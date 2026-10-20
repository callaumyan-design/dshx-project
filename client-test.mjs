// client.js redirect test with a fake window/document/fetch. Run: node client-test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const calls = []
const listeners = {}
class El {
  constructor(attrs = {}, children = [], parent = null) { this.attrs = attrs; this.children = children; this.parentElement = parent; for (const c of children) c.parentElement = this }
  getAttribute(n) { return this.attrs[n] ?? null }
  querySelector(sel) {
    const name = sel.slice(1, -1)
    const walk = (e) => { for (const c of e.children) { if (name in c.attrs) return c; const f = walk(c); if (f) return f } return null }
    return walk(this)
  }
}
const body = new El()
// header: utilities container holds the built-in button + our marker
const builtinBtn = new El({})
const marker = new El({ 'data-dshx-project-session': 'S1', 'data-cwd': 'F:\\ds' })
const utilities = new El({}, [builtinBtn, marker], body)
const otherPanelBtn = new El({}, [], body)

let stateProject = 'F:\\ds\\projects\\rivers-end'
const fakeFetch = async (input, init) => {
  calls.push({ input, init })
  if (String(input).startsWith('/dshx-project/state')) return { ok: true, json: async () => ({ project: stateProject }) }
  return { ok: true, json: async () => ({}) }
}

let loaded
const window = {
  fetch: fakeFetch,
  __ModuleLoader__: { load: (m) => { loaded = m.factory((id) => (id === 'react' ? { createElement: (...a) => a } : null)) } },
}
const document = {
  body,
  addEventListener: (t, fn) => { listeners[t] = fn },
  removeEventListener: () => {},
}
vm.runInNewContext(readFileSync(new URL('./client.js', import.meta.url), 'utf8'), {
  window, document, Element: El, URL, AbortController, setTimeout, clearTimeout, Date, JSON, Object, Symbol, String, RegExp,
})

const effects = []
let registered
loaded.apply({
  effect: (fn) => effects.push(fn()),
  slots: { inject: (_n, fn) => fn(), register: (spec, comp) => { registered = { spec, comp } } },
})

const post = (path) => window.fetch('open-in-app/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app: 'explorer', path }) })
const lastOpenBody = () => JSON.parse(calls.filter((c) => String(c.input).includes('open-in-app')).at(-1).init.body)

let n = 0
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name) }

await t('registers a hidden marker in the header slot', async () => {
  assert.equal(registered.spec.name, 'conversation.session.header.utilities')
  const out = registered.comp({ sessionId: 'S1', useSessions: (sel) => sel({ byId: { S1: { cwd: 'F:\\ds' } } }) })
  assert.equal(out[1]['data-dshx-project-session'], 'S1')
  assert.equal(out[1]['data-cwd'], 'F:\\ds')
})

await t('no header click yet -> request untouched', async () => {
  await post('F:\\ds')
  assert.equal(lastOpenBody().path, 'F:\\ds')
})

await t('click built-in icon in header -> redirected to real project', async () => {
  listeners.pointerdown({ target: builtinBtn })
  await post('F:\\ds')
  assert.deepEqual(lastOpenBody(), { app: 'explorer', path: 'F:\\ds\\projects\\rivers-end' })
})

await t('other app choice is redirected too (app preserved)', async () => {
  await window.fetch('open-in-app/open', { method: 'POST', body: JSON.stringify({ app: 'vscode', path: 'F:/ds/' }) })
  assert.deepEqual(lastOpenBody(), { app: 'vscode', path: 'F:\\ds\\projects\\rivers-end' })
})

await t('a different path (e.g. Files tab subfolder) is untouched', async () => {
  await post('F:\\ds\\docs')
  assert.equal(lastOpenBody().path, 'F:\\ds\\docs')
})

await t('click outside any header does not change the remembered session', async () => {
  listeners.pointerdown({ target: otherPanelBtn })
  await post('F:\\ds')
  assert.equal(lastOpenBody().path, 'F:\\ds\\projects\\rivers-end')
})

await t('state lookup fails -> original request', async () => {
  stateProject = null
  await post('F:\\ds')
  assert.equal(lastOpenBody().path, 'F:\\ds')
})

await t('non-open requests pass through unchanged', async () => {
  const before = calls.length
  await window.fetch('open-in-app/apps')
  assert.equal(calls.length, before + 1)
  assert.equal(calls.at(-1).input, 'open-in-app/apps')
})

console.log(`\n${n} passed`)
