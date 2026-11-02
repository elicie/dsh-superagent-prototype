/** Several dsh-superagent instances in one process: the instance key, its management prefix, and routing on DSH's web server. */
import { execFile } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerHttp, type HttpHost } from '../src/app/http.ts'
import { caller, type ApiMessages } from '../src/client/api.ts'
import { Config, machineOf } from '../src/deployment.ts'
import { DEFAULT_PREFIX, managementPrefix } from '../src/instance.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
interface Route { kind: 'exact' | 'prefix'; path: string; handler: Handler }
/** The route table of DSH's web server; `match` is private in its types. */
interface Table { register(route: Route): () => void; match(pathname: string): Route | undefined }

describe('instance key', () => {
  it('defaults to empty, which leaves the machine settings as they were', () => {
    const config = Config({ stateDir: '/srv/state' })
    expect(config.instance).toBe('')
    expect('instance' in machineOf(config)).toBe(false)
  })
  it('accepts a lowercase slug and passes it to the machine settings', () => {
    for (const instance of ['b', 'team-2', 'a'.repeat(32)]) expect(machineOf(Config({ stateDir: '/srv/state', instance })).instance).toBe(instance)
  })
  it('refuses anything that is not a slug', () => {
    for (const instance of ['B', '-b', 'b-', 'a--b', 'a_b', 'a/b', '../b', 'b.c', ' b', 'a'.repeat(33)]) {
      expect(() => Config({ stateDir: '/srv/state', instance }), instance).toThrow('regexp')
    }
  })
})

describe('management prefix', () => {
  it('keeps /orchestrator for the default instance and gives another a sibling prefix', () => {
    expect(managementPrefix()).toBe('/orchestrator')
    expect(managementPrefix('')).toBe(DEFAULT_PREFIX)
    expect(managementPrefix('b')).toBe('/orchestrator-b')
    expect(managementPrefix('api')).toBe('/orchestrator-api')
    expect(() => managementPrefix('a/b')).toThrow('lowercase slug')
  })
})

/** DSH's web server route table: its own `register` and `match`, without a listener. */
function routeTable() {
  const server = Object.assign(Object.create(WebServer.prototype) as object, { exact: new Map(), prefixes: new Map() }) as unknown as Table
  const webServer = { host: '127.0.0.1', port: 3082, register: (route: Route) => server.register(route) }
  return { server, ctx: { webServer } }
}
const host = (masterId: string, instance?: string) =>
  ({ ready: Promise.resolve(), machine: { stateDir: `/srv/${masterId}`, ...instance ? { instance } : {} }, models: () => ({ masterId }) }) as unknown as HttpHost
async function request(server: Table, url: string) {
  const route = server.match(new URL(url, 'http://x').pathname)
  if (!route) return { status: 'unrouted' as const }
  let status = 0, text = ''
  await route.handler({ method: 'GET', url, headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' }, async *[Symbol.asyncIterator]() {} },
    { writeHead: (code: number) => { status = code }, end: (data = '') => { text = data } })
  return { status, body: text ? JSON.parse(text) as unknown : undefined }
}

describe('routing on one web server', () => {
  it('routes each instance\'s API to it, and leaves the default instance and the host-level Grok routes where they were', async () => {
    const { server, ctx } = routeTable()
    registerHttp(ctx as never, host('A'))
    registerHttp(ctx as never, host('B', 'b'))
    registerHttp(ctx as never, host('API', 'api'))
    server.register({ kind: 'prefix', path: '/orchestrator/api/subscriptions/grok', handler: async (_req, res) => { (res as { end: (text: string) => void }).end('{"grok":true}') } })
    expect(await request(server, '/orchestrator/api/models')).toEqual({ status: 200, body: { masterId: 'A' } })
    expect(await request(server, '/orchestrator-b/api/models')).toEqual({ status: 200, body: { masterId: 'B' } })
    expect(await request(server, '/orchestrator-api/api/models')).toEqual({ status: 200, body: { masterId: 'API' } })
    expect(await request(server, '/orchestrator/api/subscriptions/grok')).toEqual({ status: 0, body: { grok: true } })
    // Grok subscriptions stay with the host-level plugin; an instance prefix does not serve them.
    expect(await request(server, '/orchestrator-b/api/subscriptions/grok')).toMatchObject({ status: 404 })
    // Prefixes match whole path segments, so neither the default nor `b` serves a key that only starts like theirs.
    expect(await request(server, '/orchestrator-bb/api/models')).toEqual({ status: 'unrouted' })
    expect(await request(server, '/orchestrator-b/models')).toEqual({ status: 404, body: undefined })
  })
  it('refuses a second instance with the same key when it registers its routes', () => {
    const { ctx } = routeTable()
    registerHttp(ctx as never, host('B', 'b'))
    expect(() => registerHttp(ctx as never, host('C', 'b'))).toThrow('webserver: duplicate prefix route "/orchestrator-b"')
    expect(() => registerHttp(ctx as never, host('D'))).not.toThrow()
  })
  it('frees an instance\'s prefix when it stops, so a request finds no route rather than another instance', async () => {
    const { server, ctx } = routeTable()
    registerHttp(ctx as never, host('A'))
    const dispose = registerHttp(ctx as never, host('B', 'b'))
    dispose()
    expect(await request(server, '/orchestrator-b/api/models')).toEqual({ status: 'unrouted' })
    expect(await request(server, '/orchestrator/api/models')).toEqual({ status: 200, body: { masterId: 'A' } })
  })
})

describe('panel client', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  const messages = (): ApiMessages => ({ offline: '', notRunning: '', serverError: () => '', requestFailed: () => '', setup: () => '', user: () => '' })
  it('calls /orchestrator by default and an instance\'s prefix when given one', async () => {
    const fetch = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetch)
    await caller(messages)('GET state')
    await caller(messages, managementPrefix('b'))('GET tickets/:id', { id: 'T 1' })
    expect(fetch.mock.calls.map(call => (call as unknown[])[0])).toEqual(['/orchestrator/api/state', '/orchestrator-b/api/tickets/T%201'])
  })
})

describe('service script', () => {
  let root = ''
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })
  const run = (args: string[], instance = '') => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => execFile('python3',
    [join(root, 'scripts', 'dsh-superagent'), ...args],
    { env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, DSH_SUPERAGENT_PROFILE: '', DSH_SUPERAGENT_URL: '', DSH_SUPERAGENT_INSTANCE: instance }, timeout: 20_000 },
    (error, stdout, stderr) => { resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr }) }))
  it('reads the state of the instance it is given, from --instance or DSH_SUPERAGENT_INSTANCE', async () => {
    root = mkdtempSync(join(tmpdir(), 'instance script '))
    mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'bin'))
    copyFileSync(join(import.meta.dirname, '..', 'scripts', 'dsh-superagent'), join(root, 'scripts', 'dsh-superagent'))
    // This test process stands in for the DSH service so `ps` finds a live process for the profile.
    writeFileSync(join(root, 'bin', 'ps'), `#!/bin/sh\necho '${process.pid} node node /opt/dsh --profile superagent --no-open'\n`, { mode: 0o755 })
    const paths: string[] = []
    const server = createServer((req, res) => {
      paths.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ health: { runtime: { state: 'ready', detail: '' } }, setup: { problem: null } }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      expect(await run(['status', '--url', url])).toMatchObject({ code: 0 })
      expect(await run(['status', '--url', url, '--instance', 'b'])).toMatchObject({ code: 0, stdout: expect.stringContaining('"instance": "b"') })
      expect(await run(['status', '--url', url], 'team-2')).toMatchObject({ code: 0 })
      expect(await run(['status', '--url', url, '--instance', 'B/../x'])).toMatchObject({ code: 2, stderr: expect.stringContaining('--instance must be a lowercase slug') })
    } finally { server.close() }
    expect(paths).toEqual(['/orchestrator/api/state', '/orchestrator-b/api/state', '/orchestrator-team-2/api/state'])
  })
})
