/** Same-origin client and polling hook for the orchestrator management API. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Api, ApiRequest, ApiResponse } from '../app/api.ts'
import { SUBSCRIPTION_ERRORS, type SubscriptionError } from '../app/subscriptions-api.ts'
import { USER_ERRORS, type UserErrorCode } from '../core/errors.ts'
import type { TicketStage } from '../core/stage.ts'
import type { SetupProblem } from '../setup.ts'
import { DEFAULT_PREFIX, INSTANCES_PATH, type AddInstanceError, type AddInstanceRequest, type AddInstanceResult, type InstanceAdding,
  type InstanceView, type InstancesView } from '../instance.ts'

/** Host rejection identified by a structured user error code and interpolation values. */
export interface UserFailure { code: UserErrorCode; values: Record<string, string> }
/**
 * Represents a failed management API request with a localized message and structured diagnostic details.
 * Thrown by API callers and inspected by UI views and draft state to distinguish validation issues, missing records,
 * and unreachable hosts (`details.unreachable` is set when `dsh-superagent` did not answer at all, such as during a restart,
 * in which case a 404 does not mean a record is missing).
 */
export class ApiError extends Error {
  constructor(message: string, readonly status: number,
    readonly details: { issues?: { path: string; message: string }[]; setup?: SetupProblem; user?: UserFailure;
      subscription?: SubscriptionError; unreachable?: boolean } = {}) {
    super(message)
  }
  get issues() { return this.details.issues ?? [] }
  /** True when the host confirmed the record does not exist, rather than being unreachable. */
  get missing() { return this.status === 404 && !this.details.unreachable }
}
export interface ApiMessages {
  offline: string; notRunning: string; serverError: (status: number) => string; requestFailed: (status: number) => string
  setup: (problem: SetupProblem) => string
  user: (failure: UserFailure) => string
}
const isUserError = (code: unknown): code is UserErrorCode => typeof code === 'string' && Object.hasOwn(USER_ERRORS, code)

/**
 * Calls one management endpoint under `prefix` (`/orchestrator`, or `managementPrefix(instance)` from src/instance.ts for another
 * instance in the same process); the `x-orchestrator-request` header marks the request as originating from this page.
 */
async function api<T>(messages: ApiMessages, path: string, method: string, body?: unknown, prefix = DEFAULT_PREFIX): Promise<T> {
  let response: Response
  const json = body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  try {
    response = await fetch(`${prefix}/api/${path}`, { method, ...json, headers: { 'x-orchestrator-request': '1', ...json.headers } })
  } catch {
    throw new ApiError(messages.offline, 0, { unreachable: true })
  }
  const text = await response.text()
  let value: unknown
  try { value = text ? JSON.parse(text) : {} } catch { value = undefined }
  if (!response.ok) {
    const failure = (value ?? {}) as { error?: unknown; issues?: unknown; setup?: SetupProblem; code?: unknown
      values?: Record<string, string>; subscription?: unknown }
    const issues = Array.isArray(failure.issues) ? failure.issues as { path: string; message: string }[] : []
    const user = isUserError(failure.code) ? { code: failure.code, values: failure.values ?? {} } : undefined
    const subscription = SUBSCRIPTION_ERRORS.find(code => code === failure.subscription)
    // dsh-superagent always responds with a body; an empty 404 comes from the DSH web server when dsh-superagent routes are unmounted during startup or restart.
    const { status } = response
    const message = failure.setup ? messages.setup(failure.setup) : user ? messages.user(user)
      : typeof failure.error === 'string' ? failure.error : !text && status === 404 ? messages.notRunning
      : status >= 500 ? messages.serverError(status) : messages.requestFailed(status)
    throw new ApiError(message, status, { issues, ...failure.setup ? { setup: failure.setup } : {}, ...user ? { user } : {},
      ...subscription ? { subscription } : {}, ...text ? {} : { unreachable: true } })
  }
  return value as T
}

const HIDDEN_FACTOR = 6
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)
/**
 * Poll an endpoint while mounted, backing off when the document is hidden.
 * Preserves the last successful value across dependency changes and errors, skips state updates when the response is unchanged,
 * and drops stale responses when `deps` or `intervalMs` changes start a new subscription.
 */
export function usePoll<T>(load: () => Promise<T>, deps: readonly unknown[], intervalMs = 5000) {
  const [state, setState] = useState<{ data?: T; error?: Error }>({})
  const loader = useRef(load)
  loader.current = load
  const refresh = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    // Serialize requests so a manual reload after a mutation runs after the current poll finishes.
    let queue = Promise.resolve()
    const once = async () => {
      clearTimeout(timer)
      try {
        const value = await loader.current()
        if (active) setState(previous => same(previous.data, value) ? previous.error ? { data: previous.data as T } : previous : { data: value })
      } catch (failure) {
        if (active) setState(previous => ({ ...previous, error: failure instanceof Error ? failure : new Error(String(failure)) }))
      } finally {
        if (active) timer = setTimeout(run, document.hidden ? intervalMs * HIDDEN_FACTOR : intervalMs)
      }
    }
    const run = () => (queue = queue.then(once))
    const shown = () => { if (!document.hidden) void run() }
    refresh.current = run
    void run()
    document.addEventListener('visibilitychange', shown)
    return () => { active = false; clearTimeout(timer); document.removeEventListener('visibilitychange', shown) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, intervalMs])
  const reload = useCallback(() => refresh.current(), [])
  return { data: state.data, error: state.error, reload }
}

const ADDING_REASONS: readonly Extract<InstanceAdding, { available: false }>['reason'][] = ['no-profile', 'no-reload', 'no-default']
const ADD_ERRORS: readonly AddInstanceError[] = ['invalid', 'exists', 'unavailable', 'failed']
/** Read only what this panel understands of the instance list's `adding`; an absent or unknown value means no way to add. */
function addingOf(value: unknown): InstanceAdding | undefined {
  const { available, stateDirBase, reason } = (value ?? {}) as Record<string, unknown>
  if (available === true && typeof stateDirBase === 'string' && stateDirBase) return { available, stateDirBase }
  const known = ADDING_REASONS.find(item => item === reason)
  return available === false && known ? { available, reason: known } : undefined
}
/** Read the host's list of running instances; any failure, such as the 404 of a host without the route, rejects. */
async function listInstances(): Promise<InstancesView> {
  const response = await fetch(INSTANCES_PATH, { headers: { 'x-orchestrator-request': '1' } })
  const text = await response.text()
  if (!response.ok) throw new Error(`${INSTANCES_PATH} answered ${response.status}`)
  const { instances, adding } = JSON.parse(text) as Partial<InstancesView>
  if (!Array.isArray(instances)) throw new Error(`${INSTANCES_PATH} answered without instances`)
  const listed = instances.filter(item => typeof item?.instance === 'string' && typeof item.prefix === 'string' && typeof item.entry === 'string')
  const addable = addingOf(adding)
  return { instances: listed, ...addable ? { adding: addable } : {} }
}
/** The instance list as the panel uses it: what runs, whether and how one can be added, and an immediate re-read of both. */
export interface InstancesData {
  /** `undefined` until the list first arrives, and for good when the host never serves it (`failed`). */
  instances: InstanceView[] | undefined
  /** Absent when the host does not say whether it can add an instance. */
  adding: InstanceAdding | undefined
  failed: boolean
  /** Read the list now, such as after adding an instance; resolves once the read ended. */
  reload: () => Promise<void>
}
/**
 * Poll the instances running in this process. `undefined` until the list first arrives, and for good when the host never serves it
 * (`failed`); a later failed poll keeps the last list.
 */
export function useInstances(intervalMs = 15_000): InstancesData {
  const { data, error, reload } = usePoll(listInstances, [], intervalMs)
  return { instances: data?.instances, adding: data?.adding, failed: !data && !!error, reload }
}

/**
 * A refused or failed `addInstance`. `code` is the host's `AddInstanceError`; it is absent when the host did not answer (`status` 0)
 * or answered something else, such as the empty 404 of routes that are unmounted during a restart. `message` is the host's `error` text.
 */
export class AddInstanceFailure extends Error {
  constructor(message: string, readonly status: number, readonly code?: AddInstanceError) { super(message) }
}
/**
 * Ask the host to add the instance `key` (`POST INSTANCES_PATH`). Resolves with the host's answer, which says whether the instance
 * already runs (`applied`) or waits for a Harness restart; rejects with an `AddInstanceFailure`.
 */
export async function addInstance(key: string): Promise<AddInstanceResult> {
  const body: AddInstanceRequest = { instance: key }
  let response: Response
  try {
    response = await fetch(INSTANCES_PATH, { method: 'POST', headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' },
      body: JSON.stringify(body) })
  } catch { throw new AddInstanceFailure('', 0) }
  const text = await response.text()
  let value: Record<string, unknown> = {}
  try { value = text ? JSON.parse(text) as Record<string, unknown> : {} } catch { /* A body that is not JSON carries no code. */ }
  if (!response.ok) {
    const code = ADD_ERRORS.find(known => known === value.code)
    throw new AddInstanceFailure(typeof value.error === 'string' ? value.error : '', response.status, code)
  }
  return value as unknown as AddInstanceResult
}

export const DECISION_FILTERS = ['work', 'stop', 'ignore', 'unavailable', 'all'] as const
export type DecisionFilter = typeof DECISION_FILTERS[number]
export const DECISION_KINDS: Readonly<Record<DecisionFilter, string>> = { work: 'accept,reopen', stop: 'stop', ignore: 'ignore',
  unavailable: 'unavailable', all: '' }

export type Call = <K extends keyof Api>(route: K, ...request: {} extends ApiRequest<K> ? [request?: ApiRequest<K>] : [request: ApiRequest<K>])
  => Promise<ApiResponse<K>>
/**
 * Build a typed route caller that resolves localized error messages on each request.
 * `prefix` selects the instance; the default instance and the host-level Grok subscription routes use `/orchestrator`.
 */
export function caller(messages: () => ApiMessages, prefix = DEFAULT_PREFIX): Call {
  return (route, ...[request]) => {
    const [method, pattern] = route.split(' ') as [string, string]
    const values = (request ?? {}) as Record<string, unknown> & { query?: Record<string, unknown>; body?: unknown }
    const path = pattern.replace(/:(\w+)/g, (_match, name: string) => encodeURIComponent(String(values[name])))
    const query = Object.entries(values.query ?? {}).filter(([, value]) => value !== undefined && value !== '')
      .map(([name, value]) => `${name}=${encodeURIComponent(String(value))}`).join('&')
    return api(messages(), query ? `${path}?${query}` : path, method, values.body, prefix)
  }
}

export type StateView = ApiResponse<'GET state'>
export type SetupView = StateView['setup']
export type SettingsView = ApiResponse<'GET settings'>
export type Settings = { [B in keyof SettingsView['blocks']]: SettingsView['blocks'][B]['value'] }
export type SourceView = SettingsView['sources'][number]
export type SourceStatusRow = ApiResponse<'GET sources'>[number]
export type TicketRow = ApiResponse<'GET tickets'>['items'][number]
export type TicketPageView = ApiResponse<'GET tickets/:id'>
export type ThreadRow = ApiResponse<'GET threads'>['items'][number]
export type ThreadPageView = ApiResponse<'GET threads/:key'>
export type TriggerRow = ThreadPageView['timeline'][number]
export type DecisionRow = ApiResponse<'GET decisions'>['items'][number]
export type Problem = ApiResponse<'GET overview'>['problems'][number]
export type DroppedReply = SourceStatusRow['dropped'][number]
export type SearchView = ApiResponse<'GET search'>
export type TicketSummary = SearchView['tickets'][number]
export type { TicketStage }
export type HistoryView = ApiResponse<'GET policy/history'>
export type PromptsView = ApiResponse<'GET prompts'>
export type PromptConfig = PromptsView['defaults']
export type ThreadFacts = TicketRow['threads'][number]
export type Actor = TriggerRow['actor']
