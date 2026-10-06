/**
 * find-near-dups.mjs —— 找"疑似还是重复"的语法条目，按内容重复程度分档。
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么还需要这个脚本
 * ────────────────────────────────────────────────────────────────────
 * `merge-grammar-dups.mjs` 的判重规则是**句型集合完全相同**（有意保守），
 * 它处理掉了 85 组、115 条。但还有一类它按规则**不该**动：
 *
 *   单点条目 A（标题就是「〜に先立って」）
 *   总览条目 B（标题是「〜に先立って／〜に先立ち」，讲的是 A 加一个变体）
 *
 * 集合不同（A 是 {に先立って}、B 是 {に先立ち, に先立って}），所以严格判重放过。
 * 但用户搜 "に先立って" 会看到同一语法点的**两条**解释 —— 这正是他报的问题。
 *
 * 光看标题像不像不够（「〜つつ」和「〜つつ／〜つつある」标题也像，
 * 但一个是细讲、一个是总览，两条都留着是对的）。所以这个脚本按
 * **内容重不重**分档：
 *
 *   ① 内容明显重复：例句重叠 ≥ 50% 或 释义二元组相似 ≥ 30%
 *      → 讲的是同一件事，应该合
 *   ② 上位条目明显更"空"：大那条的内容量不足单点的一半
 *      → 它就是个薄壳版本，应该合
 *   ③ 其余：各有各的例句和讲解，像"细讲 + 总览"，可以保留
 *
 * 用法：
 *   node tools/find-near-dups.mjs            # 出报告
 *   node tools/find-near-dups.mjs --json     # 出报告 + 机器可读的候选清单
 *
 * 注意：这个脚本**只读不写**。真要合并走 merge-grammar-dups.mjs 的
 * `--merge-near` 模式（它复用这里的判据）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'data', 'grammar');

export const normPoint = (s) => String(s).replace(/[〜～~]/g, '').replace(/[（(][^）)]*[）)]/g, '')
  .replace(/[\s・･、,，]/g, '').trim();
export const isSummary = (t) => /^(归纳|总结|小结|一览|复习)/.test(String(t || '').trim());
export const pointSet = (t) => {
  const head = String(t || '').split(/[：:]/)[0];
  return [...new Set(head.split(/[／\/]/).map(normPoint)
    .filter((x) => x && /[\u3040-\u30ff\u4e00-\u9fff]/.test(x))
    .filter((x) => /[\u3040-\u30ff]/.test(x) || x.length <= 6))].sort();
};

/**
 * 和 pointSet 的区别：`〜ながら（も）／〜つつ` 得 {ながら: [], つつ: []}、
 * `〜ながら（も）／〜つつも` 得 {ながら: [], つつ: ['も']}。
 * **括号里的内容要留下来当"变体后缀"**，不能像 pointSet 那样直接删掉。
 * 判断"两条是不是同一个语法点"时，句型名和它的变体后缀**要一起比**。
 */
export const variantsByPoint = (t) => {
  const head = String(t || '').split(/[：:]/)[0];
  const out = new Map();
  for (const piece of head.split(/[／\/]/)) {
    if (!piece.trim()) continue;
    let after = '', before = '';
    const idx = piece.search(/[（(]/);          // 括号后面（「ながら」的「も」）
    const bare = piece.replace(/[（(][^）)]*[）)]/g, (m) => { after = m; return ''; });
    before = bare.replace(/[〜～~\s]/g, '').trim();
    const sfx = after.replace(/[（()）\s〜～~]/g, '').trim();
    const key = normPoint(bare).replace(/[（(][^）)]*[）)]/g, '');
    if (!key || !/[\u3040-\u30ff\u4e00-\u9fff]/.test(key)) continue;
    out.set(key, [...(out.get(key) || []), sfx].sort());
  }
  return out;
};

/** 两条条目是不是"同一个语法点"的**变体列表**（比 pointSet 更严，能区分 つつ / つつも） */
export const sameVariantList = (a, b) => {
  const A = variantsByPoint(a), B = variantsByPoint(b);
  if (A.size !== B.size || A.size === 0) return false;
  for (const [k, v] of A) {
    if (!B.has(k)) return false;
    if (B.get(k).join('|') !== v.join('|')) return false;
  }
  return true;
};

/** 二元组重合度（谁短以谁为分母，所以"短的那条被长的那条包含"会得高分） */
export function bigramSim(a, b) {
  const gram = (s) => {
    const t = String(s).replace(/\s+/g, '');
    const g = new Set();
    for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
    return g;
  };
  const A = gram(a), B = gram(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / Math.min(A.size, B.size);
}
export function exampleOverlap(a, b) {
  const A = new Set((a.examples || []).map((e) => String(e.ja).replace(/\s+/g, '')));
  const B = (b.examples || []).map((e) => String(e.ja).replace(/\s+/g, ''));
  if (!B.length) return 0;
  return B.filter((x) => A.has(x)).length / B.length;
}
export const richness = (x) => (x.examples || []).length * 2 + (x.confusions || []).length
  + (x.mistakes || []).length + String(x.meaning || '').length / 50;

/**
 * 找候选。返回 [{ small, big, ex, ms, rSmall, rBig, tier, lead }]
 *   tier 1 = 内容明显重复；tier 2 = 上位条目明显更空；tier 3 = 可保留
 *   lead   = 标题层面**确实**是"总览在讲这条单点"的证据（见下面的 A/B 判据）
 *
 * ⚠️ tier 是"内容像不像"，lead 是"结构上是不是"。**两个都要看**：
 *    只按内容合会把「〜まで」（N2：连…都）并进「〜へ／〜から／〜まで」（N5：起点终点），
 *    两条讲的是完全不同的语法内容，只是标题共享一个碎片。
 *    所以 `merge-grammar-dups.mjs --merge-near` 要求 `tier <= 2 && lead`。
 */
export function findNearDups(items) {
  /**
   * 标题拆成 (第一个句型, 冒号后面的说明)。
   *
   * ⚠️ 判断"总览是不是在讲这条单点"时，**不能只比对第一个句型**。
   *    反例：`〜に先立って：在…之前（先做准备）` 与
   *          `〜に先立って／〜に先立ち：在…之前（先做准备）`
   *    前者取「に先立って」、后者取「に先立ち」——一字之差（っ vs き），
   *    严格比较不相等，可它们**就是同一个语法点的两个写法**。
   *    所以除了句型名，还要看**冒号后面的说明**：说明完全一样时，
   *    标题的差异只是"另一个写法"，那就是重复。
   */
  const splitTitle = (t) => {
    const s = String(t || '');
    const i = s.search(/[：:]/);
    const head = (i >= 0 ? s.slice(0, i) : s);
    const tail = (i >= 0 ? s.slice(i + 1) : '');
    const first = head.split(/[／\/]/)[0].replace(/[（(][^）)]*[）)]/g, '').replace(/[〜～~\s]/g, '').trim();
    const cleanHead = head.replace(/[（(][^）)]*[）)]/g, '').replace(/[〜～~\s／\/]/g, '').trim();
    const cleanTail = tail.replace(/[（(][^）)]*[）)]/g, '').replace(/[〜～~\s／\/、,，]/g, '').trim();
    return { first, cleanHead, cleanTail };
  };
  const scored = items.filter((x) => !isSummary(x.title)).map((x) => ({ ...x, _ps: pointSet(x.title) }));
  const out = [];
  for (let i = 0; i < scored.length; i++) {
    for (let j = i + 1; j < scored.length; j++) {
      const a = scored[i], b = scored[j];
      const inter = a._ps.filter((p) => b._ps.includes(p));
      if (!inter.length) continue;
      const aCov = inter.length === a._ps.length, bCov = inter.length === b._ps.length;
      if (!aCov && !bCov) continue;
      let small, big;
      if (a._ps.length < b._ps.length) { small = a; big = b; }
      else if (b._ps.length < a._ps.length) { small = b; big = a; }
      else continue;                                  // 集合相等 → 第一轮已处理
      if (small._ps.length !== 1 || small._ps[0] !== inter[0]) continue;

      // 结构证据（三种任一）：
      //   A 总览的第一个句型就是它
      //   B 总览标题（去括号去假名符号）包含它 —— 它确实列在标题里
      //   C 冒号后面的说明完全一样 —— 标题差异只是"另一个写法"
      const S = splitTitle(small.title), B = splitTitle(big.title);
      const leading = B.first === S.first;
      const inHead = S.cleanHead && B.cleanHead.includes(S.cleanHead);
      const sameTail = S.cleanTail.length >= 4 && S.cleanTail === B.cleanTail;

      const ex = exampleOverlap(small, big);
      const ms = bigramSim(small.meaning, big.meaning);
      const rSmall = richness(small), rBig = richness(big);
      const tier = (ex >= 0.5 || ms >= 0.3) ? 1 : (rBig < rSmall * 0.6 ? 2 : 3);
      out.push({
        small, big, ex, ms, rSmall, rBig, tier,
        lead: leading || inHead || sameTail,
        leadWhy: leading ? 'A' : (inHead ? 'B' : (sameTail ? 'C' : '')),
      });
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('find-near-dups.mjs')) {
  const items = [];
  for (const f of fs.readdirSync(DIR).filter((x) => /^N\d+\.json$/.test(x)).sort()) {
    const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    for (const it of (d.items || [])) items.push(it);
  }
  const pairs = findNearDups(items);
  const t1 = pairs.filter((p) => p.tier === 1);
  const t2 = pairs.filter((p) => p.tier === 2);
  const t3 = pairs.filter((p) => p.tier === 3);
  const actionable = pairs.filter((p) => p.tier <= 2 && p.lead);

  console.log(`  语法条目 ${items.length} 条`);
  console.log(`  疑似重复 共 ${pairs.length} 对：`);
  console.log(`    ① 内容明显重复：${t1.length} 对`);
  console.log(`    ② 上位条目更空：${t2.length} 对`);
  console.log(`    ③ 各有内容（可保留）：${t3.length} 对`);
  console.log(`\n  ★ 其中"结构上也确实是总览在讲它"（标题层面有证据）的：${actionable.length} 对`);
  console.log(`     只有这 ${actionable.length} 对会被 merge-grammar-dups.mjs --merge-near 合并。`);
  const rejected = pairs.filter((p) => p.tier <= 2 && !p.lead);
  console.log(`     档①②里被结构判据排除的：${rejected.length} 对（它们只是标题共享一个碎片）`);

  const show = (p) => {
    console.log(`    ${p.lead ? '★' : ' '} [${p.small.level}] ${p.small.id.padEnd(28)} 例句重叠 ${(p.ex * 100).toFixed(0).padStart(3)}%  释义相似 ${(p.ms * 100).toFixed(0).padStart(3)}%  内容量 ${p.rSmall.toFixed(1)} vs ${p.rBig.toFixed(1)}${p.lead ? '  ' + p.leadWhy : ''}`);
    console.log(`      A ${String(p.small.title).slice(0, 50)}`);
    console.log(`      B ${String(p.big.title).slice(0, 50)}   （${p.big.id}[${p.big.level}]）`);
  };
  console.log('\n  ══ 会被合并的（档①② + 结构判据）══');
  for (const p of actionable) show(p);
  console.log('\n  ══ 档①②但结构判据排除（不合并）══');
  for (const p of rejected) show(p);
  console.log('\n  ══ ③ 可保留（前 8 对举例）══');
  for (const p of t3.slice(0, 8)) show(p);

  if (process.argv.includes('--json')) {
    const out = pairs.map((p) => ({
      tier: p.tier, lead: !!p.lead, small: p.small.id, big: p.big.id,
      ex: +p.ex.toFixed(2), ms: +p.ms.toFixed(2),
    }));
    fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'reports', 'near-dups.json'), JSON.stringify(out, null, 2));
    console.log('\n  候选清单写到 reports/near-dups.json');
  }
}
