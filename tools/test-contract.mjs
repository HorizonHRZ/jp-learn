/**
 * 模块契约检查（静态分析，不需要浏览器）
 *
 * 用法：node tools/test-contract.mjs
 *
 * 为什么需要这个：视图里的错误大多是**点击时才炸**的——比如 import 了一个
 * 并不存在的函数（vd.fromLibWord / Q.someMisspelling）。语法检查看不出来，
 * 单元测试也测不到（因为要 DOM）。等用户点到那个按钮才报错，是最糟的发现方式。
 *
 * 这里做静态检查：
 *   1. 每个视图满足路由契约（导出 default、有 render）
 *   2. 视图里对导入模块的成员访问，在该模块的导出里确实存在
 *   3. 视图实现了 destroy()，且 destroy 里确实摘掉了监听的 keydown
 *   4. 没有残留的占位/未完成标记
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0, passed = 0;
const ok = (cond, label, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
};

console.log('='.repeat(74));
console.log(' 模块契约检查（静态分析）');
console.log('='.repeat(74));

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** 抽出一个模块文件的所有导出名 */
function exportsOf(relPath) {
  const src = read(relPath);
  const names = new Set();
  // export function foo / export async function foo
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  // export const foo = / export let foo =
  for (const m of src.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  // export { a, b as c }
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const piece of m[1].split(',')) {
      const t = piece.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  // export default { ...methods }  —— 视图对象
  if (/export\s+default\s*\{/.test(src)) names.add('default');
  if (/export\s+default\s+[A-Za-z_$]/.test(src)) names.add('default');
  return names;
}

// ---------------------------------------------------------------------------
// 1. 视图契约
// ---------------------------------------------------------------------------
console.log('\n(1) 视图契约');
const VIEWS = ['home', 'vocab', 'lyric', 'reading', 'grammar', 'stats', 'settings'];
for (const v of VIEWS) {
  const rel = `app/js/views/${v}.js`;
  const src = read(rel);
  ok(/export\s+default\s*\{/.test(src) || /export\s+default\s+/.test(src), `${rel} 导出了 default`);
  ok(/async\s+render\s*\(|render\s*\(/.test(src), `${rel} 有 render()`);
  ok(/id:\s*'[a-z]+'/.test(src), `${rel} 声明了 id`);
  ok(/title:\s*'/.test(src), `${rel} 声明了 title`);
}

// ---------------------------------------------------------------------------
// 2. 跨模块成员引用必须真实存在
// ---------------------------------------------------------------------------
console.log('\n(2) 视图引用的模块成员确实存在（防止点击时才炸）');

/** 找出 `import * as X from '../y.js'` 的映射 */
function namespaceImports(src) {
  const map = new Map();
  // 注意：结尾必须排除 ` from`，否则 `import * as db from '../db.js'` 会把
  // 模块基名 `db` 当成别名，再往后匹配到 `from` 里的 `js`（实测踩到过）。
  for (const m of src.matchAll(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)(?!\s+from)\s+from\s+'([^']+)'/g)) {
    map.set(m[1], m[2]);
  }
  return map;
}

/** 把相对 import 路径解析成仓库相对路径 */
function resolveRel(fromRel, spec) {
  if (!spec.startsWith('.')) return null;
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
}

const MODULE_EXPORTS = new Map();
function exportsFor(rel) {
  if (!MODULE_EXPORTS.has(rel)) MODULE_EXPORTS.set(rel, exportsOf(rel));
  return MODULE_EXPORTS.get(rel);
}

/** 已知不是本仓库模块的命名空间（浏览器/DOM 相关），跳过 */
const SKIP_NS = new Set();

for (const v of VIEWS) {
  const rel = `app/js/views/${v}.js`;
  const src = read(rel);
  const ns = namespaceImports(src);

  for (const [alias, spec] of ns) {
    const target = resolveRel(rel, spec);
    if (!target || !fs.existsSync(path.join(ROOT, target))) {
      ok(false, `${rel}: import * as ${alias} from '${spec}' 指向的文件不存在`);
      continue;
    }
    const ex = exportsFor(target);
    // 收集 src 里 alias.member 的用法。
    // 结尾的 (?![\w$]) 很重要：`_` 属于 \w，缺了它 `S._SRS()` 会被当成
    // 命名空间 S 的成员 `_SRS`，报出一个并不存在的成员（实测踩到过）。
    const used = new Set();
    for (const m of src.matchAll(new RegExp(`\\b${alias}\\.([A-Za-z_$][\\w$]*)(?![\\w$])`, 'g'))) used.add(m[1]);

    const missing = [...used].filter((name) => !ex.has(name));
    ok(missing.length === 0,
      `${rel}: ${alias}（${target}）用到的 ${used.size} 个成员都存在`,
      missing.length ? `不存在：${missing.join(', ')}` : '');
  }

  // 具名 import 也要检查
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
    const target = resolveRel(rel, m[2]);
    if (!target || !fs.existsSync(path.join(ROOT, target))) {
      ok(false, `${rel}: import {...} from '${m[2]}' 指向的文件不存在`);
      continue;
    }
    const ex = exportsFor(target);
    const wanted = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    const missing = wanted.filter((n) => !ex.has(n));
    ok(missing.length === 0,
      `${rel}: 从 ${target} 具名导入的 ${wanted.length} 个成员都存在`,
      missing.length ? `不存在：${missing.join(', ')}` : '');
  }
}

// ---------------------------------------------------------------------------
// 3. 事件监听必须被清理
// ---------------------------------------------------------------------------
console.log('\n(3) 全局事件监听的清理');
for (const v of VIEWS) {
  const rel = `app/js/views/${v}.js`;
  const src = read(rel);
  const adds = (src.match(/document\.addEventListener\('keydown'/g) || []).length;
  if (!adds) { ok(true, `${rel} 没有注册全局 keydown（无需清理）`); continue; }
  const hasDestroy = /destroy\s*\(/.test(src);
  const removes = (src.match(/document\.removeEventListener\('keydown'/g) || []).length;
  ok(hasDestroy, `${rel} 注册了 keydown，实现了 destroy()`);
  ok(removes > 0, `${rel} destroy 里摘掉了 keydown 监听`);
  ok(/keyHandler/.test(src), `${rel} 用可复用的 handler 引用（否则摘不掉匿名监听）`);
}

// ---------------------------------------------------------------------------
// 4. 背单词页的关键能力确实接上了
// ---------------------------------------------------------------------------
console.log('\n(4) 背单词页关键能力');
{
  const src = read('app/js/views/vocab.js');
  const need = [
    ['ensureLibrary', '会准备内置词库缓存'],
    ['startSession', '能开始一次练习'],
    ['submitAnswer', '会推进会话'],
    ['recordAnswer', '会把作答写回 SRS/错题/历史'],
    ['grade', '有评分入口'],
    ['verdictBlock', '会显示答案与解析'],
    ['listMistakes', '错题本接入'],
    ['parseWordList', '导入前会解析预览'],
    ['importWordList', '能导入词表'],
    ['confirmTwice', '批量删除走二次确认'],
    ['makeSnapshot', '批量删除前强制快照（约束 3）'],
    ['openLookupFor', '接了全局速查抽屉'],
    ['humanInterval', '评分按钮会显示下次复习时间'],
    ['weightForReinforce', '记忆加深接入'],
    ['removeEventListener', 'destroy 里摘监听'],
  ];
  for (const [kw, why] of need) ok(src.includes(kw), why, src.includes(kw) ? '' : `缺少 ${kw}`);
  // 练习模式已按用户要求收敛为 3 个。视图自己不再写死模式 id（写死就会出现
  // 两份真相：界面列出的和出题器认识的），所以这里核对的是 quiz.js 的声明，
  // 以及视图确实只消费这一份声明。
  const quizSrc = read('app/js/quiz.js');
  const declared = [...quizSrc.matchAll(/^\s{2}([a-z0-9_]+):\s*\{/gm)].map((m) => m[1]);
  for (const m of ['jp2zh', 'zh2jp', 'zh2jp_typing']) {
    ok(declared.includes(m), `quiz.js 声明了练习模式 ${m}`, declared.join(', '));
  }
  for (const dead of ['listen', 'cloze', 'kana']) {
    ok(!declared.includes(dead), `练习模式 ${dead} 已删除`);
    ok(!new RegExp(`'${dead}'`).test(src), `视图里没有残留的 ${dead}`);
  }
  // 模式列表由 quiz.js 导出，视图必须按它渲染而不是自己维护一份副本，
  // 否则以后增删模式时界面和出题器会悄悄不一致。
  ok(/MODE_ORDER/.test(src), '视图按 quiz.js 的 MODE_ORDER 渲染模式列表');
  // 用户要求背单词模块不含任何语音内容：视图既不能 import speak.js，
  // 也不能再出现 🔊 按钮的标记。断言"没有"比断言"有"更容易被误删，
  // 所以这里显式钉住它。
  ok(!/from\s+'[^']*speak\.js'/.test(src), '背单词页不引用 speak.js');
  ok(!/🔊/.test(src), '背单词页没有 🔊 朗读按钮');
  // 评分按钮已删除，改成自动评分（见 ARCHITECTURE §10.18）
  ok(/gradeAuto/.test(src), '背单词页是自动评分（gradeAuto）');
  ok(!/grade-row/.test(src), '背单词页不再渲染评分按钮行（grade-row）');
}

// ---------------------------------------------------------------------------
// 5. 速查抽屉
// ---------------------------------------------------------------------------
console.log('\n(5) 全局速查抽屉');
{
  const src = read('app/js/drawer.js');
  for (const [kw, why] of [
    ['toggleLookup', '对外暴露开关'],
    ['lookupWord', '会查词'],
    ['addWord', '能一键加入生词本'],
    ['removeWord', '能移除'],
    ['isInVocab', '会显示是否已加入'],
  ]) ok(src.includes(kw), why, src.includes(kw) ? '' : `缺少 ${kw}`);
  // 「能朗读（speak）」这条断言随语音功能一起删掉了：用户要求背单词模块
  // 不出现任何语音内容，抽屉里的朗读按钮也已移除。这里改成断言它**没有**
  // 再引用 speak.js，否则将来有人加回按钮，没人会发现。
  ok(!/from\s+'[^']*speak\.js'/.test(src), '速查抽屉不再引用 speak.js');

  const app = read('app/js/app.js');
  ok(app.includes('toggleLookup'), 'app.js 已接上速查开关');
  ok(/Ctrl\+Shift\+F|ctrlKey/.test(app), '注册了全局快捷键 Ctrl+Shift+F');
}

// ---------------------------------------------------------------------------
// 6. 无残留占位
// ---------------------------------------------------------------------------
console.log('\n(6) 无残留占位与半成品');
{
  const vocab = read('app/js/views/vocab.js');
  ok(!/占位视图/.test(vocab), '背单词页不再是占位视图');
  ok(!/开发中/.test(vocab), '背单词页没有残留「开发中」标记');

  // 检查是否残留我调试时的模块桩
  for (const rel of ['app/js/views/vocab.js', 'app/js/session.js', 'app/js/quiz.js']) {
    const src = read(rel);
    ok(!/S_SRS\(\)|S_SRSX\(\)|_srsx\b|_srs\s*=\s*null/.test(src), `${rel} 没有残留的模块桩函数`);
  }
}

// ---------------------------------------------------------------------------
// 7. 动态 import 的相对路径必须指向真实文件
// ---------------------------------------------------------------------------
//
// ⚠️ 这一节是**真事故**换来的，值得完整记下来。
//
// 现象：用户实拍一页书 → OCR 成功 → 精读页渲染成功 → **点一个单词** →
//       弹出「速查抽屉打不开：Failed to fetch dynamically imported module:
//       http://127.0.0.1:8787/js/views/drawer.js」
//
// 根因：`app/js/views/jpreader.js` 里写的是 `await import('./drawer.js')`，
//       但 `drawer.js` 在 `app/js/` 下，而 jpreader 在 `app/js/views/` 下，
//       所以正确写法是 `'../drawer.js'`。
//       少了 `../`，浏览器就去请求一个不存在的文件。
//
// **为什么所有测试都没抓到它**（这是本节存在的全部理由）：
//   · 原来的静态检查只匹配 `import ... from '...'`，
//     **完全不看** `import('...')` 这种动态形式；
//   · `test-render.mjs` 是直接 `import('../app/js/drawer.js')` ——
//     它按**真实路径**加载抽屉，压根没走 jpreader 里那条动态导入；
//   · 页面本身能正常打开（不点词就不会加载抽屉）。
//
// 结果就是最难堪的一种状态：**功能 100% 坏掉，而测试 100% 通过。**
//
// 检查方式刻意选成"**把相对路径解析成绝对路径，再看文件在不在**"，
// 而不是"有没有写 import" —— 后者正是当初漏掉它的原因。
console.log('\n(7) 动态 import 的相对路径指向真实文件');
{
  const allJs = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) allJs.push(p);
    }
  };
  walk(path.join(ROOT, 'app', 'js'));

  let checked = 0;
  const bad = [];
  for (const abs of allJs) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    // ⚠️ 先剥注释再扫。jpreader.js 的说明注释里就写着 `import('./drawer.js')`
    //    （那是"错误示范"的注解），不剥注释会把注解当成真代码报假错。
    //    这个坑本项目已经踩过多次，见 tools/lib/srcscan.mjs。
    const src = read(rel)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    for (const m of src.matchAll(/import\(\s*'([^']+)'\s*\)/g)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;      // 只看本仓库相对路径
      checked++;
      const target = resolveRel(rel, spec);
      if (!target || !fs.existsSync(path.join(ROOT, target))) {
        const hint = !spec.startsWith('../') && rel.includes('/views/')
          ? `  —— 这个文件在 views/ 子目录里，多半该写成 '../${spec.replace(/^\.\//, '')}'`
          : '';
        bad.push(`${rel} 里的 import('${spec}') → 解析成 ${target}（不存在）${hint}`);
      }
    }
  }
  ok(bad.length === 0, `${allJs.length} 个文件里的 ${checked} 处动态 import 都指向真实文件`,
    bad.join(' ｜ '));
  // 反向断言：确认真的扫到了动态 import，不是空跑
  ok(checked > 0, '确实扫到了动态 import（这条断言不是空跑）', `${checked} 处`);

  // 专门盯住出过事的那一处，防止有人"修回去"
  const jp = read('app/js/views/jpreader.js');
  ok(/await\s+import\('\.\.\/drawer\.js'\)/.test(jp),
    "jpreader.js 用的是 '../drawer.js'（曾经写成 './drawer.js'，导致点词必炸）");
  ok(fs.existsSync(path.join(ROOT, 'app/js/drawer.js')),
    'app/js/drawer.js 确实在那个位置（上面那条路径才对）');
}

console.log('\n' + '='.repeat(74));
console.log(fail === 0 ? ` 全部通过（${passed} 项）` : ` ${fail} 项未通过，${passed} 项通过`);
console.log('='.repeat(74));
process.exit(fail === 0 ? 0 : 1);
