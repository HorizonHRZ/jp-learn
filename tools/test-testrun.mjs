/**
 * test-testrun.mjs —— 小测状态机单元测试（纯函数，不需要浏览器）
 *
 * 重点验的是"小测和练习到底哪里不一样"，以及那些只在边界上才暴露的行为：
 *   · 题量必须固定（不做答错重排队尾）——否则"20 题"这个承诺是假的
 *   · 计时到点要能判定，未作答的题要如实计为未作答而不是静默丢掉
 *   · 结果要按模式/等级分解，且分母不能拿整卷题量去糊弄
 *   · 回写用的逐题评分必须与练习走同一套 grade 口径
 */
import {
  TEST_SOURCE, COUNT_PRESETS, TIME_PRESETS,
  pickTestWords, shuffle, createTest, currentQuestion, submitTestAnswer,
  remainingMs, isTimeUp, finishTest, skippedQuestions, gradesForWriteback, formatDuration,
} from '../app/js/testrun.js';
import { GRADE } from '../app/js/srs.js';

let pass = 0, fail = 0;
const check = (cond, label, detail) => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? '  — ' + detail : ''}`);
};

/**
 * 固定随机源，让抽题结果可复现。
 * ⚠️ 这里必须直接返回"生成随机数的函数"，不要写成返回函数的函数——
 * 写错一层会让 rand() 拿到一个函数而不是数字，洗牌下标变成 NaN，
 * 结果是数组里混进 undefined（实测踩到过，症状很隐蔽）。
 */
const seeded = (seed) => {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
};

const mkWords = (n, prefix = 'w') => Array.from({ length: n }, (_, i) => ({
  id: `${prefix}${i}`,
  term: `語${i}`,
  reading: `ご${i}`,
  zh: [`词义${i}`],
  level: ['N5', 'N4', 'N3'][i % 3],
}));

/** 假的出题器：每个词出一道题，题目自带 answer/mode，足够状态机用 */
const fakeBuild = (ws, opts = {}) => ws.map((w, i) => ({
  wordId: w.id,
  mode: (opts.modes && opts.modes[i % opts.modes.length]) || 'jp2zh',
  level: w.level,
  prompt: w.term,
  answer: w.zh[0],
}));

const mkTest = (over = {}) => createTest({
  words: mkWords(30),
  count: 10,
  modes: ['jp2zh', 'zh2jp'],
  now: 1000,
  rand: seeded(42),
  buildQuestions: fakeBuild,
  ...over,
});

console.log('='.repeat(72));
console.log(' 小测状态机单元测试');
console.log('='.repeat(72));

console.log('\n[1] 常量与来源');
check(Object.keys(TEST_SOURCE).length === 4, '四种小测来源', Object.keys(TEST_SOURCE).join(', '));
check(COUNT_PRESETS.includes(10) && COUNT_PRESETS.includes(50), '题量预设含 10/50', COUNT_PRESETS.join('/'));
check(TIME_PRESETS.includes(0), '计时预设含 0（不计时）', TIME_PRESETS.join('/'));

console.log('\n[2] 抽题：去重、截断、不改原数组');
{
  const words = mkWords(5);
  const before = words.slice();
  const picked = pickTestWords(words, { count: 3, rand: seeded(1) });
  check(picked.length === 3, '按 count 截断', `得到 ${picked.length}`);
  check(words.every((w, i) => w === before[i]), '不改动传入的数组');

  const dup = [...mkWords(3), ...mkWords(3)];
  const uniqd = pickTestWords(dup, { count: 10, rand: seeded(2) });
  check(uniqd.length === 3, '同一个词重复出现只算一次', `得到 ${uniqd.length}`);

  const skipped = pickTestWords(mkWords(5), { count: 5, rand: seeded(3), avoidIds: new Set(['w0', 'w1']) });
  check(skipped.length === 3, 'avoidIds 排除掉 2 个词', `得到 ${skipped.length}`);
  check(!skipped.some((w) => w && (w.id === 'w0' || w.id === 'w1')), '被排除的词确实没出现',
    skipped.map((w) => w.id).join(', '));

  check(pickTestWords([], { count: 5 }).length === 0, '空候选返回空');
  check(pickTestWords(mkWords(3), { count: 0 }).length === 0, 'count=0 返回空');
  check(pickTestWords([{ id: 'x' }, null, undefined, {}], { count: 5 }).length === 1, '跳过没有 id 的脏数据');
}

console.log('\n[3] shuffle 是确定性且不丢元素');
{
  const a = [1, 2, 3, 4, 5, 6, 7, 8];
  const s1 = shuffle(a, seeded(7));
  const s2 = shuffle(a, seeded(7));
  check(JSON.stringify(s1) === JSON.stringify(s2), '同一个种子结果一致');
  check(s1.slice().sort((x, y) => x - y).join() === a.join(), '元素一个不少');
  check(a.join() === '1,2,3,4,5,6,7,8', '不改动原数组');

  // 回归：rand() 返回非数字时，曾经的写法会把 undefined 静默塞进数组。
  // 这里必须既不报错、也不产出空洞。
  const badRand = () => (() => 0.5);   // 返回函数而不是数字
  const s3 = shuffle(a, badRand);
  check(s3.length === a.length, 'rand 返回非数字时不丢元素', `${s3.length}/${a.length}`);
  check(s3.every((x) => x !== undefined && x !== null), 'rand 返回非数字时不产生空洞');
  const s4 = shuffle(a, () => NaN);
  check(s4.length === a.length && s4.every((x) => x !== undefined), 'rand 返回 NaN 时也不产生空洞');
}

console.log('\n[4] 建卷');
{
  const t = mkTest();
  check(t.queue.length === 10, '题量等于请求的 count', `实际 ${t.queue.length}`);
  check(t.requestedCount === 10 && t.availableCount === 10, '记录了请求题量与可用词量');
  check(t.cursor === 0 && !t.finished && !t.submitted, '初始状态：第 0 题、未完成、未交卷');
  check(t.queue.every((q) => q.wordId && q.answer), '每道题都有 wordId 与 answer');

  const few = mkTest({ words: mkWords(3), count: 20 });
  check(few.queue.length === 3, '词不够时如实只出 3 题', `实际 ${few.queue.length}`);
  check(few.requestedCount === 20 && few.availableCount === 3,
    '词不够时保留了 requested/available 的差异（结果页要如实说明）');

  const none = mkTest({ words: [] });
  check(none.queue.length === 0 && none.finished, '无词可考时直接标记完成');
}

console.log('\n[5] 逐题作答：题量固定，不做答错重排');
{
  let t = mkTest({ count: 5 });
  const total0 = t.queue.length;
  check(currentQuestion(t).index === 0, '第一题 index=0');

  // 故意全答错，看题量会不会变多（练习模式会重排，小测不能）
  for (let i = 0; i < 5; i++) {
    const cur = currentQuestion(t);
    check(cur !== null, `第 ${i + 1} 题存在`);
    t = submitTestAnswer(t, { input: '错误答案', ok: false, now: 1000 + i * 10 });
  }
  check(t.queue.length === total0, '全部答错后题量没有增加（不重排队尾）', `${total0} → ${t.queue.length}`);
  check(t.finished, '答完最后一题后标记完成');
  check(currentQuestion(t) === null, '完成后没有当前题');
  check(t.answers.length === 5 && t.answers.every((a) => !a.ok), '记录了 5 条全错');
}

console.log('\n[6] submitTestAnswer 的边界');
{
  const t = mkTest({ count: 2 });
  const t1 = submitTestAnswer(t, { input: 'a', ok: true, now: 10 });
  check(t.answers.length === 0, '原对象不被修改（纯函数）');
  check(t1.answers.length === 1 && t1.cursor === 1, '返回的新对象已推进');
  let threw = '';
  try { submitTestAnswer({ ...t1, cursor: 99 }, { input: 'x', ok: true }); } catch (e) { threw = e.message; }
  check(/没有待答的题/.test(threw), '越界作答会抛明确错误', threw || '(没抛错)');

  const done = finishTest(t1, 20);
  let threw2 = '';
  try { submitTestAnswer(done, { input: 'x', ok: true }); } catch (e) { threw2 = e.message; }
  check(/已交卷/.test(threw2), '交卷后不能再作答', threw2 || '(没抛错)');
}

console.log('\n[7] 计时');
{
  const t = mkTest({ timeLimitMs: 60 * 1000, now: 0 });
  check(remainingMs(t, 0) === 60000, '起始剩余 = 时限', String(remainingMs(t, 0)));
  check(remainingMs(t, 30 * 1000) === 30000, '过半剩余正确', String(remainingMs(t, 30 * 1000)));
  check(remainingMs(t, 90 * 1000) === 0, '超时后剩余归零（不出现负数）', String(remainingMs(t, 90 * 1000)));
  check(!isTimeUp(t, 59 * 1000), '未到点 isTimeUp=false');
  check(isTimeUp(t, 60 * 1000), '正好到点算超时');
  check(isTimeUp(t, 61 * 1000), '过了也算超时');

  const nt = mkTest({ timeLimitMs: 0, now: 0 });
  check(remainingMs(nt, 999999) === null, '不计时时 remainingMs 为 null');
  check(!isTimeUp(nt, 999999), '不计时时永远不超时');

  const done = finishTest(t, 10 * 1000);
  check(!isTimeUp(done, 999999), '已交卷后不再报超时');
  check(remainingMs(done, 0) === 0, '已交卷后剩余为 0');
}

console.log('\n[8] 算分：未作答要如实单独统计');
{
  let t = mkTest({ count: 4 });
  t = submitTestAnswer(t, { input: '对', ok: true, now: 1 });    // 对
  t = submitTestAnswer(t, { input: '错', ok: false, now: 2 });   // 错
  // 剩下 2 题不答，直接交卷（模拟计时到点自动交卷）
  const r = finishTest(t, 9999);
  check(r.submitted && r.finished, '交卷后标记 submitted/finished');
  check(r.result.total === 4, '卷面题量 4', String(r.result.total));
  check(r.result.correct === 1 && r.result.wrong === 1, '对 1 错 1', `${r.result.correct}/${r.result.wrong}`);
  check(r.result.unanswered === 2, '未作答 2 题（不是静默丢掉）', String(r.result.unanswered));
  check(r.result.answered === 2, '已作答 2 题', String(r.result.answered));
  check(r.result.accuracy === 25, '总正确率按卷面算 = 25%', String(r.result.accuracy));
  check(r.result.answeredAccuracy === 50, '已作答正确率 = 50%', String(r.result.answeredAccuracy));
  check(r.result.timeUsedMs === 9999 - 1000, '用时 = 交卷时刻 - 开考时刻', String(r.result.timeUsedMs));
  check(r.result.timeout === false, '未设时限时 timeout=false');

  const again = finishTest(r, 1);
  check(again === r, '重复交卷是幂等的（返回原对象）');
}

console.log('\n[9] 超时自动交卷：未答的题算漏掉');
{
  let t = mkTest({ count: 3, timeLimitMs: 1000, now: 0 });
  t = submitTestAnswer(t, { input: 'a', ok: true, now: 100 });
  check(isTimeUp(t, 1000), '到点判定超时');
  const r = finishTest(t, 1000);
  check(r.result.timeout === true, '结果标记 timeout=true');
  check(r.result.unanswered === 2, '未答的 2 题计为未作答', String(r.result.unanswered));
  const sk = skippedQuestions(r);
  check(sk.length === 2, 'skippedQuestions 列出漏掉的题', `列出 ${sk.length}`);
  check(sk.every((s) => s.wordId && s.prompt && s.answer), '漏掉的题带上词与答案（结果页要能回顾）');
}

console.log('\n[10] 按模式/等级分解，分母是"该维度出过的题数"');
{
  let t = mkTest({
    count: 6,
    modes: ['jp2zh', 'zh2jp'],
    words: mkWords(6),
  });
  // fakeBuild 按 i % modes.length 轮流给模式：0,2,4 是 jp2zh；1,3,5 是 zh2jp
  t = submitTestAnswer(t, { input: 'a', ok: true, now: 1 });   // jp2zh 对
  t = submitTestAnswer(t, { input: 'b', ok: false, now: 2 });  // zh2jp 错
  t = submitTestAnswer(t, { input: 'c', ok: true, now: 3 });   // jp2zh 对
  t = submitTestAnswer(t, { input: 'd', ok: true, now: 4 });   // zh2jp 对
  t = submitTestAnswer(t, { input: 'e', ok: true, now: 5 });   // jp2zh 对
  const r = finishTest(t, 6);

  check(r.result.byMode.jp2zh.asked === 3 && r.result.byMode.jp2zh.correct === 3,
    'jp2zh：出 3 题对 3 题', JSON.stringify(r.result.byMode.jp2zh));
  check(r.result.byMode.zh2jp.asked === 2 && r.result.byMode.zh2jp.wrong === 1,
    'zh2jp：出 2 题错 1 题', JSON.stringify(r.result.byMode.zh2jp));
  check(r.result.byMode.zh2jp.asked !== r.result.total,
    '单项分母不等于整卷题量（避免"出 2 题显示 2/6"的误导）');
  check(Object.keys(r.result.byLevel).length > 0, '按等级也有分解', Object.keys(r.result.byLevel).join(', '));
}

console.log('\n[11] 回写评分：与练习同一套 grade 口径');
{
  let t = mkTest({ count: 3 });
  t = submitTestAnswer(t, { input: '对', ok: true, now: 1, expected: 'e1' });
  t = submitTestAnswer(t, { input: '错', ok: false, now: 2, expected: 'e2' });
  t = submitTestAnswer(t, { input: '对2', ok: true, now: 3, expected: 'e3' });
  const wb = gradesForWriteback(t);
  check(wb.length === 3, '每题都给一条回写记录', `实际 ${wb.length}`);
  check(wb[0].grade === GRADE.GOOD && wb[2].grade === GRADE.GOOD, '答对记 good');
  check(wb[1].grade === GRADE.AGAIN, '答错记 again');
  check(wb[0].correct === true && wb[1].correct === false, 'correct 标志与 grade 一致');
  check(wb.every((x) => x.wordId && x.mode && 'input' in x && 'expected' in x),
    '回写记录字段齐全（wordId/mode/input/expected）');
  check(gradesForWriteback(null).length === 0, '空输入返回空数组');
}

console.log('\n[12] 用时格式化');
{
  check(formatDuration(0) === '0 秒', '0 → 0 秒', formatDuration(0));
  check(formatDuration(59000) === '59 秒', '59 秒', formatDuration(59000));
  check(formatDuration(60000) === '1 分 0 秒', '1 分 0 秒', formatDuration(60000));
  check(formatDuration(125000) === '2 分 5 秒', '2 分 5 秒', formatDuration(125000));
  check(formatDuration(-5) === '0 秒', '负数不出现负时间', formatDuration(-5));
}

console.log('\n' + '='.repeat(72));
console.log(fail === 0 ? ` 全部通过（${pass} 项）` : ` ${fail} 项未通过（通过 ${pass} 项）`);
console.log('='.repeat(72));
process.exit(fail === 0 ? 0 : 1);
