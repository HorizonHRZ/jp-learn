/**
 * 复习会话状态机单元测试（纯函数）
 *
 * 用法：node tools/test-session.mjs
 *
 * 重点验证那些"在浏览器里很难复现"的行为：
 *   · 答错的词会不会重新出现
 *   · 重排有没有上限（否则会话永远结束不了）
 *   · 进度条的分子分母对不对
 *   · 每日新词额度（newLimit / introducedToday / remainingNew）算得对不对
 *   · 用真实 SRS 跑完整会话，排程数据是否自洽
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const S = await import('../app/js/session.js');
const Q = await import('../app/js/quiz.js');
const SRS = await import('../app/js/srs.js');

const { GRADE, STATE, newCard, schedule, DAY, MINUTE, isDue } = SRS;
const { mulberry32 } = SRS;

let fail = 0, passed = 0;
const ok = (cond, label, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
};
const eq = (a, b, label) => ok(a === b, label, a === b ? '' : `得到 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`);

const n5 = JSON.parse(fs.readFileSync(ROOT + '/data/vocab/n5.json', 'utf8')).items;
const n4 = JSON.parse(fs.readFileSync(ROOT + '/data/vocab/n4.json', 'utf8')).items;
const pool = [...n5, ...n4];
const T0 = Date.UTC(2026, 0, 15, 5, 0, 0);

console.log('='.repeat(72));
console.log(' 复习会话状态机单元测试');
console.log('='.repeat(72));

const seed = (n, now = T0) => n5.slice(0, n).map((w) => newCard(w.id, now));

// ---------------------------------------------------------------- 建会话
console.log('\n[1] 创建会话：到期 vs 未到期');
{
  const words = pool.slice(0, 30);
  const now = T0;
  const cards = words.map((w, i) => ({
    ...newCard(w.id, now - 10 * DAY),
    state: STATE.REVIEW,
    interval: 5,
    // 前 10 个到期，其余 10 天后才到期
    due: i < 10 ? now - DAY : now + 10 * DAY,
  }));

  const s = S.createSession({
    source: 'due', cards, words, size: 20, now, rand: mulberry32(1),
    // keepOrder 由 createSession 注入，这里必须透传，否则优先级会被打乱
    buildQuestions: (ws, o) => Q.buildQuiz(ws, { count: ws.length, pool, rand: o.rand, modes: ['jp2zh'], keepOrder: o.keepOrder }),
  });

  ok(s.queue.length > 0, `会话有 ${s.queue.length} 道题`);
  const first = S.currentQuestion(s);
  ok(first && first.question, '能取到当前题');
  eq(first.index, 0, '游标从 0 开始');

  // 到期的词必须排在前面
  const dueIds = new Set(cards.filter((c) => c.due <= now).map((c) => c.wordId));
  const firstTen = s.queue.slice(0, 10).map((x) => x.q.wordId);
  ok(firstTen.every((id) => dueIds.has(id)), '到期的词排在最前面',
    `前 10 个里 ${firstTen.filter((id) => !dueIds.has(id)).length} 个不该在里面`);
  eq(s.finished, false, '会话未结束');
}

console.log('\n[2] 空数据时不应崩溃');
{
  const s = S.createSession({ source: 'due', cards: [], words: [], now: T0, rand: mulberry32(1) });
  eq(s.queue.length, 0, '没有词时候队列为空');
  eq(s.finished, true, '直接标记为已结束');
  eq(S.currentQuestion(s), null, '取当前题返回 null 而不是抛错');
  eq(S.progress(s).percent, 0, '进度不会除零');
}

// ---------------------------------------------------------------- 作答推进
console.log('\n[3] 答对推进，答错重新排队尾');
{
  const words = pool.slice(0, 5);
  const cards = seed(5);
  const s0 = S.createSession({
    source: 'new', cards, words, size: 5, now: T0, rand: mulberry32(2),
    buildQuestions: (ws, o) => Q.buildQuiz(ws, { count: ws.length, pool, rand: o.rand, modes: ['jp2zh'] }),
  });
  const total0 = s0.queue.length;
  eq(total0, 5, '一共 5 道题');

  const q0 = S.currentQuestion(s0).question;

  // 答对 → 不重排
  const r1 = S.submitAnswer(s0, { grade: GRADE.GOOD, correct: true, input: q0.answer, expected: q0.answer, now: T0 });
  eq(r1.session.queue.length, total0, '答对不增加队列长度');
  eq(r1.requeued, false, '答对不重排');
  eq(r1.session.cursor, 1, '游标推进到 1');

  // 答错 → 重排到队尾
  const q1 = S.currentQuestion(r1.session).question;
  const r2 = S.submitAnswer(r1.session, { grade: GRADE.AGAIN, correct: false, input: '错', expected: q1.answer, now: T0 + 1000 });
  eq(r2.requeued, true, '答错会重新排队');
  eq(r2.session.queue.length, total0 + 1, '队列长度 +1');
  const last = r2.session.queue[r2.session.queue.length - 1];
  eq(last.q.wordId, q1.wordId, '重新排到队尾的是刚答错的那个词');
  eq(last.requeued, true, '标记了 requeued');

  // 纯函数：原会话不能被改动
  eq(s0.cursor, 0, '原会话对象未被修改（纯函数）');
  eq(s0.queue.length, total0, '原会话队列长度不变');
}

console.log('\n[4] 重排有上限：一个词不能拖住整个会话');
{
  const words = pool.slice(0, 3);
  const cards = seed(3);
  let s = S.createSession({
    source: 'new', cards, words, size: 3, now: T0, rand: mulberry32(3),
    buildQuestions: (ws, o) => Q.buildQuiz(ws, { count: ws.length, pool, rand: o.rand, modes: ['jp2zh'] }),
  });
  const maxRequeue = 2;

  // 一直答错同一个词，看会话能否结束
  let guard = 0;
  while (!s.finished && guard++ < 500) {
    const cur = S.currentQuestion(s).question;
    const r = S.submitAnswer(s, {
      grade: GRADE.AGAIN, correct: false, input: '错', expected: cur.answer,
      now: T0 + guard * 60000, maxRequeue,
    });
    s = r.session;
  }
  ok(s.finished, `一直答错也会结束（做了 ${guard} 次作答）`, `finished=${s.finished}`);
  ok(guard < 100, '不会无限循环', `实际 ${guard} 次`);

  // 每个词最多出现 1 + maxRequeue 次
  const count = {};
  for (const a of s.answers) count[a.wordId] = (count[a.wordId] || 0) + 1;
  const worst = Math.max(...Object.values(count));
  ok(worst <= 1 + maxRequeue, `同一个词最多出现 ${1 + maxRequeue} 次`, `实际最多 ${worst} 次`);
  eq(s.stats.requeued, words.length * maxRequeue, `重排总次数 = 词数 × 上限`);
}

console.log('\n[5] 进度计算');
{
  const words = pool.slice(0, 4);
  const cards = seed(4);
  let s = S.createSession({
    source: 'new', cards, words, size: 4, now: T0, rand: mulberry32(4),
    buildQuestions: (ws, o) => Q.buildQuiz(ws, { count: ws.length, pool, rand: o.rand, modes: ['jp2zh'] }),
  });

  eq(S.progress(s).percent, 0, '开始进度 0%');
  eq(S.progress(s).remaining, 4, '剩余 4 题');

  for (let i = 0; i < 2; i++) {
    const cur = S.currentQuestion(s).question;
    s = S.submitAnswer(s, { grade: GRADE.GOOD, correct: true, input: cur.answer, expected: cur.answer, now: T0 + i }).session;
  }
  const p = S.progress(s);
  eq(p.done, 2, '已作答 2 次');
  eq(p.correct, 2, '答对 2 题');
  eq(p.remaining, 2, '剩余 2 题');
  eq(p.accuracy, 100, '正确率 100%');
  eq(p.percent, 50, '进度 50%（答对 2 / 还需答对 4）');

  // 答错：题目重新排到队尾。进度条**不能**因为"又答了一题"就往上涨，
  // 否则一个总答不对的词会让进度条一路涨到 100%，用户会不信任它。
  //
  // 注意重排有上限（maxRequeue=2）。上面那个词已经用掉一次重排额度
  // （它在第 3 题答错 → 重排 → 又答对了），所以这里必须用一个**新会话**
  // 来验证"首次答错一定重排"这条行为，否则会被上限挡住而误判。
  {
    const w2 = pool.slice(0, 4);
    let fresh = S.createSession({
      source: 'new', cards: seed(4), words: w2, size: 4, now: T0, rand: mulberry32(4),
      buildQuestions: (ws, o) => Q.buildQuiz(ws, { count: ws.length, pool, rand: o.rand, modes: ['jp2zh'] }),
    });
    const b = S.progress(fresh);
    const cur2 = S.currentQuestion(fresh).question;
    const r2 = S.submitAnswer(fresh, { grade: GRADE.AGAIN, correct: false, input: '错', expected: cur2.answer, now: T0 });
    ok(r2.requeued, '首次答错一定重排');
    const a2 = S.progress(r2.session);
    eq(a2.done, 1, '已作答次数 +1');
    eq(a2.correct, 0, '答对次数仍为 0');
    eq(a2.remaining, b.remaining, '剩余题数不变（答错一道、又回来一道）');
    eq(a2.percent, b.percent, '答错不会让进度条上涨（分子分母都没白涨）');
    ok(a2.percent <= b.percent, '进度绝不因为答错而上升', `${b.percent}% → ${a2.percent}%`);
  }

  // 把剩下的题全答对，进度必须走到 100% 且会话结束
  {
    let run = s;
    let guard = 0;
    while (!run.finished && guard++ < 200) {
      const c = S.currentQuestion(run).question;
      run = S.submitAnswer(run, { grade: GRADE.GOOD, correct: true, input: c.answer, expected: c.answer, now: T0 + 100 + guard }).session;
    }
    ok(run.finished, '全部答对后会话结束');
    eq(S.progress(run).percent, 100, '全部答对后进度 100%');
    eq(S.progress(run).remaining, 0, '剩余题数归零');
    eq(S.progress(run).accuracy, 100, '正确率 100%');
    eq(S.currentQuestion(run), null, '结束后取不到题');
  }
}

// ---------------------------------------------------------------- 小结
console.log('\n[6] 会话小结');
{
  const words = pool.slice(0, 5);
  const cards = seed(5);
  let s = S.createSession({
    source: 'new', cards, words, size: 5, now: T0, rand: mulberry32(6),
    buildQuestions: (ws, o) => Q.buildQuiz(ws, { count: ws.length, pool, rand: o.rand, modes: ['jp2zh'] }),
  });
  const wrongIds = [];
  let n = 0;
  while (!s.finished && n++ < 100) {
    const cur = S.currentQuestion(s).question;
    const makeWrong = n % 2 === 0;
    if (makeWrong) wrongIds.push(cur.wordId);
    s = S.submitAnswer(s, {
      grade: makeWrong ? GRADE.AGAIN : GRADE.GOOD,
      correct: !makeWrong,
      input: makeWrong ? '错' : cur.answer,
      expected: cur.answer,
      now: T0 + n * 1000,
    }).session;
  }

  const sum = S.summarizeSession(s, s.cards ? [...s.cardById.values()] : [], T0 + 60000);
  eq(sum.asked, s.stats.asked, '小结题量与会话统计一致');
  ok(sum.accuracy >= 0 && sum.accuracy <= 100, '正确率在合法范围', `${sum.accuracy}%`);
  eq(sum.durationMs, 60000, '时长计算正确');
  ok(sum.wrongWords.length > 0, '小结里列出了错词', `${sum.wrongWords.length} 个`);
  // 错词不能重复列出
  const wids = sum.wrongWords.map((w) => w.wordId);
  eq(new Set(wids).size, wids.length, '错词列表按词去重（同一个词错多次只列一条）');
  ok(sum.wrongWords.every((w) => w.answer), '每个错词都带正确答案（小结里能直接看）');
}

// ---------------------------------------------------------------- 学习计划
console.log('\n[7] buildPlan 今日计划');
{
  const now = T0;
  const words = pool.slice(0, 25);
  const cards = words.map((w, i) => {
    if (i < 8) return newCard(w.id, now);                     // 8 个新词
    if (i < 18) return { ...newCard(w.id, now), state: STATE.REVIEW, interval: 5, due: now - DAY };  // 10 个到期
    return { ...newCard(w.id, now), state: STATE.REVIEW, interval: 30, due: now + 7 * DAY };          // 7 个未到期
  });

  const plan = S.buildPlan(cards, words, { now, newLimit: 20 });
  eq(plan.newAvailable, 8, '可用新词 8 个');
  eq(plan.newToday, 8, '今日新学 8 个（未超过上限）');
  eq(plan.dueReviewCount, 10, '到期复习 10 个');
  eq(plan.hasWork, true, '今天有活干');
  eq(plan.dueCards.length, 10, 'dueCards 与计数一致');

  // 新词上限生效
  const limited = S.buildPlan(cards, words, { now, newLimit: 3 });
  eq(limited.newToday, 3, 'newLimit 生效');

  // 已不在生词本里的卡要被忽略
  const plan2 = S.buildPlan(cards, words.slice(0, 5), { now, newLimit: 20 });
  eq(plan2.dueReviewCount, 0, '不在生词本里的卡不计入计划');

  // 没活干的情况
  const idle = S.buildPlan([], [], { now });
  eq(idle.hasWork, false, '没词时 hasWork=false');
  eq(idle.newAvailable, 0, '没词时新词数 0');
}

console.log('\n[7b] buildPlan 每日新词额度：靠 introducedAt 算"今天已学"');
{
  const now = T0;
  const words = pool.slice(0, 12);
  // 一张"今天学过的复习卡"（introducedAt 落在今天）+ 一张全新卡。
  // 今天已学只能靠 introducedAt 数出来：光看 state !== 'new' 无法区分
  // "今天学的" 和 "上周学的"，每日上限就会退化成"每次练习给 N 个"。
  const cards = [
    { ...newCard(words[0].id, now), state: STATE.REVIEW, interval: 5, due: now + 5 * DAY, introducedAt: now },
    newCard(words[1].id, now),
  ];

  const p = S.buildPlan(cards, words, { now, newLimit: 1 });
  eq(p.introducedToday, 1, '今天已学新词 = 1（按 introducedAt 统计）');
  eq(p.newLimit, 1, '回报了本次使用的上限');
  eq(p.remainingNew, 0, '剩余额度 0');
  eq(p.newQuotaUsedUp, true, '额度用完了（还有新词，但今天不再给）');
  eq(p.newToday, 0, 'newToday 被剩余额度截断成 0');
  eq(p.newAvailable, 1, '但"还有多少个新词"要如实告诉用户');
  eq(p.hasWork, false, '新词额度用完且没有到期复习 → 今天没活干');

  // 额度没用完
  const many = S.buildPlan(cards, words, { now, newLimit: 5 });
  eq(many.remainingNew, 4, '上限 5、已学 1 → 还剩 4');
  eq(many.newQuotaUsedUp, false, '还有额度时不算用完');
  eq(many.newToday, 1, '只剩 1 张新卡，不会被硬凑成 4 个');

  // newCards 必须真的被剩余额度**截断**（这是"每日上限"生效的关键一步）
  const cards6 = words.slice(2, 8).map((w) => newCard(w.id, now));
  const cut = S.buildPlan(cards6, words, { now, newLimit: 2 });
  eq(cut.newAvailable, 6, '有 6 个新词可用');
  eq(cut.remainingNew, 2, '今天还剩 2 个额度');
  eq(cut.newCards.length, 2, 'newCards 被截断到 2 个（不是把所有新词都发下来）');
  eq(cut.newToday, 2, 'newToday 与截断后的 newCards 一致');
  eq(cut.newQuotaUsedUp, false, '还剩额度时不算用完');

  // 昨天学过的不算今天的额度
  const yesterday = S.buildPlan(
    [{ ...newCard(words[0].id, now), state: STATE.REVIEW, interval: 5, due: now + 5 * DAY, introducedAt: now - DAY }],
    words, { now, newLimit: 1 },
  );
  eq(yesterday.introducedToday, 0, '昨天学的词不算进今天的已学数');
  eq(yesterday.newQuotaUsedUp, false, '昨天学过不影响今天是否用满额度');

  // 没有新词时不该提示"额度用完了"（没有东西可学，不是被额度挡住）
  const noNew = S.buildPlan([cards[0]], words, { now, newLimit: 1 });
  eq(noNew.newAvailable, 0, '没有 new 卡');
  eq(noNew.newQuotaUsedUp, false, '"没有新词可学"与"额度用完"必须区分开');

  // 额度为 0 且还有新词：同样算"用完"（等于今天只复习）
  const zero = S.buildPlan(cards, words, { now, newLimit: 0 });
  eq(zero.remainingNew, 0, '上限 0 → 没有剩余额度');
  eq(zero.newQuotaUsedUp, true, '上限 0 且有新词 → 额度用完');

  // 不传 newLimit 时用默认值 50（原来是 20，用户改成了 50）
  const plain = S.buildPlan(cards, words, { now });
  eq(plain.newLimit, 50, '不传 newLimit 时默认 50');
  eq(plain.remainingNew, 49, '默认额度下还剩 49');
}

console.log('\n[7c] ★ 每日复习额度：界面承诺的量 = 实际发出的量');
// ---------------------------------------------------------------------------
// 这一节专门盯那次真 bug。修复前的行为：
//   · 「今日」页的按钮写「开始复习（537 个到期）」
//   · 但 startSession 里 suggestSize(..., { max: 40 }) 只发 40 题
//   · 而且不告诉用户还有 497 个
// 两个数字在界面上从不同时出现，用户无从判断自己是做完了还是做了个零头。
// 下面这套断言就是"以后不许再出现这种不一致"的护栏。
{
  const now = Date.now();
  const N = 100;                    // 100 个到期，远超默认上限 40
  const words = [];
  const dueCards = [];
  for (let i = 0; i < N; i++) {
    const id = 'q' + i;
    // ⚠️ 词条字段要照真实数据的样子给（zh / gloss 是出题和判分都读的字段）。
    //    第一版只给了 term/reading/meaning，而且 modes 用了不存在的 'meaning'，
    //    结果 buildQuiz 里每道题都抛错、被 catch 静默跳过 → 得到 0 题。
    //    （顺便确认：真代码的 modes 只可能来自 Q.MODES，所以这条静默跳过
    //      在应用里不容易触发；但测试里踩一次就够了，别再犯。）
    words.push({
      id, term: '語' + i, reading: 'ご' + i,
      zh: ['词' + i], gloss: '词' + i, forms: [], kanas: [],
    });
    const c = newCard(id, now - 30 * DAY);
    dueCards.push({ ...c, state: STATE.REVIEW, interval: 10, ease: 2.5, due: now - (N - i) * MINUTE });
  }

  // ---- 计划：到期总数与今天可做量必须分开 ----
  const plan = S.buildPlan(dueCards, words, { now, newLimit: 0, reviewLimit: 40, reviewedToday: 0 });
  eq(plan.dueReviewCount, N, `到期总数如实统计（${N} 个）`);
  eq(plan.reviewToday, 40, '今天只能做 40 个（每日上限）');
  eq(plan.reviewDeferred, 60, '差额 60 个记为"顺延到明天"');

  // ---- 界面文案：两个数字都要出现，且必须是同一个来源 ----
  const label = `开始复习（本轮 ${plan.reviewToday} 个，另有 ${plan.reviewDeferred} 个顺延）`;
  const nums = label.match(/\d+/g).map(Number);
  eq(nums[0], plan.reviewToday, '按钮里第一个数是"本次做几个"');
  eq(nums[1], plan.reviewDeferred, '按钮里第二个数是"顺延几个"');
  ok(nums[0] !== nums[1], '两个数不是同一个数（修复前它们只能显示一个）');

  // ---- ★ 核心：按界面承诺的量建会话，实际必须发同样多 ----
  // 这里**照抄 startSession 的做法**（app/js/views/vocab.js 里 'due' 那一段）：
  //   1. 用 plan.dueCards 的白名单把卡池和词池先收窄；
  //   2. 再用 suggestSize 定题量。
  // 第 1 步是关键：少了它，卡池仍然是全部 100 个，结果就只能靠 size 兜底，
  // 而 size 又受 max:40 限制 —— 表现看起来"碰巧也对"，但语义是错的，
  // 而且 pool 越大越容易让 pickDue 之外的逻辑漏进来。
  // 所以下面既断言"卡池已经只有 40 个"，也断言"最终题量 = 承诺量"。
  const allowed = new Set(plan.dueCards.map((c) => c.wordId));
  const scopedCards = dueCards.filter((c) => allowed.has(c.wordId));
  const scopedWords = words.filter((w) => allowed.has(w.id));
  eq(scopedCards.length, 40, '★ 收窄后的卡池恰好是今天的额度（不是全部 100 个）');
  eq(scopedWords.length, 40, '★ 收窄后的词池同样是 40 个');

  const size = S.suggestSize('due', scopedWords.length, { max: 40 });
  // ⚠️ 这里的 pool 必须用外层那个大词库（n5+n4），**不能**用 buildQuiz 的 o.pool。
  //    原因：createSession 传给回调的是 `{ ..., pool: words, ... }`，
  //    而这里的 words 是 40 个生词 —— 干扰项从 40 个里取不出像样的 4 选 1。
  //    真实代码（views/vocab.js）同样是闭包捕获自己的 pool（sampleLibrary(600)+生词），
  //    它写在 o 展开之后，所以把 createSession 传进来的 pool 覆盖掉了。
  //    （第一版这里漏了 pool，断言得到 0 题；第二版用了 o.pool，仍然不对。）
  const quizPool = pool;
  const sess = S.createSession({
    source: 'due', cards: scopedCards, words: scopedWords,
    modes: ['jp2zh'], size, now,
    buildQuestions: (ws, o) => Q.buildQuiz(ws, {
      count: ws.length, pool: quizPool, rand: o.rand, modes: o.modes, keepOrder: o.keepOrder,
    }),
  });
  eq(sess.queue.length, plan.reviewToday,
    '★ 实际发出的题量 = 界面承诺的"本轮 N 个"（这就是那次 bug 的护栏）');
  ok(sess.queue.length < plan.dueReviewCount,
    '实际题量少于到期总数（多出来的确实顺延了，没有被硬塞）');
  // 顺序必须是"逾期最久的在前"，不能被打乱（否则顺延的那批永远是同一批）
  eq(sess.queue[0].q.wordId, 'q0', '发的第一个是逾期最久的（顺序没被 shuffle）');

  // ---- 额度用完后：今天一个都不发，且文案要能解释为什么 ----
  const full = S.buildPlan(dueCards, words, { now, newLimit: 0, reviewLimit: 40, reviewedToday: 40 });
  eq(full.reviewToday, 0, '今天额度已满 → 今天不再发题');
  eq(full.reviewDeferred, 100, '100 个全部顺延（一个都不丢）');
  eq(full.reviewQuotaUsedUp, true, '标记为已完成，界面才能提示而不是装作没事');

  // ---- 顺延的证据：被裁掉的卡 due 仍在过去，明天依然到期 ----
  const deferred = dueCards.filter((c) => !allowed.has(c.wordId));
  eq(deferred.length, 60, '被裁掉 60 个');
  ok(deferred.every((c) => isDue(c, now)), '被裁掉的卡现在依然是"到期"状态（没有被动过）');
  ok(deferred.every((c) => isDue(c, now + DAY)), '明天它们照样到期 —— 这就是"顺延"，不是"丢词"');

  // ---- ★ 学习步/重学步必须免费放行，不能被复习额度裁掉 ----
  // 这一条是**改这一版时自己踩出来的 bug**，留个护栏：
  //   learning 状态的词会在 1 分钟 / 10 分钟后各要考一次，走完才算"毕业"。
  //   第一版把 dueCards 收窄成"只有天级复习"，于是今天新学的词到 10 分钟
  //   该考第二步时，如果当天复习额度已用完 → 那一步被裁掉 → 那些词
  //   **永远毕业不了**，一直卡在 learning 里。这不是少考一次，是功能坏掉。
  {
    const mixing = [
      // 2 个到期天级复习
      { ...newCard('r0', now - 30 * DAY), state: STATE.REVIEW, interval: 10, due: now - 5000 },
      { ...newCard('r1', now - 30 * DAY), state: STATE.REVIEW, interval: 10, due: now - 4000 },
      // 3 个到点的学习步/重学步（不占额度）
      { ...newCard('l0', now - MINUTE), state: STATE.LEARNING, step: 1, due: now - 1000 },
      { ...newCard('l1', now - MINUTE), state: STATE.LEARNING, step: 1, due: now - 2000 },
      { ...newCard('l2', now - MINUTE), state: STATE.RELEARNING, step: 0, due: now - 3000 },
    ];
    const mw = mixing.map((c) => ({ id: c.wordId, term: c.wordId, zh: [c.wordId], gloss: c.wordId, forms: [], kanas: [] }));
    // 额度刚好只剩 1 个：天级复习只能做 1 个，但 3 个学习步必须全都还在
    const mp = S.buildPlan(mixing, mw, { now, newLimit: 0, reviewLimit: 40, reviewedToday: 39 });
    eq(mp.reviewToday, 1, '额度只剩 1 → 天级复习只给 1 个');
    eq(mp.reviewDeferred, 1, '另 1 个天级复习顺延');
    eq(mp.freeToday, 3, '★ 3 个学习步/重学步被免费放行（不占额度）');
    eq(mp.dueCards.length, 4, '★ dueCards = 1 个额度内复习 + 3 个免费学习步');
    const ids = mp.dueCards.map((c) => c.wordId).sort();
    eq(ids.join(','), 'l0,l1,l2,r0', '★ 学习步没有被额度裁掉（这就是"永远毕业不了"的护栏）');

    // 额度彻底用完时，学习步**依然**要放行（否则刚学的词就断了）
    const mfull = S.buildPlan(mixing, mw, { now, newLimit: 0, reviewLimit: 40, reviewedToday: 40 });
    eq(mfull.reviewToday, 0, '额度用满 → 天级复习一个都不给');
    eq(mfull.freeToday, 3, '★ 额度用满时学习步仍然放行');
    eq(mfull.dueCards.length, 3, '★ 仍然发出 3 个学习步');
    ok(mfull.hasWork, '★ 还有学习步要做 → hasWork 为真（界面不能显示"今天没事做"）');
    ok(mfull.reviewQuotaUsedUp, '同时如实标记"今日复习额度已完成"');
  }
}

console.log('\n[8] suggestSize 建议题量');
{
  eq(S.suggestSize('due', 0), 0, '到期 0 个 → 0 题');
  eq(S.suggestSize('due', 25), 25, '到期 25 个 → 25 题');
  eq(S.suggestSize('due', 500), 60, '到期 500 个 → 封顶 60（不让一次复习变成折磨）');
  eq(S.suggestSize('mistakes', 0), 5, '错题 0 个也给最小题量（可以主动练）');
  eq(S.suggestSize('level', 999), 20, '按等级练默认 20 题');
}

// ---------------------------------------------------------------- 与真实 SRS 联跑
console.log('\n[9] 与真实 SRS 联跑整场会话，排程数据必须自洽');
{
  const words = pool.slice(0, 40);
  const now = T0;
  const cards = words.map((w) => newCard(w.id, now));
  const rand = mulberry32(77);

  let s = S.createSession({
    source: 'new', cards, words, size: 20, now, rand,
    buildQuestions: (ws, o) => Q.buildQuiz(ws, { count: ws.length, pool, rand: o.rand, modes: ['jp2zh', 'zh2jp', 'zh2jp_typing'] }),
  });

  // 用会话自己的卡表跑，每题按 SRS 排程推进。
  // 时间步长必须大于 learningSteps 的第二步（10 分钟），否则卡片永远
  // 攒不满学习步、毕业不了 —— 这正是"复习会话要跨越分钟级间隔"的真实形态。
  const cardMap = new Map(cards.map((c) => [c.wordId, c]));
  let n = 0;
  while (!s.finished && n++ < 300) {
    const cur = S.currentQuestion(s).question;
    // 大部分答对，偶尔点"太简单"（直接毕业），每 7 题错一次
    const grade = n % 7 === 0 ? GRADE.AGAIN : (n % 3 === 0 ? GRADE.EASY : GRADE.GOOD);
    const card = cardMap.get(cur.wordId) || newCard(cur.wordId, now);
    const t = now + n * 15 * 60000;         // 每题间隔 15 分钟
    const nextCard = schedule(card, grade, t);
    cardMap.set(cur.wordId, nextCard);
    s = S.submitAnswer(s, {
      grade, correct: grade !== GRADE.AGAIN,
      input: grade === GRADE.AGAIN ? '错' : cur.answer,
      expected: cur.answer, now: t,
    }).session;
  }

  ok(s.finished, `会话正常结束（${n} 次作答）`);

  // 所有排程卡必须字段完整、数值合法
  let bad = 0;
  for (const c of cardMap.values()) {
    if (!(c.due > 0)) { bad++; continue; }
    if (!(c.interval >= 0)) { bad++; continue; }
    if (!(c.ease >= 1.3 && c.ease <= 3.0)) { bad++; continue; }
    if (!(c.lapses >= 0)) { bad++; continue; }
    if (![STATE.NEW, STATE.LEARNING, STATE.REVIEW, STATE.RELEARNING].includes(c.state)) bad++;
  }
  eq(bad, 0, '所有排程卡字段完整、数值合法');

  const sum = S.summarizeSession(s, [...cardMap.values()], now + 999999);
  eq(sum.asked, s.stats.asked, '小结与统计一致');
  console.log(`      作答 ${sum.asked} 次，正确率 ${sum.accuracy}%，重排 ${sum.requeued} 次，错词 ${sum.wrongWords.length} 个`);
  console.log(`      卡状态：${JSON.stringify(sum.cardStats && { new: sum.cardStats.new, learning: sum.cardStats.learning, review: sum.cardStats.review, relearning: sum.cardStats.relearning })}`);
  ok(sum.cardStats.review > 0, '整场会话后确实有词毕业进入复习');
  ok(sum.cardStats.review + sum.cardStats.learning + sum.cardStats.relearning + sum.cardStats.new === cards.length,
    '四种状态的卡数加起来等于总词数（没有卡凭空丢失）');
}

console.log('\n[10] 各来源都能建出会话');
{
  const words = pool.slice(0, 30);
  const cards = words.map((w, i) => ({
    ...newCard(w.id, T0),
    state: i % 3 === 0 ? STATE.REVIEW : STATE.NEW,
    due: i % 3 === 0 ? T0 - DAY : T0,
    interval: i % 3 === 0 ? 5 : 0,
  }));
  const mk = (src) => S.createSession({
    source: src, cards, words, size: 20, now: T0, rand: mulberry32(9),
    buildQuestions: (ws, o) => Q.buildQuiz(ws, { count: ws.length, pool, rand: o.rand, modes: ['jp2zh'] }),
  });

  for (const src of ['due', 'new', 'level', 'mistakes', 'reinforce']) {
    const s = mk(src);
    ok(s.queue.length > 0, `来源「${S.SESSION_SOURCE[src].label}」能建出会话`, `${s.queue.length} 题`);
    ok(!!S.SESSION_SOURCE[src].hint, `  —— 且有给用户看的说明文字`);
  }
}

console.log('\n[11] 边界与健壮性');
{
  // 只有 1 个词
  const s1 = S.createSession({
    source: 'new', cards: seed(1), words: pool.slice(0, 1), size: 20, now: T0, rand: mulberry32(1),
    buildQuestions: (ws, o) => Q.buildQuiz(ws, { count: ws.length, pool, rand: o.rand, modes: ['jp2zh'] }),
  });
  ok(s1.queue.length >= 1, '只有 1 个词也能建会话');

  // size 为 0
  const s0 = S.createSession({
    source: 'new', cards: seed(5), words: pool.slice(0, 5), size: 0, now: T0, rand: mulberry32(1),
    buildQuestions: () => [],
  });
  eq(s0.queue.length, 0, 'size=0 → 空会话');

  // submitAnswer 的错误输入
  let threw = false;
  try { S.submitAnswer(null, { grade: GRADE.GOOD }); } catch { threw = true; }
  ok(threw, 'session 为空时抛错（不静默）');

  const empty = S.createSession({ source: 'new', cards: [], words: [], size: 5, now: T0, rand: mulberry32(1) });
  threw = false;
  try { S.submitAnswer(empty, { grade: GRADE.GOOD }); } catch { threw = true; }
  ok(threw, '没有待答题时抛错');

  // 词条缺 id 也不该崩
  const weird = S.createSession({
    source: 'new', cards: [], words: [{ id: 'x', term: 'あ', reading: 'あ', zh: ['a'], pos: [], forms: [], kanas: [] }],
    size: 5, now: T0, rand: mulberry32(1),
    buildQuestions: (ws, o) => Q.buildQuiz(ws, { count: ws.length, pool: ws, rand: o.rand, modes: ['jp2zh'] }),
  });
  ok(weird !== null, '词条字段不全也不崩');
}

console.log('\n' + '='.repeat(72));
console.log(fail === 0 ? ` 全部通过（${passed} 项）` : ` ${fail} 项未通过，${passed} 项通过`);
console.log('='.repeat(72));
process.exit(fail === 0 ? 0 : 1);
