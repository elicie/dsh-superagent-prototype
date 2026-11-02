// @vitest-environment jsdom
// Panel search, glossary, route persistence, host-down fallback, and the instance selector.
import { act } from 'react'
import { expect, it, onTestFinished, vi } from 'vitest'
import { managementPrefix, type InstanceView } from '../src/instance.ts'
import { en, ko, zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, at, click, type, tab, text, field } from './fixtures/panel.tsx'
import { server, found, fakeForm, MACHINE } from './fixtures/panel-server.ts'

usePanel()
it('states why a filtered search result has no Thread instead of opening an empty one', async () => {
  server.search = { items: [found('e9', '2026-09-20T00:00:00Z', { source: 'github', actor: { source: 'github', id: 'someone' },
    preview: 'issue text', threads: ['github:7'],
    filtered: 'source_disabled' })], threads: [] }
  await mount()
  await type(field<HTMLInputElement>(zh.searchLabel), 'issue')
  await act(async () => { field<HTMLInputElement>(zh.searchLabel).closest('form')!.requestSubmit() }); await settle()
  expect(text()).toContain('被来源过滤：来源已停用')
  expect(all('.dt-search-results button').some(button => button.textContent === 'issue text')).toBe(false)
})

it('opens a search result older than the newest page around its Trigger', async () => {
  server.search = { items: [found('e1', '2026-09-20T00:00:00Z')], threads: [] }
  await mount()
  await type(field<HTMLInputElement>(zh.searchLabel), 'message')
  await act(async () => { field<HTMLInputElement>(zh.searchLabel).closest('form')!.requestSubmit() }); await settle()
  expect(text()).toContain('找到 0 个工单、0 个线程、1 条触发')
  await click(all('.dt-search-results button').find(button => button.textContent === 'message e1')!)
  expect(server.requests.some(request => request.path.includes('around=e1'))).toBe(true)
  expect(document.querySelector('.dt-highlight')?.textContent).toContain('message e1')
})

it('explains what can be searched when nothing matches', async () => {
  await mount()
  await type(field<HTMLInputElement>(zh.searchLabel), 'nothing')
  await act(async () => { field<HTMLInputElement>(zh.searchLabel).closest('form')!.requestSubmit() }); await settle()
  expect(text()).toContain('没有找到。可以输入触发文字')
})

it('returns to the exact page after a remount of the main panel', async () => {
  await mount()
  await click('修复回归')
  await remount()
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('修复回归')
})

it('shows domain terms in the interface language only and lists both languages in the (?) glossary', async () => {
  await mount(en)
  expect(all('[role="tab"]').map(tab => tab.textContent)).toEqual(['Overview', 'Source', 'Trigger', 'Eval', 'Execution', 'Settings'])
  await click('Glossary')
  const dialog = document.querySelector('[role="dialog"]')!
  const row = [...dialog.querySelectorAll('tr')].find(item => item.textContent?.startsWith('Ticket'))!
  expect([...row.querySelectorAll('td')].map(cell => cell.textContent)).toEqual(['Ticket', '工单', 'An authorized unit of work'])
  expect(dialog.textContent).toContain('Accept 接单')
  // Terms are grouped the way the tabs follow the flow, after the roles that act in it.
  expect([...dialog.querySelectorAll('th.dt-glossary-group')].map(cell => cell.textContent)).toEqual(['Roles', 'Source', 'Trigger', 'Eval',
    'Execution'])
  expect([...dialog.querySelectorAll('tr')].find(item => item.textContent?.startsWith('Main Session'))!.textContent).toContain('prompts call it the orchestrator')
})

it('says dsh-superagent is not answering when its routes are gone, as while it restarts', async () => {
  server.down = true
  await mount()
  expect(text()).toContain(zh.hostNotRunning)
  expect(text()).not.toContain('404')
})

it('closes search results on Escape and on a click outside the search', async () => {
  await mount()
  const search = field<HTMLInputElement>(zh.searchLabel)
  const submit = async () => { await type(search,
    'nothing'); await act(async () => { search.closest('form')!.requestSubmit() }); await settle() }
  await submit()
  expect(document.querySelector('.dt-search-results')).not.toBeNull()
  await act(async () => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(document.querySelector('.dt-search-results')).toBeNull()
  await submit()
  await act(async () => { document.querySelector('main')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
  expect(document.querySelector('.dt-search-results')).toBeNull()
})

it('shows the answer to the latest search only', async () => {
  server.search = { items: [found('e1', '2026-09-20T00:00:00Z', { preview: 'old message' }), found('e2', '2026-09-21T00:00:00Z',
    { preview: 'new message' })], threads: [] }
  let release = () => {}
  server.searching = async query => { if (query === 'old') await new Promise<void>(resolve => { release = resolve }) }
  await mount()
  const search = field<HTMLInputElement>(zh.searchLabel)
  for (const query of ['old', 'new']) { await type(search,
    query); await act(async () => { search.closest('form')!.requestSubmit() }); await settle() }
  expect(all('.dt-search-results .dt-row-title').map(title => title.textContent)).toEqual(['new message'])
  await act(async () => { release() }); await settle()
  expect(all('.dt-search-results .dt-row-title').map(title => title.textContent)).toEqual(['new message'])
})

const instance = (key: string, repository?: string): InstanceView => ({ instance: key, prefix: managementPrefix(key),
  entry: key ? `superagent-${key}-core` : 'dsh-superagent', ...repository ? { repository } : {} })
const selector = (label = zh.instanceLabel) => document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)
const options = () => [...selector()!.options].map(option => option.textContent)
const prefixes = () => [...new Set(server.requests.map(request => request.prefix ?? managementPrefix()))]
const page = () => all('[role="tab"][aria-selected="true"]').map(item => item.textContent)
const poll = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(15_000) }); await settle() }

it('shows no instance selector and calls the default instance with one instance or without an instance list', async () => {
  // A host without the instances route answers 404: the panel is the default instance's, as before instances.
  await mount()
  expect(server.listings).toBe(1)
  expect(selector()).toBeNull()
  expect(document.querySelector('.dt-head-title')?.children).toHaveLength(1)
  expect(prefixes()).toEqual(['/orchestrator'])
  const before = server.requests.map(request => request.path).sort()
  server.instances = { instances: [instance('', 'acme/widgets')] }
  server.requests = []
  await remount()
  expect(selector()).toBeNull()
  expect(server.requests.map(request => request.path).sort()).toEqual(before)
  // An instance remembered from another host, where the list does not answer, still opens the default instance and is kept.
  localStorage.setItem('dsh-superagent/instance', 'tools')
  server.instances = undefined
  server.requests = []
  await remount()
  expect(selector()).toBeNull()
  expect(prefixes()).toEqual(['/orchestrator'])
  expect(localStorage.getItem('dsh-superagent/instance')).toBe('tools')
})

it('switches the whole panel to another instance at that instance\'s own route, and remembers the selection', async () => {
  server.instances = { instances: [instance('', 'acme/widgets'), instance('tools', 'acme/tools'), instance('spare')] }
  at({ page: 'execution' })
  at({ page: 'eval' }, 'tools')
  await mount()
  expect(options()).toEqual(['acme/widgets', 'acme/tools · tools', 'spare'])
  expect(selector()!.value).toBe('')
  expect(page()).toEqual([zh['tab.execution']])
  server.requests = []
  await type(selector()!, 'tools')
  expect(prefixes()).toEqual(['/orchestrator-tools'])
  expect(page()).toEqual([zh['tab.eval']])
  expect(localStorage.getItem('dsh-superagent/instance')).toBe('tools')
  await click(tab(zh['tab.source']))
  await remount()
  expect(selector()!.value).toBe('tools')
  expect(page()).toEqual([zh['tab.source']])
  // The default instance kept its own route.
  await type(selector()!, '')
  expect(page()).toEqual([zh['tab.execution']])
  expect(localStorage.getItem('dsh-superagent/instance')).toBeNull()
  expect(JSON.parse(sessionStorage.getItem('dsh-superagent/route/tools')!)).toMatchObject({ route: { page: 'source' } })
  await remount(ko)
  expect(selector(ko.instanceLabel)!.options[2]!.textContent).toBe('spare')
  server.instances = { instances: [instance(''), instance('tools')] }
  await remount(ko)
  expect([...selector(ko.instanceLabel)!.options].map(option => option.textContent)).toEqual([ko.instanceDefault, 'tools'])
})

it('keeps a selected instance missing from the list selected, marked unavailable, with its own Deployment form', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  server.form = fakeForm().form
  const tools = fakeForm()
  tools.publish({ value: { ...MACHINE, promptMaxChars: 7777 } })
  server.forms['superagent-tools-core'] = tools.form
  server.instances = { instances: [instance('', 'acme/widgets'), instance('tools', 'acme/tools')] }
  at({ page: 'settings', query: { group: 'deployment' } })
  at({ page: 'settings', query: { group: 'deployment' } }, 'tools')
  await mount()
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).value).toBe('100000')
  await type(selector()!, 'tools')
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).value).toBe('7777')
  // Saving settings restarts the instance, which leaves the list meanwhile: the panel stays on it and on its form.
  server.instances = { instances: [instance('', 'acme/widgets')] }
  await poll()
  expect(selector()!.value).toBe('tools')
  expect(options()).toEqual(['acme/widgets', zh.instanceUnavailable.replace('{name}', 'acme/tools · tools')])
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).value).toBe('7777')
  server.instances = { instances: [instance('', 'acme/widgets'), instance('tools', 'acme/tools')] }
  await poll()
  expect(options()).toEqual(['acme/widgets', 'acme/tools · tools'])
  await type(selector()!, '')
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).value).toBe('100000')
})

it('keeps a selected instance that was never listed, says it is not answering, and offers the listed ones', async () => {
  localStorage.setItem('dsh-superagent/instance', 'gone')
  server.instances = { instances: [instance('', 'acme/widgets')] }
  await mount()
  expect(selector()!.value).toBe('gone')
  expect(options()).toEqual(['acme/widgets', zh.instanceUnavailable.replace('{name}', 'gone')])
  expect(text()).toContain(zh.hostNotRunning)
  expect(server.requests).toEqual([])
  await type(selector()!, '')
  expect(selector()).toBeNull()
  expect(prefixes()).toEqual(['/orchestrator'])
})
