/**
 * 按 id 删条目，**数据文件和内容源文件一起删**。
 *
 * ⚠️ 为什么必须成对删：只删 data/*.json 的话，下次谁跑 gen-grammar，
 *   内容源文件里那条又会被加回来 —— **删了等于没删，而且不报错**。
 *   这是本项目"源文件与产物必须一致"规矩的又一次应用。
 *
 * 用法：node tools/drop-grammar.mjs <id> [<id> ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ids = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!ids.length) { console.error('用法：node tools/drop-grammar.mjs <id> [...]'); process.exit(1); }

const DIR = path.join(ROOT, 'data', 'grammar');
const TOOLS = path.join(ROOT, 'tools');
let totalData = 0; let totalSrc = 0;

// ── ① 数据文件 ──
for (const lv of ['N5', 'N4', 'N3', 'N2', 'N1']) {
  const p = path.join(DIR, lv + '.json');
  if (!fs.existsSync(p)) continue;
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  const before = doc.items.length;
  doc.items = doc.items.filter((x) => !ids.includes(x.id));
  const n = before - doc.items.length;
  if (n) {
    // ⚠️ 必须 null, 2 —— 曾经把 N5.json 写成单行紧凑 JSON
    fs.writeFileSync(p, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    console.log('  ' + lv + '.json 删除 ' + n + ' 条（' + before + ' → ' + doc.items.length + '）');
    totalData += n;
  }
}

// ── ② 内容源文件：按大括号配平删掉整个条目对象 ──
for (const f of fs.readdirSync(TOOLS).filter((z) => z.startsWith('内容-') && z.endsWith('.mjs'))) {
  const p = path.join(TOOLS, f);
  let s = fs.readFileSync(p, 'utf8');
  const original = s;
  let n = 0;
  for (const id of ids) {
    const at = s.indexOf("id: '" + id + "'");
    if (at < 0) continue;
    // 从 id 往前找到这个对象块的 '{'（就是包含 id 的那层的开头）
    let open = -1;
    for (let i = at; i >= 0; i--) { if (s[i] === '{') { open = i; break; } }
    if (open < 0) { console.error('  ✗ ' + f + ' 找不到 ' + id + ' 的对象开头，中止'); process.exit(1); }
    // 从 open 往后配平括号，找到配对的 '}'
    let depth = 0; let close = -1; let inStr = false; let q = '';
    for (let i = open; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (ch === '\\') { i++; continue; }
        if (ch === q) inStr = false;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = true; q = ch; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { close = i; break; } }
    }
    if (close < 0) { console.error('  ✗ ' + f + ' 的 ' + id + ' 括号不配平，中止（不猜）'); process.exit(1); }
    // 连同后面的逗号/空行一起删
    let end = close + 1;
    while (end < s.length && (s[end] === ',' || s[end] === '\n' || s[end] === '\r' || s[end] === ' ')) end++;
    s = s.slice(0, open) + s.slice(end);
    n++;
  }
  if (s !== original) {
    // ⚠️ 改完立即语法校验，坏了自动回滚（上一版脚本把文件削没的教训）
    fs.writeFileSync(p, s, 'utf8');
    try {
      const { execFileSync } = await import('node:child_process');
      const { pathToFileURL } = await import('node:url');
      // ⚠️ ESM 的 import() 里**相对路径不会被当成文件路径**，
      //    必须用绝对 file:// URL。用相对路径会得到
      //    "Cannot find package 'jp-learn'" —— 它把首段当包名了。
      const href = pathToFileURL(p).href;
      execFileSync(process.execPath, ['--input-type=module', '--eval',
        'const m = await import(' + JSON.stringify(href) + '); if (!m.default || !Array.isArray(m.default.items)) throw new Error("default.items 不是数组");'],
      { stdio: 'pipe', timeout: 30000 });
      console.log('  ' + f + ' 删除 ' + n + ' 条（语法校验通过）');
      totalSrc += n;
    } catch (e) {
      fs.writeFileSync(p, original, 'utf8');
      console.error('  ✗ ' + f + ' 改完语法不通过，已回滚：' + String(e.message).slice(0, 160));
      process.exit(1);
    }
  }
}

console.log('');
console.log('数据文件共删 ' + totalData + ' 条，内容源文件共删 ' + totalSrc + ' 条');
if (totalData !== totalSrc) console.log('⚠️ 两个数字不一致 —— 说明源文件和产物本来就不同步，请检查');
