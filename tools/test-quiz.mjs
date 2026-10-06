/**
 * 出题器单元测试（纯函数）
 *
 * 用法：node tools/test-quiz.mjs
 *
 * 重点不是"函数能跑"，而是"题出得对不对"：
 * 选项重复、选项里混进正确答案的同义词、填空题挖不掉词——
 * 这些肉眼审代码看不出来，但用户一眼就发现。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const {
  MODES, MODE_ORDER, DEFAULT_MODE,
  normalizeAnswer, checkAnswer, primaryGloss, pickDistractors,
  makeQuestion, blankOut, pickExample, shuffle, buildQuiz, gradeQuiz,
} = await import('../app/js/quiz.js');
const { mulberry32 } = await import('../app/js/srs.js');

let fail = 0, passed = 0;
const ok = (cond, label, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
};
const eq = (a, b, label) => ok(a === b, label, a === b ? '' : `得到 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`);

// ---- 载入真实词库（用真数据测，不用编的假数据） ----
// 必须用 fileURLToPath：本目录含空格，URL.pathname 会给出 %20 路径而读不到文件
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const n5 = JSON.parse(fs.readFileSync(ROOT + '/data/vocab/n5.json', 'utf8')).items;
const n4 = JSON.parse(fs.readFileSync(ROOT + '/data/vocab/n4.json', 'utf8')).items;
const n3 = JSON.parse(fs.readFileSync(ROOT + '/data/vocab/n3.json', 'utf8')).items;
const allWords = [...n5, ...n4, ...n3];

console.log('='.repeat(72));
console.log(` 出题器单元测试   （词库：N5 ${n5.length} / N4 ${n4.length} / N3 ${n3.length}）`);
console.log('='.repeat(72));

// ---------------------------------------------------------------- 答案比对
console.log('\n[1] normalizeAnswer 宽松比对');
{
  eq(normalizeAnswer('  タベル '), 'たべる', '去空白 + 片假名折成平假名');
  eq(normalizeAnswer('ＡＢＣ'), 'abc', '全角转半角 + 转小写');
  eq(normalizeAnswer('コーヒー'), 'こーひー', '片假名折平假名，长音符保留');
  eq(normalizeAnswer('会う。'), '会う', '句号不参与比对');
  eq(normalizeAnswer('  '), '', '纯空白归一为空串');
  eq(normalizeAnswer(null), '', 'null 安全');
}

console.log('\n[1b] 设计决定：片假名与平假名互相作答算对');
{
  const w = { term: 'アパート', reading: 'アパート', kanas: ['アパート'], forms: [], zh: ['公寓'] };
  ok(checkAnswer('あぱーと', w, 'jp').ok, '听写时用平假名写出片假名外来语 → 算对');
  ok(checkAnswer('アパート', w, 'jp').ok, '原文写法当然算对');
  ok(checkAnswer('あぱと', w, 'jp').ok, '漏掉长音符也容忍（听写常见）');
  ok(!checkAnswer('あ', w, 'jp').ok, '但太短的答案不放行（长音符容忍有条件）');
}

console.log('\n[2] checkAnswer 接受合理等价形式、拒绝蹭边');
{
  const w = allWords.find((x) => x.term === '会う');
  ok(w, '词库里找到 会う');
  ok(checkAnswer('会う', w, 'jp').ok, '辞书形算对');
  ok(checkAnswer('あう', w, 'jp').ok, '读音算对');
  ok(checkAnswer('逢う', w, 'jp').ok, '其它写法（forms）算对');
  ok(checkAnswer('见面', w, 'zh').ok, '中文释义算对');
  ok(checkAnswer(' 会う ', w, 'jp').ok, '首尾空白不影响');
  ok(!checkAnswer('会', w, 'jp').ok, '只写汉字词干不算对（不蹭边）');
  ok(!checkAnswer('', w, 'jp').ok, '空答案不算对');
  ok(!checkAnswer('买', w, 'zh').ok, '无关中文不算对');
  ok(!checkAnswer('会うた', w, 'jp').ok, '多打字不算对');
}

console.log('\n[3] checkAnswer 中文释义带括注时允许只答主体');
{
  const w = { term: 'x', reading: 'x', kanas: [], forms: [], zh: ['见面（人）', '遇到'] };
  ok(checkAnswer('见面（人）', w, 'zh').ok, '完整写法算对');
  ok(checkAnswer('见面', w, 'zh').ok, '只答主体也算对');
  ok(checkAnswer('遇到', w, 'zh').ok, '第二条释义算对');
}

console.log('\n[4] primaryGloss 只取第一条、且不截断');
{
  const w = allWords.find((x) => x.zh && x.zh.length > 1);
  eq(primaryGloss(w), w.zh[0], '取第一条释义');
  ok(!primaryGloss(w).includes('…'), '不做省略号截断（截断会误导）');
  eq(primaryGloss({ zh: [] }), '', '没有释义时返回空串而不是 undefined');
  eq(primaryGloss(null), '', 'null 安全');
}

// ---------------------------------------------------------------- 干扰项
console.log('\n[5] 干扰项质量');
{
  const rand = mulberry32(11);
  const target = allWords.find((x) => x.term === '会う');

  const d = pickDistractors(target, allWords, 'jp', 3, rand);
  eq(d.length, 3, '选出 3 个干扰项');
  const targetForms = [target.term, ...(target.forms || []), ...(target.kanas || [])].map(normalizeAnswer);
  for (const x of d) {
    ok(!targetForms.includes(normalizeAnswer(x.text)),
      `干扰项「${x.text}」不与正确答案重复`, '');
  }
  const texts = d.map((x) => normalizeAnswer(x.text));
  eq(new Set(texts).size, texts.length, '干扰项之间互不重复');

  // 中文侧
  const dz = pickDistractors(target, allWords, 'zh', 3, rand);
  eq(dz.length, 3, '中文干扰项 3 个');
  const correctZh = (target.zh || []).map(normalizeAnswer);
  for (const x of dz) {
    ok(!correctZh.includes(normalizeAnswer(x.text)), `中文干扰项「${x.text}」不是正确答案`);
  }

  // 词性偏好：名词的干扰项应该更多是名词
  const noun = allWords.find((x) => (x.pos || []).includes('名词') && (x.pos || []).length === 1);
  const dn = pickDistractors(noun, allWords, 'jp', 3, mulberry32(5));
  const nounShare = dn.filter((x) => (x.w.pos || []).includes('名词')).length;
  ok(nounShare >= 2, `名词的干扰项以名词为主（${nounShare}/3）`);

  // 池子太小时不硬凑
  const tiny = pickDistractors(target, [target], 'jp', 3, rand);
  eq(tiny.length, 0, '候选池只有自己时不硬凑干扰项');
}

console.log('\n[6] 干扰项不包含正确答案的同义词（同 id 不同写法）');
{
  const w = allWords.find((x) => x.term === '会う');
  // 池子里塞进同一条目的其它写法，不应被选为干扰项
  const pool = [{ id: w.id, term: '逢う', reading: 'あう', zh: ['见面'], pos: ['动1(五段)'], level: 'N5' }];
  const d = pickDistractors(w, pool, 'jp', 3, mulberry32(1));
  eq(d.length, 0, '同一条目的其它写法不被当作干扰项');
}

// ---------------------------------------------------------------- 各模式出题
console.log('\n[7] 三种模式都能出题（模式已按用户要求收敛为 3 个）');
{
  const rand = mulberry32(2024);
  const withKanji = allWords.filter((w) => /[\u4e00-\u9fff]/.test(w.term) && w.ex && w.ex.length);
  ok(withKanji.length > 100, `有足够带汉字和例句的词可用于测试（${withKanji.length} 个）`);

  // 题干给哪一侧、答案在哪一侧、要不要手打，这三件事必须**每个模式各自固定**。
  // 不能只断言"有题干有答案"——那样把 zh2jp 和 jp2zh 写反了也照样通过。
  const SHAPE = {
    jp2zh:        { promptKind: 'jp', answerSide: 'zh', typing: false },
    zh2jp:        { promptKind: 'zh', answerSide: 'jp', typing: false },
    zh2jp_typing: { promptKind: 'zh', answerSide: 'jp', typing: true },
  };
  eq(MODE_ORDER.length, 3, '界面只列出 3 个模式');
  eq(MODE_ORDER.join(','), Object.keys(SHAPE).join(','), '模式顺序与定义一致');

  for (const mode of MODE_ORDER) {
    const spec = SHAPE[mode];
    const w = withKanji.find((x) => x.ex.some((e) => blankOut(e.jp, x).ok)) || withKanji[0];
    const q = makeQuestion(w, mode, allWords, { rand });
    eq(q.mode, mode, `${mode}: 模式标记正确`);
    ok(q.answer !== undefined && q.answer !== null && q.answer !== '', `${mode}: 有答案`, `answer=${q.answer}`);
    ok(q.prompt !== undefined && q.prompt !== '', `${mode}: 有题干`);
    ok(q.wordId === w.id, `${mode}: 关联到正确词条`);
    eq(q.promptKind, spec.promptKind, `${mode}: 题干是${spec.promptKind === 'jp' ? '日文' : '中文'}`);
    eq(q.answerSide, spec.answerSide, `${mode}: 作答侧是${spec.answerSide === 'jp' ? '日文' : '中文'}`);

    if (spec.typing) {
      // 手打题：不给选项，靠 checkAnswer 判分（接受读音/其它写法）
      eq(q.typing, true, `${mode}: 标记为打字题`);
      eq(q.choices.length, 0, `${mode}: 手打题不给选项`);
      ok(checkAnswer(q.answer, q, 'jp').ok, `${mode}: 答案是可判分的日文词形`);
      ok(q.note && /打出汉字写法或读音都算对/.test(q.note), `${mode}: 说明了「读音也算对」`, q.note);
    } else {
      // 点选题：必须有选项、且选项里含正确答案，否则这道题无法作答
      eq(q.typing, false, `${mode}: 不是打字题`);
      ok(q.choices.length >= 2, `${mode}: 有可点的选项`, `${q.choices.length} 个`);
      ok(q.choices.map(normalizeAnswer).includes(normalizeAnswer(q.answer)),
        `${mode}: 选项里含正确答案`, JSON.stringify(q.choices));
    }
    console.log(`      ${MODES[mode].label}: 题干「${String(q.prompt).slice(0, 26)}」→ 答案「${q.answer}」`);
  }
}

console.log('\n[7b] 已删除的模式必须真的出不了题（而不是悄悄退化）');
{
  // 用户要求彻底删掉语音与填空：这些 id 不能再是可出题的模式。
  // 静态断言 MODES 里没有它们，dynamic 断言 makeQuestion 会抛错——
  // 只查一处的话，将来有人把 listen 加回 MODES 但忘了分支，测试仍会绿。
  for (const dead of ['listen', 'cloze', 'kana']) {
    eq(MODES[dead], undefined, `MODES 里没有 ${dead}`);
    let err = null;
    try { makeQuestion(allWords.find((x) => x.term === '会う'), dead, allWords, {}); } catch (e) { err = e; }
    ok(err && /未知练习模式/.test(err.message), `${dead}: 出题时抛「未知练习模式」`, err ? err.message : '没有抛错');
  }
  // 假名/汉字互认被删了，但它的辅助正则还被别的判断用着，不能顺手删掉
  eq(DEFAULT_MODE, 'jp2zh', '默认模式是 jp2zh');
}

console.log('\n[8] 看日文记中文：选项含正确答案且不重复');
{
  const rand = mulberry32(7);
  const w = allWords.find((x) => x.term === '会う');
  const q = makeQuestion(w, 'jp2zh', allWords, { rand, choiceCount: 4 });
  eq(q.choices.length, 4, '4 个选项');
  eq(q.choices.includes(primaryGloss(w)), true, '选项里包含正确答案');
  eq(new Set(q.choices.map(normalizeAnswer)).size, 4, '4 个选项互不重复');
  ok(q.prompt === '会う' && q.promptSub === 'あう', '题干是词 + 读音副标题');
  eq(q.answerSide, 'zh', '作答侧是中文');
}

console.log('\n[9] 看中文记日文：选项含正确答案');
{
  const rand = mulberry32(8);
  const w = allWords.find((x) => x.term === '会う');
  const q = makeQuestion(w, 'zh2jp', allWords, { rand, choiceCount: 4 });
  eq(q.choices.length, 4, '4 个选项');
  eq(q.choices.includes('会う'), true, '选项里包含正确答案');
  eq(new Set(q.choices.map(normalizeAnswer)).size, 4, '选项互不重复');
  eq(q.prompt, primaryGloss(w), '题干是中文释义');
}

console.log('\n[10] 看汉语意思手动输入日文：题干是中文、答案认读音、不给选项');
{
  const rand = mulberry32(9);
  const kanjiWord = allWords.find((x) => x.term === '会う');
  const q = makeQuestion(kanjiWord, 'zh2jp_typing', allWords, { rand });
  eq(q.prompt, primaryGloss(kanjiWord), '题干是中文释义');
  eq(q.promptKind, 'zh', '题干类型是中文');
  eq(q.answer, '会う', '答案是日文词形');
  eq(q.answerSide, 'jp', '作答侧是日文');
  eq(q.typing, true, '标记 typing=true（UI 显示输入框）');
  eq(q.choices.length, 0, '手打题不给选项');
  // 判分要认读音：手打题里"想不起汉字写法但记得读音"必须算对，
  // 否则这个模式会变成纯考字形，和 jp2zh 重复。
  ok(checkAnswer('あう', q, q.answerSide).ok, '打出读音算对');
  ok(checkAnswer('逢う', q, q.answerSide).ok, '打出其它写法算对');
  ok(q.glosses === undefined && Array.isArray(q.zh), '题目带的是 zh 字段（判分靠它，曾用错名字导致全判错）');

  // 选项重复是选择题最刺眼的 bug：读作 だい 的汉字不止一个（台/代），
  // 若按词形去重就会冒出两个一模一样的中文选项。
  const dai = allWords.filter((x) => x.reading === 'だい');
  ok(dai.length >= 1, `词库里存在读音撞车的词（だい 有 ${dai.length} 个）`);
  const qd = makeQuestion(dai[0], 'jp2zh', allWords, { rand });
  eq(new Set(qd.choices.map(normalizeAnswer)).size, qd.choices.length,
    '读音撞车的词也不会出现重复选项', JSON.stringify(qd.choices));

  const kanaWord = allWords.find((x) => !/[\u4e00-\u9fff]/.test(x.term));
  const q2 = makeQuestion(kanaWord, 'zh2jp_typing', allWords, { rand });
  eq(q2.answer, kanaWord.term, '纯假名词也能出成手打题（答案=词形）');
  ok(checkAnswer(kanaWord.reading, q2, q2.answerSide).ok, '纯假名词答读音也算对');
}

console.log('\n[11] 没有读音的词：note 不能提示「读音也算对」');
{
  const rand = mulberry32(10);
  const w = { id: 'fake:2', term: '架空漢字', level: 'N5', zh: ['虚构'], pos: ['名词'], forms: [], kanas: [], ex: [] };
  const q = makeQuestion(w, 'zh2jp_typing', allWords, { rand });
  eq(q.typing, true, '仍然是打字题');
  eq(q.note, '', '没有 reading 时 note 为空（不承诺一个判不了的等价形式）');
  const withReading = makeQuestion(allWords.find((x) => x.term === '会う'), 'zh2jp_typing', allWords, { rand });
  ok(withReading.note, '有读音的词才提示读音也算对', withReading.note);
}

console.log('\n[12] blankOut 仍按词形挖空（模式虽已删除，工具函数保留复用）');
{
  const rand = mulberry32(11);
  const w = allWords.find((x) => x.term === '会う');

  // 活用形场景：例句里是"会いましょう"，辞书形"会う"整体 replace 匹配不到
  const b1 = blankOut('明日駅で会いましょう。', w);
  ok(b1.ok, '活用形例句也能挖空');
  ok(b1.blanked.includes('＿＿＿'), '活用形被挖掉', b1.blanked);
  ok(!b1.blanked.includes('会'), '汉字词干也被挖掉（不会留下"会"这个提示）', b1.blanked);

  const b2 = blankOut('会う人会う人に挨拶した。', w);
  ok(b2.ok && b2.blanked.includes('＿＿＿'), '多次出现时至少挖掉一处');

  const b3 = blankOut('全然関係ない文です。', w);
  eq(b3.ok, false, '句子里没有该词时如实返回 false（不硬挖）');
}

console.log('\n[13] 手打题的题型不依赖例句（没有例句也照样出题）');
{
  const rand = mulberry32(12);
  const noEx = { id: 'fake:1', term: '架空語', reading: 'かくうご', level: 'N5', zh: ['虚构词'], pos: ['名词'], forms: [], kanas: [], ex: [] };
  const q = makeQuestion(noEx, 'zh2jp_typing', [noEx, ...allWords], { rand });
  eq(q.mode, 'zh2jp_typing', '没有例句照样出题，不需要退化');
  // 手打题不设选项，所以 buildQuiz 的"至少 2 个选项"过滤不能把它误杀
  ok(q.typing && q.choices.length === 0, '手打题没有选项也不影响出题');
}

console.log('\n[14] pickExample 只挑"挖得动"的例句');
{
  const w = allWords.find((x) => x.term === '会う');
  for (let i = 0; i < 20; i++) {
    const ex = pickExample(w, mulberry32(i));
    ok(!!ex, `第 ${i + 1} 次都挑到可用例句`);
    if (!ex) break;
    ok(blankOut(ex.jp, w).ok, '  —— 且该例句确实挖得动');
  }
}

// ---------------------------------------------------------------- 组卷与判分
console.log('\n[15] buildQuiz 组一张卷子');
{
  const rand = mulberry32(99);
  const quiz = buildQuiz(allWords.slice(0, 200), { count: 20, pool: allWords, rand, choiceCount: 4 });
  ok(quiz.length > 0, `组出 ${quiz.length} 道题`);
  ok(quiz.length <= 20, '不超过请求的题量');

  const ids = quiz.map((q) => q.wordId);
  eq(new Set(ids).size, ids.length, '同一张卷子不出现重复的词');

  // 每道选择题都必须有正确答案在选项里、且选项不重复
  for (const q of quiz) {
    if (q.typing || !q.choices.length) continue;
    ok(q.choices.map(normalizeAnswer).includes(normalizeAnswer(q.answer)),
      `题(${q.mode}) 选项包含正确答案`, `${JSON.stringify(q.choices)} vs ${q.answer}`);
    eq(new Set(q.choices.map(normalizeAnswer)).size, q.choices.length,
      `题(${q.mode}) 选项无重复`);
  }

  // 指定单一模式
  const onlyJp = buildQuiz(allWords.slice(0, 50), { count: 10, modes: ['jp2zh'], pool: allWords, rand });
  eq(onlyJp.every((q) => q.mode === 'jp2zh'), true, '可以锁定单一模式');
}

console.log('\n[15b] buildQuiz 不传 modes：统一用默认模式，不再随机混用');
{
  // 这是用户明确要求的行为：选定一个功能，整场就只有这一个功能。
  // 以前这里会"按哪种出得出来"随机挑，同一场学习里交互方式会突然从
  // 点选变成手打，所以现在必须固定为 DEFAULT_MODE。
  const rand = mulberry32(123);
  const quiz = buildQuiz(allWords.slice(0, 60), { count: 30, pool: allWords, rand, choiceCount: 4 });
  ok(quiz.length > 0, `组出 ${quiz.length} 道题`);
  eq(quiz.every((q) => q.mode === DEFAULT_MODE), true,
    `每道题都用默认模式 ${DEFAULT_MODE}`, [...new Set(quiz.map((q) => q.mode))].join(','));
  eq(quiz.some((q) => q.typing), false, '不会悄悄混进打字题');
  ok(quiz.every((q) => q.promptKind === 'jp' && q.answerSide === 'zh'),
    '题干一律是日文、作答侧一律是中文');

  // 显式传 modes 时才允许混合（小测就是这么做的）
  const mixed = buildQuiz(allWords.slice(0, 60), { count: 30, pool: allWords, rand, modes: ['jp2zh', 'zh2jp', 'zh2jp_typing'] });
  const kinds = new Set(mixed.map((q) => q.mode));
  ok([...kinds].every((m) => ['jp2zh', 'zh2jp', 'zh2jp_typing'].includes(m)),
    '显式传 modes 时只在这三个模式里挑', [...kinds].join(','));
  ok(mixed.every((q) => !q.typing || q.choices.length === 0),
    '混合卷里的手打题同样不给选项');
}

console.log('\n[16] buildQuiz 的边界');
{
  const rand = mulberry32(3);
  eq(buildQuiz([], { count: 10, rand }).length, 0, '空词池 → 空卷子');
  const fewer = buildQuiz(allWords.slice(0, 3), { count: 10, pool: allWords, rand });
  ok(fewer.length <= 3, '词不够时按实际数量出题，不硬凑', `${fewer.length} 道`);
  const avoided = buildQuiz(allWords.slice(0, 5), { count: 5, pool: allWords, rand, avoidIds: new Set([allWords[0].id]) });
  ok(!avoided.some((q) => q.wordId === allWords[0].id), 'avoidIds 里的词被排除');
}

console.log('\n[17] gradeQuiz 判分');
{
  const rand = mulberry32(42);
  const words = allWords.slice(0, 6);
  const quiz = buildQuiz(words, { count: 6, pool: allWords, rand, modes: ['jp2zh'] });
  ok(quiz.length >= 4, `组出 ${quiz.length} 道题用于判分`);

  // 全对
  const allRight = gradeQuiz(quiz.map((q) => ({ question: q, input: q.answer })));
  eq(allRight.correct, quiz.length, '全答对应全对');
  eq(allRight.wrong, 0, '错 0 道');
  eq(allRight.accuracy, 100, '正确率 100%');

  // 全错
  const allWrong = gradeQuiz(quiz.map((q) => ({ question: q, input: '绝不是答案' })));
  eq(allWrong.correct, 0, '全答错应全错');
  eq(allWrong.accuracy, 0, '正确率 0%');

  // 一半对
  const half = gradeQuiz(quiz.map((q, i) => ({ question: q, input: i % 2 === 0 ? q.answer : '错' })));
  ok(half.correct >= 1 && half.correct < quiz.length, '对错混合时结果介于两者之间', `${half.correct}/${quiz.length}`);
  ok(half.detail.every((d) => 'ok' in d && 'wordId' in d), '判分明细含 ok 与 wordId（错题本要用）');
}

console.log('\n[18] 判分一致性：选择题点选与手打同样答案结果必须一致');
{
  const rand = mulberry32(55);
  const w = allWords.find((x) => x.term === '会う');
  const qZh = makeQuestion(w, 'jp2zh', allWords, { rand });
  const qJp = makeQuestion(w, 'zh2jp', allWords, { rand });

  const a1 = gradeQuiz([{ question: qZh, input: qZh.answer }]);
  const a2 = gradeQuiz([{ question: qZh, input: primaryGloss(w) }]);
  eq(a1.correct, a2.correct, '中文侧：选项答案与手打同一释义判分一致');

  const b1 = gradeQuiz([{ question: qJp, input: '会う' }]);
  const b2 = gradeQuiz([{ question: qJp, input: 'あう' }]);
  eq(b1.correct, 1, '手打辞书形算对');
  eq(b2.correct, 1, '手打读音也算对（宽松比对，两条路径一致）');
}

console.log('\n[19] shuffle 可复现且是真打乱');
{
  const a = [1, 2, 3, 4, 5, 6, 7, 8];
  const r1 = shuffle(a, mulberry32(1));
  const r2 = shuffle(a, mulberry32(1));
  eq(JSON.stringify(r1), JSON.stringify(r2), '同种子结果一致（测试可复现）');
  eq(r1.length, a.length, '元素数量不变');
  eq(new Set(r1).size, a.length, '元素不丢失不重复');
  eq(JSON.stringify(a), JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8]), '原数组不被改动');
}

console.log('\n[20] 大规模抽查：1000 道题里不许出现坏题');
{
  const rand = mulberry32(20260101);
  const pool = allWords;
  let bad = 0;
  let checked = 0;
  let choiceCountBad = 0;
  let dupBad = 0;
  let noAnswer = 0;

  for (let i = 0; i < 1000; i++) {
    const w = pool[Math.floor(rand() * pool.length)];
    const modes = MODE_ORDER;
    const mode = modes[Math.floor(rand() * modes.length)];
    let q;
    try {
      q = makeQuestion(w, mode, pool, { rand });
    } catch (e) {
      bad++; console.log(`      出题抛错: ${mode} / ${w.term} — ${e.message}`); continue;
    }
    checked++;

    if (q.answer === undefined || q.answer === null || q.answer === '') { noAnswer++; }
    if (!q.typing && q.choices.length) {
      const norms = q.choices.map(normalizeAnswer);
      if (new Set(norms).size !== norms.length) {
        dupBad++;
        if (dupBad <= 3) console.log(`      选项重复: ${mode} / ${w.term} → ${JSON.stringify(q.choices)}`);
      }
      if (!norms.includes(normalizeAnswer(q.answer))) {
        choiceCountBad++;
        if (choiceCountBad <= 3) console.log(`      选项里没有正确答案: ${mode} / ${w.term} → ${JSON.stringify(q.choices)} vs ${q.answer}`);
      }
    }
  }

  console.log(`      抽查 ${checked} 道题`);
  eq(bad, 0, '出题不抛错');
  eq(noAnswer, 0, '每道题都有答案');
  eq(dupBad, 0, '没有选项重复的题');
  eq(choiceCountBad, 0, '没有"选项里没有正确答案"的题');
}

// ---------------------------------------------------------------- 主词形质量
console.log('\n[21] 词库主词形：该写假名的写假名，该写汉字的写汉字');
// ---------------------------------------------------------------------------
// 这一节守的是一个真实反馈过的 bug：そこ 被显示成「其処」、とても 被显示成「迚も」。
// 根因是 build-vocab.mjs 选主词形时"只要有汉字形就用汉字形"，
// 把 JMdict 标为 rK（罕用）的写法也当成了主形。
//
// ⚠️ 为什么这个断言必须落在测试里而不是只写在构建脚本注释里：
// 词库是**生成物**，随手重跑一次 build-vocab.mjs 就可能把错误规则带回来，
// 而源码 diff 里看不出来（data/ 是几百 KB 的 JSON）。
// 只有拿产物本身的特征来断言，才能挡住"规则被改回去"。
{
  const fs2 = fs;
  const levels = ['n5', 'n4', 'n3', 'n2', 'n1', 'extra'];
  const all = [];
  for (const lv of levels) {
    const items = JSON.parse(fs2.readFileSync(`${ROOT}/data/vocab/${lv}.json`, 'utf8')).items || [];
    for (const w of items) all.push({ ...w, lv });
  }

  // (1) 上游标为 rK/oK/sK 的汉字形，不该成为主词形
  const badPrimary = all.filter((w) => /[\u4e00-\u9fff]/.test(w.term) && w.termReason === 'kana-fallback');
  eq(badPrimary.length, 0, '没有"该用假名却用了汉字"的词条',
    badPrimary.slice(0, 5).map((w) => `${w.term}(${w.reading})`).join(' '));

  // (2) 这批"汉字形罕见到不必认"的词，主形必须已经是假名
  const KANA_MUST = [
    ['其処', 'そこ'], ['何処', 'どこ'], ['此処', 'ここ'], ['彼処', 'あそこ'],
    ['迚も', 'とても'], ['矢張り', 'やはり'], ['為る', 'する'], ['一寸', 'ちょっと'],
    ['有る', 'ある'], ['未だ', 'まだ'], ['居る', 'いる'], ['成る', 'なる'],
  ];
  for (const [kanji, kana] of KANA_MUST) {
    const stillKanji = all.some((w) => w.term === kanji);
    const hasKana = all.some((w) => w.term === kana);
    ok(!stillKanji && hasKana, `${kanji} 不再作为主词形，${kana} 已就位`,
      `残留汉字=${stillKanji} 有假名主形=${hasKana}`);
  }

  // (3) 该保留汉字的没被误伤 —— 这些汉字在真实文章里满地都是，改了学习者就读不懂课文
  const KEEP_KANJI = ['会う', '青い', '明日', '日本語', '勉強', '先生',
    '事', '時', '物', '所', '方', '訳', '筈', '程', '又'];
  const missing = KEEP_KANJI.filter((t) => !all.some((w) => w.term === t));
  eq(missing.length, 0, '该保留汉字的词形都还在', missing.join(' '));

  // (4) 同音词不能被牵连 —— 按读音一刀切会把 入る/鳴る/擦る 也改成假名
  const HOMOPHONE_KEEP = ['入る', '鳴る', '擦る', '刷る', '炒る', '個々'];
  const homBad = HOMOPHONE_KEEP.filter((t) => !all.some((w) => w.term === t));
  eq(homBad.length, 0, '同音词没有被误改（按汉字形而非读音判定）', homBad.join(' '));

  // (5) 主形是汉字、但平时也常写假名的词，要带 kanaHint 把假名写法带出来
  for (const t of ['事', '時', '物', '所', '方', '訳', '又']) {
    const w = all.find((x) => x.term === t);
    ok(!!w && !!w.kanaHint, `${t} 带 kanaHint（${w ? w.kanaHint : '—'}）`);
  }

  // (6) 数据结构完整性：新字段是下游（界面/其它脚本）会依赖的
  const noCommon = all.filter((w) => typeof w.common !== 'boolean').length;
  const noReason = all.filter((w) => typeof w.termReason !== 'string').length;
  eq(noCommon, 0, '每个词条都有 boolean 的 common 字段');
  eq(noReason, 0, '每个词条都有 termReason 字段（便于排查"为什么显示假名"）');

  console.log(`      共检查 ${all.length} 个词条`);
}

console.log('\n' + '='.repeat(72));
console.log(fail === 0 ? ` 全部通过（${passed} 项）` : ` ${fail} 项未通过，${passed} 项通过`);
console.log('='.repeat(72));
process.exit(fail === 0 ? 0 : 1);
