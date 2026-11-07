import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, settle } from './fixtures/host.mjs'

test('pre-acceptance failure preserves input and retries only after backoff', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  const f = await fixture(t)
  const agent = f.actor('private-12345')
  agent.follow = () => {
    throw Error('pre-accept failure')
  }
  f.deliver(f.message(1))
  await f.bridge.flush()
  await settle()
  assert.equal(f.calls.length, 1)
  agent.follow = null
  await f.bridge.flush()
  assert.equal(f.calls.length, 1)
  t.mock.timers.tick(2000)
  await f.bridge.flush()
  await settle()
  assert.equal(f.calls.length, 2)
})

test('accepted input is not replayed after a provider failure', async (t) => {
  const f = await fixture(t)
  const agent = f.actor('private-12345')
  agent.flush = () => {
    throw Error('provider failed after acceptance')
  }
  f.deliver(f.message(2))
  await f.bridge.flush()
  await settle()
  assert.equal(f.calls.length, 1)
  await f.bridge.flush()
  assert.equal(f.calls.length, 1)
})

test('late acceptance consumes only its batch while a queued next message survives reconnect', async (t) => {
  const f = await fixture(t)
  const wait = f.defer()
  const agent = f.actor('private-12345')
  agent.follow = () => wait.promise
  f.deliver(f.message(3))
  const pending = f.bridge.flush()
  await settle()
  f.deliver(f.message(4))
  f.disconnect()
  wait.resolve()
  await pending
  agent.follow = null
  f.connect()
  await f.bridge.flush()
  await settle()
  assert.equal(f.calls.length, 2)
  assert.match(f.calls[1].prompt, /message-4/)
  assert.doesNotMatch(f.calls[1].prompt, /message-3/)
})

test('accepted inbox survives restart as deduplication state', async (t) => {
  const f = await fixture(t)
  const event = f.message(8)
  f.deliver(event)
  await f.bridge.flush()
  await settle()
  f.bridge.stop()
  const second = f.mount()
  f.deliver(event)
  await second.flush()
  await settle()
  assert.equal(f.calls.length, 1)
})

test('another account cannot consume queued input; the original account resumes without a new event', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  const f = await fixture(t)
  const agent = f.actor('private-12345')
  agent.follow = () => {
    throw Error('keep pending')
  }
  f.deliver(f.message(9))
  await f.bridge.flush()
  await settle()
  f.disconnect()
  f.connect('30003')
  await f.bridge.flush()
  await settle()
  assert.equal(f.calls.length, 1)
  agent.follow = null
  f.disconnect()
  f.connect('10001')
  t.mock.timers.tick(2000)
  await f.bridge.flush()
  await settle()
  assert.equal(f.calls.length, 2)
  assert.match(f.calls[1].prompt, /message-9/)
})

test('late old completion after reconnect is suppressed while the next turn replies', async (t) => {
  const f = await fixture(t)
  const agent = f.actor('private-12345')
  const wait = f.defer()
  let n = 0
  agent.onTurn = async () => {
    if (++n === 1) {
      await wait.promise
      f.reply('private-12345', 'old answer', 'old-turn')
    } else {
      f.reply('private-12345', 'new answer', 'new-turn')
    }
  }
  f.deliver(f.message(10))
  const oldWork = f.bridge.flush()
  await settle()
  f.disconnect()
  f.connect()
  wait.resolve()
  await oldWork
  assert.equal(f.sent.length, 0)
  f.deliver(f.message(11))
  await f.bridge.flush()
  await f.bridge.drain()
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].body.message[0].data.text, 'new answer')
})

test('stop after the first outbound paragraph prevents later segments', async (t) => {
  const f = await fixture(t)
  const agent = f.actor('private-12345')
  agent.onTurn = () => f.reply('private-12345', 'first paragraph\n\nsecond paragraph', 'outbound')
  f.requestHook((request) => {
    if (request.action === 'send_private_msg') {
      f.bridge.stop()
    }
  })
  f.deliver(f.message(12))
  await f.bridge.flush()
  await f.bridge.drain()
  assert.equal(f.sent.length, 1)
})
