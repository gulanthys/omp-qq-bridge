import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'

export function samePath(left, right) {
  const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)
  return normalize(realpathSync.native(left)) === normalize(realpathSync.native(right))
}

export function plainPath(path) {
  const parent = dirname(path)
  if (parent !== path) {
    plainPath(parent)
  }
  if (!existsSync(path)) {
    return
  }
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || (!stat.isDirectory() && stat.nlink !== 1)) {
    throw new Error(`拒绝链接数据路径：${path}`)
  }
}

export function writeJson(path, data) {
  plainPath(path)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  let fd
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(data, null, 2) + '\n', 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, path)
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
    if (existsSync(temporary)) {
      unlinkSync(temporary)
    }
  }
}

export function settingsPaths(projectRoot) {
  const root = realpathSync.native(resolve(projectRoot))
  const directory = join(root, 'omp-qq-bridge', '.runtime')
  plainPath(directory)
  return { projectRoot: root, directory, settingsFile: join(directory, 'settings.json') }
}

export function defaultSettings(projectRoot) {
  const paths = settingsPaths(projectRoot)
  return {
    version: 4,
    projectRoot: paths.projectRoot,
    enabled: false,
    onebotUrl: 'ws://127.0.0.1:3001',
    token: '',
    speechCommand: '',
  }
}

export function validateSettings(projectRoot, draft) {
  const paths = settingsPaths(projectRoot)
  if (
    !draft ||
    draft.version !== 4 ||
    typeof draft.projectRoot !== 'string' ||
    !samePath(draft.projectRoot, paths.projectRoot)
  ) {
    throw new Error('桥接设置的版本或项目身份不匹配')
  }
  const allowed = new Set([
    'version',
    'projectRoot',
    'enabled',
    'onebotUrl',
    'token',
    'speechCommand',
  ])
  if (Object.keys(draft).some((key) => !allowed.has(key))) {
    throw new Error('设置包含不支持的字段；所有私聊与群聊均自动接入')
  }
  if (typeof draft.enabled !== 'boolean') {
    throw new Error('桥接开关必须是布尔值')
  }
  let url
  try {
    url = new URL(draft.onebotUrl)
  } catch {
    throw new Error('OneBot 地址必须是完整 WebSocket 地址')
  }
  if (
    !['ws:', 'wss:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('OneBot 地址不能含用户名、密码、查询凭据或片段；使用独立 Token 字段')
  }
  if (
    typeof draft.token !== 'string' ||
    draft.token.length > 4096 ||
    /[\r\n\0]/.test(draft.token)
  ) {
    throw new Error('OneBot Token 格式无效')
  }
  if (
    draft.speechCommand !== undefined &&
    (typeof draft.speechCommand !== 'string' ||
      draft.speechCommand.length > 1000 ||
      /[\r\n\0]/.test(draft.speechCommand) ||
      (draft.speechCommand && !draft.speechCommand.includes('{file}')))
  ) {
    throw new Error('语音转写命令必须包含 {file}，且为单行本机命令')
  }
  return {
    version: 4,
    projectRoot: paths.projectRoot,
    enabled: draft.enabled,
    onebotUrl: url.href.replace(/\/$/, ''),
    token: draft.token.trim(),
    speechCommand: draft.speechCommand || '',
  }
}

export function readSettings(projectRoot) {
  const paths = settingsPaths(projectRoot)
  plainPath(paths.settingsFile)
  if (!existsSync(paths.settingsFile)) {
    return null
  }
  const draft = JSON.parse(readFileSync(paths.settingsFile, 'utf8'))
  if (
    draft?.version === 3 &&
    typeof draft.projectRoot === 'string' &&
    samePath(draft.projectRoot, paths.projectRoot)
  ) {
    return null
  }
  if (draft?.version === 4) {
    delete draft.revision
    delete draft.echoMemoryDir
  }
  return validateSettings(paths.projectRoot, draft)
}

export function writeSettings(projectRoot, draft) {
  const paths = settingsPaths(projectRoot)
  const settings = validateSettings(paths.projectRoot, draft)
  readSettings(paths.projectRoot)
  writeJson(paths.settingsFile, settings)
  return settings
}
