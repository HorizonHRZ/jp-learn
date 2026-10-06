/**
 * qa-bugs.mjs —— 在**真浏览器**里验证用户报的五个 bug 已经修好。
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么这五个 bug 必须用真浏览器测（假 DOM 测不到）
 * ────────────────────────────────────────────────────────────────────
 *   1. 「查词按钮只在点过某个词之后才出现」——
 *      这是"启动时到底有没有把 DOM 建出来"的问题。假 DOM 里我们**手动**
 *      调 mountLookup() 也能过，但那证明不了真实启动路径（app.js → boot()）
 *      真的调了它。
 *   2. 「假名查不到全部同音词」—— 涉及 fetch + 去重 + 渲染三层，
 *      只有真页面能把三层串起来看。
 *   3. 「改注音保存报 object stores was not found」——
 *      **必须有一个"版本 2、缺 readingOverrides 表"的旧库**才复现得出来。
 *      全新安装永远走不到那条路径，所以这个脚本启动前会刻意造一个旧库。
 *   4. 「点句子空白处误触 AI」+「结果落在句子下方」——
 *      单击/双击/右键的区分是**真实事件模型**的行为，假 DOM 里
 *      事件是我们自己手搓的，区分不出来。
 *   5. 「已保存的笔记被判成未保存草稿」——
 *      根源是自动保存那个**真的每 5 秒跑一次**的定时器。
 *      假 DOM 里"时间"是我们自己拨的，必须真等一次才知道。
 *
 * ────────────────────────────────────────────────────────────────────
 * 它不做的事（刻意的边界，和 qa-layout.mjs 一致）
 * ────────────────────────────────────────────────────────────────────
 *   · 自己起一个**临时只读**服务（随机端口，和用户的 8787 无关）；
 *     `/api/*` 原样转发给真服务，不重写一份接口。
 *   · 找不到 Edge/Chrome 就跳过并说明，**不算失败**。
 *
 * 用法：
 *   node tools/qa-bugs.mjs              # 自检
 *   node tools/qa-bugs.mjs --verbose    # 打印每条检查的原始返回值
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
// 浏览器临时用户目录的收尾（等进程退出 + 删目录）—— 见 lib/qa-profile.mjs 文件头
import { finishBrowser } from './lib/qa-profile.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const VERBOSE = process.argv.includes('--verbose');

let pass = 0;
let fail = 0;
let skipped = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  — ${extra}` : ''}`); }
}
function skip(name, why) { skipped++; console.log(`  · 跳过：${name}（${why}）`); }

// ---------------------------------------------------------------------------
// [0] 找浏览器
// ---------------------------------------------------------------------------
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
const BROWSER = BROWSERS.find((p) => { try { return fs.existsSync(p); } catch { return false; } });

if (!BROWSER) {
  skip('五个 bug 的真浏览器验证', '这台机器上没找到 Edge/Chrome');
  console.log(`\n  跳过 ${skipped} 项。要在有浏览器的机器上跑才能验证这些交互。`);
  process.exit(0);
}
console.log(`  用 ${path.basename(BROWSER)} 做真交互检查`);

// ---------------------------------------------------------------------------
// [1] 临时静态服务（只读；/api/* 转发给真服务）
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let rel = decodeURIComponent(url.pathname);
  // 正式服务把 app/ 当站点根（/js/ui.js → app/js/ui.js），这里要补前缀
  for (const p of ['/js/', '/css/', '/assets/']) {
    if (rel.startsWith(p)) { rel = '/app' + rel; break; }
  }
  if (rel === '/') rel = '/app/__qa__/bugs.html';

  // /api/* 原样转发 —— 不在这里重写一份接口
  if (rel.startsWith('/api/')) {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const up = await fetch('http://127.0.0.1:8787' + req.url, {
        method: req.method,
        headers: { 'content-type': req.headers['content-type'] || 'application/json' },
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      });
      const text = await up.text();
      res.writeHead(up.status, { 'content-type': up.headers.get('content-type') || 'application/json' });
      res.end(text);
    } catch (e) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '转发到 127.0.0.1:8787 失败：' + (e.message || e) }));
    }
    return;
  }

  const abs = path.join(ROOT, rel);
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream' });
  fs.createReadStream(abs).pipe(res);
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const URL_UNDER_TEST = `http://127.0.0.1:${PORT}/app/__qa__/bugs.html`;
const CDP_PORT = PORT + 1;

// ---------------------------------------------------------------------------
// [2] 起浏览器，连 CDP
// ---------------------------------------------------------------------------
const profile = mkdtempSync(path.join(tmpdir(), 'jp-qabugs-'));
const child = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-networking',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`,
  '--window-size=1200,1600',
  URL_UNDER_TEST,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanup() {
  // 等浏览器退出 + 删掉它的临时用户目录（原来只 kill()，profile 从没人删）
  finishBrowser(child, profile);
  try { server.close(); } catch { /* 已经关了 */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

async function targetWs() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.startsWith('http'));
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('CDP 端口没起来（浏览器可能启动失败）');
}

let ws;
try {
  ws = new WebSocket(await targetWs());
} catch (e) {
  skip('五个 bug 的真浏览器验证', String(e.message || e));
  console.log(`\n  跳过 ${skipped} 项。`);
  process.exit(0);
}
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const waiting = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
};
function send(method, params = {}) {
  const myId = ++msgId;
  return new Promise((res) => { waiting.set(myId, res); ws.send(JSON.stringify({ id: myId, method, params })); });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (!r.result) throw new Error('CDP 没有返回结果：' + JSON.stringify(r).slice(0, 200));
  if (r.result.exceptionDetails) {
    throw new Error('页面里抛错：' + (r.result.exceptionDetails.exception
      ? r.result.exceptionDetails.exception.description : r.result.exceptionDetails.text));
  }
  return r.result.result ? r.result.result.value : undefined;
}

// ---------------------------------------------------------------------------
// [3] 等页面把 app 启动起来
// ---------------------------------------------------------------------------
let status = '';
for (let i = 0; i < 100; i++) {
  try {
    const s = await evaluate('(window.__QA && window.__QA.status) || document.title');
    if (s === 'ready' || s === 'threw') { status = s; break; }
  } catch { /* 页面还在换 document */ }
  await sleep(250);
}

const seed = await evaluate('JSON.stringify(window.__QA && window.__QA.seeded)');
console.log('\n[0] 预置"上一版"的用户库（bug 2 的真实现场）');
{
  let s = null;
  try { s = JSON.parse(seed); } catch { /* 保持 null */ }
  if (s && s.error) {
    ok(false, '造出一个版本 2 的旧库', s.error);
  } else if (s && s.blocked) {
    skip('预置旧库', '库被别的连接占着（同一个 profile 跑了第二次？）');
  } else {
    ok(!!s && s.version === 2, `造出一个版本 2 的旧库（表：${(s && s.stores || []).join(',')}）`);
    ok(s && s.hasReadingOverrides === false,
      '★ 这个旧库里**确实没有** readingOverrides 表（复现用户当时的库）');
  }
}

if (status === 'threw') {
  const errs = await evaluate('JSON.stringify(window.__QA.errors)');
  ok(false, 'app.js 能在真浏览器里启动', String(errs).slice(0, 400));
} else {
  ok(status === 'ready', 'app.js 在真浏览器里启动完成', `status=${status}`);
}

// ---------------------------------------------------------------------------
// [4] 逐条跑页面里登记好的检查
// ---------------------------------------------------------------------------
const CHECKS = [
  ['fabOnBoot', '★ 查词按钮在首页就存在（不必先点过某个词）'],
  ['fabOpens', '★ 点这个按钮能打开查词抽屉'],
  ['homophones', '★★ 假名查词列出**全部**同音词，并写明共几条'],
  ['overrideStore', '★★ 改注音能存进 readingOverrides（不再报 object stores was not found）'],
  ['editHint', '★ 页面上有一行小字说明怎么改注音'],
  ['editTrigger', '★ 双击 / 右键都能触发改注音'],
  // ★★ 用户第二轮报的第 1 个问题：双击会先派发两次 click 再派发 dblclick，
  //    旧代码里两次 click 把查词抽屉开开关关，dblclick 又因为层级打架出不来。
  ['dblclickEditsNotLookup', '★★ 双击改读音时，查词抽屉不许被开开关关'],
  ['singleClickStillLooksUp', '★★ 修完之后单击查词仍然好使（不许把单击一起杀掉）'],
  ['noMisfire', '★★ 点句子空白处不会误触 AI 讲语法（AI 已开启，数请求条数）'],
  ['grammarModule', '★★ 讲语法的结果落在这行下方的模块里（不是弹窗）'],
  // ★★ 用户第二轮报的第 5 个问题：结果被一大片留白顶到下半段
  ['drawerNoBigGap', '★★ 查词结果紧跟输入框，上方没有一大片留白'],
  // ★★ 用户第二轮报的第 2 个问题：提示文字和真实交互不一致
  ['hintTextUpToDate', '★★ 阅读页的提示文字和真实的讲语法入口一致'],
  ['draftNoFalsePositive', '★★ 已保存的笔记不再被当成"没保存的草稿"'],
  ['draftRealOneStillShown', '★ 真草稿照常提示（没有为了修 bug 把保护关掉）'],
  ['draftNotRecreated', '★★ 打开已保存的笔记后，自动保存不会把草稿重建出来'],
  // ★★ 改分词（合并/拆分）。分工：算得对不对在 check-segments.mjs（40 条纯函数），
  //    这里只测"按钮在不在、点了开不开、界面上真的能合并、存完真的生效"。
  ['segmentEntry', '★★ 改读音对话框里有「改分词」入口，点了真的出现分词界面'],
  ['segmentMergeWorks', '★★ 真界面上「包括前一个」+「合」真的把两个词并成一个，并写进 segOverrides'],
  ['segmentSplitWorks', '★★ 点「方块内切开」真的把一个词切成两段，并写进 segOverrides'],
  ['segmentAppliesAfterSave', '★★ 存了切法之后页面真的按新切法重画（不是存了没生效）'],
  ['segmentMergeVisibleAfterSave', '★★ 点界面按钮合并之后，阅读器自己就该是合并后的样子'],
  ['noConsoleErrors', '整个过程没有未预期的报错'],
];

console.log('\n[1] 五个 bug 的真交互验证');
for (const [name, title] of CHECKS) {
  let res = null;
  try {
    res = await evaluate(`(async () => {
      const f = window.__QA && window.__QA.check && window.__QA.check[${JSON.stringify(name)}];
      if (!f) return { ok: false, note: '页面里没有登记这个检查' };
      try { return await f(); }
      catch (e) { return { ok: false, note: '检查函数抛错: ' + ((e && e.stack) || e) }; }
    })()`);
  } catch (e) {
    res = { ok: false, note: 'CDP 求值失败: ' + ((e && e.message) || e) };
  }
  if (VERBOSE && res && res.extra) {
    console.log(`      [${name}] extra = ${JSON.stringify(res.extra).slice(0, 300)}`);
  }
  ok(res && res.ok, title, (res && res.note) || '没有返回结果');
}

// 页面里自己报的异常也打出来（即使断言过了，这些也值得看一眼）
const errs = await evaluate('JSON.stringify((window.__QA && window.__QA.errors || []).slice(0, 8))');
let errList = [];
try { errList = JSON.parse(errs) || []; } catch { /* 忽略 */ }
if (errList.length) {
  console.log('\n  页面里报的异常：');
  for (const e of errList) console.log('    · ' + String(e).replace(/\n/g, '\n      ').slice(0, 240));
}

cleanup();
console.log('\n' + '='.repeat(74));
console.log(fail === 0
  ? ` 全部通过（${pass} 项${skipped ? `，跳过 ${skipped} 项` : ''}）`
  : ` ${fail} 项未通过（通过 ${pass} 项）`);
console.log('='.repeat(74));
process.exit(fail === 0 ? 0 : 1);
