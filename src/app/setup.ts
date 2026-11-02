/** Probes repository and account CLIs, writes the worker command shims and git configuration, registers them with the shared worker environment, and tracks setup readiness. */
import type { Context } from '@deepseek-ai/cordis'
import { UserError } from '../core/index.ts'
import { SETUP_FIELDS, resolveDeployment, resolveFeishuBot, workerProbe, type Deployment, type Machine } from '../deployment.ts'
import { agentVariables, verifyEnvironment, withoutDirectory, workerBin, writeEnvironment } from '../infra/environment.ts'
import type { Settings, SettingsBlock } from '../policy.ts'
import { SetupError, type SetupProblem } from '../setup.ts'
import type { WorkerMembership } from '../worker-env.ts'

export interface SetupHost {
  readonly context: Context
  readonly machine: Machine
  readonly lifetime: AbortSignal
  /** The instance's registration with the shared worker environment (src/worker-env.ts), which alone changes `process.env`. */
  readonly workers: WorkerMembership
  restart(): void
}

const setupFields = (settings: Settings) =>
  JSON.stringify(Object.entries(SETUP_FIELDS).map(([id, keys]) => keys.map(key => settings.sources[id]?.config[key] ?? '')))
export const setupChanged = (before: Settings, after: Settings): boolean => setupFields(before) !== setupFields(after)

/**
 * Resolves the target repository, GitHub account, and optional Feishu bot by probing CLIs, then writes the isolated git and shim
 * environment used by worker processes and marks the instance configured in the shared worker environment, whose dispatchers
 * then run its shims for its Sessions. It never changes `process.env`.
 * `Runtime` runs it at startup to gate orchestration readiness, while `Settings` uses it to validate account changes, update blocked command shims, and schedule restarts.
 */
export class Setup {
  private resolved?: Deployment
  problem?: SetupProblem
  feishuProblem?: SetupProblem
  /** PATH with the worker shim and shared dispatcher directories removed so the host's own CLI calls invoke the real binaries. */
  private readonly path: string
  /** Directories of PATH the host's own CLI calls skip: the instance's shims and the shared dispatchers. */
  private readonly shims: readonly string[]
  /** Environment variables pointing the host's own commands at the instance's isolated git config. */
  private readonly variables: Record<string, string | undefined>
  constructor(private readonly host: SetupHost) {
    this.shims = [workerBin(host.machine.stateDir), host.workers.shared.bin]
    this.path = this.shims.reduce(withoutDirectory, process.env.PATH ?? '')
    this.variables = agentVariables(host.machine.stateDir)
  }
  /** Host command environment with agent git variables applied and the worker shim directory excluded from PATH. */
  get commandEnvironment(): Record<string, string | undefined> { return { ...this.variables, PATH: this.path } }
  get deployment(): Deployment {
    if (!this.resolved) throw new Error(`dsh-superagent is waiting for setup: ${this.problem?.detail ?? 'setup has not run'}`)
    return this.resolved
  }
  configured(): boolean { return this.resolved !== undefined }
  /** Resolve deployment accounts and register the worker environment, recording `SetupError` failures in `problem`/`feishuProblem` and rethrowing unexpected errors. */
  async run(settings: Settings): Promise<boolean> {
    try { this.resolved = await this.resolve(settings); return true }
    catch (error) {
      if (!(error instanceof SetupError)) throw error
      this.problem = error.problem
      return false
    }
  }
  /** Trigger a restart to re-run setup, refusing if setup and Feishu are already healthy so running assignments are not interrupted. */
  check(): void {
    if (this.configured() && !this.feishuProblem) throw new UserError('setupComplete')
    this.restart()
  }
  /** Defer the restart to the next macrotask so the current HTTP or tool caller receives its response first. */
  restart(): void { setTimeout(this.host.restart, 0) }
  /** Verify account CLIs for a modified source block before saving, ignoring setup errors belonging to other blocks. */
  async checkAccounts(block: SettingsBlock, settings: Settings): Promise<void> {
    const { machine } = this.host
    const check = block === 'source:feishu' ? resolveFeishuBot(machine, settings.sources.feishu?.config, this.probe(), this.path, this.shims)
      : resolveDeployment(machine, settings.sources.github?.config, this.probe(), this.path, this.shims)
    await check.catch((error: unknown) => { if (!(error instanceof SetupError) || error.place === block.slice(7)) throw error })
  }
  /** Rewrite the blocked-command shims, and the shared dispatchers, which run them for this instance's Sessions. */
  async blockCommands(blocked: readonly string[]): Promise<void> {
    if (!this.resolved) return
    await writeEnvironment(this.resolved, blocked)
    await this.host.workers.block(blocked)
  }
  /** Probes CLIs the way worker shells run them, using `stateDir` as `cwd` since it exists even before the repository clone is valid. */
  private probe() {
    const { context, machine, lifetime } = this.host
    return workerProbe(context.subprocess, machine.stateDir, this.path, machine.stateDir, lifetime)
  }
  private async resolve(settings: Settings): Promise<Deployment> {
    const { context, machine, lifetime } = this.host
    const probe = this.probe()
    const deployment = await resolveDeployment(machine, settings.sources.github?.config, probe, this.path, this.shims)
    const feishu = await resolveFeishuBot(machine, settings.sources.feishu?.config, probe, this.path, this.shims).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      this.feishuProblem = error.problem
      context.logger.warn('dsh-superagent leaves Feishu out: %s', error.message)
      return undefined
    })
    const resolved = { ...deployment, ...(feishu ? { feishu } : {}) }
    const machineProblem = (error: unknown): never => {
      if (error instanceof SetupError) throw error
      throw new SetupError('environmentFailed', { output: error instanceof Error ? error.message : String(error) })
    }
    const { workers } = this.host
    const blocked = settings.executor.blockedCommands
    await writeEnvironment(resolved, blocked).catch(machineProblem)
    // The dispatchers run only the shims of configured instances, and the checks below run through them, so they precede
    // the checks, which take the registration back when they fail.
    try {
      await workers.configure(blocked)
      await verifyEnvironment(machine.stateDir, workers.shared, context.subprocess, lifetime)
    } catch (error) {
      await workers.unconfigure()
      machineProblem(error)
    }
    return resolved
  }
}
