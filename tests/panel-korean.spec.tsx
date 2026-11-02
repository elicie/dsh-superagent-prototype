// @vitest-environment jsdom
import { act } from 'react'
import { expect, it } from 'vitest'
import { en, ko, zh } from '../src/client/locales.ts'
import { all, at, click, field, find, mount, remount, settle, tab, text, type, usePanel } from './fixtures/panel.tsx'
import { found, server } from './fixtures/panel-server.ts'

usePanel()

it('shows Korean navigation and a Korean/English glossary while preserving other interface languages', async () => {
  await mount(ko)
  expect(all('.dt-tabs [role="tab"]').map(item => item.textContent)).toEqual(['개요', '소스', '트리거', '평가', '실행', '설정'])
  await click(ko.glossary)
  const dialog = document.querySelector('[role="dialog"]')!
  expect([...dialog.querySelectorAll('thead th')].map(item => item.textContent)).toEqual(['한국어', 'English', '의미'])
  const ticket = [...dialog.querySelectorAll('tr')].find(item => item.firstElementChild?.textContent === '작업')!
  expect([...ticket.querySelectorAll('td')].map(item => item.textContent)).toEqual(['작업', 'Ticket', '권한을 부여받은 작업 단위'])
  expect(dialog.textContent).toContain('수락 Accept')
  await click(find(ko.close, '[role="dialog"] button'))
  for (const dictionary of [en, zh]) {
    await remount(dictionary)
    expect(tab(dictionary['tab.overview']).textContent).toBe(dictionary['tab.overview'])
  }
})

it('saves Korean settings and keeps pause state consistent across Execution, Eval and Overview', async () => {
  await mount(ko)
  await click(tab(ko['tab.execution']))
  await click(find(ko['tab.settings'], '.dt-status-head button'))
  await type(field<HTMLInputElement>(ko.maxWorkers), '4')
  await click(tab(ko['tab.trigger']))
  await click(tab(ko['tab.settings']))
  expect(field<HTMLInputElement>(ko.maxWorkers).value).toBe('4')
  await click(ko.save)
  expect(server.settings.executor.maxWorkers).toBe(4)
  await remount(ko)
  await click(tab(ko['tab.execution']))
  expect(text()).toContain('실행 중 2 / 4')
  await click(ko.pauseProcessing)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(ko.pauseProcessingConfirm)
  await click(ko.confirm)
  expect(server.settings.paused).toBe(true)
  expect(text()).toContain(ko.processingPaused)
  await click(tab(ko['tab.eval']))
  expect(text()).toContain(ko.evalRecordsPaused)
  await click(tab(ko['tab.overview']))
  expect(text()).toContain(ko.problemPaused)
  await click(tab(ko['tab.execution']))
  await click(ko.resumeProcessing)
  await click(ko.confirm)
  expect(server.settings.paused).toBe(false)
  await click(tab(ko['tab.eval']))
  expect(text()).not.toContain(ko.evalRecordsPaused)
})

it('renders Korean source and policy metadata and preserves user-written content', async () => {
  await mount(ko)
  await click(tab(ko['tab.settings']))
  expect(all('.dt-settings-link').map(link => link.textContent)).toEqual(['소스', '평가', '실행', '프롬프트', '배포'])
  expect(field<HTMLInputElement>('에이전트의 GitHub CLI').value).toBe('gh-agent')
  expect(field<HTMLInputElement>('봇의 lark-cli').value).toBe('lark-bot')
  expect(text()).toContain('저장소의 새 이슈 수신')
  await click(find(ko['settingsGroup.eval'], '.dt-settings-link'))
  expect(text()).toContain('작업을 시작할 수 있는 Feishu 사용자')
  expect(text()).toContain('기타 채팅방')
  expect(text()).toContain('文案修改')
  await click(find('GitHub', '[role="tab"]'))
  expect(text()).toContain('작업을 시작할 수 있는 GitHub 계정')
  expect(text()).toContain('새 이슈')
})

it('searches in Korean, opens the matched Thread and queues a Trigger for another Eval', async () => {
  server.search = { items: [found('e1', '2026-09-20T00:00:00Z')], threads: [] }
  await mount(ko)
  const submit = async (query: string) => {
    const search = field<HTMLInputElement>(ko.searchLabel)
    await type(search, query)
    await act(async () => { search.closest('form')!.requestSubmit() })
    await settle()
  }
  await submit('nothing')
  expect(text()).toContain(ko.searchNone)
  await submit('message')
  expect(text()).toContain('작업 0개, 스레드 0개, 트리거 1개를 찾았습니다')
  await click(find('message e1', '.dt-search-results button'))
  expect(server.requests.some(request => request.path.includes('around=e1'))).toBe(true)
  expect(document.querySelector('.dt-highlight')?.textContent).toContain('message e1')
  await click(tab(ko['tab.trigger']))
  await click('这个文案好奇怪')
  expect(text()).toContain('발신자가 이 소스의 목록에 없음')
  await click(ko.requeue)
  expect(server.queued.has('e4')).toBe(true)
  expect(text()).toContain(ko.dispositionQueued)
})

it('shows Korean missing-record and connection errors', async () => {
  at({ page: 'execution', id: 'missing' })
  await mount(ko)
  expect(text()).toContain(ko.ticketNotFound)
  server.down = true
  await remount(ko)
  expect(text()).toContain(ko.hostNotRunning)
})
