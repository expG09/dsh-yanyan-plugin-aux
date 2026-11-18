/**
 * lib/settings.js 的普通 node 测试脚本。
 *
 * 跑法：`node test/settings.test.mjs`
 * 不需要任何测试框架，也不需要装 @deepseek-ai 依赖；全部通过时最后一行为 `PASS <用例数>`。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_SETTINGS,
  inScope,
  normalizeSettings,
  readSettings,
  writeSettings,
} from '../lib/settings.js';

/** 兜底基准：故意用与 DEFAULT_SETTINGS 不同的值，才能看出“回落到 base”而不是“回落到默认”。 */
const BASE = {
  scopeSessions: ['base-session'],
  clockFile: 'D:\\base\\clock.md',
  clockIntervalHours: 6,
  injectPerTurn: true,
  handoverPercent: 40,
  compactSoonPercent: 65,
  nearlyFullPercent: 85,
  rotateReminderMode: 'monthly',
  rotateReminderDays: 14,
  rotateReminderWeekday: 3,
  rotateReminderDayOfMonth: 15,
  timeZone: 'Asia/Shanghai',
};

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

/** 三档百分比是否严格递增且都在 1–100 内。 */
function assertLadder(out, label) {
  assert.ok(
    out.handoverPercent < out.compactSoonPercent && out.compactSoonPercent < out.nearlyFullPercent,
    `${label}：三档应当严格递增，实际 ${out.handoverPercent}/${out.compactSoonPercent}/${out.nearlyFullPercent}`,
  );
  for (const [key, value] of [
    ['handoverPercent', out.handoverPercent],
    ['compactSoonPercent', out.compactSoonPercent],
    ['nearlyFullPercent', out.nearlyFullPercent],
  ]) {
    assert.ok(Number.isInteger(value) && value >= 1 && value <= 100, `${label}：${key}=${value} 应在 1–100 内`);
  }
}

const workDir = mkdtempSync(join(tmpdir(), 'aux-settings-test-'));

try {
  test('出厂默认值就是 patch 里那十二项', () => {
    assert.deepEqual(DEFAULT_SETTINGS.clockFile, 'G:\\yanyan-workspace\\report-cache\\clock.md');
    assert.equal(DEFAULT_SETTINGS.clockIntervalHours, 6);
    assert.equal(DEFAULT_SETTINGS.injectPerTurn, true);
    assert.equal(DEFAULT_SETTINGS.handoverPercent, 50);
    assert.equal(DEFAULT_SETTINGS.compactSoonPercent, 75);
    assert.equal(DEFAULT_SETTINGS.nearlyFullPercent, 90);
    assert.equal(DEFAULT_SETTINGS.rotateReminderMode, 'weekly');
    assert.equal(DEFAULT_SETTINGS.rotateReminderDays, 7);
    assert.equal(DEFAULT_SETTINGS.rotateReminderWeekday, 6);
    assert.equal(DEFAULT_SETTINGS.rotateReminderDayOfMonth, 1);
    assert.deepEqual([...DEFAULT_SETTINGS.scopeSessions], []);
    assert.equal(DEFAULT_SETTINGS.timeZone, 'Asia/Shanghai');
  });

  test('非法小时数回落到 base', () => {
    for (const bad of [0, 169, -3, 'abc', '8', '', null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(
        normalizeSettings({ clockIntervalHours: bad }, BASE).clockIntervalHours,
        BASE.clockIntervalHours,
        `小时数 ${String(bad)} 应该回落`,
      );
    }
    // 合法数字照原样留下（允许小数）
    assert.equal(normalizeSettings({ clockIntervalHours: 12 }, BASE).clockIntervalHours, 12);
    assert.equal(normalizeSettings({ clockIntervalHours: 1.5 }, BASE).clockIntervalHours, 1.5);
  });

  test('三个百分比越界钳制到 1–100', () => {
    // 只动一档、钳制后仍落在原位置的情况，能直接看到钳制结果
    assert.equal(normalizeSettings({ handoverPercent: -20 }, BASE).handoverPercent, 1);
    assert.equal(normalizeSettings({ handoverPercent: 0 }, BASE).handoverPercent, 1);
    assert.equal(normalizeSettings({ handoverPercent: 2.6 }, BASE).handoverPercent, 3);
    assert.equal(normalizeSettings({ nearlyFullPercent: 250 }, BASE).nearlyFullPercent, 100);
    assert.equal(normalizeSettings({ nearlyFullPercent: 101.4 }, BASE).nearlyFullPercent, 100);
    // 三档一起越界：钳制后还要能排成递增
    const out = normalizeSettings(
      { handoverPercent: -5, compactSoonPercent: 0, nearlyFullPercent: 1000 },
      BASE,
    );
    assert.deepEqual(out.handoverPercent, 1);
    assertLadder(out, '全部越界');
    // 非数字不算越界，按非法回落到 base
    for (const bad of ['50', null, undefined, Number.NaN, {}, []]) {
      assert.equal(
        normalizeSettings({ handoverPercent: bad }, BASE).handoverPercent,
        BASE.handoverPercent,
        `百分比 ${String(bad)} 应该回落`,
      );
    }
  });

  test('三档非递增被修正成递增', () => {
    // 倒序：按 handover < compactSoon < nearlyFull 的顺序重排
    assert.deepEqual(
      (({ handoverPercent, compactSoonPercent, nearlyFullPercent }) => [
        handoverPercent,
        compactSoonPercent,
        nearlyFullPercent,
      ])(normalizeSettings({ handoverPercent: 90, compactSoonPercent: 50, nearlyFullPercent: 75 }, BASE)),
      [50, 75, 90],
    );
    // 全相等：从低到高各加 1 撑开，只加必要的量，不改原值高低
    const allSame = normalizeSettings(
      { handoverPercent: 90, compactSoonPercent: 90, nearlyFullPercent: 90 },
      BASE,
    );
    assert.deepEqual(
      [allSame.handoverPercent, allSame.compactSoonPercent, allSame.nearlyFullPercent],
      [90, 91, 92],
    );
    // 贴底相等：从 1 开始排
    const allOne = normalizeSettings(
      { handoverPercent: 1, compactSoonPercent: 1, nearlyFullPercent: 1 },
      BASE,
    );
    assert.deepEqual(
      [allOne.handoverPercent, allOne.compactSoonPercent, allOne.nearlyFullPercent],
      [1, 2, 3],
    );
    // 只有两档相等
    const pair = normalizeSettings(
      { handoverPercent: 80, compactSoonPercent: 80, nearlyFullPercent: 90 },
      BASE,
    );
    assert.deepEqual(
      [pair.handoverPercent, pair.compactSoonPercent, pair.nearlyFullPercent],
      [80, 81, 90],
    );
    // 乱序 + 越界混在一起也要收敛
    for (const input of [
      { handoverPercent: 100, compactSoonPercent: 100, nearlyFullPercent: 100 },
      { handoverPercent: 99, compactSoonPercent: 100, nearlyFullPercent: 100 },
      { handoverPercent: 0, compactSoonPercent: 100, nearlyFullPercent: 0 },
      { handoverPercent: 75, compactSoonPercent: 75, nearlyFullPercent: 75 },
    ]) {
      assertLadder(normalizeSettings(input, BASE), JSON.stringify(input));
    }
  });

  test('换新天数钳制到 1–365', () => {
    assert.equal(normalizeSettings({ rotateReminderDays: 1 }, BASE).rotateReminderDays, 1);
    assert.equal(normalizeSettings({ rotateReminderDays: 365 }, BASE).rotateReminderDays, 365);
    assert.equal(normalizeSettings({ rotateReminderDays: 0 }, BASE).rotateReminderDays, 1);
    assert.equal(normalizeSettings({ rotateReminderDays: -5 }, BASE).rotateReminderDays, 1);
    assert.equal(normalizeSettings({ rotateReminderDays: 999 }, BASE).rotateReminderDays, 365);
    assert.equal(normalizeSettings({ rotateReminderDays: 3.6 }, BASE).rotateReminderDays, 4);
    // 非数字回落到 base
    for (const bad of ['7', null, undefined, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      assert.equal(
        normalizeSettings({ rotateReminderDays: bad }, BASE).rotateReminderDays,
        BASE.rotateReminderDays,
        `换新天数 ${String(bad)} 应该回落`,
      );
    }
  });

  test('换新提醒周期：三选一，非法值回落 base', () => {
    for (const mode of ['interval', 'weekly', 'monthly']) {
      assert.equal(normalizeSettings({ rotateReminderMode: mode }, BASE).rotateReminderMode, mode);
    }
    for (const bad of ['yearly', 'Interval', '', '每天', null, 42, {}]) {
      assert.equal(
        normalizeSettings({ rotateReminderMode: bad }, BASE).rotateReminderMode,
        BASE.rotateReminderMode,
        `模式 ${String(bad)} 应该回落`,
      );
    }
    // base 也没有合法模式时，回落到出厂默认 weekly
    assert.equal(
      normalizeSettings({ rotateReminderMode: 'daily' }, { ...BASE, rotateReminderMode: 'nope' })
        .rotateReminderMode,
      'weekly',
    );
  });

  test('星期几与每月几号的边界', () => {
    // 0 = 周日 … 6 = 周六
    for (let weekday = 0; weekday <= 6; weekday += 1) {
      assert.equal(
        normalizeSettings({ rotateReminderWeekday: weekday }, BASE).rotateReminderWeekday,
        weekday,
      );
    }
    for (const bad of [-1, 7, 8, '6', null, {}]) {
      assert.equal(
        normalizeSettings({ rotateReminderWeekday: bad }, BASE).rotateReminderWeekday,
        BASE.rotateReminderWeekday,
        `星期几 ${String(bad)} 应该回落`,
      );
    }
    // 小数按四舍五入取整后再判区间
    assert.equal(normalizeSettings({ rotateReminderWeekday: 1.4 }, BASE).rotateReminderWeekday, 1);
    // 每月几号：1–28（保证每个月都有）
    for (const day of [1, 28]) {
      assert.equal(
        normalizeSettings({ rotateReminderDayOfMonth: day }, BASE).rotateReminderDayOfMonth,
        day,
      );
    }
    for (const bad of [0, 29, 31, -3, '1', null, {}]) {
      assert.equal(
        normalizeSettings({ rotateReminderDayOfMonth: bad }, BASE).rotateReminderDayOfMonth,
        BASE.rotateReminderDayOfMonth,
        `每月几号 ${String(bad)} 应该回落`,
      );
    }
    assert.equal(normalizeSettings({ rotateReminderDayOfMonth: 5.6 }, BASE).rotateReminderDayOfMonth, 6);
  });

  test('生效范围 scopeSessions：去空白、去空串、去重，非数组回落 base', () => {
    // 默认空数组 = 所有会话
    assert.deepEqual([...DEFAULT_SETTINGS.scopeSessions], []);
    // 空数组是合法值，不回落 base
    assert.deepEqual(normalizeSettings({ scopeSessions: [] }, BASE).scopeSessions, []);
    // 单值照留
    assert.deepEqual(
      normalizeSettings({ scopeSessions: ['session-x'] }, BASE).scopeSessions,
      ['session-x'],
    );
    // 去首尾空白、去空串、去重、丢掉非字符串，保持出现顺序
    assert.deepEqual(
      normalizeSettings(
        { scopeSessions: ['  session-a  ', '', '   ', 'session-a', 123, null, 'session-b'] },
        BASE,
      ).scopeSessions,
      ['session-a', 'session-b'],
    );
    // 非数组回落 base
    for (const bad of ['session-a', null, undefined, 42, {}, true]) {
      assert.deepEqual(
        normalizeSettings({ scopeSessions: bad }, BASE).scopeSessions,
        ['base-session'],
        `生效范围 ${String(bad)} 应该回落`,
      );
    }
    // 返回的是新数组，不改入参
    const input = ['  a  ', 'a', 'b'];
    const out = normalizeSettings({ scopeSessions: input }, BASE);
    assert.notEqual(out.scopeSessions, input);
    assert.deepEqual(input, ['  a  ', 'a', 'b']);
    assert.deepEqual(out.scopeSessions, ['a', 'b']);
    // 只认正好叫 scopeSessions 的键：拼错（少个 s）的未知键不影响结果，交给 base 兜底
    assert.deepEqual(
      normalizeSettings({ scopeSession: ['typo-session'] }, BASE).scopeSessions,
      ['base-session'],
    );
  });

  test('inScope：空数组 = 不过滤（所有会话都生效）', () => {
    for (const id of ['session-1', 'unknown', '', 'Session-A']) {
      assert.equal(inScope([], id), true, `空范围应该放行 ${JSON.stringify(id)}`);
    }
    // 非数组也当“没设范围”：这是宿主读坏配置时的兜底，宁可多注入也不要静默失效
    for (const bad of [null, undefined, 'session-1', {}, 42]) {
      assert.equal(inScope(bad, 'session-1'), true, `范围 ${String(bad)} 应该放行`);
    }
  });

  test('inScope：精确匹配与前缀匹配', () => {
    const scope = ['session-3df4e987', 'session-b'];
    // 完全相等
    assert.equal(inScope(scope, 'session-3df4e987'), true);
    assert.equal(inScope(scope, 'session-b'), true);
    // 以某一项开头（只填前缀也能生效）
    assert.equal(inScope(scope, 'session-3df4e987-extra'), true);
    assert.equal(inScope(scope, 'session-b-2026'), true);
    // 范围项自带前后空白也认（手改 JSON 常见）
    assert.equal(inScope(['  session-c  '], 'session-c-1'), true);
  });

  test('inScope：不匹配就跳过（只看前缀，不做子串）', () => {
    const scope = ['session-3df4e987'];
    // 前缀不对
    assert.equal(inScope(scope, 'session-aaaaaaaa'), false);
    assert.equal(inScope(scope, 'other-session-3df4e987'), false);
    // 前缀比会话 id 长
    assert.equal(inScope(['session-3df4e987-extra'], 'session-3df4e987'), false);
    // 大小写不同不算命中
    assert.equal(inScope(['Session-3DF4E987'], 'session-3df4e987'), false);
    // 空串项 / 非字符串项跳过：否则 '' 是所有字符串的前缀，范围会被废掉
    assert.equal(inScope(['', '   ', 42, null], 'session-any'), false);
    // 未知会话 id（宿主拿不到 header.id 时是 'unknown'）也不会命中具体前缀
    assert.equal(inScope(scope, 'unknown'), false);
  });

  test('非绝对路径的时钟文件回落到 base', () => {
    for (const bad of ['clock.md', '', '   ', 'C:relative.md', '\\\\server\\share\\clock.md', 42, null]) {
      assert.equal(
        normalizeSettings({ clockFile: bad }, BASE).clockFile,
        BASE.clockFile,
        `路径 ${String(bad)} 应该回落`,
      );
    }
    assert.equal(normalizeSettings({ clockFile: 'D:\\x\\clock.md' }, BASE).clockFile, 'D:\\x\\clock.md');
    assert.equal(normalizeSettings({ clockFile: '/tmp/clock.md' }, BASE).clockFile, '/tmp/clock.md');
  });

  test('非法时区回落到 base', () => {
    for (const bad of ['Mars/Phobos', '', 'not a zone', 123, null]) {
      assert.equal(
        normalizeSettings({ timeZone: bad }, BASE).timeZone,
        BASE.timeZone,
        `时区 ${String(bad)} 应该回落`,
      );
    }
    assert.equal(normalizeSettings({ timeZone: 'UTC' }, BASE).timeZone, 'UTC');
  });

  test('非布尔 injectPerTurn 回落到 base', () => {
    assert.equal(normalizeSettings({ injectPerTurn: 'false' }, BASE).injectPerTurn, true);
    assert.equal(normalizeSettings({ injectPerTurn: 0 }, BASE).injectPerTurn, true);
    assert.equal(normalizeSettings({ injectPerTurn: false }, BASE).injectPerTurn, false);
  });

  test('旧的 thresholds 数组被忽略，不影响新键', () => {
    const out = normalizeSettings({ thresholds: [10, 20], clockIntervalHours: 9 }, BASE);
    assert.equal(out.clockIntervalHours, 9);
    assert.equal(out.handoverPercent, BASE.handoverPercent);
    assert.equal(out.compactSoonPercent, BASE.compactSoonPercent);
    assert.equal(out.nearlyFullPercent, BASE.nearlyFullPercent);
    assert.equal(out.rotateReminderDays, BASE.rotateReminderDays);
    assert.equal('thresholds' in out, false);
  });

  test('返回新对象且不修改入参', () => {
    const input = {
      clockIntervalHours: 8,
      clockFile: '/a/clock.md',
      handoverPercent: 85,
      compactSoonPercent: 20,
      nearlyFullPercent: 60,
      rotateReminderDays: 30,
    };
    const snapshot = { ...input };
    const out = normalizeSettings(input, BASE);
    assert.notEqual(out, input);
    assert.deepEqual(input, snapshot);
    assert.deepEqual(
      [out.handoverPercent, out.compactSoonPercent, out.nearlyFullPercent],
      [20, 60, 85],
    );
    assert.equal(out.rotateReminderDays, 30);
  });

  test('坏 JSON 返回 null', () => {
    const file = join(workDir, 'broken.json');
    writeFileSync(file, '{ 这不是 JSON', 'utf8');
    assert.equal(readSettings(file), null);
    // 坏 JSON 时宿主会保留上一份好配置，这里只验读不抛
    writeFileSync(file, '', 'utf8');
    assert.equal(readSettings(file), null);
  });

  test('文件不存在返回 null', () => {
    assert.equal(readSettings(join(workDir, 'missing.json')), null);
    assert.equal(readSettings(join(workDir, 'no-such-dir', 'missing.json')), null);
  });

  test('写入后能读回，且末尾有换行、UTF-8 正常', () => {
    const file = join(workDir, 'roundtrip.json');
    const value = {
      scopeSessions: ['session-a', 'session-b'],
      clockFile: 'D:\\砚砚\\report-cache\\clock.md',
      clockIntervalHours: 12,
      injectPerTurn: false,
      handoverPercent: 30,
      compactSoonPercent: 60,
      nearlyFullPercent: 90,
      rotateReminderMode: 'interval',
      rotateReminderDays: 3,
      rotateReminderWeekday: 5,
      rotateReminderDayOfMonth: 2,
      timeZone: 'UTC',
    };
    writeSettings(file, value);
    const raw = readFileSync(file, 'utf8');
    assert.ok(raw.endsWith('\n'), '文件末尾应有换行');
    assert.ok(raw.includes('砚砚'), '中文路径应按 UTF-8 原样写入');
    assert.deepEqual(readSettings(file), value);
  });

  test('读文件时会顺带规整（不改文件本身）', () => {
    const file = join(workDir, 'messy.json');
    writeFileSync(
      file,
      JSON.stringify({
        thresholds: [10, 20],
        handoverPercent: 80,
        compactSoonPercent: 20,
        rotateReminderMode: 'yearly',
        rotateReminderDays: 999,
        rotateReminderWeekday: 9,
        rotateReminderDayOfMonth: 40,
        scopeSessions: ['  s1  ', 's1', '', 42, 's2'],
        clockIntervalHours: 999,
      }),
      'utf8',
    );
    assert.deepEqual(readSettings(file), {
      scopeSessions: ['s1', 's2'],
      clockFile: DEFAULT_SETTINGS.clockFile,
      clockIntervalHours: DEFAULT_SETTINGS.clockIntervalHours,
      injectPerTurn: DEFAULT_SETTINGS.injectPerTurn,
      handoverPercent: 20,
      compactSoonPercent: 80,
      nearlyFullPercent: DEFAULT_SETTINGS.nearlyFullPercent,
      rotateReminderMode: DEFAULT_SETTINGS.rotateReminderMode,
      rotateReminderDays: 365,
      rotateReminderWeekday: DEFAULT_SETTINGS.rotateReminderWeekday,
      rotateReminderDayOfMonth: DEFAULT_SETTINGS.rotateReminderDayOfMonth,
      timeZone: DEFAULT_SETTINGS.timeZone,
    });
  });
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

console.log(`PASS ${passed}`);
