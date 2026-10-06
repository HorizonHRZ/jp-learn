/**
 * SRS 间隔重复排程（纯函数，不碰 DOM、不碰 IndexedDB）
 *
 * 为什么单独一个文件、且写成纯函数：
 *   排程算法错了会直接毁掉用户的复习计划，而且症状很隐蔽（几天后才显现）。
 *   所以把它做成无副作用的纯函数，好在 Node 里直接跑单元测试
 *   （tools/test-srs.mjs），不需要开浏览器。
 *
 * 算法：参考 SM-2 / Anki 的思路，但做了简化，理由逐条写在下面。
 *   · 只有三档评分：again（忘了）/ good（想起来了）/ easy（太简单）
 *     —— 四档五档对自学者是负担，"模糊"和"困难"在实际使用中很难区分，
 *        而且用户还要先理解这些档位的差别，反而降低坚持率。
 *   · interval 用"上次间隔 × 难度系数"推进，配一个 ease（难度因子）微调。
 *   · 遗忘时 interval 退回重学步（分钟级），但 ease 只小幅下调、有下限，
 *     避免一次手滑就把一个词的 ease 永久打死（Anki 的老问题）。
 *   · 记录 lapses（遗忘次数）：错题本和"记忆加深"都用它排序。
 *
 * 时间单位：全部用毫秒时间戳（Date.now() 同量纲），便于存 IndexedDB 和比较。
 *
 * ⚠️ 时区一致性（踩过的坑）：
 *   所有日期算术一律走 UTC。曾经混用过「本地时间 getFullYear()」和
 *   「UTC 毫秒加法」，在 UTC+8 下算出来的一天比实际偏移 8 小时，
 *   导致 dayKey 的换日边界完全错位（当时表现为"分桶对不上"）。
 *   统一规则：时间戳 → UTC 日历 → 减 dayStartHour → 取 UTC 年月日。
 *   代价是"一天"的边界固定在世界时 = dayStartHour（0 点即 UTC 00:00，
 *   北京时间为当天 08:00）——这是为了确定性刻意接受的取舍，
 *   对 SRS 排程与"今天新学了几个"的额度统计都已足够。
 */

export const DAY = 24 * 60 * 60 * 1000;
export const MINUTE = 60 * 1000;

/** 学习状态机：new（没学过）→ learning（刚认识，分钟级）→ review（天级）→ relearning（忘过，分钟级） */
export const STATE = {
  NEW: 'new',
  LEARNING: 'learning',
  REVIEW: 'review',
  RELEARNING: 'relearning',
};

/**
 * 复习状态的卡才占"每日复习额度"；学习步/重学步（分钟级）不占。
 * 语义：上限是"每天最多复习几个**不同的词**"。
 * 为什么：错词在会话里会被重排再考一次，那是"一次复习里的重复"，
 * 不该吃掉两份额度；而学习步本来就是新词入门的必修过程，不算"复习负担"。
 */
export function countsAgainstDailyReview(card) {
  return !!(card && card.state === STATE.REVIEW);
}

/**
 * 一天还剩多少复习额度。
 *
 * @param {number} limit dailyReviewLimit；0 = 不限量（返回 Infinity 语义）
 * @param {number} doneToday 今天已经复习过的**不同词**的个数
 * @returns {number} 剩余可复习个数；limit<=0 时返回 Infinity（没上限）
 */
export function reviewQuotaLeft(limit, doneToday) {
  const cap = Number(limit);
  if (!Number.isFinite(cap) || cap <= 0) return Infinity;
  return Math.max(0, cap - (Number(doneToday) || 0));
}

/**
 * 把到期复习按"今天的额度"裁剪：只留今天能做的，其余顺延（不丢词）。
 *
 * 顺延为什么不用改排程：到期的卡 due 本来就在过去，明天 `isDue` 照样为真，
 * 所以"今天没做"的卡明天自动还在队列里 —— 一个都不会漏。
 * 这里只负责"今天取哪几个"，顺序沿用 pickDue 的优先级（逾期最久、错得最多在前）。
 *
 * @param {object[]} dueCards 已经按优先级排好的到期复习卡
 * @param {number} limit dailyReviewLimit；0 = 不限量
 * @param {number} doneToday 今天已复习的不同词数
 * @returns {object[]} 今天要做的卡
 */
export function capByDailyReview(dueCards, limit, doneToday) {
  const left = reviewQuotaLeft(limit, doneToday);
  if (!Number.isFinite(left)) return dueCards;
  return (dueCards || []).slice(0, left);
}

/**
 * 长期复习负担的杠杆倍数（实测值，不是拍的）。
 *
 * 含义：**每天新学 g 个词，长期稳定下来每天会有约 12g 个词到期。**
 * 这个 12 是有内在原因的：一个词从"第一次学"到"基本记牢"大约要被复习
 * 12 次左右（1天→3天→7天→17天→41天→…），而这些复习摊在约一年的学习期里。
 *
 * 实测（tools/test-srs.mjs 的长期模拟，正确率 85%，跑 730 天）：
 *   每天学 10 个 → 每天 122 个到期（12.2 倍）
 *   每天学 20 个 → 每天 242 个到期（12.1 倍）
 *   每天学  5 个 → 每天  60 个到期（12.0 倍）
 *
 * ⚠️ 为什么必须知道这个数：**如果每日复习上限小于 12 × 每天新学量，
 * 到期队列会永远增长、永远清不完。** 这不是 bug，是数学 ——
 * 每天灌进来 12g 个、只消化 cap 个，差额必然越积越多。
 * 实测：每天新学 10 个、上限 40 时，两年后积压 5,958 个、只有 2,460 个词记牢；
 * 同样条件上限 150 时，积压 0、6,966 个记牢。
 * 换句话说：**上限设太小不是"少做点"，是"永远做不完 + 学习效果显著变差"。**
 *
 * 所以界面上要主动提示（只提示，不擅自改用户的设置）：
 * 当上限 < 12 × 每天新学量时，告诉用户"要么把上限调大，要么把新词减下来"。
 */
export const REVIEW_LEVERAGE = 12;

/**
 * 按"每天新学量"算出能长期不积压的复习上限参考值。
 * @param {number} newPerDay 每天新学几个词
 * @returns {number} 建议的每日复习上限（约 12 倍）
 */
export function recommendedReviewLimit(newPerDay) {
  const g = Number(newPerDay);
  if (!Number.isFinite(g) || g <= 0) return 0;
  return Math.round(g * REVIEW_LEVERAGE);
}

/**
 * 这个上限配这个新学量，长期能不能不积压？
 *
 * @param {number} reviewLimit 每日复习上限；0 = 不限量
 * @param {number} newPerDay 每天新学几个词
 * @returns {{ok:boolean, recommended:number}}
 *   ok=true 表示上限够用（或本来就不限量）；false 表示必然积压
 */
export function reviewLoadAdvice(reviewLimit, newPerDay) {
  const rec = recommendedReviewLimit(newPerDay);
  const cap = Number(reviewLimit);
  if (!Number.isFinite(cap) || cap <= 0) return { ok: true, recommended: rec };
  if (rec === 0) return { ok: true, recommended: rec };
  return { ok: cap >= rec, recommended: rec };
}

/** 三档评分 */
export const GRADE = {
  AGAIN: 'again',
  GOOD: 'good',
  EASY: 'easy',
};

/** 默认参数（可被 settings 覆盖，但默认值必须写死在这里以便测试） */
export const DEFAULT_CONFIG = {
  // 学习步（分钟）：新词先按这个节奏过一遍
  learningSteps: [1, 10],
  // 重学步（分钟）：忘了之后重新走
  relearningSteps: [10],
  // 毕业间隔（天）：走出学习步之后的第一个天级间隔
  graduatingInterval: 1,
  // 简单档毕业间隔（天）
  easyInterval: 4,
  // 初始难度因子
  startingEase: 2.5,
  // ease 调整量
  easyBonus: 0.15,      // 点"太简单"：ease 上调
  hardPenalty: 0.2,     // 遗忘：ease 下调
  // ease 上下限：下限防止一个词被打死，上限防止间隔爆炸
  minEase: 1.3,
  maxEase: 3.0,
  // 复习状态下的间隔倍率
  goodMultiplier: 1.0,  // 正常：interval × ease
  easyMultiplier: 1.3,  // 简单：再乘一点
  // 最大间隔（天）：约 5 年，再长没意义（用户早就重新学了）
  maxInterval: 365 * 5,
  // 遗忘后回到复习状态时的间隔压缩比例
  lapseIntervalRatio: 0.0,   // 0 = 回到重学步，不走天级
  // 一天的开始时间（小时）：凌晨 4 点前算前一天，符合熬夜学习者的直觉
  dayStartHour: 4,
};

/**
 * 把毫秒时间戳归到"哪一天"（用于复习计划与"今天新学了几个"的额度统计）。
 *
 * 采用可配置的 dayStartHour：凌晨 4 点前算前一天，
 * 否则熬夜到 1 点学习会被算成第二天，额度就白 reset 了。
 *
 * ⚠️ 这里必须用**本地时间**，不能用 getUTC* （踩过的坑，别改回去）：
 *   之前写的是 `new Date(ts - dayStartHour*3600e3)` 再取 getUTC*，
 *   那等于把边界钉在 UTC 的 4 点。在 UTC+8（北京时间）下，
 *   UTC 04:00 就是北京 12:00 —— 于是"每日新词额度"直到**中午**才重置，
 *   上午学习的人会觉得额度不对。修法是把"减掉的 4 小时"也放在本地日历上算。
 *
 *   旧注释担心"本地时间与 forecast() 的 UTC 毫秒加法对不上"——
 *   现在 forecast() 是 `dayKey(now + i*DAY)` 逐日推算，日历算在 dayKey 内部完成，
 *   两边不再混用，这个担心已经不成立了。
 *
 * @returns {string} 'YYYY-MM-DD'（本地日历日）
 */
export function dayKey(ts, dayStartHour = DEFAULT_CONFIG.dayStartHour) {
  // 减掉 dayStartHour 小时后取本地日历年月日 —— 边界就是本地时间 dayStartHour 点
  const d = new Date(ts - dayStartHour * 60 * 60 * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * 新建一个词条的排程记录。
 * @param {string} wordId
 * @param {number} now 毫秒时间戳
 */
export function newCard(wordId, now = Date.now()) {
  return {
    wordId,
    state: STATE.NEW,
    // 学习步进度：走完了第几步
    step: 0,
    ease: DEFAULT_CONFIG.startingEase,
    interval: 0,          // 当前间隔（天）；学习状态为 0
    due: now,             // 立刻可学
    lapses: 0,            // 遗忘次数（错题本/加权排序用）
    reps: 0,              // 总作答次数
    lastGrade: null,
    lastAt: null,
    firstAt: null,
    // 首次"学"这个词的时间（从 new 转出时写入）。
    // 与 firstAt 的区别：firstAt 是第一次**作答**时间，
    // introducedAt 只在这张卡第一次被学过时写一次，之后永不改变。
    // 每日新词上限靠它统计，见 vocabdata.recordAnswer。
    introducedAt: null,
  };
}

/** 取配置项，缺省回退到 DEFAULT_CONFIG */
function cfg(config, key) {
  const v = config && config[key];
  return v === undefined || v === null ? DEFAULT_CONFIG[key] : v;
}

/** 夹在 [lo, hi] 之间 */
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 记一次遗忘：lapses +1 且 ease 下调（带回下限）。
 *
 * 为什么抽成一个函数：曾经只在"天级复习"分支里写这段，
 * 结果学习步/重学步里再次点"忘了"时 lapses 不增、ease 不降，
 * 一个总也记不住的词反而显示得跟容易词一样。三处必须走同一段逻辑。
 * 错题本排序和"记忆加深"加权都依赖 lapses 的准确性。
 */
function applyLapse(c, config) {
  c.lapses = (c.lapses || 0) + 1;
  c.ease = clamp(
    (c.ease || cfg(config, 'startingEase')) - cfg(config, 'hardPenalty'),
    cfg(config, 'minEase'),
    cfg(config, 'maxEase'),
  );
}

/**
 * 核心：根据用户评分算出新的排程状态。
 *
 * @param {object} card   现有排程记录（不会被打散，返回新对象）
 * @param {string} grade  GRADE 之一
 * @param {number} now    毫秒时间戳
 * @param {object} config 可选配置覆盖
 * @returns {object} 新的排程记录
 */
export function schedule(card, grade, now = Date.now(), config = null) {
  if (!card || !card.wordId) throw new Error('schedule() 需要一个带 wordId 的排程记录');
  if (!Object.values(GRADE).includes(grade)) throw new Error(`未知评分：${grade}`);

  const c = { ...card };
  const ease = clamp(
    c.ease || cfg(config, 'startingEase'),
    cfg(config, 'minEase'),
    cfg(config, 'maxEase'),
  );

  c.reps = (c.reps || 0) + 1;
  c.lastGrade = grade;
  c.lastAt = now;
  if (!c.firstAt) c.firstAt = now;
  c.ease = ease;

  const learningSteps = cfg(config, 'learningSteps');
  const relearningSteps = cfg(config, 'relearningSteps');
  const step = c.step || 0;

  // ---- 情况一：新词 / 学习中的词（分钟级） ----
  if (c.state === STATE.NEW || c.state === STATE.LEARNING) {
    if (grade === GRADE.AGAIN) {
      // 回到学习步第一步，立刻重来。学习步里也算一次遗忘：
      // 新词第一次没答出来同样应该在错题本里留痕。
      applyLapse(c, config);
      c.state = STATE.LEARNING;
      c.step = 0;
      c.interval = 0;
      c.due = now + learningSteps[0] * MINUTE;
      return c;
    }
    if (grade === GRADE.EASY) {
      // 直接毕业
      c.state = STATE.REVIEW;
      c.step = 0;
      c.interval = cfg(config, 'easyInterval');
      c.due = now + c.interval * DAY;
      return c;
    }
    // GOOD：走下一个学习步
    const nextStep = step + 1;
    if (nextStep >= learningSteps.length) {
      // 学习步走完 → 毕业进入天级复习
      c.state = STATE.REVIEW;
      c.step = 0;
      c.interval = cfg(config, 'graduatingInterval');
      c.due = now + c.interval * DAY;
      return c;
    }
    c.state = STATE.LEARNING;
    c.step = nextStep;
    c.interval = 0;
    c.due = now + learningSteps[nextStep] * MINUTE;
    return c;
  }

  // ---- 情况二：重学中（忘过之后，分钟级） ----
  if (c.state === STATE.RELEARNING) {
    if (grade === GRADE.AGAIN) {
      applyLapse(c, config);
      c.step = 0;
      c.due = now + relearningSteps[0] * MINUTE;
      return c;
    }
    // GOOD / EASY：走出重学，回到天级。
    // 注意这里用"遗忘前的间隔 × 比例"而不是回到毕业间隔：
    // 一个已经复习到 60 天的词不该因为忘一次就退回 1 天。
    const nextStep = step + 1;
    if (grade === GRADE.GOOD && nextStep < relearningSteps.length) {
      c.step = nextStep;
      c.due = now + relearningSteps[nextStep] * MINUTE;
      return c;
    }
    c.state = STATE.REVIEW;
    c.step = 0;
    const base = Math.max(1, Math.round((c.interval || 1) * 0.5));
    c.interval = clamp(base, 1, cfg(config, 'maxInterval'));
    c.due = now + c.interval * DAY;
    return c;
  }

  // ---- 情况三：天级复习中的词 ----
  if (grade === GRADE.AGAIN) {
    // 忘了：记一次遗忘，回到重学步
    applyLapse(c, config);
    c.state = STATE.RELEARNING;
    c.step = 0;
    // interval 保留（走出重学时按比例压缩），不要清零
    c.due = now + relearningSteps[0] * MINUTE;
    return c;
  }

  if (grade === GRADE.EASY) {
    c.ease = clamp(ease + cfg(config, 'easyBonus'), cfg(config, 'minEase'), cfg(config, 'maxEase'));
    const grown = (c.interval || 1) * c.ease * cfg(config, 'easyMultiplier');
    c.interval = clamp(Math.round(grown), 1, cfg(config, 'maxInterval'));
    c.due = now + c.interval * DAY;
    return c;
  }

  // GOOD：正常推进
  const grown = (c.interval || 1) * c.ease * cfg(config, 'goodMultiplier');
  // 至少 +1 天，否则间隔会卡住不动
  c.interval = clamp(Math.max(Math.round(grown), (c.interval || 0) + 1), 1, cfg(config, 'maxInterval'));
  c.due = now + c.interval * DAY;
  return c;
}

/**
 * 一个词现在该不该复习。
 * @param {object} card
 * @param {number} now
 */
export function isDue(card, now = Date.now()) {
  if (!card) return false;
  return (card.due || 0) <= now;
}

/**
 * 从一堆排程记录里挑出"现在该复习的"，并按优先级排序。
 *
 * 排序理由：
 *   1. 已逾期的排在前（逾期越久越靠前，避免积压）
 *   2. 同逾期程度时，遗忘次数多的优先（这些是真正的难点）
 *   3. 学习/重学状态的优先于复习状态（分钟级的步骤不能拖）
 *
 * @param {object[]} cards
 * @param {number} now
 * @param {object} opts { includeFuture:boolean, limit:number }
 */
export function pickDue(cards, now = Date.now(), opts = {}) {
  const { includeFuture = false, limit = 0 } = opts;
  const pool = (cards || []).filter((c) => c && (includeFuture || isDue(c, now)));

  const rank = (s) => (s === STATE.LEARNING || s === STATE.RELEARNING ? 0 : s === STATE.NEW ? 1 : 2);
  pool.sort((a, b) => {
    const r = rank(a.state) - rank(b.state);
    if (r !== 0) return r;
    const od = (a.due || 0) - (b.due || 0);          // 越早到期越靠前
    if (od !== 0) return od;
    return (b.lapses || 0) - (a.lapses || 0);        // 错得多的靠前
  });

  return limit > 0 ? pool.slice(0, limit) : pool;
}

/**
 * "记忆加深"加权：给一组词按需要加强的程度打分，分数越高越该练。
 *
 * 用于"记忆加深"模式 —— 从已学过的词里挑最不牢的重新练。
 * 打分依据（都在 cards 里有现成数据）：
 *   · 遗忘次数 lapses：主要因素
 *   · 距上次作答越久：次要因素（久没碰过的容易忘）
 *   · 间隔越短说明越不牢：轻微因素
 *   · 最近一次评分是 again：额外加分（刚忘过，最该巩固）
 *
 * @returns {Array<{card:object, score:number}>} 降序
 */
export function weightForReinforce(cards, now = Date.now()) {
  const out = [];
  for (const c of cards || []) {
    if (!c || !c.wordId) continue;
    if (c.state === STATE.NEW) continue;          // 没学过的词不属于"加深"

    let score = 0;
    score += (c.lapses || 0) * 10;                                    // 遗忘次数：权重最高
    if (c.lastGrade === GRADE.AGAIN) score += 8;                      // 刚忘过
    const daysSince = c.lastAt ? (now - c.lastAt) / DAY : 0;
    score += Math.min(daysSince, 60) * 0.5;                           // 生疏度，封顶 60 天
    if (c.interval && c.interval < 7) score += (7 - c.interval) * 0.8; // 间隔短 = 还不牢
    score += (cfg(null, 'maxEase') - (c.ease || 0)) * 2;              // ease 低 = 难词

    out.push({ card: c, score: Math.round(score * 100) / 100 });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * 复习预测：从任意时刻起，未来若干天每天要复习多少词。
 * 用于首页/统计页给用户一个心理预期（"明天有 40 个"）。
 *
 * 注意：这只是**当前**排程的静态预测。用户今天答对/答错会改变后续排程，
 * 所以它是参考值，不是承诺。UI 上要如实说明。
 *
 * @param {object[]} cards
 * @param {number} now
 * @param {number} days
 * @returns {Array<{day:string, count:number}>}
 */
export function forecast(cards, now = Date.now(), days = 30) {
  const buckets = new Map();
  for (let i = 0; i < days; i++) buckets.set(dayKey(now + i * DAY), 0);
  const overdueKey = dayKey(now);
  for (const c of cards || []) {
    if (!c || !c.due) continue;
    // 逾期的都算"今天"
    const key = c.due <= now ? overdueKey : dayKey(c.due);
    if (buckets.has(key)) buckets.set(key, buckets.get(key) + 1);
  }
  return [...buckets.entries()].map(([day, count]) => ({ day, count }));
}

/** 统计一组排程记录的概况（首页/统计页用） */
export function summarize(cards, now = Date.now()) {
  const s = {
    total: 0, new: 0, learning: 0, review: 0, relearning: 0,
    due: 0, dueNew: 0, dueReview: 0,
    mature: 0,        // interval >= 21 天（"成熟"卡片，Anki 的惯例）
    young: 0,         // 0 < interval < 21
    avgEase: 0, totalLapses: 0,
  };
  let easeSum = 0;
  for (const c of cards || []) {
    if (!c) continue;
    s.total++;
    if (c.state === STATE.NEW) s.new++;
    else if (c.state === STATE.LEARNING) s.learning++;
    else if (c.state === STATE.RELEARNING) s.relearning++;
    else if (c.state === STATE.REVIEW) s.review++;
    if (c.interval >= 21) s.mature++;
    else if (c.interval > 0) s.young++;
    if (isDue(c, now)) {
      s.due++;
      if (c.state === STATE.NEW) s.dueNew++;
      else s.dueReview++;
    }
    easeSum += c.ease || 0;
    s.totalLapses += c.lapses || 0;
  }
  s.avgEase = s.total ? Math.round((easeSum / s.total) * 100) / 100 : 0;
  return s;
}

/** 把毫秒间隔说成人话，UI 直接用 */
export function humanInterval(card, now = Date.now()) {
  if (!card) return '—';
  const ms = (card.due || 0) - now;
  if (card.state === STATE.NEW) return '新词';
  if (ms <= 0) {
    const over = -ms;
    if (over < 60 * MINUTE) return '现在';
    if (over < DAY) return `逾期 ${Math.round(over / (60 * MINUTE))} 小时`;
    return `逾期 ${Math.round(over / DAY)} 天`;
  }
  if (ms < 60 * MINUTE) return `${Math.max(1, Math.round(ms / MINUTE))} 分钟后`;
  if (ms < DAY) return `${Math.round(ms / (60 * MINUTE))} 小时后`;
  const d = Math.round(ms / DAY);
  if (d < 30) return `${d} 天后`;
  if (d < 365) return `${Math.round(d / 30)} 个月后`;
  return `${(d / 365).toFixed(1)} 年后`;
}

/**
 * 模拟一段时间的学习，用来检查参数是否合理（测试与调参用）。
 * 给定一批词和每天新学/复习的量，跑若干天，返回排程概况。
 * 这样"参数改了会不会爆炸"这件事可以在 Node 里直接验证，不用等真实使用。
 */
export function simulate(wordCount, days, opts = {}) {
  const {
    newPerDay = 10,
    reviewsPerDay = 200,
    accuracy = 0.85,
    config = null,
    rand = mulberry32(42),
  } = opts;

  const cards = [];
  const cardsById = new Map();
  for (let i = 0; i < wordCount; i++) {
    const c = newCard('w' + i, 0);
    c.state = STATE.NEW;
    cards.push(c);
    cardsById.set(c.wordId, c);
  }

  let now = 0;
  let introduced = 0;
  const dailyLoad = [];

  for (let d = 0; d < days; d++) {
    now = d * DAY;
    // 1) 先复习到期的
    let done = 0;
    const due = cards.filter((c) => c.state !== STATE.NEW && c.due <= now);
    due.sort((a, b) => a.due - b.due);
    for (const c of due) {
      if (done >= reviewsPerDay) break;
      const g = rand() < accuracy ? (rand() < 0.2 ? GRADE.EASY : GRADE.GOOD) : GRADE.AGAIN;
      const nc = schedule(c, g, now, config);
      Object.assign(c, nc);
      done++;
    }
    // 2) 再引入新词
    for (let n = 0; n < newPerDay && introduced < wordCount; n++, introduced++) {
      const c = cards[introduced];
      const g = rand() < 0.8 ? GRADE.GOOD : GRADE.AGAIN;
      const nc = schedule(c, g, now, config);
      Object.assign(c, nc);
    }
    dailyLoad.push({ day: d, reviews: done, introduced: Math.min(introduced, wordCount) });
  }

  const s = summarize(cards, now);
  return { cards, summary: s, dailyLoad, introduced, finalNow: now };
}

/** 可复现的伪随机数（测试用，避免每次跑结果不同） */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
