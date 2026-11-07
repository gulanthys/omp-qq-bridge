import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, settle } from './fixtures/host.mjs'

test('own text, @, image and message_sent never reach parsing or the model', async (t) => {
  const f = await fixture(t)
  const download = t.mock.method(globalThis, 'fetch', () => {
    throw Error('own image must not be fetched')
  })
  for (const type of ['private', 'group']) {
    for (const segments of [
      [{ type: 'text', data: { text: 'self' } }],
      [{ type: 'image', data: { url: 'https://invalid.local/own.png' } }],
      [
        { type: 'at', data: { qq: '10001' } },
        { type: 'text', data: { text: 'self' } },
      ],
    ]) {
      f.deliver(f.message(type + '-' + segments[0].type, { type, user: '10001', segments }))
    }
  }
  f.deliver({ ...f.message('sent'), post_type: 'message_sent' })
  await f.bridge.flush()
  await settle()
  assert.equal(f.calls.length, 0)
  assert.equal(download.mock.callCount(), 0)
})

test('events arriving during a slow model turn remain queued and are processed in order', async (t) => {
  const f = await fixture(t)
  const agent = f.actor('private-12345')
  const wait = f.defer()
  agent.follow = () => wait.promise
  f.deliver(f.message(1))
  const first = f.bridge.flush()
  await settle()
  f.deliver(f.message(2))
  f.deliver(f.message(3))
  await f.bridge.flush()
  assert.equal(f.calls.length, 1)
  agent.follow = null
  wait.resolve()
  await first
  await f.bridge.flush()
  await settle()
  assert.equal(f.calls.length, 2)
  assert.match(f.calls[1].prompt, /message-2/)
  assert.match(f.calls[1].prompt, /message-3/)
  assert.doesNotMatch(f.calls[1].prompt, /message-1/)
})

for (const source of ['group_id', 'temp_source']) {
  test(`temporary private ${source} replies to the sender with the original group source`, async (t) => {
    const f = await fixture(t)
    const agent = f.actor('private-12345')
    const event = f.message(1)
    event.sub_type = 'group'
    if (source === 'group_id') {
      event.group_id = '54321'
    } else {
      event.temp_source = { group_id: '54321' }
    }
    agent.onTurn = () => f.reply('private-12345', 'temporary reply')
    f.deliver(event)
    await f.bridge.flush()
    await f.bridge.drain()
    assert.equal(f.calls[0].id, 'private-12345')
    assert.equal(f.sent[0].body.user_id, 12345)
    assert.equal(f.sent[0].body.group_id, 54321)
  })
}

test('nested forward content actually reaches the correct conversation', async (t) => {
  const f = await fixture(t)
  f.requestHook((request) =>
    request.action === 'get_forward_msg'
      ? {
          messages: [
            {
              sender: { nickname: 'forwarded' },
              content:
                request.body.message_id === 'outer'
                  ? [
                      { type: 'text', data: { text: 'OUTER_NOTE' } },
                      { type: 'forward', data: { id: 'inner' } },
                    ]
                  : [{ type: 'text', data: { text: 'INNER_NOTE' } }],
            },
          ],
        }
      : undefined,
  )
  f.deliver(f.message(1, { segments: [{ type: 'forward', data: { id: 'outer' } }] }))
  await f.bridge.flush()
  await settle()
  assert.match(f.calls[0].prompt, /OUTER_NOTE/)
  assert.match(f.calls[0].prompt, /INNER_NOTE/)
})

test('a forward timeout keeps the original event pending until its contents can be read', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  const f = await fixture(t)
  f.requestHook((request) => {
    if (request.action === 'get_forward_msg') {
      throw Object.assign(Error('deadline'), { code: 'ONEBOT_TIMEOUT' })
    }
  })
  f.deliver(f.message(5, { segments: [{ type: 'forward', data: { id: 'timed-forward' } }] }))
  await f.bridge.flush()
  await settle()
  assert.equal(f.calls.length, 0)
  f.requestHook((request) =>
    request.action === 'get_forward_msg'
      ? {
          messages: [
            {
              sender: { nickname: 'recovered' },
              content: [{ type: 'text', data: { text: 'RECOVERED_FORWARD' } }],
            },
          ],
        }
      : undefined,
  )
  t.mock.timers.tick(2000)
  await f.bridge.flush()
  await settle()
  assert.equal(f.calls.length, 1)
  assert.match(f.calls[0].prompt, /RECOVERED_FORWARD/)
})
