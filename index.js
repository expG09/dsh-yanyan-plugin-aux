/**
 * aux：给模型读上下文水位，顺带给时钟文件续行，外加 QQ 群会话换新。
 *
 * 三件事：
 *   1. 每个 turn 的第一步注入一条水位读数；占比跨过阈值（默认 50/70）时各额外注入一次提醒
 *      （同一个会话里每个阈值只提醒一次）。
 *   2. 按 clockIntervalHours 往 clockFile 追加一行 `YYYY-MM-DD HH:mm`，能读到水位时
 *      追加 ` 上下文 NN%`；进程启动时先补写一行。
 *   3. 设置页里的「QQ 群会话换新」改 `%USERPROFILE%\.dsh-qqbot\model-prefs.json` 里的
 *      sessionKey → sessionId 绑定：写前备份、原子写回、记一行审计日志。qqbot 只在启动时
 *      读这个文件，所以换新要重启桌面端（托盘退出再打开）才生效。
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
import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  listBindings,
  mintSessionId,
  parseSessionKey,
  prefsPath,
  rotateBinding,
  rotationsPath,
} from './lib/bindings.js';
import { DEFAULT_SETTINGS, normalizeSettings, readSettings, writeSettings } from './lib/settings.js';

export const name = 'aux';

/** 必需的服务：agent 注册表（pre-step 事件）与 token 计量。webServer 走运行时探测，不在这里。 */
export const inject = ['agents', 'tokenMeter'];

/** 与 cordis.patch.yml 里的 config 键一一对应，全部必填；它们只是设置文件的出厂默认。 */
export const Config = z.object({
  clockFile: z.string(),
  clockIntervalHours: z.number(),
  injectPerTurn: z.boolean(),
  thresholds: z.array(z.number()),
  timeZone: z.string(),
});

/** 每个阈值给一句对应建议；自定义阈值按最近的一档取文案。 */
function adviceFor(threshold) {
  if (threshold >= 85) return '上下文很满了：立刻写交接、换新会话。';
  if (threshold >= 70) return '该准备收尾：把结论写进交接，准备换新会话，别再开新的大活。';
  if (threshold >= 50) return '留意上下文：长任务先把中间结论落盘。';
  return '留意上下文占用。';
}

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

export function apply(ctx, config) {
  /** patch 里的 config 规整后作为出厂默认；设置文件被删掉时回到这一份。 */
  const patchDefaults = normalizeSettings(config, DEFAULT_SETTINGS);
  /** 用户设置文件：设置页保存到这里，启动和每次热更新都读它。 */
  const settingsFile = join(homedir(), '.dsh', 'aux-settings.json');

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
  /** 每个会话已经提醒过的阈值，避免同一个坎反复说。 */
  const notified = new Map();

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

  /** 追加一行时钟；写失败（目录、权限、格式化器缺失）静默跳过。 */
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

      const watermark = readWatermark(agent.session);
      if (watermark === null) return decision;
      lastPercent = watermark.percent;

      const sessionId = String(agent.session?.header?.id ?? agent.id ?? 'unknown');
      let seen = notified.get(sessionId);
      if (seen === undefined) {
        seen = new Set();
        notified.set(sessionId, seen);
      }

      const texts = [];
      // 每轮第一步报一次读数（设置页可以关掉）
      if (settings.injectPerTurn && step === 1) {
        texts.push(
          `上下文水位：${watermark.percent}%（已用 ${fmtTokens(watermark.used)} / 窗口 ${fmtTokens(watermark.window)}）`,
        );
      }
      // 跨过新阈值时不管第几步都额外说一次，每个阈值每会话只说一次
      for (const threshold of settings.thresholds) {
        if (watermark.percent >= threshold && !seen.has(threshold)) {
          seen.add(threshold);
          texts.push(`已跨过 ${threshold}%：${adviceFor(threshold)}`);
        }
      }
      if (texts.length === 0) return decision;

      return {
        ...decision,
        messages: [
          ...decision.messages,
          ...texts.map((text) =>
            createUserMessage({
              content: [{ type: 'text', text }],
              source: {
                kind: name,
                form: 'snapshot',
                sections: [{ name, text }],
              },
            }),
          ),
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

  /* ─────────────── QQ 群会话换新（改 qqbot 的 model-prefs.json） ─────────────── */

  /** qqbot 的绑定文件与换新审计日志；路径来自 lib/bindings.js（基于 os.homedir）。 */
  const qqbotPrefsFile = prefsPath();
  const rotationLogFile = rotationsPath();

  /** 读 prefs：文件不存在、坏 JSON、顶层不是对象都返回 null（调用方自己决定怎么报）。 */
  function readPrefs() {
    try {
      const parsed = JSON.parse(readFileSync(qqbotPrefsFile, 'utf8'));
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** 备份文件名里的本地时间戳：yyyyMMdd-HHmmss。 */
  function backupStamp(date) {
    const pad = (value) => String(value).padStart(2, '0');
    return (
      `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
      `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
    );
  }

  /** 生成一个还没被占用的备份路径；同一秒里连点两次也不会覆盖上一份备份。 */
  function nextBackupPath(stamp) {
    const base = `${qqbotPrefsFile}.bak-${stamp}`;
    if (!existsSync(base)) return base;
    let counter = 1;
    while (existsSync(`${base}-${counter}`)) counter += 1;
    return `${base}-${counter}`;
  }

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

    /* ── QQ 群会话绑定：列出 ── */

    if (req.method === 'GET' && path === '/api/aux/bindings') {
      // 文件不存在 / 读坏不报错：设置页显示「没有找到」，不拿一个坏档案吓人
      return sendJson(res, 200, { ok: true, bindings: listBindings(readPrefs()) });
    }

    /* ── QQ 群会话绑定：换新（一条） ── */

    if (req.method === 'POST' && path === '/api/aux/rotate') {
      const body = await readBody(req);
      const sessionKey = typeof body?.sessionKey === 'string' ? body.sessionKey : '';

      if (parseSessionKey(sessionKey) === null) {
        return sendJson(res, 400, {
          ok: false,
          error: 'sessionKey 不合法：必须形如 qqbot:<appId>:<kind>:<peerId>',
        });
      }

      const prefs = readPrefs();
      if (prefs === null) {
        return sendJson(res, 400, {
          ok: false,
          error: `读不到 ${qqbotPrefsFile}：文件不存在或不是合法 JSON`,
        });
      }

      const binding = listBindings(prefs).find((item) => item.sessionKey === sessionKey);
      if (binding === undefined) {
        return sendJson(res, 400, {
          ok: false,
          error: '这个 sessionKey 不在 model-prefs.json 的 QQ 绑定里',
        });
      }

      const newSessionId = mintSessionId();
      const nextPrefs = rotateBinding(prefs, sessionKey, newSessionId);
      if (nextPrefs === null) {
        // prefs 刚被并发改掉、这条刚消失的情况：不写半份文件
        return sendJson(res, 409, { ok: false, error: '这条绑定在读取之后消失了，请刷新后重试' });
      }

      const at = new Date();
      const atText = at.toISOString();

      // 写之前先备份：备份失败就不动原文件（宁可换不成，也不留无法回滚的改动）
      const backup = nextBackupPath(backupStamp(at));
      try {
        copyFileSync(qqbotPrefsFile, backup);
      } catch (err) {
        return sendJson(res, 500, {
          ok: false,
          error: `备份失败，没有改动 model-prefs.json：${String(err?.message ?? err)}`,
        });
      }

      // 原子写回：先写同目录 .tmp 再 rename，崩溃不留半份 JSON
      const tmpPath = `${qqbotPrefsFile}.tmp`;
      try {
        mkdirSync(dirname(qqbotPrefsFile), { recursive: true });
        writeFileSync(tmpPath, `${JSON.stringify(nextPrefs, null, 2)}\n`, 'utf8');
        renameSync(tmpPath, qqbotPrefsFile);
      } catch (err) {
        try {
          unlinkSync(tmpPath);
        } catch {
          // 临时代可能不存在，删不掉就算了
        }
        return sendJson(res, 500, {
          ok: false,
          error: `写回 model-prefs.json 失败（备份留在 ${backup}）：${String(err?.message ?? err)}`,
        });
      }

      // 审计日志写失败不影响换新本身，只留一句告警
      try {
        mkdirSync(dirname(rotationLogFile), { recursive: true });
        appendFileSync(
          rotationLogFile,
          `${JSON.stringify({
            at: atText,
            sessionKey,
            oldSessionId: binding.sessionId,
            newSessionId,
          })}\n`,
          'utf8',
        );
      } catch (err) {
        console.warn(`[aux] 换新记录没写进 ${rotationLogFile}：${String(err?.message ?? err)}`);
      }

      return sendJson(res, 200, {
        ok: true,
        sessionKey,
        oldSessionId: binding.sessionId,
        newSessionId,
        at: atText,
      });
    }

    /* ── QQ 群会话绑定：换新记录（最近 20 条） ── */

    if (req.method === 'GET' && path === '/api/aux/rotations') {
      let lines = [];
      try {
        lines = readFileSync(rotationLogFile, 'utf8')
          .split(/\r?\n/)
          .filter((line) => line.trim() !== '');
      } catch {
        // 文件还不存在 = 还没换过，就是空列表
        lines = [];
      }
      const rotations = [];
      for (const line of lines.slice(-20)) {
        try {
          const value = JSON.parse(line);
          if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            rotations.push(value);
          }
        } catch {
          // 半截行 / 手写坏行跳过，不因为一行坏数据让整个接口失败
        }
      }
      return sendJson(res, 200, { ok: true, rotations });
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
