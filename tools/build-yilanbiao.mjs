/**
 * build-yilanbiao.mjs —— 从 PDF 抽出「一览表」的草稿，供逐条过目。
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么不能"全自动生成就入库"
 * ────────────────────────────────────────────────────────────────────
 * 这份 PDF 是用排版软件做的，**逻辑行和视觉行对不齐**：
 * 比如「が　② 主语疑问」这一行的例句「何がありますか。」在 PDF 里的
 * y 坐标比"主语疑问"低了 2.7 磅 —— 按 y 分行的通用做法会把它排到
 * 下一行去（第 2 页还有更严重的：一条的解释和例句差了好几行）。
 *
 * 所以这个脚本**只负责把坐标变成结构**（按 x 切列、按 y 分组），
 * 出来的是**草稿**，还要人工过一遍。它不做任何"猜"。
 *
 * 输出（都在 reports/，不碰 data/）：
 *   reports/yilanbiao-draft.md    人看的：分区 + 每条的列
 *   reports/yilanbiao-draft.json  机器看的：分组结果，方便再加工
 *
 * 用法：
 *   node tools/build-yilanbiao.mjs            # 只出草稿
 *   node tools/build-yilanbiao.mjs --verbose  # 把每一行的坐标也打出来
 */
import fs from 'node:fs';
import path from 'node:path';
import { columnsOf } from './lib/pdf-cols.mjs';

// ⚠️ 文件名**不写死**：这个名字里有个「单」(U+5355)，和形近的「単」(U+5358)
//    肉眼几乎分不出。check-yilanbiao.mjs 里写死过一次，结果 `existsSync`
//    静默返回 false、脚本报"跳过"然后**永远绿** —— 校验自己失效却报告正常。
//    所以统一按特征找。
function findPdf() {
  const list = fs.readdirSync(path.resolve(import.meta.dirname, '..'));
  const pdfs = list.filter((f) => /\.pdf$/i.test(f));
  return pdfs.find((f) => /助詞/.test(f) && /副詞/.test(f)) || pdfs[0] || '';
}
const PDF = findPdf();
if (!PDF) {
  console.error('  ✗ 项目根目录下一个 .pdf 都没找到 —— 这个脚本需要那份一览表的 PDF。');
  process.exit(1);
}
const VERBOSE = process.argv.includes('--verbose');

// ---------------------------------------------------------------------------
// 列区间：**从 lib/pdf-cols.mjs 拿**，不在这里再写一份。
//
// ⚠️ 第一版这里写死了一套 x 边界（`{k:'head', from:90, to:190}`），
//    而 check-yilanbiao.mjs 里又写了另一套 —— 于是两份边界漂移，
//    检查报"副词 36 条里 13 条在 PDF 里找不到"，**错的是检查**。
//    第 36 节踩过一模一样的坑（find-near-dups 和 merge 各写一份 tier 逻辑）：
//    **一处规则，一处实现。** 所以列区间只留在 lib/pdf-cols.mjs 里。
// ---------------------------------------------------------------------------

/** 分组：把 y 差 <= tol 的相邻行并成一条（解释/例句被排到下一行时靠这个救回来） */
function groupRows(rows, tol = 3.2) {
  const out = [];
  for (const r of rows) {
    // groups 里存的是"视觉行"，但每条带 4 列，用列名当键
    const cells = {};
    r.cells.forEach((v, i) => { cells[`c${i}`] = v; });
    const g = out[out.length - 1];
    if (g && Math.abs(g.y - r.y) <= tol) {
      for (const [k, v] of Object.entries(cells)) g.cells[k] = (g.cells[k] || '') + v;
      g.ys.push(r.y);
    } else {
      out.push({ y: r.y, ys: [r.y], cells: { ...cells }, cols: r.cells.length });
    }
  }
  return out;
}

const { pages: rawPages, cmapErrors } = await columnsOf(PDF);
if (cmapErrors.length) console.log(`  ⚠️ PDF 提取报了 ${cmapErrors.length} 条错误`);

const out = { pdf: PDF, pages: [] };
const md = [`# 一览表草稿（由 ${path.basename(PDF)} 抽出）`, '',
  '> ⚠️ 这是**草稿**，还没人工过目。请逐条检查"词形 / 中文意思 / 分区"三样。',
  '> 列区间是从坐标**推**出来的（tools/lib/pdf-cols.mjs），不是写死的。', ''];

for (const p of rawPages) {
  const groups = groupRows(p.rows);
  out.pages.push({ page: p.page, cols: p.cols, groups: groups.map((g) => ({ y: g.y, cells: g.cells })) });
  md.push(`\n## 第 ${p.page} 页（${groups.length} 组，列区间 ${JSON.stringify(p.cols)}）\n`);
  for (const g of groups) {
    const desc = Object.entries(g.cells).filter(([, v]) => v && v.trim())
      .map(([k, v]) => `${k}=${JSON.stringify(v.trim())}`).join('  ');
    md.push(`- y=${g.y}  ${desc}`);
  }
  if (VERBOSE) {
    md.push('\n<details><summary>原始视觉行（含坐标）</summary>\n');
    for (const r of p.rows) {
      md.push(`- y=${r.y.toFixed(1)}  ` + r.raw.parts.map((q) => `[${q.x.toFixed(0)}]${q.text}`).join(' '));
    }
    md.push('\n</details>\n');
  }
}

fs.mkdirSync('reports', { recursive: true });
fs.writeFileSync('reports/yilanbiao-draft.md', md.join('\n'), 'utf8');
fs.writeFileSync('reports/yilanbiao-draft.json', JSON.stringify(out, null, 2), 'utf8');
console.log(`  已写 reports/yilanbiao-draft.md（${md.length} 行）`);
console.log(`  已写 reports/yilanbiao-draft.json`);
for (const p of out.pages) console.log(`    第 ${p.page} 页: ${p.groups.length} 组，列区间 ${JSON.stringify(p.cols)}`);
