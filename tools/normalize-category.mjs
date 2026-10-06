/**
 * 把分类名统一一下。**只改这一处，不动任何正文。**
 *
 * ⚠️ 为什么要改：原来这 6 个分类各自只有 1 条，而且名字互相重叠
 *   （时间・变化 / 时间・机会 / 时间・条件 / 条件 / 让步 / 理由）。
 *   分类是给**用户筛选和搜索**用的，一个分类只有一条等于没分类；
 *   而且「时间」「条件」这种词做搜索时，分类名也算匹配范围，
 *   分散成六个反而让"筛某一类"变得没法用。
 *
 * ⚠️ 同时必须改**内容源文件**（tools/内容-*.mjs）。
 *   只改 data/grammar/*.json 的话，下次谁重跑 gen-grammar 就又被覆盖回去了 ——
 *   数据文件和内容源文件必须保持一致，这是本项目的硬规矩。
 */
import fs from 'node:fs';
import path from 'node:path';

const MAP = {
  '时间・变化': '时间',
  '时间・机会': '时间',
  '时间・条件': '时间',
};

const ROOT = 'jp-learn';
const DIR = path.join(ROOT, 'data', 'grammar');

// ── ① 改数据文件 ──
let jsonChanged = 0;
for (const lv of ['N5', 'N4', 'N3', 'N2', 'N1']) {
  const p = path.join(DIR, lv + '.json');
  if (!fs.existsSync(p)) continue;
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  let touched = false;
  for (const it of (doc.items || doc)) {
    if (MAP[it.category]) { it.category = MAP[it.category]; touched = true; jsonChanged++; }
  }
  if (touched) fs.writeFileSync(p, JSON.stringify(doc, null, 2) + '\n', 'utf8');
}

// ── ② 改内容源文件（保持两者一致）──
const toolsDir = path.join(ROOT, 'tools');
let srcChanged = 0;
for (const f of fs.readdirSync(toolsDir)) {
  if (!f.startsWith('内容-') || !f.endsWith('.mjs')) continue;
  const p = path.join(toolsDir, f);
  let s = fs.readFileSync(p, 'utf8');
  const before = s;
  for (const [from, to] of Object.entries(MAP)) {
    // 只替换 category 字段上的值，避免误伤正文里出现的同样文字
    s = s.split("category: '" + from + "'").join("category: '" + to + "'");
  }
  if (s !== before) { fs.writeFileSync(p, s, 'utf8'); srcChanged++; }
}

console.log('数据文件改了 ' + jsonChanged + ' 条；内容源文件改了 ' + srcChanged + ' 个');
