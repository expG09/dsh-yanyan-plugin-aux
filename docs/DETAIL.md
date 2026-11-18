# 辅助工具（aux）

## 做什么

- **每轮读数**：每个 turn 的第一步，向模型上下文注入一条「上下文水位」读数，内容形如
  `上下文水位：42%（已用 84K / 窗口 200K）`。读数来自 `ctx.tokenMeter.contextPressure()`，
  是最近一次请求的 prompt 侧占用，不是本轮内容算出来的。`injectPerTurn` 关掉则完全不注入读数行，
  但下面的三档提醒和换新提醒照常。受全局 `scopeSessions` 限定（见下）。
- **三档提醒**：占比第一次跨过三档线时，各额外注入一条对应文案，同一会话每档只提醒一次：
  - 提醒交接（`handoverPercent`，默认 50）：「上下文 X%：该写交接了——长任务先把结论落盘，再往下做。」
  - 即将折叠（`compactSoonPercent`，默认 75）：「上下文 X%：快到折叠线了。折叠只留摘要，细节会丢；
    重要结论先落盘。」
  - 即将用完（`nearlyFullPercent`，默认 90）：「上下文 X%：快满了，该换新会话了。」

  三档文案各说各的事，不合并成一句。跑在 turn 的后续步骤里跨过线时也会立刻提醒，不等下一轮。
- **交接模板落盘**：占比第一次跨过 `handoverPercent` 时（就是上面「提醒交接」那条），除了注入
  提醒，还在 `clockFile` 同目录写一份 `交接-<yyyy-MM-dd>-<会话 id 后 8 位>.md`，并在同一条注入
  文案后追加一行 `模板已生成：<绝对路径>`。文件已存在就不覆盖、不追加（同一天同一会话只生成
  一次），注入里仍然给出路径；写失败吞掉，不影响注入。只有 handover 这一档生成，
  `compactSoonPercent` / `nearlyFullPercent` 不生成；`scopeSessions` 范围外的会话不注入，
  也就不生成。详见下面「交接模板」一节。
- **时钟行**：每 `clockIntervalHours` 小时往 `clockFile` 追加一行 `YYYY-MM-DD HH:mm`；
  能读到水位时同一行追加 ` 上下文 NN%`。进程启动时先补写一行，之后按间隔写。
- **换新提醒**：**每次 pre-step 都检查**（不限第几步）。周期三选一（`rotateReminderMode`）：

  - `interval`：距上次提醒满 `rotateReminderDays` 天（1–365）；
  - `weekly`：上次提醒之后最近的、落在 `rotateReminderWeekday`（0=周日 … 6=周六）的自然日到了；
  - `monthly`：上次提醒之后最近的、`rotateReminderDayOfMonth`（1–28）那个自然日到了。

  「周几 / 几号」按 `timeZone` 算本地日期。第一次运行（状态里没有记录）立刻提醒；到点注入一条
  「该换会话」提醒，写回 `%USERPROFILE%\.dsh\aux-state.json`，同时**另外**往 `clockFile` 追加一行
  `YYYY-MM-DD HH:mm · 该换会话`，能读到水位时再带 ` 上下文 NN%`
  （例：`2026-11-18 20:50 · 该换会话 上下文 66%`）。关机期间错过的那次，下次打开的第一轮补上，
  只补一次。换新动作本身交给外置脚本 `tools/rotate-qq-session.mjs`，插件不碰任何别人的存储。
- **生效范围（全局）**：`scopeSessions` 为空数组 = 所有会话都收；非空时只有会话 id **等于**
  某一项、或**以某一项开头**的会话才会收到**任何注入**（读数、三档提醒、换新提醒）。
  范围检查排在 pre-step 的最前面：不匹配就直接返回，一条都不注入（连读数也不发），
  也不会推进读数门限、已提醒档位和换新提醒状态。跳过时在 `aux-debug.log` 里写一行
  `skip scope session=<id>`。**时钟行不受影响**——它按 `clockIntervalHours` 照常写。

## 怎么配

⚠️ **入口在「设置」里，不在插件页，也不在左侧主侧边栏。** 点设置 → 左侧导航「砚砚工具包」，那一页才能改。插件页只显示介绍和图标。

`cordis.patch.yml` 里的 `config` 是**出厂默认**，十二项都写全：

| 键 | 类型 | 示例 | 说明 |
| --- | --- | --- | --- |
| `scopeSessions` | string[] | `[]` | 全局生效范围。空数组 = 所有会话；非空只在「等于或以其开头」的会话里注入**任何内容**（读数、三档提醒、换新提醒）。去空白、去空串、去重；非数组回落默认。**只管注入，不管时钟**。 |
| `clockFile` | string | `G:\yanyan-workspace\report-cache\clock.md` | 时钟行追加到哪个文件。目录不存在会自动建。 |
| `clockIntervalHours` | number | `6` | 时钟行间隔（小时），合法范围 1–168；超出按非法处理，回落到默认。 |
| `injectPerTurn` | boolean | `true` | 是否每轮第一步注入读数。关掉只影响读数，提醒不受它影响。 |
| `handoverPercent` | number | `50` | 提醒交接线（%），钳制到 1–100。 |
| `compactSoonPercent` | number | `75` | 即将折叠线（%），钳制到 1–100。 |
| `nearlyFullPercent` | number | `90` | 即将用完线（%），钳制到 1–100。 |
| `rotateReminderMode` | string | `weekly` | 换新提醒周期：`interval` / `weekly` / `monthly`；非法值回落 `weekly`。 |
| `rotateReminderDays` | number | `7` | 仅 `interval` 模式用：隔几天提醒，钳制到 1–365。 |
| `rotateReminderWeekday` | number | `6` | 仅 `weekly` 模式用：0 = 周日 … 6 = 周六；越界或非法回落 6。 |
| `rotateReminderDayOfMonth` | number | `1` | 仅 `monthly` 模式用：每月几号 1–28；越界回落 1。 |
| `timeZone` | string | `Asia/Shanghai` | 时钟行、以及换新提醒算「周几 / 几号」用的时区。无效时回落到进程所在时区。 |

三个百分比是**一条阶梯**，必须严格递增：

- 设置页保存前先校验，不递增就地报错、不提交（前端一道）；
- `normalizeSettings` 再兜一道：各自取整后钳制到 1–100，按 handover < compactSoon < nearlyFull
  的顺序排序；排序后仍相等（比如三项都填 90），就从低到高各加 1 撑开
  （`[90,90,90]` → `[90,91,92]`，`[1,1,1]` → `[1,2,3]`），确保三档仍合法且递增。

装好之后在 **设置 → 砚砚工具包** 里改，保存写入 `%USERPROFILE%\.dsh\aux-settings.json`，宿主在
每次 pre-step 与时钟 tick 前检查文件 mtime，变了就重读，所以**保存即生效、不用重启**。
「恢复默认」删掉设置文件，回到 patch 的值。设置文件写坏时保留上一份好配置；文件被删则立刻回到
patch 默认。

## 交接模板

到交接水位（`handoverPercent`，默认 50）那一次，插件只写文件、不往上下文里塞模板正文：
注入里留一行指针，正文留在磁盘上，省每轮上下文（取舍见 `docs/DESIGN.md`）。

- **位置**：`path.dirname(clockFile)`，也就是 `report-cache\`；目录不存在会建。
- **文件名**：`交接-<yyyy-MM-dd>-<会话 id 后 8 位>.md`，例 `交接-2026-11-18-ca1a4b99.md`。
  日期按进程**本地时区**取（Date / `yyyy-mm-dd` 都能传）；会话 id 里的非字母数字字符换成
  `_`，保证是合法文件名；id 不足 8 位就全用，洗过没剩下字符则用 `unknown`。
- **标题**：`# 交接 · <日期>（会话 <会话 id 前 8 位>）`。DSH 会话 id 常以 `session-` 开头，
  直接取前 8 位会得到 `session_`（所有会话同款），所以拼标题时先摘掉这个公共前缀：
  `session-3df4e987-ca1a-...` → `3df4e987`；没有该前缀的 id 仍是字面前 8 位。
- **只写一次**：用排他写（`flag: 'wx'`）。文件已存在就**不覆盖、不追加**，跳过写盘但注入里
  仍给路径——既然之前生成过，指针照样有用。
- **只在 handover 触发**：`compactSoonPercent` / `nearlyFullPercent` 两档只提醒，不落文件；
  `scopeSessions` 范围外的会话连提醒都没有，更不会生成。
- **失败静默**：写盘任何异常都吞掉，只在 `aux-debug.log` 记一行；注入照常，只是少了那行路径。
- **模板五段**（写死在 `lib/handover.js` 的 `renderTemplate()`，不做成配置）：
  1. 本场做了什么：3–5 条，一句话一条；
  2. 下一场必须知道的：路径、版本、坑、在哪找东西，写得让下一个我不用翻聊天记录；
  3. 没做完的：带为什么没做，以及卡在哪；
  4. 要落账的条目：每条形如「编号 / 原话或来源 / 决策 / 代价 / 反例 / 被压掉的细节」，
     写完标「已落账」，定期整理时一眼看得出哪些还没归并；
  5. 这次有没有改热记忆：有则写改了什么、什么时候；没有就写「没有」。

文件名规则与正文都是 `lib/handover.js` 里的纯函数（`templateFileName()` /
`renderTemplate()`），`node test/handover.test.mjs` 直接测，不用起宿主。

## 换新提醒

状态与设置分开放：状态在 `%USERPROFILE%\.dsh\aux-state.json`，设置永远只在上面的
`aux-settings.json`。

- 状态文件只有一个字段：`{ "lastRotateReminderAt": "<ISO 字符串>" }`（或 `null`）。
- 到点条件：从未提醒过（第一次运行）→ 立刻到期；之后按 `rotateReminderMode`：
  `interval` 看距上次的天数，`weekly` / `monthly` 看「上次提醒之后最近的周几 / 几号」是否已到。
  **每次 pre-step 都查，不限第几步**——关机期间错过的那次，下次打开的第一轮就补上，只补一次。
  到期判断的纯逻辑在 `lib/rotate-schedule.js` 的 `isRotateDue()`，按 `timeZone` 算本地日期。
- 会话范围：`scopeSessions` 为空数组 = 所有会话；非空时只有会话 id **等于**某一项、
  或**以某一项开头**的会话才收到任何注入。它是**全局**的，不只作用于换新提醒——
  范围外的会话连水位读数都收不到，也不会推进任何到期判断的状态。时钟行不受影响。
- 到点后注入一条：
  「本周换会话提醒：这一场已经用了 X%（窗口 Y）。要换就说一声，我按 `tools/rotate-qq-session.mjs`
  走——先写交接，再改绑定，最后重启。」然后把当前时间写回状态文件。
- 同一次还会**另外**往 `clockFile` 追加一行
  `YYYY-MM-DD HH:mm · 该换会话`（能读到水位时带 ` 上下文 NN%`）。这行跟常规时钟行是两回事：
  各自追加、互不覆盖，同一时刻两行都有也并排留着，不做去重；写失败吞掉，不影响注入。
- 容错：状态文件读不到 / 是坏 JSON / 字段不是字符串，一律当作从没提醒过；写失败吞掉。为了不让写失败
  变成每个 pre-step 都提醒一次，宿主进程内另记一份上次提醒时间，取两者较晚的那个来判到点。

换新本身**不在插件里**：不读 `model-prefs.json`、不缓存绑定、不铸 session id。按提醒去跑
`tools/rotate-qq-session.mjs` 即可（先写交接，再改绑定，最后重启桌面端）。

## 设置页接口

设置页全部走同一个前缀路由 `/api/aux`（`ctx.webServer.register`，`kind: 'prefix'`）。
`webServer` 不是必需服务：`inject` 里不要它，apply 时用 `ctx.get('webServer')` 探测一次，
拿不到就在第一次 `agent/pre-step` 再补试一次（只试一次），还拿不到就只跳过这些接口，
水位、提醒与时钟照常跑；挂上后路由仍随 `ctx.effect` 卸载清理。

| 方法 | 路径 | 返回 |
| --- | --- | --- |
| GET | `/api/aux/settings` | `{ ok: true, settings, effective }`：`settings` 是文件里的（没有则 `null`），`effective` 是此刻真正生效的 |
| POST | `/api/aux/settings` | 收 JSON，规整后写文件；成功 `{ ok: true, settings }`，写失败 500 `{ ok: false, error }` |
| POST | `/api/aux/reset` | 删设置文件、回到 patch 默认，返回 `{ ok: true }` |

请求体读取上限 1MB；超过上限会先把 Promise 收掉再断开连接。`Origin` 头存在时必须等于
`http://` + `Host`，否则 403。

## 已知限制

- **水位读不到时不注入**：`contextPressure()` 缺 `pressureTokens` 或 `contextWindow`、窗口不为正、
  或调用抛错时，这一轮什么都不注入，也不写水位后缀，只保证会话照常进行。
- **生效范围按会话 id 前缀匹配**：`scopeSessions` 填错前缀，那个会话就一条注入都收不到；
  留空（所有会话）最稳。诊断日志里会有 `skip scope session=<id>`。
- **提醒每会话每档只记一次**：插件进程内按会话 id 记账，进程重启后重新计数。交接模板同理：
  重启后再跨线会再做一次写盘检查，文件已存在就不重写，但注入里会再给一次路径。
- **时钟行只在进程活着时按间隔写**：进程不在的时段没有记录，启动时只补当下一行，不补历史；
  ` · 该换会话` 那一行只在换新提醒到点的那一次写。
- **没有 webServer 就只是没接口**：启动与第一次 pre-step 都探测不到 webServer 的 profile 里，
  设置页不可用，水位、提醒与时钟不受影响。
