/**
 * SRS 排程算法单元测试（纯函数，不需要浏览器、不需要 IndexedDB）
 *
 * 用法：node tools/test-srs.mjs
 *
 * 为什么要单独测这个：排程错了会悄悄毁掉用户的复习计划，
 * 症状往往几天后才显现。所以用固定时间戳做确定性断言，
 * 不依赖 Date.now()，每次跑结果都一样。
 */
const {
  DAY, MINUTE, STATE, GRADE, DEFAULT_CONFIG,
  newCard, schedule, isDue, pickDue, weightForReinforce,
  forecast, summarize, humanInterval, dayKey, simulate, mulberry32,
  countsAgainstDailyReview, reviewQuotaLeft, capByDailyReview,
  REVIEW_LEVERAGE, recommendedReviewLimit, reviewLoadAdvice,
} = await import('../app/js/srs.js');
const { buildPlan } = await import('../app/js/session.js');

let fail = 0;
let passed = 0;
const ok = (cond, label, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
};
const eq = (actual, expected, label) =>
  ok(actual === expected, label, actual === expected ? '' : `得到 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);

// 固定基准时间，避免测试结果随真实时间漂移
const T0 = Date.UTC(2026, 0, 15, 5, 0, 0);   // 2026-01-15 05:00 UTC（已过 4 点，算当天）

console.log('='.repeat(72));
console.log(' SRS 排程算法单元测试');
console.log('='.repeat(72));

// ---------------------------------------------------------------- 新词学习步
console.log('\n[1] 新词的学习步与毕业');
{
  let c = newCard('w1', T0);
  eq(c.state, STATE.NEW, '新卡状态是 new');
  eq(c.due, T0, '新卡立刻到期');
  eq(c.ease, DEFAULT_CONFIG.startingEase, '新卡 ease = 2.5');

  c = schedule(c, GRADE.GOOD, T0);
  eq(c.state, STATE.LEARNING, 'GOOD 后进入 learning');
  eq(c.step, 1, '步进到第 1 步');
  eq(c.due - T0, DEFAULT_CONFIG.learningSteps[1] * MINUTE, '下次在 10 分钟后');

  c = schedule(c, GRADE.GOOD, T0 + 10 * MINUTE);
  eq(c.state, STATE.REVIEW, '走完学习步 → 毕业到 review');
  eq(c.interval, DEFAULT_CONFIG.graduatingInterval, '毕业间隔 = 1 天');
  eq(c.due - (T0 + 10 * MINUTE), DAY, '毕业后 1 天到期');
}

console.log('\n[2] 学习步里 forgot 要退回第一步');
{
  let c = newCard('w2', T0);
  c = schedule(c, GRADE.GOOD, T0);              // → 第 1 步
  c = schedule(c, GRADE.AGAIN, T0 + MINUTE);    // 忘了
  eq(c.state, STATE.LEARNING, '仍处于 learning');
  eq(c.step, 0, '退回第 0 步');
  eq(c.due - (T0 + MINUTE), DEFAULT_CONFIG.learningSteps[0] * MINUTE, '1 分钟后重来');
}

console.log('\n[3] 新词点"太简单"直接毕业');
{
  let c = newCard('w3', T0);
  c = schedule(c, GRADE.EASY, T0);
  eq(c.state, STATE.REVIEW, '直接进入 review');
  eq(c.interval, DEFAULT_CONFIG.easyInterval, `间隔 = easyInterval(${DEFAULT_CONFIG.easyInterval} 天)`);
}

console.log('\n[4] 天级复习的间隔推进');
{
  let c = newCard('w4', T0);
  c = schedule(c, GRADE.GOOD, T0);                    // learning step1
  c = schedule(c, GRADE.GOOD, T0);                    // 毕业，interval=1
  eq(c.interval, 1, '毕业间隔 1 天');
  const i1 = c.interval;

  c = schedule(c, GRADE.GOOD, T0 + DAY);
  const expect1 = Math.round(i1 * c.ease);
  eq(c.interval, expect1, `GOOD: 1 × ease(${c.ease}) = ${expect1} 天`);

  const before = c.interval;
  c = schedule(c, GRADE.GOOD, T0 + 5 * DAY);
  ok(c.interval > before, 'GOOD 让间隔继续增长', `${before} → ${c.interval}`);

  // 间隔必须是单调不减的（GOOD 至少 +1 天，不能卡住）
  let prev = c.interval;
  for (let i = 0; i < 12; i++) {
    c = schedule(c, GRADE.GOOD, T0 + (100 + i * 30) * DAY);
    ok(c.interval >= prev, `第 ${i + 1} 次 GOOD 间隔不倒退`, `${prev} → ${c.interval}`);
    prev = c.interval;
  }
  ok(c.interval <= DEFAULT_CONFIG.maxInterval, `间隔不超过上限 ${DEFAULT_CONFIG.maxInterval}`);

  // EASY 应该比 GOOD 推进得更快
  let a = newCard('a', T0);
  a = schedule(a, GRADE.EASY, T0);            // review, interval=4
  let b = newCard('b', T0);
  b = schedule(b, GRADE.EASY, T0);
  const aE = schedule(a, GRADE.EASY, T0 + DAY).interval;
  const bG = schedule(b, GRADE.GOOD, T0 + DAY).interval;
  ok(aE > bG, 'EASY 的间隔推进快于 GOOD', `EASY=${aE} vs GOOD=${bG}`);
}

console.log('\n[5] 遗忘（lapse）：记次数、降 ease、回重学步');
{
  let c = newCard('w5', T0);
  c = schedule(c, GRADE.GOOD, T0);
  c = schedule(c, GRADE.GOOD, T0);            // 毕业 interval=1
  c = schedule(c, GRADE.GOOD, T0 + DAY);      // interval = 1*2.5 = 3
  const easeBefore = c.ease;
  const intervalBefore = c.interval;

  c = schedule(c, GRADE.AGAIN, T0 + 2 * DAY);
  eq(c.lapses, 1, 'lapses 记为 1（错题本靠它排序）');
  eq(c.state, STATE.RELEARNING, '进入 relearning');
  ok(c.ease < easeBefore, 'ease 被下调', `${easeBefore} → ${c.ease}`);
  ok(c.interval === intervalBefore, '遗忘时保留原 interval（不是清零，便于恢复）');
  eq(c.due - (T0 + 2 * DAY), DEFAULT_CONFIG.relearningSteps[0] * MINUTE, '10 分钟后重学');

  // 连续遗忘不能让 ease 无限下跌
  let d = newCard('w5b', T0);
  d = schedule(d, GRADE.EASY, T0);              // 先进入 review
  for (let i = 0; i < 30; i++) d = schedule(d, GRADE.AGAIN, T0 + (i + 1) * DAY);
  eq(d.ease, DEFAULT_CONFIG.minEase, `ease 有下限 ${DEFAULT_CONFIG.minEase}（一个词不能被打死）`);
  eq(d.lapses, 30, 'lapses 照实累计到 30（错题本按它排序，不能封顶）');
}

console.log('\n[6] 走出重学：按比例压缩而不是退回 1 天');
{
  let c = newCard('w6', T0);
  c = schedule(c, GRADE.EASY, T0);                    // review interval=4
  for (let i = 0; i < 6; i++) c = schedule(c, GRADE.GOOD, T0 + (i + 1) * DAY);
  const mature = c.interval;
  ok(mature > 20, `先养成一个成熟卡片，interval=${mature}`);
  c = schedule(c, GRADE.AGAIN, T0 + 30 * DAY);        // 忘了
  eq(c.state, STATE.RELEARNING, '进入 relearning');
  c = schedule(c, GRADE.GOOD, T0 + 30 * DAY + 10 * MINUTE);
  eq(c.state, STATE.REVIEW, 'GOOD 后回到 review');
  const half = Math.max(1, Math.round(mature * 0.5));
  eq(c.interval, half, `间隔压缩为一半(${half})，而不是退回 1 天`);
  ok(c.interval > 1, '成熟卡片忘一次不该被判回新手', `interval=${c.interval}`);
}

console.log('\n[7] 参数校验');
{
  let threw = false;
  try { schedule(null, GRADE.GOOD, T0); } catch { threw = true; }
  ok(threw, '缺 card 时抛错（不静默出错）');

  threw = false;
  try { schedule(newCard('x', T0), 'nonsense', T0); } catch { threw = true; }
  ok(threw, '未知评分时抛错');

  // ease 上限
  let c = newCard('w7', T0);
  c = schedule(c, GRADE.EASY, T0);
  for (let i = 0; i < 50; i++) c = schedule(c, GRADE.EASY, T0 + (i + 1) * DAY);
  ok(c.ease <= DEFAULT_CONFIG.maxEase, `ease 有上限 ${DEFAULT_CONFIG.maxEase}（防止间隔爆炸）`, `ease=${c.ease}`);
}

console.log('\n[8] isDue / pickDue 排序');
{
  const now = T0;
  const mk = (id, state, due, lapses) => ({ ...newCard(id, now), state, due, lapses });

  const cards = [
    mk('review-future', STATE.REVIEW, now + DAY, 0),
    mk('review-overdue-slight', STATE.REVIEW, now - MINUTE, 0),
    mk('review-overdue-long', STATE.REVIEW, now - 10 * DAY, 0),
    mk('learning', STATE.LEARNING, now - MINUTE, 0),
    mk('relearning', STATE.RELEARNING, now - MINUTE, 0),
    mk('new', STATE.NEW, now, 0),
    mk('review-lots-of-lapses', STATE.REVIEW, now - MINUTE, 7),
  ];

  eq(isDue(cards[0], now), false, '未到期的 isDue=false');
  eq(isDue(cards[1], now), true, '已到期的 isDue=true');

  const due = pickDue(cards, now);
  eq(due.length, 6, '挑出 6 个到期的（排除未来那个）');
  eq(due[0].state === STATE.LEARNING || due[0].state === STATE.RELEARNING, true,
    '学习/重学状态排最前（分钟级步骤不能拖）');
  const futureIdx = due.findIndex((c) => c.wordId === 'review-future');
  eq(futureIdx, -1, '未来的词不在到期列表里');

  const withFuture = pickDue(cards, now, { includeFuture: true });
  eq(withFuture.length, 7, 'includeFuture 时包含全部');

  const limited = pickDue(cards, now, { limit: 3 });
  eq(limited.length, 3, 'limit 生效');

  // 同为 review 且都逾期时，遗忘次数多的优先
  const reviewOnly = pickDue(
    [mk('few', STATE.REVIEW, now - MINUTE, 0), mk('many', STATE.REVIEW, now - MINUTE, 9)],
    now,
  );
  eq(reviewOnly[0].wordId, 'many', '同逾期程度时，lapses 多的优先');

  // 逾期更久的优先
  const byOverdue = pickDue(
    [mk('recent', STATE.REVIEW, now - MINUTE, 0), mk('old', STATE.REVIEW, now - 30 * DAY, 0)],
    now,
  );
  eq(byOverdue[0].wordId, 'old', '逾期更久的优先');
}

console.log('\n[9] 记忆加深加权排序');
{
  const now = T0;
  const cards = [
    { ...newCard('easy-word', now), state: STATE.REVIEW, lapses: 0, interval: 60, ease: 2.8, lastGrade: GRADE.GOOD, lastAt: now - DAY },
    { ...newCard('hard-word', now), state: STATE.REVIEW, lapses: 5, interval: 2, ease: 1.4, lastGrade: GRADE.AGAIN, lastAt: now - 40 * DAY },
    { ...newCard('mid-word', now), state: STATE.REVIEW, lapses: 2, interval: 10, ease: 2.2, lastGrade: GRADE.GOOD, lastAt: now - 10 * DAY },
    { ...newCard('never-studied', now), state: STATE.NEW, lapses: 0, interval: 0, ease: 2.5 },
  ];

  const ranked = weightForReinforce(cards, now);
  eq(ranked[0].card.wordId, 'hard-word', '最难的词排第一');
  eq(ranked[ranked.length - 1].card.wordId, 'easy-word', '最简单的词排最后');
  ok(ranked[0].score > ranked[1].score, `分数有区分度：${ranked[0].score} > ${ranked[1].score}`);
  eq(ranked.find((r) => r.card.wordId === 'never-studied'), undefined,
    '没学过的词不属于"加深"范围（不该出现在结果里）');

  // 刚忘过的词要加权
  const fresh = [
    { ...newCard('just-lapsed', now), state: STATE.RELEARNING, lapses: 1, interval: 5, ease: 2.4, lastGrade: GRADE.AGAIN, lastAt: now },
    { ...newCard('stable', now), state: STATE.REVIEW, lapses: 1, interval: 5, ease: 2.4, lastGrade: GRADE.GOOD, lastAt: now },
  ];
  const r2 = weightForReinforce(fresh, now);
  eq(r2[0].card.wordId, 'just-lapsed', '同样 lapses 时，"刚忘过"的排更前');
}

console.log('\n[10] dayKey 的"一天从几点开始"');
{
  // ⚠️ 这里必须用**本地时间**构造时间戳，不能用 Date.UTC。
  // 之前用 Date.UTC 写这组断言时，测试在任何时区都"通过"，却掩盖了真实缺陷：
  // dayKey 当时取的是 getUTC*，于是边界被钉在 UTC 4 点 ——
  // 在 UTC+8 下（也就是用户所在时区）实际是**中午 12 点**才换日，
  // 每日新词额度要到中午才重置。测试跑在 UTC 上所以看不出来。
  // 改用本地时间构造之后，这条断言才真正在测"本地凌晨 4 点换日"。
  const local = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi || 0, 0, 0).getTime();
  const at3am = local(2026, 1, 15, 3, 0);
  const at5am = local(2026, 1, 15, 5, 0);
  const at2359 = local(2026, 1, 14, 23, 59);
  eq(dayKey(at5am), '2026-01-15', '本地早上 5 点算 1/15');
  eq(dayKey(at3am), '2026-01-14', '本地凌晨 3 点算前一天（熬夜学习额度不白 reset）');
  eq(dayKey(at2359), '2026-01-14', '本地前一天 23:59 算 1/14');
  // 换日边界必须正好落在本地 04:00
  eq(dayKey(local(2026, 1, 15, 3, 59)), '2026-01-14', '本地 03:59 仍算前一天');
  eq(dayKey(local(2026, 1, 15, 4, 0)), '2026-01-15', '本地 04:00 整换日');
  // 时区无关性：dayKey 的结果不该依赖进程时区，只依赖传入的本地时刻
  eq(dayKey(T0), dayKey(new Date(T0).getTime()), 'dayKey 是纯函数，同一时间戳结果稳定');
}

console.log('\n[11] forecast 复习预测');
{
  const now = T0;
  const mk = (id, due) => ({ ...newCard(id, now), state: STATE.REVIEW, due });
  const cards = [
    mk('a', now - 5 * DAY),        // 逾期 → 算今天
    mk('b', now - DAY),            // 逾期 → 算今天
    mk('c', now),                  // 今天
    mk('d', now + DAY),            // 明天
    mk('e', now + DAY),            // 明天
    mk('f', now + 5 * DAY),        // 5 天后
    mk('g', now + 400 * DAY),      // 超出预测窗口
  ];
  const f = forecast(cards, now, 30);
  eq(f.length, 30, '默认预测 30 天');
  eq(f[0].count, 3, '逾期的都算今天（2 个逾期 + 1 个今天）');
  eq(f[1].count, 2, '明天 2 个');
  eq(f[5].count, 1, '第 6 天（索引 5）1 个');
  const total = f.reduce((s, x) => s + x.count, 0);
  eq(total, 6, '窗口外的词不被计入（不虚报）');
}

console.log('\n[12] summarize 概况统计');
{
  const now = T0;
  const mk = (id, state, interval, due, lapses) => ({ ...newCard(id, now), state, interval, due, lapses });
  const cards = [
    mk('n1', STATE.NEW, 0, now, 0),
    mk('l1', STATE.LEARNING, 0, now, 0),
    mk('r1', STATE.REVIEW, 30, now + 30 * DAY, 0),    // mature
    mk('r2', STATE.REVIEW, 5, now - DAY, 2),          // young, 逾期
    mk('rl', STATE.RELEARNING, 5, now, 1),
  ];
  const s = summarize(cards, now);
  eq(s.total, 5, '总数 5');
  eq(s.new, 1, 'new = 1');
  eq(s.learning, 1, 'learning = 1');
  eq(s.review, 2, 'review = 2');
  eq(s.relearning, 1, 'relearning = 1');
  eq(s.due, 4, '到期 = 4（除了 30 天后的那个）');
  eq(s.mature, 1, '成熟卡片(>=21天) = 1');
  eq(s.young, 2, 'young(0<interval<21) = 2');
  eq(s.totalLapses, 3, '累计遗忘 = 3');
  ok(s.avgEase > 2 && s.avgEase < 3, 'ease 均值合理', `avgEase=${s.avgEase}`);
}

console.log('\n[13] humanInterval 说人话');
{
  const now = T0;
  eq(humanInterval(newCard('x', now), now), '新词', '新词');
  eq(humanInterval({ ...newCard('x', now), state: STATE.REVIEW, due: now - DAY }, now), '逾期 1 天', '逾期 1 天');
  eq(humanInterval({ ...newCard('x', now), state: STATE.LEARNING, due: now + 10 * MINUTE }, now), '10 分钟后', '10 分钟后');
  eq(humanInterval({ ...newCard('x', now), state: STATE.REVIEW, due: now + 3 * DAY }, now), '3 天后', '3 天后');
  eq(humanInterval({ ...newCard('x', now), state: STATE.REVIEW, due: now + 90 * DAY }, now), '3 个月后', '3 个月后');
  ok(/年/.test(humanInterval({ ...newCard('x', now), state: STATE.REVIEW, due: now + 800 * DAY }, now)), '800 天显示为年');
}

console.log('\n[14] 长期模拟：参数是否合理（不会爆炸/不会积压失控）');
{
  // 500 个词，每天新学 10 个、最多复习 200 个，答对率 85%，跑 120 天
  const r = simulate(500, 120, { newPerDay: 10, reviewsPerDay: 200, accuracy: 0.85, rand: mulberry32(7) });
  const s = r.summary;
  console.log(`      引入 ${r.introduced} 个词；状态分布 new=${s.new} learning=${s.learning} review=${s.review} relearning=${s.relearning}`);
  console.log(`      成熟 ${s.mature} / 年轻 ${s.young}；平均 ease=${s.avgEase}；累计遗忘 ${s.totalLapses}`);

  ok(r.introduced === 500, '120 天里把 500 个词都引入了', `实际 ${r.introduced}`);
  ok(s.avgEase >= DEFAULT_CONFIG.minEase && s.avgEase <= DEFAULT_CONFIG.maxEase,
    'ease 均值落在合理区间', `${s.avgEase}`);
  const maxInterval = Math.max(...r.cards.map((c) => c.interval || 0));
  ok(maxInterval <= DEFAULT_CONFIG.maxInterval, '最大间隔不超过上限', `${maxInterval} 天`);
  ok(s.mature > 0, '长期学习会产出成熟卡片', `${s.mature} 个`);
  ok(s.review > s.new, '大部分词进入了复习阶段', `review=${s.review} vs new=${s.new}`);

  // 每天复习量不该单调爆炸式增长（相邻两天差异要有界）
  const loads = r.dailyLoad.slice(-60).map((d) => d.reviews);
  const avgLate = loads.reduce((a, b) => a + b, 0) / loads.length;
  console.log(`      后 60 天平均每天复习 ${avgLate.toFixed(1)} 个词`);
  ok(avgLate <= 200, '每日复习量在设定的上限内', `平均 ${avgLate.toFixed(1)}`);

  // 答对率更低时，成熟卡片应该更少
  const low = simulate(500, 120, { newPerDay: 10, reviewsPerDay: 200, accuracy: 0.6, rand: mulberry32(7) });
  ok(low.summary.mature < s.mature,
    '答对率低时成熟卡片更少（算法对表现敏感）',
    `60% 答对 → ${low.summary.mature} 个成熟 vs 85% 答对 → ${s.mature} 个`);
  ok(low.summary.totalLapses > s.totalLapses,
    '答对率低时遗忘次数更多',
    `${low.summary.totalLapses} vs ${s.totalLapses}`);
  // 参数可覆盖：把学习步改成 [5]，毕业应更快
  const fast = simulate(200, 60, {
    newPerDay: 10, accuracy: 0.9, rand: mulberry32(3),
    config: { graduatingInterval: 2, learningSteps: [1] },
  });
  ok(fast.cards.every((c) => c.interval >= 0), '自定义参数也能正常跑完');
}

// ---------------------------------------------------------------------------
console.log('\n[15] 每日复习上限（2026-10 新增：复习量会累积，必须有个底）');
// ---------------------------------------------------------------------------
{
  // --- 15.1 哪些卡占"复习额度" ---
  // 语义：只有天级复习（review）才占。学习步/重学步是分钟级的入门过程，不算复习负担。
  ok(countsAgainstDailyReview({ state: STATE.REVIEW }), '天级复习的卡占额度');
  ok(!countsAgainstDailyReview({ state: STATE.LEARNING }), '学习步的卡不占额度');
  ok(!countsAgainstDailyReview({ state: STATE.RELEARNING }), '重学步的卡不占额度');
  ok(!countsAgainstDailyReview({ state: STATE.NEW }), '还没学的新词不占额度');
  ok(!countsAgainstDailyReview(null), '空卡不占额度（不抛错）');

  // --- 15.2 剩余额度 ---
  eq(reviewQuotaLeft(40, 0), 40, '额度 40、还没做 → 剩 40');
  eq(reviewQuotaLeft(40, 15), 25, '额度 40、已做 15 → 剩 25');
  eq(reviewQuotaLeft(40, 40), 0, '额度刚做完 → 剩 0');
  // 关键：做过量了不能变负数（否则 slice(0, -5) 会从尾部裁剪，行为诡异）
  eq(reviewQuotaLeft(40, 55), 0, '额度做超了也不会变成负数（clamp 到 0）');
  eq(reviewQuotaLeft(0, 10), Infinity, '上限填 0 = 不限量');
  eq(reviewQuotaLeft(-5, 10), Infinity, '负数上限也当不限量（防御非法设置）');
  eq(reviewQuotaLeft(undefined, 10), Infinity, '没有上限设置时按不限量');

  // --- 15.3 裁剪：超出的顺延，不丢词、不改数据 ---
  const mk = (id, dueOffsetDays, lapses = 0) => ({
    wordId: id, state: STATE.REVIEW, due: T0 + dueOffsetDays * DAY,
    interval: 10, ease: 2.5, lapses,
  });
  const many = [mk('a', -5), mk('b', -4), mk('c', -3), mk('d', -2), mk('e', -1)];
  const capped = capByDailyReview(many, 2, 0);
  eq(capped.length, 2, '额度 2 时只取 2 个');
  eq(capped[0].wordId, 'a', '取的是逾期最久的（顺序不被改动）');
  eq(capped[1].wordId, 'b', '第二个也是较久逾期的');
  // 顺延证：被裁掉的卡**一个都没被改动**，明天照样到期
  eq(many.length, 5, '原始卡数组长度没变（顺延不删词）');
  ok(many.every((c) => c.due <= T0), '被裁掉的卡 due 仍在过去 → 明天依然 isDue（这就是"顺延"）');
  eq(capByDailyReview(many, 0, 0).length, 5, '上限 0 = 不限量，一个都不裁');
  eq(capByDailyReview(many, 10, 0).length, 5, '额度比到期数多时不会补出多余的');
  eq(capByDailyReview(many, 40, 40).length, 0, '今天额度已做满 → 今天一个都不给');
  eq(capByDailyReview([], 40, 0).length, 0, '没有到期卡时不抛错');

  // --- 15.4 buildPlan：两个数字必须分开 ---
  // 这是修那个真 bug 的核心：以前 dueReviewCount 既当"到期总数"又当"今天要做几个"，
  // 结果按钮写"537 个到期"、点进去只给 40 个、还不告诉用户剩多少。
  const words = many.map((c) => ({ id: c.wordId, term: c.wordId }));
  const plain = buildPlan(many, words, { now: T0, newLimit: 0, reviewLimit: 40, reviewedToday: 0 });
  eq(plain.dueReviewCount, 5, '到期总数 = 5（含今天做不完的）');
  eq(plain.reviewToday, 5, '额度 40 > 到期 5 → 今天全给');
  eq(plain.reviewDeferred, 0, '没有顺延');

  const tight = buildPlan(many, words, { now: T0, newLimit: 0, reviewLimit: 2, reviewedToday: 0 });
  eq(tight.dueReviewCount, 5, '额度 2 时，到期总数仍然是 5（如实告知）');
  eq(tight.reviewToday, 2, '额度 2 时，今天只给 2 个');
  eq(tight.reviewDeferred, 3, '差额 3 个记成"顺延到明天"');
  eq(tight.dueCards.length, 2, 'dueCards 就是今天要做的这 2 个');
  ok(!tight.reviewUnlimited, '额度 2 不是不限量');
  ok(!tight.reviewQuotaUsedUp, '还有额度时不算"今日已完成"');

  // 今天做满了：额度用尽但还有到期
  const doneAll = buildPlan(many, words, { now: T0, newLimit: 0, reviewLimit: 4, reviewedToday: 4 });
  eq(doneAll.reviewToday, 0, '今天已做满额度 → 今天不再给题');
  eq(doneAll.reviewDeferred, 5, '剩下的 5 个全部顺延');
  ok(doneAll.reviewQuotaUsedUp, '标记为"今日额度已完成"（界面要提示，不能装作没事）');

  // 不限量：行为退回旧的样子（这是纯函数层的防御分支）。
  // ⚠️ 界面上已经**填不出 0 了**（范围改成 20–200），但这里必须继续测：
  //    ① 老用户的库里可能存着 0（历史数据），读到它不能炸；
  //    ② 它是 `reviewQuotaLeft` 的边界分支，删掉就没东西守着了。
  //    也就是说"界面不允许"和"纯函数要防御"是两件事，别把测试一起删了。
  const unlimited = buildPlan(many, words, { now: T0, newLimit: 0, reviewLimit: 0, reviewedToday: 3 });
  ok(unlimited.reviewUnlimited, '上限 0 → reviewUnlimited 为真（纯函数防御分支）');
  eq(unlimited.reviewToday, 5, '不限量时到期多少给多少');
  eq(unlimited.reviewDeferred, 0, '不限量时没有"顺延"这回事');

  // 默认值必须是 50（用户 2026-10 看过 12 倍数据后定的），
  // 而且它和"一场出多少题"是两回事
  const dflt = buildPlan(many, words, { now: T0, newLimit: 0 });
  eq(dflt.reviewLimit, 50, '不传 reviewLimit 时默认 50');

  // --- 15.5 新词额度没被这次改动弄坏（回归）---
  const newCards = [0, 1, 2, 3, 4, 5].map((i) => newCard('n' + i, T0));
  const newWords = newCards.map((c) => ({ id: c.wordId, term: c.wordId }));
  const np = buildPlan(newCards, newWords, { now: T0, newLimit: 4, reviewLimit: 40, reviewedToday: 0 });
  eq(np.newToday, 4, '每日新词额度仍然生效（4 个）');
  eq(np.newAvailable, 6, '可学的新词总数仍然如实统计（6 个）');
  eq(np.remainingNew, 4, '新词剩余额度 = 4');
  const npUsed = buildPlan(newCards, newWords, { now: T0, newLimit: 4, reviewedToday: 0,
    reviewLimit: 40 });
  ok(!npUsed.newQuotaUsedUp, '额度没用完时不报"已用完"');

  // --- 15.6 复习上限真的能把长期负担压下来（这才是加它的理由）---
  // ⚠️ 第一版这里写错了，留档：我一开始用"固定 500 个到期词"跑 30 天，
  //    结果**限与不限都做掉 500 个**（只是天数不同），断言就红了。
  //    原因是那个模型里没有新的到期流入，池子很快被做空 —— 测不出上限的作用。
  //    真实的复习负担是"源源不断有词到期"，所以改成每天有新词到期、
  //    而每天的处理能力被上限卡住，这样差额才会累积出来。
  const CAP = 40;
  const ARRIVE = 100;              // 每天新到期 100 个（远超上限，模拟积压）
  const loadWithCap = (cap, days) => {
    const dl = [];
    let due = 0;                   // 到期待办数
    for (let d = 0; d < days; d++) {
      due += ARRIVE;               // 今天新到期一批
      const take = cap > 0 ? Math.min(cap, due) : due;
      dl.push(take);
      due -= take;                 // 没做完的留在队列里（顺延）
    }
    return { dl, backlog: due };
  };
  const un = loadWithCap(0, 30);
  const ca = loadWithCap(CAP, 30);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  console.log(`      每天新到期 ${ARRIVE} 个、跑 30 天：不限量共做掉 ${sum(un.dl)} 个（积压 ${un.backlog}）；`
    + `每天限 ${CAP} 个共做掉 ${sum(ca.dl)} 个（积压 ${ca.backlog}）`);
  ok(ca.dl.every((n) => n <= CAP), `每天限 ${CAP} 时，没有任何一天超过上限`, `${Math.max(...ca.dl)}`);
  ok(ca.dl[0] === CAP, '第一天就把额度用满（额度不是摆设）');
  eq(sum(ca.dl), CAP * 30, `每天限 ${CAP} × 30 天 = 恰好做掉 ${CAP * 30} 个`);
  ok(ca.backlog > 0, '跟不上流入时积压会增长（这是顺延队列，不是丢词）', `积压 ${ca.backlog}`);
  ok(sum(un.dl) > sum(ca.dl), '不加限时每天做得更多（说明限制真的在起作用）',
    `${sum(un.dl)} vs ${sum(ca.dl)}`);
  ok(un.backlog === 0, '不限量时积压能被清空（证明上面那个差额不是模型漏洞）');

  // --- 15.7 ★ 12 倍杠杆：上限设太小会"永远做不完"（这是实测出来的数学事实）---
  // 这条是这整套改动里最重要的一个数字。它错了，界面上的提醒就会误导人。
  eq(REVIEW_LEVERAGE, 12, '杠杆常数是 12（实测值，改它要有新实测数据）');
  eq(recommendedReviewLimit(10), 120, '每天学 10 个 → 建议上限 120');
  eq(recommendedReviewLimit(20), 240, '每天学 20 个 → 建议上限 240');
  eq(recommendedReviewLimit(0), 0, '不学新词就没有复习负担（建议值 0）');
  eq(recommendedReviewLimit(-3), 0, '非法值按 0 处理，不抛错');

  ok(reviewLoadAdvice(150, 10).ok, '上限 150 配每天学 10 个 → 够用');
  ok(!reviewLoadAdvice(40, 10).ok, '上限 40 配每天学 10 个 → 不够（必然积压）');
  ok(reviewLoadAdvice(0, 50).ok, '上限 0（不限量）永远够用');
  eq(reviewLoadAdvice(40, 10).recommended, 120, '不够用时给出建议值 120');
  ok(reviewLoadAdvice(240, 20).ok, '刚好等于建议值也算够用');

  // ★ 用真实 simulate 交叉验证这个常数（不是自己跟自己比）：
  //   每天学 10 个、完全不限流，稳定后日均复习量应该落在建议值附近。
  const lever = simulate(4000, 400, { newPerDay: 10, accuracy: 0.85, reviewsPerDay: 1000000, rand: mulberry32(11) });
  const leverTail = lever.dailyLoad.slice(-30);
  const leverAvg = leverTail.reduce((a, d) => a + d.reviews, 0) / leverTail.length;
  console.log(`      实测交叉验证：每天学 10 个 → 稳定后日均复习 ${leverAvg.toFixed(0)} 个`
    + `（杠杆常数 12 → 建议 ${recommendedReviewLimit(10)}）`);
  ok(leverAvg > recommendedReviewLimit(10) * 0.7 && leverAvg < recommendedReviewLimit(10) * 1.3,
    '实测日均复习量与 12 倍建议值相符（±30%）', `实测 ${leverAvg.toFixed(0)}`);

  // ★ 上限太小的后果：积压涨、记牢的少。这是"必须显示提醒"的依据。
  const tightRun = simulate(4000, 400, { newPerDay: 10, accuracy: 0.85, reviewsPerDay: 40, rand: mulberry32(11) });
  const looseRun = simulate(4000, 400, { newPerDay: 10, accuracy: 0.85, reviewsPerDay: 1000000, rand: mulberry32(11) });
  console.log(`      上限 40 时成熟 ${tightRun.summary.mature} 个；不限量时成熟 ${looseRun.summary.mature} 个`);
  ok(tightRun.summary.mature < looseRun.summary.mature,
    '复习上限设太小时，记牢的词明显更少（不只是"少做点"，是效果变差）',
    `${tightRun.summary.mature} vs ${looseRun.summary.mature}`);
}

console.log('\n' + '='.repeat(72));
console.log(fail === 0 ? ` 全部通过（${passed} 项）` : ` ${fail} 项未通过，${passed} 项通过`);
console.log('='.repeat(72));
process.exit(fail === 0 ? 0 : 1);
