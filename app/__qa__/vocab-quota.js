/**
 * `tools/qa-vocab-quota.mjs` 的载荷：在**真浏览器**里验证「每日复习上限」。
 *
 * ────────────────────────────────────────────────────────────────────
 * 这个 QA 存在的理由（就是当初那个 bug）
 * ────────────────────────────────────────────────────────────────────
 * `srs.js` 的纯函数（countsAgainstDailyReview / reviewQuotaLeft /
 * capByDailyReview）已经有单测了，工具 `test-session.mjs` 也验过 buildPlan 的
 * 返回值。但它们都证明不了**界面有没有把两个数字都写出来**。
 *
 * 修之前的现象：按钮写「开始复习（537 个到期）」，点进去只给 40 题，
 * 而且页面上任何地方都不说还有 497 个 —— 用户以为程序吃掉了他的词。
 * 所以这里要验的是：**「本轮多少」和「另有多个顺延」必须同时出现在屏幕上，
 * 而且是两个不同的数**；点下去之后练习页显示的额度真的是 40。
 *
 * ────────────────────────────────────────────────────────────────────
 * 约定：页面侧只"观察"，node 侧只"判定"
 * ────────────────────────────────────────────────────────────────────
 * 每个断言做成一个返回 `{ok, note, extra}` 的函数，挂在下面这个**局部** `checks`
 * 对象上（它同时被挂成 `window.__QA.check`），由外面的 node 脚本逐个调用
 * （同 qa-harness 的约定）。
 *
 * ⚠️ 为什么用局部对象而不是到处写 `window.__QA.check.xxx = ...`：
 *    这一版最初就是那么写的，结果 `window.__QA` 上那个属性名对不上（写成了
 *    `QA.check` 而实际挂在 `QA.checks`），于是**一条断言都没登记上**，
 *    现象只是"页面里没有登记这个检查"，node 侧完全看不出真正原因。
 *    改成局部对象后，登记这件事不再依赖任何全局查找，也就没得写错了。
 *
 * ⚠️ 每条检查都必须**自己完成所需的渲染和等待**，不能依赖调用顺序 ——
 *    靠顺序的测试在有人插一条新断言之后就会莫名其妙地红。
 *    这里多数检查都要先切回「今日」页并等额度行出现，`showToday()` 就是做这个的。
 *
 * ⚠️ 凡是**从真实渲染结果读出来的数字**，一律先读到变量、再把实际值放进
 *    失败信息里。只写"应该是 40"的失败信息，红了也不知道当时到底是什么。
 */
import * as db from '/js/db.js';
import vocabView, { goVocabTab } from '/js/views/vocab.js';

// 断言登记表。**先建这个对象、再把它同时挂到 __QA 上** ——
// 页面里所有断言都往 `checks` 这个局部对象上挂，不依赖任何全局查找。
const checks = {};
const QA = {
  status: 'starting', errors: [], steps: [],
  check: checks,
  consoleErrors: [],
  // 预置数据的事实（断言拿它当对照，而不是把数字硬编码在 node 侧）
  facts: {},
};
window.__QA = QA;

// 收所有 window 级异常 —— 「没有报错」本身就是一条要断言的事实
window.addEventListener('error', (e) => {
  QA.errors.push(`window.error: ${e.message || ''} @ ${e.filename || ''}:${e.lineno || ''}`);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  QA.errors.push('unhandledrejection: ' + ((r && r.message) || String(r)));
});

// 收 console.error / console.warn（headless 里没人看控制台，必须主动收）
for (const level of ['error', 'warn']) {
  const orig = console[level].bind(console);
  console[level] = (...a) => {
    QA.consoleErrors.push(level + ': ' + a.map((x) => {
      try { return typeof x === 'string' ? x : JSON.stringify(x); } catch { return String(x); }
    }).join(' '));
    orig(...a);
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等一个条件成立；超时返回 false（**不抛错** —— 由断言那边去报"没等到"） */
async function until(fn, ms = 15000, step = 200) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = await fn(); } catch { v = false; }
    if (v) return true;
    if (Date.now() - t0 > ms) return false;
    await sleep(step);
  }
}

const mount = () => document.getElementById('mount');

/** 等挂载点里出现某个选择器 */
async function waitFor(sel, ms = 15000) {
  const got = await until(() => mount().querySelector(sel), ms);
  return got ? mount().querySelector(sel) : null;
}

/**
 * 渲染「背单词」视图到本页的挂载点。
 *
 * ⚠️ 为什么必须**手动**调 view.render，而不是 app.js 的 router：
 *    本页不是应用启动页（没有 nav/foot、也不 load app.js），所以 router 的
 *    hashchange 监听根本不存在 —— 只改 hash 是**什么都不会发生**的。
 *    真浏览器 QA 的常见坑：以为"设了 hash 就等于页面渲染了"。
 *    第一版就是这么写的，现象是 `#/vocab` 已经设好、mount 却是空的。
 *
 * ⚠️ 但也不能只用 goVocabTab：它内部走的是 `renderShell(mountedRoot)`，
 *    而 `mountedRoot` 只有 `view.render()` 被调过才会被赋值 —— 顺序必须是
 *    「先 render 一次（建好视图状态）→ 之后才轮到 goVocabTab 切页签」。
 */
async function ensureRendered() {
  const m = mount();
  if (m.querySelector('.tabs')) return;      // 已经渲染过了
  // ⚠️ 只设 hash 是**没有用**的（第一版就是这么写的，现象是 `#/vocab` 设好了、
  //    mount 里却一个节点都没有）：本页不是应用启动页，没有 load app.js，
  //    所以 router 的 hashchange 监听根本不存在 —— 改 hash 什么都不会发生。
  //    必须**手动**调 view.render()。
  await vocabView.render(m, {});
  await until(() => m.querySelector('.tabs'), 60000);
  QA.steps.push('今日页渲染完成');
}

/** 切回「今日」页签并等额度行渲染出来（每次都重新读一次设置，见下面注释） */
async function showToday() {
  await ensureRendered();

  // 从练习页切回来：点「今日」页签。视图内部会**重新渲染**，
  // 于是拿到的是最新设置/最新数据（这正是 unlimitedMode 需要的行为）。
  const tab = [...mount().querySelectorAll('.tab')].find((b) => /今日/.test(b.textContent));
  if (tab && !tab.classList.contains('active')) {
    tab.click();
  } else {
    // ⚠️ 已经在「今日」页时**必须主动重画**。
    //    这个坑很隐蔽：调用方刚刚改了 dailyReviewLimit，而页面上还是旧文案；
    //    不重画的话断言读到的是"改之前"的那个数字（第一版就卡在这里）。
    //    用 goVocabTab('today') 而不是直接调 renderShell —— 它内部走
    //    `renderShell(mountedRoot)`，而 mountedRoot 已经在 ensureRendered 里建好了。
    goVocabTab('today');
  }

  const lines = await until(
    () => mount().querySelectorAll('.quota-line').length > 0, 30000) 
    ? [...mount().querySelectorAll('.quota-line')] : [];
  return lines;
}

/** 所有额度行拼起来的文本（这里只有两行：每日新词 / 每日复习） */
const quotaText = () => [...mount().querySelectorAll('.quota-line')].map((e) => e.textContent).join(' ｜ ');

/** 含「每日复习」的那一行（返回节点与文本） */
function reviewQuotaLine() {
  const line = [...mount().querySelectorAll('.quota-line')].find((e) => /每日复习/.test(e.textContent));
  return { el: line || null, text: line ? line.textContent : '' };
}

/** 今日页那个主按钮：文案含「复习 / 到期」并且不是「修改 / 学新词 / 练错题」 */
function reviewMainButton() {
  const btns = [...mount().querySelectorAll('.btn-row button')];
  return btns.find((b) => /复习|到期/.test(b.textContent) && !/修改|新词|错题/.test(b.textContent)) || null;
}

/** 练习页的进度条文本：practice-count 有两种（题号 / 正确率 + 今日额度） */
function practiceBar() {
  const ps = [...mount().querySelectorAll('.practice-count')].map((e) => e.textContent);
  return { texts: ps, all: ps.join('　') };
}

/**
 * 从进度条文本里取"本场总共几题"。
 *
 * ⚠️ 兼容两种写法（第一版只写了前一种，结果"上限 10"那条断言取不到总数而假红）：
 *   · `第 1 / 40 题` —— 视图在**有光标位置**时用的写法
 *   · `0/40`         —— 「已答对/总数」那个计数器的写法（未答时是 0/10）
 * 取的是"斜杠右边那个数"，两种都能对上。
 */
function sessionTotalFrom(text) {
  const s = String(text);
  // 先试"第 N / M 题"（有的视图会这么写），再试开头的"答对/总数"计数器。
  // ⚠️ 第二个用 `^\s*(\d+)\s*\/\s*(\d+)`（**锚在开头**）：
  //    practice-count 拼起来是「0/10　正确率 0%　今日额度 0/10」，
  //    不锚开头的话 `\d+/\d+` 会先匹配到「今日额度 0/10」那一处，
  //    数字碰巧一样所以看不出来 —— 但上限一改就不一样了，属于埋伏的错。
  const m = s.match(/\/\s*(\d+)\s*题/) || s.match(/^\s*\d+\s*\/\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

/** 从「今日额度 0/40」里取额度上限（本来一场也不超过 40 题，所以这个数才是关键） */
function quotaLimitFrom(text) {
  const m = String(text).match(/今日额度\s*\d+\s*\/\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

/** 从「另有 80 个顺延到明天」里取顺延数 */
function deferredFrom(text) {
  const m = String(text).match(/另有\s*(\d+)\s*个顺延/);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// 预置数据：120 个到期复习（超过默认上限 40，才能验出"顺延"）
// ---------------------------------------------------------------------------
//
// 为什么是 120 而不是刚好 41：要留出"顺延数明显大于 0"的余量，
// 这样按钮上的两个数字差得远，正则抓错了会立刻看出来。
const SEED_N = 120;
// 上限：**直接读默认值常量**，不手写数字。
// 原来这里写的是 40（当时的默认值），默认值改成 50 之后，手写的 40 仍然能用
// （40 落在范围内），但断言就变成了"在测一个非默认的配置"，
// 而这条 QA 想验的恰恰是"用户不改设置时会怎样"。所以改成读常量。
const LIMIT = db.DEFAULT_SETTINGS.dailyReviewLimit;

// 词形（都是常见初级词）+ 读音 + 中文
const TERMS = [
  ['私', 'わたし', '我'], ['人', 'ひと', '人'], ['学生', 'がくせい', '学生'],
  ['先生', 'せんせい', '老师'], ['学校', 'がっこう', '学校'], ['日本', 'にほん', '日本'],
  ['水', 'みず', '水'], ['本', 'ほん', '书'], ['猫', 'ねこ', '猫'], ['犬', 'いぬ', '狗'],
  ['山', 'やま', '山'], ['川', 'かわ', '河'], ['空', 'そら', '天空'], ['海', 'うみ', '海'],
  ['朝', 'あさ', '早上'], ['夜', 'よる', '夜晚'], ['花', 'はな', '花'], ['木', 'き', '树'],
  ['電車', 'でんしゃ', '电车'], ['駅', 'えき', '车站'], ['友達', 'ともだち', '朋友'],
  ['家族', 'かぞく', '家人'], ['時間', 'じかん', '时间'], ['天気', 'てんき', '天气'],
];

const seed = (async () => {
  const now = Date.now();
  const words = [];
  const cards = [];
  for (let i = 0; i < SEED_N; i++) {
    const id = 'qa-review:' + i;
    const t = TERMS[i % TERMS.length];
    words.push({
      id,
      term: t[0],
      reading: t[1],
      forms: [],
      kanas: [],
      level: 'N5',
      zh: [t[2]],
      pos: ['名词'],
      ex: [],
      source: 'manual',
      sourceRef: null,
      tags: ['qa-due'],
      createdAt: now - (SEED_N - i) * 1000,
      updatedAt: now,
    });
    cards.push({
      wordId: id,
      state: 'review',
      step: 0,
      ease: 2.5,
      interval: 5,
      // 到期设在过去：逾期越久越靠前（pickDue 的优先级），所以按 i 递减
      due: now - (SEED_N - i) * 60 * 1000,
      lapses: i % 7,
      reps: 5,
      lastGrade: 'good',
      lastAt: now - (SEED_N - i) * 86400000,
      firstAt: now - 30 * 86400000,
      introducedAt: now - 30 * 86400000,
    });
  }
  await db.dbPutMany('words', words);
  await db.dbPutMany('srs', cards);
  await db.setSetting('dailyReviewLimit', LIMIT);

  const allCards = await db.dbAll('srs');
  const due = allCards.filter((c) => c && c.state === 'review' && (c.due || 0) <= now);
  QA.facts = { seeded: SEED_N, limit: LIMIT, dueCards: due.length };
  QA.steps.push(`seed 完成：${words.length} 个词 / ${cards.length} 张到期卡`);
  // 预置完成就算"页面可以开工了"。
  // ⚠️ 这里**不能**等渲染：首次进页面要建内置词库缓存（上万条），
  //    骨架只等 25 秒就会放弃，于是"页面没启动完成"这条会假红。
  //    渲染交给各条检查自己按需触发（showToday → ensureRendered）。
  QA.status = 'ready';
})();

seed.catch((e) => {
  QA.status = 'threw';
  QA.errors.push('QA 载荷（seed/render）抛错: ' + ((e && e.stack) || String(e)));
});

// ---------------------------------------------------------------------------
// 断言（由 node 侧逐个调用）
// ---------------------------------------------------------------------------

/** [1] 预置的到期卡真的在库里、真的是"已到期 + review 状态" */
checks.seedDueCards = async () => {
  await seed;
  const f = QA.facts;
  const now = Date.now();
  const cards = await db.dbAll('srs');
  const mine = cards.filter((c) => c && String(c.wordId).startsWith('qa-review:'));
  const overdue = mine.filter((c) => c.state === 'review' && (c.due || 0) < now);
  const words = (await db.dbAll('words')).filter((w) => String(w.id).startsWith('qa-review:'));
  const extra = { seeded: f.seeded, words: words.length, cards: mine.length, overdue: overdue.length };
  const ok = words.length >= 100 && mine.length >= 100 && overdue.length >= 100
    && overdue.length > f.limit;
  return {
    ok,
    note: `预置 ${f.seeded} 个词 / ${mine.length} 张卡，其中已到期 ${overdue.length} 张`
      + `（要求 ≥100 张且多于上限 ${f.limit}）`,
    extra,
  };
};

/** [2] 额度行：含「每日复习」的那一行必须同时写出"今天还剩"和"顺延到明天" */
checks.quotaLineShowsBoth = async () => {
  await seed;
  const lines = await showToday();
  if (!lines.length) return { ok: false, note: '今日页没有渲染出任何 .quota-line' };
  const { text } = reviewQuotaLine();
  if (!text) {
    return { ok: false, note: '额度行里找不到含「每日复习」的那一行', extra: { all: quotaText() } };
  }
  const left = text.match(/今天还剩\s*(\d+)\s*个/);
  const defer = text.match(/另有\s*(\d+)\s*个到期[^）]*顺延/);
  const ok = /每日复习/.test(text) && !!left && !!defer;
  return {
    ok,
    note: ok
      ? `额度行：${text}`
      : `额度行没有同时写出"今天还剩"和"顺延到明天" —— 实际是「${text}」`
        + `（抓到 今天还剩=${left ? left[1] : '无'} / 顺延=${defer ? defer[1] : '无'}）`,
    extra: { text, left: left ? Number(left[1]) : null, deferred: defer ? Number(defer[1]) : null },
  };
};

/** [3] 主按钮：「本轮 N 个」和「另有 M 个顺延」必须同时出现，且 N ≠ M */
checks.buttonShowsBothNumbers = async () => {
  await seed;
  await showToday();
  const btn = reviewMainButton();
  if (!btn) {
    return {
      ok: false,
      note: '今日页找不到复习主按钮',
      extra: { buttons: [...mount().querySelectorAll('.btn-row button')].map((b) => b.textContent) },
    };
  }
  const text = btn.textContent.trim();
  const round = text.match(/本轮\s*(\d+)\s*个/);
  const defer = text.match(/另有\s*(\d+)\s*个顺延/);
  const nRound = round ? Number(round[1]) : null;
  const nDefer = defer ? Number(defer[1]) : null;
  const ok = !!round && !!defer && nRound !== nDefer && nRound > 0 && nDefer > 0;
  return {
    ok,
    note: `按钮文案「${text}」→ 本轮=${nRound === null ? '没抓到' : nRound}，`
      + `另有顺延=${nDefer === null ? '没抓到' : nDefer}`
      + (ok ? '（两个数不同，符合预期）'
        : '（要求两个数都出现且不相等 —— 修之前它只写一个数）'),
    extra: { text, round: nRound, deferred: nDefer },
  };
};

/** [4] 真的点一下按钮：进练习页，额度真的生效（这一场 ≤ 当天额度，不是 120） */
checks.sessionHonoursQuota = async () => {
  await seed;
  await showToday();
  const btn = reviewMainButton();
  if (!btn) return { ok: false, note: '今日页找不到复习主按钮，点不了' };
  btn.click();
  const bar = await waitFor('.practice-bar', 20000);
  if (!bar) {
    return {
      ok: false,
      note: '点了「开始复习」之后没有出现练习页（.practice-bar）',
      extra: { pageText: mount().innerText.slice(0, 300) },
    };
  }
  // 等 practice-count 里的额度信息画出来
  await until(() => quotaLimitFrom(practiceBar().all) !== null, 5000);
  const pb = practiceBar();
  const total = sessionTotalFrom(pb.all);
  const limit = quotaLimitFrom(pb.all);
  const deferred = deferredFrom(pb.all);
  const facts = QA.facts;
  const ok = limit === facts.limit && limit !== facts.seeded
    && deferred === facts.seeded - facts.limit
    && (total === null || total === limit);
  return {
    ok,
    note: `练习页进度条「${pb.all}」→ 本场题数=${total === null ? '没显示总数' : total}，`
      + `今日额度=${limit}，顺延=${deferred}（预置到期 ${facts.seeded} 个、上限 ${facts.limit}）`
      + (ok ? '（额度真的生效了，不是把 120 个一次给完）'
        : ' —— 要求额度=上限、顺延=到期总数-上限，且本场不超过额度；'
          + '若额度等于到期总数，说明点击这条路没走 buildPlan.dueCards'),
    extra: { practiceTexts: pb.texts, total, limit, deferred, facts },
  };
};

/** [5] ★ 额度调到下限 20 再点一次：只给 20 题（不是 40）。
 *
 * 为什么光有 [4] 不够（这是**反向验证时发现的**，很重要）：
 *   `createSession` 内部本来就会用 `suggestSize(source, n, { max: 40 })` 取前 size 个，
 *   而 'due' 那条路 `suggestSize` 的上限也正好是 40。所以在"上限恰好 40"的配置下，
 *   就算把"按额度收窄卡池"那一步整个删掉，本场仍然只会出 40 题 —— [4] 照样是绿的。
 *   也就是说 **[4] 证明不了收窄那一步在起作用**。
 *   把上限调成一个**不等于 40** 的数，收窄和不收窄的结果才会分叉：
 *     · 收窄了  → 卡池只有 20 个 → 这一场 20 题
 *     · 没收窄  → 卡池 120 个 → suggestSize 给 min(40, 120) = 40 题  ✗
 *   这条检查存在的唯一理由就是抓住这个分叉。
 *
 * ⚠️ 这里原来用的是 10。用户把范围改成 20–200 之后，**10 已经被夹成 20 了**，
 *    再拿 10 当"期望值"就会因为这个巧合而假绿（幸好放的是 20 不是 40，
 *    但"测试里的期望值必须落在允许范围内"这条规矩得立住）。
 *    现在直接用 `db.DAILY_REVIEW_LIMIT_MIN`，范围再改它也不会脱节。
 */
checks.sessionHonoursTightLimit = async () => {
  await seed;
  // 用真正的下限，而不是手写的数字 —— 手写的那个会随范围调整而失效
  const TIGHT = db.DAILY_REVIEW_LIMIT_MIN;
  await db.setSetting('dailyReviewLimit', TIGHT);
  await showToday();
  const btn = reviewMainButton();
  if (!btn) return { ok: false, note: `额度改成 ${TIGHT} 之后找不到复习主按钮`, extra: { quota: quotaText() } };
  const btnText = btn.textContent.trim();
  btn.click();
  const bar = await waitFor('.practice-bar', 20000);
  if (!bar) {
    return { ok: false, note: '点了「开始复习」之后没有出现练习页（.practice-bar）', extra: { btnText } };
  }
  await until(() => sessionTotalFrom(practiceBar().all) !== null, 5000);
  const pb = practiceBar();
  const total = sessionTotalFrom(pb.all);
  const facts = QA.facts;
  // 关键判据：本场题数必须**等于 10**，而不是 40（没收窄时会变成 40）
  const ok = total === TIGHT;
  // 用完把上限还原，避免影响后面的检查
  await db.setSetting('dailyReviewLimit', facts.limit);
  return {
    ok,
    note: `上限调成 ${TIGHT} 后按钮「${btnText}」，练习页「${pb.all}」→ 本场题数=`
      + `${total === null ? '没显示总数' : total}（要求恰好 ${TIGHT}）`
      + (ok ? '（额度真的按上限收窄了）'
        : ` —— 期望 ${TIGHT}。若得到 40，说明"按额度收窄卡池"那一步没生效，`
          + '只是被 suggestSize 的 40 上限兜住了（那是个巧合，换个上限就漏题）'),
    extra: { practiceTexts: pb.texts, total, tight: TIGHT, facts },
  };
};

/** [6] ★ 范围 20–200：界面里**填不出 0 了**，脏数据 0 会被夹到 20。
 *
 * 这条原来测的是"上限填 0 = 不限量"（额度行写「不限量」、按钮一次给完）。
 * 用户 2026-10 看过 12 倍实测数据之后把范围定成 **20–200**，
 * "不限量"这个出口就撤掉了 —— 所以旧断言测的是一条**已经不存在的路**，必须换掉。
 *
 * 换成测边界，是因为范围这件事有两个容易各改一半的地方：
 *   ① 输入框的 min/max 属性（界面层，拦不住手输）；
 *   ② getSetting 的夹取（数据层，真正说了算的）。
 * 只改一处会出现"框上写着 20–200、但存进去 0 照样生效"。所以两处都要验。
 */
checks.reviewLimitRange = async () => {
  await seed;
  const facts = QA.facts;
  const LO = db.DAILY_REVIEW_LIMIT_MIN;
  const HI = db.DAILY_REVIEW_LIMIT_MAX;

  // ---- ① 数据层夹取：0（旧的"不限量"值）必须被夹到下限 20 ----
  await db.setSetting('dailyReviewLimit', 0);
  const readBack = await db.getSetting('dailyReviewLimit');
  await db.setSetting('dailyReviewLimit', 99999);
  const readHigh = await db.getSetting('dailyReviewLimit');
  await db.setSetting('dailyReviewLimit', facts.limit);   // 还原

  // ---- ② 界面层：额度行不能再出现「不限量」三个字 ----
  await showToday();
  const { text } = reviewQuotaLine();
  const noUnlimited = !/不限量/.test(text) && !/不限量/.test(quotaText());

  // ---- ③ 设置页输入框的 min/max 属性必须和常量一致 ----
  const host = document.createElement('div');
  const mod = await import('/js/views/settings.js');
  await mod.default.render(host, {});
  const label = [...host.querySelectorAll('label')]
    .find((l) => /每天最多复习多少个词/.test(l.textContent));
  const field = label ? label.closest('.field') : null;
  const input = field ? field.querySelector('input[type=number]') : null;

  const ok = readBack === LO && readHigh === HI && noUnlimited
    && !!input && Number(input.min) === LO && Number(input.max) === HI;
  return {
    ok,
    note: `范围常量 ${LO}–${HI}：写 0 读回 ${readBack}（要 ${LO}）、写 99999 读回 ${readHigh}（要 ${HI}）；`
      + `额度行不含「不限量」=${noUnlimited}；`
      + `设置页输入框 min/max=${input ? input.min + '/' + input.max : '没找到'}`
      + (ok ? '' : ' —— 要求：数据层把 0/99999 夹到边界，且界面不再提"不限量"、'
        + '输入框属性与常量一致'),
    extra: { LO, HI, readBack, readHigh, quota: text, min: input ? input.min : null, max: input ? input.max : null },
  };
};

/** [7] 设置页：「背单词」卡片里有那个标签和输入框，且显示的是刚改成的值 */
checks.settingsField = async () => {
  await seed;
  // 不假设上一条跑过，这里自己把上限设成一个可辨认的值。
  // ⚠️ 这个"可辨认的值"必须落在允许范围 20–200 内（原来写的是 500，
  //    范围一收就被夹成 200，于是断言会报"值 200，期望 500"而假红）。
  //    直接用上限本身，范围再改也不会脱节。
  const LIMIT_MARK = db.DAILY_REVIEW_LIMIT_MAX;
  await db.setSetting('dailyReviewLimit', LIMIT_MARK);

  const host = document.createElement('div');
  const mod = await import('/js/views/settings.js');
  await mod.default.render(host, {});

  const label = [...host.querySelectorAll('label')]
    .find((l) => /每天最多复习多少个词/.test(l.textContent));
  const field = label ? label.closest('.field') : null;
  const card = label ? label.closest('.card') : null;
  const input = field ? field.querySelector('input[type=number]') : null;
  const ok = !!label && !!input && input.value === String(LIMIT_MARK)
    && !!card && /背单词/.test(card.textContent);
  return {
    ok,
    note: ok
      ? `设置页「背单词」卡片里有「${label.textContent.trim()}」和输入框，当前值 ${input.value}`
      : `设置页缺东西：标签=${!!label}，同栏输入框=${!!input}`
        + `（值 ${input ? input.value : '无'}，期望 ${LIMIT_MARK}），卡片=${!!card}`,
    extra: {
      labels: [...host.querySelectorAll('label')].map((l) => l.textContent.trim()).slice(0, 20),
      value: input ? input.value : null,
    },
  };
};

/** [8] 全程没有页面异常、没有 console.error */
checks.noErrors = async () => {
  await seed;
  await sleep(300);
  const errs = QA.errors.slice();
  const cons = QA.consoleErrors.filter((x) => /^error/.test(x));
  const ok = errs.length === 0 && cons.length === 0;
  return {
    ok,
    note: ok
      ? '页面无异常、控制台无 error'
      : `页面异常 ${errs.length} 条、控制台 error ${cons.length} 条`,
    extra: { errors: errs.slice(0, 5), consoleErrors: cons.slice(0, 5) },
  };
};
