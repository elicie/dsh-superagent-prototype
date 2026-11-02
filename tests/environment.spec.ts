import { execFile, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SENSITIVE_ENV_PATTERN, type SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { GIT_LOCATION, agentVariables, credentialHelper, neutralVariables, runAsWorker, sharedWorkers, verifyDirectory, withoutDirectory, workerBin,
  workerGitConfig, writeDispatchers, writeEnvironment, writeSharedGitConfig, type Dispatch } from '../src/infra/environment.ts'
import { CliError } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { gitEnv } from './fixtures/git.ts'

// Git and shell subprocesses can exceed the 5s default timeout when the test suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 })
const exec = promisify(execFile)
let dir: string
const program = (path: string, body: string): string => { writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); return path }
/** Worker shell environment after DSH strips credential-shaped variables. */
const workerEnv = (env: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !SENSITIVE_ENV_PATTERN.test(entry[0])))
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'environment-')); mkdirSync(join(dir, 'real')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('worker shims', () => {
  it('run a wrapper that calls `gh` by name without reaching the shim again, and keep the caller\'s other PATH entries', async () => {
    program(join(dir, 'real', 'gh'), 'echo "{\\"login\\":\\"agent-bot\\",\\"config\\":\\"$GH_CONFIG_DIR\\",\\"path\\":\\"$PATH\\"}"')
    const wrapper = program(join(dir, 'gh-agent'), `GH_CONFIG_DIR=${dir}/agent-config exec gh "$@"`)
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: wrapper }, feishu: undefined }), [])
    const bin = workerBin(dir)
    const path = [bin, join(dir, 'venv'), join(dir, 'real'), '/usr/bin', '/bin'].join(':')
    const { stdout } = await exec('gh', ['api', 'user'], { env: { PATH: path }, timeout: 10_000 })
    expect(JSON.parse(stdout)).toEqual({ login: 'agent-bot', config: `${dir}/agent-config`, path: [join(dir, 'venv'), join(dir, 'real'), '/usr/bin', '/bin'].join(':') })
  })
  it('make `lark-cli` fail without a Feishu bot and each blocked command fail with the agent\'s login', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir, feishu: undefined }), ['personal-gh'])
    const bin = workerBin(dir)
    await expect(exec(join(bin, 'lark-cli'), ['im', '+chat-list'])).rejects.toMatchObject({ code: 1, stderr: 'lark-cli is unavailable: this installation has no Feishu bot.\n' })
    await expect(exec(join(bin, 'personal-gh'), [])).rejects.toMatchObject({ code: 1, stderr: 'personal-gh is blocked in this installation; use gh, which acts as agent-bot.\n' })
  })
  it('keep `gh` and `lark-cli` working, and shim no `git`, when the blocked commands name the commands workers need', async () => {
    const gh = program(join(dir, 'gh-agent'), 'echo gh "$@"'), lark = program(join(dir, 'lark-bot'), 'echo lark "$@"')
    const base = testDeployment()
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...base.github, cli: gh }, feishu: { ...base.feishu!, cli: lark } }), ['gh', 'git', 'lark-cli'])
    const bin = workerBin(dir)
    expect([(await exec(join(bin, 'gh'), ['api', 'user'])).stdout, (await exec(join(bin, 'lark-cli'), ['im'])).stdout]).toEqual(['gh api user\n', 'lark im\n'])
    expect(readdirSync(bin)).not.toContain('git')
  })
  it('replace only what dsh-superagent wrote and refuse anything else in its places', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir }), ['old-cli'])
    await writeEnvironment(testDeployment({ stateDir: dir }), [])
    expect(readdirSync(workerBin(dir)).sort()).toEqual(['gh', 'lark-cli'])
    // A file that merely contains the marker on a later line, a symlink to a shim, and a foreign gitconfig are all rejected.
    writeFileSync(join(workerBin(dir), 'notes'), `notes\nmore\n${readFileSync(join(workerBin(dir), 'gh'), 'utf8').split('\n')[1]}\n`)
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow(`${join(workerBin(dir), 'notes')} was not written by dsh-superagent`)
    rmSync(join(workerBin(dir), 'notes'))
    symlinkSync(join(workerBin(dir), 'gh'), join(workerBin(dir), 'link'))
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow('link was not written by dsh-superagent')
    rmSync(join(workerBin(dir), 'link'))
    writeFileSync(workerGitConfig(dir), '[user]\n\tname = someone\n')
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow(`${workerGitConfig(dir)} was not written by dsh-superagent`)
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toBe('[user]\n\tname = someone\n')
  })
  it('replaces the files it wrote under the project\'s earlier names', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir }), ['old-cli', 'older-cli'])
    const legacy = (file: string, name: string) => writeFileSync(file, readFileSync(file, 'utf8').replace('Written by dsh-superagent', `Written by ${name}`))
    legacy(join(workerBin(dir), 'old-cli'), 'dsh-tag'); legacy(join(workerBin(dir), 'older-cli'), 'dsh-freelancer'); legacy(workerGitConfig(dir), 'dsh-go')
    await writeEnvironment(testDeployment({ stateDir: dir }), [])
    expect(readdirSync(workerBin(dir)).sort()).toEqual(['gh', 'lark-cli'])
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toContain('Written by dsh-superagent')
  })
})

describe('agent git configuration', () => {
  it('ignores the operator\'s global and system git configuration, also after DSH drops credential-shaped variables', async () => {
    const home = join(dir, 'home'); mkdirSync(home)
    // Operator configuration that rewrites HTTPS to SSH, enables commit signing, and sets a credential helper.
    writeFileSync(join(home, '.gitconfig'), '[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n[commit]\n\tgpgsign = true\n[credential]\n\thelper = osxkeychain\n')
    const deployment = testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: '/opt/agent tools/gh' } })
    await writeEnvironment(deployment, [])
    // Operator identity variables and git's fallback from the OS username must not apply to worker commits.
    const env = workerEnv({ PATH: process.env.PATH, HOME: home, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.abbrev', GIT_CONFIG_VALUE_0: '12', GIT_AUTHOR_NAME: 'Operator', GIT_COMMITTER_EMAIL: 'operator@example.com', ...agentVariables(dir) })
    const git = async (...args: string[]): Promise<string> => (await exec('git', args, { cwd: dir, env })).stdout.trim()
    await git('init', '-q', 'repo')
    await exec('git', ['-C', 'repo', 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: dir, env })
    expect(await git('-C', 'repo', 'remote', 'get-url', '--push', 'origin')).toBe('https://github.com/acme/widgets.git')
    expect(await git('config', '--show-origin', '--get-all', 'credential.https://github.com.helper')).toBe(`file:${workerGitConfig(dir)}\t${credentialHelper('/opt/agent tools/gh')}`)
    expect(await git('config', '--get-all', 'credential.helper')).toBe('')
    await expect(git('config', 'commit.gpgsign')).rejects.toThrow()
    await expect(git('config', 'core.abbrev')).rejects.toThrow()
    expect(env).not.toHaveProperty('GIT_AUTHOR_NAME')
    expect(env).not.toHaveProperty('GIT_COMMITTER_EMAIL')
    await expect(git('-C', 'repo', 'commit', '--allow-empty', '-q', '-m', 'without identity')).rejects.toMatchObject({ stderr: expect.stringContaining('no email was given') })
    await git('-C', 'repo', '-c', 'user.name=Alice', '-c', 'user.email=alice@example.com', 'commit', '--allow-empty', '-q', '-m', 'with identity')
    expect(await git('-C', 'repo', 'log', '-1', '--format=%an <%ae> / %cn <%ce>')).toBe('Alice <alice@example.com> / Alice <alice@example.com>')
  })
})

it('fails instead of asking the operator\'s askpass helpers when the agent\'s credential helper has no answer', async () => {
  const log = join(dir, 'asked')
  const askpass = program(join(dir, 'askpass'), `echo asked >> ${log}; echo operator-secret`)
  const agent = program(join(dir, 'real', 'gh'), 'exit 0')
  const deployment = testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: agent } })
  await writeEnvironment(deployment, [])
  const env = workerEnv({ PATH: process.env.PATH, HOME: dir, GIT_ASKPASS: askpass, SSH_ASKPASS: askpass, ...agentVariables(dir) })
  await exec('git', ['init', '-q', 'repo'], { cwd: dir, env })
  await exec('git', ['-C', 'repo', 'config', 'core.askPass', askpass], { cwd: dir, env })
  const fill = exec('git', ['-C', 'repo', 'credential', 'fill'], { cwd: dir, env, timeout: 10_000 })
  fill.child.stdin?.end('protocol=https\nhost=github.com\n\n')
  await expect(fill).rejects.toMatchObject({ stderr: expect.stringContaining('terminal prompts disabled') })
  expect(() => readFileSync(log, 'utf8')).toThrow()
})

it('removes every spelling of a directory from PATH and keeps the other entries', () => {
  mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true })
  symlinkSync(join(dir, 'state'), join(dir, 'link'))
  const bin = join(dir, 'state', 'worker-bin')
  expect(withoutDirectory([`${bin}/`, join(dir, 'link', 'worker-bin'), '/usr/bin', 'node_modules/.bin'].join(':'), bin)).toBe('/usr/bin:node_modules/.bin')
})

/** Minimal SubprocessRuntime backed by child_process.spawn with an isolated global git config. */
const subprocess = (config: string): SubprocessRuntime => ({
  spawn: ({ argv, cwd }: { argv: readonly string[]; cwd: string }) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env: gitEnv({ GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' }) })
    const output = { stdout: '', stderr: '' }
    child.stdout.on('data', chunk => { output.stdout += String(chunk) })
    child.stderr.on('data', chunk => { output.stderr += String(chunk) })
    const reader = (name: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: output[name], nextOffset: 0, lossy: false }) })
    const done = new Promise(resolve => child.on('close', code => resolve({ exitCode: code, signal: null })))
    return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') } }
  },
}) as unknown as SubprocessRuntime
describe('ticket directory check', () => {
  const signal = new AbortController().signal
  const env = () => gitEnv({ GIT_CONFIG_GLOBAL: join(dir, 'global'), GIT_CONFIG_NOSYSTEM: '1' })
  const git = (...args: string[]) => exec('git', args, { cwd: dir, env: env() })
  const check = (directory: string) => verifyDirectory(join(dir, directory), subprocess(join(dir, 'global')), signal)
  beforeEach(() => { writeFileSync(join(dir, 'global'), '[credential]\n\thelper = global-helper\n') })
  it('passes a directory whose repository adds no credentials, and one outside any repository', async () => {
    await git('init', '-q', 'repo')
    await expect(check('repo')).resolves.toBeUndefined()
    // When no config key matches at all, git config --get-regexp exits with status 1.
    writeFileSync(join(dir, 'global'), '')
    await expect(check('real')).resolves.toBeUndefined()
  })
  it('names the credential settings of the repository\'s own configuration', async () => {
    await git('init', '-q', 'repo')
    await git('-C', 'repo', 'config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic x')
    await expect(check('repo')).rejects.toThrow('sets http.https://github.com/.extraheader')
  })
  it('fails when git cannot read the repository\'s configuration, instead of passing it', async () => {
    await git('init', '-q', 'repo')
    writeFileSync(join(dir, 'repo', '.git', 'config'), '[core\n')
    await expect(check('repo')).rejects.toThrow(/bad config/)
  })
  it('reports a failed command\'s exit status', async () => {
    const failing = ['sh', '-c', 'echo nope >&2; exit 3']
    const error = await runAsWorker(subprocess(join(dir, 'global')), failing, dir, signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CliError)
    expect(error).toMatchObject({ message: 'nope', exitCode: 3 })
  })
})

describe('the repository the host\'s environment names', () => {
  it('is left alone by the tests\' git and named in no worker\'s environment, as when they run inside `git rebase --exec`', async () => {
    // A scratch repository stands for the one under test, which `git rebase --exec` names in GIT_DIR and GIT_WORK_TREE.
    await exec('git', ['init', '-q', 'scratch'], { cwd: dir, env: gitEnv() })
    const config = () => readFileSync(join(dir, 'scratch', '.git', 'config'), 'utf8')
    const before = config()
    vi.stubEnv('GIT_DIR', join(dir, 'scratch', '.git')); vi.stubEnv('GIT_WORK_TREE', join(dir, 'scratch'))
    // The operator's limit on git's search for a repository names none, and stays.
    vi.stubEnv('GIT_CEILING_DIRECTORIES', dir)
    try {
      // What the tests do: a repository of their own, checked as a ticket directory.
      await exec('git', ['init', '-q', 'repo'], { cwd: dir, env: gitEnv({ GIT_CONFIG_GLOBAL: join(dir, 'global'), GIT_CONFIG_NOSYSTEM: '1' }) })
      writeFileSync(join(dir, 'global'), '')
      await expect(verifyDirectory(join(dir, 'repo'), subprocess(join(dir, 'global')), new AbortController().signal)).resolves.toBeUndefined()
      expect(readdirSync(join(dir, 'repo'))).toContain('.git')
      expect(config()).toBe(before)
      // The worker environment, which workers' shells and the host's own commands get, names no repository.
      const env = workerEnv({ ...process.env, ...agentVariables(dir) })
      for (const name of GIT_LOCATION) expect(env, name).not.toHaveProperty(name)
      expect(env.GIT_CEILING_DIRECTORIES).toBe(dir)
    } finally { vi.unstubAllEnvs() }
  })
})

describe('shared dispatchers', () => {
  const shared = () => sharedWorkers(join(dir, 'shared'))
  const a = () => join(dir, 'a'), b = () => join(dir, 'b')
  /** Both instances configured: A blocks personal-gh (its shim exists), B blocks nothing. */
  const both = (): Dispatch => ({ configured: [workerBin(a()), workerBin(b())], present: 2, commands: ['personal-gh'] })
  beforeEach(async () => {
    // The real gh answers as the account its configuration directory names, also as a git credential helper.
    program(join(dir, 'real', 'gh'), [
      'account=$(basename "$GH_CONFIG_DIR")',
      'if [ "$1 $2" = "auth git-credential" ]; then cat > /dev/null; echo username=x-access-token; echo "password=token-$account"; exit 0; fi',
      'echo "gh as $account: $*"',
    ].join('\n'))
    program(join(dir, 'real', 'personal-gh'), 'echo "personal gh: $*"')
    // Account wrappers that call gh by name, as docs/006-deployment.md shows.
    const wrapper = (name: string) => program(join(dir, `gh-${name}`), `GH_CONFIG_DIR=${dir}/${name}-config exec gh "$@"`)
    const base = testDeployment()
    await writeEnvironment(testDeployment({ stateDir: a(), github: { ...base.github, cli: wrapper('a'), login: 'agent-a' }, feishu: undefined }), ['personal-gh'])
    await writeEnvironment(testDeployment({ stateDir: b(), github: { ...base.github, cli: wrapper('b'), login: 'agent-b' }, feishu: undefined }), [])
    await writeSharedGitConfig(shared())
    await writeDispatchers(shared(), both())
  })
  /** A worker shell's environment: the process's as the shared environment sets it, and DSH_SUPERAGENT_WORKER_BIN when given. */
  const shell = (bin?: string, extra: Record<string, string> = {}) => workerEnv({ PATH: [shared().bin, join(dir, 'real'), '/usr/bin', '/bin'].join(':'), HOME: dir,
    ...neutralVariables(), GIT_CONFIG_GLOBAL: shared().gitconfig, ...bin === undefined ? {} : { DSH_SUPERAGENT_WORKER_BIN: bin }, ...extra })
  const run = (command: string, args: string[], env: Record<string, string>) => exec(command, args, { cwd: dir, env, timeout: 10_000 })
  const output = async (command: string, args: string[], env: Record<string, string>) => (await run(command, args, env)).stdout
  const refusal = (command: string, env: Record<string, string>) => expect(run(command, ['api', 'user'], env)).rejects

  it('run the shims of the instance the variable names, through a wrapper that calls gh by name without looping', async () => {
    expect(await output('gh', ['api', 'user'], shell(workerBin(a())))).toBe('gh as a-config: api user\n')
    expect(await output('gh', ['api', 'user'], shell(workerBin(b())))).toBe('gh as b-config: api user\n')
    // And say which program they would run, as setup checks.
    expect(await output('gh', [], shell(workerBin(b()), { DSH_SUPERAGENT_WORKER_RESOLVE: '1' }))).toBe(`${join(workerBin(b()), 'gh')}\n`)
  })
  it('run a command one instance blocks as blocked for it and as itself for another', async () => {
    await refusal('personal-gh', shell(workerBin(a()))).toMatchObject({ code: 1, stderr: 'personal-gh is blocked in this installation; use gh, which acts as agent-a.\n' })
    expect(await output('personal-gh', ['x'], shell(workerBin(b())))).toBe('personal gh: x\n')
    expect(await output('personal-gh', [], shell(workerBin(b()), { DSH_SUPERAGENT_WORKER_RESOLVE: '1' }))).toBe(`${join(dir, 'real', 'personal-gh')}\n`)
  })
  it('stand for the only instance when the variable is unset, and refuse when several share the process', async () => {
    await writeDispatchers(shared(), { configured: [workerBin(a())], present: 1, commands: [] })
    expect(await output('gh', ['api', 'user'], shell())).toBe('gh as a-config: api user\n')
    const several = 'gh is unavailable here: several dsh-superagent instances share this process, and this command runs outside their sessions, so it has no account to act as.\n'
    // One configured instance and one still waiting for setup.
    await writeDispatchers(shared(), { configured: [workerBin(a())], present: 2, commands: [] })
    await refusal('gh', shell()).toMatchObject({ code: 1, stderr: several })
    await writeDispatchers(shared(), both())
    await refusal('gh', shell()).toMatchObject({ code: 1, stderr: several })
    // While no instance is configured, as before the first setup or while the only one restarts, nothing reaches a real CLI.
    await writeDispatchers(shared(), { configured: [], present: 1, commands: ['personal-gh'] })
    await refusal('gh', shell()).toMatchObject({ code: 1, stderr: 'gh is unavailable: the dsh-superagent instance of this process has not finished setup.\n' })
    await writeDispatchers(shared(), { configured: [], present: 0, commands: ['personal-gh'] })
    await refusal('gh', shell()).toMatchObject({ code: 1, stderr: 'gh is unavailable: no dsh-superagent instance runs in this process.\n' })
    await refusal('lark-cli', shell()).toMatchObject({ code: 1, stderr: 'lark-cli is unavailable: no dsh-superagent instance runs in this process.\n' })
    // A command an instance blocked fails too, rather than running the real one.
    await refusal('personal-gh', shell()).toMatchObject({ code: 1, stderr: 'personal-gh is unavailable: no dsh-superagent instance runs in this process.\n' })
    // The variable names an instance that is no longer configured.
    await refusal('gh', shell(workerBin(a()))).toMatchObject({ code: 1, stderr: expect.stringContaining('names no dsh-superagent instance that finished setup') })
    await refusal('personal-gh', shell(workerBin(b()))).toMatchObject({ code: 1, stderr: expect.stringContaining('names no dsh-superagent instance that finished setup') })
  })
  it('refuse an unknown directory and the values that say the owner is not ready or not one', async () => {
    await refusal('gh', shell(join(dir, 'elsewhere'))).toMatchObject({ code: 1,
      stderr: 'gh is unavailable: DSH_SUPERAGENT_WORKER_BIN names no dsh-superagent instance that finished setup in this process.\n' })
    await refusal('gh', shell('')).toMatchObject({ code: 1, stderr: expect.stringContaining('names no dsh-superagent instance') })
    await refusal('lark-cli', shell('unconfigured')).toMatchObject({ code: 1, stderr: 'lark-cli is unavailable: the dsh-superagent instance of this session has not finished setup.\n' })
    await refusal('gh', shell('ambiguous')).toMatchObject({ code: 1, stderr: 'gh is unavailable: more than one dsh-superagent instance claims this session.\n' })
  })
  it('give git the credentials of the instance the variable names, and fail without asking anyone when no instance owns the call', async () => {
    const log = join(dir, 'asked')
    const askpass = program(join(dir, 'askpass'), `echo asked >> ${log}; echo operator-secret`)
    const fill = async (env: Record<string, string>) => {
      const child = run('git', ['credential', 'fill'], env)
      child.child.stdin?.end('protocol=https\nhost=github.com\n\n')
      return (await child).stdout
    }
    expect(await fill(shell(workerBin(a())))).toContain('password=token-a-config')
    expect(await fill(shell(workerBin(b())))).toContain('password=token-b-config')
    // Operator askpass helpers stay unasked: GIT_ASKPASS is empty in the shared environment and overrides SSH_ASKPASS.
    await expect(fill(shell(undefined, { SSH_ASKPASS: askpass }))).rejects.toMatchObject({
      stderr: expect.stringMatching(/several dsh-superagent instances share this process[\s\S]*terminal prompts disabled/) })
    expect(() => readFileSync(log, 'utf8')).toThrow()
    expect(readFileSync(shared().gitconfig, 'utf8')).toContain(`helper = "${credentialHelper(join(shared().bin, 'gh'))}"`)
    // The shared configuration names no identity: a worker's commit takes the author its instructions name.
    await expect(run('git', ['config', 'user.email'], shell(workerBin(a())))).rejects.toMatchObject({ code: 1, stdout: '' })
    await expect(run('git', ['config', '--get-regexp', '^user\\.(name|email)$'], shell(workerBin(a())))).rejects.toMatchObject({ code: 1 })
  })
  it('write gh, lark-cli and the blocked commands of configured instances only, and refuse what they did not write', async () => {
    expect(readdirSync(shared().bin).sort()).toEqual(['gh', 'lark-cli', 'personal-gh'])
    await writeDispatchers(shared(), { configured: [workerBin(b())], present: 2, commands: ['git', 'gh'] })
    expect(readdirSync(shared().bin).sort()).toEqual(['gh', 'lark-cli'])
    writeFileSync(join(shared().bin, 'mine'), '#!/bin/sh\n')
    await expect(writeDispatchers(shared(), both())).rejects.toThrow(`${join(shared().bin, 'mine')} was not written by dsh-superagent`)
  })
})
