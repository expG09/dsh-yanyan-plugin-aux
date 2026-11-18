# 砚砚工具包 · dsh-yanyan-plugin-aux

仓库：<https://github.com/expG09/dsh-yanyan-plugin-aux>

DeepSeek Harness 的辅助插件包，目前装三件东西：

1. **上下文水位读数**：每个 turn 的第一步，往模型上下文里注入一条占用读数（已用 / 窗口 / 百分比）。跨过 50%、70% 时各额外注入一次提醒，同一会话每个阈值只提醒一次。
2. **时钟续行**：按固定间隔往一个文本文件追加 `YYYY-MM-DD HH:mm` 一行；能读到占用时行尾带上百分比。进程启动时先补一行，把上次关机期间的空白收口。
3. **QQ 群会话换新**：在设置页里给某个 QQ 群换一个新会话（改 qqbot 的 `model-prefs.json`），用于长会话该收尾的时候。只影响 QQ 群聊，不碰网页/手机这边的会话。

前两件只做**读数和提示**，不改任何行为、不代替折叠、不删历史；第三件是显式的手动操作，只有点了「换新」才会改那一个绑定。

## 为什么做这个

长会话会一直折叠、一直累计。折叠只压当前窗口，压不掉累计消耗；判断「这一场该不该换新」需要一个模型自己看得见的读数。界面上有那个百分比，但模型读不到它——这个插件把它注入进去。

## 安装

在 DSH 里 **插件 → 添加插件 → 选本地目录**，指到本仓库目录；或者用 `dsh plugin --profile <name> add file:<绝对路径>`。

装完重启桌面端（从托盘退出，不是关窗口）才生效。

## 配置

行 id 是 `aux`。`cordis.patch.yml` 里的五项是**出厂默认**；装好之后直接在
**设置 → 砚砚工具包** 里改，保存即生效，不用重启：

| 键 | 说明 |
|---|---|
| `clockFile` | 时钟文件绝对路径。父目录不存在会自动建。 |
| `clockIntervalHours` | 两次追加之间的间隔（小时），合法范围 1–168。 |
| `injectPerTurn` | 每轮第一步是否都注入一条读数。 |
| `thresholds` | 提醒阈值数组，例如 `[50, 70]`；逐项取整、钳制到 1–100、去重升序。 |
| `timeZone` | 时钟行使用的 IANA 时区。 |

设置页把值保存在 `%USERPROFILE%\.dsh\aux-settings.json`；「恢复默认」会删掉这个文件，
回到 patch 里的值。也可以直接改那个 JSON —— 宿主每次 pre-step 与时钟 tick 前都会看
文件 mtime，变了就重读。

示例见 `cordis.patch.yml`。

## QQ 群会话换新

设置页最下面（现有四项配置之下）是这一节：

- **只影响 QQ 群聊**：改的是 qqbot 的群会话绑定；网页和手机这边的会话不受影响，要换请在界面上新开会话。
- 加载时列出 `%USERPROFILE%\.dsh-qqbot\model-prefs.json` 里所有 `qqbot:<appId>:<kind>:<peerId>`
  的绑定，每行显示会话类型 + peerId 后 8 位 + 当前 sessionId 后 8 位（完整值悬停可见）。
- 点某一行的「换新」：宿主先备份 `model-prefs.json` 到同目录 `model-prefs.json.bak-<yyyyMMdd-HHmmss>`，
  再用 `session-<uuid>` 换掉那一条，原子写回（`.tmp` + rename），其他键与其他绑定原样保留；
  同时在 `%USERPROFILE%\.dsh\aux-rotations.jsonl` 记一行换新记录。
- 换新前建议先让助手写一份交接。换新本身不迁移上下文，旧会话还在，只是这个群不再往里写。
- **重启桌面端后生效**：qqbot 把 `sessionIds` 缓存在内存里（只在启动时读一次 `model-prefs.json`，
  之后没有 reload 也没有 watch），所以改完文件不会立刻接上；要从托盘退出再打开，新会话才生效。

**风险（跨插件耦合）**：这一节直接读写 qqbot 的私有状态文件，依赖它当前的 JSON 结构
（`sessionIds` 子对象）。qqbot 升级后如果改了存储格式或位置，列表可能变空或换新失败；
本插件只做最小读写、保留不认识的键、写前备份，失败时不会清空原文件。还有一点：生效窗口是
「重启桌面端之后」，不是「下一句消息」。

## 已知限制

- **读不到水位就不注入**：`pressureTokens` 或 `contextWindow` 缺失、为 0 时静默跳过，不会伪造读数。这通常意味着宿主刚启动、还没发出过请求。
- **阈值只按会话内存记**：插件重启后，同一会话的阈值提醒会重新计一次。
- **时钟行只随进程活着写**：电脑关机或桌面端退出期间不会写；下次启动补一行，但中间那段的空白不会补。
- **只注入文本**：不提供模型可调用的查询工具，读数只在每轮开头可见。
- **QQ 换新依赖 qqbot 的内部文件**：`model-prefs.json` 的格式由 qqbot 决定，升级后可能变；
  qqbot 只在启动时读一次绑定并缓存在内存里，所以换新必须重启桌面端（托盘退出再打开）才生效。
- **没有 webServer 的 profile 不挂接口**：`webServer` 服务现在不是必需项，探测不到就只跳过
  `/api/aux` 路由（设置页与 QQ 换新不可用），水位与时钟照常跑。
- 不接管 DSH 的自动折叠，也不改变压缩阈值——那是 `compaction-basic` 的事。

## 开发

改 `index.js` 后，ESM 语法检查用自带的解析器（`node --check` 对含 `export` 的文件会直接放行，别信它）：

```sh
node --experimental-vm-modules <check-esm-syntax.mjs 的路径> index.js
```

纯逻辑都有普通 node 测试（不装依赖）：

```sh
node test/settings.test.mjs
node test/bindings.test.mjs
```

## 许可

MIT，见 `LICENSE`。
