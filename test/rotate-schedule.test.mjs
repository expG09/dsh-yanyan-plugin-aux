/**
 * lib/rotate-schedule.js 的普通 node 测试脚本。
 *
 * 跑法：`node test/rotate-schedule.test.mjs`
 * 不需要测试框架，也不需要装 @deepseek-ai 依赖；全部通过时最后一行为 `PASS <用例数>`。
 *
 * 所有用例都固定 Asia/Shanghai（UTC+8）算本地日期，星期几按真实日历写死：
 * 2026-11-18 是周三，2026-11-21 是周六，2026-11-22 是周日，2026-12-01 是周二，2027-01-01 是周五。
 */
import assert from 'node:assert/strict';

import { isRotateDue } from '../lib/rotate-schedule.js';

const TZ = 'Asia/Shanghai';
const DAY_MS = 24 * 60 * 60 * 1000;

/** 一份完整的模式设置，按需覆盖字段。 */
const settingsOf = (patch = {}) => ({
  rotateReminderMode: 'weekly',
  rotateReminderDays: 7,
  rotateReminderWeekday: 6,
  rotateReminderDayOfMonth: 1,
  ...patch,
});

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

/** 北京时间 2026-11-18（周三）中午：后面几种模式的公共起点。 */
const WED_NOON = '2026-11-18T12:00:00+08:00';

test('从未提醒过（空值 / 坏时间）立刻到期', () => {
  assert.equal(isRotateDue('2026-11-18T12:00:00+08:00', null, settingsOf(), TZ), true);
  assert.equal(isRotateDue('2026-11-18T12:00:00+08:00', undefined, settingsOf(), TZ), true);
  assert.equal(isRotateDue('2026-11-18T12:00:00+08:00', 'not-a-time', settingsOf(), TZ), true);
  assert.equal(isRotateDue('2026-11-18T12:00:00+08:00', '', settingsOf(), TZ), true);
});

test('interval：满 N 天才到期', () => {
  const lastAt = '2026-11-10T08:00:00+08:00';
  const sevenDays = settingsOf({ rotateReminderMode: 'interval', rotateReminderDays: 7 });
  const lastMs = Date.parse(lastAt);
  assert.equal(isRotateDue(lastMs + 7 * DAY_MS - 1, lastAt, sevenDays, TZ), false);
  assert.equal(isRotateDue(lastMs + 7 * DAY_MS, lastAt, sevenDays, TZ), true);
  const threeDays = settingsOf({ rotateReminderMode: 'interval', rotateReminderDays: 3 });
  assert.equal(isRotateDue(lastMs + 3 * DAY_MS - 1, lastAt, threeDays, TZ), false);
  assert.equal(isRotateDue(lastMs + 3 * DAY_MS, lastAt, threeDays, TZ), true);
});

test('weekly：下个周六零点（本地）起到期', () => {
  // 2026-11-18 周三 → 最近的周六是 11-21
  const weekly = settingsOf({ rotateReminderMode: 'weekly', rotateReminderWeekday: 6 });
  assert.equal(isRotateDue('2026-11-20T23:59:00+08:00', WED_NOON, weekly, TZ), false);
  assert.equal(isRotateDue('2026-11-21T00:00:00+08:00', WED_NOON, weekly, TZ), true);
  // 用 UTC 写同一瞬间：本地已是 21 日，所以到期（证明用的是本地日期，不是 UTC）
  assert.equal(isRotateDue('2026-11-20T16:30:00Z', WED_NOON, weekly, TZ), true);
  assert.equal(isRotateDue('2026-11-20T15:30:00Z', WED_NOON, weekly, TZ), false);
});

test('weekly：上次提醒当天就是那个星期几，顺延到下一周', () => {
  const lastSaturday = '2026-11-14T10:00:00+08:00'; // 周六
  const weekly = settingsOf({ rotateReminderMode: 'weekly', rotateReminderWeekday: 6 });
  assert.equal(isRotateDue('2026-11-20T12:00:00+08:00', lastSaturday, weekly, TZ), false);
  assert.equal(isRotateDue('2026-11-21T00:00:00+08:00', lastSaturday, weekly, TZ), true);
});

test('weekly：星期天（0）边界', () => {
  const sunday = settingsOf({ rotateReminderMode: 'weekly', rotateReminderWeekday: 0 });
  assert.equal(isRotateDue('2026-11-21T23:00:00+08:00', WED_NOON, sunday, TZ), false);
  assert.equal(isRotateDue('2026-11-22T00:00:00+08:00', WED_NOON, sunday, TZ), true);
});

test('monthly：最近的「几号」到了就到期', () => {
  const monthly = settingsOf({ rotateReminderMode: 'monthly', rotateReminderDayOfMonth: 1 });
  // 11-18 之后最近的 1 号是 12-01
  assert.equal(isRotateDue('2026-11-30T23:59:00+08:00', WED_NOON, monthly, TZ), false);
  assert.equal(isRotateDue('2026-12-01T00:00:00+08:00', WED_NOON, monthly, TZ), true);
  // 上次提醒正好在 1 号：顺延到下个月 1 号
  const sameDay = '2026-11-01T00:00:00+08:00';
  assert.equal(isRotateDue('2026-11-20T12:00:00+08:00', sameDay, monthly, TZ), false);
  assert.equal(isRotateDue('2026-12-01T00:00:00+08:00', sameDay, monthly, TZ), true);
  // 本月 1 号还没过：本月就到期
  const oct = '2026-10-20T12:00:00+08:00';
  assert.equal(isRotateDue('2026-10-31T23:00:00+08:00', oct, monthly, TZ), false);
  assert.equal(isRotateDue('2026-11-02T00:00:00+08:00', oct, monthly, TZ), true);
});

test('monthly：跨年进位', () => {
  const monthly = settingsOf({ rotateReminderMode: 'monthly', rotateReminderDayOfMonth: 1 });
  const december = '2026-12-20T12:00:00+08:00';
  assert.equal(isRotateDue('2026-12-31T23:00:00+08:00', december, monthly, TZ), false);
  assert.equal(isRotateDue('2027-01-01T00:00:00+08:00', december, monthly, TZ), true);
});

test('未知模式按 weekly 处理', () => {
  const unknown = {
    rotateReminderMode: 'yearly',
    rotateReminderDays: 7,
    rotateReminderWeekday: 6,
    rotateReminderDayOfMonth: 1,
  };
  assert.equal(isRotateDue('2026-11-19T12:00:00+08:00', WED_NOON, unknown, TZ), false);
  assert.equal(isRotateDue('2026-11-21T00:00:00+08:00', WED_NOON, unknown, TZ), true);
});

test('设置里的坏值用默认（星期几=6、几号=1、天数=7）', () => {
  // 星期几 9 非法 → 按周六
  const badWeekday = settingsOf({ rotateReminderMode: 'weekly', rotateReminderWeekday: 9 });
  assert.equal(isRotateDue('2026-11-20T23:00:00+08:00', WED_NOON, badWeekday, TZ), false);
  assert.equal(isRotateDue('2026-11-21T00:00:00+08:00', WED_NOON, badWeekday, TZ), true);
  // 几号 40 非法 → 按 1 号
  const badDayOfMonth = { rotateReminderMode: 'monthly', rotateReminderDayOfMonth: 40 };
  assert.equal(isRotateDue('2026-11-30T23:00:00+08:00', WED_NOON, badDayOfMonth, TZ), false);
  assert.equal(isRotateDue('2026-12-01T00:00:00+08:00', WED_NOON, badDayOfMonth, TZ), true);
  // 天数 0 非法 → 按 7 天
  const lastAt = '2026-11-10T08:00:00+08:00';
  const badDays = { rotateReminderMode: 'interval', rotateReminderDays: 0 };
  assert.equal(isRotateDue(Date.parse(lastAt) + 6 * DAY_MS, lastAt, badDays, TZ), false);
  assert.equal(isRotateDue(Date.parse(lastAt) + 7 * DAY_MS, lastAt, badDays, TZ), true);
});

test('时区非法不抛；now 非法返回 false', () => {
  const weekly = settingsOf({ rotateReminderMode: 'weekly', rotateReminderWeekday: 6 });
  assert.equal(typeof isRotateDue('2026-11-21T00:00:00+08:00', WED_NOON, weekly, 'Mars/Phobos'), 'boolean');
  assert.equal(isRotateDue('not-a-time', WED_NOON, weekly, TZ), false);
  // interval 不依赖时区，照样能判
  const interval = settingsOf({ rotateReminderMode: 'interval', rotateReminderDays: 7 });
  assert.equal(
    isRotateDue(Date.parse(WED_NOON) + 7 * DAY_MS, WED_NOON, interval, 'Mars/Phobos'),
    true,
  );
});

console.log(`PASS ${passed}`);
