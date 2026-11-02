/**
 * CLI shims, git configuration and the shared dispatchers that bind git, gh, and lark-cli to the deployment's accounts and block disallowed commands.
 * An instance writes its shims and git configuration; `dsh-superagent/worker-env` (src/worker-env.ts) writes the dispatchers that run them and alone applies them to the process.
 * Variables read by workers avoid `KEY|PASSWORD|SECRET|TOKEN` in their names because DSH strips credential-shaped variables from child environments.
 * Provides default-path guardrails rather than an OS-level security boundary, as workers run under the operator's OS user.
 */
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Deployment } from '../deployment.ts'
import { SetupError } from '../setup.ts'
import { CliError } from './commands.ts'

const MARKER = '# Written by dsh-superagent on every start; edits are lost.'
/** Markers of files written under the project's earlier names (`dsh-tag`, `dsh-go`, `dsh-freelancer`), which `dsh-superagent` owns and replaces too. */
const LEGACY_MARKERS = ['dsh-tag', 'dsh-go', 'dsh-freelancer'].map(name => `# Written by ${name} on every start; edits are lost.`)
/** Commands workers need, which `blockedCommands` cannot block: the shims and git. */
export const WORKER_COMMANDS: readonly string[] = ['gh', 'git', 'lark-cli']
export const workerBin = (stateDir: string): string => join(stateDir, 'worker-bin')
export const workerGitConfig = (stateDir: string): string => join(stateDir, 'worker-gitconfig')
/**
 * Names the `worker-bin` directory of the instance whose Session runs a command. The `dsh-superagent/worker-env` plugin sets it
 * through DSH's `shellEnv` for model shells, and the instance's own worker spawns pass it; the dispatchers in the shared
 * directory read it. DSH drops every `DSH_*` variable from other spawns, so it never leaks into an unrelated process.
 */
export const WORKER_BIN_VARIABLE = 'DSH_SUPERAGENT_WORKER_BIN'
/** Set to any non-empty value, makes a dispatcher print the program it would run instead of running it; setup checks with it. */
export const WORKER_RESOLVE_VARIABLE = 'DSH_SUPERAGENT_WORKER_RESOLVE'
/** Values of `DSH_SUPERAGENT_WORKER_BIN` that make every dispatcher fail: the owner has not finished setup, or several instances claim the Session. */
export const WORKER_UNCONFIGURED = 'unconfigured'
export const WORKER_AMBIGUOUS = 'ambiguous'
/** The variable an instance's own worker spawns carry, so its git and CLIs reach its shims through the dispatchers. */
export const workerVariables = (stateDir: string): Record<string, string> => ({ [WORKER_BIN_VARIABLE]: workerBin(stateDir) })
/** The process-wide dispatchers and git configuration that `dsh-superagent/worker-env` owns (src/worker-env.ts). */
export interface SharedWorkers { readonly dir: string; readonly bin: string; readonly gitconfig: string }
export const sharedWorkers = (dir: string): SharedWorkers => ({ dir, bin: join(dir, 'bin'), gitconfig: join(dir, 'gitconfig') })
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const gitQuote = (value: string): string => `"${value.replace(/[\\"]/g, char => `\\${char}`)}"`
export const credentialHelper = (cli: string): string => `!${shellQuote(cli)} auth git-credential`

export function sameDirectory(a: string, b: string): boolean {
  const real = (path: string): string => { try { return realpathSync(path) } catch { return resolve(path) } }
  return real(a) === real(b)
}
export function withoutDirectory(path: string, dir: string): string {
  return path.split(delimiter).filter(entry => !sameDirectory(entry, dir)).join(delimiter)
}

/**
 * The variables that tell git which repository, work tree and index to act on. A host started inside git, such as by
 * `git rebase --exec`, passes them on, and a git started below it would act on that repository. GIT_CEILING_DIRECTORIES is
 * kept: it names no repository, and it stops git's search for one where the operator chose.
 */
export const GIT_LOCATION: readonly string[] = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']

/**
 * Returns environment variable overrides that strip ambient GitHub tokens, interactive prompts, the repository the host's own
 * environment may name, and operator git identity/config overrides.
 */
export function agentVariables(stateDir: string): Record<string, string | undefined> {
  return { ...neutralVariables(), GIT_CONFIG_GLOBAL: workerGitConfig(stateDir) }
}
/** The overrides of `agentVariables` that are the same for every instance; `dsh-superagent/worker-env` applies them to the process. */
export function neutralVariables(): Record<string, string | undefined> {
  return {
    GH_TOKEN: undefined, GITHUB_TOKEN: undefined,
    // A worker's git finds the repository from its directory, never from the host's environment.
    ...Object.fromEntries(GIT_LOCATION.map(name => [name, undefined])),
    GIT_CONFIG_NOSYSTEM: '1',
    // Clear environment git config overrides; configuration passed through the environment would otherwise reach every git command the agent runs.
    GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined,
    // When the credential helper has no answer, git must fail rather than prompt; `GIT_ASKPASS: ''` also overrides `core.askPass` and `SSH_ASKPASS`.
    GIT_ASKPASS: '', SSH_ASKPASS: undefined, GIT_TERMINAL_PROMPT: '0',
    // Clear operator commit identity variables; prompts specify commit identity and operator env vars would override what a worker sets.
    GIT_AUTHOR_NAME: undefined, GIT_COMMITTER_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_EMAIL: undefined,
  }
}

/** True when a regular file starts with the dsh-superagent marker in its first two lines; a symbolic link, directory, or other non-regular file never counts as written by dsh-superagent. */
async function written(file: string): Promise<boolean> {
  if (!(await lstat(file)).isFile()) return false
  const head = (await readFile(file, 'utf8')).split('\n', 2)
  return [MARKER, ...LEGACY_MARKERS].some(marker => head.includes(marker))
}
async function own(file: string, text: string, mode = 0o644): Promise<void> {
  let foreign = false
  try { foreign = !await written(file) } catch { /* The file does not exist yet. */ }
  if (foreign) throw new SetupError('foreignFile', { file })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, text, { mode })
  await rename(temporary, file)
}

/** Shell lines that remove `dir` from PATH, so a command run by name afterwards finds what lies beyond `dir`. */
const withoutOnPath = (dir: string): string => [
  `self=${shellQuote(dir)}`, 'rest=', 'IFS=:', 'set -f',
  'for entry in $PATH; do [ "$entry" = "$self" ] || rest="${rest:+$rest:}$entry"; done',
  'set +f', 'unset IFS', 'PATH=$rest', 'export PATH',
].join('\n')
const fail = (message: string): string => `echo ${shellQuote(message)} >&2; exit 1`

/**
 * Makes `dir` hold exactly `scripts` (name → body), refusing a directory that holds anything dsh-superagent did not write.
 * Workers may be running concurrently: each script is written to a temp file and atomically renamed, so no command ever
 * resolves past the directory while it changes.
 */
async function writeScripts(dir: string, scripts: ReadonlyMap<string, string>): Promise<void> {
  await mkdir(dir, { recursive: true })
  const before = await readdir(dir)
  for (const name of before) { const file = join(dir, name); if (!await written(file)) throw new SetupError('foreignFile', { file }) }
  for (const [name, body] of scripts) {
    const temporary = join(dir, `.${name}.${process.pid}.tmp`)
    await writeFile(temporary, `#!/bin/sh\n${MARKER}\n${body}\n`, { mode: 0o755 })
    await rename(temporary, join(dir, name))
  }
  for (const name of before) if (!scripts.has(name)) await unlink(join(dir, name))
}

/** The agent's git configuration, with `helper` as the only credential helper, for github.com. */
const gitConfig = (helper: string): string => [
  MARKER,
  // Make git refuse to commit without an explicit identity set by the worker instead of guessing from the operator's OS user.
  '[user]', '\tuseConfigOnly = true',
  '[credential]', '\thelper =',
  '[credential "https://github.com"]', `\thelper = ${gitQuote(helper)}`,
  '[url "https://github.com/"]', '\tinsteadOf = git@github.com:', '\tinsteadOf = ssh://git@github.com/',
  // Include Git LFS filters because the operator's global gitconfig (which usually holds them) is ignored.
  '[filter "lfs"]', '\tclean = git-lfs clean -- %f', '\tsmudge = git-lfs smudge -- %f', '\tprocess = git-lfs filter-process', '\trequired = true',
].join('\n') + '\n'

/**
 * Atomically writes worker CLI shims and the isolated git configuration file into the state directory, refusing to overwrite foreign files.
 * Each shim strips the shim directory from PATH before exec so wrapper scripts resolving `gh` or `lark-cli` by name reach the real binary.
 */
export async function writeEnvironment(deployment: Pick<Deployment, 'stateDir' | 'repository' | 'github' | 'feishu'>, blockedCommands: readonly string[]): Promise<void> {
  const { stateDir, github, feishu } = deployment
  const dir = workerBin(stateDir)
  const run = (program: string): string => `${withoutOnPath(dir)}\nexec ${shellQuote(program)} "$@"`
  const scripts = new Map<string, string>([
    ['gh', run(github.cli)],
    ['lark-cli', feishu ? run(feishu.cli) : fail('lark-cli is unavailable: this installation has no Feishu bot.')],
  ])
  for (const name of blockedCommands) {
    if (!WORKER_COMMANDS.includes(name)) scripts.set(name, fail(`${name} is blocked in this installation; use gh, which acts as ${github.login}.`))
  }
  await writeScripts(dir, scripts)
  await own(workerGitConfig(stateDir), gitConfig(credentialHelper(github.cli)))
}

/** What the dispatchers know of the dsh-superagent instances in this process. */
export interface Dispatch {
  /** The `worker-bin` directory of each instance that finished setup. */
  readonly configured: readonly string[]
  /**
   * How many instances have run in this process since the shared environment started, finished with setup or not. A command
   * without `DSH_SUPERAGENT_WORKER_BIN` runs as the configured instance only when it is the only one ever: so a restart of one
   * of several never lets the others answer for its Sessions.
   */
  readonly present: number
  /**
   * Commands to dispatch besides `gh` and `lark-cli`: every command an instance blocked while the shared environment ran, so
   * one an instance blocks fails while that instance restarts instead of reaching the real command.
   */
  readonly commands: readonly string[]
}
/** What a dispatcher says when its variable is unset and no single instance stands for the command. */
function unownedMessage(name: string, present: number): string {
  if (present > 1) return `${name} is unavailable here: several dsh-superagent instances share this process, and this command runs outside their sessions, so it has no account to act as.`
  return present === 1 ? `${name} is unavailable: the dsh-superagent instance of this process has not finished setup.`
    : `${name} is unavailable: no dsh-superagent instance runs in this process.`
}
/**
 * The dispatcher of command `name` in the shared `bin` directory. It picks the instance from `DSH_SUPERAGENT_WORKER_BIN`,
 * or, when that is unset, the only instance the process has run if it finished setup; removes the shared directory from PATH;
 * and runs that instance's shim of `name`, or `name` itself when only another instance blocks it. Anything else fails: it
 * never runs the operator's own CLI while no instance answers for the command.
 */
function dispatcher(shared: SharedWorkers, name: string, dispatch: Dispatch): string {
  const bins = dispatch.configured
  const only = dispatch.present === 1 && bins.length === 1 ? bins[0] : undefined
  const variable = WORKER_BIN_VARIABLE
  return [
    `name=${shellQuote(name)}`,
    `if [ "\${${variable}+set}" = set ]; then bin=$${variable}`,
    only ? `else bin=${shellQuote(only)}` : `else ${fail(unownedMessage(name, dispatch.present))}`,
    'fi',
    'case $bin in',
    ...bins.length ? [`  ${bins.map(shellQuote).join('|')}) ;;`] : [],
    `  ${WORKER_UNCONFIGURED}) ${fail(`${name} is unavailable: the dsh-superagent instance of this session has not finished setup.`)} ;;`,
    `  ${WORKER_AMBIGUOUS}) ${fail(`${name} is unavailable: more than one dsh-superagent instance claims this session.`)} ;;`,
    `  *) ${fail(`${name} is unavailable: ${variable} names no dsh-superagent instance that finished setup in this process.`)} ;;`,
    'esac',
    withoutOnPath(shared.bin),
    'if [ -f "$bin/$name" ] && [ -x "$bin/$name" ]; then target=$bin/$name; else target=$name; fi',
    `if [ -n "\${${WORKER_RESOLVE_VARIABLE}:-}" ]; then`,
    '  [ "$target" = "$name" ] && target=$(command -v "$name")',
    `  printf '%s\\n' "$target"; exit 0`,
    'fi',
    'exec "$target" "$@"',
  ].join('\n')
}
/**
 * Atomically rewrites the shared dispatchers: `gh`, `lark-cli` and the blocked `commands`. Workers may run meanwhile; as with
 * the shims, no command resolves past the directory while it changes.
 */
export async function writeDispatchers(shared: SharedWorkers, dispatch: Dispatch): Promise<void> {
  const names = new Set(['gh', 'lark-cli', ...dispatch.commands.filter(name => !WORKER_COMMANDS.includes(name))])
  await writeScripts(shared.bin, new Map([...names].map(name => [name, dispatcher(shared, name, dispatch)])))
}
/** Writes the shared git configuration, whose credential helper is the shared `gh` dispatcher. */
export async function writeSharedGitConfig(shared: SharedWorkers): Promise<void> {
  await mkdir(shared.dir, { recursive: true, mode: 0o700 })
  await own(shared.gitconfig, gitConfig(credentialHelper(join(shared.bin, 'gh'))))
}

/** Spawns a command through the DSH subprocess runtime, which strips credential-shaped environment variables. */
export async function runAsWorker(subprocess: SubprocessRuntime, argv: string[], cwd: string, signal: AbortSignal, env?: Record<string, string>): Promise<string> {
  const handle = subprocess.spawn({ argv, cwd, graceMs: 2000, signal, ...env ? { env } : {}, stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 16 } } })
  const { exitCode } = await handle.done
  const read = (reader: SubprocessOutputReader | undefined): string => reader?.readFrom(0).text ?? ''
  if (exitCode === 0) return read(handle.collected.stdout)
  const ended = exitCode === null ? 'was stopped before it finished' : `exited with ${exitCode}`
  throw new CliError(read(handle.collected.stderr).trim() || `${argv.join(' ')} ${ended}`, undefined, exitCode ?? undefined)
}

/**
 * Verifies, as an instance's workers run them, that git reads the shared configuration with the shared `gh` dispatcher as
 * its github.com credential helper, and that `gh` reaches this instance's shim through the dispatcher.
 */
export async function verifyEnvironment(stateDir: string, shared: SharedWorkers, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const limit = () => AbortSignal.any([signal, AbortSignal.timeout(60_000)])
  const env = workerVariables(stateDir)
  // `-z` separates fields with NUL and never quotes paths.
  const helpers = (await runAsWorker(subprocess, ['git', 'config', '-z', '--show-origin', '--get-all', 'credential.https://github.com.helper'], stateDir, limit(), env).catch(() => '')).split('\0')
  if (helpers.join('\0') !== [`file:${shared.gitconfig}`, credentialHelper(join(shared.bin, 'gh')), ''].join('\0')) throw new SetupError('gitTooOld')
  const shim = join(workerBin(stateDir), 'gh')
  const resolved = (await runAsWorker(subprocess, ['gh'], stateDir, limit(), { ...env, [WORKER_RESOLVE_VARIABLE]: '1' })
    .catch((error: unknown) => error instanceof Error ? error.message : String(error))).trim()
  if (resolved !== shim) throw new SetupError('environmentFailed', { output: `A worker's gh runs ${resolved || 'nothing'}, not ${shim}.` })
}

/**
 * Verifies that a ticket directory's local or worktree git config defines no custom `credential.*` or `http.*extraheader`
 * keys, which the agent's git would read from the repository's own config and act on. `env` carries the instance's
 * `DSH_SUPERAGENT_WORKER_BIN`, as its workers' git has it.
 */
export async function verifyDirectory(directory: string, subprocess: SubprocessRuntime, signal: AbortSignal, env?: Record<string, string>): Promise<void> {
  const keys = ['git', 'config', '-z', '--show-scope', '--get-regexp', '^(credential\\..*|http\\..*extraheader)$']
  // `git config --get-regexp` exits with code 1 when no keys match.
  const output = await runAsWorker(subprocess, keys, directory, AbortSignal.any([signal, AbortSignal.timeout(60_000)]), env)
    .catch((error: unknown) => { if (error instanceof CliError && error.exitCode === 1) return ''; throw error })
  const scoped = output.split('\0')
  const local = scoped.flatMap((scope, index) => index % 2 === 0 && (scope === 'local' || scope === 'worktree') ? [scoped[index + 1]!.split('\n')[0]!] : [])
  if (local.length) throw new Error(`The git configuration of the repository in ${directory} sets ${local.join(', ')}, which the agent's git would also read; remove them.`)
}
