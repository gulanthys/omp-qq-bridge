import test from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, rm, access, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OmpAgent } from '../lib/omp-rpc.mjs'

const fixture = fileURLToPath(new URL('./fixtures/omp-rpc-child.mjs', import.meta.url))
const spawn = childProcess.spawn
async function agentFor(t, scenario = 'success', options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'omp-rpc-boundary-'))
  const mock = t.mock.method(childProcess, 'spawn', (_command, args, spawnOptions) =>
    spawn(process.execPath, [fixture, ...args], spawnOptions),
  )
  syncBuiltinESMExports()
  const events = []
  const modelSource = options.modelSource || {
    executable: process.execPath,
    model: {
      provider: 'fixture-provider',
      id: 'fixture-model',
      api: 'openai-completions',
      baseUrl: 'https://example.invalid/v1',
      supportsTools: true,
    },
    getAuth: async () => ({
      apiKey: 'secret-fixture-key',
      headers: { 'x-private': 'secret-header' },
      env: {},
    }),
  }
  const agent = new OmpAgent({
    id: 'private',
    cwd: root,
    agentDir: join(root, 'agent'),
    sessionDir: join(root, 'sessions'),
    command: 'protocol-fixture',
    modelSource,
    env: { FIXTURE_SCENARIO: scenario },
    callbackUrl: options.callbackUrl,
    callbackToken: options.callbackToken,
    timeoutMs: 5000,
    onEvent: (session, event) => events.push({ session, event }),
  })
  t.after(async () => {
    await agent.close()
    mock.mock.restore()
    syncBuiltinESMExports()
    await rm(root, { recursive: true, force: true })
  })
  return { agent, events, root, mock, modelSource }
}

test('remote commands are rejected without creating agent state', async (t) => {
  const { agent } = await agentFor(t)
  await assert.rejects(agent.followup('/help'))
  await assert.rejects(agent.followup('!whoami'))
  await assert.rejects(access(agent.agentDir))
})

test('reply decisions require a registered live host gate and never fabricate success', async (t) => {
  const { agent } = await agentFor(t)
  const decision = { action: 'silent', addressedToBot: false, reason: 'observe' }
  await assert.rejects(agent.executeTool('qq_reply_gate', decision), /未知桥接工具/)
  const calls = []
  const unregister = agent.registerTool({
    name: 'qq_reply_gate',
    execute(args, { signal }) {
      calls.push({ args, signal })
      return { action: args.action, accepted: true }
    },
  })
  const controller = new AbortController()
  assert.deepEqual(
    await agent.executeTool('qq_reply_gate', decision, { signal: controller.signal }),
    { action: 'silent', accepted: true },
  )
  assert.deepEqual(calls, [{ args: decision, signal: controller.signal }])
  controller.abort()
  await assert.rejects(
    agent.executeTool('qq_reply_gate', decision, { signal: controller.signal }),
    /取消/,
  )
  assert.equal(calls.length, 1)
  unregister()
  await assert.rejects(agent.executeTool('qq_reply_gate', decision), /未知桥接工具/)
})

test('only the final answer escapes after the matching successful prompt result', async (t) => {
  const { agent, events } = await agentFor(t)
  await agent.followup('hello')
  assert.deepEqual(
    events
      .filter((item) => item.event.type === 'assistant/message')
      .map((item) => item.event.message.content),
    [[{ type: 'text', text: 'final answer' }]],
  )
  assert.equal(events.at(-1).event.status, 'completed')
})

test('provider failure rejects accepted work and never sends its apparent answer', async (t) => {
  const { agent, events } = await agentFor(t, 'failure')
  await assert.rejects(agent.followup('hello'), (error) => error.accepted === true)
  assert.equal(
    events.some((item) => item.event.type === 'assistant/message'),
    false,
  )
  assert.equal(events.at(-1).event.status, 'failed')
})

test('cancelled work rejects and cannot produce a completed reply', async (t) => {
  const { agent, events } = await agentFor(t, 'cancel')
  const admitted = Promise.withResolvers()
  const pending = agent.followup('hello', { onAccepted: admitted.resolve })
  const rejection = assert.rejects(pending, (error) => error.accepted === true)
  await admitted.promise
  await agent.cancel()
  await rejection
  assert.equal(
    events.some((item) => item.event.type === 'assistant/message'),
    false,
  )
  assert.equal(
    events.some((item) => item.event.status === 'completed'),
    false,
  )
})

test('an oversized transport declaration rejects the turn without exposing output', async (t) => {
  const { agent, events } = await agentFor(t, 'oversized')
  await assert.rejects(agent.followup('hello'), (error) => error.accepted === true)
  assert.equal(
    events.some((item) => item.event.type === 'assistant/message'),
    false,
  )
})

test('closing while authentication is pending rejects promptly without creating session state', async (t) => {
  const auth = Promise.withResolvers()
  const modelSource = {
    executable: process.execPath,
    model: {
      provider: 'fixture',
      id: 'probe',
      api: 'openai-completions',
      baseUrl: 'https://example.invalid/v1',
    },
    getAuth: () => auth.promise,
  }
  const { agent } = await agentFor(t, 'success', { modelSource })
  let rejected = false
  const pending = agent.followup('hello').catch(() => {
    rejected = true
  })
  await new Promise(setImmediate)
  await agent.close()
  await new Promise(setImmediate)
  assert.equal(rejected, true)
  auth.resolve({ apiKey: 'late-private-key', headers: {} })
  await pending
  await assert.rejects(access(agent.agentDir))
})

test('a failed safety extension cannot admit QQ work even when RPC reports ready', async (t) => {
  const { agent, events } = await agentFor(t, 'extension-error')
  let admitted = false
  await assert.rejects(
    agent.followup('read something', {
      onAccepted: () => {
        admitted = true
      },
    }),
  )
  assert.equal(admitted, false)
  assert.equal(
    events.some((item) => item.event.type === 'assistant/message'),
    false,
  )
})

test('each callback-enabled prompt gets a distinct parent ticket and out-of-band turn context', async (t) => {
  const { agent, events } = await agentFor(t, 'success', {
    callbackUrl: 'http://127.0.0.1:12345',
    callbackToken: 'local-fixture-token',
  })
  const contexts = [
    { origin: { channel: 'qq', messages: [{ messageId: 'owner', senderId: '33333' }] }, epoch: 1 },
    { origin: { channel: 'qq', messages: [{ messageId: 'other', senderId: '22222' }] }, epoch: 2 },
  ]
  const frames = []
  const send = agent.send.bind(agent)
  t.mock.method(agent, 'send', (frame) => {
    frames.push(frame)
    return send(frame)
  })
  const tickets = []
  for (const context of contexts) {
    await agent.followup('unchanged QQ message text', { context })
    tickets.push(JSON.parse(await readFile(join(agent.agentDir, 'callback-turn.json'), 'utf8')))
  }
  const starts = events.filter(({ event }) => event.type === 'turn/start')
  assert.notEqual(tickets[0].turn, tickets[1].turn)
  assert.deepEqual(
    tickets,
    starts.map(({ event }) => ({ turn: event.turn })),
  )
  assert.deepEqual(
    starts.map(({ event }) => event.context),
    contexts,
  )
  for (const frame of frames.filter((frame) => frame.type === 'prompt')) {
    assert.equal(frame.message, 'unchanged QQ message text')
    assert.equal(Object.hasOwn(frame, 'context'), false)
  }
})
