/**
 * AI 端到端测试：用**假的 OpenAI 兼容服务**把整条链路跑通。
 *
 * 用法：node tools/test-ai-e2e.mjs
 *
 * 这条链路：浏览器 → /api/ai/chat → 上游 /chat/completions → 回填界面
 *
 * 为什么非要真发一次请求（光靠 test-ai.mjs 的单测不够）：
 *   单测只能验证我们自己的拼装逻辑。而下面这三件事只有真发请求才能确认：
 *     1. 请求到底打到哪个路径（baseURL 拼接对不对）
 *     2. Authorization 头有没有正确带上
 *     3. 有没有正确从 `choices[0].message.content` 取回答
 *   而且**只有真的收到一次请求**，才能断言"发出去的东西里只有选中文本" ——
 *   这是对用户的承诺，值得在最下游看一眼。
 *
 * ⚠️ 关键设计：测试用的配置写到 **系统临时目录**（`JP_LEARN_CONFIG`），
 *    绝不碰用户项目目录里的 `config.local.json`。
 *    原因：最初写成"备份真配置 → 写入 → 测完恢复"，结果探针里
 *    `process.exit()` 跳过了恢复逻辑，项目目录里留下一份指向
 *    `http://127.0.0.1:8792/v1` 的假配置 —— 用户下次打开设置页会看到它。
 *    让测试从一开始就不碰那个文件，是唯一可靠的办法。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 8791;
const FAKE_PORT = 8792;

let fail = 0; let pass = 0;
const ok = (c, label, detail) => {
  if (c) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
};

// ---------------------------------------------------------------------------
// 0. 临时配置（在系统临时目录，不碰项目目录）
// ---------------------------------------------------------------------------
const TMP_CFG = path.join(os.tmpdir(), `jp-learn-test-ai-${process.pid}.json`);
process.env.JP_LEARN_CONFIG = TMP_CFG;
process.env.JP_LEARN_PORT = String(APP_PORT);

function writeCfg(patch) {
  const base = {
    enabled: true,
    baseURL: `http://127.0.0.1:${FAKE_PORT}/v1`,
    apiKey: 'sk-e2e-SECRETKEY-abcdefghijklmnop',
    model: 'model-ok',
    temperature: 0.3,
    maxTokens: 1200,
    timeoutMs: 20000,
  };
  fs.writeFileSync(TMP_CFG, JSON.stringify({ ...base, ...patch }, null, 2));
}
writeCfg({});

// ---------------------------------------------------------------------------
// 1. 假的 AI 服务（记录收到的每个请求）
// ---------------------------------------------------------------------------
let upstreamGot = null;
const fake = http.createServer((req, res) => {
  if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '这不是 chat 接口' } }));
    return;
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* 下面按 null 处理 */ }
    upstreamGot = {
      url: req.url,
      auth: req.headers.authorization || '(无)',
      contentType: req.headers['content-type'] || '(无)',
      body: parsed,
    };
    // 按模型名给出不同的回应，方便测错误分支
    const model = parsed && parsed.model;
    if (model === 'model-401') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
      return;
    }
    if (model === 'model-429') {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Rate limit reached' } }));
      return;
    }
    if (model === 'model-garbage') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('这不是 JSON');
      return;
    }
    if (model === 'model-multi') {
      // 部分服务商把 content 返回成数组
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: [{ text: '甲' }, { text: '乙' }] } }] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '这是假的回答：你好。' }, finish_reason: 'stop' }],
      usage: { total_tokens: 42 },
    }));
  });
});

await new Promise((r) => fake.listen(FAKE_PORT, '127.0.0.1', r));

// ---------------------------------------------------------------------------
// 2. 起一个本程序实例
// ---------------------------------------------------------------------------
// ⚠️ Windows 上不能直接 import 绝对路径（ERR_UNSUPPORTED_ESM_URL_SCHEME），
//    必须先转成 file:// URL。这是本项目已知的路径坑之一。
await import(pathToFileURL(path.join(ROOT, 'server.js')).href);
await new Promise((r) => setTimeout(r, 1200));

const post = (p, obj) => fetch(`http://127.0.0.1:${APP_PORT}${p}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj),
}).then(async (r) => ({ status: r.status, body: await r.json() }));
const get = (p) => fetch(`http://127.0.0.1:${APP_PORT}${p}`)
  .then(async (r) => ({ status: r.status, body: await r.json() }));

console.log('='.repeat(72));
console.log(' AI 端到端测试（假上游服务，真实 HTTP 往返）');
console.log('='.repeat(72));

// ---------------------------------------------------------------------------
console.log('\n[1] 成功路径：请求发对了地方吗');
{
  upstreamGot = null;
  const r = await post('/api/ai/chat', { task: 'translate', text: 'こんにちは' });
  ok(r.status === 200 && r.body.ok, 'HTTP 200 且 ok=true', JSON.stringify(r.body).slice(0, 120));
  ok(r.body.text === '这是假的回答：你好。', '取到了 choices[0].message.content', r.body.text);
  ok(r.body.model === 'model-ok', '返回体带上模型名');
  ok(r.body.sent && r.body.sent.chars === 5, '报告"这次发出去多少个字"', JSON.stringify(r.body.sent));

  ok(!!upstreamGot, '上游确实收到了请求');
  if (upstreamGot) {
    ok(upstreamGot.url === '/v1/chat/completions', `打到了正确路径（${upstreamGot.url}）`);
    ok(upstreamGot.auth === 'Bearer sk-e2e-SECRETKEY-abcdefghijklmnop', '带了正确的 Authorization 头');
    ok(upstreamGot.contentType === 'application/json', 'Content-Type 正确');

    const b = upstreamGot.body || {};
    ok(b.model === 'model-ok', 'model 透传');
    ok(b.temperature === 0.3, 'temperature 透传');
    ok(b.max_tokens === 1200, 'max_tokens 透传');
    ok(Array.isArray(b.messages) && b.messages.length === 2, 'messages 是 system + user 两条');
    ok(b.messages[0].role === 'system', '第一条是 system 提示词');
    ok(b.messages[1].content === 'こんにちは', '第二条是选中文本，原样发送');

    // ★ 最关键的一条：发出去的东西里**只有**选中文本
    const allContent = b.messages.map((m) => m.content).join('\n');
    ok(!/生词本|IndexedDB|progress|srs|笔记/.test(allContent), '发送内容里没有任何用户数据');
    ok(b.messages[1].content.length < 50,
      `发送的文本很短（${b.messages[1].content.length} 字），不是整页文本`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n[2] content 是数组时也要能取到（部分服务商这么返回）');
{
  writeCfg({ model: 'model-multi' });
  const r = await post('/api/ai/chat', { task: 'explain', text: 'テスト' });
  ok(r.body.text === '甲乙', '数组形式的 content 被拼起来了', r.body.text);
}

// ---------------------------------------------------------------------------
console.log('\n[3] 上游报错要翻译成人话');
{
  writeCfg({ model: 'model-401' });
  const r401 = await post('/api/ai/chat', { task: 'translate', text: 'テスト' });
  ok(/401|密钥/.test(r401.body.error), '401 → 提到密钥不对', r401.body.error);
  ok(!/Incorrect API key/.test(r401.body.error), '不把上游英文原文直接甩给用户', r401.body.error);

  writeCfg({ model: 'model-429' });
  const r429 = await post('/api/ai/chat', { task: 'translate', text: 'テスト' });
  ok(/429|频繁|额度/.test(r429.body.error), '429 → 提到太频繁/额度', r429.body.error);

  writeCfg({ model: 'model-garbage' });
  const rg = await post('/api/ai/chat', { task: 'translate', text: 'テスト' });
  ok(rg.status === 502, '上游返回非 JSON → 502', String(rg.status));
  ok(/不是 JSON|失败/.test(rg.body.error), '给出可读原因', rg.body.error);

  writeCfg({});
}

// ---------------------------------------------------------------------------
console.log('\n[4] 参数校验');
{
  const empty = await post('/api/ai/chat', { task: 'translate', text: '   ' });
  ok(empty.status === 400, '空文本 → 400', String(empty.status));

  const badJson = await fetch(`http://127.0.0.1:${APP_PORT}/api/ai/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '不是JSON',
  });
  ok(badJson.status === 400, '请求体不是 JSON → 400', String(badJson.status));

  const badTask = await post('/api/ai/chat', { task: '随便乱传', text: 'テスト' });
  ok(badTask.status === 200, '未知任务用兜底提示词（不报错）', String(badTask.status));
}

// ---------------------------------------------------------------------------
console.log('\n[5] 默认关闭 / 配置不全 → 必须拒绝');
{
  writeCfg({ enabled: false });
  const off = await post('/api/ai/chat', { task: 'translate', text: 'テスト' });
  ok(off.status === 403, '关闭状态 → 403', String(off.status));
  ok(off.body.code === 'disabled', '错误码是 disabled', JSON.stringify(off.body));

  writeCfg({ enabled: true, apiKey: '' });
  const nokey = await post('/api/ai/chat', { task: 'translate', text: 'テスト' });
  ok(nokey.status === 403, '有地址没密钥 → 403', String(nokey.status));
  ok(nokey.body.code === 'unconfigured', '错误码是 unconfigured', JSON.stringify(nokey.body));

  writeCfg({ enabled: true, baseURL: '' });
  const nourl = await post('/api/ai/chat', { task: 'translate', text: 'テスト' });
  ok(nourl.status === 403, '有密钥没地址 → 403', String(nourl.status));

  writeCfg({});
}

// ---------------------------------------------------------------------------
console.log('\n[6] 密钥绝不能从任何出口泄漏');
{
  const SECRET = 'sk-e2e-SECRETKEY-abcdefghijklmnop';
  const cfg = await get('/api/ai/config');
  const cfgDump = JSON.stringify(cfg.body);
  ok(!cfgDump.includes(SECRET), 'GET /api/ai/config 不含密钥原文');
  ok(!cfgDump.includes('SECRETKEY'), '连密钥片段都不含');
  ok(cfg.body.config.hasKey === true, '但能告诉用户"已经设了密钥"');
  ok(!!cfg.body.config.keyHint, `给出遮罩提示（${cfg.body.config.keyHint}）`);

  // 隐私说明由服务端下发（单一来源在 tools/aiconf.js）。
  // 浏览器侧另有一份兜底副本，test-render.mjs 断言两份逐字一致。
  //
  // ⚠️ 2026-10 改：原来断言"说了只发选中的"。加了「自动翻译全部段落」之后
  //    那句话不再成立（一按按钮就会把每段正文依次发出去），
  //    所以改成"两种触发方式都要说清楚"。
  ok(Array.isArray(cfg.body.privacy) && cfg.body.privacy.length >= 3,
    '服务端下发了隐私说明', String(cfg.body.privacy && cfg.body.privacy.length));
  ok((cfg.body.privacy || []).some((s) => /那一小段|讲这个词|讲这句/.test(s)),
    '隐私说明说了"点词/点句时只发那一小段"');
  ok((cfg.body.privacy || []).some((s) => /自动翻译/.test(s)),
    '★ 隐私说明说了"自动翻译会把每段正文发出去"');
  ok((cfg.body.privacy || []).every((s) => !/\*\*|`/.test(s)),
    '下发的隐私说明里没有 Markdown 标记（界面上会原样露星号）');

  const health = await get('/api/health');
  ok(!JSON.stringify(health.body).includes('SECRETKEY'), '/api/health 不含密钥');
  ok(health.body.ai && health.body.ai.enabled === true, '/api/health 报告 AI 已开启');
  ok(!JSON.stringify(health.body.ai).includes('baseURL'), '/api/health 连地址都不报（没必要）');

  // 配置文件本身不能被静态访问
  for (const p of ['/config.local.json', '/CONFIG.LOCAL.JSON']) {
    const r = await fetch(`http://127.0.0.1:${APP_PORT}${p}`);
    ok(r.status === 404, `${p} 静态访问被拒（404）`, String(r.status));
  }

  // 保存响应里也不能回显密钥
  const saved = await post('/api/ai/config', { apiKey: 'sk-another-SECRET-9999999999' });
  ok(!JSON.stringify(saved.body).includes('SECRET-999'), '保存响应不回显密钥');
  writeCfg({});
}

// ---------------------------------------------------------------------------
console.log('\n[7] 连不上时要快、且说人话');
{
  writeCfg({ baseURL: 'http://127.0.0.1:8799/v1', timeoutMs: 3000 });
  const t0 = Date.now();
  const r = await post('/api/ai/chat', { task: 'translate', text: 'テスト' });
  const dt = Date.now() - t0;
  ok(r.status === 502, '连不上 → 502', String(r.status));
  ok(/拒绝了连接|连不上/.test(r.body.error), '给出人话', r.body.error);
  ok(!/fetch failed/.test(r.body.error), '不出现 "fetch failed" 这种等于没说的话', r.body.error);
  ok(dt < 15000, `没有傻等很久（${dt}ms）`);

  writeCfg({ baseURL: 'https://api.example.invalid/v1', timeoutMs: 3000 });
  const r2 = await post('/api/ai/chat', { task: 'translate', text: 'テスト' });
  ok(/连不上这个地址/.test(r2.body.error), '域名解析失败也有人话', r2.body.error);
}

// ---------------------------------------------------------------------------
console.log('\n[8] 不该碰用户真实配置');
{
  const real = path.join(ROOT, 'config.local.json');
  // 测试跑到现在，应该一次都没写过项目目录里的真配置
  // （这里只断言"我们用的是临时文件"，不去看真配置文件是否存在 ——
  //   用户自己可能真的配置过，那样文件本来就该在。）
  ok(path.resolve(process.env.JP_LEARN_CONFIG) === path.resolve(TMP_CFG),
    'JP_LEARN_CONFIG 指向系统临时目录，不是项目目录');
  ok(!path.resolve(process.env.JP_LEARN_CONFIG).startsWith(ROOT),
    '临时配置在项目目录之外');
  void real;
}

console.log('\n' + '='.repeat(72));
console.log(fail === 0 ? ` 全部通过（${pass} 项）` : ` ${fail} 项未通过（通过 ${pass} 项）`);
console.log('='.repeat(72));

// ---------------------------------------------------------------------------
// 清理：这一节要真跑到（不能靠 process.exit 提前退出）
// ---------------------------------------------------------------------------
fake.close();
try { fs.unlinkSync(TMP_CFG); } catch { /* 已经不在了也没关系 */ }
process.exit(fail === 0 ? 0 : 1);
