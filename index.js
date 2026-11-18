/**
 * aux：给模型读上下文水位，顺带给时钟文件续行，按周期提醒换会话。
 *
 * 四件事：
 *   1. 每个 turn 的第一步注入一条水位读数；占比跨过三档线时各额外注入一次对应提醒
 *      （同一个会话里每档只提醒一次）：
 *        - handoverPercent（默认 50）：该写交接了；
 *        - compactSoonPercent（默认 75）：快到折叠线了；
 *        - nearlyFullPercent（默认 90）：该换新会话了。
 *      三档提醒不受 injectPerTurn 影响，该说照说。
 *      跨过 handover 这一档时**额外落一份交接模板文件**（只写文件，不塞进注入正文）：
 *      写在 clockFile 同目录，文件名 `交接-<yyyy-MM-dd>-<会话 id 后 8 位>.md`，
 *      已存在就不覆盖、不追加，注入里只追加一行指针 `模板已生成：<绝对路径>`。
 *      compactSoon / nearlyFull 不生成模板；范围外的会话不注入，也就不生成。
 *   2. 按 clockIntervalHours 往 clockFile 追加一行 `YYYY-MM-DD HH:mm`，能读到水位时
 *      追加 ` 上下文 NN%`；进程启动时先补写一行。
 *   3. 换新提醒：**每次 pre-step 都检查**（不限第几步）；周期三选一（`rotateReminderMode`）：
 *      - interval：距上次提醒满 `rotateReminderDays` 天（1–365）；
 *      - weekly：上次提醒之后最近的、落在 `rotateReminderWeekday`（0=周日…6=周六）的自然日到了；
 *      - monthly：上次提醒之后最近的、`rotateReminderDayOfMonth`（1–28）那个自然日到了。
 *      「周几 / 几号」按 `timeZone` 算本地日期。从未提醒过（第一次运行）→ 立刻提醒。
 *      到期就注入一次，并把时间写进 `%USERPROFILE%\.dsh\aux-state.json`；关机期间错过的那次，
 *      下次打开的第一轮会补上，而且只补一次（写完时间就不到期了）。到点那一拍还会**另外**往
 *      clockFile 写一行 `YYYY-MM-DD HH:mm · 该换会话`（能读到水位就再带 ` 上下文 NN%`）——
 *      这行跟按 clockIntervalHours 写的常规时钟行是两回事，互不覆盖、也不去重。
 *   4. 换新本身不在这里做：插件只提醒，动作交给外置脚本
 *      `tools/rotate-qq-session.mjs`，所以本插件不读不写 qqbot 的任何存储。
 *
 * 生效范围（scopeSessions）是**全局**的，管上面所有注入，不只换新提醒：
 *   空数组 = 所有会话都收；非空时只有会话 id 等于某一项、或以某一项开头的会话才收。
 *   判定排在 pre-step 的最前面：不在范围里就直接返回，**一条都不注入**（连读数也不发），
 *   也不推进读数门限、已提醒档位、换新提醒状态，免得范围外的会话把状态推着走。
 *   时钟行不受影响——它按 clockIntervalHours 照常写，跟会话无关。
 *   跳过时往诊断日志写一行 `skip scope session=<id>`，方便排查「这个会话怎么没读数」。
 *
 * 设置有两层：
 *   - cordis.patch.yml 里的 config 是出厂默认；
 *   - `%USERPROFILE%\.dsh\aux-settings.json` 是用户在设置页保存的那一份，优先于 patch。
 *     每次 pre-step 与时钟 tick 前都会看一眼这个文件的 mtime，变了就重读，所以保存后不用重启。
 *
 * 注入方式照抄 @deepseek-ai/dsh-time-context：在 agent/pre-step 里往
 * decision.messages 追加一条 source.kind 为本插件名的用户消息，durable、可回溯。
 *
 * webServer 是可选的：有的 profile 不装它。路由改成运行时探测 ctx.get('webServer')，
 * 拿不到就只跳过 HTTP 接口，水位与时钟照常。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { renderTemplate, templateFileName } from './lib/handover.js';
import { isRotateDue } from './lib/rotate-schedule.js';
import {
  DEFAULT_SETTINGS,
  inScope,
  normalizeSettings,
  readSettings,
  writeSettings,
} from './lib/settings.js';

export const name = 'aux';

/** 必需的服务：agent 注册表（pre-step 事件）与 token 计量。webServer 走运行时探测，不在这里。 */
export const inject = ['agents', 'tokenMeter'];

/**
 * 刻意不声明 Config、也不 import 任何 @deepseek-ai 包。
 *
 * 这个插件是从工作区 link/junction 进 profile 的：Node 解析裸 import 时按真实路径
 * (G:\...) 往上找 node_modules，那里没有 @deepseek-ai，于是加载阶段直接失败，
 * 而且不会留下任何可见报错。所以保持自包含——只用 node 内置模块和相对导入；
 * 配置校验与回落交给 lib/settings.js 的 normalizeSettings。
 */

/**
 * 三档提醒：每一档一句自己的话，语义各不相同。
 *
 * 文案里的 X 是**当前占比**，不是阈值本身——同一档线在一次会话里只会被跨过一次。
 */
const REMINDERS = Object.freeze([
  {
    key: 'handover',
    percentKey: 'handoverPercent',
    text: (percent) => `上下文 ${percent}%：该写交接了——长任务先把结论落盘，再往下做。`,
  },
  {
    key: 'compactSoon',
    percentKey: 'compactSoonPercent',
    text: (percent) => `上下文 ${percent}%：快到折叠线了。折叠只留摘要，细节会丢；重要结论先落盘。`,
  },
  {
    key: 'nearlyFull',
    percentKey: 'nearlyFullPercent',
    text: (percent) => `上下文 ${percent}%：快满了，该换新会话了。`,
  },
]);

/** token 数按 K 显示，去掉无意义的 .0 尾巴；不足 1K 就报原数。 */
function fmtTokens(value) {
  if (value < 1000) return String(Math.round(value));
  const inK = value / 1000;
  return inK >= 100 ? `${Math.round(inK)}K` : `${inK.toFixed(1).replace(/\.0$/, '')}K`;
}

/** 小时数转定时器毫秒；normalize 后已经保证落在 1–168，这里再兜一道。 */
function intervalMsOf(hours) {
  const value = Number(hours);
  return (Number.isFinite(value) && value > 0 ? value : 1) * 3600 * 1000;
}

/** 两段式本地时间：['2026-11-18', '08:50']；格式化器不可用时为 null。 */
function buildFormatter(timeZone) {
  const options = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  };
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone });
  } catch {
    // timeZone 无效时回落到进程所在时区，和以前的处理一致
    try {
      return new Intl.DateTimeFormat('en-US', options);
    } catch {
      return null;
    }
  }
}

/** 启动与注入的自检日志：写在 clock 同目录的 aux-debug.log，超过 200KB 就不再写。 */
function makeDiag(clockFile) {
  const file = clockFile ? join(dirname(clockFile), 'aux-debug.log') : '';
  return (msg) => {
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      if (existsSync(file) && statSync(file).size > 200 * 1024) return;
      appendFileSync(file, `${new Date().toISOString()} ${msg}\n`, 'utf8');
    } catch {
      /* 诊断日志写不了不影响插件 */
    }
  };
}

/**
 * 换新提醒的状态：`%USERPROFILE%\.dsh\aux-state.json`。
 *
 * 这个文件只放状态、不放用户设置（设置永远在 aux-settings.json）。读不到、写不进
 * 都不许影响会话：读失败当「从没提醒过」，写失败吞掉，宿主另有内存兜底。
 */
function makeStateStore(file) {
  /** 返回 `{ lastRotateReminderAt }`，字段要么是 ISO 字符串要么是 null。 */
  function read() {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { lastRotateReminderAt: null };
      }
      const at = parsed.lastRotateReminderAt;
      return { lastRotateReminderAt: typeof at === 'string' ? at : null };
    } catch {
      return { lastRotateReminderAt: null };
    }
  }

  /** 写回状态；成功返回 true，失败 false（不抛）。 */
  function write(state) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      const body = { lastRotateReminderAt: state.lastRotateReminderAt };
      writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  return { read, write };
}

export function apply(ctx, config) {
  const diag = makeDiag(config?.clockFile ?? '');
  diag(`apply start clockFile=${config?.clockFile ?? '(none)'}`);
  /** patch 里的 config 规整后作为出厂默认；设置文件被删掉时回到这一份。 */
  const patchDefaults = normalizeSettings(config, DEFAULT_SETTINGS);
  /** 用户设置文件：设置页保存到这里，启动和每次热更新都读它。 */
  const settingsFile = join(homedir(), '.dsh', 'aux-settings.json');
  /** 换新提醒的状态文件：只存 lastRotateReminderAt。 */
  const stateStore = makeStateStore(join(homedir(), '.dsh', 'aux-state.json'));

  /** 文件指纹：有文件用 mtimeMs，没有就记 'missing'。 */
  function readStamp() {
    try {
      return String(statSync(settingsFile).mtimeMs);
    } catch {
      return 'missing';
    }
  }

  /** 当前生效的设置。启动时先读文件，读不到就用 patch 默认。 */
  let current = readSettings(settingsFile, patchDefaults) ?? patchDefaults;
  let stamp = readStamp();

  /** 定时器句柄与当前间隔；间隔改了要重建定时器，保存后下一拍就按新频率走。 */
  let clockTimer = null;
  let clockIntervalMs = intervalMsOf(current.clockIntervalHours);

  /** 最近一次读到的水位，供时钟行使用；没读到就写纯时间。 */
  let lastPercent = null;
  /** 每个会话已经提醒过的提醒档（handover / compactSoon / nearlyFull），避免同一档反复说。 */
  const notified = new Map();

  /**
   * 本进程内上次发换新提醒的时间（毫秒）。状态文件写不进去时靠它兜底，
   * 免得每个 pre-step 都重复提醒一次。0 = 本进程还没提醒过。
   */
  let lastRotateReminderMs = 0;

  /** /api/aux 路由是否已挂上。webServer 是可选服务，启动时拿不到就在第一次 pre-step 再试一次。 */
  let routesMounted = false;
  /** 懒挂载是否已经试过：只补试一次，还拿不到就不再试。 */
  let routesLazyTried = false;

  /** 时间格式化器按 timeZone 缓存；时区改了才重建。 */
  let formatter = null;
  let formatterZone = null;

  function localParts(timeZone) {
    if (formatterZone !== timeZone) {
      formatterZone = timeZone;
      formatter = buildFormatter(timeZone);
    }
    if (formatter === null) return null;
    const parts = formatter.formatToParts(new Date());
    const at = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return [`${at.year}-${at.month}-${at.day}`, `${at.hour}:${at.minute}`];
  }

  /** 间隔变了就重建定时器；还没建（启动阶段）就只记下新间隔。 */
  function syncClockTimer() {
    const nextMs = intervalMsOf(current.clockIntervalHours);
    if (nextMs === clockIntervalMs) return;
    clockIntervalMs = nextMs;
    if (clockTimer === null) return;
    clearInterval(clockTimer);
    clockTimer = setInterval(clockTick, clockIntervalMs);
    clockTimer.unref?.();
  }

  /**
   * 每次用配置前调一次：mtime 变了就重读。
   * 文件被删（设置页「恢复默认」）= 回到 patch 默认；文件刚好写坏时保留上一份好配置。
   */
  function refreshSettings() {
    const nextStamp = readStamp();
    if (nextStamp === stamp) return current;
    stamp = nextStamp;
    if (nextStamp === 'missing') {
      current = patchDefaults;
    } else {
      const loaded = readSettings(settingsFile, patchDefaults);
      if (loaded !== null) current = loaded;
    }
    syncClockTimer();
    return current;
  }

  /**
   * 读一次水位。pressureTokens 或 contextWindow 缺失、窗口不为正、读抛错，
   * 一律返回 null —— 读不到水位绝不影响会话本身。
   */
  function readWatermark(session) {
    try {
      const pressure = ctx.tokenMeter?.contextPressure?.(session);
      if (pressure === null || typeof pressure !== 'object') return null;
      const used = pressure.pressureTokens;
      const window = pressure.contextWindow;
      if (typeof used !== 'number' || typeof window !== 'number') return null;
      if (window <= 0 || used < 0) return null;
      return { used, window, percent: Math.round((used / window) * 100) };
    } catch {
      return null;
    }
  }

  /**
   * 上次提醒的时间（毫秒），状态文件优先，其次本进程内存里的。
   * 0 = 还没有任何记录（= 从未提醒过）。
   *
   * 内存那份是写状态失败时的兜底：免得状态写不进去，每个 pre-step 都重复提醒一次。
   */
  function lastRotateMs() {
    const state = stateStore.read();
    const fromFile =
      state.lastRotateReminderAt === null ? 0 : Date.parse(state.lastRotateReminderAt);
    return Math.max(Number.isFinite(fromFile) ? fromFile : 0, lastRotateReminderMs);
  }

  /**
   * 追加一行时钟；写失败（目录、权限、格式化器缺失）静默跳过。
   * 常规行只按 clockIntervalHours 写，换新提醒的标记行由 appendRotateMarkerLine 单独写。
   */
  function clockTick() {
    const settings = refreshSettings();
    const clockFile = settings.clockFile;
    if (!clockFile) return;
    const parts = localParts(settings.timeZone);
    if (parts === null) return;
    const suffix = lastPercent === null ? '' : ` 上下文 ${lastPercent}%`;
    try {
      mkdirSync(dirname(clockFile), { recursive: true });
      appendFileSync(clockFile, `${parts[0]} ${parts[1]}${suffix}\n`, 'utf8');
    } catch {
      // 时钟写失败不影响会话
    }
  }

  /**
   * 换新提醒到点时额外写的一行：`YYYY-MM-DD HH:mm · 该换会话`，能读到水位时再带
   * ` 上下文 NN%`（例：`2026-11-18 20:50 · 该换会话 上下文 66%`）。
   *
   * 跟常规时钟行是两回事：各自追加、互不覆盖；同一时刻碰巧两行都有也照样并排，不做去重。
   * 写失败吞掉，不影响注入。
   */
  function appendRotateMarkerLine(settings, percent) {
    const clockFile = settings.clockFile;
    if (!clockFile) return;
    const parts = localParts(settings.timeZone);
    if (parts === null) return;
    const suffix = percent === null ? '' : ` 上下文 ${percent}%`;
    try {
      mkdirSync(dirname(clockFile), { recursive: true });
      appendFileSync(clockFile, `${parts[0]} ${parts[1]} · 该换会话${suffix}\n`, 'utf8');
    } catch {
      // 这一行写不进去也不影响注入
    }
  }

  /**
   * 到交接水位那一次落一份模板文件，返回可注入的绝对路径；写不出来返回 null。
   *
   * - 目录取 `clockFile` 的目录（默认就是 `report-cache\`），不存在会建；
   * - 文件名 `交接-<yyyy-MM-dd>-<会话 id 后 8 位>.md`，日期按进程本地时区
   *   （clockFile 的 timeZone 只管时钟行，模板文件名跟着机器本地时间走，够用且不会歧义）；
   * - **已存在就不覆盖、不追加**：用 `flag: 'wx'` 排他写，EEXIST 当作「之前生成过」，
   *   照样返回路径 —— 注入里给的是指针，文件在不在比谁写的更重要；
   * - 任何异常都吞掉，只往诊断日志写一行，绝不影响注入本身。
   */
  function ensureHandoverTemplate(settings, sessionId) {
    const clockFile = settings.clockFile;
    if (!clockFile) return null;
    const directory = dirname(clockFile);
    const now = new Date();
    const file = resolve(directory, templateFileName(now, sessionId));
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(file, renderTemplate(now, sessionId), { encoding: 'utf8', flag: 'wx' });
      diag(`handover template created=${file}`);
      return file;
    } catch (err) {
      if (err?.code === 'EEXIST') {
        diag(`handover template exists=${file}`);
        return file;
      }
      diag(`handover template failed=${file} ${String(err?.message ?? err)}`);
      return null;
    }
  }

  ctx.effect(() => {
    // 进程起来先补一行：上次关机期间的空白在这里收口
    clockTick();
    clockIntervalMs = intervalMsOf(current.clockIntervalHours);
    clockTimer = setInterval(clockTick, clockIntervalMs);
    // 别让这个定时器单独吊住宿主进程
    clockTimer.unref?.();
    return () => {
      if (clockTimer !== null) {
        clearInterval(clockTimer);
        clockTimer = null;
      }
    };
  }, 'aux: 时钟定时器');

  ctx.on(
    'agent/pre-step',
    async ({ agent, step, signal }, next) => {
      const decision = await next();
      if (decision.kind === 'reject' || signal.aborted) return decision;

      // webServer 可能晚于本插件就绪：借第一次 pre-step 补挂一次路由（只试一次）
      if (!routesMounted && !routesLazyTried) {
        routesLazyTried = true;
        mountRoutes();
      }

      // 每次用配置前都热更新一次：设置页保存后，下一轮立刻按新值注入
      const settings = refreshSettings();

      // 范围检查排在最前面：先算范围，再决定要不要做任何事。
      // 它必须排在读数门限、已提醒档位、换新提醒状态之前——否则范围外的会话会把状态推着走；
      // 不在范围里就一条都不注入（连读数也不发）。时钟行不经过这里，按间隔照常写。
      const sessionId = String(agent.session?.header?.id ?? agent.id ?? 'unknown');
      if (!inScope(settings.scopeSessions, sessionId)) {
        diag(`skip scope session=${sessionId}`);
        return decision;
      }

      const watermark = readWatermark(agent.session);
      if (watermark === null) return decision;
      lastPercent = watermark.percent;

      let seen = notified.get(sessionId);
      if (seen === undefined) {
        seen = new Set();
        notified.set(sessionId, seen);
      }

      const texts = [];
      // 每轮第一步报一次读数（设置页可以关掉；关掉只影响读数，不影响下面的提醒）
      if (settings.injectPerTurn && step === 1) {
        texts.push(
          `上下文水位：${watermark.percent}%（已用 ${fmtTokens(watermark.used)} / 窗口 ${fmtTokens(watermark.window)}）`,
        );
      }
      // 跨过新的一档时不管第几步都额外说一次，每档每会话只说一次。
      // handover 这一档额外落一份模板文件（只写文件），文案里再追加一行指针。
      // 模板只在 handover 生成；compactSoon / nearlyFull 只提醒，不落文件。
      for (const reminder of REMINDERS) {
        const threshold = settings[reminder.percentKey];
        if (watermark.percent < threshold || seen.has(reminder.key)) continue;
        seen.add(reminder.key);
        let text = reminder.text(watermark.percent);
        if (reminder.key === 'handover') {
          const templateFile = ensureHandoverTemplate(settings, sessionId);
          // 写失败就只是少了这一行：提醒照发，不假装文件已经在了
          if (templateFile !== null) text += `\n模板已生成：${templateFile}`;
        }
        texts.push(text);
      }
      // 换新提醒：每次 pre-step 都查（不限第几步）。周期三选一（interval / weekly / monthly），
      // 「周几 / 几号」按 timeZone 算本地日期；从未提醒过就立刻提醒。
      // 到点就注入一次并落状态；关机期间错过的那次，下次打开的第一轮补上，而且只补一次。
      // 会话范围已在上面的全局 scopeSessions 检查里处理，走到这里就一定在范围内。
      const lastMs = lastRotateMs();
      if (isRotateDue(Date.now(), lastMs === 0 ? null : lastMs, settings, settings.timeZone)) {
        lastRotateReminderMs = Date.now();
        texts.push(
          `本周换会话提醒：这一场已经用了 ${watermark.percent}%（窗口 ${fmtTokens(watermark.window)}）。` +
            '要换就说一声，我按 `tools/rotate-qq-session.mjs` 走——先写交接，再改绑定，最后重启。',
        );
        // 顺带在时钟文件里留一行标记；写失败只吞掉，不影响上面的注入
        appendRotateMarkerLine(settings, watermark.percent);
        // 写失败不重试到爆：内存里的时间已经挡住本进程的重复提醒，重启后再说
        stateStore.write({ lastRotateReminderAt: new Date(lastRotateReminderMs).toISOString() });
      }
      if (texts.length === 0) return decision;
      // 带上会话 id：日志里没有它就没法判断某条注入属于哪个会话（范围限定时尤其重要）
      diag(`inject session=${sessionId} step=${step} texts=${JSON.stringify(texts)}`);

      return {
        ...decision,
        messages: [
          ...decision.messages,
          ...texts.map((text) => ({
            // data.id 必须写：宿主校验要求每条 user/message 都能对上一个带 id 的消息，
            // 缺了它会在会话重新加载时报 "lacks an identified message" 并判定 corrupt。
            // 2026-11-18 事故：手写字面量替代 createUserMessage 时漏了这个字段，
            // 攒了 31 条之后会话加载失败。别再省。
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text }],
            source: {
              kind: name,
              form: 'snapshot',
              sections: [{ name, text }],
            },
          })),
        ],
      };
    },
    { prepend: true },
  );

  /* ─────────────── HTTP（设置页用） ─────────────── */

  const sendJson = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };

  const readBody = (req) =>
    new Promise((resolve) => {
      let data = '';
      let done = false;
      // 超过 1MB 得先把 Promise 收掉再掐断：只 destroy 的话它永远不 settle
      const finish = (value) => {
        if (!done) {
          done = true;
          resolve(value);
        }
      };
      req.on('data', (chunk) => {
        data += chunk;
        if (data.length > 1_000_000) {
          data = '';
          finish({});
          req.destroy();
        }
      });
      req.on('end', () => {
        try {
          finish(JSON.parse(data || '{}'));
        } catch {
          finish({});
        }
      });
      req.on('error', () => finish({}));
    });

  /** 来源校验：浏览器带了 Origin 就必须等于 `http://` + Host，别的网页挡在外面。 */
  const originAllowed = (req) => {
    const origin = req.headers.origin;
    if (!origin) return true;
    return origin === `http://${req.headers.host || ''}`;
  };

  const handle = async (req, res, url) => {
    const path = url.pathname;

    if (req.method === 'GET' && path === '/api/aux/settings') {
      refreshSettings();
      return sendJson(res, 200, {
        ok: true,
        // settings 是文件里的原样（没文件就是 null）；effective 是此刻真正生效的那一份
        settings: readSettings(settingsFile, patchDefaults),
        effective: current,
      });
    }

    if (req.method === 'POST' && path === '/api/aux/settings') {
      const base = refreshSettings();
      const body = await readBody(req);
      const next = normalizeSettings(body, base);
      try {
        writeSettings(settingsFile, next);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
      }
      // 写成功后立刻切到新值，不等下一轮 mtime 检查
      current = next;
      stamp = readStamp();
      syncClockTimer();
      return sendJson(res, 200, { ok: true, settings: current });
    }

    if (req.method === 'POST' && path === '/api/aux/reset') {
      try {
        unlinkSync(settingsFile);
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
      // 文件没了 ⇒ 回到 patch 里的 config
      current = patchDefaults;
      stamp = 'missing';
      syncClockTimer();
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { ok: false, error: `未知接口：${req.method} ${path}` });
  };

  /* ─────────────── 路由挂载：webServer 可选，懒挂载 ─────────────── */

  /**
   * 探测 webServer 并注册 `/api/aux` 路由；成功返回 true。
   *
   * 启动时试一次；拿不到不算失败——有的 profile 根本没有 webServer，有的则是
   * webServer 服务晚于本插件才就绪。后者由第一次 pre-step 再补试一次。
   * 注册仍走 ctx.effect，插件卸载时路由会跟着撤掉。
   */
  function mountRoutes() {
    if (routesMounted) return true;

    // 服务未注入时直接读 ctx.webServer 可能抛错，所以用 ctx.get 探测
    let webServer;
    try {
      webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
    } catch {
      webServer = undefined;
    }
    if (!webServer || typeof webServer.register !== 'function') return false;

    try {
      ctx.effect(
        () =>
          webServer.register({
            kind: 'prefix',
            path: '/api/aux',
            handler: async (req, res) => {
              if (!originAllowed(req)) {
                try {
                  sendJson(res, 403, { ok: false, error: '只接受同源请求' });
                } catch {
                  // 响应已经发不出去就算了
                }
                return;
              }
              try {
                await handle(req, res, new URL(req.url, 'http://127.0.0.1'));
              } catch (err) {
                try {
                  sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
                } catch {
                  // 响应已经发不出去就算了
                }
              }
            },
          }),
        'aux: /api/aux 路由',
      );
    } catch (err) {
      // 路由挂不上只影响设置页读写，水位与时钟照常
      console.warn(`[aux] /api/aux 路由没挂上：${String(err?.message ?? err)}`);
      return false;
    }

    routesMounted = true;
    return true;
  }

  if (!mountRoutes()) {
    console.warn('[aux] 暂时没有 webServer 服务：/api/aux 路由先不挂，第一次 pre-step 时再试一次；水位与时钟照常。');
  }
}
