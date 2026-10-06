/**
 * 版面重建的纯函数测试（不需要 Python、不需要真图、毫秒级）。
 *
 * 为什么这个测试必须存在：
 *   用户手上的书**全是竖排**，而竖排重建是纯几何算法 —— 一旦某条规则写错，
 *   表现是"识别出来的文字顺序乱了"，比崩溃更难发现（不会报错，只是读不通）。
 *   所以每条规则都要有断言钉住。
 *
 * 关键：下面的用例坐标**全部来自真实 OCR 输出**（rapidocr 3.9.2 + 日文模型），
 *   不是编的。编的坐标只能证明"代码符合我的想象"。
 */
import {
  isTall, cx, bottom, median,
  detectLayout, clusterColumns, clusterRows,
  findFurigana, joinBlocks, reconstruct, layoutSummary,
} from '../app/js/ocrlayout.js';

let pass = 0, fail = 0;
const failures = [];
function check(cond, label, extra = '') {
  if (cond) { pass++; }
  else { fail++; failures.push(`${label}${extra ? '  —— ' + extra : ''}`); }
}
function group(t) { console.log(`\n[${t}]`); }

// ─────────────────────────────────────────────────────────────────────
// 真实数据：竖排带注音（rapidocr 3.9.2 + japan_PP-OCRv4_rec_mobile.onnx 实测输出）
// 合成图：正文 52pt MS Mincho，注音 20pt，两列
// ─────────────────────────────────────────────────────────────────────
const REAL_VERTICAL = {
  ok: true,
  image: {
    width: 360, height: 560,
    rowBands: 8, colBands: 3,
    rowPeaks: 8, colPeaks: 6,
    meanPeakH: 20.88, maxPeakH: 44.0, meanPeakW: 15.17, maxPeakW: 43.0,
    inkRatio: 0.02,
  },
  engine: { name: 'rapidocr', recLang: 'japan' },
  count: 7,
  items: [
    { text: '猫が歩いた', x: 57, y: 29, w: 57, h: 306, score: 0.9618 },
    { text: 'ねこ', x: 115, y: 37, w: 40, h: 24, score: 0.9983 },
    { text: 'にち', x: 254, y: 36, w: 42, h: 32, score: 1.0 },
    { text: '本語を', x: 199, y: 89, w: 57, h: 184, score: 0.9465 },
    { text: 'ほん', x: 255, y: 99, w: 43, h: 25, score: 0.9999 },
    { text: 'ある', x: 116, y: 160, w: 41, h: 26, score: 0.9995 },
    { text: 'が', x: 60, y: 100, w: 52, h: 60, score: 0.99 },
  ],
};

// ─────────────────────────────────────────────────────────────────────
// 真实数据：横排（实测输出）
// 注意：这里必须带上真实的投影度量，因为"横排还是竖排"主要靠投影带判断。
//   实测（900x120 的一行长句）：rowBands=1  colBands=25
//     → 水平方向只有 1 段墨（就那一行），垂直方向 25 段（被字的间隙切碎）
//   实测（360x560 的竖排两列）：rowBands=8  colBands=3
//     → 水平方向 8 段（每个字），垂直方向 3 段（真正的列）
//   ★ 这个对比是本项目版面判断的核心证据，改判据前先看这两行。
// ─────────────────────────────────────────────────────────────────────
const REAL_HORIZONTAL = {
  ok: true,
  image: {
    width: 900, height: 120,
    rowBands: 1, colBands: 25,
    rowPeaks: 1, colPeaks: 29,
    meanPeakH: 45.0, maxPeakH: 45.0, meanPeakW: 13.24, maxPeakW: 42.0,
    inkRatio: 0.0528,
  },
  engine: { name: 'rapidocr', recLang: 'japan' },
  count: 1,
  items: [
    { text: '猫が歩いた日本語を勉強します', x: 6, y: 18, w: 756, h: 77, score: 0.9944 },
  ],
};

// ─────────────────────────────────────────────────────────────────────
group('基础工具函数');
// ─────────────────────────────────────────────────────────────────────
check(isTall({ w: 57, h: 306 }) === true, 'isTall：竖排列 w=57 h=306 是高窄形');
check(isTall({ w: 756, h: 77 }) === false, 'isTall：横排整行 w=756 h=77 不算高窄形');
check(isTall({ w: 40, h: 24 }) === false, 'isTall：注音 w=40 h=24 不算高窄形');
// 边界：恰好 1.3 倍
check(isTall({ w: 100, h: 130 }) === false, 'isTall 边界：h == w*1.3 不算（用严格大于）');
check(isTall({ w: 100, h: 131 }) === true, 'isTall 边界：h 略超 w*1.3 算');

check(cx({ x: 57, w: 57 }) === 85.5, 'cx：中心 = x + w/2');
check(bottom({ y: 29, h: 306 }) === 335, 'bottom：底边 = y + h');

check(median([]) === 0, 'median：空数组返回 0');
check(median([5]) === 5, 'median：单个元素');
check(median([1, 3, 2]) === 2, 'median：奇数个取中位');
check(median([1, 2, 3, 4]) === 2.5, 'median：偶数个取平均');
{
  const src = [3, 1, 2];
  median(src);
  check(src[0] === 3 && src[1] === 1 && src[2] === 2, 'median：不修改入参数组（避免副作用）');
}

// ─────────────────────────────────────────────────────────────────────
group('竖排检测（用真实坐标）');
// ─────────────────────────────────────────────────────────────────────
{
  const d = detectLayout(REAL_VERTICAL.items, REAL_VERTICAL.image);
  check(d.vertical === true, '真实竖排数据判定为竖排');
  check(d.reasons.length > 0, '给判定的理由（便于用户/开发者理解）', d.reasons.join(' / '));
  check(d.confidence > 0, '给出置信度', String(d.confidence));

  const h = detectLayout(REAL_HORIZONTAL.items, REAL_HORIZONTAL.image);
  check(h.vertical === false, '真实横排数据判定为横排', JSON.stringify(h.reasons));
}
{
  // 证据 A：高窄块占多数，即使投影数据缺失也要判竖排
  const blocks = [
    { text: 'a', x: 0, y: 0, w: 30, h: 200 },
    { text: 'b', x: 50, y: 0, w: 30, h: 200 },
    { text: 'c', x: 100, y: 0, w: 30, h: 200 },
  ];
  const d = detectLayout(blocks, {});
  check(d.vertical === true, '没有投影数据时，靠高窄块占比也能判竖排');
}
{
  // 证据 B：投影带 —— 核心判据。用真实的两组实测值。
  //   横排：rowBands=1（一行）colBands=25（字间缝）→ 不是竖排
  //   竖排：rowBands=8（每字一段）colBands=3（真正的列）→ 是竖排
  // 这里刻意用**形状中立**的块（宽扁），逼着判定只能靠投影带。
  const flatBlocks = [
    { text: 'a', x: 0, y: 0, w: 300, h: 40 },
    { text: 'b', x: 0, y: 60, w: 300, h: 40 },
    { text: 'c', x: 0, y: 120, w: 300, h: 40 },
  ];
  const dv = detectLayout(flatBlocks, { width: 360, height: 560, rowBands: 8, colBands: 3 });
  check(dv.vertical === true,
    '投影带判据：rowBands=8 / colBands=3（竖排实测值）判为竖排',
    JSON.stringify(dv.reasons));
  const dh = detectLayout(flatBlocks, { width: 900, height: 120, rowBands: 1, colBands: 25 });
  check(dh.vertical === false,
    '★ 投影带判据：rowBands=1 / colBands=25（横排实测值）判为横排',
    JSON.stringify(dh.reasons));
}
{
  // 回归：只报旧的 rowPeaks/colPeaks、没有 rowBands 时不能崩，
  // 也不能因为 colPeaks 大就误判成竖排（这正是最初踩的坑）。
  const flat = [
    { text: 'a', x: 0, y: 0, w: 300, h: 40 },
    { text: 'b', x: 0, y: 60, w: 300, h: 40 },
    { text: 'c', x: 0, y: 120, w: 300, h: 40 },
  ];
  const d = detectLayout(flat, { width: 900, height: 120, rowPeaks: 1, colPeaks: 29 });
  check(d.vertical === false,
    '★ 只有旧字段 rowPeaks/colPeaks 时，不因 colPeaks=29 误判竖排', JSON.stringify(d.reasons));
}
{
  // 证据 C：最高块远高于最宽块
  const d = detectLayout([
    { text: 'a', x: 0, y: 0, w: 40, h: 300 },
    { text: 'b', x: 200, y: 0, w: 20, h: 20 },
    { text: 'c', x: 260, y: 0, w: 20, h: 20 },
  ], {});
  check(d.vertical === true, '最高块远高于最宽块时判竖排');
}
{
  // 空输入
  const d = detectLayout([], {});
  check(d.vertical === false, '空输入不判竖排（不能崩）');
  check(d.reasons.length === 1, '空输入给出说明');
}

// ─────────────────────────────────────────────────────────────────────
group('竖排分列（核心：列从右往左）');
// ─────────────────────────────────────────────────────────────────────
{
  const cols = clusterColumns(REAL_VERTICAL.items);
  check(cols.length >= 2, `真实数据分出多列`, `实际 ${cols.length} 列`);
  // 列应该按 x 升序返回（clusterColumns 本身不排方向，方向在 reconstruct 里定）
  for (let i = 1; i < cols.length; i++) {
    check(cols[i].x >= cols[i - 1].x, `分列结果按 x 升序（第 ${i} 组）`);
  }
  // 列内按 y 升序
  for (const c of cols) {
    for (let i = 1; i < c.items.length; i++) {
      check(c.items[i].y >= c.items[i - 1].y, `列内按 y 升序（不变量）`);
    }
  }
  // 正文列（'猫が歩いた' / '本語を'）应各自成列或与近邻同列，但不能把注音并进正文列
  const mainCol = cols.find((c) => c.items.some((i) => i.text === '猫が歩いた'));
  check(!!mainCol, '找到含正文「猫が歩いた」的列');
}

// ─────────────────────────────────────────────────────────────────────
group('注音识别（fu りがな）');
// ─────────────────────────────────────────────────────────────────────
{
  const f = findFurigana(REAL_VERTICAL.items);
  const removed = f.remove.map((b) => b.text).sort();
  check(removed.includes('ねこ'), '识别出注音「ねこ」', JSON.stringify(removed));
  check(removed.includes('ある'), '识别出注音「ある」', JSON.stringify(removed));
  check(removed.includes('にち'), '识别出注音「にち」', JSON.stringify(removed));
  check(removed.includes('ほん'), '识别出注音「ほん」', JSON.stringify(removed));
  check(!removed.includes('猫が歩いた'), '★ 不能把正文「猫が歩いた」当注音删掉');
  check(!removed.includes('本語を'), '★ 不能把正文「本語を」当注音删掉');
  check(f.mainHeight > 100, '正文高度中位数合理（应接近 300，实际 ' + Math.round(f.mainHeight) + '）');
  check(typeof f.reason === 'string' && f.reason.length > 0, '给出过滤理由');
}
{
  // 兜底：候选过多时放弃过滤，绝不能删掉正文
  const many = [];
  for (let i = 0; i < 20; i++) many.push({ text: 'r' + i, x: 100, y: i * 20, w: 40, h: 20 });
  many.push({ text: 'MAIN', x: 0, y: 0, w: 50, h: 300 });
  const f = findFurigana(many);
  const keptMain = f.keep.some((b) => b.text === 'MAIN');
  check(keptMain, '★ 候选注音过多时，正文必须保住');
}
{
  // 块太少时不过滤
  const f = findFurigana([{ text: 'a', x: 0, y: 0, w: 10, h: 10 }]);
  check(f.remove.length === 0, '块太少时不冒险过滤');
  check(f.keep.length === 1, '块太少时全部保留');
}
{
  // 纯横排：所有块高度相近，不应误判注音
  const rows = [
    { text: '一行字', x: 0, y: 0, w: 300, h: 40 },
    { text: '二行字', x: 0, y: 60, w: 300, h: 40 },
    { text: '三行字', x: 0, y: 120, w: 300, h: 40 },
  ];
  const f = findFurigana(rows);
  check(f.remove.length === 0, '★ 横排等高文本不应被误判成注音', JSON.stringify(f.remove.map((b) => b.text)));
}

// ─────────────────────────────────────────────────────────────────────
group('横排分行');
// ─────────────────────────────────────────────────────────────────────
{
  const rows = clusterRows([
    { text: 'B', x: 200, y: 60, w: 100, h: 40 },
    { text: 'A', x: 0, y: 60, w: 100, h: 40 },
    { text: 'C', x: 0, y: 0, w: 100, h: 40 },
  ]);
  check(rows.length === 2, '两行分开', `实际 ${rows.length}`);
  check(rows[0].items[0].text === 'C', '行从上到下排（第一行是 y 最小的）');
  const second = rows[1].items.map((i) => i.text).join('');
  check(second === 'AB', '行内从左往右排', second);
}

// ─────────────────────────────────────────────────────────────────────
group('reconstruct：完整重建');
// ─────────────────────────────────────────────────────────────────────
{
  const r = reconstruct(REAL_VERTICAL);
  check(r.ok === true, '重建成功');
  check(r.vertical === true, '判为竖排');
  check(r.furigana.removedCount >= 4, '去掉了注音', String(r.furigana.removedCount));
  check(!r.text.includes('ねこ'), '★ 输出里不含注音「ねこ」', r.text);
  check(!r.text.includes('ある'), '★ 输出里不含注音「ある」', r.text);
  check(r.text.includes('猫が歩いた'), '★ 输出里有正文「猫が歩いた」', r.text);
  check(r.text.includes('本語を'), '★ 输出里有正文「本語を」', r.text);
  // 竖排从右往左：'本語を' 那列在 x≈199，'猫が歩いた' 在 x≈57，
  // 所以「本語を」应该排在「猫が歩いた」**前面**
  const iRight = r.text.indexOf('本語を');
  const iLeft = r.text.indexOf('猫が歩いた');
  check(iRight >= 0 && iLeft >= 0 && iRight < iLeft,
    '★ 竖排列从右往左：x 大的列排在前面', `本語を@${iRight} 猫が歩いた@${iLeft}`);
  check(r.lines.length >= 2, '分成多列/行', String(r.lines.length));
}
{
  // forceLayout 覆盖
  const r = reconstruct(REAL_VERTICAL, { forceLayout: 'horizontal' });
  check(r.vertical === false, 'forceLayout=horizontal 时不按竖排处理');
  const r2 = reconstruct(REAL_HORIZONTAL, { forceLayout: 'vertical' });
  check(r2.vertical === true, 'forceLayout=vertical 时不管证据都按竖排');
}
{
  // 横排重建
  const r = reconstruct(REAL_HORIZONTAL);
  check(r.ok === true, '横排重建成功');
  check(r.vertical === false, '横排判为横排');
  check(r.text === '猫が歩いた日本語を勉強します', '横排文字原样保留', r.text);
}
{
  // 不删注音
  const r = reconstruct(REAL_VERTICAL, { stripFurigana: false });
  check(r.furigana.removedCount === 0, 'stripFurigana=false 时不删注音');
  check(r.text.includes('ねこ'), 'stripFurigana=false 时注音留在文本里');
}
{
  // 空结果
  const r = reconstruct({ ok: true, items: [], image: {} });
  check(r.ok === true, '空结果不算失败');
  check(r.text === '', '空结果文本为空');
  check(/没有识别到文字/.test(r.note), '空结果给出人话提示', r.note);
}
{
  // worker 报错
  const r = reconstruct({ ok: false, error: 'NO_RUNTIME', message: '没有找到 OCR 运行时' });
  check(r.ok === false, 'worker 报错时重建也返回失败');
  check(r.note.includes('没有找到 OCR 运行时'), '把 worker 的提示透传出来');
}
{
  // separator
  const r = reconstruct(REAL_HORIZONTAL, { separator: ' ' });
  check(r.text === '猫が歩いた日本語を勉強します', '单个块时分隔符不产生多余空格', r.text);
}
{
  // 空文本块要被丢掉
  const r = reconstruct({
    ok: true, image: { width: 100, height: 100 },
    items: [
      { text: '  ', x: 0, y: 0, w: 10, h: 10 },
      { text: '有字', x: 0, y: 20, w: 40, h: 40 },
    ],
  });
  check(r.blocks.length === 1, '空白块被过滤', String(r.blocks.length));
}

// ─────────────────────────────────────────────────────────────────────
group('layoutSummary：给人看的提示');
// ─────────────────────────────────────────────────────────────────────
{
  const s = layoutSummary(reconstruct(REAL_VERTICAL));
  check(s.includes('竖排'), '提示里说明是竖排', s);
  check(s.includes('注音'), '提示里说明去掉了注音', s);
  check(/[。]$/.test(s), '提示以句号结尾');
}
{
  const s = layoutSummary(reconstruct({ ok: true, items: [], image: {} }));
  check(s.length > 0, '空结果也有提示', s);
}
{
  const s = layoutSummary(null);
  check(typeof s === 'string' && s.length > 0, 'null 也不崩', s);
}

// ─────────────────────────────────────────────────────────────────────
group('不变量（跨所有用例）');
// ─────────────────────────────────────────────────────────────────────
{
  // 重建绝不能丢正文：把真实数据里所有"高窄块"的文本都找回来
  const r = reconstruct(REAL_VERTICAL);
  const mainTexts = REAL_VERTICAL.items.filter(isTall).map((b) => b.text);
  for (const t of mainTexts) {
    check(r.text.includes(t), `★ 不变量：正文块「${t}」必须在输出里`);
  }
}
{
  // 幂等：同输入两次结果一致（不能有隐藏状态）
  const a = reconstruct(REAL_VERTICAL).text;
  const b = reconstruct(REAL_VERTICAL).text;
  check(a === b, '幂等：同样输入两次结果一致');
}
{
  // 不修改输入（纯函数）
  const snapshot = JSON.stringify(REAL_VERTICAL);
  reconstruct(REAL_VERTICAL);
  detectLayout(REAL_VERTICAL.items, REAL_VERTICAL.image);
  findFurigana(REAL_VERTICAL.items);
  clusterColumns(REAL_VERTICAL.items);
  check(JSON.stringify(REAL_VERTICAL) === snapshot, '纯函数：不修改传入的数据');
}
{
  // 退化输入不该抛异常
  let threw = null;
  try {
    reconstruct({ ok: true, items: [{ text: 'x' }], image: {} });   // 缺坐标
    reconstruct({ ok: true, items: [{ text: 'x', x: 0, y: 0 }], image: {} }); // 缺 w/h
    findFurigana([{ text: 'a' }, { text: 'b' }, { text: 'c' }]);
    clusterColumns([{ text: 'a' }]);
    clusterRows([{ text: 'a' }]);
    joinBlocks([]);
    median([1, 2]);
  } catch (e) { threw = e; }
  check(threw === null, '缺少坐标字段时不抛异常（OCR 数据可能不完整）',
    threw ? String(threw && threw.message) : '');
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(72));
if (fail === 0) {
  console.log(` 全部通过（${pass} 项）`);
} else {
  console.log(` ${fail} 项未通过，${pass} 项通过`);
  for (const f of failures) console.log('   ✗ ' + f);
}
console.log('='.repeat(72));
process.exit(fail === 0 ? 0 : 1);
