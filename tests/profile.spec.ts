/** Adding an instance to the DSH profile: the patch block, appending it, the writer lock, validation, reload and restore. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstanceView } from '../src/instance.ts'
import { AddInstanceFailure, InstanceAdder, MAX_BODY_BYTES, appendBlock, instanceBlock, parseRequest, patchIds, readRequest, withProfileLock,
  yamlString, type AdderHost, type Hmr, type LoaderEntry, type Reconciled } from '../src/infra/profile.ts'

/** js-yaml as Cordis's include plugin, which reads profile patches, resolves it. */
const include = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/cordis/package.json')).resolve('@deepseek-ai/cordis-plugin-include')
const yaml = await import(createRequire(include).resolve('js-yaml')) as { load(text: string): unknown }
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'profile-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const TEMPLATE = '# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array.\n[]\n'
const block = instanceBlock('b', '/state/superagent-b')

describe('patch block', () => {
  it('is the group of docs/006-deployment.md with every string JSON-quoted', () => {
    expect(yaml.load(block)).toEqual([{ insert: [{ id: 'superagent-b', name: 'cordis:group', group: true, isolate: { orchestrator: true }, config: [
      { id: 'superagent-b-core', name: 'dsh-superagent', config: { stateDir: '/state/superagent-b', instance: 'b' } },
      { id: 'superagent-b-github', name: 'dsh-superagent/github-watch' },
      { id: 'superagent-b-feishu', name: 'dsh-superagent/feishu-watch', disabled: true },
    ] }] }])
    expect(block.endsWith('\n')).toBe(true)
  })
  it('keeps a stateDir with YAML syntax, quotes, escapes and unprintable characters', () => {
    const odd = '/s/a: b # "c" \\d\n\t\u0085\u2028[e]{f}&*!|>\'%@`'
    const [row] = yaml.load(instanceBlock('x', odd)) as { insert: { config: { config?: { stateDir: string } }[] }[] }[]
    expect(row!.insert[0]!.config[0]!.config!.stateDir).toBe(odd)
    expect(yamlString('\u2028')).toBe('"\\u2028"')
  })
})

describe('appending to the patch file', () => {
  const load = (text: string) => yaml.load(text) as unknown[]
  it('makes a missing or empty file just the block', () => {
    expect(appendBlock(undefined, block)).toBe(block)
    expect(appendBlock('', block)).toBe(block)
  })
  it('replaces an empty sequence, keeping the comments around it', () => {
    const text = appendBlock(TEMPLATE, block)
    expect(text).toBe(`${TEMPLATE.replace('[]\n', '')}${block}`)
    expect(load(text)).toHaveLength(1)
    expect(appendBlock('[]', block)).toBe(block)
    expect(appendBlock('  [ ]  # none yet\n\n', block)).toBe(`\n${block}`)
    expect(appendBlock('# only a comment\n', block)).toBe(`# only a comment\n${block}`)
  })
  it('appends after every existing byte, adding the missing final newline', () => {
    const existing = '- id: webserver\n  config:\n    port: 1 # keep\n'
    expect(appendBlock(existing, block)).toBe(existing + block)
    expect(appendBlock(existing.trimEnd(), block)).toBe(existing + block)
    expect(load(appendBlock(existing, block))).toHaveLength(2)
    expect(appendBlock('- id: a\n[]\n', block)).toBe(`- id: a\n[]\n${block}`)
  })
  it('reads the ids a patch names, in any style', () => {
    expect(patchIds(`- id: a\n- {id: "b", name: x}\n- id: 'c''d' # e\n  my-id: f\n  config: { id: g }\n${block}`))
      .toEqual(new Set(['a', 'b', "c'd", 'g', 'superagent-b', 'superagent-b-core', 'superagent-b-github', 'superagent-b-feishu']))
  })
})

describe('writer lock', () => {
  const file = () => join(dir, 'package.json')
  const lock = () => `${file()}.lock`
  it('creates a private lock with this process id and removes it after the operation, also when it fails', async () => {
    let seen = ''
    await withProfileLock(file(), async () => { seen = readFileSync(lock(), 'utf8'); expect(statSync(lock()).mode & 0o777).toBe(0o600) })
    expect(seen).toBe(`${process.pid}\n`)
    expect(existsSync(lock())).toBe(false)
    await expect(withProfileLock(file(), () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(existsSync(lock())).toBe(false)
  })
  it('takes over a lock whose holder exited', async () => {
    const dead = spawnSync(process.execPath, ['-e', '']).pid!
    writeFileSync(lock(), `${dead}\n`)
    let ran = false
    await withProfileLock(file(), async () => { ran = true; expect(readFileSync(lock(), 'utf8')).toBe(`${process.pid}\n`) }, 1000)
    expect(ran).toBe(true)
  })
  it('waits for a lock of this process or a live one, and times out', async () => {
    writeFileSync(lock(), `${process.pid}\n`)
    let entered = false
    const waiting = withProfileLock(file(), async () => { entered = true }, 5000)
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(entered).toBe(false)
    rmSync(lock())
    await waiting
    expect(entered).toBe(true)
    writeFileSync(lock(), `${process.ppid}\n`)
    await expect(withProfileLock(file(), async () => {}, 100)).rejects.toThrow(/timed out waiting for the writer lock/)
    writeFileSync(lock(), 'garbage')
    await expect(withProfileLock(file(), async () => {}, 100)).rejects.toThrow(/timed out/)
  })
})

describe('request', () => {
  const body = (text: string) => Readable.from([Buffer.from(text)])
  const invalid = (run: () => unknown) => { try { run() } catch (error) { return error instanceof AddInstanceFailure && error.status === 400 && error.code === 'invalid' } return false }
  it('takes exactly { instance } with a non-empty slug', async () => {
    expect(parseRequest({ instance: 'b-2' })).toBe('b-2')
    for (const value of [null, [], 'b', {}, { instance: '' }, { instance: 'B' }, { instance: 'a--b' }, { instance: 'x'.repeat(33) }, { instance: 1 },
      { instance: 'b', extra: 1 }]) expect(invalid(() => parseRequest(value))).toBe(true)
    await expect(readRequest(body('{"instance":"b"}'))).resolves.toEqual({ instance: 'b' })
    await expect(readRequest(body('{'))).rejects.toMatchObject({ status: 400, code: 'invalid' })
    await expect(readRequest(body(JSON.stringify({ instance: 'x'.repeat(MAX_BODY_BYTES) })))).rejects.toMatchObject({ status: 400, code: 'invalid' })
  })
})

describe('adding an instance', () => {
  interface Rig { host: AdderHost; hmr: Hmr; joined: InstanceView[]; entries: LoaderEntry[]; profile: { dir?: string; patchPath?: string } | undefined
    reconcile: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; patch: string; base: string }
  /**
   * A profile with the template patch, a default instance in `<dir>/state`, and an `hmr` whose reconciliation reads the patch
   * file and runs `outcome` with the required ids and the text; by default it joins the new instance.
   */
  function rig(outcome?: (required: string[] | undefined, text: string, rig: Rig) => Reconciled | Promise<Reconciled>): Rig {
    const root = mkdtempSync(join(dir, 'rig-')), profileDir = join(root, 'profile'), patch = join(profileDir, 'cordis.patch.yml'), base = join(root, 'state')
    mkdirSync(profileDir); writeFileSync(patch, TEMPLATE)
    const joined: InstanceView[] = [{ instance: '', prefix: '/orchestrator', entry: 'dsh-superagent' }]
    let chain: Promise<unknown> = Promise.resolve(), inside = false
    const self = {} as Rig
    const reconcile = vi.fn(async (required?: string[]) => {
      if (!inside) throw new Error('outside runExclusive')
      const text = readFileSync(patch, 'utf8')
      yaml.load(text)
      if (outcome) return outcome(required, text, self)
      const key = /instance: "([^"]+)"/.exec(text)?.[1]
      if (key && required?.length) joined.push({ instance: key, prefix: `/orchestrator-${key}`, entry: `superagent-${key}-core` })
      return { warnings: [], pending: [] }
    })
    const hmr: Hmr = {
      runExclusive: <T>(operation: () => Promise<T>) => {
        const run = chain.then(async () => { inside = true; try { return await operation() } finally { inside = false } })
        chain = run.catch(() => {})
        return run
      },
      reconcileProfile: reconcile as unknown as Hmr['reconcileProfile'],
    }
    const warn = vi.fn(), info = vi.fn()
    Object.assign(self, { hmr, joined, entries: [], profile: { dir: profileDir, patchPath: patch }, reconcile, warn, info, patch, base })
    self.host = { profile: () => self.profile, hmr: () => self.hmr, loader: () => ({ entries: () => self.entries }), instances: () => [...joined],
      defaultStateDir: () => joined.some(view => !view.instance) ? base : undefined, logger: { info, warn } }
    return self
  }
  const adder = (r: Rig) => new InstanceAdder(r.host, { lockWaitMs: 500, joinWaitMs: 300, pollMs: 10 })
  const failure = (status: number, code: string) => expect.objectContaining({ status, code })

  it('reports whether adding is available and why not', () => {
    const r = rig()
    expect(adder(r).adding()).toEqual({ available: true, stateDirBase: r.base })
    r.joined.length = 0
    expect(adder(r).adding()).toEqual({ available: false, reason: 'no-default' })
    r.hmr = undefined as never
    expect(adder(r).adding()).toEqual({ available: false, reason: 'no-reload' })
    r.profile = { dir: '/p' }
    expect(adder(r).adding()).toEqual({ available: false, reason: 'no-profile' })
    r.profile = undefined
    expect(adder(r).adding()).toEqual({ available: false, reason: 'no-profile' })
  })
  it('appends the group, reconciles it with its required ids, waits for it to join and answers 201', async () => {
    const r = rig()
    const added = await adder(r).add({ instance: 'b' })
    const stateDir = `${r.base}-b`
    expect(added).toEqual({ status: 201, result: { applied: true, stateDir, instance: { instance: 'b', prefix: '/orchestrator-b', entry: 'superagent-b-core' } } })
    expect(readFileSync(r.patch, 'utf8')).toBe(`${TEMPLATE.replace('[]\n', '')}${instanceBlock('b', stateDir)}`)
    expect(statSync(r.patch).mode & 0o777).toBe(0o600)
    expect(r.reconcile).toHaveBeenCalledWith(['superagent-b', 'superagent-b-core', 'superagent-b-github'])
    expect(existsSync(join(r.profile!.dir!, 'package.json.lock'))).toBe(false)
    expect(r.info).toHaveBeenCalledWith(expect.stringContaining('added instance'), 'b', 'superagent-b', stateDir, r.patch, '')
  })
  it('answers 201 once applied even when the instance has not joined in time', async () => {
    const r = rig(() => ({ warnings: ['entry x inactive'], pending: [] }))
    await expect(adder(r).add({ instance: 'b' })).resolves.toMatchObject({ status: 201, result: { applied: true } })
    expect(r.warn).toHaveBeenCalledWith(expect.any(String), 'entry x inactive')
  })
  it('answers 202 with the reason when the change waits for a restart, keeping the file', async () => {
    const restart = rig(() => ({ warnings: [], pending: [], restartReason: 'resolution' }))
    await expect(adder(restart).add({ instance: 'b' })).resolves.toMatchObject({ status: 202, result: { applied: false, restartReason: 'resolution' } })
    expect(readFileSync(restart.patch, 'utf8')).toContain('superagent-b-core')
    const pending = rig(() => ({ warnings: [], pending: [{ reason: 'module-comparison' }] }))
    await expect(adder(pending).add({ instance: 'c' })).resolves.toMatchObject({ status: 202, result: { applied: false, restartReason: 'module-comparison' } })
  })
  it('restores the file and reconciles it again when DSH refuses the change', async () => {
    const r = rig(required => { if (required?.length) throw new Error('entry superagent-b-core failed to start'); return { warnings: [], pending: [] } })
    await expect(adder(r).add({ instance: 'b' })).rejects.toEqual(failure(500, 'failed'))
    expect(readFileSync(r.patch, 'utf8')).toBe(TEMPLATE)
    expect(r.reconcile).toHaveBeenCalledTimes(2)
    expect(r.reconcile).toHaveBeenLastCalledWith()
    expect(existsSync(join(r.profile!.dir!, 'package.json.lock'))).toBe(false)
  })
  it('removes a file that was missing, and still answers failed when the restore cannot reconcile', async () => {
    const r = rig(() => { throw new Error('refused') })
    rmSync(r.patch)
    await expect(adder(r).add({ instance: 'b' })).rejects.toEqual(failure(500, 'failed'))
    expect(existsSync(r.patch)).toBe(false)
    expect(r.warn).toHaveBeenCalledWith(expect.stringContaining('could not reapply'), r.patch, expect.any(String))
  })
  it('fails without writing when the profile lock stays held or hmr refuses the transaction', async () => {
    const r = rig()
    writeFileSync(join(r.profile!.dir!, 'package.json.lock'), `${process.pid}\n`)
    await expect(adder(r).add({ instance: 'b' })).rejects.toEqual(failure(500, 'failed'))
    expect(readFileSync(r.patch, 'utf8')).toBe(TEMPLATE)
    rmSync(join(r.profile!.dir!, 'package.json.lock'))
    r.hmr = { ...r.hmr, runExclusive: () => Promise.reject(new Error('HMR is disposed')) }
    await expect(adder(r).add({ instance: 'b' })).rejects.toEqual(failure(500, 'failed'))
  })
  it('refuses a taken key, entry id or stateDir with exists', async () => {
    const r = rig(), add = adder(r)
    r.joined.push({ instance: 'b', prefix: '/orchestrator-b', entry: 'x' })
    await expect(add.add({ instance: 'b' })).rejects.toEqual(failure(409, 'exists'))
    r.entries.push({ options: { id: 'superagent-c-feishu', name: 'dsh-superagent/feishu-watch' } })
    await expect(add.add({ instance: 'c' })).rejects.toEqual(failure(409, 'exists'))
    r.entries.push({ options: { id: 'other', name: 'dsh-superagent', config: { instance: 'd' } } })
    await expect(add.add({ instance: 'd' })).rejects.toEqual(failure(409, 'exists'))
    writeFileSync(r.patch, '- id: superagent-e-github\n  disabled: true\n')
    await expect(add.add({ instance: 'e' })).rejects.toEqual(failure(409, 'exists'))
    mkdirSync(`${r.base}-f`); writeFileSync(join(`${r.base}-f`, 'orchestrator.sqlite'), '')
    await expect(add.add({ instance: 'f' })).rejects.toEqual(failure(409, 'exists'))
    writeFileSync(`${r.base}-g`, '')
    await expect(add.add({ instance: 'g' })).rejects.toEqual(failure(409, 'exists'))
    expect(r.reconcile).not.toHaveBeenCalled()
    mkdirSync(`${r.base}-h`)
    await expect(add.add({ instance: 'h' })).resolves.toMatchObject({ status: 201 })
  })
  it('refuses an invalid body and an unavailable process before touching the file', async () => {
    const r = rig()
    await expect(adder(r).add({ instance: '' })).rejects.toEqual(failure(400, 'invalid'))
    r.joined.length = 0
    await expect(adder(r).add({ instance: 'b' })).rejects.toEqual(failure(409, 'unavailable'))
    expect(readFileSync(r.patch, 'utf8')).toBe(TEMPLATE)
  })
  it('adds one instance at a time, so a second request for the same key finds the first', async () => {
    const r = rig(), add = adder(r)
    const results = await Promise.allSettled([add.add({ instance: 'b' }), add.add({ instance: 'b' }), add.add({ instance: 'c' })])
    expect(results.map(result => result.status === 'fulfilled' ? result.value.status : (result.reason as AddInstanceFailure).code)).toEqual([201, 'exists', 201])
    expect(patchIds(readFileSync(r.patch, 'utf8'))).toEqual(new Set(['superagent-b', 'superagent-b-core', 'superagent-b-github', 'superagent-b-feishu',
      'superagent-c', 'superagent-c-core', 'superagent-c-github', 'superagent-c-feishu']))
  })
})
