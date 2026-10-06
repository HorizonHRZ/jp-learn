/**
 * test-render.mjs —— 界面冒烟测试（不依赖浏览器）
 *
 * 为什么需要：`node --check` 放过了一个真实的 ESM 语法错误
 * （app/js/views/settings.js 少一个 `)`），浏览器里表现为"页面打不开"。
 * 静态检查能查括号，但查不出"渲染时抛异常"。这里用一套最小假 DOM +
 * 内存版 IndexedDB，把真实前端代码 import 进来真的渲染一遍。
 *
 * 覆盖：[1] 启动  [2] 七个路由  [3] 背单词四页签  [3b] 练习页选模式（三选一）
 *       [3c] 今日页每日新词额度  [4] 速查抽屉  [4b] 小测端到端（抽题→作答→算分→回写 SRS/错题本）
 *       [5] 无错误  [7] 统计页（熟练度分布/到期量/错题 Top20，且没有热力图）
 */
import { installFakeDOM } from './lib/fake-dom.mjs';
import fs from 'node:fs';
import path from 'node:path';
// 假 fetch 里要用真分词器算振假名（否则语法页测的就不是真数据了）
import { buildReading, initTokenizer } from './tokenizer.js';
// 隐私说明的**权威版本**。设置页显示的和首次确认框弹出的都应该是这一份；
// 浏览器侧 app/js/ai.js 里另有一份兜底副本，[9e] 会断言两份一致。
import { AI_PRIVACY_TEXT } from './aiconf.js';
// 【务必用这个】源码扫描要先剥注释，否则会把"解释规矩的注释"当成违规。
// 这个坑在本项目里踩了六次，所以抽成共用函数（详见该文件头部注释）。
import { codeOnly, codeLike, stringLiterals } from './lib/srcscan.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
let fail = 0, pass = 0;
const check = (cond, label, detail) => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? '  — ' + detail : ''}`);
};

// ============================================================================
// 一、最小假 DOM
// ============================================================================

// 假 DOM 的实现与注释在 tools/lib/fake-dom.mjs —— 抽出去是为了让
// test-airead.mjs（测"按段翻译 + 译文缓存"）用**同一套**假 DOM。
// 抄一份的话两份会各自演化，而不一致的时候测试**还是会绿**。
const { docBody, FakeNode, fakeWindow, fakeLocation } = installFakeDOM();


// ============================================================================
// 二、内存版 IndexedDB
// ============================================================================

function makeIDB() {
  const dbs = new Map();
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const rec = (name) => {
    if (!dbs.has(name)) dbs.set(name, { name, version: 0, stores: new Map() });
    return dbs.get(name);
  };
  const storeOf = (db, n) => {
    if (!db.stores.has(n)) db.stores.set(n, { name: n, keyPath: null, data: new Map(), indexes: new Map() });
    return db.stores.get(n);
  };
  const tx = (db) => {
    const t = { error: null, oncomplete: null, onerror: null, onabort: null };
    t.objectStore = (n) => {
      const s = storeOf(db, n);
      const req = (fn) => {
        const r = { result: undefined, error: null, onsuccess: null, onerror: null };
        setTimeout(() => {
          try { r.result = fn(); if (r.onsuccess) r.onsuccess({ target: r }); }
          catch (e) { r.error = e; if (r.onerror) r.onerror({ target: r }); }
        }, 0);
        return r;
      };
      return {
        get: (k) => req(() => { const v = s.data.get(k); return v === undefined ? undefined : clone(v); }),
        put: (v) => req(() => { const k = s.keyPath ? v[s.keyPath] : v.key; s.data.set(k, clone(v)); return k; }),
        delete: (k) => req(() => { s.data.delete(k); return undefined; }),
        clear: () => req(() => { s.data.clear(); return undefined; }),
        getAll: () => req(() => Array.from(s.data.values()).map(clone)),
        count: () => req(() => s.data.size),
        index: () => ({ getAll: () => req(() => []) }),
        createIndex: (n) => { s.indexes.set(n, true); return {}; },
        indexNames: { contains: (n) => s.indexes.has(n) },
      };
    };
    setTimeout(() => { if (t.oncomplete) t.oncomplete(); }, 0);
    return t;
  };
  return {
    open(name, version) {
      const r = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      setTimeout(() => {
        const db = rec(name);
        const old = db.version;
        const target = version || 1;
        const api = {
          name,
          objectStoreNames: { contains: (n) => db.stores.has(n) },
          createObjectStore: (n, opt) => {
            const s = storeOf(db, n);
            s.keyPath = opt && opt.keyPath;
            return { indexNames: { contains: (x) => s.indexes.has(x) }, createIndex: (x) => s.indexes.set(x, true) };
          },
          transaction: () => tx(db),
          close: () => {},
        };
        Object.defineProperty(api, 'version', { get: () => db.version });
        r.result = api;
        if (target > old) {
          db.version = target;
          if (r.onupgradeneeded) r.onupgradeneeded({ target: { result: api, oldVersion: old, newVersion: target } });
        }
        if (r.onsuccess) r.onsuccess({ target: r });
      }, 0);
      return r;
    },
    deleteDatabase(name) {
      const r = { onsuccess: null, onerror: null };
      setTimeout(() => { dbs.delete(name); if (r.onsuccess) r.onsuccess(); }, 0);
      return r;
    },
  };
}
globalThis.indexedDB = makeIDB();

/**
 * 假 fetch —— 让语法页能在 Node 里**真的跑起来**，而不是一进去就报错、只渲染出一个错误块。
 *
 * 为什么必须装这个：语法页一上来就 fetch('/data/grammar/index.json')，
 * 点开某条又 fetch('/api/grammar/entry?id=…')。Node 里没有 fetch 的可用实现，
 * 不装的话视图会走 catch 分支渲染"读不到语法数据"，
 * 于是路由测试虽然"通过"（没抛错），但**根本没测到页面本身**（只渲染出 1 个节点）。
 *
 * 这里刻意返回**真实数据**（从磁盘读 data/grammar/，并用真分词器算振假名），
 * 而不是编一个假响应 —— 否则测的又是一个不存在的世界。
 */
const realFetch = globalThis.fetch;
let tokenizerReady = false;

/**
 * AI 配置的**可变状态**（这个桩是要有状态的）。
 * 因为设置页的"保存 → 界面更新"必须真的能测：
 * 无状态桩会让保存看起来没生效。
 */
const aiConfigState = {
  enabled: false, configured: false, baseURL: '', model: '',
  hasKey: false, keyHint: '', temperature: 0.3, maxTokens: 1200,
};
const AI_PRESETS = [
  { id: 'deepseek', label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'ollama', label: '本机 Ollama（不联网）', baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
  { id: 'custom', label: '其他（自己填地址）', baseURL: '', model: '' },
];
/** 记录设置页提交过的 patch，用来断言"没输密钥就不提交 apiKey" */
const savedAiPatches = [];

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = String((opts && opts.method) || 'GET').toUpperCase();
  const json = (obj, status = 200) => ({
    ok: status < 400,
    status,
    async json() { return obj; },
    async text() { return JSON.stringify(obj); },
  });
  if (u.includes('/data/grammar/index.json')) {
    return json(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/grammar/index.json'), 'utf8')));
  }
  // ---- AI 配置：保存后要真的改变状态，否则测不出界面有没有跟上 ----
  if (u.includes('/api/ai/config')) {
    if (method === 'POST') {
      let patch = {};
      try { patch = JSON.parse(opts.body || '{}'); } catch { /* 保持空 */ }
      savedAiPatches.push(patch);
      Object.assign(aiConfigState, patch);
      // 服务端的语义：传了 apiKey 就改（空串=删），没传就不动
      if (Object.prototype.hasOwnProperty.call(patch, 'apiKey')) {
        aiConfigState.hasKey = !!patch.apiKey;
        aiConfigState.keyHint = patch.apiKey ? 'sk-t••••••••••••mnop' : '';
        delete aiConfigState.apiKey;   // 服务端**不会**把密钥回给浏览器
      }
      aiConfigState.configured = !!(aiConfigState.baseURL && aiConfigState.model && aiConfigState.hasKey);
    }
    // ⚠️ 返回体里**永远没有 apiKey** —— 生产代码也是这样，测试桩必须一致
    return json({
      ok: true,
      config: {
        enabled: aiConfigState.enabled,
        configured: aiConfigState.configured,
        baseURL: aiConfigState.baseURL,
        model: aiConfigState.model,
        hasKey: aiConfigState.hasKey,
        keyHint: aiConfigState.keyHint,
        temperature: aiConfigState.temperature,
        maxTokens: aiConfigState.maxTokens,
      },
      presets: AI_PRESETS,
      // 服务端下发的隐私说明（单一来源在 tools/aiconf.js）
      privacy: AI_PRIVACY_TEXT,
      file: 'config.local.json',
    });
  }
  if (u.includes('/api/grammar/entry')) {
    // 分词器要显式初始化才能用（和 test-tokenizer.mjs 一样）。
    // 懒初始化：只有真的走到语法页才付这个代价，不影响别的路由的测试速度。
    if (!tokenizerReady) { await initTokenizer(); tokenizerReady = true; }
    const id = new URL(u, 'http://localhost/').searchParams.get('id');
    const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/grammar/index.json'), 'utf8'));
    const meta = index.items.find((x) => x.id === id);
    if (!meta) return json({ ok: false, error: '没有这条语法：' + id });
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/grammar', meta.file), 'utf8'));
    const item = data.items.find((x) => x.id === id);
    const opts = { romajiStyle: 'hepburn', particleRule: true, ruby: true };
    const examples = (item.examples || []).map((e) => {
      const r = buildReading(e.ja, opts);
      return {
        ja: e.ja, zh: e.zh || '', note: e.note || '',
        reading: r.error ? null : {
          tokens: r.tokens, kana: r.kana, romaji: r.romaji,
          unknownSurfaces: r.unknownSurfaces, coverage: r.coverage, rubyEstimated: r.rubyEstimated,
        },
        readingError: r.error || null,
      };
    });
    return json({ ok: true, item: { ...item, examples }, dictReady: true });
  }
  // 其它请求交回真 fetch（本项目视图目前没有别的请求）
  if (realFetch) return realFetch(url);
  throw new Error('未处理的请求：' + u);
};


// ============================================================================
// 三、测试
// ============================================================================

const errors = [];
const origError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); };

const withTimeout = (p, ms, label) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error('超时: ' + label)), ms)),
]);

const boot = new FakeNode('div'); boot.id = 'boot';
const nav = new FakeNode('nav'); nav.id = 'nav';
const mount = new FakeNode('div'); mount.id = 'mount';
const foot = new FakeNode('div'); foot.id = 'foot';
for (const n of [boot, nav, mount, foot]) docBody.appendChild(n);
// 启动时让路由落在首页
fakeLocation.hash = '#/home';

console.log('='.repeat(72));
console.log(' 界面冒烟测试（假 DOM + 内存 IndexedDB）');
console.log('='.repeat(72));

console.log('\n[1] 启动应用');
// app.js 在模块顶层自动调用 boot()（和浏览器里一致），所以这里 import 之后等它跑完
await import('../app/js/app.js');
await new Promise((r) => setTimeout(r, 1500));
check(!/应用启动失败/.test(boot.textContent), '启动没有失败', boot.textContent.slice(0, 160));
const navLinks = nav.querySelectorAll('a[data-view]');
check(navLinks.length === 9, '导航有 9 项（工具箱 + 快照各一项）', `实际 ${navLinks.length}`);
check(!/应用启动失败/.test(mount.textContent), '首屏已渲染', `${mount.childNodes.length} 个节点`);

console.log('\n[2] 逐个路由渲染');
const ROUTES = ['home', 'vocab', 'lyric', 'reading', 'grammar', 'toolbox', 'stats', 'snapshots', 'settings'];
const { createRouter } = await import('../app/js/router.js');
const router = createRouter({ nav, mount, foot });
for (const r of ROUTES) {
  mount.innerHTML = '';
  let err = null;
  try {
    // 必须改 location.hash —— router 是从 hash 解析当前路由的
    fakeLocation.hash = '#/' + r;
    await withTimeout(router.render(), 10000, r);
  } catch (e) { err = e; }
  // 注意：不能只看"文字里有没有出错字样"，要直接看是否被替换成了错误占位块
  const emptyTitle = mount.querySelector('.empty-title');
  const broken = emptyTitle && /打不开|渲染出错/.test(emptyTitle.textContent);
  check(!err && !broken, `路由 #/${r} 渲染正常`,
    err ? err.message : (broken ? (mount.querySelector('.empty-hint') || {}).textContent : `${mount.childNodes.length} 个节点`));
  // 等 hashchange 触发的异步 render 也跑完，避免污染下一个路由
  await new Promise((res) => setTimeout(res, 250));
  // 回归：任何视图渲染都不许把顶部导航栏弄没（用户反馈过导航栏"消失"）。
  // 这里断言每次路由切换后 nav 仍在 DOM 里、9 个链接都在、没有被加上隐藏类。
  const linksAfter = nav.querySelectorAll('a[data-view]');
  const navHidden = nav.classList.contains('hidden') ||
    /display\s*:\s*none/.test(nav.getAttribute('style') || '');
  check(linksAfter.length === 9 && !navHidden,
    `路由 #/${r} 渲染后导航栏仍然完好`,
    `链接 ${linksAfter.length} 个${navHidden ? '，但被隐藏了' : ''}`);
}

console.log('\n[2b] 首页入口排成齐整的两行（4+4）');
{
  // 需求：模块入口要排满、不能出现"第一行 5 个 + 第二行 1 个"那种落单。
  // 历史：6 个入口时用固定 3 列（3+3）；加「工具箱」变 7 个，3 列变成 3+3+1
  // 又落单，所以宽屏改 4 列（4+3）；再加「快照备份」变 8 个，4 列正好 4+4。
  // 这里断言数量 + 列数 + 最后一行不落单，任何一项被改坏都会被测出来。
  const homeHost = new FakeNode('div');
  const homeView = await import('../app/js/views/home.js');
  await withTimeout((homeView.default || homeView.view).render(homeHost), 10000, 'home');
  const tilesBox = homeHost.querySelectorAll('.tiles');
  check(tilesBox.length === 1, '首页用了固定列数的 .tiles 容器', `实际 ${tilesBox.length}`);
  const tiles = homeHost.querySelectorAll('.tile');
  check(tiles.length === 8, '首页有 8 个功能入口（工具箱 + 快照备份）', `实际 ${tiles.length}`);
  const cols = 4;
  check(tiles.length % cols === 0,
    `${tiles.length} 个入口正好排满 ${cols} 列 → ${tiles.length / cols} 行，完全齐整`);
  const css = fs.readFileSync(path.join(ROOT, 'app/css/theme.css'), 'utf8');
  check(/\.tiles\s*\{[^}]*grid-template-columns:\s*repeat\(4,/.test(css),
    '.tiles 在宽屏是固定 4 列（不是 auto-fit）');
  check(/@media\s*\(max-width:\s*1100px\)\s*\{\s*\.tiles\s*\{\s*grid-template-columns:\s*repeat\(3,/.test(css),
    '中等屏幕退到 3 列');
  check(/@media\s*\(max-width:\s*900px\)\s*\{\s*\.tiles\s*\{\s*grid-template-columns:\s*repeat\(2,/.test(css),
    '窄一点退到 2 列');
  check(/@media\s*\(max-width:\s*560px\)\s*\{\s*\.tiles\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(css),
    '窄屏退到 1 列');
  check(!/class: 'grid grid-3'/.test(fs.readFileSync(path.join(ROOT, 'app/js/views/home.js'), 'utf8')),
    'home.js 没有再使用 auto-fit 的 grid-3');

  // 首页文案与模块的精简（都是用户明确要求的删减，断言防止又被加回来）
  const homeHost2 = new FakeNode('div');
  await withTimeout((homeView.default || homeView.view).render(homeHost2), 10000, 'home2');
  const homeText = homeHost2.textContent;
  check(!/不联网/.test(homeText) && !/不上传/.test(homeText),
    '首页不再声称「不联网、不上传」（要接入 AI，这句话会变成假的）');
  check(/只保存在这台电脑|本机浏览器|IndexedDB/.test(homeText),
    '首页仍然说清楚"数据只存本地"这一条（硬约束 2 没变）');
  check(!/最近一次数据快照/.test(homeText),
    '首页删掉了「最近一次数据快照」卡片（已由「快照备份」页承担）');
}

console.log('\n[3] 背单词页四个页签');
// 单独用一个干净容器直接渲染 vocab 视图，避开 router 异步渲染的干扰
await new Promise((res) => setTimeout(res, 400));
const vocabHost = new FakeNode('div');
const vocabView = await import('../app/js/views/vocab.js');
await withTimeout((vocabView.default || vocabView.view).render(vocabHost), 10000, 'vocab');
const tabs = vocabHost.querySelectorAll('.tab');
check(tabs.length === 4, '有四个页签（今日/练习/词表/错题）', `实际 ${tabs.length}`);
const tabText = tabs.map((t) => t.textContent).join('/');
check(/今日/.test(tabText) && /练习/.test(tabText) && /词表/.test(tabText) && /错题/.test(tabText),
  '四个页签文案正确', tabText.slice(0, 60));

console.log('\n[3b] 练习页：第一屏选模式（三选一）+ 小测入口');
{
  // 切到练习页签：找到那个 .tab 按钮点一下
  const practiceTab = tabs.find((t) => /练习/.test(t.textContent));
  practiceTab.dispatch('click', { type: 'click', target: practiceTab });
  await new Promise((r) => setTimeout(r, 400));

  const body = vocabHost.textContent || '';
  // 文案已从「选择练习内容」改成「练习」（页面标题）＋「练习内容」（内容小标题），
  // 这里断言的是"入口还在"，所以查的是仍然存在的那半句。
  check(/练习内容/.test(body), '练习入口还在（没有把小测挤掉）');
  check(/小测/.test(body), '练习页里有「小测」入口');

  // 第一屏必须先是选模式：三个 .mode-item 按钮，且文案与 quiz.js 的三种模式一致
  const modeItems = vocabHost.querySelectorAll('.mode-item');
  check(modeItems.length === 3, '练习页有 3 个练习模式按钮', `实际 ${modeItems.length}`);
  const modeText = modeItems.map((m) => m.textContent).join('/');
  check(/看日文单词选意思/.test(modeText) && /看汉字选日文/.test(modeText) && /看汉语意思手动输入日文/.test(modeText),
    '三个模式是对外承诺的那三个', modeText.slice(0, 80));
  check(!/听写|填空|假名/.test(modeText), '已删除的听写/填空/假名模式没有复活', modeText.slice(0, 80));

  const startBtn = vocabHost.querySelectorAll('.btn').find((b) => /开始小测/.test(b.textContent));
  check(!!startBtn, '有「开始小测」按钮');
  check(/定题量/.test(body), '小测说明了它的特点（定题量 · 可计时）');
  check(/不计时/.test(body), '计时选项里有「不计时」');
}

console.log('\n[3c] 今日页：每日新词额度行 + 自动评分（没有评分按钮）');
{
  // 页签状态是模块级的（切走再回来不丢），上一节把视图停在练习页了，
  // 所以这里必须显式切回「今日」页签，否则查的是练习页的文案。
  const todayTab = vocabHost.querySelectorAll('.tab').find((t) => /今日/.test(t.textContent));
  check(!!todayTab, '能找回「今日」页签');
  todayTab.dispatch('click', { type: 'click', target: todayTab });
  await new Promise((r) => setTimeout(r, 400));

  // 2026-10 之后这里**有两行**额度（新词一行、复习一行），所以不能再断言 length===1。
  // 改成按内容分别找：这样以后再加一行额度也不会又把这条测试弄红。
  const quota = vocabHost.querySelectorAll('.quota-line');
  check(quota.length >= 2, '今日页有额度行（新词 + 复习）', `实际 ${quota.length}`);
  const lines = quota.map((q) => q.textContent || '');
  const quotaText = lines.find((t) => /每日新词/.test(t)) || '';
  check(/每日新词：今天已学 \d+ \/ \d+，还剩 \d+ 个/.test(quotaText),
    '额度行说清了今日已学 / 上限 / 还剩', quotaText || '(没有额度行)');
  // 默认上限必须是 50（用户指定），这条文案是唯一能直接看出默认值的地方
  const m = quotaText.match(/每日新词：今天已学 \d+ \/ (\d+)/);
  check(!!m && m[1] === '50', '新词额度默认 50（设置里可改）', m ? m[1] : '(没匹配到)');

  // 每日复习上限（2026-10 新增）：默认 50，且必须把"到期总数"和"今天还剩"都写出来
  const revText = lines.find((t) => /每日复习/.test(t)) || '';
  check(/每日复习：/.test(revText), '有每日复习额度行', revText || '(没有)');
  const rm = revText.match(/每日复习：今天已复习 (\d+) \/ (\d+)/);
  // 默认值改过一次（40 → 50，用户看过 12 倍实测数据后定的），所以这里跟着改。
  // 顺带钉一句：界面上**不该再出现"不限量"**——范围已收成 20–200，0 填不出来了。
  check(!!rm && rm[2] === '50', '复习额度默认 50（设置里可改）', rm ? rm[2] : '(没匹配到)');
  check(!/不限量/.test(revText), '额度行不该再出现"不限量"（范围 20–200，填不出 0）',
    revText || '(没有额度行)');
  // ★ 这条是那次真 bug 的护栏：以前按钮写"537 个到期"、点进去只给 40 个，
  //   而"537"和"40"两个数在界面上从来不同时出现，用户无从判断。
  //   现在要求：这一行必须说清今天的处置 —— 还有多少可做、或已完成、
  //   或今天本来就没有到期的（三选一，不能什么都不说）。
  check(/今天还剩|今天的额度已完成|今天没有到期的词/.test(revText),
    '复习额度行写明了今天的处置（还剩/已完成/无到期）', revText || '(没有)');

  // 没有任何评分按钮：答对由程序自动判 good
  check(vocabHost.querySelectorAll('.grade-row').length === 0, '练习界面没有三档评分按钮行');
  const src = fs.readFileSync(path.join(ROOT, 'app/js/views/vocab.js'), 'utf8');
  check(/gradeAuto/.test(src) && !/grade-row/.test(src), '评分改成自动（gradeAuto），评分按钮代码已删除');
}

console.log('\n[4] 全局速查抽屉');
const drawer = await import('../app/js/drawer.js');
const fnCount = Object.values(drawer).filter((v) => typeof v === 'function').length;
check(fnCount > 0, 'drawer.js 导出可用函数', `${fnCount} 个`);

console.log('\n[4b] 小测端到端：抽题 → 作答 → 算分 → 回写 SRS/错题本');
{
  const db = fakeWindow.JP.db;
  const vd = await import('../app/js/vocabdata.js');
  const T = await import('../app/js/testrun.js');
  const Q = await import('../app/js/quiz.js');

  // 造 12 个"用户在学"的词（id 前缀用 jmdict:，与真实生词本一致）
  const words = Array.from({ length: 12 }, (_, i) => ({
    id: `jmdict:test${i}`, term: `試験語${i}`, reading: `しけんご${i}`,
    zh: [`测试词${i}`], level: 'N5', pos: ['名'], createdAt: Date.now() - i,
  }));
  for (const w of words) await db.dbPut('words', w);
  const listed = await vd.listWords();
  check(listed.length >= 12, '生词本已写入 12 个词', `实际 ${listed.length}`);

  // 组卷：6 题、不限时
  const pool = words.concat();
  const test = T.createTest({
    id: 'test-e2e', source: 'vocab', words: listed, count: 6,
    timeLimitMs: 0, now: 1000, modes: ['jp2zh', 'zh2jp'],
    buildQuestions: (ws, o) => Q.buildQuiz(ws, { count: ws.length, pool, rand: o.rand, modes: o.modes }),
  });
  check(test.queue.length === 6, '小测出到 6 题', `实际 ${test.queue.length}`);

  // 逐题作答：前 4 题故意答对（把正确答案填进去），后 2 题答错
  let t = test;
  for (let i = 0; i < 6; i++) {
    const cur = T.currentQuestion(t);
    const q = cur.question;
    const answer = i < 4 ? q.answer : '肯定是错的答案';
    const ok = Q.checkAnswer(answer, q, q.answerSide).ok;
    t = T.submitTestAnswer(t, { input: answer, ok, now: 1000 + i });
  }
  t = T.finishTest(t, 2000);
  check(t.result.correct === 4 && t.result.wrong === 2, '算分：对 4 错 2',
    `${t.result.correct}/${t.result.wrong}`);
  check(t.result.accuracy === 66.7, '正确率 66.7%', String(t.result.accuracy));
  check(t.result.unanswered === 0, '没有未作答');

  // 回写：走 gradesForWriteback → recordAnswer（与练习同一路径）
  const rows = T.gradesForWriteback(t);
  check(rows.length === 6, '每道题都生成了回写记录', String(rows.length));
  let okCount = 0;
  for (const row of rows) {
    const inVocab = await vd.isInVocab(row.wordId);
    if (!inVocab) continue;
    await vd.recordAnswer({
      wordId: row.wordId, grade: row.grade, mode: 'test',
      correct: row.correct, input: row.input, expected: row.expected, now: Date.now(),
    });
    okCount++;
  }
  check(okCount === 6, '6 条全部写入（词都在生词本里）', String(okCount));

  const srs = await db.dbAll('srs');
  check(srs.length === 6, 'SRS 排程写了 6 个词', `实际 ${srs.length}`);
  const mistakes = await db.dbAll('mistakes');
  check(mistakes.length === 2, '错题本只记了答错的 2 个词（答对不进错题本）', `实际 ${mistakes.length}`);
  check(mistakes.every((m) => m.wrongCount === 1 && m.byMode && m.byMode.test === 1),
    '错题记录带 wrongCount 与 byMode.test');
  const reviews = await db.dbAll('reviews');
  check(reviews.length === 6, '答题历史追加了 6 条', `实际 ${reviews.length}`);
  check(reviews.every((r) => r.mode === 'test'), '历史里模式标记为 test（可区分练习/小测）');

  // 答对的词 SRS 状态应该推进（不是停在 new）
  const correctIds = rows.filter((r) => r.correct).map((r) => r.wordId);
  const correctCards = srs.filter((c) => correctIds.includes(c.wordId));
  check(correctCards.every((c) => c.state !== 'new'), '答对的词 SRS 状态已推进（不再是 new）',
    correctCards.map((c) => c.state).join(', '));
}

console.log('\n[7] 统计页：只给行动导向的数字，没有热力图');
{
  // 用户明确要求删掉热力图（"对实际学习没有帮助的花哨功能"）。
  // 光断言"能渲染"挡不住它被加回来，所以要同时断言：
  //   (1) 三个该有的东西真的渲出来了（而且带真实数据，不是空壳）
  //   (2) 热力图的痕迹不在
  // 这里用的是 [4b] 已经造好的数据：12 个词在生词本、6 个有排程、2 个错题。
  await new Promise((res) => setTimeout(res, 200));
  const statsHost = new FakeNode('div');
  const statsView = await import('../app/js/views/stats.js');
  await withTimeout((statsView.default || statsView.view).render(statsHost), 10000, 'stats');

  // (1) 熟练度分布：4 档都在，且数字是真实的
  //     ⚠️ 别断言"还没开始 = 6"：分布统计的是 **SRS 排程（cards）** 的状态，
  //     不是生词本的词数。[4b] 只给 6 个作答过的词建了排程，所以总数就是 6，
  //     全部处于「学习中」。这里要守的是"数字来自真实数据、不是写死的 0"。
  const distRows = statsHost.querySelectorAll('.dist-row');
  check(distRows.length === 4, '熟练度分布有四档', `实际 ${distRows.length}`);
  const distText = distRows.map((r) => r.textContent).join(' | ');
  check(/还没开始/.test(distText) && /学习中/.test(distText)
    && /复习中/.test(distText) && /已记牢/.test(distText),
    '四档文案是 还没开始/学习中/复习中/已记牢');
  check(/学习中\s*6 个 · 100%/.test(distText),
    '分布数字来自真实数据（6 个已排程的词都在「学习中」）', distText.slice(0, 90));

  // (2) 未来 14 天到期量：14 根柱子
  const foreCols = statsHost.querySelectorAll('.fore-col');
  check(foreCols.length === 14, '未来到期量画了 14 天', `实际 ${foreCols.length}`);
  check(foreCols[0] && /今天/.test(foreCols[0].textContent), '第一根柱子标的是「今天」');

  // (3) 错题 Top20：应该有 2 条真实错题
  const missRows = statsHost.querySelectorAll('.miss-row');
  check(missRows.length === 2, '错题列表列出了 2 条真实错题', `实际 ${missRows.length}`);
  check(/错 1 次/.test(missRows.map((r) => r.textContent).join(' ')), '错题行显示错误次数');

  // (4) 「去错题本」按钮存在，且点它会切到背单词的错题标签页
  const gotoBtn = statsHost._walk([]).find((n) => n.tagName === 'BUTTON' && /去错题本/.test(n.textContent));
  check(!!gotoBtn, '有「去错题本练这几个」按钮');
  if (gotoBtn) {
    fakeLocation.hash = '#/stats';           // 模拟"人在统计页"
    const vocabMod = await import('../app/js/views/vocab.js');
    gotoBtn.dispatch('click', { type: 'click', target: gotoBtn });
    await new Promise((res) => setTimeout(res, 300));
    check(fakeLocation.hash === '#/vocab', '点击后跳到背单词页', fakeLocation.hash);
    // 落到「错题」标签而不是默认的「今日」——这正是需要 goVocabTab 而不是直接改 hash 的原因
    const vHost = new FakeNode('div');
    await withTimeout((vocabMod.default || vocabMod.view).render(vHost), 10000, 'vocab');
    const activeTab = vHost.querySelectorAll('.tab').find((t) => t.classList.contains('active'));
    check(!!activeTab && /错题/.test(activeTab.textContent),
      '落地在「错题」标签页（不是默认的「今日」）', activeTab ? activeTab.textContent.trim() : '找不到活动标签');
  }

  // (5) 热力图必须真的没有被实现
  //     ⚠️ 不能只搜 "热力图" 这个字眼：stats.js 的注释和页面说明里**故意**写着
  //     "热力图这类打卡指标刻意不做"，那是设计记录，正是要保留的。
  //     要断言的是"没有实现痕迹"——热力图必然需要一套格子/单元的 CSS 类，
  //     所以查 CSS 里有没有相关的类才是有效断言。
  const cssSrc = fs.readFileSync(path.join(ROOT, 'app/css/theme.css'), 'utf8');
  const heatCss = cssSrc.match(/\.(heat|heatmap|cal-|calendar|contrib)[a-z-]*\s*\{/gi) || [];
  check(heatCss.length === 0, 'CSS 里没有任何热力图/日历格子样式', heatCss.join(' '));
  const statsNoComment = fs.readFileSync(path.join(ROOT, 'app/js/views/stats.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check(!/heatmap|heat-map|daily-grid|year-grid/i.test(statsNoComment),
    'stats.js 里没有热力图的实现代码（注释里记录"不做"是允许的）');
  const homeSrc = fs.readFileSync(path.join(ROOT, 'app/js/views/home.js'), 'utf8');
  check(!/热力图/.test(homeSrc), '首页入口描述里不再提热力图');
}

console.log('\n[5] 工具箱：三个工具都在，且砍掉的三个没有被偷偷加回来');
{
  // 需求：工具箱收敛成 4 项（原本 3 项，本轮加了「动词・形容词变形表」——
  //       用户明确要求"在工具箱里能查ます、て等形式的变法"）。
  // 砍掉的：查词（已在全局速查抽屉，重复）、假名练习（用户明确否决）、
  //         词表格式转换（降到「数据与设置 → 导入」）。
  // 这里既断言"四个都在"，也断言"砍掉的不在"，否则以后很容易顺手加回来。
  const tbHost = new FakeNode('div');
  const tbView = await import('../app/js/views/toolbox.js');
  await withTimeout((tbView.default || tbView.view).render(tbHost), 10000, 'toolbox');
  const tbTabs = tbHost.querySelectorAll('.tab');
  check(tbTabs.length === 4, '工具箱恰好 4 个工具', `实际 ${tbTabs.length}`);
  const tbText = tbTabs.map((t) => t.textContent).join('/');
  check(/活用还原器/.test(tbText), '有「活用还原器」', tbText);
  check(/变形表/.test(tbText), '有「动词・形容词变形表」', tbText);
  check(/汉字读音反查/.test(tbText), '有「汉字读音反查」', tbText);
  check(/数字/.test(tbText) && /量词/.test(tbText), '有「数字・日期・量词」', tbText);

  // ★ 变形表和还原器**都必须留着** —— 它们回答的是相反方向的问题，
  //   少任何一个，用户就有一半的问题没法问。
  check(/活用还原器/.test(tbText) && /变形表/.test(tbText),
    '★★ 正向（变形表）和反向（还原器）两个工具并存，不能只留一个');

  const tbSrc = fs.readFileSync(path.join(ROOT, 'app/js/views/toolbox.js'), 'utf8');
  const tbCode = tbSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check(!/假名练习/.test(tbCode), '没有被否决的「假名练习」');
  check(!/词表格式转换|格式转换/.test(tbCode), '「词表格式转换」没有留在工具箱里');

  // 规则引擎必须和视图分开、且校验脚本能直接 import
  // （纯函数模块才能让 tools/check-counters.mjs 复用同一份规则）
  check(fs.existsSync(path.join(ROOT, 'app/js/counter.js')), '数字读法规则抽成了 app/js/counter.js');
  const counterSrc = fs.readFileSync(path.join(ROOT, 'app/js/counter.js'), 'utf8');
  check(!/\bdocument\b|\bwindow\b/.test(counterSrc.replace(/\/\*[\s\S]*?\*\//g, '')),
    'counter.js 不碰 DOM（所以 Node 里能直接 import 校验）');

  // 变形规则同理，而且更严格：变形规则**必须能被 Node 直接 import**，
  // 因为 tools/test-conj.mjs 要靠它做"正向推出 → 丢回还原器 → 验往返"。
  // 一旦有人往 conj.js 里加 DOM 调用，那套验证就整体失效了。
  check(fs.existsSync(path.join(ROOT, 'app/js/conj.js')), '变形规则抽成了 app/js/conj.js');
  const conjSrc = fs.readFileSync(path.join(ROOT, 'app/js/conj.js'), 'utf8');
  const conjCode = conjSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check(!/\bdocument\b|\bwindow\b|\blocalStorage\b/.test(conjCode),
    '★★ conj.js 不碰 DOM / localStorage（否则 test-conj.mjs 的往返验证会整体失效）');
  check(!/\bfetch\s*\(/.test(conjCode), 'conj.js 不发网络请求（纯规则，离线可用）');
  check(fs.existsSync(path.join(ROOT, 'tools/test-conj.mjs')),
    '存在 tools/test-conj.mjs（变形规则校验脚本）');

  // 工具 3 的读数必须和词库对得上：对账脚本必须存在
  check(fs.existsSync(path.join(ROOT, 'tools/check-counters.mjs')),
    '存在 tools/check-counters.mjs（数字读法对账脚本）');

  // 工具箱**不该**注册全局 keydown。
  // test-contract.mjs 会强制"注册了全局 keydown 就必须在 destroy 里摘掉"，
  // 而工具箱的 Enter 提交是绑在局部 input 上的，压根不需要全局监听。
  // 这里断言 window.addEventListener('keydown' 一次都没出现，避免以后误加。
  const globalKeydowns = tbSrc.match(/window\.addEventListener\(\s*['"]keydown['"]/g) || [];
  check(globalKeydowns.length === 0,
    '工具箱没有注册全局 keydown（Enter 提交绑在局部 input 上）', `${globalKeydowns.length} 处`);

  // ---- 工具 2：动词・形容词变形表（本轮新增）----
  //
  // 这一块要验的不是"页面上有个表"，而是**这个工具不会骗用户**。
  // 变形规则对初学者是"没法自己验错"的东西：他看到一个错的变形表也认不出来。
  // 所以三件事必须成立：
  //   ① 判定结果（这是几段动词）要显式说出来；
  //   ② 拿不准时要标出来，并且允许手动改；
  //   ③ 手动改之后表要真的跟着变。
  const tbTabs2 = tbHost.querySelectorAll('.tab');
  const conjTab = tbTabs2.find((t) => /变形表/.test(t.textContent));
  check(!!conjTab, '找得到「变形表」这个工具页签');
  conjTab.click();
  const conjHost = tbHost;
  const conjTables = conjHost.querySelectorAll('.conj-table');
  check(conjTables.length >= 2, '变形表页有两块内容（变形表 + 按形态查规则）', `实际 ${conjTables.length}`);

  // 默认应该已经算过一个例子 —— 空白工具没人会用
  const conjText = conjHost.textContent;
  check(/使います/.test(conjText), '★ 打开就有例子（默认算过「使う」），不是空白页', conjText.slice(0, 120));
  check(/使って/.test(conjText), '★ 例子里包含て形（用户最想要的就是这个）');
  check(/使わない/.test(conjText), '例子里包含ない形');

  // ① 判定依据必须写出来
  check(/以「う」结尾/.test(conjText) || /五段/.test(conjText),
    '★★ 显式说明了判定依据（不是默默给一张表）', conjText.slice(0, 200));

  // ②③ 手动改词类之后，表必须真的变
  const typeSel = conjHost.querySelectorAll('select').find((s) =>
    [...(s.childNodes || [])].some((o) => /自动判断/.test(o.textContent || '')));
  check(!!typeSel, '类型选择器存在（第一项是「自动判断词类」）');
  const opts = [...(typeSel.childNodes || [])];
  check(opts.length >= 7, '词类选择器里每种词类都能选（≥7 项）', `实际 ${opts.length}`);
  const hasMan = opts.some((o) => /一段/.test(o.textContent));
  check(hasMan, '★ 能手动指定「一段动词」（这是纠错入口，不能藏起来）');

  // 把「使う」当一段动词强制变一遍 —— 结果必须是错的日语，
  // 这正好证明"手动指定真的生效了"，而不是摆设。
  const textInput = conjHost.querySelectorAll('input').find((i) => /辞书形/.test(i.attributes.get('placeholder') || ''));
  check(!!textInput, '辞书形输入框存在');
  const ichidanOpt = opts.find((o) => /一段/.test(o.textContent));
  typeSel.value = ichidanOpt.attributes.get('value') || 'ichidan';
  typeSel.dispatch('change');
  const afterText = conjHost.textContent;
  check(/手动指定/.test(afterText),
    '★★ 手动指定后明确告诉用户"这是按你选的类型变的"（否则他不知道该不该信）', afterText.slice(0, 200));
  check(!/使います/.test(afterText),
    '★★ 手动指定一段后，「使う」不再给出「使います」（表确实跟着类型变了）');
}

console.log('\n[6] 快照备份页：占用可见 + 与导出的区别讲清楚');
{
  // 需求：快照从设置页拆成独立页，并且要显示总占用（用户明确要求）。
  // 同时必须警告"快照救不了浏览器数据被清理"，否则用户会以为有快照就不用导出 ——
  // 那正好是最危险的误解。
  const snHost = new FakeNode('div');
  const snView = await import('../app/js/views/snapshots.js');
  await withTimeout((snView.default || snView.view).render(snHost), 10000, 'snapshots');
  const snText = snHost.textContent;

  check(/快照是什么/.test(snText), '有「快照是什么」的说明');
  check(/占用/.test(snText), '有占用信息（用户要求显示总占用）');
  check(/快照份数|份/.test(snText), '显示了快照份数');
  check(/浏览器实际占用|快照内容合计/.test(snText), '显示了具体占用数字');
  // 关键的诚实性提醒
  check(/救不了|同一个数据库/.test(snText), '明确说了快照救不了浏览器数据被清理');
  check(/导出/.test(snText), '把「导出文件」作为另一种手段指了出来');
  check(/立即创建快照/.test(snText), '有「立即创建快照」按钮');
  // 两类不会被自动删的快照要有标注
  const snSrc = fs.readFileSync(path.join(ROOT, 'app/js/views/snapshots.js'), 'utf8');
  check(/不会.{0,4}被自动删/.test(snSrc), '标出了「不会被自动删」的快照类型');
  check(/preupgrade/.test(snSrc) && /before-wipe/.test(snSrc),
    '与 db.js 的 PINNED 两类（preupgrade / before-wipe）对应');

  // 设置页不该再内嵌那份快照表格，只留入口
  const setSrc = fs.readFileSync(path.join(ROOT, 'app/js/views/settings.js'), 'utf8');
  check(!/async function renderSnapshots/.test(setSrc),
    '设置页里的快照列表已移走（不再重复实现一份）');
  check(/#\/snapshots/.test(setSrc), '设置页留了指向快照页的链接');
}

console.log('\n[6b] 界面诊断：能在出问题的那一页上自查导航栏，并把报告发回服务端');
{
  // 为什么需要它：假 DOM 只对比标签和类名，**没有布局引擎** ——
  // 不知道元素落在屏幕哪里、有没有被盖住、宽度够不够。
  // 导航栏"看不见"这类问题只有真浏览器能测。
  //
  // ⚠️ 曾经的错误设计：先做成了 `#/diag` **一个页面**，但它检查的是它自己 ——
  //    而毛病只在**某些页面**出现，在诊断页上一切正常，于是永远报"没问题"，等于白测。
  //    所以改成**浮层面板**（?diag=1），开在出问题的那一页上检查那一页。
  const panelPath = path.join(ROOT, 'app/js/diagpanel.js');
  check(fs.existsSync(panelPath), 'app/js/diagpanel.js 存在（浮层面板）');
  const panelSrc = fs.readFileSync(panelPath, 'utf8');

  check(/getComputedStyle/.test(panelSrc), '读取 computed style（能发现 display:none / 零尺寸）');
  check(/elementFromPoint/.test(panelSrc), '用 elementFromPoint 检测遮挡（唯一可靠判据）');
  check(/getBoundingClientRect/.test(panelSrc), '读取元素实际位置尺寸（能发现跑到屏幕外）');
  check(/documentScrollWidth/.test(panelSrc), '检查整页横向溢出（内容撑宽会把导航带出可视区）');
  check(/\/api\/diag/.test(panelSrc), '把报告 POST 回服务端（用户不必手动复制）');
  check(/hash:/.test(panelSrc), '报告里带上"这是在哪个页面测的"（否则无法定位）');

  // readonly 必须传 true：el() 里 `v === false || v === null` 会跳过，
  // 传 'readonly' 会设成 readonly="readonly"（能用但不规范）
  check(/readonly:\s*true/.test(panelSrc), 'textarea 的 readonly 用布尔 true（配合 el() 的 true → setAttribute）');

  // 面板**不该**出现在导航或首页入口里：它是排查工具，不是学习功能
  const appSrc2 = fs.readFileSync(path.join(ROOT, 'app/js/app.js'), 'utf8');
  check(!/id: 'diag'/.test(appSrc2), '诊断面板不在导航栏里（不干扰正常使用）');
  check(/\[\?&\]diag=1/.test(appSrc2), 'app.js 用 ?diag=1 作为开关');
  check(/import\('\.\/diagpanel\.js'\)/.test(appSrc2),
    '诊断模块用 dynamic import —— 不塞进启动关键路径，正常使用完全不加载');
  const homeSrc = fs.readFileSync(path.join(ROOT, 'app/js/views/home.js'), 'utf8');
  check(!/view: 'diag'/.test(homeSrc), '诊断面板不在首页入口里');
  check(!fs.existsSync(path.join(ROOT, 'app/js/views/diag.js')),
    '不存在 views/diag.js（已废弃的"检查自己"方案已删除，避免留下没用的路由）');

  // 服务端接收口必须在，且限定大小与目录（不能变成任意文件写入口）
  const srvSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  check(/\/api\/diag/.test(srvSrc), 'server.js 注册了 POST /api/diag');
  check(/readBody\(req,\s*256\s*\*\s*1024\)/.test(srvSrc), '诊断接口限制请求体大小（256KB）');
  check(/data['"]?,\s*['"]diag/.test(srvSrc) || /'data',\s*'diag'/.test(srvSrc),
    '诊断报告写到 data/diag/（内置数据目录，不是用户数据区）');
}

console.log('\n[6c] 导航栏关键属性带 !important（防浏览器扩展把 .nav 压扁）');
{
  // 实测踩的坑（诊断报告 2026-10-04）：导航栏在部分页面看不见。
  // #nav 的 computed height 是 **1px**（我们声明 54px），导航项 y = **-19**。
  // document.styleSheets 里有 7 个样式表，只有 1 个是本项目的 ——
  // 另外 6 个内联样式表来自**浏览器扩展**，把 .nav 压成了 1px。
  //
  // 所以关键属性必须带 !important：站点样式表在层叠里优先于扩展注入的样式。
  // 任意一条丢失都会让导航栏再次消失，所以逐条断言。
  const css = fs.readFileSync(path.join(ROOT, 'app/css/theme.css'), 'utf8');
  const navBlock = (css.match(/\.nav\s*\{[\s\S]*?\}/) || [''])[0];
  check(navBlock.length > 0, '找到 .nav 规则块');
  // 每项是 [匹配用的正则片段, 报错时显示的说明]。
  // ⚠️ 两者分开写：曾试图用 replace 从正则片段生成说明文字，结果把 pattern 本身改坏了。
  const props = [
    ['height:\\s*54px', 'height: 54px'],
    ['min-height:\\s*54px', 'min-height: 54px'],
    ['position:\\s*sticky', 'position: sticky'],
    ['top:\\s*0', 'top: 0'],
    ['z-index:\\s*50', 'z-index: 50'],
    ['display:\\s*flex', 'display: flex'],
    ['visibility:\\s*visible', 'visibility: visible'],
    ['opacity:\\s*1', 'opacity: 1'],
  ];
  for (const [pattern, label] of props) {
    check(new RegExp(pattern + '\\s*!important').test(navBlock),
      `.nav 的 ${label} 带 !important（防被扩展盖掉）`);
  }
}

console.log('\n[7] 启动占位必须被移除（否则顶部留一条空白横条）');
{
  // 踩过的 bug：index.html 里的 <div id="boot">正在启动…</div> 从来没人删，
  // 它带 40px 内边距，于是导航栏上方一直挂着一条空白横条。
  const appSrc = fs.readFileSync(path.join(ROOT, 'app/js/app.js'), 'utf8');
  check(/getElementById\('boot'\)[\s\S]{0,200}(remove\(\)|\.remove)/.test(appSrc),
    'app.js 在启动完成后移除了 #boot 占位');
  // 移除必须发生在 router.render() 之后，否则会有白屏闪烁
  const renderIdx = appSrc.indexOf('await router.render()');
  const removeIdx = appSrc.indexOf("getElementById('boot')");
  check(renderIdx > 0 && removeIdx > renderIdx,
    '移除动作在首次渲染之后（不会造成白屏闪烁）');
}

console.log('\n[9] 歌词页与精读页：共用一套渲染器，各自接对接口');
{
  const lyricSrc = fs.readFileSync(path.join(ROOT, 'app/js/views/lyric.js'), 'utf8');
  const readingSrc = fs.readFileSync(path.join(ROOT, 'app/js/views/reading.js'), 'utf8');
  const readerSrc = fs.readFileSync(path.join(ROOT, 'app/js/views/jpreader.js'), 'utf8');

  // ---- 9.1 共用渲染器存在，且真的是"共用" ----
  // 为什么这条重要：两页各写一份渲染逻辑，就会出现两个地方处理未知词/振假名，
  // 以后改一处忘一处。断言两页都 import 了它，防止有人"就地复制一份改改"。
  check(/from '\.\/jpreader\.js'/.test(lyricSrc), '歌词页 import 共用的 jpreader.js');
  check(/from '\.\/jpreader\.js'/.test(readingSrc), '精读页 import 共用的 jpreader.js');
  for (const fn of ['renderTokens', 'renderSentence', 'openWord', 'addManyToVocab', 'buildToggles']) {
    check(new RegExp(`\\b${fn}\\b`).test(readerSrc), `jpreader.js 导出 ${fn}()`);
  }
  // 反向断言：两页都不该自己造 <ruby> 或自己拼罗马音
  check(!/<ruby|'ruby'|"ruby"/.test(lyricSrc.replace(/ruby:\s*(true|false)/g, '')),
    '歌词页没有自己造 ruby 标签（一律走共用渲染器）');
  check(!/<ruby|'ruby'|"ruby"/.test(readingSrc.replace(/ruby:\s*(true|false)/g, '')),
    '精读页没有自己造 ruby 标签');

  // ---- 9.2 接对了接口，且没有偷偷做翻译 ----
  check(/\/api\/lyric\/parse/.test(lyricSrc), '歌词页调用 POST /api/lyric/parse');
  check(/\/api\/analyze/.test(readingSrc), '精读页调用 POST /api/analyze');
  check(/\/api\/ocr/.test(readingSrc), '精读页调用 POST /api/ocr（拍照识别）');
  // 硬约束：本机不做翻译。任何"翻译"接口调用都是错的。
  check(!/\/api\/(trans|translate)/.test(lyricSrc + readingSrc),
    '两页都没有调用任何"翻译"接口（本机不做翻译）');
  // ⚠️ 这条断言**改过一次**，原因是它原来的形状不对：
  //    旧写法是 `!/translation\s*:/`（全文任何位置出现这个字段名就报错）。
  //    那是**过宽**的 —— 它想抓的是"别把待翻译的文本放进请求体"，
  //    却会连"本地对象里有个叫 translation 的字段"一起打红。
  //    加草稿保护时就撞上了：草稿要存一份中文对照，字段名正好叫 translation，
  //    于是断言报错，而代码没有任何问题。
  //    **遇到这种红，要改的是断言，不是把正确的字段名改掉去迁就断言。**
  //    现在改成只盯真正的危险形状：发给服务端的请求体里不许有 translation。
  {
    // ⚠️ 这里我写坏过两次，所以最后用**手工定位**而不是花哨的正则：
    //    第一次：惰性 `([\s\S]*?)\)\s*,` —— 在 JSON.stringify 自己的左括号
    //            后面就收尾了，捕获为空、整体失配。
    //    第二次：`/\/api\/analyze` 中间夹了一个反引号 —— 而 reading.js 的
    //            文件头注释里也写着 /api/analyze，**从注释里那个位置开始找，
    //            后面根本不会有 body: JSON.stringify**，于是永远失配。
    //    教训：**从源码里"抠一段"的断言，必须用最不容易被注释干扰的定位方式**，
    //    而且必须有一条"真的抠到了东西"的断言兜着（下面第一条就是）。
    let bodySrc = '';
    let found = -1;
    // 从后往前找最后一次出现 —— 注释在文件头，真正的调用在正文里。
    for (let i = readingSrc.indexOf('/api/analyze'); i >= 0; i = readingSrc.indexOf('/api/analyze', i + 1)) found = i;
    if (found >= 0) {
      const anchor = 'body: JSON.stringify(';
      const s = readingSrc.indexOf(anchor, found);
      if (s >= 0) {
        // 手工配对括号，取到与之匹配的那个右括号为止
        let depth = 0;
        for (let j = s + anchor.length - 1; j < readingSrc.length; j++) {
          if (readingSrc[j] === '(') depth++;
          else if (readingSrc[j] === ')') { depth--; if (depth === 0) { bodySrc = readingSrc.slice(s + anchor.length, j); break; } }
        }
      }
    }
    check(bodySrc.length > 0, '能定位到 /api/analyze 的请求体（否则下面那条断言是空跑）', bodySrc.slice(0, 80));
    check(!/translation\s*:/.test(bodySrc),
      '★ 精读页没有向服务端发翻译请求字段（只检查请求体，不是全文乱找）',
      bodySrc.slice(0, 160));
  }

  // ---- 9.3 只写已有的表，不碰 SCHEMA_VERSION ----
  check(/dbPut\('lyrics'|db\.dbPut\('lyrics'/.test(lyricSrc), '歌词笔记写入 lyrics 表');
  check(/dbPut\('readings'|db\.dbPut\('readings'/.test(readingSrc), '精读笔记写入 readings 表');
  check(!/SCHEMA_VERSION\s*=/.test(lyricSrc + readingSrc + readerSrc),
    '两页都没有改 SCHEMA_VERSION（不动用户数据）');
  // 写入必须是 dbPut 而不是手写 indexedDB —— 否则绕过迁移与快照体系
  check(!/indexedDB\.open/.test(lyricSrc + readingSrc + readerSrc),
    '两页都不直接开 indexedDB（一律走 db.js 封装）');

  // ---- 9.4 粘贴监听挂在局部容器上（不是 document）----
  // 挂 document 就必须在 destroy 里撤销，而路由复用同一个模块对象，
  // 撤销时机一旦没跟上就会叠加多个监听（粘一次图触发多次识别）。
  // 挂局部容器则随宿主元素一起消失，没有需要撤销的东西。
  //
  // ⚠️ 2026-10：OCR 那 140 行已经从精读页抽成共用组件 `app/js/ocrbox.js`
  //    （歌词页也要用同一份），所以"root.addEventListener('paste')"这个字样
  //    现在应该在 **ocrbox.js** 里，而精读页只负责把 root 传进去。
  //    断言跟着实现走：盯"有没有把 pasteTarget 交给组件"+"组件挂的粘什么"。
  check(!/document\.addEventListener\('paste'/.test(readingSrc),
    '精读页没有把 paste 挂在 document 上（避免反复进出页面叠加监听）');
  check(/pasteTarget/.test(readingSrc),
    '精读页把粘贴目标交给共用 OCR 组件（而不是自己挂监听）');
  const ocrBoxSrc = fs.readFileSync(path.join(ROOT, 'app/js/ocrbox.js'), 'utf8');
  check(/pasteTarget\.addEventListener\('paste'/.test(ocrBoxSrc),
    'OCR 组件把 paste 挂在传进来的局部容器上（随宿主销毁自动消失）');
  check(!/document\.addEventListener/.test(ocrBoxSrc.split('\n')
    .filter((l) => !/^\s*[*/]/.test(l)).join('\n')),
    'OCR 组件自己不碰 document 级监听');

  // ---- 9.6 token 字段契约（实测出来的，必须锁住）----  // 端到端实测：/api/lyric/parse 与 /api/analyze 返回的 token 里，
  //   romaji 是**字符串**（如 "kyou"），ruby 是**逐字数组** [{t,r},...]。
  // 把 romaji 当成对象用（比如 String(t.romaji) 前先取字段）就会渲染出 [object Object]。
  // 这类错误假 DOM 测不出来（它只比标签名），所以至少把字段名锁住。
  check(/t\.romaji\s*[,)]/.test(readerSrc) || /text:\s*t\.romaji/.test(readerSrc),
    '渲染器把 token.romaji 当字符串直接显示');
  check(!/t\.romaji\.[a-z]/i.test(readerSrc), '没有把 token.romaji 当对象取字段');
  check(/part\.t/.test(readerSrc) && /part\.r/.test(readerSrc),
    '渲染器按 {t, r} 结构消费振假名分段（part.t / part.r）');
  // 未知片段不编读音：引擎的原则是"猜错更害人"
  check(/t\.known\s*&&\s*t\.ruby|t\.ruby\s*&&\s*t\.ruby\.length/.test(readerSrc),
    '只有已知词才上振假名（未知片段不猜读音）');

  // ---- 9.7 OCR 文本必须清洗（实测出的真 bug，会让精读页变废）----
  // 引擎会在**每个字符之间**插空格：
  //   「日本語を勉強しています」→ "日 本 語 を 勉 強 し て い ま す"
  // 后果实测：带空格分词成单字，覆盖率 77.8%；去空格 100%。
  // 也就是说「日本語」「勉強」「しています」这些真词会全部识别不出来。
  //
  // ⚠️ 2026-10：这两句从"精读页里必须有"改成"OCR 组件里必须有"。
  //    OCR 已经不是精读页独有的了（歌词页也在用），清洗必须在**共用组件**里做 ——
  //    如果只写在精读页里，歌词页识别出来的文字就会带着空格直接进分词器，
  //    而两页用的是同一个渲染管线，症状完全一样。
  check(/cleanOcrText/.test(ocrBoxSrc), 'OCR 组件调用 cleanOcrText 清洗识别结果');
  check(/ocrWarning/.test(ocrBoxSrc), 'OCR 组件用 ocrWarning 如实说明识别问题');
  check(fs.existsSync(path.join(ROOT, 'app/js/ocrtext.js')),
    'app/js/ocrtext.js 存在（纯函数，可脱离浏览器单测）');
  check(fs.existsSync(path.join(ROOT, 'tools/test-ocrtext.mjs')),
    'tools/test-ocrtext.mjs 存在（清洗规则有单测守着）');
  const ocrSrc = fs.readFileSync(path.join(ROOT, 'app/js/ocrtext.js'), 'utf8');
  // 清洗逻辑必须真的比对左右字符，不能只是 trim
  check(/isLatin/.test(ocrSrc) && /A-Za-z/.test(ocrSrc),
    '清洗逻辑区分拉丁字母与日文（拉丁词界要保留）');
  // 纯函数：不许碰 DOM / 网络，否则又变成测不了的东西
  check(!/document\.|fetch\(|indexedDB/.test(ocrSrc),
    'ocrtext.js 是纯函数（不碰 DOM / 网络）');

  // ---- 9.8 OCR 失败必须给用户看得懂的话（实测出的第二个 bug）----
  // 实测：沙箱里 spawn 失败时，服务端原样返回 `{"error":"spawn EPERM"}`，
  // 前端就显示"OCR 失败：spawn EPERM" —— 编程小白看这句等于没看，
  // 既不知道是谁权限不够，也不知道下一步该干什么。
  const srvSrc2 = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  check(/function ocrFailureMessage/.test(srvSrc2),
    'server.js 有 ocrFailureMessage()（把底层报错翻译成人话）');
  check(/EPERM|EACCES/.test(srvSrc2) && /启动\.cmd|沙箱/.test(srvSrc2),
    '权限类失败会告诉用户"用启动.cmd 启动"');
  // ⚠️ 2026-10：原来这里断言"缺日语 OCR 语言包时有专门说明"，
  //    指的是 Windows.Media.Ocr 的 RecognizerLanguages 检查 ——
  //    那个引擎**整个换掉了**（换成本项目自带的 rapidocr + 日文 ONNX 模型，
  //    原因见 ARCHITECTURE.md 第十九节）。所以旧的断言已经没有对应实现。
  //    现在真正会遇到的失败是"运行时没装/装坏了"，改成盯这一条：
  //    用户看到的话里必须给出**下一步该做什么**，不能只甩一个 ModuleNotFoundError。
  const ocrWorkerPy = fs.readFileSync(path.join(ROOT, 'tools/ocr-worker.py'), 'utf8');
  for (const code of ['NO_RUNTIME', 'INIT_FAILED', 'IMAGE_UNREADABLE', 'OCR_FAILED']) {
    check(ocrWorkerPy.includes(code), `OCR worker 对 ${code} 有明确的错误码（不甩看不懂的异常）`);
  }
  check(/NO_RUNTIME/.test(srvSrc2) && /get-ocr-runtime/.test(srvSrc2),
    '缺 OCR 运行时会告诉用户去跑哪个安装脚本');
  check(/stage/.test(srvSrc2), '失败响应带 stage（哪个环节失败，便于排查）');

  // ---- 9.5 真渲染：两页都能在假 DOM 里跑起来，且产出共用渲染器标记 ----
  for (const [viewId, store] of [['lyric', 'lyrics'], ['reading', 'readings']]) {
    const host = new FakeNode('div');
    const mod = await import(`../app/js/views/${viewId}.js`);
    const view = mod.default || mod.view;
    let err = null;
    try {
      await withTimeout(view.render(host, []), 10000, viewId);
    } catch (e) { err = e; }
    check(!err, `#/${viewId} 能在假 DOM 里渲染`, err ? String(err.message) : '');
    if (err) continue;

    const all = host._walk([]);
    const cls = new Set();
    for (const n of all) for (const c of n.classList._s) cls.add(c);

    // 共用渲染器的外壳必须都出现
    check(cls.has('jpr-grid') || cls.has('jpr-ocr-area'),
      `#/${viewId} 用了共用阅读器外壳`, [...cls].filter((c) => c.startsWith('jpr-')).slice(0, 6).join(','));
    check(all.filter((n) => n.tagName === 'TEXTAREA').length >= 1,
      `#/${viewId} 有输入框`);
    check(all.some((n) => n.tagName === 'BUTTON'), `#/${viewId} 有按钮`);

    // 笔记列表：必须去读对应的表（说明"存为笔记"接上了）
    const text = all.map((n) => n.textContent).join('');
    check(text.indexOf('笔记') >= 0, `#/${viewId} 界面上有笔记区`);
    void store;
  }
}

console.log('\n[9c] 语法教材：真数据 + 真渲染 + 学习状态落库');
{
  // ---- 假环境自身的回归：document.getElementById 必须能用 ----
  // 踩过的坑：本文件里模块级 `const body` 和后面块里的 `const body` 重名，
  // 于是模块级 body 进了暂时性死区，getElementById 一调就抛
  // "document.getElementById is not a function"。症状极具迷惑性 ——
  // 数据其实已经写进库了，只是紧接着的 toast 炸了，看起来像"收藏没生效"。
  // 这里直接断言假 document 的这个方法能用，防止再被同名变量弄坏。
  const probeEl = new FakeNode('div'); probeEl.id = 'probe-target';
  docBody.appendChild(probeEl);
  let gbiOk = true; let gbiErr = '';
  try { gbiOk = document.getElementById('probe-target') === probeEl; } catch (e) { gbiOk = false; gbiErr = e.message; }
  check(gbiOk, '假 DOM 的 document.getElementById 可用（防同名变量把它弄坏）', gbiErr);
  check(document.getElementById('绝对不会有的 id') === null, '找不到时返回 null 而不是抛错');
  docBody.removeChild(probeEl);
  // 状态读写走 app.js 暴露的那个 db 封装（假环境里挂在 fakeWindow.JP 上），
  // 和我们平常调的方式一致 —— 不为了测试另开一条访问数据的路径。
  const gdb = fakeWindow.JP.db;
  // ---- 数据文件本身 ----
  const gdir = path.join(ROOT, 'data/grammar');
  check(fs.existsSync(path.join(gdir, 'index.json')), 'data/grammar/index.json 存在');
  check(fs.existsSync(path.join(gdir, 'N5.json')), 'data/grammar/N5.json 存在');
  check(fs.existsSync(path.join(gdir, 'README.md')), 'data/grammar/README.md 存在（怎么加内容写清楚了）');

  const gidx = JSON.parse(fs.readFileSync(path.join(gdir, 'index.json'), 'utf8'));
  check(gidx.count === gidx.items.length, `索引 count 与实际条数一致（${gidx.count}）`);
  // 现在是"先搭框架"阶段，只放样例。这条断言是**提醒**：内容变多了要回来更新预期，
  // 而不是让数字悄悄漂移。
  check(gidx.count >= 10, `已放样例内容（${gidx.count} 条 ≥ 10）`);
  check((gidx.levels || []).includes('N5'), '索引里有 N5 等级');

  // ---- 索引必须带上"界面筛选要用"的字段（实测漏过两次）----
  // ⚠️ 这里踩了同一个坑两次：
  //    ① tags 没进索引 → 用户搜「书面语」一条都搜不到（静默失效）
  //    ② line 没进索引 → 界面上没法"只看书面语线"
  //    两次都是"正文里加了字段，忘了让索引也带上"。
  //    所以这条断言盯的是：**索引条目要有 tags 和 line**，而不是"索引存在"。
  check(gidx.items.every((x) => Array.isArray(x.tags)),
    '索引里每条都有 tags（否则按标签搜会静默失效）');
  check(gidx.items.every((x) => !!x.line),
    '索引里每条都有 line（否则界面上没法按 JLPT／书面语分线）');
  const gLines = new Set(gidx.items.map((x) => x.line));
  check([...gLines].every((l) => l === 'jlpt' || l === 'written'),
    `line 取值只有 jlpt／written（现有：${[...gLines].join('/')}）`);
  // 等级和分类必须从索引真实读出来，不是写死的
  check((gidx.levels || []).length === new Set(gidx.items.map((x) => x.level)).size,
    '索引里的 levels 与条目实际等级一致');
  check((gidx.categories || []).length === new Set(gidx.items.map((x) => x.category)).size,
    '索引里的 categories 与条目实际分类一致');
  // 标签要真能搜到：至少有一条的 tags 里含"书面语"（提醒这条链路是活的）
  const anyTagged = gidx.items.some((x) => x.tags.length > 0);
  check(anyTagged, '至少有一条带标签（说明标签链路是活的，不是空跑）');

  // ---- 视图能真渲染出内容（假 fetch 喂真数据）----
  const gHost = new FakeNode('div');
  const gMod = await import('../app/js/views/grammar.js');
  const gView = gMod.default || gMod.view;
  let gErr = null;
  try {
    await withTimeout(gView.render(gHost, []), 15000, 'grammar');
    // 首条会自动打开，等它的人造 fetch 回来
    await new Promise((r) => setTimeout(r, 300));
  } catch (e) { gErr = e; }
  check(!gErr, '#/grammar 能在假 DOM 里渲染', gErr ? String(gErr.message) : '');

  if (!gErr) {
    const gAll = gHost._walk([]);
    const gCls = new Set();
    for (const n of gAll) for (const c of n.classList._s) gCls.add(c);

    check(gCls.has('gram-wrap'), '语法页用了两栏外壳 .gram-wrap');
    check(gCls.has('gram-side') && gCls.has('gram-body'), '左栏列表 + 右栏正文都在');

    // 列表行数 = 索引条数（没筛选时）
    const rows = gAll.filter((n) => n.classList.contains('gram-row'));
    check(rows.length === gidx.count,
      `列表渲染出全部 ${gidx.count} 条`, `实际 ${rows.length} 行`);

    // 有搜索框和筛选按钮
    check(gAll.some((n) => n.tagName === 'INPUT'), '有搜索框');
    const chips = gAll.filter((n) => n.classList.contains('gram-chip'));
    check(chips.length > 0, `有筛选/操作按钮（${chips.length} 个）`);

    // 正文：接续规则、例句都渲染出来了
    const gText = gAll.map((n) => n.textContent).join('|');
    check(gCls.has('gram-conn'), '正文里有"接续规则"块（自学最容易错的地方）');
    check(gCls.has('gram-ex'), '正文里有例句块');

    // 例句必须带上真算出来的振假名（复用了歌词页/精读页的渲染器）
    const rubyCount = gAll.filter((n) => n.tagName === 'RUBY').length;
    check(rubyCount > 0, `例句渲染出了振假名（${rubyCount} 个 ruby）`);
    check(gAll.some((n) => n.classList.contains('jpr-line')),
      '例句用的是共用渲染器的 .jpr-line（三处显示一致）');

    // ---- 详情区的"头部卡片"必须真的挂上去了 ----
    //
    // ⚠️ 这一组是**真实事故**补的（2026-10，语法页 UI 改版时）：
    //    我把详情区拆成"接续 / 意思 / 例句…"几张卡片时，头部那张卡
    //    （标题 + 收藏 + 已掌握）变成了**建好但忘了 appendChild** ——
    //    变量 `head` 还在、`head.appendChild(...)` 也都在、代码看起来完全正常，
    //    只是再也没进过 DOM。结果页面**标题和收藏按钮整体消失**。
    //
    //    为什么上面那些断言全绿：
    //      `gHost._walk()` 只走**已经挂上去**的子树，所以"少了一张卡"这种
    //      缺失型 bug 它天然看不见 —— 它只会说"该有的都在"，不会说"还缺什么"。
    //      `gCls.has('gram-conn')` 同理：接续/意思是新卡片，都挂上了，于是照绿。
    //      真正逮住它的是真浏览器里"找不到 data-act=favorite 按钮"。
    //
    //    所以这里补的是**正向的存在性断言**（标题在、两个按钮在），
    //    而不是只断言"某些 class 出现过"。教训：
    //    **"某个 class 出现过"不等于"那张卡挂上去了"** ——
    //    缺失型 bug 只能靠"点名要某样东西必须存在"来抓。
    {
      const h2s = gAll.filter((n) => n.tagName === 'H2').map((n) => n.textContent);
      const first = gidx.items[0];
      check(h2s.some((t) => t && first && t.includes(first.title.slice(0, 6))),
        '详情区顶部有标题卡（不是只有"例句"这种小标题）',
        `页面上的 h2：${h2s.slice(0, 4).join(' / ')}`);
      const acts = gAll.filter((n) => n.dataset && n.dataset.act).map((n) => n.dataset.act);
      check(acts.includes('favorite'), '详情区有「收藏」按钮且挂在页面上（不是只创建了对象）',
        `实际 data-act：${acts.join(', ') || '(一个都没有)'}`);
      check(acts.includes('mastered'), '详情区有「已掌握」按钮且挂在页面上',
        `实际 data-act：${acts.join(', ') || '(一个都没有)'}`);
      check(acts.includes('prev') && acts.includes('next'),
        '详情区有「上一条 / 下一条」按钮（阅读导览）',
        `实际 data-act：${acts.join(', ') || '(一个都没有)'}`);
      // 反向：确认上面不是空跑（列表里确实点了开了一条）
      check(acts.length >= 4, '导览与状态按钮确实都渲染出来了（上面几条不是空跑）',
        `${acts.length} 个 data-act`);
    }

    // ---- 收藏要真的写进 grammarState 表 ----
    const before = await gdb.dbAll('grammarState');
    check(Array.isArray(before), 'grammarState 表可读');

    // ⚠️ 左栏筛选里也有一个「★ 收藏」chip，文案**完全一样**
    // （详情页那个是「☆ 收藏」→ 点完后变「★ 已收藏」）。
    // 第一版按文案找，点到了筛选 chip，于是断言"没写库"，
    // 白白怀疑了一轮生产代码 —— 生产代码其实是对的。
    // 现在生产代码给按钮加了 dataset.act 语义标记，按标记找就唯一了。
    const favSel = (host) => host._walk([]).find((n) =>
      n.tagName === 'BUTTON' && n.dataset.act === 'favorite');
    const favBtn = favSel(gHost);
    check(!!favBtn, '正文里有"收藏"按钮', favBtn ? favBtn.textContent : '没找到');
    if (favBtn) {
      favBtn.click();
      await new Promise((r) => setTimeout(r, 400));
      const after = await gdb.dbAll('grammarState');
      check(after.length === 1, `点收藏后 grammarState 写了 1 条`, `实际 ${after.length} 条`);
      const rec = after[0] || {};
      check(rec.grammarId === gidx.items[0].id, `记的是当前这条（${rec.grammarId}）`);
      check(rec.favorite === true, 'favorite 记为 true');
      check(typeof rec.updatedAt === 'number' && rec.updatedAt > 0, '记了 updatedAt');

      // 再点一次应该取消，而不是又插一条
      const favBtn2 = favSel(gHost);
      if (favBtn2) {
        favBtn2.click();
        await new Promise((r) => setTimeout(r, 300));
        const after2 = await gdb.dbAll('grammarState');
        check(after2.length === 1, '取消收藏不会多插一条（按 grammarId 覆盖）', `${after2.length} 条`);
        check(after2[0] && after2[0].favorite === false, 'favorite 回到 false');
      }
    }
  }

  // ---- 硬约束：做语法功能不许动结构版本 ----
  // 直接读常量本身，而不是拿正则去匹配源码字符串 ——
  // 第一版写成 /const SCHEMA_VERSION = 2;/，但真实声明是
  // `export const SCHEMA_VERSION = 2;`，前面还有 `export `，于是断错了。
  // 断言别人的源码文本很容易被无关的改动弄坏，能用真值就别用正则。
  //
  // ⚠️ 这个断言原来是 `SCHEMA_NOW === 2`，写死了当时的版本号。
  //    它想表达的其实是"**做语法功能不该涨结构版本**"，
  //    但写成等于某个具体数字之后，任何一次**正当**的版本升级都会让它变红，
  //    而它又看不出"这次升级是不是正当的" —— 这种断言只会制造噪音。
  //    （真实后果：修 readingOverrides 那个 bug 必须把 2 涨到 3，
  //      于是这条断言红了，但红的理由和语法功能毫无关系。）
  //    改成断言真正想说的那件事：语法页复用了已有表，没有新增 store。
  const { SCHEMA_VERSION: SCHEMA_NOW } = await import('../app/js/version.js');
  const dbSrcForSchema = fs.readFileSync(path.join(ROOT, 'app/js/db.js'), 'utf8');
  check(/grammarState:\s*\{/.test(dbSrcForSchema),
    '语法状态复用了已有的 grammarState 表（不是为语法功能新建的表）');
  check(SCHEMA_NOW >= 2,
    `SCHEMA_VERSION 是合理的结构版本（当前 ${SCHEMA_NOW}；做语法功能本身没有涨它）`);

  // ---- 反向断言：语法页不许自己造一套振假名渲染 ----
  const gSrc = fs.readFileSync(path.join(ROOT, 'app/js/views/grammar.js'), 'utf8');
  check(/from '\.\/jpreader\.js'/.test(gSrc) && /renderTokens/.test(gSrc),
    '语法页复用 jpreader.js 的 renderTokens');
  check(!/createElement\('ruby'\)|'<ruby/.test(gSrc),
    '语法页没有自己手搓 <ruby>（否则注音方式会三处不一致）');
  // 状态必须走 db.js 封装，不许直接开 indexedDB（会绕过迁移与快照体系）
  check(!/indexedDB\.open/.test(gSrc), '语法页不直接开 indexedDB');
  check(/dbPut\('grammarState'|db\.dbPut\('grammarState'/.test(gSrc), '语法状态走 dbPut 写 grammarState');
}

console.log('\n[9d] 导出到 Anki：界面能点通，且真的产出文件内容');
{
  // 先给词表里放几个词，否则"没有可导出的词"分支会挡住真正的检查
  const vdb = fakeWindow.JP.db;
  const now = Date.now();
  await vdb.dbPut('words', {
    id: 'jmdict:anki-1', term: '会う', reading: 'あう', level: 'N5',
    zh: ['见面', '遇到'], forms: ['会う'], kanas: ['あう'],
    ex: [{ jp: '明日駅で会いましょう。', zh: '明天在车站见吧。' }],
    source: 'manual', tags: [], createdAt: now, updatedAt: now,
  });
  await vdb.dbPut('words', {
    id: 'jmdict:anki-2', term: '犬', reading: 'いぬ', level: 'N5',
    zh: ['狗'], forms: ['犬'], kanas: ['いぬ'],
    source: 'manual', tags: [], createdAt: now + 1, updatedAt: now + 1,
  });

  // 重新渲染背单词页，切到「词表」页签
  const expHost = new FakeNode('div');
  const expView = await import('../app/js/views/vocab.js');
  await withTimeout((expView.default || expView.view).render(expHost), 10000, 'vocab-export');
  await new Promise((r) => setTimeout(r, 400));
  const wordTab = expHost.querySelectorAll('.tab').find((t) => /词表/.test(t.textContent));
  check(!!wordTab, '找到「词表」页签');
  if (wordTab) {
    wordTab.dispatch('click', { type: 'click', target: wordTab });
    await withTimeout(new Promise((r) => setTimeout(r, 500)), 2000, 'tab');

    const exportBtn = expHost._walk([]).find((n) => n.dataset.act === 'export');
    check(!!exportBtn, '词表工具栏里有「导出 Anki」按钮', exportBtn ? exportBtn.textContent : '没找到');

    if (exportBtn) {
      // downloadText 要用 Blob / URL.createObjectURL / a.click —— 假环境得先提供
      const downloads = [];
      globalThis.Blob = class { constructor(parts) { this._text = String(parts[0]); } };
      globalThis.URL.createObjectURL = () => 'blob:fake';
      globalThis.URL.revokeObjectURL = () => {};

      exportBtn.click();
      await new Promise((r) => setTimeout(r, 200));

      const backdrop = docBody.querySelectorAll('.modal-backdrop');
      check(backdrop.length === 1, '点导出后弹出对话框', `实际 ${backdrop.length} 个`);

      const fmtBtns = docBody._walk([]).filter((n) => (n.dataset.act || '').startsWith('export-'));
      check(fmtBtns.length === 3, '对话框里有 3 个格式按钮（tsv/csv/md）', `实际 ${fmtBtns.length} 个`);
      const fmtText = fmtBtns.map((b) => b.textContent).join(' / ');
      check(/TSV/.test(fmtText) && /CSV/.test(fmtText) && /Markdown/.test(fmtText),
        '三种格式都标出来了', fmtText);
      check(/导入 Anki/.test(fmtText), 'TSV 标明了"导入 Anki"（用户不知道该选哪个）');

      const modalText = (backdrop[0] || expHost).textContent || '';
      check(/不经过任何服务器/.test(modalText), '对话框里说明文件不经服务器（用户关心这个）');

      // 真的点一下 TSV，检查下载内容
      const tsvBtn = fmtBtns.find((b) => b.dataset.act === 'export-tsv');
      if (tsvBtn) {
        // 拦下 a.click 拿下载内容：临时 <a> 是 el() 造的，我们改 createElement 太侵入，
        // 改成在 Blob 构造时把文本记下来
        const origBlob = globalThis.Blob;
        globalThis.Blob = class { constructor(parts) { downloads.push(String(parts[0])); this._text = String(parts[0]); } };
        tsvBtn.click();
        await new Promise((r) => setTimeout(r, 300));
        globalThis.Blob = origBlob;

        check(downloads.length === 1, '点 TSV 触发了 1 次下载', `实际 ${downloads.length} 次`);
        if (downloads.length) {
          const text = downloads[0];
          const lines = text.split('\n').filter(Boolean);
          check(lines.length >= 2, `导出的 TSV 有表头和数据行（${lines.length} 行）`);
          check(/^词形\t读音\t释义\t例句\t等级\t标签\t来源/.test(text),
            'TSV 表头字段正确', lines[0]);
          check(text.includes('会う') && text.includes('あう') && text.includes('见面'),
            'TSV 里有真实的词形/读音/释义');
          check(!text.startsWith('\uFEFF'), 'TSV 不带 BOM（Anki 会把 BOM 当成第一列的一部分）');
          check(text.includes('明日駅で会いましょう。'), '例句也导出了');
        }
      }

      // 关掉对话框，别影响后面的断言
      const closeBtn = docBody._walk([]).find((n) => n.classList.contains('modal-x'));
      if (closeBtn) closeBtn.click();
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // ---- 静态反向断言：导出模块不许把数据发到网上 ----
  const ankiSrc = fs.readFileSync(path.join(ROOT, 'app/js/anki.js'), 'utf8');
  const fmtSrc = fs.readFileSync(path.join(ROOT, 'app/js/exportfmt.js'), 'utf8');
  check(!/fetch\(|XMLHttpRequest|navigator\.sendBeacon/.test(ankiSrc),
    '导出模块不发任何网络请求（词表不出本机）');
  check(!/document\.|window\./.test(fmtSrc),
    '格式化模块是纯函数（不碰 DOM，所以能直接单测）');
}

console.log('\n[9e] AI：设置页 + 阅读页接入 + 密钥不落浏览器');
{
  // ---- 静态断言：密钥绝不能进浏览器存储 ----
  // 这是用户选了"明文存 config.local.json"之后唯一的兜底，
  // 所以要在源码层面钉死。
  //
  // ⚠️ 写这类"源码扫描"断言很容易过宽。第一版写成
  //     `!/dbPut\(|dbSet\(/.test(aiSrc) || !/apiKey/.test(aiSrc)`
  //   结果把**解释这条规矩的注释**也当成了违规，报假错。
  //   教训和 13.8 那次一样：过宽的规则会逼人去改本来正确的代码。
  //   现在改成只看"真正会发生存储的代码形态"，并且**用共用函数剥注释**
  //   （tools/lib/srcscan.mjs；手写五六遍的意思就是五六个漏点）。
  const aiSrc = fs.readFileSync(path.join(ROOT, 'app/js/ai.js'), 'utf8');
  const panelSrc = fs.readFileSync(path.join(ROOT, 'app/js/views/aipanel.js'), 'utf8');
  const setSrc = fs.readFileSync(path.join(ROOT, 'app/js/views/settings.js'), 'utf8');
  const expSrc = fs.readFileSync(path.join(ROOT, 'app/js/db.js'), 'utf8');
  const aiCode = codeOnly(aiSrc);

  // ---- 浏览器侧的兜底副本必须和服务端那份完全一致 ----
  // ⚠️ 为什么这条重要：app/js/ai.js 里那份常量是**读不到 tools/ 的无奈之举**
  //    （tools/ 不在 SAFE_ROOTS，浏览器请求会 403）。既然必须有第二份，
  //    就必须有人在它俩不一致时喊出来 —— 否则哪天只改了一处，
  //    就会出现"设置页说 A、首次确认框说 B"，而没有任何测试会红。
  {
    const browserMod = await import('../app/js/ai.js');
    const browserCopy = browserMod.AI_PRIVACY_TEXT;
    check(Array.isArray(browserCopy) && browserCopy.length === AI_PRIVACY_TEXT.length,
      '浏览器侧兜底副本与权威版本条数一致',
      `浏览器 ${browserCopy && browserCopy.length} / 权威 ${AI_PRIVACY_TEXT.length}`);
    const mismatch = [];
    for (let i = 0; i < AI_PRIVACY_TEXT.length; i++) {
      if (browserCopy[i] !== AI_PRIVACY_TEXT[i]) mismatch.push(`第 ${i + 1} 条不同`);
    }
    check(mismatch.length === 0, '浏览器侧兜底副本与权威版本逐字一致', mismatch.join('，'));
    // 兜底副本同样不能有 Markdown 标记
    const md = browserCopy.filter((s) => /\*\*|__|`/.test(String(s)));
    check(md.length === 0, '兜底副本里也没有 Markdown 标记', md.join(' | '));
  }

  // ai.js 只允许写"首次确认标记"那一处 settings；不许写任何带 apiKey 的东西
  const aiWrites = aiCode.match(/dbPut(Many)?\(\s*['"][^'"]+['"]\s*,\s*[^)]*/g) || [];
  check(aiWrites.every((w) => !/apiKey/i.test(w)),
    'ai.js 的 IndexedDB 写入里没有 apiKey', aiWrites.join(' | '));
  check(aiWrites.every((w) => /settings/.test(w)),
    'ai.js 只写 settings 表（存"已确认过隐私说明"这一个标记）', aiWrites.join(' | '));

  // 真正的"密钥操作"只许出现在一个地方：发给自己服务端的那次 fetch。
  // 这条是**正向**断言：确认 saveAiConfig 确实是把密钥 POST 出去的。
  check(/apiKey[\s\S]{0,120}\/api\/ai\/config|saveAiConfig[\s\S]{0,200}apiKey/.test(aiCode),
    'ai.js 的密钥只走 saveAiConfig → POST /api/ai/config');

  // 三个前端文件里，**密钥**都不能走浏览器存储。
  //
  // ⚠️ 这里**不能**简单地断言"不许出现 localStorage"：设置页用
  //    `localStorage.setItem('jp-learn.theme', …)` 存主题，那是正当用途。
  //    （第一版就是这么写的，报了假错 —— 又是"规则过宽"。）
  //    真正的风险只有一个：**密钥**被写进浏览器存储。
  //    所以只在"存储操作"和"apiKey"同时出现在很近的范围内时才判违规。
  for (const [name, src] of [['ai.js', aiSrc], ['aipanel.js', panelSrc], ['settings.js', setSrc]]) {
    const code = codeOnly(src);
    const risky = [];
    const re = /(localStorage|sessionStorage|document\.cookie|indexedDB\.open|dbPut(?:Many)?)\s*\(/g;
    let m;
    while ((m = re.exec(code)) !== null) {
      // 看这个存储调用前后各 200 字符里有没有 apiKey
      const around = code.slice(Math.max(0, m.index - 200), m.index + 200);
      if (/apiKey/i.test(around)) risky.push(m[1]);
    }
    check(risky.length === 0,
      `${name} 的存储调用附近没有 apiKey（密钥不进浏览器存储）`, risky.join(', '));
  }
  check(!/apiKey/.test(codeOnly(expSrc)), 'db.js 里没有 apiKey 字样（不会进导出/快照）');

  // ---- 设置页：AI 卡片 ----
  const aiHost = new FakeNode('div');
  const setView = await import('../app/js/views/settings.js');
  let setErr = null;
  try {
    await withTimeout((setView.default || setView).render(aiHost), 15000, 'settings-ai');
    await new Promise((r) => setTimeout(r, 500));
  } catch (e) { setErr = e; }
  check(!setErr, '设置页渲染成功', setErr ? String(setErr.message) : '');

  if (!setErr) {
    const sAll = aiHost._walk([]);
    const sText = aiHost.textContent;

    const badges = sAll.filter((n) => n.classList.contains('ai-badge'));
    check(badges.length === 1, `恰好有 1 个 AI 状态徽章（不是 0 也不是 2）`, `实际 ${badges.length}`);
    check(badges[0] && badges[0].classList.contains('is-off'),
      '默认状态显示为"已关闭"', badges[0] ? badges[0].textContent : '');
    check(badges[0] && /关闭/.test(badges[0].textContent), '徽章文案说的是关闭');

    check(sAll.some((n) => n.dataset.act === 'ai-save'), '有保存按钮');
    check(sAll.some((n) => n.dataset.act === 'ai-test'), '有测试连接按钮');
    check(sAll.some((n) => n.dataset.act === 'ai-clear-key'), '有删除密钥按钮');

    // 密钥框必须是 password 类型（不能明文显示）
    const keyInput = sAll.find((n) => n.attributes.get('type') === 'password');
    check(!!keyInput, '密钥输入框是 password 类型');

    // 隐私说明必须出现在界面上（这是硬要求）
    // ⚠️ 断言和说明文案都要盯住**两种触发方式**。
    //    只提"点词/点句"是不够的：一按「自动翻译全部段落」就会把
    //    每段正文依次发出去，只写前半句就等于对用户隐瞒了一半事实。
    check(/只有你/.test(sText), '界面写明只有你启用后才会联网');
    check(/点词|点句|讲这个词|那一小段/.test(sText), '界面写明了手动触发时发什么（点词/点句那一小段）');
    check(/自动翻译/.test(sText), '★ 界面也写明了「自动翻译全部段落」会把每段正文发出去');
    check(/config\.local\.json/.test(sText), '界面说明了密钥存在哪');
    check(/默认关闭/.test(sText), '界面说明默认关闭');
    check(/联网/.test(sText), '界面明确说了这个功能会联网');

    // ⚠️ 关键：下拉框拉取配置后，页面上**不能出现任何像密钥的字符串**
    const leak = sAll.map((n) => n.textContent).join('|');
    check(!/sk-[A-Za-z0-9_-]{16,}/.test(leak), '设置页文本里不含任何像 API 密钥的串');

    // ---- 保存时如果用户没输密钥，就不该提交 apiKey 字段 ----
    const saveBtn = sAll.find((n) => n.dataset.act === 'ai-save');
    if (saveBtn) {
      const before = savedAiPatches.length;
      saveBtn.click();
      await new Promise((r) => setTimeout(r, 300));
      check(savedAiPatches.length === before + 1, '点保存会提交一次配置');
      const sent = savedAiPatches[savedAiPatches.length - 1];
      check(sent && !('apiKey' in sent),
        '用户没输密钥时不提交 apiKey（否则会把已存的密钥清空）', JSON.stringify(sent));
    }
  }

  // ---- 阅读页：两个页面都要接上 AI，而且都**不能**挂 document 级监听 ----
  //
  // ⚠️ 2026-10 改：原来断言的是 "attachAiTo + destroy + _detachAi"。
  //    用户明确要求删掉"选中文字就浮出按钮条"，那套东西已经不存在了。
  //    现在 AI 走两个固定入口（点词 → 抽屉按钮；点句 → 讲语法），
  //    两者都**不需要 document 级监听**，所以反而应该断言"没有它" ——
  //    这样以后谁不小心加了一个全局监听，这条会立刻变红。
  for (const viewId of ['lyric', 'reading']) {
    const src = fs.readFileSync(path.join(ROOT, `app/js/views/${viewId}.js`), 'utf8');
    // 只看代码，不看注释：注释里解释"为什么删掉了 document 监听"是正常的
    const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    check(/buildAiReader/.test(src), `#/${viewId} 接上了两栏 AI 阅读器`);
    check(/installAiWordHook/.test(src), `#/${viewId} 把「AI 讲这个词」装进了速查抽屉`);
    // 讲语法：两个阅读页只传一个**开关**，整条流程归阅读器管。
    // ⚠️ 这条断言原来是 `/explainSentence/` —— 那个函数走的是浮层面板，
    //    用户明确要求改成"句子下方的可折叠模块"（原话：「ai 的输出依旧是
    //    弹窗，无法保存」）。所以断言跟着改成盯**新的接线方式**，
    //    否则它会逼着人把被否决的弹窗接回去。
    check(/onSentence:\s*true/.test(src), `#/${viewId} 开了「讲语法」，流程交给阅读器`);
    check(!/explainSentence/.test(code), `#/${viewId} 没有退回旧的弹窗式讲语法`);
    check(!/document\.addEventListener/.test(code),
      `#/${viewId} 没有 document 级监听（所以不需要 destroy 去撤销）`);
  }

  // ---- 页脚那句隐私声明（每个页面都在，说错了代价最大）----
  // ⚠️ 加 AI 之前它写的是"用户数据只存在本机浏览器，不会上传到任何服务器"。
  //    加了 AI 之后这句就**不准确**了，所以改成了带限定语的说法。
  //    页脚是 `el(..., {text})` 渲染的纯文本，不能带 Markdown 标记。
  {
    const appSrc = fs.readFileSync(path.join(ROOT, 'app/js/app.js'), 'utf8');
    // ⚠️ 不要用正则去"框住"这段代码 —— 里面嵌套的括号/方括号会让
    //    `[\s\S]{0,900}?\)\)\);` 这种写法停得很早，结果断言其实是在
    //    一个几乎为空的串上跑（第一版就是这样，报了一堆假失败）。
    //    改为按行取：从 `footEl.appendChild` 开始，一直取到出现 `]));` 为止。
    const lines = appSrc.split('\n');
    const start = lines.findIndex((l) => /footEl\.appendChild/.test(l));
    let footLine = '';
    if (start >= 0) {
      for (let i = start; i < lines.length && i < start + 40; i++) {
        footLine += lines[i] + '\n';
        if (/\]\)\);/.test(lines[i])) break;
      }
    }
    check(footLine.length > 80, '取到了页脚那段代码（不是空串）', `${footLine.length} 字符`);
    // ⚠️ 只取**字符串字面量**再判断 —— 只有字符串才是用户看得见的字。
    //    那段代码里紧挨着一条注释写着"原来的说法是'不会上传到任何服务器'"，
    //    那是**解释为什么改**，不是页面上的字。
    //    （用 tools/lib/srcscan.mjs 的共用实现，别再手写一份。）
    const footLiterals = stringLiterals(footLine);
    check(footLiterals.length > 20, '取到了页脚的字符串文案', `${footLiterals.length} 字符`);
    check(/IndexedDB/.test(footLiterals), '页脚提到了数据存在 IndexedDB');
    // 关键：不能出现无条件的"不会上传/不联网"
    check(!/不会上传到任何服务器/.test(footLiterals),
      '页脚不再说"不会上传到任何服务器"（AI 会把选中的文字发出去）');
    check(!/不联网|不需要联网/.test(footLiterals), '页脚不说"不联网"');
    // 必须提到 AI 的例外
    check(/AI/.test(footLiterals), '页脚提到了 AI 这个例外');
    // ⚠️ 2026-10 改：原来这里断言"页脚限定了只发选中的"。
    //    那时唯一的触发方式是"选中一段 → 点按钮"。后来加了「自动翻译全部段落」，
    //    一按那个按钮就会把每段正文依次发出去 —— "只发选中的"当场变成假话。
    //    所以页脚改成了按**两种触发方式**分别说清楚，断言也跟着改。
    check(/点|翻译/.test(footLiterals), '页脚说明了触发方式（点词/点句，或自动翻译）');
    check(!/\*\*|`/.test(footLiterals), '页脚文案里没有 Markdown 标记');
  }

  // ---- 已删除的功能不该复活 ----
  // "选中文字 → 浮出按钮条"是用户明确要求去掉的（跟着光标到处冒，干扰阅读）。
  // 这条是**反面断言**：谁把它加回来，这里立刻变红，而不是等用户抱怨。
  check(!/ai-selbar/.test(panelSrc), 'aipanel.js 里已经没有选区按钮条（用户要求删除）');
  check(!/export function attachAiTo/.test(panelSrc), 'attachAiTo 已经删掉了');

  // ---- 源码断言：绝不自动发送整页 ----
  // 这是对用户的承诺：发出去的文字只可能是调用方**明确传进来**的那一段。
  // 唯一发送入口 runAiTask(task, text) 的 text 就是全部，
  // 它绝不去读 DOM、不去读全文 —— 那种写法一旦出现，这条会红。
  check(!/runAiTask[\s\S]{0,120}textContent/.test(panelSrc),
    'aipanel.js 不会把整块 textContent 当作要发送的文本');
  check(/askAi\(\{\s*task,\s*text/.test(panelSrc) || /askAi\(\{/.test(panelSrc),
    'aipanel.js 只把显式传入的 text 交给 askAi');
}

console.log('\n[9f] 隐私：AI 开启后，界面上关于"联网"的说法必须仍然成立');
{
  // 上面 9b 那节管的是"不能说程序不联网"。这一节管反过来的事：
  // AI 是唯一会联网的功能，所以界面上**必须**说清楚，
  // 而且"用户数据只存本机"这个说法在 AI 开启后仍然要是真的
  //（因为密钥不进浏览器、用户数据不上传）。
  const setSrc = fs.readFileSync(path.join(ROOT, 'app/js/views/settings.js'), 'utf8');
  // ⚠️ 2026-10 改：原来断言"写明只发送选中的文字"。加了「自动翻译全部段落」
  //    之后那句话不再成立，所以改成盯**两种触发方式都要写清楚**。
  check(/只有你自己启用|只有你自己/.test(setSrc), '设置页写明了"只有你启用后才会联网"');
  check(/自动翻译/.test(setSrc), '★ 设置页说明了自动翻译会把每段正文发出去（不能只提"点词"）');
  check(/生词本|学习进度|笔记/.test(setSrc), '设置页说明了哪些东西不会被发送');
  check(/密钥/.test(setSrc) && /config\.local\.json/.test(setSrc), '设置页说明了密钥的存放位置与形式');

  // db.js 的导出清单里不能有 AI 密钥来源
  const dbSrc2 = fs.readFileSync(path.join(ROOT, 'app/js/db.js'), 'utf8');
  check(!/aiKey|apiKey|openai|deepseek/i.test(dbSrc2), '数据层完全不涉及 AI 密钥');
}

console.log('\n[9g] 隐私：全程序只有 AI 一个功能会联网 —— 这条要用代码证明');
{
  // 这是给用户的承诺（也写在使用说明里）："只有 AI 会联网"。
  // 光靠人工检查不可靠，所以做成断言。
  //
  // 判定方法：找出所有会真正发出请求的调用点，看它请求的地址是不是"本站相对路径"。
  //   相对路径（'/api/…'、'/data/…'）→ 打给自己，不算联网。
  //   绝对地址（http(s)://…）→ 真的出门了，必须只出现在 AI 代码里。
  const viewDir = path.join(ROOT, 'app/js/views');
  const jsFiles = [
    ...fs.readdirSync(path.join(ROOT, 'app/js')).filter((f) => f.endsWith('.js')).map((f) => path.join(ROOT, 'app/js', f)),
    ...fs.readdirSync(viewDir).filter((f) => f.endsWith('.js')).map((f) => path.join(viewDir, f)),
  ];

  const outbound = [];
  for (const f of jsFiles) {
    const code = fs.readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    // 抓 fetch('...') / fetch(`...`) 的第一个参数
    const re = /fetch\(\s*(['"`])([^'"`]*)\1/g;
    let m;
    while ((m = re.exec(code)) !== null) {
      const target = m[2];
      if (/^https?:\/\//i.test(target)) {
        outbound.push(`${path.basename(f)} → ${target}`);
      }
    }
  }
  check(outbound.length === 0,
    'app/ 下没有任何"直接打到外部地址"的请求（都走本站相对路径）', outbound.join(' | '));

  // 客户端的 fetch 目标必须都是本站相对路径
  const nonRelative = [];
  for (const f of jsFiles) {
    const code = fs.readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const re = /fetch\(\s*(['"`])([^'"`]*)\1/g;
    let m;
    while ((m = re.exec(code)) !== null) {
      const target = m[2];
      if (target && !/^\//.test(target) && !/^https?:\/\//i.test(target)) {
        nonRelative.push(`${path.basename(f)} → ${target}`);
      }
    }
  }
  check(nonRelative.length === 0,
    '客户端的请求地址都是"/"开头的本站路径', nonRelative.join(' | '));

  // 服务端：唯一能主动连出去的地方就是 AI 代理
  const srvCode = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const srvOut = [];
  {
    const re = /fetch\(\s*([A-Za-z_$][\w$]*)/g;   // fetch(url) / fetch(target)
    let m;
    while ((m = re.exec(srvCode)) !== null) srvOut.push(m[1]);
  }
  check(srvOut.length > 0, '服务端确实有一个出站请求（AI 代理）');
  check(srvOut.every((v) => v === 'url'),
    '服务端只对拼接出来的 url 发起请求（即只有 AI 代理）', srvOut.join(', '));
  // 而且那个 url 必须来自 chatEndpoint(cfg.baseURL)——用户自己填的地址
  check(/const url = chatEndpoint\(cfg\.baseURL\)/.test(srvCode),
    '那个出站地址只能来自用户填的 baseURL');

  // 服务端不许有别的出站手段。
  // ⚠️ 注意：`import http from 'node:http'` 是**必需的** —— 那是用来
  //    **监听**本地请求的（http.createServer）。它是"进门"，不是"出门"。
  //    第一版规则把 `node:http` 整个禁掉了，等于要求删掉服务器本身。
  //    所以这里只禁"真正会主动连出去"的东西：https 客户端、net.connect、WebSocket。
  check(!/from ['"]node:https['"]|require\(['"]https['"]\)/.test(srvCode),
    '服务端不引入 https 客户端模块');
  check(!/net\.connect|new WebSocket|sendBeacon/.test(srvCode),
    '服务端没有 net.connect / WebSocket / sendBeacon');
  // http 模块只允许用来 createServer（监听），不允许用来发请求
  check(!/http\.(request|get)\(/.test(srvCode),
    '服务端不用 http.request / http.get 发请求');
  check(/http\.createServer\(/.test(srvCode), 'http 模块只用来 createServer（监听本地）');
}

console.log('\n[9b] 界面上的隐私说法必须和事实一致（不能再说"不联网、不上传"）');

{
  // 为什么要有这一条：即将接入 AI 翻译/讲解，那是一个**真的会联网**的功能。
  // 界面上如果还写着"程序不联网、不上传"，一旦用户启用 AI，这句话就成了谎话。
  // 首页在 12.7 已经改过一次，同类说法**散落在多处**（这次在设置页又发现一处），
  // 所以这里做一次全量扫描，防止以后再冒出来。
  const viewFiles = fs.readdirSync(path.join(ROOT, 'app/js/views'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ name: 'views/' + f, src: fs.readFileSync(path.join(ROOT, 'app/js/views', f), 'utf8') }));
  viewFiles.push({ name: 'app.js', src: fs.readFileSync(path.join(ROOT, 'app/js/app.js'), 'utf8') });

  for (const f of viewFiles) {
    // 去掉注释再查，否则说明性注释里的字样会误伤
    const code = f.src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // ① "不联网" 一律不许：这是对**整个程序**下的判断，接了 AI 就一定不成立。
    check(!/不联网/.test(code),
      `${f.name} 没有"不联网"这类会变成谎话的说法`);

    // ② "不上传" 要看**说的是谁**。
    //    "用户数据……不上传" 是事实（硬约束 2 没变），必须留着；
    //    "程序不上传" / "不上传任何地方"（无主语、像在描述整个程序）才是问题 ——
    //    因为 AI 功能会把**你选中的那段文字**发出去。
    //    实测踩坑：第一版把这条写成一律禁止，结果把 app.js 里
    //    "用户数据只存在本机浏览器，不上传任何服务器"这句**正确**的话也判成错了。
    const bad = /不是.*不上传/.test(code)
      || /程序[^。；\n]{0,30}不上传/.test(code)
      || /不上传任何地方/.test(code);
    check(!bad, `${f.name} 没有把"不上传"说成对整个程序成立的判断`);
  }

  // 但"数据只存本地""用户数据不上传"是**事实**，必须保留，别一起删掉
  const settingsSrc = fs.readFileSync(path.join(ROOT, 'app/js/views/settings.js'), 'utf8');
  const homeSrc2 = fs.readFileSync(path.join(ROOT, 'app/js/views/home.js'), 'utf8');
  const appSrc3 = fs.readFileSync(path.join(ROOT, 'app/js/app.js'), 'utf8');
  check(/只保存在这台电脑的浏览器里|数据库名 jp-learn/.test(settingsSrc),
    '设置页仍然说明"数据只存本地"（这是事实，不能删）');
  // ⚠️ 这里原来断言 settings.js 含"不会上传到任何地方"。
  //    加了 AI 之后那句话被**主动改掉**了（拆成"哪些绝不会动"+"哪些会出去"），
  //    所以断言也必须跟着改成"区分了两件事"，而不是"含某句原文"。
  //    否则测试会逼着人把一句不准确的话改回去 —— 正是 [9b] 要防的事情。
  check(/绝不会被发送|绝不会被上传/.test(settingsSrc),
    '设置页明确说了哪些数据绝不会被发送');
  // ⚠️ 2026-10 改：原来断言含"当时选中/选中的那一小段"。
  //    现在设置页要同时说清**两种**触发方式：点词/点句（只发那一小段）
  //    和自动翻译（发每段正文）。只提前者就是漏了一半事实。
  check(/那一小段|一小段/.test(settingsSrc),
    '设置页说明了点词/点句时只发那一小段');
  check(/自动翻译/.test(settingsSrc),
    '★ 设置页说明了自动翻译会把每段正文依次发出去');
  // 页脚：必须保留"只存本机"这个事实，同时带上 AI 例外。
  // ⚠️ 判断"不再出现某句旧文案"时必须**先把注释摘掉**：
  //    app.js 里那条解释性注释本身写着"原来的说法是'不会上传到任何服务器'"，
  //    拿整个文件去 grep 会命中自己的注释。这个坑本项目踩过多次。
  const appCode3 = appSrc3
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  check(/只存在本机浏览器/.test(appCode3), '页脚仍然说明"用户数据只存本机"（这是事实，不能删）');
  check(!/不会上传到任何服务器/.test(appCode3),
    '页脚不再出现"不会上传到任何服务器"这句已经不准的话（注释里提不算）');
  check(/AI/.test(appCode3) && /自动翻译|点词|点句/.test(appCode3),
    '页脚写明了 AI 这个例外（并说清发的是哪两种东西）');
  check(/不需要安装|离线/.test(homeSrc2) || /本机|本地/.test(homeSrc2),
    '首页仍然说明本地优先');
}

console.log('\n[8] 覆盖层关闭时必须真正撤销命中测试（否则整页点不动）');
{
  // ⚠️ 真事故：精读页点词 → 打开速查抽屉 → 点右上角 × 关闭 →
  //    **整个页面所有按钮都点不动了**。
  //    根因在 CSS，不在 JS：
  //        .pop-backdrop { position: fixed; inset: 0; z-index: 60; opacity: 0; }
  //        .pop-backdrop.is-open { opacity: 1; }
  //    `opacity: 0` 的元素**照样接收点击** —— 它只是看不见，
  //    但它仍然是一个盖住整个视口的实体，z-index 还比页面高。
  //    关闭时 opacity 变回 0、"看起来消失了"，实际还盖在页面上吃掉每一次点击。
  //
  //    因为 FakeNode 没有布局引擎、更不会做命中测试，
  //    **这个 bug 在假 DOM 里永远测不出来** —— 所以这里退一步，
  //    检查"规则本身是否用了正确的隐藏手段"：
  //    凡是 fixed 定位、铺满视口的覆盖层，用 opacity/transform 隐藏时
  //    必须同时有 visibility: hidden（visibility 才是真正把元素从命中测试里移除的）。
  const cssText = fs.readFileSync(path.join(ROOT, 'app/css/theme.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');   // 先剥注释：说明里写着错误写法，不剥会误报

  // 找出所有"关闭态"规则：选择器里没有 .is-open，但规则体里有 opacity: 0
  const offenders = [];
  for (const m of cssText.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    const body = m[2];
    if (/\{|\}/.test(sel)) continue;
    if (/is-open/.test(sel)) continue;                   // 打开态，不管
    const hidesByOpacity = /opacity:\s*0(?!\.\d)/.test(body);
    const hidesByTransform = /transform:\s*[^;]*translate[XY]?\(/.test(body);
    if (!hidesByOpacity && !hidesByTransform) continue;
    // 只管**铺满视口的固定覆盖层**（小元素如 toast 无所谓）
    const isFullscreenFixed = /position:\s*fixed/.test(body) && /inset:\s*0/.test(body);
    if (!isFullscreenFixed) continue;
    const hasVisibility = /visibility:\s*hidden/.test(body);
    const hasDisplayNone = /display:\s*none/.test(body);
    if (!hasVisibility && !hasDisplayNone) {
      offenders.push(`${sel} —— 用 ${hidesByOpacity ? 'opacity' : 'transform'} 隐藏，`
        + `但没有 visibility: hidden / display: none，关闭后会继续吃掉所有点击`);
    }
  }
  check(offenders.length === 0,
    '铺满视口的覆盖层关闭时用了 visibility/display 真正撤销命中测试',
    offenders.join(' ｜ '));

  // 反向断言：确认上面真的扫到了东西，不是"一条都没匹配到所以通过"
  const fullFixed = [...cssText.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => /position:\s*fixed/.test(m[2]) && /inset:\s*0/.test(m[2]));
  check(fullFixed.length > 0,
    '确实存在铺满视口的固定覆盖层（上面那条不是空跑）', `${fullFixed.length} 条`);

  // 定点盯住出事的那个类，防止有人把 visibility 删回去
  const backdropBlock = (cssText.match(/\.pop-backdrop\s*\{[\s\S]*?\}/) || [''])[0];
  check(/visibility:\s*hidden/.test(backdropBlock),
    '.pop-backdrop 关闭态有 visibility: hidden（曾经只有 opacity: 0，导致整页点不动）');
  const popBlock = (cssText.match(/\.pop\s*\{[\s\S]*?\}/) || [''])[0];
  check(/visibility:\s*hidden/.test(popBlock),
    '.pop 关闭态有 visibility: hidden（滑出屏幕的 fixed 元素仍然会命中）');
  // 打开态必须能收回来
  check(/\.pop-backdrop\.is-open\s*\{[^}]*visibility:\s*visible/.test(cssText),
    '.pop-backdrop.is-open 把 visibility 恢复成 visible');
  check(/\.pop\.is-open\s*\{[^}]*visibility:\s*visible/.test(cssText),
    '.pop.is-open 把 visibility 恢复成 visible');
}

console.log('\n[9h] ★ 笔记改名：只动标题，正文和 AI 译文一律不许碰');
{
  // 用户提的需求：「保存歌词笔记之后我希望能有一个重命名功能」。
  //
  // 为什么这里同时断言 aiCache 没被碰：
  //   改名和"保存笔记"走的是同一条写库路径。而"保存笔记"曾经把 aiCache
  //   整条冲掉（用户报的丢译文 bug）。如果改名的实现写成"读出来、改标题、
  //   整条覆盖写回"，就会**原样复现那个 bug** —— 用户改个名字，译文又没了。
  //   所以这一节不是顺手加的一条，它是**同一个坑的第二个入口**。
  const { renameNote, renderNoteList } = await import('../app/js/views/jpreader.js');
  const db = fakeWindow.JP.db;
  const store = 'lyrics';

  const rec = {
    id: 'lyric:rename-test',
    title: '旧标题',
    text: '猫である。\n名前はまだ無い。',
    translation: '是猫。\n还没有名字。',
    opts: { romaji: 'hepburn', ruby: true },
    stats: { lineCount: 2, charCount: 12 },
    sourceType: 'paste',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    aiCache: { translation: { 0: '是猫。', 1: '还没有名字。' }, at: '2026-01-01T00:00:00.000Z' },
  };
  await db.dbPut(store, rec);

  const applied = await renameNote(store, rec, '  新标题  ');
  check(applied === '新标题', '改名生效，并且去掉了首尾空格', String(applied));

  const after = await db.dbGet(store, 'lyric:rename-test');
  check(after && after.title === '新标题', '库里的标题真的变了');
  check(after && after.text === rec.text, '★ 正文没被动过', after && after.text);
  check(after && after.translation === rec.translation, '★ 用户自己填的中文对照没被动过');
  check(after && after.stats && after.stats.lineCount === 2, '★ 统计信息还留着');
  check(after && after.createdAt === rec.createdAt, '★ 创建时间还留着');
  check(after && after.aiCache && after.aiCache.translation['0'] === '是猫。'
    && after.aiCache.translation['1'] === '还没有名字。',
    '★★ AI 译文缓存没被动过（改名绝不能重演"丢译文"那个 bug）',
    after && after.aiCache ? JSON.stringify(after.aiCache.translation) : 'aiCache 不见了');

  // 空标题不能把名字清掉（否则列表里会出现一条没有名字的笔记）
  const empty = await renameNote(store, rec, '   ');
  check(empty === null, '空标题被拒绝（不会把笔记改成没名字）');
  const stillThere = await db.dbGet(store, 'lyric:rename-test');
  check(stillThere && stillThere.title === '新标题', '拒绝之后标题保持原样');

  // 不存在的记录不能抛错
  let threw = '';
  let missing = 'x';
  try { missing = await renameNote(store, { id: '不存在' }, '随便'); } catch (e) { threw = e.message; }
  check(!threw && missing === null, '改不存在的笔记返回 null，不抛错', threw);

  // ---- 界面上真的有一个「改名」按钮，并且点了会变成输入框 ----
  await db.dbPut('readings', {
    id: 'reading:rename-ui', title: '精读旧名', text: '猫である。',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const list = await renderNoteList('readings', { onOpen() {}, onDelete() {} });
  const btns = list._walk([]).filter((n) => n.tagName === 'BUTTON');
  const renameBtn = btns.find((b) => b.textContent === '改名');
  check(!!renameBtn, '★ 笔记列表里有「改名」按钮（歌词页和精读页共用这个列表）');
  if (renameBtn) {
    renameBtn.click();
    await new Promise((r) => setTimeout(r, 30));
    const inputs = list._walk([]).filter((n) => n.classList.contains('note-title-edit'));
    check(inputs.length === 1, '★ 点「改名」之后就地变成输入框（不弹窗、不跳页）', String(inputs.length));
    if (inputs.length === 1) {
      check(inputs[0].value === '精读旧名', '输入框里带着原名，方便只改一部分', inputs[0].value);
    }
  }
}

console.log('\n[9] 没有未捕获的错误提示');
const errToasts = docBody._walk([]).filter((n) => n.classList.contains('toast-error'));
check(errToasts.length === 0, '没有 error 提示条', errToasts.map((n) => n.textContent).join(' | ').slice(0, 160));
check(errors.length === 0, 'console.error 没有输出', errors.slice(0, 2).join(' | ').slice(0, 160));

console.error = origError;

// ---------------------------------------------------------------------------
console.log('\n[10] ★ 全局不变量：隐私承诺不许和"自动翻译"自相矛盾');
{
  // 这一段是**穷举式**的，不是逐条写死的。
  //
  // 为什么需要它：隐私文案在本项目里已经变成过两次谎话 ——
  //   ① "程序完全不联网" —— 加了 AI 之后不成立；
  //   ② "只把你选中的那段文字发出去" —— 加了「自动翻译全部段落」之后不成立，
  //      因为一按那个按钮就会把每段正文依次发出去。
  // 两次的成因是同一个：**改了行为，忘了改文案**。
  // 逐条写死的断言只能守住"我已经想到的那几句"，
  // 所以这里换成一条更宽的规则：
  //
  //   只要界面上任何一句承诺提到"只有你选中的…会被发送"，
  //   整个界面就必须**同时**说明"自动翻译会发每段正文"。
  //
  // 判断依据只看**字符串字面量**（`stringLiterals`），
  // 因为只有字符串才是用户看得见的字；注释里的话用户看不到。
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      // __qa__ 是自检载荷，不是应用的一部分，也不算用户可见文案
      if (e.isDirectory()) { if (e.name !== '__qa__') walk(p); }
      else if (/\.(js|html)$/.test(e.name)) files.push(p);
    }
  })(path.join(ROOT, 'app'));

  const uiText = files.map((f) => stringLiterals(fs.readFileSync(f, 'utf8'))).join('\n');

  // 反面：这个"选中"的说法如果再出现，就必须有人补上自动翻译的说明。
  // 现在程序里已经**一处都没有**了，所以这条同时钉住了"不许再出现"。
  check(!/只有你选中|只发你选中|只把你选中/.test(uiText),
    '★ 界面上不再有"只发你选中的"这种和自动翻译矛盾的说法',
    (uiText.match(/[^\n]*(只有你选中|只发你选中|只把你选中)[^\n]*/g) || []).join(' | ').slice(0, 200));

  // ── 关键：**按文件**检查，不是整个 app 拼起来查 ──
  // ⚠️ 第一版就是拼起来查的，结果"删掉首页那句自动翻译的说明"没被抓到 ——
  //    因为 settings.js 里也有"自动翻译"四个字，一拼就凑齐了。
  //    那等于在测"整个程序里某个地方提过"，完全没有约束力。
  //    真正的规则是：**哪一句话说了"会发出去"，它自己就得说全**
  //    （手动点词发一小段 + 自动翻译发每段正文），
  //    因为用户可能只看到那一段。
  //
  // ⚠️ 第二版把"发送"也算进来，误伤了 diagpanel.js 的「发送中…」「发送失败：」
  //    —— 那是**诊断请求**的状态提示，跟"把用户数据发给 AI"是两回事。
  //    判据必须盯住**数据发去哪**，不是"发送"这两个字。
  // ⚠️ 第三版的教训：判据只写"发给你的 AI / 会被发送"，结果**首页那句
  //    「发出去的也只有你要处理的日文」认不出来**，于是"把首页的自动翻译
  //    说明删掉"这个破坏又漏过去了。
  //    判据要按**话题**写，不能按某一个具体的动词搭配写 ——
  //    换个说法就失效的检查等于没有。
  //
  // ⚠️ 第四版的教训：把判据放宽成"谈发出去/上传"之后，又误伤了两个文件：
  //    reading.js「图片不会上传」和 vocab.js「文件只在你本机解析」——
  //    这两句谈的是**本机处理**，本来不该要求它们提自动翻译。
  //    所以判据必须**两个条件同时成立**才算一句"关于 AI 会发什么的承诺"：
  //      ① 这一段在谈 AI；② 这一段在谈"东西会发出去/不会发出去"。
  //
  // ⚠️ 第五版（现在这版）的修正：必须在**一段话的范围**里判断，
  //    不能在整个文件的范围里判断。原因：
  //      · 按文件判断 → reading.js 里"② 翻译要用 AI"和"③ 图片不会上传"
  //        是同一张提示卡里**相邻两句**，被判成同一个话题，于是被误伤；
  //      · 按整段字符串判断 → ② 和 ③ 是两条独立字符串，分得干干净净。
  //    所以这里把每个文件切成"相邻的几条界面文案"作为判断单位。
  //    **判断单位选错，规则再对也会误报。**
  const AI_CONTEXT = /AI|人工智能/;
  const SENDS = /发给你的 AI|发给你填的|发给 AI|发给你的|会被发送|发出去|不出本机|不会上传/;
  const TRIGGER_MANUAL = /点词|点句|讲这个词|讲这句|那一小段/;
  const TRIGGER_AUTO = /自动翻译/;

  /**
   * 把一段源码切成"相邻的几条界面文案"，作为判断单位。
   *
   * 做法：取中文文案字面量（带行号），行号接近的归成一组。
   * 这样 home.js 那段"只有你打开 AI 之后才会联网…点词…自动翻译…其余数据…"
   * 会落进同一组（它们是相邻的字符串拼接），
   * 而 reading.js 里彼此独立的提示条目各自成组。
   */
  function uiBlocks(src) {
    const lits = [...src.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g)]
      .map((m) => ({ text: m[0].slice(1, -1), line: src.slice(0, m.index).split('\n').length }))
      .filter((x) => /[\u4e00-\u9fa5]/.test(x.text) && x.text.length > 2);
    const groups = [];
    let cur = null;
    for (const x of lits) {
      if (cur && x.line - cur.last <= 3) { cur.text += '\n' + x.text; cur.last = x.line; }
      else { cur = { from: x.line, last: x.line, text: x.text }; groups.push(cur); }
    }
    return groups;
  }

  const offenders = [];
  const senders = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    for (const b of uiBlocks(codeOnly(fs.readFileSync(f, 'utf8')))) {
      // 两个条件同时成立才算"关于 AI 会发什么的承诺"（见上面第四版的教训）
      if (!(AI_CONTEXT.test(b.text) && SENDS.test(b.text))) continue;
      senders.push(`${rel}:${b.from}`);
      const miss = [];
      if (!TRIGGER_AUTO.test(b.text)) miss.push('没提自动翻译');
      if (!TRIGGER_MANUAL.test(b.text)) miss.push('没提手动点词/点句');
      if (miss.length) offenders.push(`${rel}:${b.from}（${miss.join('、')}）`);
    }
  }
  check(offenders.length === 0,
    '★ 凡是讲了"把数据发给 AI"的那段文案，都把两种触发方式说全了（不许只提一半）',
    offenders.join(' ｜ '));

  // 确认上面的扫描真的扫到了东西（防止"一个文件都没读到所以通过"）
  check(files.length > 20, '扫描确实读到了应用源码（上面几条不是空跑）', `${files.length} 个文件`);
  check(senders.length >= 4,
    '确实有多个文件在谈"把数据发给 AI"（上面那条不是空跑）', `${senders.length} 个文件`);
}

console.log('\n' + '='.repeat(72));
console.log(fail === 0 ? ` 全部通过（${pass} 项）` : ` ${fail} 项未通过（通过 ${pass} 项）`);
console.log('='.repeat(72));
process.exit(fail === 0 ? 0 : 1);
