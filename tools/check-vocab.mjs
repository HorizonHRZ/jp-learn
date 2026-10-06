/**
 * check-vocab.mjs —— 内置词库的**完整性 + 可重建性**自检（只读，不写任何文件）
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么要有这个脚本
 * ────────────────────────────────────────────────────────────────────
 * 这个项目里，词库是"生成物"：`tools/build-vocab.mjs` 从上游数据算出
 * `data/vocab/*.json` 和 `data/index/*.json`。也就是说，
 * **任何人随时可以重跑一次构建，把词库换成另一个样子。**
 *
 * 而 `build-vocab.mjs` 有一个 `--max-extra` 参数控制"分级之外收多少词"。
 * 这里踩过一个**很难发现的坑**（就是本脚本诞生的原因）：
 *
 *   实际交付的数据是用 `--max-extra=0`（全收，extra 15364 条）建的，
 *   但脚本**默认值是 8000**。于是：
 *     用户照着文档跑「node tools/build-vocab.mjs」重建词库，
 *     **会静默丢掉 7364 个词** —— 命令成功、不报错、还能查词，只是少了一大半。
 *   这种"重建之后东西变少了、而且没人知道"的失败最难发现，
 *   因为它看起来完全正常。
 *
 * 所以本脚本盯三件事：
 *   [1] **当前数据的内部自洽**（数量对得上、索引指向的条目真的存在、无空值）
 *   [2] **默认构建不会让词变少**（默认参数必须等于交付时用的参数）
 *   [3] **索引的查询能力还在**（表面形/读音真的查得到；空索引会让查词静默失效）
 *
 * 用法：node tools/check-vocab.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const P = (...a) => path.join(ROOT, ...a);

let pass = 0;
const fails = [];
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fails.push(label); console.log(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
};

const readJson = (rel) => JSON.parse(fs.readFileSync(P(rel), 'utf8'));

// ---------------------------------------------------------------------------
console.log('\n[1] 当前词库的内部自洽');
// ---------------------------------------------------------------------------
const man = readJson('data/index/manifest.json');
const totals = ['N5', 'N4', 'N3', 'N2', 'N1'].reduce((n, k) => n + (man.counts[k] || 0), 0)
  + (man.counts.extra || 0);

ok(man.total === totals,
  `manifest.total 等于各等级之和（${man.total}）`,
  `total=${man.total} 而各级相加=${totals}`);

// 每个等级文件里的条目数必须和 manifest 说的一致。
// ⚠️ 这一条是"两个地方各记了一遍同一个数"的典型：manifest 是构建时写下的，
//    等级文件是构建产物。如果只改了一边（比如手工编辑过 JSON），
//    界面按 manifest 显示条数、列表按文件渲染 —— 用户会看到"说有 654 条，实际 650 条"。
//
// 文件形状（实测）：{ format, formatVersion, generatedAt, note, level, count, items: [...] }
// 注意这里有**两个**条数：`count`（构建时写的）和 `items.length`（真实内容）。
// 两个都要查 —— 只查一个的话，另一个漂了没人知道。
let levelMismatch = [];
for (const lv of ['N5', 'N4', 'N3', 'N2', 'N1', 'extra']) {
  const rel = `data/vocab/${lv.toLowerCase()}.json`;
  if (!fs.existsSync(P(rel))) { levelMismatch.push(`${lv}: 文件不存在`); continue; }
  const doc = readJson(rel);
  const items = Array.isArray(doc) ? doc : (doc.items || doc.words || []);
  if (items.length !== man.counts[lv]) levelMismatch.push(`${lv}: manifest=${man.counts[lv]} 文件=${items.length}`);
  if (!Array.isArray(doc) && doc.count !== items.length) {
    levelMismatch.push(`${lv}: 文件内 count=${doc.count} 而 items=${items.length}`);
  }
}
ok(levelMismatch.length === 0, '每个等级文件的实际条数与 manifest 一致',
  levelMismatch.join('；'));

// ---------------------------------------------------------------------------
console.log('\n[2] ★ 默认构建不会让词变少（这条是重点）');
// ---------------------------------------------------------------------------
// 为什么用"读源码"而不是"跑一遍构建"：构建要几十秒且会写盘。
// 这里要判断的只是"默认参数是多少"，读源码足够且不产生副作用。
//
// ⚠️ 抠不到常量时**必须报错**，不能静默通过 ——
//    "正则没匹配到"和"匹配到了且正确"在只看结果时是一模一样的，
//    那种断言等于永远通过的空转（本项目踩过好几次）。
const buildSrc = fs.readFileSync(P('tools/build-vocab.mjs'), 'utf8');
const defM = /argOf\('max-extra'\)\s*\?\?\s*(\d+)/.exec(buildSrc);
ok(!!defM, '能从 build-vocab.mjs 里抠到 --max-extra 的默认值',
  '正则没匹配到 —— 可能是写法变了，本脚本需要跟着改');
if (defM) {
  const def = Number(defM[1]);
  ok(def === 0,
    `★ 默认 --max-extra 是 0（全收），不是 ${def}`,
    `默认=${def}：照着文档跑「重建词库」会静默丢掉分级外的词。` +
    '默认值必须等于交付数据实际用的参数，否则"重建一次"和"手上这份数据"就是两回事。');
  // 反向：确认交付数据确实是按这个默认建出来的
  ok(man.maxExtra === def,
    `交付数据的 maxExtra(${man.maxExtra}) 等于当前默认(${def})`,
    `数据是用 --max-extra=${man.maxExtra} 建的，而脚本默认是 ${def} —— 重建会得到不一样的结果`);
}
ok(man.extraDropped === 0,
  `★ 没有被丢弃的分级外词（extraDropped=${man.extraDropped}）`,
  `有 ${man.extraDropped} 条被 --max-extra 截掉了`);

// ---------------------------------------------------------------------------
console.log('\n[3] 索引的查询能力真的在');
// ---------------------------------------------------------------------------
const lookup = readJson('data/index/lookup.json').keys;
const readings = readJson('data/index/readings.json').keys;
const terms = readJson('data/index/terms.json').terms;

ok(man.lookupKeys === Object.keys(lookup).length,
  `lookup 键数与 manifest 一致（${man.lookupKeys}）`,
  `manifest=${man.lookupKeys} 实际=${Object.keys(lookup).length}`);
ok(man.readingKeys === Object.keys(readings).length,
  `readings 键数与 manifest 一致（${man.readingKeys}）`,
  `manifest=${man.readingKeys} 实际=${Object.keys(readings).length}`);
ok(man.total === Object.keys(terms).length,
  `terms 条目数与 manifest.total 一致（${man.total}）`,
  `total=${man.total} terms=${Object.keys(terms).length}`);

// ⚠️ 这三个索引必须**真的能查到东西**。空索引不会报错，
//    表现是"查词永远查不到"——用户会以为是自己拼错了。
ok(Object.keys(lookup).length > 10000, '表面形索引不是空的', `${Object.keys(lookup).length} 个键`);
ok(Object.keys(readings).length > 5000, '读音索引不是空的', `${Object.keys(readings).length} 个键`);

// 抽样：索引里指向的 id 必须真的存在于 terms 里。
// 悬空 id 的表现是"点词查不到释义"，而不报任何错。
//
// ⚠️ terms 的形状是 `{ terms: { id: [term, reading, level, zh[], pos[]] } }`
//    —— 用 **id 作键**，所以判断"id 存在"就是 `id in terms`。
//    而 lookup 的形状是 `{ keys: { 表面形: [id, ...] } }`。
//    两者的 key 含义完全不同（一个是 id、一个是表面形），别搞混。
const sampleKeys = Object.keys(lookup).slice(0, 400);
let dangling = 0;
for (const k of sampleKeys) {
  for (const id of (lookup[k] || [])) if (!(id in terms)) dangling++;
}
ok(dangling === 0, `抽样 ${sampleKeys.length} 个表面形，索引里的 id 都能在 terms 里找到`,
  `${dangling} 个悬空 id —— 点这些词会查不到释义`);

// 反向：确认抽样不是空跑
ok(sampleKeys.length > 0 && Object.keys(terms).length > 0,
  '抽样确实取到了键和条目（上面那条不是空跑）',
  `${sampleKeys.length} 键 / ${Object.keys(terms).length} 条目`);

// 每个条目必须有主词形和读音（空值会让界面显示空白）
// terms 的值是数组 [term, reading, level, zh[], pos[]]
let emptySurfaces = 0;
let badShape = 0;
for (const rec of Object.values(terms).slice(0, 3000)) {
  if (!Array.isArray(rec) || rec.length < 4) { badShape++; continue; }
  if (!rec[0]) emptySurfaces++;
}
ok(badShape === 0, '抽样 3000 个条目的结构都是 [词形, 读音, 等级, 中释义, 词类]',
  `${badShape} 个结构不对`);
ok(emptySurfaces === 0, '抽样 3000 个条目都有主词形', `${emptySurfaces} 个空词形`);

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(74));
if (fails.length) {
  console.log(` ✗ ${fails.length} 项未通过（通过 ${pass} 项）`);
  for (const f of fails) console.log('    - ' + f);
  console.log('='.repeat(74));
  process.exit(1);
}
console.log(` 全部通过（${pass} 项）`);
console.log('='.repeat(74));
