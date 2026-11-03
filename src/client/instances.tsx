/**
 * Adding a Superagent instance, opened from the header's instance selector (docs/005-panel.md). It is about the process rather
 * than the instance shown, so it sits beside the selector and not in any instance's Settings.
 */
import { useEffect, useRef, useState } from 'react'
import { INSTANCE_PATTERN, managementPrefix, type InstanceAdding, type InstanceView } from '../instance.ts'
import { AddInstanceFailure, addInstance, type InstancesData } from './api.ts'
import { Button, Icon, Input, Modal } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { Field } from './settings-kit.tsx'
import { errorText, type T } from './text.ts'
import { KeyValues } from './widgets.tsx'

/** What a refused or failed addition says, by the host's code; `error` is the host's own text. */
function addFailureText(t: T, failure: unknown, key: string): string {
  if (!(failure instanceof AddInstanceFailure)) return errorText(failure)
  const { status, code, message } = failure
  if (code) return t(`instanceError.${code}`, { key, error: message || t('serverError', { status }) })
  return !status ? t('offline') : status === 404 && !message ? t('hostNotRunning') : status >= 500 ? t('serverError', { status })
    : t('requestFailed', { status })
}

/**
 * Dialog that adds an instance under a new key, or says why this host cannot. Mounted only while open, so each opening starts
 * empty. A running addition cannot be dismissed: it ends within the host's own time limits, and its answer belongs here.
 */
export function AddInstanceDialog({ instances, adding, reload, switchTo, onClose }: Pick<InstancesData, 'reload'> & {
  instances: InstanceView[]; adding: InstanceAdding
  /** Show a newly added, running instance, with a notice for its first screen; this remounts the panel and so closes the dialog. */
  switchTo: (instance: InstanceView, notice: string) => void
  onClose: () => void
}) {
  const { t } = usePanel()
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ error: boolean; text: string }>()
  const running = useRef(false)
  const body = useRef<HTMLDivElement>(null)
  // `Modal` focuses the dialog itself as it opens; this runs after it, as the parent's effect, and moves on to the key.
  useEffect(() => { body.current?.querySelector('input')?.focus() }, [])
  const value = key.trim()
  const problem = !value ? undefined : !INSTANCE_PATTERN.test(value) ? 'invalid' : instances.some(view => view.instance === value) ? 'taken'
    : undefined
  const valid = adding.available && !!value && !problem
  const close = () => { if (!running.current) onClose() }
  const add = async () => {
    if (running.current || !valid) return
    running.current = true; setBusy(true); setNote(undefined)
    try {
      const added = await addInstance(value)
      await reload()
      if (added.applied) { switchTo(added.instance, t('instanceAdded', { name: value })); return }
      setKey('')
      setNote({ error: false, text: `${t('instanceAddedRestart', { name: value })}${added.restartReason
        ? ` ${t('instanceRestartReason', { reason: added.restartReason })}` : ''}` })
    } catch (failure) {
      setNote({ error: true, text: addFailureText(t, failure, value) })
      // The host's refusal may mean the list or the ability to add changed since it was read.
      if (failure instanceof AddInstanceFailure && (failure.code === 'exists' || failure.code === 'unavailable')) void reload()
    } finally { running.current = false; setBusy(false) }
  }
  const footer = adding.available ? <>
    <Button variant="outline" disabled={busy} onClick={close}>{t('cancel')}</Button>
    <Button variant="primary" icon={<Icon name="plus" size={14} />} disabled={!valid || busy}
      onClick={() => { void add() }}>{busy ? t('instanceAdding') : t('instanceAdd')}</Button>
  </> : <Button variant="primary" onClick={close}>{t('close')}</Button>
  return <Modal open onClose={close} title={t('instanceAdd')} closeLabel={t('close')} className="dt-add-instance-modal" footer={footer}
    description={adding.available ? t('instanceAddIntro') : t(`instanceAddOff.${adding.reason}`)}>
    {(adding.available || note) && <div ref={body} className="dt-add-instance">
      {adding.available && <>
        <Field label={t('instanceKey')} note={problem === 'taken' ? <span className="dt-error">{t('instanceKeyTaken', { key: value })}</span>
          : <span className={problem ? 'dt-error' : undefined}>{t('instanceKeyRule')}</span>}>
          <Input value={key} placeholder="tools" autoComplete="off" autoCapitalize="none" spellCheck={false} aria-invalid={!!problem}
            onChange={event => { setKey(event.target.value); setNote(undefined) }}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void add() } }} />
        </Field>
        {valid && <KeyValues rows={[[t('instancePrefix'), <span className="dt-mono">{managementPrefix(value)}</span>],
          [t('deploymentStateDir'), <span className="dt-mono">{`${adding.stateDirBase}-${value}`}</span>]]} />}
        {instances.length === 1 && <p className="dt-banner">{t('instanceAddShared')}</p>}
      </>}
      {note && <p className={note.error ? 'dt-error' : 'dt-hint'} role={note.error ? 'alert' : 'status'}>{note.text}</p>}
    </div>}
  </Modal>
}
