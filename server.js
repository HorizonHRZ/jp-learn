#!/usr/bin/env node
/**
 * jp-learn 本地小服务（零依赖，只用 Node 内置模块）
 *
 * 职责：
 *   1. 静态文件服务（app/ 与 data/）
 *   2. /api/health          健康检查 + 版本 + 能力探测
 *   3. /api/ocr             调用项目内置的日文 OCR 引擎（Python + ONNX）
 *   4. /api/lyric/parse     解析用户自己粘贴的歌词文本（分行 + 中日配对 + 统计）
 *   5. /api/dict/lookup     查词（汉字形 / 假名形 / 读音）
 *   6. /api/analyze         文本分析（分行 + 注音 + 罗马音 + 生词清单）
 *   7. /api/deinflect       活用还原（把活用形拆成「怎么变来的」几步）
 *
 * 设计边界（重要）：
 *   - 歌词文本一律由用户本人提供，本服务不连接任何歌词站点、不自动获取任何外部内容。
 *   - 本服务只做语言学处理（分行、中日配对，以及注音/罗马音的挂载点）。
 *
 * 硬约束遵守情况：
 *   - 本文件是明文源码，可随时修改，重启服务即生效
 *   - 不读写任何用户数据（用户数据全在浏览器的 IndexedDB 里）
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  initTokenizer, isReady as dictReady, getIndexError as dictError,
  getIndexStats as dictStats, buildReading as dictBuildReading,
  lookup as dictLookup, tokenize as dictTokenize, kanaNormalize,
  explainDeinflect as dictExplain, buildRubyFor as dictBuildRubyFor,
} from './tools/tokenizer.js';
import {
  CONFIG_FILENAME, DEFAULT_CONFIG, normalizeConfig, isConfigured, configSummary,
  chatEndpoint, buildMessages, extractContent, aiFailureMessage, trimHistory,
  PROVIDER_PRESETS, AI_PRIVACY_TEXT,
  // 按任务给输出长度预算（讲语法比翻译需要多得多的 token）
  maxTokensFor,
} from './tools/aiconf.js';
import { reconstruct as ocrReconstruct, layoutSummary as ocrLayoutSummary } from './app/js/ocrlayout.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(ROOT, 'app');
const DATA_DIR = path.join(ROOT, 'data');
const TMP_DIR = path.join(os.tmpdir(), 'jp-learn');

/**
 * AI 配置文件的绝对路径。
 *
 * ⚠️ 这个文件**存在项目根目录、明文保存密钥**（用户的选择：问 2 = 甲）。
 *    因此：
 *      · 它必须在 `SAFE_ROOTS` 之外 —— 否则浏览器能 GET 到自己的密钥。
 *        下面有一条启动时的自检断言这件事（见 assertConfigNotServable）。
 *      · 它必须被 .gitignore 排除 —— 免得用户哪天建了仓库把密钥推上去。
 *      · 它**绝不能**出现在任何 /api 响应里（除了遮罩后的摘要）。
 *
 * `JP_LEARN_CONFIG` 环境变量可以改变它的位置，**只为自动化测试服务**：
 * 端到端测试需要一份"指向假 AI 服务"的配置，如果写进项目目录里的真配置，
 * 跑完一旦没清理干净（比如中途退出），用户就会看到一份指向 127.0.0.1:xxxxx
 * 的假配置 —— 实测确实踩到过这个坑（探针里 process.exit 会跳过清理逻辑）。
 * 让它写到系统临时目录，就完全不会污染用户的真实配置。
 */
const CONFIG_PATH = process.env.JP_LEARN_CONFIG
  ? path.resolve(process.env.JP_LEARN_CONFIG)
  : path.join(ROOT, CONFIG_FILENAME);

// 分词器要按绝对路径找 data/，这里显式告诉它，避免依赖它自己的路径推导
process.env.JP_LEARN_DATA = DATA_DIR;

// ---------- 版本号：唯一来源是 app/js/version.js ----------
async function readVersion() {
  try {
    const t = await fsp.readFile(path.join(APP_DIR, 'js', 'version.js'), 'utf8');
    const m = t.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
    return m ? m[1] : '0.0.0';
  } catch { return '0.0.0'; }
}

const PORT = Number(process.env.JP_LEARN_PORT || process.argv[2] || 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    ...headers,
  });
  res.end(body);
}
function json(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}
function readBody(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------- 静态文件 ----------
const SAFE_ROOTS = [APP_DIR, DATA_DIR];
async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';

  // ⚠️ app/__qa__/ 是**自检载荷**（tools/qa-layout.mjs 用的那个页面），
  //    它不属于应用。不挡住它会有两个真问题：
  //      ① 用户手滑点到 /__qa__/reading.html，会在这个页面里跑一遍分析，
  //         往他自己的精读笔记库里写数据（测试动静不该出现在用户数据里）；
  //      ② 它是"测试用的后门页面"，长期挂在应用目录里迟早被当成正式功能改。
  //    所以这里明确 403。
  //    qa-layout.mjs 不受影响：它自己起临时服务、直接从磁盘读文件，
  //    根本不经过这里（见那个脚本里"为什么自己起一个"的注释）。
  if (/(^|\/)__qa__(\/|$)/.test(rel)) {
    return send(res, 403, '这是自检载荷页，不属于应用。见 tools/qa-layout.mjs');
  }

  // 注意：目录穿越在这里已经**拦不住**了，因为 URL 解析阶段就把点段归一化了
  // （见 handleRequest 顶部）。防护放在那里，这里只做静态映射。

  // 允许访问的目录：app/ 与 data/；另放行根目录的少数文件
  let target;
  const rootFiles = new Set(['/ARCHITECTURE.md', '/使用说明.md']);
  if (rootFiles.has(rel)) {
    target = path.join(ROOT, rel);
  } else if (rel === '/data' || rel.startsWith('/data/')) {
    // /data/... 必须直接映射到项目根的 data/ 目录。
    // ⚠️ 曾经这里只有「先 app/ 再 data/ 兜底」的分支，而兜底用的是
    //    path.join(DATA_DIR, rel) —— rel 还带着开头的 /data，
    //    结果去找 data/data/... 而 404。导致词库文件全部取不到
    //    （/data/vocab/n5.json、/data/index/manifest.json 都是 404）。
    target = path.join(DATA_DIR, rel.replace(/^\/data\/?/, ''));
  } else {
    target = path.join(APP_DIR, rel);
    if (!fs.existsSync(target)) {
      const alt = path.join(DATA_DIR, rel.replace(/^\/+/, ''));
      if (fs.existsSync(alt)) target = alt;
    }
  }

  const resolved = path.resolve(target);
  const allowed = SAFE_ROOTS.some((r) => resolved.startsWith(path.resolve(r) + path.sep))
    || resolved === path.join(ROOT, 'ARCHITECTURE.md')
    || resolved === path.join(ROOT, '使用说明.md');
  if (!allowed) return send(res, 403, 'Forbidden');

  try {
    const st = await fsp.stat(resolved);
    if (st.isDirectory()) return serveStatic(req, res, path.posix.join(rel, 'index.html'));
    const ext = path.extname(resolved).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    // 大 JSON 数据支持 Range（便于流式加载）
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(resolved).pipe(res);
  } catch {
    send(res, 404, '404 Not Found: ' + rel, { 'Content-Type': 'text/plain; charset=utf-8' });
  }
}

// ---------- 日文 OCR（项目内置的 Python + ONNX 引擎） ----------
/**
 * ──────────────────────────────────────────────────────────────────
 * 为什么不用 Windows 自带的 OCR 了（这段历史必须留着）
 * ──────────────────────────────────────────────────────────────────
 * 最初用的是 `Windows.Media.Ocr`（通过 tools/win-ocr.ps1 调 PowerShell）。
 * 它有两个**修不掉**的毛病，而用户的核心场景恰恰是竖排的日文书籍：
 *
 *   1. 竖排可靠性差：`TextAngle` 永远是 0，同一张图两次运行结果都不一样；
 *      注音（ふりがな）有时整块丢掉、有时被拆到单独一行。
 *   2. 横向/纵向判断要自己猜，且没有可用的置信度。
 *
 * 换成了 `rapidocr 3.9.2` + `japan_PP-OCRv4_rec_mobile.onnx`（ONNX Runtime）。
 * 走通的弯路记在 ARCHITECTURE §十九，这里只留结论：
 *   · 必须用**日文**识别模型 —— 中文模型会把假名整个丢掉（实测「猫が歩いた」→「猫歩」）
 *   · 模型和 Python 运行时都放在项目里（runtime/ocr/），不写用户目录
 *
 * ──────────────────────────────────────────────────────────────────
 * 分工：**Python 出证据，JS 出结论**
 * ──────────────────────────────────────────────────────────────────
 *   Python (tools/ocr-worker.py)：只给"文本 + 坐标 + 客观图像度量"。
 *   JS (app/js/ocrlayout.js)    ：判断横排/竖排、分列、排序、去注音。
 *
 * 为什么这么分：版面重建是纯几何算法，放在 JS 里可以用纯函数测试逐条断言，
 * 不需要装 Python、不需要真图、毫秒级跑完。Python 只负责它非做不可的事。
 */

/** Python 解释器（项目内置的可移植版本）。 */
const OCR_PY = path.join(ROOT, 'runtime', 'ocr', 'py', 'python.exe');
/** OCR worker 脚本。 */
const OCR_WORKER = path.join(ROOT, 'tools', 'ocr-worker.py');

/** 运行时是否就绪（只做"文件在不在"的便宜检查）。 */
function ocrRuntimeReady() {
  try { return fs.existsSync(OCR_PY) && fs.existsSync(OCR_WORKER); } catch { return false; }
}

/**
 * 调 Python worker，返回它输出的 JSON。
 *
 * ⚠️ 用 `stdio: ['ignore','pipe','pipe']` 而不是默认值：
 *    worker 的日志走 stderr，stdout **只有一行 JSON**（这样解析最简单，
 *    也避免日志里的日文把 JSON 搞坏）。测试 test-ocr-e2e.mjs [6] 专门钉住这点。
 *
 * ⚠️ 超时给得比较长（120 秒）：第一次运行要先加载 ONNX 模型，
 *    冷启动实测几秒到十几秒；给短了会把"慢"误报成"坏"。
 */
function runOcrWorker(args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    execFile(OCR_PY, [OCR_WORKER, ...args], {
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs,
      // 强制 UTF-8：Windows 上 Python 的默认编码可能是 GBK，
      // 那会把日文输出变成乱码（实测过）。
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }, (err, stdout, stderr) => resolve({ err, stdout: stdout || '', stderr: stderr || '' }));
  });
}

async function handleOcr(req, res) {
  let stage = 'start';
  let imgPath = null;
  try {
    const body = JSON.parse((await readBody(req)).toString('utf8'));
    const {
      imageBase64, ext = 'png',
      // 用户的**手动覆盖**（界面上有开关）：auto / vertical / horizontal
      layout = 'auto',
      // 是否去掉注音，默认去（用户看正文，注音由本程序自己注）
      stripFurigana = true,
    } = body || {};
    if (!imageBase64) return json(res, 400, { ok: false, error: '缺少 imageBase64' });

    // 运行时没装就给一条**能照着做**的提示，而不是一个技术报错
    if (!ocrRuntimeReady()) {
      return json(res, 503, {
        ok: false,
        error: 'OCR 运行时还没安装。请在项目目录里执行一次：node tools/get-ocr-runtime.mjs',
        code: 'NO_RUNTIME',
        runtimeReady: false,
        hint: '这一步会下载约 400MB 的日文识别模型（只下一次），之后拍照识别就一直可用。',
      });
    }

    stage = 'mkdir';
    await fsp.mkdir(TMP_DIR, { recursive: true });
    const safeExt = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff'].includes(String(ext).toLowerCase())
      ? String(ext).toLowerCase() : 'png';
    imgPath = path.join(TMP_DIR, `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${safeExt}`);
    stage = 'write';
    await fsp.writeFile(imgPath, Buffer.from(imageBase64, 'base64'));

    stage = 'run';
    const { err, stdout, stderr } = await runOcrWorker(['--image', imgPath]);
    // 清理临时图（隐私：不长期保留用户图片）
    fsp.unlink(imgPath).catch(() => {});
    imgPath = null;

    // worker 把可预期的失败也写成 JSON（并 exit 2），所以先尝试解析 stdout
    stage = 'parse';
    const line = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{')).pop();
    let raw = null;
    if (line) { try { raw = JSON.parse(line); } catch { raw = null; } }

    if (!raw) {
      // stdout 里没有 JSON —— 说明 Python 自己崩了（语法错误、缺包……）
      return json(res, 500, {
        ok: false, error: ocrFailureMessage(err, stderr), stage,
        detail: (stderr || String((err && err.message) || err)).slice(0, 800),
      });
    }
    if (raw.ok === false) {
      // worker 明确报错（图片读不了、模型缺失……）：原样透传它给的错误码和人话
      const status = raw.error === 'NO_RUNTIME' ? 503 : 500;
      return json(res, status, {
        ok: false, error: raw.message || 'OCR 失败', code: raw.error, stage,
        detail: String(raw.detail || '').slice(0, 800),
      });
    }

    // ── 重点：版面重建（横排/竖排、分列、排序、去注音）在 JS 里做 ──
    stage = 'layout';
    const forceLayout = layout === 'vertical' || layout === 'horizontal' ? layout : null;
    const laid = ocrReconstruct(raw, { forceLayout, stripFurigana });

    json(res, 200, {
      ok: true,
      // 重建后的可读文本（竖排已转成横排）
      text: laid.text,
      lines: laid.lines.map((l) => ({ axis: l.axis, text: l.text, count: l.blocks.length })),
      vertical: laid.vertical,
      summary: ocrLayoutSummary(laid),
      layoutReasons: (laid.layout && laid.layout.reasons) || [],
      furiganaRemoved: laid.furigana ? laid.furigana.removedCount : 0,
      // 原始块留着：界面上可以显示"识别置信度"，也方便排查问题
      blocks: raw.items || [],
      count: raw.count || 0,
      image: raw.image || null,
      engine: raw.engine || null,
    });
  } catch (e) {
    if (imgPath) fsp.unlink(imgPath).catch(() => {});
    json(res, 500, { ok: false, error: ocrFailureMessage(e, ''), stage,
      detail: String((e && e.stack) || e).slice(0, 800) });
  }
}

/**
 * 把 OCR 的底层报错翻译成**用户能看懂、并且知道该怎么办**的话。
 *
 * 为什么必须翻译：`execFile` 失败时 `err.message` 就是 `"spawn EPERM"` 这种字符串。
 * 把它原样显示给一个编程小白，等于什么都没说 —— 他不知道是谁权限不够、
 * 更不知道下一步该做什么。实测在开发沙箱里就是这个报错（见 ARCHITECTURE 13.4.2）。
 */
function ocrFailureMessage(err, stderr) {
  const raw = String((err && err.message) || err || '') + ' ' + String(stderr || '');
  if (/ETIMEDOUT|timed? ?out/i.test(raw)) {
    return 'OCR 运行超时了（超过 2 分钟）。'
      + '第一次运行需要加载模型会慢一些，可以稍等再试一次；'
      + '如果一直超时，可能是图片太大，试着裁小一点或降低拍照分辨率。';
  }
  if (/EPERM|EACCES/i.test(raw)) {
    return '无法启动 OCR 程序（权限被拒绝）。'
      + '请确认是通过双击「启动.cmd」启动的服务，而不是在受限的沙箱/容器里运行。';
  }
  if (/ENOENT/i.test(raw)) {
    return '没有找到项目内置的 OCR 运行时（runtime/ocr/py/python.exe）。'
      + '请在项目目录里执行一次：node tools/get-ocr-runtime.mjs';
  }
  if (/ModuleNotFoundError|ImportError/i.test(raw)) {
    return 'OCR 运行时缺少必要的组件。'
      + '请重新执行：node tools/get-ocr-runtime.mjs（会补齐缺失的包）。';
  }
  return 'OCR 执行失败：' + (raw.trim().slice(0, 200) || '原因未知');
}

// ---------- 歌词文本解析（文本全部由用户自己提供） ----------
/**
 * 输入：{
 *   text: '日文歌词原文（用户粘贴，必填）',
 *   translation?: '中文对照（用户粘贴，可选）',
 *   romaji?: 'hepburn' | 'kunrei',   // 罗马音体系，默认 hepburn
 *   particle?: boolean,              // 助词 は/へ/を 按读音转写（默认 true）
 *   ruby?: boolean                   // 是否计算逐字振假名（默认 true）
 * }
 * 输出：{
 *   ok, source:'user-provided',
 *   stats: { lineCount, charCount, kanjiCount, kanaCount, translationLines, translationAligned },
 *   reading: { knownTokens, unknownTokens, coverage, unknownSurfaces, rubyEstimated, romajiStyle },
 *   lines: [{ index, ja, zh, reading: { kana, romaji, tokens, knownCount, unknownCount, coverage, unknownSurfaces } }]
 * }
 *
 * 边界：本服务不获取任何外部歌词内容，text / translation 全部来自用户输入。
 *
 * 实现说明：注音与罗马音由 tools/tokenizer.js 的 buildReading() 完成 ——
 * 用 data/index/ 的词库索引做最长匹配分词，命中词条时取其假名表面形作为读音；
 * 查不到的片段 reading 留空并标 known:false（不用单字音读去猜，猜错更害人）。
 */
const KANJI_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const KANA_RE = /[\u3040-\u309f\u30a0-\u30ff]/g;

function splitLyricLines(s) {
  return String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** 逐行挂载注音/罗马音。词库索引尚未就绪时如实返回错误，不伪装成结果。 */
function buildReading(jaLine, opts) {
  return dictBuildReading(jaLine, opts);
}

async function handleLyricParse(req, res) {
  try {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const jaLines = splitLyricLines(body.text);
    if (jaLines.length === 0) {
      return json(res, 400, { ok: false, error: '缺少 text（请先粘贴歌词文本）' });
    }
    const zhLines = splitLyricLines(body.translation);
    const opts = {
      romajiStyle: body.romaji === 'kunrei' ? 'kunrei' : 'hepburn',
      particleRule: body.particle !== false,
      ruby: body.ruby !== false,
    };

    let known = 0;
    let unknown = 0;
    let rubyEstimated = 0;
    const unknownSet = new Set();
    let indexError = null;

    const lines = jaLines.map((ja, i) => {
      const reading = buildReading(ja, opts);
      if (reading.error) indexError = reading.error;
      known += reading.knownCount || 0;
      unknown += reading.unknownCount || 0;
      rubyEstimated += reading.rubyEstimated || 0;
      for (const u of reading.unknownSurfaces || []) unknownSet.add(u);
      return {
        index: i + 1,
        ja,
        zh: zhLines[i] ?? '',
        reading,
      };
    });

    const joined = jaLines.join('');
    const total = known + unknown;
    const stats = {
      lineCount: jaLines.length,
      charCount: joined.length,
      kanjiCount: (joined.match(KANJI_RE) || []).length,
      kanaCount: (joined.match(KANA_RE) || []).length,
      translationLines: zhLines.length,
      translationAligned: zhLines.length === 0 ? null : zhLines.length === jaLines.length,
    };

    json(res, 200, {
      ok: true,
      source: 'user-provided',
      stats,
      reading: {
        ready: dictReady() && !indexError,
        error: indexError,
        romajiStyle: opts.romajiStyle,
        particleRule: opts.particleRule,
        knownTokens: known,
        unknownTokens: unknown,
        coverage: total ? Math.round((known / total) * 1000) / 10 : 100,
        unknownSurfaces: [...unknownSet].slice(0, 30),
        rubyEstimated,
      },
      lines,
    });
  } catch (e) {
    json(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
}

// ---------- 查词 ----------
/**
 * GET /api/dict/lookup?q=日本語[&style=hepburn]
 * 支持汉字形、假名形与读音。返回条目 id、词形、读音、等级、中文释义、词性。
 * 词条完整信息（例句）在 data/vocab/*.json 里，由前端按需加载。
 */
async function handleLookup(req, res, url) {
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return json(res, 400, { ok: false, error: '缺少 q 参数' });
  if (!dictReady()) {
    return json(res, 503, { ok: false, error: dictError() || '词库索引尚未就绪' });
  }
  try {
    const style = url.searchParams.get('style') === 'kunrei' ? 'kunrei' : 'hepburn';
    // ⚠️ 片假名要先归一成平假名再查（用户报的 bug 之一：
    //    输入「かた」能出 5 个同音词，输入「カタ」却一个都没有）。
    //    索引里的读音**一律存平假名**，而片假名和平假名是两套不同的码位，
    //    严格比较必然不相等。之前只有前端做了归一，服务端没做 ——
    //    于是"前端只在前端能修，直接调接口或前端漏了这条路径就查不到"。
    //    在数据入口处归一，是唯一一处能覆盖所有调用方的地方。
    const qNorm = kanaNormalize(q);
    const result = dictLookup(q);
    const normDiffers = qNorm !== q;
    const resultNorm = normDiffers ? dictLookup(qNorm) : { exact: [], byReading: [] };
    const reading = buildReading(q, { romajiStyle: style, particleRule: false, ruby: true });
    // ⚠️ 计数的口径必须是**去重之后**。
    //
    //    实测（临时诊断脚本跑出来的真相）：`dictLookup('カタ')` 自己就能
    //    通过读音回退找到那 5 个词，只是它们落在 `byReading` 而不是 `exact`。
    //    所以归一那一路并不是"补上了缺失的结果"，而是**同一批词又数了一遍**。
    //    之前把四组长度直接相加 → かた 明明只有 5 个词，total 却报 10。
    //    界面上就会写成"共 10 条（同音/同形词）"却只列出 5 条 —— 自己打自己脸。
    //
    //    这里按 id 去重后再数。`exact` 放在最前面，所以同一个词的"正牌身份"
    //    （按词形直接命中）优先于回退命中，前端拿到的仍是同一条数据。
    const seenIds = new Set();
    const uniq = (list) => (list || []).filter((t) => {
      const k = t && (t.id || t.wordId || t.term);
      if (k == null) return true;
      if (seenIds.has(k)) return false;
      seenIds.add(k);
      return true;
    });
    const exact = uniq(result.exact);
    const byReading = uniq(result.byReading);
    const exactNorm = uniq(resultNorm.exact);
    const byReadingNorm = uniq(resultNorm.byReading);
    json(res, 200, {
      ok: true,
      query: q,
      // 归一之后的查询串（和原串不同时前端可以提示"按 X 查的"）
      normalizedQuery: qNorm,
      romaji: reading.romaji,
      kana: reading.kana,
      tokens: reading.tokens,
      coverage: reading.coverage,
      unknownSurfaces: reading.unknownSurfaces,
      exact,
      byReading,
      // 片假名归一那一路**新多出来**的命中（一条都没有就是 []，不影响原行为）
      exactNormalized: exactNorm,
      byReadingNormalized: byReadingNorm,
      // 去重后的真实条数 —— 和前端"去重后列出来的条数"必须一致
      total: exact.length + byReading.length + exactNorm.length + byReadingNorm.length,
    });
  } catch (e) {
    json(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
}

// ---------- 活用还原（工具箱「活用还原器」） ----------
/**
 * GET /api/deinflect?q=食べさせられた
 *
 * 把一个活用形拆开讲清楚：原文 → 拿掉哪段语尾 → 词干怎么归位 → 辞书形。
 * 为什么需要它：词典**只收辞书形**，看到 使って / 食べさせられた / 書かなければ
 * 根本不知道该查哪个词。这个接口把"它是怎么变来的"直接摊开。
 *
 * 与 /api/dict/lookup 的分工：
 *   lookup  —— "这是哪个词"（给词条信息，可查汉字/假名/读音）
 *   deinflect —— "它怎么变来的"（给推导步骤，只接受一个活用形或一小段话）
 *
 * 实现复用 tools/tokenizer.js 的 explainDeinflect()，不另写一套活用规则 ——
 * 两套规则迟早会不一致，而分词器那套有单元测试守着。
 */
async function handleDeinflect(req, res, url) {
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return json(res, 400, { ok: false, error: '缺少 q 参数' });
  if (q.length > 120) return json(res, 400, { ok: false, error: '输入太长了（最多 120 字）' });
  if (!dictReady()) {
    return json(res, 503, { ok: false, error: dictError() || '词库索引尚未就绪' });
  }
  try {
    const result = dictExplain(q);
    json(res, 200, {
      ok: true,
      query: result.input,
      found: !!result.found,
      error: result.error || undefined,
      results: result.results || [],
      total: (result.results || []).length,
    });
  } catch (e) {
    json(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
}

// ---------- 注音对齐（用户手改读音后由服务端算振假名） ----------
/**
 * GET /api/yomi?surface=今日&reading=こんにち
 *
 * 用途：**汉字多音**，程序猜的读音未必是歌里唱的那个（用户报的问题）。
 * 允许用户在歌词页 / 精读页把某个词的读音改成正确的，改完要重新得到
 * 「振假名怎么切 + 罗马音是什么」。
 *
 * 为什么不让客户端自己算：
 *   对齐用的是 DP + data/index/kanji.json 的单字读音统计，那套逻辑在
 *   tools/tokenizer.js 里，而且统计表有 3000+ 条 —— 没必要为了改个读音
 *   把它也发给浏览器。**一份实现，只有服务端有**，客户端只负责显示。
 *
 * 与 /api/analyze 的分工：
 *   analyze    —— 给定**文本**，程序去猜读音并注音
 *   yomi       —— 给定**词形 + 用户指定的读音**，只做对齐，不猜
 */
async function handleYomi(req, res, url) {
  const surface = (url.searchParams.get('surface') || '').trim();
  const reading = (url.searchParams.get('reading') || '').trim();
  if (!surface) return json(res, 400, { ok: false, error: '缺少 surface 参数' });
  if (!reading) return json(res, 400, { ok: false, error: '缺少 reading 参数' });
  if (surface.length > 60) return json(res, 400, { ok: false, error: '词形太长了（最多 60 字）' });
  if (reading.length > 120) return json(res, 400, { ok: false, error: '读音太长了（最多 120 字）' });
  if (!dictReady()) {
    return json(res, 503, { ok: false, error: dictError() || '词库索引尚未就绪' });
  }
  try {
    const out = dictBuildRubyFor(surface, reading);
    if (!out) {
      // 读音必须是纯假名。用户可能填了罗马音或汉字 —— 说清楚，别静默失败。
      return json(res, 400, { ok: false, error: '读音只能填平假名或片假名' });
    }
    json(res, 200, { ok: true, ...out });
  } catch (e) {
    json(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
}

// ---------- 文本分析（精读用：用户粘贴的日文） ----------
/**
 * POST /api/analyze   Body: { text, paragraph?: boolean, romaji?, particle?, ruby? }
 * 把用户粘贴的日文按「段落 → 句子 → 词」切开，并给出注音、罗马音、生词清单。
 * 注意：这里只做语言学处理，不产生任何翻译。
 */
async function handleAnalyze(req, res) {
  try {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const text = String(body.text ?? '');
    if (!text.trim()) return json(res, 400, { ok: false, error: '缺少 text' });
    if (!dictReady()) {
      return json(res, 503, { ok: false, error: dictError() || '词库索引尚未就绪' });
    }

    const opts = {
      romajiStyle: body.romaji === 'kunrei' ? 'kunrei' : 'hepburn',
      particleRule: body.particle !== false,
      ruby: body.ruby !== false,
    };

    // 段落：按空行切；句子：按日文句读点切（保留标点）
    const paragraphs = text.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const sentences = [];
    let idx = 0;
    for (const p of paragraphs) {
      const raw = p.split('\n').map((l) => l.trim()).filter(Boolean).join('');
      const parts = raw.split(/(?<=[。！？!?…‥])/).map((x) => x.trim()).filter(Boolean);
      for (const s of parts) {
        const reading = buildReading(s, opts);
        sentences.push({ index: ++idx, text: s, reading });
      }
    }

    // 生词清单：汇总所有 token，统计出现次数与"已知/未知"
    const vocabMap = new Map();
    for (const s of sentences) {
      for (const t of s.reading.tokens || []) {
        if (t.isSpace || t.isPunct || t.isLatin) continue;
        if (/^[\u3040-\u309f\u30a0-\u30ff\u30fc]+$/.test(t.surface) && !t.id) {
          // 纯假名且非词条：多为助词/词尾，不放进生词本候选
          continue;
        }
        const key = t.id || t.surface;
        const cur = vocabMap.get(key) || {
          surface: t.surface, reading: t.reading || '', romaji: t.romaji || '',
          level: t.level || '', zh: t.zh || null, pos: t.pos || '',
          id: t.id || null, known: !!t.known, count: 0,
        };
        cur.count++;
        vocabMap.set(key, cur);
      }
    }
    const vocab = [...vocabMap.values()].sort((a, b) => b.count - a.count || a.surface.localeCompare(b.surface, 'ja'));

    const allTokens = sentences.flatMap((s) => s.reading.tokens || []);
    const known = allTokens.filter((t) => t.known && !t.isSpace && !t.isPunct).length;
    const unknown = allTokens.filter((t) => !t.known && !t.isSpace && !t.isPunct).length;

    json(res, 200, {
      ok: true,
      source: 'user-provided',
      stats: {
        charCount: text.length,
        paragraphCount: paragraphs.length,
        sentenceCount: sentences.length,
        tokenCount: allTokens.length,
        uniqueVocab: vocab.length,
        unknownVocab: vocab.filter((v) => !v.known).length,
        coverage: known + unknown ? Math.round((known / (known + unknown)) * 1000) / 10 : 100,
      },
      sentences,
      vocab,
    });
  } catch (e) {
    json(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
}

/**
 * 接收前端诊断页（#/diag）发来的环境报告，落盘到 data/diag/。
 *
 * 为什么要有这个接口：排查界面问题时，让用户"按 F12 复制控制台输出"经常行不通
 * （笔记本要 Fn+F12、某些浏览器禁用、用户不熟悉）。改成网页自己把报告 POST 回来，
 * 开发者直接读文件即可，用户只需要点一下按钮。
 *
 * ⚠️ 写进 data/ 而不是用户数据区：data/ 是**内置数据**目录，本来就由程序管理，
 *    不违反"用户数据只在 IndexedDB"。诊断报告是程序的调试产物，不是用户数据。
 * ⚠️ 只接受 JSON、限 256KB、字段截断，避免被当成任意文件写入口。
 */
// ---------- 语法教材（正文在 data/grammar/，用户状态在前端 grammarState 表） ----------
/**
 * 语法正文是**静态资源**（`data/grammar/*.json`），前端可以直接取，服务端不插手。
 * 那为什么还要这个接口？因为正文里的日文例句需要**振假名和读音**，
 * 而那是分词器（`tools/tokenizer.js`）干的活，只有服务端有。
 *
 * 所以分工是：
 *   · `data/grammar/index.json`、`N5.json`  → 前端直接静态取（可缓存，快）
 *   · `/api/grammar/entry?id=xxx`          → 服务端补上例句的振假名
 *
 * 返回的 `examples[].reading` 结构和歌词页/精读页**完全一样**（buildReading 的产物），
 * 所以前端能直接复用 `views/jpreader.js` 的 renderTokens 渲染，不用再写一套。
 */
const GRAMMAR_DIR = path.join(DATA_DIR, 'grammar');

function readGrammarIndex() {
  return JSON.parse(fs.readFileSync(path.join(GRAMMAR_DIR, 'index.json'), 'utf8'));
}

async function handleGrammarEntry(req, res, url) {
  try {
    const id = url.searchParams.get('id');
    if (!id) return json(res, 400, { ok: false, error: '缺少 id' });

    // 索引里找这条属于哪个文件（信任索引，因为 test-grammar.mjs 会保证它和正文一致）
    let index;
    try {
      index = readGrammarIndex();
    } catch (e) {
      return json(res, 500, {
        ok: false,
        error: '语法数据还没生成索引。请运行 node tools/build-grammar-index.mjs',
      });
    }
    const meta = index.items.find((x) => x.id === id);
    if (!meta) return json(res, 404, { ok: false, error: `没有这条语法：${id}` });

    const file = path.join(GRAMMAR_DIR, path.basename(meta.file)); // basename 防目录穿越
    const data = JSON.parse(await fsp.readFile(file, 'utf8'));
    const item = (data.items || []).find((x) => x.id === id);
    if (!item) return json(res, 404, { ok: false, error: `索引指向 ${meta.file}，但正文里没有 ${id}` });

    // 给每条例句算振假名。和精读页用同一套参数，保证两处显示一致。
    const opts = { romajiStyle: 'hepburn', particleRule: true, ruby: true };
    const examples = (item.examples || []).map((e) => {
      const r = buildReading(e.ja, opts);
      return {
        ja: e.ja,
        zh: e.zh || '',
        note: e.note || '',
        reading: r.error ? null : {
          tokens: r.tokens, kana: r.kana, romaji: r.romaji,
          unknownSurfaces: r.unknownSurfaces, coverage: r.coverage,
          rubyEstimated: r.rubyEstimated,
        },
        // 词库没就绪时如实说明，不假装注音是空的
        readingError: r.error || null,
      };
    });

    json(res, 200, {
      ok: true,
      item: {
        ...item,
        source: item.source || data.source || '',
        examples,
        // ⚠️ related（相关条目）**只在索引里，不在等级 JSON 里**。
        //    因为它是**关系**不是条目属性：同一份关系同时约束两端，
        //    放在任一条的正文里都会变成"一半在这边、一半在那边"。
        //    所以 index.json 是它的唯一出处，这里从 meta 合并进来。
        //
        //    踩到的：第一版只 ...item，于是界面上「相关条目」整块不显示 ——
        //    而数据层检查（check-related）全绿，因为它查的是索引和
        //    relations.json，根本没经过这个接口。**测试跑在同一条路上，
        //    才证明得了那条路通。**
        related: Array.isArray(meta.related) ? meta.related : [],
        alias: Array.isArray(meta.alias) && meta.alias.length ? meta.alias : (item.alias || []),
      },
      // 顺便告诉前端：注音是不是可靠的（词库没就绪时 coverage 会很低）
      dictReady: dictReady(),
    });
  } catch (e) {
    json(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
}

/**
 * 判断一条语法索引条目是否命中搜索词。
 *
 * 抽成独立函数是**为了能单独测**：搜索匹配这段逻辑原来内联在
 * `handleGrammarSearch` 里，只有起服务发 HTTP 才能验证，结果
 * **一个测试都没覆盖它**（`grep grammar/search tools/` 是空的）。
 * 真实后果：搜「は が 区别」0 条这个 bug 一直没被发现，
 * 而那恰恰是初学者最自然的输入写法。
 *
 * ⚠️ 现在测它的是 `tools/test-http.mjs` 的 `[7c]`～`[7e]` 三段
 *    （原来这里的注释写的是 `tools/test-grammar-search.mjs`，
 *     但**那个文件从来不存在** —— 代码里留着一句假话。
 *     文档/注释里写的路径必须真的存在，这条已经犯过两次了。）
 *
 * 匹配规则（两条都要）：
 *   ① 直接 includes（保留原来的行为）
 *   ② 两边都去掉空白再 includes —— 用户写「は と が の違い」、
 *      条目写「は 与 が 的区别」，只有去掉空白加宽松连接才可能撞上
 *
 * ⚠️ 已知的宽松代价：搜「ら しい」会命中「らしい」，因为去空白后
 *    两者相等。这对**搜索**是可接受的（用户这么敲本来就想找らしい），
 *    所以不改，但要知道它不是零成本。
 */
export function grammarHit(x, needleLower) {
  const needleTight = needleLower.replace(/\s+/g, '');
  const hit = (v) => {
    const s = String(v || '').toLowerCase();
    if (s.includes(needleLower)) return true;
    return Boolean(needleTight) && s.replace(/\s+/g, '').includes(needleTight);
  };
  return hit(x.title) || hit(x.meaning) || hit(x.category) || hit(x.id)
    || (Array.isArray(x.tags) && x.tags.some((t) => hit(t)))
    // ⚠️ alias（同一语法点的其他写法）**必须搜**。
    //    实测踩到：讲「くせに」的条目，标题里没有「くせして」，
    //    用户搜「くせして」就搜不到 —— 而那正是同一个语法点的口语变体。
    //    tags 和 alias 在这里都搜，因为它们对用户是同一回事：能搜到的写法。
    || (Array.isArray(x.alias) && x.alias.some((t) => hit(t)));
}

/**
 * 多词查询：**任一命中就算命中**（是"或"，不是"与"）。
 *
 * ⚠️ 为什么要改成"或"（实测踩到的）：
 *   用户很自然会敲「为什么 因为」「每 各」「明明 却」这种**两个词**的查询。
 *   原来的做法是把整串「为什么 因为」当成一个词去 includes ——
 *   没有任何条目里含这五个连续字符（还带个空格），所以**恒返回 0 条**。
 *   也就是说：用户越努力描述自己想找什么，越搜不到。
 *   实测「为什么 因为」「每 各」「明明 却」「语气 女性」全是 0 条。
 *
 * 改成"或"之后的取舍：
 *   ① 单词查询**完全不变**（只有一个词时，或＝与，行为逐字节相同）；
 *   ② 多词查询会**变宽**（命中任一即可），可能多出一些条目。
 *      但这比"恒为 0"好得多 —— 用户看得见东西才能自己缩小范围；
 *   ③ 内部命中数多的条目会排在前面（见 handleGrammarSearch 的排序），
 *      所以"两个词都命中"的条目仍然在最上面。
 */
export function grammarHitAny(x, q) {
  const words = String(q || '').split(/\s+/).map((w) => w.trim()).filter(Boolean);
  if (!words.length) return { hit: false, score: 0 };
  let score = 0;
  let hit = false;
  for (const w of words) {
    if (grammarHit(x, w.toLowerCase())) { hit = true; score++; }
  }
  return { hit, score };
}


async function handleGrammarSearch(req, res, url) {
  try {
    const q = String(url.searchParams.get('q') || '').trim();
    const level = String(url.searchParams.get('level') || '').trim();
    const category = String(url.searchParams.get('category') || '').trim();

    let index;
    try {
      index = readGrammarIndex();
    } catch {
      return json(res, 200, { ok: true, items: [], total: 0, indexed: false,
        hint: '语法数据还没生成索引' });
    }

    let items = index.items;
    if (level) items = items.filter((x) => x.level === level);
    if (category) items = items.filter((x) => x.category === category);

    if (q) {
      // 只按索引里有的字段搜 —— 正文里的接续/例句要读文件，代价大，
      // 这里刻意不搜，宁可搜得少也不让列表页变慢（README 里写明了）。
      //
      // ⚠️ 但 tags **必须**搜。实测踩到：条目打了「书面语」「长句」标签，
      //    用户搜「书面语」却一条都搜不到 —— 而按概念/标签搜正是初学者
      //    最主要的用法（他还不知道自己需要哪个语法点，只能按概念翻）。
      //    tags 现在由 build-grammar-index.mjs 写进索引。
      //
      // 匹配细节（含"去空白再比一次"和"多词取或"的原因）都在
      // grammarHit / grammarHitAny 的注释里，那两个函数由
      // tools/test-http.mjs 的 [7c]～[7e] 三段直接验证。
      const scored = [];
      for (const x of items) {
        const r = grammarHitAny(x, q);
        if (r.hit) scored.push([r.score, x]);
      }
      // 命中词数多的排前面：搜「为什么 因为」时，
      // 两个词都命中的条目应该在只命中一个的上面。
      scored.sort((a, b) => b[0] - a[0]);
      items = scored.map((p) => p[1]);
    }

    json(res, 200, {
      ok: true,
      indexed: true,
      total: items.length,
      items,
      levels: index.levels || [],
      categories: index.categories || [],
    });
  } catch (e) {
    json(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
}

// ---------- AI（可选功能，默认关闭） ----------

/**
 * 读取 AI 配置。文件不存在/损坏都返回默认配置（**默认关闭**），绝不抛错 ——
 * 一个坏掉的配置文件不该让整个程序起不来。
 */
async function readAiConfig() {
  try {
    const text = await fsp.readFile(CONFIG_PATH, 'utf8');
    return normalizeConfig(JSON.parse(text));
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      console.warn(`[jp-learn] ${CONFIG_FILENAME} 读取失败，按"未配置"处理：${e.message}`);
    }
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * 写入 AI 配置。只写已知字段（白名单），避免把前端传来的杂项落盘。
 * 权限 0600：只有当前用户能读，其他账号读不到明文密钥。
 */
async function writeAiConfig(patch) {
  const cur = await readAiConfig();
  const next = normalizeConfig({ ...cur, ...patch });
  await fsp.writeFile(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  return next;
}

/**
 * 启动时自检：配置文件**绝不能**落在能被静态服务读到的目录里。
 *
 * 为什么要有这个：`SAFE_ROOTS` 是 [APP_DIR, DATA_DIR]，而配置文件在 ROOT。
 * 今天是对的，但**哪天有人把它挪进 app/ 或 data/，就等于把密钥挂到公网上**
 * （本地服务也是对同机所有程序开放的）。与其指望人记得，不如让程序自己喊出来。
 */
function assertConfigNotServable() {
  for (const rootDir of SAFE_ROOTS) {
    const rel = path.relative(rootDir, CONFIG_PATH);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      throw new Error(
        `${CONFIG_FILENAME} 位于可静态访问的目录（${path.basename(rootDir)}/）内，`
        + '这会把 API 密钥暴露给浏览器。请把它移回项目根目录。',
      );
    }
  }
}

/**
 * 只给"开没开、配得全不全、用哪个模型"，**不含密钥也不需要**。
 * 单独抽出来是为了让 /api/health 那行保持好读。
 */
async function aiStatus() {
  const c = configSummary(await readAiConfig());
  return { enabled: c.enabled, configured: c.configured, model: c.model };
}

async function handleAiConfigGet(req, res) {
  const cfg = await readAiConfig();
  return json(res, 200, {
    ok: true,
    // ⚠️ configSummary() 只给遮罩后的提示，不给密钥原文。
    //    test-ai.mjs 会断言这一点。
    config: configSummary(cfg),
    presets: PROVIDER_PRESETS,
    // 隐私说明由服务端下发（和 presets 同一个思路：单一来源在 tools/aiconf.js）。
    // 浏览器侧留了一份兜底副本，两边是否一致由 tools/test-render.mjs 断言。
    privacy: AI_PRIVACY_TEXT,
    file: CONFIG_FILENAME,
  });
}

async function handleAiConfigPost(req, res) {
  try {
    const raw = (await readBody(req, 256 * 1024)).toString('utf8');
    let payload;
    try {
      payload = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
    }
    // 白名单：只接受这些键。前端塞别的东西不会落盘。
    const patch = {};
    for (const k of ['enabled', 'baseURL', 'apiKey', 'model', 'temperature', 'maxTokens', 'timeoutMs']) {
      if (Object.prototype.hasOwnProperty.call(payload, k)) patch[k] = payload[k];
    }
    // 空字符串表示"清掉密钥"，而不是"把 apiKey 设为空字符串"以外的含义 —— 这里语义一致
    const next = await writeAiConfig(patch);
    return json(res, 200, { ok: true, config: configSummary(next) });
  } catch (e) {
    return json(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
}

/**
 * 真正去请求上游（OpenAI 兼容的 /chat/completions）。
 *
 * 为什么放服务端而不是浏览器直连：
 *   密钥就永远不进浏览器，也就不会出现在 localStorage / 页面内存 / 任何导出里。
 *   代价是本地服务成了一个"代理"，但它只连**用户自己填的那个地址**。
 */
async function callUpstream(cfg, messages, opts = {}) {
  const url = chatEndpoint(cfg.baseURL);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  // 输出长度预算由调用方按任务决定；没给就退回用户配置
  const maxTokens = Number.isFinite(opts.maxTokens) && opts.maxTokens > 0
    ? opts.maxTokens : cfg.maxTokens;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: cfg.temperature,
        max_tokens: maxTokens,
      }),
      signal: ctrl.signal,
    });

    const text = await resp.text();
    if (!resp.ok) {
      // 上游的错误信息里可能回显请求头 —— 这里只取 message 字段，且**不记日志**
      let detail = '';
      try {
        const j = JSON.parse(text);
        detail = (j.error && (j.error.message || j.error.type)) || '';
      } catch { /* 非 JSON 就用状态码说话 */ }
      const err = new Error(`${resp.status}${detail ? ` ${detail}` : ''}`);
      err.status = resp.status;
      throw err;
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error('上游返回的不是 JSON');
    }
    return extractContent(body);
  } finally {
    clearTimeout(timer);
  }
}

async function handleAiChat(req, res) {
  try {
    const raw = (await readBody(req, 2 * 1024 * 1024)).toString('utf8');
    let payload;
    try {
      payload = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
    }

    const cfg = await readAiConfig();
    if (!cfg.enabled) {
      return json(res, 403, {
        ok: false,
        error: 'AI 功能还没开启。到「设置 → AI」里打开，并填好地址、模型和密钥。',
        code: 'disabled',
      });
    }
    if (!isConfigured(cfg)) {
      return json(res, 403, {
        ok: false,
        error: 'AI 配置不完整。到「设置 → AI」里把地址、模型、密钥都填上。',
        code: 'unconfigured',
      });
    }

    const task = String(payload.task || 'translate');
    const text = String(payload.text || '');
    const messages = buildMessages(task, text, {
      context: payload.context ? String(payload.context) : '',
    });
    if (!messages) {
      return json(res, 400, { ok: false, error: '没有要发送的文本' });
    }
    // 可选的多轮历史（前端只在"追问"时带）
    const history = trimHistory(payload.history);
    if (history.length) messages.splice(1, 0, ...history);

    // ★★ 按任务给不同的输出长度预算 —— 见 aiconf.js 里 TASK_MAX_TOKENS 的长注释。
    //    用户报的「讲语法偶尔被长度上限截断」就是"所有任务共用一个 1200"造成的。
    const budget = maxTokensFor(task, cfg.maxTokens);
    const out = await callUpstream(cfg, messages, { maxTokens: budget });

    // 部分回答也要给用户看 —— 被截断不等于"什么都没有"。
    // 见 extractContent / callUpstream 里的说明。
    if (!out.text && !out.truncated) {
      return json(res, 502, { ok: false, error: out.reason || '上游没有返回内容' });
    }
    return json(res, 200, {
      ok: true,
      text: out.text,
      // ⚠️ truncated 为真时 text 是"被截断的半截回答"：
      //    前端要把它显示出来 + 明确提示"没说完"，
      //    而不是丢掉（旧版本就是丢掉的，用户白花一次钱还什么都看不到）。
      truncated: !!out.truncated,
      truncateHint: out.truncated ? (out.reason || '') : '',
      model: cfg.model,
      maxTokens: budget,
      // 明确告诉前端"这次到底发出去了什么"，让用户能自己核对
      sent: { task, chars: text.length, messages: messages.length },
    });
  } catch (e) {
    // ⚠️ 这里把错误翻译成人话再返回；**绝不把请求头/密钥带进消息**
    return json(res, 502, { ok: false, error: aiFailureMessage(e) });
  }
}

async function handleDiag(req, res) {
  try {
    const raw = (await readBody(req, 256 * 1024)).toString('utf8');
    if (!raw.trim()) return json(res, 400, { ok: false, error: '空请求体' });
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
    }
    const dir = path.join(ROOT, 'data', 'diag');
    await fsp.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const record = {
      receivedAt: new Date().toISOString(),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 400),
      payload,
    };
    const file = path.join(dir, `diag-${stamp}.json`);
    await fsp.writeFile(file, JSON.stringify(record, null, 2), 'utf8');
    return json(res, 200, { ok: true, saved: path.relative(ROOT, file) });
  } catch (e) {
    return json(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
}

// ---------- 路由 ----------
const handleRequest = async (req, res) => {
  // ⚠️ 目录穿越必须在**解析 URL 之前**检查原始请求行。
  //    因为 WHATWG URL 会把路径里的点段归一化掉：
  //      new URL('/js/../ARCHITECTURE.md', base).pathname  ===  '/ARCHITECTURE.md'
  //      new URL('/%2e%2e/ARCHITECTURE.md', base).pathname ===  '/ARCHITECTURE.md'
  //    也就是说恶意路径到达 serveStatic 时已经被"洗白"成合法路径，
  //    之后无论怎么检查都拦不住（实测这两种都能读到根目录文件）。
  const rawPath = String(req.url || '').split('?')[0];
  let rawDecoded = rawPath;
  try { rawDecoded = decodeURIComponent(rawPath); } catch { /* 编码非法，交给下面判断 */ }
  if (rawPath.includes('\0') || rawDecoded.includes('\0')
    || /(^|\/)\.\.(\/|$)/.test(rawPath) || /(^|\/)\.\.(\/|$)/.test(rawDecoded)) {
    return send(res, 404, '404 Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    return send(res, 204, '', {
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
  }

  // ---- 心跳：网页还开着吗？-------------------------------------------------
  // 前端每 20 秒打一次。**90 秒收不到任何一次，就认为页面已经关了，服务自己退出。**
  //
  // 为什么要"心跳 + 超时"，而不是"网页关闭时通知服务端"：
  //   1. **刷新页面会短暂断开**。关掉就立刻停的话，按 F5 那一刻服务就没了，
  //      页面直接打不开 —— 这个 bug 会非常烦人。90 秒的宽限足以覆盖刷新、
  //      后退、误关重开。
  //   2. **浏览器崩溃 / 电脑睡眠时，"关闭通知"根本发不出来**，
  //      但"心跳停了"是客观事实，两种情况都能正确收敛。
  //
  // ⚠️ 首要是**绝不能误杀**：只有在收到过至少一次心跳之后，看门狗才会启动。
  //    所以任何不发心跳的客户端（Node 测试、curl、老版本页面）都不会让服务退出，
  //    行为与加这个功能之前完全一致。
  if (p === '/api/alive' && req.method === 'POST') {
    markAlive();
    return json(res, 200, { ok: true, idleExit: idleExitEnabled(), timeoutMs: IDLE_EXIT_MS });
  }

  if (p === '/api/health') {
    const version = await readVersion();
    // OCR 探测失败（运行时没装、无权限、被拦截…）不得影响服务本身，
    // 只把状态报出去 —— 界面据此显示"去装运行时"的引导，而不是报个空白错误。
    //
    // ⚠️ 这里**故意不跑真正的 OCR 自检**（那要几秒到十几秒）。
    //    健康检查会被界面频繁调用，必须便宜。只检查文件在不在。
    const ocrInfo = ocrRuntimeReady()
      ? { ok: true, ready: true, engine: 'rapidocr+onnx', lang: 'japan', runtime: 'runtime/ocr' }
      : {
        ok: false,
        ready: false,
        engine: 'rapidocr+onnx',
        error: 'OCR 运行时还没安装',
        fix: '在项目目录里执行一次：node tools/get-ocr-runtime.mjs',
      };
    return json(res, 200, {
      ok: true, version, root: ROOT,
      node: process.version,
      platform: process.platform,
      lyric: { mode: 'user-provided-text', endpoint: '/api/lyric/parse' },
      ocr: ocrInfo,
      // 词库索引状态：前端据此提示"先去跑构建脚本"，而不是给人一个空白界面
      dict: {
        ready: dictReady(),
        error: dictError(),
        stats: dictStats(),
      },
      // AI 状态：只报"开没开、配得全不全"，**不含密钥**。
      // 每次都重新读文件 —— 用户改完 config.local.json 不用重启服务。
      ai: await aiStatus(),
      // "关掉网页自动停服务"的状态。加这个字段是为了让这件事**可见**：
      // heartbeats 不涨就说明页面没在发心跳（或已经关了）。
      idle: idleStatus(),
    });
  }

  if (p === '/api/ocr' && req.method === 'POST') return handleOcr(req, res);
  if (p === '/api/lyric/parse' && req.method === 'POST') return handleLyricParse(req, res);
  if (p === '/api/dict/lookup' && req.method === 'GET') return handleLookup(req, res, url);
if (p === '/api/deinflect' && req.method === 'GET') return handleDeinflect(req, res, url);
  if (p === '/api/analyze' && req.method === 'POST') return handleAnalyze(req, res);
  if (p === '/api/yomi' && req.method === 'GET') return handleYomi(req, res, url);
  if (p === '/api/grammar/entry' && req.method === 'GET') return handleGrammarEntry(req, res, url);
  if (p === '/api/grammar/search' && req.method === 'GET') return handleGrammarSearch(req, res, url);
  if (p === '/api/ai/config' && req.method === 'GET') return handleAiConfigGet(req, res);
  if (p === '/api/ai/config' && req.method === 'POST') return handleAiConfigPost(req, res);
  if (p === '/api/ai/chat' && req.method === 'POST') return handleAiChat(req, res);
  if (p === '/api/diag' && req.method === 'POST') return handleDiag(req, res);

  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);
  json(res, 405, { ok: false, error: 'Method Not Allowed' });
};

// ---- "关掉网页就让服务停下来" 看门狗 ----------------------------------------
//
// 背景（用户 2026-10 提出）：这个程序基本每天只启动一次，但关掉网页之后
// node 会一直挂着占 ~99 MB 内存。要求"关掉网页就停掉后台"。
//
// 内存的实测构成（留着这个数字，免得以后有人以为"优化一下"就能省下来）：
//     空 node 进程        45.4 MB   ← 只要跑就得付，省不掉
//     挂上 http 服务      54.4 MB
//     载入词库索引        98.6 MB   ← 查词/注音要用，省不掉（除非砍功能）
// 所以真正有效的办法只有"不跑的时候让它真的不跑"，即下面这个看门狗。
//
// 设计上的三条硬约束：
//   ① **默认不生效**：只有收到过心跳之后才启动看门狗。
//      任何不发心跳的客户端（Node 测试、curl、静态文件请求）行为完全不变。
//   ② **宽限期远大于"刷新耗时"**（90 秒 vs 2~8 秒），宁可多占 90 秒，也不误杀。
//   ③ **退出前必须说明原因**，不能静默消失 —— 否则用户会以为程序坏了。
//
// 关掉的办法（排错时想让它一直开着）：设环境变量 JP_LEARN_NO_IDLE_EXIT=1
//
// ⚠️ 超时用环境变量可覆盖，**这不是为了给用户调的**，是因为自动化测试
//    不能等 90 秒（那会让整个测试套变慢且容易被判超时）。
//    测试用 JP_LEARN_IDLE_EXIT_SEC=<小数字> 把它压到几秒，从而真的验证
//    "停了心跳之后服务确实会退出" —— 否则这个功能就只能靠手工看，
//    而"没人验证过的定时器"是最容易悄悄坏掉的东西。
const IDLE_EXIT_MS = (() => {
  const raw = String(process.env.JP_LEARN_IDLE_EXIT_SEC || '').trim();
  const sec = Number(raw);
  // 只接受正数；非法值一律回退到默认，绝不因此把功能关掉或变成 0 秒
  if (Number.isFinite(sec) && sec > 0) return Math.round(sec * 1000);
  return 90 * 1000;
})();

/** 是否启用了自动退出（默认启用；JP_LEARN_NO_IDLE_EXIT 非空则禁用，排错用） */
function idleExitEnabled() {
  const v = String(process.env.JP_LEARN_NO_IDLE_EXIT || '').trim();
  return v === '';
}

/** 最后一次收到心跳的时间；null = 从没收到过（此时看门狗不启动） */
let lastAliveAt = null;
/** 看门狗的定时器句柄 */
let idleTimer = null;
/** 收到过多少次心跳。**只用来观测/排错**（见 /api/health 的 idle 字段）。 */
let aliveCount = 0;

/** 收到一次心跳：记录时间并启动看门狗（重复调用是幂等的） */
function markAlive() {
  lastAliveAt = Date.now();
  aliveCount++;
  if (idleTimer || !idleExitEnabled()) return;
  // 每 5 秒查一次。用 unref() 是为了**让这个定时器自己不要撑住进程** ——
  // 否则它反而会成为"服务永远不退出"的原因（那就完全反了）。
  // 实测证实这不是多虑：一个不 unref 的 setInterval 会让
  // `server.close()` 回调跑完之后进程依然赖着不走。
  idleTimer = setInterval(checkIdle, 5000);
  if (idleTimer.unref) idleTimer.unref();
}

/**
 * 把看门狗状态报给 /api/health。
 *
 * 为什么要报出来：这个功能里"浏览器到底有没有在发心跳"是**看不见的**，
 * 只能靠猜。曾经为了确认它，得去翻被重定向到文件的日志。报出来之后
 * 一眼就能看出：heartbeats > 0 说明页面真的在发；lastAgoMs 说明还在发；
 * 页面关掉后这个数不再增长，过一会儿服务就自己退了。
 */
function idleStatus() {
  return {
    enabled: idleExitEnabled(),
    timeoutMs: IDLE_EXIT_MS,
    heartbeats: aliveCount,
    lastAgoMs: lastAliveAt === null ? null : Date.now() - lastAliveAt,
    // 看门狗只在收到过心跳之后才工作，如实说明
    watching: lastAliveAt !== null && idleTimer !== null,
  };
}

/** 看看是不是太久没人理了 */
function checkIdle() {
  if (lastAliveAt === null) return;
  const idle = Date.now() - lastAliveAt;
  if (idle < IDLE_EXIT_MS) return;
  console.log(`\n  网页已经关闭（${Math.round(idle / 1000)} 秒没有收到页面的心跳），服务自动停止。`);
  console.log('  想再用时，双击「静默启动.vbs」或桌面的「日语学习」图标即可。');
  console.log('  如果不希望它自动停，设环境变量 JP_LEARN_NO_IDLE_EXIT=1 再启动。\n');
  if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
  server.close(() => process.exit(0));
  // 兜底：万一还有 keep-alive 连接挂着导致 close() 迟迟不回调，
  // 1.5 秒后强制退出 —— 不能因为"优雅"而变成"永远不退"。
  // unref() 同样是为了这个兜底定时器自己不撑住进程。
  const hardExit = setTimeout(() => process.exit(0), 1500);
  if (hardExit.unref) hardExit.unref();
}

// 任何请求处理异常只影响这一个请求，绝不带崩整个本地服务
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((e) => {
    try { json(res, 500, { ok: false, error: String((e && e.message) || e) }); } catch {}
  });
});

server.listen(PORT, '127.0.0.1', async () => {
  const version = await readVersion();
  const line = '='.repeat(58);
  console.log(`\n${line}`);
  console.log('  日语学习应用 jp-learn  已启动');
  console.log(`${line}`);
  console.log(`  版本     : v${version}`);
  console.log(`  访问地址 : http://127.0.0.1:${PORT}/`);
  console.log(`  源码目录 : ${ROOT}`);
  console.log(`  数据目录 : ${path.join(ROOT, 'data')}`);
  console.log(`${line}`);
  console.log('  修改 app/ 或 data/ 里的文件后，刷新浏览器即可生效。');
  console.log('  用户数据保存在浏览器本地(IndexedDB)，升级代码不会影响它。');
  // 让"关掉网页会自动停"这件事可见 —— 否则用户会以为程序莫名消失了
  if (idleExitEnabled()) {
    console.log(`  关掉网页后约 ${IDLE_EXIT_MS / 1000} 秒，本服务会自动停止以释放内存。`);
    console.log('  想让它一直开着（比如排错时）：设环境变量 JP_LEARN_NO_IDLE_EXIT=1 再启动。');
  } else {
    console.log('  [注意] 已禁用"关掉网页自动停止"（JP_LEARN_NO_IDLE_EXIT 已设置），');
    console.log('         本服务会一直运行，直到你关闭本窗口或双击「停止服务.cmd」。');
  }
  console.log('  关闭本窗口即停止服务。\n');

  // 先做安全自检：密钥文件绝不能落在能被浏览器读到的目录里。
  // 这个检查故意做成"起不来"而不是"只警告" —— 密钥泄漏没有可接受的降级。
  try {
    assertConfigNotServable();
  } catch (e) {
    console.error(`\n  [严重] ${(e && e.message) || e}\n`);
    process.exit(1);
  }

  // 词库索引导入放在监听之后，避免大文件读取拖慢首次访问。
  // 失败不致命：/api/health 会把状态报出去，前端会提示去跑构建脚本。
  const t0 = Date.now();
  try {
    await initTokenizer();
    const st = dictStats();
    const counts = st && st.counts ? Object.entries(st.counts).map(([k, v]) => `${k}=${v}`).join(' ') : '';
    console.log(`  词库索引 : 已载入（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
    if (counts) console.log(`  词条统计 : ${counts}（合计 ${st.total || '?'} 条）`);
    if (st && st.lookupKeys) console.log(`  查词索引 : 表面形 ${st.lookupKeys} 个键 / 读音 ${st.readingKeys} 个键`);
    console.log('  注音能力 : 汉字注音 + 假名→罗马音（平文式/黑本式）已可用');
  } catch (e) {
    console.log(`\n  [注意] 词库索引未就绪：${(e && e.message) || e}`);
    console.log('         注音/查词接口暂时不可用，其余功能正常。修复方法：');
    console.log('           node tools/fetch-data.mjs');
    console.log('           node tools/build-romaji.mjs');
    console.log('           node tools/build-vocab.mjs');
    console.log('         （也可以直接双击 tools\\重建数据.cmd）');
  }
  console.log('');
});
