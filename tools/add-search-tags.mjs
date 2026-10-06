/**
 * 给条目批量补**用户可能打出来的**检索词（只改 tools/内容-*.mjs）。
 *
 * ⚠️ 为什么必须有这类工具（这条规矩踩了四次）：
 *   「可发现性」和「内容覆盖」是两个独立的轴。内容写对了，
 *   用户搜「为什么 因为」还是搜不到「なぜなら」—— 因为标题里没有"为什么"。
 *   四次栽在同一件事：四大假定 / 假名-vs-汉字 / 「は が 区别」的空格 / 这一批。
 *
 * ────────────────────────────────────────────────────────────────────
 * ⚠️⚠️ 这个脚本我写坏过一次，两个原因都记在这里，别再犯
 * ────────────────────────────────────────────────────────────────────
 * 第一版把两个内容源文件**整个削成了 4 行**，原因是：
 *
 *   ① **路径按 CWD 解析**：脚本用 'tools' 相对路径，
 *      而我是从工作区根目录跑的（CWD 不是 jp-learn），
 *      readdirSync('tools') 找不到东西，后面的 indexOf 全返回 -1。
 *   ② **indexOf 返回 -1 时没拦**：`s.slice(tagsStart, tagsEnd)` 在
 *      两者都是 -1 时会变成 `s.slice(-1, -1)`（空串），
 *      然后把结果拼回开头 —— 等于**只留下最后一行**。
 *      这是本项目第二次被"indexOf/slice 静默产错"毁掉文件
 *      （上一次是 内容-N5基础.mjs）。
 *
 * 所以现在的做法：
 *   - 用 fileURLToPath 定位项目根，**不依赖 CWD**；
 *   - 找不到任何锚点时**直接报错退出**，绝不带 -1 继续算；
 *   - 改完**立即用 node --input-type=module 语法校验**，坏了就自动回滚。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// ① 项目根：从本文件位置推，**不用 CWD**（CWD 是工作区根，不是 jp-learn）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = path.join(ROOT, 'tools');

// 要补的检索词：id -> 词表
const ADD = {};

const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!Object.keys(ADD).length) {
  console.log('ADD 表是空的 —— 这一批的检索词已经手动写进内容文件了。');
  console.log('要再补的话：把 id -> [词...] 填进本文件的 ADD，然后 node tools/add-search-tags.mjs');
  process.exit(0);
}

const files = fs.readdirSync(TOOLS).filter((f) => f.startsWith('内容-') && f.endsWith('.mjs') && (!only.length || only.includes(f)));
const report = [];
let changed = 0;

for (const f of files) {
  const p = path.join(TOOLS, f);
  const original = fs.readFileSync(p, 'utf8');
  let s = original;

  for (const [id, words] of Object.entries(ADD)) {
    const idx = s.indexOf("id: '" + id + "'");
    if (idx < 0) continue;                       // 这个 id 不在本文件里，正常

    const tagsStart = s.indexOf('tags: [', idx);
    const tagsEnd = s.indexOf(']', tagsStart < 0 ? idx : tagsStart);
    // ② 锚点必须先验证再切片 —— 这是上一版把文件削没的原因
    if (tagsStart < 0 || tagsEnd < tagsStart) {
      console.error('  ✗ ' + id + ' 在本文件里找不到完整的 tags 数组，中止（不猜）');
      process.exit(1);
    }
    const cur = s.slice(tagsStart, tagsEnd);
    const missing = words.filter((w) => !cur.includes("'" + w + "'"));
    if (!missing.length) continue;
    const add = missing.map((w) => "'" + w + "'").join(', ');
    s = cur + ', ' + add + s.slice(tagsEnd);
    report.push('  ' + id + '  + ' + missing.join(' '));
  }

  if (s === original) continue;

  // ③ 改完立刻语法校验，坏了就回滚
  fs.writeFileSync(p, s, 'utf8');
  try {
    execFileSync(process.execPath, ['--input-type=module', '--eval', 'await import("' + p.replace(/\\/g, '/') + '")'], {
      stdio: 'pipe', timeout: 30000,
    });
    changed++;
  } catch (e) {
    fs.writeFileSync(p, original, 'utf8');
    console.error('  ✗ ' + f + ' 改完语法不通过，已回滚：' + String(e.message).slice(0, 120));
    process.exit(1);
  }
}

console.log(report.join('\n'));
console.log('改了 ' + changed + ' 个内容源文件（每个都做过语法校验）');
