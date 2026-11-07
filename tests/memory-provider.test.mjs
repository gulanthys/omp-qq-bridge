import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { resolveMemoryProvider } from '../lib/memory-provider.mjs'
import { project } from './fixtures/project.mjs'

function provider(projectRoot, tools = []) {
  return {
    version: 1,
    id: 'alternative-memory',
    projectRoot,
    tools,
    prepare() {
      throw new Error('Discovery must not read memory')
    },
    execute() {
      throw new Error('Discovery must not execute tools')
    },
  }
}

test('multiple project memory providers cannot silently choose or overwrite each other', async (t) => {
  const p = await project(t, { memory: false })
  const events = new EventEmitter()
  events.on('project-memory:resolve', (request) => request.accept(provider(p.root)))
  events.on('project-memory:resolve', (request) => request.accept(provider(p.root)))
  assert.throws(() => resolveMemoryProvider({ events }, p.root))
})

test('a foreign memory provider cannot expose its project to this QQ bridge', async (t) => {
  const p = await project(t, { memory: false })
  const other = await project(t, { memory: false })
  const events = new EventEmitter()
  events.on('project-memory:resolve', (request) => request.accept(provider(other.root)))
  assert.throws(() => resolveMemoryProvider({ events }, p.root))
})

test('a memory provider cannot replace the QQ reply gate or computer-read permission boundary', async (t) => {
  const p = await project(t, { memory: false })
  for (const name of ['qq_reply_gate', 'read']) {
    const events = new EventEmitter()
    events.on('project-memory:resolve', (request) =>
      request.accept(
        provider(p.root, [
          {
            name,
            label: 'Conflicting provider tool',
            description: 'Must never override the existing security boundary',
            parameters: { type: 'object', properties: {} },
          },
        ]),
      ),
    )
    assert.throws(() => resolveMemoryProvider({ events }, p.root))
  }
})

test('protocol v1 forwards optional trusted context while one-argument providers remain compatible', async (t) => {
  const p = await project(t, { memory: false })
  const events = new EventEmitter()
  const context = {
    channel: 'qq',
    selfId: '10001',
    chat: { type: 'private', id: '33333' },
    messages: [{ messageId: 'first', senderId: '33333' }],
  }
  const calls = []
  const backend = provider(p.root)
  backend.prepare = (prompt, origin) => {
    calls.push({ prompt, origin })
    return { persona: 'alternative persona', memories: '' }
  }
  events.on('project-memory:resolve', (request) => request.accept(backend))
  const resolved = resolveMemoryProvider({ events }, p.root)
  assert.deepEqual(resolved.prepare('message', context), {
    persona: 'alternative persona',
    memories: '',
  })
  assert.deepEqual(calls, [{ prompt: 'message', origin: context }])
  backend.prepare = (prompt) => ({ persona: `legacy: ${prompt}`, memories: '' })
  assert.equal(resolved.version, 1)
  assert.equal(resolved.prepare('message', context).persona, 'legacy: message')
  assert.equal(resolved.prepare('local').persona, 'legacy: local')
})
