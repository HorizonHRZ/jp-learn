/**
 * qa-grammar.mjs —— 在真浏览器里确认新加的语法内容真的读得到。
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么需要它（和 qa-layout 同一个理由）
 * ────────────────────────────────────────────────────────────────────
 * `test-grammar.mjs` 是**数据层**的检查：字段齐不齐、索引和正文一不一致、
 * 文案里有没有 Markdown。它证明不了这些内容在界面里**长得出来**：
 *   · 筛选按钮（等级/分类）是不是真的按新分类出现；
 *   · 列表里能不能翻到新条目；
 *   · 点开之后 detail / examples 有没有被渲染。
 * 这些只有真浏览器能验。
 *
 * 依赖：服务已启动（要读 /data/grammar/index.json 和正文文件）。
 *      没启动就如实跳过，退出码仍是 0 —— 不能让人开始忽略红色。
 *
 * 用法：node tools/qa-grammar.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
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

let pass = 0, fail = 0;
function ok(c, n, x = '') {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${x ? '\n      ' + x : ''}`); }
}
const skipOut = (why) => {
  console.log(`  · 跳过：${why}`);
  console.log('\n  这个脚本要在服务启动后才有意义：node server.js 8787');
  console.log('\n  跳过 1 项，不算失败。');
  process.exit(0);
};

// ---- 前置：服务在跑吗 ----
try {
  const r = await fetch(APP + 'data/grammar/index.json');
  if (!r.ok) throw new Error('HTTP ' + r.status);
} catch (e) { skipOut(`服务没在 ${APP} 上跑（${e.message || e}）`); }

const BROWSER = BROWSERS.find((p) => { try { return existsSync(p); } catch { return false; } });
if (!BROWSER) skipOut('这台机器上没有 Edge/Chrome');

// ---- 起浏览器 ----
const PORT = 9511;
const profile = mkdtempSync(path.join(tmpdir(), 'jp-gramqa-'));
const child = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--no-default-browser-check', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--window-size=1300,1200', APP + '#/grammar'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 等浏览器退出 + 删掉它的临时用户目录（原来只 kill()，profile 从没人删）。
// 幂等：末尾还会显式调一次，exit 时再调一次也不会出问题。
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
  throw new Error('CDP 端口没起来');
}

let sock;
try {
  sock = new WebSocket(await wsUrl());
  await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej; });
} catch (e) { skipOut(`连不上浏览器（${e.message || e}）`); }

let id = 0;
const waiting = new Map();
const errs = [];
sock.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errs.push(JSON.stringify(m.params.exceptionDetails).slice(0, 200));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errs.push((m.params.args || []).map((a) => a.value || a.description || '').join(' '));
  }
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
await send('Runtime.enable');
await sleep(3000);

// 数据层期望值：直接读服务端的索引，作为界面的对照
const idx = await (await fetch(APP + 'data/grammar/index.json')).json();
const total = idx.count;
const writtenCount = (idx.items || []).filter((x) => x.category === '书面语').length;

console.log(`\n[1] 语法列表（索引里有 ${total} 条，其中书面语 ${writtenCount} 条）`);
{
  const info = await ev(`(() => {
    const m = document.getElementById('mount');
    return {
      rows: m.querySelectorAll('button.gram-row').length,
      filters: m.innerText.slice(0, 120),
      text: m.innerText,
    };
  })()`);
  ok(info.rows > 0, '列表渲染出了条目', `${info.rows} 行`);
  ok(/书面语/.test(info.filters), '出现了「书面语」分类筛选按钮');
  ok(/接续/.test(info.filters), '出现了「接续」分类筛选按钮');
  // ⚠️ 界面**故意**不在标题区显示总条数，所以这里不去断言"页面上写着 47"。
  //    第一版这么断言，红了 —— 红的是断言，不是代码：我在要求一个产品上
  //    不存在的显示。**断言要描述"应有的行为"，不是"我以为长什么样"。**
}

console.log('\n[2] 书面语这一层的内容真的在列表里');
{
  const info = await ev(`(() => {
    const m = document.getElementById('mount');
    const titles = [...m.querySelectorAll('button.gram-row .gram-row-title')].map(n => n.textContent);
    return { titles, n: titles.length };
  })()`);
  const all = info.titles.join('\n');
  for (const [name, re] of [
    ['だ 与 である（常体收尾）', /だ 与 である|である/],
    ['连体修饰', /连体修饰/],
    ['被动表客观叙述', /被动/],
    ['しかし（逆接）', /しかし/],
    ['〜において', /において/],
  ]) {
    ok(re.test(all), `列表里有「${name}」`, all.slice(0, 200));
  }
  // 确认列表确实装下了很多条（不是只渲染前几条）
  ok(info.n >= 30, '列表一次渲染出足够多的条目（不是只渲染前几条）', `${info.n} 条`);
}

console.log('\n[3] 点开一条，看 detail 与例句有没有渲染出来');
{
  const d = await ev(`(async () => {
    const m = document.getElementById('mount');
    const rows = [...m.querySelectorAll('button.gram-row')];
    const row = rows.find(r => /しかし|だ 与 である/.test(r.textContent));
    if (!row) return { clicked: false, why: '没找到目标条目' };
    row.click();
    await new Promise(r => setTimeout(r, 900));
    const t = m.innerText;
    const pane = m.querySelector('.gram-detail, .gram-pane, .gram-body');
    return {
      clicked: true,
      title: row.textContent.slice(0, 40),
      hasDetail: /常体|文章体/.test(t),
      // ⚠️ 不能按整句匹配：界面会给例句自动加振假名，汉字之间会插进假名
      //    （「結果」→「結けっ果か」）。所以只断言可辨认的短片段。
      hasExampleJa: /しかし/.test(t) && /努力|努どり力/.test(t),
      hasFurigana: (pane || m).querySelectorAll('ruby').length > 0,
      sample: (pane || m).innerText.slice(0, 120).replace(/\\n/g, ' | '),
      hasConfusion: /容易混的地方/.test(t),
      hasMistake: /常见的错/.test(t),
      len: t.length,
    };
  })()`);
  ok(d.clicked, '能点开一条语法', JSON.stringify(d).slice(0, 160));
  if (d.clicked) {
    ok(d.hasDetail, '★ 详情里渲染出了 detail 讲解', `页面文本 ${d.len} 字`);
    // ⚠️ 判断例句时有个坑，值得写下来：界面会给例句**自动加振假名**，
    //    所以日文原文被 `<ruby>` 切成了一段一段。实际渲染出来是
    //    「努どり力ょくした。しかし、結けっ果かは出でなかった。」
    //    —— 汉字和假名交错，**不可能**按原句整串去匹配。
    //    第一版就是这么写的（/しかし、結果は出なかった/），红了，
    //    而红的原因是断言没有考虑"假名会插进来"，不是界面坏了。
    //    正确做法是断言**可辨认的短片段**，而不是整句。
    ok(d.hasExampleJa, '★ 详情里渲染出了日文例句（假名是界面自动加的，所以按短片段判断）',
      d.sample || '');
    ok(d.hasFurigana, '★ 例句里的振假名真的加上了（ruby 元素）');
    ok(d.hasConfusion, '详情里渲染出了易混对比');
    // ⚠️ 界面上的小标题是「常见的错」（不是「常见错误」）。
    //    另一个"我在要求我以为的文案"的坑 —— 断言要对着真实界面写。
    ok(d.hasMistake, '详情里渲染出了常见错误');
  }
}

console.log('\n[4] 筛选按钮真的能筛');
{
  const f = await ev(`(async () => {
    const m = document.getElementById('mount');
    const btn = [...m.querySelectorAll('button')].find(b => b.textContent.trim() === '书面语');
    if (!btn) return { found: false };
    const before = m.querySelectorAll('button.gram-row').length;
    btn.click();
    await new Promise(r => setTimeout(r, 700));
    const after = m.querySelectorAll('button.gram-row').length;
    return { found: true, before, after };
  })()`);
  ok(f.found, '找到「书面语」筛选按钮');
  if (f.found) {
    ok(f.after > 0 && f.after < f.before,
      '★ 点「书面语」之后列表变短了（筛选真的生效）', `${f.before} → ${f.after}`);
  }
}

console.log('\n[5] 按标签搜索');
{
  // 为什么单独测这一条：
  //   索引用心良苦把 tags 收了进来（build-grammar-index.mjs 里有注释说明），
  //   但**搜索逻辑一开始没有查 tags** —— 于是按概念搜一条都搜不到。
  //   而按概念搜正是初学者最自然的用法：他不知道自己不知道什么，只能拿一个词去试。
  //   这个 bug 是"数据到位了、功能没接上"，静态检查和数据检查都看不见它。
  //
  // ⚠️ 挑判别性标签这件事我错了两轮，值得完整记下来：
  //    第一轮：用「文语」当判别词 —— **假判别词**。tags 搜索改坏后照样通过，
  //            因为标题里就写着「〜き／〜し：文语的过去」，title 那支已经命中了。
  //    第二轮：改成"从索引里现算只出现在 tags 里的词"，还是不够 ——
  //            「长句」「书面语」这类词虽然**自身**不在任何标题里，但它们是
  //            别的**条目**的标题用词（「长句拆解」那一批），一搜就命中那些条目。
  //            所以"有命中"还是证明不了 tags 起作用，只是命中数会少。
  //
  //    第三轮（现在）改成**看命中数够不够**：
  //    设 n ＝ 索引里带这个标签的条目数，s ＝ 实际搜出来的条数。
  //    要求 s >= n —— 因为只要 tags 参与搜索，带这个标签的条目**至少**全都能搜到。
  //    假判别词过不了这一关：改坏之后「长句」只能搜出 5 条（靠标题命中的），
  //    而标签里有 9 条，5 < 9，断言就红了。
  //
  //    这条经验是通用的：**断言要卡"数量"，不要只卡"有没有"。**
  //    "有反应"太容易蒙对；"该有多少就有多少"才卡得住。
  const tagCount = new Map();
  for (const it of idx.items) {
    for (const t of it.tags || []) {
      const n = String(t).toLowerCase();
      const elsewhere = [it.title, it.meaning, it.category, it.id]
        .some((v) => String(v || '').toLowerCase().includes(n));
      if (!elsewhere) tagCount.set(t, (tagCount.get(t) || 0) + 1);
    }
  }
  const probes = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  ok(probes.length >= 2, '索引里能找到"只在 tags 里出现"的判别词',
    `找到 ${probes.length} 个：${probes.map(([t, n]) => `${t}(${n})`).join(' / ')}`);

  // ⚠️ 必须先清空上一个区块留下的筛选！[4] 点了「书面语」分类按钮，
  //    那是**会保持住**的状态。不清掉的话，搜别的分类永远是 0 条 ——
  //    第一版就是这么写的，红了，我差点以为是 tags 没生效。
  //    教训：**测试之间会互相污染。** 每个区块开始前，先把状态清干净。
  const s = await ev(`(async () => {
    const m = document.getElementById('mount');
    // 把所有筛选复位：点每个筛选组里的「全部」
    for (let i = 0; i < 3; i++) {
      const allBtn = [...m.querySelectorAll('button')].filter(b => b.textContent.trim() === '全部')[i];
      if (allBtn) { allBtn.click(); await new Promise(r => setTimeout(r, 300)); }
    }
    const input = m.querySelector('input[type=search]');
    if (!input) return { found: false };
    const results = {};
    for (const q of ${JSON.stringify(probes.map(([t]) => t))}) {
      input.value = q;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 600));
      results[q] = m.querySelectorAll('button.gram-row').length;
    }
    return { found: true, results };
  })()`);
  ok(s.found, '找到搜索框');
  if (s.found) {
    for (const [q, expected] of probes) {
      const got = s.results[q] || 0;
      ok(got >= expected,
        `★ 搜「${q}」搜出了至少 ${expected} 条（标签里有这么多条，少于这个数就说明 tags 没参与搜索）`,
        `实际 ${got} 条 —— ${JSON.stringify(s.results)}`);
    }
  }
}

console.log('\n[6] 收藏与「已掌握」—— 用户自己的学习状态');
{
  // 为什么要在真浏览器里测这个：
  //   收藏和已掌握存在浏览器的 IndexedDB（grammarState 表）里，是**用户的数据**。
  //   数据层的测试只查内置 JSON，查不到这条链路。而这条链路一旦断了，
  //   表现是"我标了已掌握，刷新之后又回来了"—— 用户会以为程序在骗他。
  //   ⚠️ 这里会往浏览器自己的库里写数据；用的是 headless 实例的临时 profile，
  //      跑完整个浏览器进程就没了，不碰用户的真实数据。
  const st = await ev(`(async () => {
    const m = document.getElementById('mount');
    // 先清掉筛选，保证列表是全的
    for (let i = 0; i < 3; i++) {
      const allBtn = [...m.querySelectorAll('button')].filter(b => b.textContent.trim() === '全部')[i];
      if (allBtn) { allBtn.click(); await new Promise(r => setTimeout(r, 250)); }
    }
    // 清掉搜索框
    const input = m.querySelector('input[type=search]');
    if (input) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => setTimeout(r, 400)); }

    const row = m.querySelector('button.gram-row');
    if (!row) return { why: '列表是空的' };
    const id = row.dataset.id;
    row.click();
    await new Promise(r => setTimeout(r, 700));

    // 详情区里找「收藏」和「标记为已掌握」。
    // 按钮文字实测是「☆ 收藏 / ★ 已收藏」「标记为已掌握 / ✓ 已掌握」
    // —— 所以收藏那一颗按钮的初始文字里就带着「收藏」两个字，
    // 不能用 /收藏/ 去找"初始状态"，否则会把已收藏的也当成初始态。
    const btns = [...m.querySelectorAll('button')];
    const fav = btns.find(b => b.dataset && b.dataset.act === 'favorite');
    const mastBtn = btns.find(b => b.dataset && b.dataset.act === 'mastered');
    if (!fav || !mastBtn) return { why: '没找到收藏/已掌握按钮', hasFav: !!fav, hasMast: !!mastBtn };

    const favBefore = fav.textContent.trim();
    fav.click();
    await new Promise(r => setTimeout(r, 700));
    // ⚠️ 点完必须**重新查一次**按钮，不能接着用上面那个 fav 引用。
    //    原因：onclick 里会调 renderBody()，**整个详情区被重建** ——
    //    旧的那个 DOM 节点已经脱离文档，文字永远停在点击前。
    //    第一版就是抱着旧引用读文字的，于是"点了没反应"，
    //    而真实页面上星号明明变了。**界面重建之后，旧引用就是废的。**
    const favAfterNode = m.querySelector('button[data-act="favorite"]');
    const favAfter = favAfterNode ? favAfterNode.textContent.trim() : '(按钮不见了)';
    const favOn = favAfterNode ? favAfterNode.classList.contains('is-on') : false;

    const mastBefore = mastBtn.textContent.trim();
    mastBtn.click();
    await new Promise(r => setTimeout(r, 800));
    const mastAfterNode = m.querySelector('button[data-act="mastered"]');
    const mastAfter = mastAfterNode ? mastAfterNode.textContent.trim() : '(按钮不见了)';

    const saved = await window.JP.db.dbGet('grammarState', id);
    return { id, saved: saved || null, favBefore, favAfter, favOn, mastBefore, mastAfter };
  })()`);
  ok(!!st.id, '能选中一条语法并找到收藏/已掌握按钮', JSON.stringify(st).slice(0, 200));
  if (st.id) {
    ok(st.saved && st.saved.favorite === true, '★ 点「收藏」真的写进了 IndexedDB',
      JSON.stringify(st.saved));
    ok(st.saved && st.saved.mastered === true, '★ 点「标记为已掌握」真的写进了 IndexedDB',
      JSON.stringify(st.saved));
    // 界面上也要跟着变（否则用户看不出自己标过）
    ok(st.favBefore !== st.favAfter,
      '★ 收藏按钮的文字跟着状态变了（用户看得出自己标过）',
      `点击前=「${st.favBefore}」，点击后=「${st.favAfter}」`);
    ok(st.favOn === true, '★ 收藏按钮加上了 is-on 样式（不只是文字变）');
    ok(st.mastBefore !== st.mastAfter,
      '★ 「已掌握」按钮的文字也跟着变了',
      `点击前=「${st.mastBefore}」，点击后=「${st.mastAfter}」`);
  }
}

console.log('\n[7] 刷新之后，学习状态还在不在');
{
  // 这是上一条的"下一步"：写进去了，**读出来了没有**。
  // 分开测的理由：写入成功但读取失败，用户看到的现象是"标了又没了"，
  // 而只测写入的话这一条会全绿。
  await send('Page.navigate', { url: APP + '#/grammar' });
  await sleep(3500);
  const again = await ev(`(async () => {
    const m = document.getElementById('mount');
    for (let i = 0; i < 3; i++) {
      const allBtn = [...m.querySelectorAll('button')].filter(b => b.textContent.trim() === '全部')[i];
      if (allBtn) { allBtn.click(); await new Promise(r => setTimeout(r, 250)); }
    }
    // 用「★ 收藏」筛选，看刚才标的那条还在不在
    const favBtn = [...m.querySelectorAll('button')].find(b => /★ 收藏|收藏/.test(b.textContent) && b.className.includes('gram'));
    if (!favBtn) return { why: '找不到收藏筛选按钮' };
    favBtn.click();
    await new Promise(r => setTimeout(r, 800));
    return { n: m.querySelectorAll('button.gram-row').length, titles: [...m.querySelectorAll('.gram-row-title')].map(x => x.textContent).slice(0, 3) };
  })()`);
  ok(!!again.n, '★ 刷新后仍能用「收藏」筛出刚才标的那条（状态真的读回来了）',
    JSON.stringify(again).slice(0, 240));
}

console.log('\n[8] 工具箱的「动词・形容词变形表」在真浏览器里真的能查（本轮新增）');
{
  // 为什么这一节必须在真浏览器里跑，而不是只靠 test-conj.mjs：
  //   test-conj.mjs 验的是**规则引擎算得对不对**（纯函数，假 DOM 就够）。
  //   这一节验的是**用户在页面上真的查得到吗** ——
  //   页签接没接上、表格建没建出来、下拉框改类型会不会重算。
  //   这两件事会独立出错：引擎全绿而页签没接上，是完全可能的
  //   （本项目就发生过"数据到位了、功能没接上"，见 ARCHITECTURE 第 21.9 节）。
  await send('Page.navigate', { url: APP + '#/toolbox' });
  await sleep(3500);

  const tabInfo = await ev(`(() => {
    const tabs = [...document.querySelectorAll('.tab')].map(t => t.textContent);
    const conjTab = [...document.querySelectorAll('.tab')].find(t => /变形表/.test(t.textContent));
    if (conjTab) conjTab.click();
    return JSON.stringify({ tabs, clicked: !!conjTab });
  })()`);
  const ti = JSON.parse(tabInfo);
  ok(ti.clicked, '★ 工具箱里有「动词・形容词变形表」这个页签，且点得开', tabInfo.slice(0, 200));
  ok(ti.tabs.length === 4, '★ 工具箱现在是 4 个工具', ti.tabs.join(' / '));

  const tbl = JSON.parse(await ev(`(() => {
    const first = document.querySelector('.conj-table');
    const rows = first ? [...first.querySelectorAll('tbody tr')].map(tr =>
      [...tr.querySelectorAll('td')].map(td => td.textContent.trim())) : [];
    return JSON.stringify({
      tableCount: document.querySelectorAll('.conj-table').length,
      rowCount: rows.length,
      forms: rows.map(r => r[1]),
      rules: rows.map(r => r[2]),
      text: document.body.innerText,
    });
  })()`));

  ok(tbl.tableCount >= 2, '★ 变形表页真的建出了表格（变形表 + 变化规则表）', `实际 ${tbl.tableCount} 张`);
  ok(tbl.rowCount >= 15, '★ 默认例子「使う」列出了一整张变形表（≥15 行）', `实际 ${tbl.rowCount} 行`);
  ok(tbl.forms.includes('使います'), '★★ 表里有「使います」', tbl.forms.slice(0, 6).join('/'));

  // ⚠️⚠️ 这一条是本轮最该留在真浏览器里的断言。
  //    「う」的あ段是「わ」，不是「あ」。第一版产出「使あない」——
  //    而且**当时所有测试全绿**（原有断言恰好没覆盖 う 行的ない形），
  //    是肉眼看页面才发现的。所以这里从**页面文字**上直接卡死：
  //    页面上出现「使あ」就是 bug，出现「使わない」才算对。
  ok(!/使あ/.test(tbl.text), '★★★ 页面上没有「使あない」这种不存在的写法（う 的あ段是 わ）',
    (tbl.text.match(/使あ[^\s]{0,6}/) || [''])[0]);
  ok(tbl.forms.includes('使わない'), '★★★ 页面上写的是「使わない」', tbl.forms.join('/'));
  ok(tbl.forms.includes('使われる') && tbl.forms.includes('使わせる'),
    '★★ 被动/使役也用 わ 行（使われる / 使わせる）', tbl.forms.join('/'));

  // 判定依据必须写出来，否则用户不知道程序是怎么理解这个词的
  ok(/以「う」结尾/.test(tbl.text), '★★ 页面上显式写了判定依据', (tbl.text.match(/判断依据[^\n]{0,40}/) || [''])[0]);

  // 类型选择器：这不是"高级功能"，是纠错入口
  const selInfo = JSON.parse(await ev(`(() => {
    const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => /自动判断/.test(o.textContent)));
    return JSON.stringify({ has: !!sel, opts: sel ? [...sel.options].map(o => o.textContent) : [] });
  })()`));
  ok(selInfo.has, '★★ 有词类选择器（用户必须能手动纠错）');
  ok(selInfo.opts.length >= 7, '★ 每种词类都能选（≥7 项）', selInfo.opts.join('/'));

  // ★★★ 手动改类型必须真的重算 —— 不然那个下拉框就是个摆设
  const after = JSON.parse(await ev(`(() => {
    const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => /自动判断/.test(o.textContent)));
    sel.value = 'ichidan';
    sel.dispatchEvent(new Event('change'));
    return JSON.stringify({
      saysManual: document.body.innerText.includes('手动指定'),
      stillShimasu: /使います/.test(document.body.innerText),
      forms: [...document.querySelectorAll('.conj-form')].slice(0, 6).map(e => e.textContent),
    });
  })()`));
  ok(after.saysManual, '★★★ 手动指定词类后页面明说"这是按你选的类型变的"');
  ok(!after.stillShimasu, '★★★ 手动指定一段后，表真的重算了（「使う」不再给出「使います」）',
    after.forms.join('/'));

  // 变化规则表那一块（用户点名要的功能）
  //
  // 用户原话：「我还需要你保留"输入原型——给出所有变化"这一功能的前提下，
  //           直接给出变化规则表，例如一段五段动词的具体通用规则。」
  // 所以这里要验三件事，缺一不可：
  //   ① 「输入原型→所有变化」还在（上面那几条断言已经在验了）
  //   ② **不用先输入**就能看到规则表（这是用户最在意的那一点）
  //   ③ 搜索和词类按钮都能筛
  const ruleSearch = JSON.parse(await ev(`(() => {
    const ri = [...document.querySelectorAll('input')].find(i => /筛选规则/.test(i.placeholder || ''));
    if (!ri) return JSON.stringify({ err: '找不到规则筛选框' });
    ri.value = '音便';
    ri.dispatchEvent(new Event('input'));
    const t = document.body.innerText;
    return JSON.stringify({ found: t.includes('音便'), ended: t.includes('变化规则表') });
  })()`));
  ok(ruleSearch.found, '★ 「变化规则表」输入关键词能筛出规则（搜「音便」有结果）',
    JSON.stringify(ruleSearch).slice(0, 160));
  ok(ruleSearch.ended, '这一块还在页面上（改名后没有把整块弄丢）', JSON.stringify(ruleSearch).slice(0, 160));

  // ★★ 核心：**没做任何操作**时，规则表就已经铺在页面上了。
  //    旧版的毛病就是只有一个空白搜索框，初学者不知道该输什么，
  //    等于看不到任何规则 —— 那正是用户提这条需求的原因。
  const initial = JSON.parse(await ev(`(() => {
    const host = document.querySelector('.conj-rules');
    const groups = [...document.querySelectorAll('.conj-rules-group')];
    return JSON.stringify({
      hasHost: !!host,
      groups: groups.length,
      open: groups.filter(g => g.open).length,
      rows: document.querySelectorAll('.conj-table tbody tr').length,
      firstOpenType: (groups.find(g => g.open) || {}).textContent || '',
    });
  })()`));
  ok(initial.hasHost && initial.groups > 0, '★ 进页面就有规则表（不用先输入关键词）', JSON.stringify(initial));
  ok(initial.rows > 0, '★★ 默认就展开了规则行（不是全折叠的空壳）', `默认展开 ${initial.open} 组 / 共 ${initial.rows} 行`);
  ok(/五段动词/.test(initial.firstOpenType), '★ 五段动词默认展开（用户点名的例子）', initial.firstOpenType.slice(0, 40));

  // 词类按钮：点一下只留那一类，再点一下取消
  const chipFilter = JSON.parse(await ev(`(() => {
    const b = [...document.querySelectorAll('.chip')].find(x => x.textContent === '五段动词');
    if (!b) return JSON.stringify({ err: '找不到五段动词按钮' });
    b.click();
    const on = b.classList.contains('is-on');
    const types = [...document.querySelectorAll('.conj-rules-type')].map(e => e.textContent);
    b.click();
    const off = !b.classList.contains('is-on');
    const back = [...document.querySelectorAll('.conj-rules-type')].length;
    return JSON.stringify({ on, types, off, back });
  })()`));
  ok(chipFilter.on && chipFilter.types && chipFilter.types.length === 1,
    '★ 点「五段动词」按钮只剩这一类（并且按钮高亮，用户知道自己在筛）',
    JSON.stringify(chipFilter).slice(0, 200));
  ok(chipFilter.off && chipFilter.back > 1, '★ 再点一次取消筛选，其它词类回来了',
    JSON.stringify(chipFilter).slice(0, 200));

  // 用户可见文字里不许残留 Markdown 星号（没有渲染器，会连星号一起显示）
  const finalText = await ev(`document.body.innerText`);
  ok(!/\*\*/.test(finalText), '★ 变形表页面上没有残留的 Markdown ** 星号给用户看',
    (finalText.match(/\*\*[^\n]{0,30}/) || [''])[0]);
}

console.log('\n[9] 相关条目真的显示出来，而且点得动（本轮新增）');
{
  // 为什么这块必须在真浏览器里验：
  //   check-related.mjs 只证明**数据**是好的（没有悬空 id、关系双向）。
  //   它证明不了界面上出现得出来、点得动、跳过去真的换了内容。
  //   本项目反复出现过"数据到位、功能没接上"（见 ARCHITECTURE §21.9）。
  await send('Page.navigate', { url: APP + '#/grammar' });
  await sleep(3500);

  const rel = JSON.parse(await ev(`(async () => {
    const m = document.getElementById('mount');
    for (let i = 0; i < 3; i++) {
      const allBtn = [...m.querySelectorAll('button')].filter(b => b.textContent.trim() === '全部')[i];
      if (allBtn) { allBtn.click(); await new Promise(r => setTimeout(r, 250)); }
    }
    // 用搜索框定位到「につれて」那一条（它有三条相关，最适合验）
    const input = m.querySelector('input[type=search]');
    input.value = 'につれて';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 700));
    const row = m.querySelector('button.gram-row');
    if (!row) return JSON.stringify({ why: '搜不到条目', id: null });
    row.click();
    await new Promise(r => setTimeout(r, 900));
    const t = m.innerText;
    const links = [...m.querySelectorAll('.gram-rel-go')].map(b => b.textContent);
    const whys = [...m.querySelectorAll('.gram-rel-why')].map(b => b.textContent);
    return JSON.stringify({
      id: row.dataset.id,
      hasCard: /相关条目/.test(t),
      links, whys,
      // 跳转前的标题，用来对比"点完真的换了一条"
      beforeTitle: (m.querySelector('.card-title h2, .card-title h3') || {}).textContent || '',
      beforeId: row.dataset.id,
    });
  })()`));

  ok(!!rel.id, '能搜到「につれて」那一条并点开', JSON.stringify(rel).slice(0, 200));
  ok(rel.hasCard, '★ 详情里有「相关条目」这一块', JSON.stringify(rel).slice(0, 200));
  ok((rel.links || []).length >= 2, '★ 相关条目至少 2 条（不是空壳）',
    (rel.links || []).join(' | '));
  // ⚠️ 相关条目显示的必须是**别的条目的标题**，不是 id。
  //    显示 id（如 n3-j-ni-shitagatte）对用户毫无意义 —— 那是给程序看的。
  const looksLikeId = (rel.links || []).some((s) => /^n[0-9]-/.test(String(s).trim()));
  ok(!looksLikeId, '★★ 相关条目显示的是标题，不是 id（id 对用户没意义）',
    (rel.links || []).join(' | '));
  ok((rel.whys || []).every((w) => String(w).trim().length > 4), '★ 每条相关都带一句"为什么相关"',
    (rel.whys || []).join(' ／ '));

  // ★★★ 点一下必须真的跳过去 —— 不然这一块就是个摆设
  const jumped = JSON.parse(await ev(`(async () => {
    const m = document.getElementById('mount');
    const go = m.querySelector('.gram-rel-go');
    if (!go) return JSON.stringify({ why: '没有可点的相关条目' });
    const label = go.textContent;
    go.click();
    await new Promise(r => setTimeout(r, 1100));
    // 详情区顶部的大标题就是当前条目
    const h = [...m.querySelectorAll('.card h2, .card h3')].map(x => x.textContent);
    const t = m.innerText;
    return JSON.stringify({ label, headings: h.slice(0, 3), text0: t.slice(0, 80) });
  })()`));
  ok(!!jumped.label, '★ 相关条目是可以点的按钮', JSON.stringify(jumped).slice(0, 160));
  if (jumped.label) {
    // 跳过去之后，页面上应该出现**目标条目**的内容。
    // 目标标题不一定等于按钮文字（按钮文字可能是长标题被截断），
    // 所以用"点之前的标题不见了 + 出现了新内容"来判断。
    ok(jumped.text0 && jumped.text0.length > 10,
      '★★★ 点相关条目之后详情真的换成了另一条（不是没反应）',
      `点了「${String(jumped.label).slice(0, 24)}」→ 现在页面开头是「${String(jumped.text0).slice(0, 50)}」`);
    ok(!/につれて：随着/.test(String(jumped.text0)),
      '★★★ 跳转后**不再是**原来那一条（说明真的导航了）',
      String(jumped.text0).slice(0, 80));
  }
}

// ---------------------------------------------------------------------------
// [新] 阅读导览：吸顶导览条 + 上一条/下一条 + 键盘 + 本页目录
// ---------------------------------------------------------------------------
// 这一节的由来（用户原话）：「语法功能的 ui 设计得更加完备，
// 现在只靠鼠标滚轮的形式有点太不优雅了」。
// 加的功能最容易"看起来有、其实没接上"（按钮渲染出来了但点了不动），
// 所以这里每一条都**真的点一下 / 真的按一下**，再验证页面确实变了。
console.log('\n[N1] 吸顶导览条：位置、上一条、下一条');
{
  const bar = JSON.parse(await ev(`(async () => {
    const m = document.getElementById('mount');
    // 清掉筛选，回到全量列表，保证"位置"有意义
    const input = m.querySelector('input[type=search]');
    if (input) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); }
    await new Promise(r => setTimeout(r, 500));
    const rows = [...m.querySelectorAll('button.gram-row')];
    if (rows.length < 3) return JSON.stringify({ why: '列表条目太少', n: rows.length });
    rows[1].click();
    await new Promise(r => setTimeout(r, 900));
    const b = m.querySelector('.gram-readbar');
    if (!b) return JSON.stringify({ why: '没有导览条' });
    const pos = b.querySelector('[data-role=pos]');
    const prev = b.querySelector('[data-act=prev]');
    const next = b.querySelector('[data-act=next]');
    return JSON.stringify({
      exists: true,
      pos: pos ? pos.textContent.trim() : '',
      hasPrev: !!prev, hasNext: !!next,
      prevDisabled: prev ? prev.disabled : null,
      nextDisabled: next ? next.disabled : null,
      // 位置必须写成「第几条 / 共几条」
      posShape: pos ? /^\\s*\\d+\\s*\\/\\s*\\d+\\s*$/.test(pos.textContent) : false,
      // 吸顶：CSS 里 position 必须是 sticky，且 top 有值
      position: getComputedStyle(b).position,
      top: getComputedStyle(b).top,
      row2Id: rows[1].dataset.id,
    });
  })()`));
  ok(bar.exists, '★ 详情页有吸顶导览条', JSON.stringify(bar).slice(0, 200));
  ok(bar.posShape, '★ 导览条显示「第几条 / 共几条」', `得到「${bar.pos}」`);
  ok(bar.position === 'sticky', '★★ 导览条真的是 sticky（不是普通一行）', `position=${bar.position}`);
  ok(bar.top && bar.top !== 'auto', '★★ 导览条写了 top（否则贴不到导航栏下沿）', `top=${bar.top}`);
  // 吸顶偏移必须正好等于导航栏高度，否则会被盖住或露缝
  ok(bar.top === '54px', '★★ 导览条的 top 等于导航栏高度 54px（改一处要改三处）', `top=${bar.top}`);

  // --- 点"下一条"，必须真的换一条 ---
  const moved = JSON.parse(await ev(`(async () => {
    const m = document.getElementById('mount');
    const before = (m.querySelector('.gram-readbar-title') || {}).textContent || '';
    const btn = m.querySelector('.gram-readbar [data-act=next]');
    if (!btn) return JSON.stringify({ why: '没有下一条按钮' });
    if (btn.disabled) return JSON.stringify({ why: '下一条是禁用态' });
    btn.click();
    await new Promise(r => setTimeout(r, 900));
    const after = (m.querySelector('.gram-readbar-title') || {}).textContent || '';
    const pos = (m.querySelector('.gram-readbar [data-role=pos]') || {}).textContent || '';
    return JSON.stringify({ before, after, pos, changed: before !== after && !!after });
  })()`));
  ok(moved.changed, '★★★ 点「下一条」真的换到了另一条', `「${moved.before}」→「${moved.after}」`);

  // --- 点"上一条"，应该回到刚才那条 ---
  const back = JSON.parse(await ev(`(async () => {
    const m = document.getElementById('mount');
    const before = (m.querySelector('.gram-readbar-title') || {}).textContent || '';
    const btn = m.querySelector('.gram-readbar [data-act=prev]');
    btn.click();
    await new Promise(r => setTimeout(r, 900));
    const after = (m.querySelector('.gram-readbar-title') || {}).textContent || '';
    return JSON.stringify({ before, after });
  })()`));
  ok(back.before !== back.after, '★★★ 点「上一条」能回退（不是单向的）', `「${back.before}」→「${back.after}」`);

  // --- "记住了，下一条"必须真的写入已掌握状态 ---
  const done = JSON.parse(await ev(`(async () => {
    const m = document.getElementById('mount');
    const title = (m.querySelector('.gram-readbar-title') || {}).textContent || '';
    const btn = m.querySelector('.gram-readbar [data-act=next-done]');
    if (!btn) return JSON.stringify({ why: '没有"记住了"按钮' });
    btn.click();
    await new Promise(r => setTimeout(r, 1200));
    const after = (m.querySelector('.gram-readbar-title') || {}).textContent || '';
    // 回列表看有没有打上 ✓
    const onRows = [...m.querySelectorAll('button.gram-row.is-on .gram-done')].length;
    return JSON.stringify({ title, after, advanced: title !== after, onRows });
  })()`));
  ok(done.advanced, '★★★ 点「记住了，下一条」会前进到下一条（顺带标记已掌握）',
    `「${done.title}」→「${done.after}」`);
}

console.log('\n[N2] 键盘：← → 翻条（这是"不优雅"最直接的解法）');
{
  const kb = JSON.parse(await ev(`(async () => {
    const m = document.getElementById('mount');
    const title0 = (m.querySelector('.gram-readbar-title') || {}).textContent || '';
    const fire = (key) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    fire('ArrowRight');
    await new Promise(r => setTimeout(r, 850));
    const title1 = (m.querySelector('.gram-readbar-title') || {}).textContent || '';
    fire('ArrowLeft');
    await new Promise(r => setTimeout(r, 850));
    const title2 = (m.querySelector('.gram-readbar-title') || {}).textContent || '';
    return JSON.stringify({ title0, title1, title2 });
  })()`));
  ok(kb.title0 !== kb.title1, '★★★ 按 → 会跳到下一条', `「${kb.title0}」→「${kb.title1}」`);
  ok(kb.title0 === kb.title2, '★★★ 按 ← 能回到原来那条（一来一回可逆）',
    `「${kb.title1}」→「${kb.title2}」，原为「${kb.title0}」`);

  // ⚠️ 反向验证：在搜索框里按方向键**不许**翻条目。
  //    没有这条的话，"是否只在非输入框里响应"就是没被验证过的假设。
  const inInput = JSON.parse(await ev(`(async () => {
    const m = document.getElementById('mount');
    const input = m.querySelector('input[type=search]');
    if (!input) return JSON.stringify({ why: '没有搜索框' });
    const title0 = (m.querySelector('.gram-readbar-title') || {}).textContent || '';
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await new Promise(r => setTimeout(r, 700));
    const title1 = (m.querySelector('.gram-readbar-title') || {}).textContent || '';
    return JSON.stringify({ title0, title1, same: title0 === title1 });
  })()`));
  ok(inInput.same, '★★★ 在搜索框里按方向键**不会**翻条目（不然没法编辑文字了）',
    `「${inInput.title0}」→「${inInput.title1}」`);
}

console.log('\n[N3] 本页目录：点一下真的滚到那一节');
{
  const toc = JSON.parse(await ev(`(async () => {
    const m = document.getElementById('mount');
    // 找一条内容长的（有例句 + 易混 + 常见错误）—— 目录才有意义
    const input = m.querySelector('input[type=search]');
    input.value = 'ものなら';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 700));
    const row = m.querySelector('button.gram-row');
    if (!row) return JSON.stringify({ why: '搜不到条目' });
    row.click();
    await new Promise(r => setTimeout(r, 1100));
    const card = m.querySelector('.gram-toc');
    if (!card) return JSON.stringify({ why: '没有本页目录' });
    const btns = [...card.querySelectorAll('button')].map(b => ({ sec: b.dataset.sec, text: b.textContent }));
    return JSON.stringify({ exists: true, btns, n: btns.length });
  })()`));
  ok(toc.exists, '★ 详情页有「本页目录」', JSON.stringify(toc).slice(0, 200));
  ok((toc.n || 0) >= 3, '★ 目录里有多个可跳的节', (toc.btns || []).map((b) => b.text).join(' / '));

  // 点"常见的错"，必须滚下去（scrollY 明显增大），且真的滚到了目标元素附近
  const jump = JSON.parse(await ev(`(async () => {
    const m = document.getElementById('mount');
    window.scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 300));
    const y0 = window.scrollY;
    const btn = [...m.querySelectorAll('.gram-toc button')].find(b => b.dataset.sec === 'mist');
    if (!btn) return JSON.stringify({ why: '目录里没有"常见的错"' });
    btn.click();
    await new Promise(r => setTimeout(r, 1400));
    const target = m.querySelector('[data-sec=mist]');
    const r = target ? target.getBoundingClientRect() : null;
    // 目标应该落在视口上半部（补偿量对的话不会被吸顶条盖住）
    return JSON.stringify({
      y0, y1: window.scrollY,
      targetTop: r ? Math.round(r.top) : null,
      // 顶部导航 54 + 导览条约 50，所以 100~200 之间是理想落点
      wellPlaced: r ? (r.top >= 0 && r.top < 260) : false,
    });
  })()`));
  ok(jump.y1 > jump.y0, '★★★ 点目录里的「常见的错」页面真的滚动了',
    `scrollY ${jump.y0} → ${jump.y1}`);
  ok(jump.wellPlaced, '★★★ 滚到的位置没被吸顶导航挡住（scroll-margin-top 生效）',
    `目标距视口顶端 ${jump.targetTop}px（要求 0~260）`);
}

// ---------------------------------------------------------------------------
// [N5] 条目底部的「标签 → 分隔线 → 小字」三者间距
// ---------------------------------------------------------------------------
//
// 用户反馈原话：「在每个语法条目最底端，有 tag 标签，然后是一行直线，
// 然后是最后的小字，这个直线跟 tag 边框几乎重合了，往下移动一点。」
//
// 为什么只有真浏览器能量：
//   分隔线是 `.gram-src` 的 `border-top`，不是独立元素。
//   它离标签有多远，取决于**标签胶囊的实际排版高度**
//   （font-size .82rem × line-height 1.7 + padding 3px + 1px 边框）。
//   假 DOM 没有排版引擎，算不出这个高度，也就量不出这个间距。
{
  await send('Page.navigate', { url: APP + '#/grammar' });
  await sleep(3200);

  const sp = JSON.parse(await ev(`(async () => {
    const m = document.getElementById('mount');
    const input = m.querySelector('input[type=search]');
    input.value = 'ついでに';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 800));
    const row = m.querySelector('button.gram-row');
    if (!row) return JSON.stringify({ why: '搜不到条目' });
    row.click();
    await new Promise(r => setTimeout(r, 1100));

    const src = m.querySelector('.gram-src');
    if (!src) return JSON.stringify({ why: '没有 .gram-src' });
    const sr = src.getBoundingClientRect();
    // 取这一块里所有的标签胶囊（详情页的标签是 span）
    const chips = [...m.querySelectorAll('.gram-tags .gram-chip')];
    if (!chips.length) return JSON.stringify({ why: '这一条没有标签' });
    // 标签区最靠下的那条边
    const chipBottom = Math.max(...chips.map(c => c.getBoundingClientRect().bottom));
    const tags = m.querySelector('.gram-tags');
    const tagsBottom = tags.getBoundingClientRect().bottom;
    const chip0 = chips[0].getBoundingClientRect();
    return JSON.stringify({
      chipCount: chips.length,
      // 分隔线离标签底边多远（这就是用户说的"几乎重合"那个距离）
      gapFromChip: Math.round(sr.top - chipBottom),
      // 分隔线离标签容器底边多远（容器可能比胶囊高一点）
      gapFromTags: Math.round(sr.top - tagsBottom),
      padTop: getComputedStyle(src).paddingTop,
      tagsMarginBottom: getComputedStyle(tags).marginBottom,
      // 诊断用：容器高度 vs 胶囊高度。如果容器比胶囊矮，
      // 说明 flex 行盒没把胶囊撑开（胶囊溢出了容器），
      // 那么"给容器加 margin"到底管不管用就要看这个数。
      tagsH: Math.round(tags.getBoundingClientRect().height),
      chipH: Math.round(chip0.height),
      chipTop: Math.round(chip0.top),
      tagsTop: Math.round(tags.getBoundingClientRect().top),
      // 分隔线下面那段文字的内容（要在 Node 侧断言，所以要带出来）
      srcText: src.innerText.trim().slice(0, 80),
    });
  })()`));

  ok(!sp.why, '能打开一条带标签的语法条目', sp.why || '');
  if (!sp.why) {
    console.log(`        标签 ${sp.chipCount} 个；分隔线离标签 ${sp.gapFromChip}px，` +
      `离标签容器 ${sp.gapFromTags}px（padding-top=${sp.padTop}, tags margin-bottom=${sp.tagsMarginBottom}）`);
    console.log(`        容器高 ${sp.tagsH}px / 胶囊高 ${sp.chipH}px；` +
      `容器顶 ${sp.tagsTop} / 胶囊顶 ${sp.chipTop}（差 <0 说明胶囊溢出了容器）`);
    ok(sp.gapFromChip >= 12,
      `★★ 分隔线离标签有明显的空隙（实测 ${sp.gapFromChip}px，要求 ≥12px）`,
      `只有 ${sp.gapFromChip}px —— 就是用户反馈的"直线跟 tag 边框几乎重合"`);
    // 反向：也不能大得离谱，否则标签和末尾小字会被拆成两段不相干的东西
    ok(sp.gapFromChip <= 40,
      `★ 空隙没有大到把两者拆散（实测 ${sp.gapFromChip}px，要求 ≤40px）`,
      `${sp.gapFromChip}px 太大了`);
    // 分隔线下面还得有内容（末尾那行小字），不能是空块
    // ⚠️ 这里必须断言从页面**带出来**的 srcText。
    //    第一版直接写了 `ok(src.innerText...)` —— 而 `src` 是页面里的变量，
    //    Node 侧根本没有它，于是整个脚本 ReferenceError 崩掉。
    //    （教训：CDP 求值的表达式和 Node 侧的代码是两个世界。）
    ok(sp.srcText.length > 0, '分隔线下面还有文字（不是空块）',
      JSON.stringify(sp.srcText.slice(0, 60)));
  }
}

console.log('\n[N4] 一览表：点得开、表格真的长出来了、真实数据在表里');
{
  // 数据层期望值：直接读服务端的一览表数据作为对照
  const yl = await (await fetch(APP + 'data/grammar/yilanbiao.json')).json();
  const ylGroups = yl.groups || [];
  const ylTotal = ylGroups.reduce((n, g) => n + (g.items || []).length, 0);
  console.log(`        数据里有 ${ylGroups.length} 个分区、${ylTotal} 条`);

  // 先在**左栏**找那个入口并点掉它（从上面的章节过来时，可能正停在某条详讲上）
  //
  // ⚠️ 按 data-yilan="toggle" 找，**不能按文字「一览表」找、更不能按「副词」找** ——
  //    左栏"分类"那一排里也有一个「副词」chip（筛 470 条详讲），
  //    而"分区"那一排的「副词」筛的是一览表的 36 条速查。
  //    第一版就是按文字找「副词」，点到了分类那个，于是断言误报。
  //    教训：**界面自检要按语义找元素，不要按文案找** —— 文案会撞车。
  const opened = await ev(`(() => {
    const m = document.getElementById('mount');
    const chip = m.querySelector('.gram-side button[data-yilan="toggle"]');
    if (!chip) return { why: '左栏找不到「一览表」入口（data-yilan=toggle）',
      chips: [...m.querySelectorAll('.gram-side button.gram-chip')].map(c => c.textContent).slice(0, 30) };
    chip.click();
    return { text: chip.textContent.trim() };
  })()`);
  ok(!opened.why, '左栏出现了「一览表」入口', opened.why || '');
  if (opened.why) console.log('        左栏现有 chip：' + JSON.stringify(opened.chips));

  await sleep(700);

  // ⚠️ 这里刻意**不断言**"chip 的文案是 一览表 (81)"。
  //    文案里的条数来自数据，数据变了文案就该变 —— 断言死数字会在
  //    正常补内容时变红，那是"断言比规则窄"的老毛病（第 36 节记过）。
  //    所以只断言"里面有 一览表 三个字 + 一个数字"。
  ok(/一览表/.test(opened.text || ''), `入口文案是「${String(opened.text).trim()}」`);

  const t = await ev(`(() => {
    const m = document.getElementById('mount');
    const table = m.querySelector('table.yilan-table');
    if (!table) return { why: '右栏没有 table.yilan-table' };
    // ⚠️ 这里必须查**整页**的 tbody tr，不能只查第一张表 ——
    //    第一版写成 table.querySelectorAll('tbody tr')，只数了助词那 21 行，
    //    于是"行数和数据一致"这条断言误报（数据是对的、断言是错的）。
    //    同一个坑在本轮踩过第二次了（见 qa-layout 的 [4] 段）：**断言的取样范围写窄了**。
    const heads = [...table.querySelectorAll('thead th')].map(n => n.textContent.trim());
    const rows = [...m.querySelectorAll('table.yilan-table tbody tr')];
    const allTables = m.querySelectorAll('table.yilan-table').length;
    const h3 = [...m.querySelectorAll('.card-title h3')].map(n => n.textContent.trim());
    // 抽一行真实数据出来，好在 Node 侧比对（不能只数"有几行"）
    const sample = rows.slice(0, 3).map(r => [...r.querySelectorAll('td')].map(n => n.textContent.trim()));
    // 有没有哪一行是空的（渲染漏了）
    const emptyRows = rows.filter(r => [...r.querySelectorAll('td')].every(n => !n.textContent.trim())).length;
    // 左栏分区 chip
    const sideChips = [...m.querySelectorAll('.gram-side button.gram-chip')].map(n => n.textContent.trim());
    // ★ 用户要求「一览表里"这份表是怎么来的"没必要写，去掉」——
    //   把"去掉"也变成一条断言。只删代码不断言，下次很容易被无意加回来。
    //   同时查"元素在不在"和"整页文字里还有没有这句话"，两者都要。
    const aboutEl = m.querySelector('.gram-yilan-about');
    const bodyAllText = m.innerText || '';
    const aboutSummary = [...m.querySelectorAll('summary')].map(n => n.textContent.trim());
    return {
      heads, rowCount: rows.length, tableCount: allTables, h3, sample, emptyRows, sideChips,
      hasAbout: !!aboutEl,
      summaryTexts: aboutSummary,
      saysProvenance: /这份表是怎么来的/.test(bodyAllText),
      bodyText: m.innerText.slice(0, 60),
    };
  })()`);

  ok(!t.why, '右栏渲染出了一览表表格', t.why || '');
  if (!t.why) {
    console.log(`        表头 ${JSON.stringify(t.heads)}；共 ${t.tableCount} 张表、${t.rowCount} 行`);
    console.log(`        前 3 行：${JSON.stringify(t.sample)}`);
    console.log(`        分区标题：${JSON.stringify(t.h3)}`);

    // ① "简洁"是用户对这张表的**硬要求**：只能有词形 / 读法 / 中文意思三列。
    //    多出"例句"或"接续"就违背了原话，所以这里断言列名。
    ok(t.heads.length === 3, `表正好 3 列（实际 ${t.heads.length} 列）`, JSON.stringify(t.heads));
    ok(t.heads.includes('词形') && t.heads.includes('中文意思'),
      '列名是「词形 / 读法 / 中文意思」', JSON.stringify(t.heads));
    // 反向：确认**没有**出现用户明确说不要的两样
    ok(!t.heads.some(h => /例句|例文/.test(h)), '表里没有「例句」列（用户明确说不要）', JSON.stringify(t.heads));
    ok(!t.heads.some(h => /接续/.test(h)), '表里没有「接续」列（用户明确说不要）', JSON.stringify(t.heads));

    // ② 每个分区一张表，行数加起来必须等于数据里的条数（不是只渲染了第一张）
    ok(t.tableCount === ylGroups.length,
      `每个分区都渲染了（${t.tableCount} 张表 / 数据里 ${ylGroups.length} 个分区）`);
    ok(t.rowCount === ylTotal,
      `★ 行数和数据一致（表里 ${t.rowCount} 行 / 数据 ${ylTotal} 条）`,
      '行数对不上说明有分区或条目没渲染出来');

    // ③ 不能有空行（渲染漏了的典型症状）
    ok(t.emptyRows === 0, '没有空行', `${t.emptyRows} 行是空的`);

    // ③b ★ 用户要求去掉的"这份表是怎么来的"，必须真的不在页面上。
    //     两个口径都查：元素没了、整页文字里也没这句话。
    //     （只查一个都可能漏：元素删了但文字还留在别处，或者反之。）
    ok(!t.hasAbout, '页面上没有 .gram-yilan-about（用户要求去掉的"这份表是怎么来的"）',
      t.hasAbout ? `还有这个元素；summary=${JSON.stringify(t.summaryTexts)}` : '');
    ok(!t.saysProvenance, '整页文字里也没有"这份表是怎么来的"这句话',
      t.saysProvenance ? `文字里还有；summary=${JSON.stringify(t.summaryTexts)}` : '');

    // ④ 左栏出现了分区选择（这是"分类"要求的一部分）
    const hasParts = ['助词', '副词', '接续词', '疑问词'].filter(n => t.sideChips.some(c => c.includes(n)));
    ok(hasParts.length === 4, `左栏有四个分区入口（${hasParts.join('、')}）`, JSON.stringify(t.sideChips));

    // ⑤ 按分区筛选真的只出那一个分区
    //
    // 同样按 data-ygroup 找，不按文字（见上面 toggle 的注释）。
    const one = await ev(`(async () => {
      const m = document.getElementById('mount');
      const chip = m.querySelector('.gram-side button[data-ygroup="fukushi"]');
      if (!chip) return { why: '找不到 data-ygroup=fukushi 的分区入口' };
      chip.click();
      await new Promise(r => setTimeout(r, 500));
      const tables = m.querySelectorAll('table.yilan-table');
      const h3 = [...m.querySelectorAll('.card-title h3')].map(n => n.textContent.trim());
      const rows = m.querySelectorAll('table.yilan-table tbody tr').length;
      return { tables: tables.length, h3, rows };
    })()`);
    const advGroup = ylGroups.find((g) => g.name === '副词') || {};
    const advCount = (advGroup.items || []).length;
    ok(!one.why && one.tables === 1 && one.rows === advCount,
      `★ 点「副词」只出副词那一个分区（${one.rows} 行，期望 ${advCount}）`,
      one.why || JSON.stringify(one));
    ok(!one.why && /副词/.test((one.h3 || []).join('')), '分区标题也跟着变了', JSON.stringify(one.h3));

    // ⑥ 回到「全部」，确认能切回来（不能只出不进）
    const back = await ev(`(async () => {
      const m = document.getElementById('mount');
      const chip = m.querySelector('.gram-side button[data-ygroup="all"]');
      if (!chip) return { why: '找不到 data-ygroup=all' };
      chip.click();
      await new Promise(r => setTimeout(r, 500));
      return { tables: m.querySelectorAll('table.yilan-table').length };
    })()`);
    ok(!back.why && back.tables === ylGroups.length,
      '★ 点回「全部」能把所有分区都放出来', back.why || JSON.stringify(back));

    // ⑦ 竖排文字错位是这份 PDF 的已知问题（机器只出草稿），
    //    所以这里抽一条**已知容易错位**的条目，确认入库的是核对过的那份。
    //
    // ⚠️ 下面这条断言要先切回「全部」再找 —— 上一段刚点过「副词」，
    //    若不切回来，`が`（助词）根本不在表里，断言会误报"表里找不到「が」"。
    //    （这类"上一步的状态漏了恢复"在第 34 节也踩过：视口 emulate 没清。）
    const cell = await ev(`(async () => {
      const m = document.getElementById('mount');
      const back = m.querySelector('.gram-side button[data-ygroup="all"]');
      if (back) { back.click(); await new Promise(r => setTimeout(r, 500)); }
      for (const tr of m.querySelectorAll('table.yilan-table tbody tr')) {
        const tds = [...tr.querySelectorAll('td')].map(n => n.textContent.trim());
        if (tds[0] === 'が') return { word: tds[0], zh: tds[2] };
      }
      return { why: '表里找不到「が」' };
    })()`);
    ok(!cell.why && /主语/.test(cell.zh || '') && !/何がありますか/.test(cell.zh || ''),
      `★ 「が」那一行的中文是对的（实测 ${JSON.stringify(cell.zh)}）`,
      '如果这里混进了例句，说明用的是没核对过的草稿 —— PDF 的例句会被排到相邻行');
  }
}

ok(errs.length === 0, '控制台无 error / 异常', errs.slice(0, 2).join(' | '));

cleanup();
console.log('\n' + '='.repeat(74));
console.log(fail === 0 ? ` 全部通过（${pass} 项）` : ` ${fail} 项未通过（通过 ${pass} 项）`);
console.log('='.repeat(74));
process.exit(fail === 0 ? 0 : 1);
