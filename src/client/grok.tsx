/** Native subscription sign-in within xAI's add-provider draft and saved provider row. */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { verificationLink, type SubscriptionView } from '../app/subscriptions-api.ts'
import { ApiError, caller, usePoll, type ApiMessages } from './api.ts'
import { Button } from './controls.tsx'
import type { ModelProviderCardOwner } from './model-settings.d.ts'
import { fullTime, type T } from './text.ts'
import STYLES from './grok.css?raw'

type Operation = 'start' | 'cancel' | 'activate' | 'logout'
type Confirmation = { kind: 'replace' } | { kind: 'activate'; revision: number } | { kind: 'logout' }
const ERROR_KEYS = {
  unavailable: 'grok.error.unavailable', denied: 'grok.error.denied', expired: 'grok.error.expired', network: 'grok.error.network',
  unsupported: 'grok.error.unsupported', conflict: 'grok.error.conflict', 'api-key': 'grok.error.api-key',
} as const
const messages = (t: T): ApiMessages => ({
  offline: t('offline'), notRunning: t('hostNotRunning'), serverError: status => t('serverError', { status }),
  requestFailed: status => t('requestFailed', { status }), setup: () => t('grok.error.unavailable'), user: () => t('grok.error.conflict'),
})
const asError = (failure: unknown): Error => failure instanceof Error ? failure : new Error()
function failureText(t: T, failure: Error): string {
  if (!(failure instanceof ApiError)) return t('grok.error.network')
  if (failure.details.subscription) return t(ERROR_KEYS[failure.details.subscription])
  if (failure.status === 0) return t('offline')
  if (failure.status === 404 && failure.details.unreachable) return t('hostNotRunning')
  if (failure.status === 409) return t('grok.error.conflict')
  if (failure.status === 501) return t('grok.error.unsupported')
  if (failure.status === 503) return t('grok.error.unavailable')
  return failure.status >= 500 ? t('serverError', { status: failure.status }) : t('requestFailed', { status: failure.status })
}
const expired = (view: SubscriptionView | undefined, now: number): boolean =>
  view?.attempt?.phase === 'pending' && Number.isFinite(Date.parse(view.attempt.expiresAt)) && Date.parse(view.attempt.expiresAt) <= now

export function GrokProviderSubscription({ provider, configured, t }: ModelProviderCardOwner & { t: T }) {
  if (provider.provider !== 'xai') return null
  return configured ? <details className="dt-grok-provider">
    <summary>{t('grok.title')} · {t('grok.manage')}</summary>
    <GrokSubscription t={t} />
  </details> : <GrokSubscription t={t} />
}

export function GrokSubscription({ t }: { t: T }) {
  const titleId = useId(), confirmationId = useId()
  const copy = useRef(t)
  copy.current = t
  const call = useMemo(() => caller(() => messages(copy.current)), [])
  const mounted = useRef(true), generation = useRef(0), reads = useRef(0), running = useRef(false)
  const latest = useRef<SubscriptionView>()
  const [view, setView] = useState<SubscriptionView>()
  const [readFailure, setReadFailure] = useState<Error>()
  const [actionFailure, setActionFailure] = useState<Error>()
  const [operation, setOperation] = useState<Operation>()
  const [confirmation, setConfirmation] = useState<Confirmation>()
  const confirmationRoot = useRef<HTMLDivElement>(null), opener = useRef<HTMLButtonElement>(), returnFocus = useRef(false)
  const actions = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(Date.now)
  const [copying, setCopying] = useState(false), copyLock = useRef(false)
  const [copied, setCopied] = useState<'done' | 'failed'>()
  const signInWindow = useRef<{ window: Window; document: Document; attemptId?: string }>()
  const [windowState, setWindowState] = useState<'opened' | 'blocked'>()
  const closeWaitingWindow = useCallback(() => {
    const waiting = signInWindow.current
    signInWindow.current = undefined
    try {
      if (waiting && !waiting.window.closed && waiting.window.document === waiting.document && waiting.window.location.href === 'about:blank') waiting.window.close()
    } catch { /* A user-navigated window keeps its own lifecycle. */ }
  }, [])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; generation.current++; closeWaitingWindow() }
  }, [closeWaitingWindow])
  const publish = useCallback((next: SubscriptionView) => { latest.current = next; setView(next) }, [])
  const load = useCallback(async () => {
    if (!mounted.current || running.current) return latest.current
    const request = generation.current, read = ++reads.current
    try {
      const next = await call('GET subscriptions/grok')
      if (mounted.current && request === generation.current && read === reads.current && !running.current) {
        publish(next)
        setReadFailure(undefined)
      }
      return next
    } catch (failure) {
      if (mounted.current && request === generation.current && read === reads.current && !running.current) setReadFailure(asError(failure))
      return latest.current
    }
  }, [call, publish])
  const { reload } = usePoll(load, [load], view?.attempt?.phase === 'pending' ? 1500 : 5000)
  const attempt = view?.attempt
  useEffect(() => {
    setNow(Date.now())
    if (attempt?.phase !== 'pending') return
    const until = Date.parse(attempt.expiresAt)
    if (!Number.isFinite(until)) return
    const timer = setTimeout(() => { setNow(Date.now()); void reload() }, Math.min(2_147_483_647, Math.max(0, until - Date.now())))
    return () => { clearTimeout(timer) }
  }, [attempt?.id, attempt?.phase, attempt?.expiresAt, reload])
  useEffect(() => { setCopied(undefined); setCopying(false); copyLock.current = false }, [attempt?.id, attempt?.code])
  useEffect(() => {
    const waiting = signInWindow.current
    if (!waiting?.attemptId) return
    if (attempt?.id !== waiting.attemptId || attempt.phase !== 'pending' || expired(view, Date.now()) || view?.connected) {
      closeWaitingWindow(); return
    }
    try {
      if (waiting.window.closed || waiting.window.document !== waiting.document || waiting.window.location.href !== 'about:blank') {
        signInWindow.current = undefined; setWindowState('blocked'); return
      }
      if (!attempt.verificationUri) return
      const url = verificationLink(attempt.verificationUri)
      if (!url) { closeWaitingWindow(); return }
      const link = waiting.window.document.createElement('a')
      link.href = url
      link.rel = 'noopener noreferrer'
      link.referrerPolicy = 'no-referrer'
      waiting.window.document.body.append(link)
      link.click()
      signInWindow.current = undefined
      setWindowState('opened')
    } catch { closeWaitingWindow(); setWindowState('blocked') }
  }, [view, attempt, now, closeWaitingWindow])
  useEffect(() => {
    if (confirmation) confirmationRoot.current?.querySelector('button')?.focus()
    else if (returnFocus.current) {
      const buttons = [...actions.current?.querySelectorAll('button') ?? []]
      const target = buttons.find(button => button.textContent === opener.current?.textContent) ?? buttons[0]
      target?.focus()
      returnFocus.current = false
    }
  }, [confirmation])

  const send = async (kind: Operation, request: () => Promise<SubscriptionView>) => {
    const current = latest.current
    if (!mounted.current || running.current || !current?.available || !current.writable) return
    const token = ++generation.current
    running.current = true
    setOperation(kind)
    setActionFailure(undefined)
    setConfirmation(undefined)
    setCopied(undefined)
    setCopying(false)
    copyLock.current = false
    try {
      const next = await request()
      if (mounted.current && token === generation.current) {
        if (kind === 'start' && signInWindow.current) signInWindow.current.attemptId = next.attempt?.id
        if (kind === 'start' && !signInWindow.current?.attemptId) closeWaitingWindow()
        publish(next); setReadFailure(undefined)
      }
    } catch (failure) {
      if (mounted.current && token === generation.current) {
        if (kind === 'start') closeWaitingWindow()
        setActionFailure(asError(failure))
      }
    } finally {
      if (mounted.current && token === generation.current) {
        running.current = false
        setOperation(undefined)
        void reload()
      }
    }
  }
  const ask = (next: Confirmation, button: HTMLButtonElement) => { opener.current = button; setConfirmation(next) }
  const dismiss = () => { returnFocus.current = true; setConfirmation(undefined) }
  const start = (button: HTMLButtonElement, replaceApiKey = false) => {
    const current = latest.current
    if (!mounted.current || running.current || !current?.available || !current.writable || readFailure || current.connected
      || current.busy && !expired(current, Date.now()) || current.attempt?.phase === 'pending' && !expired(current, Date.now())) return
    if (current.credential === 'api-key' && !replaceApiKey) { ask({ kind: 'replace' }, button); return }
    closeWaitingWindow()
    setWindowState(undefined)
    // Reserve during the click; xAI's verification URL arrives after the native device challenge.
    try {
      const popup = window.open('about:blank', '_blank', 'popup,width=560,height=720')
      if (popup) {
        signInWindow.current = { window: popup, document: popup.document }
        popup.opener = null
        const policy = popup.document.createElement('meta')
        policy.name = 'referrer'; policy.content = 'no-referrer'
        popup.document.head.append(policy)
        popup.document.title = t('grok.title')
        popup.document.documentElement.lang = t('lang')
        const heading = popup.document.createElement('h1')
        heading.textContent = t('grok.title')
        const progress = popup.document.createElement('p')
        progress.textContent = t('grok.starting')
        progress.role = 'status'
        popup.document.body.replaceChildren(heading, progress)
      } else setWindowState('blocked')
    } catch { closeWaitingWindow(); setWindowState('blocked') }
    void send('start', () => call('POST subscriptions/grok/start', { body: replaceApiKey ? { replaceApiKey: true } : {} }))
  }
  const activate = (button: HTMLButtonElement) => {
    const current = latest.current
    if (!current?.connected || !current.canActivate || current.revision === undefined || current.busy
      || current.route !== 'unconfigured' && current.route !== 'api-key') return
    const revision = current.revision
    if (current.route === 'api-key') { ask({ kind: 'activate', revision }, button); return }
    void send('activate', () => call('POST subscriptions/grok/activate', { body: { revision } }))
  }
  const confirm = (button: HTMLButtonElement) => {
    const current = latest.current
    if (!confirmation || !current) return
    if (confirmation.kind === 'replace') { start(button, true); return }
    if (current.busy || !current.connected) return
    if (confirmation.kind === 'logout') {
      void send('logout', () => call('POST subscriptions/grok/logout', { body: { confirm: true } }))
    } else if (current.canActivate && current.route === 'api-key' && current.revision === confirmation.revision) {
      const revision = confirmation.revision
      void send('activate', () => call('POST subscriptions/grok/activate', { body: { revision } }))
    } else {
      setConfirmation(undefined)
      setActionFailure(new ApiError('', 409))
      void reload()
    }
  }
  const copyCode = async () => {
    const current = latest.current?.attempt
    if (!current?.code || current.phase !== 'pending' || expired(latest.current, Date.now()) || copyLock.current) return
    const token = generation.current
    copyLock.current = true
    setCopying(true)
    setCopied(undefined)
    try {
      await navigator.clipboard.writeText(current.code)
      if (mounted.current && token === generation.current && latest.current?.attempt?.id === current.id && latest.current.attempt.code === current.code) setCopied('done')
    } catch {
      if (mounted.current && token === generation.current && latest.current?.attempt?.id === current.id && latest.current.attempt.code === current.code) setCopied('failed')
    } finally {
      if (mounted.current && token === generation.current && latest.current?.attempt?.id === current.id && latest.current.attempt.code === current.code) {
        copyLock.current = false
        setCopying(false)
      }
    }
  }

  const timedOut = expired(view, now)
  const phase = timedOut ? 'expired' : attempt?.phase
  const pending = phase === 'pending'
  const link = pending ? verificationLink(attempt?.verificationUri) : undefined
  const disabled = !view?.available || !view.writable || !!operation || !!readFailure
  const idle = !view?.busy || timedOut
  const error = actionFailure ?? readFailure
  const terminalError = phase === 'failed' ? t(attempt?.error && Object.hasOwn(ERROR_KEYS, attempt.error)
    ? ERROR_KEYS[attempt.error] : 'grok.error.network') : phase === 'expired' ? t('grok.expired') : undefined
  const confirmationTitle = confirmation?.kind === 'replace' ? 'grok.replaceTitle' : confirmation?.kind === 'activate' ? 'grok.activateTitle' : 'grok.logoutTitle'
  const confirmationWarning = confirmation?.kind === 'replace' ? 'grok.replaceWarning' : confirmation?.kind === 'activate' ? 'grok.activateWarning' : 'grok.logoutWarning'
  const confirmationLabel = confirmation?.kind === 'replace' ? 'grok.replaceConfirm' : confirmation?.kind === 'activate' ? 'grok.activateConfirm' : 'grok.logoutConfirm'
  return <section className="dt-grok" aria-labelledby={titleId}>
    <style>{STYLES}</style>
    <h3 id={titleId} className="dt-grok-title">{t('grok.title')}</h3>
    <p className="dt-grok-hint">{t('grok.intro')}</p>
    {!view && !error && <p role="status">{t('loading')}</p>}
    {view && <>
      <p className="dt-grok-status" role="status" aria-live="polite">{t(view.connected ? 'grok.connected' : pending ? 'grok.waiting'
        : phase === 'cancelled' ? 'grok.cancelled' : 'grok.signedOut')}</p>
      {!view.available && <p className="dt-grok-hint">{t('grok.unavailable')}</p>}
      {!view.writable && <p className="dt-grok-hint">{t('grok.readOnly')}</p>}
      {view.busy && !pending && !timedOut && <p className="dt-grok-hint" role="status">{t('grok.busy')}</p>}
      {view.credential === 'api-key' && !view.connected && <p className="dt-grok-hint">{t('grok.apiKey')}</p>}
      {pending && <div className="dt-grok-verification">
        {windowState && <p className="dt-grok-hint" role="status">{t(windowState === 'opened' ? 'grok.popupOpened' : 'grok.popupBlocked')}</p>}
        {attempt?.code && <div className="dt-grok-code-row"><span>{t('grok.code')}</span>
          <code className="dt-grok-code" aria-label={t('grok.code')}>{attempt.code}</code>
          <Button className="dt-grok-button" disabled={copying || !!operation} onClick={() => { void copyCode() }}>{t(copying ? 'grok.copying' : 'grok.copy')}</Button>
        </div>}
        {copied && <p className={copied === 'failed' ? 'dt-grok-error' : 'dt-grok-hint'} role={copied === 'failed' ? 'alert' : 'status'}>{t(copied === 'done' ? 'grok.copied' : 'grok.copyFailed')}</p>}
        {link && <a className="dt-grok-link" href={link} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{t('grok.open')}</a>}
        {attempt?.verificationUri && !link && <p className="dt-grok-error" role="alert">{t('grok.unsafeLink')}</p>}
        {attempt && fullTime(attempt.expiresAt, t('lang')) && <p className="dt-grok-hint">{t('grok.window', { time: fullTime(attempt.expiresAt, t('lang')) })}</p>}
      </div>}
      {terminalError && <p className="dt-grok-error" role="alert">{terminalError}</p>}
      {view.connected && <p className="dt-grok-hint">{t(view.activationBlocked === 'inherited-api-key' ? 'grok.inheritedRoute'
        : view.route === 'api-key' ? 'grok.apiRoute' : view.route === 'custom' ? 'grok.customRoute'
        : view.route === 'unconfigured' ? 'grok.unconfigured' : 'grok.chooseModel')}</p>}
      {!confirmation && <div ref={actions} className="dt-grok-actions">
        {!view.connected && !pending && <Button className="dt-grok-button" data-primary disabled={disabled || !idle}
          onClick={event => { start(event.currentTarget) }}>{t(operation === 'start' ? 'grok.starting' : phase === 'failed' || phase === 'expired' || phase === 'cancelled' ? 'grok.retry' : 'grok.signIn')}</Button>}
        {pending && <Button className="dt-grok-button" disabled={disabled} onClick={() => {
          const current = latest.current?.attempt
          if (current?.phase === 'pending') void send('cancel', () => call('POST subscriptions/grok/cancel', { body: { id: current.id } }))
        }}>{t(operation === 'cancel' ? 'grok.cancelling' : 'grok.cancel')}</Button>}
        {view.connected && view.canActivate && view.revision !== undefined && (view.route === 'unconfigured' || view.route === 'api-key') && <Button className="dt-grok-button" data-primary disabled={disabled || !idle}
          onClick={event => { activate(event.currentTarget) }}>{t(operation === 'activate' ? 'grok.activating' : 'grok.activate')}</Button>}
        {view.connected && <Button className="dt-grok-button" disabled={disabled || !idle}
          onClick={event => { ask({ kind: 'logout' }, event.currentTarget) }}>{t(operation === 'logout' ? 'grok.loggingOut' : 'grok.logout')}</Button>}
      </div>}
      {confirmation && <div ref={confirmationRoot} className="dt-grok-confirmation" role="group" aria-labelledby={confirmationId}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss() } }}>
        <h4 id={confirmationId}>{t(confirmationTitle)}</h4>
        <p className="dt-grok-hint">{t(confirmationWarning)}</p>
        <div className="dt-grok-actions"><Button className="dt-grok-button" onClick={dismiss}>{t('cancel')}</Button>
          <Button className="dt-grok-button" data-primary disabled={disabled || !idle} onClick={event => { confirm(event.currentTarget) }}>{t(confirmationLabel)}</Button></div>
      </div>}
    </>}
    {error && <div className="dt-grok-error-box"><p className="dt-grok-error" role="alert">{failureText(t, error)}</p>
      <Button className="dt-grok-button" disabled={!!operation} onClick={() => { setActionFailure(undefined); void reload() }}>{t('retry')}</Button></div>}
  </section>
}
