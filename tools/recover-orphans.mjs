/**
 * 恢复内容源文件（recover-orphans.mjs）
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么会有这个脚本
 * ────────────────────────────────────────────────────────────────────
 * 2026-10 并行写 N1/N2/N3 应试线内容时，我给 28 个写手的文件名是按序号生成的，
 * 其中三个**撞上了已经存在的内容源文件**，把它们的正文覆盖掉了：
 *   tools/内容-JLPT-N2b.mjs（原 6 条）
 *   tools/内容-JLPT-N3b.mjs（原 18 条）
 *   tools/内容-JLPT-N3c.mjs（原 15 条）
 *
 * **数据没有丢** —— 那些条目早就通过 gen-grammar 合并进 data/grammar/N*.json 了，
 * 而我是先抓了 jlpt/written 分线的快照才动手的。丢的是**纯文本源文件**，
 * 而项目有一条硬约束：「源码永远保持纯文本，程序与数据都从源码生成」。
 * 源文件没了，意味着这些条目**再也不能从这个仓库重新生成** —— 这才是真损失。
 *
 * 这个脚本把"在 data/grammar/*.json 里存在、但没有任何内容源文件负责"的条目
 * （孤儿）反向导出成内容源文件，把纯文本这条链补回来。
 *
 * ⚠️ 这是**恢复手段，不是常规流程**。常规流程永远是
 *    「改内容源文件 → gen-grammar.mjs → build-grammar-index.mjs」，单向的。
 *    反向导出只能补回已经存在的数据，补不出被覆盖前的人写注释。
 *
 * 用法：node tools/recover-orphans.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'data', 'grammar');
const DRY = process.argv.includes('--dry');

// ---- 一、扫出所有内容源文件当前负责的 id ----
const srcFiles = fs.readdirSync(path.join(ROOT, 'tools'))
  .filter((f) => f.startsWith('内容-') && f.endsWith('.mjs'));
const owned = new Set();
for (const f of srcFiles) {
  let m;
  try { m = await import(pathToFileURL(path.join(ROOT, 'tools', f)).href); } catch { continue; }
  for (const v of Object.values(m)) {
    const arr = (Array.isArray(v) && v.length && v[0] && v[0].id) ? v
      : (v && typeof v === 'object' && Array.isArray(v.items) && v.items.length
        && v.items[0] && v.items[0].id ? v.items : null);
    if (!arr) continue;
    for (const it of arr) if (it && it.id) owned.add(it.id);
  }
}

// ---- 二、按「等级 + 线」把孤儿分组。一个内容文件必须一个等级，所以线也顺带统一 ----
const groups = new Map();     // "N3/jlpt" -> [item]
for (const f of fs.readdirSync(DIR)) {
  if (!/^N\d\.json$/.test(f)) continue;
  const doc = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  for (const x of doc.items || []) {
    if (owned.has(x.id)) continue;
    const key = `${doc.level}/${x.line || 'jlpt'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(x);
  }
}

if (!groups.size) {
  console.log('✓ 没有孤儿：每个条目都有内容源文件负责。');
  process.exit(0);
}

// ---- 三、写出恢复文件。文件名加 `恢复-` 前缀，一眼能看出它不是新写的内容 ----
const report = [];
for (const [key, items] of [...groups].sort()) {
  const [level, line] = key.split('/');
  const outRel = `tools/内容-恢复-${level}-${line}.mjs`;
  const outPath = path.join(ROOT, outRel);
  // 字段顺序固定，便于人读；source 如实标成"数据反向导出"
  const body = items.map((it) => `  {
    id: ${JSON.stringify(it.id)},
    level: ${JSON.stringify(level)},
    category: ${JSON.stringify(it.category || '惯用型')},
    title: ${JSON.stringify(it.title || '')},
    connection: ${JSON.stringify(it.connection || '')},
    meaning: ${JSON.stringify(it.meaning || '')},${it.detail ? `\n    detail: ${JSON.stringify(it.detail)},` : ''}
    examples: ${JSON.stringify(it.examples || [], null, 2).replace(/\n/g, '\n    ')},
    mistakes: ${JSON.stringify(it.mistakes || [], null, 2).replace(/\n/g, '\n    ')},${it.confusions ? `\n    confusions: ${JSON.stringify(it.confusions, null, 2).replace(/\n/g, '\n    ')},` : ''}
    tags: ${JSON.stringify(it.tags || [])},${it.alias ? `\n    alias: ${JSON.stringify(it.alias)},` : ''}${it.related ? `\n    related: ${JSON.stringify(it.related)},` : ''}
  }`).join(',\n');

  const src = `/**
 * ${path.basename(outRel)} —— **反向恢复**的源文件（${items.length} 条 · ${level} / ${line}）
 *
 * ⚠️ 这个文件不是"写"出来的，是从 data/grammar/${level}.json 里**导出**回来的。
 *
 * 起因：并行写内容时按序号生成文件名，撞上了三个已存在的内容源文件
 * （内容-JLPT-N2b / N3b / N3c），把它们的正文覆盖了。数据本身没丢
 * （早就合并进等级 JSON 了），丢的是纯文本源文件 —— 而项目硬约束要求
 * 源码永远可读、可重新生成。所以把孤儿条目反向导出，把这条链补回来。
 *
 * 因此：这里的 source 标成"数据反向导出"，如实说明它的来历；
 * 注释和讲解的写作过程无法恢复，这一条损失是不可逆的。
 * 删掉本文件 + 跑一次 gen-grammar 会**丢掉这些条目**，不要删。
 */
export default {
  level: '${level}',
  source: '数据反向导出（源文件曾被覆盖，见文件头注释）',
  line: '${line}',
  items: [
${body},
  ],
};
`;
  if (!DRY) fs.writeFileSync(outPath, src, 'utf8');
  report.push(`${outRel}  ←  ${items.length} 条`);
}

console.log(`${DRY ? '（干跑）将写出' : '已写出'} ${report.length} 个恢复文件：`);
for (const r of report) console.log('  ' + r);
console.log(`  合计 ${[...groups.values()].reduce((n, a) => n + a.length, 0)} 条`);
console.log('');
console.log('检查（恢复文件按"快照模式"查，那两条规则对它们不适用）：');
for (const r of report) {
  console.log(`  node tools/check-content.mjs ${r.split('  ')[0]} --recovered`);
}
