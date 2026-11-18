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
  normalizeSettings,
  readSettings,
  writeSettings,
} from '../lib/settings.js';

/** 兜底基准：故意用与 DEFAULT_SETTINGS 不同的值，才能看出“回落到 base”而不是“回落到默认”。 */
const BASE = {
  clockFile: 'D:\\base\\clock.md',
  clockIntervalHours: 6,
  injectPerTurn: true,
  thresholds: [50, 70, 85],
  timeZone: 'Asia/Shanghai',
};

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const workDir = mkdtempSync(join(tmpdir(), 'aux-settings-test-'));

try {
  test('出厂默认值就是 patch 里那五项', () => {
    assert.deepEqual(DEFAULT_SETTINGS.clockFile, 'G:\\yanyan-workspace\\report-cache\\clock.md');
    assert.equal(DEFAULT_SETTINGS.clockIntervalHours, 6);
    assert.equal(DEFAULT_SETTINGS.injectPerTurn, true);
    assert.deepEqual([...DEFAULT_SETTINGS.thresholds], [50, 70]);
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

  test('阈值排序并去重', () => {
    assert.deepEqual(
      normalizeSettings({ thresholds: [85, 50, 50, 70, 85] }, BASE).thresholds,
      [50, 70, 85],
    );
  });

  test('越界阈值被钳制到 1–100', () => {
    assert.deepEqual(
      normalizeSettings({ thresholds: [0, 150, 2.6, 99.4] }, BASE).thresholds,
      [1, 3, 99, 100],
    );
    assert.deepEqual(normalizeSettings({ thresholds: [-5, 101] }, BASE).thresholds, [1, 100]);
  });

  test('空数组或全非法阈值回落到 base', () => {
    assert.deepEqual(normalizeSettings({ thresholds: [] }, BASE).thresholds, [50, 70, 85]);
    assert.deepEqual(normalizeSettings({ thresholds: ['x', null, {}] }, BASE).thresholds, [50, 70, 85]);
    assert.deepEqual(normalizeSettings({ thresholds: '50,70' }, BASE).thresholds, [50, 70, 85]);
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

  test('返回新对象且不修改入参', () => {
    const input = { clockIntervalHours: 8, thresholds: [90, 30], clockFile: '/a/clock.md' };
    const snapshot = { ...input, thresholds: [...input.thresholds] };
    const out = normalizeSettings(input, BASE);
    assert.notEqual(out, input);
    assert.notEqual(out.thresholds, input.thresholds);
    assert.deepEqual(input, snapshot);
    assert.deepEqual(out.thresholds, [30, 90]);
  });

  test('坏 JSON 返回 null', () => {
    const file = join(workDir, 'broken.json');
    writeFileSync(file, '{ 这不是 JSON', 'utf8');
    assert.equal(readSettings(file), null);
  });

  test('文件不存在返回 null', () => {
    assert.equal(readSettings(join(workDir, 'missing.json')), null);
    assert.equal(readSettings(join(workDir, 'no-such-dir', 'missing.json')), null);
  });

  test('写入后能读回，且末尾有换行、UTF-8 正常', () => {
    const file = join(workDir, 'roundtrip.json');
    const value = {
      clockFile: 'D:\\砚砚\\report-cache\\clock.md',
      clockIntervalHours: 12,
      injectPerTurn: false,
      thresholds: [30, 60, 90],
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
    writeFileSync(file, JSON.stringify({ thresholds: [90, 90, 0], clockIntervalHours: 999 }), 'utf8');
    assert.deepEqual(readSettings(file), {
      clockFile: DEFAULT_SETTINGS.clockFile,
      clockIntervalHours: DEFAULT_SETTINGS.clockIntervalHours,
      injectPerTurn: DEFAULT_SETTINGS.injectPerTurn,
      thresholds: [1, 90],
      timeZone: DEFAULT_SETTINGS.timeZone,
    });
  });
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

console.log(`PASS ${passed}`);
