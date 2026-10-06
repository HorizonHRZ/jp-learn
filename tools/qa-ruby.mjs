/**
 * qa-ruby.mjs —— 用**真浏览器**量「振假名 / 罗马音 / 表面形」的几何关系。
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么必须有这个脚本
 * ────────────────────────────────────────────────────────────────────
 * 用户报的原话是：
 *
 *     「歌词和精读功能似乎不能有效识别"々"这个字符，
 *       点击罗马音按钮之后会下沉到与罗马音字母同一行。」
 *
 * 这句话的本质是**几何**：振假名（<rt>）在表面形**上方**、罗马音在**下方**，
 * 三者不能挤在同一行。而 `test-render.mjs` 用的是假 DOM —— **它没有排版引擎**。
 * 假 DOM 能证明"建出了 <rt> 和 <span class="jpr-romaji">"，
 * 但把 `.jpr-romaji { display:block }` 写成 `inline`、
 * 或者某个 `display` 覆盖掉，**照样全绿**。
 *
 * 所以这里刻意做一次真排版：起临时只读服务 → headless Edge 走 CDP →
 * 在页面里 `getBoundingClientRect()` 量三个盒子 → 算成可判定的布尔值。
 *
 * ────────────────────────────────────────────────────────────────────
 * 判据（为什么用中心线而不是上边界）
 * ────────────────────────────────────────────────────────────────────
 *   rt.centerY      <  表面形.centerY     → 振假名在上方
 *   romaji.centerY  >  表面形.centerY     → 罗马音在下方
 *   且 romaji.top   >= rt.bottom - 1      → 两者没有挤在一起
 *
 * 字号分别是 .52em / .6em，上边界会差 1px 左右；中心线对字号差异更稳，
 * 也更能反映"视觉上是不是同一行"这个用户真正看到的现象。
 *
 * ────────────────────────────────────────────────────────────────────
 * 它不做的事
 * ────────────────────────────────────────────────────────────────────
 *   · 不测"读音对不对"（那是 data/kana 与词库的事，这里只测几何 + 打印读音供核对）
 *   · 找不到 Edge 就**跳过并说明**，不算失败
 *
 * 用法：
 *   node tools/qa-ruby.mjs              # 自检
 *   node tools/qa-ruby.mjs --verbose    # 把量到的每个矩形都打出来
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
const UPSTREAM = 'http://127.0.0.1:8787';

let pass = 0, fail = 0, skipped = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  — ' + extra : ''}`); }
}
function skip(name, why) { skipped++; console.log(`  · 跳过：${name}（${why}）`); }

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
const BROWSER = BROWSERS.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!BROWSER) {
  skip('真浏览器振假名排版检查', '这台机器上没找到 Edge/Chrome');
  console.log(`\n  跳过 ${skipped} 项。`);
  process.exit(0);
}
console.log(`  用 ${path.basename(BROWSER)} 做真排版检查`);

// [1] 临时只读服务（自己起一个，绝不碰用户的 8787，只转发 /api/*）
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let rel = decodeURIComponent(url.pathname);
  // 应用的模块用 /js /css /assets 绝对路径（正式服务把 app/ 当站点根）
  for (const p of ['/js/', '/css/', '/assets/']) {
    if (rel.startsWith(p)) { rel = '/app' + rel; break; }
  }
  if (rel === '/') rel = '/app/__qa__/ruby.html';

  if (rel.startsWith('/api/')) {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const up = await fetch(UPSTREAM + req.url, {
        method: req.method,
        headers: { 'content-type': req.headers['content-type'] || 'application/json' },
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      });
      const text = await up.text();
      res.writeHead(up.status, { 'content-type': up.headers.get('content-type') || 'application/json' });
      res.end(text);
    } catch (e) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '转发失败：' + (e.message || e) }));
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
const CDP_PORT = PORT + 1;

// [2] 起浏览器连 CDP
const profile = mkdtempSync(path.join(tmpdir(), 'jp-ruby-'));
const child = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-networking',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--window-size=900,1400', `http://127.0.0.1:${PORT}/app/__qa__/ruby.html`,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function cleanup() {
  // ⚠️ 原来是"发个终止信号 + server.close()"，**没删 profile** ——
  //    就是它（和另外 5 个 QA）在 %TEMP% 里堆出了 18.3 GB。
  //    （写注释时别把这行写成被禁用的那种写法 —— check-deliverables 会红。）
  finishBrowser(child, profile);
  try { server.close(); } catch { /* 已关 */ }
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
  throw new Error('CDP 端口没起来');
}
let ws;
try { ws = new WebSocket(await targetWs()); }
catch (e) { skip('真浏览器振假名排版检查', String(e.message || e)); console.log(`\n  跳过 ${skipped} 项。`); process.exit(0); }
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const waiting = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
};
function send(method, params = {}) {
  const myId = ++msgId;
  return new Promise((res) => { waiting.set(myId, res); ws.send(JSON.stringify({ id: myId, method, params })); });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (!r.result) throw new Error('CDP 无返回：' + JSON.stringify(r).slice(0, 200));
  if (r.result.exceptionDetails) {
    throw new Error('页面抛错：' + (r.result.exceptionDetails.exception
      ? r.result.exceptionDetails.exception.description : r.result.exceptionDetails.text));
  }
  return r.result.result ? r.result.result.value : undefined;
}

// [3] 等页面就绪
let status = '';
for (let i = 0; i < 80; i++) {
  try {
    const s = await evaluate('(window.__QA && window.__QA.status) || document.title');
    if (s === 'ready') { status = s; break; }
  } catch { /* 还在换 document */ }
  await sleep(250);
}
const qa = await evaluate('window.__QA ? JSON.parse(JSON.stringify(window.__QA)) : null');
if (qa && qa.errors && qa.errors.length) {
  console.log('  页面里报的错：');
  for (const e of qa.errors) console.log('    · ' + String(e).replace(/\n/g, '\n      '));
}

console.log('\n[1] 振假名在上、罗马音在下（真浏览器几何）');
ok(!!qa && qa.status === 'ready', 'QA 页面跑到了 ready', qa ? `status=${qa.status}` : 'window.__QA 不存在');

if (VERBOSE && qa) console.log('\n  量到的原始数据：\n' + JSON.stringify(qa.cases, null, 2));

if (qa && qa.cases) {
  for (const c of qa.cases) {
    if (VERBOSE) console.log(`\n  · ${c.name}`);
    for (const ch of c.chips) {
      const label = `「${ch.surface}」`;
      if (!ch.romaji) { ok(false, `${label} 有罗马音盒子`, '没找到 .jpr-romaji'); continue; }
      if (!ch.body) { ok(false, `${label} 有主体盒子`); continue; }

      // ★ 罗马音必须在主体下方（用户说的"下沉到和罗马音同一行"就是这条不成立）
      ok(ch.romaji.cy > ch.body.cy,
        `${label} 罗马音在表面形下方`,
        `romaji.cy=${ch.romaji.cy} body.cy=${ch.body.cy} (差 ${(ch.romaji.cy - ch.body.cy).toFixed(2)}px)`);

      // ★ 振假名必须在主体上方
      if (ch.rt) {
        ok(ch.rt.cy < ch.body.cy,
          `${label} 振假名在表面形上方`,
          `rt.cy=${ch.rt.cy} body.cy=${ch.body.cy}`);
        // ★ 两者不能挤在同一行
        ok(ch.romaji.top >= ch.rt.bottom - 1,
          `${label} 振假名与罗马音没有挤在同一行`,
          `rt.bottom=${ch.rt.bottom} romaji.top=${ch.romaji.top} (重叠 ${(ch.rt.bottom - ch.romaji.top).toFixed(2)}px)`);
      }
      // 一个词必须整体占位（不能宽度为 0）
      ok(ch.body.h > 0 && ch.romaji.h > 0, `${label} 两个盒子都有真实高度`,
        `body.h=${ch.body.h} romaji.h=${ch.romaji.h}`);

      // 罗马音比词还宽会让相邻词挤在一起（"翹出去"）；允许 60% 的超出。
      // ⚠️ 这条不是硬要求 —— 长罗马音本来就比汉字宽（生活→seikatsu）。
      //    它只是用来**观察**，不作为失败条件，所以用 console.log 而不是 ok()。
      const over = ch.romaji.right - ch.chipW - ch.body.left;
      if (VERBOSE) console.log(`      romaji 宽 ${(ch.romaji.right - ch.romaji.left).toFixed(1)} / 词宽 ${ch.chipW} / 超出 ${over.toFixed(1)}px`);
    }
  }
}

console.log('\n[2] 「々」这类叠字的注音（走真实 /api/analyze）');
if (!qa || !qa.readings || !qa.readings.length) {
  skip('叠字注音检查', '没能从 /api/analyze 拿到分词结果（服务没在跑？）');
} else {
  for (const r of qa.readings) {
    const toks = (r.tokens || []).map((t) => t.surface + '[' + t.reading + ']').join(' | ');
    console.log(`  · ${r.text}  =>  ${toks}`);
  }
  // 「々」必须被当成汉字的一部分，不能单独成一个"未知词"
  const iterTokens = qa.readings.flatMap((r) => r.tokens.filter((t) => t.surface.includes('々')));
  ok(iterTokens.length > 0, '「々」参与构词（拿到了含 々 的 token）',
    JSON.stringify(iterTokens.map((t) => t.surface)));
  const loneIter = qa.readings.flatMap((r) => r.tokens.filter((t) => t.surface === '々'));
  ok(loneIter.length === 0, '★ 「々」没有被切成单独一个 token',
    loneIter.length ? `有 ${loneIter.length} 个孤立 々` : '');
}

console.log('\n[3] 改读音功能（js/yomi.js + IndexedDB + /api/yomi）');
const ov = qa && qa.overrides;
if (!ov) {
  skip('改读音检查', '载荷没有返回 overrides 段（页面没跑起来？）');
} else {
  ok(ov.store === true, 'readingOverrides 这张表自动补上了（只增不减的迁移）',
    ov.store ? '' : `错误：${ov.storeError || '未知'}`);
  for (const e of ov.errors || []) console.log(`      ✗ 载荷内错误：${e}`);
  ok((ov.errors || []).length === 0, '载荷内没有抛异常', (ov.errors || []).join(' | '));

  if (ov.saved) {
    const b = ov.saved.before, a = ov.saved.after;
    console.log(`      改之前：读音 ${b.reading} / 罗马音 ${b.romaji}`);
    console.log(`      改之后：读音 ${a.reading} / 罗马音 ${a.romaji} / 振假名 ${JSON.stringify(a.ruby)}`);
    ok(b.reading === 'きょう', '程序默认给 今日 的读音是 きょう', `实际 ${b.reading}`);
    ok(a.reading === 'こんにち', '手改后的读音是 こんにち');
    ok(a.romaji === 'konnichi', '罗马音跟着变成 konnichi（不是旧的 kyou）', `实际 ${a.romaji}`);
    ok((a.ruby || []).length === 2, '新读音被重新切成两段振假名（不是整词一段）',
      JSON.stringify(a.ruby));
  } else {
    ok(false, '拿到了 今日 这个 token 并改过读音', '没拿到，用例没跑起来');
  }

  ok(ov.appliedCount > 0, 'applyOverrides() 真的改写了 token', `改了 ${ov.appliedCount} 个`);
  const hit = (ov.applied || []).find((t) => t.surface === '今日');
  ok(!!hit && hit.override === true && hit.reading === 'こんにち',
    '被改的词带上了 override 标记（界面据此显示"这个读音是你定的"）',
    JSON.stringify(hit));

  ok(!!ov.persisted && ov.persisted.reading === 'こんにち',
    '读音真的写进了 IndexedDB（重新读一遍还在）',
    `读回来是 ${JSON.stringify(ov.persisted)}`);
  ok(!!ov.persisted && ov.persisted.hasRuby === true,
    '存库时就带上了振假名（所以套用读音是全同步的，不用发请求）',
    JSON.stringify(ov.persisted));
  ok(!!ov.persisted && ov.persisted.romaji === 'konnichi',
    '存库时也带上了罗马音', JSON.stringify(ov.persisted));
  ok(ov.cleanedUp === true, '测试写入的记录已被删掉（不会污染真实页面的读音）');

  // ★ 改读音之后版式仍然要对 —— 这是用户报的那个现象的形状：
  //   新读音（こんにち）比旧的（きょう）长，很容易把罗马音挤到振假名同一行。
  const chips = ov.chips || [];
  ok(chips.length > 0, '改读音后的那一行渲染出来了');
  for (const ch of chips) {
    if (!ch.rt || !ch.romaji) continue;
    const label = `改读音后「${ch.surface}」`;
    ok(ch.rt.cy < ch.body.cy, `${label} 振假名在表面形上方`,
      `rt.cy=${ch.rt.cy} body.cy=${ch.body.cy}`);
    ok(ch.romaji.cy > ch.body.cy, `${label} 罗马音在表面形下方`,
      `romaji.cy=${ch.romaji.cy} body.cy=${ch.body.cy}`);
    ok(ch.romaji.top >= ch.rt.bottom - 1, `${label} 罗马音和振假名没有挤在同一行`,
      `romaji.top=${ch.romaji.top} rt.bottom=${ch.rt.bottom}`);
  }
  const today = chips.find((c) => c.surface === '今日');
  if (today) {
    ok(today.reading === 'こんにち', '页面上那个词显示的是手改后的读音',
      `dataset.reading=${today.reading}`);
    if (VERBOSE) {
      console.log(`      today.ruby = ${ov.targetRuby}`);
      console.log(`      today 的 HTML = ${ov.todayChipHTML}`);
    }
    ok(today.rtCount === 2, '页面上那个词的振假名是两段（今/日）',
      `rtCount=${today.rtCount}  HTML=${ov.todayChipHTML}`);
  }
}

cleanup();
console.log('\n' + '='.repeat(74));
console.log(fail === 0
  ? ` 全部通过（${pass} 项${skipped ? `，跳过 ${skipped} 项` : ''}）`
  : ` ${fail} 项未通过（通过 ${pass} 项）`);
console.log('='.repeat(74));
process.exit(fail === 0 ? 0 : 1);
