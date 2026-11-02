/**
 * Host-level worker environment shared by every dsh-superagent instance in one DSH process (docs/006-deployment.md).
 *
 * `process.env` is one per process, so only this plugin writes it, once when it starts and back when it stops: `PATH` starts
 * with the shared dispatcher directory, git reads the shared configuration, whose credential helper is the `gh` dispatcher, and
 * the instance-neutral overrides apply. It stays the same while instances start, finish setup, restart and stop; while no
 * instance can answer for a command, the dispatchers fail rather than run the operator's own CLIs.
 * Each instance registers here; DSH's `shellEnv` then gives a model shell `DSH_SUPERAGENT_WORKER_BIN`, the `worker-bin`
 * directory of the instance whose Session (or whose Session's subagent) runs it, and the dispatchers run that instance's
 * shims. Like the shims, this is a guardrail for the default path, not isolation: a worker can set the variable itself.
 * The registry also knows which instances run, so this entry serves `GET /orchestrator/api/instances` for the panel's instance
 * selector, whichever instances run, the default one included or not.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { INSTANCES_PATH, managementPrefix, type InstanceView, type InstancesView } from './instance.ts'
import { sameOrigin } from './infra/origin.ts'
import { WORKER_AMBIGUOUS, WORKER_BIN_VARIABLE, WORKER_UNCONFIGURED, neutralVariables, sharedWorkers, withoutDirectory, workerBin, writeDispatchers,
  writeSharedGitConfig, type SharedWorkers } from './infra/environment.ts'

declare module '@deepseek-ai/cordis' { interface Context { superagentWorkers: WorkerRegistry } }

export const name = 'dsh-superagent-worker-env'
export const inject: string[] = []
/** The directory under the profile that holds the dispatchers and the shared git configuration. */
export const SHARED_DIRECTORY = '.dsh-superagent-workers'
/** How many parents up a subagent chain the owner of a shell call is looked for, as `limitSubagent` does in src/app/sessions.ts. */
const PARENTS = 8

/** An instance as the registry sees it. */
export interface WorkerMember {
  readonly stateDir: string
  /** The instance key, empty for the default instance. */
  readonly instance: string
  /** The id of the instance's plugin entry, the key of its DSH configuration form. */
  readonly entry: string
  /** The repository (`owner/name`) the instance works on, read when instances are listed; undefined until setup names one. */
  repository(): string | undefined
  /** True for the instance's main Session and the worker Sessions of its Tickets. */
  owns(sessionId: string): boolean
}
/** An instance's registration, from its start to its stop. */
export interface WorkerMembership {
  readonly shared: SharedWorkers
  /** Marks the instance configured with the commands it blocks, once its shims are written; resolves once the dispatchers and the process environment serve it. */
  configure(blocked: readonly string[]): Promise<void>
  /** Updates the commands a configured instance blocks. */
  block(blocked: readonly string[]): Promise<void>
  /** Takes back `configure`, as when setup's last check fails. */
  unconfigure(): Promise<void>
  /** Ends the registration; later calls do nothing. */
  release(): Promise<void>
}
/** The service the main plugin injects as `superagentWorkers`. */
export interface Workers {
  readonly shared: SharedWorkers
  join(member: WorkerMember): WorkerMembership
}
interface Entry { readonly member: WorkerMember; configured?: readonly string[] }
interface Logger { warn(format: string, ...args: unknown[]): void }

/** The registries of this process still finishing, by shared directory, which a new registry of the same directory waits for. */
const finishing = new Map<string, Promise<void>>()

/**
 * The instances of this process and what follows from them: the dispatchers and the shared git configuration. The process
 * environment is applied once when the registry starts and restored exactly once when it has stopped and the last instance
 * released its registration.
 */
export class WorkerRegistry implements Workers {
  readonly shared: SharedWorkers
  private readonly entries = new Set<Entry>()
  /** Every command an instance blocked since the registry started; it only grows, so a restart never unblocks one. */
  private readonly commands = new Set<string>()
  /**
   * The state directory of every instance that registered since the registry started. It only grows: while one of several
   * instances restarts, the only one left must not answer for the Sessions of the one that restarts.
   */
  private readonly known = new Set<string>()
  /** Values the process environment had before this registry applied its own; set while applied. */
  private previous?: Record<string, string | undefined>
  private queue: Promise<void> = Promise.resolve()
  private stopping = false
  private finished?: Promise<void>
  private finish?: () => void
  private unlock?: () => void
  /**
   * @param dir - the shared directory, private to this process.
   * @param env - the environment to apply, `process.env` outside tests.
   * @param cleanup - removes the directory once the registry finishes, for a temporary one.
   */
  constructor(dir: string, private readonly env: Record<string, string | undefined> = process.env, private readonly logger: Logger = console,
    private readonly cleanup = false) {
    this.shared = sharedWorkers(dir)
  }
  /** Locks the shared directory against another process, writes the git configuration and the dispatchers of no instance, and applies the process environment. */
  async start(): Promise<void> {
    const { dir } = this.shared
    await finishing.get(dir)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    // Another process with the same directory, such as a second start of the profile, would rewrite the dispatchers under this one.
    const compromised = (error: Error) => { this.logger.warn('dsh-superagent lost the lock of %s: %s', dir, error.message) }
    try { this.unlock = lockSync(dir, { stale: 30_000, onCompromised: compromised }) }
    catch (error) { throw new Error(`Another DSH process uses ${dir} for dsh-superagent workers: ${error instanceof Error ? error.message : String(error)}`) }
    this.finished = new Promise(resolve => { this.finish = resolve })
    finishing.set(dir, this.finished)
    try {
      await writeSharedGitConfig(this.shared)
      await this.sync()
    } catch (error) { this.done(); throw error }
    this.apply()
  }
  join(member: WorkerMember): WorkerMembership {
    if (this.stopping) throw new Error('The dsh-superagent worker environment is stopping')
    const entry: Entry = { member }
    this.entries.add(entry)
    this.known.add(member.stateDir)
    void this.change()
    const registry = this
    let released = false
    return {
      shared: this.shared,
      async configure(blocked) { if (!released) { entry.configured = [...blocked]; await registry.change(true) } },
      async block(blocked) { if (!released && entry.configured) { entry.configured = [...blocked]; await registry.change(true) } },
      // Only this flag goes: the commands it blocked stay dispatched, failing while no configured instance answers for them.
      async unconfigure() { if (!released && entry.configured) { delete entry.configured; await registry.change() } },
      async release() {
        if (released) return
        released = true
        registry.entries.delete(entry)
        await registry.change()
        if (registry.stopping && !registry.entries.size) registry.done()
      },
    }
  }
  /** The instances joined and not released, the default one first, then the others by key. */
  instances(): InstanceView[] {
    return [...this.entries].map(({ member }) => {
      let repository: string | undefined
      try { repository = member.repository() } catch { /* Listed without it. */ }
      return { instance: member.instance, prefix: managementPrefix(member.instance), entry: member.entry, ...repository ? { repository } : {} }
    }).sort((a, b) => a.instance === b.instance ? 0 : !a.instance ? -1 : !b.instance ? 1 : a.instance < b.instance ? -1 : 1)
  }
  /** Stops taking registrations; the process environment is restored once the last instance released its own, at once if none is left. */
  stop(): Promise<void> {
    this.stopping = true
    if (!this.entries.size) this.done()
    return this.finished ?? Promise.resolve()
  }
  /**
   * The value of `DSH_SUPERAGENT_WORKER_BIN` for a shell call of `agent`: the `worker-bin` directory of the instance that owns
   * its Session, or that of its nearest owned parent up a subagent chain; a value every dispatcher refuses when that instance has
   * not finished setup or several claim the Session; undefined when none claims it.
   */
  resolve(agent: Agent | undefined, agentOf: (sessionId: string) => Agent | undefined): string | undefined {
    let current = agent
    let id: string | undefined = agent?.id
    for (let depth = 0; id !== undefined && depth <= PARENTS; depth++) {
      const sessionId: string = id
      const claims = [...this.entries].filter(({ member }) => {
        try { return member.owns(sessionId) } catch { return true /* An instance that cannot say claims it, so the call fails closed. */ }
      })
      if (claims.length > 1) return WORKER_AMBIGUOUS
      const [owner] = claims
      if (owner) return owner.configured ? workerBin(owner.member.stateDir) : WORKER_UNCONFIGURED
      id = current?.session.header.parentSession
      current = id === undefined ? undefined : agentOf(id)
    }
    return undefined
  }
  /** Queue a rewrite of the dispatchers after a registration changed; `strict` rejects with its failure. */
  private change(strict = false): Promise<void> {
    const run = this.queue.then(() => this.sync())
    this.queue = run.catch((error: unknown) => {
      this.logger.warn('dsh-superagent could not update the shared worker environment in %s: %s', this.shared.dir, String(error))
    })
    return strict ? run : this.queue
  }
  private async sync(): Promise<void> {
    const configured = [...this.entries].flatMap(({ member, configured }) => configured ? [workerBin(member.stateDir)] : [])
    for (const { configured: blocked } of this.entries) for (const name of blocked ?? []) this.commands.add(name)
    await writeDispatchers(this.shared, { configured, present: Math.max(this.known.size, this.entries.size), commands: [...this.commands] })
  }
  private apply(): void {
    if (this.previous) return
    const values = { ...neutralVariables(), GIT_CONFIG_GLOBAL: this.shared.gitconfig,
      PATH: [this.shared.bin, withoutDirectory(this.env.PATH ?? '', this.shared.bin)].filter(Boolean).join(delimiter) }
    this.previous = Object.fromEntries(Object.keys(values).map(name => [name, this.env[name]]))
    this.write(values)
  }
  private restore(): void {
    if (!this.previous) return
    const previous = this.previous
    this.previous = undefined
    this.write(previous)
  }
  private write(values: Record<string, string | undefined>): void {
    for (const [name, value] of Object.entries(values)) { if (value === undefined) delete this.env[name]; else this.env[name] = value }
  }
  private done(): void {
    if (!this.finish) return
    this.restore()
    const finish = this.finish
    this.finish = undefined
    try { this.unlock?.() } catch (error) { this.logger.warn('dsh-superagent could not unlock %s: %s', this.shared.dir, String(error)) }
    if (this.cleanup) rmSync(this.shared.dir, { recursive: true, force: true })
    if (finishing.get(this.shared.dir) === this.finished) finishing.delete(this.shared.dir)
    finish()
  }
}

/** What DSH's `ctx.shellEnv` takes from a contributor (`@deepseek-ai/dsh-shell-env`, which this package's DSH types lack). */
interface ShellEnv {
  register(contributor: { name: string; variables: Record<string, { description: string }>; resolve(execution: { agent?: Agent }): Record<string, string> }): () => void
}
/** What the host web server takes from a route, as `@deepseek-ai/dsh-host-webserver` declares it. */
interface WebServer {
  host: string
  port: number
  register(route: { kind: 'prefix'; path: string; handler(req: IncomingMessage, res: ServerResponse): void }): () => void
}
function answer(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
}
interface ProfileContext { dir?: string }

/**
 * Provides `superagentWorkers`: a registry whose shared directory is `<profile>/.dsh-superagent-workers`, or a temporary one
 * outside a DSH profile, and the single `shellEnv` contributor of `DSH_SUPERAGENT_WORKER_BIN`.
 */
export async function apply(ctx: Context): Promise<void> {
  const profile = ctx.get('profileContext') as ProfileContext | undefined
  const dir = profile?.dir ? join(profile.dir, SHARED_DIRECTORY) : undefined
  const registry = new WorkerRegistry(dir ?? mkdtempSync(join(tmpdir(), 'dsh-superagent-workers-')), process.env, ctx.logger, !dir)
  await registry.start()
  ctx.logger.info('dsh-superagent workers dispatch through %s', registry.shared.bin)
  // Stopping restores the process environment only once the instances, which stop with the service, released their registrations.
  ctx.effect(() => () => registry.stop(), 'dsh-superagent: worker environment')
  ctx.provide('superagentWorkers', registry)
  // DSH's shellEnv ties the registration to the fiber of the context it is reached through, here this plugin's.
  ctx.inject(['shellEnv'], child => {
    const { shellEnv } = child as unknown as { shellEnv: ShellEnv }
    const agents = () => child.get('agents') as { get(id: string): Agent | undefined } | undefined
    shellEnv.register({
      name: 'dsh-superagent-worker-bin',
      variables: { [WORKER_BIN_VARIABLE]: { description: 'The dsh-superagent instance whose accounts gh, lark-cli and git use in this shell; do not set or change it.' } },
      resolve: ({ agent }): Record<string, string> => {
        const value = registry.resolve(agent, id => agents()?.get(id))
        return value === undefined ? {} : { [WORKER_BIN_VARIABLE]: value }
      },
    })
  })
  // The web server is optional; a non-loopback one is refused by the instances as well, so the route is skipped with a warning.
  ctx.inject(['webServer'], child => {
    const { webServer } = child as unknown as { webServer: WebServer }
    if (webServer.host !== '127.0.0.1') { ctx.logger.warn('dsh-superagent does not list its instances on a non-loopback Web server'); return }
    child.effect(() => webServer.register({ kind: 'prefix', path: INSTANCES_PATH, handler: (req, res) => {
      if (!sameOrigin(req, webServer.port)) { answer(res, 403, { error: 'Same-origin management request required' }); return }
      if (req.method !== 'GET' || new URL(req.url ?? '/', 'http://localhost').pathname !== INSTANCES_PATH) { answer(res, 404, { error: 'Unknown operation' }); return }
      answer(res, 200, { instances: registry.instances() } satisfies InstancesView)
    } }), 'dsh-superagent: instance list route')
  })
}
