/** Runs only the native xAI subscription flow; credentials remain owned by DSH's credential service. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationService, AuthorizationNotice } from '@deepseek-ai/dsh-authorization'
import type { CredentialKey, CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { SettingsForms } from '@deepseek-ai/dsh-settings'
import { verificationLink, type SubscriptionAttempt, type SubscriptionError, type SubscriptionView } from './subscriptions-api.ts'

const KEY = 'llm-pi-ai/xai' as CredentialKey
const LOGIN_WINDOW_MS = 10 * 60_000
const RETENTION_MS = 5 * 60_000
const OFFICIAL_ENDPOINT = 'https://api.x.ai/v1'
export interface SubscriptionHost {
  authorization(): Pick<AuthorizationService, 'describe' | 'begin' | 'cancel'> | undefined
  credentials(): Pick<CredentialProvider, 'describeRecord' | 'deleteRecord'> | undefined
  settings(): Pick<SettingsForms, 'writable' | 'describe' | 'mutate'> | undefined
  llm: Pick<LlmRuntime, 'listConfigurableProviders' | 'listProviders'>
}
/** Stable, secret-free failure code suitable for the subscription management response. */
export class SubscriptionFailure extends Error {
  constructor(readonly code: SubscriptionError, readonly status: number = 400) { super(code) }
}
interface ActiveAttempt { view: SubscriptionAttempt; controller: AbortController; timer: ReturnType<typeof setTimeout>; done: Promise<void> }
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined
function at(value: unknown, path: readonly string[]): unknown {
  for (const key of path) value = object(value)?.[key]
  return value
}
function classify(error: unknown): SubscriptionError {
  const code = object(error)?.code
  if (code === 'ALREADY_IN_FLIGHT') return 'conflict'
  if (code === 'NO_FLOW' || code === 'UNKNOWN_METHOD') return 'unavailable'
  const message = error instanceof Error ? error.message : ''
  if (/expired|expir[ay]/i.test(message)) return 'expired'
  if (/denied|access_denied|authorization_denied/i.test(message)) return 'denied'
  return 'network'
}

/** Owns one bounded native xAI sign-in attempt and projects credential-free status to model settings. */
export class GrokSubscriptions {
  private attempt?: ActiveAttempt
  private closed = false
  private mutating = false
  constructor(private readonly host: SubscriptionHost) {}
  private flow() { return this.host.authorization()?.describe(KEY) }
  private target() {
    const entries = this.host.llm.listConfigurableProviders().filter(entry => entry.provider === 'xai')
    if (entries.length !== 1) return undefined
    const entry = entries[0]!
    if (entry.settingsPath.length !== 2 || entry.settingsPath[0] !== 'providers' || entry.settingsPath[1] !== 'xai') return undefined
    const settings = this.host.settings()
    const descriptor = settings?.describe({ redactSecrets: true }).find(item => item.ns === entry.settingsNs)
    return descriptor ? { entry, descriptor, settings: settings! } : undefined
  }
  private profile(target: NonNullable<ReturnType<GrokSubscriptions['target']>>) { return object(at(target.descriptor.value, target.entry.settingsPath)) }
  private inheritedApiKey(target = this.target()) { return !!target && at(target.descriptor.base, [...target.entry.settingsPath, 'apiKeyEnv']) !== undefined }
  private route(target = this.target()): SubscriptionView['route'] {
    if (!target) return 'unconfigured'
    const profile = this.profile(target)
    if (!profile) return 'unconfigured'
    const endpoint = typeof profile.baseURL === 'string' ? profile.baseURL.replace(/\/$/, '') : OFFICIAL_ENDPOINT
    if (endpoint !== OFFICIAL_ENDPOINT || (profile.api !== undefined && profile.api !== 'openai-responses')
      || (object(profile.headers) && Object.keys(object(profile.headers)!).length)
      || (Array.isArray(profile.models) && profile.models.some(model => object(model)?.baseUrl || object(model)?.baseURL
        || (object(model)?.api && object(model)?.api !== 'openai-responses')))
      || (object(profile.modelOverrides) && Object.values(object(profile.modelOverrides)!).some(model => object(model)?.baseUrl
        || object(model)?.baseURL || (object(model)?.api && object(model)?.api !== 'openai-responses')))) return 'custom'
    return typeof profile.apiKeyEnv === 'string' ? 'api-key' : 'subscription'
  }
  async view(): Promise<SubscriptionView> {
    const credentials = this.host.credentials(), flow = this.flow(), target = this.target()
    const info = await credentials?.describeRecord(KEY)
    const available = !!flow?.methods.some(method => method.id === 'oauth') && !!credentials
    const connected = info?.configured === true && info.kind === 'grant'
    const route = this.route(target), inheritedApiKey = this.inheritedApiKey(target)
    const attempt = this.attempt?.view
    const retained = attempt && (attempt.phase === 'pending' || Date.parse(attempt.expiresAt) + RETENTION_MS > Date.now()) ? { ...attempt } : undefined
    return { available, writable: !this.closed && available && info?.writable === true,
      connected, busy: this.mutating || !!flow?.inFlight,
      credential: connected ? 'subscription' : info?.configured && info.kind === 'api-key' ? 'api-key' : 'none',
      route, ...target ? { revision: target.descriptor.revision } : {},
      canActivate: connected && !!target?.settings.writable && (route === 'unconfigured' || route === 'api-key') && !inheritedApiKey && !this.closed,
      ...inheritedApiKey ? { activationBlocked: 'inherited-api-key' as const } : {},
      ...retained ? { attempt: retained } : {} }
  }
  private async exclusive(work: () => Promise<void>): Promise<SubscriptionView> {
    if (this.mutating || this.closed) throw new SubscriptionFailure(this.closed ? 'unavailable' : 'conflict', 409)
    this.mutating = true
    try { await work() } finally { this.mutating = false }
    return this.view()
  }
  async start(replaceApiKey = false): Promise<SubscriptionView> {
    return this.exclusive(async () => {
      const current = await this.view(), authorization = this.host.authorization()
      if (!current.available || !current.writable || !authorization) throw new SubscriptionFailure('unavailable', 503)
      if (this.attempt?.view.phase === 'pending' || this.flow()?.inFlight) throw new SubscriptionFailure('conflict', 409)
      if (current.route === 'custom') throw new SubscriptionFailure('unsupported')
      if (current.credential === 'api-key' && !replaceApiKey) throw new SubscriptionFailure('api-key', 409)
      const controller = new AbortController()
      const view: SubscriptionAttempt = { id: randomUUID(), phase: 'pending', expiresAt: new Date(Date.now() + LOGIN_WINDOW_MS).toISOString() }
      const active: ActiveAttempt = { view, controller, timer: setTimeout(() => {
        if (active.view.phase === 'pending') { active.view.phase = 'expired'; active.view.error = 'expired'; controller.abort() }
      }, LOGIN_WINDOW_MS), done: Promise.resolve() }
      active.timer.unref?.()
      this.attempt = active
      active.done = Promise.resolve().then(() => authorization.begin({ key: KEY, method: 'oauth', signal: controller.signal,
        interaction: {
          notify: notice => this.notice(active, notice),
          prompt: async () => { throw new SubscriptionFailure('unsupported') },
        } })).then(outcome => {
        if (this.closed || controller.signal.aborted || this.attempt !== active || active.view.phase !== 'pending') return
        active.view.phase = outcome.status
      }).catch(error => {
        if (this.closed || controller.signal.aborted || this.attempt !== active || active.view.phase !== 'pending') return
        const code = error instanceof SubscriptionFailure ? error.code : classify(error)
        active.view.phase = code === 'expired' ? 'expired' : 'failed'; active.view.error = code
      }).finally(() => {
        clearTimeout(active.timer)
        if (active.view.phase !== 'pending') { delete active.view.code; delete active.view.verificationUri }
      })
    })
  }
  private notice(active: ActiveAttempt, notice: AuthorizationNotice) {
    if (this.closed || this.attempt !== active || active.view.phase !== 'pending') return
    if (notice.url !== undefined) {
      const link = verificationLink(notice.url)
      if (!link) { active.view.phase = 'failed'; active.view.error = 'unsupported'; active.controller.abort(); return }
      active.view.verificationUri = link
    }
    if (notice.code !== undefined) {
      if (!/^[A-Za-z0-9][A-Za-z0-9 -]{0,63}$/.test(notice.code)) {
        active.view.phase = 'failed'; active.view.error = 'unsupported'; active.controller.abort(); return
      }
      active.view.code = notice.code
    }
  }
  async cancel(id: string): Promise<SubscriptionView> {
    const active = this.attempt
    if (active?.view.id === id && active.view.phase === 'pending') {
      active.view.phase = 'cancelled'; active.controller.abort(); clearTimeout(active.timer)
      delete active.view.code; delete active.view.verificationUri
      await active.done
    }
    return this.view()
  }
  async activate(revision: number): Promise<SubscriptionView> {
    return this.exclusive(async () => {
      const current = await this.view(), target = this.target()
      if (!current.connected || !target || !target.settings.writable) throw new SubscriptionFailure('unavailable')
      if (current.route === 'custom') throw new SubscriptionFailure('unsupported')
      if (target.descriptor.revision !== revision) throw new SubscriptionFailure('conflict', 409)
      if (current.route === 'subscription') return
      // Native object unsets reset to the inherited value, so a layered key reference needs a source-layer edit.
      if (this.inheritedApiKey(target)) throw new SubscriptionFailure('unsupported')
      const path = target.entry.settingsPath
      try {
        await target.settings.mutate(target.entry.settingsNs, this.profile(target)
          ? [{ op: 'unset', path: [...path, 'apiKeyEnv'] }]
          : [{ op: 'set', path, value: {} }], revision)
      } catch (error) {
        if (object(error)?.code === 'SETTINGS_CONFLICT') throw new SubscriptionFailure('conflict', 409)
        throw new SubscriptionFailure('unavailable', 503)
      }
      if (this.route() !== 'subscription') throw new SubscriptionFailure('unsupported')
    })
  }
  async logout(): Promise<SubscriptionView> {
    return this.exclusive(async () => {
      const active = this.attempt
      if (active?.view.phase === 'pending') await this.cancel(active.view.id)
      const credentials = this.host.credentials()
      if (!credentials) throw new SubscriptionFailure('unavailable', 503)
      const info = await credentials.describeRecord(KEY)
      if (!info.writable) throw new SubscriptionFailure('unavailable', 503)
      if (info.kind === 'grant') await credentials.deleteRecord(KEY)
      this.attempt = undefined
    })
  }
  async stop(): Promise<void> {
    this.closed = true
    const active = this.attempt
    if (active?.view.phase === 'pending') await this.cancel(active.view.id)
  }
}

/** Optional native services keep older hosts usable; unsupported hosts report capability without crashing the panel. */
export function subscriptionHost(ctx: Context): SubscriptionHost {
  return { authorization: () => ctx.get('authorization'), credentials: () => ctx.get('credentials'),
    settings: () => ctx.get('settings'), llm: ctx.llm }
}
