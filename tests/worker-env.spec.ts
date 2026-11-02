/** The shared worker environment: owners of shell calls, the process environment it applies, the dispatchers it keeps, and the plugin entry. */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { workerBin } from '../src/infra/environment.ts'
import { SHARED_DIRECTORY, WorkerRegistry, apply, type WorkerMember } from '../src/worker-env.ts'

let dir: string
let registries: WorkerRegistry[]
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'worker-env-')); registries = [] })
afterEach(async () => { for (const registry of registries) await registry.stop(); rmSync(dir, { recursive: true, force: true }) })

const ORIGINAL = { PATH: '/usr/local/bin:/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/home/me/.gitconfig', GH_TOKEN: 'operator', GIT_AUTHOR_NAME: 'Operator', HOME: '/home/me' }
/** A started registry in `<dir>/shared` that applies to a copy of ORIGINAL, counting the writes of every variable. */
async function started(env: Record<string, string | undefined> = { ...ORIGINAL }) {
  const writes: string[] = []
  const counted = new Proxy(env, {
    set: (target, name, value) => { writes.push(String(name)); target[name as string] = value; return true },
    deleteProperty: (target, name) => { writes.push(String(name)); delete target[name as string]; return true },
  })
  const registry = new WorkerRegistry(join(dir, 'shared'), counted, { warn: () => {} })
  registries.push(registry)
  await registry.start()
  return { registry, env, writes }
}
/** An instance with state directory `<dir>/<name>` that owns `orchestrator-<name>` and the workers of `tickets`. */
const member = (name: string, tickets: string[] = []): WorkerMember => ({
  stateDir: join(dir, name), owns: id => id === `orchestrator-${name}` || tickets.some(ticket => id === `worker-${ticket}`),
})
/** Fake agents by Session id, each with its parent Session. */
function agents(parents: Record<string, string | undefined>) {
  const all = new Map(Object.entries(parents).map(([id, parentSession]) => [id, { id, session: { header: { id, parentSession } } } as unknown as Agent]))
  return { of: (id: string) => all.get(id), get: (id: string) => all.get(id) }
}

describe('owner of a shell call', () => {
  it('is the instance that owns the Session or its nearest owned parent, up to eight parents', async () => {
    const { registry } = await started()
    const a = registry.join(member('a', ['t1'])), b = registry.join(member('b', ['t2']))
    await a.configure([]); await b.configure([])
    const chain = { 'orchestrator-a': undefined, 'worker-t1': undefined, 'worker-t2': undefined, sub1: 'worker-t2', sub2: 'sub1', other: undefined,
      ...Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`deep${index}`, index ? `deep${index - 1}` : 'worker-t1'])) }
    const { of, get } = agents(chain)
    const resolve = (id: string) => registry.resolve(of(id), get)
    expect(resolve('orchestrator-a')).toBe(workerBin(join(dir, 'a')))
    expect(resolve('worker-t1')).toBe(workerBin(join(dir, 'a')))
    expect(resolve('worker-t2')).toBe(workerBin(join(dir, 'b')))
    expect(resolve('sub2')).toBe(workerBin(join(dir, 'b')))
    expect(resolve('deep7')).toBe(workerBin(join(dir, 'a')))
    // Nine subagents down, the worker is past the walk.
    expect(resolve('deep8')).toBeUndefined()
    expect(resolve('other')).toBeUndefined()
    expect(registry.resolve(undefined, get)).toBeUndefined()
    // A parent that is not loaded is still looked at by its id.
    expect(registry.resolve(agents({ sub: 'worker-t1' }).of('sub'), () => undefined)).toBe(workerBin(join(dir, 'a')))
    await a.release(); await b.release()
  })
  it('makes the dispatchers fail when its instance has not finished setup, or several claim the Session or cannot say', async () => {
    const { registry } = await started()
    const a = registry.join(member('a', ['t1']))
    const b = registry.join(member('b', ['t1']))
    const c = registry.join({ stateDir: join(dir, 'c'), owns: id => { if (id === 'broken') throw new Error('closed'); return false } })
    const { of, get } = agents({ 'orchestrator-a': undefined, 'worker-t1': undefined, broken: undefined })
    expect(registry.resolve(of('orchestrator-a'), get)).toBe('unconfigured')
    await a.configure([])
    expect(registry.resolve(of('orchestrator-a'), get)).toBe(workerBin(join(dir, 'a')))
    expect(registry.resolve(of('worker-t1'), get)).toBe('ambiguous')
    expect(registry.resolve(of('broken'), get)).toBe('unconfigured')
    await a.unconfigure()
    expect(registry.resolve(of('orchestrator-a'), get)).toBe('unconfigured')
    await a.release()
    expect(registry.resolve(of('orchestrator-a'), get)).toBeUndefined()
    await b.release(); await c.release()
  })
})

describe('process environment', () => {
  it('is applied once when the registry starts and restored exactly once when it stops', async () => {
    const { registry, env, writes } = await started()
    const shared = registry.shared
    expect(env).toEqual({ PATH: `${shared.bin}:${ORIGINAL.PATH}`, GIT_CONFIG_GLOBAL: shared.gitconfig, GIT_CONFIG_NOSYSTEM: '1', GIT_ASKPASS: '',
      GIT_TERMINAL_PROMPT: '0', HOME: '/home/me' })
    const applied = writes.length
    expect(writes.filter(name => name === 'PATH')).toHaveLength(1)
    await registry.stop()
    expect(env).toEqual(ORIGINAL)
    expect(writes.filter(name => name === 'PATH')).toHaveLength(2)
    await registry.stop()
    expect(writes).toHaveLength(applied * 2)
  })
  it('stays identical while instances register, configure, restart, block commands and unregister', async () => {
    const { registry, env, writes } = await started()
    const applied = { ...env }, count = writes.length
    const a = registry.join(member('a'))
    await a.configure(['personal-gh'])
    let b = registry.join(member('b'))
    await b.configure([])
    // B restarts: it releases its registration and registers again before its setup finished.
    await b.release()
    b = registry.join(member('b'))
    expect(env).toEqual(applied)
    await b.configure(['curl'])
    await a.block([])
    await a.unconfigure()
    await a.release(); await b.release()
    expect(env).toEqual(applied)
    expect(writes).toHaveLength(count)
  })
  it('is restored only once the instances still registered when it stops released theirs', async () => {
    const { registry, env } = await started()
    const a = registry.join(member('a'))
    await a.configure([])
    let stopped = false
    const stopping = registry.stop().then(() => { stopped = true })
    expect(() => registry.join(member('b'))).toThrow('stopping')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(stopped).toBe(false)
    expect(env.PATH).toBe(`${registry.shared.bin}:${ORIGINAL.PATH}`)
    await a.release()
    await stopping
    expect(env).toEqual(ORIGINAL)
  })
})

describe('a command no Session owns', () => {
  const gh = (registry: WorkerRegistry) => readFileSync(join(registry.shared.bin, 'gh'), 'utf8')
  it('runs as the only instance the process has run, and fails while it restarts', async () => {
    const { registry } = await started()
    let a = registry.join(member('a'))
    await a.configure([])
    expect(gh(registry)).toContain(`else bin='${workerBin(join(dir, 'a'))}'`)
    await a.release()
    expect(gh(registry)).toContain('the dsh-superagent instance of this process has not finished setup')
    a = registry.join(member('a'))
    expect(gh(registry)).toContain('the dsh-superagent instance of this process has not finished setup')
    await a.configure([])
    expect(gh(registry)).toContain(`else bin='${workerBin(join(dir, 'a'))}'`)
    await a.release()
  })
  it('fails once a second instance has run, also while it restarts and only the first is left', async () => {
    const { registry } = await started()
    const a = registry.join(member('a'))
    await a.configure([])
    const b = registry.join(member('b'))
    await b.configure([])
    await b.release()
    expect(gh(registry)).not.toContain(`else bin=`)
    expect(gh(registry)).toContain('several dsh-superagent instances share this process')
    await a.release()
  })
})

describe('shared directory', () => {
  const dispatcher = (registry: WorkerRegistry, name: string) => readFileSync(join(registry.shared.bin, name), 'utf8')
  it('is private, and its dispatchers serve configured instances and keep every command one blocked', async () => {
    const { registry } = await started()
    expect(statSync(registry.shared.dir).mode & 0o777).toBe(0o700)
    expect(readdirSync(registry.shared.bin).sort()).toEqual(['gh', 'lark-cli'])
    expect(dispatcher(registry, 'gh')).toContain('no dsh-superagent instance runs in this process')
    const a = registry.join(member('a'))
    await a.configure(['personal-gh'])
    expect(readdirSync(registry.shared.bin).sort()).toEqual(['gh', 'lark-cli', 'personal-gh'])
    expect(dispatcher(registry, 'gh')).toContain(`else bin='${workerBin(join(dir, 'a'))}'`)
    await a.block([])
    await a.release()
    expect(readdirSync(registry.shared.bin).sort()).toEqual(['gh', 'lark-cli', 'personal-gh'])
    expect(dispatcher(registry, 'personal-gh')).not.toContain(workerBin(join(dir, 'a')))
  })
  it('refuses a dispatcher directory holding what dsh-superagent did not write, and leaves the environment alone', async () => {
    const { registry } = await started()
    await registry.stop()
    writeFileSync(join(registry.shared.bin, 'mine'), '#!/bin/sh\n')
    const env = { ...ORIGINAL }
    const next = new WorkerRegistry(registry.shared.dir, env, { warn: () => {} })
    await expect(next.start()).rejects.toThrow('was not written by dsh-superagent')
    expect(env).toEqual(ORIGINAL)
    // It also gave its lock back.
    rmSync(join(registry.shared.bin, 'mine'))
    await started()
  })
  it('waits for a registry of the same directory in this process to finish before it takes the directory', async () => {
    const first = await started()
    const a = first.registry.join(member('a'))
    void first.registry.stop()
    const env = { ...ORIGINAL }
    const second = new WorkerRegistry(first.registry.shared.dir, env, { warn: () => {} })
    registries.push(second)
    let taken = false
    const starting = second.start().then(() => { taken = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(taken).toBe(false)
    await a.release()
    await starting
    expect(first.env).toEqual(ORIGINAL)
    expect(env.PATH).toBe(`${second.shared.bin}:${ORIGINAL.PATH}`)
  })
})

describe('plugin entry', () => {
  it('keeps its directory under the profile, provides the registry and contributes DSH_SUPERAGENT_WORKER_BIN to shell calls', async () => {
    const profile = join(dir, 'profile')
    const provided = new Map<string, unknown>(), effects: (() => unknown)[] = []
    const contributors: { name: string; variables: Record<string, { description: string }>; resolve(execution: { agent?: Agent }): Record<string, string> }[] = []
    const { of } = agents({ 'orchestrator-a': undefined, sub: 'orchestrator-a', other: undefined })
    const child = { shellEnv: { register: vi.fn((contributor: typeof contributors[number]) => { contributors.push(contributor); return () => {} }) },
      get: (name: string) => name === 'agents' ? { get: of } : undefined }
    // The entry applies to process.env itself, which its stop restores; this file's worker process alone sees it meanwhile.
    const before = { ...process.env }, env = process.env
    try {
      const ctx = {
        get: (name: string) => name === 'profileContext' ? { name: 'superagent', dir: profile } : undefined,
        logger: { info: vi.fn(), warn: vi.fn() },
        effect: (effect: () => unknown) => { effects.push(effect) },
        provide: (name: string, value: unknown) => { provided.set(name, value) },
        inject: (names: string[], callback: (child: unknown) => void) => { expect(names).toEqual(['shellEnv']); callback(child) },
      }
      await apply(ctx as never)
      const registry = provided.get('superagentWorkers') as WorkerRegistry
      registries.push(registry)
      expect(registry.shared.dir).toBe(join(profile, SHARED_DIRECTORY))
      expect(env.PATH?.split(':')[0]).toBe(join(profile, SHARED_DIRECTORY, 'bin'))
      expect(env.GIT_CONFIG_GLOBAL).toBe(join(profile, SHARED_DIRECTORY, 'gitconfig'))
      const [contributor] = contributors
      expect(contributor!.variables).toHaveProperty('DSH_SUPERAGENT_WORKER_BIN')
      const a = registry.join(member('a'))
      await a.configure([])
      expect(contributor!.resolve({ agent: of('sub') })).toEqual({ DSH_SUPERAGENT_WORKER_BIN: workerBin(join(dir, 'a')) })
      expect(contributor!.resolve({ agent: of('other') })).toEqual({})
      expect(contributor!.resolve({})).toEqual({})
      await a.release()
      for (const effect of effects) await (effect() as () => Promise<void>)()
      expect({ ...process.env }).toEqual(before)
    } finally { for (const name of Object.keys(process.env)) if (!(name in before)) delete process.env[name]; Object.assign(process.env, before) }
  })
})
