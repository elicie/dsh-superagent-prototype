/**
 * Instance keys and management URL prefixes, shared by the host and the panel (no Node imports).
 *
 * Several dsh-superagent entries can run in one DSH process when each extra entry sits in its own `cordis:group` that
 * isolates the `orchestrator` service (docs/006-deployment.md). Each one then needs its own management prefix on the shared
 * web server. The default instance keeps `/orchestrator`; an instance with key `b` serves `/orchestrator-b`. A sibling prefix
 * rather than `/orchestrator/b` because DSH's web server matches prefixes on path-segment boundaries and the longest one wins:
 * a nested prefix such as `/orchestrator/api` would capture the default instance's routes and the host-level
 * `/orchestrator/api/subscriptions/grok`, whereas a sibling prefix never overlaps either.
 */
export const DEFAULT_PREFIX = '/orchestrator'
/** A lowercase slug of at most 32 characters: letters, digits and single inner hyphens. */
export const INSTANCE_PATTERN = /^(?=.{1,32}$)[a-z0-9]+(?:-[a-z0-9]+)*$/
/** Return the management URL prefix of an instance; an empty key is the default instance. */
export function managementPrefix(instance = ''): string {
  if (!instance) return DEFAULT_PREFIX
  if (!INSTANCE_PATTERN.test(instance)) throw new Error(`dsh-superagent instance must be a lowercase slug of at most 32 characters, not ${JSON.stringify(instance)}`)
  return `${DEFAULT_PREFIX}-${instance}`
}
