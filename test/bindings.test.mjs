/**
 * lib/bindings.js 的普通 node 测试脚本。
 *
 * 跑法：`node test/bindings.test.mjs`
 * 不需要测试框架，也不装任何依赖；全部通过时最后一行为 `PASS <用例数>`。
 * 这个文件不写磁盘（路径函数只做拼接），所以不会在包目录里留下产物。
 */
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  listBindings,
  mintSessionId,
  parseSessionKey,
  prefsPath,
  rotateBinding,
  rotationsPath,
} from '../lib/bindings.js';

const GROUP_KEY = 'qqbot:102123456:group:ABCDEF0123456789';
const C2C_KEY = 'qqbot:102123456:c2c:9F8E7D6C5B4A3928';
const GROUP_KEY_2 = 'qqbot:102123456:group:ZZZZ000011112222';

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

test('sessionKey 正常解析出 appId / kind / peerId', () => {
  assert.deepEqual(parseSessionKey(GROUP_KEY), {
    appId: '102123456',
    kind: 'group',
    peerId: 'ABCDEF0123456789',
  });
  assert.deepEqual(parseSessionKey(C2C_KEY), {
    appId: '102123456',
    kind: 'c2c',
    peerId: '9F8E7D6C5B4A3928',
  });
  // peerId 里再出现冒号时整段拼回去，不丢信息
  assert.deepEqual(parseSessionKey('qqbot:1:group:a:b'), {
    appId: '1',
    kind: 'group',
    peerId: 'a:b',
  });
});

test('畸形 sessionKey 一律返回 null', () => {
  const bad = [
    '',
    'qqbot:',
    'qqbot:1',
    'qqbot:1:group',
    'qqbot::group:peer',
    'qqbot:1::peer',
    'qqbot:1:group:',
    'session-abc',
    'x:1:group:peer',
    'QQBOT:1:group:peer',
    null,
    undefined,
    42,
    {},
    [],
  ];
  for (const value of bad) {
    assert.equal(parseSessionKey(value), null, `应该解析失败：${String(value)}`);
  }
});

test('listBindings 只挑 qqbot 绑定并按 sessionKey 排序', () => {
  const prefs = {
    sessionIds: {
      [GROUP_KEY]: 'session-cccc',
      'not-a-session-key': 'session-dddd',
      [C2C_KEY]: 'session-bbbb',
      [GROUP_KEY_2]: 'session-aaaa',
      // 值不是字符串的坏数据跳过
      'qqbot:102123456:group:BROKEN': 123,
    },
    overrides: { [GROUP_KEY]: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
    presets: { [GROUP_KEY]: 'preset-1' },
  };

  const list = listBindings(prefs);
  // c2c 在 group 之前，group 内按 peerId 排
  assert.deepEqual(
    list.map((item) => item.sessionKey),
    [C2C_KEY, GROUP_KEY, GROUP_KEY_2],
  );
  assert.deepEqual(list[0], {
    sessionKey: C2C_KEY,
    appId: '102123456',
    kind: 'c2c',
    peerId: '9F8E7D6C5B4A3928',
    sessionId: 'session-bbbb',
  });
  assert.equal(list.length, 3);
});

test('listBindings 兼容顶层 qqbot: 键，且非对象返回空数组', () => {
  const flat = { [GROUP_KEY]: 'session-x', other: 'keep' };
  assert.deepEqual(listBindings(flat), [
    {
      sessionKey: GROUP_KEY,
      appId: '102123456',
      kind: 'group',
      peerId: 'ABCDEF0123456789',
      sessionId: 'session-x',
    },
  ]);
  assert.deepEqual(listBindings(null), []);
  assert.deepEqual(listBindings('nope'), []);
  assert.deepEqual(listBindings({ sessionIds: { [GROUP_KEY]: 'session-y' } }).length, 1);
});

test('rotateBinding 返回新对象、不改入参、保留其他键与结构', () => {
  const prefs = {
    sessionIds: { [GROUP_KEY]: 'session-old', [C2C_KEY]: 'session-p' },
    overrides: { [GROUP_KEY]: { provider: 'p', model: 'm' } },
    presets: { [GROUP_KEY]: 'preset-1' },
    extra: { nested: [1, 2, 3] },
  };
  const snapshot = structuredClone(prefs);

  const out = rotateBinding(prefs, GROUP_KEY, 'session-new');

  assert.notEqual(out, prefs, '必须返回新对象');
  assert.notEqual(out.sessionIds, prefs.sessionIds, 'sessionIds 也要是新对象');
  assert.deepEqual(prefs, snapshot, '入参不能被修改');
  assert.equal(out.sessionIds[GROUP_KEY], 'session-new');
  assert.equal(out.sessionIds[C2C_KEY], 'session-p', '别的绑定原样保留');
  assert.deepEqual(out.overrides, prefs.overrides);
  assert.deepEqual(out.presets, prefs.presets);
  assert.deepEqual(out.extra, prefs.extra);
  // 键序不因替换而改变
  assert.deepEqual(Object.keys(out.sessionIds), Object.keys(prefs.sessionIds));
});

test('rotateBinding 找不到 key 或参数不合法时返回 null', () => {
  const prefs = { sessionIds: { [GROUP_KEY]: 'session-old' } };
  assert.equal(rotateBinding(prefs, C2C_KEY, 'session-new'), null);
  assert.equal(rotateBinding(prefs, GROUP_KEY, ''), null);
  assert.equal(rotateBinding(prefs, GROUP_KEY, 123), null);
  assert.equal(rotateBinding(prefs, 'not-a-key', 'session-new'), null);
  assert.equal(rotateBinding(null, GROUP_KEY, 'session-new'), null);
  assert.equal(rotateBinding([], GROUP_KEY, 'session-new'), null);
});

test('rotateBinding 也能替换顶层 qqbot: 键', () => {
  const prefs = { [GROUP_KEY]: 'session-old', other: 'keep' };
  const snapshot = structuredClone(prefs);
  const out = rotateBinding(prefs, GROUP_KEY, 'session-new');
  assert.equal(out[GROUP_KEY], 'session-new');
  assert.equal(out.other, 'keep');
  assert.deepEqual(prefs, snapshot);
});

test('mintSessionId 有固定前缀且是合法的 session-uuid', () => {
  const id = mintSessionId();
  assert.ok(id.startsWith('session-'), '应以 session- 开头');
  assert.equal(id.length, 'session-'.length + 36, 'session- 后面应是 36 位 UUID');
  assert.match(id, /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('两次 mintSessionId 不同', () => {
  const ids = new Set(Array.from({ length: 64 }, () => mintSessionId()));
  assert.equal(ids.size, 64);
});

test('prefsPath / rotationsPath 落在用户目录下', () => {
  assert.equal(prefsPath(), join(homedir(), '.dsh-qqbot', 'model-prefs.json'));
  assert.equal(rotationsPath(), join(homedir(), '.dsh', 'aux-rotations.jsonl'));
});

console.log(`PASS ${passed}`);
