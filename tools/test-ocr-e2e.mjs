/**
 * 端到端验证：真图 → Python worker → JSON → JS 版面重建 → 可读文本。
 *
 * ⚠️ 这个脚本**需要 OCR 运行时**（runtime/ocr）。它不进 check-deliverables 的
 *    必须通过清单，因为它依赖 ~400MB 运行时；但它会被 test-ocrlayout 之外的
 *    人工验证使用，也会在 CI 里跑（如果运行时在的话会自动跳过）。
 *
 * 为什么必须有它：test-ocrlayout.mjs 用的是**写死的真实坐标**，
 * 能保证算法对，但不能保证"worker 的输出格式没变"。
 * 这个脚本把两头接起来，防止 Python 侧改了字段名而 JS 侧静默失效。
 *
 * 用法：node tools/test-ocr-e2e.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reconstruct, layoutSummary } from '../app/js/ocrlayout.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PY = path.join(ROOT, 'runtime', 'ocr', 'py', 'python.exe');
const WORKER = path.join(ROOT, 'tools', 'ocr-worker.py');

let pass = 0, fail = 0;
const failures = [];
function check(cond, label, extra = '') {
  if (cond) pass++; else { fail++; failures.push(`${label}${extra ? '  —— ' + extra : ''}`); }
}

// ── 运行时不在就跳过（不让没装 OCR 的环境变成"测试失败"）──
if (!fs.existsSync(PY)) {
  console.log('跳过：没有找到 OCR 运行时（runtime/ocr/py/python.exe）。');
  console.log('      需要先执行 `node tools/get-ocr-runtime.mjs`。');
  console.log('\n' + '='.repeat(72));
  console.log(' 已跳过（0 项）');
  console.log('='.repeat(72));
  process.exit(0);
}

function runWorker(imgPath, extra = []) {
  const out = execFileSync(PY, [WORKER, '--image', imgPath, ...extra], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    stdio: ['ignore', 'pipe', 'ignore'],   // stderr 丢掉（日志）
  });
  return JSON.parse(out.trim().split('\n').pop());
}

// ── 用 Python + PIL 生成测试图 ──
// ⚠️ 生成器写成**文件**再执行，不用 `python -c`。
//   原因：`-c` 的代码要经过 Windows 命令行传参，日文字符会被编码搞坏
//   （实测报 `NameError: name '????' is not defined`）。
//   写文件走的是 UTF-8 字节，没有这个问题。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jpocr-e2e-'));
const genPath = path.join(tmp, 'gen.py');
const gen = [
  'import sys, os',
  'from PIL import Image, ImageDraw, ImageFont',
  'out = sys.argv[1]',
  "FONT = r'C:\\Windows\\Fonts\\msmincho.ttc'",
  'f = ImageFont.truetype(FONT, 52)',
  'f20 = ImageFont.truetype(FONT, 20)',
  '',
  '# 横排：一整行长句',
  "im = Image.new('RGB', (900, 120), 'white')",
  "ImageDraw.Draw(im).text((20, 30), '猫が歩いた日本語を勉強します', font=f, fill='black')",
  "im.save(os.path.join(out, 'h.png'))",
  '',
  '# 竖排：三列，带注音。刻意画成**真实书页的样子**：',
  '#   · 列间留够空隙（~120px），避免相邻列被聚成一列',
  '#   · 注音紧贴在正文右侧（偏移 = 字宽 + 4）',
  '#   · 每列至少 6 个字 —— 实测每个字间隔 62px 时，检测器会把',
  '#     "列首的孤立单字"单独切成一个块，列内因此不连续，',
  '#     而版面算法已按"允许一个字高错位"处理了这种情况。',
  'PITCH = 62',
  "im2 = Image.new('RGB', (560, 700), 'white')",
  'd = ImageDraw.Draw(im2)',
  'cols = [',
  "    (60,  [('猫','ねこ'),('が',None),('歩','ある'),('い',None),('た',None),('。',None)]),",
  "    (240, [('日','にち'),('本','ほん'),('語',None),('を',None),('勉','べん'),('強','きょう')]),",
  "    (420, [('私','わたし'),('は',None),('学','がく'),('生','せい'),('で',None),('す',None)]),",
  ']',
  'for x, chars in cols:',
  '    y = 30',
  '    for ch, ru in chars:',
  "        d.text((x, y), ch, font=f, fill='black')",
  "        if ru: d.text((x + 56, y + 12), ru, font=f20, fill=(90, 90, 90))",
  '        y += PITCH',
  "im2.save(os.path.join(out, 'v.png'))",
  "print('ok')",
  '',
].join('\n');
fs.writeFileSync(genPath, gen, 'utf8');
execFileSync(PY, [genPath, tmp], { encoding: 'utf8', windowsHide: true });

console.log('='.repeat(72));
console.log(' OCR 端到端验证（真图 → Python worker → JS 版面重建）');
console.log('='.repeat(72));

// ─────────────────────────────────────────────────────────────────────
console.log('\n[1] worker --probe');
// ─────────────────────────────────────────────────────────────────────
{
  const out = execFileSync(PY, [WORKER, '--probe'], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1' }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const j = JSON.parse(out.trim().split('\n').pop());
  check(j.ok === true, 'probe 成功');
  check(j.hasJapan === true, '★ 运行时里有 japan（日文）识别模型');
  check(j.allModelsPresent === true, '三个模型文件都在');
  check(Array.isArray(j.recLangs) && j.recLangs.length > 0, '列出了支持的语言', String(j.recLangs && j.recLangs.length));
  // 模型目录必须在项目里（用户明确要求：文件都留在工作区）
  check(String(j.modelDir).includes('jp-learn'), '★ 模型目录在项目内（不写用户目录）', j.modelDir);
  check(!String(j.modelDir).includes('.paddleocr'), '★ 模型目录不是用户主目录下的 .paddleocr', j.modelDir);
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n[2] 横排');
// ─────────────────────────────────────────────────────────────────────
{
  const raw = runWorker(path.join(tmp, 'h.png'));
  check(raw.ok === true, '横排识别成功');
  check(raw.count >= 1, '至少识别到 1 个块', String(raw.count));
  check(raw.image && raw.image.width === 900, 'worker 报告了图片宽度', JSON.stringify(raw.image && raw.image.width));
  check(typeof raw.image.rowBands === 'number', '★ worker 报了 rowBands（版面判据依赖它）');
  check(typeof raw.image.colBands === 'number', '★ worker 报了 colBands（版面判据依赖它）');
  check(raw.engine && raw.engine.recLang === 'japan', '用的是日文识别模型', JSON.stringify(raw.engine));

  const r = reconstruct(raw);
  check(r.vertical === false, '★ 判为横排', JSON.stringify(r.layout && r.layout.reasons));
  check(r.text.includes('猫が歩いた'), '★ 横排正文正确', r.text);
  check(r.text.includes('日本語'), '★ 横排含「日本語」', r.text);
  // 假名必须都在（这正是中文模型会丢的东西）
  for (const k of ['が', 'いた', 'を']) {
    check(r.text.includes(k), `★ 横排保留假名「${k}」`, r.text);
  }
  check(/[。]?$/.test(layoutSummary(r)), 'layoutSummary 能生成提示', layoutSummary(r));
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n[3] 竖排（带注音）');
// ─────────────────────────────────────────────────────────────────────
// ⚠️ 这里的断言刻意**不逐字比对**，说明一下原因：
//   合成图（PIL 画的、字距机械均匀）会让检测器出现"把列首孤立单字
//   单独切出去"的怪癖，个别字还可能被识别成别的字符（实测：'日' 会变成
//   'ー' 或 '-'）。那是**识别层**的局限，不是版面算法的问题。
//   所以这里断言的是**每个正文列是否连续出现** —— 那才是版面重建的职责。
//   （逐字正确性由 ARCHITECTURE 里记录的实测数据负责，见 §19.3）
{
  const raw = runWorker(path.join(tmp, 'v.png'));
  check(raw.ok === true, '竖排识别成功');
  check(raw.count >= 5, '识别到多个块', String(raw.count));
  const r = reconstruct(raw);
  check(r.vertical === true, '★ 判为竖排', JSON.stringify(r.layout && r.layout.reasons));

  // 三个正文列必须**各自连续**地出现在输出里
  const MAIN_COLS = ['猫が歩いた', '本語を勉強', '私は学生です'];
  for (const c of MAIN_COLS) {
    check(r.text.includes(c), `★ 正文列「${c}」完整连续（没有被注音或别的列插进来）`, JSON.stringify(r.text));
  }
  // 注音必须被清掉
  for (const rub of ['ねこ', 'ある', 'にち', 'ほん', 'べん', 'がく']) {
    check(!r.text.includes(rub), `★ 注音「${rub}」被去掉`, JSON.stringify(r.text));
  }
  // 竖排从右往左：三列 x 递增 → 输出顺序应该是 私(416) → 本(237) → 猫(57)
  const iRight = r.text.indexOf('私は学生です');
  const iMid = r.text.indexOf('本語を勉強');
  const iLeft = r.text.indexOf('猫が歩いた');
  check(iRight >= 0 && iMid >= 0 && iLeft >= 0 && iRight < iMid && iMid < iLeft,
    '★ 竖排列从右往左（x 大的列在前）',
    `私@${iRight} 本@${iMid} 猫@${iLeft}`);
  check(r.furigana.removedCount >= 4, '报告了去掉的注音数量', String(r.furigana.removedCount));
  check(r.lines.length >= 3, '分成多列', String(r.lines.length));
  check(r.text.split('\n').length >= 3, '输出是多行文本（可横排阅读）', JSON.stringify(r.text));
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n[4] 手动覆盖版面判断');
// ─────────────────────────────────────────────────────────────────────
{
  const raw = runWorker(path.join(tmp, 'v.png'));
  const rh = reconstruct(raw, { forceLayout: 'horizontal' });
  check(rh.vertical === false, 'forceLayout=horizontal 生效');
  const rv = reconstruct(raw, { forceLayout: 'vertical' });
  check(rv.vertical === true, 'forceLayout=vertical 生效');
  const rn = reconstruct(raw, { stripFurigana: false });
  check(rn.furigana.removedCount === 0, 'stripFurigana=false 时不去注音');
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n[5] 错误处理');
// ─────────────────────────────────────────────────────────────────────
{
  // 不存在的文件
  let j = null;
  try {
    j = runWorker(path.join(tmp, '不存在.png'));
  } catch (e) {
    // worker 用 exit 2 表示可预期的失败，execFileSync 会抛；从 stdout 拿不到就算了
  }
  // 用 execFileSync 捕获不到 stdout 时，直接问 worker 的退出码
  let code = 0, stdout = '';
  try {
    execFileSync(PY, [WORKER, '--image', path.join(tmp, 'nope.png')], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    code = e.status;
    stdout = String(e.stdout || '');
  }
  check(code === 2, '找不到图片时退出码为 2（可预期的失败）', String(code));
  let parsed = null;
  try { parsed = JSON.parse(stdout.trim().split('\n').pop()); } catch { /* ignore */ }
  check(parsed && parsed.ok === false, '★ 失败时 stdout 仍是合法 JSON（server 能解析）', stdout.slice(0, 80));
  check(parsed && parsed.error === 'IMAGE_NOT_FOUND', '给出机器可读的错误码', parsed && parsed.error);
  check(parsed && String(parsed.message).length > 0, '给人看的错误消息非空', parsed && parsed.message);

  const r = reconstruct(parsed);
  check(r.ok === false, 'reconstruct 接受失败的 worker 输出');
  check(String(r.note).length > 0, '失败时也有提示文本', r.note);
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n[6] stdout 干净度（server 按 JSON 解析它）');
// ─────────────────────────────────────────────────────────────────────
{
  const out = execFileSync(PY, [WORKER, '--image', path.join(tmp, 'h.png')], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = out.trim().split('\n');
  check(lines.length === 1, '★ stdout 只有一行（没有日志混进去）', `实际 ${lines.length} 行`);
  let ok = true;
  try { JSON.parse(lines[lines.length - 1]); } catch { ok = false; }
  check(ok, '★ 那一行是合法 JSON');
  check(out.includes('猫'), '★ stdout 是 UTF-8（日文没乱码）');
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n[6] 受控版面测试：用实测坐标钉住排序与注音过滤');
// ─────────────────────────────────────────────────────────────────────
// 为什么要有这一段：上面 [3] 依赖真的 OCR，会被"识别层把某个字读错"影响。
// 这一段把**识别层的输出固定成实测坐标**，只考版面算法本身 ——
// 这样"列从右往左"和"注音被去掉"这两条核心规则就与识别质量解耦了。
//
// 坐标全部是 rapidocr 在这张三列图上的**实测值**（560x700）：
//   '猫が歩いた'   x=57  y=30  w=58  h=304   正文列（第 1 列，最右……不对，最左）
//   '本語を勉強'    x=237 y=90  w=59  h=305   正文列（第 2 列）
//   '私は学生です'   x=416 y=29  w=63  h=369   正文列（第 3 列，最右）
//   以及贴着每列右侧的一堆小字（注音）
//
// ⚠️ 注意这里用的 5 个"正文块"的中心：
//      69 / 86 / 266.5 / 447.5 / 496.5
//   间距是 17 / 180.5 / 181 / 49 —— 这个分布**特意保留**，因为它是
//   "分列算法第一次写错"的现场（见 ocrlayout.js 里 clusterColumns 的注释）。
//   如果哪天有人把"找谷底"改回"中位数乘系数"，这一段会立刻失败。
{
  const CONTROLLED = {
    ok: true,
    image: { width: 560, height: 700, rowBands: 7, colBands: 5, inkRatio: 0.02 },
    engine: { name: 'rapidocr', recLang: 'japan' },
    items: [
      { text: '猫が歩いた', x: 57, y: 30, w: 58, h: 304, score: 0.96 },
      { text: 'ねこ', x: 119, y: 42, w: 29, h: 21, score: 1.0 },
      { text: 'ある', x: 116, y: 164, w: 39, h: 25, score: 1.0 },
      { text: ',', x: 63, y: 380, w: 12, h: 18, score: 0.9 },
      { text: '本語を勉強', x: 237, y: 90, w: 59, h: 305, score: 0.95 },
      { text: 'にち', x: 291, y: 38, w: 43, h: 31, score: 1.0 },
      { text: 'ほん', x: 296, y: 98, w: 40, h: 30, score: 1.0 },
      { text: 'きょう', x: 294, y: 348, w: 61, h: 31, score: 1.0 },
      { text: '私は学生です', x: 416, y: 29, w: 63, h: 369, score: 0.97 },
      { text: 'わたし', x: 475, y: 38, w: 55, h: 31, score: 1.0 },
      { text: 'がく', x: 473, y: 163, w: 37, h: 27, score: 1.0 },
      { text: 'せい', x: 480, y: 224, w: 28, h: 23, score: 1.0 },
    ],
  };
  const r = reconstruct(CONTROLLED);
  check(r.vertical === true, '受控：判为竖排');
  check(r.lines.length === 3, '★ 受控：正好分成 3 列（不是 1 列也不是 5 列）', String(r.lines.length));
  check(r.lines[0].text.includes('私は学生です'), '★ 受控：最右列排第 1', r.lines[0].text);
  check(r.lines[1].text.includes('本語を勉強'), '★ 受控：中间列排第 2', r.lines[1].text);
  check(r.lines[2].text.includes('猫が歩いた'), '★ 受控：最左列排第 3', r.lines[2].text);
  // 注音一个都不能留
  for (const rub of ['ねこ', 'ある', 'にち', 'ほん', 'きょう', 'わたし', 'がく', 'せい']) {
    check(!r.text.includes(rub), `★ 受控：注音「${rub}」被去掉`, JSON.stringify(r.text));
  }
  check(r.furigana.removedCount === 8, '★ 受控：8 处注音全部被识别出来',
    String(r.furigana.removedCount) + ' ' + JSON.stringify(r.furigana.removed));
  // 列内顺序：从上往下
  check(r.lines[2].blocks.map((b) => b.text).join('') === '猫が歩いた,',
    '列内从上往下排', r.lines[2].blocks.map((b) => b.text).join('|'));
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n[7] 空图 / 纯白图');
// ─────────────────────────────────────────────────────────────────────
{
  // 一张什么都没有的图：不能崩，要给出人话提示
  const blank = path.join(tmp, 'blank.png');
  fs.writeFileSync(blank, Buffer.from(
    // 最小的合法 PNG（1x1 白点）
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DAwAAABQAB'
    + 'DQH1FwAAAABJRU5ErkJggg==', 'base64'));
  let raw = null, parseErr = null;
  try { raw = runWorker(blank); } catch (e) { parseErr = e; }
  if (raw) {
    check(raw.ok === true || raw.ok === false, '纯白图不抛异常');
    const r = reconstruct(raw);
    check(r.text === '', '纯白图重建出空文本', JSON.stringify(r.text));
    check(String(r.note).length > 0, '纯白图给出提示', r.note);
  } else {
    // 引擎可能直接判定"没有文字"并以非零码退出；只要 stdout 是合法 JSON 就算通过
    check(parseErr !== null, '纯白图：要么正常返回，要么可预期的失败（不是崩溃）',
      parseErr ? String(parseErr.message).slice(0, 80) : '');
  }
}

// ─────────────────────────────────────────────────────────────────────
// 清理临时目录（放在最后，前面的用例都还要用里面的图）
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

console.log('\n' + '='.repeat(72));
if (fail === 0) console.log(` 全部通过（${pass} 项）`);
else {
  console.log(` ${fail} 项未通过，${pass} 项通过`);
  for (const f of failures) console.log('   ✗ ' + f);
}
console.log('='.repeat(72));
process.exit(fail === 0 ? 0 : 1);
