/**
 * `tools/qa-bugs.mjs` 的载荷：在**真浏览器**里验证用户报的五个 bug 已经修好。
 *
 * ────────────────────────────────────────────────────────────────────
 * 设计：为什么把每个断言做成一个"检查函数"
 * ────────────────────────────────────────────────────────────────────
 * 这个文件**自己不下结论**，也不自己拼通过/失败的文字。它只把每个检查
 * 做成一个返回 `{ok, note}` 的函数，挂在 `window.__QA.check` 上，
 * 由外面的 node 脚本一个一个调用。
 *
 * 这样做的好处很实在：断言名字和判定逻辑留在 node 那一侧（和别的测试一致），
 * 页面这一侧只负责"观察真实世界并把看到的东西如实报回来"。
 * 页面里自己写 console.log 的坏处是 headless 里看不到输出，
 * 一旦出错就只剩"页面一片空白"。
 *
 * ⚠️ 每一条检查函数都必须**自己完成所需的导航和等待**，不能依赖调用顺序。
 *    靠顺序的测试在有人插一条新断言之后就会莫名其妙地红。
 */
import * as db from '/js/db.js';

window.__QA = { status: 'starting', errors: [], check: {}, consoleErrors: [] };

// 收所有 console.error —— 「没有报错」本身就是一条要断言的事实
for (const level of ['error', 'warn']) {
  const orig = console[level].bind(console);
  console[level] = (...a) => {
    window.__QA.consoleErrors.push(level + ': ' + a.map((x) => {
      try { return typeof x === 'string' ? x : JSON.stringify(x); } catch { return String(x); }
    }).join(' '));
    orig(...a);
  };
}
window.addEventListener('error', (e) => {
  window.__QA.errors.push(`window.error: ${e.message || ''} @ ${e.filename || ''}:${e.lineno || ''}`);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  window.__QA.errors.push('unhandledrejection: ' + ((r && r.message) || String(r)));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等一个条件成立；超时返回 false（**不抛错** —— 由断言那边去报"没等到"） */
async function until(fn, ms = 12000, step = 200) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = await fn(); } catch { v = false; }
    if (v) return true;
    if (Date.now() - t0 > ms) return false;
    await sleep(step);
  }
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/** 走路由（不刷新页面，和用户点导航一样） */
async function goto(viewId) {
  const JP = window.JP;
  if (JP && JP.router && typeof JP.router.go === 'function') {
    JP.router.go(viewId);
  } else {
    location.hash = '#/' + viewId;
  }
  // 视图的 render 是异步的，等 DOM 真的换掉
  await until(() => $('#mount') && $('#mount').children.length > 0, 8000);
  await sleep(350);
}

/** 点一个元素 —— 用真实的 DOM click，会冒泡，和用户点一样 */
function click(node) {
  if (!node) return false;
  node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return true;
}

/** 派发一个指定类型的事件（click / dblclick / contextmenu …） */
function fire(node, type, init = {}) {
  if (!node) return false;
  node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
  return true;
}

// ===========================================================================
// 0. 启动真正的 app.js
// ===========================================================================
try {
  // ⚠️ 必须在 import app.js **之前**铺好"上一版的用户数据"，
  //    否则 app 一启动就已经把库升级到当前版本，那个 bug 就复现不出来了。
  //    这里复现的正是用户当时的状态：库停在版本 2、缺 readingOverrides 表。
  window.__QA.seeded = await seedLegacyV2();

  await import('/js/app.js');
  await until(() => window.JP && window.JP.router, 15000);
  // 等首页渲染出来
  await until(() => $('#mount') && $('#mount').children.length > 0, 8000);
  await sleep(400);
  window.__QA.status = 'booting';
} catch (e) {
  window.__QA.status = 'threw';
  window.__QA.errors.push('启动 app.js 失败: ' + ((e && e.stack) || String(e)));
}

/**
 * 造一个"版本 2、缺少 readingOverrides 表"的旧库 —— 用户报 bug 2 时的真实状态。
 *
 * ⚠️ 这是整个 QA 里唯一需要"造假"的地方，而且是刻意的：
 *    正常的全新安装**永远走不到**那条升级路径，而 bug 2 恰恰只在这条路径上。
 *    不造这个旧库，就等于不测 bug 2。
 *
 * 只建几张有代表性的表（meta / words / lyrics），不建 readingOverrides ——
 * 这样它就是"老用户的库"，而不是"程序刚建好的库"。
 */
function seedLegacyV2() {
  return new Promise((resolve) => {
    const req = indexedDB.open('jp-learn', 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      if (!d.objectStoreNames.contains('words')) d.createObjectStore('words', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('lyrics')) d.createObjectStore('lyrics', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('snapshots')) d.createObjectStore('snapshots', { keyPath: 'id' });
      // ★ 故意**不建** readingOverrides —— 这就是 bug 2 的现场
    };
    req.onsuccess = () => {
      const d = req.result;
      const names = [...d.objectStoreNames];
      d.close();
      resolve({ version: 2, stores: names, hasReadingOverrides: names.includes('readingOverrides') });
    };
    req.onerror = () => resolve({ error: String(req.error) });
    // 已经存在更高版本的库（比如同一个 profile 跑第二次）就如实报告
    req.onblocked = () => resolve({ blocked: true });
  });
}

// ===========================================================================
// 1. ★ 右下角查词按钮：必须**一进页面就有**，不依赖任何点击
// ===========================================================================
window.__QA.check.fabOnBoot = async () => {
  // 回到首页 —— 用户抱怨的就是"在首页/随便哪个页面时看不见它"
  await goto('home');
  const fab = $('.pop-fab');
  const drawerOpen = !!$('.pop.open') || !!$('.pop-backdrop.open');
  return {
    ok: !!fab && !drawerOpen,
    note: fab
      ? `按钮在首页就存在（文字="${fab.textContent.trim()}"）；抽屉未自动展开=${!drawerOpen}`
      : '首页上找不到 .pop-fab —— 按钮还是"要点过某个词才出现"的老样子',
    extra: { hasFab: !!fab, drawerOpen },
  };
};

window.__QA.check.fabOpens = async () => {
  await goto('home');
  const fab = $('.pop-fab');
  if (!fab) return { ok: false, note: '没有 .pop-fab，没法测点击' };
  click(fab);
  const opened = await until(() => !!$('.pop.open') || !!$('.pop'), 4000);
  const input = $('.pop input[type="search"]');
  // 关掉，别影响后面的检查
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(250);
  return {
    ok: opened && !!input,
    note: opened ? `点按钮打开了抽屉（有搜索框=${!!input}）` : '点了按钮但抽屉没打开',
  };
};

// ===========================================================================
// 2. ★ 查词结果：同音词要**全部**出来，而且条数要说清楚
// ===========================================================================
//
// ⚠️ 这里把 `/api/dict/lookup` 临时接管掉，喂一组**固定**的数据。
//    为什么不直接用真服务：真服务返回几条会随词库变化，
//    断言就得写"≥3 条"这种含糊的话 —— 而用户报的 bug 恰恰是
//    "应该出 5 条却只出了 1 条"，含糊的断言抓不住它。
//    接管之后可以精确断言"喂 3 条就必须显示 3 条、且写明共 3 条"。
window.__QA.check.homophones = async () => {
  await goto('home');
  const fab = $('.pop-fab');
  if (!fab) return { ok: false, note: '没有 .pop-fab' };
  click(fab);
  if (!await until(() => !!$('.pop input[type="search"]'), 4000)) {
    return { ok: false, note: '抽屉没打开，测不了查词' };
  }

  // 接管查词接口：固定喂 3 条同音词（讀音都是 かた，和用户举的例子一致）
  const realFetch = window.fetch;
  const fake = {
    ok: true,
    query: 'かた',
    exact: [
      { id: 'qa-1', term: '方', reading: 'かた', level: 'N5', zh: ['方向；方面'], pos: ['名'] },
      { id: 'qa-2', term: '肩', reading: 'かた', level: 'N3', zh: ['肩膀'], pos: ['名'] },
      { id: 'qa-3', term: '過多', reading: 'かた', level: 'N1', zh: ['过多'], pos: ['名'] },
    ],
    byReading: [],
    total: 3,
  };
  window.fetch = (input, init) => {
    const u = typeof input === 'string' ? input : (input && input.url) || '';
    if (u.includes('/api/dict/lookup')) {
      return Promise.resolve(new Response(JSON.stringify(fake), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    }
    return realFetch(input, init);
  };

  try {
    const input = $('.pop input[type="search"]');
    input.value = '\u304B\u305F';   // かた
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // 输框是防抖 220ms，等结果渲染
    await until(() => $$('.pop-hit').length >= 3, 6000);
    const hits = $$('.pop-hit');
    const terms = hits.map((h) => (h.querySelector('.pop-hit-term') || {}).textContent || '');
    const bodyText = ($('.pop-body') || {}).innerText || '';
    // 抽屉整体文字（含底部说明）
    const popText = ($('.pop') || {}).innerText || '';

    const allThree = terms.filter((t) => ['方', '肩', '過多'].includes(t.trim())).length;
    const saysCount = /共\s*3\s*条/.test(popText);
    return {
      ok: hits.length === 3 && allThree === 3 && saysCount,
      note: `命中 ${hits.length} 条（${terms.join('・')}）；写明"共 N 条"=${saysCount}`,
      extra: { terms, bodyText: bodyText.slice(0, 200), saysCount },
    };
  } finally {
    window.fetch = realFetch;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(200);
  }
};

// ===========================================================================
// 3. ★★ 改注音：报错的那个 bug（旧库缺表）
// ===========================================================================
window.__QA.check.overrideStore = async () => {
  const jpDb = window.JP && window.JP.db;
  if (!jpDb) return { ok: false, note: 'window.JP.db 不存在，拿不到数据层' };
  try {
    await jpDb.dbPut('readingOverrides', {
      surface: 'QA\u6D4B\u8BD5', reading: '\u3066\u3059\u3068', at: new Date().toISOString(),
    });
    const back = await jpDb.dbGet('readingOverrides', 'QA\u6D4B\u8BD5');
    await jpDb.dbDelete('readingOverrides', 'QA\u6D4B\u8BD5');
    return {
      ok: !!back && back.reading === '\u3066\u3059\u3068',
      note: back
        ? '★ 往 readingOverrides 写入并读回都成功（不再报 object stores was not found）'
        : '写入没有报错但读不回来',
      extra: { seeded: window.__QA.seeded },
    };
  } catch (e) {
    return {
      ok: false,
      note: '写 readingOverrides 仍然失败：' + ((e && e.message) || e),
      extra: { seeded: window.__QA.seeded },
    };
  }
};

// ===========================================================================
// 4. ★ 改注音的入口：页面必须有一行小字说明怎么改
// ===========================================================================
window.__QA.check.editHint = async (ctx) => {
  await openReadingReader();
  const hint = $('.air-edit-hint');
  const text = hint ? hint.innerText.replace(/\s+/g, ' ').trim() : '';
  // 小字里必须说清"双击"和"不用点准"这两件事
  const saysDbl = /\u53CC\u51FB/.test(text);
  const saysAnywhere = /\u4E0D\u7528\u70B9\u51C6|\u54EA\u513F\u90FD\u884C/.test(text);
  // ★ 还必须提一句"改分词"（用户要求：「把改分词的方法用小字写出来」）。
  //   理由是同一个老问题：改分词藏在"改读音"对话框里，
  //   光看这行小字**根本猜不到它存在**。功能在但没人知道 = 没有这个功能。
  //   断言到"改分词"这个入口名 + "合"/"切"两个动作名，
  //   因为只说"可以改分词"用户还是不知道点哪儿。
  const sub = $('.air-edit-hint-sub');
  const subText = sub ? sub.innerText.replace(/\s+/g, ' ').trim() : '';
  const saysSegment = /\u6539\u5206\u8BCD/.test(subText);
  const saysMerge = /\u5408/.test(subText);
  const saysSplit = /\u5207/.test(subText);
  return {
    ok: !!hint && saysDbl && saysAnywhere && saysSegment && saysMerge && saysSplit,
    note: hint
      ? `小字存在，"双击"=${saysDbl}、"不用点准"=${saysAnywhere}；`
        + `改分词那句：入口=${saysSegment}、"合"=${saysMerge}、"切"=${saysSplit}`
        + ` —— ${text.slice(0, 80)}`
      : '页面上找不到 .air-edit-hint（用户说"入口无提示"的那个问题没修）',
  };
};

/** 触发一次"改读音"，看编辑器有没有出来（双击 / 右键两条路都要能用） */
window.__QA.check.editTrigger = async () => {
  await openReadingReader();
  const chip = $('.air-ja .jpr-w') || $('.jpr-w');
  if (!chip) return { ok: false, note: '页面上没有可点的词（.jpr-w）' };

  // --- 双击 ---
  fire(chip, 'dblclick');
  const byDbl = await until(() => !!$('.yomi-form'), 3000);
  closeModal();
  await sleep(200);

  // --- 右键（最"稳"的一条路：不会和单击查词混在一起）---
  fire(chip, 'contextmenu');
  const byCtx = await until(() => !!$('.yomi-form'), 3000);
  closeModal();
  await sleep(200);

  return {
    ok: byDbl && byCtx,
    note: `双击能改读音=${byDbl}；右键也能=${byCtx}`,
  };
};

function closeModal() {
  // 模态的关闭按钮 / Esc 都试一遍
  const btn = $$('.modal button, .dialog button, .ui-modal button')
    .find((b) => /\u53D6\u6D88|\u5173\u95ED|\u5B8C\u6210|\u4E0D\u6539/.test(b.textContent));
  if (btn) { click(btn); return; }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

/**
 * 先把"AI 隐私确认"点过。
 *
 * ⚠️ 为什么非做不可（这是第二版才发现的）：
 *    `runAiTaskInline()` 第一件事是 `ensureAck(confirmAiNotice)` ——
 *    没确认过就**弹一个确认框等人点**。
 *    headless 里那个框在看不见的窗口里，没人点，于是这个 Promise
 *    **永远挂着**：既不发请求，也不报错。
 *
 *    第一版的断言只看"有没有发出 AI 请求"，于是红；而它红的原因
 *    其实是"确认框没人点"，不是"按钮没接上流程"—— 差一点就去改代码了。
 *    后来加了 `gramImmediately/busyImmediately` 才发现真相：
 *    **点完立刻进入忙碌态但之后再无动静** = 卡在确认框上。
 *
 *    这也说明"数请求条数"这一个信号不够：还得看**忙碌态有没有收尾**。
 */
async function preAgreeAi() {
  try {
    const m = await import('/js/ai.js');
    await m.setAck(true);
    return await m.getAck();
  } catch (e) {
    return 'setAck 失败: ' + String((e && e.message) || e);
  }
}

// ===========================================================================
// 5. ★★ 讲语法：点句子空白处**不许**误触；结果要落在句子下方的模块里
// ===========================================================================
//
// ⚠️ 这一段刻意把 AI **打开**（接管 /api/ai/config 返回 enabled:true），
//    而不是靠"AI 没配所以什么都没发生"蒙过去。
//
//    为什么这一点很重要（第一版就栽在这里）：
//      AI 关闭时 askGrammar() 会提前 return，于是"点空白处什么都没发生"
//      **既能解释成"误触修好了"，也能解释成"AI 没开"** —— 断言没有判别力。
//      我把它接回"点整行就讲语法"跑了一遍，测试**照样全绿**，才发现这个问题。
//
//    打开 AI 之后两件事都变得可观测了：
//      · 只有点按钮才该产生 /api/ai/chat 请求（数请求条数，最硬的证据）；
//      · 误触会立刻出现 .air-gram 模块或 AI 浮层。
installAiStub();

function installAiStub() {
  if (window.__QA.aiStub) return window.__QA.aiStub;
  const realFetch = window.fetch;
  const stub = { chatCalls: 0, configCalls: 0, lastBody: null, enabled: true, urls: [] };
  window.fetch = (input, init) => {
    const u = typeof input === 'string' ? input : (input && input.url) || '';
    if (stub.urls.length < 40) stub.urls.push(u.slice(0, 80));
    if (u.includes('/api/ai/config')) {
      stub.configCalls++;
      return Promise.resolve(new Response(JSON.stringify({
        ok: true,
        config: { enabled: stub.enabled, provider: 'qa', model: 'qa', baseUrl: 'http://127.0.0.1:1/v1' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    if (u.includes('/api/ai/chat')) {
      stub.chatCalls++;
      try { stub.lastBody = init && init.body ? String(init.body).slice(0, 200) : null; } catch { /* 忽略 */ }
      // 故意返回失败：我们不测 AI 答得好不好，只测"有没有真的去请求"。
      // 失败也会渲染出模块（带失败说明），正好证明结果落在句子下方这条路径是通的。
      return Promise.resolve(new Response(JSON.stringify({
        ok: false, error: 'QA：这是自检里的假 AI，不会真的联网',
      }), { status: 502, headers: { 'content-type': 'application/json' } }));
    }
    return realFetch(input, init);
  };
  window.__QA.aiStub = stub;
  return stub;
}

window.__QA.check.noMisfire = async () => {
  const stub = installAiStub();
  // 重建阅读器，让 aiOn 这一步读到"已启用"
  await resetReader();
  await openReadingReader();
  const ja = $('.air-ja');
  if (!ja) return { ok: false, note: '没有 .air-ja' };

  const before = stub.chatCalls;

  // 点"日文栏的空白处"（不是词、也不是那个按钮）——
  // 这正是用户说"很容易误触"的那个动作
  click(ja);
  // 留足时间：误触的话请求和渲染都会在 1 秒内发生
  await sleep(1500);

  const after = stub.chatCalls;
  const panel = !!$('.ai-panel-wrap') || !!$('.ai-panel');
  const gram = !!$('.air-gram');
  const fired = after > before;
  return {
    ok: !fired && !panel && !gram,
    note: fired
      ? `★★ 点句子空白处发出了 ${after - before} 次 AI 请求（误触没修）`
      : (panel ? '★★ 点句子空白处弹出了 AI 面板（误触没修）'
        : (gram ? '★★ 点句子空白处直接生成了语法模块（误触没修）'
          : '★★ 点句子空白处：AI 请求 0 次、没有面板、没有模块（误触已消除）')),
    extra: { chatCallsBefore: before, chatCallsAfter: after },
  };
};

window.__QA.check.grammarModule = async () => {
  const stub = installAiStub();
  const ack = await preAgreeAi();
  await resetReader();
  await openReadingReader();
  const btn = $('.air-gram-btn');
  if (!btn) return { ok: false, note: '找不到「讲语法」按钮（.air-gram-btn）' };
  const btnText = btn.textContent.trim();
  const before = stub.chatCalls;

  btn.click();
  // ★ askGrammar 是**同步**调 paintGrammar 的，所以点完这一刻就应该看到忙碌态。
  //   用它来区分"按钮没接上"（连模块都没有）和"卡在确认框上"（有忙碌态但不动）。
  const gramImmediately = !!$('.air-gram');
  const busyImmediately = !!$('.air-gram.is-busy');

  const fired = await until(() => stub.chatCalls > before, 6000);
  const shown = await until(() => !!$('.air-gram'), 9000);
  // ★ 忙碌态必须收尾 —— 只看"发了请求"会被"卡住"蒙过去
  const settled = await until(() => !$('.air-gram.is-busy'), 9000);
  const inRowHost = shown ? !!$('.air-row .air-gram-host .air-gram') : false;
  const panel = !!$('.ai-panel-wrap') || !!$('.ai-panel');
  const text = shown ? ($('.air-gram').innerText || '').replace(/\s+/g, ' ').slice(0, 120) : '';
  return {
    ok: fired && shown && settled && inRowHost && !panel,
    note: fired
      ? (shown
        ? `★ 点「${btnText}」发出了 AI 请求，结果显示在这一行的下方`
          + `（.air-gram-host 里=${inRowHost}、用了浮层=${panel}、忙碌态已收尾=${settled}）：${text}`
        : '发了请求，但没有模块出现')
      : `点了「讲语法」却没有发出任何 AI 请求；点完立刻有模块=${gramImmediately}、`
        + `忙碌态=${busyImmediately}（两者都真=卡在"AI 隐私确认"框上）、确认状态=${JSON.stringify(ack)}`,
    extra: {
      chatCallsBefore: before, chatCallsAfter: stub.chatCalls,
      configCalls: stub.configCalls, inRowHost, panel, ack,
      gramImmediately, busyImmediately, settled, btnCount: $$('.air-gram-btn').length,
    },
  };
};

/**
 * 把已经建好的阅读器**真的**清掉，逼下一次 openReadingReader 重新建一遍。
 *
 * ⚠️ 为什么必须"真的换页"而不是直接把节点删掉：
 *    `openReadingReader()` 开头是 `if ($('.air-reader')) return true;` ——
 *    它是按"页面上有没有阅读器"来判断的。
 *    而 `aiOn`（AI 是否启用）是在**建阅读器那一刻**读一次并缓存的。
 *    如果只是把 DOM 节点删掉、没有换页，下一次就会命中早退分支，
 *    拿到的是同一个旧阅读器（aiOn 还是旧的 false）——
 *    表现为"按钮点了没反应"，而真正的原因是我们根本没重建。
 *
 *    第一版就是这么写的，结果 grammarModule 一直报"没有发出 AI 请求"。
 *    所以这里必须：先切到别的页面（把 reader 从 DOM 上摘掉），
 *    再切回来（让 render → mountReader 重跑）。
 */
async function resetReader() {
  if (!(window.JP && window.JP.router)) return;
  await goto('home');
  await until(() => !$('.air-reader'), 6000);
}

// ===========================================================================
// 6. ★★ 已保存的笔记不许被当成"没保存的草稿"
// ===========================================================================
const QA_TEXT = '\u541B\u306E\u540D\u524D\u306F\u3002';        // 君の名前は。
const QA_ZH = '\u4F60\u7684\u540D\u5B57\u662F\u3002';          // 你的名字是。

window.__QA.check.draftNoFalsePositive = async () => {
  const jpDb = window.JP && window.JP.db;
  if (!jpDb) return { ok: false, note: 'window.JP.db 不存在' };

  // 造一条"已保存的歌词笔记"，并且把它的内容写进草稿 ——
  // 这正是用户当时的库状态：草稿文件在，但内容其实早就是一条笔记了。
  await jpDb.dbPut('lyrics', {
    id: 'qa-lyric-1', title: 'QA 歌词', text: QA_TEXT, translation: QA_ZH,
    opts: {}, stats: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  localStorage.setItem('jp-learn:draft:lyric', JSON.stringify({
    text: QA_TEXT, translation: QA_ZH, at: new Date().toISOString(),
  }));

  await goto('lyric');
  await sleep(800);

  const banner = $$('.banner-warn').find((b) => /\u8349\u7A3F/.test(b.textContent));
  const draftGone = localStorage.getItem('jp-learn:draft:lyric') === null;
  return {
    ok: !banner && draftGone,
    note: banner
      ? '★ 还是弹出了"发现一份没保存的草稿"（用户报的那个问题没修）'
      : `没有弹草稿提示（草稿文件也已清掉=${draftGone}）`,
  };
};

window.__QA.check.draftRealOneStillShown = async () => {
  // 反向断言：**真的**没保存过的草稿必须照常提示 ——
  // 不能为了修 bug 把整个草稿保护功能关掉。
  localStorage.setItem('jp-learn:draft:lyric', JSON.stringify({
    text: '\u8FD9\u662F\u4E00\u4EFD\u771F\u6CA1\u4FDD\u5B58\u8FC7\u7684\u8349\u7A3F\u3002',
    translation: '', at: new Date().toISOString(),
  }));
  await goto('home');
  await sleep(200);
  await goto('lyric');
  await sleep(900);
  const banner = $$('.banner-warn').find((b) => /\u8349\u7A3F/.test(b.textContent));
  const restoreBtn = banner
    ? [...banner.querySelectorAll('button')].find((b) => /\u6062\u590D/.test(b.textContent))
    : null;
  const ok = !!banner && !!restoreBtn;
  // 收拾干净，别留给后面的检查
  localStorage.removeItem('jp-learn:draft:lyric');
  return {
    ok,
    note: banner
      ? '★ 真草稿照常提示，并且有「恢复草稿」按钮（原来的保护没被修坏）'
      : '★ 真草稿反而不提示了 —— 修过了头，草稿保护被关掉了',
  };
};

window.__QA.check.draftNotRecreated = async () => {
  // 打开一条已保存的笔记之后，**自动保存的 5 秒定时器**不许把它重新写成草稿。
  // 这是 bug 5 的真正根源（不是"少清了一次草稿"，是"清完又被重建"）。
  const jpDb = window.JP && window.JP.db;
  localStorage.removeItem('jp-learn:draft:lyric');
  await goto('lyric');
  await sleep(400);

  // 找到笔记列表里"打开"的入口，真的点一次
  const openBtn = $$('#mount button').find((b) => /^\u6253\u5F00$|\u6253\u5F00\u7B14\u8BB0/.test(b.textContent.trim()));
  if (openBtn) {
    click(openBtn);
    // 等解析完（会调接口）
    await until(() => !!$('.air-reader') || !!$('textarea').value, 12000);
    await sleep(1000);
  } else {
    // 找不到按钮就直接把内容填进输入框 —— 效果等价：
    // 模拟"打开笔记之后输入框里有内容"这个状态
    const ta = $('#mount textarea');
    if (ta) {
      ta.value = QA_TEXT;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // ★ 等**超过**自动保存的 5 秒兜底间隔（留出余量），看草稿会不会自己长出来
  await sleep(7000);
  const recreated = localStorage.getItem('jp-learn:draft:lyric');
  let parsed = null;
  try { parsed = recreated ? JSON.parse(recreated) : null; } catch { /* 坏了也当没写 */ }
  const ok = !parsed || parsed.text !== QA_TEXT;
  return {
    ok,
    note: ok
      ? '★★ 等了 7 秒（超过自动保存的 5 秒间隔），草稿没有被重建'
      : '★★ 自动保存又把已保存笔记的内容写回了草稿：' + JSON.stringify(parsed).slice(0, 120),
  };
};

// ===========================================================================
// 7. 收尾：整个过程不许有真正的错误
// ===========================================================================
window.__QA.check.noConsoleErrors = async () => {
  // 过滤掉"预期内"的噪音：AI 没配置时的提示、404 的 favicon 等
  const IGNORE = /AI|favicon|net::ERR|Failed to load resource|manifest/i;
  const real = window.__QA.consoleErrors.filter((s) => !IGNORE.test(s));
  const pageErrs = window.__QA.errors.filter((s) => !IGNORE.test(s));
  return {
    ok: real.length === 0 && pageErrs.length === 0,
    note: `未预期的 console 报错 ${real.length} 条、页面异常 ${pageErrs.length} 条`,
    extra: { real: real.slice(0, 5), pageErrs: pageErrs.slice(0, 5) },
  };
};

// ===========================================================================
// 8. ★★ 双击改读音，不许把查词抽屉开开关关
// ===========================================================================
//
// 用户 2026-10 的原话：
//     「你现在把改注音功能变成了双击触发，但是双击的时候只会打开再关闭
//       查词界面，无法改注音。」
//
// 这是浏览器的一条基础行为造成的：**双击会先派发两次 click，再派发 dblclick。**
//     click → 查词 open；click → 查词 close；dblclick → 改读音
// 用户看到的就是"开了又关，改注音没出来"。
//
// ⚠️ 这个检查必须**真的按顺序派发 click, click, dblclick**。
//    只派发一个 dblclick 是测不到这个 bug 的 —— 那是这个检查最容易写错的地方。
window.__QA.check.dblclickEditsNotLookup = async () => {
  await openReadingReader();
  // 先确保抽屉是关着的（前面几条检查可能开过它）
  const drawer = await import('/js/drawer.js');
  if (drawer.isLookupOpen()) { drawer.toggleLookup(); await sleep(300); }
  const wasOpen = drawer.isLookupOpen();

  const chip = $('.air-ja .jpr-w') || $('.jpr-w');
  if (!chip) return { ok: false, note: '页面上没有可点的词（.jpr-w）' };

  // ★ 真实的双击序列：click → click → dblclick
  chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(40);
  chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  chip.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));

  // 等过"延迟投递窗口"（250ms）+ 余量：如果延迟单击没被撤销，抽屉就会开
  await sleep(900);

  const openedAfter = drawer.isLookupOpen();
  const editorShown = !!$('.yomi-form');
  // 收拾：关掉编辑器和抽屉
  closeModal();
  await sleep(300);
  if (drawer.isLookupOpen()) { drawer.toggleLookup(); await sleep(250); }

  return {
    ok: editorShown && !openedAfter && !wasOpen,
    note: editorShown
      ? (openedAfter
        ? '★★ 双击确实打开了改读音，但查词抽屉也被打开了（延迟单击没被撤销）'
        : '★★ 双击只打开了改读音编辑器，查词抽屉全程没被打开（单击已被正确撤销）')
      : '双击之后没有出现改读音编辑器（.yomi-form）',
    extra: { editorShown, openedAfter, wasOpen },
  };
};

// ===========================================================================
// 9. ★★ 单击查词仍然要工作（撤销逻辑不许把单击一起干掉）
// ===========================================================================
window.__QA.check.singleClickStillLooksUp = async () => {
  await openReadingReader();
  const drawer = await import('/js/drawer.js');
  if (drawer.isLookupOpen()) { drawer.toggleLookup(); await sleep(300); }

  const chip = $('.air-ja .jpr-w') || $('.jpr-w');
  if (!chip) return { ok: false, note: '页面上没有可点的词（.jpr-w）' };

  chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  // 单击是**延迟投递**的（250ms），所以要等过去
  const opened = await until(() => drawer.isLookupOpen(), 3000);

  if (drawer.isLookupOpen()) { drawer.toggleLookup(); await sleep(250); }
  return {
    ok: opened,
    note: opened
      ? '★ 单击一个词仍然会打开查词抽屉（延迟了 250ms，但功能没丢）'
      : '单击一个词之后抽屉一直没打开 —— 撤销逻辑把单击也杀掉了',
  };
};

// ===========================================================================
// 10. ★★ 查词结果不许被"一大片留白"顶到下半段
// ===========================================================================
//
// 用户 2026-10 的原话：
//     「查词功能在输入文字后，下面显示的结果只会在页面的下半段出现，
//       上面有大幅度的留白。」
//
// 根因：搜索框被单独放进一个 `.pop-body`，而 `.pop-body` 是 `flex: 1`
//       （撑满剩余高度）—— 那个只装了一个输入框的容器把整个抽屉的高度吃光了。
//
// ⚠️ 断言用"输入框下边缘到第一条结果的间距"，而不是"某个具体像素值"：
//    前者是"有没有一大片留白"，后者是"好不好看"，后者不该被测试锁死。
window.__QA.check.drawerNoBigGap = async () => {
  const drawer = await import('/js/drawer.js');
  if (!drawer.isLookupOpen()) { drawer.toggleLookup(); }
  if (!await until(() => !!$('.pop input[type="search"]'), 4000)) {
    return { ok: false, note: '抽屉没打开，量不了排版' };
  }

  // 接管查词接口，喂固定数据，保证一定有结果可量
  const realFetch = window.fetch;
  window.fetch = (input, init) => {
    const u = typeof input === 'string' ? input : (input && input.url) || '';
    if (u.includes('/api/dict/lookup')) {
      return Promise.resolve(new Response(JSON.stringify({
        ok: true, query: 'かた', total: 3,
        exact: [
          { id: 'g1', term: '方', reading: 'かた', level: 'N5', zh: ['方向'] },
          { id: 'g2', term: '肩', reading: 'かた', level: 'N3', zh: ['肩膀'] },
          { id: 'g3', term: '過多', reading: 'かた', level: 'N1', zh: ['过多'] },
        ],
        byReading: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return realFetch(input, init);
  };

  try {
    const input = $('.pop input[type="search"]');
    input.value = '\u304B\u305F';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (!await until(() => $$('.pop-hit').length >= 3, 6000)) {
      return { ok: false, note: '等不到查词结果，量不了排版' };
    }
    await sleep(250);

    const pop = $('.pop');
    const popBox = pop.getBoundingClientRect();
    const inBox = input.getBoundingClientRect();
    const firstHit = $$('.pop-hit')[0].getBoundingClientRect();
    const gap = Math.round(firstHit.top - inBox.bottom);

    // 输入框必须落在抽屉的**上半部分**（留白 bug 里它其实还在上面，
    // 真正被挤走的是结果区 —— 所以关键是下面那个 gap）
    const inputInUpperHalf = inBox.top < popBox.top + popBox.height * 0.5;
    // 间距要小：原来那个 bug 下这里会是好几百像素
    const gapOk = gap >= 0 && gap < 80;
    // 结果区自己应该有真实高度（不是被压成一条缝）
    const resultsH = Math.round($('.pop-body').getBoundingClientRect().height);
    const resultsTall = resultsH > 200;

    return {
      ok: gapOk && resultsTall && inputInUpperHalf,
      note: `输入框底边到第一条结果间距 ${gap}px（应 <80）、`
        + `结果区高 ${resultsH}px（应 >200）、输入框在抽屉上半部=${inputInUpperHalf}`,
      extra: { gap, resultsH, inputInUpperHalf, popH: Math.round(popBox.height), inBoxTop: Math.round(inBox.top) },
    };
  } finally {
    window.fetch = realFetch;
    if (drawer.isLookupOpen()) { drawer.toggleLookup(); await sleep(200); }
  }
};

// ===========================================================================
// 11. ★ 页面上那些说明文字要和真实交互一致（用户报的第 2 个问题）
// ===========================================================================
//
// 用户 2026-10 的原话：
//     「"点句子空白处 → 讲这句的语法。"这句提示还在，
//       但是实际上现在已经不是这样查语法了，改一下。」
//
// 这条检查**故意去读页面上的提示文字**而不是读源码：
// 源码里写对、页面上没显示，用户照样被误导。
window.__QA.check.hintTextUpToDate = async () => {
  const results = [];
  // 三个页面在**没输入内容之前**是不渲染那句提示的（提示跟着阅读器一起出来）。
  // ⚠️ 第一版就是没管这一点，直接读 innerText，于是读到空页面、
  //    "没提到讲语法"直接判红 —— 那是**测试自己的 bug**。
  //    凡是断言"页面上有某段文字"，都必须先把那段文字所在的状态弄出来。
  //
  // ⚠️ 而且"开始"按钮的文案**两个页面不一样**（歌词页是「解析」，
  //    精读页是「开始精读」）。第一版只匹配「开始」，于是歌词页压根没进入
  //    阅读器，读到的还是输入表单 —— 又一次自己造的假红灯。
  const START_BTN = /\u5F00\u59CB|\u89E3\u6790/;   // 开始 / 解析

  const enterReader = async () => {
    const ta = $('#mount textarea');
    if (!ta) return;
    ta.value = QA_TEXT;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(250);
    const btn = $$('#mount button').find((b) => START_BTN.test(b.textContent || ''));
    if (btn) {
      btn.click();
      await until(() => !!$('.air-reader'), 15000);
      await sleep(500);
    }
  };

  // --- 歌词页 ---
  await goto('lyric');
  await sleep(700);
  await enterReader();
  const lyricText = ($('#mount') || {}).innerText || '';
  results.push({
    page: 'lyric',
    stale: /\u70B9\u53E5\u5B50\u7A7A\u767D\u5904/.test(lyricText) || /\u70B9\u4E00\u53E5\u7684\u7A7A\u767D\u5904/.test(lyricText),
    mentionsButton: /\u8BB2\u8BED\u6CD5/.test(lyricText),
    // 让"读到了空页面"这种情况一眼可见，而不是伪装成一条断言失败
    textLen: lyricText.length,
    hasReader: !!$('.air-reader'),
    sample: lyricText.length < 400 ? lyricText.replace(/\s+/g, ' ').slice(0, 200) : '',
  });

  // --- 精读页 ---
  await goto('reading');
  await sleep(700);
  await enterReader();
  const readText = ($('#mount') || {}).innerText || '';
  results.push({
    page: 'reading',
    stale: /\u70B9\u53E5\u5B50\u7A7A\u767D\u5904/.test(readText) || /\u70B9\u4E00\u53E5\u7684\u7A7A\u767D\u5904/.test(readText),
    mentionsButton: /\u8BB2\u8BED\u6CD5/.test(readText),
    textLen: readText.length,
    hasReader: !!$('.air-reader'),
    sample: readText.length < 400 ? readText.replace(/\s+/g, ' ').slice(0, 200) : '',
  });

  const anyStale = results.some((r) => r.stale);
  const noReader = results.filter((r) => !r.hasReader);
  const allMention = results.every((r) => r.mentionsButton);
  return {
    ok: !anyStale && allMention && noReader.length === 0,
    note: noReader.length
      ? `没能进入阅读器（${noReader.map((r) => r.page).join('、')}），这条检查没测到东西`
      : (anyStale
        ? `★★ 页面上还留着过时的提示「点句子空白处」（${results.filter((r) => r.stale).map((r) => r.page).join('、')}）`
        : (allMention
          ? '两个阅读页的提示都改成了「讲语法」按钮的说法，没有过时的「点句子空白处」'
          : `有页面没提到「讲语法」（${results.filter((r) => !r.mentionsButton).map((r) => r.page).join('、')}）`)),
    extra: results,
  };
};

// ===========================================================================
// 12. ★★ 改分词：入口真的在，点了真的开，界面上真的能合并，存完真的生效
// ===========================================================================
//
// 这一节的**分工**要说清楚，否则很容易写成"测了个空气"：
//   · 「合并/拆分算得对不对」在 `tools/check-segments.mjs` 里测（40 条，纯函数，秒级）；
//   · 「按钮在不在、点了开不开、界面能不能真的点出合并、存完页面变不变」
//     只有真浏览器知道 —— 也就是这一节。
//   两边都不可少：纯函数全绿但按钮没接线，用户还是用不了。
//
// ⚠️ 断言一律**按语义找元素**（`.seg-strip`、`.seg-chip`、`.seg-cut`），
//    不按文案找。文案会改，而且同一个词（"合并"）在按钮和说明里都会出现。
//
// ⚠️ 还有一条**血的教训**：这里用的例句必须真的被分词器切出想要的那个词。
//    分词器把「この人」切成了 **`こ` / `の` / `人`**（这是分词器的真实输出，
//    不是 `この` / `人`）——`check-segments.mjs` 里手写的 fixture 是后者，
//    拿 fixture 的形状去真页面上找 `この` 只会找到空气。
//    所以下面一律**先问页面上有什么**，再据此决定合并哪两个。

/**
 * 按语义打开"某一个词"的分词对话框。
 *
 * @param {(chip:Element, surface:string)=>boolean} pred 挑词的谓词（按 jpr-w 的 dataset）
 * @param {number} nth 要第几个符合条件的（默认 0）
 * @returns {{ok?:false, note:string}|{ok:true, surface:string}}
 */
async function openSegEditorFor(pred, nth = 0) {
  await openReadingReader();
  const chips = $$('.air-ja .jpr-w');
  if (!chips.length) return { ok: false, note: '页面上没有可点的词（.jpr-w）' };
  // ⚠️ 用 dataset.term（原始词形），**不要用 textContent** ——
  //    带振假名的词 textContent 会是「人ひと」，和分词器的输出对不上。
  const hits = chips.filter((c) => pred(c, c.dataset ? c.dataset.term : ''));
  const hit = hits[nth];
  if (!hit) {
    return {
      ok: false,
      note: `页面上没有第 ${nth + 1} 个符合条件的词（符合的有 ${hits.length} 个）。`
        + `这些是页面上的词：`
        + chips.map((c) => (c.dataset ? c.dataset.term : c.textContent)).slice(0, 16).join('・'),
    };
  }
  const surface = hit.dataset ? hit.dataset.term : hit.textContent;
  fire(hit, 'dblclick');
  if (!await until(() => !!$('.yomi-form'), 4000)) {
    return { ok: false, note: `双击「${surface}」之后没有出现改读音对话框` };
  }
  const segBtn = $$('.modal button, .dialog button, .ui-modal button')
    .find((b) => /改分词/.test(b.textContent || ''));
  if (!segBtn) return { ok: false, note: '改读音对话框里没有「改分词」按钮' };
  click(segBtn);
  if (!await until(() => !!$('.seg-strip'), 4000)) {
    return { ok: false, note: '点了「改分词」但没有出现分词界面（.seg-strip）' };
  }
  return { ok: true, surface };
}

window.__QA.check.segmentEntry = async () => {
  const r = await openSegEditorFor(() => true);
  if (r.ok === false) { closeModal(); return r; }
  const chips = $$('.seg-strip .seg-chip');
  const inner = $$('.seg-strip .seg-inner-btn');
  const cut = $$('.seg-strip .seg-cut');
  const readings = $$('.seg-reading-input');
  const warn = $$('.seg-hint .seg-warn').map((w) => w.innerText.trim());
  closeModal();
  await sleep(200);
  return {
    // 三个硬条件：至少一个方块、读音输入框数和方块数一致、
    // 「和程序原来的切法一样」的提醒要在（否则用户会以为已经改过了）
    ok: chips.length >= 1 && readings.length === chips.length
      && warn.some((t) => /和程序原来的切法一样/.test(t)),
    note: `分词界面：${chips.length} 个方块、${inner.length} 个"方块内切开"、`
      + `${cut.length} 个方块间"合"、${readings.length} 个读音输入框；`
      + `提醒=${JSON.stringify(warn)}`,
    extra: { chips: chips.length, inner: inner.length, cut: cut.length, readings: readings.length, warn },
  };
};

/**
 * 把阅读器恢复到"没有任何手改切法"的干净状态，并把页面上真实的词读回来。
 *
 * ⚠️ 两条都不能省：
 *   · 清空整张手改切法表（用 dbAll + dbDelete，不猜有哪些 key）；
 *   · **重建阅读器** —— 阅读器是"进页面时读一次手改表"的，
 *     复用旧的那个会仍然带着上一条记录切出来的形状。
 *
 * ⚠️ 还有一条更根本的纪律：**不许写死"分词器一定会切出某某"**。踩过两次：
 *   · 按 check-segments.mjs 的 fixture 以为会切出 `この`/`人`，
 *     真页面切的是 `こ`/`の`/`人`；
 *   · 以为「名前」会切成 `名`+`前`，真页面切的是 `名前` 一个词
 *     （分词器有词表，`名前` 是个词，**不该**被拆）。
 *   两次都不是功能坏了，是**测试凭空假设了分词器的输出**。
 *   所以这里一律先读回"页面现在切成了什么"，再据此决定要操作哪个词。
 *
 * @returns {Promise<{surfaces:string[], byTerm:Object<string, number[]>}>}
 */
async function snapReaderWithoutOverrides() {
  const jpDb = window.JP && window.JP.db;
  if (jpDb) {
    try {
      const rows = await jpDb.dbAll('segOverrides');
      for (const row of (rows || [])) {
        if (row && row.surface) await jpDb.dbDelete('segOverrides', row.surface);
      }
    } catch { /* 表还不存在之类，忽略 */ }
  }
  await resetReader();
  await openReadingReader();
  await sleep(300);
  const surfaces = $$('.air-ja .jpr-w').map((c) => (c.dataset ? c.dataset.term : c.textContent));
  const byTerm = {};
  surfaces.forEach((s, i) => { (byTerm[s] = byTerm[s] || []).push(i); });
  return { surfaces, byTerm };
}

window.__QA.check.segProbe = async () => {
  const snap = await snapReaderWithoutOverrides();
  const target = snap.surfaces[1];
  const r = await openSegEditorFor((c, s) => s === target);
  if (r.ok === false) { closeModal(); return { ok: false, note: r.note }; }
  const steps = [];
  steps.push({ step: 'open', chips: $$('.seg-strip .seg-chip-text').map((c) => c.textContent) });
  const includeBtn = $$('.seg-tool').find((b) => /包括/.test(b.textContent || ''));
  click(includeBtn);
  await sleep(250);
  steps.push({ step: 'include', chips: $$('.seg-strip .seg-chip-text').map((c) => c.textContent) });
  const joinBtn = $('.seg-strip .seg-cut');
  click(joinBtn);
  await sleep(250);
  steps.push({
    step: 'join',
    chips: $$('.seg-strip .seg-chip-text').map((c) => c.textContent),
    hint: (($('.seg-hint') || {}).innerText || '').replace(/\s+/g, ' ').slice(0, 80),
    innerBtns: $$('.seg-inner-btn').map((b) => b.textContent),
  });
  const dbg = ($('.seg-form') || {}).dataset ? $('.seg-form').dataset.segDebug : null;
  closeModal();
  delete window.__QA.check.segProbe;
  return { ok: false, note: JSON.stringify({ target, steps, dbg }).slice(0, 1800) };
};

// 用户实测报的：**手改完分词，页面上没看出合并**，但再打开那个词却提示
// 「这一串原文已经有一条手改切法」—— 说明记录**存进去了**，只是没生效。
//
// 这条检查走的路径和用户**完全一样**：
//   双击词 →「改分词」→「包括前面的 X」→「合」→「保存切法」
// 然后 `onSaved` 会把阅读器重新挂一遍 —— 关键就在这一步：
// **重新挂出来的那一份，必须已经是新切法。**
//
// ⚠️ 这条和 segmentAppliesAfterSave 是**不同的**检查，两条都要留：
//   · segmentAppliesAfterSave 是直接调 API 存一条记录，验"存了会不会生效"；
//   · 这一条是**点界面按钮**存，验"界面存的那条和请阅读器重挂这条链没有断"。
//   第一版只有前一条，所以"界面存进去的形状对不上阅读器重挂时的分词"
//   这种断链**测不出来** —— 而用户遇到的正是它。
window.__QA.check.segmentMergeVisibleAfterSave = async () => {
  const jpDb = window.JP && window.JP.db;
  if (!jpDb) return { ok: false, note: 'window.JP.db 不存在' };

  const snap = await snapReaderWithoutOverrides();
  if (snap.surfaces.length < 2) {
    return { ok: false, note: `页面上的词太少（${snap.surfaces.join('・')}），没法做合并检查` };
  }
  const prevSurface = snap.surfaces[0];
  const targetSurface = snap.surfaces[1];
  const mergedWord = prevSurface + targetSurface;

  const r = await openSegEditorFor((c, s) => s === targetSurface);
  if (r.ok === false) { closeModal(); return { ok: false, note: r.note }; }

  // 打开时它自己的切法（用来判断"重开时有没有认出已存的记录"）
  const openedCuts = $$('.seg-strip .seg-chip-text').map((c) => c.textContent);

  const includeBtn = $$('.seg-tool').find((b) => /包括/.test(b.textContent || ''));
  if (!includeBtn) { closeModal(); return { ok: false, note: '没有「包括…」按钮' }; }
  click(includeBtn);
  if (!await until(() => $$('.seg-strip .seg-chip-text').length === 2, 3000)) {
    closeModal();
    return { ok: false, note: `点「包括」之后没有变成 2 个盒子：${JSON.stringify($$('.seg-strip .seg-chip-text').map((c) => c.textContent))}` };
  }
  const joinBtn = $('.seg-strip .seg-cut');
  if (!joinBtn) { closeModal(); return { ok: false, note: '盒子之间没有「合」按钮' }; }
  click(joinBtn);
  if (!await until(() => {
    const t = $$('.seg-strip .seg-chip-text').map((c) => c.textContent);
    return t.length === 1 && t[0] === mergedWord;
  }, 3000)) {
    closeModal();
    return { ok: false, note: `点「合」之后没有变成「${mergedWord}」一个盒子` };
  }

  const saveBtn = $$('.modal button, .dialog button, .ui-modal button')
    .find((b) => /保存切法/.test(b.textContent || ''));
  if (!saveBtn) { closeModal(); return { ok: false, note: '没有「保存切法」按钮' }; }
  click(saveBtn);

  // ① 记录真的存进去了吗
  const stored = await until(async () => !!(await jpDb.dbGet('segOverrides', mergedWord)), 6000);
  const rec = stored ? await jpDb.dbGet('segOverrides', mergedWord) : null;

  // ② 不需要刷新、不需要重进页面，阅读器**自己**应该已经重挂成新切法。
  //    ⚠️ 用 until 轮询，不要 sleep 一个固定时间 —— 重挂是异步的，
  //       固定等待要么白等要么不够，而且失败时会误报成"功能坏了"。
  const surfacesNow = () => $$('.air-ja .jpr-w').map((c) => (c.dataset ? c.dataset.term : c.textContent));
  await until(() => surfacesNow().length > 0, 8000);
  await sleep(200);
  // ⚠️ 判"原来的词还在不在"时，只有**带 is-overridden 标记的那个新词**才是证据。
  //    直接看"页面上还有没有 `の`"是错的：`の` 可能在句子里**别的位置**合法存在
  //    （「君の名前」里那个 `の` 被合并掉了，但别处还有 `の`）。
  //    第一版就是这样误报成"像是追加而不是替换"。
  //    正确口径：合并出来的词**带 override 标记**，而它**左边紧邻**的那个词
  //    应该不再是原来的 `prevSurface`。
  const chipList = () => $$('.air-ja .jpr-w');
  const idxMerged = chipList().findIndex((c) => c.dataset && c.dataset.term === mergedWord);
  const mergedChip = idxMerged >= 0 ? chipList()[idxMerged] : null;
  const mergedMarked = !!(mergedChip && mergedChip.classList.contains('is-overridden'));
  const leftNeighbor = idxMerged > 0
    ? (chipList()[idxMerged - 1].dataset ? chipList()[idxMerged - 1].dataset.term : '') : null;
  const hasMerged = idxMerged >= 0;
  // 只有"紧邻左边还是 prevSurface 且那个词没被标成 override"才算没合并掉
  const stillSplit = hasMerged && leftNeighbor === prevSurface;
  const toasts = $$('.toast, .ui-toast, .toast-wrap > *').map((t) => (t.innerText || t.textContent || '').trim()).filter(Boolean);
  const errs = (window.__QA.errors || []).slice(-4);

  // ③ 再打开那个合并后的词：应该**认出**记录，并且盒子就是合并后的样子
  let reopenCuts = null;
  let reopenHasRecoverBtn = false;
  if (hasMerged) {
    const r2 = await openSegEditorFor((c, s) => s === mergedWord);
    if (r2.ok === false) {
      reopenCuts = `(打不开：${r2.note})`;
    } else {
      reopenCuts = $$('.seg-strip .seg-chip-text').map((c) => c.textContent);
      reopenHasRecoverBtn = $$('.modal button, .dialog button, .ui-modal button')
        .some((b) => /恢复程序切法/.test(b.textContent || ''));
      closeModal();
    }
  }
  // 收拾干净，别给后面的检查留记录
  if (rec) await jpDb.dbDelete('segOverrides', rec.surface);
  await resetReader();

  const note = stored
    ? (hasMerged
      ? (stillSplit
        ? `★★ 页面出现了「${mergedWord}」但「${prevSurface}」/「${targetSurface}」还在 —— 像是追加而不是替换`
        : `★★ 点界面按钮合并「${prevSurface}」+「${targetSurface}」→ 存进 segOverrides → `
          + `阅读器「自己」重挂成「${mergedWord}」；再打开这个字认出已存记录=${reopenHasRecoverBtn}、`
          + `盒子=[${(reopenCuts || []).join('・')}]`)
      : `存进去的记录形状=${rec ? JSON.stringify(rec.auto) : '?'}，`
        + `但阅读器重挂之后「看不到」「${mergedWord}」（页面上的词：`
        + `${surfacesNow().slice(0, 16).join('・')}；`
        + `提示=${JSON.stringify(toasts)}；最近异常=${JSON.stringify(errs)}）`
        + `—— 这就是用户报的"存了但没生效"`)
    : '点「保存切法」之后，segOverrides 里读不到这条记录';

  return {
    ok: stored && hasMerged && !stillSplit,
    note,
    extra: {
      prevSurface, targetSurface, mergedWord, openedCuts,
      stored, rec: rec ? { surface: rec.surface, auto: rec.auto, segments: rec.segments } : null,
      hasMerged, stillSplit, reopenCuts, reopenHasRecoverBtn,
      leftNeighbor, mergedMarked,
      surfacesNow: surfacesNow().slice(0, 20),
    },
  };
};

// 「合并」和「拆分」是**两个方向**，界面上也是两组不同的按钮，别搞混：
//   · 合并 = 把**相邻的词**并进来 —— `.seg-tool`（「← 和前面的「X」合并」）
//   · 拆分 = 在一个词**内部**加一个边界 —— `.seg-inner-btn` / `.seg-cut`
//
// ⚠️ 这里踩过一次，值得记住：`.seg-cut` 的文案是"在这里切开"，
//    它做的事是**把一个方块从中间切开**，**不是**"取消这个边界"。
//    所以拿它去测"合并"永远只会得到一条"这一段只剩一个字，切不开了"的提示 ——
//    那不是 bug，是我把两个动作搞混了。**按钮的文案就是它的语义，照着读。**
//
// ⚠️ 合并只在**文本层面**成立：记录同时存 `auto`（原来怎么切的）和
//    `segments`（改成什么），两者拼出来的文字必须一字不差。
window.__QA.check.segmentMergeWorks = async () => {
  const jpDb = window.JP && window.JP.db;
  if (!jpDb) return { ok: false, note: 'window.JP.db 不存在' };

  const snap = await snapReaderWithoutOverrides();
  // 挑一个"有前一个词"的词，从它出发点「和前面的『X』合并」。
  // 用最后一个词不行（它没有后一个），用第一个词不行（没有前一个）——
  // 所以挑第 2 个词。
  if (snap.surfaces.length < 2) {
    return { ok: false, note: `页面上的词太少（${snap.surfaces.join('・')}），没法做合并检查` };
  }
  const targetSurface = snap.surfaces[1];
  const prevSurface = snap.surfaces[0];
  const mergedWord = prevSurface + targetSurface;
  const surfacesBefore = snap.surfaces.slice();

  const r = await openSegEditorFor((c, s) => s === targetSurface);
  if (r.ok === false) { closeModal(); return { ok: false, note: r.note }; }

  // 第一步：「包括前面的「X」」—— 把前一个词拉进这次编辑的范围。
  //
  // ⚠️ 这一步**不会**把两个词并起来（盒子从 1 个变成 2 个）。文案也因此
  //    从"和前面的 X 合并"改成了"包括前面的 X" —— 上一版那个措辞
  //    让人（包括我自己写自检的时候）以为点一下就并好了，白查了一轮。
  const includeBtn = $$('.seg-tool').find((b) => /包括/.test(b.textContent || ''));
  if (!includeBtn) {
    closeModal();
    return {
      ok: false,
      note: `分词界面上没有「包括…」按钮（.seg-tool），只有：`
        + JSON.stringify($$('.seg-tool').map((b) => b.textContent)),
    };
  }
  const includeBtnText = includeBtn.textContent.trim();
  click(includeBtn);
  const twoBoxes = await until(() => $$('.seg-strip .seg-chip-text').length === 2, 3000);
  if (!twoBoxes) {
    closeModal();
    return { ok: false, note: `点了「${includeBtnText}」之后应该有 2 个盒子，`
      + `现在是 ${JSON.stringify($$('.seg-strip .seg-chip-text').map((c) => c.textContent))}` };
  }

  // 第二步：点两个盒子之间的「合」—— 这才是真正的合并
  const joinBtn = $('.seg-strip .seg-cut');
  if (!joinBtn) {
    closeModal();
    return { ok: false, note: '盒子之间没有「合」按钮（.seg-cut），没法合并' };
  }
  const joinTitle = joinBtn.getAttribute('title') || '';
  click(joinBtn);

  // 合并成功 = 只剩**一个**盒子，且它的文字正好是 `前一个词 + 这个词`
  //
  // ⚠️ 判定条件里**每次都重新查一次节点**（`$$(...)`），不许把查询结果
  //    存在变量里反复用。踩过两次，都是"看起来应该对"的那种：
  //    界面每次重画都造新节点，抓着旧引用去读，读到的是**已经脱离文档的孤儿**
  //    —— 它的文字停在重画之前的值，于是断言永远不成立、还不报错。
  const chipsNow = () => $$('.seg-strip .seg-chip-text').map((c) => c.textContent);
  const mergedOk = await until(() => {
    const texts = chipsNow();
    return texts.length === 1 && texts[0] === mergedWord;
  }, 3000);
  const mergedText = mergedOk ? chipsNow()[0] : null;
  if (!mergedOk) {
    closeModal();
    return { ok: false, note: `点了「${includeBtnText}」再点「${joinTitle || '合'}」之后`
      + `没有变成「${mergedWord}」一个盒子（现在是 ${JSON.stringify(chipsNow())}）` };
  }
  // 合并出来的那一串必须和新切法**文字一致**（界面上天然成立，但存库前要挡住坏数据）
  const hintText = ($('.seg-hint') || {}).innerText || '';
  if (!hintText.includes(`原文：${mergedWord}`)) {
    closeModal();
    return { ok: false, note: `合并后提示里的"原文"不是「${mergedWord}」：${hintText.replace(/\s+/g, ' ').slice(0, 120)}` };
  }

  const saveBtn = $$('.modal button, .dialog button, .ui-modal button')
    .find((b) => /保存切法/.test(b.textContent || ''));
  if (!saveBtn) { closeModal(); return { ok: false, note: '没有「保存切法」按钮' }; }
  click(saveBtn);
  const stored = await until(async () => !!(await jpDb.dbGet('segOverrides', mergedWord)), 6000);
  const rec = stored ? await jpDb.dbGet('segOverrides', mergedWord) : null;
  closeModal();
  await sleep(300);

  const shapeOk = !!rec && Array.isArray(rec.segments) && rec.segments.length === 1
    && Array.isArray(rec.auto) && rec.auto.join('') === mergedWord
    && rec.segments.map((x) => x.t).join('') === mergedWord;

  return {
    ok: mergedOk && stored && shapeOk,
    note: stored
      ? `★ 在真界面上先点「${includeBtnText}」把「${prevSurface}」拉进来，`
        + `再点盒子之间的「合」把两个盒子并成「${mergedText}」，`
        + `segOverrides 里的记录形状正确=${shapeOk}`
        + `（auto=${JSON.stringify(rec && rec.auto)}）；页面原来这些词：`
        + `${surfacesBefore.slice(0, 16).join('・')}`
      : '★ 点了保存，但 segOverrides 里读不到这条记录',
    extra: {
      prevSurface, targetSurface, mergedWord, mergedText, includeBtnText,
      surfacesBefore: surfacesBefore.slice(0, 20),
      rec: rec ? { surface: rec.surface, auto: rec.auto, segments: rec.segments } : null,
    },
  };
};

// 「拆分」方向：在词**内部**加一个边界。
//
// 这一步只在界面上验——"切出来的两段对不对"在 check-segments.mjs 里逐条断言过，
// 这里只证明"那个按钮真的能把方块切开，并且切开的状态能存下去"。
window.__QA.check.segmentSplitWorks = async () => {
  const jpDb = window.JP && window.JP.db;
  if (!jpDb) return { ok: false, note: 'window.JP.db 不存在' };

  const snap = await snapReaderWithoutOverrides();
  const multi = snap.surfaces.find((s) => s && s.length >= 2);
  if (!multi) {
    return { ok: false, note: `页面上没有多字词，没法测"切开"。这些是页面上的词：${snap.surfaces.join('・')}` };
  }

  const r = await openSegEditorFor((c, s) => s === multi);
  if (r.ok === false) { closeModal(); return { ok: false, note: r.note }; }

  const innerBtn = $('.seg-strip .seg-inner-btn');
  if (!innerBtn) {
    const dbg = ($('.seg-strip') || {}).outerHTML || '';
    closeModal();
    return { ok: false, note: `「${multi}」的分词界面上没有"方块内切开"按钮（.seg-inner-btn）。`
      + `HTML=${dbg.slice(0, 400)}` };
  }
  const innerText = innerBtn.textContent.trim();
  click(innerBtn);
  const splitOk = await until(() => $$('.seg-strip .seg-chip').length >= 2, 3000);
  const parts = $$('.seg-strip .seg-chip-text').map((c) => c.textContent);
  if (!splitOk) {
    closeModal();
    return { ok: false, note: `点了「${innerText}」但方块没有变成两个（还是 ${$$('.seg-strip .seg-chip').length} 个）` };
  }
  // 切开之后拼起来必须还是原来那个词（切法只改"怎么切"，不改文字）
  if (parts.join('') !== multi) {
    closeModal();
    return { ok: false, note: `切开成 ${parts.join('+')}，拼起来是「${parts.join('')}」，不是「${multi}」` };
  }

  const saveBtn = $$('.modal button, .dialog button, .ui-modal button')
    .find((b) => /保存切法/.test(b.textContent || ''));
  if (!saveBtn) { closeModal(); return { ok: false, note: '没有「保存切法」按钮' }; }
  click(saveBtn);
  const stored = await until(async () => !!(await jpDb.dbGet('segOverrides', multi)), 6000);
  const rec = stored ? await jpDb.dbGet('segOverrides', multi) : null;
  closeModal();
  await sleep(300);

  const shapeOk = !!rec && Array.isArray(rec.auto) && rec.auto.join('') === multi
    && Array.isArray(rec.segments) && rec.segments.length >= 2
    && rec.segments.map((x) => x.t).join('') === multi;

  return {
    ok: splitOk && stored && shapeOk,
    note: stored
      ? `★ 在真界面上点了「${innerText}」，把「${multi}」切成 ${parts.join('+')}，`
        + `存进 segOverrides 的记录形状正确=${shapeOk}`
        + `（auto=${JSON.stringify(rec && rec.auto)}，`
        + `segments=${JSON.stringify(rec && rec.segments.map((x) => x.t))}）`
      : '★ 点了保存，但 segOverrides 里读不到这条记录',
    extra: { multi, parts, rec: rec ? { surface: rec.surface, auto: rec.auto, segments: rec.segments } : null },
  };
};

// 存完之后**页面必须真的变** —— 这条最容易漏：
// 数据存对了，但页面没重画，用户看到的是旧切法，会以为"保存失败"。
//
// 同样**不假设分词器的输出**：先读回页面上真实的词，从中挑相邻的一对去合并，
// 再要求页面按新切法重画。第一版写死了 `名`+`前`→`名前`，
// 而分词器本来就切出 `名前` 一个词（词表里有）—— 那是测试自己的假设错了。
window.__QA.check.segmentAppliesAfterSave = async () => {
  const jpDb = window.JP && window.JP.db;

  const snap = await snapReaderWithoutOverrides();
  // 找一对相邻的、且**各只出现一次**的词 —— 这样"新词在 + 旧词没了"
  // 两条断言都不会被别处的同形词搅浑。
  const count = (s) => snap.surfaces.filter((x) => x === s).length;
  let pick = -1;
  for (let i = 0; i + 1 < snap.surfaces.length; i++) {
    const a = snap.surfaces[i];
    const b = snap.surfaces[i + 1];
    if (a && b && count(a) === 1 && count(b) === 1) { pick = i; break; }
  }
  if (pick < 0) {
    return {
      ok: false,
      note: `找不到一对各只出现一次且相邻的词，没法干净地断言。页面上的词：${snap.surfaces.join('・')}`,
    };
  }
  const a = snap.surfaces[pick];
  const b = snap.surfaces[pick + 1];
  const merged = a + b;

  const seg = await import('/js/segments.js');
  // ⚠️ 这里**故意填上读音**。原因是这条检查要顺带验"合并出来的词带振假名"：
  //    不带读音的记录是合法的（程序**不猜**读音），但没读音就**没有**振假名可显示，
  //    "必须有 ruby"这个断言就变成了在测一件不可能成立的事。
  //    第一版就是 `r: ''` 然后断言 `mergedHasRuby`，白红了一轮。
  //    要测"补振假名"，就**必须**给它一个读音走 `/api/yomi`。
  //    ⚠️ 而这个读音必须是**真的**：写成假的（比如 `xxxxx`）接口会返回
  //    `ok:false`，一样没有 ruby —— 又变成在测空气。这里合并结果是「いい天気」，
  //    读音就是「いいてんき」。
  const mergedReading = 'いいてんき';
  await seg.saveSegOverride(merged, [{ t: merged, r: mergedReading }], [a, b]);

  await resetReader();
  await openReadingReader();
  await sleep(600);

  const surfaces = $$('.air-ja .jpr-w').map((c) => (c.dataset ? c.dataset.term : c.textContent));
  const hasMerged = surfaces.includes(merged);
  // ⚠️ 必须同时断言"原来的两个词**不见了**" —— 只断言"出现了新词"，
  //    一个坏实现（把新词**追加**上去、旧的没删）也能通过。
  const stillSplit = surfaces.includes(a) || surfaces.includes(b);
  // 合并出来的词还要**带上注音**：不带的话它旁边程序切的词都有注音，
  // 用户会以为"这个词查不到"（这一条对应 reading.js/lyric.js 里的 ensureRuby）。
  const mergedChip = $$('.air-ja .jpr-w').find((c) => c.dataset && c.dataset.term === merged);
  const mergedHasRuby = !!(mergedChip && mergedChip.querySelector('ruby, rt'));
  const mergedMarked = !!(mergedChip && mergedChip.classList.contains('is-overridden'));

  await jpDb.dbDelete('segOverrides', merged);
  await resetReader();

  return {
    ok: hasMerged && !stillSplit && mergedHasRuby && mergedMarked,
    note: hasMerged
      ? (stillSplit
        ? `★★ 页面上出现了合并后的词「${merged}」，但原来的词「还在」—— 像是追加而不是替换`
        : `★★ 存了切法之后页面真的按新切法重画了（\`${a}\`+\`${b}\` 合并成 \`${merged}\`，`
          + `原来的词已不在），合并出来的词带注音=${mergedHasRuby}、`
          + `带"是你自己切的"标记=${mergedMarked}`)
      : `存了切法（${a}+${b} → ${merged}），但页面上找不到合并后的词。`
        + `当前这些词：${surfaces.slice(0, 16).join('・')}`,
    extra: {
      a, b, merged, surfaces: surfaces.slice(0, 20), hasMerged, stillSplit,
      mergedHasRuby, mergedMarked,
      mergedChipHTML: mergedChip ? mergedChip.outerHTML.slice(0, 200) : null,
    },
  };
};

// ---------------------------------------------------------------------------
// 共用：把精读页真的跑起来（填文本 → 点开始精读 → 等两栏出现）
// ---------------------------------------------------------------------------
async function openReadingReader() {
  if ($('.air-reader')) return true;
  await goto('reading');
  const ta = $('#mount textarea');
  if (!ta) return false;
  // ⚠️ 这段文本里必须有 `この` + `人` **两个独立的词** ——
  //    第 12 节的"改分词"检查要在它们之间取消一个边界（合并成 `この人`）。
  //    第一版沿用了旧的例句（君の名前は。今日はいい天気ですね。），
  //    里面根本没有 `この`，于是分词检查只能报"页面上没有符合条件的词"——
  //    那不是功能坏了，是**测试用的文本不满足测试自己的前提**。
  ta.value = '\u541B\u306E\u540D\u524D\u306F\u3002\u4ECA\u65E5\u306F\u3044\u3044\u5929\u6C17\u3067\u3059\u306D\u3002'
    + '\u3053\u306E\u4EBA\u306F\u5B66\u751F\u3067\u3059\u3002';
  const btn = $$('#mount button').find((b) => /\u5F00\u59CB\u7CBE\u8BFB/.test(b.textContent));
  if (btn) click(btn);
  return until(() => !!$('.air-reader'), 20000);
}

// ---------------------------------------------------------------------------
// 收尾：告诉外面的脚本"页面这边准备好了"
// ---------------------------------------------------------------------------
if (window.__QA.status === 'booting') {
  window.__QA.status = 'ready';
  document.title = 'QA 就绪';
}
