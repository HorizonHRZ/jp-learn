/**
 * 小测（纯状态机，不碰 DOM、不碰 IndexedDB）
 *
 * 和 session.js 的"练习"有什么不同？——这是本模块存在的唯一理由：
 *
 *   练习（practice）：一题一答一反馈，答错当场重排队尾，还能自己给自己评
 *                     "忘了/想起来了/太简单"。目标是**记住**。
 *   小测（test）    ：定题量、有计时、**答完才出结果**，中途不给对错提示，
 *                     评分由程序判定（没有自评档）。目标是**检验**。
 *
 * 为什么不能直接复用 session.js：如果小测也走"答错重排队尾"，
 * 题量就不固定了（答错会让题越做越多），"做 20 题得 80 分"这个结论
 * 也就不成立——而"结论可信"恰恰是小测唯一的价值。所以这里刻意
 * **不做 requeue**：一个词只考一次，题量严格等于用户选的题量。
 *
 * 为什么单独一个文件而不是塞进 session.js：本模块是纯计算，可以在 Node 里
 * 把"计时到点自动交卷""题量不足怎么办""错题要能回写错题本"这些
 * 时间相关、边界相关的行为直接跑出来（tools/test-testrun.mjs）。
 */

import { GRADE } from './srs.js';

/** 小测来源 */
export const TEST_SOURCE = {
  level: { id: 'level', label: '按等级', hint: '从选定的 JLPT 级别里抽题' },
  mistakes: { id: 'mistakes', label: '只考错题', hint: '只考错题本里还没克服的词' },
  vocab: { id: 'vocab', label: '考生词本', hint: '从自己的生词本里抽题' },
  mix: { id: 'mix', label: '混合', hint: '生词本 + 错题本 一起抽' },
};

/** 题量预设 */
export const COUNT_PRESETS = [10, 20, 30, 50];

/** 计时预设（分钟，0 = 不计时） */
export const TIME_PRESETS = [0, 5, 10, 15, 20];

/**
 * 从候选词里抽题。
 *
 * 为什么不在这里判"够不够"：来源不同，够不够的标准也不同
 * （错题本里有 3 个词也值得考，不算"不够"）。所以本函数只负责
 * 去重 + 打乱 + 截断，够不够由调用方和小测结果页如实说明。
 *
 * @param {object[]} words 候选词
 * @param {object} opts { count, rand, avoidIds }
 * @returns {object[]}
 */
export function pickTestWords(words, opts = {}) {
  const { count = 20, rand = Math.random, avoidIds = new Set() } = opts;
  const seen = new Set();
  const eligible = [];
  for (const w of words || []) {
    if (!w || !w.id) continue;
    if (avoidIds.has(w.id)) continue;
    if (seen.has(w.id)) continue;   // 同一个词可能同时来自生词本与错题本
    seen.add(w.id);
    eligible.push(w);
  }
  return shuffle(eligible, rand).slice(0, Math.max(0, count));
}

/**
 * Fisher–Yates，不改原数组。
 *
 * 这里对 rand 的返回值做了强制校验，不是多此一举：
 * 只要 rand() 返回的不是数字（比如调用方把"返回随机函数的工厂"直接传了进来），
 * `Math.floor(非数字 * n)` 得到 NaN，用它当下标写数组**不会报错**，
 * 而是静默往数组里塞进 undefined，最后表现为"抽出来的题里有空洞"。
 * 这个症状排查起来非常费劲（实测踩过），所以在源头挡掉。
 */
export function shuffle(arr, rand = Math.random) {
  const a = (arr || []).slice();
  const rnd = () => {
    const v = typeof rand === 'function' ? Number(rand()) : NaN;
    return Number.isFinite(v) ? v : Math.random();
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1)) % (i + 1);
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  // 兜底：任何原因产生了空洞都要剔除，绝不能把 undefined 当题发出去
  return a.filter((x) => x !== undefined && x !== null);
}

/**
 * 创建一次小测。
 *
 * @param {object} p {
 *   id, source, modes, words, count, timeLimitMs, now, rand, buildQuestions
 * }
 * @returns {object} test
 */
export function createTest(p) {
  const {
    id = 'test-' + Math.round(Number(p && p.now) || Date.now()),
    source = 'vocab',
    modes = [],
    words = [],
    count = 20,
    timeLimitMs = 0,
    now = Date.now(),
    rand = Math.random,
    buildQuestions = null,
  } = p || {};

  const picked = pickTestWords(words, { count, rand });
  const questions = buildQuestions
    ? buildQuestions(picked, { modes, rand, count: picked.length, keepOrder: false })
    : [];

  return {
    id,
    source,
    modes,
    count,                       // 用户想要的题量
    timeLimitMs: Math.max(0, Number(timeLimitMs) || 0),
    startedAt: now,
    queue: questions,            // 固定题量：小测**不做**答错重排队尾
    cursor: 0,
    answers: [],
    submitted: false,
    finishedAt: null,
    finished: questions.length === 0,
    // 出题数少于用户要的题量时如实记下来，结果页要说明，
    // 不能假装"20 题"其实只出了 8 题
    requestedCount: count,
    availableCount: picked.length,
  };
}

/** 当前该答的题（无副作用） */
export function currentQuestion(test) {
  if (!test || test.finished || test.submitted) return null;
  const q = test.queue[test.cursor];
  if (!q) return null;
  return {
    question: q,
    index: test.cursor,
    total: test.queue.length,
    remaining: test.queue.length - test.cursor,
  };
}

/**
 * 提交一题的答案（纯函数：返回新对象）。
 *
 * 关键：**不重排队尾**。小测的题量必须严格固定，否则"20 题"这个承诺就是假的。
 * 答错的词靠结果页回顾 + 回写错题本来处理，而不是当场再考一遍——
 * 当场重考会让这题变成"做对了才放你走"，那又退回成练习了。
 */
export function submitTestAnswer(test, p) {
  if (!test) throw new Error('submitTestAnswer 需要 test');
  if (test.submitted) throw new Error('小测已交卷，不能再作答');
  const q = test.queue[test.cursor];
  if (!q) throw new Error('当前没有待答的题');

  const { input = '', ok = false, now = Date.now(), elapsedMs = null } = p || {};

  const next = {
    ...test,
    answers: test.answers.slice(),
  };
  next.answers.push({
    index: test.cursor,
    wordId: q.wordId,
    mode: q.mode,
    level: q.level,
    prompt: q.prompt,
    expected: q.answer,
    input: String(input || ''),
    ok: !!ok,
    at: now,
    ms: elapsedMs === null ? null : Math.max(0, elapsedMs),
  });
  next.cursor = test.cursor + 1;
  next.finished = next.cursor >= next.queue.length;
  if (next.finished) next.finishedAt = now;
  return next;
}

/** 剩余时间（毫秒）。不计时则返回 null。 */
export function remainingMs(test, now = Date.now()) {
  if (!test || !test.timeLimitMs) return null;
  if (test.submitted) return 0;
  return Math.max(0, test.timeLimitMs - (now - test.startedAt));
}

/**
 * 计时是否已到。
 * 到点必须自动交卷——否则用户晾着一个"剩余 00:00"的页面，
 * 这个成绩算不算数就说不清了。
 */
export function isTimeUp(test, now = Date.now()) {
  if (!test || !test.timeLimitMs) return false;
  if (test.submitted) return false;
  return now - test.startedAt >= test.timeLimitMs;
}

/**
 * 交卷并算分（纯函数）。
 *
 * 未作答的题按**错**处理，并单独记 `unanswered` 数量——
 * 如实区分"答错了"和"没来得及答"，这两件事对用户的含义完全不同。
 */
export function finishTest(test, now = Date.now()) {
  if (!test) throw new Error('finishTest 需要 test');
  if (test.submitted) return test;

  const total = test.queue.length;
  const answered = test.answers.length;
  const correct = test.answers.filter((a) => a.ok).length;
  const wrong = answered - correct;
  const unanswered = Math.max(0, total - answered);

  return {
    ...test,
    submitted: true,
    finished: true,
    finishedAt: now,
    result: {
      total,
      asked: total,          // 小测的题量 = 卷面题量（不重排，所以两者相等）
      answered,
      correct,
      wrong,
      unanswered,
      accuracy: total ? Math.round((correct / total) * 1000) / 10 : 0,
      // 只统计已作答的题，用来看"做了的题对了多少"
      answeredAccuracy: answered ? Math.round((correct / answered) * 1000) / 10 : 0,
      timeUsedMs: now - test.startedAt,
      timeout: !!test.timeLimitMs && (now - test.startedAt) >= test.timeLimitMs,
      byMode: tally(test.answers, total, (a) => a.mode),
      byLevel: tally(test.answers, total, (a) => a.level || '未知'),
    },
  };
}

/**
 * 按某个维度统计"答对/答错"。
 *
 * 为什么分母用整卷题量：小测不重排，所以某维度"没出现的题"本来就不该算进来；
 * 这里的分母是该维度**实际出过的题数**（answered 里属于该维度的数量），
 * 而不是整卷题量——否则"听写"只出了 2 题却显示 2/20，会误导。
 */
function tally(answers, total, keyFn) {
  const out = {};
  for (const a of answers) {
    const k = keyFn(a) || '未分类';
    if (!out[k]) out[k] = { key: k, asked: 0, correct: 0, wrong: 0 };
    out[k].asked++;
    if (a.ok) out[k].correct++;
    else out[k].wrong++;
  }
  return out;
}

/**
 * 从未作答的题里列出"漏掉的词"，用于结果页提示"有 N 题没来得及做"。
 */
export function skippedQuestions(test) {
  if (!test) return [];
  const answeredIdx = new Set(test.answers.map((a) => a.index));
  return test.queue
    .map((q, i) => ({ q, i }))
    .filter(({ i }) => !answeredIdx.has(i))
    .map(({ q }) => ({ wordId: q.wordId, prompt: q.prompt, answer: q.answer, mode: q.mode }));
}

/**
 * 结果页要回写 SRS / 错题本时需要的"逐题评分"。
 *
 * 为什么要单独给一份：小测没有自评档，必须由程序定档——
 * 答对记 good，答错记 again。这样回写走的是**和练习完全相同**的
 * recordAnswer() 路径，错题本、历史、SRS 三处的口径不会分叉。
 *
 * @returns {Array<{wordId, mode, grade, correct, input, expected}>}
 */
export function gradesForWriteback(test) {
  if (!test || !test.answers) return [];
  return test.answers.map((a) => ({
    wordId: a.wordId,
    mode: a.mode || 'test',
    grade: a.ok ? GRADE.GOOD : GRADE.AGAIN,
    correct: !!a.ok,
    input: a.input,
    expected: a.expected,
  }));
}

/** 用时格式化（结果页显示） */
export function formatDuration(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m ? `${m} 分 ${r} 秒` : `${r} 秒`;
}
