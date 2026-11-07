#!/usr/bin/env node
import readline from 'node:readline'

const input = readline.createInterface({ input: process.stdin })
const write = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`)
if (process.env.FIXTURE_SCENARIO === 'extension-error') {
  write({ type: 'extension_error', error: 'safety extension failed during startup' })
}
write({
  type: 'ready',
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1048576,
  maxReassembledFrameBytes: 67108864,
})
let promptId
input.on('line', (line) => {
  const frame = JSON.parse(line)
  if (frame.type === 'negotiate_protocol') {
    write({
      id: frame.id,
      type: 'response',
      command: frame.type,
      success: true,
      data: { protocolVersion: 2 },
    })
  }
  if (frame.type === 'prompt') {
    promptId = frame.id
    write({
      id: frame.id,
      type: 'response',
      command: 'prompt',
      success: true,
      data: { agentInvoked: true },
    })
    if (process.env.FIXTURE_SCENARIO === 'cancel') {
      return
    }
    if (process.env.FIXTURE_SCENARIO === 'oversized') {
      write({
        type: 'rpc_chunk',
        chunkId: 'oversized',
        index: 0,
        count: 1,
        byteLength: 64 * 1024 * 1024 + 1,
        data: '',
      })
      return
    }
    write({
      type: 'prompt_result',
      id: 'another-prompt',
      status: 'completed',
      sessionSettled: true,
    })
    write({
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'earlier answer' }],
      },
    })
    const final = process.env.FIXTURE_SCENARIO === 'failure' ? 'must not escape' : 'final answer'
    write({
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [{ type: 'text', text: 'intermediate tool call' }],
      },
    })
    write({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: final }] },
    })
    write({ type: 'agent_end', yielded: true, isTerminal: true, messages: [] })
    write({
      type: 'prompt_result',
      id: promptId,
      agentInvoked: true,
      status: process.env.FIXTURE_SCENARIO === 'failure' ? 'error' : 'completed',
      sessionSettled: true,
      error: { message: 'fixture failure' },
    })
  }
  if (frame.type === 'abort') {
    write({ id: frame.id, type: 'response', command: 'abort', success: true })
    write({
      type: 'prompt_result',
      id: promptId,
      agentInvoked: true,
      status: 'aborted',
      sessionSettled: true,
    })
  }
})
