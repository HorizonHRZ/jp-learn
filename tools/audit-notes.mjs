// 课堂笔记 ⇄ 语法库 覆盖率对照 v2（一次性审计脚本）。
//
// v1 有两个问题，v2 都修掉了：
//   ① 输出被控制台截断，只看得到前 120 行 —— 所以"没命中 95 条"里
//      其实混着一批**已经有覆盖**的（比如 #21 あります／います 明明有 n5-arimasu-imasu）。
//      v2 改成**写文件**，不再靠控制台。
//   ② v1 把"泛助词命中"和"完全没命中"分开统计，但没把**真正的命中证据**列出来，
//      导致没法人工复核。v2 每条都附上命中的条目 id。
//
// ⚠️ 判定仍然是**粗糙**的，两个偏差方向都保留在报告里：
//    - 抽关键词是启发式的，抽歪了会误判；
//    - 子串匹配会**高估**覆盖率。
//    所以这份报告只能当**线索**，最终结论要人眼过一遍报告。
import fs from 'node:fs';
import path from 'node:path';

// ⚠️ 路径必须相对**脚本自己**解析，不能相对当前工作目录。
//    原来写的是 'jp-learn/DOC/...' —— 只有**在工作区根目录**跑才对。
//    而使用说明第六节让用户在**项目目录里**跑（`node tools\xxx.mjs`），
//    于是路径变成 jp-learn/jp-learn/DOC/... 直接 ENOENT 崩掉。
//    一个审计脚本崩掉比"审计不通过"更糟：它**什么都没检查**就退出了，
//    而看日志的人只会以为"这个脚本坏了"，于是不再跑它。
//    （同类问题在别的脚本里也见过，一律用 import.meta.dirname 兜住。）
const ROOT = path.resolve(import.meta.dirname, '..');
const P = (rel) => path.join(ROOT, rel);

const md = fs.readFileSync(P('DOC/课堂笔记-语法点清单.md'), 'utf8');
const idx = JSON.parse(fs.readFileSync(P('data/grammar/index.json'), 'utf8'));

const lines = md.split(/\r?\n/);
const items = [];
let section = '';
for (const l of lines) {
  const h = l.match(/^##\s+(.+)$/);
  if (h) { section = h[1].trim(); continue; }
  const m = l.match(/^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|/);
  if (m) items.push({ section, no: Number(m[1]), point: m[2].trim(), where: m[3].trim() });
}

// 关键词抽取：去掉序号圈码和括号注释，抓日文片段。
function keywords(point) {
  let s = point.replace(/[（(][^）)]*[）)]/g, ' ').replace(/[①-⑳]/g, '');
  const out = [];
  for (const m of s.matchAll(/[ぁ-んァ-ヶー一-龥々〜～／]+/g)) {
    for (const part of m[0].split(/[／〜～]/)) {
      const k = part.trim();
      if (k) out.push(k);
    }
  }
  return [...new Set(out)];
}

const STOP = new Set(['の', 'は', 'が', 'を', 'に', 'で', 'と', 'も', 'や', 'か', 'から', 'まで', 'より', 'など', 'へ', 'だ', 'です', 'ます', 'する', 'ある', 'いる', 'ない']);
function find(kw) {
  const k = kw.toLowerCase();
  return idx.items.filter((x) => [x.title, x.meaning, x.id, ...(x.tags || [])].join(' ').toLowerCase().includes(k));
}

const rows = [];
for (const it of items) {
  const kws = keywords(it.point);
  let best = null;
  for (const k of kws) {
    const hits = find(k);
    if (!hits.length) continue;
    // 优先选"越具体的词命中越少"的：命中数少说明关键词越有区分力
    const penalty = STOP.has(k) ? 1000 : 0;
    const weight = penalty + hits.length;
    if (!best || weight < best.weight) best = { kw: k, hits, weight };
  }
  rows.push({ ...it, kws, best });
}

const strong = rows.filter((r) => r.best && !STOP.has(r.best.kw));
const onlyStop = rows.filter((r) => r.best && STOP.has(r.best.kw));
const noHit = rows.filter((r) => !r.best);

const BT = String.fromCharCode(96);
const out = [];
out.push('# 课堂笔记 ⇄ 语法库 覆盖率对照报告');
out.push('');
out.push('> 本报告由 `tools/audit-notes.mjs` 自动生成，**只是一份线索**，不是最终结论。');
out.push('> 生成时间：2026-10。语法库当时 **' + idx.count + ' 条**。');
out.push('');
out.push('## 读这份报告之前必须知道的两件事');
out.push('');
out.push('1. **判定方法是子串匹配**，所以它**会高估覆盖率** ——');
out.push('   比如笔记里的「と①（并列）」会命中库里任何标题含「と」的条目。');
out.push('   所以**判成"有覆盖"的必须抽查**。');
out.push('2. **抽关键词是启发式的**，抽歪了就会**误判成"缺"** ——');
out.push('   反过来也一样。所以**判成"缺"的也必须看一眼**。');
out.push('');
out.push('> 结论：两个方向都要人眼过一遍。机械部分只是把 220 条筛成"值得看的几十条"。');
out.push('');
out.push('## 汇总');
out.push('');
out.push('| 类别 | 条数 | 含义 |');
out.push('|---|---|---|');
out.push('| 强命中 | ' + strong.length + ' | 关键词是个具体语法形式，命中可信度较高 |');
out.push('| 仅泛助词命中 | ' + onlyStop.length + ' | 只被 は／が／に 这类泛助词命中，**基本等于没验证** |');
out.push('| 完全没命中 | ' + noHit.length + ' | 关键词一个都没匹配上，**最值得看** |');
out.push('| 合计 | ' + rows.length + ' | |');
out.push('');

out.push('## A. 完全没命中（' + noHit.length + ' 条）—— 优先人工复核');
out.push('');
out.push('| 节 | 序 | 笔记里的语法点 | 抽到的关键词 |');
out.push('|---|---|---|---|');
for (const r of noHit) out.push('| ' + r.section + ' | ' + r.no + ' | ' + r.point + ' | ' + r.kws.join('、') + ' |');
out.push('');

out.push('## B. 仅被泛助词命中（' + onlyStop.length + ' 条）—— 等于没验证');
out.push('');
out.push('| 节 | 序 | 笔记里的语法点 | 命中的泛助词 | 命中条数 |');
out.push('|---|---|---|---|---|');
for (const r of onlyStop) out.push('| ' + r.section + ' | ' + r.no + ' | ' + r.point + ' | ' + r.best.kw + ' | ' + r.best.hits.length + ' |');
out.push('');

out.push('## C. 强命中（' + strong.length + ' 条）—— 抽查用');
out.push('');
out.push('| 节 | 序 | 笔记里的语法点 | 命中关键词 | 命中条目 |');
out.push('|---|---|---|---|---|');
for (const r of strong) {
  out.push('| ' + r.section + ' | ' + r.no + ' | ' + r.point + ' | ' + r.best.kw + ' | '
    + r.best.hits.slice(0, 3).map((x) => x.id).join(', ') + (r.best.hits.length > 3 ? ' …' : '') + ' |');
}
out.push('');

// ---- 人工复核那一节从独立文件读进来 ----
// ⚠️ 为什么要这样做：我原来是把人工复核的内容**手写追加**到报告末尾的，
//    结果下一次重新生成报告时，**手写的那一节被整个覆盖掉了**。
//    这是"生成物里混着人工内容"的典型事故：机器每次重写全文，
//    人工的部分没有落脚点，迟早丢。
//
// 修法：手写内容放进 DOC/课堂笔记-人工复核.md（**不进生成流程、不叫生成物**），
// 生成时读进来拼在后面。这样重新生成**不会丢人工结论**。
// 这个思路可以推广：**任何"机器生成 + 人工补充"的文档，
// 都要把人工部分放在生成器够不到的地方。**
const HUMAN = P('DOC/课堂笔记-人工复核.md');
out.push('---');
out.push('');
if (fs.existsSync(HUMAN)) {
  out.push('> ⚠️ **以下这一节是人工写的，不参与机器生成。**');
  out.push('> 上面三张表由脚本产出，**两个方向都会错**（见下），所以只当线索；');
  out.push('> 下面这一节是逐条复核后的结论，可信度更高。');
  out.push('');
  out.push(fs.readFileSync(HUMAN, 'utf8').replace(/\s*$/, ''));
} else {
  out.push('> ⚠️ **人工复核一节缺失**：找不到 `' + HUMAN + '`。');
  out.push('> 这一节是逐条复核后的结论，比上面三张表可信，**不应该丢**。');
}
out.push('');

const p = P('DOC/课堂笔记-覆盖率报告.md');
fs.writeFileSync(p, out.join('\n'), 'utf8');
console.log('报告已写出：' + p + '（' + fs.statSync(p).size + ' B，' + out.length + ' 行）');
console.log('强命中 ' + strong.length + ' / 泛助词 ' + onlyStop.length + ' / 没命中 ' + noHit.length);
