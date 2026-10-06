/**
 * fix-relations-after-merge.mjs —— 合并删掉条目之后，把指向"已删除条目"的关系
 * 改指向"吸收它的那条"，然后重排、去重、写回。
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么必须有这个脚本
 * ────────────────────────────────────────────────────────────────────
 * 删掉一条语法条目，**不会**让它被引用到的地方报错。引用点至少有三处：
 *   1. data/grammar/relations.json  的 relations 表和反查表
 *   2. data/grammar/index.json      每条条目里的 related 字段
 *   3. 每条条目自己的 related 字段
 * 三处都只是"字符串记着 id"，指向一个不存在的 id 也照样能读。
 * 所以删除条目之后**必须专门检查并修一遍**，否则网页上会出现
 * "点进去 404" 的关系链接 —— 而且不会有任何报错提示你。
 *
 * ────────────────────────────────────────────────────────────────────
 * 怎么知道"该改指向谁"
 * ────────────────────────────────────────────────────────────────────
 * 优先读 tools/merge-grammar-dups.mjs 写下的**台账**
 * （reports/merge-ledger.json，里面是"被删 id → 保留 id"）。
 * 台账缺失时（比如以前跑过的合并）从**最近一次备份**推：
 * 把备份里的等级文件和现在的等级文件**按数组顺序对照** ——
 * 合并工具是按"原顺序过滤掉被删的"重写数据的，所以
 * 被删条目在备份里的**下一个仍存在的 id** 就是吸收它的那条。
 * 这条规则推出来的结果还要**过一遍检验**：保留者的句型必须覆盖被删者的句型，
 * 否则视为推不出来（宁可放弃改指向、直接删掉这条关系，也不要乱指）。
 *
 * 用法：
 *   node tools/fix-relations-after-merge.mjs --dry     # 只报告改什么
 *   node tools/fix-relations-after-merge.mjs           # 真的写
 *
 * 写完之后**必须**重跑 build-grammar-index.mjs（index.json 的 related 要同步），
 * 再跑 check-related.mjs 确认 7 项全绿。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pointSet } from './find-near-dups.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'data', 'grammar');
const DRY = process.argv.includes('--dry');
const NL = fs.readFileSync(path.join(DIR, 'N5.json'), 'utf8').includes('\r\n') ? '\r\n' : '\n';
const LEVEL_FILES = fs.readdirSync(DIR).filter((x) => /^N\d+\.json$/.test(x)).sort();

// ---------------------------------------------------------------------------
// 1. 读现在的条目 + relations，找出"悬空"的 id
// ---------------------------------------------------------------------------
const live = new Map();
for (const f of LEVEL_FILES) {
  const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  for (const it of (d.items || [])) live.set(it.id, it);
}
console.log(`  现有条目 ${live.size} 条`);

const relPath = path.join(DIR, 'relations.json');
const rel = JSON.parse(fs.readFileSync(relPath, 'utf8'));

const dangling = new Set();
for (const [k, list] of Object.entries(rel.relations)) {
  if (!live.has(k)) dangling.add(k);
  for (const r of list) if (!live.has(r.to)) dangling.add(r.to);
}
for (const it of live.values()) {
  for (const r of (it.related || [])) if (!live.has(r)) dangling.add(r);
}
console.log(`  悬空 id ${dangling.size} 个：${[...dangling].join(', ') || '（无）'}`);
if (!dangling.size) {
  console.log('  ✓ 没有悬空关系，不需要修');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 2. 求"被删 id → 吸收它的那条"
// ---------------------------------------------------------------------------
const redirect = new Map();

// ---- 来源一：合并台账（最可靠，直接用）----
const LEDGER = path.join(ROOT, 'reports', 'merge-ledger.json');
if (fs.existsSync(LEDGER)) {
  try {
    const led = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
    for (const [gone, keep] of Object.entries(led.removed || {})) redirect.set(gone, keep);
    console.log(`  台账 reports/merge-ledger.json：${redirect.size} 条映射（${led.模式 || '?'}）`);
  } catch (e) {
    console.log(`  ⚠️ 台账读不动（${e.message}），改从备份推`);
  }
}

// ---- 来源二：从最近一次备份推（台账缺失时才用）----
if (!redirect.size) {
  const backups = fs.readdirSync(path.join(ROOT, 'data-cache'))
    .filter((x) => x.startsWith('grammar-backup-')).sort().reverse();
  let bk = null;
  for (const b of backups) {
    if (fs.existsSync(path.join(ROOT, 'data-cache', b, 'data', 'N5.json'))) { bk = b; break; }
  }
  if (!bk) {
    console.log('  ⚠️ 找不到带数据的备份，无法推断改指向');
  } else {
    console.log(`  从备份推：data-cache/${bk}`);
    for (const f of LEVEL_FILES) {
      const p = path.join(ROOT, 'data-cache', bk, 'data', f);
      if (!fs.existsSync(p)) continue;
      const before = (JSON.parse(fs.readFileSync(p, 'utf8')).items || []);
      const after = (JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')).items || []);
      const afterIds = new Set(after.map((x) => x.id));
      const beforeIds = new Set(before.map((x) => x.id));
      for (let i = 0; i < before.length; i++) {
        const it = before[i];
        if (afterIds.has(it.id)) continue;                 // 没被删
        // 同文件里往后找第一个仍存在的 id
        let keep = null;
        for (let j = i + 1; j < before.length; j++) {
          if (afterIds.has(before[j].id)) { keep = before[j].id; break; }
        }
        // 往后再找不到就往前找（被删的是该组最后一条时）
        if (!keep) {
          for (let j = i - 1; j >= 0; j--) {
            if (afterIds.has(before[j].id)) { keep = before[j].id; break; }
          }
        }
        // 等级可能搬走了：另找"现在存在、备份里不存在"的新条目比对句型
        if (!keep || !covers(live.get(keep), it)) {
          const cand = [...live.values()].find((x) => !beforeIds.has(x.id) && covers(x, it))
            || [...live.values()].find((x) => covers(x, it));
          if (cand) keep = cand.id;
        }
        if (keep && covers(live.get(keep), it)) redirect.set(it.id, keep);
        else console.log(`      ⚠️ 推不出 ${it.id} 被谁吸收了（将删掉指向它的关系）`);
      }
    }
    console.log(`  推出改指向 ${redirect.size} 条`);
  }
}

/** 保留者的句型集合必须**覆盖**被删者的句型集合，否则不认这个推断 */
function covers(keeper, gone) {
  if (!keeper || !gone) return false;
  const k = pointSet(keeper.title), g = pointSet(gone.title);
  if (!g.length) return false;
  return g.every((p) => k.includes(p));
}

// ---------------------------------------------------------------------------
// 3. 改写 relations
// ---------------------------------------------------------------------------
const out = {};
let redirected = 0, dropped = 0, deduped = 0;
for (const [k, list] of Object.entries(rel.relations)) {
  const dest = redirect.get(k) || k;
  if (!live.has(dest)) { dropped++; continue; }
  if (dest !== k) redirected++;
  if (!out[dest]) out[dest] = [];
  for (const r of list) {
    const to = redirect.get(r.to) || r.to;
    if (!live.has(to)) { dropped++; continue; }
    if (to === dest) continue;                       // 自己指向自己，没意义
    if (out[dest].some((x) => x.to === to)) { deduped++; continue; }
    out[dest].push({ to, why: r.why });
  }
}
// 反向补齐：双向关系是硬规则（A→B 必须 B→A）
let patched = 0;
for (const [a, list] of Object.entries(out)) {
  for (const r of list) {
    if (!out[r.to]) out[r.to] = [];
    if (!out[r.to].some((x) => x.to === a)) { out[r.to].push({ to: a, why: r.why }); patched++; }
  }
}
// 排序并**限长**（check-related 规定每条最多 4 个关系）
let trimmed = 0;
const sorted = {};
for (const k of Object.keys(out).sort()) {
  let list = out[k].slice().sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  if (list.length > 4) { trimmed += list.length - 4; list = list.slice(0, 4); }
  sorted[k] = list;
}
const next = { ...rel, relations: sorted };

console.log(`  改指向 ${redirected} 条、丢弃悬空 ${dropped} 条、去重 ${deduped} 条、反向补齐 ${patched} 条、超 4 条裁掉 ${trimmed} 条`);
console.log(`  关系键：${Object.keys(rel.relations).length} → ${Object.keys(sorted).length}`);

if (DRY) {
  console.log('\n  （--dry：不写文件）');
  for (const u of dangling) {
    const d = redirect.get(u);
    console.log(`    ${u} → ${d || '（删掉这条关系）'}${d && live.get(d) ? '   ' + String(live.get(d).title).slice(0, 34) : ''}`);
  }
  process.exit(0);
}
fs.writeFileSync(relPath, JSON.stringify(next, null, 2) + NL, 'utf8');
console.log(`  已写 ${path.relative(ROOT, relPath)}`);
console.log('  下一步：node tools/build-grammar-index.mjs && node tools/check-related.mjs');
