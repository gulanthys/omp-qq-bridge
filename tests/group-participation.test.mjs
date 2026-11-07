import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixture, settle } from './fixtures/host.mjs'

const group = 'group-54321'
const decision = (action, targetMessageId, extra = {}) => ({
  action,
  addressedToBot: false,
  reason: 'model assessment',
  ...(targetMessageId === undefined ? {} : { targetMessageId: String(targetMessageId) }),
  ...extra,
})
const rowPath = (f, self = '10001', chat = '54321') =>
  join(f.root, 'inbox', self, `${Buffer.from(`group-${chat}`).toString('hex')}.json`)
const row = (f, self, chat) => JSON.parse(readFileSync(rowPath(f, self, chat), 'utf8'))
const state = (f, self, chat) => row(f, self, chat).groupConversation
const at = (id = '10001') => ({ type: 'at', data: { qq: id } })
const reactRequests = (f) => f.requests.filter(({ action }) => action === 'set_msg_emoji_like')
function model(f, chosen, { text = 'public answer', status = 'completed', id = group } = {}) {
  f.actor(id).onTurn = async () => {
    if (chosen !== undefined) {
      await f.actor(id).tools.get('qq_reply_gate').execute(chosen)
    }
    f.reply(id, text === null ? undefined : text, 'turn', status)
  }
}
async function exchange(f, id, options = {}, bridge = f.bridge) {
  f.deliver(f.message(id, { type: 'group', ...options }))
  await bridge.flush()
  await settle()
  await bridge.drain()
}

test('an explicit silent decision overrides @ and quote evidence without publishing mood or final prose', async (t) => {
  const f = await fixture(t)
  model(f, decision('reply', 1))
  await exchange(f, 1)
  const botId = state(f).history.find(({ kind }) => kind === 'bot').messageId
  model(f, decision('silent', undefined, { mood: 'quietly interested' }))
  await exchange(f, 2, {
    segments: [
      at(),
      { type: 'reply', data: { id: botId } },
      { type: 'text', data: { text: 'talking to somebody else' } },
    ],
  })
  assert.equal(f.sent.length, 1)
  assert.equal(state(f).mood, 'quietly interested')
  assert.equal(state(f).latestAssessment.outcome, 'silent')
  const latest = state(f).history.at(-1)
  assert.deepEqual(latest.mentions, ['10001'])
  assert.equal(latest.replyToMessageId, botId)
  assert.equal(latest.kind, 'incoming')
})

test('no decision, malformed decisions and unknown targets never authorize even a mentioned reply', async (t) => {
  const f = await fixture(t)
  const invalid = [
    undefined,
    { reply: true },
    decision('reply', 'unseen'),
    decision('react', 1),
    decision('reply', 1, { addressedToBot: 'yes' }),
    decision('silent', undefined, { extra: true }),
  ]
  for (const [index, chosen] of invalid.entries()) {
    model(f, chosen)
    await exchange(f, index + 1, { segments: [at()] })
    assert.equal(state(f).latestAssessment.outcome, 'no_decision')
  }
  assert.equal(f.sent.length, 0)
  assert.equal(reactRequests(f).length, 0)
})

test('the model can choose an unmentioned continuation, contribute once, then observe without a cooldown', async (t) => {
  const f = await fixture(t)
  model(f, decision('reply', 1, { reason: 'worthwhile interest-based addition' }))
  await exchange(f, 1, { text: 'a shared interest' })
  model(
    f,
    decision('reply', 2, {
      addressedToBot: true,
      reason: 'answer continues the exchange without @',
    }),
  )
  await exchange(f, 2, { text: 'yes, that option' })
  model(f, decision('silent', undefined, { reason: 'members now address each other' }))
  await exchange(f, 3, { text: 'member to member exchange' })
  assert.equal(f.sent.length, 2)
  assert.equal(state(f).latestAssessment.action, 'silent')
  assert.equal(state(f).history.filter(({ kind }) => kind === 'bot').length, 2)
})

test('a mixed batch replies to the chosen observed incoming message, not every sender', async (t) => {
  const f = await fixture(t)
  model(f, decision('reply', 12, { quote: true }))
  f.deliver(f.message(11, { type: 'group', user: '22222' }))
  f.deliver(f.message(12, { type: 'group', user: '33333' }))
  await f.bridge.flush()
  await f.bridge.drain()
  assert.equal(f.sent.length, 1)
  assert.deepEqual(f.sent[0].body.message[0], { type: 'reply', data: { id: '12' } })
  assert.deepEqual(
    state(f)
      .history.filter(({ kind }) => kind === 'incoming')
      .map(({ messageId }) => messageId),
    ['11', '12'],
  )
})

test('target binding does not force visible quoting and the model can quote an earlier message explicitly', async (t) => {
  const f = await fixture(t)
  model(f, decision('reply', 1, { quote: false }), { text: 'natural continuation' })
  await exchange(f, 1)
  assert.equal(
    f.sent[0].body.message.some(({ type }) => type === 'reply'),
    false,
  )
  assert.equal(state(f).latestAssessment.targetMessageId, '1')
  assert.equal(state(f).history.at(-1).replyToMessageId, null)

  model(f, decision('reply', 1, { quote: true }), {
    text: 'answering the earlier question\n\nextra detail',
  })
  await exchange(f, 2)
  const quoted = f.sent.slice(1)
  assert.deepEqual(quoted[0].body.message[0], { type: 'reply', data: { id: '1' } })
  assert.equal(
    quoted[1].body.message.some(({ type }) => type === 'reply'),
    false,
  )
  assert.deepEqual(
    state(f)
      .history.filter(({ kind }) => kind === 'bot')
      .slice(-2)
      .map(({ replyToMessageId }) => replyToMessageId),
    ['1', null],
  )
})

test('only confirmed, actually visible bot output enters short-term history', async (t) => {
  const f = await fixture(t)
  model(f, decision('reply', 1), { text: 'first\n\nsecond' })
  await exchange(f, 1)
  assert.deepEqual(
    state(f)
      .history.filter(({ kind }) => kind === 'bot')
      .map(({ text }) => text),
    ['first', 'second'],
  )
  model(f, decision('silent'), { text: 'unsent silent draft' })
  await exchange(f, 2)
  f.requestHook(({ action }) => {
    if (action === 'send_group_msg') {
      throw Error('uncertain send failure')
    }
  })
  model(f, decision('reply', 3), { text: 'failed draft' })
  await exchange(f, 3)
  assert.equal(state(f).latestAssessment.outcome, 'failed')
  assert.match(state(f).latestAssessment.error, /uncertain send failure/)
  assert.deepEqual(
    state(f)
      .history.filter(({ kind }) => kind === 'bot')
      .map(({ text }) => text),
    ['first', 'second'],
  )
  assert.equal(f.requests.filter(({ action }) => action === 'send_group_msg').length, 3)
})

test('no-text silence completes, and no-text reaction uses a real negative target without sending prose', async (t) => {
  const f = await fixture(t)
  model(f, decision('silent', undefined, { mood: 'content' }), { text: null })
  await exchange(f, 1)
  assert.equal(state(f).latestAssessment.outcome, 'silent')
  model(f, decision('react', -2, { emojiId: '128077' }), { text: null })
  await exchange(f, -2)
  assert.deepEqual(
    reactRequests(f).map(({ body }) => body),
    [{ message_id: -2, emoji_id: '128077', set: true }],
  )
  assert.equal(f.sent.length, 0)
  assert.equal(state(f).latestAssessment.outcome, 'reacted')
  assert.equal(state(f).mood, 'content')
  assert.equal(
    state(f).history.some(({ kind }) => kind === 'bot'),
    false,
  )
})

test('reaction rejects bot, unseen and other-group targets; failures have no text substitute or replay', async (t) => {
  const f = await fixture(t)
  model(f, decision('reply', 1))
  await exchange(f, 1)
  const bot = state(f).history.find(({ kind }) => kind === 'bot').messageId
  model(f, decision('silent'), { id: 'group-65432' })
  await exchange(f, 99, { chat: '65432' })
  for (const [index, target] of [bot, '99', 'never-observed'].entries()) {
    model(f, decision('react', target, { emojiId: '128077' }))
    await exchange(f, index + 2)
  }
  assert.equal(reactRequests(f).length, 0)
  f.requestHook(({ action }) => {
    if (action === 'set_msg_emoji_like') {
      throw Error('unsupported reaction')
    }
  })
  model(f, decision('react', 1, { emojiId: '128077' }))
  await exchange(f, 5)
  assert.equal(state(f).latestAssessment.outcome, 'failed')
  assert.match(state(f).latestAssessment.error, /unsupported reaction/)
  assert.equal(reactRequests(f).length, 1)
  assert.equal(f.sent.length, 1)
  await f.bridge.flush()
  assert.equal(reactRequests(f).length, 1)
})

test('history and mood survive restart but stay isolated across group and bot account', async (t) => {
  const f = await fixture(t)
  model(f, decision('silent', undefined, { mood: 'curious' }), { text: null })
  await exchange(f, 1, { text: 'remember only in this short-term group context' })
  await f.bridge.close()
  const restarted = f.mount()
  await exchange(f, 2, {}, restarted)
  const restored = f.contexts.at(-1).context.groupConversation
  assert.deepEqual(
    restored.history.map(({ messageId }) => messageId),
    ['1', '2'],
  )
  assert.equal(restored.mood, 'curious')
  model(f, decision('silent'), { id: 'group-65432', text: null })
  await exchange(f, 3, { chat: '65432' }, restarted)
  assert.deepEqual(
    f.contexts.at(-1).context.groupConversation.history.map(({ messageId }) => messageId),
    ['3'],
  )
  assert.equal(f.contexts.at(-1).context.groupConversation.mood, '')
  f.connect('10002')
  await exchange(f, 4, {}, restarted)
  assert.deepEqual(
    f.contexts.at(-1).context.groupConversation.history.map(({ messageId }) => messageId),
    ['4'],
  )
  assert.equal(f.contexts.at(-1).context.groupConversation.mood, '')
  assert.equal(state(f, '10001').mood, 'curious')
})

test('old inbox rows are accepted without rewriting them just to add conversation state', async (t) => {
  const f = await fixture(t)
  model(f, decision('silent'), { text: null })
  await exchange(f, 1)
  await f.bridge.close()
  const legacy = row(f)
  delete legacy.groupConversation
  delete legacy.groupRevision
  const original = JSON.stringify(legacy)
  writeFileSync(rowPath(f), original)
  const restarted = f.mount()
  await restarted.flush()
  assert.equal(readFileSync(rowPath(f), 'utf8'), original)
  await exchange(f, 2, {}, restarted)
  assert.deepEqual(
    state(f).history.map(({ messageId }) => messageId),
    ['2'],
  )
})

test('history remains bounded and each chosen incoming message appears only once in context', async (t) => {
  const f = await fixture(t, { config: { maxBatchSize: 50 } })
  model(f, decision('silent'), { text: null })
  for (let start = 0; start < 100; start += 50) {
    for (let id = start + 1; id <= start + 50; id++) {
      f.deliver(f.message(id, { type: 'group', text: 'x'.repeat(1000) }))
    }
    await f.bridge.flush()
    await f.bridge.drain()
  }
  const history = state(f).history
  assert.ok(history.length <= 80)
  assert.ok(history.reduce((total, { text }) => total + text.length, 0) <= 24000)
  assert.equal(new Set(history.map(({ messageId }) => messageId)).size, history.length)
  assert.equal(history.at(-1).messageId, '100')
})

test('new input suppresses an old queued proposal and the next context records non-publication', async (t) => {
  const f = await fixture(t)
  let turns = 0
  f.actor(group).onTurn = async () => {
    turns++
    await f
      .actor(group)
      .tools.get('qq_reply_gate')
      .execute(decision(turns === 1 ? 'reply' : 'silent', turns === 1 ? 1 : undefined))
    f.reply(group, 'old uncommitted proposal', `turn-${turns}`)
    if (turns === 1) {
      f.deliver(f.message(2, { type: 'group', text: 'new context' }))
    }
  }
  await exchange(f, 1)
  await f.bridge.flush()
  await f.bridge.drain()
  assert.equal(f.sent.length, 0)
  assert.equal(f.contexts[1].context.groupConversation.latestAssessment.outcome, 'not_published')
  assert.deepEqual(
    state(f).history.map(({ messageId }) => messageId),
    ['1', '2'],
  )
  assert.equal(
    state(f).history.some(({ kind }) => kind === 'bot'),
    false,
  )
})

test('new input during generation suppresses the prior decision without replaying accepted messages', async (t) => {
  const f = await fixture(t)
  const generating = f.defer()
  let turns = 0
  f.actor(group).onTurn = async () => {
    turns++
    const n = turns
    await f
      .actor(group)
      .tools.get('qq_reply_gate')
      .execute(decision(n === 1 ? 'reply' : 'silent', n === 1 ? 1 : undefined))
    if (n === 1) {
      await generating.promise
    }
    f.reply(group, 'obsolete answer', `turn-${n}`)
  }
  f.deliver(f.message(1, { type: 'group' }))
  const flushing = f.bridge.flush()
  await settle()
  f.deliver(f.message(2, { type: 'group' }))
  generating.resolve()
  await flushing
  await settle()
  await f.bridge.flush()
  await f.bridge.drain()
  assert.equal(f.sent.length, 0)
  assert.equal(f.calls.length, 2)
  assert.equal(f.contexts[1].context.groupConversation.latestAssessment.outcome, 'not_published')
})

for (const interruption of ['cancelled', 'failed', 'stop', 'account-change']) {
  test(`${interruption} cannot publish or commit a successful reply or reaction`, async (t) => {
    for (const action of ['reply', 'react']) {
      const f = await fixture(t)
      f.actor(group).onTurn = async () => {
        await f
          .actor(group)
          .tools.get('qq_reply_gate')
          .execute(decision(action, 1, action === 'react' ? { emojiId: '128077' } : {}))
        if (interruption === 'stop') {
          f.bridge.stop()
        }
        if (interruption === 'account-change') {
          f.connect('10002')
        }
        f.reply(
          group,
          'must not escape',
          'interrupted',
          ['cancelled', 'failed'].includes(interruption) ? interruption : 'completed',
        )
      }
      await exchange(f, 1)
      assert.equal(f.sent.length, 0)
      assert.equal(reactRequests(f).length, 0)
      assert.equal(
        state(f).history.some(({ kind }) => kind === 'bot'),
        false,
      )
      assert.ok(['cancelled', 'not_published'].includes(state(f).latestAssessment.outcome))
    }
  })
}

test('a later invalid gate call revokes the earlier proposal rather than retaining permission', async (t) => {
  const f = await fixture(t)
  f.actor(group).onTurn = async () => {
    const gate = f.actor(group).tools.get('qq_reply_gate')
    await gate.execute(decision('reply', 1))
    assert.ok((await gate.execute({ reply: true })).error)
    f.reply(group, 'not authorized')
  }
  await exchange(f, 1)
  assert.equal(f.sent.length, 0)
  assert.equal(state(f).latestAssessment.outcome, 'no_decision')
})

test('a completion without a matching turn start cannot execute a no-text reaction', async (t) => {
  const f = await fixture(t)
  f.actor(group).onTurn = async () => {
    await f
      .actor(group)
      .tools.get('qq_reply_gate')
      .execute(decision('react', 1, { emojiId: '128077' }))
    f.sessionEvent(group, { type: 'turn/end', turn: 'unmatched', status: 'completed' })
    f.reply(group, undefined, 'actual', 'cancelled')
  }
  await exchange(f, 1)
  assert.equal(reactRequests(f).length, 0)
  assert.equal(state(f).latestAssessment.outcome, 'cancelled')
})

test('fresh input suppresses an uncommitted reaction as well as a textual reply', async (t) => {
  const f = await fixture(t)
  let turns = 0
  f.actor(group).onTurn = async () => {
    turns++
    await f
      .actor(group)
      .tools.get('qq_reply_gate')
      .execute(turns === 1 ? decision('react', 1, { emojiId: '128077' }) : decision('silent'))
    f.reply(group, undefined, `reaction-turn-${turns}`)
    if (turns === 1) {
      f.deliver(f.message(2, { type: 'group' }))
    }
  }
  await exchange(f, 1)
  await f.bridge.flush()
  await f.bridge.drain()
  assert.equal(reactRequests(f).length, 0)
  assert.equal(f.contexts[1].context.groupConversation.latestAssessment.outcome, 'not_published')
})

test('a currently visible message remains targetable when it overflows the retained history budget', async (t) => {
  const f = await fixture(t, { config: { maxBatchSize: 50 } })
  model(f, decision('reply', 1, { quote: true }))
  for (let id = 1; id <= 50; id++) {
    f.deliver(f.message(id, { type: 'group', text: 'x'.repeat(1000) }))
  }
  await f.bridge.flush()
  await f.bridge.drain()
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].body.message[0].data.id, '1')
  const snapshot = f.contexts[0].context.groupConversation
  const allIds = [...snapshot.history, ...snapshot.currentMessages].map(
    ({ messageId }) => messageId,
  )
  assert.equal(new Set(allIds).size, 50)
  assert.equal(allIds.length, 50)
})
