import { expect, it, vi } from 'vitest'
import type { EffectKind } from '../src/app/effects.ts'
import { EXECUTOR_VARIABLES } from '../src/app/execution-environment.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { githubKind } from '../src/sources/github.ts'
import { en, ko, zh, type DshSuperagentKey } from '../src/client/locales.ts'
import { fullTime, localized, readableMarkers, reasonLabel, when, type T } from '../src/client/text.ts'
import { REASONS, USER_ERRORS } from '../src/core/index.ts'

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()

const dictionaries = { zh, en, ko }
const translate = (dictionary: Record<DshSuperagentKey, string>): T =>
  ((key: DshSuperagentKey, values: Record<string, unknown> = {}) => (dictionary[key] ?? key)
    .replace(/\{(\w+)\}/g, (match, name: string) => name in values ? String(values[name]) : match)) as T

it.each(Object.entries(dictionaries))('has complete keys and matching placeholders in %s', (_language, dictionary) => {
  const keys = Object.keys(en) as DshSuperagentKey[]
  expect(Object.keys(dictionary).sort()).toEqual([...keys].sort())
  expect(keys.filter(key => placeholders(dictionary[key]).join() !== placeholders(en[key]).join())).toEqual([])
  expect(keys.filter(key => !dictionary[key])).toEqual([])
})

it('words a reason by its code with its values, each of a batch, and words a person or an assessor wrote as written', () => {
  const t = ((key: DshSuperagentKey, values: Record<string, string> = {}) => (zh[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => values[name] ?? '')) as T
  expect(reasonLabel(t, 'retried')).toBe(zh['reason.retried'])
  expect(reasonLabel(t, [{ code: 'routed', values: { ticket: 't1' } }])).toBe('已转给工单 t1')
  expect(reasonLabel(t, [{ code: 'not_a_member', triggerId: '1' }, { code: 'no_mention', triggerId: '2' }]))
    .toBe(`${zh['reason.not_a_member']}；${zh['reason.no_mention']}`)
  expect(reasonLabel(t, [{ code: 'said', values: { text: 'The button is already blue' } }])).toBe('The button is already blue')
  // A code the panel has no words for reads as the host words it.
  expect(reasonLabel(t, { code: 'some_new_filter' })).toBe('some_new_filter')
  expect(reasonLabel(t, 'The button is already blue')).toBe('The button is already blue')
})

it('names every health entry of dsh-superagent itself, which the overview shows when it fails', () => {
  // Each entry by its writer: dsh-superagent, the model budget retries, every kind of the effect queue, Channel messages, the
  // Executor and the unavailable Evals of the last hour.
  const entries = { runtime: 0, models: 0, reply: 0, worker: 0, assessment: 0, launch: 0, delivery: 0, relay: 0,
    notice: 0, evals: 0 } satisfies Record<EffectKind | 'runtime' | 'models' | 'reply' | 'worker' | 'evals', 0>
  expect(Object.keys(entries).filter(name => !(`health.${name}` in zh))).toEqual([])
})

it.each(Object.entries(dictionaries))('words every refusal the host words by code in %s', (_language, dictionary) => {
  expect(Object.keys(USER_ERRORS).filter(code => !dictionary[`userError.${code}` as DshSuperagentKey])).toEqual([])
})

it('has words for every reason code the core records', () => {
  expect(Object.keys(REASONS).filter(code => code !== 'said' && !(`reason.${code}` in zh))).toEqual([])
})

it('words the reasons agents read in the glossary\'s words: a sender on the list, a Thread', () => {
  expect(Object.values(REASONS).filter(text => /\b(member|members|topic)\b/i.test(text))).toEqual([])
})

it('uses Korean source text and falls back to English for older records and external plugins', () => {
  const t = translate(ko)
  expect(localized(t, { zh: '中文', en: 'English', ko: '한국어' })).toBe('한국어')
  expect(localized(t, { zh: '中文', en: 'English' })).toBe('English')
  expect(localized(t, { zh: '中文', en: 'English', ko: '' })).toBe('')
  expect(localized(t, 'User-provided title')).toBe('User-provided title')
  expect(localized(t, undefined)).toBe('')
  expect(localized(translate(en), { zh: '中文', en: 'English', ko: '한국어' })).toBe('English')
  expect(localized(translate(zh), { zh: '中文', en: 'English', ko: '한국어' })).toBe('中文')
})

it('formats Korean reasons and message markers while preserving people\'s words', () => {
  const t = translate(ko)
  expect(reasonLabel(t, { code: 'routed', values: { ticket: 't1' } })).toBe('작업 t1에 전달됨')
  expect(reasonLabel(t, [{ code: 'retried' }, { code: 'completed' }])).toBe('사용자가 재시도함; 완료됨')
  expect(reasonLabel(t, { code: 'said', values: { text: 'Keep this message as written' } })).toBe('Keep this message as written')
  expect(readableMarkers(t, '[image] [Media: video] [Merged forward] [Chat card: title] @_user_1'))
    .toBe('[이미지] [미디어] [모아 전달한 메시지] [카드 메시지] @누군가')
})

it('formats relative and full timestamps with Korean date conventions and handles missing or invalid times', () => {
  vi.useFakeTimers()
  try {
    vi.setSystemTime(new Date('2026-11-01T12:00:00Z'))
    expect(when('2026-11-01T11:58:00Z', 'ko')).toBe('2분 전')
    expect(when('2026-11-01T13:00:00Z', 'ko')).toBe('1시간 후')
    expect(when('2026-11-01T12:00:00Z', 'ko')).toBe('지금')
    const old = '2025-09-23T00:00:00Z'
    expect(when(old, 'ko')).toBe(new Date(old).toLocaleString('ko-KR', {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }))
    expect(fullTime(old, 'ko')).toBe(new Date(old).toLocaleString('ko-KR'))
    expect(when(undefined, 'ko')).toBe('')
    expect(when('invalid', 'ko')).toBe('invalid')
    expect(fullTime('invalid', 'ko')).toBe('')
  } finally { vi.useRealTimers() }
})

it('provides Korean for built-in Source metadata, admission rows and execution variables', () => {
  const missing: string[] = []
  const visit = (value: unknown, path: string) => {
    if (!value || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    if (typeof record.zh === 'string' && typeof record.en === 'string') {
      if (typeof record.ko !== 'string' || (record.en && !record.ko)) missing.push(path)
      return
    }
    for (const [key, nested] of Object.entries(record)) visit(nested, `${path}.${key}`)
  }
  visit(EXECUTOR_VARIABLES, 'executor')
  for (const kind of [feishuKind, githubKind]) {
    visit([kind.title, kind.description, kind.fields, kind.environment?.variables,
      kind.policy?.fields, kind.policy?.explicit, kind.policy?.unnamed], kind.kind)
    visit(kind.policy?.rows?.(kind.schema.parse({})), `${kind.kind}.rows`)
  }
  expect(missing).toEqual([])
})
