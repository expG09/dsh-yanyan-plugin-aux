/**
 * 交接文件：三档提醒共用同一份 Markdown 文件——交接档首次写模板，折叠档与
 * 用完档各**追加**一段更新块。（文件名规则 + 模板正文 + 更新块正文。）
 *
 * 这个文件只依赖 node 内建，**不 import 任何 @deepseek-ai 包**：插件是从工作区
 * junction 进 profile 的，裸 import 会按真实路径解析，加载阶段直接失败且不留明显报错。
 * 因此 `node test/handover.test.mjs` 也能直接加载它，不用起宿主、不用装依赖。
 *
 * 这里只放**纯**事：文件名怎么拼、模板正文长什么样、更新块长什么样。写盘交给 index.js ——
 * 那边才有 clockFile 目录和诊断日志，也负责把写失败吞掉。
 *
 * 口径（与 README / docs/DETAIL.md 保持一致）：
 *   - 文件名：`交接-<yyyy-MM-dd>-<会话 id 后 8 位>.md`，日期按**本地时区**取；
 *   - 标题：`# 交接 · <日期>（会话 <会话 id 前 8 位>）`。DSH 的 id 常以 `session-` 开头，
 *     直接取前 8 位会全是 `session_`，所以先摘掉这个公共前缀再取；
 *   - 会话 id 里的非字母数字字符一律换成 `_`，保证拼出来是合法文件名；
 *   - 三档写的是**同一个文件**：交接档首次写（已存在就不动），折叠 / 用完两档追加更新块；
 *     同一天同一场只该有一份交接，所以后两档是「更新」而不是「另起一份」。
 */

/** 只要「年-月-日」这种已经成型的字符串，原样返回，免得被 Date.parse 按 UTC 解释。 */
const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 会话 id 截出来最多这么多个字符（文件名用「后 8 位」，标题用「前 8 位」）。 */
const SHORT_ID_LEN = 8;

/**
 * DSH 的会话 id 常见形态是 `session-3df4e987-ca1a-...`：直接取「前 8 位」会得到
 * `session_`，所有会话的标题就一模一样了，失去「一眼认出是哪个会话」的意义。
 * 所以拼标题短 id 时先摘掉这个公共前缀，再取前 8 位；没有该前缀的 id 仍是字面前 8 位。
 */
const SESSION_PREFIX_RE = /^session[-_:]/i;

function pad2(value) {
  return String(value).padStart(2, '0');
}

/**
 * 把 Date / 毫秒 / ISO 字符串 / `yyyy-mm-dd` 统一成 `yyyy-MM-dd`。
 *
 * - `yyyy-mm-dd` 字符串原样返回（这是「日期」而不是「时刻」，不该再经时区换算）；
 * - Date 与毫秒值按**本地时区**取年月日；
 * - 不合法（空值、坏字符串、Invalid Date）一律退回「今天」，不抛错 ——
 *   交接模板是辅助产物，没有理由让一次坏参数打断注入。
 *
 * @param {Date|number|string} date
 * @returns {string} `yyyy-MM-dd`
 */
export function dateKey(date) {
  if (typeof date === 'string') {
    const trimmed = date.trim();
    if (DATE_KEY_RE.test(trimmed)) return trimmed;
  }

  let at = null;
  if (date instanceof Date) {
    at = date;
  } else if (typeof date === 'number' && Number.isFinite(date)) {
    at = new Date(date);
  } else if (typeof date === 'string' && date.trim() !== '') {
    const ms = Date.parse(date);
    if (Number.isFinite(ms)) at = new Date(ms);
  }
  if (at === null || !Number.isFinite(at.getTime())) at = new Date();

  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
}

/**
 * 会话 id 洗成只含 `[A-Za-z0-9_]` 的形式：其余字符（`-`、`:`、空格、`/` 之类）
 * 逐个换成 `_`。空值或洗完是空的，退回 `unknown`，保证文件名里总有东西。
 *
 * 换掉而不是删掉，是为了让 `session-ab:cd` 和 `sessionabcd` 不会撞成同一个文件名。
 */
function sanitizeSessionId(sessionId) {
  const clean = String(sessionId ?? '').replace(/[^A-Za-z0-9]/g, '_');
  return /^[A-Za-z0-9_]+$/.test(clean) && !/^_+$/.test(clean) ? clean : 'unknown';
}

/** 文件名里用的「会话 id 后 8 位」；不足 8 位就全用。 */
function sessionTail(sessionId) {
  const clean = sanitizeSessionId(sessionId);
  return clean.length > SHORT_ID_LEN ? clean.slice(-SHORT_ID_LEN) : clean;
}

/** 模板标题里用的「会话 id 前 8 位」：先摘 `session-` 公共前缀，不足 8 位就全用。 */
function sessionHead(sessionId) {
  const clean = sanitizeSessionId(sessionId);
  const withoutPrefix = clean.replace(SESSION_PREFIX_RE, '');
  return (withoutPrefix === '' ? clean : withoutPrefix).slice(0, SHORT_ID_LEN);
}

/**
 * 模板文件名：`交接-<yyyy-MM-dd>-<会话 id 后 8 位>.md`。
 *
 * 例：`templateFileName(new Date('2026-11-18T10:00:00+08:00'), 'session-ca1a4b99')`
 * → `交接-2026-11-18-ca1a4b99.md`。
 *
 * @param {Date|number|string} date 生成日期（Date / 毫秒 / ISO / `yyyy-mm-dd`）
 * @param {string} sessionId 会话 id
 * @returns {string} 纯文件名（不含目录）
 */
export function templateFileName(date, sessionId) {
  return `交接-${dateKey(date)}-${sessionTail(sessionId)}.md`;
}

/**
 * 交接模板正文（五段写死，不做成配置）。
 *
 * 为什么写死：模板是给人填的骨架，不是功能开关。配置化的下一步一定是「五个字段
 * 各自开关」，那只会让每一份交接长得不一样，下次开工还得先猜这份少了哪段。
 * 唯一会变的是日期和会话短 id，都放在标题里。
 *
 * @param {Date|number|string} date 生成日期
 * @param {string} sessionId 会话 id
 * @returns {string} Markdown 正文，末尾带一个换行
 */
export function renderTemplate(date, sessionId) {
  const day = dateKey(date);
  const head = sessionHead(sessionId);
  return `# 交接 · ${day}（会话 ${head}）

> 到交接水位时自动生成。填完把第四段处理掉，其余部分下次开工先读。

## 一、本场做了什么

（3–5 条，一句话一条）

## 二、下一场必须知道的

（路径、版本、坑、在哪找东西；写得让下一个我不用翻聊天记录）

## 三、没做完的

（带为什么没做，以及卡在哪）

## 四、要落账的条目

（每条形如：
编号 / 原话或来源 / 决策 / 代价 / 反例 / 被压掉的细节
写完在这里标「已落账」，定期整理时一眼看得出哪些还没归并）

## 五、这次有没有改热记忆

（有则写改了什么、什么时候；没有就写「没有」）
`;
}

/** 更新块标题里的百分数：取 0–100 的整数；坏参数按 0 处理，保证标题总能成型。 */
function updatePercent(percent) {
  const value = Number(percent);
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** 更新块里的时间：只认非空字符串，其它一律退回 `--:--`，免得拼出 `（undefined）` 这种东西。 */
function updateTimeText(timeText) {
  if (typeof timeText !== 'string') return '--:--';
  const text = timeText.trim();
  return text === '' ? '--:--' : text;
}

/**
 * 交接文件的**更新块**：折叠 / 用完两档到水位时追加到同一份交接文件末尾。
 *
 * 只留标题和一句空位，具体内容由助手填——插件不知道这一场做了什么，也不该假装知道。
 * `timeText` 由调用方按配置的时区算好（形如 `09:05`），这里只负责拼，保证可单测。
 *
 * @param {number} percent 触发这一块的档位百分比（70 / 90，或用户改过的值）
 * @param {string} timeText 触发时刻，`HH:mm`
 * @returns {string} Markdown 更新块，末尾带一个换行
 */
export function renderUpdateBlock(percent, timeText) {
  return `## 更新 · ${updatePercent(percent)}%（${updateTimeText(timeText)}）

（这一档的进展、新结论、状态变化，补在这里）
`;
}
