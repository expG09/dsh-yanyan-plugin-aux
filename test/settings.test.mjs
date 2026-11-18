/**
 * lib/settings.js 的普通 node 测试脚本。
 *
 * 跑法：`node test/settings.test.mjs`
 * 不需要任何测试框架，也不需要装 @deepseek-ai 依赖；全部通过时最后一行为 `PASS <用例数>`。
 *
 * 2.5.0 起的重点：
 *   - 三档提醒的开关仍是「百分比填 0」；折叠 / 用完两档另加回自己的勾，勾未选与填 0 等效；
 *   - 写长期记忆（ledgerPercent）是**独立一档**：0 合法、越界钳制、不参与三档递增；
 *   - 四个档各自关闭互不影响；
 *   - 旧键 templateEnabled / ledgerReminderEnabled 被静默忽略。
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
  // 三个勾在 BASE 里故意都是 false：出厂默认是 true，才能分清「回落 base」和「回落默认」
  handoverTemplateEnabled: false,
  compactSoonEnabled: false,
  nearlyFullEnabled: false,
  handoverPercent: 40,
  compactSoonPercent: 65,
  nearlyFullPercent: 85,
  ledgerPercent: 30,
  rotateReminderMode: 'monthly',
  rotateReminderDays: 14,
  rotateReminderWeekday: 3,
  rotateReminderDayOfMonth: 15,
  timeZone: 'Asia/Shanghai',
};

/** 已经删掉 / 改名 / 被新键取代的旧键：任何输入里出现都不该回到结果里。 */
const REMOVED_KEYS = ['handoverEnabled', 'templateEnabled', 'ledgerReminderEnabled'];

/** 三个勾的键（交接档的落模板 + 折叠 / 用完两档的发提醒），后面几条用例共用。 */
const CHECK_KEYS = ['handoverTemplateEnabled', 'compactSoonEnabled', 'nearlyFullEnabled'];

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

/** 三档百分比取成数组，方便直接比。 */
function ladderOf(out) {
  return [out.handoverPercent, out.compactSoonPercent, out.nearlyFullPercent];
}

/**
 * 三档百分比是否合法：
 *   - 每一项都是 0–100 的整数（0 = 关闭这一档）；
 *   - 只有**大于 0** 的那几档之间才严格递增（0 的档直接跳过）。
 */
function assertLadder(out, label) {
  const values = ladderOf(out);
  for (const [index, value] of values.entries()) {
    assert.ok(
      Number.isInteger(value) && value >= 0 && value <= 100,
      `${label}：第 ${index + 1} 档=${value} 应在 0–100 内`,
    );
  }
  const active = values.filter((value) => value > 0);
  for (let index = 1; index < active.length; index += 1) {
    assert.ok(
      active[index - 1] < active[index],
      `${label}：大于 0 的档应当严格递增，实际 ${values.join('/')}`,
    );
  }
}

const workDir = mkdtempSync(join(tmpdir(), 'aux-settings-test-'));

try {
  test('出厂默认值就是 patch 里那十六项', () => {
    assert.deepEqual(DEFAULT_SETTINGS.clockFile, 'G:\\yanyan-workspace\\report-cache\\clock.md');
    assert.equal(DEFAULT_SETTINGS.clockIntervalHours, 6);
    assert.equal(DEFAULT_SETTINGS.injectPerTurn, true);
    // 三个勾：出厂默认都开
    assert.equal(DEFAULT_SETTINGS.handoverTemplateEnabled, true);
    assert.equal(DEFAULT_SETTINGS.compactSoonEnabled, true);
    assert.equal(DEFAULT_SETTINGS.nearlyFullEnabled, true);
    // 四个档默认都开着（都不是 0）
    assert.equal(DEFAULT_SETTINGS.handoverPercent, 50);
    assert.equal(DEFAULT_SETTINGS.compactSoonPercent, 75);
    assert.equal(DEFAULT_SETTINGS.nearlyFullPercent, 90);
    assert.equal(DEFAULT_SETTINGS.ledgerPercent, 50);
    assert.equal(DEFAULT_SETTINGS.rotateReminderMode, 'weekly');
    assert.equal(DEFAULT_SETTINGS.rotateReminderDays, 7);
    assert.equal(DEFAULT_SETTINGS.rotateReminderWeekday, 6);
    assert.equal(DEFAULT_SETTINGS.rotateReminderDayOfMonth, 1);
    assert.deepEqual([...DEFAULT_SETTINGS.scopeSessions], []);
    assert.equal(DEFAULT_SETTINGS.timeZone, 'Asia/Shanghai');
    // 2.4.0 的十四项 + 写长期记忆一档 + 加回来的两个勾 = 十六项
    assert.equal(Object.keys(DEFAULT_SETTINGS).length, 16);
    for (const gone of REMOVED_KEYS) {
      assert.equal(gone in DEFAULT_SETTINGS, false, `${gone} 应从出厂默认里删掉`);
    }
    // 2.4.0 删过的两个勾现在回来了
    assert.equal('compactSoonEnabled' in DEFAULT_SETTINGS, true);
    assert.equal('nearlyFullEnabled' in DEFAULT_SETTINGS, true);
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

  test('三个百分比允许 0，越界钳制到 0–100', () => {
    // 0 是合法值：表示关闭这一档，不能再被钳成 1
    assert.equal(normalizeSettings({ handoverPercent: 0 }, BASE).handoverPercent, 0);
    // 负数钳到 0（关闭），100 以上钳到 100
    assert.equal(normalizeSettings({ handoverPercent: -20 }, BASE).handoverPercent, 0);
    assert.equal(normalizeSettings({ handoverPercent: 2.6 }, BASE).handoverPercent, 3);
    assert.equal(normalizeSettings({ nearlyFullPercent: 250 }, BASE).nearlyFullPercent, 100);
    assert.equal(normalizeSettings({ nearlyFullPercent: 101.4 }, BASE).nearlyFullPercent, 100);
    // 三档一起越界：负数都钳成 0（= 关），超 100 的钳成 100
    const out = normalizeSettings(
      { handoverPercent: -5, compactSoonPercent: 0, nearlyFullPercent: 1000 },
      BASE,
    );
    assert.deepEqual(ladderOf(out), [0, 0, 100]);
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

  test('0/0/0 合法：三档全关', () => {
    const out = normalizeSettings(
      { handoverPercent: 0, compactSoonPercent: 0, nearlyFullPercent: 0 },
      BASE,
    );
    assert.deepEqual(ladderOf(out), [0, 0, 0]);
    assertLadder(out, '三档全关');
    // 三个都传 0 时不会被任何钳制 / 撑开逻辑改成非 0
    for (const value of ladderOf(out)) assert.equal(value, 0);
  });

  test('50/0/90 合法：0 的档被跳过，不参与递增', () => {
    const out = normalizeSettings(
      { handoverPercent: 50, compactSoonPercent: 0, nearlyFullPercent: 90 },
      BASE,
    );
    assert.deepEqual(ladderOf(out), [50, 0, 90]);
    assertLadder(out, '中间档关闭');

    // 单档 0 时其它两档原样保留，不会被重排
    const cases = [
      [{ handoverPercent: 0, compactSoonPercent: 70, nearlyFullPercent: 90 }, [0, 70, 90]],
      [{ handoverPercent: 40, compactSoonPercent: 0, nearlyFullPercent: 85 }, [40, 0, 85]],
      [{ handoverPercent: 40, compactSoonPercent: 65, nearlyFullPercent: 0 }, [40, 65, 0]],
    ];
    for (const [input, expected] of cases) {
      const out = normalizeSettings(input, BASE);
      assert.deepEqual(ladderOf(out), expected, `${JSON.stringify(input)} 应原样保留`);
    }
  });

  test('0/70/50 不合法：大于 0 的档被重排成递增', () => {
    // 0 的交接档跳过，剩下 70 / 50 两档都开着但不递增 → 20 的顺序被纠正成 50 / 70
    const out = normalizeSettings(
      { handoverPercent: 0, compactSoonPercent: 70, nearlyFullPercent: 50 },
      BASE,
    );
    assert.deepEqual(ladderOf(out), [0, 50, 70]);
    assert.equal(out.handoverPercent, 0, '0 的档必须保持 0，不能被排进阶梯');
    assertLadder(out, '0/70/50');
    // 两档相等时也撑开
    assert.deepEqual(
      ladderOf(normalizeSettings({ handoverPercent: 0, compactSoonPercent: 70, nearlyFullPercent: 70 }, BASE)),
      [0, 70, 71],
    );
    // 顶格两档相等：从 100 往回压
    assert.deepEqual(
      ladderOf(normalizeSettings({ handoverPercent: 0, compactSoonPercent: 100, nearlyFullPercent: 100 }, BASE)),
      [0, 99, 100],
    );
  });

  test('三档非递增被修正成递增', () => {
    // 倒序：按 handover < compactSoon < nearlyFull 的顺序重排
    assert.deepEqual(
      ladderOf(normalizeSettings({ handoverPercent: 90, compactSoonPercent: 50, nearlyFullPercent: 75 }, BASE)),
      [50, 75, 90],
    );
    // 全相等：从低到高各加 1 撑开，只加必要的量，不改原值高低
    const allSame = normalizeSettings(
      { handoverPercent: 90, compactSoonPercent: 90, nearlyFullPercent: 90 },
      BASE,
    );
    assert.deepEqual(ladderOf(allSame), [90, 91, 92]);
    // 贴底相等：从 1 开始排
    const allOne = normalizeSettings(
      { handoverPercent: 1, compactSoonPercent: 1, nearlyFullPercent: 1 },
      BASE,
    );
    assert.deepEqual(ladderOf(allOne), [1, 2, 3]);
    // 只有两档相等
    const pair = normalizeSettings(
      { handoverPercent: 80, compactSoonPercent: 80, nearlyFullPercent: 90 },
      BASE,
    );
    assert.deepEqual(ladderOf(pair), [80, 81, 90]);
    // 乱序 + 越界 + 0 混在一起也要收敛（0 的档保持 0，大于 0 的仍递增）
    for (const input of [
      { handoverPercent: 100, compactSoonPercent: 100, nearlyFullPercent: 100 },
      { handoverPercent: 99, compactSoonPercent: 100, nearlyFullPercent: 100 },
      { handoverPercent: 0, compactSoonPercent: 100, nearlyFullPercent: 0 },
      { handoverPercent: 75, compactSoonPercent: 75, nearlyFullPercent: 75 },
      { handoverPercent: 0, compactSoonPercent: 30, nearlyFullPercent: 30 },
      { handoverPercent: 1, compactSoonPercent: 0, nearlyFullPercent: 1 },
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

  test('三个勾：默认 true，非布尔回落 base，真布尔照收', () => {
    for (const key of CHECK_KEYS) {
      // 出厂默认 true
      assert.equal(DEFAULT_SETTINGS[key], true, `${key} 出厂默认应为 true`);
      // 输入里是合法布尔就用输入（两个方向都要能分开）
      assert.equal(normalizeSettings({ [key]: true }, BASE)[key], true, `${key}=true 应保留`);
      assert.equal(
        normalizeSettings({ [key]: false }, { ...BASE, [key]: true })[key],
        false,
        `${key}=false 应保留`,
      );
      // 非布尔一律回落 base（BASE 里是 false，能证明不是回落到默认 true）
      for (const bad of ['true', 'false', 1, 0, null, undefined, {}, [], Number.NaN]) {
        assert.equal(
          normalizeSettings({ [key]: bad }, BASE)[key],
          BASE[key],
          `${key}=${String(bad)} 应该回落 base`,
        );
      }
      // base 也没有合法布尔时回落到出厂默认 true
      assert.equal(normalizeSettings({ [key]: 'yes' }, {})[key], true, `${key} 应回落默认 true`);
      // 只动自己那一项：另外两个勾、读数、四档百分比都不受牵连
      const allOn = { ...BASE, ...Object.fromEntries(CHECK_KEYS.map((k) => [k, true])) };
      const out = normalizeSettings({ [key]: false }, allOn);
      assert.equal(out[key], false);
      for (const other of CHECK_KEYS) {
        if (other !== key) assert.equal(out[other], true, `${key} 关掉不该影响 ${other}`);
      }
      assert.equal(out.injectPerTurn, true);
      assert.equal(out.ledgerPercent, allOn.ledgerPercent);
      assert.deepEqual(ladderOf(out), ladderOf(normalizeSettings({}, allOn)));
    }
  });

  test('handoverTemplateEnabled 单独验：非布尔回落（改名自 templateEnabled）', () => {
    // 典型手改：字符串 "false" / 数字 0 / null 都不算关，回落 base（BASE 里是 false）
    for (const bad of ['false', '0', 0, 1, null, undefined, NaN]) {
      assert.equal(
        normalizeSettings({ handoverTemplateEnabled: bad }, BASE).handoverTemplateEnabled,
        BASE.handoverTemplateEnabled,
        `handoverTemplateEnabled=${String(bad)} 应回落 base`,
      );
    }
    // 真布尔两个方向都认
    assert.equal(normalizeSettings({ handoverTemplateEnabled: true }, BASE).handoverTemplateEnabled, true);
    assert.equal(
      normalizeSettings({ handoverTemplateEnabled: false }, { ...BASE, handoverTemplateEnabled: true })
        .handoverTemplateEnabled,
      false,
    );
    // base 也没有合法值时回落出厂默认 true
    assert.equal(
      normalizeSettings({ handoverTemplateEnabled: 'no' }, {}).handoverTemplateEnabled,
      true,
    );
  });

  test('ledgerPercent：0 合法、越界钳制、不参与三档递增、独立触发', () => {
    // 0 合法：关闭这一档，不能被钳成 1
    assert.equal(normalizeSettings({ ledgerPercent: 0 }, BASE).ledgerPercent, 0);
    // 越界钳制到 0–100；小数四舍五入
    assert.equal(normalizeSettings({ ledgerPercent: -30 }, BASE).ledgerPercent, 0);
    assert.equal(normalizeSettings({ ledgerPercent: 250 }, BASE).ledgerPercent, 100);
    assert.equal(normalizeSettings({ ledgerPercent: 70.6 }, BASE).ledgerPercent, 71);
    // 非数字回落 base
    for (const bad of ['70', null, undefined, Number.NaN, {}, []]) {
      assert.equal(
        normalizeSettings({ ledgerPercent: bad }, BASE).ledgerPercent,
        BASE.ledgerPercent,
        `ledgerPercent=${String(bad)} 应回落 base`,
      );
    }
    // 独立触发：可以等于别的档、可以在交接之前、也可以在交接与折叠之间，
    // 都不会被三档的排序 / 撑开逻辑改动，也不会去改动三档
    const cases = [
      [{ handoverPercent: 50, compactSoonPercent: 75, nearlyFullPercent: 90, ledgerPercent: 50 }, 50],
      [{ handoverPercent: 50, compactSoonPercent: 75, nearlyFullPercent: 90, ledgerPercent: 10 }, 10],
      [{ handoverPercent: 50, compactSoonPercent: 75, nearlyFullPercent: 90, ledgerPercent: 70 }, 70],
      [{ handoverPercent: 50, compactSoonPercent: 75, nearlyFullPercent: 90, ledgerPercent: 75 }, 75],
    ];
    for (const [input, expected] of cases) {
      const out = normalizeSettings(input, BASE);
      assert.equal(out.ledgerPercent, expected, `${JSON.stringify(input)} 的 ledgerPercent 应原样保留`);
      assert.deepEqual(ladderOf(out), [50, 75, 90], '三档不该被 ledgerPercent 牵动');
    }
    // 三档全关时写长期记忆照样能开（它不挂在交接档上）
    const onlyLedger = normalizeSettings(
      { handoverPercent: 0, compactSoonPercent: 0, nearlyFullPercent: 0, ledgerPercent: 70 },
      BASE,
    );
    assert.deepEqual(ladderOf(onlyLedger), [0, 0, 0]);
    assert.equal(onlyLedger.ledgerPercent, 70);
    // 反过来：ledgerPercent 怎么改都不动三档
    assert.deepEqual(ladderOf(normalizeSettings({ ledgerPercent: 0 }, BASE)), [40, 65, 85]);
  });

  test('四个档各自关闭互不影响', () => {
    const allOn = {
      ...BASE,
      handoverPercent: 50,
      compactSoonPercent: 75,
      nearlyFullPercent: 90,
      ledgerPercent: 50,
      handoverTemplateEnabled: true,
      compactSoonEnabled: true,
      nearlyFullEnabled: true,
    };
    const baseline = normalizeSettings({}, allOn);
    // 每次只动一项：只有它自己变，其余三项（含读数、时钟、换新）原样
    const cases = [
      [{ handoverPercent: 0 }, 'handoverPercent'],
      [{ compactSoonEnabled: false }, 'compactSoonEnabled'],
      [{ nearlyFullEnabled: false }, 'nearlyFullEnabled'],
      [{ ledgerPercent: 0 }, 'ledgerPercent'],
    ];
    for (const [patch, key] of cases) {
      const out = normalizeSettings(patch, allOn);
      assert.notEqual(out[key], baseline[key], `${key} 应该真的变了`);
      for (const other of Object.keys(baseline)) {
        if (other === key) continue;
        assert.deepEqual(out[other], baseline[other], `${key} 改动不该影响 ${other}`);
      }
      assert.equal(out.injectPerTurn, true);
      assert.equal(out.clockIntervalHours, baseline.clockIntervalHours);
      assert.equal(out.rotateReminderWeekday, baseline.rotateReminderWeekday);
    }
  });

  test('旧键 templateEnabled / ledgerReminderEnabled / handoverEnabled 被静默忽略', () => {
    const out = normalizeSettings(
      {
        // 2.4.0 的旧键（templateEnabled 已改名，ledgerReminderEnabled 被 ledgerPercent 取代）
        templateEnabled: false,
        ledgerReminderEnabled: false,
        // 更老的旧开关
        handoverEnabled: false,
        handoverPercent: 50,
      },
      BASE,
    );
    for (const gone of REMOVED_KEYS) {
      assert.equal(gone in out, false, `${gone} 不该出现在规整结果里`);
      assert.equal(out[gone], undefined);
    }
    // 旧键的 false 不会顺手把新键关掉：三个勾按 base 回落，四档按 base / 输入走
    assert.equal(out.handoverTemplateEnabled, BASE.handoverTemplateEnabled);
    assert.equal(out.compactSoonEnabled, BASE.compactSoonEnabled);
    assert.equal(out.nearlyFullEnabled, BASE.nearlyFullEnabled);
    assert.equal(out.ledgerPercent, BASE.ledgerPercent);
    // 三档本身也不受旧开关影响：交接 50 照收，另外两档回落 base 的 65 / 85
    assert.deepEqual(ladderOf(out), [50, 65, 85]);
    // 只显式传 0 才关档
    const withZero = normalizeSettings({ handoverEnabled: false, handoverPercent: 0 }, BASE);
    assert.deepEqual(ladderOf(withZero), [0, 65, 85]);
    // 老设置文件（2.4.0 写的）里残留这两个键也能直接读回来：不报错、不回到结果里
    const legacyFile = join(workDir, 'legacy-2.4.json');
    writeFileSync(
      legacyFile,
      JSON.stringify({
        templateEnabled: false,
        ledgerReminderEnabled: false,
        handoverPercent: 55,
      }),
      'utf8',
    );
    const legacy = readSettings(legacyFile, BASE);
    assert.equal(legacy.handoverPercent, 55);
    assert.equal('templateEnabled' in legacy, false);
    assert.equal('ledgerReminderEnabled' in legacy, false);
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
    assert.deepEqual(ladderOf(out), [20, 60, 85]);
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
      handoverPercent: 0,
      handoverTemplateEnabled: false,
      compactSoonPercent: 60,
      compactSoonEnabled: false,
      nearlyFullPercent: 90,
      nearlyFullEnabled: true,
      ledgerPercent: 0,
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
      handoverTemplateEnabled: DEFAULT_SETTINGS.handoverTemplateEnabled,
      compactSoonPercent: 80,
      compactSoonEnabled: DEFAULT_SETTINGS.compactSoonEnabled,
      nearlyFullPercent: DEFAULT_SETTINGS.nearlyFullPercent,
      nearlyFullEnabled: DEFAULT_SETTINGS.nearlyFullEnabled,
      ledgerPercent: DEFAULT_SETTINGS.ledgerPercent,
      rotateReminderMode: DEFAULT_SETTINGS.rotateReminderMode,
      rotateReminderDays: 365,
      rotateReminderWeekday: DEFAULT_SETTINGS.rotateReminderWeekday,
      rotateReminderDayOfMonth: DEFAULT_SETTINGS.rotateReminderDayOfMonth,
      timeZone: DEFAULT_SETTINGS.timeZone,
    });
  });

  test('读文件时 0 被保留（不会被当成没填）', () => {
    const file = join(workDir, 'zero.json');
    writeFileSync(
      file,
      JSON.stringify({
        handoverPercent: 0,
        compactSoonPercent: 0,
        nearlyFullPercent: 0,
        ledgerPercent: 0,
      }),
      'utf8',
    );
    const loaded = readSettings(file, BASE);
    assert.deepEqual(ladderOf(loaded), [0, 0, 0]);
    assert.equal(loaded.ledgerPercent, 0, '写长期记忆的 0 也要原样保留');
    assert.equal(loaded.clockFile, BASE.clockFile, '其它项仍按 base 兜底');
  });
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

console.log(`PASS ${passed}`);
