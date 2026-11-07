import { WebSocketServer } from 'ws'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

export async function until(predicate, label = 'condition', timeout = 10000) {
  const end = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > end) {
      throw new Error(`${label} timed out`)
    }
    await delay(10)
  }
}
export async function onebotServer({ token = '', selfId = '10001', onConnect } = {}) {
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    verifyClient: ({ req }) =>
      new URL(req.url, 'http://local').searchParams.get('access_token') === (token || null),
  })
  await once(server, 'listening')
  const requests = []
  const sent = []
  // Explicit protocol simulation: only observed group messages support QQ reactions.
  const groupMessages = new Set()
  const reactions = new Map()
  const clients = new Set()
  let id = 80000
  let handler
  let account = String(selfId)
  function event(value, client) {
    if (value.message_type === 'group' && value.group_id !== undefined) {
      groupMessages.add(`${account}:${String(value.message_id)}`)
    }
    const data = JSON.stringify({
      self_id: Number(account),
      time: Math.floor(Date.now() / 1000),
      ...value,
    })
    for (const socket of client ? [client] : clients) {
      if (socket.readyState === 1) {
        socket.send(data)
      }
    }
  }
  server.on('connection', (client) => {
    clients.add(client)
    client.on('close', () => clients.delete(client))
    client.on('message', async (data) => {
      const packet = JSON.parse(data.toString())
      requests.push(packet)
      try {
        const response = await handler?.(packet, client)
        if (response === false) {
          return
        }
        let result
        if (response !== undefined) {
          result = response
        } else if (packet.action === 'get_login_info') {
          result = { status: 'ok', retcode: 0, data: { user_id: Number(account) } }
        } else if (['send_private_msg', 'send_group_msg'].includes(packet.action)) {
          sent.push(packet)
          result = { status: 'ok', retcode: 0, data: { message_id: ++id } }
          const own = {
            post_type: 'message_sent',
            message_type: packet.action === 'send_group_msg' ? 'group' : 'private',
            user_id: Number(account),
            message_id: id,
            message: packet.params.message,
            ...(packet.action === 'send_group_msg' ? { group_id: packet.params.group_id } : {}),
          }
          event(own, client)
          event({ ...own, post_type: 'message' }, client)
        } else if (packet.action === 'set_msg_emoji_like') {
          const { message_id: messageId, emoji_id: emojiId, set } = packet.params
          const key = `${account}:${String(messageId)}`
          if (
            !groupMessages.has(key) ||
            typeof emojiId !== 'string' ||
            !/^\d+$/.test(emojiId) ||
            typeof set !== 'boolean'
          ) {
            result = { status: 'failed', retcode: 1400, data: null }
          } else {
            const likes = reactions.get(key) || new Map()
            if (set) {
              likes.set(emojiId, {
                emoji_id: emojiId,
                emoji_type: '1',
                count: 1,
                users: [{ user_id: Number(account) }],
              })
            } else {
              likes.delete(emojiId)
            }
            reactions.set(key, likes)
            result = { status: 'ok', retcode: 0, data: null }
          }
        } else if (packet.action === 'get_msg_emoji_likes') {
          const key = `${account}:${String(packet.params.message_id)}`
          result = groupMessages.has(key)
            ? { status: 'ok', retcode: 0, data: [...(reactions.get(key)?.values() || [])] }
            : { status: 'failed', retcode: 1400, data: null }
        } else {
          result = { status: 'failed', retcode: 1404, data: null }
        }
        if (client.readyState === 1) {
          client.send(JSON.stringify({ ...result, echo: packet.echo }))
        }
      } catch {
        if (client.readyState === 1) {
          client.send(
            JSON.stringify({ status: 'failed', retcode: 1500, data: null, echo: packet.echo }),
          )
        }
      }
    })
    onConnect?.(client, event)
  })
  return {
    url: `ws://127.0.0.1:${server.address().port}`,
    requests,
    sent,
    reactions,
    clients,
    event,
    handle: (fn) => {
      handler = fn
    },
    identity: (id) => {
      account = String(id)
    },
    disconnect: () => {
      for (const client of clients) {
        client.terminate()
      }
    },
    close: async () => {
      for (const client of clients) {
        client.terminate()
      }
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
export function qqMessage(
  id,
  {
    user = 12345,
    group,
    text = 'QQ message ' + id,
    segments,
    selfId = 10001,
    subType = 'friend',
    sourceGroup,
  } = {},
) {
  return {
    post_type: 'message',
    self_id: selfId,
    time: Math.floor(Date.now() / 1000),
    message_id: id,
    user_id: user,
    message_type: group ? 'group' : 'private',
    sub_type: group ? 'normal' : subType,
    ...(group ? { group_id: group } : sourceGroup ? { group_id: sourceGroup } : {}),
    sender: { user_id: user, nickname: 'member-' + user },
    message: segments || [{ type: 'text', data: { text } }],
  }
}
