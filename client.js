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
 * 页面里的配置全部走宿主的 /api/aux：GET 取、POST 存、POST /reset 恢复默认。
 * 保存后宿主会立刻热更新，不用重启 DSH。
 *
 * 具名项：生效范围（会话限定，管所有注入）、时钟间隔、提醒交接、即将折叠、即将用完、
 * 换会话提醒周期（三选一，选中哪个就只显示对应那个输入）。每项下面都有一行小字，说清
 * 「管什么、范围多少、什么时候生效」。
 * 「生效范围」放在最上面，因为它是**全局**的：留空 = 所有会话都收到读数与提醒，非空就只在
 * 匹配的会话里注入（时钟行不受影响）。
 * 三档百分比必须递增（提醒交接 < 即将折叠 < 即将用完）：保存前在本页先拦一道，
 * 不递增就就地报错、不发请求；宿主那边 normalizeSettings 还会再修一道。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-yanyan-plugin-aux',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/aux'

    /** 换新提醒的三种周期模式；顺序就是下拉里的顺序。 */
    const MODES = [
      { value: 'interval', label: '按间隔（每 N 天）' },
      { value: 'weekly', label: '每周（星期几）' },
      { value: 'monthly', label: '每月（几号）' },
    ]

    /** 星期几：0 = 周日 … 6 = 周六，按中国人的习惯从周一排到周日。 */
    const WEEKDAYS = [
      { value: '1', label: '周一' },
      { value: '2', label: '周二' },
      { value: '3', label: '周三' },
      { value: '4', label: '周四' },
      { value: '5', label: '周五' },
      { value: '6', label: '周六' },
      { value: '0', label: '周日' },
    ]

    /* ⚠️ 不看 res.ok 的话，HTTP 500 的 { ok:false, error } 会被当成“已保存”。
       失败时优先把宿主给的 error 原文带出来，方便看出是校验没过还是磁盘写不了，
       而不是只有一句 HTTP 400。 */
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
      select: {
        padding: '6px 8px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-weak, rgba(128,128,128,.4))',
        background: 'transparent',
        color: 'inherit',
        fontSize: 13,
        fontFamily: 'inherit',
        outline: 'none',
        minWidth: 180,
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
      mono: { fontFamily: 'ui-monospace, monospace' },
    }

    /**
     * 宿主的设置对象 → 页面里的草稿。
     * 数字统一先变成字符串，方便输入框里编辑到半截（比如清空重打）也不跳；
     * 会话范围用逗号拼成一行。
     */
    const toDraft = (settings) => ({
      scopeSessions: Array.isArray(settings.scopeSessions) ? settings.scopeSessions.join(',') : '',
      clockIntervalHours: String(settings.clockIntervalHours ?? 6),
      clockFile: String(settings.clockFile ?? ''),
      injectPerTurn: settings.injectPerTurn !== false,
      handoverPercent: String(settings.handoverPercent ?? 50),
      compactSoonPercent: String(settings.compactSoonPercent ?? 75),
      nearlyFullPercent: String(settings.nearlyFullPercent ?? 90),
      rotateReminderMode: MODES.some((item) => item.value === settings.rotateReminderMode)
        ? settings.rotateReminderMode
        : 'weekly',
      rotateReminderDays: String(settings.rotateReminderDays ?? 7),
      rotateReminderWeekday: String(settings.rotateReminderWeekday ?? 6),
      rotateReminderDayOfMonth: String(settings.rotateReminderDayOfMonth ?? 1),
    })

    /** 文本 → 数字；空串 / 非数字返回 null（交给校验按“填错了”处理）。 */
    const numOf = (text) => {
      const trimmed = String(text ?? '').trim()
      if (trimmed === '') return null
      const value = Number(trimmed)
      return Number.isFinite(value) ? value : null
    }

    /**
     * 逗号分隔的生效范围 → 去空白、去空串、去重的数组。
     * 真正合法化由宿主 normalizeSettings 做；这里只把输入整理干净。
     */
    const parseSessionList = (text) => {
      const seen = new Set()
      for (const piece of String(text ?? '').split(/[,，、\s]+/)) {
        const trimmed = piece.trim()
        if (trimmed !== '') seen.add(trimmed)
      }
      return [...seen]
    }

    /** 普通的一行字段：标题 + 控件 + 说明。说明统一是一行灰色小字。 */
    function Field({ title, note, children }) {
      return h('div', { style: S.field },
        h('div', { style: S.label }, title),
        children,
        note ? h('div', { style: S.note }, note) : null,
      )
    }

    /** 数字输入框 + 「单位」提示，各个数字项共用这一个形状。 */
    function NumberRow({ value, disabled, min, max, step, unit, onChange }) {
      return h('div', { style: S.row },
        h('input', {
          type: 'number',
          min,
          max,
          step,
          value,
          disabled,
          onChange: (e) => onChange(e.target.value),
          style: { ...S.input, width: 120 },
        }),
        unit ? h('span', { style: S.hint }, unit) : null)
    }

    /** 下拉框；换新提醒的周期和「星期几」都用它。 */
    function SelectRow({ value, disabled, options, onChange }) {
      return h('div', { style: S.row },
        h('select', {
          value,
          disabled,
          onChange: (e) => onChange(e.target.value),
          style: S.select,
        }, options.map((item) => h('option', { key: item.value, value: item.value }, item.label))))
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

        const hours = numOf(draft.clockIntervalHours)
        if (hours === null || hours < 1 || hours > 168) {
          setError('时钟间隔必须是 1–168 之间的数字')
          return
        }
        const clockFile = draft.clockFile.trim()
        if (!/^[A-Za-z]:[\\/]/.test(clockFile) && !clockFile.startsWith('/')) {
          setError('时钟文件必须是非空绝对路径（例如 D:\\... 或 /...）')
          return
        }

        const handover = numOf(draft.handoverPercent)
        const compactSoon = numOf(draft.compactSoonPercent)
        const nearlyFull = numOf(draft.nearlyFullPercent)
        for (const [value, name] of [
          [handover, '提醒交接'],
          [compactSoon, '即将折叠'],
          [nearlyFull, '即将用完'],
        ]) {
          if (value === null || !Number.isInteger(value) || value < 1 || value > 100) {
            setError(name + '必须是 1–100 之间的整数')
            return
          }
        }
        // 三档必须严格递增：不递增就地拦下，不发请求（后端还有一道排序修正）
        if (!(handover < compactSoon && compactSoon < nearlyFull)) {
          setError('三档百分比必须递增：提醒交接 < 即将折叠 < 即将用完')
          return
        }

        // 换新提醒的周期：只校验当前模式对应的那个输入，另外两个按默认兜底发过去
        const mode = draft.rotateReminderMode
        if (!MODES.some((item) => item.value === mode)) {
          setError('换会话提醒周期只能是按间隔 / 每周 / 每月')
          return
        }
        const days = numOf(draft.rotateReminderDays)
        const weekday = numOf(draft.rotateReminderWeekday)
        const dayOfMonth = numOf(draft.rotateReminderDayOfMonth)
        if (mode === 'interval') {
          if (days === null || !Number.isInteger(days) || days < 1 || days > 365) {
            setError('「每 N 天」必须是 1–365 之间的整数')
            return
          }
        } else if (mode === 'weekly') {
          if (weekday === null || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
            setError('「星期几」必须是周一…周日之一')
            return
          }
        } else if (dayOfMonth === null || !Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28) {
          setError('「每月几号」必须是 1–28 之间的整数')
          return
        }

        setSaving('save')
        try {
          const r = await jpost('/settings', {
            clockFile,
            clockIntervalHours: hours,
            injectPerTurn: draft.injectPerTurn,
            handoverPercent: handover,
            compactSoonPercent: compactSoon,
            nearlyFullPercent: nearlyFull,
            rotateReminderMode: mode,
            rotateReminderDays: Number.isInteger(days) && days >= 1 && days <= 365 ? days : 7,
            rotateReminderWeekday:
              Number.isInteger(weekday) && weekday >= 0 && weekday <= 6 ? weekday : 6,
            rotateReminderDayOfMonth:
              Number.isInteger(dayOfMonth) && dayOfMonth >= 1 && dayOfMonth <= 28
                ? dayOfMonth
                : 1,
            scopeSessions: parseSessionList(draft.scopeSessions),
          })
          if (!alive.current) return
          applyServer(r)
          setStatus('已保存 ' + new Date().toLocaleString('zh-CN', { hour12: false }))
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

      // 周期模式：只显示当前选中的那个输入
      let modeInput = null
      if (draft.rotateReminderMode === 'interval') {
        modeInput = h(Field, {
          title: '每 N 天提醒一次',
          note: '按间隔模式：距上次提醒满 N 天就提醒一次。范围 1–365 的整数。保存后立即生效。',
        },
          h(NumberRow, {
            value: draft.rotateReminderDays,
            disabled,
            min: 1,
            max: 365,
            step: 1,
            unit: '天',
            onChange: (value) => setDraft({ ...draft, rotateReminderDays: value }),
          }))
      } else if (draft.rotateReminderMode === 'weekly') {
        modeInput = h(Field, {
          title: '每周几提醒',
          note: '每周模式：上次提醒之后最近的这个星期几到了就提醒（按配置的时区算本地日期）。保存后立即生效。',
        },
          h(SelectRow, {
            value: draft.rotateReminderWeekday,
            disabled,
            options: WEEKDAYS,
            onChange: (value) => setDraft({ ...draft, rotateReminderWeekday: value }),
          }))
      } else {
        modeInput = h(Field, {
          title: '每月几号提醒',
          note: '每月模式：上次提醒之后最近的这个日期到了就提醒（按配置的时区算本地日期）。范围 1–28 的整数，每月都有。保存后立即生效。',
        },
          h(NumberRow, {
            value: draft.rotateReminderDayOfMonth,
            disabled,
            min: 1,
            max: 28,
            step: 1,
            unit: '号',
            onChange: (value) => setDraft({ ...draft, rotateReminderDayOfMonth: value }),
          }))
      }

      return h('div', { style: S.page },
        h(Field, {
          title: '生效范围',
          note: '留空 = 所有会话都收到读数与提醒；填会话 id（或前缀）就只在那些会话里注入。时钟行不受影响。',
        },
          h('input', {
            type: 'text',
            value: draft.scopeSessions,
            disabled,
            placeholder: '留空 = 所有会话，例如 session-3df4e987',
            onChange: (e) => setDraft({ ...draft, scopeSessions: e.target.value }),
            style: { ...S.input, fontFamily: 'ui-monospace, monospace' },
          })),

        h(Field, {
          title: '时钟间隔',
          note: '每几小时往时钟文件续一行（进程启动时先补一行）。范围 1–168，可填小数。保存后立即生效，下一拍按新间隔写。',
        },
          h(NumberRow, {
            value: draft.clockIntervalHours,
            disabled,
            min: 1,
            max: 168,
            step: 1,
            unit: '小时',
            onChange: (value) => setDraft({ ...draft, clockIntervalHours: value }),
          })),

        h(Field, {
          title: '时钟文件',
          note: '时钟行写到哪个文件，只认绝对路径，父目录不存在会自动建。保存后立即生效。',
        },
          h('input', {
            type: 'text',
            value: draft.clockFile,
            disabled,
            placeholder: 'G:\\...\\clock.md',
            onChange: (e) => setDraft({ ...draft, clockFile: e.target.value }),
            style: { ...S.input, fontFamily: 'ui-monospace, monospace' },
          })),

        h(Field, {
          title: '每轮注入',
          note: '每个 turn 的第一步是否注入一条水位读数；关掉后只剩三档提醒和换会话提醒。保存后立即生效。',
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
              ? '每轮第一步报一条读数'
              : '不报读数，只留提醒'))),

        h(Field, {
          title: '提醒交接（%）',
          note: '到这条线提醒把中间结论落盘。范围 1–100 的整数，须小于「即将折叠」。保存后立即生效。',
        },
          h(NumberRow, {
            value: draft.handoverPercent,
            disabled,
            min: 1,
            max: 100,
            step: 1,
            unit: '%',
            onChange: (value) => setDraft({ ...draft, handoverPercent: value }),
          })),

        h(Field, {
          title: '即将折叠（%）',
          note: '到这条线提醒快要折叠了；折叠只留摘要、细节会丢。范围 1–100 的整数，须大于「提醒交接」、小于「即将用完」。保存后立即生效。',
        },
          h(NumberRow, {
            value: draft.compactSoonPercent,
            disabled,
            min: 1,
            max: 100,
            step: 1,
            unit: '%',
            onChange: (value) => setDraft({ ...draft, compactSoonPercent: value }),
          })),

        h(Field, {
          title: '即将用完（%）',
          note: '到这条线提醒该换新会话了。范围 1–100 的整数，须大于「即将折叠」。保存后立即生效。',
        },
          h(NumberRow, {
            value: draft.nearlyFullPercent,
            disabled,
            min: 1,
            max: 100,
            step: 1,
            unit: '%',
            onChange: (value) => setDraft({ ...draft, nearlyFullPercent: value }),
          })),

        h(Field, {
          title: '换会话提醒周期',
          note: '多久提醒一次换会话：按间隔（每 N 天）/ 每周（星期几）/ 每月（几号）。保存后立即生效。',
        },
          h(SelectRow, {
            value: draft.rotateReminderMode,
            disabled,
            options: MODES,
            onChange: (value) => setDraft({ ...draft, rotateReminderMode: value }),
          })),

        modeInput,

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
          error ? h('div', { style: S.error }, error) : null))
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
