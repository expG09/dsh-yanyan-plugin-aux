/**
 * QQ 群会话绑定：解析、列出、换新。
 *
 * 这个文件是纯 ESM，**不 import 任何 @deepseek-ai 包** —— 宿主（index.js）和
 * `node test/bindings.test.mjs` 都能直接加载，测试也不需要装依赖。
 *
 * 绑定的真身在 `%USERPROFILE%\.dsh-qqbot\model-prefs.json`：qqbot 把每个
 * sessionKey（`qqbot:<appId>:<kind>:<peerId>`）对应的会话 id 记在 `sessionIds`
 * 子对象里，形如
 *
 *     { "sessionIds": { "qqbot:...:group:...": "session-<uuid>" },
 *       "overrides": { ... }, "presets": { ... } }
 *
 * 这里只碰 `sessionIds` 里那一条；其他所有键（含以后 qqbot 新增的）原样带过去，
 * 也兼容“直接把 qqbot: 键放在顶层”的旧/实验格式。
 *
 * 注意：这里只做内存里的纯计算，读写文件、备份、原子落盘由宿主 index.js 负责。
 */
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** qqbot 的 sessionKey 前缀，换新只认这个前缀。 */
const SESSION_KEY_PREFIX = 'qqbot:';
/** 新会话 id 的固定前缀，后面跟一个 UUID。 */
const SESSION_ID_PREFIX = 'session-';

/** 只认普通对象；数组、null、别的类型都不算 prefs。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 拆 sessionKey：`qqbot:<appId>:<kind>:<peerId>` → `{ appId, kind, peerId }`。
 *
 * - 不以 `qqbot:` 开头、段数不够、appId / kind / peerId 有空段，一律返回 null；
 * - peerId 里若再出现冒号，后面的段拼回 peerId（QQ 的 openid 目前不含冒号，
 *   这里宽进，避免以后格式变化时误判）。
 */
export function parseSessionKey(key) {
  if (typeof key !== 'string') return null;
  if (!key.startsWith(SESSION_KEY_PREFIX)) return null;

  const parts = key.slice(SESSION_KEY_PREFIX.length).split(':');
  if (parts.length < 3) return null;

  const [appId, kind] = parts;
  const peerId = parts.slice(2).join(':');
  if (appId === '' || kind === '' || peerId === '') return null;

  return { appId, kind, peerId };
}

/**
 * 从整个 prefs 对象里挑出 QQ 绑定，按 sessionKey 升序返回。
 *
 * 返回 `[{ sessionKey, appId, kind, peerId, sessionId }]`；sessionId 不是非空
 * 字符串的条目直接跳过（坏数据不展示）。入参不是对象时返回空数组。
 */
export function listBindings(prefsObject) {
  const found = [];
  if (!isPlainObject(prefsObject)) return found;

  const seen = new Set();
  const ids = prefsObject.sessionIds;

  // qqbot 的正规位置：sessionIds 子对象
  if (isPlainObject(ids)) {
    for (const [key, sessionId] of Object.entries(ids)) {
      const parsed = parseSessionKey(key);
      if (parsed === null || typeof sessionId !== 'string' || sessionId === '') continue;
      found.push({ sessionKey: key, ...parsed, sessionId });
      seen.add(key);
    }
  }

  // 兼容旧/实验格式：qqbot: 键直接放在顶层
  for (const [key, sessionId] of Object.entries(prefsObject)) {
    if (seen.has(key)) continue;
    const parsed = parseSessionKey(key);
    if (parsed === null || typeof sessionId !== 'string' || sessionId === '') continue;
    found.push({ sessionKey: key, ...parsed, sessionId });
  }

  // 按 sessionKey 的码位排序，不依赖 locale，测试结果稳定
  found.sort((a, b) => (a.sessionKey < b.sessionKey ? -1 : a.sessionKey > b.sessionKey ? 1 : 0));
  return found;
}

/**
 * 把某一条绑定的 sessionId 换成 newSessionId，返回**新对象**，不修改入参。
 *
 * - sessionKey 不是合法 QQ key，或执行完没找到这一条 → 返回 null；
 * - newSessionId 不是非空字符串 → 返回 null（交给调用方报 400/500）；
 * - `sessionIds` 里存在就替换 `sessionIds` 那一条（并复制子对象）；
 * - 顶层直接放着同名键时也一并替换，两个位置都保留原来的键序；
 * - 其余键、嵌套对象原样保留（浅拷贝共享引用，但绝不写入）。
 */
export function rotateBinding(prefsObject, sessionKey, newSessionId) {
  if (!isPlainObject(prefsObject)) return null;
  if (parseSessionKey(sessionKey) === null) return null;
  if (typeof newSessionId !== 'string' || newSessionId === '') return null;

  const out = { ...prefsObject };
  let found = false;

  const ids = prefsObject.sessionIds;
  if (isPlainObject(ids) && typeof ids[sessionKey] === 'string') {
    out.sessionIds = { ...ids, [sessionKey]: newSessionId };
    found = true;
  }

  if (typeof prefsObject[sessionKey] === 'string') {
    out[sessionKey] = newSessionId;
    found = true;
  }

  return found ? out : null;
}

/** 铸一个新会话 id：`session-<uuid>`（与 qqbot 自己 fork 出来的形状一致）。 */
export function mintSessionId() {
  return SESSION_ID_PREFIX + randomUUID();
}

/** qqbot 的绑定文件路径：`%USERPROFILE%\.dsh-qqbot\model-prefs.json`。 */
export function prefsPath() {
  return join(homedir(), '.dsh-qqbot', 'model-prefs.json');
}

/** 换新审计日志路径：`%USERPROFILE%\.dsh\aux-rotations.jsonl`。 */
export function rotationsPath() {
  return join(homedir(), '.dsh', 'aux-rotations.jsonl');
}
