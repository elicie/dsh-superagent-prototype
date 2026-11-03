/**
 * Deployment settings view shared between the panel Settings tab and the DSH Plugin Manager config page.
 * Edits host-level plugin configuration limits through DSH `ConfigForm` when writable.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConfigPageForm } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { INSTANCE_PATTERN, managementPrefix, type InstanceView } from '../instance.ts'
import { LIMITS } from '../limits.ts'
import { AddInstanceFailure, addInstance, useInstances, type InstancesData, type SetupView } from './api.ts'
import { Button, Icon, InfoTip, Input } from './controls.tsx'
import { SaveBar, useDraft } from './draft.tsx'
import { PanelProvider, usePanel, usePanelData } from './provider.tsx'
import { Field, Fields } from './settings-kit.tsx'
import { errorText, setupText, type T } from './text.ts'
import { CheckSetupButton, Hint, KeyValues, Section, SetupMessage } from './widgets.tsx'

export type DeploymentForm = ConfigPageForm | undefined

/** The instance list and what the Deployment settings may do with it, given by the page that shows them. */
export interface InstancesControl extends Pick<InstancesData, 'instances' | 'adding' | 'reload'> {
  /**
   * Show a newly added, running instance, with a notice for its first screen. Absent where the page cannot change the instance it
   * shows, as in DeepSeek Harness's Plugin Manager, which then only confirms.
   */
  switchTo?: (instance: InstanceView, notice: string) => void
}
export const InstancesContext = createContext<InstancesControl | undefined>(undefined)

/** What a refused or failed addition says, by the host's code; `error` is the host's own text. */
function addFailureText(t: T, failure: unknown, key: string): string {
  if (!(failure instanceof AddInstanceFailure)) return errorText(failure)
  const { status, code, message } = failure
  if (code) return t(`instanceError.${code}`, { key, error: message || t('serverError', { status }) })
  return !status ? t('offline') : status === 404 && !message ? t('hostNotRunning') : status >= 500 ? t('serverError', { status })
    : t('requestFailed', { status })
}
/**
 * Every instance of the process, and a form to add one when the host can. Process-level: it lists the same instances whichever
 * one the page shows. Hidden when the host does not list instances, or when there is only one and no way to add another.
 */
function InstancesSection() {
  const { t, notify } = usePanel()
  const control = useContext(InstancesContext)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ error: boolean; text: string }>()
  const running = useRef(false)
  if (!control?.instances || (control.instances.length < 2 && !control.adding)) return null
  const { instances, adding, reload, switchTo } = control
  const value = key.trim()
  const problem = !value ? undefined : !INSTANCE_PATTERN.test(value) ? 'invalid' : instances.some(view => view.instance === value) ? 'taken'
    : undefined
  const valid = !!value && !problem
  const add = async () => {
    if (running.current || !valid) return
    running.current = true; setBusy(true); setNote(undefined)
    try {
      const added = await addInstance(value)
      await reload()
      setKey('')
      if (!added.applied) setNote({ error: false, text: `${t('instanceAddedRestart', { name: value })}${added.restartReason
        ? ` ${t('instanceRestartReason', { reason: added.restartReason })}` : ''}` })
      else if (switchTo) switchTo(added.instance, t('instanceAdded', { name: value }))
      else notify(t('instanceAddedElsewhere', { name: value }))
    } catch (failure) {
      setNote({ error: true, text: addFailureText(t, failure, value) })
      // The host's refusal may mean the list or the ability to add changed since it was read.
      if (failure instanceof AddInstanceFailure && (failure.code === 'exists' || failure.code === 'unavailable')) void reload()
    } finally { running.current = false; setBusy(false) }
  }
  return <Section title={t('instances')} count={instances.length} hint={t('instancesHint')}>
    <ul className="dt-instances">{instances.map(view => <li key={view.instance}>
      <span className="dt-instance-key">{view.instance || t('instanceDefaultKey')}</span>
      <span className={view.repository ? 'dt-instance-repository' : 'dt-hint'}>{view.repository ?? t('instanceNotSetUp')}</span>
      <span className="dt-mono" title={t('instancePrefix')}>{view.prefix}</span>
    </li>)}</ul>
    {adding?.available === false && <Hint>{t(`instanceAddOff.${adding.reason}`)}</Hint>}
    {adding?.available === true && <div className="dt-add-instance">
      <Field label={t('instanceKey')} note={problem === 'taken' ? <span className="dt-error">{t('instanceKeyTaken', { key: value })}</span>
        : <span className={problem ? 'dt-error' : undefined}>{t('instanceKeyRule')}</span>}>
        <Input value={key} placeholder="tools" autoComplete="off" autoCapitalize="none" spellCheck={false} aria-invalid={!!problem}
          onChange={event => { setKey(event.target.value); setNote(undefined) }}
          // Enter adds the instance instead of submitting the limits form this section sits in.
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void add() } }} />
      </Field>
      {valid && <KeyValues rows={[[t('instancePrefix'), <span className="dt-mono">{managementPrefix(value)}</span>],
        [t('deploymentStateDir'), <span className="dt-mono">{`${adding.stateDirBase}-${value}`}</span>]]} />}
      <Hint>{t('instanceAddIntro')}</Hint>
      {instances.length === 1 && <p className="dt-banner">{t('instanceAddShared')}</p>}
      <div className="dt-row-buttons">
        <Button variant="primary" icon={<Icon name="plus" size={14} />} disabled={!valid || busy}
          onClick={() => { void add() }}>{busy ? t('instanceAdding') : t('instanceAdd')}</Button>
      </div>
    </div>}
    {note && <p className={note.error ? 'dt-error' : 'dt-hint'} role={note.error ? 'alert' : 'status'}>{note.text}</p>}
  </Section>
}
type Op = Parameters<ConfigPageForm['mutate']>[0][number]

const MACHINE_LIMITS = ['promptMaxChars', 'admissionContextMaxPages', 'admissionContextTimeoutMs'] as const
type Limits = Record<typeof MACHINE_LIMITS[number], string>
const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : ''
const limitsOf = (values: object | undefined): Limits =>
  Object.fromEntries(MACHINE_LIMITS.map(key => [key, text((values as Record<string, unknown> | undefined)?.[key])])) as Limits

export function usePageForm(form: ConfigForm<Record<string, unknown>> | undefined): DeploymentForm {
  const subscribe = useCallback((listener: () => void) => form ? form.subscribe(listener) : () => {}, [form])
  const state = useSyncExternalStore(subscribe, () => form?.getSnapshot())
  return useMemo(() => form && state ? { state, mutate: form.mutate.bind(form) } : undefined, [form, state])
}

/** Deployment configuration form; falls back to read-only display when DSH config forms are unavailable or read-only. */
export function DeploymentPage({ setup, form, accounts: showAccounts }: { setup: SetupView; form: DeploymentForm; accounts?: boolean }) {
  const { t, notify } = usePanel()
  const snapshot = form?.state
  const editable = snapshot?.status === 'ready' && snapshot.writable
  // Pass `revision` only while DSH serves writable values so a draft started before `ready` rebases once writable.
  const draft = useDraft({ saved: limitsOf(editable ? snapshot.value : setup.machine), revision: editable ? snapshot.revision : undefined,
    reload: async () => {},
    save: async (value, revision, base) => {
      const ops: Op[] = MACHINE_LIMITS.filter(key => value[key].trim() !== base[key].trim())
        .map(key => value[key].trim() ? { op: 'set', path: [key], value: Number(value[key]) } : { op: 'unset', path: [key] })
      if (!form || !await form.mutate(ops, revision)) throw new Error(t('deploymentRefused'))
      notify(t('saved'))
      return { revision: revision + 1, restarting: false }
    } })
  const accounts = setup.accounts
  // Remote browsers (`memory` mode) are read-only; `unavailable` indicates `dsh-superagent` is still starting.
  const readOnlyHint = !form ? t('deploymentNoForms') : snapshot?.mode === 'memory' ? t('deploymentReadOnly')
    : snapshot?.status === 'loading' ? t('loading') : snapshot?.status === 'unavailable' ? t('deploymentUnavailable')
    : !editable ? t('deploymentReadOnly') : undefined
  const limit = (key: typeof MACHINE_LIMITS[number], label: string) => <Field label={label}>
    <Input type="number" min={LIMITS[key].min} max={LIMITS[key].max} step={1} value={draft.value[key]} disabled={!editable}
      onChange={event => draft.edit({ ...draft.value, [key]: event.target.value })} />
  </Field>
  const feishu = accounts?.feishu ? accounts.feishu.name || accounts.feishu.botId
    : setup.feishuProblem ? setupText(t, setup.feishuProblem) : t('deploymentFeishuNone')
  return <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
    <Fields disabled={draft.busy}>
      <Hint>{t('deploymentIntro')}</Hint>
      {setup.problem && <div className="dt-row-buttons">
        <p className="dt-error" role="status"><SetupMessage problem={setup.problem} lead /></p><CheckSetupButton />
      </div>}
      {showAccounts && <Section title={t('deploymentDerived')} hint={t('deploymentDerivedHint')}>
        <KeyValues rows={[[t('deploymentRepository'), accounts?.repository ?? '—'],
          [t('deploymentAgent'), accounts ? `@${accounts.agent}` : '—'], [t('deploymentFeishu'), feishu]]} />
        <Hint>{t('deploymentAccountsWhere')}</Hint>
      </Section>}
      <InstancesSection />
      <Section title={t('deploymentMachine')}>
        {readOnlyHint && <Hint>{readOnlyHint}</Hint>}
        <div className="dt-field">
          <span className="dt-field-head">{t('deploymentStateDir')}<InfoTip text={t('deploymentStateDirHint')} /></span>
          <span className="dt-mono">{setup.machine.stateDir}</span>
        </div>
      </Section>
      <Section title={t('deploymentLimits')} hint={t('deploymentLimitsHint')}>
        {limit('promptMaxChars', t('deploymentPromptMaxChars'))}
        {limit('admissionContextMaxPages', t('deploymentContextPages'))}
        {limit('admissionContextTimeoutMs', t('deploymentContextTimeout'))}
      </Section>
    </Fields>
    {editable && <SaveBar {...draft} onDiscard={draft.discard} />}
  </form>
}

/** The Plugin Manager page lists the instances itself, as no panel above it does; it can add one, not switch to it. */
function StandaloneInstances({ children }: { children: ReactNode }) {
  const { instances, adding, reload } = useInstances()
  const control = useMemo(() => ({ instances, adding, reload }), [instances, adding, reload])
  return <InstancesContext.Provider value={control}>{children}</InstancesContext.Provider>
}
/** Plugin Manager config page; includes derived repository and accounts because Source settings live in the main panel. */
function PluginPage({ form }: { form: DeploymentForm }) {
  const { t } = usePanel()
  const { state, error } = usePanelData()
  return <div className="dt-embedded">
    {state ? <DeploymentPage setup={state.setup} form={form} accounts />
      : error ? <p className="dt-error" role="alert">{error.message}</p> : <p className="dt-hint">{t('loading')}</p>}
  </div>
}
/** DSH Plugin Manager config view entry; renders nothing in `summary` mode because DSH displays the package description. */
export function PluginConfig({ t, view, form }: { t: T; view: 'page' | 'summary'; form: DeploymentForm }) {
  return view === 'page' ? <PanelProvider t={t} interval={10_000}><StandaloneInstances><PluginPage form={form} /></StandaloneInstances></PanelProvider> : null
}
