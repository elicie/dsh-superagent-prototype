/** Feishu source kind definition, policy synchronization, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { FeishuBotSchema } from '../deployment.ts'
import { feishuLink, sendFeishu } from './feishu-channel.ts'
import { feishuThreadContext } from './feishu-read.ts'
import { refreshChatNames, runFeishu } from './feishu-loops.ts'
import { SOURCE, feishuTriggerId } from './feishu-trigger.ts'
import { sourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import type { SourceRegistry } from './registry.ts'

export { SOURCE, feishuRef, feishuThreadId, feishuTime, feishuTrigger, feishuTriggerId, historyEvent, withMentionNames }
  from './feishu-trigger.ts'
export type { FeishuEvent } from './feishu-trigger.ts'
export { backfillChat, consumerRetry, pollThreads, refreshChatNames, threadRef } from './feishu-loops.ts'
const MembersSchema = z.looseObject({
  users: z.array(z.looseObject({ member_id: z.string(), name: z.string() })),
  has_more: z.boolean(), truncations: z.array(z.unknown()).optional(),
})
const FeishuConfigSchema = FeishuBotSchema.extend({
  readPageSize: z.number().int().min(1).max(50).default(20),
  linkTimeoutMs: z.number().int().min(1).max(90000).default(5000),
  chats: z.array(z.object({ chatId: z.string().regex(/^oc_[a-zA-Z0-9]+$/), name: z.string().trim().max(60).optional(), listen: z.enum(['mentions', 'all']) }).strict())
    .refine(chats => new Set(chats.map(chat => chat.chatId)).size === chats.length, 'Duplicate chat IDs')
    .default([]),
  directMessages: z.boolean().default(true),
  otherChats: z.enum(['none', 'mentions']).default('none'),
}).strict()
export type FeishuConfig = z.infer<typeof FeishuConfigSchema>
export const feishuKind: SourceKind<FeishuConfig> = {
  kind: SOURCE,
  refreshLabels: (host, signal) => refreshChatNames(sourceContext(host, feishuKind), signal),
  title: { zh: '飞书', en: 'Feishu', ko: 'Feishu' },
  description: { zh: '接收下列群和私聊中发给机器人的消息，补收群历史并轮询订阅的线程。', en: 'Receives messages to the bot in these chats and direct messages, recovers chat history and polls subscribed Threads.', ko: '아래 채팅방과 개인 대화에서 봇에게 보낸 메시지를 수신하고, 채팅 기록을 복구하며 구독 중인 스레드를 폴링합니다.' },
  schema: FeishuConfigSchema,
  fields: [
    { key: 'cli', type: 'text', label: { zh: '机器人的 lark-cli', en: 'Bot lark-cli', ko: '봇의 lark-cli' },
      hint: { zh: '命令名或绝对路径，指向只允许机器人身份（strict mode bot）的 lark-cli 配置；执行器以 lark-cli 调用它。保存时读取应用和机器人，然后重启 dsh-superagent。', en: 'A command name or absolute path of a lark-cli configuration that allows only the bot identity (strict mode bot); the Executor calls it as lark-cli. Saving reads the app and the bot, then restarts dsh-superagent.', ko: '봇 계정만 허용하는(strict mode bot) lark-cli 설정을 가리키는 명령어 이름 또는 절대 경로입니다. 실행기는 이를 lark-cli로 호출합니다. 저장하면 앱과 봇 정보를 읽은 뒤 dsh-superagent를 다시 시작합니다.' } },
    { key: 'chats', type: 'rows', label: { zh: '接收的群', en: 'Chats', ko: '수신할 채팅방' },
      hint: { zh: '“仅 @”只接收 @ 机器人的消息和已有工单的线程；“全部消息”也接收其余消息，评估可以按规则从中推断工作，需要机器人有读取全部消息的权限。', en: '"@ only" receives messages that mention the bot and Threads that have Tickets; "All" also receives the rest, from which Eval may infer work under the rules; the bot needs permission to read all messages.', ko: '"@ 멘션만"은 봇을 @ 멘션한 메시지와 작업이 있는 스레드만 수신합니다. "모든 메시지"는 나머지 메시지도 수신하며, 평가에서는 규칙에 따라 이 메시지에서 작업을 추론할 수 있습니다. 봇에 모든 메시지를 읽을 권한이 필요합니다.' },
      columns: [
        { key: 'chatId', type: 'text', label: { zh: '群', en: 'Chat', ko: '채팅방' }, pattern: 'oc_[a-zA-Z0-9]+', choose: { zh: '选择机器人已加入的群', en: 'Choose a chat the bot has joined', ko: '봇이 참여한 채팅방 선택' }, refresh: { zh: '刷新群列表', en: 'Refresh chats', ko: '채팅방 목록 새로고침' } },
        { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive', ko: '수신' }, options: [{ value: 'mentions', label: { zh: '仅 @', en: '@ only', ko: '@ 멘션만' } }, { value: 'all', label: { zh: '全部消息', en: 'All', ko: '모든 메시지' } }] },
      ] },
    { key: 'otherChats', type: 'select', label: { zh: '其他群', en: 'Other chats', ko: '기타 채팅방' }, options: [{ value: 'none', label: { zh: '不接收', en: 'Not received', ko: '수신 안 함' } }, { value: 'mentions', label: { zh: '仅 @', en: '@ only', ko: '@ 멘션만' } }],
      hint: { zh: '机器人已加入、但没列在上面的群。“仅 @”接收那里 @ 机器人的消息；谁的消息能发起工作看策略里的准入。', en: 'Chats the bot has joined that are not listed above. "@ only" receives messages there that mention the bot; whose messages may originate work is the Policy\'s admission.', ko: '봇이 참여했지만 위 목록에는 없는 채팅방입니다. "@ 멘션만"을 선택하면 해당 채팅방에서 봇을 @ 멘션한 메시지를 수신합니다. 누구의 메시지가 작업을 시작할 수 있는지는 정책의 수신 허용 기준으로 결정합니다.' } },
    { key: 'directMessages', type: 'switch', label: { zh: '接收私聊', en: 'Direct messages', ko: '개인 메시지' } },
    { key: 'readPageSize', type: 'number', advanced: true, min: 1, max: 50, label: { zh: '每页消息数', en: 'Messages per page', ko: '페이지당 메시지 수' }, hint: { zh: '智能体读取线程和群历史时，每页的消息数。', en: 'Messages per page when agents read Threads and chat history.', ko: '에이전트가 스레드와 채팅 기록을 읽을 때 한 페이지에 표시되는 메시지 수입니다.' } },
    { key: 'linkTimeoutMs', type: 'number', advanced: true, min: 1, max: 90000, label: { zh: '原消息链接的查询时限 / 毫秒', en: 'Original message link time limit / ms', ko: '원본 메시지 링크 조회 제한 시간 / ms' },
      hint: { zh: '查询原消息链接最多等待的时间；超时后智能体改为直接读取原消息。', en: 'How long to wait for an original message\'s link; after that, agents read the message itself.', ko: '원본 메시지 링크를 조회할 때 기다리는 최대 시간입니다. 시간이 초과되면 에이전트가 원본 메시지를 직접 읽습니다.' } },
  ],
  health: ['feishu', 'history'],
  scope({ meta }, config) {
    if (meta.direct === true) return config.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
    const chat = config.chats.find(item => item.chatId === meta.chatId)
    if (chat) return { listened: true, observed: chat.listen === 'all', row: chat.chatId }
    return config.otherChats === 'mentions' ? { listened: true, observed: false, row: 'other' } : { listened: false, reason: 'chat_not_allowed' }
  },
  // A reply goes only to a chat the Source still receives.
  channel: {
    allowed: (address, config) =>
      feishuKind.scope!({ meta: { chatId: address.chatId ?? '', direct: address.direct === 'true' } }, config).listened,
    send: sendFeishu, link: feishuLink,
  },
  threadContext: feishuThreadContext,
  find: query => ({ threads: [], terms: [...new Set(query.match(/om_[A-Za-z0-9_-]+/g) ?? [])] }),
  // A message's Trigger is named after the message, so the one it answers is named after its parent.
  repliesTo: trigger => typeof trigger.meta.parentId === 'string' ? feishuTriggerId(trigger.meta.parentId) : undefined,
  policy: {
    unnamed: { person: { zh: '飞书用户', en: 'Feishu user', ko: 'Feishu 사용자' }, bot: { zh: '飞书机器人', en: 'Feishu bot', ko: 'Feishu 봇' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^ou_[a-zA-Z0-9]+$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate open_ids').default([]),
      syncChat: z.string().regex(/^(oc_[a-zA-Z0-9]+)?$/).default(''),
      bots: z.array(z.object({ id: z.string().regex(/^(cli|ou)_[a-zA-Z0-9]+$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(bots => new Set(bots.map(bot => bot.id)).size === bots.length, 'Duplicate bot ids').optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的飞书用户', en: 'Feishu users who may originate work', ko: '작업을 시작할 수 있는 Feishu 사용자' },
        columns: [{ key: 'id', type: 'text', label: { zh: 'open_id', en: 'open_id', ko: 'open_id' }, pattern: 'ou_[a-zA-Z0-9]+' }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name', ko: '이름' }, optional: true }] },
      { key: 'syncChat', type: 'text', pattern: '(oc_[a-zA-Z0-9]+)?', label: { zh: '同步来源群', en: 'Sync chat', ko: '동기화할 채팅방' }, choose: { zh: '不同步', en: 'Do not sync', ko: '동기화 안 함' },
        hint: { zh: '同步时，名单变成这个群里的人：新成员加入，离开的人移除，名字取群里的名字。启动时和点同步时进行。', en: 'Syncing makes the list the people in this chat: new members join, people who left are removed, and names follow the chat. It runs at startup and on Sync.', ko: '동기화하면 이 채팅방의 참여자에 맞춰 목록을 갱신합니다. 새 참여자는 추가하고 나간 사람은 제거하며, 사용자 이름은 채팅방에 표시된 이름을 따릅니다. 시작할 때와 동기화를 누를 때 실행됩니다.' } },
      { key: 'bots', type: 'rows', label: { zh: '消息可以成为候选的机器人', en: 'Bots whose messages may become candidates', ko: '메시지가 후보가 될 수 있는 봇' },
        hint: { zh: '名单里的机器人在接收的群里发的消息成为推断的候选，交给评估；它们不能发起明确的请求，也不能停止工单。其他机器人的消息不接收。', en: 'Messages of a bot on this list, in chats the Source receives, become inferred candidates for an assessment; they never make an explicit request or stop a ticket. Other bots\' messages are not admitted.', ko: '소스가 수신하는 채팅방에서 이 목록의 봇이 보낸 메시지는 추론 후보가 되어 판단 대상으로 전달됩니다. 이 메시지로 명시적 요청을 하거나 작업을 중지할 수는 없습니다. 다른 봇의 메시지는 허용되지 않습니다.' },
        columns: [{ key: 'id', type: 'text', label: { zh: 'App ID 或 open_id', en: 'App ID or open_id', ko: 'App ID 또는 open_id' }, pattern: '(cli|ou)_[a-zA-Z0-9]+' },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name', ko: '이름' }, optional: true }] },
    ],
    explicit: { zh: '名单内的人 @ 机器人或私聊机器人，总是明确的请求，不需要配置。', en: 'Someone on the list who mentions the bot or messages it directly always makes an explicit request; that needs no setting.', ko: '목록에 있는 사람이 봇을 @ 멘션하거나 개인 메시지를 보내면 항상 명시적 요청으로 간주됩니다. 별도 설정은 필요하지 않습니다.' },
    rows(stored) {
      const config = FeishuConfigSchema.parse(stored)
      const mentions = { zh: '仅 @', en: '@ only', ko: '@ 멘션만' }
      return [
        ...config.chats.map(chat => ({ id: chat.chatId, label: chat.name || chat.chatId, note: chat.listen === 'all' ? { zh: '全部消息', en: 'All', ko: '모든 메시지' } : mentions,
          cells: { listedUnaddressed: chat.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: chat.listen === 'all' } })),
        { id: 'other', label: { zh: '其他群', en: 'Other chats', ko: '기타 채팅방' }, note: config.otherChats === 'mentions' ? mentions : { zh: '不接收', en: 'Not received', ko: '수신 안 함' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.otherChats === 'mentions', unlistedUnaddressed: false } },
        { id: 'direct', label: { zh: '私聊', en: 'Direct messages', ko: '개인 메시지' }, note: config.directMessages ? { zh: '接收', en: 'Received', ko: '수신' } : { zh: '不接收', en: 'Not received', ko: '수신 안 함' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.directMessages, unlistedUnaddressed: false } },
      ]
    },
    sync: {
      label: { zh: '立即同步', en: 'Sync now', ko: '지금 동기화' },
      ready: part => !!part.syncChat,
      async run(host, part, signal) {
        const commands = sourceContext(host, feishuKind).commands.withSignal(signal)
        const chat = String(part.syncChat)
        const members = ['im', '+chat-members-list', '--chat-id', chat, '--member-types', 'user', '--page-all', '--page-limit', '0']
        const result = MembersSchema.parse(await commands.lark(members))
        if (result.has_more || result.truncations?.length) throw new Error('Feishu returned an incomplete member list')
        // Preserve existing member order so policy version hashes stay stable; update names in place and append new members.
        const users = new Map(result.users.map(user => [user.member_id, user.name]))
        const known = new Set(part.allowed.map(entry => entry.id))
        return { ...part, allowed: [...part.allowed.filter(entry => users.has(entry.id)).map(entry => ({ ...entry, name: users.get(entry.id)! })), ...result.users.filter(user => !known.has(user.member_id)).map(user => ({ id: user.member_id, name: user.name }))] }
      },
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_FEISHU_BOT', description: { zh: '飞书机器人；lark-cli 以它行事', en: 'The Feishu bot; lark-cli acts as it', ko: 'Feishu 봇입니다. lark-cli는 이 봇으로 동작합니다' } },
      { key: 'DSH_SUPERAGENT_FEISHU_CHAT', description: { zh: '接下工单的飞书群 chat_id；工单不是从飞书来的时为空', en: 'chat_id of the Feishu chat that started the ticket; empty when the ticket did not start on Feishu', ko: '작업을 시작한 Feishu 채팅방의 chat_id입니다. Feishu에서 시작한 작업이 아니면 비어 있습니다' } },
    ],
    values: ({ deployment, trigger }) => ({ DSH_SUPERAGENT_FEISHU_BOT: deployment.feishu ? deployment.feishu.name || deployment.feishu.botId : '', DSH_SUPERAGENT_FEISHU_CHAT: trigger?.source === SOURCE ? String(trigger.meta.chatId ?? '') : '' }),
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.feishu ? { cli: { zh: `当前机器人 ${deployment.feishu.name || deployment.feishu.botId}`, en: `Current bot ${deployment.feishu.name || deployment.feishu.botId}`, ko: `현재 봇 ${deployment.feishu.name || deployment.feishu.botId}` } } : {},
}
/** Returns the Feishu Source's settings, falling back to schema defaults while the Feishu plugin is disabled. */
export const feishuSettings = (sources: SourceRegistry): FeishuConfig => sources.instance<FeishuConfig>(SOURCE)?.config ?? FeishuConfigSchema.parse({})

export const name = 'dsh-superagent-feishu'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(feishuKind), 'feishu: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const running = runFeishu(sourceContext(ctx.orchestrator, feishuKind), controller.signal)
    return async () => { controller.abort(); await running }
  })
}
