/**
 * Adding an instance from the panel (`POST /orchestrator/api/instances`, docs/006-deployment.md): append its `cordis:group`
 * to the DSH profile's `cordis.patch.yml` and apply it through DSH's live profile reload, as DSH's own configuration editor
 * does: inside an `hmr` transaction, under the profile's writer lock, an atomic write, then a reconciliation that requires the
 * new entries; when DSH refuses it, the previous file is written back and reconciled again.
 */
import { createHash, randomBytes } from 'node:crypto'
import { lstat, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { INSTANCE_PATTERN, instanceEntryIds, managementPrefix, type AddInstanceError, type AddInstanceResult, type InstanceAdding,
  type InstanceView } from '../instance.ts'

/** The fields of DSH's `profileContext` this module reads. */
export interface ProfileContext { dir?: string; patchPath?: string }
/** What `reconcileProfile` answers, as DSH's `hmr` service (`@deepseek-ai/dsh-hmr`) declares it. */
export interface Reconciled { warnings: readonly unknown[]; pending: readonly { reason: string }[]; restartReason?: string }
/** The part of DSH's `hmr` service a profile edit uses; `reconcileProfile` runs only inside `runExclusive`. */
export interface Hmr {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>
  reconcileProfile(requiredIds?: string[]): Promise<Reconciled>
}
/** A Cordis Loader entry; `loader.entries()` lists disabled entries too, but not the children of a disabled group. */
export interface LoaderEntry { options: { id?: string; name?: string; config?: unknown } }
/** What adding reads from the process, each time, since DSH services come and go. */
export interface AdderHost {
  profile(): ProfileContext | undefined
  hmr(): Hmr | undefined
  loader(): { entries(): Iterable<LoaderEntry> } | undefined
  /** The instances joined in the worker registry. */
  instances(): InstanceView[]
  /** The `stateDir` of the joined default instance. */
  defaultStateDir(): string | undefined
  logger: { info(format: string, ...args: unknown[]): void; warn(format: string, ...args: unknown[]): void }
}
/** A refused `POST`: its HTTP status and `AddInstanceError` code. */
export class AddInstanceFailure extends Error {
  constructor(readonly status: 400 | 409 | 500, readonly code: AddInstanceError, message: string) { super(message) }
}
/** What a successful `POST` answers: 201 once applied, 202 when the change waits for a restart. */
export interface Added { status: 201 | 202; result: AddInstanceResult }

/** The largest `POST` body read. */
export const MAX_BODY_BYTES = 4096
/** A YAML double-quoted scalar: JSON's escapes are YAML's, and the characters YAML would not print are escaped as well. */
export function yamlString(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029\ufeff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}
/** The profile patch block of instance `key` with `stateDir`, the group of docs/006-deployment.md, ending with a newline. */
export function instanceBlock(key: string, stateDir: string): string {
  const ids = instanceEntryIds(key), q = yamlString
  return [
    '- insert:',
    `    - id: ${q(ids.group)}`,
    `      name: ${q('cordis:group')}`,
    '      group: true',
    '      isolate:',
    '        orchestrator: true',
    '      config:',
    `        - id: ${q(ids.core)}`,
    `          name: ${q('dsh-superagent')}`,
    '          config:',
    `            stateDir: ${q(stateDir)}`,
    `            instance: ${q(key)}`,
    `        - id: ${q(ids.github)}`,
    `          name: ${q('dsh-superagent/github-watch')}`,
    `        - id: ${q(ids.feishu)}`,
    `          name: ${q('dsh-superagent/feishu-watch')}`,
    '          disabled: true',
    '',
  ].join('\n')
}
const EMPTY_SEQUENCE = /^\s*\[\s*\]\s*(?:#.*)?$/
const content = (line: string) => line.trim() !== '' && !line.trimStart().startsWith('#')
/**
 * The patch file `before` (undefined when missing) with `block` appended. Every existing byte stays, except that a file whose
 * only content is the empty sequence `[]`, as DSH's profile template, loses that line and keeps its comments.
 */
export function appendBlock(before: string | undefined, block: string): string {
  if (before === undefined) return block
  const lines = before.split('\n'), filled = lines.flatMap((line, index) => content(line) ? [index] : [])
  const [only] = filled
  const kept = filled.length === 1 && EMPTY_SEQUENCE.test(lines[only!]!) ? lines.filter((_, index) => index !== only).join('\n') : before
  return kept === '' || kept.endsWith('\n') ? kept + block : `${kept}\n${block}`
}
/** The `id:` values a patch file's text names, in block or flow style, quoted or not. */
export function patchIds(text: string): Set<string> {
  return new Set([...text.matchAll(/(?<![\w-])id\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s,}\]#'"][^\s,}\]#]*))/g)]
    .map(([, double, single, plain]) => double !== undefined ? safeJson(double) : single !== undefined ? single.replace(/''/g, "'") : plain!))
}
function safeJson(inner: string): string { try { return JSON.parse(`"${inner}"`) as string } catch { return inner } }

/** Retry cadence and default wait of DSH's `withFileLock` (`@deepseek-ai/dsh-atomic-write`). */
const LOCK_RETRY_INITIAL_MS = 20, LOCK_RETRY_MAX_MS = 200
const code = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code
/** Whether the holder a `<pid>\n` lock record names is proven gone; a holder that is this process is not. */
function holderExited(record: string): boolean {
  if (!/^\d+\n$/.test(record)) return false
  const pid = Number(record.trim())
  if (pid === 0 || pid > 2_147_483_647 || pid === process.pid) return false
  try { process.kill(pid, 0); return false } catch (error) { return code(error) === 'ESRCH' }
}
const readRecord = (path: string) => readFile(path, 'utf8').catch(() => undefined)
/** Remove a lock whose holder exited, under the claim file DSH's contenders use for the same record. */
async function takeOver(lockPath: string): Promise<boolean> {
  const record = await readRecord(lockPath)
  if (record === undefined || !holderExited(record)) return false
  const claim = `${lockPath}.takeover-${createHash('sha256').update(record).digest('hex').slice(0, 16)}`
  try { await writeFile(claim, `${process.pid}\n`, { mode: 0o600, flag: 'wx' }) }
  catch (error) { if (code(error) === 'EEXIST' || code(error) === 'EPERM') return false; throw error }
  try {
    if (await readRecord(lockPath) !== record || !holderExited(record)) return false
    try { await rm(lockPath, { force: true }) } catch { return false }
    return true
  } finally { await rm(claim, { force: true }).catch(() => {}) }
}
/**
 * Hold the cross-process writer lock of `filename` around `operation`, DSH's `withFileLock` protocol: `<filename>.lock` created
 * exclusively with this process's `<pid>\n`, waited for with backoff until `waitMs`, and taken over only when its holder no
 * longer exists. A lock this process holds, such as DSH's configuration editor's, is waited for.
 */
export async function withProfileLock<T>(filename: string, operation: () => Promise<T>, waitMs = 10_000): Promise<T> {
  const lockPath = `${filename}.lock`, deadline = Date.now() + waitMs
  for (let delay = LOCK_RETRY_INITIAL_MS; ; delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS)) {
    try { await writeFile(lockPath, `${process.pid}\n`, { mode: 0o600, flag: 'wx' }); break }
    catch (error) {
      const contended = code(error) === 'EEXIST' || (code(error) === 'EPERM' && await lstat(lockPath).then(() => true, () => false))
      if (!contended) throw error
      if (await takeOver(lockPath)) continue
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for the writer lock at ${lockPath}`)
    await sleep(delay)
  }
  try { return await operation() } finally { await rm(lockPath, { force: true }) }
}
/** Replace `filename` atomically with a private file, as DSH writes profile patches. */
async function writeAtomic(filename: string, text: string): Promise<void> {
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`
  try { await writeFile(temp, text, { mode: 0o600, flag: 'wx' }); await rename(temp, filename) }
  catch (error) { await rm(temp, { force: true }); throw error }
}
const readOptional = (path: string) => readFile(path, 'utf8').catch((error: unknown) => { if (code(error) === 'ENOENT') return undefined; throw error })
/** Why `stateDir` is taken: it exists and is not an empty directory. */
async function stateDirTaken(stateDir: string): Promise<boolean> {
  try { return !(await lstat(stateDir)).isDirectory() || (await readdir(stateDir)).length > 0 }
  catch (error) { if (code(error) === 'ENOENT') return false; throw error }
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Options of `InstanceAdder`, for tests. */
export interface AdderOptions { lockWaitMs?: number; joinWaitMs?: number; pollMs?: number }

/** Adds instances to the profile, one at a time in this process. */
export class InstanceAdder {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly host: AdderHost, private readonly options: AdderOptions = {}) {}
  /** Whether adding is available, and the `stateDir` a new instance's derives from. */
  adding(): InstanceAdding {
    const profile = this.host.profile()
    if (!profile?.dir || !profile.patchPath) return { available: false, reason: 'no-profile' }
    if (!this.host.hmr()) return { available: false, reason: 'no-reload' }
    const base = this.host.defaultStateDir()
    return base ? { available: true, stateDirBase: base.replace(/(.)\/+$/, '$1') } : { available: false, reason: 'no-default' }
  }
  /** Validate a `POST` body and add its instance; throws `AddInstanceFailure`. */
  async add(body: unknown): Promise<Added> {
    const key = parseRequest(body)
    const run = this.queue.then(() => this.addKey(key))
    this.queue = run.catch(() => {})
    return run
  }
  private async addKey(key: string): Promise<Added> {
    const adding = this.adding()
    if (!adding.available) throw new AddInstanceFailure(409, 'unavailable', `Adding an instance is unavailable here: ${adding.reason}`)
    const { dir, patchPath } = this.host.profile() as Required<ProfileContext>
    const hmr = this.host.hmr()!, ids = instanceEntryIds(key), stateDir = `${adding.stateDirBase}-${key}`
    const required = [ids.group, ids.core, ids.github]
    const check = async (text: string | undefined) => {
      const taken = this.taken(key, text)
      if (taken) throw new AddInstanceFailure(409, 'exists', taken)
      if (await stateDirTaken(stateDir)) throw new AddInstanceFailure(409, 'exists', `${stateDir} exists and is not an empty directory`)
    }
    await check(await readOptional(patchPath))
    const reconciled = await hmr.runExclusive(() => withProfileLock(join(dir, 'package.json'), async () => {
      const before = await readOptional(patchPath)
      await check(before)
      await writeAtomic(patchPath, appendBlock(before, instanceBlock(key, stateDir)))
      try { return await hmr.reconcileProfile(required) }
      catch (error) {
        this.host.logger.warn('dsh-superagent could not add instance %s; restoring %s: %s', key, patchPath, message(error))
        try {
          if (before === undefined) await rm(patchPath, { force: true }); else await writeAtomic(patchPath, before)
          await hmr.reconcileProfile()
        } catch (restore) { this.host.logger.warn('dsh-superagent could not reapply %s after restoring it: %s', patchPath, message(restore)) }
        throw new AddInstanceFailure(500, 'failed', `DeepSeek Harness refused instance ${key}: ${message(error)}`)
      }
    }, this.options.lockWaitMs)).catch((error: unknown) => {
      if (error instanceof AddInstanceFailure) throw error
      throw new AddInstanceFailure(500, 'failed', `Could not change ${patchPath}: ${message(error)}`)
    })
    for (const warning of reconciled.warnings) this.host.logger.warn('dsh-superagent: profile reload: %s', message(warning))
    const restartReason = reconciled.restartReason ?? reconciled.pending[0]?.reason
    const instance: InstanceView = { instance: key, prefix: managementPrefix(key), entry: ids.core }
    this.host.logger.info('dsh-superagent added instance %s (entry %s, stateDir %s) to %s%s', key, ids.group, stateDir, patchPath,
      restartReason === undefined ? '' : `; it starts after a restart (${restartReason})`)
    if (restartReason !== undefined) return { status: 202, result: { applied: false, instance, stateDir, restartReason } }
    await this.joined(key)
    return { status: 201, result: { applied: true, instance, stateDir } }
  }
  /** Why `key` is taken by a joined instance, a Loader entry or the patch file's text; undefined when it is free. */
  private taken(key: string, text: string | undefined): string | undefined {
    if (this.host.instances().some(view => view.instance === key)) return `Instance ${key} already runs`
    const ids = Object.values(instanceEntryIds(key))
    for (const { options } of this.host.loader()?.entries() ?? []) {
      if (options.id !== undefined && ids.includes(options.id)) return `Plugin entry ${options.id} already exists`
      const config = options.config as { instance?: unknown } | undefined
      if (options.name === 'dsh-superagent' && config?.instance === key) return `Plugin entry ${options.id ?? options.name} already has instance ${key}`
    }
    const named = text === undefined ? new Set<string>() : patchIds(text)
    const id = ids.find(id => named.has(id))
    return id === undefined ? undefined : `The profile patch already names ${id}`
  }
  /** Waits, briefly, for the new instance to join the registry so the answer and the next list agree. */
  private async joined(key: string): Promise<void> {
    const deadline = Date.now() + (this.options.joinWaitMs ?? 10_000)
    while (!this.host.instances().some(view => view.instance === key) && Date.now() < deadline) await sleep(this.options.pollMs ?? 100)
  }
}
/** The key of an `AddInstanceRequest` body: exactly `{ instance }`, a non-empty `INSTANCE_PATTERN` slug. */
export function parseRequest(body: unknown): string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new AddInstanceFailure(400, 'invalid', 'The request body must be an object')
  const keys = Object.keys(body)
  const { instance } = body as { instance?: unknown }
  if (keys.length !== 1 || keys[0] !== 'instance' || typeof instance !== 'string') throw new AddInstanceFailure(400, 'invalid', 'The request body must be { "instance": "<key>" }')
  if (!INSTANCE_PATTERN.test(instance)) throw new AddInstanceFailure(400, 'invalid', 'The instance key must be a lowercase slug of at most 32 characters')
  return instance
}
/** Read a JSON request body of at most `MAX_BODY_BYTES`; a larger or non-JSON one is `invalid`. The rest of a large one is drained, so the answer still reaches the client. */
export async function readRequest(req: AsyncIterable<unknown>): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk as Uint8Array)
    size += bytes.length
    if (size <= MAX_BODY_BYTES) chunks.push(bytes)
  }
  if (size > MAX_BODY_BYTES) throw new AddInstanceFailure(400, 'invalid', `The request exceeds ${MAX_BODY_BYTES} bytes`)
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new AddInstanceFailure(400, 'invalid', 'The request body is not JSON') }
}
