// dshx-project — host half.
//
// WHY THIS EXISTS
//
// The harness's session header carries exactly one path field, `cwd`, and it is
// *immutable validated storage metadata*: it is stamped when the session is
// created (`CreateSessionOptions.meta.cwd`) and there is no setter anywhere in
// the runtime. On this machine every session is created in the workspace root,
// so `cwd` is the workspace root for essentially every session, and the built-in
// "Open In..." button faithfully opens the same root over and over.
//
// The real project is a level or two deeper and cannot be recovered from the
// log: deriving it from tool calls was measured at ~3% coverage. So this plugin
// does not try to rewrite immutable metadata. It keeps its own durable mapping
// `sessionId -> project path`, records it when the user (or the model, via the
// `set_project` tool) names the project, and exposes it to the client so the
// header can show the real project and open it.
//
// The mapping is advisory presentation state. If this plugin is missing, the
// session still loads and the built-in button still works — nothing about the
// conversation log depends on it.
//
// ROUTES
//
//   GET  /dshx-project/state?sessionId=<id>
//        -> { sessionId, project, source, exists, root, candidates: [...] }
//   POST /dshx-project/set    { sessionId, path }
//        -> { ok: true, project, source: 'user' }
//   POST /dshx-project/clear  { sessionId }
//        -> { ok: true }
//   POST /dshx-project/open   { sessionId, path? }
//        -> { ok: true, opened: <abs path> }

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Stable Cordis plugin name. */
export const name = 'dshx-project'

/** Web server carrier for the routes; tools for the model-facing tool. */
export const inject = ['webServer']

const STATE_ROUTE = '/dshx-project/state'
const SET_ROUTE = '/dshx-project/set'
const CLEAR_ROUTE = '/dshx-project/clear'
const OPEN_ROUTE = '/dshx-project/open'

/** One path plus a session id; refuse anything larger. */
const MAX_BODY_BYTES = 8192

/** Depth cap when walking down from a workspace root. */
const MAX_DEPTH = 2

/** Sibling cap, so one fat directory cannot flood the candidate list. */
const MAX_SIBLINGS = 40

/** Directories that are never a project a human wants to open. */
const NOISE = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build',
  'out', 'target', '.next', '.cache', '.tmp', 'coverage', '.dsh', '.workbuddy-ai',
  '.agents', '.claude', '.idea', '.vscode', '.godot', '.import', 'tmp', 'temp',
])

/** Marker files that make a directory look like a real project. */
const PROJECT_MARKERS = [
  'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml',
  'build.gradle', 'project.godot', 'requirements.txt', 'setup.py',
  '.git', 'CLAUDE.md', 'AGENTS.md', 'README.md', 'WORKSPACE.md',
]

function describeError(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string') return error.message
  return String(error)
}

/** The harness reads DSH_HOME first and falls back to ~/.dsh. */
function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.length > 0) return configured
  return path.join(os.homedir(), '.dsh')
}

/**
 * Durable store file for the session -> project mapping.
 *
 * A plain JSON file under the plugin's own data directory, not the session log:
 * this is presentation metadata, and writing it must never touch immutable
 * session storage.
 */
function storeFile() {
  return path.join(dshHome(), 'dshx-project', 'projects.json')
}

/**
 * Read the whole mapping.
 *
 * A missing or corrupt file is treated as empty rather than fatal: losing the
 * mapping must degrade to "no project recorded", never to a broken page.
 *
 * @returns a plain object mapping session id to a record.
 */
async function readStore() {
  try {
    const parsed = JSON.parse(await fs.readFile(storeFile(), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.sessions === 'object') {
      return parsed
    }
    return { schemaVersion: 1, sessions: {} }
  } catch {
    return { schemaVersion: 1, sessions: {} }
  }
}

/**
 * Persist the whole mapping atomically.
 *
 * Written to a temp file and renamed, so a crash mid-write cannot leave a
 * truncated file that the next read would have to guess at.
 *
 * @param store - the mapping object to persist.
 */
async function writeStore(store) {
  const file = storeFile()
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

/**
 * Read the configured workspace roots.
 *
 * `workspace.json` is the product's own source of truth for which directories
 * are workspaces; consulting it keeps this plugin's notion of "workspace"
 * agreeing with the sidebar instead of inventing a second one.
 *
 * @param cwd - the session's cwd, used only as a fallback.
 * @returns absolute workspace directories, de-duplicated.
 */
async function workspaceRoots(cwd) {
  const found = new Set()
  try {
    const file = path.join(dshHome(), 'storages', 'workspace.json')
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
    for (const row of Object.values(parsed?.tables?.workspaces ?? {})) {
      if (typeof row?.path === 'string' && row.path.length > 0) found.add(path.resolve(row.path))
    }
  } catch {
    // A missing or unreadable store is not fatal; `cwd` still covers us.
  }
  if (typeof cwd === 'string' && cwd.length > 0) found.add(path.resolve(cwd))
  return [...found]
}

/** Whether a directory carries any project marker. */
async function looksLikeProject(dir) {
  for (const marker of PROJECT_MARKERS) {
    try {
      await fs.access(path.join(dir, marker))
      return true
    } catch {
      // Try the next marker.
    }
  }
  return false
}

/**
 * Enumerate openable directories under one root.
 *
 * Walks two levels because on this machine the interesting projects sit one
 * level down (`projects/rivers-end`) while others sit directly at the root
 * (`Pony-Image-Studio`); a single depth would miss half of them.
 *
 * @param root - absolute workspace directory.
 * @returns candidate rows, shallow first and markered before plain.
 */
async function collect(root) {
  const items = []
  let level = [{ dir: root, depth: 0 }]

  while (level.length > 0) {
    const next = []
    for (const node of level) {
      let entries
      try {
        entries = await fs.readdir(node.dir, { withFileTypes: true })
      } catch {
        continue
      }
      const dirs = entries
        .filter((entry) => entry.isDirectory() && !NOISE.has(entry.name) && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b, 'zh'))
        .slice(0, MAX_SIBLINGS)

      for (const dirName of dirs) {
        const full = path.join(node.dir, dirName)
        const depth = node.depth + 1
        items.push({
          name: depth === 1 ? dirName : path.relative(root, full).split(path.sep).join('/'),
          path: full,
          depth,
          project: await looksLikeProject(full),
        })
        if (depth < MAX_DEPTH) next.push({ dir: full, depth })
      }
    }
    level = next
  }

  items.sort((a, b) =>
    a.depth - b.depth ||
    Number(b.project) - Number(a.project) ||
    a.name.localeCompare(b.name, 'zh'))
  return items
}

/** Whether a path currently exists and is a directory. */
async function directoryExists(target) {
  try {
    const stat = await fs.stat(target)
    return stat.isDirectory()
  } catch {
    return false
  }
}

/**
 * Resolve the record for one session, without creating it.
 *
 * @param store - the loaded mapping.
 * @param sessionId - session to look up.
 * @returns the stored record, or undefined.
 */
function recordOf(store, sessionId) {
  const row = store.sessions?.[sessionId]
  return row !== null && typeof row === 'object' ? row : undefined
}

/**
 * Build the client-facing state for one session.
 *
 * Candidates are always returned so the menu can be built without a second
 * round trip; the recorded project is returned even when it no longer exists,
 * flagged, so the header can say so instead of silently forgetting.
 *
 * @param sessionId - session being inspected.
 * @param cwd - the session's immutable cwd, used to seed the candidate roots.
 * @returns the state payload.
 */
async function buildState(sessionId, cwd) {
  const store = await readStore()
  const record = recordOf(store, sessionId)
  const roots = await workspaceRoots(cwd)

  const items = []
  const seen = new Set()
  for (const root of roots) {
    for (const item of await collect(root)) {
      const key = item.path.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      items.push(item)
    }
  }

  const project = typeof record?.path === 'string' ? record.path : null
  return {
    sessionId,
    project,
    source: typeof record?.source === 'string' ? record.source : null,
    updatedAt: typeof record?.updatedAt === 'number' ? record.updatedAt : null,
    exists: project === null ? false : await directoryExists(project),
    root: roots[0] ?? null,
    roots,
    candidates: items,
  }
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

/** Read a bounded JSON body; returns null when unreadable or oversized. */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

/**
 * Reject a path that is not a real directory inside a known workspace root.
 *
 * The set/open routes are reachable from the page, so an unguarded path would
 * let the browser point the header at any directory on the machine.
 *
 * @param target - the requested absolute path.
 * @param roots - known workspace roots.
 * @returns an error string, or null when acceptable.
 */
async function validateProjectPath(target, roots) {
  if (typeof target !== 'string' || target.length === 0) return 'path 不能为空'
  if (!path.isAbsolute(target)) return 'path 必须是绝对路径'

  const resolved = path.resolve(target)
  const inside = roots.some((root) => {
    const rel = path.relative(root, resolved)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  })
  if (!inside) return '只能记录工作区内的目录'

  if (!(await directoryExists(resolved))) return '目录不存在：' + resolved
  return null
}

/**
 * Open one directory in the OS file manager.
 *
 * Fire-and-forget by design: `explorer.exe` returns immediately and its exit
 * code is unreliable, so the successful spawn is the signal.
 *
 * @param ctx - host context carrying the subprocess service.
 * @param target - absolute directory path.
 * @returns null on success, or a human-readable failure reason.
 */
async function openInFileManager(ctx, target) {
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined || typeof subprocess.spawn !== 'function') {
    return '子进程服务不可用'
  }

  const platform = process.platform
  const argv = platform === 'win32'
    ? ['explorer.exe', target]
    : platform === 'darwin'
      ? ['open', target]
      : ['xdg-open', target]

  try {
    const handle = subprocess.spawn({
      argv,
      cwd: os.homedir(),
      stdio: { stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } },
      graceMs: 3000,
    })
    void handle.done.catch(() => {})
    return null
  } catch (error) {
    return '无法启动文件管理器：' + describeError(error)
  }
}

/**
 * Register a project for a session and persist it.
 *
 * @param sessionId - session to record against.
 * @param target - absolute project directory.
 * @param source - who decided it, `'ai'` or `'user'`.
 * @returns the stored record.
 */
async function setProject(sessionId, target, source) {
  const store = await readStore()
  const resolved = path.resolve(target)
  store.schemaVersion = 1
  store.sessions = store.sessions ?? {}
  store.sessions[sessionId] = { path: resolved, source, updatedAt: Date.now() }
  await writeStore(store)
  return store.sessions[sessionId]
}

export function apply(ctx) {
  const logger = ctx.logger?.(name)

  // ------------------------------------------------------------------ routes

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATE_ROUTE,
    handler: async (req, res) => {
      if ((req.method ?? 'GET') !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      const url = new URL(req.url ?? STATE_ROUTE, 'http://localhost')
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const cwd = url.searchParams.get('cwd') ?? ''
      if (sessionId.length === 0) {
        sendJson(res, 400, { error: 'sessionId 必填' })
        return
      }
      sendJson(res, 200, await buildState(sessionId, cwd))
    },
  }), 'dshx-project: state')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SET_ROUTE,
    handler: async (req, res) => {
      if ((req.method ?? 'GET') !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      const body = await readBody(req)
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
      if (sessionId.length === 0) {
        sendJson(res, 400, { error: 'sessionId 必填' })
        return
      }
      const roots = await workspaceRoots('')
      const problem = await validateProjectPath(body?.path, roots)
      if (problem !== null) {
        sendJson(res, 400, { error: problem })
        return
      }
      const record = await setProject(sessionId, body.path, 'user')
      logger?.info?.('project recorded for %s: %s', sessionId, record.path)
      sendJson(res, 200, { ok: true, project: record.path, source: record.source })
    },
  }), 'dshx-project: set')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CLEAR_ROUTE,
    handler: async (req, res) => {
      if ((req.method ?? 'GET') !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      const body = await readBody(req)
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
      if (sessionId.length === 0) {
        sendJson(res, 400, { error: 'sessionId 必填' })
        return
      }
      const store = await readStore()
      if (store.sessions !== undefined && store.sessions[sessionId] !== undefined) {
        delete store.sessions[sessionId]
        await writeStore(store)
      }
      sendJson(res, 200, { ok: true })
    },
  }), 'dshx-project: clear')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: OPEN_ROUTE,
    handler: async (req, res) => {
      if ((req.method ?? 'GET') !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      const body = await readBody(req)
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''

      // An explicit path (menu pick) wins; otherwise open this session's record.
      let target = typeof body?.path === 'string' && body.path.length > 0 ? body.path : null
      if (target === null && sessionId.length > 0) {
        const store = await readStore()
        const record = recordOf(store, sessionId)
        target = typeof record?.path === 'string' ? record.path : null
      }
      if (target === null) {
        sendJson(res, 400, { error: '没有可打开的项目：先记录一个项目' })
        return
      }

      const roots = await workspaceRoots('')
      const problem = await validateProjectPath(target, roots)
      if (problem !== null) {
        sendJson(res, 400, { error: problem })
        return
      }

      const reason = await openInFileManager(ctx, target)
      if (reason !== null) {
        logger?.warn?.('open failed: %s', reason)
        sendJson(res, 502, { error: reason })
        return
      }
      logger?.info?.('opened %s', target)
      sendJson(res, 200, { ok: true, opened: target })
    },
  }), 'dshx-project: open')

  // -------------------------------------------------------------------- tool
  //
  // The model-facing half. Registering this late is deliberate: `ctx.tools` is
  // owned by the host plugin, and the tool is the only part of this plugin that
  // changes what the model can do. It is registered through an effect so
  // unloading the plugin removes it again.

  const tools = ctx.get('tools')
  if (tools !== undefined && typeof tools.register === 'function') {
    const definition = {
      name: 'set_project',
      description:
        'Record which project directory this session is actually working on, so the '
        + 'session header can show it and open it in the file manager. Use this when the '
        + 'user names a project, or when you determine the real project root differs from '
        + 'the workspace root (for example D:\\work\\repo\\packages\\app rather than D:\\work\\repo). '
        + 'The path must be an existing directory inside a known workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path of the project directory to record for this session.',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            project: { type: 'string' },
            error: { type: 'string' },
          },
          required: ['ok'],
          additionalProperties: false,
        },
        render: (_args, value) => {
          if (value.ok === true) {
            return [{ type: 'text', text: '已记录当前项目：' + value.project }]
          }
          return [{ type: 'text', text: '无法记录项目：' + (value.error ?? '未知错误') }]
        },
      },
      async execute(args, exec) {
        const requested = typeof args?.path === 'string' ? args.path : ''
        const roots = await workspaceRoots('')
        const problem = await validateProjectPath(requested, roots)
        if (problem !== null) return { ok: false, error: problem }

        // `Agent.id` IS the session id (dsh-agent types.d.ts: "Session-backed
        // Agent identity"). An agent-less execution has no session to record
        // against, so report that rather than inventing one.
        const sessionId = exec?.agent?.id
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          return { ok: false, error: '无法确定当前会话（没有 agent 上下文）' }
        }

        const record = await setProject(sessionId, requested, 'ai')
        logger?.info?.('project recorded by ai for %s: %s', sessionId, record.path)
        return { ok: true, project: record.path }
      },
    }

    ctx.effect(() => tools.register(definition), 'dshx-project: set_project tool')
  } else {
    logger?.warn?.('ctx.tools unavailable; set_project not registered')
  }
}
