// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SubscriptionView } from '../src/app/subscriptions-api.ts'
import { GrokProviderSubscription, GrokSubscription } from '../src/client/grok.tsx'
import type { ModelProviderCardOwner } from '../src/client/model-settings.d.ts'
import { en, ko } from '../src/client/locales.ts'
import type { T } from '../src/client/text.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const signedOut = (changes: Partial<SubscriptionView> = {}): SubscriptionView => ({
  available: true, writable: true, connected: false, busy: false, credential: 'none', route: 'unconfigured', revision: 7,
  canActivate: false, ...changes,
})
const pending = (changes: Partial<SubscriptionView['attempt']> = {}): SubscriptionView => signedOut({ busy: true,
  attempt: { id: 'attempt-1', phase: 'pending', expiresAt: new Date(Date.now() + 300_000).toISOString(), code: 'ABCD-EFGH',
    verificationUri: 'https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH', ...changes },
})
const connected = (changes: Partial<SubscriptionView> = {}): SubscriptionView => signedOut({
  connected: true, credential: 'subscription', canActivate: true, ...changes,
})
const translate = (dictionary: Record<string, string>): T => ((key: string, values: Record<string, unknown> = {}) =>
  (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) => name in values ? String(values[name]) : match)) as T
const deferred = <V,>() => {
  let resolve!: (value: V) => void
  const promise = new Promise<V>(done => { resolve = done })
  return { promise, resolve }
}
type Request = { method: string; path: string; body?: unknown }
let view: SubscriptionView
let requests: Request[]
let responses: Record<string, (body: unknown) => Response | Promise<Response>>
let read: (() => Response | Promise<Response>) | undefined
let container: HTMLElement, root: Root | undefined
let clipboard: PropertyDescriptor | undefined
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-02T12:00:00Z'))
  view = signedOut()
  requests = []
  responses = {}
  read = undefined
  vi.spyOn(window, 'open').mockReturnValue(null)
  clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    expect(init.headers).toMatchObject({ 'x-orchestrator-request': '1' })
    const path = url.replace('/orchestrator/api/subscriptions/grok', '')
    const method = init.method ?? 'GET'
    const body: unknown = init.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, path, ...body === undefined ? {} : { body } })
    if (method === 'GET' && path === '') return read ? read() : Response.json(view)
    const respond = responses[path]
    if (!respond) throw new Error(`Unexpected request: ${method} ${path}`)
    return respond(body)
  }))
  container = document.createElement('div')
  document.body.append(container)
})
afterEach(() => {
  act(() => { root?.unmount() })
  root = undefined
  container.remove()
  if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
const flush = async () => { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }) }
async function mount(dictionary: Record<string, string> = en) {
  root = createRoot(container)
  await act(async () => { root!.render(<GrokSubscription t={translate(dictionary)} />) })
  await flush()
}
async function mountProvider(provider: string, configured = false) {
  root ??= createRoot(container)
  const owner: ModelProviderCardOwner = { provider: { provider }, configured, keyConfigured: false }
  await act(async () => { root!.render(<GrokProviderSubscription {...owner} t={translate(en)} />) })
  await flush()
}
const text = () => [...container.querySelectorAll('style')].reduce((all, style) => all.replace(style.textContent ?? '', ''), container.textContent ?? '')
function button(label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')].find(item => item.textContent === label)
  if (!result) throw new Error(`No button named ${label}`)
  return result
}
async function click(label: string) {
  await act(async () => { button(label).click() })
  await flush()
}
async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }); await flush() }
async function visible() { await act(async () => { document.dispatchEvent(new Event('visibilitychange')) }); await flush() }
const writes = () => requests.filter(request => request.method !== 'GET')
const respond = (path: string, next: () => SubscriptionView) => { responses[path] = () => { view = next(); return Response.json(view) } }
function popupFixture() {
  const popup = { document: document.implementation.createHTMLDocument(), location: { href: 'about:blank' }, closed: false, opener: window as Window | null,
    close: vi.fn(() => { popup.closed = true }) }
  const navigate = vi.fn()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    navigate({ href: this.href, rel: this.rel, referrerPolicy: this.referrerPolicy, opener: popup.opener })
  })
  vi.mocked(window.open).mockReturnValue(popup as unknown as Window)
  return { popup, navigate }
}

it('leaves other provider cards unchanged and does not request subscription state', async () => {
  await mountProvider('openai')
  expect(container.textContent).toBe('')
  expect(requests).toEqual([])
  await tick(10_000)
  expect(requests).toEqual([])
})

it('opens sign-in within the selected xAI add-provider draft and cleans up when another provider is selected', async () => {
  await mountProvider('xai')
  expect(text()).toContain(en['grok.title'])
  expect(button(en['grok.signIn']).disabled).toBe(false)
  expect(writes()).toEqual([])
  await mountProvider('anthropic')
  const count = requests.length
  await tick(10_000)
  expect(container.textContent).toBe('')
  expect(requests).toHaveLength(count)
})

it('restores a pending subscription attempt after returning to xAI in the provider chooser', async () => {
  respond('/start', () => pending())
  await mountProvider('xai')
  await click(en['grok.signIn'])
  await mountProvider('openai')
  expect(container.textContent).toBe('')
  await mountProvider('xai')
  expect(text()).toContain('ABCD-EFGH')
  expect(writes()).toEqual([{ method: 'POST', path: '/start', body: {} }])
})

it('manages a saved subscription inside a configured xAI provider row', async () => {
  view = connected({ route: 'subscription', canActivate: false })
  await mountProvider('xai', true)
  const disclosure = container.querySelector('details')!
  expect(disclosure.open).toBe(false)
  expect(disclosure.querySelector('summary')?.textContent).toContain(en['grok.manage'])
  await act(async () => { disclosure.querySelector('summary')!.click() })
  expect(disclosure.open).toBe(true)
  expect(text()).toContain(en['grok.connected'])
  expect(button(en['grok.logout']).disabled).toBe(false)
  expect(writes()).toEqual([])
})

it('starts only on an explicit click, retains the secure manual link when popups are blocked, and polls until authorization', async () => {
  const open = vi.mocked(window.open)
  respond('/start', () => pending())
  await mount()
  expect(writes()).toEqual([])
  expect(container.querySelector('style')).not.toBeNull()
  await tick(10_000)
  expect(writes()).toEqual([])
  expect(open).not.toHaveBeenCalled()
  await click(en['grok.signIn'])
  expect(writes()).toEqual([{ method: 'POST', path: '/start', body: {} }])
  expect(text()).toContain('ABCD-EFGH')
  expect(text()).toContain(en['grok.waiting'])
  expect(text()).toContain("not the verification code's expiry")
  const link = container.querySelector('a')!
  expect(link.href).toBe('https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH')
  expect(link.target).toBe('_blank')
  expect(link.rel).toBe('noopener noreferrer')
  expect(link.getAttribute('referrerpolicy')).toBe('no-referrer')
  expect(open).toHaveBeenCalledExactlyOnceWith('about:blank', '_blank', 'popup,width=560,height=720')
  expect(text()).toContain(en['grok.popupBlocked'])
  const readCount = requests.length
  view = connected({ attempt: { id: 'attempt-1', phase: 'authorized', expiresAt: new Date().toISOString() } })
  await tick(1499)
  expect(requests).toHaveLength(readCount)
  await tick(1)
  expect(text()).toContain(en['grok.connected'])
  expect(text()).not.toContain('ABCD-EFGH')
  expect(writes()).toHaveLength(1)
  expect(button(en['grok.activate']).disabled).toBe(false)
})

it('reserves a window synchronously and navigates it once when this attempt receives its trusted URL', async () => {
  const { popup, navigate } = popupFixture(), started = deferred<Response>()
  responses['/start'] = () => started.promise
  await mount()
  expect(window.open).not.toHaveBeenCalled()
  await click(en['grok.signIn'])
  expect(window.open).toHaveBeenCalledTimes(1)
  expect(popup.opener).toBeNull()
  expect(popup.document.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe('no-referrer')
  expect(popup.document.body.textContent).toContain(en['grok.starting'])
  expect(navigate).not.toHaveBeenCalled()
  await act(async () => { view = pending({ verificationUri: undefined }); started.resolve(Response.json(view)) })
  await flush()
  expect(navigate).not.toHaveBeenCalled()
  view = pending()
  await visible()
  expect(navigate).toHaveBeenCalledExactlyOnceWith({ href: view.attempt!.verificationUri, rel: 'noopener noreferrer',
    referrerPolicy: 'no-referrer', opener: null })
  expect(text()).toContain(en['grok.popupOpened'])
  await visible()
  expect(window.open).toHaveBeenCalledTimes(1)
  expect(navigate).toHaveBeenCalledTimes(1)
  act(() => { root!.unmount() }); root = undefined
  expect(popup.close).not.toHaveBeenCalled()
})

it('keeps the manual link when a browser throws while reserving the sign-in window', async () => {
  vi.mocked(window.open).mockImplementation(() => { throw new Error('PRIVATE POPUP DETAIL') })
  respond('/start', () => pending())
  await mount()
  await click(en['grok.signIn'])
  expect(text()).toContain(en['grok.popupBlocked'])
  expect(text()).not.toContain('PRIVATE POPUP DETAIL')
  expect(container.querySelector('a')?.href).toBe(view.attempt!.verificationUri)
})

it('does not reopen a window closed by the person while the challenge is loading', async () => {
  const { popup, navigate } = popupFixture()
  respond('/start', () => pending({ verificationUri: undefined }))
  await mount()
  await click(en['grok.signIn'])
  popup.closed = true
  view = pending()
  await visible()
  expect(text()).toContain(en['grok.popupBlocked'])
  expect(navigate).not.toHaveBeenCalled()
  expect(window.open).toHaveBeenCalledTimes(1)
  expect(container.querySelector('a')?.href).toBe(view.attempt!.verificationUri)
})

it('leaves a user-navigated reserved window alone when the verification URL arrives', async () => {
  const { popup, navigate } = popupFixture()
  respond('/start', () => pending({ verificationUri: undefined }))
  await mount()
  await click(en['grok.signIn'])
  popup.location.href = 'https://example.test/user-chosen'
  view = pending()
  await visible()
  expect(navigate).not.toHaveBeenCalled()
  expect(popup.close).not.toHaveBeenCalled()
  expect(text()).toContain(en['grok.popupBlocked'])
})

it.each(['failure', 'cancel', 'expiry', 'unmount', 'superseded', 'authorized', 'unsafe'])(
  'closes a still-blank reservation after %s without navigating a stale or unsafe URL', async ending => {
    const { popup, navigate } = popupFixture()
    if (ending === 'failure') responses['/start'] = () => Response.json({ subscription: 'network' }, { status: 503 })
    else respond('/start', () => pending({ verificationUri: undefined }))
    await mount()
    await click(en['grok.signIn'])
    if (ending === 'cancel') {
      respond('/cancel', () => signedOut({ attempt: { ...view.attempt!, phase: 'cancelled' } }))
      await click(en['grok.cancel'])
    } else if (ending === 'expiry') await tick(300_000)
    else if (ending === 'unmount') { act(() => { root!.unmount() }); root = undefined }
    else if (ending !== 'failure') {
      view = ending === 'superseded' ? pending({ id: 'different-attempt' }) : ending === 'authorized'
        ? connected({ attempt: { ...view.attempt!, phase: 'authorized' } }) : pending({ verificationUri: 'https://evil.example/device' })
      await visible()
    }
    expect(popup.close).toHaveBeenCalledTimes(1)
    expect(navigate).not.toHaveBeenCalled()
  },
)

it('does not open a popup for pending state loaded on mount or after provider re-entry', async () => {
  view = pending()
  await mountProvider('xai')
  expect(container.querySelector('a')?.href).toBe(view.attempt!.verificationUri)
  await mountProvider('openai')
  await mountProvider('xai')
  await visible()
  expect(window.open).not.toHaveBeenCalled()
})

it('prevents duplicate starts while the start request is pending', async () => {
  const started = deferred<Response>()
  responses['/start'] = () => started.promise
  await mount()
  await act(async () => { const start = button(en['grok.signIn']); start.click(); start.click() })
  expect(writes()).toHaveLength(1)
  expect(window.open).toHaveBeenCalledTimes(1)
  expect(button(en['grok.starting']).disabled).toBe(true)
  await act(async () => { view = pending(); started.resolve(Response.json(view)) })
  await flush()
  expect(text()).toContain(en['grok.waiting'])
})

it('cancels the exact current attempt and discards a pre-cancel polling response', async () => {
  view = pending()
  respond('/cancel', () => signedOut({ attempt: { ...view.attempt!, phase: 'cancelled' } }))
  await mount()
  const held = deferred<Response>()
  const old = structuredClone(view)
  read = () => held.promise
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  await flush()
  await click(en['grok.cancel'])
  expect(writes()).toEqual([{ method: 'POST', path: '/cancel', body: { id: 'attempt-1' } }])
  expect(text()).toContain(en['grok.cancelled'])
  read = undefined
  await act(async () => { held.resolve(Response.json(old)) })
  await flush()
  expect(text()).toContain(en['grok.cancelled'])
  expect(text()).not.toContain('ABCD-EFGH')
})

it('expires the app waiting window without displaying an old code and allows an explicit retry', async () => {
  view = pending({ expiresAt: new Date(Date.now() + 2000).toISOString() })
  respond('/start', () => pending({ id: 'attempt-2', code: 'NEW-CODE' }))
  await mount()
  await tick(2000)
  expect(text()).toContain(en['grok.expired'])
  expect(text()).not.toContain('ABCD-EFGH')
  expect(container.querySelector('a')).toBeNull()
  expect(writes()).toEqual([])
  await click(en['grok.retry'])
  expect(writes()).toEqual([{ method: 'POST', path: '/start', body: {} }])
  expect(text()).toContain('NEW-CODE')
})

it.each([
  { available: false, message: 'grok.unavailable' },
  { writable: false, message: 'grok.readOnly' },
] as const)('keeps sign-in disabled when the host reports $message', async ({ message, ...changes }) => {
  view = signedOut(changes)
  await mount()
  expect(text()).toContain(en[message])
  expect(button(en['grok.signIn']).disabled).toBe(true)
  await click(en['grok.signIn'])
  expect(writes()).toEqual([])
})

it('disables activation and sign-out on a read-only host', async () => {
  view = connected({ writable: false })
  await mount()
  expect(button(en['grok.activate']).disabled).toBe(true)
  expect(button(en['grok.logout']).disabled).toBe(true)
  expect(writes()).toEqual([])
})

it.each(['https://accounts.x.ai/oauth2/device', 'https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH', 'https://auth.x.ai/device'])(
  'renders the trusted native verification link and cancels the challenge: %s', async verificationUri => {
    view = pending({ verificationUri })
    respond('/cancel', () => signedOut({ attempt: { ...view.attempt!, phase: 'cancelled', code: undefined, verificationUri: undefined } }))
    await mount()
    expect(container.querySelector('a')?.href).toBe(verificationUri)
    expect(text()).not.toContain(en['grok.unsafeLink'])
    await click(en['grok.cancel'])
    expect(writes()).toEqual([{ method: 'POST', path: '/cancel', body: { id: 'attempt-1' } }])
    expect(container.querySelector('a')).toBeNull()
  },
)

it.each([
  'http://auth.x.ai/device', 'https://auth.x.ai.evil.example/device', 'https://evil.example/device',
  'https://auth.x.ai@evil.example/device', 'https://user:password@auth.x.ai/device', 'https://auth.x.ai:8443/device',
  'javascript:alert(1)', '//auth.x.ai/device', ' https://auth.x.ai/device', 'https://auth.x.ai/\ndevice',
  'http://accounts.x.ai/oauth2/device', 'https://accounts.x.ai.evil.example/oauth2/device', 'https://evil.accounts.x.ai/oauth2/device',
  'https://accounts.x.ai@evil.example/oauth2/device', 'https://user:password@accounts.x.ai/oauth2/device',
  'https://accounts.x.ai:8443/oauth2/device', '//accounts.x.ai/oauth2/device', ' https://accounts.x.ai/oauth2/device',
  'https://accounts.x.ai/\ndevice', 'blob:https://accounts.x.ai/fixture-id', 'blob:https://auth.x.ai/fixture-id',
])('does not render an untrusted verification address: %s', async verificationUri => {
  view = pending({ verificationUri })
  await mount()
  expect(container.querySelector('a')).toBeNull()
  expect(text()).toContain(en['grok.unsafeLink'])
  expect(text()).not.toContain(verificationUri)
})

it('requires explicit saved-API-key replacement confirmation and supports keyboard dismissal', async () => {
  view = signedOut({ credential: 'api-key', route: 'api-key' })
  respond('/start', () => pending())
  await mount()
  await click(en['grok.signIn'])
  expect(writes()).toEqual([])
  expect(window.open).not.toHaveBeenCalled()
  expect(text()).toContain(en['grok.replaceWarning'])
  expect(document.activeElement).toBe(button(en.cancel))
  await act(async () => { button(en.cancel).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
  expect(container.querySelector('[role="group"]')).toBeNull()
  expect(document.activeElement).toBe(button(en['grok.signIn']))
  await click(en['grok.signIn'])
  await click(en['grok.replaceConfirm'])
  expect(window.open).toHaveBeenCalledTimes(1)
  expect(writes()).toEqual([{ method: 'POST', path: '/start', body: { replaceApiKey: true } }])
})

it('renders only known subscription error messages and allows a fresh attempt', async () => {
  view = pending({ phase: 'failed', error: 'denied' })
  view.busy = false
  respond('/start', () => pending({ id: 'attempt-2' }))
  await mount()
  expect(text()).toContain(en['grok.error.denied'])
  await click(en['grok.retry'])
  expect(writes()).toHaveLength(1)
  expect(text()).not.toContain(en['grok.error.denied'])
})

it('keeps raw host errors out of the UI and reports API-key conflicts with localized copy', async () => {
  responses['/start'] = () => Response.json({ error: 'PRIVATE HOST DETAIL', subscription: 'api-key' }, { status: 409 })
  await mount()
  await click(en['grok.signIn'])
  expect(text()).toContain(en['grok.error.api-key'])
  expect(text()).not.toContain('PRIVATE HOST DETAIL')
})

it.each(['unavailable', 'denied', 'expired', 'network', 'unsupported', 'conflict', 'api-key'] as const)(
  'preserves the safe subscription failure code %s independently of HTTP status', async subscription => {
    responses['/start'] = () => Response.json({ subscription, error: 'PRIVATE HOST DETAIL' }, { status: 400 })
    await mount()
    await click(en['grok.signIn'])
    expect(text()).toContain(en[`grok.error.${subscription}`])
    expect(text()).not.toContain('PRIVATE HOST DETAIL')
  },
)

it('uses a safe status fallback for an unknown subscription failure code', async () => {
  responses['/start'] = () => Response.json({ subscription: 'PRIVATE HOST DETAIL' }, { status: 400 })
  await mount()
  await click(en['grok.signIn'])
  expect(text()).toContain(en.requestFailed.replace('{status}', '400'))
  expect(text()).not.toContain('PRIVATE HOST DETAIL')
})

it('uses standard localized transport errors without echoing host exception text', async () => {
  read = async () => { throw new Error('PRIVATE CONNECTION DETAIL') }
  await mount()
  expect(text()).toContain(en.offline)
  expect(text()).not.toContain('PRIVATE CONNECTION DETAIL')
  read = () => Response.json({ error: 'PRIVATE SERVER DETAIL' }, { status: 500 })
  await click(en.retry)
  expect(text()).toContain(en.serverError.replace('{status}', '500'))
  expect(text()).not.toContain('PRIVATE SERVER DETAIL')
  read = undefined
  await click(en.retry)
  expect(text()).toContain(en['grok.signedOut'])
  expect(writes()).toEqual([])
})

it('adds an unconfigured xAI route only after the explicit activation click and carries its revision', async () => {
  view = connected()
  respond('/activate', () => connected({ route: 'subscription', revision: 8, canActivate: false }))
  await mount()
  expect(writes()).toEqual([])
  expect(text()).toContain(en['grok.unconfigured'])
  await click(en['grok.activate'])
  expect(writes()).toEqual([{ method: 'POST', path: '/activate', body: { revision: 7 } }])
  expect(text()).toContain(en['grok.chooseModel'])
})

it('confirms switching a provider away from its explicit API-key reference', async () => {
  view = connected({ route: 'api-key' })
  respond('/activate', () => connected({ route: 'subscription', revision: 8, canActivate: false }))
  await mount()
  expect(text()).toContain(en['grok.apiRoute'])
  await click(en['grok.activate'])
  expect(writes()).toEqual([])
  expect(text()).toContain(en['grok.activateWarning'])
  await click(en['grok.activateConfirm'])
  expect(writes()).toEqual([{ method: 'POST', path: '/activate', body: { revision: 7 } }])
})

it('refuses an activation confirmation made against a superseded revision', async () => {
  view = connected({ route: 'api-key' })
  await mount()
  await click(en['grok.activate'])
  view = connected({ route: 'api-key', revision: 8 })
  await visible()
  await click(en['grok.activateConfirm'])
  expect(writes()).toEqual([])
  expect(text()).toContain(en['grok.error.conflict'])
})

it('explains an inherited API-key reference and withholds unsupported activation', async () => {
  view = connected({ route: 'api-key', canActivate: false, activationBlocked: 'inherited-api-key' })
  await mount()
  expect(text()).toContain(en['grok.inheritedRoute'])
  expect([...container.querySelectorAll('button')].some(item => item.textContent === en['grok.activate'])).toBe(false)
  expect(button(en['grok.logout']).disabled).toBe(false)
  expect(writes()).toEqual([])
})

it('preserves custom provider settings and does not offer unsupported activation', async () => {
  view = connected({ route: 'custom', canActivate: false })
  await mount()
  expect(text()).toContain(en['grok.customRoute'])
  expect([...container.querySelectorAll('button')].some(item => item.textContent === en['grok.activate'])).toBe(false)
  expect(writes()).toEqual([])
})

it('warns before subscription sign-out and does not let an older poll undo the result', async () => {
  view = connected({ route: 'subscription', canActivate: false })
  respond('/logout', () => signedOut({ route: 'subscription' }))
  await mount()
  await click(en['grok.logout'])
  expect(writes()).toEqual([])
  expect(text()).toContain(en['grok.logoutWarning'])
  expect(text()).toContain('host environment may become active')
  const held = deferred<Response>(), old = structuredClone(view)
  read = () => held.promise
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  await flush()
  await click(en['grok.logoutConfirm'])
  expect(writes()).toEqual([{ method: 'POST', path: '/logout', body: { confirm: true } }])
  expect(text()).toContain(en['grok.signedOut'])
  read = undefined
  await act(async () => { held.resolve(Response.json(old)) })
  await flush()
  expect(text()).not.toContain(en['grok.connected'])
  expect(text()).toContain(en['grok.signedOut'])
})

it('waits for clipboard completion and reports both success and denied access visibly', async () => {
  view = pending()
  const copied = deferred<void>()
  const writeText = vi.fn(() => copied.promise)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  await mount()
  await click(en['grok.copy'])
  expect(writeText).toHaveBeenCalledExactlyOnceWith('ABCD-EFGH')
  expect(button(en['grok.copying']).disabled).toBe(true)
  expect(text()).not.toContain(en['grok.copied'])
  await act(async () => { copied.resolve() })
  await flush()
  expect(text()).toContain(en['grok.copied'])
  writeText.mockRejectedValueOnce(new Error('DENIED PRIVATE DETAIL'))
  await click(en['grok.copy'])
  expect(text()).toContain(en['grok.copyFailed'])
  expect(text()).not.toContain('DENIED PRIVATE DETAIL')
})

it('refreshes on visibility without starting sign-in and stops polling after unmount', async () => {
  await mount()
  view = connected()
  await visible()
  expect(text()).toContain(en['grok.connected'])
  expect(writes()).toEqual([])
  act(() => { root!.unmount() }); root = undefined
  const count = requests.length
  await tick(20_000)
  await visible()
  expect(requests).toHaveLength(count)
})

it('lets the newest polling generation win when a prior poll is still outstanding', async () => {
  await mount()
  const held = deferred<Response>()
  read = () => held.promise
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  await flush()
  read = undefined
  respond('/start', () => pending())
  await click(en['grok.signIn'])
  view = connected()
  await visible()
  expect(text()).toContain(en['grok.connected'])
  await act(async () => { held.resolve(Response.json(signedOut())) })
  await flush()
  expect(text()).toContain(en['grok.connected'])
  expect(writes()).toHaveLength(1)
})

it('ignores an outstanding mutation after the card unmounts', async () => {
  const held = deferred<Response>()
  responses['/start'] = () => held.promise
  await mount()
  await click(en['grok.signIn'])
  act(() => { root!.unmount() }); root = undefined
  const count = requests.length
  await act(async () => { held.resolve(Response.json(pending())) })
  await tick(10_000)
  expect(requests).toHaveLength(count)
  expect(container.textContent).toBe('')
})

it('keeps subscription CSS scoped and follows the one-rule-per-line convention', async () => {
  const { readFileSync } = await import('node:fs')
  const css = readFileSync(`${process.cwd()}/src/client/grok.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const selectors: string[] = []
  for (const line of css.split('\n').map(value => value.trim()).filter(Boolean)) {
    expect(line).toMatch(/^[^{}]+\{[^{}]*\}$/)
    const selector = line.slice(0, line.indexOf('{')).trim()
    expect(selector.split(',').every(value => value.trim().startsWith('.dt-grok'))).toBe(true)
    expect(selectors).not.toContain(selector)
    selectors.push(selector)
  }
})

it('uses Korean labels for the complete manual sign-in and cancel flow', async () => {
  respond('/start', () => pending())
  respond('/cancel', () => signedOut({ attempt: { ...view.attempt!, phase: 'cancelled' } }))
  await mount(ko)
  expect(text()).toContain('Grok 구독')
  await click(ko['grok.signIn'])
  expect(text()).toContain(ko['grok.waiting'])
  expect(container.querySelector('a')?.textContent).toBe('xAI 로그인 열기')
  await click(ko['grok.cancel'])
  expect(text()).toContain(ko['grok.cancelled'])
  expect(text()).not.toMatch(/grok\.[A-Za-z]/)
})
