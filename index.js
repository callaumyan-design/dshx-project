// dshx-project v2 — host half.
//
// WHY THIS EXISTS
//
// The session header's only path field, `cwd`, is immutable metadata stamped at
// creation, and when sessions start in a workspace root it is that root for nearly
// every session. The built-in "Open In..." button therefore always opens the
// root. This plugin resolves the session's REAL project and opens that.
//
// HOW THE PROJECT IS RESOLVED (first hit wins)
//
//   1. user     — picked from the header menu
//   2. ai       — the model called `set_project` (a standing system-prompt
//                 rule asks it to as soon as the project is clear)
//   3. inferred — read off the session log: absolute paths in every tool
//                 call are scored per project directory (writes weigh more,
//                 recent calls weigh more). Works for old sessions with no
//                 record at all, and keeps updating while a new one runs.
//   4. fallback — the session cwd
//
// Records live in `<DSH_HOME>/dshx-project/projects.json` (atomic write). The
// session log is only ever READ. With this plugin absent every session still
// opens and the built-in button still works.
//
// ROUTES (same-origin, behind the connection trust fence when available)
//
//   GET  /dshx-project/state?sessionId=<id>&cwd=<cwd>
//   POST /dshx-project/set    { sessionId, path }
//   POST /dshx-project/clear  { sessionId }
//   POST /dshx-project/open   { sessionId, path? }

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inferProject, listProjects, supported as inferenceSupported } from './infer.js'

export const name = 'dshx-project'
export const inject = ['webServer']

const STATE_ROUTE = '/dshx-project/state'
const SET_ROUTE = '/dshx-project/set'
const CLEAR_ROUTE = '/dshx-project/clear'
const OPEN_ROUTE = '/dshx-project/open'
const MAX_BODY_BYTES = 8192

export const PROMPT_RULE = [
  'PROJECT TRACKING (dshx-project):',
  '- Sessions here usually start in the workspace root, not in the project being worked on. As soon as it is clear which project directory this conversation is about (the user names it, or your work centers on one directory), call the `set_project` tool once with that directory\'s absolute path, e.g. D:\\work\\projects\\my-app — the project root, not a file and not the workspace root.',
  '- Call it again only if the conversation clearly moves to a different project. Do not call it for one-off questions that touch no project, and do not mention the call to the user.',
  '',
  'FILE PLACEMENT (mandatory; keeps the workspace root clean):',
  '- Never create files directly in the workspace root (the session cwd). The root holds only project folders and workspace-level notes.',
  '- Work on an existing project: put its files inside that project.',
  '- Anything else that produces files (generated images, reports, spreadsheets, research data, one-off scripts): before writing the first file, create ONE folder for this conversation at <workspace root>\\outputs\\<YYYY-MM-DD>-<short-english-slug>\\ (e.g. D:\\work\\outputs\\2026-10-12-market-research\\), call `set_project` with it, and put every file of this conversation there. Reuse that folder for the rest of the conversation; do not create a second one.',
  '- Throwaway scratch files (probes, temporary dumps you will delete) go in <workspace root>\\.tmp\\ and are removed when done.',
  '- If a tool saves its output somewhere else (for example image generation), move the file into the conversation folder right after, and report the final path.',
  '- Do not apply these rules to files the user explicitly asks to place elsewhere.',
].join('\n')

function describeError(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string') return error.message
  return String(error)
}

export function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.length > 0) return configured
  return path.join(os.homedir(), '.dsh')
}

const storeFile = () => path.join(dshHome(), 'dshx-project', 'projects.json')
const sessionsDir = () => path.join(dshHome(), 'sessions')

// ------------------------------------------------------------------- store

async function readStore() {
  try {
    const parsed = JSON.parse(await fs.readFile(storeFile(), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.sessions === 'object') return parsed
  } catch { /* missing or corrupt: start empty */ }
  return { schemaVersion: 1, sessions: {} }
}

let writeChain = Promise.resolve()

/** Serialized read-modify-write so concurrent calls cannot drop each other. */
function mutateStore(mutator) {
  const run = writeChain.then(async () => {
    const store = await readStore()
    store.schemaVersion = 1
    store.sessions = store.sessions ?? {}
    const result = mutator(store)
    const file = storeFile()
    await fs.mkdir(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp-' + process.pid
    await fs.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8')
    await fs.rename(tmp, file)
    return result
  })
  writeChain = run.catch(() => {})
  return run
}

function recordOf(store, sessionId) {
  const row = store.sessions?.[sessionId]
  return row !== null && typeof row === 'object' && typeof row.path === 'string' ? row : undefined
}

export function setProject(sessionId, target, source) {
  return mutateStore((store) => {
    store.sessions[sessionId] = { path: path.resolve(target), source, updatedAt: Date.now() }
    return store.sessions[sessionId]
  })
}

export function clearProject(sessionId) {
  return mutateStore((store) => { delete store.sessions[sessionId] })
}

// -------------------------------------------------------------- workspace

export async function workspaceRoots(cwd) {
  const found = new Map()
  const add = (p) => { const r = path.resolve(p); found.set(r.toLowerCase(), r) }
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dshHome(), 'storages', 'workspace.json'), 'utf8'))
    for (const row of Object.values(parsed?.tables?.workspaces ?? {})) {
      if (typeof row?.path === 'string' && row.path.length > 0) add(row.path)
    }
  } catch { /* fall back to cwd */ }
  if (typeof cwd === 'string' && cwd.length > 0) add(cwd)
  return [...found.values()]
}

async function directoryExists(target) {
  try { return (await fs.stat(target)).isDirectory() } catch { return false }
}

function inside(target, roots) {
  const resolved = path.resolve(target)
  return roots.some((root) => {
    const rel = path.relative(root, resolved)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  })
}

export async function validateProjectPath(target, roots) {
  if (typeof target !== 'string' || target.length === 0) return 'path 不能为空'
  if (!path.isAbsolute(target)) return 'path 必须是绝对路径'
  if (!inside(target, roots)) return '只能记录工作区内的目录'
  if (!(await directoryExists(path.resolve(target)))) return '目录不存在：' + path.resolve(target)
  return null
}

// ------------------------------------------------------------- resolution

/**
 * Resolve the effective project for one session.
 *
 * @returns `{ project, source, exists, inferred, ranked, cwd }` where source is
 *   'user' | 'ai' | 'inferred' | 'cwd' | null.
 */
export async function resolveProject(sessionId, cwd) {
  const roots = await workspaceRoots(cwd)
  const store = await readStore()
  const record = recordOf(store, sessionId)

  let inference = { project: null, ranked: [] }
  try {
    inference = await inferProject(sessionsDir(), sessionId, roots)
  } catch { /* inference is best-effort */ }

  if (record !== undefined) {
    const exists = await directoryExists(record.path)
    if (exists) {
      return { project: record.path, source: record.source === 'ai' ? 'ai' : 'user', exists, inferred: inference.project, ranked: inference.ranked, roots }
    }
  }
  if (inference.project !== null) {
    return { project: inference.project, source: 'inferred', exists: true, inferred: inference.project, ranked: inference.ranked, roots }
  }
  if (typeof cwd === 'string' && cwd.length > 0 && (await directoryExists(cwd))) {
    return { project: path.resolve(cwd), source: 'cwd', exists: true, inferred: null, ranked: inference.ranked, roots }
  }
  return { project: null, source: null, exists: false, inferred: null, ranked: inference.ranked, roots, missing: record?.path ?? null }
}

export async function buildState(sessionId, cwd) {
  const resolved = await resolveProject(sessionId, cwd)
  const candidates = []
  const seen = new Set()
  for (const root of resolved.roots) {
    for (const item of listProjects(root)) {
      const key = item.path.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push(item)
    }
  }
  return {
    sessionId,
    project: resolved.project,
    source: resolved.source,
    exists: resolved.exists,
    missing: resolved.missing ?? null,
    suggestions: resolved.ranked.map((r) => r.path),
    roots: resolved.roots,
    candidates,
    inference: inferenceSupported,
  }
}

// ----------------------------------------------------------------- opening

async function openInFileManager(ctx, target) {
  const argv = process.platform === 'win32'
    ? ['explorer.exe', target]
    : process.platform === 'darwin' ? ['open', target] : ['xdg-open', target]

  const subprocess = typeof ctx.get === 'function' ? ctx.get('subprocess') : undefined
  if (subprocess !== undefined && typeof subprocess.spawn === 'function') {
    try {
      const handle = subprocess.spawn({
        argv,
        cwd: os.homedir(),
        stdio: { stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } },
        graceMs: 3000,
      })
      void handle?.done?.catch?.(() => {})
      return null
    } catch { /* fall through to child_process */ }
  }
  try {
    const { spawn } = await import('node:child_process')
    const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore', windowsHide: false })
    child.on('error', () => {})
    child.unref()
    return null
  } catch (error) {
    return '无法启动文件管理器：' + describeError(error)
  }
}

// ------------------------------------------------------------------ http

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return null }
}

function rejectedBy(ctx, req, res) {
  let connection
  try { connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined } catch { connection = undefined }
  if (connection === undefined || typeof connection.requestRejection !== 'function') return false
  const status = connection.requestRejection(req)
  if (status === undefined) return false
  res.statusCode = status
  res.end()
  return true
}

export function createHandlers(ctx, logger) {
  return {
    async state(req, res) {
      if ((req.method ?? 'GET') !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      const url = new URL(req.url ?? STATE_ROUTE, 'http://localhost')
      const sessionId = url.searchParams.get('sessionId') ?? ''
      if (sessionId.length === 0) return sendJson(res, 400, { error: 'sessionId 必填' })
      sendJson(res, 200, await buildState(sessionId, url.searchParams.get('cwd') ?? ''))
    },
    async set(req, res) {
      if ((req.method ?? 'GET') !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      const body = await readBody(req)
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
      if (sessionId.length === 0) return sendJson(res, 400, { error: 'sessionId 必填' })
      const problem = await validateProjectPath(body?.path, await workspaceRoots(''))
      if (problem !== null) return sendJson(res, 400, { error: problem })
      const record = await setProject(sessionId, body.path, 'user')
      logger?.info?.('project recorded for %s: %s', sessionId, record.path)
      sendJson(res, 200, { ok: true, project: record.path, source: record.source })
    },
    async clear(req, res) {
      if ((req.method ?? 'GET') !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      const body = await readBody(req)
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
      if (sessionId.length === 0) return sendJson(res, 400, { error: 'sessionId 必填' })
      await clearProject(sessionId)
      sendJson(res, 200, { ok: true })
    },
    async open(req, res) {
      if ((req.method ?? 'GET') !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      const body = await readBody(req)
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
      const cwd = typeof body?.cwd === 'string' ? body.cwd : ''
      let target = typeof body?.path === 'string' && body.path.length > 0 ? body.path : null
      if (target === null && sessionId.length > 0) target = (await resolveProject(sessionId, cwd)).project
      if (target === null) return sendJson(res, 400, { error: '没有可打开的目录' })
      const problem = await validateProjectPath(target, await workspaceRoots(cwd))
      if (problem !== null) return sendJson(res, 400, { error: problem })
      const reason = await openInFileManager(ctx, path.resolve(target))
      if (reason !== null) {
        logger?.warn?.('open failed: %s', reason)
        return sendJson(res, 502, { error: reason })
      }
      sendJson(res, 200, { ok: true, opened: path.resolve(target) })
    },
  }
}

// ------------------------------------------------------------------- tool

export function toolDefinition(logger) {
  return {
    name: 'set_project',
    description:
      'Record which project directory this conversation is working on, so the session header '
      + 'shows it and opens it in the file manager. Call it once as soon as the project is clear '
      + '(the user names it, or the work centers on one directory), with the project ROOT '
      + '(e.g. D:\\work\\projects\\my-app), not a file and not the workspace root. '
      + 'The path must be an existing directory inside a known workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the project root directory.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, project: { type: 'string' }, error: { type: 'string' } },
        required: ['ok'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok === true ? '已记录当前项目：' + value.project : '无法记录项目：' + (value.error ?? '未知错误'),
      }],
    },
    async execute(args, exec) {
      const requested = typeof args?.path === 'string' ? args.path : ''
      const problem = await validateProjectPath(requested, await workspaceRoots(''))
      if (problem !== null) return { ok: false, error: problem }
      // `Agent.id` is the session id; the tool registry passes `exec.agent`.
      const sessionId = exec?.agent?.id
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return { ok: false, error: '无法确定当前会话（没有 agent 上下文）' }
      }
      // A user pick always wins; the model cannot overwrite it.
      const store = await readStore()
      const existing = recordOf(store, sessionId)
      if (existing?.source === 'user') {
        return { ok: true, project: existing.path }
      }
      const record = await setProject(sessionId, requested, 'ai')
      logger?.info?.('project recorded by ai for %s: %s', sessionId, record.path)
      return { ok: true, project: record.path }
    },
  }
}

// ------------------------------------------------------------------ apply

export function apply(ctx) {
  const logger = ctx.logger?.(name)
  const handlers = createHandlers(ctx, logger)
  const route = (p, handler, label) => ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: p,
    handler: async (req, res) => {
      if (rejectedBy(ctx, req, res)) return
      try {
        await handler(req, res)
      } catch (error) {
        logger?.warn?.('%s failed: %s', p, describeError(error))
        if (!res.headersSent) sendJson(res, 500, { error: describeError(error) })
      }
    },
  }), label)

  route(STATE_ROUTE, handlers.state, 'dshx-project: state')
  route(SET_ROUTE, handlers.set, 'dshx-project: set')
  route(CLEAR_ROUTE, handlers.clear, 'dshx-project: clear')
  route(OPEN_ROUTE, handlers.open, 'dshx-project: open')

  // Tool + prompt rule. Same binding shape as beauticode-dsh, which is known to
  // work on this host: inject `tools`, then read `systemPrompt` from that scope.
  bindAgentSurfaces(ctx, logger)
}

export function bindAgentSurfaces(ctx, logger) {
  if (typeof ctx.inject !== 'function') return
  try {
    ctx.inject(['tools'], (inner) => {
      try {
        inner.tools.register(toolDefinition(logger))
      } catch (error) {
        logger?.warn?.('set_project not registered: %s', describeError(error))
      }
      try {
        const prompt = typeof inner.get === 'function' ? inner.get('systemPrompt') : inner.systemPrompt
        if (prompt && typeof prompt.section === 'function') {
          prompt.section({ name: 'dshx:project', order: 170, text: PROMPT_RULE })
        }
      } catch { /* prompt guidance is optional */ }
    })
  } catch {
    logger?.warn?.('tools service unavailable; set_project not registered')
  }
}
