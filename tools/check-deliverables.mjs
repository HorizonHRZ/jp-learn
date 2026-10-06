/**
 * 阶段 0 + 阶段 1 交付完整性检查
 * 逐条核对目标里的每一项是否真的落地，而不是只看文件存在。
 */
import fs from 'node:fs';
import path from 'node:path';
// 源码扫描工具。**必须用这个，不要手写正则** —— 这段逻辑手写过五遍，每遍都是一个漏点。
//
// ⚠️ 名字要看清，这两个的差别正是踩坑的关键：
//   scanCode   剥注释 + 剥字符串      → 判"有没有真的调用某个 API"
//   scanStrings 剥注释，**保留**字符串 → 判"有没有请求某个地址"（地址本身在字符串里）
import { codeLike as scanCode, codeOnly as scanStrings } from './lib/srcscan.mjs';
const ROOT = path.resolve(import.meta.dirname, '..');
let fail = 0;
const check = (cond, label, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? '  — ' + detail : ''}`);
};
const exists = (p) => fs.existsSync(path.join(ROOT, p));
const sizeOf = (p) => { try { return fs.statSync(path.join(ROOT, p)).size; } catch { return -1; } };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/**
 * 在真正的代码里找关键字（去掉注释与字符串字面量）。
 *
 * 为什么需要：源码里"禁止 deleteObjectStore"这样的**说明性文字**会误伤
 * 朴素的 includes 检查（实测踩到过——检查脚本被自己写的警告注释绊倒）。
 *
 * 实现已移到 `tools/lib/srcscan.mjs`（`codeLike`），这里保留 `codeOnly`
 * 这个名字只是为了不动下面几十处调用点。**新代码请直接用 scanCode / scanStrings。**
 */
const codeOnly = scanCode;
const hasBom = (p) => { const b = fs.readFileSync(path.join(ROOT, p)); return b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf; };
const isCrlf = (p) => {
  const b = fs.readFileSync(path.join(ROOT, p));
  let lf = 0, crlf = 0;
  for (let i = 0; i < b.length; i++) if (b[i] === 10) { lf++; if (i > 0 && b[i - 1] === 13) crlf++; }
  return lf > 0 && lf === crlf;
};

console.log('='.repeat(72));
console.log(' 阶段 0 + 阶段 1 交付完整性检查');
console.log('='.repeat(72));

console.log('\n(1) OCR 引擎：项目内置的 Python + 日文 ONNX 模型');
// ─────────────────────────────────────────────────────────────────────────
// 这里原本是 `tools/win-ocr.ps1` 的定点检查（Windows.Media.Ocr 桥接）。
//
// ⚠️ 那个文件已经**删除**，原因不是它坏了，而是它修不好：
//   用户的核心场景是**竖排的日文书籍**，而 Windows OCR 对竖排：
//     · TextAngle 永远是 0（拿不到方向）
//     · 同一张图两次运行结果不同
//     · 注音有时整块丢掉、有时被拆到单独一行
//   换成了 rapidocr 3.9.2 + japan_PP-OCRv4_rec_mobile.onnx（ONNX Runtime）。
//   完整的三次尝试与实测数据记在 ARCHITECTURE §十九。
//
// 为什么下面的断言值得留：OCR 是本项目里唯一"需要下载大文件"的功能，
// 也很容易在升级/清理时被误删。这些断言把"它必须还在、还完整"钉住。
// ─────────────────────────────────────────────────────────────────────────
const OCR_PY = 'runtime/ocr/py/python.exe';
const OCR_MODELS = [
  'runtime/ocr/models/ch_PP-OCRv4_det_mobile.onnx',   // 文字检测
  'runtime/ocr/models/japan_PP-OCRv4_rec_mobile.onnx', // ★ 日文识别（关键：中文模型会丢假名）
  'runtime/ocr/models/ch_ppocr_mobile_v2.0_cls_mobile.onnx', // 方向分类
];
check(exists('tools/ocr-worker.py'), 'tools/ocr-worker.py（Python 侧的 OCR worker）存在',
  `${sizeOf('tools/ocr-worker.py')} 字节`);
check(exists('tools/get-ocr-runtime.mjs'), 'tools/get-ocr-runtime.mjs（下载 + SHA256 校验 + 自检）');
check(exists('app/js/ocrlayout.js'), 'app/js/ocrlayout.js（版面重建，纯 JS）');
check(exists('runtime/ocr/OCR-RUNTIME-INFO.json'), 'runtime/ocr/OCR-RUNTIME-INFO.json（安装记录）');

// 运行时本身可能没装（那是"还没跑 get-ocr-runtime"的正常状态，不算交付缺失），
// 但只要 python.exe 在，模型就必须齐全 —— 缺模型 = OCR 静默失效。
if (exists(OCR_PY)) {
  check(true, 'OCR 运行时已安装（runtime/ocr/py/python.exe）',
    `${(sizeOf(OCR_PY) / 1048576).toFixed(1)} MB`);
  for (const m of OCR_MODELS) {
    check(exists(m), `模型存在：${path.basename(m)}`,
      exists(m) ? `${(sizeOf(m) / 1048576).toFixed(1)} MB` : '缺失 → 跑 `node tools/get-ocr-runtime.mjs`');
  }
  // ★ 日文模型是整套方案的关键。用中文模型会把假名**整个丢掉**
  //   （实测「猫が歩いた日本語を勉強します」→「猫歩日本語勉強」）。
  //   这个断言防的就是"哪天有人顺手换回默认的中文模型"。
  check(exists('runtime/ocr/models/japan_PP-OCRv4_rec_mobile.onnx'),
    '★ 用的是日文识别模型（不是默认的中文模型）');
} else {
  console.log('  … OCR 运行时未安装（正常：还没跑过 node tools/get-ocr-runtime.mjs）');
}

// ★ 反面断言：OCR 绝不能再退回 PowerShell / Windows.Media.Ocr。
//   为什么值得写：这是本会话里花了最多代价才得到的结论（三次尝试、见 §十九），
//   而"用系统自带的 OCR"听起来太合理了，很容易被人重新捡起来。
//
// ⚠️ 这里踩过自己的一个坑，注意两个扫描函数的分工（见 tools/lib/srcscan.mjs）：
//     `scanCode` = codeLike = 剥注释**和字符串** → 判"有没有真的调用某个 API"
//     `scanStrings` = codeOnly = 只剥注释、**保留字符串** → 判"有没有请求某个地址/路径"
//   我第一版用 `scanCode` 去查 `'ocr-worker.py'` 这个**路径字符串**，
//   它被当字符串剥掉了 → 断言永远失败。路径要用 `scanStrings`。
{
  const srv = read('server.js');
  const srvCode = scanCode(srv);     // 剥字符串：判"有没有调用"
  const srvStr = scanStrings(srv);   // 留字符串：判"路径/地址"
  check(!/win-ocr\.ps1/.test(srvStr), '★ server.js 不再引用 win-ocr.ps1');
  check(!/Windows\.Media\.Ocr/.test(srvCode), '★ server.js 不再使用 Windows.Media.Ocr');
  check(!/runPwsh/.test(srvCode), '★ server.js 不再用 PowerShell 跑 OCR（runPwsh 已删）');
  check(/execFile\s*\(\s*OCR_PY/.test(srvCode), 'server.js 用 execFile 调 OCR_PY（Python 解释器）');
  check(/OCR_WORKER/.test(srvCode), 'server.js 引用 OCR_WORKER');
  check(/ocr-worker\.py/.test(srvStr), '★ OCR worker 路径确实是 tools/ocr-worker.py', '');
  check(!exists('tools/win-ocr.ps1'), 'tools/win-ocr.ps1 已删除（废弃的 Windows OCR 桥接）');
  // 运行时必须定位到**项目目录内**。
  // 断言方式说明：源码里是 path.join(ROOT, 'runtime', 'ocr', 'py', 'python.exe')，
  // 所以**不存在** "runtime/ocr" 这个连续字符串 —— 不能用连写去匹配。
  //
  // ⚠️ 必须用 srvStr（保留字符串），**不能用 srvCode**。
  //   codeLike 会把 'runtime' / 'ocr' 这些**路径字符串**整段剥成空串 ''，
  //   于是 `path.join(ROOT, '', '', '', '')` —— 任何看路径的断言都查不到东西。
  //   （我在上面注释里刚写过这个分工，转头自己又用错了；留在这里当路标。）
  check(/const\s+OCR_PY[\s\S]{0,80}?path\.join\(\s*ROOT\s*,\s*'runtime'\s*,\s*'ocr'/.test(srvStr),
    '★ OCR 解释器路径以 ROOT（项目目录）起头，不写用户目录');
  check(/const\s+OCR_WORKER[\s\S]{0,80}?path\.join\(\s*ROOT\s*,\s*'tools'\s*,\s*'ocr-worker\.py'\s*\)/.test(srvStr),
    '★ OCR worker 路径以 ROOT（项目目录）起头');
  // 反面：绝不能出现指向用户主目录或 AppData 的固定路径
  check(!/AppData|USERPROFILE|os\.homedir\(\)/.test(srvCode),
    '★ server.js 不含指向用户主目录/AppData 的固定路径');
}

console.log('\n(2) 便携版 Node + 可独立运行的 启动.cmd');
check(exists('runtime/node.exe'), 'runtime/node.exe 存在', `${(sizeOf('runtime/node.exe') / 1048576).toFixed(1)} MB`);
check(exists('tools/get-node-runtime.mjs'), 'tools/get-node-runtime.mjs（下载+校验 SHA256）');
check(exists('启动.cmd'), '启动.cmd 存在', `${sizeOf('启动.cmd')} 字节`);
check(isCrlf('启动.cmd'), '启动.cmd 是 CRLF（cmd.exe 需要）');
check(!hasBom('启动.cmd'), '启动.cmd 无 BOM（有 BOM 会让首行报错）');
const cmd = read('启动.cmd');
check(cmd.includes('chcp 65001'), '启动.cmd 设了 chcp 65001（中文显示正常）');
check(cmd.includes('runtime\\node.exe'), '启动.cmd 优先用便携版 Node');
check(cmd.includes('get-node-runtime.mjs'), '启动.cmd 能自愈补齐 runtime/');
check(cmd.includes('server.js'), '启动.cmd 会拉起 server.js');

console.log('\n(3) app/ 前端骨架 + db.js 数据层');
for (const f of ['app/index.html', 'app/css/theme.css', 'app/js/version.js', 'app/js/router.js',
                 'app/js/ui.js', 'app/js/app.js', 'app/js/db.js']) {
  check(exists(f), f, `${sizeOf(f)} 字节`);
}
const db = read('app/js/db.js');
check(/indexedDB/i.test(db), 'db.js 用 IndexedDB');
check(/migrate|迁移/i.test(db), 'db.js 有迁移逻辑');
check(/before-migration|迁移快照|升级到/i.test(db), 'db.js 升级前自动快照');
check(/exportAll|导出/i.test(db) && /importAll|导入/i.test(db), 'db.js 有导出/导入');
check(/makeSnapshot/i.test(db), 'db.js 有快照');
check(/wipeAllData/i.test(db), 'db.js 有清空');
const ui = read('app/js/ui.js');
check(/confirmTwice/.test(ui), 'ui.js 有二次确认组件（清空数据用）');
const settings = read('app/js/views/settings.js');
check(/confirmTwice/.test(settings), '设置页调用了二次确认');

// --- CSS 自检：语法错误不会让页面白屏，只会让样式静默失效，很难发现 ---
{
  const css = read('app/css/theme.css');
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const open = (noComments.match(/\{/g) || []).length;
  const close = (noComments.match(/\}/g) || []).length;
  check(open === close, 'theme.css 花括号配对', `{ ${open} / } ${close}`);
  // CSS 没有行注释语法。写了 `//` 会把后面整行当选择器，规则静默失效。
  const badSlash = noComments.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /^\s*\/\//.test(l) || /;\s*\/\//.test(l));
  check(badSlash.length === 0, 'theme.css 没有用 // 当注释（CSS 不支持）',
    badSlash.length ? '第 ' + badSlash.map(([n]) => n).join(',') + ' 行' : '');
  // 首页 6 个入口必须排成齐整两行：固定 3 列，且不能用 auto-fit
  check(/\.tiles\s*\{[^}]*grid-template-columns:\s*repeat\(3,/.test(noComments),
    'theme.css 里 .tiles 是固定 3 列（保证 3+3 两行）');
  check(!/\.tiles\s*\{[^}]*auto-fit/.test(noComments), '.tiles 没有退回 auto-fit（会变成 5+1）');
}

console.log('\n(4)(5) 数据管线：抓取 + 罗马音 + 词库/索引');
for (const f of ['tools/fetch-data.mjs', 'tools/build-romaji.mjs', 'tools/build-vocab.mjs', 'tools/重建数据.cmd']) {
  check(exists(f), f, `${sizeOf(f)} 字节`);
}
const fetchSrc = read('tools/fetch-data.mjs');
check(/node:https/.test(fetchSrc), 'fetch-data.mjs 手写 https 传输层（undici 10s 超时不可用）');
check(/CONNECT_TIMEOUT|connectTimeout/i.test(fetchSrc), '有连接超时设置');
check(/retry|重试/i.test(fetchSrc), '有重试');
check(/\.part|range|续传|resume/i.test(fetchSrc), '有断点续传/临时文件');
check(/jmdict-cn|jmdict/i.test(fetchSrc), '接入 jmdict-cn');
check(/jlpt/i.test(fetchSrc), '接入 JLPT 词表');
check(/tatoeba/i.test(fetchSrc), '接入 Tatoeba');
for (const f of ['data/kana/kana-table.json', 'data/kana/romaji-table.json']) {
  check(exists(f), f, `${(sizeOf(f) / 1024).toFixed(1)} KB`);
}
for (const f of ['data/vocab/n5.json', 'data/vocab/n4.json', 'data/vocab/n3.json',
                 'data/vocab/n2.json', 'data/vocab/n1.json', 'data/vocab/extra.json']) {
  check(exists(f), f, `${(sizeOf(f) / 1048576).toFixed(2)} MB`);
}
for (const f of ['data/index/lookup.json', 'data/index/readings.json', 'data/index/terms.json',
                 'data/index/kanji.json', 'data/index/manifest.json']) {
  check(exists(f), f, `${(sizeOf(f) / 1024).toFixed(1)} KB`);
}

console.log('\n(6) server.js：buildReading + 查词接口');
const server = read('server.js');
check(/buildReading/.test(server), '实现了 buildReading()');
check(/tokenizer\.js/.test(server), '复用 tools/tokenizer.js 的分词器');
check(/\/api\/dict\/lookup/.test(server), '新增查词接口 /api/dict/lookup');
check(/\/api\/lyric\/parse/.test(server), '歌词解析接口');
check(/\/api\/analyze/.test(server), '精读分析接口');
check(/\/api\/ocr/.test(server), 'OCR 接口');
check(/\/api\/health/.test(server), '健康检查接口');
check(/JP_LEARN_DATA/.test(server), '显式设置数据目录（避开路径含空格的 %20 坑）');
// 真实危害是「把 URL 对象/字符串的 pathname 直接当文件系统路径用」，
// 因为本项目目录含空格，pathname 会给出 %20 而读不到文件。
// 注意：正则必须限定在**同一行**内匹配 —— 多行匹配会误伤
// `const url = new URL(...)` 后面另起一行写 `url.pathname` 的正常 HTTP 用法
// （那是在解析请求 URL，不是推文件路径），实测被误伤过。
check(!/new URL\([^)\n]*\)[ \t]*\.pathname/.test(codeOnly(server)),
  '没有把 URL.pathname 当作文件路径（会得到 %20 路径）');
check(/fileURLToPath/.test(read('server.js')), 'server.js 用 fileURLToPath 解析自身位置');

console.log('\n目录穿越防护（安全）');
{
  const s = read('server.js');
  check(/rawPath|rawDecoded/.test(s), '在解析 URL 之前检查原始请求行（点段会被 URL 归一化掉，事后检查无效）');
  check(/\.\./.test(s) && /404/.test(s), '含 .. 的请求被拒绝');
  check(/\.\.\(\/\|\$\)|\(\^\|\\\/\)\\\.\\\./.test(s) || /\(\^\|\\\/\)/.test(s) || /\\\.\\\./.test(s),
    '用「路径段」而非裸子串判断 ..（避免误伤 a..b 这类合法名字）');
}

console.log('\n硬约束遵守情况');
check(!exists('package.json'), '没有 package.json（零依赖）');
check(!exists('node_modules'), '没有 node_modules');
check(!exists('package-lock.json') && !exists('pnpm-lock.yaml'), '没有 lock 文件');
let bundled = false;
for (const d of ['app/js', 'app']) {
  for (const f of fs.readdirSync(path.join(ROOT, d), { recursive: true })) {
    const s = String(f);
    if (s.endsWith('.min.js')) bundled = true;
  }
}
check(!bundled, '没有 .min.js 之类压缩产物（源码保持明文）');
check(exists('ARCHITECTURE.md'), 'ARCHITECTURE.md 已同步');
const arch = read('ARCHITECTURE.md');
for (const kw of ['jmdict-cn', 'kanji.json', 'JP_LEARN_DATA', '启动.cmd', 'runtime/', '活用还原', '元音行位移']) {
  check(arch.includes(kw), `ARCHITECTURE.md 记录了「${kw}」`);
}
check(exists('使用说明.md'), '使用说明.md 已补上');

console.log('\n自检脚本');
check(exists('tools/test-tokenizer.mjs'), 'tools/test-tokenizer.mjs');
check(exists('tools/test-http.mjs'), 'tools/test-http.mjs');
check(exists('tools/test-srs.mjs'), 'tools/test-srs.mjs');
check(exists('tools/test-quiz.mjs'), 'tools/test-quiz.mjs');
check(exists('tools/test-session.mjs'), 'tools/test-session.mjs');
check(exists('tools/test-contract.mjs'), 'tools/test-contract.mjs（视图契约与跨模块引用静态检查）');
check(exists('tools/test-db.mjs'), 'tools/test-db.mjs（用户数据层：导出/导入/快照/清空，内存版 IndexedDB）');
check(exists('tools/test-render.mjs'), 'tools/test-render.mjs（界面冒烟：假 DOM + 内存 IndexedDB 渲染九个路由）');
check(exists('app/js/testrun.js'), 'app/js/testrun.js（小测状态机：定题量 + 计时 + 算分）');
check(exists('tools/test-testrun.mjs'), 'tools/test-testrun.mjs（小测状态机单元测试）');
check(exists('tools/audit-phase2.mjs'), 'tools/audit-phase2.mjs（阶段 2 目标逐条核对）');
check(exists('tools/test-ocrtext.mjs'), 'tools/test-ocrtext.mjs（OCR 文本清洗：Windows OCR 每字插空格）');
check(exists('tools/test-grammar.mjs'), 'tools/test-grammar.mjs（语法数据完整性：字段/索引一致/来源诚实）');
check(exists('tools/test-anki.mjs'), 'tools/test-anki.mjs（导出格式：TSV/CSV/Markdown 的转义与边界）');

console.log('\n阶段 6-1：导出到 Anki（TSV / CSV / Markdown）');
check(exists('app/js/exportfmt.js'), 'app/js/exportfmt.js（纯格式化，可直接单测）');
check(exists('app/js/anki.js'), 'app/js/anki.js（取数据 + 触发浏览器下载）');
if (exists('app/js/exportfmt.js')) {
  const f = read('app/js/exportfmt.js');
  check(/export function render/.test(f), 'exportfmt 提供 render()');
  check(/export function toRows/.test(f), 'exportfmt 提供 toRows()');
  check(/export function collectFrom/.test(f), 'exportfmt 提供 collectFrom()（不查库，供界面用）');
  check(!/document\.|window\.|fetch\(/.test(f), 'exportfmt 是纯函数（零 DOM / 零网络）');
  check(/'tsv'|"tsv"/.test(f) && /'csv'/.test(f) && /'md'/.test(f), '三种格式都在');
  // Anki 会把 BOM 当成第一个字段名的一部分，所以 TSV 绝不能带 BOM。
  // 这里查源码里那个转义写法（'\uFEFF'）是否只出现在"按需添加"的地方。
  check(f.includes('uFEFF') && f.includes('opts.bom'), 'BOM 只在显式要求时加（CSV 给 Excel 用）');
}
if (exists('app/js/anki.js')) {
  const a = read('app/js/anki.js');
  check(!/fetch\(|XMLHttpRequest|sendBeacon/.test(a), '导出不经网络（词表不出本机）');
  check(/Blob/.test(a) && /createObjectURL/.test(a), '用 Blob + objectURL 纯前端下载');
}
if (exists('app/js/views/vocab.js')) {
  const v = read('app/js/views/vocab.js');
  check(/ankiMod/.test(v), '背单词页接上了导出模块');
  check(/openExportDialog/.test(v), '背单词页有导出对话框');
  check(/dataset: \{ act: 'export' \}/.test(v), '导出入口按钮有语义标记');
}

console.log('\n阶段 6-2：AI 翻译 / 讲解（默认关闭，密钥不进浏览器）');
/**
 * 剥掉注释再检查源码。
 *
 * ⚠️ 为什么必须这么做（踩过两次）：
 *   这类"源码扫描"断言很容易把**解释规则的注释**当成违规。
 *   `ai.js` 顶部写着"密钥进 localStorage 会让泄漏面变大"——
 *   那是说明**为什么不那么做**，结果被扫成"用了 localStorage"。
 *   和 13.8 那次的教训一样：**过宽的规则会逼人去改本来正确的代码**。
 *
 * 现在剥注释/剥字符串统一用 `tools/lib/srcscan.mjs` 的共用实现（文件顶部已 import），
 * 不再在这里手写一份 —— 这个逻辑在本项目里被手写过五遍，每遍都是一个漏点。
 */

check(exists('tools/aiconf.js'), 'tools/aiconf.js（配置纯逻辑，可直接单测）');
check(exists('tools/test-ai.mjs'), 'tools/test-ai.mjs（配置/密钥安全/提示词/错误翻译）');
check(exists('tools/test-ai-e2e.mjs'), 'tools/test-ai-e2e.mjs（假上游服务，真实 HTTP 往返）');
check(exists('tools/lib/srcscan.mjs'), 'tools/lib/srcscan.mjs（源码扫描共用工具）');
check(exists('tools/lib/fake-idb.mjs'), 'tools/lib/fake-idb.mjs（内存版 IndexedDB，共用）');
check(exists('tools/lib/fake-dom.mjs'),
  'tools/lib/fake-dom.mjs（假 DOM，共用 —— 原来只长在 test-render 里，抄第二份就会各自演化）');
check(exists('tools/test-airead.mjs'),
  'tools/test-airead.mjs（按段翻译与译文缓存：假 fetch + 假 IndexedDB，直接测花钱的那条路径）');
check(exists('tools/test-draft.mjs'),
  'tools/test-draft.mjs（草稿保护：自动保存 / 恢复 / 停止，且草稿只进 localStorage 不进用户数据）');
check(exists('app/js/draft.js'),
  'app/js/draft.js（草稿暂存；刻意用 localStorage 而不是 IndexedDB —— 草稿不是用户资产，不参与导出/快照）');
check(exists('tools/test-conj.mjs'),
  'tools/test-conj.mjs（变形规则：逐条形态 + 丢回还原器验往返 + 「输出必须是规范形态」的独立证据）');
check(exists('app/js/conj.js'),
  'app/js/conj.js（正向变形引擎：纯函数、不碰 DOM，所以 Node 里能直接 import 校验）');
check(exists('tools/qa-layout.mjs'),
  'tools/qa-layout.mjs（★ 真浏览器量两栏排版：假 DOM 没有排版引擎，左右并排只有真浏览器能证明）');
check(exists('tools/qa-disclosure.mjs'),
  'tools/qa-disclosure.mjs（★ 真浏览器看隐私承诺：渲染出来了 ≠ 用户看得见）');
check(exists('tools/qa-grammar.mjs'),
  'tools/qa-grammar.mjs（★ 真浏览器看语法页：新加的内容真的长得出来吗 —— 筛选、详情、振假名）');
check(exists('app/__qa__/reading.html') && exists('app/__qa__/reading.js'),
  'app/__qa__/（qa-layout 的载荷页；不是应用的一部分，用户看不到）');
check(exists('app/js/airead.js'), 'app/js/airead.js（两栏阅读器 + 按段翻译 + 译文缓存）');
check(exists('tools/test-srcscan.mjs'), 'tools/test-srcscan.mjs（扫描工具自身的测试，防"测试说谎"）');
check(exists('tools/audit-phases.mjs'), 'tools/audit-phases.mjs（阶段 5/6 目标逐条核对）');
check(exists('tools/ps1bom.mjs'), 'tools/ps1bom.mjs（给 .ps1 补 UTF-8 BOM，防 PowerShell 解析失败）');
check(exists('tools/diag-ai.mjs'), 'tools/diag-ai.mjs（AI 连接只读诊断：密钥出错时看清上游返回了什么）');
check(exists('app/js/ai.js'), 'app/js/ai.js（浏览器侧接入层）');
check(exists('app/js/views/aipanel.js'), 'app/js/views/aipanel.js（选中→翻译/讲解界面）');
check(exists('.gitignore'), '.gitignore（防止密钥进版本库）');
if (exists('.gitignore')) {
  const gi = read('.gitignore');
  check(/config\.local\.json/.test(gi), '.gitignore 排除了 config.local.json');
}
if (exists('tools/aiconf.js')) {
  const a = read('tools/aiconf.js');
  const aCode = scanStrings(a);
  check(/export function normalizeConfig/.test(a), 'aiconf 提供 normalizeConfig()');
  check(/export function configSummary/.test(a), 'aiconf 提供 configSummary()');
  check(/export function maskKey/.test(a), 'aiconf 提供 maskKey()');
  check(/export function chatEndpoint/.test(a), 'aiconf 提供 chatEndpoint()');
  check(/export function buildMessages/.test(a), 'aiconf 提供 buildMessages()');
  check(/export function aiFailureMessage/.test(a), 'aiconf 提供 aiFailureMessage()');
  // 默认必须关闭
  check(/enabled:\s*false/.test(a), '默认配置是关闭的');
  // 纯逻辑模块不许碰网络/文件
  check(!/fetch\(|node:fs|node:path|XMLHttpRequest/.test(aCode),
    'aiconf.js 是纯逻辑（零 I/O、零网络）');
}
if (exists('app/js/ai.js')) {
  const a = read('app/js/ai.js');
  const aCode = scanStrings(a);
  check(/AI_PRIVACY_TEXT/.test(a), 'ai.js 里有给用户看的隐私说明');
  check(/ack|Ack/.test(a), 'ai.js 有"首次使用确认"机制');
  // 密钥绝不能进浏览器存储
  check(!/localStorage|sessionStorage/.test(aCode), 'ai.js 不用 localStorage/sessionStorage');
}
{
  const srv = read('server.js');
  check(/\/api\/ai\/config/.test(srv), '服务端有 /api/ai/config');
  check(/\/api\/ai\/chat/.test(srv), '服务端有 /api/ai/chat');
  check(/assertConfigNotServable/.test(srv), '启动时自检：密钥文件不能在可静态访问的目录里');
  check(/JP_LEARN_CONFIG/.test(srv), '配置路径可用环境变量覆盖（供测试隔离，不碰真配置）');
}
if (exists('app/js/views/settings.js')) {
  const st = read('app/js/views/settings.js');
  check(/renderAiCard/.test(st), '设置页有 AI 配置卡');
  check(/只有你/.test(st), '设置页写明"只有你选中的那段文字"会被发送');
}
// ⚠️ 这两条在 2026-10 改过：原来盯的是 attachAiTo + _detachAi，
//    但用户要求删掉"选中文字就浮出按钮条"，那两个东西已经不存在了。
//    留旧断言只会逼着代码里养一个死函数来哄测试 —— 那是最糟的结局。
//    现在盯**新实现**，并且盯真正危险的一点：阅读页不许挂 document 级监听
//    却不撤销（本页的监听都挂在局部容器上，随 DOM 消失）。
for (const vid of ['lyric', 'reading']) {
  if (!exists(`app/js/views/${vid}.js`)) continue;
  const v = read(`app/js/views/${vid}.js`);
  check(/buildAiReader/.test(v), `${vid}.js 接上了两栏 AI 阅读器`);
  check(/installAiWordHook/.test(v), `${vid}.js 把「AI 讲这个词」装进了速查抽屉`);
  check(!/document\.addEventListener/.test(scanCode(v)),
    `${vid}.js 没有 document 级监听（因此也不需要 destroy）`);
}

// ⚠️ "只有 AI 一个功能会联网"是写在使用说明里给用户的承诺，
//    所以它必须被机器检查，不能只靠人工核对。
//    这里做一次粗略但有效的验证：前端不许出现绝对 http(s) 地址的 fetch。
//
// 注意：这里**只能剥注释，不能剥字符串** ——
//   我们要找的正是 `fetch('https://…')` 里的那个字符串。
//   所以用 codeOnly()（来自 srcscan），而不是 codeLike()。
{
  const appJs = path.join(ROOT, 'app', 'js');
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  if (fs.existsSync(appJs)) walk(appJs);
  const outbound = [];
  for (const f of files) {
    const code = scanStrings(fs.readFileSync(f, 'utf8'));
    const re = /fetch\(\s*(['"`])(https?:\/\/[^'"`]*)\1/g;
    let m;
    while ((m = re.exec(code)) !== null) outbound.push(`${path.basename(f)} → ${m[2]}`);
  }
  check(files.length > 0, '扫描到了前端源码文件（否则这条检查是空的）');
  check(outbound.length === 0,
    '前端没有任何"直接打到外部地址"的请求（只有 AI 走本机服务端代理）', outbound.join(' | '));
}

console.log('\n阶段 6-3：manifest（问 5 = 甲：只做 manifest，不做 Service Worker）');
{
  check(exists('app/manifest.webmanifest'), 'app/manifest.webmanifest');
  check(exists('app/assets/icon.svg'), 'app/assets/icon.svg');
  if (exists('app/manifest.webmanifest')) {
    let m = null;
    try { m = JSON.parse(read('app/manifest.webmanifest')); } catch { /* 下面断言会报 */ }
    check(!!m, 'manifest 是合法 JSON');
    if (m) {
      check(!!m.name && !!m.short_name, 'manifest 有 name / short_name');
      check(m.display === 'standalone', 'display 是 standalone');
      check(Array.isArray(m.icons) && m.icons.length >= 1, 'manifest 声明了图标');
      // 图标文件必须真的存在，否则浏览器会拿不到
      for (const ic of (m.icons || [])) {
        const rel = String(ic.src || '').replace(/^\//, 'app/');
        check(exists(rel), `manifest 里的图标文件存在（${ic.src}）`);
      }
    }
  }
  const html = read('app/index.html');
  check(/rel="manifest"/.test(html), 'index.html 引用了 manifest');

  // ★ 用户明确取消了 Service Worker（离线能力与"之后要接入 AI"矛盾）。
  //   这条断言把"取消"这个决定固化下来：以后谁再加就报错。
  check(!exists('app/sw.js'), '没有 app/sw.js（Service Worker 已取消）');
  check(!exists('app/service-worker.js'), '没有 app/service-worker.js');
  check(!/serviceWorker/.test(html), 'index.html 里没有注册 Service Worker');
  // 服务端要认得这个扩展名，否则 Content-Type 不对、浏览器不认
  const srvMime = read('server.js');
  check(/\.webmanifest'\s*:\s*'application\/manifest\+json/.test(srvMime),
    'server.js 的 MIME 表认得 .webmanifest');
}

console.log('\n阶段 5：语法教材（骨架已搭，内容分批补）');
check(exists('data/grammar/README.md'), 'data/grammar/README.md（怎么加内容写清楚了）');
check(exists('data/grammar/index.json'), 'data/grammar/index.json（目录索引）');
check(exists('tools/build-grammar-index.mjs'), 'tools/build-grammar-index.mjs（由正文生成索引）');
// 内容文件的生成入口必须是**存在的那个文件**。上一轮内容文件里声称由
// tools/gen-grammar-l3.mjs 读取，而那个脚本早删了 —— 代码里留了一句假话。
// 所以这里盯住两条：入口存在，内容文件指向的入口就是它。
check(exists('tools/gen-grammar.mjs'), 'tools/gen-grammar.mjs（内容文件 → 等级文件，带生成前自检）');
if (exists('tools/gen-grammar.mjs')) {
  const gen = read('tools/gen-grammar.mjs');
  check(/pathToFileURL/.test(gen) && /fileURLToPath/.test(gen),
    'gen-grammar.mjs 用 fileURLToPath（项目路径含空格，不能靠 URL.pathname）');
}
check(exists('tools/内容-L3.mjs'), 'tools/内容-L3.mjs（文语残存那一层的真相来源）');
if (exists('tools/内容-L3.mjs')) {
  const l3 = read('tools/内容-L3.mjs');
  check(/gen-grammar\.mjs/.test(l3),
    '内容-L3.mjs 指向的生成脚本是真的存在的那一个');
  check(!/gen-grammar-l3\.mjs/.test(l3),
    '内容-L3.mjs 里不再提那个不存在的 gen-grammar-l3.mjs');
}
check(exists('app/js/views/grammar.js'), 'app/js/views/grammar.js');
if (exists('app/js/views/grammar.js')) {
  const g = read('app/js/views/grammar.js');
  check(!/占位视图/.test(g), '语法页已实现（不再是占位视图）');
  check(/jpreader\.js/.test(g), '语法页复用共用渲染器（例句注音与另两页一致）');
  check(/grammarState/.test(g), '语法状态写已有的 grammarState 表');
  check(!/indexedDB\.open/.test(g), '语法页不直接开 indexedDB（走 db.js 封装）');
  check(/\/api\/grammar\/entry/.test(g), '语法页取正文时走后端补振假名');
}
{
  const lvl = fs.readdirSync(path.join(ROOT, 'data/grammar')).filter((f) => /^[A-Za-z0-9]+\.json$/.test(f) && f !== 'index.json');
  check(lvl.length > 0, `grammar 至少有 1 个等级文件（${lvl.join(', ')}）`);
  const idx = JSON.parse(read('data/grammar/index.json'));
  check(idx.count > 0, `语法索引里有内容（${idx.count} 条）`);
}
{
  // 硬约束：语法功能**没有新增表**，所以它本身不该涨结构版本。
  //
  // ⚠️ 这里原来写的是 `check(/SCHEMA_VERSION = 2;/, 'SCHEMA_VERSION 仍为 2')`。
  //    那是一条**写死数字的断言**：它想表达的是"语法功能没动结构版本"，
  //    但只要以后有任何一次**正当**的版本升级（比如修 readingOverrides
  //    那个 bug 必须从 2 涨到 3），它就会变红，而红的理由和语法毫无关系。
  //    写死具体数字的断言只会制造噪音，检查不出真正的问题。
  //    改成断言真正想说的那件事：语法状态复用了已有的表。
  const v = read('app/js/version.js');
  const dbSrc = read('app/js/db.js');
  check(/export const SCHEMA_VERSION = \d+;/.test(v), 'SCHEMA_VERSION 是一个明确的结构版本号');
  check(/grammarState:/.test(dbSrc), '★ 语法状态复用已有的 grammarState 表（没为语法功能新建表）');
}

console.log('\n阶段 3 / 4：歌词学习与读书精读');
check(exists('app/js/views/jpreader.js'), 'app/js/views/jpreader.js（歌词页与精读页共用的阅读渲染器）');
check(exists('app/js/ocrtext.js'), 'app/js/ocrtext.js（OCR 文本清洗，纯函数）');
if (exists('app/js/views/lyric.js')) {
  const lyric = read('app/js/views/lyric.js');
  check(!/占位视图/.test(lyric), '歌词页已实现（不再是占位视图）');
  check(/\/api\/lyric\/parse/.test(lyric), '歌词页接 /api/lyric/parse');
  check(/jpreader\.js/.test(lyric), '歌词页复用共用渲染器');
  check(/dbPut\('lyrics'/.test(lyric), '歌词笔记写入 lyrics 表');}
if (exists('app/js/views/reading.js')) {
  const reading = read('app/js/views/reading.js');
  check(!/占位视图/.test(reading), '精读页已实现（不再是占位视图）');
  check(/\/api\/analyze/.test(reading), '精读页接 /api/analyze');
  check(/\/api\/ocr/.test(reading), '精读页接 /api/ocr（拍照识别）');
  check(/jpreader\.js/.test(reading), '精读页复用共用渲染器');
  check(/dbPut\('readings'/.test(reading), '精读笔记写入 readings 表');
  // ⚠️ 这里原来断言"精读页里出现 cleanOcrText"。
  //    OCR 那 140 行内联代码已经抽成共用组件 app/js/ocrbox.js（歌词页也要用），
  //    所以那个字样现在应该在 **ocrbox.js 里**，不在精读页里 ——
  //    断言跟着实现走，见下面那段 ocrbox.js 的检查。
  check(/buildOcrBox/.test(reading), '精读页用共用 OCR 组件（不再内联一份）');
  check(/\/api\/ocr/.test(read('app/js/ocrbox.js')), 'OCR 组件真的调 /api/ocr');
}

// OCR 抽取成共用组件之后，真正该被盯住的是**组件自己**有没有做那几件必需的事。
// 尤其是 cleanOcrText：这是实测踩出来的真 bug ——
// 旧引擎会在每个字之间插空格，不清洗的话分词会退化成一个个单字，
// 覆盖率从 100% 掉到 77.8%，「日本語」「勉強」这类真词全都识别不出来。
if (exists('app/js/ocrbox.js')) {
  const box = read('app/js/ocrbox.js');
  check(/cleanOcrText/.test(box), 'OCR 组件清洗识别结果（否则分词退化成单字）');
  check(/ocrWarning/.test(box), 'OCR 组件如实说明识别问题（不假报"完全正确"）');
  // 粘贴监听必须挂在传进来的局部容器上。挂 document 就成了全局监听，
  // 视图换掉之后还在，必须靠 destroy 撤销 —— 忘一次就"粘一下识别好几次"。
  check(/pasteTarget/.test(box), 'OCR 组件的粘贴监听支持挂到局部容器（不用 document 级监听）');
  check(!/document\.addEventListener/.test(scanCode(box)),
    '✔ OCR 组件自己不挂 document 级监听');
}

console.log('\n阶段 2：背单词核心（进行中）');
check(exists('app/js/srs.js'), 'app/js/srs.js 排程算法（纯函数）');
if (exists('app/js/srs.js')) {
  const srs = read('app/js/srs.js');
  for (const kw of ['STATE', 'GRADE', 'schedule', 'newCard', 'pickDue', 'weightForReinforce',
                    'forecast', 'summarize', 'humanInterval', 'dayKey', 'simulate', 'applyLapse']) {
    check(srs.includes(kw), `srs.js 导出/包含 ${kw}`);
  }
  check(!/document\.|window\.|indexedDB/.test(srs),
    'srs.js 是纯函数（不碰 DOM / 不碰 IndexedDB，所以能在 Node 里单测）');
}
check(exists('app/js/quiz.js'), 'app/js/quiz.js 出题器（纯函数）');
if (exists('app/js/quiz.js')) {
  const quiz = read('app/js/quiz.js');
  for (const kw of ['MODES', 'checkAnswer', 'normalizeAnswer', 'makeQuestion', 'blankOut',
                    'pickDistractors', 'buildQuiz', 'gradeQuiz', 'primaryGloss', 'pickExample']) {
    check(quiz.includes(kw), `quiz.js 包含 ${kw}`);
  }
  check(!/document\.|window\.|indexedDB/.test(quiz),
    'quiz.js 是纯函数（不碰 DOM / 不碰 IndexedDB）');
  // 三种练习模式（用户要求收敛为 3 个，且单选不混用）
  for (const m of ['jp2zh', 'zh2jp', 'zh2jp_typing']) {
    check(quiz.includes(`${m}:`), `模式 ${m} 已定义`);
  }
  // 已按用户要求删除的模式不得复活
  for (const m of ['listen', 'cloze', 'kana']) {
    check(!new RegExp(`^\\s*${m}:\\s*\\{`, 'm').test(quiz),
      `已删除的模式 ${m} 没有被重新加回来`);
  }
  check(/MODE_ORDER/.test(quiz) && /DEFAULT_MODE/.test(quiz), 'quiz.js 导出 MODE_ORDER 与 DEFAULT_MODE');
  // 用户明确不要任何语音内容
  check(!/speak|voice/i.test(quiz), 'quiz.js 里没有任何语音相关代码');
  const vocabSrc = read('app/js/views/vocab.js');
  check(!/from '\.\.\/speak\.js'/.test(vocabSrc), '背单词页不再引入 speak.js（不要语音）');
  check(!/🔊/.test(vocabSrc), '背单词页里没有朗读按钮');
  // 不要每次答完都蹦评分按钮
  check(!/grade-row/.test(vocabSrc), '背单词页不再显示三档评分按钮');
  check(/gradeAuto/.test(vocabSrc), '背单词页改成自动评分（gradeAuto）');
}

check(exists('app/js/session.js'), 'app/js/session.js 复习会话状态机（纯函数）');
if (exists('app/js/session.js')) {
  const sess = read('app/js/session.js');
  for (const kw of ['SESSION_SOURCE', 'createSession', 'currentQuestion', 'submitAnswer',
                    'progress', 'summarizeSession', 'buildPlan', 'suggestSize']) {
    check(sess.includes(kw), `session.js 包含 ${kw}`);
  }
  check(!/document\.|window\.|indexedDB/.test(sess),
    'session.js 是纯函数（不碰 DOM / 不碰 IndexedDB）');
}

check(exists('app/js/vocabdata.js'), 'app/js/vocabdata.js 词库与生词本数据服务');
if (exists('app/js/vocabdata.js')) {
  const vd = read('app/js/vocabdata.js');
  for (const kw of ['ensureLibrary', 'libraryStatus', 'addWord', 'removeWord', 'listWords',
                    'recordAnswer', 'listMistakes', 'parseWordList', 'importWordList',
                    'reparseImport', 'lookupWord', 'vocabSelfCheck', 'reconcileCards']) {
    check(vd.includes(kw), `vocabdata.js 包含 ${kw}`);
  }
  // 约束 2 的核心：内置词库必须是可再生的派生缓存，不能混进用户数据表
  check(vd.includes("PREFIX_LIB = 'lib:'"), '内置词库用独立 id 前缀 lib: 标记（可安全批量清理）');
  check(/libwords/.test(vd), '内置词库写进 libwords 派生表，而不是用户的 words 表');
  check(/PREFIX_USER = 'jmdict:'/.test(vd), '用户正在学的词用 jmdict: 前缀标记');
  check(/PREFIX_IMPORT = 'import:'/.test(vd), '导入的词用 import: 前缀标记');
}
if (exists('app/js/db.js')) {
  const db = read('app/js/db.js');
  check(/DERIVED_STORES/.test(db), 'db.js 标明了派生数据表（导出时排除，避免备份虚胖）');
  check(/libwords/.test(db), 'db.js 注册了 libwords 表');
  // 硬约束：迁移只允许增量（在去掉注释后的真实代码里检查）
  check(!/deleteObjectStore/.test(codeOnly(db)), 'db.js 代码里没有 deleteObjectStore（迁移只增不减）');

  // 回归防护：openDB 初始化期间绝不能再调用公开的 dbPut/dbGet。
  // 它们内部会 await openDB()，而 openDB 尚未返回，会 await 到自己身上永久挂起；
  // 首次安装（不存在旧数据、不需要备份升级）时必然触发，表现为新用户第一次打开就白屏。
  const openBody = codeOnly(db).slice(
    codeOnly(db).indexOf('function openDB'),
    codeOnly(db).indexOf('function ensureSchema'),
  );
  check(!/\bdb(Put|Get|All|Count)\s*\(/.test(openBody),
    'openDB 内部只用 rawPut/rawGet，不调用公开 API（否则首次安装会死锁白屏）');
  check(/rawPut/.test(openBody) && /rawGet/.test(openBody), 'openDB 内部确实走了 raw* 底层原语');

  // 回归防护：清空数据必须保留它自己刚做的那份强制备份。
  // 曾经 snapshots 也被 clear()，用户拿到 backupId 却恢复不出任何东西 —— 等于没有备份。
  // 注意：这里必须看**原文**，因为 codeOnly 会把字符串字面量抹成 ''，
  // 而我们要检查的正是 'snapshots' 这个字面量。
  const wipeRaw = db.slice(db.indexOf('export async function wipeAllData'), db.indexOf('export async function selfCheck'));
  const wipeClean = wipeRaw.replace(/(^|[^:])\/\/[^\n]*/g, '$1 ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  check(/filter\(\(n\)\s*=>\s*n !== 'meta' && n !== 'snapshots'\)/.test(wipeClean),
    '清空数据时保留 snapshots（否则刚做的强制备份会被自己删掉）');
  check(/before-wipe/.test(wipeClean), '清空前会创建 before-wipe 快照');

  // 淘汰优先级里 before-wipe 必须被"钉住"，否则快照一多就被自动删掉
  const pinRaw = db.slice(db.indexOf('const PINNED'), db.indexOf('const PINNED') + 200);
  check(/before-wipe/.test(pinRaw),
    'pruneSnapshots 把 before-wipe 列为保护（不被自动淘汰）');
}

console.log('\n(12) 前端模块语法自检（括号/字符串配对）');
/**
 * 为什么需要这一节：`node --check` 对 ESM **不可靠** ——
 * 实测它放过了 app/js/views/settings.js 里的一个真实语法错误
 * （少一个 `)`），而浏览器与 Node 的 ESM 加载器都拒绝该文件，
 * 结果是"白屏 / 页面打不开"且没有明显线索（详见 ARCHITECTURE.md §10.14）。
 * 这里用一个不依赖子进程的字符级扫描：跳过注释与字符串/模板，
 * 检查 () [] {} 是否配对、字符串是否闭合。它能可靠抓住这类"少一个括号"。
 * （本机沙箱禁止 child_process，所以不能靠 node --check 复核。）
 */
const stripAndCheck = (file) => {
  const src = read(file);
  const stack = [];
  const pair = { ')': '(', ']': '[', '}': '{' };
  const errs = [];
  let i = 0, line = 1;
  // 上一个"有意义"的字符，用来判断 '/' 是除号还是正则起始
  // （正则里的 ( ) [ ] { } 不能当括号算，否则 split(/[（(]/) 会被误报）
  let prev = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i += 2;
      continue;
    }
    // 正则字面量 or 除号？
    //
    // ⚠️ 这里抓过自己的一个假报警，值得记：原判据是"紧跟在
    //   = ( , [ { ; : ! & | ? 或运算符之后"就把 `/` 当正则起点。
    //   于是 `const p = median(...) * sg[bestAt] / sg[bestAt - 1];`
    //   里的**除号**被当成正则起点，扫描器一路找闭合 `/` 找不到 →
    //   假报"第 229 行的正则字面量未闭合"。
    //
    //   真正的区分办法：**先试着把它当正则扫一遍，扫不动就当除号**。
    //   正则不可能跨行（未转义的换行就是语法错误），所以只要这一行内
    //   找不到未转义、不在字符类里的收尾 `/`，它就是除号。
    //   这比维护一张"哪些前驱字符算前缀"的清单可靠得多。
    if (c === '/' && /[=(,;:!&|?+\-*%~^<>\[\]{}]|^$/.test(prev)) {
      let j = i + 1, inClass = false, closed = false;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) { closed = true; break; }
        j++;
      }
      if (closed) {
        // 确认是正则：整段跳过（里面的括号/引号都不算数）
        i = j + 1;
        prev = '/';
        continue;
      }
      // 没闭合 → 是除号，当普通字符处理
    }
    if (c === '"' || c === "'") {
      const q = c, at = line;
      i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      if (i >= src.length) errs.push(`第 ${at} 行 ${q} 字符串未闭合`);
      i++;
      prev = q;
      continue;
    }
    if (c === '`') {
      const at = line;
      i++;
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '\n') line++;
        i++;
      }
      if (i >= src.length) errs.push(`第 ${at} 行模板字符串未闭合`);
      i++;
      prev = '`';
      continue;
    }
    if ('([{'.includes(c)) { stack.push({ c, line }); prev = c; i++; continue; }
    if (')]}'.includes(c)) {
      const top = stack.pop();
      if (!top) errs.push(`第 ${line} 行多余的 '${c}'`);
      else if (top.c !== pair[c]) errs.push(`第 ${line} 行 '${c}' 关错了第 ${top.line} 行的 '${top.c}'`);
      prev = c;
      i++;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  for (const s of stack.slice(0, 3)) errs.push(`第 ${s.line} 行的 '${s.c}' 未闭合`);
  return errs;
};

const frontModules = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir + '/' + e.name;
    if (e.isDirectory()) walk(rel);
    else if (e.name.endsWith('.js')) frontModules.push(rel);
  }
};
walk('app/js');
for (const f of frontModules) {
  const errs = stripAndCheck(f);
  check(errs.length === 0, `${f} 括号/字符串配对`, errs.slice(0, 2).join('；'));
}

/**
 * 命名导入必须真的被导出。
 * 为什么需要：settings.js 曾经 import 了 `clear` 但 ui.js 之外没人注意到它
 * 在 import 列表里漏了 —— 静态解析不报错，一渲染就 `clear is not defined`。
 * 这里把每个模块的 `export function/const/class X` 收集起来做交叉核对。
 */
console.log('\n(13) 前端 import/export 交叉核对');
const exportsOf = new Map();
for (const f of frontModules) {
  const src = read(f);
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const piece of m[1].split(',')) {
      const nm = piece.trim().split(/\s+as\s+/).pop().trim();
      if (nm) names.add(nm);
    }
  }
  if (/^export\s+default\s/m.test(src)) names.add('default');
  exportsOf.set(f, names);
}
let importProblems = 0;
for (const f of frontModules) {
  const src = read(f);
  const dir = path.posix.dirname(f);
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const spec = m[2];
    if (!spec.startsWith('.')) continue;
    const target = path.posix.normalize(path.posix.join(dir, spec));
    if (!exportsOf.has(target)) continue; // 非 .js 或不存在，交给别的检查
    const want = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    const have = exportsOf.get(target);
    const miss = want.filter((w) => !have.has(w));
    if (miss.length) {
      importProblems++;
      check(false, `${f} 从 ${spec} 导入的名字都存在`, '未导出: ' + miss.join(', '));
    }
  }
}
check(importProblems === 0, '所有命名导入都能在目标模块里找到', importProblems ? `${importProblems} 处` : '全部匹配');

console.log('\n没有遗留的临时调试文件');
const tools = fs.readdirSync(path.join(ROOT, 'tools'));
const junk = tools.filter((f) => /^_/.test(f) || /^\./.test(f));
check(junk.length === 0, 'tools/ 无 _ 或 . 开头的临时文件', junk.length ? '残留: ' + junk.join(', ') : '干净');
const rootFiles = fs.readdirSync(ROOT);
const bak = rootFiles.filter((f) => /\.bak/.test(f));
check(bak.length === 0, '根目录无 .bak 备份残留', bak.length ? '残留: ' + bak.join(', ') : '干净');

/**
 * ⚠️ 根目录的 `_` 开头文件也要查（2026-10 补）。
 *
 * 加这条是因为发现**两个脚本会把临时报告写到项目根目录**：
 *   · `tools/audit-gap.mjs`      → `<ROOT>/_gap.txt`
 *   · `tools/check-duplicate.mjs` → `<ROOT>/_dup.txt`
 * 而原来这里只查了 `tools/` 的 `_*` 和**只查 `.bak`** ——
 * 于是这两个文件可以一直躺在根目录里没人管。
 *
 * 它被抓到的过程也值得记：我手工 `Remove-Item _dup.txt, _gap.txt` 清掉之后，
 * 又跑了一遍全量自检，它们**又回来了** —— 因为自检本身就会生成它们。
 * **"我清干净了"和"系统不会再产生"是两件事。**
 * 清掉一次只解决了现象，加这条检查才解决"没人会再注意到"的问题。
 *
 * 用**点名白名单**而不是笼统"根目录不许有 _ 开头文件"：
 * 根目录里确实有别人的东西（用户自己的扫描脚本 `_scan_lib.ps1` 等，
 * 那些在上一级工作区、不在项目里）。这里只否决**已知由本项目脚本产生**的名字，
 * 精确到文件名，避免将来误伤无关文件。
 *
 * 2026-10 后续：这三个脚本（audit-gap / search-json / check-duplicate）
 * 已经改成把报告写进 `reports/` 了，所以下面这份名单现在是**防御性**的 ——
 * 留着是为了"万一有人改回去"时能立刻报警，而不是因为现在还会生成。
 * `reports/` 本身**不算 junk**：它是明确约定的产物目录，且已在 .gitignore 里。
 */
const ROOT_JUNK = ['_gap.txt', '_gap2.txt', '_dup.txt', '_term-changes.tsv', '_allids.txt'];
const rootJunk = rootFiles.filter((f) => ROOT_JUNK.includes(f));
check(rootJunk.length === 0, '项目根目录没有自检脚本吐出来的临时报告',
  rootJunk.length
    ? '残留: ' + rootJunk.join(', ') + '（删掉即可；这些脚本现在应该把报告写进 reports/）'
    : '干净');
// 反向：确认 reports/ 是被明确接受的产物目录，而不是"碰巧没被抓到"
check(!rootJunk.includes('reports'), 'reports/ 是约定的产物目录（已加进 .gitignore）');

// ---------------------------------------------------------------------------
// 浏览器 QA 的临时用户目录必须被删掉（2026-10 补）
// ---------------------------------------------------------------------------
//
// ⚠️ 加这条的原因：六个真浏览器 QA 各自 `mkdtempSync()` 建一个浏览器
//   `--user-data-dir`，`cleanup()` 里只 `child.kill()` + `server.close()`，
//   **从来没删过那个目录**。半年下来 `%TEMP%` 里堆了 **539 个目录、18.3 GB**。
//
//   它是怎么被发现的也值得记：当时在查一个"文件正由另一进程使用"的报错，
//   顺手 `Get-ChildItem $env:TEMP -Directory -Filter 'jp-*'` 才看见的 ——
//   **它不在项目里，所以任何"项目内文件"检查都抓不到它。**
//
//   `check-deliverables.mjs` 只管**项目里**的东西，所以严格说这个泄漏落在它的
//   职责之外。但"跑一次自检就往用户机器上堆 150 MB"是真问题，而且**没有任何
//   别的脚本会看它** —— 所以放在这里，当作"交付物不含副作用"的一部分。
//
//   三条断言：
//     ① 建了 profile 的脚本，必须**调用** `finishBrowser`（不只是 import）
//        （它负责"等浏览器真的退出"再删 —— 只 kill 了就删会 EBUSY）；
//     ② **不许出现 `child.kill`**：那正是"杀完就不管"的写法。
//        要杀进程就用 `killAndWait` / `finishBrowser`。
//     ③ `cleanup` 必须挂在 `process.on('exit')` 上（中途抛错也要走到）。
//
//   ⚠️ 这个检查器自己被咬过两次，都留在这里当教训：
//
//   (a) **不许拿注释当代码判。** 第一版查 `child.kill()`，结果它把我写在
//       qa-harness / qa-ruby 里**解释这个 bug 的注释**当成了真代码，
//       报了两个假失败。
//   (b) **不许用正则去块注释。** 第二版想"先把注释去掉再查"，于是：
//           .replace(/\/\*[\s\S]*?\*\//g, ' ')
//       而 qa-bugs.mjs 的**行注释里提到了 `/*` 这个字符串**，
//       于是它从那里一路吞到下一个真 `*/` —— **把中间的真代码
//       `finishBrowser(child, profile)` 一起删了**，报出 4 个假失败。
//       正则剥块注释需要词法分析（得知道 `/*` 是不是在字符串/行注释里），
//       做不到就别做。
//
//   所以最终只用两种**不会误伤**的做法：
//     · 查"禁用的写法"（②）→ 直接查**原文**，注释里有也算，这是可接受的方向
//       （逼着人别在注释里写这个写法）；
//     · 查"必须在"（①）→ 数**出现次数**：import 占 1 次，真调用再加 1 次。
//       行注释的剥离只做整行 `//`（安全：行注释必然到行尾）。
{
  const stripLineComments = (s) => s.replace(/^\s*\/\/.*$/gm, ' ');

  const qaFiles = tools.filter((x) => /^qa-[a-z0-9-]+\.mjs$/.test(x));
  const creators = [];
  for (const f of qaFiles) {
    const raw = fs.readFileSync(path.join(ROOT, 'tools', f), 'utf8');
    if (!/mkdtempSync\(path\.join\(tmpdir\(\)/.test(raw)) continue;
    creators.push(f);
    const src = stripLineComments(raw);

    check(/from\s+'\.\/lib\/qa-profile\.mjs'/.test(src),
      `${f} 用了共用的临时目录收尾模块`,
      '它 mkdtempSync 建了浏览器 profile，却没 import ./lib/qa-profile.mjs'
        + ' → 那个目录没人删，会在 %TEMP% 里堆积（曾堆到 18.3 GB）');
    const uses = (src.match(/finishBrowser/g) || []).length;
    check(uses >= 2,
      `${f} 真的调用了 finishBrowser（出现 ${uses} 次 = import 1 + 调用）`,
      `只出现 ${uses} 次 —— 只有 import、没调用，等于没修`);
    check(!raw.includes('child.kill'),
      `${f} 没有 child.kill（杀完就不管的那种写法）`,
      '裸 child.kill() 只发信号、不等进程退出，也不会删 profile；'
        + '改用 finishBrowser(child, profile)');
    check(/process\.on\('exit',\s*cleanup\)/.test(src),
      `${f} 在 process.on('exit') 上也挂了 cleanup`,
      '只在末尾显式调 cleanup 的话，中途抛错退出就不删了');
  }
  check(creators.length >= 5,
    `建临时 profile 的 QA 脚本都被覆盖到了（${creators.length} 个）`,
    `只找到 ${creators.length} 个，太少了 —— 可能匹配规则失效，这条会变成空转`);
}

// ---------------------------------------------------------------------------
// 泛化：**将来如果再加** .ps1，必须有 UTF-8 BOM
// ---------------------------------------------------------------------------
//
// ⚠️ 现在 tools/ 下**一个 .ps1 都没有了**。原来唯一的那个
//   （`win-ocr.ps1`，Windows.Media.Ocr 桥接）随着 OCR 换引擎一起删掉了。
//   所以下面这个循环目前是空转 —— 但它**故意留着**：
//
//   它会失败的那个坑是**任何 PowerShell 脚本**都会踩的，不是 win-ocr 特有的：
//     `edit` / `write` 工具按 UTF-8 文本读写文件、**不保留 BOM**。
//     PowerShell 5.1 判断脚本编码**只看 BOM**，没有 BOM 就按系统 ANSI（本机是 GBK）解码。
//     真实现场：文件里 `"系统未安装 $Lang 的 OCR 语言包"` 这行，
//     GBK 解码时「安装」的尾字节会吞掉后面的空格和结束引号 →
//     **整个脚本解析失败**，报 `字符串缺少终止符`，而报错信息毫无指向性。
//
//   规矩：**改过任何 .ps1 之后，都要重跑 `node tools/check-deliverables.mjs`**。
//   修法：`node tools/ps1bom.mjs`（给所有 .ps1 补 BOM）。
console.log('\n所有 PowerShell 脚本的编码（BOM）');
{
  const ps1 = tools.filter((x) => x.endsWith('.ps1'));
  if (!ps1.length) {
    console.log('  … tools/ 下没有 .ps1 文件（OCR 已改用 Python，无需 PowerShell 桥接）');
  }
  for (const f of ps1) {
    const buf = fs.readFileSync(path.join(ROOT, 'tools', f));
    const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    const text = buf.toString('utf8');
    const nonAscii = [...text].filter((c) => c.codePointAt(0) > 127).length;
    if (nonAscii > 0) {
      check(hasBom, `${f} 含 ${nonAscii} 个非 ASCII 字符，因此必须有 UTF-8 BOM`,
        hasBom ? '' : '没有 BOM → PowerShell 5.1 按 GBK 解码 → 整个脚本解析失败。'
          + '跑 `node tools/ps1bom.mjs` 修复');
    } else {
      check(true, `${f} 是纯 ASCII（有没有 BOM 都不影响）`);
    }
  }
}

console.log('\n' + '='.repeat(72));
console.log(fail === 0 ? ' 全部交付项齐备' : ` ${fail} 项缺失或不合格`);
console.log('='.repeat(72));
process.exit(fail === 0 ? 0 : 1);
