/** The same-origin check of the management routes. */
import type { IncomingMessage } from 'node:http'

/** True for a request the panel makes to this loopback server: its own host and port, the `x-orchestrator-request` header and no foreign origin. */
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const host = req.headers.host
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false
  return req.headers['x-orchestrator-request'] === '1' && (req.headers.origin === undefined || req.headers.origin === `http://${host}`)
}
