/**
 * check-content.mjs 的**反向验证**（test-content-check.mjs）
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么必须有这个测试
 * ────────────────────────────────────────────────────────────────────
 * 项目里反复出现同一类事故：**校验脚本自己坏了，而且坏得"全绿"**。
 * 已经发生过的几次：
 *   · audit-phases 里 `STORE_DEFS\.(\w+)\s*=` 一个都没匹配到，
 *     于是三条依赖它的断言全部**空转通过**；
 *   · `readingMeaning.onYomi` 从来不存在，kanjiReadings 一直是 0；
 *   · 文档里的 `共 37 个脚本` 用 `\*{0,2}` 匹配不上加粗的 `**37`。
 * 共同点：**校验器什么都不查，却报成功**。
 *
 * 所以每个校验器都必须有一份"故意写错"的样例，要求它**必须报出来**。
 * 这就是本文件的作用：给 check-content.mjs 喂一堆错，看它逐条抓住没有。
 *
 * 做法：临时生成一个含 9 种典型错误的内容文件 → 跑 check-content →
 * 断言每一种错误都被点到名（不是只看退出码！退出码非 0 也可能只抓到了第一条）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'tools', '_content-check-fixture.mjs');

let fail = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond || !detail ? '' : '  — ' + detail}`);
};

/** 一条"完全合格"的样本，各种错误都从它派生出来 */
const good = (over = {}) => ({
  id: 'zz-fixture-good',
  level: 'N1',
  category: '条件',
  title: '〜サンプル：示例句型',
  connection: '动词辞书形 + サンプル',
  meaning: '这是一个用来测试校验器的示例条目，说明它的用法和语感。',
  examples: [
    { ja: 'これはサンプルです。', zh: '这是示例。', note: '第一条' },
    { ja: 'サンプルを書きます。', zh: '写示例。' },
    { ja: 'サンプルを見ました。', zh: '看了示例。' },
    { ja: 'サンプルはここです。', zh: '示例在这里。' },
  ],
  mistakes: ['当成正式句型用 → 它只是测试样例'],
  confusions: [{ with: 'サンプル 与 れい', diff: '两者都是示例，判断点是语体。' }],
  tags: ['N1', '条件', 'サンプル', 'sanpuru'],
  ...over,
});

const items = [
  good(),                                                     // 0 合格
  good({ id: 'ZZ_BAD', level: 'N1' }),                        // 1 id 非法
  good({ id: 'zz-fixture-good' }),                            // 2 文件内重复
  good({ id: 'n5-wa-ga-diff' }),                              // 3 全库已存在
  good({ id: 'zz-fixture-nofield', meaning: '' }),            // 4 缺字段
  good({ id: 'zz-fixture-md', meaning: '这里有**星号**。' }),  // 5 Markdown
  good({ id: 'zz-fixture-en', meaning: '这里有 English 单词。' }), // 6 英文
  good({ id: 'zz-fixture-space', examples: [
    { ja: 'これ は スペース入り。', zh: '有空格的例句。' },
    { ja: 'あ。', zh: '甲' }, { ja: 'い。', zh: '乙' }, { ja: 'う。', zh: '丙' },
  ] }),                                                       // 7 例句含空格
  good({ id: 'zz-fixture-few', examples: [{ ja: 'あ。', zh: '甲' }] }), // 8 例句不足 4 条
  good({ id: 'zz-fixture-mist', mistakes: [{ wrong: '对象不是字符串' }] }), // 9 mistakes 不是字符串
];

const src = `export default {\n  level: 'N1',\n  source: '测试用',\n  line: 'jlpt',\n  items: ${JSON.stringify(items, null, 2)},\n};\n`;
fs.writeFileSync(FIXTURE, src, 'utf8');

let out = '';
let code = 0;
try {
  out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'check-content.mjs'),
    path.relative(ROOT, FIXTURE)], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  code = e.status == null ? 1 : e.status;
  out = String(e.stdout || '') + String(e.stderr || '');
} finally {
  try { fs.unlinkSync(FIXTURE); } catch { /* 删不掉不影响结论 */ }
}

ok(code !== 0, '校验器对"故意写错"的文件退出码非 0', `实际 exit=${code}`);

// ★ 关键：逐条确认**每一种**错误都被点到名。
//    只看退出码是不够的 —— 只抓到第一条也会非 0，剩下的错会溜过去。
const must = [
  ['id 非法字符', /ZZ_BAD[^\n]*非法字符/],
  ['文件内重复', /zz-fixture-good[^\n]*重复/],
  ['全库已存在', /n5-wa-ga-diff[^\n]*已经存在/],
  ['缺字段', /zz-fixture-nofield[^\n]*缺字段/],
  ['Markdown', /zz-fixture-md[^\n]*Markdown/],
  ['中文混英文', /zz-fixture-en[^\n]*混了英文/],
  ['例句含空格', /zz-fixture-space[^\n]*含空格/],
  ['例句不足', /zz-fixture-few[^\n]*只有 1 条/],
  ['mistakes 非字符串', /zz-fixture-mist[^\n]*必须是字符串/],
];
for (const [label, re] of must) {
  ok(re.test(out), `抓住了「${label}」`, `输出里没匹配到 ${re}`);
}
// 合格的那条不许被冤枉
ok(!/zz-fixture-good\] 缺字段/.test(out), '合格条目的其它字段没被误报');

// 反向再验一次：把错误都改对，应当通过
const okItems = [good({ id: 'zz-fixture-clean' })];
fs.writeFileSync(FIXTURE, `export default {\n  level: 'N1',\n  source: '测试用',\n  line: 'jlpt',\n  items: ${JSON.stringify(okItems, null, 2)},\n};\n`, 'utf8');
let code2 = 0;
let out2 = '';
try {
  out2 = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'check-content.mjs'),
    path.relative(ROOT, FIXTURE)], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  code2 = e.status == null ? 1 : e.status;
  out2 = String(e.stdout || '') + String(e.stderr || '');
} finally {
  try { fs.unlinkSync(FIXTURE); } catch { /* 同上 */ }
}
ok(code2 === 0, '把错误都改对之后校验器通过（不是无脑报错）', `exit=${code2} ${out2.trim().slice(0, 200)}`);

// ---------------------------------------------------------------------------
// 白名单必须一致
// ---------------------------------------------------------------------------
// 「中文里不许混英文」这条规则写在**两个**文件里（check-content.mjs 自查、
// gen-grammar.mjs 合并前再查一次）。两份白名单一旦漂开，就会出现
// 「自查绿了、合并红」—— 而写内容的人只跑自查，于是他会以为自己写对了。
// 所以这里直接读两个文件的源码，把白名单抠出来做集合比较。
//
// 抠源码而不是 import 常量，是因为 gen-grammar.mjs 是"跑起来就写盘"的脚本，
// 不能为了拿一个常量去执行它。抠的时候**必须断言抠到了东西** ——
// 正则没匹配到时如果不报错，这条测试就会变成永远通过的空转（本项目踩过好几次）。
{
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const grab = (src, label) => {
    const m = /const ALLOWED_LATIN = new Set\(\[([^\]]*)\]\)/.exec(src);
    if (!m) { ok(false, `能从 ${label} 里抠到 ALLOWED_LATIN`, '正则没匹配到 —— 可能是变量改名了'); return null; }
    return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).sort();
  };
  const a = grab(read('tools/check-content.mjs'), 'check-content.mjs');
  const b = grab(read('tools/gen-grammar.mjs'), 'gen-grammar.mjs');
  ok(!!a && a.length > 0, '抠到的白名单非空（防止正则空转）', `得到 ${JSON.stringify(a)}`);
  ok(!!a && !!b && a.join('|') === b.join('|'),
    'check-content.mjs 与 gen-grammar.mjs 的英文白名单完全一致',
    `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}

console.log(fail ? `  ${fail} 项未通过` : '  全部通过');
process.exit(fail ? 1 : 0);
