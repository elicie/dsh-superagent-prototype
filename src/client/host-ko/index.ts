import { conversation } from './conversation.ts'
import { management } from './management.ts'
import { shell } from './shell.ts'
import { tools } from './tools.ts'

/** Host UI dictionaries for DeepSeek Harness 0.2.1-rc.3; registered by the Korean language owner. */
export const hostKorean: Record<string, Record<string, string>> = { ...shell, ...conversation, ...management, ...tools }
