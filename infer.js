// dshx-project — project inference from the session log.
//
// A session's `cwd` is immutable and is the workspace root for almost every
// session started from a workspace root, so the real project has to be read off what the
// conversation actually touched. Every `tool/call` entry in the session log
// carries its JSON arguments; absolute paths inside them (file_path, workdir,
// paths embedded in shell commands) are mapped to a project directory and
// scored. Measured on 342 local sessions: ~73% resolve to a project.
//
// The log is append-only zstd (one frame per flush), so scanning is
// incremental: each session keeps its byte offset and running scores, and a
// poll only decodes the frames written since the last one.

import { promises as fs, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/** First-level directories that are never a project. Lower-case. */
export const NOISE = new Set([
  'node_modules', '.git', '.tmp', 'tmp', 'temp', '.dsh', '.agents', '.claude',
  '.pnpm-store', '.workbuddy-ai', '.lms-sdk', '.cache', '.venv', '__pycache__',
  'archive', '_fix', 'tmp-session-repair',
])

/**
 * Container directories: they hold projects rather than being one, so the
 * project is the next segment down. Relative to a workspace root, '/'-joined,
 * lower-case.
 */
export const CONTAINERS = new Set([
  'projects', 'dsh', 'dsh/dshx-plugins', 'dsh/skills', 'dsh/tools', 'outputs', 'docs',
])

/** Weight per tool family: writing to a project says more than reading it. */
function weightOf(toolName, key) {
  const name = String(toolName || '').toLowerCase()
  if (key === 'workdir' || key === 'cwd') return 2
  if (/^(write|edit|str_replace|apply_patch|multi_edit|create)/.test(name)) return 3
  return 1
}

/** Per-hit decay, so the focus follows the conversation instead of its start. */
const DECAY = 0.99

/** A run needs at least this much evidence before it is believed. */
export const MIN_SCORE = 2

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const PATH_RE = /[A-Za-z]:[\\/][^\s"'`<>|*?\r\n;,()\[\]{}]*/g

/** Whether this runtime can read the log at all. */
export const supported = typeof zlib.zstdDecompressSync === 'function'

/** Normalize a Windows-ish path for comparison and display. */
export function normalize(p) {
  let out = String(p).replace(/\//g, '\\').replace(/\\{2,}/g, '\\')
  out = out.replace(/[.\\:]+$/, '')
  return out
}

/**
 * Argument keys whose values are prose or file bodies, not locations: a path
 * quoted inside written content or a description is not where the work is.
 */
const PROSE_KEYS = new Set([
  'content', 'new_string', 'old_string', 'new_str', 'old_str', 'text', 'prompt',
  'message', 'description', 'justification', 'objective', 'question', 'questions',
  'plan', 'todos', 'context', 'query', 'queries', 'patch', 'script',
])

/** Pull every absolute path out of one tool-call argument tree. */
export function pathsIn(value, toolName, out = [], key = '') {
  if (PROSE_KEYS.has(String(key).toLowerCase())) return out
  if (typeof value === 'string') {
    const matches = value.match(PATH_RE)
    if (matches) for (const m of matches) out.push({ path: normalize(m), weight: weightOf(toolName, key) })
  } else if (Array.isArray(value)) {
    for (const item of value) pathsIn(item, toolName, out, key)
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) pathsIn(v, toolName, out, k)
  }
  return out
}

function isDir(target, memo) {
  const key = target.toLowerCase()
  if (memo.has(key)) return memo.get(key)
  let ok = false
  try { ok = statSync(target).isDirectory() } catch { ok = false }
  memo.set(key, ok)
  return ok
}

/**
 * Map one absolute path to the project directory it belongs to.
 *
 * @param target - absolute path that a tool touched.
 * @param roots - absolute workspace roots.
 * @param memo - directory-existence cache shared across one scan.
 * @returns the project directory, or null when the path is noise, outside the
 *   workspace, the root itself, or a loose file in a root/container.
 */
export function projectOf(target, roots, memo = new Map()) {
  const lower = target.toLowerCase()
  for (const root of roots) {
    const r = normalize(root)
    const rl = r.toLowerCase()
    if (!(lower === rl || lower.startsWith(rl + '\\'))) continue
    const segs = target.slice(r.length).split('\\').filter(Boolean)
    if (segs.length === 0) return null
    if (NOISE.has(segs[0].toLowerCase()) || segs[0].startsWith('.')) return null
    let i = 0
    while (i + 1 < segs.length && CONTAINERS.has(segs.slice(0, i + 1).join('/').toLowerCase())) i++
    if (CONTAINERS.has(segs.slice(0, i + 1).join('/').toLowerCase())) return null
    const candidate = path.join(r, ...segs.slice(0, i + 1))
    if (isDir(candidate, memo)) return candidate
    return relocate(segs, r, memo)
  }
  return null
}

/**
 * Directory layout of one root, by basename: the current projects and
 * containers. Built once per root and refreshed every few minutes so a newly
 * created project is picked up.
 */
const layouts = new Map()
const LAYOUT_TTL_MS = 5 * 60 * 1000

function layoutOf(root) {
  const key = root.toLowerCase()
  const cached = layouts.get(key)
  if (cached !== undefined && Date.now() - cached.at < LAYOUT_TTL_MS) return cached
  const projects = new Map()
  const containers = new Set()
  const list = []
  const walk = (dir, rel) => {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || NOISE.has(e.name.toLowerCase())) continue
      const childRel = rel === '' ? e.name : rel + '/' + e.name
      const full = path.join(dir, e.name)
      if (CONTAINERS.has(childRel.toLowerCase())) {
        containers.add(e.name.toLowerCase())
        walk(full, childRel)
      } else {
        const name = e.name.toLowerCase()
        // An ambiguous basename (two projects share it) is not relocatable.
        projects.set(name, projects.has(name) ? null : full)
        list.push({ name: childRel, path: full })
      }
    }
  }
  walk(root, '')
  list.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  const layout = { at: Date.now(), projects, containers, list }
  layouts.set(key, layout)
  return layout
}

/** Every current project directory under one root (for the picker menu). */
export function listProjects(root) {
  return layoutOf(normalize(root)).list
}

/**
 * Follow a project that moved after the session ran.
 *
 * Old logs name `<root>\my-app` while the project now lives at
 * `<root>\projects\my-app`. When the literal candidate is gone, walk the
 * old segments, skip names that are containers today, and accept the first
 * segment that is a uniquely named current project.
 */
function relocate(segs, root, memo) {
  const layout = layoutOf(root)
  for (const seg of segs) {
    const name = seg.toLowerCase()
    if (NOISE.has(name) || seg.startsWith('.')) return null
    if (layout.containers.has(name)) continue
    const found = layout.projects.get(name)
    return typeof found === 'string' && isDir(found, memo) ? found : null
  }
  return null
}

/**
 * Decode every complete zstd frame from `offset` on.
 *
 * Frame boundaries are found by the magic number; a false boundary (the magic
 * occurring inside compressed bytes) fails to decode and is merged with the
 * next piece. A trailing frame still being written fails too and is left for
 * the next poll.
 *
 * @returns decoded text and the offset after the last complete frame.
 */
export function decodeFrom(buf, offset) {
  let text = ''
  let start = buf.indexOf(ZSTD_MAGIC, offset)
  if (start === -1) return { text, offset }
  let done = start
  while (start < buf.length) {
    let next = buf.indexOf(ZSTD_MAGIC, start + 4)
    let decoded = false
    while (true) {
      const end = next === -1 ? buf.length : next
      try {
        text += zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
        start = end
        done = end
        decoded = true
        break
      } catch {
        if (next === -1) break
        next = buf.indexOf(ZSTD_MAGIC, next + 4)
      }
    }
    if (!decoded) break
  }
  return { text, offset: done }
}

/** Fold decoded log text into a running score table. */
export function scoreLines(text, roots, scores, memo) {
  for (const line of text.split('\n')) {
    if (!line.includes('"tool/call"')) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    if (entry?.type !== 'tool/call') continue
    const name = entry.data?.name
    if (name === 'set_project') continue
    let args = entry.data?.arguments
    if (typeof args === 'string') {
      try { args = JSON.parse(args) } catch { /* scan it as raw text */ }
    }
    const seen = new Set()
    for (const hit of pathsIn(args, name)) {
      const project = projectOf(hit.path, roots, memo)
      if (project === null) continue
      const key = project.toLowerCase()
      if (seen.has(key)) continue // one vote per call per project
      seen.add(key)
      for (const k of Object.keys(scores)) scores[k].score *= DECAY
      const row = scores[key] ?? (scores[key] = { path: project, score: 0, hits: 0 })
      row.score += hit.weight
      row.hits += 1
    }
  }
  return scores
}

/** Ranked projects, best first. */
export function ranked(scores) {
  return Object.values(scores).sort((a, b) => b.score - a.score)
}

// ---------------------------------------------------------------- locating

let index = null

async function buildIndex(sessionsDir) {
  const map = new Map()
  let groups = []
  try { groups = await fs.readdir(sessionsDir, { withFileTypes: true }) } catch { return map }
  for (const g of groups) {
    if (!g.isDirectory()) continue
    let ids = []
    try { ids = await fs.readdir(path.join(sessionsDir, g.name), { withFileTypes: true }) } catch { continue }
    for (const id of ids) if (id.isDirectory()) map.set(id.name, path.join(sessionsDir, g.name, id.name))
  }
  return map
}

/** Newest `session.vN.jsonl.zstd` for one session, or null. */
export async function logFileOf(sessionsDir, sessionId) {
  if (index === null || !index.has(sessionId)) index = await buildIndex(sessionsDir)
  const dir = index.get(sessionId)
  if (dir === undefined) return null
  let names = []
  try { names = await fs.readdir(dir) } catch { return null }
  const logs = names
    .map((n) => ({ n, v: Number(/^session\.v(\d+)\.jsonl\.zstd$/.exec(n)?.[1]) }))
    .filter((x) => Number.isFinite(x.v))
    .sort((a, b) => b.v - a.v)
  return logs.length > 0 ? path.join(dir, logs[0].n) : null
}

// ---------------------------------------------------------------- inference

const cache = new Map()
const MAX_CACHED = 200

/**
 * Infer the project for one session, incrementally.
 *
 * @param sessionsDir - `<DSH_HOME>/sessions`.
 * @param sessionId - session to inspect.
 * @param roots - absolute workspace roots.
 * @returns `{ project, score, ranked }`; `project` is null when evidence is thin.
 */
export async function inferProject(sessionsDir, sessionId, roots) {
  if (!supported) return { project: null, score: 0, ranked: [] }
  const file = await logFileOf(sessionsDir, sessionId)
  if (file === null) return { project: null, score: 0, ranked: [] }

  let stat
  try { stat = await fs.stat(file) } catch { return { project: null, score: 0, ranked: [] } }

  let entry = cache.get(sessionId)
  if (entry === undefined || entry.file !== file || stat.size < entry.size) {
    entry = { file, size: 0, offset: 0, scores: {} }
  }
  if (stat.size !== entry.size) {
    const buf = await fs.readFile(file)
    const { text, offset } = decodeFrom(buf, entry.offset)
    scoreLines(text, roots, entry.scores, new Map())
    entry.offset = offset
    entry.size = buf.length
  }
  cache.delete(sessionId)
  cache.set(sessionId, entry)
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value)

  const list = ranked(entry.scores)
  const best = list[0]
  return {
    project: best !== undefined && best.score >= MIN_SCORE ? best.path : null,
    score: best?.score ?? 0,
    ranked: list.slice(0, 6).map((r) => ({ path: r.path, score: Math.round(r.score * 10) / 10 })),
  }
}

/** Test seam. */
export function resetCaches() {
  cache.clear()
  layouts.clear()
  index = null
}
