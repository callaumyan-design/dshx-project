// dshx-project 2.1 — browser half.
//
// No button of its own. The built-in "Open In..." control in the Session
// header posts `{ app, path: <session cwd> }` to `open-in-app/open`; on this
// machine that cwd is the workspace root for almost every session. This module
// re-points that one request at the session's REAL project (user pick > the
// model's set_project > inferred from the session log), so the existing icon
// opens the right folder — in Explorer, VS Code, or whichever app is chosen.
//
// How the session is known at click time: a hidden marker is mounted in each
// Session header's utilities slot carrying its session id and cwd. A capture-
// phase pointer listener records which header the user last clicked in; the
// fetch wrapper only rewrites a launch whose path equals THAT session's cwd.
// Anything else (the Files tab's own directory, other requests) passes through
// untouched, and any failure falls back to the original request.
window.__ModuleLoader__.load({
  id: 'dshx-project',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const NS = 'dshx-project'
    const SLOT = 'conversation.session.header.utilities'
    const MARK = 'data-dshx-project-session'
    const LOOKUP_TIMEOUT_MS = 1500
    const CLICK_WINDOW_MS = 60000

    const norm = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

    /** Session whose header the user last pressed in, with its cwd. */
    let lastHeader = null
    let originalFetch = null

    /** Walk up from the pressed element to the header that holds our marker. */
    function headerOf(target) {
      let node = target instanceof Element ? target : null
      while (node !== null && node !== document.body) {
        const marker = node.querySelector?.('[' + MARK + ']')
        if (marker) return { sessionId: marker.getAttribute(MARK), cwd: marker.getAttribute('data-cwd') || '' }
        node = node.parentElement
      }
      return null
    }

    const onPointer = (event) => {
      const found = headerOf(event.target)
      if (found !== null && found.sessionId) lastHeader = { ...found, at: Date.now() }
    }

    async function lookupProject(sessionId, cwd) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS)
      try {
        const response = await originalFetch('/dshx-project/state?sessionId=' + encodeURIComponent(sessionId)
          + '&cwd=' + encodeURIComponent(cwd), { credentials: 'same-origin', signal: controller.signal })
        if (!response.ok) return null
        const state = await response.json()
        return typeof state?.project === 'string' && state.project.length > 0 ? state.project : null
      } catch {
        return null
      } finally {
        clearTimeout(timer)
      }
    }

    async function patchedFetch(input, init) {
      try {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
        const method = String(init?.method || 'GET').toUpperCase()
        if (method === 'POST' && typeof url === 'string' && /(^|\/)open-in-app\/open(\?|$)/.test(url)
          && typeof init?.body === 'string' && lastHeader !== null && Date.now() - lastHeader.at < CLICK_WINDOW_MS) {
          const body = JSON.parse(init.body)
          if (body && typeof body.path === 'string' && norm(body.path) === norm(lastHeader.cwd)) {
            const project = await lookupProject(lastHeader.sessionId, lastHeader.cwd)
            if (project !== null && norm(project) !== norm(body.path)) {
              return originalFetch(input, { ...init, body: JSON.stringify({ ...body, path: project }) })
            }
          }
        }
      } catch {
        // Any surprise: send the request exactly as the built-in made it.
      }
      return originalFetch(input, init)
    }

    /** Invisible header marker: tells the press listener which session this header is. */
    function HeaderMarker(props) {
      const { sessionId, useSessions } = props
      const cwd = useSessions((state) => state.byId[sessionId]?.cwd)
      if (!sessionId) return null
      return React.createElement('span', {
        [MARK]: sessionId,
        'data-cwd': cwd || '',
        hidden: true,
        style: { display: 'none' },
      })
    }

    exports.name = NS
    exports.inject = ['slots', 'sessions']

    exports.apply = (ctx) => {
      ctx.effect(() => {
        if (window.__dshxProjectFetchPatched) return () => {}
        originalFetch = window.fetch.bind(window)
        window.fetch = patchedFetch
        window.__dshxProjectFetchPatched = true
        document.addEventListener('pointerdown', onPointer, true)
        return () => {
          if (window.fetch === patchedFetch) window.fetch = originalFetch
          window.__dshxProjectFetchPatched = false
          document.removeEventListener('pointerdown', onPointer, true)
        }
      }, 'dshx-project: open-in-app redirect')

      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: NS,
        order: 100,
      }, HeaderMarker))
    }

    return exports
  },
})
