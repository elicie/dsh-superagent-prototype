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

/**
 * Host-level route listing the instances running in this process, served by the root `dsh-superagent/worker-env` entry so it
 * answers whichever instances run, the default one included or not. It sits under `/orchestrator/api/` like the host-level Grok
 * routes: the longer prefix wins over the default instance's `/orchestrator`.
 */
export const INSTANCES_PATH = `${DEFAULT_PREFIX}/api/instances`
/** One instance as the panel's instance selector shows it. */
export interface InstanceView {
  /** Instance key; empty for the default instance. */
  instance: string
  /** Management URL prefix, `managementPrefix(instance)`. */
  prefix: string
  /** Plugin entry id of the instance's `dsh-superagent` entry, the key of its DSH configuration form (`configForms.get`). */
  entry: string
  /** The GitHub repository the instance works on (`owner/name`), once its setup names one. */
  repository?: string
}
/**
 * Whether `POST INSTANCES_PATH` can add an instance in this process. Adding writes a `cordis:group` to the DSH profile's
 * `cordis.patch.yml` and applies it through DSH's profile reload, so it needs a profile, DSH's `hmr` service, and a running
 * default instance whose `stateDir` names the new one's (`<default stateDir>-<key>`).
 */
export type InstanceAdding =
  | { available: true; /** The default instance's `stateDir`; a new instance `key` gets `${stateDirBase}-${key}`. */ stateDirBase: string }
  | { available: false; reason: 'no-profile' | 'no-reload' | 'no-default' }
/** Answer of `GET INSTANCES_PATH`: the default instance first, then the others by key. */
export interface InstancesView {
  instances: InstanceView[]
  /** Absent from servers that predate adding instances; the panel then offers no way to add one. */
  adding?: InstanceAdding
}
/** Body of `POST INSTANCES_PATH`. */
export interface AddInstanceRequest { /** The new instance's key, `INSTANCE_PATTERN`. */ instance: string }
/**
 * Answer of a successful `POST INSTANCES_PATH`: 201 once the profile reload started the instance, 202 when the change waits
 * for a DeepSeek Harness restart (`applied: false`).
 */
export interface AddInstanceResult {
  applied: boolean
  /** The new instance as `GET INSTANCES_PATH` will list it (no repository yet). */
  instance: InstanceView
  stateDir: string
  /** DSH's reason when the change waits for a restart. */
  restartReason?: string
}
/**
 * Error codes of `POST INSTANCES_PATH`, in an `{ error, code }` body: 400 `invalid` (body or key), 409 `exists` (the key, an
 * entry id or a non-empty `stateDir` is taken) or `unavailable` (see `InstanceAdding`), 500 `failed` (DSH refused the profile;
 * it was restored).
 */
export type AddInstanceError = 'invalid' | 'exists' | 'unavailable' | 'failed'
/** Plugin entry ids of instance `key`'s group, as docs/006-deployment.md's example names them. */
export function instanceEntryIds(key: string): { group: string; core: string; github: string; feishu: string } {
  return { group: `superagent-${key}`, core: `superagent-${key}-core`, github: `superagent-${key}-github`, feishu: `superagent-${key}-feishu` }
}
