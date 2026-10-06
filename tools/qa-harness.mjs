/**
 * qa-harness.mjs —— 真浏览器自检的**共用骨架**。
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么要有这个文件
 * ────────────────────────────────────────────────────────────────────
 * `qa-layout / qa-bugs / qa-nav` 这三个脚本要做的事情是一样的：
 *   ① 起一个**临时只读**静态服务（随机端口，和用户正在用的服务无关）
 *   ② 把 `/api/*` **原样转发**给真服务（不重写一份接口）
 *   ③ 用 headless Edge/Chrome 通过 CDP 打开一个 `app/__qa__/*.html` 载荷
 *   ④ 在页面里登记好一个个 `window.__QA.check.*`，由 node 侧逐个调用并判定
 *   ⑤ 找不到浏览器就**跳过并说明**，不算失败
 *
 * 这套东西我抄到第三遍的时候决定抽出来：抄出来的每一份都会各自漂移，
 * 而"测试基础设施漂移"是最难发现的一类问题 —— 你会以为在测同一件事。
 *
 * ────────────────────────────────────────────────────────────────────
 * 约定：页面侧只"观察"，node 侧只"判定"
 * ────────────────────────────────────────────────────────────────────
 * 载荷（`app/__qa__/*.js`）把每个断言做成一个返回 `{ok, note, extra}` 的函数，
 * 挂在 `window.__QA.check` 上。**判定逻辑留在 node 侧**，页面只负责
 * "把真实世界看到的东西如实报回来"。
 *
 * 这样做的理由很实际：headless 里没有控制台可看，页面自己 console.log
 * 等于没打印。一旦出错就只剩"页面一片空白"，分不清
 * "模块没加载"和"渲染时抛了错"。
 *
 * 用法：
 *   import { runQa } from './qa-harness.mjs';
 *   await runQa({
 *     title: '五个 bug 的真交互验证',
 *     page: 'bugs.html',            // app/__qa__/ 下的载荷
 *     checks: [['fabOnBoot', '★ 查词按钮在首页就存在'], ...],
 *   });
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
// 浏览器临时用户目录的收尾（等进程退出 + 删目录 + 重试）—— 共用实现见该文件头。
// ⚠️ 原来这里只发个终止信号就完事，**从不删那个目录**，半年堆了 18.3 GB。
//    （写注释时别把这行写成被禁用的那种写法 —— check-deliverables 会红。）
import { finishBrowser } from './lib/qa-profile.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

export const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * 跑一个真浏览器自检。
 *
 * @param {object} o
 * @param {string} o.title   报告标题（打印用）
 * @param {string} o.page    `app/__qa__/` 下的载荷文件名
 * @param {Array<[string,string]>} o.checks   [检查名, 断言描述]
 * @param {(ctx:object)=>Promise<void>} [o.before]  逐条跑之前做的事（例如打印预置信息）
 * @param {(ctx:object)=>Promise<void>} [o.beforeChecks]  在正式断言**之前**调整环境（例如改视口宽度）
 * @param {(ctx:object)=>Promise<void>} [o.afterChecks]   断言之后复位环境
 * @param {boolean} [o.verbose] 是否打印每条检查的 extra
 * @returns {Promise<number>} 退出码（0=全绿）
 */
export async function runQa(o) {
  const VERBOSE = o.verbose !== undefined ? o.verbose : process.argv.includes('--verbose');
  let pass = 0;
  let fail = 0;
  let skipped = 0;

  const ok = (cond, name, extra = '') => {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}${extra ? `  — ${extra}` : ''}`); }
  };
  const skip = (name, why) => { skipped++; console.log(`  · 跳过：${name}（${why}）`); };
  const emit = () => {
    console.log('\n' + '='.repeat(74));
    console.log(fail === 0
      ? ` 全部通过（${pass} 项${skipped ? `，跳过 ${skipped} 项` : ''}）`
      : ` ${fail} 项未通过（通过 ${pass} 项）`);
    console.log('='.repeat(74));
  };

  // ---- [0] 找浏览器。找不到就跳过 —— 不能因为测试机没装浏览器就让自检变红 ----
  const BROWSER = BROWSERS.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!BROWSER) {
    skip(o.title, '这台机器上没找到 Edge/Chrome');
    console.log(`\n  跳过 ${skipped} 项。要在有浏览器的机器上跑才能验证这些交互。`);
    return 0;
  }
  console.log(`  用 ${path.basename(BROWSER)} 做真交互检查`);

  // ---- [1] 临时只读服务 ----
  //
  // ⚠️ 为什么自己起一个而不是用用户那个 8787：
  //    自检可能被反复跑、可能和用户的窗口同时跑。去连用户的 8787 就得假设
  //    "服务已经开着"，还得往用户正在用的服务里打请求。
  //    自己起一个随机端口的只读服务、跑完就关，互不干扰。
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
    // 应用里的模块用**以 /js/ 开头**的绝对路径（正式服务把 app/ 当站点根）
    for (const p of ['/js/', '/css/', '/assets/']) {
      if (rel.startsWith(p)) { rel = '/app' + rel; break; }
    }
    if (rel === '/') rel = '/app/__qa__/' + o.page;

    // `/api/*` 原样转发给真服务 —— 在这里重写一份接口等于造第二个真身
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
    // 只读 + 限制在项目目录内（这个脚本不该有能力去读别的地方）
    if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream' });
    fs.createReadStream(abs).pipe(res);
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const PORT = server.address().port;
  const URL_UNDER_TEST = `http://127.0.0.1:${PORT}/app/__qa__/${o.page}`;
  const CDP_PORT = PORT + 1;

  // ---- [2] 起浏览器，连 CDP ----
  const profile = mkdtempSync(path.join(tmpdir(), 'jp-qa-'));
  const child = spawn(BROWSER, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1200,1600',
    URL_UNDER_TEST,
  ], { stdio: 'ignore' });

  const cleanup = () => {
    // ⚠️ 必须走 finishBrowser：它**等浏览器真的退出**再删 profile。
    //    只 kill() 就删会 EBUSY（浏览器还攥着句柄），只 kill() 不删就是当年
    //    堆出 18.3 GB 的那个 bug。
    finishBrowser(child, profile);
    try { server.close(); } catch { /* 已经关了 */ }
  };
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
    skip(o.title, String(e.message || e));
    console.log(`\n  跳过 ${skipped} 项。`);
    return 0;
  }
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let msgId = 0;
  const waiting = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
  };
  const send = (method, params = {}) => {
    const myId = ++msgId;
    return new Promise((res) => { waiting.set(myId, res); ws.send(JSON.stringify({ id: myId, method, params })); });
  };
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (!r.result) throw new Error('CDP 没有返回结果：' + JSON.stringify(r).slice(0, 200));
    if (r.result.exceptionDetails) {
      throw new Error('页面里抛错：' + (r.result.exceptionDetails.exception
        ? r.result.exceptionDetails.exception.description : r.result.exceptionDetails.text));
    }
    return r.result.result ? r.result.result.value : undefined;
  };

  const ctx = { evaluate, send, sleep, ok, skip, emit, get pass() { return pass; }, get fail() { return fail; } };

  // ---- [3] 等页面就绪（页面自己会把 status 写成 ready / threw）----
  let status = '';
  for (let i = 0; i < 100; i++) {
    try {
      const s = await evaluate('(window.__QA && window.__QA.status) || document.title');
      if (s === 'ready' || s === 'threw') { status = s; break; }
    } catch { /* 页面还在换 document */ }
    await sleep(250);
  }

  if (o.before) await o.before(ctx);

  if (status === 'threw') {
    const errs = await evaluate('JSON.stringify(window.__QA.errors)');
    ok(false, '页面能在真浏览器里启动', String(errs).slice(0, 400));
  } else {
    ok(status === 'ready', '页面在真浏览器里启动完成', `status=${status}`);
  }

  // ---- [4] 逐条跑页面里登记好的检查 ----
  //
  // 每条检查可以带自己的视口宽度（`[name, title, width]`）——
  // 因为"窄屏下导航栏会不会被压扁"这类问题**必须在窄视口下量**，
  // 而把整份脚本跑两遍（一遍宽一遍窄）太慢，也没必要。
  console.log(`\n[1] ${o.title}`);
  for (const entry of o.checks) {
    const [name, title, width] = entry;
    if (width) {
      // ⚠️ mobile:false —— 用 mobile:true 时页面会按"移动端视口"重新计算，
      //    实测 window.innerWidth 报出来是 980（移动布局的默认宽度）而不是
      //    我们要的 420，于是"窄屏"断言其实量在宽屏上，等于没测。
      await send('Emulation.setDeviceMetricsOverride', {
        width, height: 900, deviceScaleFactor: 1, mobile: false,
      });
      // 等视口真的变过去（量宽度是最稳的判据，比 sleep 固定毫秒可靠）
      for (let i = 0; i < 20; i++) {
        try {
          const w = await evaluate('window.innerWidth');
          if (Math.abs(w - width) <= 8) break;
        } catch { /* 页面还在换 */ }
        await sleep(120);
      }
      await sleep(250);
    } else {
      await send('Emulation.clearDeviceMetricsOverride');
      await sleep(250);
    }
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
      console.log(`      [${name}] extra = ${JSON.stringify(res.extra).slice(0, 400)}`);
    }
    ok(res && res.ok, (width ? `[${width}px] ` : '') + title, (res && res.note) || '没有返回结果');
  }
  await send('Emulation.clearDeviceMetricsOverride');

  // 页面里自己报的异常也打出来（即使断言过了，也值得看一眼）
  const errs = await evaluate('JSON.stringify((window.__QA && window.__QA.errors || []).slice(0, 8))');
  let errList = [];
  try { errList = JSON.parse(errs) || []; } catch { /* 忽略 */ }
  if (errList.length) {
    console.log('\n  页面里报的异常：');
    for (const e of errList) console.log('    · ' + String(e).replace(/\n/g, '\n      ').slice(0, 240));
  }

  cleanup();
  emit();
  return fail === 0 ? 0 : 1;
}
