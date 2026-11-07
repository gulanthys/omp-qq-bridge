import { mkdtemp, mkdir, cp, copyFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const source = fileURLToPath(new URL('../../', import.meta.url))
export async function project(t, { memory: includeMemory = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'omp-qq-project-'))
  const bridge = join(root, 'omp-qq-bridge')
  const memory = join(root, 'omp-echo-memory')
  await mkdir(bridge)
  await cp(join(source, 'lib'), join(bridge, 'lib'), { recursive: true })
  for (const name of ['index.mjs', 'package.json', 'launch.mjs']) {
    await copyFile(join(source, name), join(bridge, name))
  }
  if (includeMemory) {
    const memorySource = dirname(fileURLToPath(import.meta.resolve('omp-echo-memory')))
    await mkdir(memory)
    for (const name of [
      'launch.mjs',
      'index.mjs',
      'api.mjs',
      'cli.mjs',
      'package.json',
      'persona.example.json',
    ]) {
      await copyFile(join(memorySource, name), join(memory, name))
    }
    await cp(join(memorySource, 'lib'), join(memory, 'lib'), { recursive: true })
    await copyFile(join(memorySource, 'persona.example.json'), join(memory, 'persona.json'))
    await writeFile(
      join(memory, 'project.json'),
      JSON.stringify({ version: 1, projectId: randomUUID(), projectRoot: root }),
    )
  }
  t.after(() => rm(root, { recursive: true, force: true }))
  return {
    root,
    bridge,
    memory,
    extension: () => import(pathToFileURL(join(bridge, 'index.mjs')).href),
  }
}
