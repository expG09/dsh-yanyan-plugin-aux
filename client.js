/**
 * dsh-yanyan-plugin-aux —— 浏览器半端：设置页
 * ============================================================================
 * ⚠️ client bundle 不是 ESM，是**自注册脚本**：
 *
 *     window.__ModuleLoader__.load({
 *       id: 'dsh-yanyan-plugin-aux',        // 必须等于 package.json 的 name
 *       factory: (require) => ({ inject: ['slots'], apply(ctx) { ... } }),
 *     })
 *
 * 进「设置」的写法照抄 dsh-bili-scroll / dsh-meme：
 *
 *     const slots = ctx.get('slots')
 *     slots.inject('settings.section', () => slots.register(
 *       { name: 'settings.section', id: 'aux', order: 30, label: '砚砚工具包' },
 *       () => h(Panel),
 *     ))
 *
 * 页面里的四项配置全部走宿主的 /api/aux：GET 取、POST 存、POST /reset 恢复默认。
 * 保存后宿主会立刻热更新，不用重启 DSH。
 *
 * 最下面还有一节「QQ 群会话换新」：GET /api/aux/bindings 列绑定，
 * POST /api/aux/rotate 把某一条的 sessionId 换成新铸的（宿主负责备份与原子写回）。
 * 这一节只改 qqbot 的 model-prefs.json，不动网页/手机这边的会话；qqbot 只在启动时
 * 读这个文件，所以界面提示「重启桌面端后生效」。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-yanyan-plugin-aux',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/aux'

    /* ⚠️ 不看 res.ok 的话，HTTP 500 的 { ok:false, error } 会被当成“已保存”。
       失败时优先把宿主给的 error 原文带出来，方便看出是“sessionKey 不在文件里”
       这类具体原因，而不是只有一句 HTTP 400。 */
    const asJson = async (res) => {
      if (res.ok) return res.json()
      let detail = ''
      try {
        const body = await res.json()
        if (body && typeof body.error === 'string') detail = body.error
      } catch {
        // 响应不是 JSON 就只用状态码
      }
      const why = res.status === 403 ? '（被宿主拦了）' : res.status === 500 ? '（宿主内部错误）' : ''
      throw new Error(detail || ('HTTP ' + res.status + why))
    }
    const jget = async (path) => asJson(await fetch(API + path, { credentials: 'same-origin' }))
    const jpost = async (path, body) => asJson(await fetch(API + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    /* 样式一律行内：颜色只用 currentColor / 宿主主题变量，背景透明，
       这样深色浅色主题都能跟宿主走。 */
    const S = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
        padding: '2px 2px 8px',
        maxWidth: 640,
        color: 'inherit',
      },
      field: { display: 'flex', flexDirection: 'column', gap: 6 },
      label: { fontSize: 13, fontWeight: 600 },
      note: {
        fontSize: 11,
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-tertiary, #9aa0a6)',
      },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '6px 8px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-weak, rgba(128,128,128,.4))',
        background: 'transparent',
        color: 'inherit',
        fontSize: 13,
        fontFamily: 'inherit',
        outline: 'none',
      },
      hint: { fontSize: 12, lineHeight: '18px', color: 'inherit', opacity: 0.7 },
      error: { fontSize: 12, lineHeight: '18px', color: '#e5484d' },
      ok: { fontSize: 12, lineHeight: '18px', color: 'inherit', opacity: 0.75 },
      row: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      footer: { display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 2 },
      button: (primary, disabled) => ({
        fontSize: 13,
        fontWeight: primary ? 600 : 400,
        padding: '6px 14px',
        borderRadius: 6,
        border: '1px solid ' + (primary
          ? 'currentColor'
          : 'var(--dsw-alias-border-weak, rgba(128,128,128,.4))'),
        background: 'transparent',
        color: 'inherit',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }),
      switchButton: (on, disabled) => ({
        fontSize: 12,
        minWidth: 64,
        padding: '3px 10px',
        borderRadius: 999,
        border: '1px solid ' + (on
          ? 'currentColor'
          : 'var(--dsw-alias-border-weak, rgba(128,128,128,.4))'),
        background: 'transparent',
        color: 'inherit',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }),
      /* QQ 群会话换新那一节 */
      section: {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        paddingTop: 14,
        borderTop: '1px solid var(--dsw-alias-border-weak, rgba(128,128,128,.25))',
      },
      sectionTitle: { fontSize: 13, fontWeight: 600 },
      warn: { fontSize: 12, lineHeight: '18px', color: 'inherit', opacity: 0.85 },
      qqRow: {
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '6px 0',
        borderTop: '1px solid var(--dsw-alias-border-weak, rgba(128,128,128,.12))',
      },
      qqHead: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      qqIds: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap',
        fontFamily: 'ui-monospace, monospace',
        fontSize: 12,
      },
      mono: { fontFamily: 'ui-monospace, monospace' },
    }

    /** 宿主的设置对象 → 页面里的草稿（数字和阈值都先变成字符串）。 */
    const toDraft = (settings) => ({
      clockIntervalHours: String(settings.clockIntervalHours ?? 6),
      thresholds: Array.isArray(settings.thresholds) ? settings.thresholds.join(',') : '',
      injectPerTurn: settings.injectPerTurn !== false,
      clockFile: String(settings.clockFile ?? ''),
    })

    /** 逗号分隔的阈值文本 → 数字数组；真正合法化由宿主 normalizeSettings 做。 */
    const parseThresholds = (text) => String(text || '')
      .split(/[,，、\s]+/)
      .map((piece) => Number(piece))
      .filter((value) => Number.isFinite(value))

    /** 普通的一行字段：标题 + 控件 + 说明。 */
    function Field({ title, note, children }) {
      return h('div', { style: S.field },
        h('div', { style: S.label }, title),
        children,
        note ? h('div', { style: S.note }, note) : null,
      )
    }

    function Panel() {
      const [draft, setDraft] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [saving, setSaving] = React.useState('') // '' | 'save' | 'reset'
      const [error, setError] = React.useState('')
      const [status, setStatus] = React.useState('')
      const alive = React.useRef(true)

      React.useEffect(() => () => {
        alive.current = false
      }, [])

      const load = React.useCallback(() => {
        setLoading(true)
        setError('')
        jget('/settings')
          .then((r) => {
            if (!alive.current) return
            // settings 是设置文件里的；文件还没建时退回 effective（当前实际生效）
            const picked = r?.settings ?? r?.effective
            if (!picked) throw new Error('宿主没有返回设置')
            setDraft(toDraft(picked))
            setLoading(false)
          })
          .catch((err) => {
            if (!alive.current) return
            setError(String(err?.message ?? err))
            setLoading(false)
          })
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      /** 用宿主返回的（已经规整过的）设置回填页面。 */
      const applyServer = (r) => {
        if (r?.settings) setDraft(toDraft(r.settings))
        else if (r?.effective) setDraft(toDraft(r.effective))
      }

      const save = async () => {
        if (!draft || saving) return
        setError('')
        setStatus('')

        const hours = Number(draft.clockIntervalHours)
        if (!Number.isFinite(hours) || hours < 1 || hours > 168) {
          setError('时钟间隔必须是 1–168 之间的数字')
          return
        }
        const clockFile = draft.clockFile.trim()
        if (!/^[A-Za-z]:[\\/]/.test(clockFile) && !clockFile.startsWith('/')) {
          setError('时钟文件必须是非空绝对路径（例如 D:\\... 或 /...）')
          return
        }

        setSaving('save')
        try {
          const r = await jpost('/settings', {
            clockFile,
            clockIntervalHours: hours,
            injectPerTurn: draft.injectPerTurn,
            thresholds: parseThresholds(draft.thresholds),
          })
          if (!alive.current) return
          applyServer(r)
          setStatus('已保存 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }))
        } catch (err) {
          if (alive.current) setError('保存失败：' + String(err?.message ?? err))
        } finally {
          if (alive.current) setSaving('')
        }
      }

      const reset = async () => {
        if (saving) return
        setError('')
        setStatus('')
        setSaving('reset')
        try {
          await jpost('/reset', {})
          if (!alive.current) return
          // 重新读一次：页面显示回落到 patch 默认之后的那一份
          const r = await jget('/settings')
          if (!alive.current) return
          const picked = r?.settings ?? r?.effective
          if (picked) setDraft(toDraft(picked))
          setStatus('已恢复默认设置')
        } catch (err) {
          if (alive.current) setError('恢复默认失败：' + String(err?.message ?? err))
        } finally {
          if (alive.current) setSaving('')
        }
      }

      // 加载中
      if (loading && draft === null) {
        return h('div', { style: S.page },
          h('div', { style: S.hint }, '读取设置中…'))
      }

      // 读失败：把错误和重试一起给出来，不装成空页面
      if (draft === null) {
        return h('div', { style: S.page },
          h('div', { style: S.error }, '读取设置失败：' + (error || '宿主没有响应')),
          h('div', { style: S.row },
            h('button', {
              type: 'button',
              style: S.button(true, false),
              onClick: load,
            }, '重试')))
      }

      const disabled = saving !== ''

      return h('div', { style: S.page },
        h(Field, {
          title: '时钟间隔',
          note: h('span', null,
            '写一行 ',
            h('code', { style: { fontFamily: 'ui-monospace, monospace' } }, 'YYYY-MM-DD HH:mm'),
            '，进程启动时先补一行。'),
        },
          h('div', { style: S.row },
            h('input', {
              type: 'number',
              min: 1,
              max: 168,
              step: 1,
              value: draft.clockIntervalHours,
              disabled,
              onChange: (e) => setDraft({ ...draft, clockIntervalHours: e.target.value }),
              style: { ...S.input, width: 120 },
            }),
            h('span', { style: S.hint }, '小时（1–168）'))),

        h(Field, {
          title: '提醒阈值',
          note: '同一会话每个阈值只提醒一次。',
        },
          h('input', {
            type: 'text',
            value: draft.thresholds,
            disabled,
            placeholder: '50,70',
            onChange: (e) => setDraft({ ...draft, thresholds: e.target.value }),
            style: S.input,
          })),

        h(Field, {
          title: '每轮注入',
          note: '关掉后只在跨阈值时提醒。',
        },
          h('div', { style: S.row },
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': draft.injectPerTurn,
              disabled,
              onClick: () => setDraft({ ...draft, injectPerTurn: !draft.injectPerTurn }),
              style: S.switchButton(draft.injectPerTurn, disabled),
            }, draft.injectPerTurn ? '已开启' : '已关闭'),
            h('span', { style: S.hint }, draft.injectPerTurn
              ? '每个 turn 的第一步注入一条水位读数'
              : '不每轮注入，只在跨阈值时提醒'))),

        h(Field, {
          title: '时钟文件',
          note: '绝对路径，父目录会自建。',
        },
          h('input', {
            type: 'text',
            value: draft.clockFile,
            disabled,
            placeholder: 'G:\\...\\clock.md',
            onChange: (e) => setDraft({ ...draft, clockFile: e.target.value }),
            style: { ...S.input, fontFamily: 'ui-monospace, monospace' },
          })),

        h('div', { style: S.footer },
          h('div', { style: S.row },
            h('button', {
              type: 'button',
              disabled,
              onClick: save,
              style: S.button(true, disabled),
            }, saving === 'save' ? '保存中…' : '保存'),
            h('button', {
              type: 'button',
              disabled,
              onClick: reset,
              style: S.button(false, disabled),
            }, saving === 'reset' ? '恢复中…' : '恢复默认'),
            status ? h('span', { style: S.ok }, status) : null),
          error ? h('div', { style: S.error }, error) : null),

        // 现有四项配置下面：QQ 群会话换新（独立于上面这份设置文件）
        h(QqRotate))
    }

    /* ─────────────── QQ 群会话换新 ─────────────── */

    /** 取末尾 8 位给页面看；完整值放在 title 里悬停可见。 */
    const tail8 = (value) => {
      const text = String(value ?? '')
      return text.length > 8 ? text.slice(-8) : text
    }

    /** 一节「QQ 群会话换新」：列绑定、逐条换新。只影响 QQ 群聊，不动别的会话。 */
    function QqRotate() {
      const [bindings, setBindings] = React.useState(null) // null = 还没读到
      const [error, setError] = React.useState('')
      const [rotating, setRotating] = React.useState('') // 正在换新的 sessionKey
      const [done, setDone] = React.useState({}) // sessionKey → { oldId, newId }
      const [rowError, setRowError] = React.useState({}) // sessionKey → 错误文本
      const alive = React.useRef(true)

      React.useEffect(() => () => {
        alive.current = false
      }, [])

      const load = React.useCallback(() => {
        setError('')
        jget('/bindings')
          .then((r) => {
            if (!alive.current) return
            setBindings(Array.isArray(r?.bindings) ? r.bindings : [])
          })
          .catch((err) => {
            if (!alive.current) return
            setError('读取 QQ 群会话绑定失败：' + String(err?.message ?? err))
            setBindings(null)
          })
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      const rotate = async (sessionKey) => {
        if (rotating) return
        setRotating(sessionKey)
        setRowError((prev) => ({ ...prev, [sessionKey]: '' }))
        try {
          const r = await jpost('/rotate', { sessionKey })
          if (!alive.current) return
          if (r?.ok !== true) throw new Error(r?.error || '宿主没有返回 ok')
          setDone((prev) => ({
            ...prev,
            [sessionKey]: { oldId: r.oldSessionId, newId: r.newSessionId },
          }))
          // 行内显示的 sessionId 跟着改成新的
          setBindings((prev) => (Array.isArray(prev)
            ? prev.map((item) => (item.sessionKey === sessionKey
              ? { ...item, sessionId: r.newSessionId }
              : item))
            : prev))
        } catch (err) {
          if (alive.current) {
            setRowError((prev) => ({
              ...prev,
              [sessionKey]: '换新失败：' + String(err?.message ?? err),
            }))
          }
        } finally {
          if (alive.current) setRotating('')
        }
      }

      const body = []
      if (error) {
        body.push(h('div', { style: S.error }, error))
        body.push(h('div', { style: S.row },
          h('button', { type: 'button', style: S.button(false, false), onClick: load }, '重试')))
      } else if (bindings === null) {
        body.push(h('div', { style: S.hint }, '读取 QQ 群会话绑定中…'))
      } else if (bindings.length === 0) {
        body.push(h('div', { style: S.hint }, '没有找到 QQ 群会话绑定'))
      } else {
        for (const item of bindings) {
          const result = done[item.sessionKey]
          body.push(h('div', { key: item.sessionKey, style: S.qqRow },
            h('div', { style: S.qqHead },
              h('div', { style: S.qqIds },
                h('span', { title: '会话类型' }, item.kind),
                h('span', { title: item.peerId }, tail8(item.peerId)),
                h('span', null, '·'),
                h('span', { title: item.sessionId }, tail8(item.sessionId))),
              h('button', {
                type: 'button',
                disabled: rotating === item.sessionKey,
                onClick: () => rotate(item.sessionKey),
                style: S.button(false, rotating === item.sessionKey),
              }, rotating === item.sessionKey ? '换新中…' : '换新')),
            result
              ? h('div', { style: S.ok }, '已换新：旧 ' + tail8(result.oldId) + ' → 新 ' + tail8(result.newId))
              : null,
            result
              ? h('div', { style: S.note }, '重启桌面端后生效（从托盘退出再打开，新会话才接上）。' +
                'qqbot 把会话绑定缓存在内存里，重启才会重读文件。')
              : null,
            rowError[item.sessionKey]
              ? h('div', { style: S.error }, rowError[item.sessionKey])
              : null))
        }
      }

      return h('div', { style: S.section },
        h('div', { style: S.sectionTitle }, 'QQ 群会话换新'),
        h('div', { style: S.note },
          '只影响 QQ 群聊里的会话；网页和手机这边的会话不受影响，要换请在界面上新开会话。'),
        h('div', { style: S.warn }, '换新前建议先让助手写一份交接。'),
        ...body)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 设置页挂进「设置」左侧导航（label 就是那一项的名字）
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'aux', order: 30, label: '砚砚工具包' },
          () => h(Panel),
        ))
      },
    }
  },
})
