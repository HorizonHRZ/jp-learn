/**
 * qa-layout.mjs —— 用**真浏览器**量"两栏阅读器"到底有没有左右并排。
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么必须有这个脚本（别的测试都替代不了它）
 * ────────────────────────────────────────────────────────────────────
 * 用户的核心诉求原话是：
 *
 *     「左边日文右边中文，这时候就把文本转变成横板的方便我阅读」
 *
 * 这句话的本质是**几何**：两个格子必须横向并排、各自有真实宽度。
 * 而 `test-render.mjs` 用的是假 DOM —— **它没有排版引擎**。
 * 假 DOM 能证明"建出了 .air-ja 和 .air-zh 两个节点"，
 * 但把 `grid-template-columns: 1fr 1fr` 写成 `1fr`（两栏上下叠）、
 * 或者写成 `column` 方向、或者被某个 `display:block` 覆盖掉，
 * 假 DOM **照样全绿**。因为对假 DOM 来说，节点的父子关系一点没变。
 *
 * 这类"渲染得出来但排版是错的"问题，只有真浏览器能发现。
 * 所以这里刻意做一次真排版：
 *   ① 起一个**临时的、只读的**静态服务（随机端口，跟用户的 8787 无关，
 *      也绝不会去碰用户正在用的那个服务）；
 *   ② 用 headless Edge 通过 CDP 打开页面；
 *   ③ 在页面里 `getBoundingClientRect()` 量矩形，把结果算成
 *      可以判定的布尔值（中文栏是否在日文栏右边、两栏是否都有宽度）。
 *
 * ────────────────────────────────────────────────────────────────────
 * 它不做的事（刻意的边界）
 * ────────────────────────────────────────────────────────────────────
 *   · 不测"内容对不对"（那是 test-render.mjs / test-http.mjs 的事）
 *   · 不测"好不好看"（审美没法断言）
 *   · 找不到 Edge 就**跳过并说明**，不算失败 —— 不能因为测试机没装浏览器
 *     就让整个自检变红，那样人就会开始忽略它。
 *
 * 用法：
 *   node tools/qa-layout.mjs            # 自检（起自己的临时服务）
 *   node tools/qa-layout.mjs --verbose  # 把量到的每个矩形都打出来
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
  else { fail++; console.log(`  ✗ ${name}${extra ? '  — ' + extra : ''}`); }
}
function skip(name, why) { skipped++; console.log(`  · 跳过：${name}（${why}）`); }

// ---------------------------------------------------------------------------
// [0] 找浏览器。找不到就跳过 —— 见文件顶部说明。
// ---------------------------------------------------------------------------
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
const BROWSER = BROWSERS.find((p) => { try { return fs.existsSync(p); } catch { return false; } });

if (!BROWSER) {
  skip('真浏览器排版检查', '这台机器上没找到 Edge/Chrome');
  console.log(`\n  跳过 ${skipped} 项。要在有浏览器的机器上跑才能验证两栏排版。`);
  process.exit(0);
}
console.log(`  用 ${path.basename(BROWSER)} 做真排版检查`);

// ---------------------------------------------------------------------------
// [1] 临时静态服务
// ---------------------------------------------------------------------------
//
// ⚠️ 为什么自己起一个而不是用用户那个 8787：
//    这个脚本是**自检**的一部分，可能被反复跑、可能和用户的窗口同时跑。
//    去连用户的 8787 就得假设"服务已经开着"，还得往用户的服务里打请求；
//    而用户的服务正在被他使用。自己起一个随机端口的只读服务，
//    跑完就关，**互不干扰**，这才是自检该有的姿态。
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let rel = decodeURIComponent(url.pathname);
  // ⚠️ 应用里的模块用的是**以 /js/ 开头**的绝对路径
  //    （因为正式服务把 app/ 当作站点根：/js/ui.js 就是 app/js/ui.js）。
  //    这个临时服务是从项目根开始映射的（/app/js/ui.js），
  //    所以必须把 /js /css /assets 这几个前缀补上 /app，
  //    否则模块之间的 import 会全部 404 —— 而页面上只会显示
  //    一句干巴巴的 "Failed to fetch dynamically imported module"，
  //    完全指不到"路径前缀对不上"这个真实原因。
  for (const p of ['/js/', '/css/', '/assets/']) {
    if (rel.startsWith(p)) { rel = '/app' + rel; break; }
  }
  if (rel === '/') rel = '/app/__qa__/reading.html';

  // ── 接口转发 ──
  // ⚠️ 精读页要用 `/api/analyze`（分词 + 注音）才出得来两栏。
  //    临时服务本身**不实现任何接口** —— 那是 server.js 的活，
  //    在这里重写一份就等于造第二个真身，早晚和真身不一致。
  //    所以只做转发：把 /api/* 原样转给真正的服务，不改一个字节。
  //    ⚠️ 这条也有代价：**必须有一个真服务在跑**。
  //       没有就如实跳过，而不是硬造一个假接口糊过去。
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
  // 只读、且限制在项目目录内（这个脚本不该有能力去读别的地方）
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream' });
  fs.createReadStream(abs).pipe(res);
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const URL_UNDER_TEST = `http://127.0.0.1:${PORT}/app/__qa__/reading.html`;
const CDP_PORT = PORT + 1;   // 同一次 listen 出来的两个端口不会撞

// ---------------------------------------------------------------------------
// [2] 起浏览器，连 CDP
// ---------------------------------------------------------------------------
const profile = mkdtempSync(path.join(tmpdir(), 'jp-qa-'));
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
  skip('真浏览器排版检查', String(e.message || e));
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
// [3] 等页面把两栏渲染出来
// ---------------------------------------------------------------------------
let status = '';
for (let i = 0; i < 80; i++) {
  try {
    const s = await evaluate('(window.__QA && window.__QA.status) || document.title');
    if (s === 'ready' || s === 'no-reader' || s === 'QA 就绪' || s === 'QA 失败') { status = s; break; }
  } catch { /* 页面还在换 document */ }
  await sleep(250);
}

const qa = await evaluate('window.__QA ? JSON.parse(JSON.stringify(window.__QA)) : null');
if (qa && qa.errors && qa.errors.length) {
  console.log('  页面里报的错：');
  for (const e of qa.errors) console.log('    · ' + String(e).replace(/\n/g, '\n      '));
}

console.log('\n[1] 两栏阅读器在真浏览器里的排版');
ok(!!qa && qa.status === 'ready',
  '页面把 .air-reader 渲染出来了', qa ? `status=${qa.status}` : 'window.__QA 不存在');

const geo = await evaluate(`(() => {
  const r = document.querySelector('.air-reader');
  if (!r) return null;
  const rows = [...document.querySelectorAll('.air-row')].map((row) => {
    const ja = row.querySelector('.air-ja');
    const zh = row.querySelector('.air-zh');
    const a = ja && ja.getBoundingClientRect();
    const b = zh && zh.getBoundingClientRect();
    // ⚠️ 网格现在在 .air-head 上，不在 .air-row 上。
    //    为什么把网格下移一层：行头下面还要塞"语法讲解模块"，
    //    它需要**横跨两栏**（grid-column 1/-1）。网格留在 .air-row 上时
    //    那个模块只能占其中一格，看起来像"中文栏的一部分"而不是"这一句的讲解"。
    //    → 所以这里量的是 .air-head。量 .air-row 会读到 display:block，
    //      断言"每一行是 grid"就会永远红（这条测试就是这么被抓出来的）。
    const head = row.querySelector('.air-head') || row;
    return {
      jaW: a ? Math.round(a.width) : 0,
      zhW: b ? Math.round(b.width) : 0,
      jaX: a ? Math.round(a.x) : 0,
      zhX: b ? Math.round(b.x) : 0,
      rowH: Math.round(row.getBoundingClientRect().height),
      cols: getComputedStyle(head).gridTemplateColumns,
      display: getComputedStyle(head).display,
      direction: getComputedStyle(head).gridAutoFlow,
      jaText: ja ? ja.innerText.slice(0, 20) : '',
      zhText: zh ? zh.innerText.slice(0, 20) : '',
    };
  });
  const bar = document.querySelector('.air-bar');
  return {
    readerW: Math.round(r.getBoundingClientRect().width),
    rowCount: rows.length,
    rows,
    barText: bar ? bar.innerText.replace(/\\n/g, ' | ') : '',
    // 有没有把振假名渲染出来（<ruby> 元素）：日文栏能不能读的关键
    rubyCount: document.querySelectorAll('.air-ja ruby').length,
    // 中文栏是不是"空的占位"而不是真的没有节点
    zhPlaceholderCount: document.querySelectorAll('.air-zh-empty').length,
  };
})()`);

if (!geo) {
  ok(false, '量到了几何数据', '页面上没有 .air-reader');
} else {
  if (VERBOSE) console.log('\n  量到的原始数据：\n' + JSON.stringify(geo, null, 2));

  ok(geo.rowCount > 0, `量到了 ${geo.rowCount} 行`, String(geo.rowCount));
  ok(geo.readerW > 600, `阅读器宽度正常（${geo.readerW}px）`, String(geo.readerW));

  // ★★ 这一条就是用户那句"左边日文右边中文"的机器化表达
  const allRight = geo.rows.every((r) => r.zhX >= r.jaX + r.jaW - 2);
  ok(allRight, '★★ 中文栏在日文栏的右边（这就是"左右对照"）',
    geo.rows.map((r) => `ja@${r.jaX}+${r.jaW} zh@${r.zhX}`).join(' / '));

  const allWide = geo.rows.every((r) => r.jaW > 200 && r.zhW > 200);
  ok(allWide, '★ 两栏都有真实宽度（没有被压成 0 或上下叠成一行）',
    geo.rows.map((r) => `${r.jaW}/${r.zhW}`).join(' / '));

  // 两栏宽度应该接近（1fr 1fr）。差太多说明某一栏被内容撑歪了。
  const ratioOk = geo.rows.every((r) => r.jaW > 0 && Math.abs(r.jaW - r.zhW) / r.jaW < 0.25);
  ok(ratioOk, '两栏宽度接近相等（grid 1fr 1fr 生效了，没被内容撑歪）',
    geo.rows.map((r) => r.cols).join(' | '));

  ok(geo.rows.every((r) => r.display === 'grid'),
    '每一行确实是 grid 布局（不是被某个 display 覆盖掉）',
    geo.rows.map((r) => r.display).join(','));

  ok(geo.rubyCount > 0, `日文栏里有振假名（${geo.rubyCount} 个 ruby 元素）`);
  ok(geo.rows.every((r) => r.jaText.length > 0), '每一行的日文栏都有文字');

  ok(/还(有|没有).*译文|段/.test(geo.barText),
    '工具条上写着"还有几段没译文"', geo.barText);
  ok(/自动翻译/.test(geo.barText), '工具条上有「自动翻译全部段落」按钮', geo.barText);
}

console.log('\n[2] 窄屏（手机宽度）下两栏要改成一栏，不能挤成两条细缝');
{
  await send('Emulation.setDeviceMetricsOverride', {
    width: 420, height: 900, deviceScaleFactor: 1, mobile: true,
  });
  await sleep(400);
}
const narrow = await evaluate(`(() => {
  const row = document.querySelector('.air-row');
  if (!row) return null;
  const ja = row.querySelector('.air-ja');
  const zh = row.querySelector('.air-zh');
  const a = ja && ja.getBoundingClientRect();
  const b = zh && zh.getBoundingClientRect();
  // 同上：网格在 .air-head 上（窄屏的媒体查询也跟着改了选择器）
  const head = row.querySelector('.air-head') || row;
  return {
    jaW: a ? Math.round(a.width) : 0,
    zhW: b ? Math.round(b.width) : 0,
    jaY: a ? Math.round(a.y) : 0,
    zhY: b ? Math.round(b.y) : 0,
    cols: getComputedStyle(head).gridTemplateColumns,
  };
})()`);
if (!narrow) {
  ok(false, '窄屏下量到了几何数据');
} else {
  if (VERBOSE) console.log('\n  窄屏原始数据：\n' + JSON.stringify(narrow, null, 2));
  // 窄屏下应该是上下叠（中文栏在日文栏下面），或者两栏都还够宽。
  // 关键是"不能出现两条各只有几十像素的细缝" —— 那种状态两栏都没法读。
  const stacked = narrow.zhY >= narrow.jaY + 10;
  const stillWide = narrow.jaW > 200 && narrow.zhW > 200;
  ok(stacked || stillWide,
    '★ 窄屏下要么上下叠、要么两栏都还够宽（没有变成两条细缝）',
    `jaW=${narrow.jaW} zhW=${narrow.zhW} stacked=${stacked} cols=${narrow.cols}`);
}

// ---------------------------------------------------------------------------
// [3] 首页：两个模块之间的"块间距"必须大于块内间距
// ---------------------------------------------------------------------------
//
// 用户反馈原话：「首页的『功能』和『运行环境』这两个模块离得有点太近了，
// 把这两个模块的间距改大一些。」
//
// 为什么这条必须用真浏览器量：
//   这是一个**纯几何 / 纯视觉层级**问题。`test-render.mjs` 用的假 DOM
//   没有排版引擎 —— 它能证明"两个节点都在"，但 `.tiles` 有没有下边距、
//   下边距是 0 还是 34px，它完全看不出来（对假 DOM 来说节点父子关系没变）。
//   和本文件顶部说"两栏有没有真的并排"是同一类问题：只有真排版才算数。
//
// 量的东西（都不靠"猜一个像素值"，而是**互相比大小**）：
//   · 网格**内部**的元素间距 = computed gap（块内）
//   · 网格**底部**到下一张卡的**顶部**的距离（块间）
//   要求「块间 > 块内」。原来的 bug 正是两者**相等**（都是 14px），
//   于是视觉上糊成一片、分不出是两个模块。
//   用"比大小"而不是"必须等于 34px"，是为了让这条断言在
//   合理调整（比如以后改成 40px）时**不会误报**。
console.log('\n[3] 首页：「功能」和「运行环境」之间的块间距');
// ⚠️ 上一段把视口 emulate 成了 420px 的手机宽度，而且**这个覆盖会一直生效**。
//    不在这里恢复的话，下面量到的是窄屏布局（.tiles 只有 1 列）——
//    虽然间距结论仍然成立，但量的不是用户看到的那套版式。
//    （这类"上一段的设置漏了恢复"很容易让后面所有测量都悄悄跑在错误的视口上。）
try {
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(300);
} catch { /* 没设置过就算了 */ }
try {
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/app/index.html#/home` });
  await sleep(1200);

  // 等首页渲染出 .tiles（视图是异步加载的，不能马上量）
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      ready = await evaluate(`!!document.querySelector('.tiles')`);
      if (ready) break;
    } catch { /* 页面还在换 */ }
    await sleep(250);
  }
  ok(ready, '首页渲染出了「功能」的 .tiles 网格');

  if (ready) {
    const gap = await evaluate(`(() => {
      const tiles = document.querySelector('.tiles');
      const cs = getComputedStyle(tiles);
      const tRect = tiles.getBoundingClientRect();
      // 下一张卡：网格之后最近的 .card（就是「运行环境」那张）
      let next = tiles.nextElementSibling;
      while (next && !next.classList.contains('card')) next = next.nextElementSibling;
      if (!next) return { err: '网格后面找不到 .card' };
      const cRect = next.getBoundingClientRect();
      const cCS = getComputedStyle(next);
      return {
        // 块内间距：网格自己声明的 gap
        innerGap: parseFloat(cs.rowGap || cs.gap) || 0,
        // 块间间距：网格底部 → 卡顶部（真实的视觉空白）
        between: Math.round(cRect.top - tRect.bottom),
        tilesMarginBottom: parseFloat(cs.marginBottom) || 0,
        cardMarginTop: parseFloat(cCS.marginTop) || 0,
        // 卡里第一行文字，确认找到的确实是「运行环境」
        cardHeading: (next.querySelector('h3') || {}).textContent || '',
      };
    })()`);

    if (VERBOSE) console.log('\n  首页间距原始数据：\n' + JSON.stringify(gap, null, 2));

    if (gap && gap.err) {
      ok(false, '能定位到网格后面的「运行环境」卡片', gap.err);
    } else {
      ok(gap.cardHeading.includes('运行环境'),
        '网格后面那张卡确实是「运行环境」', `h3=${gap.cardHeading}`);
      // 反向：确认量到了真实的非零数字（防止"两边都是 0"这种假通过）
      ok(gap.innerGap > 0, `量到了网格的内部间距（${gap.innerGap}px）`,
        '内部间距是 0，说明选择器或 CSS 没读到 —— 那样下面的比较就没意义');
      ok(gap.between > 0, `量到了网格到下一张卡的距离（${gap.between}px）`,
        '距离是 0，说明两张卡片可能贴在一起了');
      ok(gap.between > gap.innerGap,
        `★ 块间距（${gap.between}px）大于块内间距（${gap.innerGap}px）—— 两块分得开`,
        `块间 ${gap.between}px 没有大于块内 ${gap.innerGap}px：` +
        '这正是用户反馈"离得太近"的状态（原来两者都是 14px，视觉上糊成一片）');
      // 再给一个绝对底线：块间距至少 24px 才算"明显分开"
      ok(gap.between >= 24,
        `★ 块间距至少 24px（实测 ${gap.between}px）`,
        '太小了，仍然会看起来像同一个模块的一部分');
    }
  }
} catch (e) {
  ok(false, '首页间距检查跑完', String(e.message || e));
}

// ---------------------------------------------------------------------------
// [4] 语法左栏简介必须被截到 3 行（用户报"有的简介过长"）
//
// 为什么这件事**必须**真浏览器来测：
//   这条样式靠的是 `-webkit-line-clamp`，而它是一个**只在有排版引擎时才有意义**
//   的属性。假 DOM（test-render.mjs 用的那套）没有排版，`getComputedStyle`
//   根本不存在，CSS 文件写没写、写对没写对，假 DOM 一律看不见。
//   而且 `-webkit-line-clamp` 生效还需要 `display:-webkit-box` +
//   `-webkit-box-orient:vertical` **同时**成立 —— 少一个，属性就静默失效、
//   页面看起来"还是老样子"，没有任何报错。所以只能量真实高度。
//
// 反向断言（防止假通过）：
//   ⚠️ 这里**不能**用"自然高度有没有超过 3 行"来防假跑。
//   `-webkit-line-clamp` 是**绘制阶段**的截断 —— 元素的布局高度就是 3 行，
//   而 `getClientRects()` 量的是**布局结果**，所以就算文字自然有 14 行，
//   它也会老老实实报"3 行"。第一版我就是这么写的，于是永远量到 0 个超长条目，
//   断言 ERROR 地失败（见文件末尾的教训记录）。
//   替代做法：用**文本长度**判断"这条简介本来就装不进 3 行"。
//   实测每行约 22 个汉字，3 行约 66 字；取 70 字作为"肯定超过 3 行"的门槛。
// ---------------------------------------------------------------------------
console.log('\n[4] 语法左栏：条目简介被截到 3 行');
try {
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/app/index.html#/grammar` });
  await sleep(1500);

  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      ready = await evaluate(`document.querySelectorAll('.gram-row-meaning').length > 0`);
      if (ready) break;
    } catch { /* 页面还在换 */ }
    await sleep(250);
  }
  ok(ready, '语法页渲染出了左栏条目（.gram-row-meaning）');

  if (ready) {
    // 先在**桌面视口**下量（上面几段都恢复过，这里再确认一次）
    const r = await evaluate(`(() => {
      const nodes = [...document.querySelectorAll('.gram-row-meaning')];
      const cs = getComputedStyle(nodes[0]);
      const fs2 = parseFloat(cs.fontSize) || 0;
      const lhRaw = parseFloat(cs.lineHeight) || 0;
      const lineH = lhRaw > 4 ? lhRaw : fs2 * (lhRaw || 1.5);
      const heights = nodes.map((n) => Math.round(n.getBoundingClientRect().height));
      return {
        count: nodes.length,
        display: cs.display,
        clampProp: cs.webkitLineClamp || cs.getPropertyValue('-webkit-line-clamp') || '',
        clampStd: cs.getPropertyValue('line-clamp') || '',
        orient: cs.webkitBoxOrient || cs.getPropertyValue('-webkit-box-orient') || '',
        overflow: cs.overflowY || cs.overflow,
        lineH: Math.round(lineH * 10) / 10,
        maxH: Math.max.apply(null, heights),
        // "本来就装不进 3 行"的条目：按字数算（每行约 22 字）
        tooLongByChars: nodes.filter((n) => (n.textContent || '').length >= 70).length,
        titleOk: nodes.filter((n) => (n.getAttribute('title') || '').length > 0).length,
        titleSample: (nodes.find((n) => (n.getAttribute('title') || '').length > 70) || {}).title || '',
        textSample: (nodes.find((n) => (n.textContent || '').length > 70) || {}).textContent || '',
      };
    })()`);

    if (VERBOSE) console.log('\n  语法左栏原始数据：\n' + JSON.stringify(r, null, 2));

    // 反向：先确认页面上**确实有**装不进 3 行的长简介，否则下面"都没超过 3 行"是空跑
    ok(r.tooLongByChars > 5,
      `存在本来装不进 3 行的长简介（${r.tooLongByChars} 条 ≥70 字）—— 截断不是空跑`,
      '这一页没有一条长简介，下面那条断言就证明不了什么');

    ok(String(r.clampProp) === '3', `-webkit-line-clamp 生效（计算值 "${r.clampProp}"）`);
    // ⚠️ 不断言 display === '-webkit-box'：Chromium 对**生效中的** line-clamp 盒子
    //    把 computed display 报成 `flow-root`（这是浏览器自己的规范化）。
    //    真正要断言的是"属性被接受了" —— 也就是下面 clamp=3 且高度被压到 3 行。
    //    断言字面值反而会误报（第一版就是这么红的）。
    ok(r.display === '-webkit-box' || r.display === 'flow-root',
      `display 是 -webkit-box（浏览器计算值 "${r.display}"）`,
      '既不是 -webkit-box 也不是 flow-root，说明这条规则根本没匹配上');
    ok(String(r.orient).includes('vertical'), `-webkit-box-orient 是 vertical（实际 "${r.orient}"）`);
    ok(r.overflow === 'hidden', `overflow 是 hidden（实际 "${r.overflow}"）`);
    const cap = Math.round(r.lineH * 3);
    ok(r.maxH <= cap + 2,
      `★ 没有一条简介超过 3 行（最高 ${r.maxH}px，3 行 = ${cap}px）`,
      `最高 ${r.maxH}px 超过 3 行的 ${cap}px —— 截断没生效`);
    // 断言"真的被压扁了"：最长的那条（≥70 字）也在 3 行以内
    ok(r.textSample.length >= 70 && r.maxH <= cap + 2,
      `最长的一条（${r.textSample.length} 字）也被压到 3 行内`);
    // 完整简介不能因此丢掉：详情页里有全文，悬停也有 title
    ok(r.titleOk === r.count,
      `${r.count} 条简介全部带 title（悬停可看全文）`,
      `只有 ${r.titleOk}/${r.count} 条带 title，截断后用户就再也看不到全文了`);
    ok(r.titleSample.length >= r.textSample.length - 2 && r.titleSample.length > 70,
      `title 里是**完整**简介（${r.titleSample.length} 字），不是被截过的`);
  }
} catch (e) {
  ok(false, '语法左栏截断检查跑完', String(e.message || e));
}

cleanup();
console.log('\n' + '='.repeat(74));
console.log(fail === 0
  ? ` 全部通过（${pass} 项${skipped ? `，跳过 ${skipped} 项` : ''}）`
  : ` ${fail} 项未通过（通过 ${pass} 项）`);
console.log('='.repeat(74));
process.exit(fail === 0 ? 0 : 1);
