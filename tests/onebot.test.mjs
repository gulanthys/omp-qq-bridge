import test from 'node:test'
import assert from 'node:assert/strict'
import { createOneBot } from '../lib/onebot.mjs'
import { onebotServer, qqMessage, until } from './fixtures/onebot.mjs'

async function setup(t, options = {}) {
  const backend = await onebotServer(options)
  const received = []
  const states = []
  const connection = createOneBot({
    url: backend.url,
    token: options.token,
    onEvent: (event) => received.push(event),
    onState: (state) => states.push(state),
  })
  t.after(async () => {
    connection.close()
    await backend.close()
  })
  connection.connect()
  await until(() => connection.status().ready, 'OneBot ready')
  return { backend, connection, received, states }
}

test('new private and group events arrive without querying contacts or histories', async (t) => {
  const f = await setup(t, { token: 'private-test-token' })
  f.backend.event(qqMessage(1, { user: 23456 }))
  f.backend.event(qqMessage(2, { user: 34567, group: 45678 }))
  await until(() => f.received.length === 2, 'all live events')
  assert.deepEqual(
    f.received.map((event) => event.message_id),
    [1, 2],
  )
  assert.equal(
    f.backend.requests.some((packet) => /history|friend_list|group_list/.test(packet.action)),
    false,
  )
  assert.equal(JSON.stringify(f.states).includes('private-test-token'), false)
})

test('events racing the login handshake are delivered after identity confirmation', async (t) => {
  const f = await setup(t, { onConnect: (_client, event) => event(qqMessage(1, { user: 23456 })) })
  await until(() => f.received.length === 1)
  assert.equal(f.received[0].message_id, 1)
})

test('echo correlation handles responses in reverse order', async (t) => {
  const f = await setup(t)
  f.backend.handle((packet) =>
    packet.action === 'read_a' || packet.action === 'read_b' ? false : undefined,
  )
  const a = f.connection.request('read_a', {})
  const b = f.connection.request('read_b', {})
  await until(() => f.backend.requests.some((packet) => packet.action === 'read_b'))
  const client = [...f.backend.clients][0]
  const pa = f.backend.requests.find((packet) => packet.action === 'read_a')
  const pb = f.backend.requests.find((packet) => packet.action === 'read_b')
  client.send(JSON.stringify({ status: 'ok', retcode: 0, echo: pb.echo, data: 'B' }))
  client.send(JSON.stringify({ status: 'ok', retcode: 0, echo: pa.echo, data: 'A' }))
  assert.deepEqual(await Promise.all([a, b]), ['A', 'B'])
})

test('disconnect rejects uncertain sends and reconnect never resends them', async (t) => {
  const f = await setup(t)
  f.backend.handle((packet) => (packet.action === 'send_private_msg' ? false : undefined))
  const pending = f.connection.request('send_private_msg', { user_id: 23456, message: 'once' })
  const rejection = assert.rejects(pending)
  await until(() => f.backend.requests.some((packet) => packet.action === 'send_private_msg'))
  const epoch = f.connection.status().epoch
  f.backend.disconnect()
  await rejection
  await until(
    () => f.connection.status().ready && f.connection.status().epoch > epoch,
    'reconnected',
  )
  assert.equal(
    f.backend.requests.filter((packet) => packet.action === 'send_private_msg').length,
    1,
  )
  f.backend.event(qqMessage(4, { user: 23456 }))
  await until(() => f.received.length === 1)
})

test('a changed account is reauthenticated before its first event is released', async (t) => {
  const f = await setup(t)
  const epoch = f.connection.status().epoch
  f.backend.identity('20002')
  f.backend.event(qqMessage(5, { selfId: 20002, user: 23456 }))
  await until(
    () => f.connection.status().ready && f.connection.status().selfId === '20002',
    'new account authenticated',
  )
  await until(() => f.received.length === 1)
  assert.equal(f.received[0].self_id, 20002)
  assert.ok(f.connection.status().epoch > epoch)
})

test('a cached self nickname is cleared on disconnect and cannot leak into an unnamed account', async (t) => {
  const f = await setup(t)
  f.backend.handle((packet) =>
    packet.action === 'get_login_info'
      ? { status: 'ok', retcode: 0, data: { user_id: 10001, nickname: 'former account name' } }
      : undefined,
  )
  f.backend.disconnect()
  await until(
    () =>
      f.connection.status().ready && f.connection.status().selfNickname === 'former account name',
  )
  const epoch = f.connection.status().epoch
  f.backend.handle(() => undefined)
  f.backend.identity('20002')
  f.backend.event(qqMessage(5, { selfId: 20002, user: 23456 }))
  await until(() => f.connection.status().ready && f.connection.status().selfId === '20002')
  assert.equal(f.connection.status().selfNickname, null)
  assert.ok(
    f.states
      .filter((state) => state.epoch > epoch && !state.ready)
      .every((state) => state.selfNickname === null),
  )
  await until(() => f.received.length === 1)
  assert.equal(f.received[0].self_id, 20002)
})

test('request cancellation and timeout do not retry backend actions', async (t) => {
  const f = await setup(t)
  f.backend.handle((packet) => (packet.action === 'held_action' ? false : undefined))
  const controller = new AbortController()
  const pending = f.connection.request('held_action', {}, { signal: controller.signal })
  const rejected = assert.rejects(pending)
  await until(() => f.backend.requests.some((packet) => packet.action === 'held_action'))
  controller.abort()
  await rejected
  await assert.rejects(f.connection.request('held_action', {}, { timeout: 20 }))
  assert.equal(f.backend.requests.filter((packet) => packet.action === 'held_action').length, 2)
})

test('a stopped connection cannot dispatch more events or invoke APIs', async (t) => {
  const f = await setup(t)
  f.connection.close()
  f.backend.event(qqMessage(6, { user: 23456 }))
  await assert.rejects(f.connection.request('get_login_info', {}))
  assert.equal(f.received.length, 0)
  assert.equal(f.connection.status().ready, false)
})

test('a durable sink failure stops acceptance instead of silently dropping subsequent messages', async (t) => {
  const f = await setup(t)
  f.connection.onEvent(() => {
    throw new Error('disk unavailable')
  })
  f.backend.event(qqMessage(7, { user: 23456 }))
  await until(() => !f.connection.status().ready)
  await assert.rejects(f.connection.request('get_login_info', {}))
  assert.equal(f.connection.status().connected, false)
})

test('wrong credentials cannot release events and never appear in public diagnostics', async (t) => {
  const backend = await onebotServer({ token: 'required-secret' })
  const received = []
  const connection = createOneBot({
    url: backend.url,
    token: 'wrong-secret',
    onEvent: (event) => received.push(event),
  })
  t.after(async () => {
    connection.close()
    await backend.close()
  })
  connection.connect()
  await until(() => connection.status().lastError !== null, 'authentication rejection')
  backend.event(qqMessage(1))
  await assert.rejects(connection.request('get_login_info', {}))
  assert.equal(received.length, 0)
  assert.equal(connection.status().ready, false)
  assert.equal(JSON.stringify(connection.status()).includes('wrong-secret'), false)
})

test('missing login identity fails closed even when message frames claim a self ID', async (t) => {
  const backend = await onebotServer({ onConnect: (_client, event) => event(qqMessage(1)) })
  const received = []
  backend.handle((packet) =>
    packet.action === 'get_login_info' ? { status: 'ok', retcode: 0, data: {} } : undefined,
  )
  const connection = createOneBot({ url: backend.url, onEvent: (event) => received.push(event) })
  t.after(async () => {
    connection.close()
    await backend.close()
  })
  connection.connect()
  await until(() => connection.status().lastError !== null, 'unknown login identity')
  assert.equal(connection.status().ready, false)
  assert.equal(received.length, 0)
})
