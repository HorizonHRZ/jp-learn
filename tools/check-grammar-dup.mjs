/**
 * check-grammar-dup.mjs —— 语法库"同一语法点重复"检查（进自检套件）。
 *
 * ────────────────────────────────────────────────────────────────────
 * 这个测试要防的是什么（真实发生过）
 * ────────────────────────────────────────────────────────────────────
 * 我写了 n2-j-kuse-shite（〜くせして），结果它是**重复的** ——
 * n3-j-kuse-ni（〜くせに）里早就把 くせして 当口语变体讲过了。
 *
 * 两个内容审计脚本都没抓住，因为它们查"**字符串**出现过没有"：
 * 搜「くせに」搜不到「くせして」；搜「くせして」在那条正文里出现过，
 * 于是判"已有"（结论碰巧对，理由不对：它以为"提过就算有"）。
 *
 * **审计按字符串，重复按语法点 —— 中间有个缝。** 这个测试盯的就是这条缝：
 *   ① 同一别名被 ≥2 条声明 → 一定是重复；
 *   ② 一条把「X」声明为别名，而**另一条的标题主形式就是 X** → 疑重复；
 *   ③ 源文件和数据文件必须同步（只删一边 = 下次重跑又回来）；
 *   ④ 每个 alias 必须能被搜到（进了索引才算真的有用）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let fail = 0;
const ok = (c, m, d = '') => { if (c) console.log('  ✓ ' + m); else { fail++; console.log('  ✗ ' + m + (d ? '  ' + d : '')); } };

// ⚠️ 路径从**本文件位置**推，不依赖 CWD。
//    本项目的自检脚本有两种跑法：在 jp-learn 里跑（`node tools/x.mjs`）
//    和在工作区根跑（`node jp-learn/tools/x.mjs`）。用 'jp-learn/tools/...'
//    这种硬编码相对路径，在第二种跑法下会变成
//    `jp-learn/jp-learn/tools/` —— 而且报的是 ENOENT 而不是断言失败，
//    看起来像脚本坏了。这条踩过一次（check-grammar-dup 第一版）。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GROOT = path.join(ROOT, 'data', 'grammar') + path.sep;
const TROOT = path.join(ROOT, 'tools') + path.sep;
/**
 * 等级清单。
 *
 * ⚠️ 这里原来写死 `['N5','N4','N3','N2']` —— **漏了 N1**。
 *    漏掉一个等级的后果不是报错，而是那个等级的重复**永远查不出来**：
 *    脚本照样绿，人会以为"查过了"。
 *    2026-10 补完 N1 内容后暴露：`源文件里的每个 id 都已经生成进数据文件`
 *    这条断言报了「缺 106 个」，而实际缺的是"这个脚本没读 N1.json"。
 *    （同一个毛病在 tools/check-duplicate.mjs 里也有一份，已一起修。）
 *
 *    更稳的写法是**扫目录**而不是写死清单，这样将来加 N0/等级改名都不会漏。
 */
const LEVELS = fs.readdirSync(path.join(ROOT, 'data', 'grammar'))
  .filter((f) => /^N\d+\.json$/.test(f))
  .map((f) => f.replace(/\.json$/, ''))
  .sort();

const all = [];
for (const f of LEVELS) {
  const p = GROOT + f + '.json';
  if (!fs.existsSync(p)) continue;
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const x of doc.items) all.push({ f, x });
}

console.log('\n[1] alias 字段本身要合法');
for (const { f, x } of all) {
  if (!Array.isArray(x.alias)) continue;
  for (const a of x.alias) {
    ok(typeof a === 'string' && a.length >= 2 && !/^[〜～\s]+$/.test(a),
      f + ':' + x.id + ' 的别名「' + a + '」是非空字符串且长度 ≥2');
  }
}

console.log('\n[2] 同一别名不能被两条同时声明（这才是真重复）');
{
  const idx = new Map();
  for (const { f, x } of all) for (const a of (x.alias || [])) {
    if (!idx.has(a)) idx.set(a, []);
    idx.get(a).push(f + ':' + x.id);
  }
  let bad = 0;
  for (const [a, v] of idx) {
    if (v.length >= 2) { bad++; console.log('      「' + a + '」被 ' + v.join('、') + ' 声明'); }
  }
  ok(bad === 0, '没有别名被 ≥2 条同时声明', bad ? bad + ' 组冲突' : '（共 ' + idx.size + ' 个别名）');
}

console.log('\n[3] 别名不能指向"另一条的主形式"（等于有两条讲同一件事）');
{
  // 标题主形式：冒号前，按 / 拆开，去掉 〜 和空格
  const heads = new Map();
  for (const { f, x } of all) {
    const head = String(x.title || '').split(/[：:]/)[0].replace(/[〜～\s]/g, '');
    for (const z of head.split(/[／/]/)) if (z) heads.set(z, (heads.get(z) || []).concat([f + ':' + x.id]));
  }
  let bad = 0;
  for (const { f, x } of all) {
    for (const a of (x.alias || [])) {
      const owners = (heads.get(a) || []).filter((o) => !o.endsWith(x.id));
      if (owners.length) { bad++; console.log('      ' + x.id + ' 声明「' + a + '」为别名，但 ' + owners.join('、') + ' 的主形式就是它'); }
    }
  }
  ok(bad === 0, '没有别名指向另一条的主形式', bad ? bad + ' 处' : '');
}

console.log('\n[4] 源文件与数据文件必须同步（只删一边 = 下次重跑又回来）');
{
  // 对每个"数据里有的 id"，检查它是否在某个内容源文件里；反之亦然。
  const srcIds = new Set();
  for (const f of fs.readdirSync(TROOT).filter((z) => z.startsWith('内容-') && z.endsWith('.mjs'))) {
    const s = fs.readFileSync(TROOT + f, 'utf8');
    for (const m of s.matchAll(/id:\s*'([a-z0-9-]+)'/g)) srcIds.add(m[1]);
  }
  const dataIds = new Set(all.map((e) => e.x.id));
  const onlyData = [...dataIds].filter((i) => !srcIds.has(i));
  const onlySrc = [...srcIds].filter((i) => !dataIds.has(i));
  // 手工修订过的老条目可能只在数据里，所以 onlyData 只报告不判死；
  // 但"源文件里有、数据里没有"一定是没跑 gen-grammar，要报错。
  ok(onlySrc.length === 0, '源文件里的每个 id 都已经生成进数据文件',
    onlySrc.length ? '缺 ' + onlySrc.length + ' 个：' + onlySrc.slice(0, 5).join(', ') : '');
  if (onlyData.length) {
    console.log('      ℹ 只在数据里、内容源文件没有的 id：' + onlyData.length + ' 个（老条目手工修订所致，不算错）');
    if (onlyData.length <= 8) for (const i of onlyData) console.log('        ' + i);
  }
}

console.log('\n[5] 每个 alias 都要真的能搜到（进了索引才算有用）');
{
  const idx = JSON.parse(fs.readFileSync(GROOT + 'index.json', 'utf8'));
  const byId = new Map(idx.items.map((x) => [x.id, x]));
  let bad = 0;
  for (const { x } of all) {
    for (const a of (x.alias || [])) {
      const rec = byId.get(x.id);
      const has = rec && Array.isArray(rec.alias) && rec.alias.includes(a);
      if (!has) { bad++; console.log('      ' + x.id + ' 的别名「' + a + '」没进索引（重跑 build-grammar-index.mjs）'); }
    }
  }
  ok(bad === 0, '所有别名都进了索引', bad ? bad + ' 个没进' : '');
  ok((idx.items.find((z) => z.id === 'n3-j-kuse-ni') || {}).alias
    && idx.items.find((z) => z.id === 'n3-j-kuse-ni').alias.includes('くせして'),
    '★ 反向验证锚点：n3-j-kuse-ni 的索引里确实有别名 くせして',
    '（这一条是"这个测试有没有判别力"的锚，删了它就没人盯这件事了）');
}

console.log('\n' + '='.repeat(74));
console.log(fail === 0 ? ' 全部通过' : ' ' + fail + ' 项未通过');
console.log('='.repeat(74));
process.exit(fail === 0 ? 0 : 1);
