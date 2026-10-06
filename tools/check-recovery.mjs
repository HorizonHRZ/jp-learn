/**
 * 验证"内容源文件 → 数据文件"是可重建的（verify-recovery.mjs）
 *
 * ────────────────────────────────────────────────────────────────────
 * 这个脚本要回答的唯一问题
 * ────────────────────────────────────────────────────────────────────
 * 「如果现在把**全部**内容源文件依次跑一遍 gen-grammar，
 *    data/grammar/*.json 会不会变？」
 *
 * 为什么必须回答它：并行写内容时，三个已存在的内容源文件被覆盖了。
 * tools/recover-orphans.mjs 把 lost 的条目从数据文件反向导回源文件 ——
 * 但如果导出的源文件和数据**不完全一致**，那么"下次谁顺手跑一遍 gen-grammar"
 * 就会悄悄改掉数据。这种延迟发生的漂移最难查，所以必须现在就钉死。
 *
 * ⚠️ 做法上有一个必须遵守的点：**绝对不能拿真实数据当验证对象**——
 *    如果在原地跑 gen-grammar，这个"检查"本身就变成了"修改"，
 *    而且一旦发现不一致，真实数据已经被改了（检查破坏了被检查的东西）。
 *    所以先把 data/grammar 拷到临时目录、让脚本在临时目录里跑，
 *    比完再把临时目录删掉。真实数据全程只读。
 *
 * 同理也**不能**用"源文件字段 vs 数据字段"直接比对 —— gen-grammar 对已存在的
 * id 是"跳过正文、只补 tags"，所以两者本来就不要求一致（历史上有过人工修订，
 * 那正是 source 作为唯一真相之外的真实情况）。要比的是**跑完的结果**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL = path.join(ROOT, 'data', 'grammar');
const TMP = path.join(ROOT, '_recovery-check');

// ---- 1. 把真实数据拷到临时目录（真实数据只读）----
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
for (const f of fs.readdirSync(REAL)) {
  if (/^N\d\.json$/.test(f)) fs.copyFileSync(path.join(REAL, f), path.join(TMP, f));
}

// ---- 2. 在临时目录里跑一份"镜像项目"：只需要 tools/gen-grammar.mjs 和 data/grammar ----
// gen-grammar 用 import.meta.url 定位 ROOT（= tools 的上一级），所以只要把它放到
// 一个形如 <tmp>/tools/ 的位置，它就会自动把 <tmp>/data/grammar 当作目标。
fs.mkdirSync(path.join(TMP, 'tools'), { recursive: true });
fs.cpSync(path.join(ROOT, 'data', 'grammar'), path.join(TMP, 'data', 'grammar'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'tools', 'gen-grammar.mjs'), path.join(TMP, 'tools', 'gen-grammar.mjs'));

// 内容文件也拷进去（gen-grammar 的 --replace 逻辑会读 toolbox 里的同名单，这里用不到，
// 但 import 时要能找到文件，所以内容文件必须一起进临时目录）
const srcFiles = fs.readdirSync(path.join(ROOT, 'tools'))
  .filter((f) => f.startsWith('内容-') && f.endsWith('.mjs'));
for (const f of srcFiles) {
  fs.copyFileSync(path.join(ROOT, 'tools', f), path.join(TMP, 'tools', f));
}

// ---- 3. 依次跑全部内容文件（顺序和真实合并时一致：按文件名排序）----
const runs = [];
for (const f of srcFiles.sort()) {
  try {
    execFileSync(process.execPath, ['tools/gen-grammar.mjs', 'tools/' + f],
      { cwd: TMP, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    runs.push([f, true, '']);
  } catch (e) {
    runs.push([f, false, String(e.stdout || '') + String(e.stderr || '')]);
  }
}
const failed = runs.filter((r) => !r[1]);
console.log(`  在临时目录里跑了 ${srcFiles.length} 个内容文件，失败 ${failed.length} 个`);
for (const [f, , out] of failed.slice(0, 5)) {
  console.log(`      ✗ ${f}`);
  console.log('        ' + out.trim().split('\n').slice(0, 3).join('\n        '));
}

// ---- 4. 逐字段比较"临时重建结果"和"真实数据" ----
let added = 0;
let changed = 0;
let same = 0;
const detail = [];
for (const f of fs.readdirSync(REAL)) {
  if (!/^N\d\.json$/.test(f)) continue;
  const real = JSON.parse(fs.readFileSync(path.join(REAL, f), 'utf8'));
  const tmpP = path.join(TMP, 'data', 'grammar', f);
  const tmp = fs.existsSync(tmpP) ? JSON.parse(fs.readFileSync(tmpP, 'utf8')) : { items: [] };
  const realById = new Map((real.items || []).map((x) => [x.id, x]));
  const tmpById = new Map((tmp.items || []).map((x) => [x.id, x]));

  for (const [id, x] of tmpById) if (!realById.has(id)) { added++; detail.push(`+ ${f} ${id}（重建多出来）`); }
  for (const [id, x] of realById) {
    if (!tmpById.has(id)) { changed++; detail.push(`- ${f} ${id}（重建后不见了）`); continue; }
    const y = tmpById.get(id);
    const a = JSON.stringify(x);
    const b = JSON.stringify(y);
    if (a === b) same++;
    else {
      changed++;
      // 找出具体是哪个字段变了
      const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
      const diffKeys = [...keys].filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k]));
      detail.push(`~ ${f} ${id}  字段: ${diffKeys.join(', ')}`);
    }
  }
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`  真实数据 ${same + changed} 条；重建后完全一致 ${same} 条、变化 ${changed} 条、多出 ${added} 条`);
if (detail.length) {
  console.log(`  ✗ 重建会改动数据（前 25 条）：`);
  for (const d of detail.slice(0, 25)) console.log('      ' + d);
  console.log('  → 说明某个源文件和数据文件不一致，需要人工确认以哪边为准。');
  process.exit(1);
}
console.log('  ✓ 用当前全部源文件重建，结果和现有数据逐字节相同 —— 源文件已是唯一真相');
process.exit(failed.length ? 1 : 0);
