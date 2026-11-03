// @vitest-environment jsdom
// The Deployment settings and the Plugin Manager page.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { PluginConfig } from '../src/client/deployment.tsx'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ko, zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, find, tab, click, type, text, field, at, translator } from './fixtures/panel.tsx'
import { server, problemOf, fakeForm, instanceView as instance } from './fixtures/panel-server.ts'

usePanel()
it('saves this machine\'s settings in the Deployment settings through DSH\'s configuration form, without a restart', async () => {
  const { form: editable, mutations } = fakeForm()
  server.form = editable
  await mount()
  await click(tab(zh['tab.settings']))
  await click(find(zh['settingsGroup.deployment'], '.dt-settings-link'))
  expect(text()).toContain('/srv/dsh-superagent')
  // Accounts are on the Source settings; the Plugin Manager page, where those are not at hand, shows them here.
  expect(text()).not.toContain('@agent-bot')
  for (const moved of ['仓库克隆', '工单 worktree 目录', '禁用的命令']) expect(text()).not.toContain(moved)
  expect(text()).toContain(zh.deploymentIntro)
  // A limit applies at once, so a draft of one says only that it is unsaved, even while Assignments run.
  await type(field<HTMLInputElement>(zh.deploymentContextTimeout), '20000')
  expect(document.querySelector('.dt-savebar')?.textContent).toBe(`${zh.draftKept}${zh.discard}${zh.save}`)
  await click(zh.save)
  expect(mutations).toEqual([{ revision: 1, ops: [{ op: 'set', path: ['admissionContextTimeoutMs'], value: 20000 }] }])
  expect(document.querySelector('.dt-toast')?.textContent).toBe(zh.saved)
  expect(text()).not.toContain(zh.savedRestarting)
  expect(field<HTMLInputElement>(zh.deploymentContextTimeout).value).toBe('20000')
})

it('keeps a refused Deployment change as a draft, and shows the settings read-only without a writable form', async () => {
  const refusing = fakeForm(true, false)
  server.form = refusing.form
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await type(field<HTMLInputElement>(zh.deploymentPromptMaxChars), '200000')
  await click(zh.save)
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(zh.deploymentRefused)
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).value).toBe('200000')
  server.form = fakeForm(false).form
  await remount()
  expect(text()).toContain(zh.deploymentReadOnly)
  server.form = undefined
  await remount()
  expect(text()).toContain('这个 DSH 版本不提供配置表单')
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars)).toMatchObject({ disabled: true, value: '100000' })
  expect(all('button').some(button => button.textContent === '保存')).toBe(false)
})

it('merges a Deployment draft into the values another page saved meanwhile, and writes only what it changed', async () => {
  const { form: shared, mutations } = fakeForm()
  server.form = shared
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await type(field<HTMLInputElement>(zh.deploymentContextPages), '20')
  // The Plugin Manager page saves another field of the same entry meanwhile.
  await act(async () => { await shared.mutate([{ op: 'set', path: ['promptMaxChars'], value: 50000 }], 1) })
  expect(text()).toContain('设置已在别处修改，你的修改已合并到最新版本')
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).value).toBe('50000')
  await click(zh.save)
  expect(mutations.at(-1)).toEqual({ revision: 2, ops: [{ op: 'set', path: ['admissionContextMaxPages'], value: 20 }] })
  expect(shared.getSnapshot().value).toMatchObject({ admissionContextMaxPages: 20, promptMaxChars: 50000 })
})

it('renders the Deployment page with the derived accounts in the Plugin Manager, and no summary', async () => {
  let container = document.createElement('div')
  let root = createRoot(container)
  onTestFinished(() => { act(() => { root.unmount() }); container.remove() })
  // Remount from scratch on each render to match Plugin Manager page navigation.
  const render = async (view: 'page' | 'summary') => {
    act(() => { root.unmount() }); container.remove()
    container = document.createElement('div'); document.body.append(container)
    root = createRoot(container)
    const form = server.form
    await act(async () => { root.render(<PluginConfig t={translator(zh)} view={view} form={form && { state: form.getSnapshot(),
      mutate: form.mutate }} />) })
    await settle()
  }
  await render('summary')
  expect(container.textContent).toBe('')
  server.form = fakeForm().form
  await render('page')
  for (const fact of ['acme/widgets', '@agent-bot', 'Widgets Bot', '账号在 dsh-superagent 面板的来源设置里修改。']) expect(text()).toContain(fact)
  server.setup = { ...server.setup, problem: problemOf('repositoryUnset'), accounts: null }
  await render('page')
  expect(text()).toContain('部署检查未通过：GitHub 来源没有设置监听的仓库。')
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).disabled).toBe(false)
  server.down = true
  await render('page')
  expect(text()).toContain(zh.hostNotRunning)
})

it('tells a dsh-superagent that is starting from a browser that cannot write on the Deployment page', async () => {
  const { form: shared, publish } = fakeForm()
  server.form = shared
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  const limit = () => field<HTMLInputElement>(zh.deploymentPromptMaxChars)
  expect(limit().disabled).toBe(false)
  // While dsh-superagent restarts, DSH stops serving its entry; the values come back editable once it is served again.
  await act(async () => { publish({ status: 'unavailable' }) })
  expect(text()).toContain(zh.deploymentUnavailable)
  expect(limit().disabled).toBe(true)
  await act(async () => { publish({ status: 'ready' }) })
  expect(limit().disabled).toBe(false)
  await act(async () => { publish({ mode: 'memory', status: 'unavailable', writable: false }) })
  expect(text()).toContain(zh.deploymentReadOnly)
})

it('reads the state every second after a setup check, until dsh-superagent stopped answering and answers again', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset'), accounts: null }
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await click(zh.setupCheck)
  const second = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(1000) }); await settle() }
  server.down = true
  await second()
  expect(text()).toContain(zh['setup.agentCliUnset'])
  server.down = false
  server.setup = { ...server.setup, problem: null }
  await second()
  expect(text()).not.toContain(zh['setup.agentCliUnset'])
  // Once it answers, the state is read every five seconds again.
  const reads = server.requests.filter(request => request.path === 'state').length
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) }); await settle()
  expect(server.requests.filter(request => request.path === 'state')).toHaveLength(reads)
})

it('ends a restart that never stopped answering after half a minute, and reads the state every five seconds again', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset'), accounts: null }
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await click(zh.setupCheck)
  const reads = () => server.requests.filter(request => request.path === 'state').length
  const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }); await settle() }
  const before = reads()
  await advance(10_000)
  expect(reads() - before).toBeGreaterThanOrEqual(8)
  // The restart ends at 30 s; the state is read at once, then every five seconds.
  await advance(21_000)
  const ended = reads()
  await advance(3_000)
  expect(reads()).toBe(ended)
  await advance(2_000)
  expect(reads()).toBe(ended + 1)
})

const ADDING = { available: true, stateDirBase: '/srv/dsh-superagent' } as const
const deployment = () => at({ page: 'settings', query: { group: 'deployment' } })
const rows = () => all('.dt-instances li').map(row => row.textContent)
const key = () => field<HTMLInputElement>(zh.instanceKey)
const addButton = () => find(zh.instanceAdd) as HTMLButtonElement
const prefixes = () => [...new Set(server.requests.map(request => request.prefix ?? '/orchestrator'))]

it('lists the instances in the Deployment settings, and previews and validates a new key as it is typed', async () => {
  server.form = fakeForm().form
  server.instances = { instances: [instance('', 'acme/widgets'), instance('tools')], adding: ADDING }
  deployment()
  await mount()
  expect(rows()).toEqual(['默认acme/widgets/orchestrator', 'tools尚未设置仓库/orchestrator-tools'])
  expect(addButton().disabled).toBe(true)
  expect(text()).toContain(zh.instanceAddIntro)
  // More than one instance already run, so the warning about commands outside the Sessions is for the first addition only.
  expect(text()).not.toContain(zh.instanceAddShared)
  expect(text()).not.toContain(zh.instanceKeyTaken.replace('{key}', ''))
  for (const invalid of ['Tools', 'a_b', '-a', 'a--b', 'a'.repeat(33)]) {
    await type(key(), invalid)
    expect(document.querySelector('.dt-field small .dt-error')?.textContent).toBe(zh.instanceKeyRule)
    expect(key().getAttribute('aria-invalid')).toBe('true')
    expect(addButton().disabled).toBe(true)
  }
  await type(key(), 'tools')
  expect(document.querySelector('.dt-field small .dt-error')?.textContent).toBe(zh.instanceKeyTaken.replace('{key}', 'tools'))
  expect(addButton().disabled).toBe(true)
  expect(text()).not.toContain('/orchestrator-tools/')
  await type(key(), ' b-2 ')
  expect(document.querySelector('.dt-field small .dt-error')).toBeNull()
  expect(key().getAttribute('aria-invalid')).toBe('false')
  // The preview names the management prefix and the state directory the new instance would get.
  expect(all('.dt-kv dd').map(item => item.textContent)).toContain('/orchestrator-b-2')
  expect(all('.dt-kv dd').map(item => item.textContent)).toContain('/srv/dsh-superagent-b-2')
  expect(addButton().disabled).toBe(false)
  expect(server.additions).toEqual([])
})

it('warns a single instance that commands outside any Session lose the agent\'s credentials once a second runs', async () => {
  server.form = fakeForm().form
  server.instances = { instances: [instance('', 'acme/widgets')], adding: ADDING }
  deployment()
  await mount()
  expect(rows()).toEqual(['默认acme/widgets/orchestrator'])
  expect(document.querySelector('.dt-banner')?.textContent).toBe(zh.instanceAddShared)
  expect(document.querySelector('.dt-instance-select')).toBeNull()
})

it('adds an instance and switches the panel to it, which then calls the new management prefix', async () => {
  const { form: shared, mutations } = fakeForm()
  server.form = shared
  server.instances = { instances: [instance('', 'acme/widgets')], adding: ADDING }
  deployment()
  await mount()
  await type(key(), 'tools')
  // Enter adds the instance instead of saving the limits form the section sits in.
  await act(async () => { key().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
  await settle()
  expect(server.additions).toEqual([{ instance: 'tools' }])
  expect(mutations).toEqual([])
  const selector = document.querySelector<HTMLSelectElement>(`select[aria-label="${zh.instanceLabel}"]`)!
  expect(selector.value).toBe('tools')
  expect([...selector.options].map(option => option.textContent)).toEqual(['acme/widgets', 'tools', zh.instanceAddOption])
  expect(localStorage.getItem('dsh-superagent/instance')).toBe('tools')
  expect(document.querySelector('.dt-toast')?.textContent).toBe(zh.instanceAdded.replace('{name}', 'tools'))
  // The new instance opens at its Overview, and its own calls go to its own prefix.
  expect(all('[role="tab"][aria-selected="true"]').map(item => item.textContent)).toEqual([zh['tab.overview']])
  expect(prefixes()).toContain('/orchestrator-tools')
  expect(server.requests.filter(request => request.prefix === '/orchestrator-tools').map(request => request.path)).toContain('state')
  // Its Deployment settings list both, and no longer warn.
  await click(tab(zh['tab.settings']))
  await click(find(zh['settingsGroup.deployment'], '.dt-settings-link'))
  expect(rows()).toEqual(['默认acme/widgets/orchestrator', 'tools尚未设置仓库/orchestrator-tools'])
  expect(document.querySelector('.dt-banner')).toBeNull()
})

it('says an addition that waits for a Harness restart is not running yet, and stays on the instance shown', async () => {
  server.form = fakeForm().form
  server.instances = { instances: [instance('', 'acme/widgets')], adding: ADDING }
  server.addAnswer = { status: 202, body: { applied: false, instance: instance('tools'), stateDir: '/srv/dsh-superagent-tools',
    restartReason: 'The profile cannot be reloaded' } }
  deployment()
  await mount()
  await type(key(), 'tools')
  await click(zh.instanceAdd)
  expect(document.querySelector('[role="status"].dt-hint')?.textContent).toBe(`${zh.instanceAddedRestart.replace('{name}', 'tools')} ${
    zh.instanceRestartReason.replace('{reason}', 'The profile cannot be reloaded')}`)
  expect(key().value).toBe('')
  expect(document.querySelector('.dt-instance-select')).toBeNull()
  expect(localStorage.getItem('dsh-superagent/instance')).toBeNull()
  expect(prefixes()).toEqual(['/orchestrator'])
  // Typing again clears the message.
  await type(key(), 'b')
  expect(document.querySelector('[role="status"].dt-hint')).toBeNull()
})

it('answers each refusal of the host in words, and the host\'s own text for a failure', async () => {
  server.form = fakeForm().form
  server.instances = { instances: [instance('', 'acme/widgets')], adding: ADDING }
  deployment()
  await mount()
  const refuse = async (status: number, body: unknown) => {
    server.addAnswer = { status, body }
    await type(key(), 'tools')
    await click(zh.instanceAdd)
    return document.querySelector('p[role="alert"].dt-error')?.textContent
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
  // Nothing was added or switched to by any of them.
  expect(localStorage.getItem('dsh-superagent/instance')).toBeNull()
  expect(key().value).toBe('tools')
})

it('says in words why an instance cannot be added, instead of the form', async () => {
  server.form = fakeForm().form
  deployment()
  for (const reason of ['no-profile', 'no-reload', 'no-default'] as const) {
    server.instances = { instances: [instance('', 'acme/widgets')], adding: { available: false, reason } }
    await remount()
    expect(text()).toContain(zh[`instanceAddOff.${reason}`])
    expect(all('input').some(input => input.id && all('label').some(label => (label as HTMLLabelElement).htmlFor === input.id
      && label.textContent === zh.instanceKey))).toBe(false)
    expect(all('button').some(button => button.textContent === zh.instanceAdd)).toBe(false)
  }
})

it('shows no way to add an instance without a statement from the host, and no section for a lone instance', async () => {
  server.form = fakeForm().form
  deployment()
  server.instances = { instances: [instance('', 'acme/widgets')] }
  await mount()
  expect(document.querySelector('.dt-instances')).toBeNull()
  // Several instances are still listed, without a form.
  server.instances = { instances: [instance('', 'acme/widgets'), instance('tools', 'acme/tools')] }
  await remount()
  expect(rows()).toEqual(['默认acme/widgets/orchestrator', 'toolsacme/tools/orchestrator-tools'])
  expect(() => key()).toThrow()
  // A host without the list shows none of it.
  server.instances = undefined
  await remount()
  expect(document.querySelector('.dt-instances')).toBeNull()
})

it('reads the instance section in Korean', async () => {
  server.form = fakeForm().form
  server.instances = { instances: [instance('', 'acme/widgets')], adding: ADDING }
  deployment()
  await mount(ko)
  for (const label of [ko.instances, ko.instanceAddIntro, ko.instanceAddShared, ko.instanceKeyRule]) expect(text()).toContain(label)
  expect(find(ko.instanceAdd).tagName).toBe('BUTTON')
  expect(rows()).toEqual([`${ko.instanceDefaultKey}acme/widgets/orchestrator`])
})

it('adds an instance from the Plugin Manager page without switching, and only confirms', async () => {
  server.form = fakeForm().form
  server.instances = { instances: [instance('', 'acme/widgets')], adding: ADDING }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  onTestFinished(() => { act(() => { root.unmount() }); container.remove() })
  const form = server.form
  await act(async () => { root.render(<PluginConfig t={translator(zh)} view="page" form={{ state: form.getSnapshot(), mutate: form.mutate }} />) })
  await settle()
  expect(rows()).toEqual(['默认acme/widgets/orchestrator'])
  await type(key(), 'tools')
  await click(zh.instanceAdd)
  expect(server.additions).toEqual([{ instance: 'tools' }])
  expect(document.querySelector('.dt-toast')?.textContent).toBe(zh.instanceAddedElsewhere.replace('{name}', 'tools'))
  expect(localStorage.getItem('dsh-superagent/instance')).toBeNull()
  expect(prefixes()).toEqual(['/orchestrator'])
  // The list was read again and now has the new instance, which the form refuses to add twice.
  expect(rows()).toEqual(['默认acme/widgets/orchestrator', 'tools尚未设置仓库/orchestrator-tools'])
  await type(key(), 'tools')
  expect(addButton().disabled).toBe(true)
})
