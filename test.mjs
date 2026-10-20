// dshx-project v2 tests. Run: node test.mjs
// Uses an isolated DSH_HOME with a synthetic zstd session log, plus a read-only
// pass over the real session for the current conversation when present.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const home = mkdtempSync(path.join(os.tmpdir(), 'dshx-project-test-'))
const ws = path.join(home, 'ws')
for (const d of ['projects/alpha/src', 'projects/beta', 'gamma', 'archive/old', 'dsh/dshx-plugins/plug-a']) mkdirSync(path.join(ws, d), { recursive: true })
mkdirSync(path.join(home, 'storages'), { recursive: true })
writeFileSync(path.join(home, 'storages', 'workspace.json'), JSON.stringify({ tables: { workspaces: { w: { path: ws } } } }))
process.env.DSH_HOME = home

const mod = await import('./index.js')
const infer = await import('./infer.js')

let pass = 0
const test = async (title, fn) => { await fn(); pass++; console.log('ok -', title) }

// ---------------------------------------------------------- log fixture
const sid = 'session-test-1'
const logDir = path.join(home, 'sessions', '--ws--', sid)
mkdirSync(logDir, { recursive: true })
const logFile = path.join(logDir, 'session.v4.jsonl.zstd')
const frame = (obj) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(obj) + '\n'))
const call = (name, args) => ({ type: 'tool/call', data: { name, arguments: JSON.stringify(args) } })
writeFileSync(logFile, frame({ type: 'session', version: 4, id: sid, cwd: ws }))

await test('no tool calls -> falls back to cwd', async () => {
  const s = await mod.buildState(sid, ws)
  assert.equal(s.source, 'cwd')
  assert.equal(s.project, ws)
})

await test('one weak read is not enough evidence', async () => {
  appendFileSync(logFile, frame(call('read', { file_path: path.join(ws, 'gamma', 'x.md') })))
  const s = await mod.buildState(sid, ws)
  assert.equal(s.source, 'cwd')
})

await test('writes into a project -> inferred project (container skipped)', async () => {
  appendFileSync(logFile, frame(call('write', { file_path: path.join(ws, 'projects', 'alpha', 'src', 'a.js'), content: 'x' })))
  appendFileSync(logFile, frame(call('pwsh', { command: 'ls ' + path.join(ws, 'projects', 'alpha'), workdir: path.join(ws, 'projects', 'alpha') })))
  const s = await mod.buildState(sid, ws)
  assert.equal(s.source, 'inferred')
  assert.equal(s.project, path.join(ws, 'projects', 'alpha'))
  assert.ok(s.suggestions.includes(path.join(ws, 'gamma')))
})

await test('paths inside written content / descriptions do not count', async () => {
  const hits = infer.pathsIn({ file_path: path.join(ws, 'gamma', 'a'), content: 'see ' + path.join(ws, 'projects', 'beta'), description: path.join(ws, 'projects', 'beta') }, 'write')
  assert.deepEqual(hits.map((h) => h.path), [path.join(ws, 'gamma', 'a')])
})

await test('noise dirs and workspace root are ignored', async () => {
  assert.equal(infer.projectOf(path.join(ws, 'archive', 'old', 'f'), [ws]), null)
  assert.equal(infer.projectOf(path.join(ws, 'readme.md'), [ws]), null)
  assert.equal(infer.projectOf(path.join(ws, 'projects'), [ws]), null)
  assert.equal(infer.projectOf(path.join(ws, 'dsh', 'dshx-plugins', 'plug-a', 'i.js'), [ws]), path.join(ws, 'dsh', 'dshx-plugins', 'plug-a'))
})

await test('moved project is relocated by name', async () => {
  // log says ws\beta\..., project now lives at ws\projects\beta
  assert.equal(infer.projectOf(path.join(ws, 'beta', 'main.py'), [ws]), path.join(ws, 'projects', 'beta'))
})

await test('focus follows the conversation (recency decay)', async () => {
  for (let i = 0; i < 6; i++) appendFileSync(logFile, frame(call('edit', { file_path: path.join(ws, 'gamma', 'y' + i + '.md') })))
  const s = await mod.buildState(sid, ws)
  assert.equal(s.project, path.join(ws, 'gamma'))
})

await test('truncated trailing frame is tolerated', async () => {
  const half = frame(call('write', { file_path: path.join(ws, 'projects', 'beta', 'z') }))
  appendFileSync(logFile, half.subarray(0, 8))
  const s = await mod.buildState(sid, ws)
  assert.equal(s.project, path.join(ws, 'gamma'))
})

// ---------------------------------------------------------- tool / priority
const tool = mod.toolDefinition(undefined)
const sid2 = 'session-test-2'

await test('set_project: rejects outside workspace / missing / no agent', async () => {
  assert.equal((await tool.execute({ path: os.tmpdir() }, { agent: { id: sid2 } })).ok, false)
  assert.equal((await tool.execute({ path: path.join(ws, 'nope') }, { agent: { id: sid2 } })).ok, false)
  assert.equal((await tool.execute({ path: path.join(ws, 'gamma') }, {})).ok, false)
})

await test('ai record beats inference', async () => {
  const r = await tool.execute({ path: path.join(ws, 'projects', 'beta') }, { agent: { id: sid } })
  assert.equal(r.ok, true)
  const s = await mod.buildState(sid, ws)
  assert.equal(s.source, 'ai')
  assert.equal(s.project, path.join(ws, 'projects', 'beta'))
})

await test('user pick beats ai, and ai cannot overwrite it', async () => {
  await mod.setProject(sid, path.join(ws, 'gamma'), 'user')
  await tool.execute({ path: path.join(ws, 'projects', 'beta') }, { agent: { id: sid } })
  const s = await mod.buildState(sid, ws)
  assert.equal(s.source, 'user')
  assert.equal(s.project, path.join(ws, 'gamma'))
})

await test('clear -> back to inference', async () => {
  await mod.clearProject(sid)
  const s = await mod.buildState(sid, ws)
  assert.equal(s.source, 'inferred')
})

await test('concurrent writes do not drop records', async () => {
  await Promise.all(Array.from({ length: 10 }, (_, i) => mod.setProject('c' + i, path.join(ws, 'gamma'), 'ai')))
  const store = JSON.parse((await import('node:fs')).readFileSync(path.join(home, 'dshx-project', 'projects.json'), 'utf8'))
  for (let i = 0; i < 10; i++) assert.ok(store.sessions['c' + i])
})

await test('candidates list current projects, not containers or noise', async () => {
  const s = await mod.buildState(sid, ws)
  const names = s.candidates.map((c) => c.name)
  assert.ok(names.includes('projects/alpha'))
  assert.ok(names.includes('gamma'))
  assert.ok(!names.includes('projects'))
  assert.ok(!names.some((n) => n.startsWith('archive')))
})

// ---------------------------------------------------------- http + apply
const routes = new Map()
let registeredTool = null
let section = null
const spawned = []
const ctx = {
  logger: () => ({ info() {}, warn() {} }),
  effect: (fn) => fn(),
  webServer: { register: (r) => { routes.set(r.path, r.handler); return () => {} } },
  inject: (deps, cb) => {
    if (deps[0] === 'tools') cb({ tools: { register: (d) => { registeredTool = d } }, get: (n) => n === 'systemPrompt' ? { section: (s) => { section = s } } : undefined })
  },
  get: (n) => n === 'subprocess' ? { spawn: (o) => { spawned.push(o.argv); return { done: Promise.resolve() } } } : undefined,
}
mod.apply(ctx)

const fakeReq = (method, url, body) => {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return { method, url, headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield* chunks } }
}
const fakeRes = () => {
  const res = { status: 0, body: '', headersSent: false }
  res.writeHead = (s) => { res.status = s; res.headersSent = true }
  res.end = (b) => { res.body = b ?? ''; if (!res.status) res.status = res.statusCode ?? 200 }
  return res
}
const hit = async (p, method, url, body) => {
  const res = fakeRes()
  await routes.get(p)(fakeReq(method, url, body), res)
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null }
}

await test('apply registers 4 routes, the tool and the prompt rule', async () => {
  assert.equal(routes.size, 4)
  assert.equal(registeredTool?.name, 'set_project')
  assert.equal(section?.name, 'dshx:project')
  assert.match(section.text, /set_project/)
})

await test('GET state route', async () => {
  const r = await hit('/dshx-project/state', 'GET', '/dshx-project/state?sessionId=' + sid + '&cwd=' + encodeURIComponent(ws))
  assert.equal(r.status, 200)
  assert.equal(r.json.source, 'inferred')
  assert.equal((await hit('/dshx-project/state', 'POST', '/dshx-project/state')).status, 405)
})

await test('POST open with no path opens the resolved project', async () => {
  const r = await hit('/dshx-project/open', 'POST', '/dshx-project/open', { sessionId: sid, cwd: ws })
  assert.equal(r.status, 200)
  assert.equal(r.json.opened, path.join(ws, 'gamma'))
  assert.deepEqual(spawned.at(-1), ['explorer.exe', path.join(ws, 'gamma')])
})

await test('POST open refuses paths outside the workspace', async () => {
  const r = await hit('/dshx-project/open', 'POST', '/dshx-project/open', { sessionId: sid, path: os.tmpdir() })
  assert.equal(r.status, 400)
})

await test('POST set + clear routes', async () => {
  assert.equal((await hit('/dshx-project/set', 'POST', '/x', { sessionId: sid, path: path.join(ws, 'projects', 'alpha') })).status, 200)
  assert.equal((await mod.buildState(sid, ws)).source, 'user')
  assert.equal((await hit('/dshx-project/clear', 'POST', '/x', { sessionId: sid })).status, 200)
  assert.equal((await mod.buildState(sid, ws)).source, 'inferred')
})

console.log(`\n${pass} passed`)
