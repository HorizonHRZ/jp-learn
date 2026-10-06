/**
 * 语法库计数**实测报告**：把当前真实的条目数按等级/按线算出来打印。
 * 用法：node tools/sync-doc-counts.mjs
 *
 * ⚠️ 2026-10 改成分**只报告、不改文档**（原来它会自动 sed 文档里的数字）。
 *
 *    为什么撤掉自动改写：
 *      ARCHITECTURE.md 里那几张 "语法库总数 | 384 条" 的表是**历史记录** ——
 *      记录的是"那一轮结束时是什么样"。它们**必须保持当时的数字**，
 *      否则历史就变成了"每张表都写着今天的数"，谁也看不出变化过程。
 *      而自动改写分不清"该更新的在用的数字"和"必须冻住的历史数字"，
 *      它只会把两者一起改掉 —— 那就把文档里唯一的时间线抹平了。
 *      （项目约定：历史表格不做追溯修改，新一批另起一节。）
 *
 *    所以现在的分工是：**脚本负责把真实数字算准，人负责把它写到该写的地方。**
 *    "每一栏数字都必须来自跑脚本"这条规矩不变 —— 只是不许脚本自己去写。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.join(ROOT, p);

// 先算出真实数字（以此为准，绝不照抄上一次）
/**
 * 等级清单**扫目录**得出，不写死。
 *
 * ⚠️ 这里原来写死 `['N5','N4','N3','N2']` —— **漏了 N1**。
 *    后果不是报错，而是 N1 的 115 条**完全不计入**，
 *    脚本照样打印出一个"看起来很可信"的合计数。
 *    这是同一个毛病在本项目里的**第三份**（另两份在 tools/check-grammar-dup.mjs、
 *    tools/check-duplicate.mjs，都已改成扫目录）。
 *    写死等级清单的代价是"新等级静默不入账"，而统计脚本最不能出的错就是
 *    **给出一个错的、但看起来正常的数字** —— 文档会照着它写下去。
 */
const LEVELS = fs.readdirSync(rel('data/grammar'))
  .filter((f) => /^N\d+\.json$/.test(f))
  .map((f) => f.replace(/\.json$/, ''))
  .sort();

const counts = {};
const byLine = { jlpt: 0, written: 0 };
let total = 0;
for (const lv of LEVELS) {
  const doc = JSON.parse(fs.readFileSync(rel('data/grammar/' + lv + '.json'), 'utf8'));
  const per = { jlpt: 0, written: 0 };
  for (const it of doc.items) { per[it.line] = (per[it.line] || 0) + 1; byLine[it.line] = (byLine[it.line] || 0) + 1; }
  counts[lv] = { n: doc.items.length, per };
  total += doc.items.length;
}
// 书面语线按 id 前缀分层（写书面语的只有 N3/N2，但按目录扫更省心）
const layerPer = {};
for (const lv of LEVELS) {
  for (const it of JSON.parse(fs.readFileSync(rel('data/grammar/' + lv + '.json'), 'utf8')).items) {
    if (it.line !== 'written') continue;
    const m = /^n[0-9]-l([0-9])/.exec(it.id);
    const k = m ? 'L' + m[1] : '无层标记';
    layerPer[k] = (layerPer[k] || 0) + 1;
  }
}

// ⚠️ 这份名单只管"现在时"的文档 —— 即"里面写的数字应该永远等于当前实测值"。
//    `ARCHITECTURE.md` 里的**历史表格**（384 / 451 / 470 那些）是刻意留档的，
//    所以它这里的疑似过期只是**提示人看一眼**，不是错误。
//
//    2026-10 移除了两份文件，它们**已删除**：
//      · `NEXT-SESSION-PROMPT.md`（AI 会话交接提示词，数字全面过期且会误导新会话）
//      · `DOC/待办-需要你确认.md`（进度总表，数字错得更多；durable 内容搬进
//        ARCHITECTURE §40.3）。删掉它们是为了让"数字过期"这件事**有唯一一处出口**。
const FILES = [
  '使用说明.md', 'ARCHITECTURE.md',
  'data/grammar/README.md',
];

console.log('实测（以此为准）：');
for (const [lv, v] of Object.entries(counts)) console.log('  ' + lv + ' ' + v.n + '  应试 ' + (v.per.jlpt || 0) + ' / 书面语 ' + (v.per.written || 0));
console.log('  合计 ' + total + '（应试 ' + byLine.jlpt + ' + 书面语 ' + byLine.written + '）');
console.log('  书面语线分层：' + Object.entries(layerPer).map(([k, v]) => k + ' ' + v).join(' / '));
console.log('');

// ---- 报告：文档里还在说旧数字的地方（**只报告，不改**）----
//
// 为什么要报告：数字过期的文档比没有文档更糟 —— 用户会照着它判断
// "这个功能做完了没有"。但报告只负责**指出**，改不改、怎么改由人决定，
// 因为有的数字是历史记录、必须保持原样（见文件头说明）。
console.log('文档里疑似过期的合计数字（请人工判断该不该改）：');
{
  const STALE = ['384', '385', '456'];
  let hits = 0;
  for (const f of FILES) {
    const p = rel(f);
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/语法库总数|语法库.*条|N3 \d+/.test(line)) return;
      const found = STALE.filter((s) => line.includes(s));
      if (!found.length) return;
      hits++;
      console.log(`  ${f}:${i + 1}  [含 ${found.join(',')}]  ${line.trim().slice(0, 90)}`);
    });
  }
  if (!hits) console.log('  （没有发现）');
}
console.log('');
console.log(`  当前等级分布（可直接抄进在用文档）：${LEVELS.slice().reverse().map((lv) => `${lv} ${counts[lv].n}`).join(' / ')}`);
console.log(`  当前总数：${total}`);
