/**
 * 复习会话（纯状态机，不碰 DOM、不碰 IndexedDB）
 *
 * 为什么把会话逻辑再抽一层：复习流程里最容易出错的是"状态不同步"——
 * 答完一题后队列没刷新、学习步到期的词没重新出现、进度条与实际题量对不上。
 * 这些在浏览器里很难复现和定位。做成纯状态机后，可以在 Node 里
 * 用固定数据把整个会话走一遍（tools/test-session.mjs），包括
 * "答错的词几分钟后要重新出现"这种时间相关的行为。
 *
 * 约定：本模块只做纯计算。读写数据库由调用方（views/vocab.js 或
 * app/js/vocabdata.js）负责，通过注入的回调完成。
 */

import { pickDue, summarize, GRADE, STATE, dayKey, reviewQuotaLeft, reviewLoadAdvice } from './srs.js';

/** 会话来源 */
export const SESSION_SOURCE = {
  due: { id: 'due', label: '到期复习', hint: '按 SRS 排程，今天该复习的词' },
  mistakes: { id: 'mistakes', label: '错题重练', hint: '只练错过、且还没稳定的词' },
  new: { id: 'new', label: '学习新词', hint: '从选定级别里取还没学过的词' },
  reinforce: { id: 'reinforce', label: '记忆加深', hint: '从学过的词里挑最不牢的加重练' },
  level: { id: 'level', label: '按等级练', hint: '从选定级别随机抽词练' },
};

/**
 * 创建一个会话。
 *
 * @param {object} p {
 *   source: 'due'|'mistakes'|'new'|'reinforce'|'level',
 *   cards: object[],      // 可参与排程的卡（due/new/reinforce 用）
 *   words: object[],      // 与 cards 对应的词条（本会话要考的词）
 *   modes: string[],      // 允许的练习模式；空则自动
 *   size: number,         // 本次题量上限
 *   levels: string[],     // level 来源用
 *   now: number,
 *   rand: function,
 *   buildQuestions: (words, opts) => object[],   // 通常注入 quiz.buildQuiz
 * }
 */
export function createSession(p) {
  const {
    source = 'due',
    cards = [],
    words = [],
    modes = [],
    size = 20,
    now = Date.now(),
    rand = Math.random,
    buildQuestions = null,
  } = p || {};

  const wordById = new Map(words.map((w) => [w.id, w]));
  const cardById = new Map(cards.map((c) => [c.wordId, c]));

  // 选出本次要考的词
  let picked = [];
  if (source === 'due') {
    // 到期的排前面（pickDue 已经排好优先级），没到期的作为"提前练"补充
    const dueCards = pickDue(cards, now);
    const dueIds = new Set(dueCards.map((c) => c.wordId));
    picked = dueCards.map((c) => wordById.get(c.wordId)).filter(Boolean);
    if (picked.length < size) {
      const rest = cards
        .filter((c) => !dueIds.has(c.wordId) && c.state !== STATE.NEW)
        .map((c) => wordById.get(c.wordId))
        .filter(Boolean);
      picked = picked.concat(rest);
    }
  } else {
    picked = words.filter(Boolean);
  }

  // 去重（同一个词可能因为多张卡重复进来）
  const seen = new Set();
  picked = picked.filter((w) => (seen.has(w.id) ? false : (seen.add(w.id), true)));

  const take = Math.max(0, Math.min(size, picked.length));
  const selected = picked.slice(0, take);

  const questions = buildQuestions
    ? buildQuestions(selected, { modes, rand, pool: words, count: selected.length, keepOrder: true })
    : [];

  return {
    source,
    modes,
    size,
    startedAt: now,
    // 题目队列：只增不减（答错要重新排队尾，所以用 push 追加）
    queue: questions.map((q, i) => ({ q, seq: i })),
    cursor: 0,
    answers: [],
    // 统计
    stats: { asked: 0, correct: 0, again: 0, good: 0, easy: 0, requeued: 0 },
    wordById,
    cardById,
    finished: questions.length === 0,
  };
}

/**
 * 取当前该答的题。不做副作用。
 * @returns {{question:object, index:number, remaining:number}|null}
 */
export function currentQuestion(session) {
  if (!session || session.finished) return null;
  const item = session.queue[session.cursor];
  if (!item) return null;
  return {
    question: item.q,
    index: session.cursor,
    total: session.queue.length,
    remaining: session.queue.length - session.cursor,
  };
}

/**
 * 提交一个答案，推进会话（纯函数：返回新的 session，不改原对象）。
 *
 * 关键行为：**答错（again）的词会重新排到队尾**。
 * 这是"错题要当场再过一遍"的实现方式。如果不重新入队，
 * 用户答错后这一轮就再也见不到它了，等于白错。
 * 但也不能无限重排——同一个词最多重排 `maxRequeue` 次，
 * 否则一个总记不住的词会让会话永远结束不了。
 *
 * @param {object} session
 * @param {object} p { grade, correct, input, expected, now, maxRequeue }
 * @returns {{session:object, requeued:boolean, card:object|null}}
 */
export function submitAnswer(session, p) {
  const {
    grade, correct = false, input = '', expected = '',
    now = Date.now(), maxRequeue = 2,
  } = p || {};
  if (!session) throw new Error('submitAnswer 需要 session');
  const item = session.queue[session.cursor];
  if (!item) throw new Error('当前没有待答的题');
  if (!grade) throw new Error('submitAnswer 需要 grade');

  const q = item.q;
  const next = {
    ...session,
    queue: session.queue.slice(),
    answers: session.answers.slice(),
    stats: { ...session.stats },
    cardById: new Map(session.cardById),
  };

  next.answers.push({
    wordId: q.wordId, mode: q.mode, grade, correct,
    input, expected, at: now, prompt: q.prompt, answer: q.answer,
  });

  next.stats.asked++;
  if (correct) next.stats.correct++;
  if (grade === GRADE.AGAIN) next.stats.again++;
  else if (grade === GRADE.GOOD) next.stats.good++;
  else if (grade === GRADE.EASY) next.stats.easy++;

  // 答错（或客观判错）→ 重新排队尾，但限制次数
  const shouldRequeue = (!correct || grade === GRADE.AGAIN);
  const requeueCount = next.queue.filter((x) => x.q.wordId === q.wordId && x.requeued).length;
  let requeued = false;
  if (shouldRequeue && requeueCount < maxRequeue) {
    next.queue.push({ q, seq: next.queue.length, requeued: true });
    next.stats.requeued++;
    requeued = true;
  }

  next.cursor = session.cursor + 1;
  next.finished = next.cursor >= next.queue.length;
  return { session: next, requeued, card: null };
}

/**
 * 会话用到的词的当前排程（用于界面显示"下次复习时间"）。
 * 调用方在每次作答后把最新的卡喂进来。
 */
export function syncCards(session, cards) {
  const m = new Map(session.cardById);
  for (const c of cards) m.set(c.wordId, c);
  return { ...session, cardById: m };
}

/**
 * 会话进度（进度条用）。
 *
 * ⚠️ 这里刻意**不用"已答题数/总题数"**。
 * 那个算法有个隐蔽但真实的毛病：答错会把题目重新排到队尾，分子分母同时 +1，
 * 于是一个总也答不对的词会让进度条一路涨到 100% —— 明明什么都没学会，
 * 进度条却在报喜。用户会直接不信任这个进度条。
 *
 * 改成以**答对**为准（掌握度）：
 *   percent = 答对数 / (答对数 + 还剩几道)
 * 答错时答对数不动、剩余数不减（重排进来一道），百分比只会停滞或下降，
 * 如实反映"这一题还没过去"。同时把题数与正确率一并给出去，
 * 让界面可以显示"12/20 · 正确率 80%"这种更完整的信息。
 */
export function progress(session) {
  if (!session) return { done: 0, total: 0, percent: 0, correct: 0, accuracy: 0, remaining: 0, answered: 0 };
  const answered = session.stats.asked;
  const remaining = Math.max(0, session.queue.length - session.cursor);
  const correct = session.stats.correct;
  const total = correct + remaining;
  const percent = total ? Math.round((correct / total) * 100) : 0;
  return {
    done: answered,                 // 已作答次数（含答错重来）
    answered,
    total,                          // 还需要答对多少题才走完（会随重排变化）
    remaining,
    correct,
    percent: Math.min(100, percent),
    accuracy: answered ? Math.round((correct / answered) * 100) : 0,
  };
}

/**
 * 会话小结。
 * @param {object} session
 * @param {object[]} cards 最新排程卡
 */
export function summarizeSession(session, cards = [], now = Date.now()) {
  const s = session ? session.stats : { asked: 0, correct: 0 };
  const acc = s.asked ? Math.round((s.correct / s.asked) * 1000) / 10 : 0;
  const wrongWords = [];
  const seen = new Set();
  for (const a of (session ? session.answers : []).slice().reverse()) {
    if (a.correct && a.grade !== GRADE.AGAIN) continue;
    if (seen.has(a.wordId)) continue;
    seen.add(a.wordId);
    wrongWords.push({ wordId: a.wordId, prompt: a.prompt, answer: a.answer, mode: a.mode });
  }
  return {
    asked: s.asked,
    correct: s.correct,
    again: s.again,
    requeued: s.requeued,
    accuracy: acc,
    durationMs: now - (session ? session.startedAt : now),
    wrongWords,
    cardStats: cards.length ? summarize(cards, now) : null,
  };
}

/**
 * 从排程卡 + 词条算出"今天的学习计划"，
 * 用于背单词页顶部的数字与按钮（新学 / 复习 / 错题）。
 *
 * `newLimit` 是**每天**最多学几个新词（用户可在设置里改，默认 50）。
 * 想统计"今天已经学了几个"，靠的是 `introducedAt`（首次学习时间，由
 * vocabdata.recordAnswer 在卡从 new 转出时写入）。
 *
 * ⚠️ 为什么不能只看 `state !== 'new'` 就算"已学过"来扣减：
 * 那样只能知道"学过"，不知道"哪天学的"，于是每日上限会退化成
 * "每次练习给 N 个"——上午练 20 个、下午再点一次又给 20 个，
 * 用户以为的"每天 20 个"是假的。这正是加 introducedAt 的原因。
 *
 * `reviewLimit` / `reviewedToday` 同理，管的是**复习**的每日额度（默认 40）。
 * 为什么复习也要上限：长期每天到期的量约等于每天新学量的 12 倍
 * （每天学 20 个 → 每天 242 个到期），不设上限就永远做不完。
 * 超出的**顺延到明天**，不改任何排程数据（到期的 due 本来就在过去，明天照样到期）。
 *
 * ⚠️ `dueReviewCount` 和 `reviewToday` 是**两个不同的数**，别混用：
 *   · `dueReviewCount` = 今天到期的**总数**（含今天做不完、要顺延的）—— 用来告知总量；
 *   · `reviewToday`    = 今天**额度内还能做**的个数 —— 用来决定这一场给多少。
 *   混用的后果就是之前那个 bug：按钮写"537 个到期"，点进去只给 40 个，
 *   而且不告诉用户还有 497 个。**界面必须两个都显示。**
 *
 * @param {object[]} cards 全部排程卡
 * @param {object[]} words 全部生词
 * @param {object} opts { newLimit, reviewLimit, reviewedToday, now }
 */
export function buildPlan(cards, words, opts = {}) {
  const {
    newLimit = 50,
    reviewLimit = 50,
    reviewedToday = 0,
    now = Date.now(),
  } = opts;
  const wordIds = new Set(words.map((w) => w.id));
  const live = cards.filter((c) => wordIds.has(c.wordId));
  const s = summarize(live, now);

  // 今天到期的卡，已按优先级排好：逾期最久、错得最多在前（顺序必须保留，
  // 否则"顺延"出来的永远会是随机的一批，而不是最该练的那批）。
  const dueAll = pickDue(live, now, { limit: 0 }).filter((c) => c.state !== STATE.NEW);
  // 其中**占每日额度**的那部分：只有天级复习占；
  // learning/relearning（分钟级的学习步）不占，见下面 freeCards 的说明。
  const dueReviewPool = dueAll.filter((c) => c.state === STATE.REVIEW);

  // 今天到期的复习（只算占额度的天级复习），按额度裁剪
  const left = reviewQuotaLeft(reviewLimit, reviewedToday);
  const unlimited = !Number.isFinite(left);
  const dueReview = unlimited ? dueReviewPool : dueReviewPool.slice(0, left);

  // 今天已经学过几个新词：只看"学过且首次学习时间落在今天"的卡。
  const today = dayKey(now);
  const introducedToday = live.filter(
    (c) => c.introducedAt && dayKey(c.introducedAt) === today
  ).length;

  const remainingNew = Math.max(0, newLimit - introducedToday);
  const stillNew = live.filter((c) => c.state === STATE.NEW);
  const newCards = stillNew.slice(0, remainingNew);

  // 顺延到明天的**天级复习**个数（今天额度用完了但还有到期）
  // ⚠️ 必须只算 dueReviewPool，不能算 dueAll —— dueAll 里还含免费放行的学习步，
  //    把它们算进"顺延"会让这个数字虚高（第一版就是这么错的，被测试抓到了）。
  const reviewDeferred = Math.max(0, dueReviewPool.length - dueReview.length);

  // ⚠️ 学习步/重学步（分钟级）必须**免费放行**，不能也被每日复习额度裁掉。
  //
  // 为什么：刚学的词会在 1 分钟 / 10 分钟后各要考一次（learningSteps [1,10]），
  // 这两步走完才算"毕业"进入天级复习。如果把它们和天级复习一起按额度裁，
  // 会出现一个很糟的后果 —— 今天新学的词到了 10 分钟该考第二遍时，
  // 额度可能已经用完，于是这一步被裁掉，那些词**永远毕业不了**，
  // 一直卡在 learning 状态里。这不是"少考一次"，是功能性坏掉。
  //
  // 语义上也说得通：额度管的是"复习负担"，而学习步是"新词入门的必修过程"，
  // 它本来就该跟着新词额度走（新词额度已经限制了每天入门几个）。
  // countsAgainstDailyReview() 里也写了同一条规则，两处保持一致。
  const freeCards = dueAll.filter(
    (c) => c.state === STATE.LEARNING || c.state === STATE.RELEARNING
  );

  // 上限够不够用？（要不要提醒用户"这么配会永远做不完"）
  // 只用"新学量"和"上限"两个数字判断，不看当前积压 —— 这样在还没积压起来
  // 的时候就能提前提醒，而不是等堆到几百个才说。
  const loadAdvice = reviewLoadAdvice(reviewLimit, newLimit);

  return {
    ...s,
    /** 今天到期的复习总数（只含占额度的天级复习，含要顺延的）—— 用来告知总量 */
    dueReviewCount: dueReviewPool.length,
    /** 今天额度内可以做的复习个数 —— 用来决定这一场给多少 */
    reviewToday: dueReview.length,
    /** 今天到期的学习步/重学步个数（不占额度，免费放行） */
    freeToday: freeCards.length,
    /** 今天已复习的不同词数 */
    reviewedToday,
    /** 每日复习上限（0 = 不限量） */
    reviewLimit,
    /** 是否不限量 */
    reviewUnlimited: unlimited,
    /** 超出今天额度、顺延到明天的个数 */
    reviewDeferred,
    /** 长期负担建议：{ok, recommended} —— false 表示这个上限配这个新学量必然积压 */
    reviewLoadAdvice: loadAdvice,
    /** 今天的复习额度是否已用完（还有到期但今天不再给了） */
    reviewQuotaUsedUp: !unlimited && dueReviewPool.length > 0 && dueReview.length === 0,
    newAvailable: stillNew.length,
    newToday: newCards.length,
    // 界面要显示"今天还剩几个新词额度"，以及"上限是多少"
    introducedToday,
    newLimit,
    remainingNew,
    /** 今天的新词额度用完了（还有没学的新词，但不再给了） */
    newQuotaUsedUp: stillNew.length > 0 && remainingNew === 0,
    /**
     * 今天"到期复习"这一路该发的全部卡 = 额度内的天级复习 + 免费放行的学习步/重学步。
     * ⚠️ 调用方（views/vocab.js）必须用**这个**当白名单去收窄卡池，
     *    不要只用 dueCards —— 否则今天新学的词到点该考第二步时会被裁掉，
     *    永远毕业不了（详见上面 freeCards 那段注释）。
     */
    dueCards: dueReview.concat(freeCards),
    newCards,
    // 今天还有活干吗（额度用完但还有到期的复习也算"有活"要提示，见 hasWork 的用法）
    hasWork: dueReview.length > 0 || freeCards.length > 0 || newCards.length > 0,
  };
}

/** 给"到期复习"来源算一个默认题量：到期多少就练多少，但有上限 */
export function suggestSize(source, dueCount, opts = {}) {
  const { max = 60, min = 5 } = opts;
  if (source === 'due') return Math.min(max, Math.max(0, dueCount));
  if (source === 'mistakes') return Math.min(max, Math.max(min, dueCount));
  return 20;
}
