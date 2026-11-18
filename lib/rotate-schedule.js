/**
 * 换新提醒的到期判断（纯函数，不碰文件、不 import 任何 @deepseek-ai 包）。
 *
 * 三种周期模式（`rotateReminderMode`）：
 *   - `interval`：距上次提醒满 `rotateReminderDays` 天（1–365）；
 *   - `weekly`：上次提醒之后最近的、落在 `rotateReminderWeekday`（0 = 周日 … 6 = 周六）的
 *     那个自然日到了，就算到期；
 *   - `monthly`：上次提醒之后最近的、`rotateReminderDayOfMonth`（1–28）那个自然日到了。
 *
 * 「周几 / 几号」一律用配置的 `timeZone` 算本地日期，不是 UTC；时区无效时退回进程所在时区。
 * 「到了」按本地日期比较：到那天（本地零点起）就算到期，不等到当天结束。
 * 从未提醒过（lastAt 为空 / 不是合法时间）→ 立刻到期。
 *
 * 单独一个模块，是为了让 `node test/rotate-schedule.test.mjs` 能直接测，不用起宿主。
 */

/** 一天有多少毫秒；interval 模式用。 */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 把 Date / 毫秒 / ISO 字符串统一成毫秒；空值或不合法返回 null。
 */
function toMs(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * 指定时区的日期格式化器（只要年月日）。
 * 时区无效时退回进程所在时区；连这个都不行返回 null。
 */
function makeDateFormatter(timeZone) {
  const options = { year: 'numeric', month: '2-digit', day: '2-digit' };
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone });
  } catch {
    try {
      return new Intl.DateTimeFormat('en-US', options);
    } catch {
      return null;
    }
  }
}

/**
 * 某个时刻在指定时区里的「本地日期」，转成 UTC 零点的毫秒。
 *
 * 只拿它做**日期算术**（加减天数、比大小），不当作真实时刻：
 * 本地日历日 (Y, M, D) 与 `Date.UTC(Y, M, D)` 的星期几、先后关系完全一致，
 * 这样就绕开了夏令时和「本地零点对应哪个 UTC 时刻」的麻烦。
 */
function localDateMs(ms, formatter) {
  if (formatter === null) return null;
  const parts = formatter.formatToParts(new Date(ms));
  const at = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const year = Number(at.year);
  const month = Number(at.month);
  const day = Number(at.day);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return Date.UTC(year, month - 1, day);
}

/**
 * 严格在 `lastDateMs`（本地日期）之后、最近的落在 `weekday` 的那一天。
 * 循环最多 7 天，一定能命中。
 */
function nextWeekly(lastDateMs, weekday) {
  const start = new Date(lastDateMs);
  for (let add = 1; add <= 7; add += 1) {
    const candidate = Date.UTC(
      start.getUTCFullYear(),
      start.getUTCMonth(),
      start.getUTCDate() + add,
    );
    if (new Date(candidate).getUTCDay() === weekday) return candidate;
  }
  // 理论到不了；兜底给 7 天后
  return lastDateMs + 7 * DAY_MS;
}

/**
 * 严格在 `lastDateMs`（本地日期）之后、最近的那个「几号」。
 * 本月的那天还没到就用本月，否则用下月（`Date.UTC` 会自动跨年进位）。
 */
function nextMonthly(lastDateMs, dayOfMonth) {
  const start = new Date(lastDateMs);
  const thisMonth = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), dayOfMonth);
  if (thisMonth > lastDateMs) return thisMonth;
  return Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, dayOfMonth);
}

/** 从设置里取一个合法的星期几 / 几号 / 天数，坏值退回默认，保证判断不会卡死。 */
function readNumberSetting(value, min, max, fallback) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

/**
 * 现在是否该发一次换新提醒。
 *
 * @param {Date|number|string} now 当前时间
 * @param {Date|number|string|null} lastAt 上次提醒时间；空 / 不合法 = 从未提醒过
 * @param {object} settings 生效中的设置（至少含 rotateReminderMode 等四项）
 * @param {string} timeZone 算「周几 / 几号」用的 IANA 时区
 * @returns {boolean}
 */
export function isRotateDue(now, lastAt, settings, timeZone) {
  const nowMs = toMs(now);
  if (nowMs === null) return false;

  const lastMs = toMs(lastAt);
  if (lastMs === null) return true; // 从未提醒过 → 立刻提醒

  // 未知模式按 weekly 处理（normalizeSettings 已经兜过一层，这里再兜一层）
  const mode = settings?.rotateReminderMode;

  if (mode === 'interval') {
    const days = readNumberSetting(settings?.rotateReminderDays, 1, 365, 7);
    return nowMs - lastMs >= days * DAY_MS;
  }

  const formatter = makeDateFormatter(timeZone);
  if (formatter === null) {
    // 连本地日期都算不出来：退回按 7 天，至少不会漏提醒也不会每个 pre-step 都提醒
    return nowMs - lastMs >= 7 * DAY_MS;
  }

  const nowDate = localDateMs(nowMs, formatter);
  const lastDate = localDateMs(lastMs, formatter);
  if (nowDate === null || lastDate === null) return false;

  if (mode === 'monthly') {
    const dayOfMonth = readNumberSetting(settings?.rotateReminderDayOfMonth, 1, 28, 1);
    return nowDate >= nextMonthly(lastDate, dayOfMonth);
  }

  // weekly
  const weekday = readNumberSetting(settings?.rotateReminderWeekday, 0, 6, 6);
  return nowDate >= nextWeekly(lastDate, weekday);
}
