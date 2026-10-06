/**
 * qa-disclosure.mjs —— 在**真浏览器**里确认"隐私承诺"是用户真能看见的。
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么需要它：静态断言证明不了"看得见"
 * ────────────────────────────────────────────────────────────────────
 * 隐私文案在本项目里已经变成过两次谎话：
 *   ① "程序完全不联网"      —— 加了 AI 之后不成立；
 *   ② "只把你选中的那段发出去" —— 加了「自动翻译全部段落」之后不成立。
 *
 * 为了防第三次，`test-render.mjs` 里加了一条**静态**不变量：
 * 凡是讲了"把数据发给 AI"的那段文案，必须把两种触发方式都说全。
 * 那条不变量很好，但它只证明**源码里写对了**，证明不了：
 *   · 这段文字真的被渲染到了页面上（不是塞进一个不显示的节点）；
 *   · `title` 属性真的挂在那个按钮上（浏览器的 tooltip 才出得来）；
 *   · 文案没有被 CSS 截断 / 被 `innerHTML` 清掉。
 *
 * 这些正是"假 DOM 测不出来"的那一类（和 `qa-layout.mjs` 同理）。
 * 所以这里用真浏览器把三个关键位置各查一遍：
 *   首页的隐私说明 / 设置页的 AI 卡片 / 精读页的「边界与限制」提示卡，
 *   再加上抽屉里「AI 讲这个词」按钮的 title。
 *
 * ⚠️ 这个脚本需要**服务已经启动**（它要打开真页面、要跑 /api/analyze）。
 *    没启动就如实跳过，不算失败 —— 见文件末尾。
 *
 * 用法：node tools/qa-disclosure.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// 浏览器临时用户目录的收尾（等进程退出 + 删目录）—— 见 lib/qa-profile.mjs 文件头
import { finishBrowser } from './lib/qa-profile.mjs';

const APP = process.env.JP_APP_URL || 'http://127.0.0.1:8787/';
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

let pass = 0, fail = 0, skipped = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '\n      ' + extra : ''}`); }
}

// ---------------------------------------------------------------------------
// [0] 前置条件：服务在跑、浏览器在
// ---------------------------------------------------------------------------
try {
  const r = await fetch(APP + 'api/health');
  if (!r.ok) throw new Error('health ' + r.status);
} catch (e) {
  skipped++;
  console.log(`  · 跳过：服务没在 ${APP} 上跑（${e.message || e}）`);
  console.log('\n  这个脚本要在服务启动后才有意义：node server.js 8787');
  console.log(`\n  跳过 ${skipped} 项，不算失败。`);
  process.exit(0);
}
const fsMod = await import('node:fs');
const BROWSER = BROWSERS.find((p) => { try { return fsMod.existsSync(p); } catch { return false; } });
if (!BROWSER) {
  skipped++;
  console.log('  · 跳过：这台机器上没有 Edge/Chrome');
  console.log(`\n  跳过 ${skipped} 项，不算失败。`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// [1] 连 CDP
// ---------------------------------------------------------------------------
const PORT = 9466;
const profile = mkdtempSync(path.join(tmpdir(), 'jp-disc-'));
const child = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--no-default-browser-check', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--window-size=1300,1000', APP], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 等浏览器退出 + 删掉它的临时用户目录（原来只 kill()，profile 从没人删）
const cleanup = () => { finishBrowser(child, profile); };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

async function wsUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = l.find((t) => t.type === 'page' && t.url.startsWith('http'));
      if (p && p.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('CDP 端口没起来（浏览器可能启动失败）');
}

let sock;
try {
  sock = new WebSocket(await wsUrl());
  await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej; });
} catch (e) {
  skipped++;
  console.log(`  · 跳过：连不上浏览器（${e.message || e}）`);
  console.log(`\n  跳过 ${skipped} 项，不算失败。`);
  process.exit(0);
}

let id = 0;
const waiting = new Map();
sock.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id; waiting.set(i, res); sock.send(JSON.stringify({ id: i, method, params }));
});
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (!r.result) throw new Error('CDP 无返回：' + JSON.stringify(r).slice(0, 200));
  if (r.result.exceptionDetails) {
    const ex = r.result.exceptionDetails.exception;
    throw new Error('页面抛错：' + (ex ? ex.description : r.result.exceptionDetails.text));
  }
  return r.result.result ? r.result.result.value : undefined;
}

await sleep(2500);   // 等启动

// ---------------------------------------------------------------------------
// [2] 首页
// ---------------------------------------------------------------------------
console.log('\n[1] 首页的隐私说明');
{
  const h = await ev(`(() => {
    const m = document.getElementById('mount');
    const t = m ? m.innerText : '';
    return {
      manual: /点词|点句/.test(t),
      auto: /自动翻译/.test(t),
      // ⚠️ 认**意思**不认措辞：这里踩过一次。
      //    断言原本写 /都不会被发送|不会上传/，而首页那句话是「都不出本机」——
      //    断言红了，但红的不是代码，是我把断言写成了"我期待的说法"。
      noSend: /不出本机|不会被发送|不会发送|不会上传/.test(t),
      text: t.slice(0, 300),
    };
  })()`);
  ok(h.manual, '首页写明手动触发发什么（点词/点句）');
  ok(h.auto, '★ 首页写明「自动翻译」会把每段正文发出去');
  ok(h.noSend, '首页写明哪些数据不出本机', h.text.replace(/\n/g, ' | ').slice(0, 180));
}

// ---------------------------------------------------------------------------
// [3] 设置页
// ---------------------------------------------------------------------------
console.log('\n[2] 设置页的 AI 说明');
await ev(`location.hash = '#/settings'`);
await sleep(1000);
{
  const t = await ev(`document.getElementById('mount').innerText`);
  ok(/自动翻译/.test(t), '★ 设置页写明「自动翻译」会把每段正文发出去');
  ok(/点词|点句|讲这个词/.test(t), '设置页写明手动触发发什么');
  ok(/config\.local\.json/.test(t), '设置页说明密钥存在哪（用户选了明文方案，不能含糊）');
  ok(/联网/.test(t), '设置页明确说这个功能会联网');
}

// ---------------------------------------------------------------------------
// [4] 精读页的「边界与限制」提示卡
// ---------------------------------------------------------------------------
console.log('\n[3] 精读页的「边界与限制」提示卡');
await ev(`location.hash = '#/reading'`);
await sleep(1000);
{
  // 用户就是在**这一页**按「自动翻译全部段落」的，
  // 所以"按下它会把什么发出去"必须写在他眼前。
  const b = await ev(`(() => {
    const el = document.querySelector('.banner-info');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { text: el.innerText, h: Math.round(r.height), w: Math.round(r.width) };
  })()`);
  ok(!!b && b.h > 0 && b.w > 0, '提示卡真的显示出来了（有真实宽高）',
    b ? `h=${b.h} w=${b.w}` : '页面上没有 .banner-info');
  if (b) {
    ok(/自动翻译全部段落/.test(b.text), '★ 提示卡写明「自动翻译全部段落」会发每段正文',
      b.text.replace(/\n/g, ' | ').slice(0, 200));
    // ⚠️ 认**意思**不认措辞（这个坑本项目踩过两次了，见下面 noSend 那段）。
    //    这条原先写 /点词|点句/ —— 那是**我当时那句话的措辞**，不是"意思"。
    //    2026-10 用户指出提示文字已经过时（"点句子空白处"讲语法早就不成立了），
    //    我把提示卡改成写清**真实的两个入口名**：
    //      「AI 讲这个词」（抽屉里的按钮）和「⚙ 讲语法」（每句旁的按钮）
    //    结果断言红了 —— 红的不是代码，是断言被措辞锁死了。
    //    改成按**按钮名**认：那两个名字是界面上真实存在的文字，比"点词/点句"
    //    这种我自己的概括更该被钉住。
    ok(/讲这个词|讲语法/.test(b.text), '提示卡写明手动触发（AI 讲这个词 / 讲语法）会发什么', b.text.slice(0, 200));
    ok(/图片不会上传/.test(b.text), '提示卡保留"图片不会上传"这条（OCR 是本机的）');
  }
}

// ---------------------------------------------------------------------------
// [5] 抽屉里「AI 讲这个词」按钮的 title
// ---------------------------------------------------------------------------
console.log('\n[4] 抽屉里「AI 讲这个词」按钮的说明');
{
  const d = await ev(`(async () => {
    const m = document.getElementById('mount');
    const ta = m.querySelector('textarea');
    if (!ta) return { found: false, why: '没有输入框' };
    ta.value = '吾輩は猫である。';
    const go = [...m.querySelectorAll('button')].find(b => /开始精读/.test(b.textContent));
    if (!go) return { found: false, why: '没有开始精读按钮' };
    go.click();
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250));
      if (document.querySelector('.air-reader')) break;
    }
    // ⚠️ 词节点的类名是 .jpr-w（见 app/js/views/jpreader.js:86）。
    //    第一版按 .jpr-word 猜，找不到 —— 看起来像功能坏了，其实是选择器写错了。
    const words = [...document.querySelectorAll('.jpr-w')];
    if (!words.length) return { found: false, why: '页面上没有 .jpr-w 词节点' };
    words[0].click();
    await new Promise(r => setTimeout(r, 700));
    const b = [...document.querySelectorAll('button')].find(x => /AI 讲这个词/.test(x.textContent));
    return {
      found: !!b,
      wordCount: words.length,
      title: b ? (b.getAttribute('title') || '') : '',
    };
  })()`);
  ok(d.found, '抽屉里出现了「AI 讲这个词」按钮', JSON.stringify(d).slice(0, 200));
  if (d.found) {
    ok(/点词/.test(d.title), '★ 按钮 title 写明"点词只发这一个词"', d.title);
    ok(/自动翻译/.test(d.title), '★ 按钮 title 也说明自动翻译会发整段（用户可能只看到这里）', d.title);
  }
}

cleanup();
console.log('\n' + '='.repeat(74));
console.log(fail === 0
  ? ` 全部通过（${pass} 项${skipped ? `，跳过 ${skipped} 项` : ''}）`
  : ` ${fail} 项未通过（通过 ${pass} 项）`);
console.log('='.repeat(74));
process.exit(fail === 0 ? 0 : 1);
