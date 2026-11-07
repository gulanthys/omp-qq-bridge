import { spawn } from 'node:child_process'
import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { plainPath } from './lib/config.mjs'

const pluginDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = realpathSync.native(resolve(pluginDir, '..'))
const key = (path) => (process.platform === 'win32' ? path.toLowerCase() : path)

export function buildLaunchPlan(args = [], environment = process.env) {
  if (key(realpathSync.native(process.cwd())) !== key(projectRoot)) {
    throw new Error('QQ 桥接启动器只允许在所属项目根目录运行')
  }
  plainPath(pluginDir)
  const options = []
  const extensions = [join(pluginDir, 'index.mjs')]
  const extensionKeys = new Set(extensions.map(key))
  const values = {
    '--mode': new Set(['text', 'json', 'rpc', 'rpc-ui']),
    '--thinking': new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto']),
  }
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === '--no-ui') {
      options.push(flag)
      continue
    }
    if (!['--mode', '--thinking', '--model', '-e', '--extension'].includes(flag)) {
      throw new Error(`启动器不允许 ${flag}；只能选择模型、模式和本项目扩展，不能覆盖数据目录`)
    }
    const value = args[++index]
    if (typeof value !== 'string' || !value || value.startsWith('-')) {
      throw new Error(`${flag} 缺少有效值`)
    }
    if (flag === '-e' || flag === '--extension') {
      const file = resolve(projectRoot, value)
      const rel = relative(projectRoot, file)
      if (!rel || rel.startsWith('..') || isAbsolute(rel) || !/\.(?:[cm]?js|tsx?)$/i.test(file)) {
        throw new Error('扩展必须是当前项目内部的 JavaScript/TypeScript 文件')
      }
      plainPath(file)
      if (!statSync(file).isFile()) {
        throw new Error('扩展路径必须是普通文件')
      }
      const canonical = realpathSync.native(file)
      if (extensionKeys.has(key(canonical))) {
        throw new Error('不能重复加载同一个扩展')
      }
      extensionKeys.add(key(canonical))
      extensions.push(canonical)
    } else {
      if (values[flag] && !values[flag].has(value)) {
        throw new Error(`${flag} 的值无效`)
      }
      options.push(flag, value)
    }
  }
  const runtime = join(pluginDir, '.runtime')
  const agentDir = join(runtime, 'omp')
  const sessionDir = join(runtime, 'sessions')
  for (const directory of [runtime, agentDir, sessionDir]) {
    plainPath(directory)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  const overlay = join(runtime, 'omp-config.yml')
  plainPath(overlay)
  writeFileSync(overlay, 'memory:\n  backend: off\nautolearn:\n  enabled: false\n', { mode: 0o600 })
  const env = {
    ...environment,
    OMP_PROJECT_ROOT: projectRoot,
    OMP_PROJECT_AGENT_DIR: agentDir,
    OMP_PROJECT_SESSION_DIR: sessionDir,
    PI_CODING_AGENT_DIR: agentDir,
    PI_NO_TITLE: '1',
  }
  delete env.OMP_PROFILE
  return {
    command: 'omp',
    cwd: projectRoot,
    env,
    args: [
      '--cwd',
      projectRoot,
      '--session-dir',
      sessionDir,
      '--config',
      overlay,
      '--no-extensions',
      ...extensions.flatMap((file) => ['-e', file]),
      '--no-skills',
      '--no-rules',
      '--no-context-files',
      '--no-lsp',
      '--no-title',
      '--approval-mode',
      'always-ask',
      ...options,
    ],
  }
}

export function launch(args = process.argv.slice(2)) {
  const plan = buildLaunchPlan(args)
  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    stdio: 'inherit',
    shell: false,
  })
  child.on('error', (error) => {
    console.error(`无法启动本项目 omp：${error.message}`)
    process.exitCode = 1
  })
  child.on('exit', (code) => {
    process.exitCode = code ?? 1
  })
  return child
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    launch()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
