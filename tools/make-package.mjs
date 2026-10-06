// 打包 jp-learn 成一个"只含基本应用功能"的自包含文件夹。
//
// 用法：
//   node tools/make-package.mjs <输出目录>             # 完整版（含 OCR 运行时，约 500 MB）
//   node tools/make-package.mjs <输出目录> --no-ocr    # 轻量版（不含 OCR，约 115 MB）
//   node tools/make-package.mjs <输出目录> -Check      # 只列清单，不真拷
//
// 两条硬性要求（用户 2026-10 提出）：
//   ① **不含个人数据**：`config.local.json`（里面有 API 密钥）绝不拷。
//      用户数据本来就在浏览器 IndexedDB 里，不在项目目录 —— 所以拷文件天然带不走它。
//   ② **不含开发/自检的东西**：tools/ 只留 server.js 真正 import 的 4 个，
//      reports/、DOC/、data-cache/、app/__qa__/ 一律不进。
//
// ⚠️ 最容易搞错的一点：**`tools/` 不能整个删掉** ——
//    `server.js` 直接 import 了 `tools/tokenizer.js`、`tools/aiconf.js`，
//    还要 exec `tools/ocr-worker.py`。少了它们**服务起不来**。
//    所以这里是"白名单"，不是"整个目录拷过去"。
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const CHECK = argv.includes('-Check') || argv.includes('--check');
const NO_OCR = argv.includes('--no-ocr');
const destArg = argv.find((a) => !a.startsWith('-'));
if (!destArg) {
  console.error('用法：node tools/make-package.mjs <输出目录> [--no-ocr] [-Check]');
  process.exit(2);
}

const ROOT = path.resolve(import.meta.dirname, '..');
const DEST = path.resolve(process.cwd(), destArg);

// ── 1. 明确的白名单 ────────────────────────────────────────────────
// 分成"必须"和"可选"，好处是**清单本身就是文档**：以后要改包内容，
// 看这张表就知道"为什么这个东西在里面"。
const MUST_FILES = [
  'server.js',
  '启动.cmd',
  '.gitignore',
  // ⚠️ 这里**故意不放 config.local.json**：那里面有用户的 API 密钥。
  //    打包时会被"跳过清单"记下来，谁都能看到它被主动排除了。
  //
  // ⚠️ 这三个第一版漏了，是"打开包目录跟用户要的功能一个个对名字"才发现的 ——
  //    少了它们，收件人拿到的包**没有无窗口启动**（正是用户抱怨并要修的那件事），
  //    而且没人知道自己少了什么。教训：**清单要对着"用户要什么"核，不要对着
  //    "服务能不能跑起来"核** —— 后者只覆盖 server.js 的依赖。
  '静默启动.vbs',        // 无窗口启动（日常用）
  '创建桌面快捷方式.vbs',  // 可选：在桌面放一个图标，省得每次进文件夹找
  '停止服务.cmd',         // 窗口藏起来之后用它停服务
  '启动脚本-说明.md',      // 收件人看的中文说明；缺它出了错只能猜
  // ⚠️ 这份以前**没进包**，是个真缺口：整个程序的隐私承诺（"唯一会联网的功能
  //    是 AI，且默认关闭"）只写在使用说明里，而收件人拿到的包里没有它 ——
  //    也就是说**收到包的人无从知道程序会不会联网**，只能靠信任发件人。
  //    有人问"发给别人会不会有风险"时才发现。功能说明本来就该随包走。
  '使用说明.md',          // 怎么用 + 隐私承诺（唯一联网功能、默认关闭）
];
const MUST_DIRS = ['app', 'data'];
// server.js 直接 import / exec 的：
const MUST_TOOLS = [
  'tokenizer.js',        // server.js:34 —— 分词、读音、查词全靠它
  'aiconf.js',           // server.js:41 —— AI 配置与隐私说明的单一来源
  'ocr-worker.py',       // server.js:220 —— 拍照识别（OCR）的 Python 侧
  'get-node-runtime.mjs',// 启动.cmd 用它自愈："缺便携 Node 就自动补一份"
  'get-ocr-runtime.mjs', // 缺 OCR 时 app 会提示"跑这个脚本补上"，所以要带着
];
// 运行时可执行文件（不进就不自包含，但能靠上面的脚本自动补）
const RUNTIME_KEEP = ['node.exe', 'LICENSE', 'RUNTIME-INFO.json'];
const OCR_DIR = 'ocr';

// ── 2. 排除清单（打日志用，也防止以后误加回来）─────────────────────
const NEVER = [
  'config.local.json',   // ★ 个人密钥
  'reports',             // 审查报告产物（可再生）
  'DOC',                 // 开发过程文档
  'data-cache',          // 历次备份 + 上游原始数据（129 MB）
  'data/diag',           // 诊断输出
  'app/__qa__',          // 自检载荷页（服务端对它直接返回 403）
];

const copied = [];
const skipped = [];
const log = (...a) => console.log(...a);

function copyFile(rel, destRel = rel) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) { skipped.push([rel, '源文件不存在']); return; }
  const dst = path.join(DEST, destRel);
  if (!CHECK) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  copied.push([destRel, fs.statSync(src).size]);
}

function copyDir(rel, skip = []) {
  const srcRoot = path.join(ROOT, rel);
  if (!fs.existsSync(srcRoot)) { skipped.push([rel, '源目录不存在']); return; }
  /**
   * 递归拷一个目录。
   *
   * ⚠️ 第一版这里写错了，两个错叠在一起，**只有末尾那条"不许混进个人数据"的
   *    断言抓住了它**（否则会把 app/__qa__/ 打进包里发出去）：
   *      ① `copyFile(path.join(rel, relIn), …)` —— `relIn` 本来就已经是从 rel
   *         开始的相对路径，再 join 一次变成 `app/app/...`，多一层目录；
   *      ② skip 判断比对的是 `relIn`（此时是 `app/__qa__`），而 skip 名单里
   *         写的是 `app/__qa__` —— 本来能对上，但被 ① 的拼法搞混之后
   *         判断实际落到了错的字符串上。
   *    教训：**"排除"这件事必须有一条末尾断言兜底**，不能只信拷贝逻辑写对了。
   */
  const walk = (dir, out) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const relIn = out ? out + '/' + e.name : e.name;
      if (skip.some((s) => relIn === s || relIn.startsWith(s + '/'))) {
        skipped.push([relIn, '在排除清单里']);
        continue;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, relIn);
      else copyFile(relIn, relIn);   // relIn 已经是"从项目根算起"的路径
    }
  };
  walk(srcRoot, rel);
}

// ── 3. 执行 ────────────────────────────────────────────────────────
log(`输出目录：${DEST}`);
log(`模式：${NO_OCR ? '轻量版（不含 OCR）' : '完整版（含 OCR）'}${CHECK ? '  [只看清单，不拷文件]' : ''}`);
log('');

for (const f of MUST_FILES) copyFile(f);
for (const d of MUST_DIRS) {
  const skip = d === 'app' ? ['app/__qa__'] : ['data/diag'];
  copyDir(d, skip);
}
// tools：白名单，一个一个拷
for (const f of MUST_TOOLS) copyFile(path.join('tools', f), path.join('tools', f));

// runtime：只挑要的
for (const f of RUNTIME_KEEP) {
  const rel = path.join('runtime', f);
  if (fs.existsSync(path.join(ROOT, rel))) copyFile(rel, rel);
  else skipped.push([rel, '不存在']);
}
if (!NO_OCR) {
  copyDir(path.join('runtime', OCR_DIR));
} else {
  skipped.push([path.join('runtime', OCR_DIR), '--no-ocr：用轻量版时不带 OCR 运行时']);
}

// 记录被主动排除的东西（只对顶层几项，便于报告）
for (const n of NEVER) {
  if (fs.existsSync(path.join(ROOT, n))) skipped.push([n, '主动排除（见脚本里的 NEVER 清单）']);
}

// ── 4. 报告 ────────────────────────────────────────────────────────
const total = copied.reduce((a, [, s]) => a + s, 0);
log(`  将拷入 ${copied.length} 个文件，合计 ${(total / 1048576).toFixed(1)} MB`);
log('');
log('  分项：');
for (const [p, label] of [['app/', '应用界面'], ['data/', '内置数据'],
  ['tools/', '运行时脚本'], ['runtime/ocr', 'OCR 运行时'], ['runtime/node.exe', '便携 Node']]) {
  const hit = copied.filter(([r]) => r.split(path.sep).join('/').startsWith(p) || r.split(path.sep).join('/') === p);
  if (!hit.length) continue;
  const s = hit.reduce((a, [, n]) => a + n, 0);
  log(`    ${label.padEnd(12)} ${String(hit.length).padStart(5)} 文件  ${(s / 1048576).toFixed(1).padStart(7)} MB`);
}
log('');
log(`  排除 ${skipped.length} 项（前 12 条）：`);
for (const [p, why] of skipped.slice(0, 12)) log(`    ${p}  —— ${why}`);
if (skipped.length > 12) log(`    …… 还有 ${skipped.length - 12} 项`);

// 关键断言：个人数据一定不在里面
const leaked = copied.filter(([r]) => /config\.local|__qa__|reports[\\/]|DOC[\\/]|data-cache/.test(r));
if (leaked.length) {
  console.error('\n★ 打包清单里混进了不该带的东西：');
  for (const [r] of leaked) console.error('    ' + r);
  process.exit(1);
}
log('\n  ✓ 清单里没有 config.local.json / 自检载荷 / 报告 / 开发文档 / 备份');

if (!CHECK) {
  // 启动.cmd 里 `cd /d "%~dp0"` 之后直接用相对路径，所以拷过去就能用。
  log(`\n完成：${DEST}`);
  log('  在资源管理器里双击里面的「启动.cmd」即可。');
}
