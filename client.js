// dshx-project — browser half.
//
// Contributes a Session-header control ("项目") next to the built-in "Open In..."
// button. Where the built-in button answers "which application?", this one
// answers "which project?" — because a session's `cwd` is immutable and, on this
// machine, is the workspace root for every session.
//
// The header shows the recorded project's basename; the menu lists the
// directories that actually exist under the workspace so one can be picked. The
// built-in button is left completely untouched.
//
// Backed by the host half:
//   GET  /dshx-project/state?sessionId=...&cwd=...
//   POST /dshx-project/set    { sessionId, path }
//   POST /dshx-project/clear  { sessionId }
//   POST /dshx-project/open   { sessionId, path? }
window.__ModuleLoader__.load({
  id: 'dshx-project',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const NS = 'dshx-project'
    const BASE = '/dshx-project'
    const SLOT = 'conversation.session.header.utilities'

    // -----------------------------------------------------------------------
    // styles — matched to the built-in header controls so the pair reads as one
    // -----------------------------------------------------------------------

    const control = {
      boxSizing: 'border-box',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      height: 28,
      maxWidth: 220,
      padding: '5px 6px 5px 9px',
      border: '0.5px solid var(--dsw-alias-border-l4)',
      borderRadius: 14,
      overflow: 'hidden',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      fontFamily: 'var(--dsw-font-family)',
      fontSize: 11,
      fontWeight: 400,
      lineHeight: '16px',
      whiteSpace: 'nowrap',
      cursor: 'pointer',
    }
    const label = { overflow: 'hidden', textOverflow: 'ellipsis' }
    const dim = Object.assign({}, control, { color: 'var(--dsw-alias-label-dimmed)' })

    // Self-contained popover, so this plugin needs nothing but React.
    const popover = {
      position: 'absolute',
      top: 'calc(100% + 4px)',
      right: 0,
      zIndex: 40,
      minWidth: 220,
      maxWidth: 380,
      maxHeight: 340,
      overflowY: 'auto',
      padding: 4,
      border: '0.5px solid var(--dsw-alias-border-l4)',
      borderRadius: 10,
      background: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, #fff))',
      boxShadow: '0 6px 24px rgba(0,0,0,0.18)',
      fontFamily: 'var(--dsw-font-family)',
      fontSize: 11,
      lineHeight: '16px',
      color: 'var(--dsw-alias-label-primary)',
      textAlign: 'left',
    }
    const popoverGroup = {
      padding: '4px 8px 2px',
      fontSize: 10,
      color: 'var(--dsw-alias-label-dimmed)',
      whiteSpace: 'nowrap',
    }
    const popoverRow = {
      display: 'block',
      width: '100%',
      padding: '6px 8px',
      border: 0,
      borderRadius: 6,
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      textAlign: 'left',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      cursor: 'pointer',
    }
    const popoverEmpty = {
      padding: '8px',
      color: 'var(--dsw-alias-label-dimmed)',
      whiteSpace: 'normal',
    }

    // -----------------------------------------------------------------------
    // host transport
    // -----------------------------------------------------------------------

    const callHost = async (path, init) => {
      const response = await fetch(BASE + path, { credentials: 'same-origin', ...init })
      if (!response.ok) {
        let detail = ''
        try {
          const body = await response.json()
          if (typeof body?.error === 'string') detail = body.error
        } catch {
          // A non-JSON error body still surfaces as the status below.
        }
        throw new Error(detail || ('HTTP ' + response.status))
      }
      return response.json()
    }

    // -----------------------------------------------------------------------
    // component
    // -----------------------------------------------------------------------

    function ProjectAction(props) {
      // A session-scoped slot receives the standard kit: `sessionId` as a plain
      // prop and every standard hook exposed as `use<Name>`. The session's cwd
      // rides the sessions feed, exactly as the built-in "Open In..." button
      // reads it.
      const { sessionId, useSessions, t } = props
      const cwd = useSessions((state) => state.byId[sessionId]?.cwd)
      const [state, setState] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [reloadKey, setReloadKey] = React.useState(0)

      const load = React.useCallback(() => {
        if (!sessionId) return
        const query = '?sessionId=' + encodeURIComponent(sessionId)
          + (cwd ? '&cwd=' + encodeURIComponent(cwd) : '')
        callHost('/state' + query)
          .then((next) => { setState(next); setError(null) })
          .catch((reason) => { setError(String(reason?.message ?? reason)) })
      }, [sessionId, cwd])

      React.useEffect(() => { load() }, [load, reloadKey])

      // A long conversation keeps the same session id, so nothing here polls:
      // the data only changes through this menu or the model's tool call, and
      // the latter is picked up on the next menu open.
      React.useEffect(() => {
        if (open) setReloadKey((key) => key + 1)
      }, [open])

      if (!sessionId) return null

      const project = state?.project ?? null
      const exists = state?.exists === true
      const candidates = Array.isArray(state?.candidates) ? state.candidates : []

      const basenameOf = (value) => {
        if (typeof value !== 'string' || value.length === 0) return ''
        const parts = value.replace(/[\\/]+$/, '').split(/[\\/]/)
        return parts[parts.length - 1] || value
      }

      const run = (promise) => {
        setBusy(true)
        setError(null)
        promise
          .then(() => { setBusy(false); setReloadKey((key) => key + 1) })
          .catch((reason) => {
            setBusy(false)
            setError(String(reason?.message ?? reason))
          })
      }

      const openPath = (target) => {
        setOpen(false)
        if (busy) return
        run(callHost('/open', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, path: target }),
        }))
      }

      const choose = (target) => {
        setOpen(false)
        if (busy) return
        run(callHost('/set', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, path: target }),
        }))
      }

      // Menu: recorded project first (open / forget), then the candidates.
      const rows = []
      if (project !== null) {
        rows.push({ group: t('menu.groupCurrent'), id: '__current', text: t('menu.current', { name: basenameOf(project) }), run: () => openPath(project) })
      }
      for (const candidate of candidates) {
        rows.push({
          group: t('menu.groupCandidates'),
          id: candidate.path,
          text: candidate.name + (candidate.depth > 1 ? '  ·  ' + candidate.path : ''),
          run: () => choose(candidate.path),
        })
      }
      if (project !== null) {
        rows.push({
          group: t('menu.groupManage'),
          id: '__forget',
          text: t('menu.forget'),
          run: () => {
            setOpen(false)
            run(callHost('/clear', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId }),
            }))
          },
        })
      }

      const text = busy
        ? t('label.working')
        : project === null
          ? t('label.none')
          : basenameOf(project)
      const title = project === null
        ? t('title.none')
        : t('title.set', { path: project })

      const dress = busy || project === null ? dim : control

      // A self-contained dropdown, so this plugin depends on nothing but React.
      let lastGroup = null
      const menu = open
        ? React.createElement(
            'div',
            { style: popover, role: 'menu' },
            rows.length === 0
              ? React.createElement('div', { style: popoverEmpty }, t('menu.empty'))
              : rows.map((row) => {
                  const header = row.group !== lastGroup
                    ? React.createElement('div', { key: row.id + ':g', style: popoverGroup }, row.group)
                    : null
                  lastGroup = row.group
                  return React.createElement(
                    React.Fragment,
                    { key: row.id },
                    header,
                    React.createElement(
                      'button',
                      {
                        type: 'button',
                        role: 'menuitem',
                        style: popoverRow,
                        title: row.id.startsWith('__') ? undefined : row.id,
                        onClick: () => { setOpen(false); row.run() },
                        onMouseEnter: (event) => { event.currentTarget.style.background = 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.14))' },
                        onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
                      },
                      row.text,
                    ),
                  )
                }),
          )
        : null

      return React.createElement(
        'div',
        { style: { display: 'inline-flex', alignItems: 'center', position: 'relative' } },
        React.createElement(
          'button',
          {
            type: 'button',
            style: Object.assign({}, dress, exists || project === null ? {} : { opacity: 0.75 }),
            title: title + (exists || project === null ? '' : '\n' + t('title.missing')),
            onClick: () => setOpen((value) => !value),
          },
          React.createElement('span', { style: label }, text),
        ),
        menu,
        error !== null
          ? React.createElement(
              'span',
              {
                style: {
                  marginLeft: 4,
                  fontSize: 10,
                  color: 'var(--dsw-alias-label-danger, #d33)',
                  maxWidth: 160,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
                title: error,
              },
              error,
            )
          : null,
      )
    }

    // -----------------------------------------------------------------------
    // apply
    // -----------------------------------------------------------------------

    exports.name = NS
    exports.inject = ['slots', 'locale', 'sessions']

    exports.apply = (ctx) => {
      ctx.effect(() => ctx.locale.register(NS, {
        zh: {
          'label.none': '未记录项目',
          'label.working': '处理中…',
          'title.none': '本会话没有记录项目。点开可以从工作区里选一个。',
          'title.set': '本会话的项目：{path}\n点击可打开或改选。',
          'title.missing': '注意：该目录当前不存在。',
          'menu.current': '打开 {name}',
          'menu.forget': '忘记本项目',
          'menu.empty': '工作区里没有可选目录。',
          'menu.groupCurrent': '当前项目',
          'menu.groupCandidates': '工作区中的目录',
          'menu.groupManage': '管理',
        },
        en: {
          'label.none': 'No project',
          'label.working': 'Working…',
          'title.none': 'No project recorded for this session. Open to pick one.',
          'title.set': 'This session\'s project: {path}\nClick to open or change.',
          'title.missing': 'Note: that directory no longer exists.',
          'menu.current': 'Open {name}',
          'menu.forget': 'Forget project',
          'menu.empty': 'No candidate directories in the workspace.',
          'menu.groupCurrent': 'Current project',
          'menu.groupCandidates': 'Directories in workspace',
          'menu.groupManage': 'Manage',
        },
      }), 'dshx-project: dictionaries')

      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: NS,
        order: 5,
        locale: NS,
        inject: (sessionId) => ({ sessionId }),
      }, ProjectAction))
    }

    return exports
  },
})
