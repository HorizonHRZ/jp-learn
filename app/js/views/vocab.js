/**
 * views/vocab.js —— 背单词（阶段 2 核心页面）
 *
 * 一个页面里装四个视角（不新增导航页）：
 *   今日  —— 每日新词额度 / 学习计划与开始按钮
 *   练习  —— 先选**一个**练习方式（三选一），再选练什么内容；另有小测（定题量、有计时、答完才出分）
 *   词表  —— 生词本管理（搜索/筛选/排序/批量/导入），没有数量上限
 *   错题  —— 按错误次数排序的错题本，可只练错题
 *
 * 评分：**没有评分按钮**。答对自动判 good 并自动进下一题，答错判 again 进错题本、
 * 停在反馈页看正确答案。详见 ARCHITECTURE.md §10.18。
 * 语音：本页面不含任何朗读功能（用户要求）。
 *
 * ⚠️ 契约：本视图注册了全局 keydown 监听，必须在 destroy() 里摘掉，
 * 否则来回切页面会叠加多个监听器，按一次键会被处理多次（快捷键"连跳两题"）。
 */

import {
  el, clear, toast, toastOk, toastWarn, toastError, modal, confirmDialog, confirmTwice,
  humanAgo, emptyState,
} from '../ui.js';
import * as db from '../db.js';
import * as vd from '../vocabdata.js';
import * as S from '../session.js';
import * as Q from '../quiz.js';
import * as T from '../testrun.js';
import { GRADE, STATE, humanInterval, schedule, newCard, forecast, weightForReinforce } from '../srs.js';
import { openLookupFor } from '../drawer.js';
import * as ankiMod from '../anki.js';

/** 模块级状态：跨 render 保留（切走再回来不丢当前练习） */
let activeTab = 'today';
/** 外部（goVocabTab）指定、等待 render/onReenter 采纳的落地标签页 */
let pendingTab = null;
let practice = null;          // { session, revealed, picked, input, verdict }
let testRun = null;           // { test, input, startedTick, writeback }
let testTimer = null;         // 小测倒计时的 interval id
let testConfig = { source: 'mix', count: 20, minutes: 0 };
let mountedRoot = null;
let keyHandler = null;
/** 正在写答题记录（防止"继续"按钮与 Enter 键同时触发，把一题记两次） */
let grading = false;

/**
 * 小测允许的模式：三种全上（用户确认小测保留"混合"来源、模式随机）。
 * 不再包含 listen（听写）与 cloze（填空）——用户明确不要语音与填空题型。
 */
const TEST_MODES = Q.MODE_ORDER.slice();

export default {
  id: 'vocab',
  title: '背单词',

  async render(root) {
    mountedRoot = root;
    // 外部用 goVocabTab() 指定了落地标签页（例：统计页的"去错题本"）时先采纳。
    // 放在 ensureLibraryWithUI 之前，因为那一步会 await，期间不该被别的赋值插队。
    if (pendingTab) { activeTab = pendingTab; pendingTab = null; }
    // 保证内置词库缓存可用（首次会构建，之后是增量判断）
    await ensureLibraryWithUI(root);
    await renderShell(root);
  },

  destroy() {
    // 关键：摘掉全局快捷键监听（见文件头说明）
    if (keyHandler) {
      document.removeEventListener('keydown', keyHandler);
      keyHandler = null;
    }
    // 小测的倒计时也必须停掉，否则切走后定时器还在跑
    stopTestTimer();
    mountedRoot = null;
  },

  /** 再次进入同一页面时刷新数据（导航点击已在本页时触发） */
  async onReenter(root) {
    mountedRoot = root;
    if (pendingTab) { activeTab = pendingTab; pendingTab = null; }
    await renderShell(root);
  },
};

/**
 * 别处（统计页的"去错题本"、以后的速查抽屉）需要直接落在某个标签页时用它。
 *
 * 为什么需要 `pendingTab` 这个中间变量，而不是直接 `activeTab = id` 就完事：
 * `activeTab` 在 render() 开头会被 pendingTab 覆盖，而 render 是**异步**的
 * （要先 await 词库缓存）。如果外部只改 activeTab 就切路由，等 render 真正跑起来时
 * 状态可能已经被别处动过。用一个"待采纳"的变量把意图显式传递过去，时序才是确定的。
 *
 * 已经在背单词页时：`location.hash` 不变，所以 hashchange 不触发；这时直接调
 * 视图自己的 onReenter 重新渲染（router 的 `go()` 也是这个套路）。
 */
export function goVocabTab(tabId) {
  pendingTab = tabId;
  const target = '#/vocab';
  if (location.hash === target) {
    // 已经在本页：hash 不变，hashchange 不会触发，得自己重渲染（同 router.go 的套路）
    if (mountedRoot) renderShell(mountedRoot).catch(() => { /* 渲染失败由 router 兜底 */ });
  } else {
    location.hash = target;
  }
}

// ---------------------------------------------------------------------------
// 词库缓存准备
// ---------------------------------------------------------------------------

async function ensureLibraryWithUI(root) {
  let status;
  try {
    status = await vd.libraryStatus();
  } catch (e) {
    root.appendChild(el('div', { class: 'banner banner-error' }, [
      el('strong', { text: '读不到词库：' }),
      el('span', { text: String((e && e.message) || e) }),
      el('div', { class: 'banner-hint', text: '请确认本地服务（启动.cmd）还在运行，然后刷新页面。' }),
    ]));
    throw e;
  }

  if (status.ready && status.upToDate) return;

  // 需要构建：给出可见进度（一万五千条要几秒，没有进度条会让人以为卡死）
  const host = el('div', { class: 'card' });
  const bar = el('div', { class: 'progress-fill', style: { width: '0%' } });
  const label = el('div', { class: 'dim', style: { fontSize: '.85rem' }, text: '准备内置词库…' });
  host.appendChild(el('div', { class: 'card-title' }, [el('h3', { text: '正在准备内置词库' })]));
  host.appendChild(el('p', { class: 'dim', text: '首次使用需要把内置 JLPT 词库装进浏览器本地缓存，只需一次。' }));
  host.appendChild(el('div', { class: 'progress' }, [bar]));
  host.appendChild(label);
  root.appendChild(host);

  try {
    const r = await vd.ensureLibrary({
      onProgress: (stage, done, total) => {
        label.textContent = total
          ? `${stage}　${done}/${total}`
          : stage;
        bar.style.width = total ? Math.round((done / total) * 100) + '%' : '0%';
      },
    });
    host.remove();
    toastOk(`内置词库已就绪：${r.count} 条`);
  } catch (e) {
    host.remove();
    root.appendChild(el('div', { class: 'banner banner-error' }, [
      el('strong', { text: '内置词库准备失败：' }),
      el('span', { text: String((e && e.message) || e) }),
      el('div', { class: 'banner-hint', text: '你的生词本与学习记录没有受影响，可以稍后重试。' }),
    ]));
  }
}

// ---------------------------------------------------------------------------
// 页面骨架 + 标签页
// ---------------------------------------------------------------------------

async function renderShell(root) {
  clear(root);
  const body = el('div');
  root.appendChild(body);

  const counts = await tabCounts();

  const TABS = [
    { id: 'today', label: '今日' },
    { id: 'practice', label: '练习' },
    { id: 'words', label: '词表', count: counts.words },
    { id: 'mistakes', label: '错题', count: counts.mistakes },
  ];

  const tabs = el('div', { class: 'tabs' });
  for (const t of TABS) {
    tabs.appendChild(el('button', {
      class: 'tab' + (activeTab === t.id ? ' active' : ''),
      onclick: async () => {
        activeTab = t.id;
        await renderShell(root);
      },
    }, [
      el('span', { text: t.label }),
      t.count ? el('span', { class: 'tab-count', text: String(t.count) }) : null,
    ].filter(Boolean)));
  }
  root.appendChild(tabs);

  if (activeTab === 'today') await renderToday(root);
  else if (activeTab === 'practice') await renderPractice(root);
  else if (activeTab === 'words') await renderWords(root);
  else if (activeTab === 'mistakes') await renderMistakes(root);
}

async function tabCounts() {
  try {
    const [words, mistakes] = await Promise.all([
      db.dbCount('words'),
      vd.listMistakes({ includeResolved: false }),
    ]);
    return { words, mistakes: mistakes.length };
  } catch { return { words: 0, mistakes: 0 }; }
}

// ---------------------------------------------------------------------------
// 今日
// ---------------------------------------------------------------------------

async function renderToday(root) {
  const words = await vd.listWords();
  const cards = await vd.allCards();
  const settings = await db.getSettings();
  // newLimit = 每天最多学几个新词（设置页可改，默认 50）。
  // buildPlan 内部用 introducedAt 扣掉"今天已经学过的"，所以这是**每日**上限，
  // 不是"每次练习给多少"。
  //
  // reviewLimit / reviewedToday 是同一套逻辑用在**复习**上（默认 40，2026-10 补）。
  // 之前复习完全没有上限，到期多少就摆多少：实测每天学 20 个新词、稳定后
  // 每天 242 个到期，做不完就一直堆。现在超出的顺延到明天。
  // reviewedToday 从 reviews 表的 byDay 索引里数"今天答过的不同词"，
  // 所以它是**真实已完成进度**，不是这一场会话的临时计数。
  const now = Date.now();
  const done = await vd.reviewedToday(now);
  const plan = S.buildPlan(cards, words, {
    now,
    newLimit: settings.dailyNewLimit,
    reviewLimit: settings.dailyReviewLimit,
    reviewedToday: done.words,
  });
  const overview = await vd.reviewOverview();
  const libCount = (await vd.libraryStatus()).count;
  const mode = await currentMode();

  // ---- 计划卡 ----
  // 「到期复习」显示今天额度内**还能做**的个数（不是到期总数）：
  // 那个数字才是"今天要面对的量"。到期总数放在下面一行额度说明里，
  // 免得又出现"按钮写 537、点进去只给 40、还不告诉你剩多少"那种对不上的数字。
  const cells = [
    { n: plan.reviewToday, label: '今日待复习', cls: plan.reviewToday ? 'is-due' : 'is-quiet' },
    { n: plan.newToday, label: '今日新学', cls: plan.newToday ? 'is-new' : 'is-quiet' },
    { n: overview.unresolvedMistakes, label: '待克服错题', cls: overview.unresolvedMistakes ? 'is-due' : 'is-quiet' },
    { n: plan.mature, label: '已记牢', cls: 'is-quiet' },
  ];
  const grid = el('div', { class: 'plan-grid' });
  for (const c of cells) {
    grid.appendChild(el('div', { class: 'plan-cell' }, [
      el('div', { class: 'plan-num ' + c.cls, text: String(c.n) }),
      el('div', { class: 'plan-label', text: c.label }),
    ]));
  }
  root.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, [
      el('h2', { text: '今日' }),
      el('span', { class: 'badge', text: libCount ? `内置词库 ${libCount} 条` : '词库未就绪' }),
    ]),
    grid,
    // 每日新词额度：让人一眼看到"今天还能学几个"，并能直接改
    el('div', { class: 'quota-line' }, [
      el('span', { text: `每日新词：今天已学 ${plan.introducedToday} / ${plan.newLimit}，还剩 ${plan.remainingNew} 个` }),
      el('button', {
        class: 'btn btn-sm btn-ghost',
        onclick: () => editDailyLimit(plan.newLimit),
      }, '修改'),
    ]),
    // 每日复习额度：同样的模式。到期总数在这里如实写出来，
    // 这样"今日待复习 40"和"一共 537 个到期"两个数都看得见，不会再对不上。
    //
    // ⚠️ 措辞要分情况（第一版没分，今天没有到期词时会显示
    //    "今天还剩 0 个"，读起来像"额度用完了"，其实是"今天没活干"）：
    //    · 今天有到期的   → 写"今天还剩 N 个"，有顺延再补一句；
    //    · 今天没有到期的 → 就写"今天没有到期的词"，不要提剩余额度。
    //
    // 📌 这里原来还有一个"不限量"分支（上限填 0 时显示）。
    //    现在范围改成 20–200，**0 已经填不出来**了，所以分支删掉 ——
    //    留着一个永远走不到的 UI 分支，只会让以后读代码的人以为它还能发生。
    //    （纯函数 srs.js 里对 limit<=0 的"不限量"防御仍然保留，
    //      因为那是防历史脏数据的，和界面能不能填是两件事。）
    el('div', { class: 'quota-line' }, [
      el('span', {
        text: `每日复习：今天已复习 ${plan.reviewedToday} / ${plan.reviewLimit}`
          + (plan.reviewToday > 0
              ? `，今天还剩 ${plan.reviewToday} 个`
                + (plan.reviewDeferred > 0
                    ? `（另有 ${plan.reviewDeferred} 个到期，会顺延到明天）` : '')
              : plan.dueReviewCount > 0
                ? `，今天的额度已完成（还有 ${plan.reviewDeferred} 个顺延到明天）`
                : '，今天没有到期的词'),
      }),
      el('button', {
        class: 'btn btn-sm btn-ghost',
        onclick: () => editReviewLimit(plan.reviewLimit),
      }, '修改'),
    ]),
    plan.newQuotaUsedUp
      ? el('div', { class: 'banner banner-info', style: { marginTop: '10px' } }, [
          el('span', { text: `今天的 ${plan.newLimit} 个新词额度已经用完，还有 ${plan.newAvailable} 个新词等你明天学。想现在就继续，点上面的「修改」把额度调大。` }),
        ])
      : null,
    // 复习额度用完：这是"顺延"机制对用户可见的唯一出口，必须说清了三件事：
    // 今天做完了多少、还剩多少、明天会怎样。不说清就又变成"数字对不上"。
    plan.reviewQuotaUsedUp
      ? el('div', { class: 'banner banner-info', style: { marginTop: '10px' } }, [
          el('span', {
            text: `今天的 ${plan.reviewLimit} 个复习额度已经做完，还有 ${plan.reviewDeferred} 个到期的词。`
              + `它们会顺延到明天（一个都不会漏），明天照样按逾期最久的优先排给你。`
              + `想现在就继续，点上面的「修改」把额度调大。`,
          }),
        ])
      : null,
    // ⚠️ 这一条是**数学事实**，不是唠叨，所以必须显示（2026-10 实测得出）：
    //    长期稳定后每天到期的量约等于「每天新学量 × 12」。
    //    如果上限比这个小，到期队列会**永远增长、永远清不完** ——
    //    实测每天学 10 个、上限 40：两年后积压 5958 个、只有 2460 个词记牢；
    //    同样条件上限改成 150：积压 0、6966 个记牢。
    //    也就是说"上限设太小"不只意味着少做点，而是**学习效果显著变差**。
    //    只提示、不擅自改用户的设置（用户的数字由用户定）。
    //
    // 📌 文案必须自己兜住"建议值超出可填范围"这种情况（2026-10 才发现）：
    //    复习上限的可填范围只有 20–200，而默认新学 50 个算出来的建议值是 600 ——
    //    **填不进去**。原来直接照抄那个 600，等于让人去填一个输入框会拒绝的数字，
    //    是明确的坏建议。所以：
    //      · 建议值超过上限时，不再说"把复习上限调到 600"，改成说清楚
    //        "上限最多 200，所以只能靠调小新词" ；
    //      · 调小新词那条始终给，并且它就是这种情况下**唯一真能平衡的**做法。
    //
    // 📌 这里原来还写着 `!plan.reviewUnlimited &&`，一起去掉了：
    //    `reviewLoadAdvice()` 本身在"上限<=0（不限量）"时就已经返回 ok:true，
    //    再加一层判断是重复的；而界面现在也填不出 0 了。
    !plan.reviewLoadAdvice.ok
      ? el('div', { class: 'banner banner-warn', style: { marginTop: '10px' } }, [
          el('span', {
            text: `提醒：你每天新学 ${plan.newLimit} 个，长期下来每天会有约 `
              + `${plan.reviewLoadAdvice.recommended} 个词到期（约 12 倍），`
              + `而现在每日复习上限是 ${plan.reviewLimit} 个。`
              + `这样配的话到期队列会一直增长、永远清不完（不是丢词，是做不完）。`
              + (plan.reviewLoadAdvice.recommended <= db.DAILY_REVIEW_LIMIT_MAX
                  ? `建议二选一：把复习上限调到 ${plan.reviewLoadAdvice.recommended} 左右，`
                    + `或把每天新学降到 ${Math.max(1, Math.floor(plan.reviewLimit / 12))} 个左右。`
                  : `复习上限最多只能填 ${db.DAILY_REVIEW_LIMIT_MAX} 个，已经不够用了 ——`
                    + `所以这里只能反过来调小新词：把每天新学降到 `
                    + `${Math.max(1, Math.floor(db.DAILY_REVIEW_LIMIT_MAX / 12))} 个左右`
                    + `（按 12 倍算，${db.DAILY_REVIEW_LIMIT_MAX} 个复习上限大约能配这么多新词）。`),
          }),
        ])
      : null,
    el('div', { class: 'btn-row', style: { marginTop: '14px' } }, [
      el('button', {
        class: 'btn btn-primary btn-lg',
        // 注意：这里用 reviewToday（今天的额度）而不是 dueReviewCount（到期总数）。
        // 两个数不一样时，按钮文字会把两个都写出来 —— 这正是之前那个
        // "写 537、只给 40"的坑，别再改回去。
        onclick: () => startSession(plan.reviewToday ? 'due' : (plan.newToday ? 'new' : 'due')),
      }, plan.reviewToday
        ? (plan.dueReviewCount > plan.reviewToday
            ? `开始复习（本轮 ${plan.reviewToday} 个，另有 ${plan.reviewDeferred} 个顺延）`
            : `开始复习（${plan.reviewToday} 个）`)
        : plan.reviewQuotaUsedUp
          ? `今天的复习额度已完成（还剩 ${plan.reviewDeferred} 个顺延到明天）`
          : plan.newToday ? `开始学新词（${plan.newToday} 个）`
          : '今天没有到期的词'),
      plan.newToday ? el('button', {
        class: 'btn', onclick: () => startSession('new'),
      }, `学新词（${plan.newToday}）`) : null,
      overview.unresolvedMistakes ? el('button', {
        class: 'btn', onclick: () => startSession('mistakes'),
      }, `练错题（${overview.unresolvedMistakes}）`) : null,
    ].filter(Boolean)),
    el('div', { class: 'dim', style: { fontSize: '.82rem', marginTop: '8px' },
      text: `当前练习方式：${(Q.MODES[mode] || {}).label || mode}（在「练习」页可以改）` }),
  ].filter(Boolean)));

  // ---- 第一次使用：引导 ----
  if (!words.length) {
    root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [el('h3', { text: '生词本还是空的' })]),
      el('p', { class: 'dim', text: '两种方式开始：从内置 JLPT 词库里挑词加入，或导入你自己的词表。' }),
      el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn btn-primary', onclick: () => openLibraryPicker() }, '从内置词库挑词'),
        el('button', { class: 'btn', onclick: () => openImportDialog() }, '导入我的词表'),
        el('a', { class: 'btn btn-ghost', href: '#/', text: '返回首页' }),
      ]),
    ]));
  } else {
    root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [el('h3', { text: '词库管理' })]),
      el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn', onclick: () => openLibraryPicker() }, '＋ 从内置词库加词'),
        el('button', { class: 'btn', onclick: () => openImportDialog() }, '＋ 导入我的词表'),
        el('button', { class: 'btn', onclick: () => openLookupFor('') }, '速查'),
      ]),
    ]));
  }

  // ---- 未来复习量 ----
  try {
    const fc = forecast(cards, Date.now(), 14);
    const maxCount = Math.max(1, ...fc.map((d) => d.count));
    const bars = el('div', { style: { display: 'flex', gap: '3px', alignItems: 'flex-end', height: '72px' } });
    for (const d of fc) {
      bars.appendChild(el('div', {
        title: `${d.day}：${d.count} 个`,
        style: {
          flex: '1', height: Math.max(2, Math.round((d.count / maxCount) * 64)) + 'px',
          background: d.count ? 'var(--accent)' : 'var(--bg-sunken)',
          borderRadius: '2px',
        },
      }));
    }
    root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [el('h3', { text: '未来 14 天复习量' })]),
      bars,
      el('div', { class: 'dim', style: { fontSize: '.78rem', marginTop: '6px' }, text: '逾期未复习的词会堆在第一天。' }),
    ]));
  } catch { /* 预测失败不影响主流程 */ }
}

// ---------------------------------------------------------------------------
// 练习
// ---------------------------------------------------------------------------

async function renderPractice(root) {
  if (practice) { await paintQuestion(root); return; }
  if (testRun) { await paintTest(root); return; }
  root.appendChild(await practiceSetupCard());
  root.appendChild(await testSetupCard());
}

// ---------------------------------------------------------------------------
// 小测：定题量、有计时、答完才出结果（不是"第四种练习方式"，
// 而是练习之外的另一条入口 —— 模式在一个小测里随机抽，见 §10.16）
//
// 与"练习"的本质区别（也是它值得单独做一套界面的原因）：
//   练习一题一反馈、答错重排队尾、还要自己评"忘了/想起/太简单"——目标是**记住**；
//   小测中途不提示对错、题量固定、程序判分——目标是**检验**。
// 正因为要"检验"，小测的成绩不能被自评影响，所以这里不出现评分按钮，
// 回写 SRS 时统一用 答对→good / 答错→again（见 testrun.gradesForWriteback）。
// ---------------------------------------------------------------------------

function stopTestTimer() {
  if (testTimer) { clearInterval(testTimer); testTimer = null; }
}

async function testSetupCard() {
  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-title' }, [
    el('h2', { text: '小测' }),
    el('span', { class: 'badge', text: '定题量 · 可计时' }),
  ]));
  card.appendChild(el('p', { class: 'dim',
    text: '从选定的范围里抽固定题量，中途不提示对错，答完统一给分。用来检验"到底记没记住"。' }));

  // 来源
  const srcBox = el('div', { class: 'segmented' }, Object.values(T.TEST_SOURCE).map((s) =>
    el('button', {
      class: testConfig.source === s.id ? 'active' : '',
      title: s.hint,
      onclick: (e) => {
        testConfig.source = s.id;
        for (const b of e.target.parentNode.children) b.classList.toggle('active', b === e.target);
      },
    }, s.label)
  ));
  card.appendChild(el('div', { class: 'field' }, [
    el('label', { class: 'field-label', text: '题目来源' }), srcBox,
    el('div', { class: 'field-hint', text: (T.TEST_SOURCE[testConfig.source] || {}).hint || '' }),
  ]));

  // 题量
  const cntBox = el('div', { class: 'segmented' }, T.COUNT_PRESETS.map((n) =>
    el('button', {
      class: testConfig.count === n ? 'active' : '',
      onclick: (e) => {
        testConfig.count = n;
        for (const b of e.target.parentNode.children) b.classList.toggle('active', b === e.target);
      },
    }, `${n} 题`)
  ));
  card.appendChild(el('div', { class: 'field' }, [
    el('label', { class: 'field-label', text: '题量' }), cntBox,
  ]));

  // 计时
  const timeBox = el('div', { class: 'segmented' }, T.TIME_PRESETS.map((m) =>
    el('button', {
      class: testConfig.minutes === m ? 'active' : '',
      onclick: (e) => {
        testConfig.minutes = m;
        for (const b of e.target.parentNode.children) b.classList.toggle('active', b === e.target);
      },
    }, m === 0 ? '不计时' : `${m} 分钟`)
  ));
  card.appendChild(el('div', { class: 'field' }, [
    el('label', { class: 'field-label', text: '计时' }), timeBox,
    el('div', { class: 'field-hint', text: '到点自动交卷；没答的题会如实计为"未作答"，不算答错。' }),
  ]));

  card.appendChild(el('div', { class: 'btn-row', style: { marginTop: '12px' } }, [
    el('button', { class: 'btn btn-primary', onclick: () => startTest() }, '开始小测'),
  ]));

  card.appendChild(el('div', { class: 'banner banner-info', style: { marginTop: '12px' } }, [
    el('strong', { text: '快捷键：' }),
    el('div', { class: 'shortcut-list', style: { marginTop: '6px' } }, [
      el('span', { class: 'kbd', text: 'Enter' }), el('span', { text: '提交 / 下一题' }),
      el('span', { class: 'kbd', text: '空格' }), el('span', { text: '朗读' }),
      el('span', { class: 'kbd', text: 'Esc' }), el('span', { text: '放弃本次小测' }),
    ]),
  ]));

  return card;
}

/** 开始一次小测 */
async function startTest() {
  const root = mountedRoot;
  if (!root) return;
  try {
    const cfg = testConfig;
    let words = [];

    if (cfg.source === 'vocab') {
      words = await vd.listWords();
    } else if (cfg.source === 'mistakes') {
      const rows = await vd.listMistakes({ includeResolved: false });
      words = rows.map((r) => r.word).filter(Boolean);
    } else if (cfg.source === 'mix') {
      const own = await vd.listWords();
      const rows = await vd.listMistakes({ includeResolved: false });
      words = own.concat(rows.map((r) => r.word).filter(Boolean));
    } else if (cfg.source === 'level') {
      const picked = await askLevels();
      if (!picked || !picked.length) return;
      words = await vd.sampleLibrary(picked, cfg.count * 4);
    }

    if (!words.length) {
      toastWarn(cfg.source === 'mistakes' ? '错题本里没有待克服的词' : '这个范围里没有可考的词');
      return;
    }

    // 干扰项池用内置词库（够大，选项才有区分度）
    const pool = (await vd.sampleLibrary(null, 600)).concat(words);

    const test = T.createTest({
      id: 'test-' + Date.now(),
      source: cfg.source,
      words,
      count: cfg.count,
      timeLimitMs: cfg.minutes * 60 * 1000,
      now: Date.now(),
      modes: TEST_MODES,
      buildQuestions: (ws, o) => Q.buildQuiz(ws, {
        count: ws.length, pool, rand: o.rand, modes: o.modes, keepOrder: false,
      }),
    });

    if (!test.queue.length) { toastWarn('这个范围里没能出成题目，换个来源试试'); return; }
    if (test.queue.length < cfg.count) {
      toast(`可考的只有 ${test.queue.length} 个词，本次小测按 ${test.queue.length} 题进行`, 'warn', 4000);
    }

    testRun = { test, input: '', writeback: null, tick: null };
    activeTab = 'practice';
    await renderShell(root);
    installShortcuts();
    startTestTimer();
  } catch (e) {
    toastError('开始小测失败：' + ((e && e.message) || e));
  }
}

/** 倒计时：每秒刷新一次显示，到点自动交卷 */
function startTestTimer() {
  stopTestTimer();
  if (!testRun || !testRun.test.timeLimitMs) return;
  testTimer = setInterval(async () => {
    if (!testRun) { stopTestTimer(); return; }
    const t = testRun.test;
    if (t.submitted) { stopTestTimer(); return; }
    if (T.isTimeUp(t, Date.now())) {
      stopTestTimer();
      toastWarn('时间到，已自动交卷');
      testRun = { ...testRun, test: T.finishTest(t, Date.now()) };
      const root = mountedRoot;
      if (root) await paintTest(root);
      return;
    }
    // 只更新倒计时那一小块，不整屏重绘（整屏重绘会打断用户输入）
    const box = mountedRoot && mountedRoot.querySelector('.test-clock');
    if (box) box.textContent = formatClock(T.remainingMs(t, Date.now()));
  }, 1000);
}

function formatClock(ms) {
  if (ms === null || ms === undefined) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** 画小测的当前题 */
async function paintTest(root) {
  clear(root);
  const st = testRun;
  if (!st) { await renderPractice(root); return; }

  const t = st.test;
  if (t.submitted) { await paintTestResult(root); return; }

  const cur = T.currentQuestion(t);
  if (!cur) {
    testRun = { ...st, test: T.finishTest(t, Date.now()) };
    await paintTestResult(root);
    return;
  }

  const q = cur.question;
  const answered = t.answers.length;
  const left = T.remainingMs(t, Date.now());

  const bar = el('div', { class: 'progress-fill', style: { width: Math.round((answered / t.queue.length) * 100) + '%' } });
  const clock = el('span', { class: 'test-clock', text: formatClock(left) });

  root.appendChild(el('div', { class: 'practice' }, [
    el('div', { class: 'practice-bar' }, [
      bar,
      el('span', { class: 'practice-count', text: `第 ${cur.index + 1} / ${cur.total} 题` }),
      t.timeLimitMs ? clock : null,
      el('button', { class: 'btn btn-sm btn-ghost', onclick: () => quitTest() }, '放弃'),
    ].filter(Boolean)),
  ]));
  const host = root.firstChild;

  const isZhPrompt = q.promptKind === 'zh';
  const card = el('div', { class: 'practice-card' }, [
    el('div', { class: 'practice-mode', text: ((Q.MODES[q.mode] || {}).label || q.mode) + ' · 小测' }),
    el('div', {
      class: 'practice-prompt' + (isZhPrompt ? ' is-zh' : ''),
      text: q.prompt,
    }),
    el('div', { class: 'practice-sub', text: q.promptSub || '' }),
  ]);

  if (q.note) card.appendChild(el('div', { class: 'practice-note', text: q.note }));
  // ⚠️ 小测不给对错反馈，所以这里**不显示** verdictBlock；
  //    例句也只在答完之后回顾时给，否则等于泄题。
  card.appendChild(el('div', { class: 'practice-note',
    text: '小测不提示对错，答完统一给分。' }));

  // 作答区：选择题点选，打字题手打
  if (q.typing || !q.choices || !q.choices.length) {
    const input = el('input', {
      class: 'input', type: 'text', placeholder: '输入答案后按 Enter',
      autocomplete: 'off', spellcheck: 'false', value: st.input || '',
      oninput: (e) => { testRun.input = e.target.value; },
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); submitTestQ(); } },
    });
    card.appendChild(el('div', { class: 'typing-row' }, [
      input,
      el('button', { class: 'btn btn-primary', onclick: () => submitTestQ() }, '提交'),
    ]));
    setTimeout(() => input.focus(), 40);
  } else {
    const choices = el('div', { class: 'choices' });
    q.choices.forEach((c, i) => {
      const isJp = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]/.test(c);
      choices.appendChild(el('button', {
        class: 'choice' + (isJp ? ' is-jp' : ''),
        onclick: () => { testRun.input = c; submitTestQ(); },
      }, [
        el('span', { class: 'choice-key', text: String(i + 1) }),
        el('span', { class: 'choice-text', text: c }),
      ]));
    });
    card.appendChild(choices);
  }

  card.appendChild(el('div', { class: 'btn-row', style: { marginTop: '10px' } }, [
    el('button', { class: 'btn btn-ghost btn-sm', onclick: () => skipTestQ() }, '跳过这题（算未作答）'),
  ]));

  host.appendChild(card);
}

/** 提交当前题（不揭示答案，直接进下一题） */
async function submitTestQ() {
  const st = testRun;
  if (!st) return;
  const cur = T.currentQuestion(st.test);
  if (!cur) return;
  const q = cur.question;
  const ok = Q.checkAnswer(st.input || '', q, q.answerSide).ok;
  const next = T.submitTestAnswer(st.test, {
    input: st.input || '', ok, now: Date.now(),
  });
  testRun = { ...st, test: next, input: '' };

  // 答完最后一题就自动交卷
  if (next.finished) {
    stopTestTimer();
    testRun = { ...testRun, test: T.finishTest(testRun.test, Date.now()) };
  }
  const root = mountedRoot;
  if (root) await paintTest(root);
}

/** 跳过这题：算未作答，卷面题量不变 */
async function skipTestQ() {
  const st = testRun;
  if (!st) return;
  const next = T.submitTestAnswer(st.test, { input: '', ok: false, now: Date.now() });
  testRun = { ...st, test: next, input: '' };
  if (next.finished) {
    stopTestTimer();
    testRun = { ...testRun, test: T.finishTest(testRun.test, Date.now()) };
  }
  const root = mountedRoot;
  if (root) await paintTest(root);
}

/** 放弃小测（不写回，也不给成绩——半途的成绩没有意义） */
async function quitTest() {
  const ok = await confirmDialog('放弃这次小测？本次作答不会被记入错题本。', { title: '放弃小测', okLabel: '放弃', danger: true });
  if (!ok) return;
  stopTestTimer();
  testRun = null;
  const root = mountedRoot;
  if (root) await renderShell(root);
}

/** 小测结果页：给分 + 分解 + 未作答 + 回写 SRS/错题本 */
async function paintTestResult(root) {
  clear(root);
  const st = testRun;
  if (!st) { await renderPractice(root); return; }
  const t = st.test;
  const r = t.result || T.finishTest(t, Date.now()).result;

  const shortcutsOn = t.requestedCount !== t.availableCount;
  root.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, [
      el('h2', { text: '小测结果' }),
      el('span', { class: 'badge', text: r.timeout ? '时间到（自动交卷）' : `用时 ${T.formatDuration(r.timeUsedMs)}` }),
    ]),
    el('div', { class: 'grid grid-4' }, [
      stat(`${r.correct}/${r.total}`, '得分'),
      stat(`${r.accuracy}%`, '正确率'),
      stat(String(r.wrong), '答错'),
      stat(String(r.unanswered), '未作答'),
    ]),
    shortcutsOn
      ? el('div', { class: 'banner banner-info', style: { marginTop: '12px' } }, [
          el('span', { text: `可考的只有 ${t.availableCount} 个词，所以本次实际是 ${t.total} 题（你选的是 ${t.requestedCount} 题）。` }),
        ])
      : null,
    el('p', { class: 'dim', style: { marginTop: '10px' },
      text: `正确率按卷面题量算：答对 ${r.correct} ÷ 卷面 ${r.total} = ${r.accuracy}%。只算做过的题则是 ${r.answeredAccuracy}%。` }),
  ].filter(Boolean)));

  // 按模式 / 按等级 分解
  const breakdown = (title, map) => {
    const keys = Object.keys(map);
    if (!keys.length) return null;
    return el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [el('h3', { text: title })]),
      el('div', { class: 'table-wrap' }, [
        el('table', { class: 'table' }, [
          el('thead', {}, el('tr', {}, [
            el('th', { text: '类别' }), el('th', { text: '出题' }), el('th', { text: '答对' }), el('th', { text: '正确率' }),
          ])),
          el('tbody', {}, keys.map((k) => {
            const v = map[k];
            const label = title.includes('模式') ? ((Q.MODES[k] || {}).label || k) : (vd.LEVEL_LABEL[k] || k);
            return el('tr', {}, [
              el('td', { text: label }),
              el('td', { text: String(v.asked) }),
              el('td', { text: String(v.correct) }),
              el('td', { text: v.asked ? Math.round((v.correct / v.asked) * 100) + '%' : '—' }),
            ]);
          })),
        ]),
      ]),
    ]);
  };
  const b1 = breakdown('按练习模式', r.byMode);
  const b2 = breakdown('按等级', r.byLevel);
  if (b1) root.appendChild(b1);
  if (b2) root.appendChild(b2);

  // 错题回顾（含正确答案）
  const wrongOnes = t.answers.filter((a) => !a.ok);
  const skipped = T.skippedQuestions(t);
  const reviewCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, [el('h3', { text: '需要再看一遍的词' })]),
  ]);
  if (!wrongOnes.length && !skipped.length) {
    reviewCard.appendChild(el('div', { class: 'empty' }, [
      el('div', { class: 'empty-title', text: '全对，没有需要回顾的词' }),
      el('div', { class: 'empty-hint', text: '可以试试更大的题量或更高的等级。' }),
    ]));
  } else {
    reviewCard.appendChild(el('div', { class: 'table-wrap' }, [
      el('table', { class: 'table' }, [
        el('thead', {}, el('tr', {}, [
          el('th', { text: '题目' }), el('th', { text: '你的答案' }), el('th', { text: '正确答案' }), el('th', { text: '' }),
        ])),
        el('tbody', {}, [
          ...wrongOnes.map((a) => reviewRow(a.prompt, a.input || '（空）', a.expected, a.wordId, a.mode)),
          ...skipped.map((s) => reviewRow(s.prompt, '（未作答）', s.answer, s.wordId, s.mode)),
        ]),
      ]),
    ]));
  }
  root.appendChild(reviewCard);

  // 回写：答对→good，答错→again，走和练习完全相同的 recordAnswer 路径
  const wb = st.writeback;
  const wbCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, [el('h3', { text: '已写入学习记录' })]),
  ]);
  if (wb) {
    wbCard.appendChild(el('div', { class: 'banner banner-ok' }, [
      el('span', { text: `错题本新增/更新 ${wb.mistakes} 个词，SRS 排程更新 ${wb.cards} 个词（答对记 good、答错记 again）。` }),
    ]));
  } else {
    wbCard.appendChild(el('div', { class: 'banner banner-warn' }, [
      el('span', { text: '还没有写入：如果你的成绩是从旧页面回来的，请点下面的按钮补写一次。' }),
    ]));
    wbCard.appendChild(el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn btn-primary btn-sm', onclick: () => writebackTest() }, '写入学习记录'),
    ]));
  }
  root.appendChild(wbCard);

  root.appendChild(el('div', { class: 'btn-row' }, [
    el('button', { class: 'btn btn-primary', onclick: () => { testRun = null; renderShell(mountedRoot); } }, '再做一次'),
    el('button', { class: 'btn btn-ghost', onclick: () => { testRun = null; activeTab = 'mistakes'; renderShell(mountedRoot); } }, '去看错题本'),
  ]));

  // 首次进入结果页时自动回写一次
  if (!wb) await writebackTest();
}

function reviewRow(prompt, mine, answer, wordId, mode) {
  return el('tr', {}, [
    el('td', { text: prompt }),
    el('td', { class: 'faint', text: mine }),
    el('td', { text: answer }),
    el('td', {}, el('button', {
      class: 'btn btn-sm btn-ghost', text: '看词',
      onclick: () => openLookupFor(answer),
    })),
  ]);
}

/** 把小测结果写回 SRS 与错题本（幂等：只写一次） */
async function writebackTest() {
  const st = testRun;
  if (!st || !st.test.submitted) return;
  if (st.writeback) return;

  const rows = T.gradesForWriteback(st.test);
  let cards = 0, mistakes = 0;
  try {
    for (const row of rows) {
      // 不在生词本里的词（例如"按等级"抽来的）不写 SRS，
      // 否则会凭空产生"学过的词"。这一点与练习模式保持一致。
      const inVocab = await vd.isInVocab(row.wordId);
      if (!inVocab) continue;
      const res = await vd.recordAnswer({
        wordId: row.wordId, grade: row.grade, mode: 'test',
        correct: row.correct, input: row.input, expected: row.expected, now: Date.now(),
      });
      cards++;
      if (res && res.mistake) mistakes++;
    }
  } catch (e) {
    toastError('写入学习记录失败：' + ((e && e.message) || e));
    return;
  }
  testRun = { ...st, writeback: { cards, mistakes } };
  toastOk(`小测已记入学习记录：SRS ${cards} 个词、错题本 ${mistakes} 个词`, 4000);
}

async function practiceSetupCard() {
  const words = await vd.listWords();
  const cards = await vd.allCards();
  const overview = await vd.reviewOverview();
  const mode = await currentMode();
  // ⚠️ 这里原来直接用 overview.dueCount（到期总数）当"到期复习"那一项的数目，
  //    和主按钮犯的是同一个错：**显示的量 ≠ 实际会给你做的量**。
  //    现在按每日复习额度算，显示"今天能做几个"，顺延的另说一句。
  const settings = await db.getSettings();
  const doneToday = await vd.reviewedToday(Date.now());
  const plan = S.buildPlan(cards, words, {
    now: Date.now(),
    newLimit: settings.dailyNewLimit,
    reviewLimit: settings.dailyReviewLimit,
    reviewedToday: doneToday.words,
  });

  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-title' }, [
    el('h2', { text: '练习' }),
    el('span', { class: 'badge', text: (Q.MODES[mode] || {}).label || mode }),
  ]));

  // ---- 第一屏就是选模式：整场练习只有这一个模式，不混用 ----
  card.appendChild(el('div', { class: 'field-label', text: '练习方式（选定后整场只用这一个）' }));
  const modeList = el('div', { class: 'mode-list' });
  for (const id of Q.MODE_ORDER) {
    const m = Q.MODES[id];
    modeList.appendChild(el('button', {
      class: 'mode-item' + (id === mode ? ' active' : ''),
      onclick: async () => {
        await setMode(id);
        await renderShell(mountedRoot);
      },
    }, [
      el('span', { class: 'mode-item-main' }, [
        el('div', { style: { fontWeight: '600' }, text: m.label }),
        el('div', { class: 'word-meta', text: m.hint }),
      ]),
      el('span', { class: 'mode-item-check', text: id === mode ? '✓' : '' }),
    ]));
  }
  card.appendChild(modeList);

  // ---- 再选练习内容 ----
  card.appendChild(el('div', { class: 'field-label', style: { marginTop: '16px' }, text: '练习内容' }));

  const rows = [
    { id: 'due', n: plan.reviewToday, hint: '按排程今天该复习的词，优先练最该练的'
      + (plan.reviewDeferred > 0
          ? `（另有 ${plan.reviewDeferred} 个到期，会顺延到明天）` : '') },
    { id: 'new', n: overview.new, hint: '生词本里还没开始学的词' },
    { id: 'mistakes', n: overview.unresolvedMistakes, hint: '错过且还没克服的词（连续答对 3 次就移出错题本）' },
    { id: 'reinforce', n: overview.review + overview.relearning, hint: '从学过的词里挑最不牢的加重练' },
    { id: 'level', n: null, hint: '从内置词库按等级随机抽词练，不加入生词本' },
  ];

  const list = el('div', { class: 'choices' });
  for (const r of rows) {
    const meta = S.SESSION_SOURCE[r.id];
    const disabled = r.id !== 'level' && !r.n && r.id !== 'due';
    list.appendChild(el('button', {
      class: 'choice',
      disabled,
      onclick: () => startSession(r.id),
    }, [
      el('span', { class: 'choice-key', text: r.id === 'level' ? '级' : String(r.n || 0) }),
      el('span', { class: 'choice-text' }, [
        el('div', { style: { fontWeight: '600' }, text: meta.label }),
        el('div', { class: 'word-meta', text: r.hint }),
      ]),
    ]));
  }
  card.appendChild(list);

  if (!words.length) {
    card.appendChild(el('div', { class: 'banner banner-info', style: { marginTop: '12px' } }, [
      el('span', { text: '生词本还是空的。先到「今日」加词，或直接选「按等级练」用内置词库试一轮。' }),
    ]));
  }

  const isTyping = !!(Q.MODES[mode] || {}).typing;
  card.appendChild(el('div', { class: 'banner banner-info', style: { marginTop: '12px' } }, [
    el('strong', { text: '快捷键：' }),
    el('div', { class: 'shortcut-list', style: { marginTop: '6px' } }, [
      el('span', { class: 'kbd', text: 'Enter' }),
      el('span', { text: isTyping ? '提交答案' : '看答案 / 下一题' }),
      el('span', { class: 'kbd', text: '1' }), el('span', { text: '标记「不会」（进错题本）' }),
      el('span', { class: 'kbd', text: 'Esc' }), el('span', { text: '结束本次练习' }),
    ]),
  ]));

  return card;
}

// ---------------------------------------------------------------------------
// 当前模式（持久化在设置里，下次打开还是它）
// ---------------------------------------------------------------------------

/** 读当前模式；设置里没有或已失效（例如旧版留下的 listen）时回退默认 */
async function currentMode() {
  let saved = '';
  try { saved = await db.getSetting('vocabMode'); } catch { saved = ''; }
  if (saved && Q.MODES[saved] && !Q.MODES[saved].removed) return saved;
  return Q.DEFAULT_MODE;
}

async function setMode(id) {
  if (!Q.MODES[id]) return;
  try { await db.setSetting('vocabMode', id); } catch (e) {
    toastError('保存练习方式失败：' + ((e && e.message) || e));
  }
}

/**
 * 改「每天背多少个新词」。
 *
 * 为什么放在今日页而不是只放设置页：这是**每天**都要看一眼、偶尔要调的数字，
 * 藏在设置页里没人会去改。两边都能改，读写的都是同一个设置项。
 */
async function editDailyLimit(current) {
  const input = el('input', {
    class: 'input', type: 'number',
    min: String(db.DAILY_NEW_LIMIT_MIN), max: String(db.DAILY_NEW_LIMIT_MAX),
    value: String(current),
  });
  const body = el('div', {}, [
    // ⚠️ 这里原来写的是「复习不受这个数字限制」—— 2026-10 加了每日复习上限之后
    //    这句话就变成误导了（会让人以为复习永远不限量）。现在两个上限各自说明。
    el('p', { class: 'dim', text: '每天最多学几个新词？这一项只管新词，和「每日复习上限」是两个独立的数字。' }),
    input,
    el('div', { class: 'field-hint', text: `范围 ${db.DAILY_NEW_LIMIT_MIN}–${db.DAILY_NEW_LIMIT_MAX}。填 0 就是今天只复习、不学新词。` }),
  ]);
  let saved = null;
  modal({
    title: '每日新词上限',
    body,
    onClose: () => {
      // 只在真的改过时才重画，避免"打开又关掉"也刷新一遍
      if (saved !== null && mountedRoot) renderShell(mountedRoot);
    },
    buttons: [
      { label: '取消', class: 'btn-ghost' },
      {
        label: '保存', class: 'btn-primary',
        onClick: async () => {
          // 钳位统一走 db.clampLimitInput（三个入口共用同一个公式，避免改范围时漏改）
          const v = db.clampLimitInput(input.value, db.DAILY_NEW_LIMIT_MIN, db.DAILY_NEW_LIMIT_MAX);
          // 返回 false = 不关闭弹窗（见 ui.modal 的约定），让用户改成一个合法数字
          if (v === null) { toastWarn('请填一个数字'); return false; }
          await db.setSetting('dailyNewLimit', v);
          saved = v;
          toastOk(`每日新词上限已改为 ${v} 个`);
        },
      },
    ],
  });
}

/**
 * 改「每天最多复习多少个词」（2026-10 新增）。
 *
 * 为什么要有这个数字：复习量会随每天新学量累积。实测长期稳定下来，
 * 每天到期的量约等于**每天新学量的 12 倍**（每天学 20 个 → 每天 242 个到期）。
 * 没有上限时，用户会在某一天突然面对几百个到期，做不完就永远堆着，
 * 而且看不到任何"今天做够了"的终点。
 *
 * 超出的部分**顺延到明天**，不改任何排程数据：到期的卡 due 本来就在过去，
 * 明天 `isDue` 照样为真，所以一个都不会漏。
 */
async function editReviewLimit(current) {
  const input = el('input', {
    class: 'input', type: 'number',
    min: String(db.DAILY_REVIEW_LIMIT_MIN), max: String(db.DAILY_REVIEW_LIMIT_MAX),
    value: String(current),
  });
  const body = el('div', {}, [
    el('p', { class: 'dim', text: '每天最多复习多少个词？到期的词按逾期最久的优先排；额度用完的会顺延到明天，不会丢。' }),
    input,
    el('div', { class: 'field-hint', text: `范围 ${db.DAILY_REVIEW_LIMIT_MIN}–${db.DAILY_REVIEW_LIMIT_MAX}。到期的词按逾期最久的优先排，所以额度多少都不会漏掉该练的。` }),
    el('div', { class: 'field-hint', text: '这一项管的是「每天复习几个词」的总量。一场练习出多少题是另一个数字（最多 40 题一场），做满一场还能再开一场，直到当天总额度用完。' }),
  ]);
  let saved = null;
  modal({
    title: '每日复习上限',
    body,
    onClose: () => {
      if (saved !== null && mountedRoot) renderShell(mountedRoot);
    },
    buttons: [
      { label: '取消', class: 'btn-ghost' },
      {
        label: '保存', class: 'btn-primary',
        onClick: async () => {
          // 钳位统一走 db.clampLimitInput（三个入口共用同一个公式，避免改范围时漏改）
          const v = db.clampLimitInput(input.value, db.DAILY_REVIEW_LIMIT_MIN, db.DAILY_REVIEW_LIMIT_MAX);
          if (v === null) { toastWarn('请填一个数字'); return false; }
          await db.setSetting('dailyReviewLimit', v);
          saved = v;
          toastOk(`每日复习上限已改为 ${v} 个`);
        },
      },
    ],
  });
}

/** 开始一次练习 */
async function startSession(source) {
  const root = mountedRoot;
  if (!root) return;
  try {
    const words = await vd.listWords();
    const cards = await vd.allCards();
    const libCount = (await vd.libraryStatus()).count;
    if (!libCount) { toastWarn('内置词库还没准备好，请稍候再试'); return; }

    let sessionWords = words;
    let sessionCards = cards;
    // 进度条要显示的"今日额度"信息。只有"到期复习"这一路才有（见下面）。
    // 存一份快照在 practice 里，是为了不每画一题都去查一次库；
    // 每次作答后 +1 由 gradeAuto 维护，所以它一直是最新的。
    let quota = null;
    /** 「到期复习」这一场该出多少题（= 今日额度内可做的个数）；其它来源为 null */
    let dueQuotaSize = null;

    if (source === 'due' || source === 'new') {
      if (!words.length) { toastWarn('生词本还是空的，先加一些词'); return; }
    } else if (source === 'mistakes') {
      const ms = vd_mistakesToWords(await vd.listMistakes({ includeResolved: false }));
      if (!ms.length) { toastWarn('没有待克服的错题'); return; }
      sessionWords = ms;
    } else if (source === 'level') {
      const picked = await askLevels();
      if (!picked || !picked.length) return;
      const sampled = await vd.sampleLibrary(picked, 20);
      if (!sampled.length) { toastWarn('这个范围内没有词'); return; }
      sessionWords = sampled;
      sessionCards = [];      // 按等级练不进生词本，用临时卡
    } else if (source === 'reinforce') {
      const wordById = new Map(words.map((w) => [w.id, w]));
      const ranked = weightForReinforce(cards, Date.now())
        .map((r) => wordById.get(r.card.wordId))
        .filter(Boolean);
      if (!ranked.length) { toastWarn('还没有学过任何词，无法加深'); return; }
      sessionWords = ranked;
    }

    // ---- 每日新词额度：学新词时只给"今天还剩的额度" ----
    // 这一步是「每天背多少个」真正生效的地方。buildPlan 已经算好了
    // 今日已学与剩余额度（靠 SRS 卡的 introducedAt），这里照它裁剪。
    // 少了这一步，每日上限就只是个显示数字——用户还是能一次刷完所有新词。
    if (source === 'new') {
      const settings = await db.getSettings();
      const done = await vd.reviewedToday(Date.now());
      const plan = S.buildPlan(cards, words, {
        now: Date.now(),
        newLimit: settings.dailyNewLimit,
        reviewLimit: settings.dailyReviewLimit,
        reviewedToday: done.words,
      });
      if (!plan.newCards.length) {
        toastWarn(plan.newAvailable
          ? `今天的 ${plan.newLimit} 个新词额度已经用完（还有 ${plan.newAvailable} 个新词）。去「今日」把额度调大，或明天再来。`
          : '没有可以学的新词了', 'warn', 5000);
        return;
      }
      const allowed = new Set(plan.newCards.map((c) => c.wordId));
      sessionWords = words.filter((w) => allowed.has(w.id));
      sessionCards = cards.filter((c) => allowed.has(c.wordId));
      if (sessionWords.length < plan.newAvailable) {
        toast(`今日新词额度剩 ${sessionWords.length} 个（上限 ${plan.newLimit}）`, 'info', 3000);
      }
    }

    // ---- 每日复习额度：到期复习只给"今天还剩的额度"，超出的顺延到明天 ----
    // ⚠️ 少了这一段，「每日复习上限」就只是个显示数字 —— 用户点一次
    //    「开始复习」照样能把当天到期的全刷完（createSession 会从 pool 里
    //    按优先级取前 size 个，pool 里有几百个就取得出来）。这和当初
    //    新词额度踩过的坑是同一个（见上面那段注释）。
    //
    // 做法：把 sessionCards 收窄成"今天额度内的到期卡"（buildPlan.dueCards
    // 已经按逾期最久优先排好并裁过额度），createSession 就只可能从这几十个里出题。
    if (source === 'due') {
      const settings = await db.getSettings();
      const done = await vd.reviewedToday(Date.now());
      const plan = S.buildPlan(cards, words, {
        now: Date.now(),
        newLimit: settings.dailyNewLimit,
        reviewLimit: settings.dailyReviewLimit,
        reviewedToday: done.words,
      });
      if (!plan.dueCards.length) {
        toastWarn(plan.reviewQuotaUsedUp
          ? `今天的 ${plan.reviewLimit} 个复习额度已经做完，还有 ${plan.reviewDeferred} 个到期的词会顺延到明天。想现在继续，去「今日」把额度调大。`
          : '现在没有到期的词', 'warn', 5000);
        return;
      }
      const allowed = new Set(plan.dueCards.map((c) => c.wordId));
      sessionCards = cards.filter((c) => allowed.has(c.wordId));
      sessionWords = words.filter((w) => allowed.has(w.id));
      // 题量 = 今天额度内可做的复习数（+ 到点的学习步）。这就是"界面承诺多少就发多少"。
      dueQuotaSize = plan.dueCards.length;
      // 记下这次会话开始时的额度状态，给进度条用。
      // done = 今天已经复习过的不同词数；limit = 每日上限（可填 20–200）。
      quota = {
        done: plan.reviewedToday,
        limit: plan.reviewLimit,
        deferred: plan.reviewDeferred,
      };
      if (plan.reviewDeferred > 0) {
        toast(`今日复习额度剩 ${plan.dueCards.length} 个，另有 ${plan.reviewDeferred} 个顺延到明天`, 'info', 3500);
      }
    }
    // 干扰项池：用内置词库（够大，才有像样的干扰项）
    const pool = (await vd.sampleLibrary(null, 600)).concat(sessionWords);
    // ⚠️ 「到期复习」这一路的题量必须由**今日额度**直接决定，不能只靠
    //    suggestSize 的 max:40 兜底。原因：那个 40 和默认每日上限 40 撞在一起，
    //    于是在默认配置下"按额度收窄"和"靠 40 兜底"看起来一模一样 ——
    //    一旦用户把上限调成 10，兜底就会给出 40 题，**超发 4 倍**。
    //    （这个坑是做反向验证时才发现的：把收窄那一步删掉，QA 竟然全绿。）
    //    现在题量从同一个 plan 来：界面承诺多少就发多少。
    const size = (source === 'due' && dueQuotaSize !== null)
      ? dueQuotaSize
      : S.suggestSize(source, sessionWords.length, { max: 40 });

    // 整场只用当前选定的那一个模式（见 practiceSetupCard 顶部的模式选择）
    const mode = await currentMode();

    const session = S.createSession({
      source,
      cards: sessionCards,
      words: sessionWords,
      modes: [mode],          // ← 只有一个模式，所以不可能混用
      size,
      now: Date.now(),
      buildQuestions: (ws, o) => Q.buildQuiz(ws, {
        count: ws.length, pool, rand: o.rand, modes: o.modes, keepOrder: o.keepOrder,
      }),
    });

    if (!session.queue.length) { toastWarn('这次没有出成题目，换个来源试试'); return; }

    practice = { session, revealed: false, picked: null, input: '', verdict: null, startedAt: Date.now(), mode, quota };
    activeTab = 'practice';
    await renderShell(root);
    installShortcuts();
  } catch (e) {
    toastError('开始练习失败：' + ((e && e.message) || e));
  }
}

function vd_mistakesToWords(rows) {
  return rows.map((r) => r.word).filter(Boolean);
}

/** 问用户要练哪些等级 */
function askLevels() {
  return new Promise((resolve) => {
    const picked = new Set(['N5', 'N4']);
    const box = el('div');
    for (const lv of vd.LEVEL_ORDER) {
      const cb = el('input', { type: 'checkbox', checked: picked.has(lv) });
      cb.addEventListener('change', () => { if (cb.checked) picked.add(lv); else picked.delete(lv); });
      box.appendChild(el('label', { class: 'checkline' }, [
        cb,
        el('span', { class: 'checkline-text', text: vd.LEVEL_LABEL[lv] || lv }),
      ]));
    }
    const m = modal({
      title: '选择等级',
      body: box,
      buttons: [
        { label: '取消', class: 'btn-ghost', onClick: () => resolve(null) },
        { label: '开始', class: 'btn-primary', onClick: () => resolve([...picked]) },
      ],
    });
    m.root.addEventListener('click', (e) => { if (e.target === m.root) resolve(null); });
  });
}

// ---------------------------------------------------------------------------
// 题目渲染与作答
// ---------------------------------------------------------------------------

async function paintQuestion(root) {
  clear(root);
  const cur = S.currentQuestion(practice.session);
  if (!cur) { await paintSummary(root); return; }

  const q = cur.question;
  const prog = S.progress(practice.session);

  // 进度条
  const bar = el('div', { class: 'progress-fill', style: { width: prog.percent + '%' } });
  // 今日复习额度进度：这一场做完多少、今天总共还剩多少。
  // 为什么要有：一场只有 40 题，而到期总数可能有几百个。
  // 只显示场内的 "12/40" 会让人以为做完这 40 个今天就结束了。
  //
  // 📌 原来这里还有个"不限量"分支（qn.unlimited）。范围改成 20–200 之后
  //    界面已经填不出 0，那个分支永远走不到，删掉了（连 qn.unlimited 这个字段
  //    也一起从下面的快照里去掉了 —— 留着一个永远为 false 的字段同样是误导）。
  const qn = practice.quota;
  const quotaLine = qn
    ? el('span', {
        class: 'practice-count',
        text: `今日额度 ${Math.min(qn.done, qn.limit)}/${qn.limit}`
          + (qn.deferred > 0 ? `　另有 ${qn.deferred} 个顺延到明天` : ''),
      })
    : null;
  root.appendChild(el('div', { class: 'practice' }, [
    el('div', { class: 'practice-bar' }, [
      bar,
      el('span', { class: 'practice-count', text: `${prog.correct}/${prog.total}　正确率 ${prog.accuracy}%` }),
      quotaLine,
      el('button', { class: 'btn btn-sm btn-ghost', onclick: endSession }, '结束'),
    ].filter(Boolean)),
  ]));
  const host = root.firstChild;

  // 题目卡
  const isZhPrompt = q.promptKind === 'zh';
  const promptEl = el('div', {
    class: 'practice-prompt' + (isZhPrompt ? ' is-zh' : ''),
    text: q.prompt,
  });
  const card = el('div', { class: 'practice-card' }, [
    el('div', { class: 'practice-mode', text: (Q.MODES[q.mode] || {}).label || q.mode }),
    promptEl,
    el('div', { class: 'practice-sub', text: q.promptSub || '' }),
  ]);

  if (q.note) card.appendChild(el('div', { class: 'practice-note', text: q.note }));

  // 作答区
  if (practice.revealed) {
    card.appendChild(verdictBlock(q, practice));
    // 答错时停在这里看答案；答对会自动走，但按钮也留着（手快的人可以直接点）
    if (!(practice.verdict && practice.verdict.ok)) {
      card.appendChild(el('div', { class: 'btn-row', style: { justifyContent: 'center' } }, [
        el('button', { class: 'btn btn-primary', onclick: () => continueAfterWrong() }, '继续（Enter）'),
      ]));
    }
  } else if (q.typing || !q.choices || !q.choices.length) {
    // 打字题
    const input = el('input', {
      class: 'input', type: 'text', placeholder: '输入答案后按 Enter',
      autocomplete: 'off', spellcheck: 'false', value: practice.input || '',
      oninput: (e) => { practice.input = e.target.value; },
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); reveal(); } },
    });
    card.appendChild(el('div', { class: 'typing-row' }, [
      input,
      el('button', { class: 'btn btn-primary', onclick: () => reveal() }, '提交'),
    ]));
    setTimeout(() => input.focus(), 40);
  } else {
    // 选择题
    const choices = el('div', { class: 'choices' });
    q.choices.forEach((c, i) => {
      const isJp = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]/.test(c);
      choices.appendChild(el('button', {
        class: 'choice' + (isJp ? ' is-jp' : ''),
        onclick: () => {
          if (practice.revealed) return;
          practice.input = c;
          practice.picked = c;
          reveal();
        },
      }, [
        el('span', { class: 'choice-key', text: String(i + 1) }),
        el('span', { class: 'choice-text', text: c }),
      ]));
    });
    card.appendChild(choices);
  }

  host.appendChild(card);
}

/** 取这个词当前的排程卡（练习中可能刚被更新过） */
function cardFor(session, wordId) {
  return session.cardById.get(wordId) || newCard(wordId, Date.now());
}

/**
 * 答完后的反馈块。
 *
 * 用户明确要求**不要每次选完都蹦评分按钮**，所以这里没有"忘记/想起/太简单"：
 *   · 答错 → 程序已经知道错了，grade 直接定 AGAIN，这个词进错题本；
 *   · 答对 → grade 直接定 GOOD。
 * 反馈块只负责"让你看一眼正确答案"，然后继续。
 */
function verdictBlock(q, st) {
  const ok = st.verdict && st.verdict.ok;
  const box = el('div', { class: 'verdict ' + (ok ? 'is-ok' : 'is-bad') }, [
    el('div', { class: 'verdict-head', text: ok ? '✓ 答对了' : '✗ 答错了，已加入错题本' }),
    el('div', { class: 'verdict-answer', text: q.answer }),
    q.reading && q.reading !== q.answer ? el('div', { class: 'verdict-reading', text: q.reading }) : null,
    el('div', { class: 'verdict-gloss', text: (q.zh || []).join('；') }),
    q.pos && q.pos.length ? el('div', { class: 'word-meta', text: q.pos.join('・') }) : null,
  ].filter(Boolean));

  if (q.example) {
    box.appendChild(el('div', { class: 'verdict-ex' }, [
      el('div', { text: q.example.jp }),
      q.example.zh ? el('div', { class: 'verdict-ex-zh', text: q.example.zh }) : null,
    ].filter(Boolean)));
  }

  // 答错时多给一句"下次什么时候再见"，让人知道进错题本意味着什么；
  // 答对就不必打扰——用户已经答对了，再报一遍间隔只是噪音。
  if (!ok) {
    const card = cardFor(st.session, q.wordId);
    let when = '';
    try { when = humanInterval(schedule(card, GRADE.AGAIN, Date.now()), Date.now()); } catch { when = ''; }
    if (when) box.appendChild(el('div', { class: 'verdict-when', text: `这个词稍后会再考你（${when}）；也可以在错题本里重练` }));
  }

  box.appendChild(el('div', { class: 'verdict-hint', text: ok ? '答对了，继续…' : '按 Enter 继续' }));
  return box;
}

/**
 * 自动评分并推进到下一题。**不需要用户点任何评分按钮。**
 *
 * 口径（与用户确认过）：
 *   答对 → GRADE.GOOD，错题本里该词的连续答对次数 +1
 *   答错 → GRADE.AGAIN，进错题本
 * 错题本里"连续答对 3 次"的词会被 listMistakes 归为已克服，
 * 界面上表现为移出待克服列表——这就是用户要的"选对就直接移出错题本"。
 *
 * 走的是和以前完全相同的 vd.recordAnswer()，只是 grade 由程序决定，
 * 所以 SRS / 历史 / 错题本三处口径不会分叉。
 */
async function gradeAuto(g) {
  // 防重入：答错时"继续"按钮和 Enter 键都能触发，用户手快按两下就会
  // 把同一道题记两次（答错两次 → 错题本计数虚高）。写完之前一律拒绝。
  if (grading) return;
  const st = practice;
  if (!st) return;
  const cur = S.currentQuestion(st.session);
  if (!cur) return;
  grading = true;
  try {
    const q = cur.question;
    const correct = g !== GRADE.AGAIN;

    try {
      // 按等级练的词不在生词本里，就不写 SRS/错题（否则会凭空产生"学过的词"）
      const inVocab = await vd.isInVocab(q.wordId);
      if (inVocab) {
        const r = await vd.recordAnswer({
          wordId: q.wordId, grade: g, mode: q.mode, correct,
          input: st.input, expected: q.answer, now: Date.now(),
        });
        st.session = S.syncCards(st.session, [r.card]);
        // 今日复习额度的本地计数 +1。
        // 口径必须和 vd.reviewedToday() 一致（按**不同词**、只看 review 状态），
        // 否则进度条上的数字会和重开页面后从库里数出来的对不上：
        //   · 答错时 r.card.state 是 relearning —— 那一笔不占额度，所以不加；
        //   · 同一个词在会话里被重排再考一次（requeued）时是 review，
        //     但它已经算过一次了，所以用 asked 集合去重。
        if (practice && practice.quota && r.card && r.card.state === 'review') {
          if (!practice.quota.counted) practice.quota.counted = new Set();
          if (!practice.quota.counted.has(q.wordId)) {
            practice.quota.counted.add(q.wordId);
            practice.quota.done += 1;
          }
        }
      }
    } catch (e) {
      toastError('保存答题记录失败：' + ((e && e.message) || e));
    }

    const out = S.submitAnswer(st.session, {
      grade: g, correct, input: st.input, expected: q.answer, now: Date.now(),
    });
    practice = { ...st, session: out.session, revealed: false, picked: null, input: '', verdict: null, autoTimer: null };

    if (out.requeued) toast('答错了，这个词稍后会再出现', 'warn', 1600);

    const root = mountedRoot;
    if (root) await paintQuestion(root);
  } finally {
    grading = false;
  }
}

/** 揭示答案（判分）→ 自动决定 grade → 答对短暂停留后自动进下一题 */
function reveal() {
  const st = practice;
  if (!st || st.revealed) return;
  const cur = S.currentQuestion(st.session);
  if (!cur) return;
  const q = cur.question;
  const r = Q.checkAnswer(st.input, q, q.answerSide);
  practice = { ...st, revealed: true, verdict: r };
  const root = mountedRoot;
  if (root) paintQuestion(root);

  const g = r.ok ? GRADE.GOOD : GRADE.AGAIN;
  if (r.ok) {
    // 答对了：停 550ms 让人看到"✓"，然后自己走。
    // 有这点延迟，连续答对时的节奏是"点→闪一下→下一题"，
    // 不用每一次都多按一次键。
    const token = Symbol('auto');
    practice = { ...practice, autoTimer: token };
    setTimeout(() => {
      if (practice && practice.autoTimer === token && practice.revealed) gradeAuto(g);
    }, 550);
  }
  // 答错时**不自动跳**：要留时间看正确答案。按 Enter 继续（见快捷键与按钮）。
}

/** 答错后手动继续（Enter / 按钮） */
async function continueAfterWrong() {
  const st = practice;
  if (!st || !st.revealed) return;
  const r = st.verdict;
  await gradeAuto(r && r.ok ? GRADE.GOOD : GRADE.AGAIN);
}

// ---------------------------------------------------------------------------
// 会话小结
// ---------------------------------------------------------------------------

async function paintSummary(root) {
  clear(root);
  const cards = await vd.allCards();
  const sum = S.summarizeSession(practice.session, cards, Date.now());
  const mins = Math.max(1, Math.round(sum.durationMs / 60000));

  root.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, [el('h2', { text: '练习完成' }), el('span', { class: 'badge', text: `用时 ${mins} 分钟` })]),
    el('div', { class: 'grid grid-4' }, [
      stat(String(sum.asked), '作答次数'),
      stat(String(sum.correct), '答对'),
      stat(sum.accuracy + '%', '正确率'),
      stat(String(sum.again), '答错'),
    ]),
    sum.cardStats ? el('div', { class: 'banner banner-info', style: { marginTop: '12px' } }, [
      el('strong', { text: '排程变化：' }),
      el('span', { text: `已记牢 ${sum.cardStats.mature} 个 · 复习中 ${sum.cardStats.review} 个 · 学习中 ${sum.cardStats.learning + sum.cardStats.relearning} 个` }),
    ]) : null,
  ].filter(Boolean)));

  if (sum.wrongWords.length) {
    const box = el('div', { class: 'card' });
    box.appendChild(el('div', { class: 'card-title' }, [el('h3', { text: `这次错的词（${sum.wrongWords.length}）` })]));
    const wrap = el('div', { class: 'table-wrap' });
    const table = el('table', { class: 'table' });
    table.appendChild(el('tr', {}, [el('th', { text: '题目' }), el('th', { text: '正确答案' }), el('th', { text: '模式' })]));
    for (const w of sum.wrongWords) {
      table.appendChild(el('tr', {}, [
        el('td', { class: 'word-term', text: w.prompt }),
        el('td', { class: 'word-term', text: w.answer }),
        el('td', { class: 'word-meta', text: (Q.MODES[w.mode] || {}).label || w.mode }),
      ]));
    }
    wrap.appendChild(table);
    box.appendChild(wrap);
    box.appendChild(el('div', { class: 'btn-row', style: { marginTop: '12px' } }, [
      el('button', { class: 'btn btn-primary', onclick: () => startSession('mistakes') }, '立刻再练这些错词'),
    ]));
  }

  root.appendChild(el('div', { class: 'btn-row' }, [
    el('button', { class: 'btn btn-primary', onclick: () => startSession('due') }, '再练一轮到期'),
    el('button', { class: 'btn', onclick: () => startSession('new') }, '学新词'),
    el('button', {
      class: 'btn btn-ghost',
      onclick: async () => { practice = null; await renderShell(mountedRoot); },
    }, '返回'),
  ]));
}

function stat(num, label) {
  return el('div', { class: 'stat' }, [
    el('div', { class: 'stat-num', text: num }),
    el('div', { class: 'stat-label', text: label }),
  ]);
}

function endSession() {
  const s = practice && practice.session;
  const asked = s ? s.stats.asked : 0;
  if (!asked) { practice = null; renderShell(mountedRoot); return; }
  const finish = () => { practice.session.finished = true; paintSummary(mountedRoot); };
  modal({
    title: '结束本次练习？',
    body: `已经作答 ${asked} 次，还没练完。已作答的记录都已保存，可以现在结束。`,
    buttons: [
      { label: '继续练', class: 'btn-ghost' },
      { label: '结束', class: 'btn-primary', onClick: finish },
    ],
  });
}

// ---------------------------------------------------------------------------
// 快捷键（会话期间生效；destroy 时必须摘掉）
// ---------------------------------------------------------------------------

function installShortcuts() {
  if (keyHandler) document.removeEventListener('keydown', keyHandler);
  keyHandler = (e) => {
    if (activeTab !== 'practice') return;

    // ---- 小测：只有 提交 / 朗读 / 放弃，没有评分键（小测不给自评） ----
    if (testRun) {
      const t = testRun.test;
      if (t.submitted) return;
      const typing = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
      const cur = T.currentQuestion(t);
      if (!cur) return;
      if (e.key === 'Escape') { e.preventDefault(); quitTest(); return; }
      if (e.key === 'Enter') {
        if (typing || cur.question.typing || !cur.question.choices || !cur.question.choices.length) {
          e.preventDefault();
          submitTestQ();
        }
        return;
      }
      if (typing) return;
      const n = Number(e.key);
      if (n >= 1 && n <= (cur.question.choices || []).length) {
        e.preventDefault();
        testRun.input = cur.question.choices[n - 1];
        submitTestQ();
      }
      return;
    }

    if (!practice) return;
    // 输入框里打字时不要抢键（除了 Enter）
    const typing = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
    const cur = S.currentQuestion(practice.session);
    if (!cur) return;

    if (e.key === 'Escape') { e.preventDefault(); endSession(); return; }

    // 已揭示答案：答错时按 Enter 继续；答对会自动走，这里按也是"继续"。
    if (practice.revealed) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        continueAfterWrong();
      }
      return;
    }

    if (e.key === 'Enter') {
      if (typing || cur.question.typing || !cur.question.choices || !cur.question.choices.length) {
        e.preventDefault();
        reveal();
      }
      return;
    }
    if (typing) return;

    // 选择题可以用数字键直接选
    const n = Number(e.key);
    if (n >= 1 && n <= (cur.question.choices || []).length) {
      e.preventDefault();
      practice.input = cur.question.choices[n - 1];
      practice.picked = practice.input;
      reveal();
    }
  };
  document.addEventListener('keydown', keyHandler);
}

// ---------------------------------------------------------------------------
// 词表（生词本管理视角）
// ---------------------------------------------------------------------------

let wordFilter = { q: '', level: '', tag: '', sort: 'recent', state: '' };

async function renderWords(root) {
  const words = await vd.listWords();
  const cards = new Map((await vd.allCards()).map((c) => [c.wordId, c]));
  const tags = await vd.listTags();

  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-title' }, [
    el('h2', { text: '生词本' }),
    el('span', { class: 'badge', text: `${words.length} 个词` }),
  ]));

  // 工具栏
  const search = el('input', {
    class: 'input', type: 'search', placeholder: '搜索词形 / 读音 / 释义…',
    value: wordFilter.q, autocomplete: 'off',
    oninput: (e) => { wordFilter.q = e.target.value; repaint(); },
  });
  const levelSel = el('select', {
    class: 'select',
    onchange: (e) => { wordFilter.level = e.target.value; repaint(); },
  }, [
    el('option', { value: '', text: '全部等级' }),
    ...vd.LEVEL_ORDER.map((lv) => el('option', { value: lv, text: vd.LEVEL_LABEL[lv] || lv, selected: wordFilter.level === lv })),
    el('option', { value: 'custom', text: '导入/自建', selected: wordFilter.level === 'custom' }),
  ]);
  const stateSel = el('select', {
    class: 'select',
    onchange: (e) => { wordFilter.state = e.target.value; repaint(); },
  }, [
    el('option', { value: '', text: '全部状态' }),
    el('option', { value: 'new', text: '未学', selected: wordFilter.state === 'new' }),
    el('option', { value: 'learning', text: '学习中', selected: wordFilter.state === 'learning' }),
    el('option', { value: 'review', text: '复习中', selected: wordFilter.state === 'review' }),
    el('option', { value: 'mature', text: '已记牢', selected: wordFilter.state === 'mature' }),
  ]);
  const tagSel = el('select', {
    class: 'select',
    onchange: (e) => { wordFilter.tag = e.target.value; repaint(); },
  }, [
    el('option', { value: '', text: '全部标签' }),
    ...tags.map((t) => el('option', { value: t.tag, text: `${t.tag} (${t.count})`, selected: wordFilter.tag === t.tag })),
  ]);
  const sortSel = el('select', {
    class: 'select',
    onchange: (e) => { wordFilter.sort = e.target.value; repaint(); },
  }, [
    el('option', { value: 'recent', text: '最近加入', selected: wordFilter.sort === 'recent' }),
    el('option', { value: 'due', text: '最该复习', selected: wordFilter.sort === 'due' }),
    el('option', { value: 'wrong', text: '错误最多', selected: wordFilter.sort === 'wrong' }),
    el('option', { value: 'level', text: '按等级', selected: wordFilter.sort === 'level' }),
    el('option', { value: 'term', text: '按五十音', selected: wordFilter.sort === 'term' }),
  ]);

  card.appendChild(el('div', { class: 'vocab-toolbar' }, [
    search, levelSel, stateSel, tags.length ? tagSel : null, sortSel,
    el('button', { class: 'btn btn-sm', onclick: () => openImportDialog() }, '＋ 导入'),
    el('button', { class: 'btn btn-sm', onclick: () => openLibraryPicker() }, '＋ 加词'),
    el('button', { class: 'btn btn-sm btn-ghost', onclick: () => openLookupFor('') }, '速查'),
    el('button', {
      class: 'btn btn-sm btn-ghost', dataset: { act: 'export' },
      onclick: () => openExportDialog(filterWords(words, cards).map((x) => x.w), words, cards),
    }, '导出 Anki'),
  ].filter(Boolean)));

  const host = el('div');
  card.appendChild(host);
  root.appendChild(card);

  async function repaint() {
    clear(host);
    const list = filterWords(words, cards);
    if (!list.length) {
      host.appendChild(words.length
        ? emptyState('没有符合条件的词', '换一下筛选条件，或清空搜索框。')
        : emptyState('生词本还是空的', '点「＋ 加词」从内置 JLPT 词库里挑，或「＋ 导入」你自己的词表。'));
      return;
    }
    host.appendChild(el('div', { class: 'dim', style: { fontSize: '.82rem', marginBottom: '6px' }, text: `显示 ${list.length} / ${words.length} 个词` }));

    const wrap = el('div', { class: 'table-wrap' });
    const table = el('table', { class: 'table' });
    table.appendChild(el('tr', {}, [
      el('th', { text: '词' }), el('th', { text: '释义' }),
      el('th', { text: '状态' }), el('th', { text: '下次复习' }), el('th', { text: '' }),
    ]));

    for (const { w, card: c } of list) {
      const st = c ? c.state : STATE.NEW;
      const dot = { [STATE.NEW]: 'dot-new', [STATE.LEARNING]: 'dot-learning', [STATE.REVIEW]: 'dot-review', [STATE.RELEARNING]: 'dot-relearning' }[st] || 'dot-new';
      const stateText = { [STATE.NEW]: '未学', [STATE.LEARNING]: '学习中', [STATE.REVIEW]: c && c.interval >= 21 ? '已记牢' : '复习中', [STATE.RELEARNING]: '重学中' }[st] || '未学';

      table.appendChild(el('tr', {}, [
        el('td', {}, [
          el('div', { class: 'word-term', text: w.term }),
          el('div', { class: 'word-reading', text: w.reading || '（无读音）' }),
          w.level ? el('span', { class: 'badge ' + badgeClass(w.level), text: w.level }) : null,
          (w.tags || []).length ? el('span', { class: 'word-meta', text: ' ' + w.tags.map((t) => '#' + t).join(' ') }) : null,
        ].filter(Boolean)),
        el('td', {}, [el('div', { class: 'word-gloss', text: (w.zh || []).slice(0, 3).join('；') || '（无释义）' })]),
        el('td', {}, [el('span', { class: 'word-meta' }, [el('span', { class: 'dot ' + dot }), el('span', { text: stateText })])]),
        el('td', { class: 'word-meta', text: c ? humanInterval(c, Date.now()) : '—' }),
        el('td', {}, [el('div', { class: 'row-actions' }, [
          el('button', { class: 'btn btn-sm btn-ghost', title: '编辑标签', onclick: () => editTags(w) }, '#'),
          el('button', {
            class: 'btn btn-sm btn-ghost', title: '从生词本移除',
            onclick: async () => {
              const ok = await confirmDialog(`把「${w.term}」从生词本移除？\n\n它的排程与错题记录会一并删除，答题历史保留在统计里。`,
                { title: '移除生词', okLabel: '移除', danger: true });
              if (!ok) return;
              await vd.removeWord(w.id);
              toast('已移除：' + w.term, 'info');
              await renderShell(mountedRoot);
            },
          }, '✕'),
        ])]),
      ]));
    }
    wrap.appendChild(table);
    host.appendChild(wrap);

    // 批量操作
    host.appendChild(el('div', { class: 'btn-row', style: { marginTop: '12px' } }, [
      el('button', {
        class: 'btn btn-sm btn-primary',
        onclick: () => startSession(words.length ? 'due' : 'new'),
      }, '开始复习'),
      el('button', {
        class: 'btn btn-sm',
        onclick: async () => {
          const ok = await confirmTwice({
            title: '移除筛选结果里的全部词？',
            message: `将移除当前筛选出的 ${list.length} 个词（含排程与错题记录）。答题历史会保留。此操作前会自动创建快照。`,
            phrase: '确认移除',
            confirmLabel: '移除这些词',
          });
          if (!ok) return;
          await db.makeSnapshot('before-import', '批量移除生词前的自动快照');
          await vd.removeWords(list.map((x) => x.w.id));
          toastOk(`已移除 ${list.length} 个词`);
          await renderShell(mountedRoot);
        },
      }, `移除筛选结果（${list.length}）`),
    ]));
  }

  function filterWords(all, cardMap) {
    const kw = wordFilter.q.trim().toLowerCase();
    let list = all.map((w) => ({ w, card: cardMap.get(w.id) || null }));

    if (kw) {
      list = list.filter(({ w }) =>
        (w.term || '').toLowerCase().includes(kw)
        || (w.reading || '').toLowerCase().includes(kw)
        || (w.zh || []).some((z) => z.toLowerCase().includes(kw))
        || (w.forms || []).some((f) => f.toLowerCase().includes(kw)));
    }
    if (wordFilter.level) {
      list = wordFilter.level === 'custom'
        ? list.filter(({ w }) => !w.level || w.source === 'import')
        : list.filter(({ w }) => w.level === wordFilter.level);
    }
    if (wordFilter.tag) list = list.filter(({ w }) => (w.tags || []).includes(wordFilter.tag));
    if (wordFilter.state) {
      list = list.filter(({ card: c }) => {
        if (wordFilter.state === 'new') return !c || c.state === STATE.NEW;
        if (wordFilter.state === 'learning') return c && (c.state === STATE.LEARNING || c.state === STATE.RELEARNING);
        if (wordFilter.state === 'review') return c && c.state === STATE.REVIEW && c.interval < 21;
        if (wordFilter.state === 'mature') return c && c.state === STATE.REVIEW && c.interval >= 21;
        return true;
      });
    }

    if (wordFilter.sort === 'recent') list.sort((a, b) => (b.w.createdAt || 0) - (a.w.createdAt || 0));
    else if (wordFilter.sort === 'due') {
      // 到期的排前面，其次按 due 时间
      list.sort((a, b) => (a.card ? a.card.due : 0) - (b.card ? b.card.due : 0));
    } else if (wordFilter.sort === 'wrong') list.sort((a, b) => (b.card ? b.card.lapses || 0 : 0) - (a.card ? a.card.lapses || 0 : 0));
    else if (wordFilter.sort === 'level') list.sort((a, b) => vd.LEVEL_ORDER.indexOf(a.w.level) - vd.LEVEL_ORDER.indexOf(b.w.level));
    else if (wordFilter.sort === 'term') list.sort((a, b) => String(a.w.reading || a.w.term).localeCompare(String(b.w.reading || b.w.term), 'ja'));
    return list;
  }

  await repaint();
}

function badgeClass(level) {
  return { N5: 'badge-n5', N4: 'badge-n4', N3: 'badge-n3', N2: 'badge-n2', N1: 'badge-n1' }[level] || '';
}

async function editTags(w) {
  const input = el('input', { class: 'input', value: (w.tags || []).join(' '), placeholder: '用空格分隔，例如：歌词 难记' });
  modal({
    title: `编辑标签：${w.term}`,
    body: el('div', {}, [
      el('div', { class: 'field' }, [el('label', { class: 'field-label', text: '标签' }), input]),
      el('div', { class: 'field-hint', text: '标签用于在词表里筛选，也会在按标签练时用到。' }),
    ]),
    buttons: [
      { label: '取消', class: 'btn-ghost' },
      {
        label: '保存', class: 'btn-primary',
        onClick: async () => {
          const tags = input.value.split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean);
          await vd.setWordTags(w.id, tags);
          toastOk('标签已保存');
          await renderShell(mountedRoot);
        },
      },
    ],
  });
  setTimeout(() => input.focus(), 50);
}

// ---------------------------------------------------------------------------
// 错题本
// ---------------------------------------------------------------------------

async function renderMistakes(root) {
  const rows = await vd.listMistakes({ includeResolved: true });
  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-title' }, [
    el('h2', { text: '错题本' }),
    el('span', { class: 'badge', text: `${rows.length} 个词` }),
  ]));
  card.appendChild(el('p', { class: 'dim', text: '按错误次数排序。答对不会删除记录——它是"曾经错过"的历史，连续答对 3 次会标为「已克服」。' }));

  if (!rows.length) {
    card.appendChild(emptyState('还没有错题', '练习时答错的词会自动进这里。'));
    root.appendChild(card);
    return;
  }

  const unresolved = rows.filter((r) => !r.resolved);
  card.appendChild(el('div', { class: 'btn-row', style: { marginBottom: '12px' } }, [
    el('button', {
      class: 'btn btn-primary',
      disabled: !unresolved.length,
      onclick: () => startSession('mistakes'),
    }, `只练未克服的（${unresolved.length}）`),
  ]));

  const wrap = el('div', { class: 'table-wrap' });
  const table = el('table', { class: 'table' });
  table.appendChild(el('tr', {}, [
    el('th', { text: '错误次数' }), el('th', { text: '词' }), el('th', { text: '释义' }),
    el('th', { text: '最容易错在' }), el('th', { text: '最近错过' }), el('th', { text: '' }),
  ]));

  for (const r of rows) {
    const modes = Object.entries(r.byMode || {}).sort((a, b) => b[1] - a[1]);
    const worstMode = modes.length ? `${(Q.MODES[modes[0][0]] || {}).label || modes[0][0]} ×${modes[0][1]}` : '—';
    table.appendChild(el('tr', {}, [
      el('td', {}, [
        el('span', { style: { fontWeight: '700', color: 'var(--err)' }, text: String(r.wrongCount) }),
        r.resolved ? el('span', { class: 'badge', style: { marginLeft: '6px', background: 'var(--ok-soft)', color: 'var(--ok)' }, text: '已克服' }) : null,
      ].filter(Boolean)),
      el('td', {}, [
        el('div', { class: 'word-term', text: r.word.term }),
        el('div', { class: 'word-reading', text: r.word.reading || '' }),
      ]),
      el('td', { class: 'word-gloss', text: (r.word.zh || []).slice(0, 2).join('；') }),
      el('td', { class: 'word-meta', text: worstMode }),
      el('td', { class: 'word-meta', text: r.lastWrongAt ? humanAgo(new Date(r.lastWrongAt).toISOString()) : '—' }),
      el('td', {}, [el('div', { class: 'row-actions' }, [
        el('button', { class: 'btn btn-sm btn-ghost', title: '查词', onclick: () => openLookupFor(r.word.term) }, '查'),
        el('button', {
          class: 'btn btn-sm btn-ghost', title: '认为已掌握，从错题本移除',
          onclick: async () => {
            const ok = await confirmDialog(`把「${r.word.term}」从错题本移除？\n\n它仍留在生词本与排程里，只是不再出现在错题统计中。`,
              { title: '移除错题记录', okLabel: '移除' });
            if (!ok) return;
            await vd.clearMistake(r.word.id);
            toast('已移出错题本：' + r.word.term, 'info');
            await renderShell(mountedRoot);
          },
        }, '✕'),
      ])]),
    ]));
  }
  wrap.appendChild(table);
  card.appendChild(wrap);

  // 错题按模式的分布：帮助用户发现"是听写不行还是拼写不行"
  const modeTotals = {};
  for (const r of rows) for (const [m, n] of Object.entries(r.byMode || {})) modeTotals[m] = (modeTotals[m] || 0) + n;
  const entries = Object.entries(modeTotals).sort((a, b) => b[1] - a[1]);
  if (entries.length) {
    card.appendChild(el('h3', { text: '错误集中在哪些模式', style: { marginTop: '16px' } }));
    card.appendChild(el('div', { class: 'grid grid-3' },
      entries.map(([m, n]) => stat(String(n), (Q.MODES[m] || {}).label || m))));
  }

  root.appendChild(card);
}

// ---------------------------------------------------------------------------
// 弹窗：内置词库挑词 / 导入词表
// ---------------------------------------------------------------------------

async function openLibraryPicker() {
  const picked = new Set();
  const listHost = el('div', { style: { maxHeight: '46vh', overflow: 'auto', marginTop: '8px' } });
  let level = 'N5';
  let keyword = '';
  let rows = [];
  let page = 0;

  // 每页条数。以前是硬截断前 300 条且不能翻页，看起来就像"词库只有 300 个"。
  // 现在分页 + 「全选筛选结果」，任何数量都能选到。
  const PAGE_SIZE = 100;

  const levelTabs = el('div', { class: 'segmented' });
  for (const lv of vd.LEVEL_ORDER) {
    levelTabs.appendChild(el('button', {
      class: level === lv ? 'active' : '',
      text: vd.LEVEL_LABEL[lv] || lv,
      onclick: async (e) => {
        level = lv; keyword = ''; page = 0;
        for (const b of levelTabs.children) b.classList.remove('active');
        e.target.classList.add('active');
        await load();
      },
    }));
  }

  const search = el('input', {
    class: 'input', type: 'search', placeholder: '在这个等级里搜词…',
    oninput: (e) => { keyword = e.target.value; page = 0; paintList(); },
  });

  const countLabel = el('span', { class: 'word-meta' });
  const pageHost = el('div', { class: 'btn-row', style: { marginTop: '6px' } });
  const pickedLabel = el('span', { class: 'word-meta' });

  /** 当前关键词下的全部匹配项（不分页、不截断） */
  function matched() {
    const kw = keyword.trim();
    if (!kw) return rows;
    return rows.filter((w) => (w.term || '').includes(kw) || (w.reading || '').includes(kw)
      || (w.zh || []).some((z) => z.includes(kw)));
  }

  const m = modal({
    title: '从内置词库加词',
    width: '620px',
    body: el('div', {}, [
      levelTabs,
      el('div', { style: { margin: '10px 0 6px' } }, [search]),
      el('div', { class: 'word-meta', text: '勾选要学的词，点「加入生词本」开始按 SRS 排程。生词本没有数量上限。' }),
      listHost,
      pageHost,
      pickedLabel,
    ]),
    buttons: [
      { label: '取消', class: 'btn-ghost' },
      {
        label: '加入生词本', class: 'btn-primary',
        onClick: async () => {
          if (!picked.size) { toastWarn('还没勾选任何词'); return false; }

          // 大额勾选（「全选这 8000 个」是能点出来的）要两件事：
          //   1. 先确认——一次写 8000 条会让页面卡住十几秒，用户会以为死机了；
          //   2. 分块让出主线程——每 200 条 await 一个宏任务，
          //      这样能看到"正在写入 x/y"，而不是整页冻结。
          const total = picked.size;
          if (total > 300) {
            const okGo = await confirmDialog(
              `要把 ${total} 个词加入生词本？\n\n数量较多，写入需要几秒钟，请等提示出现再离开本页。`,
              { title: '确认批量加入', okLabel: `加入 ${total} 个` });
            if (!okGo) return false;
          }
          const btn = m.foot.querySelector('button.btn-primary');
          const label0 = btn ? btn.textContent : '';
          if (btn) { btn.disabled = true; btn.textContent = `写入中 0/${total}…`; }
          let n = 0, seen = 0;
          try {
            for (const w of rows) {
              if (!picked.has(w.srcId || w.id)) continue;
              const r = await vd.addWord(vd.fromLibWord ? vd.fromLibWord(w) : w, { source: 'library' });
              if (r.created) n++;
              seen++;
              if (btn && (seen % 200 === 0 || seen === total)) {
                btn.textContent = `写入中 ${seen}/${total}…`;
              }
              if (seen % 200 === 0) await new Promise((res) => setTimeout(res, 0));
            }
          } catch (e) {
            if (btn) { btn.disabled = false; btn.textContent = label0; }
            toastError('加入失败（已写入的会保留）：' + ((e && e.message) || e));
            return false;
          }
          toastOk(`已加入 ${n} 个词，可以开始练了`);
          practice = null;
          activeTab = 'today';
          await renderShell(mountedRoot);
        },
      },
    ],
  });

  async function load() {
    listHost.innerHTML = '';
    listHost.appendChild(el('div', { class: 'loading', text: '载入中…' }));
    rows = await vd.libraryByLevel([level]);
    paintList();
  }

  function paintList() {
    listHost.innerHTML = '';
    pageHost.innerHTML = '';
    const all = matched();
    const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    if (page >= pages) page = pages - 1;
    if (page < 0) page = 0;

    const shown = all.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

    countLabel.textContent = all.length === rows.length
      ? `${vd.LEVEL_LABEL[level] || level} 共 ${rows.length} 个`
      : `匹配 ${all.length} 个（本等级共 ${rows.length} 个）`;
    listHost.appendChild(countLabel);
    pickedLabel.textContent = picked.size ? `已勾选 ${picked.size} 个` : '';

    if (!shown.length) {
      listHost.appendChild(emptyState('没有匹配的词', '换个关键词试试。'));
      return;
    }
    for (const w of shown) {
      const id = w.srcId || w.id;
      const cb = el('input', { type: 'checkbox', checked: picked.has(id) });
      cb.addEventListener('change', () => {
        if (cb.checked) picked.add(id); else picked.delete(id);
        pickedLabel.textContent = picked.size ? `已勾选 ${picked.size} 个` : '';
      });
      listHost.appendChild(el('label', { class: 'checkline' }, [
        cb,
        el('span', { class: 'checkline-text' }, [
          el('span', { class: 'word-term', text: w.term }),
          el('span', { class: 'word-reading', text: '　' + (w.reading || '') }),
          el('span', { class: 'checkline-sub', text: (w.zh || []).slice(0, 3).join('；') }),
        ]),
      ]));
    }

    // ---- 翻页 ----
    // 只有真的超过一页时才显示，免得词少的时候多出一排没用的按钮
    if (pages > 1) {
      const prev = el('button', {
        class: 'btn btn-sm', disabled: page === 0,
        onclick: () => { page--; paintList(); listHost.scrollTop = 0; },
      }, '上一页');
      const next = el('button', {
        class: 'btn btn-sm', disabled: page >= pages - 1,
        onclick: () => { page++; paintList(); listHost.scrollTop = 0; },
      }, '下一页');
      pageHost.appendChild(prev);
      pageHost.appendChild(el('span', { class: 'word-meta', style: { alignSelf: 'center' },
        text: `第 ${page + 1} / ${pages} 页（每页 ${PAGE_SIZE} 个）` }));
      pageHost.appendChild(next);
    }

    // ---- 全选 ----
    // 全选的是**当前筛选结果的全部**，不是只有眼前这一页。
    // 这解决了"想加 300 个以上却点不完"的问题。
    pageHost.appendChild(el('button', {
      class: 'btn btn-sm',
      onclick: () => {
        for (const w of all) picked.add(w.srcId || w.id);
        paintList();
      },
    }, `全选这 ${all.length} 个`));
    if (picked.size) {
      pageHost.appendChild(el('button', {
        class: 'btn btn-sm btn-ghost',
        onclick: () => { picked.clear(); paintList(); },
      }, '清空选择'));
    }
  }

  await load();
}

/**
 * 导出到 Anki（TSV / CSV / Markdown）。
 *
 * 设计取舍：
 *   · **默认导出"当前筛选结果"**，不是全部 —— 用户在界面上筛出了 N2 的词，
 *     点导出却拿到全表会很意外。但"只导出错题"这个诉求也很常见，
 *     所以做成两个勾选框，当前状态写清楚，用户随时能改成全部。
 *   · 三种格式并排给出**用途说明**，而不是只写 tsv/csv/md ——
 *     编程小白不知道 TSV 是什么，不知道该选哪个。
 *   · 纯前端下载（Blob + <a>），词表不经过服务端。
 */
function openExportDialog(filteredWords, allWords, cardMap) {
  const onlyFiltered = el('input', { type: 'checkbox', checked: filteredWords.length !== allWords.length });
  const onlyWrong = el('input', { type: 'checkbox' });
  const countHint = el('div', { class: 'field-hint' });

  function currentList() {
    let list = onlyFiltered.checked ? filteredWords : allWords;
    if (onlyWrong.checked) {
      const wrongIds = new Set(list.filter((w) => (cardMap.get(w.id) || {}).wrongCount > 0).map((w) => w.id));
      list = list.filter((w) => wrongIds.has(w.id));
    }
    return list;
  }

  function paint() {
    const n = currentList().length;
    countHint.textContent = n
      ? `将导出 ${n} 个词（共 ${allWords.length} 个）。`
      : '按当前条件没有可导出的词 —— 换个筛选条件，或取消"只导出错题"。';
  }

  function makeFormatButton(fmt, label, primary) {
    return el('button', {
      class: 'btn' + (primary ? ' btn-primary' : ''),
      dataset: { act: 'export-' + fmt },
      onclick: async () => {
        const list = currentList();
        if (!list.length) { toastWarn('没有可导出的词'); return; }
        // 自动附上熟练度与错题标签（用界面上的卡片数据，不用再查一遍库）
        const { rows } = ankiMod.collectFrom(list, cardMap);
        const text = ankiMod.render(rows, fmt, { bom: fmt === 'csv' });
        const filename = ankiMod.exportFilename(fmt);
        const mime = fmt === 'csv' ? 'text/csv;charset=utf-8'
          : (fmt === 'md' ? 'text/markdown;charset=utf-8' : 'text/tab-separated-values;charset=utf-8');
        ankiMod.downloadText(filename, text, mime);
        toastOk(`已导出 ${rows.length} 个词 → ${filename}`);
      },
    }, label);
  }

  for (const box of [onlyFiltered, onlyWrong]) box.addEventListener('change', paint);
  paint();

  modal({
    title: '导出到 Anki',
    width: '560px',
    body: el('div', {}, [
      el('div', { class: 'banner banner-info' }, [
        el('strong', { text: '导出的是你自己的生词本' }),
        el('div', { class: 'banner-hint', text: '文件在你的浏览器里直接生成并下载，不经过任何服务器。' }),
      ]),
      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', text: '导出范围' }),
        el('label', { class: 'checkline' }, [onlyFiltered, el('span', { text: '只导出当前筛选出来的词' })]),
        el('label', { class: 'checkline' }, [onlyWrong, el('span', { text: '只要做错过的词' })]),
        countHint,
      ]),
      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', text: '选一种格式' }),
        el('div', { class: 'btn-row' }, [
          makeFormatButton('tsv', 'TSV（导入 Anki）', true),
          makeFormatButton('csv', 'CSV（Excel 打开）'),
          makeFormatButton('md', 'Markdown（贴笔记）'),
        ]),
        el('div', { class: 'field-hint', text: ankiMod.FORMAT_HINT.tsv }),
        el('div', { class: 'field-hint', text: ankiMod.FORMAT_HINT.csv }),
        el('div', { class: 'field-hint', text: ankiMod.FORMAT_HINT.md }),
      ]),
      el('details', { class: 'field' }, [
        el('summary', { text: '导出的列有哪些？' }),
        el('div', { class: 'field-hint', text: '词形 · 读音 · 释义 · 例句 · 等级 · 标签 · 来源。' }),
        el('div', { class: 'field-hint', text: '导入 Anki 时，把第一列设为"词形"（或你想要的字段名），后面按顺序对应即可。' }),
      ]),
    ]),
    buttons: [{ label: '关闭', class: 'btn-ghost' }],
  });
}

async function openImportDialog() {
  const nameInput = el('input', { class: 'input', placeholder: '词表名字（可留空）' });
  const textarea = el('textarea', {
    class: 'textarea jp',
    placeholder: '每行一个词，支持这些写法：\n\n会う\tあう\t见面\n会う,あう,见面\n会う\n\n第一列是日文词（必需），第二列读音（可留空），后面是中文释义。\n也支持 CSV 表头与 # 注释。',
  });
  const preview = el('div', { style: { marginTop: '10px' } });

  textarea.addEventListener('input', () => {
    const parsed = vd.parseWordList(textarea.value);
    clear(preview);
    if (!textarea.value.trim()) return;
    preview.appendChild(el('div', { class: 'banner banner-info' }, [
      el('strong', { text: `解析到 ${parsed.items.length} 个词` }),
      el('span', { text: `（分隔方式：${parsed.columns}${parsed.skipped.length ? `，跳过 ${parsed.skipped.length} 行` : ''}${parsed.warnings.length ? `，${parsed.warnings.length} 条提醒` : ''}）` }),
    ]));
    if (parsed.items.length) {
      const sample = parsed.items.slice(0, 5);
      const wrap = el('div', { class: 'table-wrap' });
      const t = el('table', { class: 'table' });
      t.appendChild(el('tr', {}, [el('th', { text: '词' }), el('th', { text: '读音' }), el('th', { text: '释义' })]));
      for (const it of sample) {
        t.appendChild(el('tr', {}, [
          el('td', { class: 'word-term', text: it.term }),
          el('td', { class: 'word-reading', text: it.reading || '—' }),
          el('td', { class: 'word-gloss', text: it.zh.join('；') || '—' }),
        ]));
      }
      wrap.appendChild(t);
      preview.appendChild(wrap);
      if (parsed.items.length > 5) {
        preview.appendChild(el('div', { class: 'word-meta', text: `…还有 ${parsed.items.length - 5} 个` }));
      }
    }
    if (parsed.skipped.length) {
      preview.appendChild(el('div', { class: 'banner banner-warn' }, [
        el('strong', { text: '有行被跳过：' }),
        el('div', { class: 'banner-hint', text: parsed.skipped.slice(0, 5).map((s) => `第 ${s.line} 行：${s.reason}`).join('；') }),
      ]));
    }
    if (parsed.warnings.length) {
      preview.appendChild(el('div', { class: 'banner banner-warn' }, [
        el('strong', { text: '提醒：' }),
        el('div', { class: 'banner-hint', text: parsed.warnings.slice(0, 3).map((s) => `第 ${s.line} 行「${s.term}」：${s.msg}`).join('；') }),
      ]));
    }
  });

  // 读取本地文件（纯前端 FileReader，文件不上传）
  const fileInput = el('input', {
    type: 'file', accept: '.txt,.csv,.tsv,.md,text/plain',
    style: { display: 'none' },
    onchange: (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const fr = new FileReader();
      fr.onload = () => {
        textarea.value = String(fr.result || '');
        textarea.dispatchEvent(new Event('input'));
        if (!nameInput.value) nameInput.value = f.name.replace(/\.[^.]+$/, '');
        toastOk(`已读取 ${f.name}`);
      };
      fr.onerror = () => toastError('读取文件失败');
      fr.readAsText(f, 'utf-8');
    },
  });

  modal({
    title: '导入我的词表',
    width: '620px',
    body: el('div', {}, [
      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', text: '词表名字' }), nameInput,
      ]),
      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', text: '内容（粘贴，或从文件读取）' }),
        textarea,
        el('div', { class: 'field-hint', text: '文件只在你本机浏览器里解析，不会上传到任何地方。' }),
      ]),
      el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn btn-sm', onclick: () => fileInput.click() }, '从文件读取'),
        fileInput,
      ]),
      preview,
    ]),
    buttons: [
      { label: '取消', class: 'btn-ghost' },
      {
        label: '导入', class: 'btn-primary',
        onClick: async () => {
          const text = textarea.value;
          if (!text.trim()) { toastWarn('还没有内容'); return false; }
          try {
            const r = await vd.importWordList(text, nameInput.value.trim() || undefined);
            toastOk(`已导入 ${r.total} 个词（新增 ${r.added}）`);
            practice = null;
            activeTab = 'words';
            await renderShell(mountedRoot);
          } catch (e) {
            toastError(String((e && e.message) || e));
            return false;
          }
        },
      },
    ],
  });
}
