/**
 * 第二种搜法：**直接搜整个条目的 JSON 文本**。
 *
 * ⚠️ 为什么一定要有这第二种搜法：
 *   第一种（搜 title/meaning/tags/id）会**假有** ——
 *   比如「になると」会被 N4「〜と」的例句"春になると"命中，
 *   但库里根本没有一条专门讲「〜になると」的。
 *   直接搜整条 JSON 是更严的判据：连例句、注意事项里都没提过，才是真空缺。
 *
 * ── 两种搜法的分工（**两个都要跑，只跑一个会得出错结论**）──────────
 *   脚本                     搜的范围                 错了会往哪边错
 *   ─────────────────────── ──────────────────────── ─────────────────
 *   audit-gap.mjs            只看字段                 会**假有**（子串匹配高估）
 *                            （title/meaning/          → 判"有"的必须人眼复核
 *                              category/id/detail/tags）
 *   search-json.mjs（本文件） 整条 JSON                会**假缺**（某条只是被
 *                            （连例句、注意事项）       别人的例句提到过）
 *                                                        → 判"缺"的也要看一眼
 *
 *   规矩：**两个都判"缺"的，才是真缺口。**
 *   两个的候选词表是**各写各的**（不是同一份），所以也别指望两边逐词对得上——
 *   要比的是"同一个词，两个判据各说什么"。
 *
 *   ⚠️ 这个分工写在 `使用说明.md` 的自检清单里，也由
 *      `test-grammar.mjs [3]` 断言（两个脚本必须看到同一个条数）——
 *      因为**两个脚本各自重新解析了一遍 data/grammar/*.json**，
 *      将来数据目录/字段一变，它们会各说各话而且不报错。
 *
 * 用法：node tools/search-json.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// ⚠️ 目录名在这里**写成字面量**（而不是从别处 import 一个常量）：
//    这样 `test-grammar.mjs [3]` 能静态看出它读的是哪个目录，
//    改动数据目录时至少有一处会被指出来。同一份数据目前有**三套**解析代码
//    （test-grammar / audit-gap / 本文件），它们必须永远看到同一个条数。
const DIR = path.join(ROOT, 'data', 'grammar');
const all = [];
for (const lv of ['N5', 'N4', 'N3', 'N2', 'N1']) {
  const p = path.join(DIR, lv + '.json');
  if (fs.existsSync(p)) for (const it of (JSON.parse(fs.readFileSync(p, 'utf8')).items || [])) all.push(it);
}

const CAND = [
  'かしら', 'なぜなら', 'につれて', 'に従って', 'に伴って', 'ずつ', 'たびに', 'ついでに',
  'わりに', 'くせして', 'ものなら', 'が早いか', 'や否や', 'とかく', 'はともかく', 'いずれにせよ',
  'と思いきや', '始末だ', 'こととて', 'までもない', 'からといって', 'うえは', 'を機に', 'たが最後',
  'ば〜ほど', 'ほど〜はない', 'はさておき', 'になると', 'ゆえに', 'からには', 'ばかりに',
  'だけに', 'あまり', 'ものだから', 'おかげで', 'せいで', 'くせに', 'つもりだった', 'はずだった',
];

const out = [];
const total = all.length;
out.push('库内 ' + total + ' 条');
out.push('');
const miss = [];
for (const t of CAND) {
  const n = all.filter((x) => JSON.stringify(x).includes(t)).length;
  if (n === 0) miss.push(t);
  out.push('  ' + t.padEnd(14) + ' 整条 JSON 命中 ' + String(n).padStart(3)
    + (n ? '  ' + all.filter((x) => JSON.stringify(x).includes(t)).slice(0, 2).map((h) => h.level + ':' + h.id).join(' ') : '   ← 真空缺'));
}
out.push('');
out.push('=== 两种搜法都搜不到的（真空缺）: ' + miss.length + ' ===');
out.push(miss.join('、'));
/**
 * ⚠️ 报告写到 `reports/` 而不是项目根目录（2026-10 改，理由同 audit-gap.mjs）：
 * 根目录原来会被塞进一个 `_gap2.txt`，既不属于项目，也没人检查它。
 */
const REPORTS = path.join(ROOT, 'reports');
fs.mkdirSync(REPORTS, { recursive: true });
fs.writeFileSync(path.join(REPORTS, 'gap2.txt'), out.join('\n') + '\n', 'utf8');
// ★ 这一行的格式被 `tools/test-grammar.mjs [3]` 用正则解析（它靠这个数字
//   确认"两个搜库工具看到的是同一份数据"）。**改格式必须同步改那个正则**，
//   否则断言会红 —— 这是故意的：宁可红一次，也不要两个工具悄悄各说各话。
console.log(`库内 ${total} 条`);
console.log('真空缺 ' + miss.length + ' 个：' + miss.join('、'));
console.log('报告：reports/gap2.txt');
