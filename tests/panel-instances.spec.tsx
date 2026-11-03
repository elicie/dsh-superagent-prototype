// @vitest-environment jsdom
// Adding an instance from the header's instance selector: the dialog, its checks, the host's answers, and the switch to the new one.
import { act } from 'react'
import { expect, it } from 'vitest'
import { ko, zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, at, click, find, type, text, field } from './fixtures/panel.tsx'
import { server, fakeForm, instanceView as instance } from './fixtures/panel-server.ts'

usePanel()
const ADDING = { available: true, stateDirBase: '/srv/dsh-superagent' } as const
const selector = (label = zh.instanceLabel) => document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)
const options = () => [...selector()!.options].map(option => option.textContent)
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"].dt-add-instance-modal')
const open = async (label = zh.instanceLabel) => { await type(selector(label)!, '+') }
const key = () => field<HTMLInputElement>(zh.instanceKey)
const addButton = () => find(zh.instanceAdd, '[role="dialog"] button') as HTMLButtonElement
const prefixes = () => [...new Set(server.requests.map(request => request.prefix ?? '/orchestrator'))]
const enter = async () => {
  await act(async () => { key().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
}

it('opens the dialog from the selector of a single instance, without leaving the page or selecting another', async () => {
  server.instances = { instances: [instance('', 'acme/widgets')], adding: ADDING }
  at({ page: 'execution' })
  await mount()
  // A lone instance gets the selector because the host can add another; the Deployment settings have no part in it.
  expect(options()).toEqual(['acme/widgets', zh.instanceAddOption])
  await open()
  expect(dialog()?.getAttribute('aria-label')).toBe(zh.instanceAdd)
  expect(selector()!.value).toBe('')
  expect(all('[role="tab"][aria-selected="true"]').map(item => item.textContent)).toEqual([zh['tab.execution']])
  expect(dialog()!.textContent).toContain(zh.instanceAddIntro)
  // Only one instance runs, so it warns that commands outside any Session lose the agent's credentials once a second does.
  expect(dialog()!.querySelector('.dt-banner')?.textContent).toBe(zh.instanceAddShared)
  expect(document.activeElement).toBe(key())
  // Cancel closes it untouched; reopening starts empty.
  await type(key(), 'tools')
  await click(find(zh.cancel, '[role="dialog"] button'))
  expect(dialog()).toBeNull()
  expect(server.additions).toEqual([])
  await open()
  expect(key().value).toBe('')
})

it('previews and validates a new key as it is typed', async () => {
  server.instances = { instances: [instance('', 'acme/widgets'), instance('tools')], adding: ADDING }
  await mount()
  await open()
  expect(addButton().disabled).toBe(true)
  // More than one instance already runs, so the warning is for the first addition only.
  expect(dialog()!.querySelector('.dt-banner')).toBeNull()
  for (const invalid of ['Tools', 'a_b', '-a', 'a--b', 'a'.repeat(33)]) {
    await type(key(), invalid)
    expect(dialog()!.querySelector('.dt-field small .dt-error')?.textContent).toBe(zh.instanceKeyRule)
    expect(key().getAttribute('aria-invalid')).toBe('true')
    expect(addButton().disabled).toBe(true)
  }
  await type(key(), 'tools')
  expect(dialog()!.querySelector('.dt-field small .dt-error')?.textContent).toBe(zh.instanceKeyTaken.replace('{key}', 'tools'))
  expect(addButton().disabled).toBe(true)
  await type(key(), ' b-2 ')
  expect(dialog()!.querySelector('.dt-field small .dt-error')).toBeNull()
  expect(key().getAttribute('aria-invalid')).toBe('false')
  // The preview names the management prefix and the state directory the new instance would get.
  const preview = all('[role="dialog"] .dt-kv dd').map(item => item.textContent)
  expect(preview).toEqual(['/orchestrator-b-2', '/srv/dsh-superagent-b-2'])
  expect(addButton().disabled).toBe(false)
  expect(server.additions).toEqual([])
})

it('adds an instance and switches the panel to it, which then calls the new management prefix', async () => {
  const { form: shared, mutations } = fakeForm()
  server.form = shared
  server.instances = { instances: [instance('', 'acme/widgets')], adding: ADDING }
  await mount()
  await open()
  await type(key(), 'tools')
  await enter()
  await settle()
  expect(server.additions).toEqual([{ instance: 'tools' }])
  expect(mutations).toEqual([])
  expect(dialog()).toBeNull()
  expect(selector()!.value).toBe('tools')
  expect(options()).toEqual(['acme/widgets', 'tools', zh.instanceAddOption])
  expect(localStorage.getItem('dsh-superagent/instance')).toBe('tools')
  expect(document.querySelector('.dt-toast')?.textContent).toBe(zh.instanceAdded.replace('{name}', 'tools'))
  // The new instance opens at its Overview, and its own calls go to its own prefix.
  expect(all('[role="tab"][aria-selected="true"]').map(item => item.textContent)).toEqual([zh['tab.overview']])
  expect(server.requests.filter(request => request.prefix === '/orchestrator-tools').map(request => request.path)).toContain('state')
  // The selector now refuses the same key a second time.
  await open()
  await type(key(), 'tools')
  expect(addButton().disabled).toBe(true)
  expect(dialog()!.querySelector('.dt-banner')).toBeNull()
})

it('says in the dialog that an addition waiting for a Harness restart is not running yet, and stays on the instance shown', async () => {
  server.instances = { instances: [instance('', 'acme/widgets')], adding: ADDING }
  server.addAnswer = { status: 202, body: { applied: false, instance: instance('tools'), stateDir: '/srv/dsh-superagent-tools',
    restartReason: 'The profile cannot be reloaded' } }
  await mount()
  await open()
  await type(key(), 'tools')
  await click(addButton())
  expect(dialog()!.querySelector('[role="status"].dt-hint')?.textContent).toBe(`${zh.instanceAddedRestart.replace('{name}', 'tools')} ${
    zh.instanceRestartReason.replace('{reason}', 'The profile cannot be reloaded')}`)
  expect(key().value).toBe('')
  expect(selector()!.value).toBe('')
  expect(localStorage.getItem('dsh-superagent/instance')).toBeNull()
  expect(prefixes()).toEqual(['/orchestrator'])
  // Typing again clears the message.
  await type(key(), 'b')
  expect(dialog()!.querySelector('[role="status"].dt-hint')).toBeNull()
})

it('answers each refusal of the host in words, and the host\'s own text for a failure', async () => {
  server.instances = { instances: [instance('', 'acme/widgets')], adding: ADDING }
  await mount()
  await open()
  const refuse = async (status: number, body: unknown) => {
    server.addAnswer = { status, body }
    await type(key(), 'tools')
    await click(addButton())
    return dialog()!.querySelector('p[role="alert"].dt-error')?.textContent
  }
  expect(await refuse(400, { error: 'x', code: 'invalid' })).toBe(zh['instanceError.invalid'].replace('{key}', 'tools'))
  expect(await refuse(409, { error: 'x', code: 'exists' })).toBe(zh['instanceError.exists'].replace('{key}', 'tools'))
  const listings = server.listings
  expect(await refuse(409, { error: 'x', code: 'unavailable' })).toBe(zh['instanceError.unavailable'])
  // A refusal that the list or the ability to add changed reads the list again.
  expect(server.listings).toBeGreaterThan(listings)
  expect(await refuse(500, { error: 'DSH refused the profile: bad plugin', code: 'failed' })).toBe(zh['instanceError.failed']
    .replace('{error}', 'DSH refused the profile: bad plugin'))
  expect(await refuse(503, {})).toBe(zh.serverError.replace('{status}', '503'))
  expect(await refuse(404, {})).toBe(zh.hostNotRunning)
  // Nothing was added or switched to by any of them, and the dialog stays open on the key.
  expect(localStorage.getItem('dsh-superagent/instance')).toBeNull()
  expect(key().value).toBe('tools')
})

it('says in words why an instance cannot be added, instead of the form', async () => {
  for (const reason of ['no-profile', 'no-reload', 'no-default'] as const) {
    server.instances = { instances: [instance('', 'acme/widgets'), instance('tools', 'acme/tools')], adding: { available: false, reason } }
    await remount()
    await open()
    expect(dialog()!.textContent).toContain(zh[`instanceAddOff.${reason}`])
    expect(() => key()).toThrow()
    expect(all('[role="dialog"] button').some(button => button.textContent === zh.instanceAdd)).toBe(false)
    await click(find(zh.close, '[role="dialog"] .dt-modal-footer button'))
    expect(dialog()).toBeNull()
  }
  // A lone instance that cannot get a second shows no selector at all.
  server.instances = { instances: [instance('', 'acme/widgets')], adding: { available: false, reason: 'no-profile' } }
  await remount()
  expect(selector()).toBeNull()
})

it('keeps the Deployment settings to the instance shown', async () => {
  server.form = fakeForm().form
  server.instances = { instances: [instance('', 'acme/widgets'), instance('tools')], adding: ADDING }
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  expect(text()).toContain(zh.deploymentMachine)
  expect(text()).not.toContain(zh.instanceKey)
  expect(text()).not.toContain('/orchestrator-tools')
})

it('reads the dialog in Korean', async () => {
  server.instances = { instances: [instance('', 'acme/widgets')], adding: ADDING }
  await mount(ko)
  expect([...selector(ko.instanceLabel)!.options].map(option => option.textContent)).toEqual(['acme/widgets', ko.instanceAddOption])
  await open(ko.instanceLabel)
  expect(dialog()?.getAttribute('aria-label')).toBe(ko.instanceAdd)
  for (const label of [ko.instanceAddIntro, ko.instanceAddShared, ko.instanceKeyRule, ko.cancel]) expect(dialog()!.textContent).toContain(label)
  expect(find(ko.instanceAdd, '[role="dialog"] button').tagName).toBe('BUTTON')
})
