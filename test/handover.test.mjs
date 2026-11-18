/**
 * lib/handover.js 的普通 node 测试脚本。
 *
 * 跑法：`node test/handover.test.mjs`
 * 不需要测试框架，也不需要装 @deepseek-ai 依赖；全部通过时最后一行为 `PASS <用例数>`。
 *
 * 日期一律用**本地时区**构造（`new Date(2026, 10, 18)`），所以不管机器在哪个时区，
 * 期望值都是 2026-11-18，测试不会因时区而飘。
 */
import assert from 'node:assert/strict';

import { dateKey, renderTemplate, templateFileName } from '../lib/handover.js';

/** 本地时间 2026-11-18 深夜：证明取的是本地日期，不是 UTC 日期。 */
const LOCAL_DAY = new Date(2026, 10, 18, 23, 30, 0);

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

/** 文件名里不允许出现的 Windows 保留字符（含路径分隔符与通配符）。 */
function assertLegalFileName(name) {
  assert.equal(typeof name, 'string');
  assert.ok(name.length > 0, '文件名不能为空');
  assert.ok(!/[<>:"/\\|?*\u0000-\u001f]/.test(name), `文件名含非法字符：${name}`);
  assert.ok(!/[. ]$/.test(name), `文件名不能以点或空格结尾：${name}`);
}

test('文件名格式：交接-日期-会话后8位.md（Date 用本地日期）', () => {
  assert.equal(templateFileName(LOCAL_DAY, 'session-ca1a4b99'), '交接-2026-11-18-ca1a4b99.md');
  // Date 与 yyyy-mm-dd 字符串给出同一个文件名
  assert.equal(templateFileName('2026-11-18', 'session-ca1a4b99'), '交接-2026-11-18-ca1a4b99.md');
  assert.equal(dateKey(LOCAL_DAY), '2026-11-18');
  assert.equal(dateKey('2026-01-02'), '2026-01-02');
  assertLegalFileName(templateFileName(LOCAL_DAY, 'session-ca1a4b99'));
});

test('后 8 位截取：长 id 只留尾巴，短 id 全用', () => {
  assert.equal(templateFileName('2026-11-18', '0123456789abcdef'), '交接-2026-11-18-89abcdef.md');
  // 洗过之后正好 8 位：session_ca1a4b99 的尾巴就是 ca1a4b99
  assert.equal(templateFileName('2026-11-18', 'session-ca1a4b99'), '交接-2026-11-18-ca1a4b99.md');
  assert.equal(templateFileName('2026-11-18', 'ab12'), '交接-2026-11-18-ab12.md');
});

test('非法字符被替换成下划线，文件名仍合法', () => {
  const name = templateFileName('2026-11-18', 'session:ab/cd*ef');
  assert.equal(name, '交接-2026-11-18-ab_cd_ef.md');
  assertLegalFileName(name);
  // 尖括号、竖线、问号这些也都洗掉
  assertLegalFileName(templateFileName('2026-11-18', 'a<b>c|d?e"f\\g'));
  // 全是非法字符 / 空 id 也不能拼出空尾巴
  assert.equal(templateFileName('2026-11-18', ':: --'), '交接-2026-11-18-unknown.md');
  assert.equal(templateFileName('2026-11-18', ''), '交接-2026-11-18-unknown.md');
  assert.equal(templateFileName('2026-11-18', null), '交接-2026-11-18-unknown.md');
});

test('坏日期退回今天，不抛错', () => {
  const today = new Date();
  const expected = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
    today.getDate(),
  ).padStart(2, '0')}`;
  assert.equal(dateKey('not-a-date'), expected);
  assert.equal(dateKey(new Date('nope')), expected);
  assert.equal(dateKey(null), expected);
});

test('模板包含五个小标题，日期与前置短 id 都写进标题', () => {
  const body = renderTemplate(LOCAL_DAY, 'ca1a4b99-dead-beef-0000');
  for (const heading of [
    '## 一、本场做了什么',
    '## 二、下一场必须知道的',
    '## 三、没做完的',
    '## 四、要落账的条目',
    '## 五、这次有没有改热记忆',
  ]) {
    assert.ok(body.includes(heading), `模板缺少小标题：${heading}`);
  }
  // 标题：日期 + 会话前 8 位
  assert.ok(body.startsWith('# 交接 · 2026-11-18（会话 ca1a4b99）\n'), body.split('\n')[0]);
  // 开头那句说明还在，第四段的「已落账」提示还在
  assert.ok(body.includes('> 到交接水位时自动生成。填完把第四段处理掉，其余部分下次开工先读。'));
  assert.ok(body.includes('写完在这里标「已落账」'));
  // 第五段写的是热记忆，不是别的
  assert.ok(body.includes('（有则写改了什么、什么时候；没有就写「没有」）'));
});

test('DSH 真实形态的 id：标题摘掉 session- 前缀再取前 8 位', () => {
  const realId = 'session-3df4e987-ca1a-4b99-a83f-1c5caa7d42cf';
  assert.equal(templateFileName('2026-11-18', realId), '交接-2026-11-18-aa7d42cf.md');
  assert.ok(
    renderTemplate('2026-11-18', realId).startsWith('# 交接 · 2026-11-18（会话 3df4e987）\n'),
    renderTemplate('2026-11-18', realId).split('\n')[0],
  );
  // 没有该前缀就是字面前 8 位（例如 uuid 形态）
  assert.ok(
    renderTemplate('2026-11-18', 'ca1a4b99-dead-beef-0000').startsWith(
      '# 交接 · 2026-11-18（会话 ca1a4b99）',
    ),
  );
  // 光一个前缀、没有后半段时不能拼出空标题
  assert.ok(renderTemplate('2026-11-18', 'session-').startsWith('# 交接 · 2026-11-18（会话 session_）'));
  assertLegalFileName(templateFileName('2026-11-18', 'session-'));
});

test('模板以换行结尾、按日期与 id 变化', () => {
  const body = renderTemplate('2026-01-02', 'abcdefgh-1234');
  assert.ok(body.endsWith('\n'));
  assert.ok(body.includes('# 交接 · 2026-01-02（会话 abcdefgh）'));
  // 同一份输入永远同一份正文（纯函数）
  assert.equal(body, renderTemplate('2026-01-02', 'abcdefgh-1234'));
  assert.notEqual(body, renderTemplate('2026-01-03', 'abcdefgh-1234'));
});

console.log(`PASS ${passed}`);
