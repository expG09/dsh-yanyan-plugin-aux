/**
 * aux 的设置层：默认值、规整、读写。
 *
 * 这个文件是纯 ESM，**不 import 任何 @deepseek-ai 包**，宿主（index.js）和
 * `node test/settings.test.mjs` 都能直接加载，测试也不需要装依赖。
 *
 * 设置文件默认在 `%USERPROFILE%\.dsh\aux-settings.json`，由 index.js 拼路径传进来；
 * 这里只负责读写一个路径，不关心它具体在哪。
 *
 * 十六项配置里，四个百分比各有各的档位：
 *
 *   - 三档提醒（handoverPercent / compactSoonPercent / nearlyFullPercent）语义上是一条阶梯，
 *     但**0 是「关闭这一档」**，不是阶梯上的一个点。所以：
 *       - 每项先各自钳制到 0–100（0 合法、保留 0）；
 *       - 只有**大于 0** 的那几档之间才要求严格递增，0 的档直接跳过；
 *       - 把大于 0 的值按从低到高排一遍，按「交接 → 折叠 → 用完」的顺序回填；
 *       - 排序后仍相等（比如 `50/50/90`）就从低到高各加 1 撑开；顶到 100 时反向往回压。
 *     例：`50/0/90` 合法；`0/70/50` 会被修正成 `0/50/70`；`0/0/0` 合法（三档全关）。
 *   - ledgerPercent（写长期记忆）是**独立一档**：只钳制到 0–100，不参与上面那条阶梯，
 *     也不要求与任何一档递增。它可以落在任意位置，也可以和别的档相等（比如交接 50、
 *     落账 70，或者两档都 50）。0 = 关闭这一档。
 * 这一层是兜底，设置页里还有一道前置校验，两层都防。
 * 换新提醒有「周期三选一」：interval / weekly / monthly，非法值回落 weekly。
 *
 * 三个勾各管一档自己的动作，加上 injectPerTurn，都只认真正的布尔值：字符串 "true"、
 * 数字 1、null 之类一律当非法，回落 base，再回落出厂默认（默认全是 true）。
 *   - handoverTemplateEnabled：**交接档**的勾——是否落交接模板文件，并决定提醒里要不要
 *     追加「模板已生成」；不勾只是不落盘，交接提醒照发（2.4.0 里它叫 templateEnabled）；
 *   - compactSoonEnabled / nearlyFullEnabled：**折叠 / 用完两档**的勾——是否发这条提醒，
 *     与把百分比填 0 等效（2.4.0 删过，2.5.0 加回来）；
 *   - ledgerPercent 这一档没有勾，填 0 就是关闭。
 * 勾只在自己那一档的百分比大于 0 时有意义：百分比为 0 时整档静默，勾无从生效。
 * 旧版的 handoverEnabled 与 2.4.0 的 templateEnabled / ledgerReminderEnabled 已经删掉，
 * 老设置文件里残留了也不会报错——它们不在返回对象里，读的时候自然被丢掉。
 *
 * scopeSessions 是**全局生效范围**（不只是换新提醒）：空数组 = 所有会话都收；非空时只有
 * 会话 id 等于某一项、或以某一项开头的会话才会收到任何注入（读数、三档提醒、换新提醒）。
 * 非数组回落 base。判定逻辑抽在纯函数 inScope() 里，宿主和测试共用同一份。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 出厂默认值：与 cordis.patch.yml 里那十六项一一对应。
 * 设置文件不存在 / 读坏时，宿主用它（或 patch 里的 config）兜底。
 *
 * 四个百分比默认都不为 0（都开着）；三档的勾默认也开着。
 */
export const DEFAULT_SETTINGS = Object.freeze({
  scopeSessions: Object.freeze([]),
  clockFile: 'G:\\yanyan-workspace\\report-cache\\clock.md',
  clockIntervalHours: 6,
  injectPerTurn: true,
  handoverPercent: 50,
  handoverTemplateEnabled: true,
  compactSoonPercent: 75,
  compactSoonEnabled: true,
  nearlyFullPercent: 90,
  nearlyFullEnabled: true,
  ledgerPercent: 50,
  rotateReminderMode: 'weekly',
  rotateReminderDays: 7,
  rotateReminderWeekday: 6,
  rotateReminderDayOfMonth: 1,
  timeZone: 'Asia/Shanghai',
});

/** 换新提醒的三种周期模式；非法值一律回落 `weekly`。 */
export const ROTATE_REMINDER_MODES = Object.freeze(['interval', 'weekly', 'monthly']);

/** 小时数的合法区间，超出按非法处理（回落到 base，不钳制）。 */
const HOURS_MIN = 1;
const HOURS_MAX = 168;
/** 百分比的合法区间：0 也合法，含义是「关闭这一档」。超出钳制到边界。 */
const PERCENT_MIN = 0;
const PERCENT_MAX = 100;
/** 换新提醒间隔的合法区间（天），超出钳制到边界；只在 interval 模式用。 */
const DAYS_MIN = 1;
const DAYS_MAX = 365;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 只接受有限数字（JSON 里的 number）；字符串、null、布尔都算非法。 */
function toNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 合法小时数返回数字，否则 null。区间外的值算非法（交给 base 兜底）。 */
function validHours(value) {
  const hours = toNumber(value);
  if (hours === null || hours < HOURS_MIN || hours > HOURS_MAX) return null;
  return hours;
}

/**
 * 百分比：取整后钳制到 0–100；不是有限数字返回 null。
 * 钳制而不是回落，是因为越界的百分比还有明确语义（0 = 关闭，100 = 顶格）。
 * 注意 0 是**合法值**，不能被 `??` 当成「没填」。
 */
function clampPercent(value) {
  const raw = toNumber(value);
  if (raw === null) return null;
  return Math.min(PERCENT_MAX, Math.max(PERCENT_MIN, Math.round(raw)));
}

/** 换新提醒间隔：取整后钳制到 1–365；不是有限数字返回 null（只在 interval 模式用）。 */
function clampDays(value) {
  const raw = toNumber(value);
  if (raw === null) return null;
  return Math.min(DAYS_MAX, Math.max(DAYS_MIN, Math.round(raw)));
}

/** 周期模式：只认 interval / weekly / monthly；别的一律 null，交给 base 或默认。 */
function validRotateMode(value) {
  return typeof value === 'string' && ROTATE_REMINDER_MODES.includes(value) ? value : null;
}

/**
 * 开关类字段：只认真正的布尔值。
 * JSON 里手改成 "true" / "false"、或者写成 1 / 0，都算非法（回落到 base），
 * 免得「填了个字符串反而把提醒打开了」这种语义意外。
 */
function validBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

/** 开关项的统一规整：输入合法用输入 → base 合法用 base → 出厂默认。 */
function pickBoolean(src, fallback, key) {
  return validBoolean(src[key]) ?? validBoolean(fallback[key]) ?? DEFAULT_SETTINGS[key];
}

/** 每周几：0 = 周日 … 6 = 周六；不是整数或越界返回 null，交给 base 或默认（6）。 */
function validWeekday(value) {
  const raw = toNumber(value);
  if (raw === null) return null;
  const weekday = Math.round(raw);
  return weekday >= 0 && weekday <= 6 ? weekday : null;
}

/** 每月几号：1–28（每个月都存在）；不是整数或越界返回 null，交给 base 或默认（1）。 */
function validDayOfMonth(value) {
  const raw = toNumber(value);
  if (raw === null) return null;
  const dayOfMonth = Math.round(raw);
  return dayOfMonth >= 1 && dayOfMonth <= 28 ? dayOfMonth : null;
}

/**
 * 全局生效范围（scopeSessions）：字符串数组 → 去首尾空白、去空串、按出现顺序去重的新数组。
 *
 * - 不是数组 → null（交给 base 回落）；
 * - 空数组是**合法值**，含义是「所有会话」，所以不能当非法处理；
 * - 数组里的非字符串项直接丢掉（JSON 手改坏了也不至于整项回落）。
 */
function normalizeSessionList(value) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed === '') continue;
    seen.add(trimmed);
  }
  return [...seen];
}

/**
 * 合法时钟文件路径返回去掉首尾空白的字符串，否则 null。
 * 只认两种绝对路径：`C:\...` / `C:/...`，以及 POSIX 的 `/...`。
 */
function validClockFile(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!/^[A-Za-z]:[\\/]/.test(trimmed) && !trimmed.startsWith('/')) return null;
  return trimmed;
}

/** 时区必须是 Intl 认得的 IANA 名称；认不出就返回 null，交给 base。 */
function validTimeZone(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * 把已升序排列的「开着的档」撑成严格递增，并保证仍落在 1–100（这里不收 0，0 由调用方跳过）。
 *
 * 例：`[90, 90, 90]` → `[90, 91, 92]`；`[1, 1, 1]` → `[1, 2, 3]`；
 * `[50, 90]` 原样不动；`[100, 100]` → `[99, 100]`。入参不被修改。
 */
function makeStrictlyIncreasing(sorted) {
  const out = [...sorted];
  // 从低到高：每一档至少比前一档大 1
  for (let i = 1; i < out.length; i += 1) {
    out[i] = Math.max(out[i], out[i - 1] + 1);
  }
  // 顶出 100 时从高到低回压，保证每一档都还在 1–100
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const cap = PERCENT_MAX - (out.length - 1 - i);
    if (out[i] > cap) out[i] = cap;
  }
  // 兜底：回压后不许掉进 0（0 在这一层表示「关闭」，不能由钳制产生）
  for (let i = 0; i < out.length; i += 1) {
    const floor = 1 + i;
    if (out[i] < floor) out[i] = floor;
  }
  return out;
}

/**
 * 规整三档提醒的百分比。
 *
 * 每一项：输入里合法就用输入，否则用 `base` 里合法的，再否则用 DEFAULT_SETTINGS。
 * 然后只挑出**大于 0** 的档（0 = 关闭，不参与阶梯），按从小到大排序、撑成严格递增，
 * 再按「交接 → 折叠 → 用完」的顺序回填到原本就大于 0 的位置；原本是 0 的档保持 0。
 *
 * 注意这里**只有三档**：写长期记忆（ledgerPercent）是独立一档，不参与这条阶梯，
 * 由 normalizeSettings 单独钳制。
 *
 * 例：`50/0/90` 原样；`0/70/50` → `0/50/70`；`0/0/0` 原样（三档全关）；
 * `0/70/70` → `0/70/71`。
 */
function normalizePercents(src, fallback) {
  const keys = ['handoverPercent', 'compactSoonPercent', 'nearlyFullPercent'];
  const picked = keys.map(
    (key) => clampPercent(src[key]) ?? clampPercent(fallback[key]) ?? DEFAULT_SETTINGS[key],
  );
  // 0 的档整档不参与递增；只把开着的档排成阶梯
  const ladder = makeStrictlyIncreasing(picked.filter((value) => value > 0).sort((a, b) => a - b));
  let cursor = 0;
  const out = {};
  keys.forEach((key, index) => {
    out[key] = picked[index] > 0 ? ladder[cursor++] : 0;
  });
  return out;
}

/**
 * 把任意输入规整成一份合法设置。
 *
 * 每一项：输入里合法就用输入，否则用 `base` 里合法的，再否则用 DEFAULT_SETTINGS。
 * 永远返回新对象，不修改入参。
 */
export function normalizeSettings(input, base) {
  const src = isPlainObject(input) ? input : {};
  const fallback = isPlainObject(base) ? base : {};

  const clockFile =
    validClockFile(src.clockFile) ??
    validClockFile(fallback.clockFile) ??
    DEFAULT_SETTINGS.clockFile;

  const clockIntervalHours =
    validHours(src.clockIntervalHours) ??
    validHours(fallback.clockIntervalHours) ??
    DEFAULT_SETTINGS.clockIntervalHours;

  // 四个布尔同一套规则：只认布尔，非布尔回落 base，再回落出厂默认（都是 true）。
  // 三个勾各管一档自己的动作，百分比为 0 时它们不生效（面板上置灰）。
  const injectPerTurn = pickBoolean(src, fallback, 'injectPerTurn');
  const handoverTemplateEnabled = pickBoolean(src, fallback, 'handoverTemplateEnabled');
  const compactSoonEnabled = pickBoolean(src, fallback, 'compactSoonEnabled');
  const nearlyFullEnabled = pickBoolean(src, fallback, 'nearlyFullEnabled');

  const percents = normalizePercents(src, fallback);
  // 写长期记忆是独立一档：只钳制到 0–100，不参与三档的递增阶梯。
  // 0 是合法值（= 关闭这一档），所以用 `??` 而不是 `||`。
  const ledgerPercent =
    clampPercent(src.ledgerPercent) ??
    clampPercent(fallback.ledgerPercent) ??
    DEFAULT_SETTINGS.ledgerPercent;

  const rotateReminderMode =
    validRotateMode(src.rotateReminderMode) ??
    validRotateMode(fallback.rotateReminderMode) ??
    DEFAULT_SETTINGS.rotateReminderMode;

  const rotateReminderDays =
    clampDays(src.rotateReminderDays) ??
    clampDays(fallback.rotateReminderDays) ??
    DEFAULT_SETTINGS.rotateReminderDays;

  const rotateReminderWeekday =
    validWeekday(src.rotateReminderWeekday) ??
    validWeekday(fallback.rotateReminderWeekday) ??
    DEFAULT_SETTINGS.rotateReminderWeekday;

  const rotateReminderDayOfMonth =
    validDayOfMonth(src.rotateReminderDayOfMonth) ??
    validDayOfMonth(fallback.rotateReminderDayOfMonth) ??
    DEFAULT_SETTINGS.rotateReminderDayOfMonth;

  const scopeSessions =
    normalizeSessionList(src.scopeSessions) ??
    normalizeSessionList(fallback.scopeSessions) ??
    [...DEFAULT_SETTINGS.scopeSessions];

  const timeZone =
    validTimeZone(src.timeZone) ??
    validTimeZone(fallback.timeZone) ??
    DEFAULT_SETTINGS.timeZone;

  return {
    scopeSessions,
    clockFile,
    clockIntervalHours,
    injectPerTurn,
    handoverPercent: percents.handoverPercent,
    handoverTemplateEnabled,
    compactSoonPercent: percents.compactSoonPercent,
    compactSoonEnabled,
    nearlyFullPercent: percents.nearlyFullPercent,
    nearlyFullEnabled,
    ledgerPercent,
    rotateReminderMode,
    rotateReminderDays,
    rotateReminderWeekday,
    rotateReminderDayOfMonth,
    timeZone,
  };
}

/**
 * 这个会话是否落在生效范围内（scopeSessions）。
 *
 * - `sessions` 空数组（或压根不是数组）→ true，所有会话都生效；
 * - 非空时只要会话 id **等于**某一项、或**以某一项开头**就算命中（方便只写
 *   `session-3df4e987` 这种前缀）；
 * - 空串项一律跳过：`''` 是所有字符串的前缀，留着会让范围形同虚设。
 *
 * 纯函数、不抛，宿主 pre-step 与测试共用这一份。
 */
export function inScope(sessions, sessionId) {
  if (!Array.isArray(sessions) || sessions.length === 0) return true;
  const id = typeof sessionId === 'string' ? sessionId : String(sessionId ?? '');
  for (const item of sessions) {
    if (typeof item !== 'string') continue;
    const prefix = item.trim();
    if (prefix === '') continue;
    if (id === prefix || id.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * 读设置文件并规整；文件不存在、不是 JSON、读失败一律返回 null（不抛）。
 * `base` 是缺项时的兜底，默认 DEFAULT_SETTINGS；宿主要让 patch 里的 config 优先时传它。
 */
export function readSettings(filePath, base = DEFAULT_SETTINGS) {
  try {
    const raw = readFileSync(filePath, 'utf8');
    return normalizeSettings(JSON.parse(raw), base);
  } catch {
    return null;
  }
}

/** 写设置文件（UTF-8，两空格缩进，末尾换行）。父目录不存在先建；失败抛错。 */
export function writeSettings(filePath, value) {
  const text = JSON.stringify(value, null, 2);
  if (typeof text !== 'string') throw new TypeError('设置内容无法序列化成 JSON');
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${text}\n`, 'utf8');
}
