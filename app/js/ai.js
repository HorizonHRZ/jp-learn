/**
 * ai.js —— 浏览器侧的 AI 接入层。
 *
 * ⚠️ 三条必须守住的规矩（都有测试盯着，见 `tools/test-ai.mjs` 与 `test-render.mjs`）：
 *
 *   1. **密钥绝不进浏览器存储**。它由服务端读写 `config.local.json`，
 *      浏览器只拿得到遮罩后的提示（`sk-a••••wxyz`）。
 *      所以这里**没有任何 dbPut/dbSet 写 apiKey 的代码**，
 *      也因此密钥不可能出现在「导出备份 / 快照 / 任何导出文件」里。
 *   2. **默认关闭**。用户不在设置里主动打开，`/api/ai/chat` 一律 403。
 *   3. **首次发送前必须让用户明确知道"发出去的是什么"**。
 *      这件事记在本地（`settings` 表的一个标记），只需确认一次；
 *      但"只发选中文本"这个事实在每次发送的界面上都重复说明。
 *
 * 为什么密钥不经浏览器：一旦经过浏览器，它就会出现在
 * localStorage / 页面内存 / 可能的导出里，泄漏面立刻变大。
 * 放服务端只多一层本地进程间调用，代价很小。
 */
import * as db from './db.js';

const API_BASE = '';

/** 首次使用确认标记的键名（存在 settings 表里，跟着备份一起走） */
export const ACK_KEY = 'aiNoticeAck';

/**
 * 给用户看的隐私说明（**兜底副本**）。
 *
 * 真正的"单一来源"在 `tools/aiconf.js`，由服务端通过 `GET /api/ai/config`
 * 的 `privacy` 字段发下来 —— 和"服务商预设"走的是同一套办法：
 * **服务端定义、浏览器取用、本地留一份兜底**。
 *
 * ⚠️ 为什么不直接 `import` 那个文件：`tools/` 不在服务端的 `SAFE_ROOTS`
 *    （`app/` 和 `data/` 才是），浏览器根本取不到 `/tools/aiconf.js`（403）。
 *    所以浏览器侧只能有一份自己读得到的副本。
 *    这份副本是否和真正的那份一致，由 `tools/test-render.mjs` 断言。
 *
 * ⚠️⚠️ 这份文字**必须和实际行为一致**，改行为就得改这里 + aiconf.js。
 *    真实发生过一次：原文写「只有你选中的那段文字会被发送」，
 *    后来加了"按段落自动翻译"，一按按钮就会把每一段正文都发出去 ——
 *    那句话当场变成假话。所以现在按"两种触发方式"分别说清楚。
 *
 * 内容是**纯文本**（用 `textContent` 渲染，不解析 Markdown），
 * 所以里面不能出现 `**加粗**` 这类标记 —— 界面上会原样露出星号。
 */
export const AI_PRIVACY_TEXT = [
  '这个功能默认关闭。关掉之后，程序不会连接任何外部服务。',
  '你点「AI 讲这个词 / 讲这句」时，只把你点的那一小段发给 AI。',
  '你点「自动翻译全部段落」时，会把每一段的日文正文依次发给你填的 AI 地址。',
  '生词本、学习进度、复习记录、笔记标题都不会被发送；整本书也不会一次性发出去。',
  '你填的 API 密钥保存在本机项目目录的 config.local.json 里（明文，这是你选的方案），不会发给浏览器。',
];

/** 各家服务商的预设由服务端提供（单一来源），这里只做兜底 */
export const FALLBACK_PRESETS = [
  { id: 'deepseek', label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'openai', label: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'ollama', label: '本机 Ollama（不联网）', baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
  { id: 'custom', label: '其他（自己填地址）', baseURL: '', model: '' },
];

async function req(path, opts = {}) {
  const resp = await fetch(API_BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  let body = null;
  try { body = await resp.json(); } catch { /* 下面统一处理 */ }
  if (!resp.ok || !body || body.ok === false) {
    const msg = (body && body.error) || `请求失败（HTTP ${resp.status}）`;
    const err = new Error(msg);
    err.code = body && body.code;
    err.status = resp.status;
    throw err;
  }
  return body;
}

/** 读配置（含遮罩后的密钥提示）。永远拿不到密钥原文 —— 服务端就不会给。 */
export async function getAiConfig() {
  return req('/api/ai/config', { method: 'GET' });
}

/**
 * 保存配置。
 *
 * 注意 `apiKey` 的处理：只有**用户真的输入了新密钥**时才带上这个字段。
 * 否则（比如只改了模型名）传空字符串会把已有密钥清掉 —— 那是个很容易踩的坑，
 * 界面上显示的是遮罩串，用户不可能把它原样提交回来。
 */
export async function saveAiConfig(patch) {
  const body = { ...patch };
  if (body.apiKey === undefined) delete body.apiKey;
  return req('/api/ai/config', { method: 'POST', body: JSON.stringify(body) });
}

/**
 * 发一条请求给 AI。
 *
 * ⚠️ 这里**只把 text 和可选的 context 发出去**，不附带任何别的数据。
 *    调用方也没有地方能塞进别的东西 —— 这是对用户的承诺的代码化。
 */
export async function askAi({ task, text, context = '', history = [] }) {
  return req('/api/ai/chat', {
    method: 'POST',
    body: JSON.stringify({ task, text, context, history }),
  });
}

/** 连通性自检：随便发一句最短的话，看能不能通。 */
export async function testAiConnection() {
  return askAi({ task: 'custom', text: '请回答"通"这一个字。' });
}

/** 读"首次使用确认"标记 */
export async function getAck() {
  try {
    const rec = await db.dbGet('settings', ACK_KEY);
    return !!(rec && rec.value);
  } catch {
    return false;
  }
}

/** 写"首次使用确认"标记 */
export async function setAck(v) {
  await db.dbPut('settings', { key: ACK_KEY, value: !!v, at: Date.now() });
}

/**
 * 首次发送前的确认。
 *
 * 为什么用"确认一次就够了"而不是每次都弹：
 *   每次都弹会让人闭眼点掉，反而失去提醒效果。
 *   但**界面上每次发送都写着"只发送选中文本"**，长期可见。
 *
 * @param {(texts:string[]) => Promise<boolean>} confirmFn  由调用方注入
 *   （这样 ai.js 不必依赖 ui.js 的对话框实现，也就更好测）
 */
/**
 * 取隐私说明的**权威版本**（服务端下发的）。
 *
 * 服务端拿不到（老版本服务端、或请求失败）就退回本地那份常量。
 * 这样"设置页显示的文字"和"首次确认框里的文字"始终是同一份。
 */
export async function getPrivacyText() {
  try {
    const r = await getAiConfig();
    const list = r && r.privacy;
    if (Array.isArray(list) && list.length) return list;
  } catch { /* 用兜底副本 */ }
  return AI_PRIVACY_TEXT;
}

/**
 * 首次使用前的一次性确认。
 *
 * ⚠️ 说明文字要**现取**（getPrivacyText），不用模块里那份常量 ——
 *    否则服务端改了文案，用户看到的确认框还是旧的。
 */
export async function ensureAck(confirmFn) {
  if (await getAck()) return true;
  const agreed = await confirmFn(await getPrivacyText());
  if (agreed) await setAck(true);
  return agreed;
}
