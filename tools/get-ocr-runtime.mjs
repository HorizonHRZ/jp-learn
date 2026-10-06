/**
 * 安装日文 OCR 运行时（便携 Python + rapidocr + 官方日文 ONNX 模型）
 *
 * ───────────────────────────────────────────────────────────────────────
 * 为什么 OCR 需要一整套 Python 运行时
 * ───────────────────────────────────────────────────────────────────────
 * 原来的方案是调用 Windows 自带的 OCR（Windows.Media.Ocr，走 PowerShell 桥）。
 * 零依赖，但**竖排日文不行**：实测同一张竖排图跑两次结果都不一样
 * （一次 `猫 が 歩 い た`，一次 `獅 が 妬 き ...`），而且 TextAngle 恒为 0，
 * 拿不到可用的版面信息。用户手上的书**全是竖排**，所以必须换引擎。
 *
 * ───────────────────────────────────────────────────────────────────────
 * 为什么是 rapidocr 而不是 PaddleOCR 官方包（两条失败路线，记下来免得重走）
 * ───────────────────────────────────────────────────────────────────────
 * ① rapidocr_onnxruntime 1.4.4 —— 只带**中文**模型
 *      现象：`猫が歩いた` → `猫步`，假名全丢
 *      注意：这**不是竖排的问题**。横排一样错。根因是包目录里只有
 *            ch_PP-OCRv4_rec_infer.onnx（中文识别），字典里没有假名；
 *            而且它**不支持 lang 参数**，传 'japan' 和传 None 结果完全一样。
 *
 * ② paddlepaddle 3.x + paddleocr —— 推理必崩
 *      现象：`NotFoundError: OneDnnContext does not have the input Filter.
 *            [operator < fused_conv2d > error]`
 *      关键：enable_mkldnn=False 和 FLAGS_use_mkldnn=0 **都拦不住**，
 *            是 paddle 自己的 MKLDNN 兼容性问题，用户机器上绕不过去。
 *            （paddlepaddle==2.6.1 也没有适配 Python 3.12 的 Windows 轮子。）
 *
 * ③ ✅ rapidocr 3.x + japan_PP-OCRv4_rec_mobile.onnx —— 走 ONNX Runtime
 *      实测：横排假名全对（ねこがあるいている / 私は学生です / きょうはいいてんきですね），
 *            竖排 '猫が歩いた' 也全对，而且注音被识别成**独立的小块**（便于几何过滤）。
 *
 * ───────────────────────────────────────────────────────────────────────
 * 落点（用户要求：项目文件都留在工作区内）
 * ───────────────────────────────────────────────────────────────────────
 *   runtime/ocr/py/       便携 Python 3.12.10 + 依赖     约 345 MB
 *   runtime/ocr/models/   三个 ONNX 模型                 约 14 MB
 *   runtime/          合计约 430 MB，且**不会**写到 C:\Users\...\.paddleocr 之类的地方
 *                     （靠 Global.model_root_dir 把模型目录钉住）
 *
 * 用法:
 *   node tools/get-ocr-runtime.mjs            # 缺什么装什么
 *   node tools/get-ocr-runtime.mjs --force    # 连 Python 一起重装
 *   node tools/get-ocr-runtime.mjs --verify   # 只检查，不下载
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const OCR_DIR = path.join(ROOT, 'runtime', 'ocr');
const PY_DIR = path.join(OCR_DIR, 'py');
const MODEL_DIR = path.join(OCR_DIR, 'models');
const PY = path.join(PY_DIR, 'python.exe');
const INFO = path.join(OCR_DIR, 'OCR-RUNTIME-INFO.json');

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const VERIFY_ONLY = argv.includes('--verify');

const log = (...a) => console.log(...a);
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

// ───────────────────────────── 固定的版本（可复现） ─────────────────────────────
// 全部钉死版本号：这几个包之间有过不兼容（见文件顶部的失败记录），
// 用浮动版本会在将来的某次安装里悄悄换掉行为。
const PY_VERSION = '3.12.10';
const PY_URL = `https://www.python.org/ftp/python/${PY_VERSION}/python-${PY_VERSION}-embed-amd64.zip`;
// 期望的 SHA256（2026-10-07 实测填入；zip 大小 10.62 MB）。
// 校验的意义：这个 zip 会被解压后**直接执行**，一旦被替换后果严重。
const PY_SHA256 = '4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3';

const PKGS = [
  'rapidocr==3.9.2',
  'onnxruntime==1.30.0',
  'opencv-python==4.11.0.86',
  'numpy==1.26.4',
  'pillow==12.3.0',
  'pyclipper==1.4.0',
  'shapely==2.1.2',
  'PyYAML==6.0.3',
  'omegaconf==2.3.1',
  'tqdm==4.70.1',
  'requests==2.34.2',
  'six==1.17.0',
  'setuptools',
  'wheel',
];
const MIRROR = 'https://pypi.tuna.tsinghua.edu.cn/simple';

const MODELS = [
  ['det', 'ch_PP-OCRv4_det_mobile.onnx'],
  ['cls', 'ch_ppocr_mobile_v2.0_cls_mobile.onnx'],
  ['rec', 'japan_PP-OCRv4_rec_mobile.onnx'],
];

// ───────────────────────────── 小工具 ─────────────────────────────
function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}
function dirSize(d) {
  if (!fs.existsSync(d)) return 0;
  let t = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    t += e.isDirectory() ? dirSize(f) : (fs.statSync(f).size || 0);
  }
  return t;
}
function runPy(args, label, quiet = false) {
  if (label) log(`  · ${label}`);
  const out = execFileSync(PY, args, {
    encoding: 'utf8', windowsHide: true, stdio: quiet ? 'pipe' : 'inherit',
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    maxBuffer: 64 * 1024 * 1024,
  });
  return out || '';
}

// ───────────────────────────── 0. 只检查模式 ─────────────────────────────
if (VERIFY_ONLY) {
  const ok = fs.existsSync(PY) && MODELS.every(([, f]) => fs.existsSync(path.join(MODEL_DIR, f)));
  log(`Python : ${fs.existsSync(PY) ? '已安装' : '缺失'}  ${PY}`);
  log(`模型   : ${MODELS.filter(([, f]) => fs.existsSync(path.join(MODEL_DIR, f))).length}/${MODELS.length}`);
  log(`合计   : ${mb(dirSize(OCR_DIR))}`);
  process.exit(ok ? 0 : 1);
}

log('='.repeat(72));
log(' 日文 OCR 运行时安装（rapidocr + 官方日文 ONNX 模型）');
log('='.repeat(72));

// ───────────────────────────── 1. 便携 Python ─────────────────────────────
fs.mkdirSync(PY_DIR, { recursive: true });
fs.mkdirSync(MODEL_DIR, { recursive: true });

if (FORCE || !fs.existsSync(PY)) {
  log(`\n[1/4] 下载便携 Python ${PY_VERSION}`);
  const zip = path.join(OCR_DIR, 'py-embed.zip');
  const r = await fetch(PY_URL);
  if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}：${PY_URL}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(zip, buf);
  log(`      已下载 ${mb(buf.length)}`);

  const got = crypto.createHash('sha256').update(buf).digest('hex');
  if (got !== PY_SHA256) {
    throw new Error(`SHA256 不匹配，已中止（不留下一个来路不明的运行时）！\n`
      + `  期望 ${PY_SHA256}\n  实际 ${got}\n`
      + `  如果你确认 python.org 换了包，把上面的"实际"值填进 PY_SHA256 再重跑。`);
  }
  log('      SHA256 校验通过');

  log('      解压…');
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${PY_DIR}' -Force`],
    { stdio: 'inherit', windowsHide: true });
  fs.rmSync(zip, { force: true });
} else {
  log(`\n[1/4] 便携 Python 已存在（${PY}）`);
}

// embeddable Python 默认**不加载 site-packages**（python312._pth 里 import site 被注释掉），
// 必须打开，否则 pip 装的包 python 看不见。这个坑很容易漏。
const pthName = fs.readdirSync(PY_DIR).find((f) => f.endsWith('._pth'));
if (pthName) {
  const p = path.join(PY_DIR, pthName);
  let s = fs.readFileSync(p, 'utf8');
  const before = s;
  if (/^\s*#\s*import\s+site/m.test(s)) s = s.replace(/^\s*#\s*import\s+site/m, 'import site');
  if (!/Lib[\\/]site-packages/.test(s)) s = s.replace(/(\r?\n)/, '$1Lib\\site-packages$1');
  if (s !== before) {
    fs.writeFileSync(p, s, 'utf8');
    log(`      已修正 ${pthName}（打开 import site + 加入 site-packages）`);
  }
}

log(`      实测：${runPy(['--version'], null, true).trim()}`);

// ───────────────────────────── 2. pip ─────────────────────────────
log('\n[2/4] 安装 pip 与依赖（走清华镜像，约 350 MB）');
const hasPip = (() => {
  try { runPy(['-m', 'pip', '--version'], null, true); return true; } catch { return false; }
})();
if (!hasPip) runPy(['-m', 'ensurepip', '--upgrade'], '安装 pip');

runPy(['-m', 'pip', 'install', '--upgrade', 'pip', '-i', MIRROR, '--quiet'], '升级 pip');
runPy(['-m', 'pip', 'install', ...PKGS, '-i', MIRROR, '--timeout', '180', '--quiet'],
  '安装 rapidocr / onnxruntime / opencv 等');

// ───────────────────────────── 3. 模型 ─────────────────────────────
log('\n[3/4] 下载日文 OCR 模型（托管在 ModelScope，约 15 MB）');
// 用一个最短的 Python 片段触发 rapidocr 的模型解析与下载。
// Global.model_root_dir 把落点**钉在工作区内**，不会污染 C:\Users\...。
const dl = [
  'import sys',
  'from rapidocr import RapidOCR',
  'from rapidocr.utils.typings import LangRec, OCRVersion, ModelType',
  'RapidOCR(params={',
  '    "Global.model_root_dir": sys.argv[1],',
  '    "Global.log_level": "warning",',
  '    "Rec.lang_type": LangRec.JAPAN,',
  '    "Rec.ocr_version": OCRVersion.PPOCRV4,',
  '    "Rec.model_type": ModelType.MOBILE,',
  '    "Det.ocr_version": OCRVersion.PPOCRV4,',
  '    "Det.model_type": ModelType.MOBILE,',
  '})',
  'print("models ready")',
].join('\n');
const out = runPy(['-c', dl, MODEL_DIR], '下载/校验模型');
log('      ' + out.trim().split('\n').pop());

// ───────────────────────────── 4. 自检 ─────────────────────────────
log('\n[4/4] 自检：用日文模型真识别一次');
const selfTest = [
  'import sys, io, json',
  'sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")',
  'import numpy as np',
  'from PIL import Image, ImageDraw, ImageFont',
  'from rapidocr import RapidOCR',
  'from rapidocr.utils.typings import LangRec, OCRVersion, ModelType',
  'f = None',
  'for c in [r"C:\\Windows\\Fonts\\msmincho.ttc", r"C:\\Windows\\Fonts\\meiryo.ttc"]:',
  '    try:',
  '        f = ImageFont.truetype(c, 52); break',
  '    except Exception: pass',
  'im = Image.new("RGB", (760, 130), "white")',
  'ImageDraw.Draw(im).text((20, 30), "ねこがあるいている", font=f, fill="black")',
  'ocr = RapidOCR(params={"Global.model_root_dir": sys.argv[1], "Global.log_level": "warning",',
  '    "Rec.lang_type": LangRec.JAPAN, "Rec.ocr_version": OCRVersion.PPOCRV4,',
  '    "Rec.model_type": ModelType.MOBILE, "Det.ocr_version": OCRVersion.PPOCRV4,',
  '    "Det.model_type": ModelType.MOBILE})',
  'r = ocr(np.array(im))',
  'print(json.dumps({"text": "".join(r.txts or [])}, ensure_ascii=False))',
].join('\n');
const res = JSON.parse(runPy(['-c', selfTest, MODEL_DIR], null, true).trim().split('\n').pop());
const expect = 'ねこがあるいている';
const pass = res.text === expect;
log(`      期望 ${expect}`);
log(`      实际 ${res.text}`);
log(`      ${pass ? '✅ 通过' : '❌ 不通过'}`);

// ───────────────────────────── 记录 ─────────────────────────────
const missing = MODELS.filter(([, f]) => !fs.existsSync(path.join(MODEL_DIR, f)));
fs.writeFileSync(INFO, JSON.stringify({
  kind: 'japanese-ocr-runtime',
  python: PY_VERSION,
  pythonSource: PY_URL,
  packages: PKGS.filter((p) => p.includes('==')),
  models: MODELS.map(([, f]) => f),
  mirror: MIRROR,
  installedAt: new Date().toISOString(),
  selfTest: { expect, got: res.text, pass },
  note: '由 tools/get-ocr-runtime.mjs 安装。这是运行时，不是源码，可以直接删掉重装。'
    + ' 模型落在 runtime/ocr/models/，不会写到用户目录。',
}, null, 2) + '\n', 'utf8');

log('\n' + '='.repeat(72));
log(` runtime/ocr 合计 ${mb(dirSize(OCR_DIR))}`);
if (missing.length) log(` ⚠️ 缺模型：${missing.map(([, f]) => f).join(', ')}`);
log(` ${pass && !missing.length ? '✅ 日文 OCR 运行时可用' : '❌ 安装未完成'}`);
log('='.repeat(72));
process.exit(pass && !missing.length ? 0 : 1);
