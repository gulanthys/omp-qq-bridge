import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Copied into a temporary project by the real-omp integration smoke.
export default function alternateMemory(pi) {
  const projectRoot = dirname(fileURLToPath(import.meta.url))
  const file = join(projectRoot, '.alternate-memory.json')
  const read = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null)
  const provider = {
    version: 1,
    id: 'alternate-memory',
    projectRoot,
    tools: [
      {
        name: 'remember_note',
        label: 'Store a project note',
        description: 'Save a shared note only after local operator approval.',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
      },
      {
        name: 'recall_note',
        label: 'Recall the shared note',
        description: 'Read the previously approved project note.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
    prepare(_prompt, context) {
      if (context && Object.hasOwn(context, 'groupConversation')) {
        throw new Error('Recent conversation must not enter privileged provider origin')
      }
      return { persona: 'ALTERNATE_PROJECT_PERSONA', memories: read()?.text || '' }
    },
    async execute(name, args, { origin, signal, requestConsent }) {
      signal.throwIfAborted()
      if (name === 'recall_note') {
        return read()
      }
      if (name !== 'remember_note' || typeof args.text !== 'string') {
        throw new Error('Invalid alternate-provider operation')
      }
      const approved = await requestConsent({
        title: 'Alternate project memory approval',
        description: `${origin}\n${args.text}`,
        signal,
      })
      signal.throwIfAborted()
      if (approved !== true) {
        throw new Error('Local operator denied the shared note')
      }
      const note = { text: args.text }
      writeFileSync(file, JSON.stringify(note), { mode: 0o600 })
      return note
    },
  }
  pi.events.on('project-memory:resolve', (request) => {
    if (request?.version === 1 && request.projectRoot === projectRoot) {
      request.accept(provider)
    }
  })
}
