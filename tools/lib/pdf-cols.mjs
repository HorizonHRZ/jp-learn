/**
 * tools/lib/pdf-cols.mjs —— 从 PDF 的坐标**推出**列区间。
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么需要它（一次真实的教训）
 * ────────────────────────────────────────────────────────────────────
 * 一览表的 PDF 是排版软件出的：一条的**页码**和**词形**在下面一行，
 * 它的**例句**和**中文**在上面一行（y 相差 4~5 磅）。所以"一条 = 一视觉行"
 * 不成立，必须**按列取字**。
 *
 * 我第一版是在两个脚本里各写死一套 x 边界（`if (x >= 90 && x < 190)`）。
 * 结果 `check-yilanbiao.mjs` 报「副词 36 条里 13 条在 PDF 里找不到」——
 * 数据是对的，**检查是错的**：我把词形列的右边界写成了 190，
 * 而 `あまり〜ない` 的「〜ない」在 x=142~172、`ほとんど` 在 148~178，
 * 都被算进了词形列。两个脚本各写一份边界，就是"一处规则两处实现"，
 * 必然漂移（第 36 节踩过一模一样的坑：find-near-dups 和 merge 各写一份 tier 逻辑）。
 *
 * 所以改成**一份实现**：从这一页所有文字块的 x 起止里，
 * 把"间隔 ≥8 磅"的地方切开 —— 那就是视觉上的列边界。
 * 两个脚本都 import 这里，规则只有一处。
 *
 * ⚠️ 它**不做**任何"猜语义"的事：不知道哪列是词形、哪列是例句，
 *    只是把"看起来是几列"如实报出来。哪列是词形由调用方按位置指定
 *    （实测这 5 页的词形列都是从左数第 2 列，见下面 WORD_COL）。
 */
import { extractPdf } from '../pdf-text.mjs';

/** 判定"两列分开了"的最小水平空隙（磅）。8 是实测值：列间空隙 ~19 磅，字间 ~4 磅 */
export const GAP = 8;
/** 一行 y 相差多少算同一视觉行（和 pdf-text.mjs 里的 YTOL 一致） */
export const YTOL = 2.5;

/** 一个文字块的估计宽度：和 pdf-text.mjs 的 lineText 用同一个估算 */
export const textWidth = (t) => t.length * 6;

/** 从一页的所有文字块推出列区间 [[x0,x1],…]，按 x 升序 */
export function pageColumns(page) {
  const segs = [];
  for (const row of page.lines) {
    for (const p of row.parts) {
      if (!p.text || !p.text.trim()) continue;
      segs.push([p.x, p.x + textWidth(p.text)]);
    }
  }
  segs.sort((a, b) => a[0] - b[0]);
  const iv = [];
  for (const [x0, x1] of segs) {
    const last = iv[iv.length - 1];
    if (last && x0 <= last[1] + GAP) last[1] = Math.max(last[1], x1);
    else iv.push([x0, x1]);
  }
  // 丢掉过窄的碎片（宽 < 12 磅），否则单点噪声会被当成一列
  return iv.filter(([a, b]) => b - a >= 12).map(([a, b]) => [Math.round(a), Math.round(b)]);
}

/**
 * 取一行里**某一列**的文字。
 *
 * ⚠️ 用 `start - 6 <= x` 而不是 `x >= start`：文字块的 x 是**起点**，
 *    而字形可能略微探进列里（实测 `〜や〜など` 的 "~" 在 x=52，
 *    而词形列从 36 起 —— 这种"探出去一点"必须收进来，
 *    否则词形会被截成 "や~など"，和 〜や〜など 对不上）。
 */
export function cellText(row, [start, end]) {
  let s = '';
  for (const p of row.parts) {
    if (!p.text || !p.text.trim()) continue;
    if (p.x + textWidth(p.text) > start - 6 && p.x < end) s += p.text;
  }
  return s.trim();
}

/** 一次把 PDF 拆成「每一页 → 每一视觉行 → 各列文字」 */
export async function columnsOf(file) {
  const { pages, cmapErrors } = extractPdf(file);
  const out = [];
  for (const p of pages) {
    const cols = pageColumns(p);
    const rows = [];
    for (const row of p.lines) {
      if (row.y > 780) continue;                     // 页眉
      const cells = cols.map((c) => cellText(row, c));
      if (!cells.some((c) => c)) continue;
      rows.push({ y: row.y, cells, raw: row });
    }
    out.push({ page: p.page, cols, rows });
  }
  return { pages: out, cmapErrors };
}

// ---------------------------------------------------------------------------
// 中文注记列 / 日文词形列的区分
// ---------------------------------------------------------------------------
//
// ⚠️ 用**字符种类**区分，不用坐标区分。原因（实测踩到的）：
//   这份 PDF 里，中文注记有时和日文**挤在同一个文字块里**。
//   例：第 5 页 `何（なに）` 那一条，PDF 的文字块是 `[44]什么 [157]何（なに）`
//   —— "什么" 在 x=44，夹在同一列区间 [36,195] 内，按坐标切不开。
//   第 2 页 `について` / `にとって` 的三行更明显：中文注记单独成行，
//   y 比日文那行高 2.8 磅，硬按坐标分列会把"提示陈述内容"当成词形。
//
//   所以：**日文列只留日文字符**（汉字 + 假名 + 长音符），
//   中文汉字会被一起收进来 —— 这是可接受的，因为下面的判定用的是
//   "数据里的词是不是它的**前缀**"，中文只在词形后面才会出现。
//   实测第 1/2/3/4 页的词形列都是"日文在前、中文在后"，前缀判定成立。
// ---------------------------------------------------------------------------

/** 只保留日文字符（CJK 统一表意文字 + 平假名 + 片假名 + 长音符 + 全角中点） */
export const jpOnly = (s) => (String(s).match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\u30fc\u30fb]/g) || []).join('');

/**
 * 每一页的**词形列**是第几列（0 起），以及要不要再拼上最后一列（中文注记）。
 *
 * 实测记录（这 5 页的版式，见 reports/yilanbiao-draft.md 的原始坐标）：
 *   第 1/2 页 助词      ：[36,79]词形 [92,193]义项/例句 [251,490]例句 [505,…]中文注记
 *                        —— 词形列很窄（36–79）；`について`/`にとって` 那三行的
 *                           中文注记（作为/关于/对于）单独排在最后那一列
 *   第 3/4 页 副词/接续词：[36,84]页码 [92,183]词形 [199,…]例句 [447,…]中文
 *                        —— 词形列是第 2 列，中文自己一列，**不用拼**
 *   第 5 页 疑问词      ：中文和词形挤在同一列区间里 → 靠 jpOnly 过滤
 */
export const WORD_COL = { 1: 0, 2: 0, 3: 1, 4: 1, 5: 0 };
/** 哪些页的词形列要**再拼上最后一列**（中文注记）才能拿到那几行的词形 */
export const NOTE_COL = { 1: null, 2: 3, 3: null, 4: null, 5: null };

/** 取一页里某个视觉行的"日文词形"文本 */
export function headText(page, cells) {
  const wi = WORD_COL[page];
  const parts = [cells[wi] || ''];
  const ni = NOTE_COL[page];
  if (ni !== null && ni !== undefined && cells[ni]) parts.push(cells[ni]);
  return jpOnly(parts.join(''));
}
