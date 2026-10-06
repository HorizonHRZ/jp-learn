/**
 * 通过 HTTP 接口验证 /api/ocr（真图 → server → Python → 版面重建）。
 *
 * 为什么不用 PowerShell 写这个验证：实测 PowerShell 的 here-string
 * 会把日文字符串编码搞坏（`NameError: name '????' is not defined`），
 * 那是 PowerShell 5.1 按 ANSI 解码文件导致的，和被测代码无关。
 * Node 全程按 UTF-8 处理，没有这个问题。
 *
 * ⚠️ 需要服务已经在跑（node server.js 8787）。
 * 用法：node tools/test-ocr-http.mjs [port]
 */
const PORT = process.argv[2] || '8787';
const BASE = `http://127.0.0.1:${PORT}`;

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PY = path.join(ROOT, 'runtime', 'ocr', 'py', 'python.exe');

let pass = 0, fail = 0;
const failures = [];
function check(cond, label, extra = '') {
  if (cond) pass++; else { fail++; failures.push(`${label}${extra ? '  —— ' + extra : ''}`); }
}
async function jsonPost(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch { /* ignore */ }
  return { status: r.status, body: j };
}

console.log('='.repeat(72));
console.log(` /api/ocr HTTP 端到端验证（${BASE}）`);
console.log('='.repeat(72));

// ── 服务在不在 ──
let health = null;
try {
  const r = await fetch(BASE + '/api/health');
  health = await r.json();
} catch (e) {
  console.log(`\n连不上服务（${BASE}）。请先在项目目录里运行：node server.js ${PORT}`);
  console.log('原因：' + String((e && e.message) || e));
  process.exit(1);
}
console.log('\n[1] 健康检查');
check(health.ok === true, '服务健康');
check(health.ocr && health.ocr.ready === true, '★ /api/health 报告 OCR 运行时就绪',
  JSON.stringify(health.ocr));
check(health.ocr && health.ocr.lang === 'japan', '★ 用的是日文识别模型', JSON.stringify(health.ocr));
check(health.ocr && /runtime\/ocr/.test(String(health.ocr.runtime || '')),
  '★ 运行时路径在项目内（不写用户目录）', String(health.ocr && health.ocr.runtime));

if (!fs.existsSync(PY)) {
  console.log('\nOCR 运行时未安装，跳过后面的识别验证。');
  console.log('先执行：node tools/get-ocr-runtime.mjs');
  process.exit(fail === 0 ? 0 : 1);
}

// ── 生成测试图 ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jpocr-http-'));
fs.writeFileSync(path.join(tmp, 'gen.py'), [
  'import sys, os',
  'from PIL import Image, ImageDraw, ImageFont',
  'out = sys.argv[1]',
  "F = r'C:\\Windows\\Fonts\\msmincho.ttc'",
  'f = ImageFont.truetype(F, 52); f20 = ImageFont.truetype(F, 20)',
  'PITCH = 62',
  '',
  "# 竖排三列（每列一个块，模拟真实书页）—— 一行一个字，避免检测器切碎",
  "im = Image.new('RGB', (560, 700), 'white')",
  'd = ImageDraw.Draw(im)',
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
  "im.save(os.path.join(out, 'v.png'))",
  '',
  '# 横排一行',
  "im2 = Image.new('RGB', (900, 120), 'white')",
  "ImageDraw.Draw(im2).text((20, 30), '猫が歩いた日本語を勉強します', font=f, fill='black')",
  "im2.save(os.path.join(out, 'h.png'))",
  '',
  '# ── 真正的竖排书页：一列是一个**连续的句子**，三列排在一页上 ──',
  '# 这一张是补上的，专门用来盯一个真 bug（见下面 [3b] 的说明）。',
  '# 关键点：文字必须**连续成列**，不能像上面 v.png 那样"每列一个独立短语"。',
  "PAGE = '日本語の文章を縦に書いたとき右から左へと読み進めますこれは昔から続く書き方です'",
  'PER = 13',
  'cols2 = [PAGE[i:i+PER] for i in range(0, len(PAGE), PER)]',
  'FS2, LEAD2, GAP2, MG2 = 50, 62, 70, 40',
  'W2 = MG2 * 2 + GAP2 * (len(cols2) - 1) + FS2',
  'H2 = MG2 * 2 + LEAD2 * PER',
  "im3 = Image.new('RGB', (W2, H2), 'white')",
  'd3 = ImageDraw.Draw(im3)',
  'f2 = ImageFont.truetype(F, FS2)',
  'for ci, col in enumerate(cols2):',
  '    x = W2 - MG2 - FS2 - GAP2 * ci',
  '    for ri, ch in enumerate(col):',
  "        d3.text((x, MG2 + ri * LEAD2), ch, font=f2, fill='black')",
  "im3.save(os.path.join(out, 'page_v.png'))",
  "print('ok')",
].join('\n'), 'utf8');
execFileSync(PY, [path.join(tmp, 'gen.py'), tmp], { encoding: 'utf8', windowsHide: true });

const b64 = (p) => fs.readFileSync(p).toString('base64');

// ─────────────────────────────────────────────────────────────────────
console.log('\n[2] 横排图片');
// ─────────────────────────────────────────────────────────────────────
{
  const t0 = Date.now();
  const { status, body } = await jsonPost('/api/ocr', {
    imageBase64: b64(path.join(tmp, 'h.png')), ext: 'png', layout: 'auto',
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  check(status === 200, 'HTTP 200', String(status));
  check(body && body.ok === true, 'ok=true', JSON.stringify(body && body.error));
  check(body && body.vertical === false, '★ 判为横排', String(body && body.vertical));
  check(body && /猫が歩いた/.test(body.text), '★ 横排文字正确', body && body.text);
  check(body && /[ぁ-んァ-ヶ]/.test(body.text), '★ 保留假名（中文模型会全丢）', body && body.text);
  check(body && typeof body.summary === 'string' && body.summary.length > 0,
    '给出给人看的提示', body && body.summary);
  check(body && body.engine && body.engine.recLang === 'japan', '引擎用的是 japan 模型');
  console.log(`    （耗时 ${secs} 秒，冷启动会慢一些）`);
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n[3] 竖排图片（核心场景）');
// ─────────────────────────────────────────────────────────────────────
{
  const t0 = Date.now();
  const { status, body } = await jsonPost('/api/ocr', {
    imageBase64: b64(path.join(tmp, 'v.png')), ext: 'png', layout: 'auto',
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  check(status === 200, 'HTTP 200', String(status));
  check(body && body.ok === true, 'ok=true', JSON.stringify(body && body.error));
  check(body && body.vertical === true, '★ 判为竖排', JSON.stringify(body && body.layoutReasons));
  check(body && /猫が歩いた/.test(body.text), '★ 竖排第一列正确', JSON.stringify(body && body.text));
  check(body && /本語を勉強/.test(body.text), '★ 竖排第二列连续', JSON.stringify(body && body.text));
  check(body && /私は学生です/.test(body.text), '★ 竖排第三列连续', JSON.stringify(body && body.text));
  for (const rub of ['ねこ', 'ある', 'にち', 'ほん']) {
    check(body && !body.text.includes(rub), `★ 注音「${rub}」被去掉`, JSON.stringify(body && body.text));
  }
  check(body && body.furiganaRemoved >= 4, '报告去掉的注音数', String(body && body.furiganaRemoved));
  // 从右往左
  const t = (body && body.text) || '';
  const iR = t.indexOf('私は学生です'), iM = t.indexOf('本語を勉強'), iL = t.indexOf('猫が歩いた');
  check(iR >= 0 && iM >= 0 && iL >= 0 && iR < iM && iM < iL,
    '★ 竖排列从右往左', `私@${iR} 本@${iM} 猫@${iL}`);
  check(body && Array.isArray(body.lines) && body.lines.length >= 3, '返回分行/分列结构',
    String(body && body.lines && body.lines.length));
  console.log(`    （耗时 ${secs} 秒）`);
  console.log('    识别结果：');
  for (const l of (body && body.lines) || []) console.log('      · ' + l.text);
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n[3b] 真正的竖排书页：连续文字 + 从右到左（★ 这条是补的）');
// ─────────────────────────────────────────────────────────────────────
// ⚠️ 【为什么必须单独加这一段】
//   上面 [3] 用的是"每列一个独立短语、列间留得很宽"的图。
//   那种图**根本不会触发**竖排重排那条路（每个字自成一框，框不高不窄），
//   所以它**在竖排代码完全错误的情况下依然是全绿的** —— 我实测过：
//   把列与列的映射公式写反（所有框镜像到对面那一列），[3] 照样通过。
//
//   这正是"测试通过 ≠ 功能正确"的典型：测试图的形状恰好绕开了 bug。
//   所以这一段换成**连续成句、列间较窄**的书页式竖排，
//   它才会真正走"整图转 90° → 逐列识别 → 映射回原图坐标"这条路。
//
//   断言重点不是"认得对不对"（识别有个别字错是正常的），
//   而是 **"哪一列在左边、哪一列在右边"必须对**，
//   以及 **每列的内容要连起来读得通**。
{
  const { status, body } = await jsonPost('/api/ocr', {
    imageBase64: b64(path.join(tmp, 'page_v.png')), ext: 'png', layout: 'auto',
  });
  check(status === 200, 'HTTP 200', String(status));
  check(body && body.vertical === true, '★ 判为竖排', JSON.stringify(body && body.layoutReasons));

  const lines = (body && body.lines) || [];
  // lines[0] 应当是最右列（竖排先读右边）
  const first = lines.length ? String(lines[0].text) : '';
  const all = ((body && body.text) || '').replace(/\s+/g, '');
  console.log('    识别结果：');
  for (const l of lines) console.log('      · ' + l.text);

  // ① 最右列必须拿到句首（"日本語の…"）。如果映射方向写反，
  //    最右列会拿到句尾的"書き方です"那一列 —— 这条断言就是用来钉这个的。
  check(/日本語|本語の文章/.test(first),
    '★★ 最右列拿到的是**句首**（映射方向没写反）', JSON.stringify(first));

  // ② 整页读起来必须是"句首 … 句尾"的顺序，不能是反的
  const iHead = all.indexOf('日本語');
  const iTail = all.lastIndexOf('書き方');
  check(iHead >= 0, '★ 整页里找得到句首', JSON.stringify(all.slice(0, 40)));
  check(iTail >= 0, '★ 整页里找得到句尾', JSON.stringify(all.slice(-40)));
  check(iHead >= 0 && iTail > iHead,
    '★★ 句首在句尾**之前**（整页顺序没倒）', `句首@${iHead} 句尾@${iTail}`);

  // ③ 不能把整列凭空丢掉（丢掉的情况：只识别出一列）
  check(lines.length >= 2, '★ 至少识别出 2 列（没有整列丢失）', String(lines.length));

  // ④ 内容大致对得上：允许个别字错，但正确字要占绝大多数
  const want = '日本語の文章を縦に書いたとき右から左へと読み進めますこれは昔から続く書き方です';
  const nw = want.replace(/[、。]/g, '');
  let same = 0;
  const seen = new Set();
  for (const ch of all) { if (nw.includes(ch) && !seen.has(ch)) { same++; seen.add(ch); } }
  const ratio = same / new Set(nw).size;
  check(ratio >= 0.8,
    '★★ 列内容基本认得出来（不要求逐字全对，但不许整体读错）',
    `命中 ${(ratio * 100).toFixed(0)}%（${same}/${new Set(nw).size} 种字）  识别=${JSON.stringify(all)}`);
  console.log(`    （耗时见上；本段允许个别字识别错，只钉"列的位置和顺序"）`);
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n[4] 手动覆盖版面判断');
// ─────────────────────────────────────────────────────────────────────
{
  const vImg = b64(path.join(tmp, 'v.png'));
  const a = await jsonPost('/api/ocr', { imageBase64: vImg, ext: 'png', layout: 'horizontal' });
  check(a.body && a.body.vertical === false, 'layout=horizontal 覆盖生效');
  const b = await jsonPost('/api/ocr', { imageBase64: vImg, ext: 'png', layout: 'vertical' });
  check(b.body && b.body.vertical === true, 'layout=vertical 覆盖生效');
  const c = await jsonPost('/api/ocr', { imageBase64: vImg, ext: 'png', stripFurigana: false });
  check(c.body && c.body.furiganaRemoved === 0, 'stripFurigana=false 时不去注音');
  check(c.body && c.body.text.includes('ねこ'), '★ stripFurigana=false 时注音留在文本里',
    c.body && c.body.text);
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n[5] 错误处理');
// ─────────────────────────────────────────────────────────────────────
{
  const n = await jsonPost('/api/ocr', { ext: 'png' });
  check(n.status === 400, '缺 imageBase64 返回 400', String(n.status));
  check(n.body && n.body.ok === false, 'ok=false');
  check(n.body && /imageBase64/.test(String(n.body.error)), '错误信息明确指出缺什么', n.body && n.body.error);

  // 不是图片的内容
  const bad = await jsonPost('/api/ocr', {
    imageBase64: Buffer.from('这不是图片，只是一段文字').toString('base64'), ext: 'png',
  });
  check(bad.body && bad.body.ok === false, '★ 非图片内容不会返回 200 + 乱码', JSON.stringify(bad.body && bad.body.error));
  check(bad.body && String(bad.body.error).length > 0, '非图片时给出可读错误', String(bad.body && bad.body.error).slice(0, 60));
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n[6] 隐私：临时图片必须被删掉');
// ─────────────────────────────────────────────────────────────────────
{
  const tmpDir = path.join(os.tmpdir(), 'jp-learn');
  const before = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir).filter((f) => f.startsWith('ocr-')) : [];
  await jsonPost('/api/ocr', { imageBase64: b64(path.join(tmp, 'h.png')), ext: 'png' });
  // 等一拍让 unlink 完成
  await new Promise((r) => setTimeout(r, 400));
  const after = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir).filter((f) => f.startsWith('ocr-')) : [];
  check(after.length <= before.length,
    '★ 识别用的临时图片没有被留在磁盘上', `前 ${before.length} 个 → 后 ${after.length} 个`);
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

console.log('\n' + '='.repeat(72));
if (fail === 0) console.log(` 全部通过（${pass} 项）`);
else {
  console.log(` ${fail} 项未通过，${pass} 项通过`);
  for (const f of failures) console.log('   ✗ ' + f);
}
console.log('='.repeat(72));
process.exit(fail === 0 ? 0 : 1);
