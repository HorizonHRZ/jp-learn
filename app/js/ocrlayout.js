/**
 * 版面重建：把 OCR 的散乱文本块，还原成**可阅读的横排文章**。
 *
 * ──────────────────────────────────────────────────────────────────
 * 这个文件为什么存在（它解决的问题是"书上是竖排的"）
 * ──────────────────────────────────────────────────────────────────
 * 用户手上的书**全是竖排**，但阅读时想要横排（左日右中）。
 * OCR 引擎给出的是一堆带坐标的文本块，顺序和阅读顺序无关：
 *
 *   实测（竖排带注音的一张图）：
 *     '猫が歩いた'  x=57  y=29   w=57  h=306   ← 正文列：又高又窄
 *     'ねこ'       x=115 y=37   w=40  h=24    ← 注音：又矮又宽
 *     'にち'       x=254 y=36   w=42  h=32    ← 注音
 *     '本語を'      x=199 y=89   w=57  h=184   ← 正文列
 *     'ほん'       x=255 y=99   w=43  h=25    ← 注音
 *     'ある'       x=116 y=160  w=41  h=26    ← 注音
 *
 * 直接按 y 排序拼接会得到 `猫が歩いたねこにち本語をほんある` —— 完全没法读。
 *
 * 需要做三件事：
 *   ① 判断这是**竖排**还是**横排**
 *   ② 竖排：按 x 聚成"列"，**列从右往左**，列内从上往下
 *   ③ 去掉注音（假名小字），否则正文里会插满发音
 *
 * ──────────────────────────────────────────────────────────────────
 * 为什么全放在 JS 里（而不是 Python）
 * ──────────────────────────────────────────────────────────────────
 * 这些是**纯几何算法**。放在 JS 里可以用纯函数测试逐条断言，
 * 不需要装 Python、不需要真图、毫秒级跑完、失败能精确定位到哪一条规则。
 * Python 那边只负责"出证据"（文本 + 坐标 + 投影峰值）。
 * 所以：**Python 出证据，JS 出结论。**
 *
 * ⚠️ 这个模块**不许**做任何 I/O、不许碰 DOM —— 它是纯函数，
 *    这样 test-ocrlayout.mjs 才能直接 import 它来测。
 */

/** 取块的宽/高，缺字段时当 0（OCR 数据可能不完整，不能让整条管线崩）。 */
function bw(b) { return Number(b && b.w) || 0; }
function bh(b) { return Number(b && b.h) || 0; }

/** 判断一个块是不是"竖着的"（竖排文字的一列）。 */
export function isTall(b) {
  const h = bh(b), w = bw(b);
  return h > w * 1.3;
}

/** 块的中心 x。 */
export function cx(b) {
  return (Number(b && b.x) || 0) + bw(b) / 2;
}

/** 块的底边 y。 */
export function bottom(b) {
  return (Number(b && b.y) || 0) + bh(b);
}

/** 中位数（不改动入参；忽略非数字）。 */
export function median(nums) {
  const s = (nums || []).map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 判断整张图是竖排还是横排。
 *
 * 三重证据，任何一个成立就算竖排（宁可判成竖排 —— 竖排处理更保守，
 * 判错了只影响顺序，判成横排却会把注音拼进正文）：
 *
 *   证据 A（主要）：又高又窄的块占比。竖排的正文列 w≈57 h≈306，
 *                   横排的整行是 w≈756 h≈77。
 *   证据 B（辅助）：投影峰 —— 但**必须看峰宽**，不能只看个数。
 *   证据 C（兜底）：最高的块是否明显高于最宽的块。
 *
 * ⚠️ 证据 B 踩过一个真坑，写在这里免得再犯：
 *   只数"峰值个数"会把横排误判成竖排。实测横排 900x120 的图
 *   rowPeaks=1 但 colPeaks=29 —— 因为横排每个字之间都有竖直细缝。
 *   修正：只有当"列的峰够宽"（宽到能装下一个字）时才算竖排证据。
 *   判据：meanPeakW >= 图片高度 × 0.06 —— 竖排的字宽约等于字高，
 *        而横排的"字间缝"只有几个像素。
 *
 * @param {Array} blocks 文本块
 * @param {object} image worker 给的图像度量（含 rowPeaks/colPeaks/meanPeakW/meanPeakH）
 * @returns {{vertical:boolean, confidence:number, reasons:string[]}}
 */
export function detectLayout(blocks, image = {}) {
  const reasons = [];
  const list = (blocks || []).filter(Boolean);
  if (!list.length) return { vertical: false, confidence: 0, reasons: ['没有文本块'] };

  const tall = list.filter(isTall).length;
  const tallRatio = tall / list.length;

  const hMax = Math.max(...list.map(bh));
  const wMax = Math.max(...list.map(bw));
  const imgH = Number(image.height) || 0;
  const imgW = Number(image.width) || 0;

  let vertical = false;

  // 证据 A：多数块是竖的
  if (tallRatio >= 0.5) {
    vertical = true;
    reasons.push(`${Math.round(tallRatio * 100)}% 的文本块是高窄形（竖排列）`);
  }

  // 证据 B：投影带 —— 关键是看"带的数量"，而不是峰值个数，也不是峰宽。
  //
  // ⚠️ 这里换过两次判据，把弯路记下来，因为它一点都不显然：
  //
  //   第一次用"峰值个数"（墨迹从无到有的次数）：
  //     横排 900x120 实测 rowPeaks=1 但 colPeaks=29  → 被判成竖排 ❌
  //     原因：横排每个字之间都有竖直细缝，也算"峰值"。
  //
  //   第二次用"峰的平均宽度"：
  //     横排 meanPeakW=13.24  竖排 15.17  → 几乎一样，区分不出来 ❌
  //     原因：竖排的列也会被字与字之间的缝切成好几段。
  //
  //   第三次（现在）用"**带**的数量"，并在 12% 阈值下、忽略小于 3px 的带：
  //     实测数据（见下）区分得非常干净：
  //       横排：水平带 1 条（一行），垂直带 25 条（字间缝）
  //       竖排：水平带 8 条（每个字），垂直带 3 条（真正的列）
  //     判据：**垂直带少 且 水平带多 → 竖排**
  //           垂直带多 且 水平带少 → 横排
  //
  //   直觉解释：竖排是"少而宽的列"纵向排下来，所以垂直方向只有几段墨；
  //            横排是一整行横着铺开，垂直方向被字的间隙切得很碎。
  const rb = Number(image.rowBands) || 0;   // 水平方向有几段墨（横排的"行"）
  const cb = Number(image.colBands) || 0;   // 垂直方向有几段墨（竖排的"列"）

  // 只在**明显不对称**时用它下结论（两边数量接近时说明这张图不典型，
  // 交给证据 C 和块形状去判，免得硬猜）。
  // 需要至少一条带，且少的那边不能超过多的一半（即比例 >= 2）。
  if (rb >= 1 && cb >= 1) {
    if (cb * 2 <= rb && cb <= 6) {
      vertical = true;
      reasons.push(`垂直方向只有 ${cb} 段墨，水平方向有 ${rb} 段`
        + `（典型竖排：少而宽的列纵向排下来）`);
    } else if (rb * 2 <= cb && rb <= 3) {
      reasons.push(`水平方向只有 ${rb} 段墨，垂直方向有 ${cb} 段`
        + `（典型横排：一整行横着铺开）`);
    }
  }

  // 证据 C：最高的块远高于最宽的块 —— 横排的一整行不会又高又窄
  if (hMax > wMax * 1.5 && hMax > 0) {
    vertical = true;
    reasons.push(`最高块 ${Math.round(hMax)}px 远高于最宽块 ${Math.round(wMax)}px`);
  }

  // 兜底：如果没有任何证据，看单一最高块是否够"竖"
  if (!reasons.length) {
    const areas = list.map((b) => bw(b) * bh(b));
    const biggest = list[areas.indexOf(Math.max(...areas))];
    vertical = isTall(biggest);
    reasons.push(vertical ? '面积最大的块是高窄形' : '面积最大的块是宽扁形（横排）');
  }

  const confidence = Math.min(1,
    Math.round((tallRatio * 0.6 + (hMax > wMax * 1.5 && hMax > 0 ? 0.4 : 0)) * 100) / 100);
  return { vertical, confidence, reasons };
}

/**
 * 按 x 中心把文本块聚成"列"（竖排专用）。
 *
 * 算法：先把块按 x 排序，然后贪心成组 —— 两个块的 x 中心差
 * 小于列的典型间距时算同一列。列间距用**中位块高**估计
 * （竖排里一列的字高约等于列宽，所以中位 h 是个合理尺度）。
 *
 * ⚠️ 用 h（高）而不是 w：竖排的块 w 很小（一列宽），
 *    而列与列的间距更接近"字的大小"，也就是 h。
 */
/**
 * 按 x 中心把文本块聚成"列"（竖排专用）。
 *
 * ──────────────────────────────────────────────────────────────────
 * ⚠️ 这个算法换过一次，第一版是**错的**，记下来免得重犯
 * ──────────────────────────────────────────────────────────────────
 * 第一版：先按 x 排序，相邻块中心差 <= pitch * 0.6 就并成一组，
 *         其中 pitch = 块高中位数。
 *
 * 失败现场（真实三列竖排图）：
 *   去掉注音后剩 5 块，中心分别在 69 / 86 / 266.5 / 447.5 / 496.5
 *   pitch = 块高中位数 = 304  →  容差 = 182.4
 *   第 2 列（266.5）和第 3 列（447.5）相差 181 < 182.4  →  **被并成一列** ❌
 *   结果输出 "私は学生です本語を勉強-"，两列串在一起。
 *
 * 错在哪：**块高 ≠ 列间距**。
 *   '本語を勉強' 是 5 个字合成的一块，高 305px，是该列字高的 5 倍。
 *   拿它当"列间距尺度"，容差自然大得离谱。
 *
 * 现在的做法：**按间距找"谷底"**（一维聚类里最稳的办法）。
 *   同列内距离小、跨列距离大，所以间距分布是**双峰**的，
 *   双峰之间必有一个"谷"。找到谷就用它当断点阈值。
 *
 *   找谷的办法（尺度无关）：把间距排序，找**相邻两个间距比值最大**的那一处，
 *   阈值取那两个值的几何平均。
 *
 *   ⚠️ 这里也走过一次弯路：我一开始用"间距中位数 × 2.5"当阈值。
 *      失败现场：间距 = 17 | 180.5 | 181 | 49
 *        → 中位数 114.8 → 阈值 287 → **一个断点都找不到**，五块并成一列 ❌
 *      错在哪：**跨列间距的个数可能比列内还多**（这张图 4 个间距里 3 个是跨列），
 *            中位数就被"跨列"那一侧主导了，阈值被抬到天上去了。
 *      用"最大比值跳变"就与个数无关：排序后 17 | 49 | 180.5 | 181，
 *        比值 2.88 / 3.68 / 1.00，最大在 49→180.5 → 阈值 ≈ 94 → 正确断开 ✓
 */
export function clusterColumns(blocks, opts = {}) {
  const list = (blocks || []).filter(Boolean);
  if (!list.length) return [];

  const sorted = [...list].sort((a, b) => cx(a) - cx(b));
  if (sorted.length === 1) return [{ x: cx(sorted[0]), items: [sorted[0]] }];

  // 相邻中心的间距
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(cx(sorted[i]) - cx(sorted[i - 1]));

  // 找"谷底"当断点阈值
  let cut;
  if (typeof opts.cut === 'number') {
    cut = opts.cut;
  } else {
    const sg = [...gaps].sort((a, b) => a - b);
    let bestRatio = 0, bestAt = -1;
    for (let i = 1; i < sg.length; i++) {
      if (sg[i - 1] <= 0) continue;
      const r = sg[i] / sg[i - 1];
      if (r > bestRatio) { bestRatio = r; bestAt = i; }
    }
    if (bestAt > 0 && bestRatio >= 2) {
      // 谷底：两个峰之间取几何平均
      cut = Math.sqrt(sg[bestAt - 1] * sg[bestAt]);
    } else {
      // 间距分布没有明显双峰 —— 退化成"一个间距就算断点"，
      // 但要求它足够大（避免把同一列里的抖动切成两块）。
      cut = opts.minCut ?? 24;
    }
  }

  const groups = [];
  let cur = { x: cx(sorted[0]), items: [sorted[0]] };
  for (let i = 1; i < sorted.length; i++) {
    if (gaps[i - 1] >= cut) {
      groups.push(cur);
      cur = { x: cx(sorted[i]), items: [sorted[i]] };
    } else {
      cur.items.push(sorted[i]);
      cur.x = cur.items.reduce((s, b) => s + cx(b), 0) / cur.items.length;
    }
  }
  groups.push(cur);

  // 列内从上往下
  for (const g of groups) g.items.sort((a, b) => (Number(a.y) || 0) - (Number(b.y) || 0));
  return groups;
}

/**
 * 按 y 中心把文本块聚成"行"（横排专用）。
 */
export function clusterRows(blocks, opts = {}) {
  const list = (blocks || []).filter(Boolean);
  if (!list.length) return [];
  const pitch = opts.pitch || median(list.map(bh)) || 30;
  const tol = opts.tolerance || pitch * 0.6;

  const mid = (b) => (Number(b.y) || 0) + bh(b) / 2;
  const sorted = [...list].sort((a, b) => mid(a) - mid(b));
  const groups = [];
  for (const b of sorted) {
    const c = mid(b);
    const g = groups[groups.length - 1];
    if (g && Math.abs(c - g.c) <= tol) {
      g.items.push(b);
      g.c = g.items.reduce((s, i) => s + mid(i), 0) / g.items.length;
    } else {
      groups.push({ c, items: [b] });
    }
  }
  // 行内从左往右
  for (const g of groups) g.items.sort((a, b) => (Number(a.x) || 0) - (Number(b.x) || 0));
  return groups;
}

/**
 * 找出注音块（ふりがな / ルビ）。
 *
 * 实测的几何特征（同一张竖排图）：
 *   正文列  w=57  h=306   → 高宽比 ≈ 5.4
 *   注音    w=40  h=24    → 高宽比 ≈ 0.6
 * 所以**高度**是最干净的判据：注音的高度只有正文的 1/10 左右。
 *
 * 三重条件（必须同时满足，宁可不删也不要误删正文）：
 *   ① 不是高窄形（h <= w * 1.3）
 *   ② 高度 < 局部正文高度 × ratio（默认 0.75）
 *   ③ 位于某个正文块的**右侧**（竖排注音在字右），或与之横向重叠
 *
 * @returns {{remove:Array, keep:Array, mainHeight:number, reason:string}}
 */
export function findFurigana(blocks, opts = {}) {
  const ratio = opts.ratio ?? 0.75;
  const list = (blocks || []).filter(Boolean);
  if (list.length < 3) {
    return { remove: [], keep: [...list], mainHeight: 0, reason: '块太少，不冒险过滤' };
  }

  // "正文高度"取**较高的那批块**的中位数。
  // 不能直接取全体中位数：注音块数量可能比正文列还多，会把尺度拉低。
  const tallBlocks = list.filter(isTall);
  const pool = tallBlocks.length >= 2 ? tallBlocks : list;
  const mainHeight = median(pool.map(bh)) || median(list.map(bh));
  if (!mainHeight) {
    return { remove: [], keep: [...list], mainHeight: 0, reason: '拿不到可靠的字高，不过滤' };
  }
  // 纵向关联容差：允许一个字高左右的错位。
  //
  // ⚠️ 这个容差是**必须的**，不是保险起见。实测真实竖排图上：
  //     正文块 '本語を'  y=91..271   （检测把该列第一个字单独切了出去）
  //     注音块 'にち'    y=36..66
  //   两者纵向**不重叠** → 没有容差就会判定"にち 不属于本語を" → 漏删注音。
  //   一个字高 = 该列总高 / 字宽数（竖排里一个字占一格，高≈宽）。
  const textLen = (b) => Math.max(1, [...String(b.text || '')].length);
  const perChar = median(tallBlocks.map((b) => bh(b) / textLen(b)));
  const vTol = Math.max(perChar * 1.5, 20);
  // "注音在正文右侧"的搜索窗口：真实书页里注音条与正文之间有 30~60px 空隙，
  // 所以窗口要按"一个字宽"的量级给，给窄了会漏删。
  const colWidth = median(tallBlocks.map(bw)) || mainHeight * 0.3;
  const rightWindow = Math.max(colWidth * 1.6, mainHeight * 0.5);

  const cands = [];
  for (const b of list) {
    if (isTall(b)) continue;                    // ① 高窄形是正文列
    if (bh(b) >= mainHeight * ratio) continue;  // ② 高度不够小
    // ③ 右侧或与之纵向关联：竖排注音不会跑到正文左边很远
    const besideMain = tallBlocks.some((m) => {
      const mRight = (Number(m.x) || 0) + bw(m);
      // 纵向：允许一个字高的错位（检测会把列首字单独切出去，见上面的说明）
      const overlapY = !(bottom(b) <= (Number(m.y) || 0) - vTol
        || (Number(b.y) || 0) >= bottom(m) + vTol);
      return overlapY && (Number(b.x) || 0) >= (Number(m.x) || 0) + bw(m) * 0.5
        && (Number(b.x) || 0) <= mRight + rightWindow;
    });
    if (besideMain || !tallBlocks.length) cands.push(b);
  }

  // 兜底保护：宁可留着注音，也不能把正文删掉（正文缺失比注音干扰严重得多）。
  //
  // ⚠️ 这里的第一版写错了，记下来：
  //   我原本用"候选占比 <= 60%"当保护。结果一张真实竖排小图上
  //   4 个注音 / 6 个块 = 67% > 60% → **直接放弃过滤**，注音全留着。
  //   错在哪：注音在小图里本来就该占多数（一个字配一个音），
  //          "占比"根本不反映判据是否失效。
  //
  //   正确的判据是：注音块是不是**普遍地**明显小于正文中位高度。
  //   如果一批候选的高度都不到正文的一半，那它们是注音这件事很确定，
  //   哪怕它们数量再多也该删。
  const halfOrLess = cands.filter((b) => bh(b) <= mainHeight * 0.5).length;
  const stronglySupported = cands.length > 0
    && (halfOrLess >= cands.length * 0.6 || cands.length <= 8);

  const remove = [];
  const removeSet = new Set();
  if (stronglySupported) {
    for (const b of cands) { remove.push(b); removeSet.add(b); }
  }
  const keep = list.filter((b) => !removeSet.has(b));
  const reason = remove.length
    ? `按高度/位置判据去掉 ${remove.length} 个注音块（正文高度中位数 ${Math.round(mainHeight)}px）`
    : (cands.length
      ? `候选注音 ${cands.length} 个，但高度不够统一地小，放弃过滤（避免误删正文）`
      : '没有发现注音块');
  return { remove, keep, mainHeight, reason };
}

/** 把块按顺序拼成文本。可选地在块之间加空格。 */
export function joinBlocks(ordered, opts = {}) {
  const sep = opts.separator ?? '';
  return ordered.map((b) => (b.text || '').trim()).filter(Boolean).join(sep);
}

/**
 * 从 worker 的原始输出重建可读文章。
 *
 * @param {object} raw  worker 的 JSON（含 items / image）
 * @param {object} opts
 *   stripFurigana  是否去掉注音（默认 true）
 *   separator      块间分隔符
 *   forceLayout    'vertical' | 'horizontal' | null（覆盖自动判断，给界面上的手动开关用）
 * @returns {object} 版面结果
 */
export function reconstruct(raw, opts = {}) {
  const stripFurigana = opts.stripFurigana !== false;
  const separator = opts.separator ?? '';

  if (!raw || raw.ok === false) {
    return {
      ok: false, text: '', lines: [], blocks: [], vertical: false,
      note: (raw && raw.message) || 'OCR 没有返回结果',
    };
  }

  const items = (raw.items || []).filter((b) => b && String(b.text || '').trim());
  const image = raw.image || {};

  if (!items.length) {
    return {
      ok: true, text: '', lines: [], blocks: [], vertical: false,
      note: '没有识别到文字。可能是图片太模糊、太小，或者拍的是一片空白。',
    };
  }

  const det = detectLayout(items, image);
  const vertical = opts.forceLayout
    ? opts.forceLayout === 'vertical'
    : det.vertical;

  // ── 注音过滤 ──
  let working = items;
  let furigana = { remove: [], keep: items, mainHeight: 0, reason: '未启用' };
  if (stripFurigana) {
    furigana = findFurigana(items, opts);
    working = furigana.keep.length ? furigana.keep : items;
  }

  // ── 排序 ──
  const lines = [];
  if (vertical) {
    // 竖排：列从**右往左**（日文竖排的阅读方向），列内从上往下
    let cols = clusterColumns(working, opts);
    cols = mergeSameColumn(cols);
    const leftToRight = !!opts.verticalLeftToRight;
    if (leftToRight) cols.sort((a, b) => a.x - b.x);
    else cols.sort((a, b) => b.x - a.x);
    for (const c of cols) {
      lines.push({
        axis: 'column',
        x: Math.round(c.x),
        blocks: c.items,
        text: joinBlocks(c.items, { separator }),
      });
    }  } else {
    // 横排：行从上往下，行内从左往右
    const rows = clusterRows(working, opts);
    for (const r of rows) {
      lines.push({
        axis: 'row',
        y: Math.round(r.c),
        blocks: r.items,
        text: joinBlocks(r.items, { separator }),
      });
    }
  }

  const text = lines.map((l) => l.text).filter(Boolean).join(vertical ? '\n' : '\n');

  return {
    ok: true,
    text,
    lines,
    blocks: items,
    vertical,
    layout: det,
    furigana: {
      removedCount: furigana.remove.length,
      removed: furigana.remove.map((b) => b.text),
      mainHeight: Math.round(furigana.mainHeight || 0),
      reason: furigana.reason,
    },
    image,
    engine: raw.engine || null,
    note: '',
  };
}

/**
 * 把"其实是同一列"的相邻列组合并回去。**只用于竖排。**
 *
 * ⚠️ 为什么需要这一步（这是本轮的一个真 bug，不是保险措施）：
 *
 *   一列比较长的竖排文字，OCR 有时会把它切成上下两块
 *   （识别器自己按行分块，跟我们的逻辑无关）。这两块的 x 几乎一样：
 *       右列上半 x=130/宽54   右列下半 x=131/宽52
 *       左列上半 x= 62/宽56   左列下半 x= 62/宽56
 *   但 `clusterColumns` 是拿**中心点间距**找断点的：
 *       中心点 157, 157, 90, 90 → 相邻间距 0 | 67 | 0
 *       最大比值跳变在 0→67 那一步 → 阈值 ≈ 0 → **四处都当断点** → 变成 4 列 ❌
 *   结果：一列被拆成两行，读起来是"半句 + 半句"，语义全乱。
 *
 *   判据用**横向区间是否重叠**，而不是中心点远近 ——
 *   同一列的上下两块，横向位置必然重叠；不同列在竖排里本来就不会重叠。
 *   这个判据和"切了多长"无关，所以不会因为列变长而失效。
 *
 * ⚠️ 只改竖排这一条路，横排一个字节都不动：
 *   横排走的是 `clusterRows`，跟这里无关（`reconstruct` 里按 `vertical` 分支）。
 *   这样"修竖排"就不可能弄坏横排。
 */
export function mergeSameColumn(cols) {
  const groups = (cols || []).filter((c) => c && c.items && c.items.length);
  if (groups.length < 2) return groups;

  const span = (g) => {
    let lo = Infinity; let hi = -Infinity;
    for (const b of g.items) {
      const x = Number(b.x) || 0;
      const w = bw(b) || 0;
      lo = Math.min(lo, x);
      hi = Math.max(hi, x + w);
    }
    return { lo, hi };
  };
  const overlapRatio = (a, b) => {
    const A = span(a); const B = span(b);
    const inter = Math.min(A.hi, B.hi) - Math.max(A.lo, B.lo);
    if (inter <= 0) return 0;
    const narrow = Math.min(A.hi - A.lo, B.hi - B.lo) || 1;
    return inter / narrow;
  };

  // 按 x 从大到小（竖排的阅读方向），把"横向重叠得厉害"的合并
  const sorted = [...groups].sort((a, b) => b.x - a.x);
  const out = [];
  for (const g of sorted) {
    const last = out[out.length - 1];
    // ⚠️ 阈值 0.6 是实测取的：同一列上下两块的重叠比接近 1.0，
    //    相邻两列在竖排里是 0（完全不重叠）。中间值不敏感。
    if (last && overlapRatio(last, g) >= 0.6) {
      last.items = last.items.concat(g.items);
      last.x = last.items.reduce((s, b) => s + cx(b), 0) / last.items.length;
    } else {
      out.push({ x: g.x, items: g.items.slice() });
    }
  }
  // 合并可能打乱了顺序，重排一次。
  // ⚠️ 必须用 (y, x) 双键，不能只按 y：
  //    同一列的上下两块在竖排里是**上下关系**（y 不同），
  //    但 OCR 切块时 y 有可能几乎相等（比如把一个字的高低算进去），
  //    这时只按 y 排就是**不稳定**的，两块的前后顺序随机 ——
  //    表现是"同一列的半句和另半句偶尔颠倒"。
  //    加 x 作为第二键之后顺序就定死了。
  //    （这条同样只作用于竖排这条路。）
  for (const g of out) {
    g.items.sort((a, b) => ((Number(a.y) || 0) - (Number(b.y) || 0))
      || ((Number(b.x) || 0) - (Number(a.x) || 0)));
  }
  return out;
}

/**
 * 把版面结果变成给人看的提示。
 *
 * 为什么要有这个：OCR 出问题是常态（拍虚了、书页倾斜、光线差），
 * 用户需要知道**大概哪里不对**，而不是只看到一堆乱码。
 */
export function layoutSummary(res) {
  if (!res || !res.ok) return res && res.note ? res.note : 'OCR 失败。';
  const bits = [];
  bits.push(res.vertical ? '识别为竖排，已转成横排阅读' : '识别为横排');
  if (res.furigana && res.furigana.removedCount) {
    bits.push(`去掉了 ${res.furigana.removedCount} 处注音`);
  }
  if (res.lines && res.lines.length) {
    bits.push(`${res.lines.length} ${res.vertical ? '列' : '行'}`);
  }
  return bits.join('；') + '。';
}
