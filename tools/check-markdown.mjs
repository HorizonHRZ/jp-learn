/** 扫描 app/ 下**用户能看到**的字符串里是否残留 Markdown 的 `**`。 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/** 递归收集文件 */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * 剥掉注释，只留下真正会执行的源码。
 * 不能直接全文搜索 —— 注释里写 `**` 是正常的（强调）。
 *
 * ⚠️ HTML 注释必须单独剥一次（2026-10 补的真洞）：
 *    这个脚本会扫 `app/` 下所有 `.js` **和 `.html`**，但原来只剥 JS 的两种注释。
 *    于是 `.html` 里的一句 `<!-- ... 不许出现 ** ... -->` 被当成字符串字面量，
 *    报出"这些 ** 会原样显示给用户"—— 而它明明在注释里，用户根本看不到。
 *    这正是 §41.5 记过的同一类错：**剥注释要用对语言，别拿一种反则套所有文件。**
 *    （那次是行注释里出现块注释开头把代码吃掉了；这次是 HTML 注释没人管。）
 */
function stripComments(src) {
  return String(src)
    // HTML 注释：<!-- ... -->（.html 载荷页的说明都写在这里）
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

/**
 * 找出**字符串字面量**里出现的 `**`。
 *
 * 判据：`**` 出现在 '...' / "..." / `...` 里面 → 它会原样显示给用户。
 * 这是"实现对了就一定长这样"的检查，不是宽泛的源码扫描。
 */
function markdownInStrings(src) {
  const noComments = stripComments(src);
  const hits = [];
  const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  let m;
  while ((m = re.exec(noComments)) !== null) {
    const body = m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]);
    if (body && body.includes('**')) {
      // 算出身所在的行号，便于定位
      const line = noComments.slice(0, m.index).split('\n').length;
      hits.push({ line, text: body.trim().slice(0, 110) });
    }
  }
  return hits;
}

let total = 0;
const files = walk(path.join(ROOT, 'app'));
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const hits = markdownInStrings(src);
  if (hits.length) {
    console.log('\n' + path.relative(ROOT, f));
    for (const h of hits) {
      total++;
      console.log(`  第 ${h.line} 行: ${JSON.stringify(h.text)}`);
    }
  }
}

console.log('\n' + '='.repeat(72));
console.log(total === 0
  ? ' ✓ 用户可见的字符串里没有残留的 Markdown **（全部干净）'
  : ` ✗ 发现 ${total} 处：这些 ** 会原样显示给用户`);
console.log('='.repeat(72));
process.exit(total === 0 ? 0 : 1);
