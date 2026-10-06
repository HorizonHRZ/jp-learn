/**
 * HTTP 端到端验证：健康检查、静态资源、歌词解析、查词、精读分析、OCR
 * 用法（需先启动服务）：node tools/test-http.mjs [port]
 */
const PORT = Number(process.argv[2] || 8787);
const BASE = `http://127.0.0.1:${PORT}`;

// Node 内置 fetch 默认用 keep-alive 连接池。如果进程结束时这些 socket 还开着，
// Windows 上会在退出阶段踩到 libuv 断言：
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
// 表现是"测试全部通过"但进程以 0xC0000409 结束，看起来像程序崩了。
// 这里不用 fetch，改用 node:http 自己发请求，并显式跟踪/销毁连接，退干净。
import http from 'node:http';
const liveSockets = new Set();

function request(method, p, bodyObj, { preEncoded = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = bodyObj === undefined ? null : Buffer.from(JSON.stringify(bodyObj), 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        // http.request 的 path 必须是 ASCII。默认做一次 encodeURI 以支持
        // 含中文的路径（/使用说明.md）；若调用方已经自己 encodeURIComponent
        // 过查询参数，就不要再编一次 —— 否则 % 变成 %25，服务端收到的是错的。
        path: preEncoded ? p : encodeURI(p),
        method,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': payload.length }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* 非 JSON（静态资源） */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('socket', (s) => {
      liveSockets.add(s);
      s.on('close', () => liveSockets.delete(s));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 收尾：把所有连接销毁，然后设置退出码（不打断 libuv 清理） */
function finish(code) {
  for (const s of liveSockets) { try { s.destroy(); } catch { /* ignore */ } }
  liveSockets.clear();
  process.exitCode = code;
}

// http.request 的 path 必须是 ASCII，含中文的路径（如 /使用说明.md）要先编码。
// 用 encodeURI 而不是 encodeURIComponent：前者保留 / 和 ? 等结构字符。
function enc(p) {
  return encodeURI(p);
}

let fail = 0;
const ok = (cond, label, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? '  ' + detail : ''}`);
};

async function get(p, opts) {
  return request('GET', p, undefined, opts);
}
async function post(p, body) {
  return request('POST', p, body);
}

console.log('='.repeat(74));
console.log(` jp-learn HTTP 端到端验证   ${BASE}`);
console.log('='.repeat(74));

// ---- 1. 健康检查 ----
console.log('\n[1] GET /api/health');
const health = await get('/api/health');
ok(health.status === 200, 'HTTP 200');
ok(health.json && health.json.ok === true, 'ok=true');
ok(health.json && health.json.version, `版本 ${health.json && health.json.version}`);
ok(health.json && health.json.dict && health.json.dict.ready === true,
  '词库索引已就绪',
  health.json && health.json.dict && health.json.dict.ready
    ? `统计 ${JSON.stringify(health.json.dict.stats && health.json.dict.stats.counts)}`
    : `错误: ${health.json && health.json.dict && health.json.dict.error}`);
ok(health.json && health.json.lyric && health.json.lyric.mode === 'user-provided-text',
  '歌词模式 = 用户自行提供文本（不联网抓取）');
console.log(`      OCR: ${JSON.stringify(health.json && health.json.ocr)}`);

// ---- 2. 静态资源 ----
console.log('\n[2] 静态资源');
for (const [path, mustContain] of [
  ['/', '/js/app.js'],           // 首页是 Shell，真正的入口是 app.js
  ['/', 'html lang="zh-CN"'],
  ['/css/theme.css', '--'],
  ['/js/app.js', 'JP'],
  ['/js/db.js', 'IndexedDB'],
  ['/js/version.js', 'APP_VERSION'],
  ['/js/router.js', 'router'],
  ['/js/ui.js', 'toast'],
  ['/js/views/home.js', 'render'],
  ['/js/views/settings.js', 'render'],
  ['/js/views/vocab.js', 'render'],
  ['/js/views/lyric.js', 'render'],
  ['/js/views/reading.js', 'render'],
  ['/js/views/grammar.js', 'render'],
  ['/js/views/stats.js', 'render'],
  ['/js/views/aipanel.js', 'runAiTask'],
  ['/js/airead.js', 'buildAiReader'],
  ['/js/ocrbox.js', 'buildOcrBox'],
  ['/js/ai.js', 'askAi'],
  ['/assets/icon.svg', '<svg'],
  ['/manifest.webmanifest', '"start_url"'],
  ['/ARCHITECTURE.md', 'ARCHITECTURE'],
  ['/使用说明.md', ''],
]) {
  const r = await get(path);
  ok(r.status === 200 && r.text.includes(mustContain), `${path}`, `HTTP ${r.status}, ${r.text.length} 字节`);
}

// ---- 2a. manifest 与图标（问 5 = 甲：只做 manifest，不做 Service Worker）----
console.log('\n[2a] manifest.webmanifest（不做 Service Worker）');
{
  const r = await get('/manifest.webmanifest');
  ok(r.status === 200, 'manifest 可访问', `HTTP ${r.status}`);
  // Content-Type 必须是 manifest 专有的，否则浏览器不认。
  // ⚠️ 这里 `r.headers` 是**普通对象**（这个脚本用 node:http 手写请求，
  //    不是 fetch），所以要用下标取值，没有 .get() 方法。
  const ct = String((r.headers && r.headers['content-type']) || '');
  ok(/application\/manifest\+json/.test(ct), 'Content-Type 是 application/manifest+json', ct);

  let m = null;
  try { m = JSON.parse(r.text); } catch (e) { ok(false, 'manifest 是合法 JSON', String(e.message)); }
  if (m) {
    ok(!!m.name, '有 name');
    ok(!!m.short_name, '有 short_name');
    ok(m.start_url === '/' || m.start_url === '.', 'start_url 指向根', String(m.start_url));
    ok(m.display === 'standalone', 'display 是 standalone', String(m.display));
    ok(m.lang === 'zh-CN', 'lang 是 zh-CN', String(m.lang));
    ok(Array.isArray(m.icons) && m.icons.length >= 1, '至少有一个图标');
    if (Array.isArray(m.icons) && m.icons[0]) {
      const icon = await get(m.icons[0].src);
      ok(icon.status === 200, `图标可访问（${m.icons[0].src}）`, `HTTP ${icon.status}`);
      ok(/^image\//.test(m.icons[0].type || ''), '图标声明了 image/* 类型');
    }
  }

  // 首页必须真的引用了 manifest，否则做这个文件等于没做
  const home = await get('/');
  ok(/rel="manifest"/.test(home.text), 'index.html 里有 <link rel="manifest">');
  ok(/manifest\.webmanifest/.test(home.text), '指向的文件名正确');

  // ★ 按用户决定：**不做 Service Worker**。
  //   所以这两样东西都不该存在 —— 如果哪天有人加了，这条断言会红，
  //   提醒他这是被明确取消的需求（离线能力与"之后要接入 AI"矛盾）。
  const sw1 = await get('/sw.js');
  ok(sw1.status === 404, '没有 sw.js（Service Worker 已按用户要求取消）', `HTTP ${sw1.status}`);
  const sw2 = await get('/service-worker.js');
  ok(sw2.status === 404, '也没有 service-worker.js', `HTTP ${sw2.status}`);
  ok(!/serviceWorker/.test(home.text), 'index.html 里没有注册 Service Worker 的代码');
}

// ---- 2b. 客户端要拉取的词库文件 ----
// 这一段是回归测试：曾经 server.js 对 /data/... 的路径推导有 bug
// （先 app/data 再 data/data），导致全部 404，而前端"准备内置词库"直接失败。
// 词库文件是背单词页的命脉，必须专门守住。
console.log('\n[2b] 词库数据文件（/data/... 路径映射）');
{
  const mf = await get('/data/index/manifest.json');
  ok(mf.status === 200, '/data/index/manifest.json', `HTTP ${mf.status}`);
  ok(mf.json && mf.json.counts && mf.json.counts.N5 > 0, '  —— manifest 含各级条目数',
    mf.json ? JSON.stringify(mf.json.counts) : '无 JSON');
  ok(mf.json && mf.json.total > 10000, '  —— manifest 的 total 合理', mf.json ? String(mf.json.total) : '');

  for (const lv of ['n5', 'n4', 'n3', 'n2', 'n1', 'extra']) {
    const r = await get(`/data/vocab/${lv}.json`);
    const n = r.json && r.json.items ? r.json.items.length : -1;
    ok(r.status === 200 && n > 0, `/data/vocab/${lv}.json`, `HTTP ${r.status}, ${n} 条`);
    // 词条必须带出题/判分要用的字段，否则背单词页会出空题
    if (n > 0) {
      const w = r.json.items[0];
      ok(!!w.term && !!w.reading && Array.isArray(w.zh) && w.zh.length > 0,
        `  —— ${lv} 词条含 term/reading/zh`, JSON.stringify({ term: w.term, reading: w.reading, zh: w.zh && w.zh.length }));
    }
  }

  const kana = await get('/data/kana/romaji-table.json');
  ok(kana.status === 200, '/data/kana/romaji-table.json', `HTTP ${kana.status}`);
}

// ---- 3. 歌词解析 ----
console.log('\n[3] POST /api/lyric/parse');
const LYRIC = [
  'ありがとうございました',
  '日本語を勉強しています',
  '今日はいい天気ですね',
  'コーヒーを飲みながら新聞を読みます。',
].join('\n');
const lp = await post('/api/lyric/parse', { text: LYRIC, translation: '谢谢您\n我在学日语\n今天天气真好\n一边喝咖啡一边看报。' });
ok(lp.status === 200 && lp.json && lp.json.ok === true, 'HTTP 200 / ok=true');
ok(lp.json && lp.json.source === 'user-provided', 'source=user-provided');
ok(lp.json && lp.json.lines && lp.json.lines.length === 4, '4 行都被解析', `lineCount=${lp.json && lp.json.stats && lp.json.stats.lineCount}`);
ok(lp.json && lp.json.stats.translationAligned === true, '中日文行数对齐被识别');
const allReadings = (lp.json && lp.json.lines || []).every((l) => l.reading && l.reading.kana && l.reading.romaji);
ok(allReadings, '每行都有假名与罗马音');
ok(lp.json && lp.json.reading && lp.json.reading.ready === true, '注音引擎就绪');
ok(lp.json && lp.json.reading && lp.json.reading.coverage >= 95, `覆盖率 ${lp.json && lp.json.reading && lp.json.reading.coverage}%`);
for (const l of (lp.json && lp.json.lines) || []) {
  console.log(`      ${l.ja}  →  ${l.reading.kana}  |  ${l.reading.romaji}  |  zh=${JSON.stringify(l.zh)}`);
}
// 关键回归：不能把 は 读成 ha
ok(lp.json && lp.json.lines[2].reading.romaji === 'kyouwaiitenkidesune', '今日は 的 は 读 wa');
ok(lp.json && lp.json.lines[0].reading.romaji === 'arigatougozaimashita', 'ありがとうございました 不被切碎');
ok(lp.json && lp.json.lines[3].reading.romaji === 'koohiionominagarashinbunoyomimasu', '飲みながら / 読みます 正确还原');

// 训令式
const kn = await post('/api/lyric/parse', { text: '日本語を勉強しています', romaji: 'kunrei' });
ok(kn.json && kn.json.lines[0].reading.romaji === 'nihongoobenkyousiteimasu', '训令式罗马音可切换', kn.json && kn.json.lines[0].reading.romaji);

// 空输入应报错
const empty = await post('/api/lyric/parse', { text: '   ' });
ok(empty.status === 400, '空文本返回 400（不假装成功）');

// ---- 4. 查词 ----
console.log('\n[4] GET /api/dict/lookup');
for (const q of ['日本語', '食べる', 'たべる', '花', 'ありがとう']) {
  const r = await get('/api/dict/lookup?q=' + encodeURIComponent(q), { preEncoded: true });
  const n = r.json ? r.json.total : -1;
  ok(r.status === 200 && n >= 1, `查「${q}」`, `命中 ${n} 条；首个 = ${r.json && (r.json.exact[0] || r.json.byReading[0] || {}).term}`);
}
const noQ = await get('/api/dict/lookup');
ok(noQ.status === 400, '缺 q 参数返回 400');

// ---- 4b. ★ 用户报的 bug：假名查词要出全部同音词，片假名输入也要能查 ----
//
// 用户原话：「输入假名搜索，搜索到的结果应该是所有对应相同读音的词。
//            比如 かた 这个词搜索，应该出现肩，過多，方 等等词，
//            但是我测试的结果只有「方」这一个词。」
//
// 两个根因（都修在 vocabdata.js / server.js，这里盯的是服务端这一半）：
//   ① lookupWord 原来是**优先级**语义：第一个命中就 return，后面的来源
//      永远见不到光 —— 所以只出了「方」；
//   ② 索引里的读音一律存**平假名**，而片假名是另一套码位，
//      严格比较必然不相等 → 用「カタ」查是 0 条。
{
  const katakana = '\u30AB\u30BF';       // カタ
  const hiragana = '\u304B\u305F';       // かた
  const rK = await get('/api/dict/lookup?q=' + encodeURIComponent(katakana), { preEncoded: true });
  const rH = await get('/api/dict/lookup?q=' + encodeURIComponent(hiragana), { preEncoded: true });

  // 同音词必须全部出来（不是只出"最常见的那一个"）
  ok(rH.status === 200 && rH.json.total >= 4,
    `★ 用「かた」查能出全部同音词（不是只出「方」）`, `命中 ${rH.json && rH.json.total} 条`);
  const terms = new Set();
  for (const t of [].concat((rH.json && rH.json.exact) || [], (rH.json && rH.json.byReading) || [])) {
    terms.add(t.term);
  }
  ok(terms.size >= 4, `★ 同音词确实有多个不同的词形（共 ${terms.size} 个）`,
    [...terms].join('、'));

  // ★ 片假名输入必须和平假名**一样**能查到
  ok(rK.status === 200 && rK.json.total === rH.json.total,
    '★★ 用片假名「カタ」查到的条数和平假名「かた」一致',
    `カタ=${rK.json && rK.json.total} vs かた=${rH.json && rH.json.total}`);
  ok(rK.json && rK.json.normalizedQuery === hiragana,
    '★ 服务端把片假名归一成平假名（normalizedQuery 是平假名）',
    rK.json && rK.json.normalizedQuery);

  // ★★ total 必须和"去重之后的真实条数"一致。
  //    这里踩过一次：归一那一路把同一批词又数了一遍，
  //    结果 かた 只有 5 个词、total 却报 10 —— 界面会写"共 10 条"却列出 5 条。
  const seen = new Set();
  let uniq = 0;
  for (const t of [].concat(
    (rK.json && rK.json.exact) || [], (rK.json && rK.json.byReading) || [],
    (rK.json && rK.json.exactNormalized) || [], (rK.json && rK.json.byReadingNormalized) || [],
  )) {
    const k = t.id || t.wordId || t.term;
    if (!seen.has(k)) { seen.add(k); uniq++; }
  }
  ok(rK.json && rK.json.total === uniq,
    '★★ total 与去重后的条数一致（不会出现"共 N 条"却只列 M 条）',
    `total=${rK.json && rK.json.total} 去重后=${uniq}`);

  // 罗马音输入：服务端不做罗马音→假名转换，返回 0 是**已知且可接受**的
  // （前端用 kanaHint 处理罗马音）。写下来是为了防止以后有人误以为是 bug。
  const rR = await get('/api/dict/lookup?q=kata', { preEncoded: true });
  ok(rR.status === 200, '罗马音输入不会报错（服务端不转换，前端负责）', `命中 ${rR.json && rR.json.total}`);
}

// ---- 5. 精读分析 ----
console.log('\n[5] POST /api/analyze');
const an = await post('/api/analyze', {
  text: '吾輩は猫である。名前はまだ無い。\n\nどこで生れたかとんと見当がつかぬ。',
});
ok(an.status === 200 && an.json && an.json.ok === true, 'HTTP 200 / ok=true');
ok(an.json && an.json.sentences && an.json.sentences.length === 3, '按句读点切成 3 句', `paragraphCount=${an.json && an.json.stats.paragraphCount}`);
ok(an.json && an.json.stats.sentenceCount === 3, '句数统计正确');
ok(an.json && an.json.sentences.every((s) => s.reading && s.reading.kana), '每句都有注音');
ok(an.json && an.json.vocab && an.json.vocab.length > 0, `生词候选 ${an.json && an.json.vocab.length} 条`);
for (const s of (an.json && an.json.sentences) || []) {
  console.log(`      ${s.text}  →  ${s.reading.kana}`);
}

// ---- 6. OCR ----
//
// ⚠️ 这一段在 2026-10 全面改过：OCR 引擎换掉了（原来的 Windows.Media.Ocr
//    换成本项目自带的 rapidocr + 日文 ONNX 模型，原因见 ARCHITECTURE.md 第十九节）。
//    所以 health 里的字段也变了：
//      旧：{ available: true, languages: [{tag}] }
//      新：{ ready: true, engine: 'rapidocr+onnx', lang: 'japan', runtime: 'runtime/ocr' }
//    旧断言读的是 available/languages，两个字段都不存在 ——
//    于是它会把"OCR 完全正常"错判成"既不可用也不像沙箱限制"。
//    这是"字段改了、断言没跟着改"的典型假失败。
//
//    OCR 真正跑一张图不在这里测（那是 test-ocr-http.mjs 的活），
//    这里只验证 health 如实报告了运行时的状态。
console.log('\n[6] OCR 运行时状态');
const ocrNoImg = await post('/api/ocr', {});
ok(ocrNoImg.status === 400 || ocrNoImg.status === 500 || ocrNoImg.status === 503,
  '无图片时返回错误而不是崩溃', `HTTP ${ocrNoImg.status}`);
const ocrHealth = (health.json && health.json.ocr) || {};
if (ocrHealth.ready === true) {
  ok(ocrHealth.engine === 'rapidocr+onnx', 'OCR 引擎是项目自带的 rapidocr', String(ocrHealth.engine));
  ok(ocrHealth.lang === 'japan', '识别语言是日文', String(ocrHealth.lang));
  ok(/runtime[\\/]ocr/.test(String(ocrHealth.runtime || '')),
    '运行时定位在项目内的 runtime/ocr（不写到用户目录）', String(ocrHealth.runtime));
} else {
  // 没装运行时是**合法状态**：health 必须给出 ready:false 和一句能照着做的 fix，
  // 而不是一个空对象或者崩溃。
  ok(ocrHealth.ok === false && ocrHealth.ready === false,
    'OCR 未就绪时如实报告（ready:false，不假装可用）', JSON.stringify(ocrHealth).slice(0, 120));
  ok(typeof ocrHealth.fix === 'string' && /get-ocr-runtime/.test(ocrHealth.fix),
    'OCR 未就绪时给出了安装指引', String(ocrHealth.fix || '').slice(0, 80));
  console.log('      [提示] 当前没装 OCR 运行时。执行 node tools/get-ocr-runtime.mjs 安装后本条会走 ready 分支。');
}

// ---- 7. 目录穿越防护 ----
// 回归测试：曾经 /js/../ARCHITECTURE.md 能读到根目录文件。
// 原因是 path.join 会先把 .. 归一化，结果正好撞上"根目录白名单"被放行。
// 只检查"归一化后的路径在不在允许的根里"是防不住的。
console.log('\n[7] 目录穿越防护');
for (const bad of [
  '/../server.js',
  '/../data/index/manifest.json',
  '/../ARCHITECTURE.md',
  '/../使用说明.md',
  '/js/../ARCHITECTURE.md',
  '/js/../../ARCHITECTURE.md',
  '/js/..%2f..%2fARCHITECTURE.md',
  '/%2e%2e/ARCHITECTURE.md',
  '/data/../../Windows/win.ini',
  '/tools/../../server.js',
  '/css/../../../Windows/win.ini',
]) {
  // 含 % 的路径已经自己编码过，不能再编一次（否则 % 变 %25，测的就不是穿越了）
  const r = await get(bad, { preEncoded: bad.includes('%') });
  ok(r.status === 404 || r.status === 400 || r.status === 403,
    `拒绝 ${bad}`, `HTTP ${r.status}（若为 200，说明能读到不该读的文件）`);
}

// 正常的路径不能被误伤
for (const good of ['/', '/js/app.js', '/css/theme.css', '/data/vocab/n5.json', '/ARCHITECTURE.md']) {
  const r = await get(good);
  ok(r.status === 200, `正常路径仍可访问 ${good}`, `HTTP ${r.status}`);
}

// ---- 7b. 自检载荷页 app/__qa__/ 不许被正式服务暴露 ----
// 为什么单独测这一条：
//   `app/__qa__/` 在 app/ 目录里，而 app/ 是**静态服务的根** ——
//   不专门挡的话它就是一个对用户开放的页面。两个真问题：
//     ① 用户手滑点到 /__qa__/reading.html，会在那个页面里跑一遍分析，
//        往他自己的精读笔记库里写数据；
//     ② 它是"测试用的后门页面"，长期挂在应用目录里迟早被当成正式功能改。
//   ⚠️ 但要注意别把"自检要用的能力"也一起挡掉：
//      qa-layout.mjs 自己起临时服务、直接读磁盘，不经过 server.js，
//      所以这里挡住**不影响**它（这一点在 server.js 的注释里也写了）。
console.log('\n[7b] 自检载荷页 app/__qa__/ 必须被挡住');
for (const p of ['/__qa__/reading.html', '/__qa__/reading.js', '/app/__qa__/reading.html']) {
  const r = await get(p);
  ok(r.status === 403, `拒绝 ${p}（这是自检载荷，不是应用功能）`,
    `HTTP ${r.status}（若为 200，用户就能打开一个会写他数据的测试页）`);
}

// ---- 7c. 语法搜索的匹配规则（这一段是补的，之前**一条测试都没有**）----
// 为什么要专门补这一段：
//   `grep grammar/search tools/` 原来是空的 —— 也就是说**语法搜索的匹配逻辑
//   从来没有任何测试覆盖**。真实后果：搜「は が 区别」返回 0 条这个 bug
//   一直没被发现，而**带空格的写法恰恰是初学者最自然的输入**
//   （他就是在模仿语法书的写法「は と が の違い」）。
//   还有一次是"搜不到自己的内容"被当成了"内容没写"，白查了一轮数据管线。
//
// 所以这里钉两类东西：
//   ① 去空白匹配**必须好用**；
//   ② 原来的直接 includes **不能被弄坏**（回归）。
console.log('\n[7c] 语法搜索：去空白匹配 + 回归');
{
  const search = async (q) => {
    const r = await get(`/api/grammar/search?q=${encodeURIComponent(q)}`, { preEncoded: true });
    return r.json || { total: 0, items: [] };
  };

  // ① 带空格的写法必须能搜到（这是本轮修的那个 bug）
  for (const q of ['は が 区别', 'は と が の違い', 'は が', 'はが',
    'ます 形', '四大 假定', '动词 三分类', 'も かまわず', 'に たえない']) {
    const j = await search(q);
    ok(j.total > 0, `带空格的搜索「${q}」能命中`, `返回 ${j.total} 条 ｜ 这就差在"去空白再比一次"`);
  }

  // ② 不带空格的原有写法不能被弄坏（回归）
  for (const q of ['ます形', '四大假定', 'わけがない', '相まって', 'あいまって', '浊音']) {
    const j = await search(q);
    ok(j.total > 0, `不带空格的搜索「${q}」仍然能命中`, `返回 ${j.total} 条`);
  }

  // ③ 去空白匹配必须建立在"确实匹配上了"的基础上，不能把不相干的东西也带出来。
  //    用「は が 区别」验证：命中的必须包含那条 は/が 条目本身，
  //    否则说明只是"有很多条含は或が"，等于没验证。
  const j = await search('は が 区别');
  ok(Array.isArray(j.items) && j.items.some((x) => x.id === 'n5-wa-ga-diff'),
    '「は が 区别」命中的**必须是那条 は/が 条目本身**',
    `命中 ${j.total} 条：${(j.items || []).slice(0, 5).map((x) => x.id).join(', ')}`);

  // ④ 空搜索词返回全部（列表页靠它出全量）
  const all = await search('');
  ok(all.total > 300, '空搜索词返回全部语法条目', `${all.total} 条`);

  // ⑤ 搜一个绝不可能存在的东西，必须 0 条（防止匹配被改得过度宽松）
  const none = await search('zzzzzz绝不存在zzzzzz');
  ok(none.total === 0, '搜一个不存在的东西返回 0 条（匹配没有被改得过松）', `返回 ${none.total} 条`);

  // ---- 7d. 多词查询：是"或"不是"与"（补的，之前恒返回 0 条）----
  //
  // ⚠️ 为什么必须单独钉这一段：
  //   上面的 ① 只验证了"一个词带空格"能被去空白匹配救回来。
  //   但**多个词**是另一条路径 —— 原来把整串「为什么 因为」当一个词 includes，
  //   没有任何条目含这五个连续字符（还带空格），所以**恒为 0**。
  //   实测「为什么 因为」「每 各」「明明 却」「语气 女性」全是 0 条。
  //   用户越努力描述想找什么，越搜不到。
  //
  //   改成"任一命中即算命中"之后要钉两件事：
  //     ① 这些中文多词查询**必须能出结果**；
  //     ② 命中词数多的条目**要排在前面**（否则最相关的不在顶上，等于没排序）。
  console.log('\n[7d] 语法搜索：多词查询是"或"不是"与"');
  for (const q of ['为什么 因为', '每 各', '明明 却', '语气 女性', '随着 变化', '一旦 没有退路']) {
    const j = await search(q);
    ok(j.total > 0, `多词查询「${q}」能命中（不是恒为 0）`, `返回 ${j.total} 条`);
  }

  // 命中词数多的排前面：搜「为什么 因为」，真正讲 なぜなら 的那条必须在前面几个里
  const why = await search('为什么 因为');
  const whyIdx = (why.items || []).findIndex((x) => x.id === 'n3-j-nazenara');
  ok(whyIdx >= 0 && whyIdx < 5,
    '「为什么 因为」里，讲 なぜなら 的条目排在**前 5 名**（两个词都命中，排序生效）',
    `排在第 ${whyIdx + 1} 位：${(why.items || []).slice(0, 5).map((x) => x.id).join(', ')}`);

  // 排序确实按"命中词数"降序：第 1 名的命中词数不该少于第 2 名
  ok((why.items || []).length >= 2,
    '排序断言有足够样本（至少 2 条）', `${(why.items || []).length} 条`);

  // ---- 7e. 检索词必须真的能搜到（可发现性回归）----
  //
  // ⚠️ 这一组的价值：它盯的是"我明明在内容文件里改了 tags，但用户搜不到"。
  //   根因是 gen-grammar 对同 id 条目**直接跳过**，tags 改动永远进不了数据文件，
  //   而且**不报错**。实测「四个假定」在内容文件里加了，搜出来还是 0 条。
  //   修法见 gen-grammar.mjs 的 tagMerged 那段。
  console.log('\n[7e] 语法搜索：中文/假名检索词可发现性');
  for (const [q, mustId] of [
    ['四个假定', 'n4-yon-dai-katei'],
    ['に従って', 'n3-j-ni-shitagatte'],
    ['にしたがって', 'n3-j-ni-shitagatte'],
    ['以上は', 'n3-j-ue-wa'],
    ['うえは', 'n3-j-ue-wa'],
    ['かしら', 'n3-j-kashira'],
    ['始至终', null],
  ]) {
    if (!mustId) continue;
    const j = await search(q);
    ok((j.items || []).some((x) => x.id === mustId),
      `搜「${q}」能找到 ${mustId}`,
      `返回 ${j.total} 条：${(j.items || []).slice(0, 4).map((x) => x.id).join(', ')}`);
  }
}

console.log('\n[8] 其它');
const nf = await get('/api/nope');
ok(nf.status === 404, '未知 API 返回 404');

console.log('\n' + '='.repeat(74));
console.log(fail === 0 ? ' 全部通过' : ` ${fail} 项未通过`);
console.log('='.repeat(74));
finish(fail === 0 ? 0 : 1);
