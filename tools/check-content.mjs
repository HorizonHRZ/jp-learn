/**
 * 语法内容文件的**只读**校验器（check-content.mjs）
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么要有它（和 gen-grammar.mjs 的区别）
 * ────────────────────────────────────────────────────────────────────
 * `gen-grammar.mjs` 自检完会**写盘**（合并进 data/grammar/<等级>.json）。
 * 内容分批并行写的时候，多个写手同时跑 gen-grammar 会同时写同一个 JSON —— 
 * 后写的覆盖先写的，条目会**静默丢失**。
 *
 * 所以把"自检"单独抽出来，规则和 gen-grammar **逐条对齐**，但不写任何文件。
 * 写手用它自查，全部通过之后再统一由人跑一次 gen-grammar 合并。
 *
 * ⚠️ 校验规则必须和 gen-grammar.mjs 保持一致。两边不同的后果是
 *    "自查绿了、合并红"，或者更糟：合并悄悄放过。改一边就要改另一边 ——
 *    这个脚本的用例由 tools/test-content-check.mjs 盯着（它故意造错，
 *    要求这里必须报出来）。
 *
 * 用法：
 *   node tools/check-content.mjs tools/内容-JLPT-N1a.mjs
 *   node tools/check-content.mjs tools/内容-*.mjs        （PowerShell 会自己展开）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'data', 'grammar');

/**
 * 「中文里不许混英文」的白名单 —— **必须和 gen-grammar.mjs 里的那份完全一致**。
 *
 * 这是本项目最容易漂的一类东西：同一套规则写在两个文件里，改了一边忘了另一边，
 * 结果"自查绿了、合并红"（或者更糟：一边悄悄放宽了）。
 * 所以 tools/test-content-check.mjs 里有一条断言直接读这两个文件的源码，
 * 把两份白名单抠出来做集合比较 —— 见那个文件里「白名单必须一致」那一段。
 */
const ALLOWED_LATIN = new Set(['wa', 'ha', 'watashi', 'AI']);

/**
 * 两种模式，区别只有一个：**这份内容有没有已经合并进 data/grammar/**。
 *
 *   · 新内容模式（默认）：`node tools/check-content.mjs tools/内容-新写的.mjs`
 *     用来在合并**之前**把关。这时 id 必须是新的、例句要够 4 条。
 *
 *   · 快照模式：加 `--recovered`，或在文件名里带「恢复」，或信封的 source
 *     带反向导出标记（见 RECOVERED_MARKER）。
 *     用来检查**已经合并过**的内容文件。两条规则在语义上不适用：
 *       ① 「id 全库已经存在」—— 它本来就存在，这正是"已合并"的意思，不是错误；
 *       ② 「例句至少 4 条」—— 那是现在写新内容的规范；早年写的条目没有这条要求，
 *          我不打算为了通过校验去**编**例句（那是造假数据）。
 *     其余规则（非法字符、缺字段、Markdown、英文、例句空格、mistakes 类型等）
 *     一律照查 —— 快照不等于免检。
 *
 * ⚠️ 不带文件参数 = 扫全部内容文件（自动按快照模式查，因为它们都已合并）。
 *    为什么要这个模式：写内容的人最自然的动作是"直接跑一下看有没有问题"。
 *    如果这时报的是"用法：…"然后退出，他要么随便挑一个文件查，要么干脆不查。
 */
const RECOVERED_MARKER = /反向导出/;

const rel = process.argv.slice(2).find((a) => !a.startsWith('--'));

/**
 * 不带文件参数 = **扫全部内容文件**。
 *
 * 为什么要这个模式（而不是让人写个 for 循环）：
 *   写新内容的人最自然的动作是"直接跑一下 check-content 看有没有问题"。
 *   如果这时报的是一句"用法：…"然后退出 2，他要么随便挑一个文件查，
 *   要么干脆不查 —— 两种都不是我们想要的结果。
 *   所以不带参数就当成"查全部"。
 *
 * 实现上**递归调用自己**（每个文件一次），而不是把主流程抽成函数：
 *   主流程是"单文件"的线性脚本，抽函数要动的地方多、容易在改动里引入偏差；
 *   而递归调用保证**单文件模式和扫全库模式跑的是同一段代码** ——
 *   "两条路各写一遍最后悄悄不一致"是本项目反复踩过的坑。
 *   代价是每个文件多起一个 node 进程（51 个文件、约 6 秒），可以接受。
 */
if (!rel) {
  const files = fs.readdirSync(path.join(ROOT, 'tools'))
    .filter((f) => f.startsWith('内容-') && f.endsWith('.mjs')).sort();
  if (!files.length) {
    console.error('✗ tools/ 下没找到任何「内容-*.mjs」文件 —— 这不对劲，检查一下目录');
    process.exit(1);
  }
  let failed = 0;
  for (const f of files) {
    // 已合并的内容一律按快照模式查（见上面两种模式的说明）。
    // 带 --recovered 是"把话说清楚"，而不是靠文件名/信封字段去猜。
    const r = spawnSync(process.execPath,
      [fileURLToPath(import.meta.url), 'tools/' + f, '--recovered'],
      { cwd: ROOT, encoding: 'utf8' });
    const out = String(r.stdout || '') + String(r.stderr || '');
    const n = /：(\d+) 条/.exec(out);
    if (r.status !== 0) {
      failed++;
      console.log(`  ✗ ${f}`);
      for (const line of out.split('\n').filter((l) => /✗/.test(l)).slice(0, 6)) {
        console.log('      ' + line.trim());
      }
    } else {
      console.log(`  ✓ ${f}${n ? `（${n[1]} 条）` : ''}`);
    }
  }
  console.log(`\n  扫了 ${files.length} 个内容文件，不合格 ${failed} 个`);
  process.exit(failed ? 1 : 0);
}

const contentPath = path.resolve(ROOT, rel);
if (!fs.existsSync(contentPath)) {
  console.error(`找不到内容文件：${rel}`);
  process.exit(2);
}

// 全库已有 id（查重范围：所有等级文件）
const usedIds = new Set();
for (const f of fs.readdirSync(DIR)) {
  if (!/^N\d\.json$/.test(f)) continue;
  const doc = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  for (const it of doc.items || []) usedIds.add(it.id);
}

let mod;
try {
  mod = await import(pathToFileURL(contentPath).href);
} catch (e) {
  console.error(`✗ 内容文件语法错误，import 失败：${(e && e.message) || e}`);
  process.exit(1);
}

// 找条目数组（和 gen-grammar 同一套约定）
const candidates = [];
let envelopeLine = '';
let envelopeSource = '';
for (const [k, v] of Object.entries(mod)) {
  if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object' && v[0].id) candidates.push([k, v]);
  if (v && typeof v === 'object' && !Array.isArray(v)
      && Array.isArray(v.items) && v.items.length
      && v.items[0] && typeof v.items[0] === 'object' && v.items[0].id) {
    candidates.push([k + '.items', v.items]);
    if (!envelopeLine && typeof v.line === 'string' && v.line) envelopeLine = v.line;
    // ⚠️ source 是**信封**上的字段，不是每个条目上的。第一版只看 items[].source，
    //    于是反向恢复文件（source 写在信封上）永远识别不出来 ——
    //    正则本身没问题，是**我找错了地方**，而且没有任何提示。
    //    教训：判断"这个字段在不在"之前，先确认它在哪一层。
    if (!envelopeSource && typeof v.source === 'string') envelopeSource = v.source;
  }
  if (/^[A-Z0-9_]*LINE$/.test(k) && typeof v === 'string') envelopeLine = v;
  if (/^[A-Z0-9_]*SOURCE$/.test(k) && typeof v === 'string') envelopeSource = v;
}
const uniq = [];
for (const c of candidates) if (!uniq.some((u) => u[1] === c[1])) uniq.push(c);
if (uniq.length !== 1) {
  console.error(`✗ 找不到唯一的条目数组（找到 ${uniq.length} 个：${uniq.map((u) => u[0]).join('、')}）`);
  process.exit(1);
}
const items = uniq[0][1];

/**
 * 是否按"反向恢复的快照文件"来查（规则少两条，见上面 RECOVERED_MARKER 的说明）。
 * 两条路：命令行显式 `--recovered`，或者文件里的 source 自带反向导出标记。
 * 后者是为了让"不带参数扫全库"这个最常用用法保持全绿 ——
 * **一个长期红的检查等于没有检查**。
 */
const RECOVERED = process.argv.includes('--recovered')
  || RECOVERED_MARKER.test(envelopeSource)
  || items.some((x) => x && typeof x.source === 'string' && RECOVERED_MARKER.test(x.source));
if (RECOVERED && !process.argv.includes('--recovered') && !/恢复/.test(rel)) {
  // 自动识别只在文件名也像恢复文件时才生效。
  // 为什么加这道闸：万一有人写新内容时随手在 source 里写了"反向导出"，
  // 那两条规则会被静默跳过。文件名对不上就在这里说明一声，不会被误会成"放宽了"。
  console.log(`  ⚠️ ${rel} 的 source 带了反向导出标记，按快照文件规则检查（已跳过"id 已存在/例句数"两条）`);
}

const problems = [];
const levels = [...new Set(items.map((x) => x.level))];
if (levels.length !== 1) problems.push(`一个内容文件里的 level 必须统一，现在是 [${levels.join(', ')}]`);

const seen = new Set();
for (const it of items) {
  const at = `[${it.id || '(没有 id)'}]`;
  if (!it.id) { problems.push(`${at} 缺 id`); continue; }
  if (!/^[a-z0-9-]+$/.test(it.id)) problems.push(`${at} id 里有非法字符（只能小写字母、数字、连字符）`);
  if (seen.has(it.id)) problems.push(`${at} 在内容文件里重复`);
  if (usedIds.has(it.id) && !RECOVERED) problems.push(`${at} 这个 id 全库已经存在了（换个 slug）`);
  seen.add(it.id);

  for (const k of ['level', 'category', 'title', 'connection', 'meaning', 'examples', 'mistakes', 'tags']) {
    if (!it[k]) problems.push(`${at} 缺字段 ${k}`);
  }
  if (!Array.isArray(it.mistakes) || !it.mistakes.length) problems.push(`${at} mistakes 必须是数组且非空`);
  else if (it.mistakes.some((m) => typeof m !== 'string')) problems.push(`${at} mistakes 的每一项必须是字符串（不能是对象）`);
  if (!Array.isArray(it.examples) || !it.examples.length) problems.push(`${at} 没有例句`);
  else if (it.examples.length < 4 && !RECOVERED) problems.push(`${at} 例句只有 ${it.examples.length} 条，规范要求至少 4 条`);

  if (!it.line && !envelopeLine) {
    problems.push(`${at} 没有 line，且信封里也没写 —— 请在顶层写 line: 'jlpt' 或 'written'`);
  }

  const copy = [it.title, it.connection, it.meaning, it.detail || '',
    ...(it.examples || []).flatMap((e) => [e.zh, e.note || '']),
    ...(it.confusions || []).flatMap((c) => [c.with, c.diff, (c.example && c.example.zh) || '']),
    ...(it.mistakes || []), ...(it.tags || [])].join('\n');
  if (/\*\*|`|\[[^\]]+\]\([^)]+\)/.test(copy)) problems.push(`${at} 文案里有 Markdown 标记`);

  const cnOnly = [it.meaning, it.detail || '', ...(it.examples || []).map((e) => e.zh),
    ...(it.confusions || []).map((c) => c.diff), ...(it.mistakes || [])].join('\n');
  const en = (cnOnly.match(/[A-Za-z]{2,}/g) || []).filter((w) => !ALLOWED_LATIN.has(w));
  if (en.length) problems.push(`${at} 中文里混了英文：${[...new Set(en)].join(' ')}`);

  for (const e of it.examples || []) {
    if (!e.ja) problems.push(`${at} 例句缺 ja`);
    else if (/\s/.test(e.ja)) problems.push(`${at} 例句含空格：${e.ja}`);
    if (!e.zh) problems.push(`${at} 例句缺 zh`);
  }
  for (const c of it.confusions || []) {
    if (!c.with || !c.diff) problems.push(`${at} confusions 缺 with/diff`);
  }
}

if (problems.length) {
  console.error(`✗ ${rel} 自检发现 ${problems.length} 个问题：`);
  for (const p of problems) console.error('  ✗ ' + p);
  process.exit(1);
}
console.log(`✓ ${rel}：${items.length} 条（${levels[0]} / ${envelopeLine || items[0].line}）全部合格`);
