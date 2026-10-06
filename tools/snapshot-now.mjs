/**
 * snapshot-now.mjs —— 改大功能**之前**留一份完整存档（用户要求：「万一改坏了还可以回档」）。
 *
 * ────────────────────────────────────────────────────────────────────
 * 和 data-cache/grammar-backup-* 的区别
 * ────────────────────────────────────────────────────────────────────
 * 那些是**语法合并工具**自动做的、只含 data/grammar + tools/ 的局部备份。
 * 这一份是**整个项目**的快照，专门用于"这次改动整体回滚"。
 *
 * 刻意**不备份**的东西（以及为什么）：
 *   · `runtime/`   —— OCR/Node 运行时，约 400MB，是可下载重建的，备份它没有意义
 *   · `data-cache/`—— 里面本来就是历次备份，备份的备份会指数膨胀
 *   · `.git`       —— 本项目没有 git
 *
 * ⚠️ 用户数据（背的单词、手改读音、笔记）**不在项目目录里** ——
 *    按项目的第二条硬约束，用户数据只存在**浏览器的 IndexedDB**。
 *    所以这份快照回滚的是**程序和数据文件**，碰不到用户数据。
 *    这也正是那条约束的价值：改坏了程序，用户的积累一点都不会丢。
 *
 * 用法：
 *   node tools/snapshot-now.mjs                  # 用 "before-<时间戳>" 当名字
 *   node tools/snapshot-now.mjs --name=xxx       # 自定义名字
 *   node tools/snapshot-now.mjs --list           # 列出已有存档
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = path.join(ROOT, 'data-cache');

/** 不备份的目录（名字 → 原因） */
const SKIP_DIRS = new Set(['runtime', 'data-cache', 'node_modules', '.git']);
/** 不备份的单文件 */
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);

function stamp() {
  // 本地时间，形如 2026-10-06T03-41-23（和语法备份的命名保持一致）
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

const args = process.argv.slice(2);
if (args.includes('--list')) {
  const list = fs.existsSync(CACHE)
    ? fs.readdirSync(CACHE, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith('snapshot-')).map((e) => e.name).sort().reverse()
    : [];
  console.log(`  已有整包存档 ${list.length} 份（新→旧）：`);
  for (const n of list) {
    const p = path.join(CACHE, n);
    let size = 0, files = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else { size += fs.statSync(f).size; files++; }
      }
    };
    try { walk(p); } catch { /* 读不了就跳过 */ }
    const readme = path.join(p, 'README.txt');
    const note = fs.existsSync(readme) ? (fs.readFileSync(readme, 'utf8').split('\n').find((l) => l.startsWith('说明：')) || '').replace('说明：', '').trim() : '';
    console.log(`    ${n}   ${files} 个文件 / ${(size / 1048576).toFixed(1)} MB${note ? '   —— ' + note : ''}`);
  }
  process.exit(0);
}

const nameArg = args.find((a) => a.startsWith('--name='));
const name = nameArg ? nameArg.slice('--name='.length) : `before-${stamp()}`;
const dest = path.join(CACHE, `snapshot-${name}`);

if (fs.existsSync(dest)) {
  console.error(`  ✗ ${dest} 已存在。换一个名字，或先删掉它。`);
  process.exit(1);
}
fs.mkdirSync(dest, { recursive: true });

let files = 0, bytes = 0;
const skipped = [];
function copyDir(src, dst, topLevel) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isSymbolicLink()) { skipped.push(`符号链接 ${e.name}`); continue; }
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) { skipped.push(`目录 ${path.relative(ROOT, path.join(src, e.name))}/`); continue; }
      copyDir(path.join(src, e.name), path.join(dst, e.name), false);
    } else if (e.isFile()) {
      if (topLevel && SKIP_FILES.has(e.name)) { skipped.push(`文件 ${e.name}`); continue; }
      fs.copyFileSync(path.join(src, e.name), path.join(dst, e.name));
      files++;
      bytes += fs.statSync(path.join(src, e.name)).size;
    }
  }
}
copyDir(ROOT, dest, true);

// 记下"这份存档是什么时候、在什么状态下做的"，以后回档才敢用
const readme = [
  `说明：改「一览表」+「用户改分词」之前留的整包存档`,
  `时间：${new Date().toISOString()}`,
  `项目根目录：${ROOT}`,
  `文件数：${files}`,
  `体积：${(bytes / 1048576).toFixed(1)} MB`,
  '',
  '回档方法（PowerShell，在项目根目录执行）：',
  `  # 1) 先确认要回档（把下面两行的 <项目根> 换成 ${ROOT}）`,
  `  $src = '${dest}'`,
  `  $dst = '${ROOT}'`,
  `  # 2) 只把程序与数据文件拷回去（不含 runtime/ 与 data-cache/，那两个没进存档）`,
  `  Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force`,
  `  # 3) 回档后重跑自检确认`,
  `  node tools/audit-phases.mjs`,
  '',
  '注意：',
  '  · 用户数据（背的单词/手改读音/笔记）只存在浏览器 IndexedDB，不在本存档里，',
  '    也**不会**被回档影响 —— 这是本项目第二条硬约束带来的好处。',
  '  · 本存档不含 runtime/（约 400MB 运行时，可用 node tools/get-ocr-runtime.mjs 重建）',
  '    和 data-cache/（历次备份，备份它们会指数膨胀）。',
  '',
  '未备份的项：',
  ...skipped.map((s) => `  · ${s}`),
].join('\n');
fs.writeFileSync(path.join(dest, 'README.txt'), readme, 'utf8');

console.log(`  ✓ 整包存档完成：data-cache/snapshot-${name}`);
console.log(`    ${files} 个文件 / ${(bytes / 1048576).toFixed(1)} MB`);
console.log(`    跳过 ${skipped.length} 项（runtime/、data-cache/ 等大件或可重建的东西）`);
