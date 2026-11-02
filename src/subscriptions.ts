/** Independent model-login extension so subscription setup does not restart active Superagent work. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { sameOrigin } from './app/http.ts'
import { GrokSubscriptions, SubscriptionFailure, subscriptionHost } from './app/subscriptions.ts'

export const name = 'dsh-superagent-subscriptions'
export const inject = ['webServer', 'llm']
const PREFIX = '/orchestrator/api/subscriptions/grok'
function answer(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
}
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk); size += buffer.length
    if (size > 4096) throw new SubscriptionFailure('unsupported')
    chunks.push(buffer)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }
  catch { throw new SubscriptionFailure('unsupported') }
}
export function apply(ctx: Context): void {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Subscription management requires a loopback Web server')
  const subscriptions = new GrokSubscriptions(subscriptionHost(ctx))
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler: async (req, res) => {
    if (!sameOrigin(req, ctx.webServer.port)) { answer(res, 403, { error: 'Same-origin management request required' }); return }
    const path = new URL(req.url ?? '/', 'http://localhost').pathname.slice(PREFIX.length)
    try {
      if (req.method === 'GET' && path === '') { answer(res, 200, await subscriptions.view()); return }
      if (req.method !== 'POST' || !['/start', '/cancel', '/activate', '/logout'].includes(path)) {
        answer(res, 404, { error: 'Unknown operation' }); return
      }
      const input = await body(req)
      const result = path === '/start'
        ? await subscriptions.start(z.object({ replaceApiKey: z.boolean().optional() }).strict().parse(input).replaceApiKey)
        : path === '/cancel'
          ? await subscriptions.cancel(z.object({ id: z.string().uuid() }).strict().parse(input).id)
          : path === '/activate'
            ? await subscriptions.activate(z.object({ revision: z.number().int().nonnegative() }).strict().parse(input).revision)
            : (z.object({ confirm: z.literal(true) }).strict().parse(input), await subscriptions.logout())
      answer(res, 200, result)
    } catch (error) {
      const code = error instanceof SubscriptionFailure ? error.code : error instanceof z.ZodError ? 'unsupported' : 'unavailable'
      answer(res, error instanceof SubscriptionFailure ? error.status : error instanceof z.ZodError ? 400 : 503, { subscription: code })
    }
  } }), 'dsh-superagent: subscription routes')
  ctx.effect(() => () => subscriptions.stop(), 'dsh-superagent: subscription lifecycle')
}
