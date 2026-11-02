/** Default deployment and machine fixtures for tests. */
import type { Volatile } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import type { Deployment, Machine } from '../../src/deployment.ts'
import { credentialHelper, workerBin, type SharedWorkers } from '../../src/infra/environment.ts'
import { WorkerRegistry } from '../../src/worker-env.ts'

/** Mutable Volatile reference for simulating live configuration updates. */
export const reference = <T>(value: T): Volatile<T> & { set(next: T): void } => {
  let current = value
  return { get: () => current as never, set: next => { current = next } }
}
export const testMachine = (overrides: Partial<Machine> = {}): Machine => ({
  stateDir: '/tmp/dsh-superagent-test', promptMaxChars: reference(100000), admissionContextMaxPages: reference(10),
  admissionContextTimeoutMs: reference(15000), ...overrides,
})
export const testDeployment = (overrides: Partial<Deployment> = {}): Deployment => ({
  ...testMachine(), repository: 'acme/widgets',
  github: { cli: '/bin/false', login: 'agent-bot', noreply: '7+agent-bot@users.noreply.github.com' },
  feishu: { cli: '/bin/false', botId: 'ou_bot', appId: 'cli_bot', brand: 'feishu', name: 'Widgets Bot' },
  ...overrides,
})

/**
 * A started shared worker environment in `dir` that applies to `env`, by default a copy of the process environment, so tests
 * leave `process.env` alone. Stop it after the runtimes that joined it.
 */
export async function testWorkers(dir: string, env: Record<string, string | undefined> = { ...process.env }): Promise<WorkerRegistry> {
  const registry = new WorkerRegistry(dir, env, { warn: () => {} })
  await registry.start()
  return registry
}
/** The commands setup checks the worker environment with, and what they print for an instance in `stateDir` behind `shared`. */
export const workerAnswers = (shared: SharedWorkers, stateDir: string): Record<string, string> => ({
  'git config -z --show-origin --get-all credential.https://github.com.helper': `file:${shared.gitconfig}\0${credentialHelper(join(shared.bin, 'gh'))}\0`,
  gh: `${join(workerBin(stateDir), 'gh')}\n`,
})
