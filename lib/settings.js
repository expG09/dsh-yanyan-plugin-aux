/**
 * aux 的设置层：默认值、规整、读写。
 *
 * 这个文件是纯 ESM，**不 import 任何 @deepseek-ai 包**，宿主（index.js）和
 * `node test/settings.test.mjs` 都能直接加载，测试也不需要装依赖。
 *
 * 设置文件默认在 `%USERPROFILE%\.dsh\aux-settings.json`，由 index.js 拼路径传进来；
 * 这里只负责读写一个路径，不关心它具体在哪。
 *
 * 十二项配置里，三个百分比（handoverPercent / compactSoonPercent / nearlyFullPercent）
 * 语义上是一条阶梯，必须严格递增。规整时先各自钳制到 1–100，再按从低到高排一遍；
 * 如果排序后仍相等（比如三项都填了 90），就从低到高各加 1 撑开，顶到 100 时反向往回压。
 * 这一层是兜底，设置页里还有一道前置校验，两层都防。
 * 换新提醒有「周期三选一」：interval / weekly / monthly，非法值回落 weekly。
 *
 * scopeSessions 是**全局生效范围**（不只是换新提醒）：空数组 = 所有会话都收；非空时只有
 * 会话 id 等于某一项、或以某一项开头的会话才会收到任何注入（读数、三档提醒、换新提醒）。
 * 非数组回落 base。判定逻辑抽在纯函数 inScope() 里，宿主和测试共用同一份。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 出厂默认值：与 cordis.patch.yml 里那十二项一一对应。
 * 设置文件不存在 / 读坏时，宿主用它（或 patch 里的 config）兜底。
 */
export const DEFAULT_SETTINGS = Object.freeze({
  scopeSessions: Object.freeze([]),
  clockFile: 'G:\\yanyan-workspace\\report-cache\\clock.md',
  clockIntervalHours: 6,
  injectPerTurn: true,
  handoverPercent: 50,
  compactSoonPercent: 75,
  nearlyFullPercent: 90,
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
/** 百分比的合法区间，超出钳制到边界。 */
const PERCENT_MIN = 1;
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
 * 百分比：取整后钳制到 1–100；不是有限数字返回 null。
 * 钳制而不是回落，是因为越界的百分比还有明确语义（1 或 100）。
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
 * 把已升序排列的三档百分比撑成严格递增，并保证仍在 1–100 内。
 *
 * 例：`[90, 90, 90]` → `[90, 91, 92]`；`[1, 1, 1]` → `[1, 2, 3]`；
 * `[50, 75, 90]` 原样不动。入参不被修改。
 */
function makeStrictlyIncreasing(sorted) {
  const out = [...sorted];
  // 从低到高：每一档至少比前一档大 1
  out[1] = Math.max(out[1], out[0] + 1);
  out[2] = Math.max(out[2], out[1] + 1);
  // 顶出 100 时从高到低回压，保证三档都还在 1–100
  if (out[2] > PERCENT_MAX) out[2] = PERCENT_MAX;
  if (out[1] >= out[2]) out[1] = out[2] - 1;
  if (out[0] >= out[1]) out[0] = out[1] - 1;
  if (out[0] < PERCENT_MIN) out[0] = PERCENT_MIN;
  return out;
}

/**
 * 规整三档百分比。
 *
 * 每一项：输入里合法就用输入，否则用 `base` 里合法的，再否则用 DEFAULT_SETTINGS。
 * 然后按 handover < compactSoon < nearlyFull 的顺序排序并撑成严格递增。
 */
function normalizePercents(src, fallback) {
  const pick = (key) =>
    clampPercent(src[key]) ?? clampPercent(fallback[key]) ?? DEFAULT_SETTINGS[key];
  const ladder = [pick('handoverPercent'), pick('compactSoonPercent'), pick('nearlyFullPercent')].sort(
    (a, b) => a - b,
  );
  const [handoverPercent, compactSoonPercent, nearlyFullPercent] = makeStrictlyIncreasing(ladder);
  return { handoverPercent, compactSoonPercent, nearlyFullPercent };
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

  const injectPerTurn =
    typeof src.injectPerTurn === 'boolean'
      ? src.injectPerTurn
      : typeof fallback.injectPerTurn === 'boolean'
        ? fallback.injectPerTurn
        : DEFAULT_SETTINGS.injectPerTurn;

  const percents = normalizePercents(src, fallback);

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
    ...percents,
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
