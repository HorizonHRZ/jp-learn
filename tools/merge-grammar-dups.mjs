/**
 * merge-grammar-dups.mjs —— 合并重复的语法条目。
 *
 * ────────────────────────────────────────────────────────────────────
 * 用户决定（2026-10）
 * ────────────────────────────────────────────────────────────────────
 *   ① 同一语法点在多个等级各有一条时，保留的那条按「最开始学到」的
 *      **最低等级**显示；内容是几条**合并**后的最全版（不是简单挑一条）
 *   ② 复合条目（一条讲 A／B／C）保留；它覆盖的**单点条目**删掉，
 *      但删之前先把单点条目的例句/易混/错误/标签合并进复合条目
 *
 * ────────────────────────────────────────────────────────────────────
 * ★★★ 这个工具的设计里最重要的一个决定：**不做文本解析**
 * ────────────────────────────────────────────────────────────────────
 * 最初的写法是"在源文件的文本里找到某一条的起止行，然后删掉/替换"。
 * 结果**连续三版都有新 bug**，而且每一版都真的把源文件改坏过：
 *
 *   第 1 版：逐行数 `{` `}` 找条目边界。
 *            → 字符串里的花括号也被数进去了（讲解文字里有「…」和 {…}），
 *              深度永远回不到 0，整条范围吃掉了后面好几条，
 *              生成出孤立的 `},`，43 个源文件语法错误。
 *   第 2 版：改成字符级扫描、遇到引号就跳过。
 *            → `skipString()` 返回的是闭合引号**之后**的位置，
 *              我又多减了 1，于是 i 落在闭合引号上、再被当成字符串开头，
 *              字符串感知从那一刻起就失效了 —— 又错。
 *   第 3 版：修了上面那处，但没认"命名导出"。
 *            → 14 个文件用的是 `export const N3_ITEMS = [...]` 而不是
 *              `export default { items: [...] }`，直接读成 undefined。
 *
 * 三次都栽在同一件事上：**想用文本处理去做一件本来属于"解析"的事。**
 *
 * 所以现在换成：**根本不去解析文本。**
 *   · 条目本来就已经以对象形式读进来了（`import` 这个文件就行）
 *   · 要删的、要改的，直接在**对象**上做
 *   · 最后把整份条目数组**序列化**回去
 *   · 序列化完立刻 `node --check`，再用 `import` 读回来逐字段比对
 *
 * 代价：条目区里原有的 74 处行注释会丢（那些是"这一条为什么这么写"的旁注）。
 * 收益：**没有文本解析，就没有文本解析的 bug**，而且输出格式完全一致。
 * 原来的文件整份备份在 data-cache/ 里，需要翻旧注释随时能翻。
 *
 * 文件头（`/** … *​/`）会**原样保留** —— 那里面记着每一批的取舍理由
 * （比如"清单给了 12 条，查重后只写了 9 条"），是内容诚实性的一部分。
 *
 * 用法：
 *   node tools/merge-grammar-dups.mjs --dry    # 只出报告，不写任何文件
 *   node tools/merge-grammar-dups.mjs          # 真合并（自动备份 + 写完自检）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIR = path.join(ROOT, 'data', 'grammar');
const TOOLS = path.join(ROOT, 'tools');
const DRY = process.argv.includes('--dry');

// ---------------------------------------------------------------------------
// 1. 读数据文件（网页实际读的那份）
// ---------------------------------------------------------------------------
const LEVEL_FILES = fs.readdirSync(DIR).filter((f) => /^N\d+\.json$/.test(f)).sort();
const all = [];
for (const f of LEVEL_FILES) {
  const doc = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  for (const it of doc.items) all.push(it);
}
console.log(`  读入 ${all.length} 条（来自 ${LEVEL_FILES.length} 个等级文件）`);

// ---------------------------------------------------------------------------
// 2. 读内容源文件。三种导出写法都要认（照抄 gen-grammar.mjs 的规则）
// ---------------------------------------------------------------------------
function findItems(mod) {
  const cands = [];
  for (const [, v] of Object.entries(mod)) {
    if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object' && v[0].id) cands.push(v);
    if (v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.items)
      && v.items.length && v.items[0] && typeof v.items[0] === 'object' && v.items[0].id) cands.push(v.items);
  }
  const uniq = [];
  for (const c of cands) if (!uniq.includes(c)) uniq.push(c);
  return uniq.length === 1 ? uniq[0] : null;
}

const srcFiles = fs.readdirSync(TOOLS).filter((f) => /^内容-.*\.mjs$/.test(f)).sort();
const sources = [];   // { file, head, NL, envelope, items }
for (const f of srcFiles) {
  const full = path.join(TOOLS, f);
  const text = fs.readFileSync(full, 'utf8');
  const NL = text.includes('\r\n') ? '\r\n' : '\n';
  const mod = await import(pathToFileURL(full).href);
  const items = findItems(mod);
  if (!items) { console.error(`  ✗ ${f}：找不到条目数组，停手`); process.exit(1); }
  const def = mod.default && !Array.isArray(mod.default) ? mod.default : {};
  const srcKey = Object.keys(mod).find((k) => /^[A-Z0-9_]*SOURCE$/.test(k));
  const lineKey = Object.keys(mod).find((k) => /^[A-Z0-9_]*LINE$/.test(k));
  // 文件头：`export` 语句之前的部分（块注释），原样保留
  const headEnd = text.search(/^\s*export\s+(default|const|\{)/m);
  const head = headEnd > 0 ? text.slice(0, headEnd) : '';
  sources.push({
    file: f, full, head, NL,
    envelope: {
      level: def.level || items[0].level,
      source: def.source || (srcKey ? mod[srcKey] : '项目自编'),
      line: def.line || (lineKey ? mod[lineKey] : 'written'),
    },
    items,
  });
}
// id → 它出现在哪个源文件里
const ownerOf = new Map();
for (const s of sources) for (const it of s.items) ownerOf.set(it.id, s);
console.log(`  读入内容源文件 ${sources.length} 个，共声明 ${ownerOf.size} 个 id`);

// ---------------------------------------------------------------------------
// 3. 句型识别 + 合并决策（纯对象运算，不碰文本）
// ---------------------------------------------------------------------------
function norm(s) {
  return String(s).replace(/[〜～~]/g, '').replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s・･、,，]/g, '').trim();
}
const isSummary = (t) => /^(归纳|总结|小结|一览|复习)/.test(String(t || '').trim());
function pointSet(t) {
  const head = String(t || '').split(/[：:]/)[0];
  return [...new Set(head.split(/[／\/]/).map(norm)
    .filter((x) => x && /[\u3040-\u30ff\u4e00-\u9fff]/.test(x))
    .filter((x) => /[\u3040-\u30ff]/.test(x) || x.length <= 6))].sort();
}
function richness(it) {
  return (it.examples || []).length * 3 + (it.confusions || []).length * 2
    + (it.mistakes || []).length * 2 + Math.min(String(it.meaning || '').length / 40, 5)
    + Math.min(String(it.detail || '').length / 60, 4);
}
const LV = { N5: 1, N4: 2, N3: 3, N2: 4, N1: 5 };

const scored = all.filter((it) => !isSummary(it.title));
for (const it of scored) it._ps = pointSet(it.title);

/**
 * ⚠️ 第一版把例句全都堆了进去，结果 n3-l3-zu-niwa 变成 **16 条例句**。
 *    对学习者来说那不叫"内容更全"，那叫"这条怎么这么长"。
 *    合并的目标是去重、保住信息，不是最大化字数。
 */
const MAX_EXAMPLES = 8;
const MAX_MISTAKES = 6;

function mergeInto(keep, donors) {
  const src = [keep, ...donors];
  // ⚠️ 标题**不取最长的**：取最长会把高等级那条的说法搬到低等级条目上
  //    （实测 〜あまり 会变成 N1 的"（不由自主地）"）。
  //    用户选定的规则是"保留最低等级那条"，标题也应该跟着它走。
  const title = String(keep.title || '');
  const pickLongest = (field) => src.slice()
    .sort((a, b) => String(b[field] || '').length - String(a[field] || '').length)[0][field] || '';
  // 释义：保留条目的排最前，其余不同的接在后面，用空行分段
  const meanings = [];
  for (const s of src) {
    const m = String(s.meaning || '').trim();
    if (m && !meanings.includes(m)) meanings.push(m);
  }
  const dedupe = (arr, keyFn) => {
    const seen = new Set(); const out = [];
    for (const s of src) {
      for (const x of (s[arr] || [])) {
        const k = keyFn(x);
        if (!k || seen.has(k)) continue;
        seen.add(k); out.push(x);
      }
    }
    return out;
  };
  const examples = dedupe('examples', (e) => String(e.ja || '').replace(/\s+/g, ''));
  const confusions = dedupe('confusions', (c) => String(c.with || '').replace(/\s+/g, ''));
  const mistakes = dedupe('mistakes', (m) => String(m).replace(/\s+/g, ''));
  const union = (field) => {
    const out = [];
    for (const s of src) for (const t of (s[field] || [])) if (!out.includes(t)) out.push(t);
    return out;
  };
  return {
    title,
    connection: pickLongest('connection'),
    meaning: meanings.join('\n\n'),
    detail: pickLongest('detail'),
    // 易混：**不设上限** —— 对比信息是这一族真正的价值
    examples: examples.slice(0, MAX_EXAMPLES),
    confusions,
    mistakes: mistakes.slice(0, MAX_MISTAKES),
    tags: union('tags'),
    alias: union('alias'),
  };
}

const edits = new Map();     // id → 合并后的条目对象
const removals = new Set();  // 要删掉的 id
const report = [];
const targetLevel = new Map();   // keeper id → 合并后应该放在哪个等级

// ---------------------------------------------------------------------------
// 3b. 用并查集把"重复"关系连成组
// ---------------------------------------------------------------------------
//
// ⚠️ 为什么必须用并查集，而不是"遍历每一对、各自处理"：
//    重复关系可以是**链式**的。实测有这样一串：
//        〜からこそ 有 3 条（N3 两条同名 + N2 一条总览）
//        〜ばこそ 的总览条目又把 N3 那条吸进去
//    如果一对一对地处理，同一条条目会被**两个组**同时声明，
//    于是"删它两次"或者"合并进两个人"—— 结果取决于遍历顺序，
//    而且不会报错。并查集让每个条目**只属于一个组**，从结构上排除这件事。
//    （第一版就是一对对处理的，实测把 n1-j-to-atte / n1-j-to-wa-ie
//      两条同时算进了两个组。）
class UnionFind {
  constructor() { this.p = new Map(); }
  find(x) {
    if (!this.p.has(x)) { this.p.set(x, x); return x; }
    let r = x;
    while (this.p.get(r) !== r) r = this.p.get(r);
    while (this.p.get(x) !== r) { const n = this.p.get(x); this.p.set(x, r); x = n; }
    return r;
  }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p.set(ra, rb); }
}

const uf = new UnionFind();
for (const it of scored) uf.find(it.id);

// ---- 第一类：真重复（句型集合完全一样，而且"纲"是同一个句型）----
//
// ⚠️ 判据从"句型集合完全相同"改成了"句型集合相同 **且** 第一个句型相同"。
//    只用集合相等会**错合**这类条目：
//        〜ことになる／〜ことにする：结论与决定
//        〜ことにする／〜ことになる：自己决定与别人决定
//    两条都列了 ことにする 和 ことになる，集合当然相等，
//    但**一条以 ことになる 为纲、另一条以 ことにする 为纲**，
//    讲的侧重完全不同（谁决定的）—— 合了就是把内容揉成一团。
//    实测这种"集合相等但纲不同"的有 3 类：ことにする/なる、ながら/つつも、がゆえに/ゆえ。
//    加上"纲必须相同"之后，只留下真正的重复。
//
// ⚠️ 另一个坑：有些条目根本不是句型（是"怎么读长句"这类方法条目），
//    标题里没有 ／ 分隔，pointSet 会得到**空集合**。空集合之间互相"相等"，
//    于是 12 条这样的条目会被判成 66 对重复！所以**空集合必须直接跳过**。
const firstPointOf = (t) => String(t || '').split(/[：:]/)[0]
  .split(/[／\/]/)[0].replace(/[（(][^）)]*[）)]/g, '').replace(/[〜～~\s]/g, '').trim();
const byPointSet = new Map();
let skippedEmpty = 0;
for (const it of scored) {
  if (it._ps.length === 0) { skippedEmpty++; continue; }
  const k = it._ps.join('|');
  if (!byPointSet.has(k)) byPointSet.set(k, []);
  byPointSet.get(k).push(it);
}
for (const [, g] of byPointSet) {
  if (g.length < 2) continue;
  // 按"纲"再分一次：纲相同的才是同一组
  const byHead = new Map();
  for (const it of g) {
    const h = firstPointOf(it.title);
    if (!byHead.has(h)) byHead.set(h, []);
    byHead.get(h).push(it);
  }
  for (const [, hg] of byHead) {
    if (hg.length < 2) continue;
    for (let i = 1; i < hg.length; i++) uf.union(hg[0].id, hg[i].id);
  }
}
if (skippedEmpty) console.log(`  （跳过了 ${skippedEmpty} 条"没有句型列表"的方法类条目，避免空集合互相比对）`);

// ---- 第二类：复合条目吸收它"主要在讲"的单点 ----
//
// ⚠️ 这里必须过"结构证据"（和 find-near-dups.mjs 的 lead 判据同一套），
//    否则会犯一个很难发现的错：**只要单点的句型出现在总览的标题里就合并**，
//    而标题里列了 3 个句型的总览会和 3 条不同的单点各合一次，
//    最后变成一个巨型条目、标题里堆着 6 个句型。
//    实测出过：〜について／に関して／に対して／によって／において 把
//    「〜において」的两条都吸进来；还有「〜まで」（N2：连…都）
//    被并进「〜へ／〜から／〜まで」（N5：方向/起点/终点）—— 后者内容根本不同。
//
//    三种结构证据任一成立：
//      A 总览第一个句型就是它
//      B 总览标题里确实列着它（去括号去假名符号后包含）
//      C 冒号后的说明一字不差（标题差异只是"另一个写法"：
//        `〜に先立って：在…之前` vs `〜に先立って／〜に先立ち：在…之前`）
{
  const splitTitle = (t) => {
    const s = String(t || '');
    const i = s.search(/[：:]/);
    const head = i >= 0 ? s.slice(0, i) : s;
    const tail = i >= 0 ? s.slice(i + 1) : '';
    return {
      first: head.split(/[／\/]/)[0].replace(/[（(][^）)]*[）)]/g, '').replace(/[〜～~\s]/g, '').trim(),
      cleanHead: head.replace(/[（(][^）)]*[）)]/g, '').replace(/[〜～~\s／\/]/g, '').trim(),
      cleanTail: tail.replace(/[（(][^）)]*[）)]/g, '').replace(/[〜～~\s／\/、,，]/g, '').trim(),
    };
  };
  const unites = (cTitle, sTitle, cPts, sPts) => {
    const C = splitTitle(cTitle), S = splitTitle(sTitle);
    if (C.first === S.first) return true;
    if (S.cleanHead && C.cleanHead.includes(S.cleanHead)) return true;
    if (S.cleanTail.length >= 4 && S.cleanTail === C.cleanTail) return true;
    void cPts; void sPts;
    return false;
  };
  for (const c of scored.filter((it) => it._ps.length > 1)) {
    const singles = scored.filter((o) => o.id !== c.id && o._ps.length === 1 && c._ps.includes(o._ps[0]));
    for (const s of singles) {
      if (unites(c.title, s.title, c._ps, s._ps)) uf.union(c.id, s.id);
    }
  }
}

// ---- 第三类（可选）：近似重复（--merge-near）----
//
// ⚠️ 这里**直接 import find-near-dups.mjs**，不自己再写一遍判据。
//    我原本在两边各写了一份 tier 计算，结果两边的 richness 公式不一样
//    （一边 `(例句).length * 2`、另一边 `(例句).length * 2`，但一处的
//     `rich` 和另一处的 `exOver/sim` 组合不同），于是**报告说还有 8 对没合、
//    合并工具却一对都没并** —— 两个工具互相矛盾，而且都不报错。
//    这类"同一规则写两遍、然后慢慢分叉"的问题，唯一的解法是**只留一份**。
const MERGE_NEAR = process.argv.includes('--merge-near');
if (MERGE_NEAR) {
  const { findNearDups } = await import(pathToFileURL(path.join(TOOLS, 'find-near-dups.mjs')).href);
  const nearPairs = findNearDups(all).filter((p) => p.tier <= 2 && p.lead);
  console.log(`  近似重复候选（档①② 且标题层面有证据）：${nearPairs.length} 对`);
  for (const p of nearPairs) uf.union(p.small.id, p.big.id);
}

// ---- 收组 ----
const groups = new Map();   // root → [item...]
for (const it of scored) {
  const r = uf.find(it.id);
  if (!groups.has(r)) groups.set(r, []);
  groups.get(r).push(it);
}
let nearGroups = 0;
for (const [, g] of groups) {
  if (g.length < 2) continue;

  // 保留哪一条：
  //  ① 组里有"复合条目"（讲多个句型）→ 保留它（用户选择的规则：
  //     复合条目保留、它覆盖的单点删掉）。多个复合就取句型最多的那个。
  //  ② 没有复合 → 取等级最低的（最先学到的）；同级取内容最全的。
  const composites = g.filter((x) => x._ps.length > 1);
  let keep;
  if (composites.length) {
    keep = composites.slice().sort((a, b) => b._ps.length - a._ps.length || LV[a.level] - LV[b.level] || richness(b) - richness(a))[0];
  } else {
    keep = g.slice().sort((a, b) => LV[a.level] - LV[b.level] || richness(b) - richness(a))[0];
  }
  const donors = g.filter((x) => x.id !== keep.id);
  const merged = mergeInto(keep, donors);

  // 合并后的等级 = 组里**最低**的那个等级（用户选的规则："最开始学到"的那一级）
  const lv = g.slice().sort((a, b) => LV[a.level] - LV[b.level])[0].level;
  edits.set(keep.id, { ...keep, ...merged, level: lv, id: keep.id });
  targetLevel.set(keep.id, lv);
  for (const d of donors) removals.add(d.id);

  const kinds = new Set(g.map((x) => (x._ps.length === 1 ? '单点' : '复合')));
  void kinds;
  report.push({
    kind: composites.length ? '复合吸收' : '单点重复',
    point: keep._ps.join('／'),
    keep: keep.id, level: lv, del: donors.map((d) => d.id),
    moved: keep.level !== lv ? `${keep.level}→${lv}` : '',
  });
}

console.log(`  合并组 ${report.length} 个（单点重复 ${report.filter((r) => r.kind === '单点重复').length} / 复合吸收 ${report.filter((r) => r.kind === '复合吸收').length}）`);
console.log(`  条数：${all.length} → ${all.length - removals.size}（删 ${removals.size} 条，另有 ${edits.size} 条被合并更新）`);

// 合并后不能有"同一个语法点还剩两条"的情况 —— 这是这次任务的验收标准
//
// ⚠️ 判据必须和第一类**完全一致**：句型集合相同 且 纲相同。
//    原来这里只查"单点句型有没有重复"（集合长度 === 1），
//    结果「〜つつ／〜つつも」这种**集合值相同的两条**被漏检了 ——
//    检查写的范围比真正的规则窄，就会"绿着但其实是错的"。
{
  const after = all.filter((it) => !removals.has(it.id)).map((it) => edits.get(it.id) || it);
  const bySet = new Map();
  for (const it of after) {
    if (isSummary(it.title)) continue;
    const set = pointSet(it.title);
    if (!set.length) continue;
    const head = firstPointOf(it.title);
    const k = set.join('|') + '§' + head;
    if (!bySet.has(k)) bySet.set(k, []);
    bySet.get(k).push(it.id);
  }
  const still = [...bySet.entries()].filter(([, v]) => v.length > 1);
  console.log(`  合并后仍重复的语法点：${still.length} 组`);
  for (const [k, v] of still.slice(0, 10)) console.log(`      【${k}】${v.join(', ')}`);
}
// 开了 --merge-near 之后，还要确定"没有剩下的近似重复" —— 否则就是没合干净。
// 判据和 find-near-dups.mjs 完全一致（故意从那边 import，不复制一份阈值）。
if (MERGE_NEAR) {
  const { findNearDups } = await import(pathToFileURL(path.join(TOOLS, 'find-near-dups.mjs')).href);
  const after = all.filter((it) => !removals.has(it.id)).map((it) => {
    const e = edits.get(it.id);
    return e || it;
  });
  const left = findNearDups(after).filter((p) => p.tier <= 2);
  console.log(`  合并后剩下的近似重复（档①②）：${left.length} 对`);
  for (const p of left.slice(0, 8)) {
    console.log(`      【${p.small.id}[${p.small.level}] vs ${p.big.id}[${p.big.level}]】例句重叠 ${(p.ex * 100).toFixed(0)}% 释义相似 ${(p.ms * 100).toFixed(0)}%`);
  }
}

if (DRY) {
  console.log('\n  （--dry：不写任何文件）\n');
  for (const r of report) {
    console.log(`    [${r.kind}] 【${r.point}】保留 ${r.keep}[${r.level}]  ← 删 ${r.del.join(', ')}`);
  }
  console.log('\n  === 抽查合并结果 ===');
  const byId = new Map(all.map((x) => [x.id, x]));
  for (const id of ['n3-j-amari', 'n3-j-tsutsu-aru', 'n3-j-tsuide', 'n2-j-tsutsu', 'n3-l3-zu-niwa']) {
    const e = edits.get(id); if (!e) continue;
    const b = byId.get(id);
    console.log(`\n  ${id}  [${b.level}]`);
    console.log(`    例句 ${(b.examples || []).length}→${e.examples.length}  易混 ${(b.confusions || []).length}→${e.confusions.length}  错误 ${(b.mistakes || []).length}→${e.mistakes.length}  标签 ${(b.tags || []).length}→${e.tags.length}`);
    console.log(`    释义 ${String(b.meaning || '').length} 字 → ${e.meaning.length} 字`);
    console.log(`    标题 ${String(e.title).slice(0, 46)}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 4. 备份 —— 这个项目**没有 git**，改了就没有回头路
// ---------------------------------------------------------------------------
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const BACKUP = path.join(ROOT, 'data-cache', 'grammar-backup-' + stamp);
fs.mkdirSync(path.join(BACKUP, 'data'), { recursive: true });
fs.mkdirSync(path.join(BACKUP, 'tools'), { recursive: true });
for (const f of LEVEL_FILES) fs.copyFileSync(path.join(DIR, f), path.join(BACKUP, 'data', f));
for (const s of sources) fs.copyFileSync(s.full, path.join(BACKUP, 'tools', s.file));
console.log(`  备份：data-cache/${path.basename(BACKUP)}（${LEVEL_FILES.length} 个数据文件 + ${sources.length} 个源文件）`);

// ⚠️ 除了备份，还要写一份**机器可读的合并台账**。
//    原因：删掉条目之后，relations.json / index.json / 每条条目的 related
//    里指过来的 id 会**静默悬空**（三处都只是字符串，指向不存在的东西不报错），
//    网页上就变成"点进去 404"。修的时候必须知道"被删的 id 被谁吸收了"——
//    这个信息只有**这一步**知道（有完整的 edits/removals 映射）。
//    事后想从备份反推是很不可靠的：我试过按文件名/标题片段猜，
//    3 个悬空 id 猜错了 3 个（把「〜あまり」指向了「〜に対して」）。
//    所以台账就在这里当场写，别让下游去猜。
const LEDGER = path.join(ROOT, 'reports', 'merge-ledger.json');
fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
const ledger = {
  说明: [
    'tools/merge-grammar-dups.mjs 每次真跑都会覆盖这份台账。',
    'removed：被删掉的条目 id → 吸收它的条目 id。',
    'tools/fix-relations-after-merge.mjs 靠它把悬空的关系改指向。',
  ],
  时间: new Date().toISOString(),
  备份目录: 'data-cache/' + path.basename(BACKUP),
  合并前条数: all.length,
  合并后条数: all.length - removals.size,
  模式: MERGE_NEAR ? '精确重复 + 近似重复（--merge-near）' : '只合精确重复',
  分组: report.map((r) => ({ 保留: r.keep, 等级: r.level, 删除: r.del, 句型: r.point })),
  removed: Object.fromEntries(report.flatMap((r) => r.del.map((d) => [d, r.keep]))),
};
fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
console.log(`  台账：reports/merge-ledger.json（${Object.keys(ledger.removed).length} 条"被删 → 保留"映射）`);

// ---------------------------------------------------------------------------
// 5. 改源文件：把"删掉/更新后的条目集合"整份序列化回去
// ---------------------------------------------------------------------------
//
// ⚠️ 原来文件头里写的"这一批多少条、为什么这么选"会变得不准
//    （因为这一批可能被删掉了几条）。所以**在文件头后面加一段补记**，
//    说明这次自动合并动了什么 —— 不修改原有的说明文字（那是历史）。
/**
 * 生成"补记"注释块。
 *
 * ⚠️ 这里连踩两个坑，都值得记（自检两次都抓住了并自动回滚 —— 那套机制值了）：
 *
 *   坑 1：模板写成 ` *${cond ? '   · 删除 N 条\n' : ''}`，以为前缀的 `*`
 *        会管住整段。但插值字符串里有 `\n`，换行之后的行没有 `*` 前缀，
 *        块注释从那里就结束了，剩下的文字变成裸露代码。
 *        → 修法：先把内容行 map 成带 `*` 的字符串再拼。
 *
 *   坑 2（更阴）：注释文字里写了备份路径 `data-cache/grammar-backup-{星号}/tools/`，
 *        而 `{星号}/` 这两个字符**本身就是块注释的结束符**。
 *        于是注释在我的说明文字中间就闭合了，后面全是语法错误。
 *        → 修法：任何"会被写进块注释"的文字里都不能出现 `*` 紧跟 `/`。
 *          这里把路径写成 `…backup-（时间戳）` 绕开。
 *        教训：**往注释里塞路径/正则/代码片段时，先想一遍它会不会提前闭合注释。**
 */
function noteLines(items) {
  return items.map((l) => ` * ${l}`).join('\n');
}
const MERGE_NOTE = (removed, replaced) => '\n/*\n'
  + noteLines([
    '────────────────────────────────────────────────────────────────────',
    '补记（由 tools/merge-grammar-dups.mjs 自动添加）',
    '────────────────────────────────────────────────────────────────────',
    '这个文件在本轮"语法去重"里被改写过：',
    ...(removed ? [`   · 删除条目 ${removed} 条（同一语法点在别的等级已有，已并入那一条）`] : []),
    ...(replaced ? [`   · 合并更新条目 ${replaced} 条（吸收了几条重复条目的例句/易混/错误/标签）`] : []),
    '改写的做法是"把条目按对象整份序列化"，所以**条目区原有的行注释没有了**。',
    '需要翻旧注释请看 data-cache 下 grammar-backup-（时间戳）里的 tools 目录备份。',
    '上面那段原有的说明文字保持原样，一个字未改。',
  ])
  + '\n */\n';

let filesTouched = 0, srcRemoved = 0, srcReplaced = 0;
// srcMoved 由下面的 planSourceItems() 给出（不能在这里读 plan —— 那会踩 TDZ）
const written = [];   // { full, before }

/**
 * 算出"每个源文件最终应该有哪些条目"。
 *
 * ⚠️ 原来这一步和下面的"往返验证"是**各写一遍**的，于是验证用的预期集合
 *    只减了删除的、没算搬家的，直接报出 16 个文件"条数不一致" ——
 *    而真实文件其实是对的。这属于"检查自己写错了，还冤枉了正确的输出"，
 *    比没有检查更糟（会让人去修没坏的东西）。
 *    所以现在**只有这一处**计算，写入和验证都读它。
 */
function planSourceItems() {
  const levelToSource = new Map();
  for (const s of sources) {
    if (!levelToSource.has(s.envelope.level)) levelToSource.set(s.envelope.level, s);
  }
  const items = new Map(sources.map((s) => [s, []]));
  const removedCount = new Map(sources.map((s) => [s, 0]));
  const replacedCount = new Map(sources.map((s) => [s, 0]));
  let moved = 0;
  for (const s of sources) {
    for (const it of s.items) {
      if (removals.has(it.id)) { removedCount.set(s, removedCount.get(s) + 1); continue; }
      const merged = edits.get(it.id);
      if (merged) {
        replacedCount.set(s, replacedCount.get(s) + 1);
        const want = targetLevel.get(it.id) || merged.level || s.envelope.level;
        const dest = levelToSource.get(want);
        if (!dest) { console.error(`  ✗ ${it.id} 的目标等级 ${want} 没有对应的源文件`); process.exit(1); }
        if (dest !== s) moved++;
        // ⚠️ 条目的 level 必须和**目的地信封**的等级一致。
        //    不这么做的话，check-recovery 在临时目录里用 gen-grammar 重建时，
        //    gen-grammar 会按信封等级给它盖回一个不同的 level，
        //    逐字段比对就报"不一致"—— 看起来像数据坏了，其实只是搬家没搬干净。
        items.get(dest).push({ ...merged, level: dest.envelope.level });
      } else {
        items.get(s).push(it);
      }
    }
  }
  return { levelToSource, items, removedCount, replacedCount, moved };
}
const plan = planSourceItems();
const itemsBySource = plan.items;
const removedBySource = plan.removedCount;
const replacedBySource = plan.replacedCount;

for (const s of sources) {
  const removedHere = removedBySource.get(s);
  const replacedHere = replacedBySource.get(s);
  const movedIn = itemsBySource.get(s).length - (s.items.length - removedHere - replacedHere);
  if (!removedHere && !replacedHere && !movedIn && itemsBySource.get(s).length === s.items.length) {
    // 这个文件完全没动
  }
  if (!removedHere && !replacedHere && !movedIn) continue;

  srcRemoved += removedHere;
  srcReplaced += replacedHere;
  const envelope = { ...s.envelope, items: itemsBySource.get(s) };
  const note = MERGE_NOTE(removedHere, replacedHere)
    + (movedIn || removedHere ? `\n/*\n * 补记（续）：本文件条目数变化 ${s.items.length} → ${itemsBySource.get(s).length}` +
      (movedIn ? `，其中 ${movedIn} 条是从别的等级文件搬过来的（合并后按"最先学到的等级"归属）` : '') +
      '。\n */\n' : '');
  const out = (s.head || '') + 'export default ' + JSON.stringify(envelope, null, 2) + ';' + s.NL + note;
  written.push({ full: s.full, before: fs.readFileSync(s.full, 'utf8'), after: out });
  filesTouched++;
}
console.log(`  跨等级搬家的条目：${plan.moved} 条`);

// 逐字节比较：没有真正变化的文件不要写（避免无意义的 diff 和备注）
const realWrites = written.filter((w) => w.before !== w.after);
if (realWrites.length !== written.length) {
  console.log(`  （${written.length - realWrites.length} 个文件内容其实没变，跳过不写）`);
}

// 写文件 + 立刻语法自检；任何一个不过就整批回滚
for (const w of realWrites) fs.writeFileSync(w.full, w.after, 'utf8');
{
  const bad = [];
  for (const w of realWrites) {
    try { execFileSync(process.execPath, ['--check', w.full], { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { bad.push([w.full, String(e.stderr || '').split('\n').slice(0, 2).join(' ')]); }
  }
  if (bad.length) {
    console.error(`\n  ✗✗ 有 ${bad.length} 个文件语法错误 —— 全部回滚，不留半成品`);
    for (const [f, m] of bad.slice(0, 5)) console.error(`      ${path.basename(f)}: ${m}`);
    for (const w of realWrites) fs.writeFileSync(w.full, w.before, 'utf8');
    console.error('  已回滚。');
    process.exit(1);
  }
}
console.log(`  源文件：改写 ${realWrites.length} 个（删 ${srcRemoved} 条、合并更新 ${srcReplaced} 条），已逐个 node --check 通过`);

// 往返验证：重新 import 一遍，确认每个源文件的条目 id 集合
// 和 **planSourceItems() 算出来的预期集合**逐项一致。
// （用同一个 plan，避免"检查自己算错还冤枉正确输出"——这坑真踩过。）
{
  const problems = [];
  for (const s of sources) {
    const expect = itemsBySource.get(s).map((it) => it.id);
    const mod = await import(pathToFileURL(s.full).href + '?v=' + Date.now());
    const got = (findItems(mod) || []).map((it) => it.id);
    if (expect.join(',') !== got.join(',')) {
      problems.push(`${s.file}: 预期 ${expect.length} 条 / 实际 ${got.length} 条` +
        `（期望里多出的：${expect.filter((x) => !got.includes(x)).slice(0, 3).join(',') || '无'}；` +
        `实际里多出的：${got.filter((x) => !expect.includes(x)).slice(0, 3).join(',') || '无'}）`);
    }
  }
  console.log(`  往返验证：${sources.length} 个源文件，不一致 ${problems.length} 个`);
  for (const p of problems.slice(0, 5)) console.log(`      ✗ ${p}`);
  if (problems.length) { console.error('  ✗ 往返验证失败'); process.exit(1); }
}

// ---------------------------------------------------------------------------
// 6. 改数据文件（网页实际读的）
// ---------------------------------------------------------------------------
let dataRemoved = 0, dataUpdated = 0, dataMoved = 0;
// 先把"每条目标数据"算好，再按目标等级分桶 —— 因为合并可能让它**降级**
// （用户规则："最开始学到"的那一级），降级就要搬到另一个等级文件里。
const byTargetLevel = new Map();
for (const f of LEVEL_FILES) byTargetLevel.set(f.replace(/\.json$/, ''), []);
for (const f of LEVEL_FILES) {
  const doc = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  const srcLv = f.replace(/\.json$/, '');
  for (const it of doc.items) {
    if (removals.has(it.id)) { dataRemoved++; continue; }
    if (edits.has(it.id)) {
      const merged = edits.get(it.id);
      const lv = targetLevel.get(it.id) || merged.level || srcLv;
      if (!byTargetLevel.has(lv)) { console.error(`  ✗ 目标等级 ${lv} 没有对应数据文件`); process.exit(1); }
      byTargetLevel.get(lv).push({ ...merged, level: lv, line: it.line });
      if (lv !== srcLv) dataMoved++;
      dataUpdated++;
    } else {
      byTargetLevel.get(srcLv).push(it);
    }
  }
}
for (const f of LEVEL_FILES) {
  const full = path.join(DIR, f);
  const doc = JSON.parse(fs.readFileSync(full, 'utf8'));
  const before = doc.items.length;
  const next = byTargetLevel.get(f.replace(/\.json$/, ''));
  doc.items = next;
  doc.count = next.length;
  fs.writeFileSync(full, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  console.log(`    ${f}: ${before} → ${next.length}`);
}
console.log(`  数据文件：删 ${dataRemoved} 条、更新 ${dataUpdated} 条（其中跨等级搬家 ${dataMoved} 条）`);

// ---------------------------------------------------------------------------
// 7. 收尾自检
// ---------------------------------------------------------------------------
{
  const bad = LEVEL_FILES.filter((f) => {
    const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    return d.items.some((x) => x.level !== d.level);
  });
  console.log(`  等级一致性：${bad.length ? '✗ ' + bad.join(', ') : '✓ 每条 level 都和所在文件一致'}`);
  if (bad.length) process.exit(1);
}
console.log('\n  下一步：node tools/build-grammar-index.mjs && node tools/test-grammar.mjs && node tools/check-recovery.mjs');
