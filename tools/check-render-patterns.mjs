/**
 * check-render-patterns.mjs —— 界面代码的**机械模式检查**（只读，不写文件）
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么要有这个脚本
 * ────────────────────────────────────────────────────────────────────
 * 用户报过一个问题：设置页的「主题」按钮显示成 **「浅色浅色」**。
 *
 * 原因是 `el(tag, attrs, children)` 这个自建的建节点函数里，
 * **两个参数在做同一件事**：
 *   · `attrs.text`   → 设置 `textContent`（ui.js:21）
 *   · `children`     → **追加**文本节点（ui.js:32）
 *
 * 所以 `el('button', { text: '浅色' }, '浅色')` 会渲染出两份"浅色"。
 *
 * 这个 bug 的特点：**代码读起来完全正常**。"text" 和第三个参数写的是同一个字符串，
 * 写的人多半以为"互为备份"——实际是叠加。人眼审查基本抓不到，
 * 只能靠机械扫描。这就是本脚本存在的理由。
 *
 * ────────────────────────────────────────────────────────────────────
 * ★ 关于本脚本的第一版（一个值得记的教训）
 * ────────────────────────────────────────────────────────────────────
 * 第一版用了一个跨行的贪婪正则 `/el\(...text:...\}\s*,\s*'...'/`，
 * 结果把**相邻两个 el() 调用**配成了一对，报出 28 处"可疑" —— **全是假阳性**。
 * 例如它把 `settings.js` 里 `text: '显示'` 和 100 行之后的 `'保存'` 配到了一起。
 *
 * 根因：**正则数不了括号。** 要取一个调用的"第三个参数"，
 * 必须真的做括号配对、跳过字符串里的括号，才能知道参数边界在哪。
 * 所以下面用 `topLevelArgs()` 手工扫描，而不是正则。
 *
 * 另一个细节：**注释里的示例会被扫到**。第一版修完之后，
 * 扫描仍然报出 1 处 —— 就是我自己写在注释里的那个错误示例。
 * 所以 `settings.js` 的注释里**故意不写完整调用形式**。
 *
 * 用法：node tools/check-render-patterns.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP = path.join(ROOT, 'app');

let pass = 0;
const fails = [];
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fails.push(label); console.log(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
};

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * 从 `(` 之后开始，取出这个调用的**顶层参数**（按逗号切，但跳过括号和字符串里）。
 * 这是本脚本能work的关键 —— 正则做不到这件事。
 */
function topLevelArgs(src, start) {
  const args = [];
  let depth = 0;
  let cur = '';
  let inStr = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      cur += c;
      if (c === '\\') { cur += src[++i] ?? ''; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; cur += c; continue; }
    if (c === ')' && depth === 0) { args.push(cur); return args; }
    if (c === ')' || c === ']' || c === '}') { depth--; cur += c; continue; }
    if (c === ',' && depth === 0) { args.push(cur); cur = ''; continue; }
    cur += c;
  }
  return args;
}

/**
 * 值是不是一个"纯字符串字面量"？是则返回内容，否则 null。
 *
 * ⚠️ 这个函数**只用来判断形式**，不能用来判断"两个参数是否相同"。
 *    第一版就栽在这里：真正的 bug 长这样 ——
 *        el('button', { text: THEME_LABELS[t], ... }, THEME_LABELS[t])
 *    `text` 的值**不是字符串字面量**，而是一个标识符表达式。
 *    于是"只比较字面量"的版本对真正要防的那个 bug **完全失明**。
 *    （这是本项目第 N 次同一个教训：断言盯着的东西和实际要防的东西不是一回事。）
 */
function stringLiteral(v) {
  const t = (v || '').trim();
  const m = /^(['"])([\s\S]*)\1$/.exec(t);
  if (!m) return null;
  if (m[2].includes('${')) return null;
  return m[2];
}

/**
 * ★ 判断"两段源码是不是同一个表达式"。
 * 去掉所有空白后比较 —— 这样 `THEME_LABELS[t]` 和 `THEME_LABELS[ t ]`
 * 会被判为同一个（它们运行时确实产生同一个值）。
 *
 * 为什么不直接比字符串：`'浅色'` 和 `'浅色'` 当然要判相同，
 * 但 `THEME_LABELS[t]` 和 `THEME_LABELS[t]` **也是重复渲染**，
 * 而且是更常见的形式（写的人抽了个常量表，两处都引用它）。
 */
function sameExpr(a, b) {
  const norm = (s) => (s || '').replace(/\s+/g, '');
  const na = norm(a);
  return na.length > 0 && na === norm(b);
}

/** 从 attrs 源码里取出 `text:` 后面那个表达式的源码片段（到顶层逗号为止） */
function extractTextValue(attrs, attrStart) {
  // attrStart 指向 attrs 里的 `text` 键
  const after = attrs.slice(attrStart);
  const colon = after.indexOf(':');
  if (colon < 0) return null;
  // 从冒号后开始，扫到顶层逗号或结尾
  let depth = 0;
  let inStr = null;
  let out = '';
  for (let i = colon + 1; i < after.length; i++) {
    const c = after[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += after[++i] ?? ''; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; out += c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; out += c; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; out += c; continue; }
    if (c === ',' && depth === 0) break;
    out += c;
  }
  return out.trim();
}

const files = walk(APP);

// ---------------------------------------------------------------------------
console.log('\n[1] 没有「text 属性 + 第三个参数是同一个字符串」的叠加');
// ---------------------------------------------------------------------------
const dupes = [];
let withThird = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const re = /\bel\(\s*/g;
  let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf('(', m.index);
    if (open < 0) continue;
    const args = topLevelArgs(src, open + 1);
    if (args.length < 3) continue;
    withThird++;
    // 在 attrs 里定位顶层 `text:` 键（不能用带捕获组的跨行正则去抓"值"，
    // 因为值可能是 `THEME_LABELS[t]` 这种含方括号的表达式）
    const attrs = args[1] || '';
    const keyM = /(^|[{,\s])text\s*:/.exec(attrs);
    if (!keyM) continue;
    const textVal = extractTextValue(attrs, keyM.index + keyM[1].length);
    if (textVal === null) continue;
    if (sameExpr(textVal, args[2])) {
      const line = src.slice(0, m.index).split('\n').length;
      dupes.push(`${path.relative(ROOT, f)}:${line}  text=${textVal.slice(0, 24)}`);
    }
  }
}
ok(dupes.length === 0, '没有重复渲染的文字（"浅色浅色"那类）',
  dupes.join('；') + '  ← 只保留 text，第三个参数不要再传同一个表达式');

// 反向：确认上面那个循环真的走到了东西
// （本项目反复踩过"正则没匹配到 = 静默空转"的坑，所以必须断言"确实扫到了"）
ok(files.length > 20, `确实扫到了源文件（${files.length} 个 js）`,
  `只扫到 ${files.length} 个，可能路径错了 —— 那样上面的检查就是空转`);
ok(withThird > 0, `确实存在"三个参数"的 el() 调用（${withThird} 处，说明参数解析在工作）`,
  '一处三个参数的调用都没解析到 —— 说明 topLevelArgs 或路径有问题，检查会变成永远通过');

// 反向："真的在比对"这件事怎么证明？
//
// ⚠️ 这里不能用 `withTextAndThird > 0` —— 修完那个 bug 之后，
//    全库**确实一处都没有**了，于是这条守卫会永远红。
//    （"一个永远红的检查比没有检查更糟"，本项目已经吃过一次这个亏。）
//
// 所以改成**自测解析器**：拿一段一定含重复的代码喂给它，
// 断言它能把那个重复找出来。这样既证明了"解析器在工作"，
// 又不会因为真实代码干净而误报。
const SELF_TEST = "el('button', { class: 'x', text: LABELS[t], onclick: () => {} }, LABELS[t])";
{
  const open = SELF_TEST.indexOf('(');
  const a = topLevelArgs(SELF_TEST, open + 1);
  const attrs = a[1] || '';
  const keyM = /(^|[{,\s])text\s*:/.exec(attrs);
  const tv = keyM ? extractTextValue(attrs, keyM.index + keyM[1].length) : null;
  const caught = a.length >= 3 && tv !== null && sameExpr(tv, a[2]);
  ok(caught, '★ 自测：解析器能识别出"重复表达式"这种写法（证明它真的在比对）',
    `自测样例没被识别：args=${a.length} text值=${JSON.stringify(tv)} 第三参数=${JSON.stringify(a[2])}`);
}

// 再自测一个"不该报"的：两个参数值不同，必须**不**被判为重复
{
  const s = "el('div', { text: '标题' }, el('span'))";
  const a = topLevelArgs(s, s.indexOf('(') + 1);
  const attrs = a[1] || '';
  const keyM = /(^|[{,\s])text\s*:/.exec(attrs);
  const tv = keyM ? extractTextValue(attrs, keyM.index + keyM[1].length) : null;
  ok(!(a.length >= 3 && tv !== null && sameExpr(tv, a[2])),
    '★ 自测：两个参数不同时**不会**误报');
}

// ---------------------------------------------------------------------------
console.log('\n[2] 顺带核对：el() 的两个"写文字"入口仍然只有那两个');
// ---------------------------------------------------------------------------
// 这条是为了让"为什么会有这个 bug"这件事在代码层面有据可查：
// 只要 ui.js 里 text→textContent 和 children→appendChild 这两条路都在，
// 就存在"两个参数做同一件事"的可能。哪天有人合并了这两条路，这条会提醒改本脚本。
const uiSrc = fs.readFileSync(path.join(APP, 'js', 'ui.js'), 'utf8');
ok(/k === 'text'\)\s*node\.textContent/.test(uiSrc), 'ui.js 里 attrs.text 仍然设置 textContent');
ok(/createTextNode/.test(uiSrc), 'ui.js 里 children 仍然会追加文本节点（所以叠加风险仍在）');

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
