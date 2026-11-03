import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sessions, ROUTER_PRESET, WORKER_PRESET, misplaced, type SessionsHost, type WorkingDirectories } from '../src/app/sessions.ts'

vi.mock('../src/app/role-models.ts', () => ({ initializeRoleModel: async () => {} }))

const MASTER = 'orchestrator-main'
let directory: string, root: string
let created: Record<string, unknown>[], registered: string[], deleted: string[], warn: ReturnType<typeof vi.fn>
let known: Set<string>, existing: Set<string>, workspaces: { id: string; path: string; sessionIds: string[] }[]
let failDelete: Set<string>, listFails: boolean
/** DSH's working directory of the one fake agent, and the directories it was moved to. */
let location: string | undefined, moves: string[]

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-superagent-workspaces-')))
  root = join(directory, 'work'); mkdirSync(root)
  created = []; registered = []; deleted = []; warn = vi.fn()
  known = new Set(['t1', 't2']); existing = new Set(); workspaces = []; failDelete = new Set(); listFails = false
  location = undefined; moves = []
})
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

const agent = { session: {} }
function make(executionRoot: () => string = () => root, { directories = false } = {}) {
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
    ...directories ? { workingDirectory: {
      get: () => location ?? '/nonexistent',
      set: async (_agent: unknown, path: string) => { moves.push(path); location = path; return path },
    } } : {},
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
  it('creates a worker Session in the main Session\'s workspace and moves it to its Ticket directory', async () => {
    workspace(directory, [MASTER])
    const ticket = child('fix-regression')
    // DSH starts a Session created in a workspace in the workspace's directory.
    location = directory
    await make(undefined, { directories: true }).ensure('worker-t1', ticket, 'Ticket', 'worker')
    expect(created).toEqual([{ sessionId: 'worker-t1', workspaceId: `ws:${directory}`, agentPreset: WORKER_PRESET }])
    expect(created[0]).not.toHaveProperty('cwd')
    expect(registered).toEqual([])
    expect(moves).toEqual([ticket])
  })
  it('creates a worker Session in its directory when there is no workspace of the main Session or no working directory to move', async () => {
    const ticket = child('fix-regression')
    location = ticket
    await make(undefined, { directories: true }).ensure('worker-t1', ticket, 'Ticket', 'worker')
    workspace(directory, [MASTER])
    await make().ensure('worker-t2', ticket, 'Ticket', 'worker')
    expect(created).toEqual([{ sessionId: 'worker-t1', cwd: ticket, agentPreset: WORKER_PRESET },
      { sessionId: 'worker-t2', cwd: ticket, agentPreset: WORKER_PRESET }])
    expect(moves).toEqual([])
  })
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

describe('keeping a worker Session in its Ticket directory', () => {
  it('leaves one working in its Ticket directory or below it, also through a symbolic link, and moves one elsewhere back', async () => {
    const ticket = child('fix-regression'), below = child('fix-regression/packages/app')
    const link = join(directory, 'linked'); symlinkSync(ticket, link)
    const sessions = make(undefined, { directories: true })
    for (const where of [ticket, below]) {
      location = where
      await sessions.place(agent as never, link)
    }
    expect(moves).toEqual([])
    // DSH moved it back to the directory it was created in, the instance's state directory, or it is somewhere else.
    for (const where of [directory, root, child('other-ticket')]) {
      location = where
      await sessions.place(agent as never, ticket)
    }
    expect(moves).toEqual([ticket, ticket, ticket])
  })
  it('refuses a Ticket directory that does not exist instead of leaving the worker where it is', async () => {
    location = directory
    await expect(make(undefined, { directories: true }).place(agent as never, join(root, 'gone'))).rejects.toThrow(/does not exist/)
    expect(moves).toEqual([])
  })
  it('does nothing without DSH\'s working directories or a Ticket directory', async () => {
    location = directory
    await make().place(agent as never, join(root, 'gone'))
    await make(undefined, { directories: true }).place(agent as never, '')
    expect(moves).toEqual([])
  })
})

describe('refusing tools outside the Ticket directory', () => {
  const at = (path: string | undefined) => ({ get: () => path ?? '/nonexistent', set: async () => '' }) as unknown as WorkingDirectories
  const session = (cwd?: string) => ({ header: cwd === undefined ? {} : { cwd } }) as never
  it('allows a Session working in its Ticket directory, below it, or elsewhere on purpose', () => {
    const ticket = child('fix-regression'), below = child('fix-regression/packages/app'), other = child('elsewhere')
    for (const where of [ticket, below, other]) expect(misplaced(at(where), session(directory), ticket)).toBeUndefined()
    // A Session created in its Ticket directory falls back into it, so only a missing Ticket directory matters to it.
    expect(misplaced(at(join(ticket, 'gone')), session(ticket), ticket)).toBeUndefined()
    // Without DSH's working directories, or without a Ticket directory, nothing more is checked.
    expect(misplaced(undefined, session(directory), ticket)).toBeUndefined()
    expect(misplaced(at(directory), session(directory), undefined)).toBeUndefined()
  })
  it('refuses when the Ticket directory is gone', () => {
    const gone = join(root, 'gone')
    for (const directories of [at(gone), undefined]) {
      expect(misplaced(directories, session(directory), gone)).toMatch(/^The Ticket directory .*gone no longer exists/)
    }
  })
  it('refuses when DSH moved the working directory back to the state directory, or would because it is gone', () => {
    const ticket = child('fix-regression')
    expect(misplaced(at(directory), session(directory), ticket)).toMatch(/working directory is .* where DSH moved it/)
    expect(misplaced(at(join(ticket, 'removed')), session(directory), ticket))
      .toBe(`This Session's working directory ${join(ticket, 'removed')} no longer exists, so DSH would run tools in ${directory}, outside the Ticket directory ${ticket}. Tools are refused; end the turn.`)
  })
})
