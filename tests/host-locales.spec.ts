import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { hostKorean } from '../src/client/host-ko/index.ts'

const contract = JSON.parse(readFileSync(new URL('./fixtures/host-locale-contract.json', import.meta.url), 'utf8')) as {
  version: string; namespaces: Record<string, Record<string, string[]>>
}
const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()

it('covers every host namespace for the supported DSH release', () => {
  expect(contract.version).toBe('0.2.1-rc.3')
  expect(Object.keys(hostKorean).sort()).toEqual(Object.keys(contract.namespaces).sort())
})

it.each(Object.entries(contract.namespaces))('preserves all host keys and placeholders in %s', (namespace, keys) => {
  const dictionary = hostKorean[namespace]!
  expect(Object.keys(dictionary).sort()).toEqual(Object.keys(keys).sort())
  const mismatches = Object.entries(keys).filter(([key, names]) => typeof dictionary[key] !== 'string'
    || placeholders(dictionary[key]!).join() !== names.join()).map(([key]) => key)
  expect(mismatches).toEqual([])
})

it('localizes the shell and language selector alongside the panel', () => {
  expect(hostKorean.sidebar!['session.new']).toBe('새 세션')
  expect(hostKorean.workspace!['section.workspaces']).toBe('작업 공간')
  expect(hostKorean.settings!['general.nav']).toBe('일반')
  expect(hostKorean['settings.locale']!['language.title']).toBe('언어')
  expect(hostKorean['settings.account']!['settings']).toBe('설정')
  expect(hostKorean['settings.models']!['nav']).toBe('모델')
})

it('limits the host settings layout adjustment to Korean mobile screens', () => {
  const css = readFileSync(new URL('../src/client/host-ko/mobile.css', import.meta.url), 'utf8')
  expect(css).toContain('@media (max-width: 640px)')
  expect(css).toContain("html[lang='ko'] [data-shortcut-modal='settings']")
  expect(css).not.toContain('!important')
})

it('keeps resource language IDs, endpoints, environment names and API protocols intact', () => {
  expect(hostKorean['settings.account']!['onboardingArtworkLocale']).toBe('en')
  expect(hostKorean['settings.models']!['customBaseUrlPlaceholder']).toBe('https://gateway.example/v1')
  expect(hostKorean['settings.models']!['protocolOpenAiResponses']).toBe('OpenAI Responses')
  expect(hostKorean['settings.models']!['deepSeekBaseUrl']).toContain('DEEPSEEK_BASE_URL')
})
