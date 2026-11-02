/** Native-service and management-route tests; no OAuth, model request, or credential file is opened. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationEntry, AuthorizationNotice, AuthorizationOutcome, AuthorizationRequest } from '@deepseek-ai/dsh-authorization'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { GrokSubscriptions, subscriptionHost, type SubscriptionHost } from '../src/app/subscriptions.ts'
import { verificationLink, type SubscriptionView } from '../src/app/subscriptions-api.ts'
import { apply, inject, name } from '../src/subscriptions.ts'

const KEY = 'llm-pi-ai/xai' as CredentialKey
const OTHER_KEY = 'llm-pi-ai/openai-codex'
const PREFIX = '/orchestrator/api/subscriptions/grok'
const ACCESS = 'fixture-access-never-returned'
const REFRESH = 'fixture-refresh-never-returned'
const PRIVATE = 'fixture-private-provider-diagnostic'
const CODE = 'ABCD-EFGH'
const URL = 'https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH'
const WINDOW = 10 * 60_000
const RETENTION = 5 * 60_000
const UUID = 'b1a00492-073a-47ea-816f-4c329264a828'
type SettingsService = NonNullable<ReturnType<SubscriptionHost['settings']>>
type Descriptor = ReturnType<SettingsService['describe']>[number]
type Entry = ReturnType<SubscriptionHost['llm']['listConfigurableProviders']>[number]
type Mutation = Parameters<SettingsService['mutate']>[1][number]
interface NativeAttempt {
  request: AuthorizationRequest
  finish(status?: AuthorizationOutcome['status'], commit?: boolean): void
  fail(error: unknown): void
}
const cleanup: (() => void | Promise<void>)[] = []
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-02T12:00:00Z')) })
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks()
})

function fixture() {
  const descriptor = {
    ns: 'llm-pi-ai', revision: 7, autoGenerate: false, applies: 'live', schema: {}, secrets: [],
    value: { providers: { xai: {}, deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: 'deepseek-chat' }] } } },
  } as unknown as Descriptor
  const entry = { provider: 'xai', displayName: 'xAI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'xai'],
    active: true, nativeAuth: { oauth: true, env: ['XAI_API_KEY'] } } as unknown as Entry
  const state = {
    authorization: true, credentials: true, settings: true, credentialWritable: true, settingsWritable: true,
    deferAbort: false,
    flow: { key: KEY, label: 'xAI', methods: [{ id: 'oauth', label: 'Sign in with SuperGrok or X Premium' },
      { id: 'api-key', label: 'xAI API key' }], inFlight: false } as AuthorizationEntry | undefined,
    entries: [entry], descriptors: [descriptor],
  }
  const records = new Map<string, CredentialRecord>([[OTHER_KEY, { kind: 'grant', payload: { access: ACCESS, refresh: REFRESH } }]])
  const attempts: NativeAttempt[] = []
  const authorization = {
    describe: vi.fn((key: CredentialKey) => key === KEY ? state.flow : undefined),
    begin: vi.fn((request: AuthorizationRequest) => new Promise<AuthorizationOutcome>((resolve, reject) => {
      const flow = state.flow
      if (flow) flow.inFlight = true
      let settled = false
      const settle = (error?: unknown, status: AuthorizationOutcome['status'] = 'cancelled') => {
        if (settled) return
        settled = true
        request.signal?.removeEventListener('abort', abort)
        if (flow) flow.inFlight = false
        if (error !== undefined) reject(error)
        else resolve({ status })
      }
      const abort = () => { if (!state.deferAbort) settle() }
      attempts.push({ request,
        finish: (status = 'authorized', commit = true) => {
          if (settled) return
          if (status === 'authorized' && commit) records.set(KEY, { kind: 'grant', payload: { access: ACCESS, refresh: REFRESH } })
          settle(undefined, status)
        },
        fail: error => settle(error),
      })
      request.signal?.addEventListener('abort', abort, { once: true })
      if (request.signal?.aborted) abort()
    })),
    cancel: vi.fn(),
  }
  const credentials = {
    describeRecord: vi.fn(async (key: CredentialKey) => {
      const record = records.get(key)
      return { configured: !!record, writable: state.credentialWritable, ...record ? { kind: record.kind } : {},
        payload: { access: ACCESS, refresh: REFRESH }, value: PRIVATE }
    }),
    deleteRecord: vi.fn(async (key: CredentialKey) => { records.delete(key) }),
    readRecord: vi.fn(async () => { throw new Error('Subscription management must not read token records') }),
    resolve: vi.fn(async () => { throw new Error('Subscription management must not resolve secrets') }),
    modifyRecord: vi.fn(), set: vi.fn(), unset: vi.fn(),
  }
  const settings = {
    get writable() { return state.settingsWritable },
    describe: vi.fn((_options?: unknown) => state.descriptors),
    mutate: vi.fn(async (ns: Parameters<SettingsService['mutate']>[0], ops: readonly Mutation[], revision?: number) => {
      const target = state.descriptors.find(item => item.ns === ns)
      if (!target || target.revision !== revision) throw Object.assign(new Error(PRIVATE), { code: 'SETTINGS_CONFLICT' })
      const value = structuredClone(target.value) as Record<string, unknown>
      for (const op of ops) {
        let parent = value
        for (const key of op.path.slice(0, -1)) parent = (parent[key] ??= {}) as Record<string, unknown>
        const key = op.path.at(-1)!
        const inherited = op.path.reduce<unknown>((node, part) => node && typeof node === 'object'
          ? (node as Record<string, unknown>)[part] : undefined, target.base)
        if (op.op === 'set') parent[key] = structuredClone(op.value)
        else if (inherited !== undefined) parent[key] = structuredClone(inherited)
        else delete parent[key]
      }
      target.value = value
      target.revision++
    }),
  }
  const llm = { listConfigurableProviders: vi.fn(() => state.entries), listProviders: vi.fn(() => []) }
  const host: SubscriptionHost = {
    authorization: () => state.authorization ? authorization : undefined,
    credentials: () => state.credentials ? credentials : undefined,
    settings: () => state.settings ? settings : undefined,
    llm,
  }
  const subscriptions = new GrokSubscriptions(host)
  const profile = (value?: Record<string, unknown>) => {
    const providers = (descriptor.value as { providers: Record<string, unknown> }).providers
    if (value === undefined) delete providers.xai
    else providers.xai = value
  }
  const notice = (value: AuthorizationNotice = { message: PRIVATE, url: URL, code: CODE }) => attempts.at(-1)!.request.interaction.notify(value)
  cleanup.push(async () => {
    for (const attempt of attempts) attempt.finish('cancelled')
    await subscriptions.stop()
  })
  return { state, descriptor, entry, records, attempts, authorization, credentials, settings, llm, host, subscriptions, profile, notice }
}

function noSecretReads(f: ReturnType<typeof fixture>) {
  for (const method of ['readRecord', 'resolve', 'modifyRecord', 'set', 'unset'] as const) expect(f.credentials[method]).not.toHaveBeenCalled()
}
function redacted(value: unknown) {
  const text = JSON.stringify(value)
  for (const secret of [ACCESS, REFRESH, PRIVATE]) expect(text).not.toContain(secret)
}
function mount(f = fixture(), listen = '127.0.0.1') {
  type Handler = (req: unknown, res: unknown) => Promise<void>
  let handler: Handler = async () => { throw new Error('Route not mounted') }
  const disposers: (() => void | Promise<void>)[] = []
  const unregister = vi.fn()
  const get = vi.fn((service: string) => service === 'authorization' ? f.host.authorization()
    : service === 'credentials' ? f.host.credentials() : service === 'settings' ? f.host.settings() : undefined)
  const ctx = {
    get, llm: f.llm,
    webServer: { host: listen, port: 3083, register: vi.fn((route: { handler: Handler }) => { handler = route.handler; return unregister }) },
    effect: vi.fn((run: () => () => void | Promise<void>, _label?: string) => { const dispose = run(); disposers.push(dispose); return dispose }),
  }
  apply(ctx as unknown as Context)
  const dispose = async () => { for (const run of disposers.splice(0).reverse()) await run() }
  cleanup.push(dispose)
  const call = async (method = 'GET', suffix = '', input?: unknown, headers: Record<string, string | undefined> = {}) => {
    let status = 0, text = '', responseHeaders: Record<string, string> = {}, reads = 0
    const body = input === undefined ? '' : typeof input === 'string' ? input : JSON.stringify(input)
    const req = { method, url: `${PREFIX}${suffix}`,
      headers: Object.fromEntries(Object.entries({ host: '127.0.0.1:3083', 'x-orchestrator-request': '1', ...headers })
        .filter(([, value]) => value !== undefined)),
      async *[Symbol.asyncIterator]() { if (body) { reads++; yield Buffer.from(body) } },
    }
    await handler(req, { writeHead: (code: number, sent: Record<string, string>) => { status = code; responseHeaders = sent },
      end: (data: string) => { text = data } })
    return { status, headers: responseHeaders, text, reads,
      body: JSON.parse(text) as SubscriptionView & { subscription?: string; error?: string } }
  }
  return { f, ctx, get, call, dispose, unregister }
}

const noStore = (response: { headers: Record<string, string> }) => expect(response.headers).toMatchObject({
  'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff',
})

describe('Grok native-service capability and metadata', () => {
  it.each(['authorization', 'credentials'] as const)('is unavailable without optional %s and never creates a fallback service', async service => {
    const f = fixture(); f.state[service] = false
    expect(await f.subscriptions.view()).toMatchObject({ available: false, writable: false, connected: false })
    await expect(f.subscriptions.start()).rejects.toMatchObject({ code: 'unavailable', status: 503 })
    expect(f.authorization.begin).not.toHaveBeenCalled(); noSecretReads(f)
  })

  it.each([undefined, { key: KEY, label: 'xAI', methods: [{ id: 'api-key', label: 'Key' }], inFlight: false }] as const)(
    'requires an actual native OAuth method, not an API-key flow', async flow => {
      const f = fixture(); f.state.flow = flow as AuthorizationEntry | undefined
      expect(await f.subscriptions.view()).toMatchObject({ available: false, writable: false })
      await expect(f.subscriptions.start()).rejects.toMatchObject({ code: 'unavailable' })
      expect(f.authorization.begin).not.toHaveBeenCalled()
    })

  it('projects grant metadata without reading secrets, and refuses a read-only credential store', async () => {
    const f = fixture(); f.records.set(KEY, { kind: 'grant', payload: { access: ACCESS } }); f.state.credentialWritable = false
    const view = await f.subscriptions.view()
    expect(view).toMatchObject({ available: true, writable: false, connected: true, credential: 'subscription' })
    redacted(view)
    await expect(f.subscriptions.start()).rejects.toMatchObject({ code: 'unavailable', status: 503 })
    await expect(f.subscriptions.logout()).rejects.toMatchObject({ code: 'unavailable', status: 503 })
    expect(f.credentials.deleteRecord).not.toHaveBeenCalled(); noSecretReads(f)
  })

  it('keeps sign-in independent of settings writability, but cannot activate a read-only profile', async () => {
    const f = fixture(); f.state.settingsWritable = false; f.records.set(KEY, { kind: 'grant', payload: {} })
    expect(await f.subscriptions.view()).toMatchObject({ available: true, writable: true, connected: true, canActivate: false })
    await expect(f.subscriptions.activate(7)).rejects.toMatchObject({ code: 'unavailable' })
    expect(f.settings.mutate).not.toHaveBeenCalled()
    expect((await f.subscriptions.start()).attempt?.phase).toBe('pending')
  })

  it('resolves optional ctx.get services afresh when native services arrive or disappear', async () => {
    const f = fixture(); const ctx = { llm: f.llm, get: vi.fn((key: string) => key === 'authorization' ? f.host.authorization()
      : key === 'credentials' ? f.host.credentials() : key === 'settings' ? f.host.settings() : undefined) }
    const bridge = subscriptionHost(ctx as unknown as Context)
    f.state.authorization = false; f.state.credentials = false; f.state.settings = false
    expect(bridge.authorization()).toBeUndefined(); expect(bridge.credentials()).toBeUndefined(); expect(bridge.settings()).toBeUndefined()
    f.state.authorization = true; f.state.credentials = true; f.state.settings = true
    expect(bridge.authorization()).toBe(f.authorization); expect(bridge.credentials()).toBe(f.credentials); expect(bridge.settings()).toBe(f.settings)
    expect(bridge.llm).toBe(f.llm)
  })
})

describe('native xAI sign-in lifecycle', () => {
  it('starts only the fixed native xAI OAuth flow and exposes only the device code and trusted link', async () => {
    const f = fixture(); const view = await f.subscriptions.start(); await flush()
    const request = f.attempts[0]!.request
    expect(Object.keys(request).sort()).toEqual(['interaction', 'key', 'method', 'signal'])
    expect(request).toMatchObject({ key: KEY, method: 'oauth' }); expect(request.signal).toBeInstanceOf(AbortSignal)
    expect(view.attempt).toMatchObject({ phase: 'pending', expiresAt: '2026-11-02T12:10:00.000Z' })
    expect(view.attempt?.id).toMatch(/^[a-f\d-]{36}$/)
    f.notice({ message: PRIVATE, url: URL, code: CODE, payload: { access: ACCESS }, refresh: REFRESH } as AuthorizationNotice)
    const shown = await f.subscriptions.view()
    expect(shown.attempt).toEqual({ ...view.attempt, code: CODE, verificationUri: URL })
    redacted(shown); noSecretReads(f)
    expect(f.settings.describe).toHaveBeenCalledWith({ redactSecrets: true })
    expect(f.settings.mutate).not.toHaveBeenCalled()
    for (const [key] of f.credentials.describeRecord.mock.calls) expect(key).toBe(KEY)
    for (const [key] of f.authorization.describe.mock.calls) expect(key).toBe(KEY)
  })

  it('returns attempt snapshots that cannot be mutated by a caller', async () => {
    const f = fixture(); const view = await f.subscriptions.start()
    view.attempt!.phase = 'authorized'; view.attempt!.code = PRIVATE
    expect((await f.subscriptions.view()).attempt).toMatchObject({ phase: 'pending' })
    redacted(await f.subscriptions.view())
  })

  it('reports native completion, clears the device instructions, and reflects native storage truth', async () => {
    const f = fixture(); await f.subscriptions.start(); f.notice()
    f.attempts[0]!.finish(); await flush()
    expect(await f.subscriptions.view()).toMatchObject({ connected: true, credential: 'subscription', busy: false,
      attempt: { phase: 'authorized' } })
    expect((await f.subscriptions.view()).attempt).not.toHaveProperty('code')
    expect((await f.subscriptions.view()).attempt).not.toHaveProperty('verificationUri')
    expect(vi.getTimerCount()).toBe(0); noSecretReads(f)
    f.records.delete(KEY)
    expect(await f.subscriptions.view()).toMatchObject({ connected: false, credential: 'none', attempt: { phase: 'authorized' } })
  })

  it('does not infer a stored grant from the native outcome alone', async () => {
    const f = fixture(); await f.subscriptions.start(); f.attempts[0]!.finish('authorized', false); await flush()
    expect(await f.subscriptions.view()).toMatchObject({ connected: false, credential: 'none', attempt: { phase: 'authorized' } })
    expect(f.credentials.modifyRecord).not.toHaveBeenCalled()
  })

  it('handles a native cancellation as an outcome rather than a provider failure', async () => {
    const f = fixture(); await f.subscriptions.start(); f.notice(); f.attempts[0]!.finish('cancelled'); await flush()
    expect((await f.subscriptions.view()).attempt).toMatchObject({ phase: 'cancelled' })
    expect((await f.subscriptions.view()).attempt).not.toHaveProperty('error')
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    ['xAI device authorization was denied', 'failed', 'denied'],
    ['authorization_denied', 'failed', 'denied'],
    ['xAI device code expired', 'expired', 'expired'],
    ['socket failed', 'failed', 'network'],
  ])('classifies %s without exposing the provider diagnostic', async (message, phase, error) => {
    const f = fixture(); await f.subscriptions.start(); f.notice()
    f.attempts[0]!.fail(new Error(`${message}: ${PRIVATE} ${ACCESS}`)); await flush()
    const view = await f.subscriptions.view()
    expect(view.attempt).toMatchObject({ phase, error }); redacted(view)
    expect(view.attempt).not.toHaveProperty('code'); expect(view.attempt).not.toHaveProperty('verificationUri')
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['https://accounts.x.ai/oauth2/device', 'https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH',
    'https://auth.x.ai/activate?user_code=ABCD-EFGH'])(
    'keeps a native device challenge pending for the exact trusted verification origin: %s', async url => {
      const f = fixture(); const started = await f.subscriptions.start()
      f.notice({ message: PRIVATE, url, code: CODE })
      expect(verificationLink(url)).toBe(url)
      expect((await f.subscriptions.view()).attempt).toMatchObject({ phase: 'pending', code: CODE, verificationUri: url })
      expect(f.attempts[0]!.request.signal?.aborted).toBe(false)
      await f.subscriptions.cancel(started.attempt!.id)
      expect((await f.subscriptions.view()).attempt).toMatchObject({ phase: 'cancelled' })
      noSecretReads(f)
    },
  )

  it.each(['http://auth.x.ai/activate', 'https://auth.x.ai.evil.example/activate', 'https://evil.example/activate',
    'https://user:password@auth.x.ai/activate', 'javascript:alert(1)', '//auth.x.ai/activate', 'not a URL',
    'http://accounts.x.ai/oauth2/device', 'https://accounts.x.ai.evil.example/oauth2/device', 'https://evil.accounts.x.ai/oauth2/device',
    'https://accounts.x.ai@evil.example/oauth2/device', 'https://user:password@accounts.x.ai/oauth2/device',
    'https://accounts.x.ai:8443/oauth2/device', '//accounts.x.ai/oauth2/device', ' https://accounts.x.ai/oauth2/device',
    'https://accounts.x.ai/\ndevice', 'https://auth.x.ai/\tdevice', 'blob:https://accounts.x.ai/fixture-id',
    'blob:https://auth.x.ai/fixture-id'])(
    'rejects an untrusted verification link: %s', async url => {
      expect(verificationLink(url)).toBeUndefined()
      const f = fixture(); await f.subscriptions.start(); f.notice({ message: PRIVATE, url, code: CODE }); await flush()
      expect(f.attempts[0]!.request.signal?.aborted).toBe(true)
      const view = await f.subscriptions.view()
      expect(view.attempt).toMatchObject({ phase: 'failed', error: 'unsupported' })
      expect(view.attempt).not.toHaveProperty('verificationUri'); redacted(view)
    })

  it.each(['', 'A\nB', 'A<script>', 'A'.repeat(65), ' ABCD'])('rejects a malformed device code %j', async code => {
    const f = fixture(); await f.subscriptions.start(); f.notice({ message: PRIVATE, url: URL, code }); await flush()
    expect(f.attempts[0]!.request.signal?.aborted).toBe(true)
    expect((await f.subscriptions.view()).attempt).toMatchObject({ phase: 'failed', error: 'unsupported' })
    expect((await f.subscriptions.view()).attempt).not.toHaveProperty('code')
  })

  it('refuses an unexpected native secret prompt without accepting an API key', async () => {
    const f = fixture(); await f.subscriptions.start()
    const prompt = f.attempts[0]!.request.interaction.prompt({ kind: 'secret', message: PRIVATE })
    await expect(prompt).rejects.toMatchObject({ code: 'unsupported' })
    f.attempts[0]!.fail(await prompt.catch(error => error)); await flush()
    expect((await f.subscriptions.view()).attempt).toMatchObject({ phase: 'failed', error: 'unsupported' }); noSecretReads(f)
  })

  it('cancels the owned signal and timer without deleting a grant or retaining device instructions', async () => {
    const f = fixture(); const started = await f.subscriptions.start(); f.notice()
    const view = await f.subscriptions.cancel(started.attempt!.id)
    expect(view.attempt).toMatchObject({ phase: 'cancelled' }); expect(f.attempts[0]!.request.signal?.aborted).toBe(true)
    expect(view.attempt).not.toHaveProperty('code'); expect(view.attempt).not.toHaveProperty('verificationUri')
    expect(f.credentials.deleteRecord).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
    f.notice(); expect((await f.subscriptions.view()).attempt).not.toHaveProperty('code')
  })

  it('expires a pending attempt after ten minutes and drops its retained view after the retention window', async () => {
    const f = fixture(); await f.subscriptions.start(); f.notice()
    await vi.advanceTimersByTimeAsync(WINDOW - 1)
    expect((await f.subscriptions.view()).attempt?.phase).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(f.attempts[0]!.request.signal?.aborted).toBe(true)
    expect((await f.subscriptions.view()).attempt).toMatchObject({ phase: 'expired', error: 'expired' })
    expect((await f.subscriptions.view()).attempt).not.toHaveProperty('code')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(RETENTION)
    expect(await f.subscriptions.view()).not.toHaveProperty('attempt')
    expect(f.credentials.deleteRecord).not.toHaveBeenCalled()
  })

  it('refuses both a duplicate owned attempt and a native flow already running elsewhere', async () => {
    const f = fixture(); await f.subscriptions.start()
    await expect(f.subscriptions.start()).rejects.toMatchObject({ code: 'conflict', status: 409 })
    expect(f.authorization.begin).toHaveBeenCalledTimes(1)
    const other = fixture(); other.state.flow!.inFlight = true
    expect(await other.subscriptions.view()).toMatchObject({ busy: true })
    await expect(other.subscriptions.start()).rejects.toMatchObject({ code: 'conflict', status: 409 })
    expect(other.authorization.begin).not.toHaveBeenCalled()
  })

  it('classifies a native already-in-flight race as a conflict rather than a network failure', async () => {
    const f = fixture()
    f.authorization.begin.mockRejectedValueOnce(Object.assign(new Error(PRIVATE), { code: 'ALREADY_IN_FLIGHT' }))
    await f.subscriptions.start(); await flush()
    const view = await f.subscriptions.view()
    expect(view.attempt).toMatchObject({ phase: 'failed', error: 'conflict' }); redacted(view)
  })

  it('ignores stale cancel IDs and notices after a newer attempt starts', async () => {
    const f = fixture(); const first = await f.subscriptions.start(); const old = f.attempts[0]!
    await f.subscriptions.cancel(first.attempt!.id)
    const second = await f.subscriptions.start(); expect(second.attempt!.id).not.toBe(first.attempt!.id)
    old.request.interaction.notify({ message: PRIVATE, url: URL, code: 'STALE' })
    const view = await f.subscriptions.cancel(first.attempt!.id)
    expect(view.attempt).toMatchObject({ id: second.attempt!.id, phase: 'pending' })
    expect(view.attempt).not.toHaveProperty('code'); expect(f.attempts[1]!.request.signal?.aborted).toBe(false)
    expect(f.authorization.cancel).not.toHaveBeenCalled()
  })

  it('reflects a native commit that completes after cancellation without deleting the saved credential', async () => {
    const f = fixture(); f.state.deferAbort = true
    const started = await f.subscriptions.start(); const cancelled = f.subscriptions.cancel(started.attempt!.id)
    expect(f.attempts[0]!.request.signal?.aborted).toBe(true)
    f.attempts[0]!.finish(); await cancelled
    expect(await f.subscriptions.view()).toMatchObject({ connected: true, credential: 'subscription', attempt: { phase: 'cancelled' } })
    expect(f.credentials.deleteRecord).not.toHaveBeenCalled(); noSecretReads(f)
  })

  it('stops idempotently, cancels pending native work, and refuses subsequent mutations', async () => {
    const f = fixture(); await f.subscriptions.start(); f.notice()
    await f.subscriptions.stop(); await f.subscriptions.stop()
    expect(f.attempts[0]!.request.signal?.aborted).toBe(true)
    expect(await f.subscriptions.view()).toMatchObject({ writable: false, canActivate: false, attempt: { phase: 'cancelled' } })
    await expect(f.subscriptions.start()).rejects.toMatchObject({ code: 'unavailable', status: 409 })
    await expect(f.subscriptions.logout()).rejects.toMatchObject({ code: 'unavailable', status: 409 })
    expect(vi.getTimerCount()).toBe(0); expect(f.credentials.deleteRecord).not.toHaveBeenCalled()
  })
})

describe('safe subscription activation and removal', () => {
  it('requires an explicit replacement flag for a native API-key record and leaves it untouched until native commit', async () => {
    const f = fixture(); f.records.set(KEY, { kind: 'api-key', key: ACCESS })
    expect(await f.subscriptions.view()).toMatchObject({ connected: false, credential: 'api-key' })
    await expect(f.subscriptions.start()).rejects.toMatchObject({ code: 'api-key', status: 409 })
    expect(f.authorization.begin).not.toHaveBeenCalled()
    await f.subscriptions.start(true)
    expect(f.records.get(KEY)).toEqual({ kind: 'api-key', key: ACCESS })
    f.attempts[0]!.finish(); await flush()
    expect(await f.subscriptions.view()).toMatchObject({ connected: true, credential: 'subscription' })
    expect(f.credentials.deleteRecord).not.toHaveBeenCalled(); noSecretReads(f)
  })

  it('activates an existing official profile with only an exact apiKeyEnv unset and the expected revision', async () => {
    const f = fixture(); f.records.set(KEY, { kind: 'grant', payload: {} })
    f.profile({ apiKeyEnv: 'XAI_API_KEY', baseURL: 'https://api.x.ai/v1/', api: 'openai-responses',
      models: [{ id: 'grok-4' }], reasoning: 'high', timeoutMs: 90000 })
    const before = structuredClone(f.descriptor.value) as { providers: Record<string, Record<string, unknown>> }
    expect(await f.subscriptions.view()).toMatchObject({ route: 'api-key', canActivate: true, revision: 7 })
    expect(await f.subscriptions.activate(7)).toMatchObject({ route: 'subscription', connected: true, revision: 8 })
    expect(f.settings.mutate).toHaveBeenCalledExactlyOnceWith('llm-pi-ai', [{ op: 'unset', path: ['providers', 'xai', 'apiKeyEnv'] }], 7)
    delete before.providers.xai!.apiKeyEnv
    expect(f.descriptor.value).toEqual(before); noSecretReads(f)
  })

  it.each([undefined, 'USER_XAI_KEY'])('blocks an inherited API-key route with user override %s before any settings write', async override => {
    const f = fixture(); f.records.set(KEY, { kind: 'grant', payload: {} })
    f.descriptor.base = { providers: { xai: { apiKeyEnv: 'BASE_XAI_KEY' } } }
    f.profile({ apiKeyEnv: override ?? 'BASE_XAI_KEY', models: [{ id: 'grok-4' }] })
    const before = structuredClone(f.descriptor.value)
    expect(await f.subscriptions.view()).toMatchObject({ route: 'api-key', canActivate: false, activationBlocked: 'inherited-api-key' })
    await expect(f.subscriptions.activate(7)).rejects.toMatchObject({ code: 'unsupported' })
    expect(f.settings.mutate).not.toHaveBeenCalled()
    expect(f.descriptor.value).toEqual(before); noSecretReads(f)
  })

  it('refuses activation if the effective route remains unchanged after a native settings mutation', async () => {
    const f = fixture(); f.profile({ apiKeyEnv: 'XAI_API_KEY' }); f.records.set(KEY, { kind: 'grant', payload: {} })
    f.settings.mutate.mockImplementationOnce(async () => { f.descriptor.revision++ })
    await expect(f.subscriptions.activate(7)).rejects.toMatchObject({ code: 'unsupported' })
    expect(await f.subscriptions.view()).toMatchObject({ route: 'api-key', revision: 8, busy: false })
  })

  it('treats an already native profile as activated without rewriting settings', async () => {
    const f = fixture(); f.records.set(KEY, { kind: 'grant', payload: {} })
    expect(await f.subscriptions.view()).toMatchObject({ connected: true, route: 'subscription', canActivate: false })
    expect(await f.subscriptions.activate(7)).toMatchObject({ route: 'subscription', revision: 7, canActivate: false })
    expect(f.settings.mutate).not.toHaveBeenCalled()
  })

  it('materializes only an empty native profile when the xAI route has not been configured', async () => {
    const f = fixture(); f.profile(); f.records.set(KEY, { kind: 'grant', payload: {} })
    expect(await f.subscriptions.view()).toMatchObject({ route: 'unconfigured', canActivate: true })
    expect(await f.subscriptions.activate(7)).toMatchObject({ route: 'subscription', revision: 8 })
    expect(f.settings.mutate).toHaveBeenCalledExactlyOnceWith('llm-pi-ai', [{ op: 'set', path: ['providers', 'xai'], value: {} }], 7)
    expect((f.descriptor.value as { providers: unknown }).providers).toMatchObject({ xai: {}, deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY' } })
    expect(f.authorization.begin).not.toHaveBeenCalled()
  })

  it('re-reads sequential settings saves and rejects stale revisions without overwriting other edits', async () => {
    const f = fixture(); f.records.set(KEY, { kind: 'grant', payload: {} }); f.profile()
    await f.subscriptions.activate(7)
    f.profile({ apiKeyEnv: 'CHANGED_XAI_KEY', models: [{ id: 'grok-4' }], maxTokens: 1234 }); f.descriptor.revision++
    const before = structuredClone(f.descriptor.value)
    await expect(f.subscriptions.activate(8)).rejects.toMatchObject({ code: 'conflict', status: 409 })
    expect(f.descriptor.value).toEqual(before); expect(f.settings.mutate).toHaveBeenCalledTimes(1)
    await f.subscriptions.activate(9)
    expect(f.settings.mutate.mock.calls[1]).toEqual(['llm-pi-ai', [{ op: 'unset', path: ['providers', 'xai', 'apiKeyEnv'] }], 9])
    expect(f.descriptor.value).toMatchObject({ providers: { xai: { models: [{ id: 'grok-4' }], maxTokens: 1234 } } })
    f.profile({ baseURL: 'https://gateway.example/v1' }); f.descriptor.revision++
    await expect(f.subscriptions.activate(11)).rejects.toMatchObject({ code: 'unsupported' })
    expect(f.settings.mutate).toHaveBeenCalledTimes(2)
  })

  it.each([
    { baseURL: 'https://gateway.example/v1' }, { baseURL: 'https://api.x.ai.evil.example/v1' },
    { baseURL: 'https://user:password@api.x.ai/v1' }, { api: 'openai-completions' }, { headers: { authorization: ACCESS } },
    { models: [{ id: 'grok-4', baseUrl: 'https://gateway.example/v1' }] },
    { models: [{ id: 'grok-4', baseURL: 'https://gateway.example/v1' }] },
    { models: [{ id: 'grok-4', api: 'openai-completions' }] },
    { modelOverrides: { 'grok-4': { baseUrl: 'https://gateway.example/v1' } } },
    { modelOverrides: { 'grok-4': { api: 'openai-completions' } } },
  ])('never starts or activates a route with custom endpoint, protocol, or headers: %j', async profile => {
    const f = fixture(); f.profile(profile); f.records.set(KEY, { kind: 'grant', payload: { access: ACCESS } })
    const view = await f.subscriptions.view()
    expect(view).toMatchObject({ route: 'custom', canActivate: false }); redacted(view)
    await expect(f.subscriptions.start()).rejects.toMatchObject({ code: 'unsupported' })
    await expect(f.subscriptions.activate(7)).rejects.toMatchObject({ code: 'unsupported' })
    expect(f.authorization.begin).not.toHaveBeenCalled(); expect(f.settings.mutate).not.toHaveBeenCalled(); noSecretReads(f)
  })

  it.each(['duplicate', 'path', 'namespace', 'missing-settings'])(
    'does not activate an ambiguous or non-native settings address: %s', async invalid => {
      const f = fixture(); f.records.set(KEY, { kind: 'grant', payload: {} })
      if (invalid === 'duplicate') f.state.entries.push({ ...f.entry })
      if (invalid === 'path') f.state.entries[0] = { ...f.entry, settingsPath: ['providers', 'other'] }
      if (invalid === 'namespace') f.state.entries[0] = { ...f.entry, settingsNs: 'unknown' }
      if (invalid === 'missing-settings') f.state.settings = false
      expect(await f.subscriptions.view()).toMatchObject({ route: 'unconfigured', canActivate: false })
      await expect(f.subscriptions.activate(7)).rejects.toMatchObject({ code: 'unavailable' })
      expect(f.settings.mutate).not.toHaveBeenCalled()
    })

  it.each([['SETTINGS_CONFLICT', 'conflict', 409], ['DISK_FULL', 'unavailable', 503]])(
    'maps native settings refusal %s without exposing secret-bearing diagnostics', async (native, code, status) => {
      const f = fixture(); f.records.set(KEY, { kind: 'grant', payload: {} }); f.profile()
      f.settings.mutate.mockRejectedValueOnce(Object.assign(new Error(`${PRIVATE} ${ACCESS}`), { code: native }))
      await expect(f.subscriptions.activate(7)).rejects.toMatchObject({ code, status, message: code })
      expect(await f.subscriptions.view()).toMatchObject({ busy: false, revision: 7 })
    })

  it('serializes settings mutations and releases the busy state after completion', async () => {
    const f = fixture(); f.records.set(KEY, { kind: 'grant', payload: {} }); f.profile()
    const gate = Promise.withResolvers<void>(); f.settings.mutate.mockImplementationOnce(async () => gate.promise)
    const saving = f.subscriptions.activate(7); await flush()
    expect(await f.subscriptions.view()).toMatchObject({ busy: true })
    await expect(f.subscriptions.logout()).rejects.toMatchObject({ code: 'conflict', status: 409 })
    f.profile({}); f.descriptor.revision++
    gate.resolve(); await saving
    expect(await f.subscriptions.view()).toMatchObject({ busy: false })
  })

  it('removes only the xAI grant without changing settings or unrelated credential records', async () => {
    const f = fixture(); f.records.set(KEY, { kind: 'grant', payload: { access: ACCESS } })
    const before = structuredClone(f.descriptor.value)
    expect(await f.subscriptions.logout()).toMatchObject({ connected: false, credential: 'none' })
    expect(f.credentials.deleteRecord).toHaveBeenCalledExactlyOnceWith(KEY)
    expect(f.records.get(OTHER_KEY)).toEqual({ kind: 'grant', payload: { access: ACCESS, refresh: REFRESH } })
    expect(f.descriptor.value).toEqual(before); expect(f.settings.mutate).not.toHaveBeenCalled(); noSecretReads(f)
  })

  it.each(['api-key', 'none'] as const)('retains a native %s record during subscription sign-out', async kind => {
    const f = fixture(); if (kind === 'api-key') f.records.set(KEY, { kind: 'api-key', key: ACCESS })
    expect(await f.subscriptions.logout()).toMatchObject({ connected: false, credential: kind })
    expect(f.credentials.deleteRecord).not.toHaveBeenCalled(); noSecretReads(f)
    if (kind === 'api-key') expect(f.records.get(KEY)).toEqual({ kind: 'api-key', key: ACCESS })
  })

  it('settles an in-flight login before sign-out and deletes a grant committed during cancellation', async () => {
    const f = fixture(); f.state.deferAbort = true; await f.subscriptions.start()
    const logout = f.subscriptions.logout(); await flush()
    expect(f.attempts[0]!.request.signal?.aborted).toBe(true)
    f.attempts[0]!.finish(); const view = await logout
    expect(view).toMatchObject({ connected: false, credential: 'none' }); expect(view).not.toHaveProperty('attempt')
    expect(f.credentials.deleteRecord).toHaveBeenCalledExactlyOnceWith(KEY)
  })
})

describe('independent subscription management routes', () => {
  it('registers its own prefix and lifecycle without depending on or restarting active agents', async () => {
    const server = mount()
    expect(name).toBe('dsh-superagent-subscriptions'); expect(inject).toEqual(['webServer', 'llm'])
    expect(server.ctx.webServer.register).toHaveBeenCalledWith(expect.objectContaining({ kind: 'prefix', path: PREFIX }))
    const started = await server.call('POST', '/start', {})
    expect(started.status).toBe(200); noStore(started)
    await server.dispose(); await server.dispose()
    expect(server.f.attempts[0]!.request.signal?.aborted).toBe(true)
    expect(server.unregister).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['0.0.0.0', '::', '::1', '192.168.10.154'])(
    'refuses to mount the management API on %s', listen => {
      expect(() => mount(fixture(), listen)).toThrow('Subscription management requires a loopback Web server')
    })

  it('returns safe capability metadata and accepts the existing exact localhost same-origin contract', async () => {
    const server = mount()
    const response = await server.call('GET', '', undefined, { host: 'localhost:3083', origin: 'http://localhost:3083' })
    expect(response.status).toBe(200); expect(response.body).toMatchObject({ available: true, writable: true, connected: false })
    noStore(response); redacted(response.body); noSecretReads(server.f)
    expect(server.f.authorization.begin).not.toHaveBeenCalled()
  })

  it.each([
    { 'x-orchestrator-request': undefined }, { 'x-orchestrator-request': '0' }, { host: 'evil.example:3083' },
    { host: '127.0.0.1:9999' }, { origin: 'http://evil.example' }, { origin: 'null' },
    { host: 'localhost:3083', origin: 'http://127.0.0.1:3083' },
  ])('rejects an untrusted request before reading the body or native services: %j', async headers => {
    const server = mount(); const response = await server.call('POST', '/start', { replaceApiKey: true }, headers)
    expect(response.status).toBe(403); expect(response.body).toEqual({ error: 'Same-origin management request required' })
    expect(response.reads).toBe(0); noStore(response); expect(server.get).not.toHaveBeenCalled()
    expect(server.f.authorization.begin).not.toHaveBeenCalled(); expect(server.f.settings.mutate).not.toHaveBeenCalled()
  })

  it.each([
    ['/start', '{'], ['/start', null], ['/start', []], ['/start', { replaceApiKey: 'yes' }],
    ['/start', { key: OTHER_KEY }], ['/start', { provider: 'other', method: 'api-key' }],
    ['/start', { headers: { authorization: ACCESS } }], ['/cancel', {}], ['/cancel', { id: 'not-a-uuid' }],
    ['/cancel', { id: UUID, key: OTHER_KEY }], ['/activate', {}], ['/activate', { revision: -1 }],
    ['/activate', { revision: 1.5 }], ['/activate', { revision: '7' }],
    ['/activate', { revision: 7, namespace: 'other', path: ['records'] }],
    ['/logout', {}], ['/logout', { confirm: false }], ['/logout', { confirm: true, key: OTHER_KEY }],
    ['/start', { padding: 'é'.repeat(2100) }],
  ] as [string, unknown][])('rejects malformed or overlarge %s input without native writes', async (path, input) => {
    const server = mount(); const response = await server.call('POST', path, input)
    expect(response.status).toBe(400); expect(response.body).toEqual({ subscription: 'unsupported' }); noStore(response); redacted(response.body)
    expect(server.f.authorization.begin).not.toHaveBeenCalled(); expect(server.f.settings.mutate).not.toHaveBeenCalled()
    expect(server.f.credentials.deleteRecord).not.toHaveBeenCalled()
  })

  it.each([['POST', ''], ['GET', '/start'], ['PUT', '/start'], ['DELETE', '/logout'], ['POST', '/unknown'],
    ['POST', '/xai/start'], ['POST', `/start/${encodeURIComponent(OTHER_KEY)}`], ['GET', '/other']])(
    'rejects an unknown %s %s before consuming the request body', async (method, path) => {
      const server = mount(); const response = await server.call(method!, path!, { key: OTHER_KEY })
      expect(response.status).toBe(404); expect(response.body).toEqual({ error: 'Unknown operation' }); expect(response.reads).toBe(0)
      noStore(response); expect(server.get).not.toHaveBeenCalled(); expect(server.f.authorization.begin).not.toHaveBeenCalled()
    })

  it('completes start, status, activation, stale cancellation, and confirmed sign-out through the exported plugin', async () => {
    const server = mount(); server.f.profile({ apiKeyEnv: 'XAI_API_KEY', models: [{ id: 'grok-4' }] })
    const started = await server.call('POST', '/start')
    expect(started.status).toBe(200); expect(started.body.attempt?.phase).toBe('pending')
    server.f.notice(); const pending = await server.call()
    expect(pending.body.attempt).toMatchObject({ code: CODE, verificationUri: URL }); redacted(pending.body)
    const duplicate = await server.call('POST', '/start', {})
    expect(duplicate.status).toBe(409); expect(duplicate.body).toEqual({ subscription: 'conflict' }); noStore(duplicate)
    server.f.attempts[0]!.finish(); await flush()
    const connected = await server.call()
    expect(connected.body).toMatchObject({ connected: true, route: 'api-key', attempt: { phase: 'authorized' } })
    const activated = await server.call('POST', '/activate', { revision: connected.body.revision })
    expect(activated.status).toBe(200); expect(activated.body).toMatchObject({ route: 'subscription', revision: 8 })
    const stale = await server.call('POST', '/activate', { revision: 7 })
    expect(stale.status).toBe(409); expect(stale.body).toEqual({ subscription: 'conflict' }); noStore(stale)
    const cancelled = await server.call('POST', '/cancel', { id: UUID })
    expect(cancelled.status).toBe(200); expect(cancelled.body.attempt?.phase).toBe('authorized')
    const loggedOut = await server.call('POST', '/logout', { confirm: true })
    expect(loggedOut.status).toBe(200); expect(loggedOut.body).toMatchObject({ connected: false, credential: 'none' })
    expect(server.f.credentials.deleteRecord).toHaveBeenCalledExactlyOnceWith(KEY)
    for (const response of [started, pending, connected, activated, cancelled, loggedOut]) { noStore(response); redacted(response.body) }
    noSecretReads(server.f)
  })

  it('allows native API-key replacement only with the strictly typed explicit flag', async () => {
    const server = mount(); server.f.records.set(KEY, { kind: 'api-key', key: ACCESS })
    const refusal = await server.call('POST', '/start', {})
    expect(refusal.status).toBe(409); expect(refusal.body).toEqual({ subscription: 'api-key' }); noStore(refusal)
    const start = await server.call('POST', '/start', { replaceApiKey: true })
    expect(start.status).toBe(200); expect(server.f.authorization.begin).toHaveBeenCalledTimes(1)
    expect(server.f.attempts[0]!.request).toMatchObject({ key: KEY, method: 'oauth' })
    expect(server.f.credentials.deleteRecord).not.toHaveBeenCalled(); redacted(start.body)
  })

  it.each(['authorization', 'credentials'] as const)('returns unavailable without optional native %s', async service => {
    const server = mount(); server.f.state[service] = false
    const read = await server.call(); expect(read.status).toBe(200); expect(read.body.available).toBe(false)
    const start = await server.call('POST', '/start', {})
    expect(start.status).toBe(503); expect(start.body).toEqual({ subscription: 'unavailable' }); noStore(start)
  })

  it('contains raw native storage and settings errors at the route boundary', async () => {
    const server = mount()
    server.f.credentials.describeRecord.mockRejectedValueOnce(new Error(`${PRIVATE} ${ACCESS} ${REFRESH}`))
    const read = await server.call()
    expect(read.status).toBe(503); expect(read.body).toEqual({ subscription: 'unavailable' }); noStore(read); redacted(read.body)
    server.f.records.set(KEY, { kind: 'grant', payload: {} }); server.f.profile()
    server.f.settings.mutate.mockRejectedValueOnce(new Error(`${PRIVATE} ${ACCESS}`))
    const activation = await server.call('POST', '/activate', { revision: 7 })
    expect(activation.status).toBe(503); expect(activation.body).toEqual({ subscription: 'unavailable' }); noStore(activation); redacted(activation.body)
    server.f.credentials.deleteRecord.mockRejectedValueOnce(new Error(`${PRIVATE} ${REFRESH}`))
    const logout = await server.call('POST', '/logout', { confirm: true })
    expect(logout.status).toBe(503); expect(logout.body).toEqual({ subscription: 'unavailable' }); noStore(logout); redacted(logout.body)
  })
})
