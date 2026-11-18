# 辅助工具（aux）

## 做什么

- **每轮读数**：每个 turn 的第一步，向模型上下文注入一条「上下文水位」读数，内容形如
  `上下文水位：42%（已用 84K / 窗口 200K）`。读数来自 `ctx.tokenMeter.contextPressure()`，
  是最近一次请求的 prompt 侧占用，不是本轮内容算出来的。
- **阈值提醒**：占比第一次跨过 50%、70% 时，各额外注入一条提醒；同一个会话里每个阈值只提醒一次。
  跑在 turn 的后续步骤里跨过阈值时也会立刻提醒，不等下一轮。
- **时钟行**：每 `clockIntervalHours` 小时往 `clockFile` 追加一行 `YYYY-MM-DD HH:mm`；
  能读到水位时同一行追加 ` 上下文 NN%`。进程启动时先补写一行，之后按间隔写。
- **QQ 群会话换新**：设置页列出 qqbot 的群会话绑定，点某一行「换新」就把那一条
  `sessionKey → sessionId` 换成新铸的 `session-<uuid>`。只影响 QQ 群聊；改的是 qqbot 的
  `%USERPROFILE%\.dsh-qqbot\model-prefs.json`，写前备份、原子写回、记一行审计。

## 怎么配

`cordis.patch.yml` 里的 `config` 是**出厂默认**，五个键都必填：

| 键 | 类型 | 示例 | 说明 |
| --- | --- | --- | --- |
| `clockFile` | string | `G:\yanyan-workspace\report-cache\clock.md` | 时钟行追加到哪个文件。目录不存在会自动建。 |
| `clockIntervalHours` | number | `6` | 时钟行间隔（小时），合法范围 1–168；超出按非法处理，回落到默认。 |
| `injectPerTurn` | boolean | `true` | 是否每轮第一步注入读数。提醒不受它影响。 |
| `thresholds` | number[] | `[50, 70]` | 提醒阈值；逐项取整、钳制到 1–100、去重升序。 |
| `timeZone` | string | `Asia/Shanghai` | 时钟行的时区。无效时回落到进程所在时区。 |

装好之后在 **设置 → 砚砚工具包** 里改这四项（时区仍走 patch）：保存写入
`%USERPROFILE%\.dsh\aux-settings.json`，宿主在每次 pre-step 与时钟 tick 前检查文件
mtime，变了就重读，所以**保存即生效、不用重启**。「恢复默认」删掉设置文件，回到 patch 的值。
设置文件写坏时保留上一份好配置；文件被删则立刻回到 patch 默认。

## QQ 群会话换新

设置页现有四项配置下面多了一节「QQ 群会话换新」。它不读写 `aux-settings.json`，改的是
qqbot 的私有状态：

- 绑定文件：`%USERPROFILE%\.dsh-qqbot\model-prefs.json`，一条绑定是 `sessionIds` 里的
  `qqbot:<appId>:<kind>:<peerId>` → `session-<uuid>`。
- 换新流程：校验 sessionKey → 生成 `session-<uuid>` → 备份 `model-prefs.json` 到同目录
  `model-prefs.json.bak-<yyyyMMdd-HHmmss>` → 写 `.tmp` 再 rename 覆盖 → 往
  `%USERPROFILE%\.dsh\aux-rotations.jsonl` 追加一行 `{ at, sessionKey, oldSessionId, newSessionId }`。
- 文件里其他键（`overrides`、`presets`、以后新增的）原样保留；备份失败就不写，写失败会
  保留备份路径并报错。
- 「QQ 群会话换新」只影响 QQ 群聊里的会话；网页和手机这边的会话不受影响，要换请在界面上新开会话。
  换新不迁移上下文，旧会话文件还在，只是这个群不再往里写。
- **重启桌面端后生效**：qqbot 的 `PrefsStore.load()` 只在构造时读一次 `model-prefs.json`，
  `sessionIds` 之后一直是内存里的 Map，没有 reload、也没有文件 watch。所以外部改文件不会立刻
  接上新会话；要从托盘退出再打开，qqbot 启动时才重读文件、用新 sessionId 恢复会话。

**风险（跨插件耦合）**：`model-prefs.json` 是 qqbot 的内部实现，不是公开契约。它升级后若改了
存储格式/位置，插件可能列不出绑定或换新失败；本插件只做最小读写、保留不认识的键、写前备份，
失败不会清空原文件。另外它自己的 `/new` 命令虽然能立即换会话（内存+文件同时改），但只在私聊
可用，没有暴露给外部的群会话换新接口——这正是这里直接改文件的原因，也是它必须重启才生效的原因。

## 设置页接口

设置页全部走同一个前缀路由 `/api/aux`（`ctx.webServer.register`，`kind: 'prefix'`）。
`webServer` 不是必需服务：`inject` 里不要它，apply 时用 `ctx.get('webServer')` 探测一次，
拿不到就在第一次 `agent/pre-step` 再补试一次（只试一次），还拿不到就只跳过这些接口，
水位与时钟照常跑；挂上后路由仍随 `ctx.effect` 卸载清理。

| 方法 | 路径 | 返回 |
| --- | --- | --- |
| GET | `/api/aux/settings` | `{ ok: true, settings, effective }`：`settings` 是文件里的（没有则 `null`），`effective` 是此刻真正生效的 |
| POST | `/api/aux/settings` | 收 JSON，规整后写文件；成功 `{ ok: true, settings }`，写失败 500 `{ ok: false, error }` |
| POST | `/api/aux/reset` | 删设置文件、回到 patch 默认，返回 `{ ok: true }` |
| GET | `/api/aux/bindings` | `{ ok: true, bindings: [{ sessionKey, appId, kind, peerId, sessionId }] }`；文件不存在/坏掉返回空数组，不报错 |
| POST | `/api/aux/rotate` | 收 `{ sessionKey }`；成功 `{ ok: true, sessionKey, oldSessionId, newSessionId, at }`；sessionKey 不合法或不在文件里 400 `{ ok: false, error }` |
| GET | `/api/aux/rotations` | `{ ok: true, rotations: [...] }`，`%USERPROFILE%\.dsh\aux-rotations.jsonl` 最近 20 条，坏行跳过 |

请求体读取上限 1MB；超过上限会先把 Promise 收掉再断开连接。`Origin` 头存在时必须等于
`http://` + `Host`，否则 403。

## 已知限制

- **水位读不到时不注入**：`contextPressure()` 缺 `pressureTokens` 或 `contextWindow`、窗口不为正、
  或调用抛错时，这一轮什么都不注入，也不写水位后缀，只保证会话照常进行。
- **阈值每会话只提醒一次**：插件进程内按会话 id 记账，进程重启后重新计数；同一个会话不会重复提醒同一个阈值。
- **时钟行只在进程活着时按间隔写**：进程不在的时段没有记录，启动时只补当下一行，不补历史。
- **QQ 换新依赖 qqbot 内部文件格式**：它升级后可能改 `model-prefs.json` 的结构；插件只做最小读写、
  保留未知键、写前备份。绑定缓存在 qqbot 进程内存里，换新后必须重启桌面端才生效。
- **没有 webServer 就只是没接口**：启动与第一次 pre-step 都探测不到 webServer 的 profile 里，
  设置页与 QQ 换新不可用，水位与时钟不受影响。
