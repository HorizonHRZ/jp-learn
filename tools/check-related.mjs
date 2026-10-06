/**
 * check-related.mjs —— 检查 relations.json 的关系表。
 *
 * ────────────────────────────────────────────────────────────────────
 * 要防的两件事（都会造成"看起来能用但实际是坏的"）
 * ────────────────────────────────────────────────────────────────────
 * ① **悬空 id**：关系指向一个不存在的条目 → 用户点进去是空白页，
 *    或者更糟：链接长得像能点，点了什么也不发生。数据里看不出错。
 * ② **单向关系**：A 声明了"相关 B"，但 B 没有回头声明 A →
 *    从 A 能跳到 B，从 B 跳不回 A。用户会觉得"这功能时好时坏"。
 *
 * 这两件事都不会让程序报错，所以必须有机器检查。
 *
 * ⚠️ 另外检查：关系的**推荐条数**。一个条目挂 20 个"相关"等于没推荐，
 *    用户不会点。目标 1~4 条。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let fail = 0;
const ok = (c, m, d = '') => { if (c) console.log('  ✓ ' + m); else { fail++; console.log('  ✗ ' + m + (d ? '  ' + d : '')); } };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GROOT = path.join(ROOT, 'data', 'grammar');

const rel = JSON.parse(fs.readFileSync(path.join(GROOT, 'relations.json'), 'utf8')).relations || {};

// 所有真实 id
const ids = new Set();
for (const f of ['N5', 'N4', 'N3', 'N2', 'N1']) {
  const p = path.join(GROOT, f + '.json');
  if (!fs.existsSync(p)) continue;
  for (const x of JSON.parse(fs.readFileSync(p, 'utf8')).items) ids.add(x.id);
}

console.log('\n[0] relations.json 里不能有重复键（JSON.parse 会静默丢掉一个）');
{
  // ⚠️ 为什么必须单独查这个：JSON.parse 遇到重复键**不报错**，
  //    后一个覆盖前一个。我确实写重了 n3-j-kara-to-itte，
  //    而 [1]~[5] 全都通过了 —— 因为被丢掉的那一份里没有坏数据。
  //    一旦被丢掉的那份里**有**关系，就会静默少几条关联，
  //    而且检查全绿。这类"解析器替你做了决定还不告诉你"的错最危险。
  const raw = fs.readFileSync(path.join(GROOT, 'relations.json'), 'utf8');
  const keys = [...raw.matchAll(/^ {4}"([a-z0-9-]+)": \[/gm)].map((m) => m[1]);
  const seen = new Set(); const dup = [];
  for (const k of keys) { if (seen.has(k)) dup.push(k); seen.add(k); }
  ok(dup.length === 0, '没有重复的关系键',
    dup.length ? '重复：' + dup.join(', ') + '（前一份会被静默丢弃）' : '（' + keys.length + ' 个键）');
}

console.log('\n[1] 关系表的每个 id（键和值）都必须真实存在');
{
  const danglingKeys = Object.keys(rel).filter((k) => !ids.has(k));
  const danglingVals = [];
  for (const [k, list] of Object.entries(rel)) {
    for (const e of list) if (!ids.has(e.to)) danglingVals.push(k + ' → ' + e.to);
  }
  ok(danglingKeys.length === 0, '所有关系键都是真实条目 id',
    danglingKeys.length ? '悬空 ' + danglingKeys.length + ' 个：' + danglingKeys.slice(0, 5).join(', ') : '（共 ' + Object.keys(rel).length + ' 条）');
  ok(danglingVals.length === 0, '所有关系指向的 id 都真实存在',
    danglingVals.length ? '悬空 ' + danglingVals.length + ' 个：' + danglingVals.slice(0, 5).join(', ') : '');
}

console.log('\n[2] 关系必须双向（A→B 则 B→A）');
{
  const missing = [];
  for (const [k, list] of Object.entries(rel)) {
    for (const e of list) {
      const back = (rel[e.to] || []).some((z) => z.to === k);
      if (!back) missing.push(k + ' → ' + e.to);
    }
  }
  ok(missing.length === 0, '每条关系都有反向声明',
    missing.length ? missing.length + ' 条单向：' + missing.slice(0, 6).join(' | ') : '');
  if (missing.length) {
    console.log('      修法：给下面这些条目补上反向关系，格式是 {"to":"对方id","why":"一句话"}');
    for (const m of missing) {
      const [a, b] = m.split(' → ');
      console.log('        ' + b + '  需要补一条  → ' + a);
    }
  }
}

console.log('\n[3] 每条关系都要有一句 why（否则用户不知道为什么相关）');
{
  const bad = [];
  for (const [k, list] of Object.entries(rel)) {
    for (const e of list) {
      if (typeof e.why !== 'string' || e.why.trim().length < 6) bad.push(k + ' → ' + e.to);
    }
  }
  ok(bad.length === 0, '每条关系都有 why 且长度合理',
    bad.length ? bad.length + ' 条缺 why：' + bad.slice(0, 5).join(', ') : '');
}

console.log('\n[4] 一个条目挂的相关不能太多（>4 条等于没推荐）');
{
  const fat = Object.entries(rel).filter(([, v]) => v.length > 4);
  ok(fat.length === 0, '没有条目挂超过 4 条相关',
    fat.length ? fat.map(([k, v]) => k + '(' + v.length + ')').join(', ') : '（最多 ' + Math.max(0, ...Object.values(rel).map((v) => v.length)) + ' 条）');
}

console.log('\n[5] 关系要真的进索引（否则界面读不到）');
{
  const p = path.join(GROOT, 'index.json');
  if (!fs.existsSync(p)) { ok(false, 'index.json 存在'); }
  else {
    const idx = JSON.parse(fs.readFileSync(p, 'utf8'));
    const byId = new Map(idx.items.map((x) => [x.id, x]));
    let miss = 0;
    for (const [k, list] of Object.entries(rel)) {
      const rec = byId.get(k);
      const n = rec && Array.isArray(rec.related) ? rec.related.length : 0;
      if (n !== list.length) miss++;
    }
    ok(miss === 0, '每条关系都写进了索引的 related 字段',
      miss ? miss + ' 条没同步（重跑 build-grammar-index.mjs）' : '');
  }
}

console.log('\n' + '='.repeat(74));
console.log(fail === 0 ? ' 全部通过' : ' ' + fail + ' 项未通过');
console.log('='.repeat(74));
process.exit(fail === 0 ? 0 : 1);
