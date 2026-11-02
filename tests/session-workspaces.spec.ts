import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sessions, ROUTER_PRESET, WORKER_PRESET, type SessionsHost } from '../src/app/sessions.ts'

vi.mock('../src/app/role-models.ts', () => ({ initializeRoleModel: async () => {} }))

const MASTER = 'orchestrator-main'
let directory: string, root: string
let created: Record<string, unknown>[], registered: string[], deleted: string[], warn: ReturnType<typeof vi.fn>
let known: Set<string>, existing: Set<string>, workspaces: { id: string; path: string; sessionIds: string[] }[]
let failDelete: Set<string>, listFails: boolean

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-superagent-workspaces-')))
  root = join(directory, 'work'); mkdirSync(root)
  created = []; registered = []; deleted = []; warn = vi.fn()
  known = new Set(['t1', 't2']); existing = new Set(); workspaces = []; failDelete = new Set(); listFails = false
})
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

const agent = { session: {} }
function make(executionRoot: () => string = () => root) {
  const ctx = new Context()
  const services = {
    sessionController: {
      resolveAgent: async (id: string) => existing.has(id) ? { agent } : { error: { code: 'session/not-found' } },
      create: async (request: Record<string, unknown>) => { created.push(request); existing.add(String(request.sessionId)) },
      rename: async () => {},
    },
    workspaceRegistry: {
      create: async (cwd: string) => { registered.push(cwd); return { id: `ws:${cwd}` } },
      list: () => { if (listFails) throw new Error('registry unavailable'); return workspaces },
      delete: async (id: string) => { if (failDelete.has(id)) throw new Error('write failed'); deleted.push(id); return true },
    },
    permissionPresets: { set: () => {} },
  }
  for (const [name, service] of Object.entries(services)) ctx.reflect.provide(name, service)
  ctx.logger.warn = warn as never
  const host = {
    context: ctx, masterId: MASTER, executionRoot, lifetime: new AbortController().signal, closing: () => false,
    store: { tickets: { get: (id: string) => known.has(id) ? { id } : undefined },
      settings: () => ({ eval: { model: null }, executor: { model: null } }) },
    effects: { handle: () => {} },
  } as unknown as SessionsHost
  const sessions = new Sessions(host)
  vi.spyOn(sessions as unknown as { decorate(): Promise<void> }, 'decorate').mockResolvedValue()
  return sessions
}
const workspace = (path: string, sessionIds: string[] = []) => {
  const entry = { id: `ws:${path}`, path, sessionIds }
  workspaces.push(entry)
  return entry
}
const child = (name: string) => { const path = join(root, name); mkdirSync(path, { recursive: true }); return path }

describe('creating Sessions', () => {
  it('creates a worker Session with its directory and no workspace', async () => {
    await make().ensure('worker-t1', '/tmp/ticket', 'Ticket', 'worker')
    expect(created).toEqual([{ sessionId: 'worker-t1', cwd: '/tmp/ticket', agentPreset: WORKER_PRESET }])
    expect(created[0]).not.toHaveProperty('workspaceId')
    expect(registered).toEqual([])
  })
  it('creates the main Session in a workspace of its state directory', async () => {
    await make().ensure(MASTER, '/tmp/state', 'Main', 'orchestrator')
    expect(registered).toEqual(['/tmp/state'])
    expect(created).toEqual([{ sessionId: MASTER, workspaceId: 'ws:/tmp/state', agentPreset: ROUTER_PRESET }])
    expect(created[0]).not.toHaveProperty('cwd')
  })
  it('only resolves a Session that exists', async () => {
    existing.add('worker-t1'); existing.add(MASTER)
    const sessions = make()
    await sessions.ensure('worker-t1', '/tmp/ticket', 'Ticket', 'worker')
    await sessions.ensure(MASTER, '/tmp/state', 'Main', 'orchestrator')
    expect(created).toEqual([])
    expect(registered).toEqual([])
  })
})

describe('releasing the workspace registrations of Ticket directories', () => {
  it('removes a direct child that is empty or holds only workers of known Tickets', async () => {
    workspace(child('empty')); workspace(child('one'), ['worker-t1']); workspace(child('two'), ['worker-t1', 'worker-t2'])
    await make().releaseWorkspaces()
    expect(deleted).toEqual([`ws:${root}/empty`, `ws:${root}/one`, `ws:${root}/two`])
    expect(warn).not.toHaveBeenCalled()
  })
  it('is idempotent', async () => {
    workspace(child('one'), ['worker-t1'])
    const sessions = make()
    await sessions.releaseWorkspaces()
    workspaces = workspaces.filter(entry => !deleted.includes(entry.id))
    await sessions.releaseWorkspaces()
    expect(deleted).toEqual([`ws:${root}/one`])
  })
  it('keeps a workspace that is nested deeper, outside the root, or the root itself', async () => {
    workspace(child('a/b')); workspace(directory); workspace(root); workspace(join(directory, 'work-other'))
    workspace(join(tmpdir(), 'unrelated'))
    await make().releaseWorkspaces()
    expect(deleted).toEqual([])
  })
  it('keeps a workspace that holds a Session this bundle did not create for a known Ticket', async () => {
    workspace(child('foreign'), ['session-by-person']); workspace(child('mixed'), ['worker-t1', 'session-by-person'])
    workspace(child('gone'), ['worker-unknown']); workspace(child('nested-name'), ['xworker-t1'])
    await make().releaseWorkspaces()
    expect(deleted).toEqual([])
  })
  it('keeps the workspace of the main Session', async () => {
    workspace(child('main'), [MASTER]); workspace(child('main-and-worker'), [MASTER, 'worker-t1'])
    await make().releaseWorkspaces()
    expect(deleted).toEqual([])
  })
  it('compares canonical paths, so a symlinked root works', async () => {
    const link = join(directory, 'link'); symlinkSync(root, link)
    workspace(child('one'), ['worker-t1'])
    await make(() => link).releaseWorkspaces()
    expect(deleted).toEqual([`ws:${root}/one`])
  })
  it('does nothing when the root does not exist', async () => {
    workspace(join(directory, 'missing', 'one'))
    const list = vi.fn(() => workspaces)
    const sessions = make(() => join(directory, 'missing'))
    ;(sessions as unknown as { ctx: { workspaceRegistry: { list: unknown } } }).ctx.workspaceRegistry.list = list
    await sessions.releaseWorkspaces()
    expect(deleted).toEqual([])
    expect(list).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })
  it('logs a failed delete and still removes the others', async () => {
    workspace(child('one'), ['worker-t1']); workspace(child('two'), ['worker-t2'])
    failDelete.add(`ws:${root}/one`)
    await expect(make().releaseWorkspaces()).resolves.toBeUndefined()
    expect(deleted).toEqual([`ws:${root}/two`])
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]!.join(' '))).toContain('write failed')
  })
  it('logs a registry failure without throwing', async () => {
    listFails = true
    await expect(make().releaseWorkspaces()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]!.join(' '))).toContain('registry unavailable')
  })
})
