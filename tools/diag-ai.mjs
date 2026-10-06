/**
 * AI 连接诊断（**只读，不改配置、不改数据**）
 *
 * 用法：
 *   cd "D:\Deepseek Harness\DSH Workshop\jp-learn"
 *   node tools\diag-ai.mjs
 *
 * 什么时候用它：
 *   点了「测试连接」，弹出一句看不懂的报错（比如"回答被长度上限截断了"），
 *   但你不确定到底是密钥错了、还是模型选错了、还是程序的问题。
 *   这个脚本直接把**上游原样返回的东西**打出来，一看就知道。
 *
 * 它做什么：
 *   1. 只读 config.local.json，只打印地址/模型/token 上限，**不打印密钥**
 *   2. 模仿程序自己的调用方式，向你的 AI 服务真发一次请求
 *   3. 把上游返回的原始 JSON（去掉密钥）原样打印出来
 *
 * 它不做什么：
 *   不写任何文件、不改配置、不碰浏览器数据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = path.join(ROOT, 'config.local.json');

// 这些字段名里如果出现疑似密钥的字符串，打印时遮掉
const SECRETISH = /^(apiKey|key|token|secret|authorization)$/i;

function maskSecrets(obj, key = '') {
  if (SECRETISH.test(key)) return '***已遮掉***';
  if (Array.isArray(obj)) return obj.map((v) => maskSecrets(v));
  if (obj && typeof obj === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(obj)) o[k] = maskSecrets(v, k);
    return o;
  }
  return obj;
}

console.log('='.repeat(74));
console.log(' AI 连接诊断（只读，不改任何东西）');
console.log('='.repeat(74));

// ---------------------------------------------------------------- 读配置
if (!fs.existsSync(CFG)) {
  console.log('\n✗ 找不到 config.local.json');
  console.log('  说明：你还没在设置页保存过 AI 配置。');
  console.log('  去「设置 → AI 翻译 / 讲解」填好服务地址和密钥，点保存，再跑一次这个脚本。');
  process.exit(1);
}

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
} catch (e) {
  console.log('\n✗ config.local.json 不是合法 JSON：', e.message);
  console.log('  多半是手工编辑时括号/引号出错了。');
  process.exit(1);
}

console.log('\n[1] 你的配置（密钥不显示）');
console.log('  enabled   :', cfg.enabled);
console.log('  baseURL   :', cfg.baseURL || '（空）');
console.log('  model     :', cfg.model || '（空）');
console.log('  maxTokens :', cfg.maxTokens);
console.log('  temperature:', cfg.temperature);
console.log('  timeoutMs :', cfg.timeoutMs);
console.log('  apiKey    :', cfg.apiKey
  ? `已设置，${cfg.apiKey.length} 个字符，开头是 ${cfg.apiKey.slice(0, 3)}…`
  : '（空）—— 没填密钥，一定连不上');

if (!cfg.enabled) {
  console.log('\n⚠️ enabled = false，AI 功能是关着的。');
  console.log('   程序会拒绝发送。要测的话先在设置页勾上"启用"。');
}
if (!cfg.apiKey) {
  console.log('\n✗ 没有密钥，不用往下测了。去设置页填密钥。');
  process.exit(1);
}

// ---------------------------------------------------------------- 算地址
// 和 tools/aiconf.js 的 chatEndpoint 同一套规则：保证测的就是程序会用的地址
function chatEndpoint(base) {
  const b = String(base || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  if (/\/chat\/completions$/.test(b)) return b;
  if (/\/v\d+$/.test(b)) return `${b}/chat/completions`;
  return `${b}/v1/chat/completions`;
}
const url = chatEndpoint(cfg.baseURL);
console.log('\n[2] 将要请求的地址');
console.log('  ', url || '（算不出来，baseURL 是空的）');
if (!url) process.exit(1);

// ---------------------------------------------------------------- 发请求
const MAX = Number(cfg.maxTokens) || 1200;
const prompt = '请回答「通」这一个字。';

async function attempt(label, maxTokens) {
  console.log(`\n[${label}] max_tokens = ${maxTokens}`);
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: '你是一个日语学习助手。' },
      { role: 'user', content: prompt },
    ],
    temperature: Number(cfg.temperature) || 0.3,
    max_tokens: maxTokens,
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(15000, Number(cfg.timeoutMs) || 60000));

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    console.log('  ✗ 连不上。');
    // Node 的网络错误真实信息在 err.cause 里，外层只会说 "fetch failed"
    const chain = [];
    let cur = e;
    for (let i = 0; i < 5 && cur; i++) {
      chain.push(`${cur.name || '?'}: ${cur.message || ''}${cur.code ? ` (${cur.code})` : ''}`);
      cur = cur.cause;
    }
    chain.forEach((c) => console.log('    ', c));
    console.log('  可能原因：地址写错 / 没有网络 / 该服务在你的网络下需要代理。');
    return null;
  }
  clearTimeout(timer);

  const text = await resp.text();
  console.log('  HTTP 状态:', resp.status, resp.statusText || '');

  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }

  if (!json) {
    console.log('  ✗ 返回的不是 JSON，前 400 字符：');
    console.log('  ', text.slice(0, 400));
    return null;
  }

  // ---- 关键：把上游到底给了什么打出来 ----
  const ch = Array.isArray(json.choices) ? json.choices[0] : null;
  console.log('  返回体顶层字段:', Object.keys(json).join(', ') || '（空对象）');
  if (json.model) console.log('  上游实际用的 model:', json.model);
  if (json.error) console.log('  上游 error:', JSON.stringify(maskSecrets(json.error)));

  if (!ch) {
    console.log('  ✗ 没有 choices 字段 —— 这不是标准的 OpenAI 兼容响应。');
    console.log('  完整返回（密钥已遮）:');
    console.log('  ', JSON.stringify(maskSecrets(json)).slice(0, 800));
    return null;
  }

  const msg = ch.message || {};
  console.log('  choices[0] 的字段:', Object.keys(ch).join(', '));
  console.log('  message 的字段  :', Object.keys(msg).join(', ') || '（空）');
  console.log('  finish_reason   :', JSON.stringify(ch.finish_reason));
  if (json.usage) console.log('  usage           :', JSON.stringify(json.usage));

  const content = typeof msg.content === 'string' ? msg.content : '';
  const reasoning = msg.reasoning_content || msg.reasoning || '';
  console.log('  content 长度    :', content.length);
  if (reasoning) console.log('  reasoning 长度  :', String(reasoning).length);

  if (content.trim()) {
    console.log('\n  ✓ 成功！回答内容：', JSON.stringify(content.slice(0, 120)));
    if (ch.finish_reason === 'length') {
      console.log('  ⚠️ 但 finish_reason 是 length：这次回答被上限切断了。');
    }
    return { ok: true, content };
  }

  // content 是空的 —— 逐种可能说清楚
  console.log('\n  ✗ content 是空的。');
  if (reasoning) {
    console.log('  ⚠️ 但 reasoning_content 有内容（' + String(reasoning).length + ' 字符）。');
    console.log('     这几乎可以确定：**你的 model 是"推理模型"**（比如 deepseek-reasoner、');
    console.log('     o1/o3 系列等）。这类模型把思考过程放在 reasoning_content，');
    console.log('     最终答案才放 content。');
    console.log('     如果 max_tokens 太小，思考还没结束就被切断，content 就会是空的。');
    console.log('     → 解决办法（二选一）：');
    console.log('       ① 把「单次回答长度上限」调到 4000 以上（推理模型很吃 token）');
    console.log('       ② 或者把 model 换成非推理模型（如 deepseek-chat）');
  } else if (ch.finish_reason === 'length') {
    console.log('  finish_reason = length，说明 token 在上限处被耗尽，没来得及产生正文。');
    console.log('  → 把「单次回答长度上限」调大试试。');
  } else {
    console.log('  finish_reason 不是 length，也没有 reasoning_content。');
    console.log('  完整返回（密钥已遮）:');
    console.log('  ', JSON.stringify(maskSecrets(json)).slice(0, 800));
  }
  return { ok: false };
}

const r1 = await attempt('3', MAX);

// 如果第一次失败，用更大的上限再试一次 —— 直接验证"是不是 token 上限的问题"
if (r1 && !r1.ok) {
  console.log('\n' + '-'.repeat(74));
  console.log('第一次没成功。再用 4000 token 试一次，验证"是不是上限太小"。');
  const r2 = await attempt('4', 4000);
  if (r2 && r2.ok) {
    console.log('\n==> 结论：连接和密钥都没问题，**只是 token 上限太小**。');
    console.log('    去设置页把「单次回答长度上限」调到 4000 左右即可。');
  }
}

console.log('\n' + '='.repeat(74));
console.log('诊断结束。以上内容不含你的密钥。');
console.log('='.repeat(74));
