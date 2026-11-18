/**
 * aux 的设置层：默认值、规整、读写。
 *
 * 这个文件是纯 ESM，**不 import 任何 @deepseek-ai 包**，宿主（index.js）和
 * `node test/settings.test.mjs` 都能直接加载，测试也不需要装依赖。
 *
 * 设置文件默认在 `%USERPROFILE%\.dsh\aux-settings.json`，由 index.js 拼路径传进来；
 * 这里只负责读写一个路径，不关心它具体在哪。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 出厂默认值：与 cordis.patch.yml 里那五行一一对应。
 * 设置文件不存在 / 读坏时，宿主用它（或 patch 里的 config）兜底。
 */
export const DEFAULT_SETTINGS = Object.freeze({
  clockFile: 'G:\\yanyan-workspace\\report-cache\\clock.md',
  clockIntervalHours: 6,
  injectPerTurn: true,
  thresholds: Object.freeze([50, 70]),
  timeZone: 'Asia/Shanghai',
});

/** 小时数的合法区间，超出按非法处理（回落到 base，不钳制）。 */
const HOURS_MIN = 1;
const HOURS_MAX = 168;

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
 * 规整阈值数组：逐项取整并钳制到 1–100，去重后升序。
 * 不是数组、空数组、或者一项合法的都没有 —— 返回 null，交给 base 兜底。
 */
function normalizeThresholds(value) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  for (const item of value) {
    const raw = toNumber(item);
    if (raw === null) continue;
    const clamped = Math.min(100, Math.max(1, Math.round(raw)));
    seen.add(clamped);
  }
  if (seen.size === 0) return null;
  return [...seen].sort((a, b) => a - b);
}

/**
 * 把任意输入规整成一份合法设置。
 *
 * 每一项：输入里合法就用输入，否则用 `base` 里合法的，再否则用 DEFAULT_SETTINGS。
 * 永远返回新对象（thresholds 也是新数组），不修改入参。
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

  const thresholds =
    normalizeThresholds(src.thresholds) ??
    normalizeThresholds(fallback.thresholds) ??
    [...DEFAULT_SETTINGS.thresholds];

  const timeZone =
    validTimeZone(src.timeZone) ??
    validTimeZone(fallback.timeZone) ??
    DEFAULT_SETTINGS.timeZone;

  return { clockFile, clockIntervalHours, injectPerTurn, thresholds, timeZone };
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
