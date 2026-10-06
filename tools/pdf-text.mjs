/**
 * pdf-text.mjs —— 从 PDF 里取文字（**只针对本项目的这一份文件**，不是通用库）
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么自己写
 * ────────────────────────────────────────────────────────────────────
 * 这个项目是**零依赖**的（`audit-phases.mjs` 里有一条断言专门守"不许有
 * package.json / node_modules"）。而运行时里没有任何 PDF 库：
 *   fitz / pypdf / PyPDF2 / pdfplumber / pdfminer / pikepdf —— 全都没有。
 * 为了一份 PDF 去装一个库，代价是打破"零依赖"这条线，不值。
 *
 * 好在**只需要支持这一份文件**。探针实测出的结构：
 *   · PDF 1.7，**5 页**，685 KB
 *   · 7 个 CID 字体（Type0 / CIDFontType2，Identity-H 编码）
 *     → 内容流里是 `<22545ACC>` 这种**十六进制字形 id**，必须查 ToUnicode 才能变回文字
 *   · 交叉引用是**压缩的**（/XRef + /ObjStm）
 *     → 所以**不解析对象树**，直接全文搜 `N 0 obj … endobj`
 *   · 文字操作符只用 `BT/ET/Tf/Tm/TJ`（没有 Td/TD/T*）
 *     → 布局完全靠 `Tm` 的坐标，必须把坐标留下来才能还原表格
 *
 * 刻意**不做**的事（这份文件用不到，做了就是给自己埋 bug）：
 * 不做通用 PDF 解析、不处理加密、不处理 LZW/JPX 等其它滤镜、
 * 不处理 Type3 字体、不做连字/双向文字。
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

// ---------------------------------------------------------------------------
// 1. 把每个对象切成 `N 0 obj … endobj`（不解析对象树，那需要处理 /XRef 压缩）
// ---------------------------------------------------------------------------
function sliceObjects(buf) {
  const S = buf.toString('latin1');
  const objs = new Map();
  const re = /(\d+)\s+\d+\s+obj\b/g;
  let m;
  while ((m = re.exec(S))) {
    const num = Number(m[1]);
    const start = m.index + m[0].length;
    const end = S.indexOf('endobj', start);
    if (end < 0) continue;
    objs.set(num, { head: S.slice(start, Math.min(end, start + 4000)), bodyStart: start, bodyEnd: end });
  }
  return { S, objs };
}

/**
 * 取对象里 `stream … endstream` 的**原始字节**。
 *
 * 这里踩过一个很贵、很难查的坑，必须记下来：
 *   第一版写的是 `S.indexOf('stream', idx)` —— **没有限制搜索范围**。
 *   二进制流里出现 `stream` 这六个 ASCII 字节是**很常见**的（实测就在内容流里），
 *   于是它定位到了流内部的假 `stream`，取出一段完全错位的数据；
 *   而错位数据**看起来像压缩数据**，于是"解压失败 → 返回 null → 这个对象被静默跳过"。
 *   症状是"ToUnicode 表 0 项"、日文全空白，**一路不报错**。
 *
 *   所以：搜索 `stream` 关键字**只在字典范围内**（本对象头之后、到 `endobj` 之前）。
 *   这是"在二进制数据里做文本搜索"的通用教训 —— 一定要框范围。
 */
function streamBytes(buf, S, o, objNum) {
  const dictStart = o && o.bodyStart !== undefined ? o.bodyStart : S.indexOf(`${objNum} 0 obj`);
  if (dictStart < 0) return null;
  const dictEnd = o && o.bodyEnd !== undefined ? o.bodyEnd : S.indexOf('endobj', dictStart);
  const sIdx = S.indexOf('stream', dictStart);
  if (sIdx < 0 || sIdx > dictEnd) return null;
  let dataStart = sIdx + 'stream'.length;
  if (S[dataStart] === '\r') dataStart++;
  if (S[dataStart] === '\n') dataStart++;
  const eIdx = S.indexOf('endstream', dataStart);
  if (eIdx < 0) return null;
  let raw = buf.subarray(dataStart, eIdx);
  if (raw.length && raw[raw.length - 1] === 0x0a) raw = raw.subarray(0, raw.length - 1);
  if (raw.length && raw[raw.length - 1] === 0x0d) raw = raw.subarray(0, raw.length - 1);
  return raw;
}

function inflateMaybe(raw, head) {
  if (!raw) return null;
  if (!/\/FlateDecode/.test(head)) return raw;
  return zlib.inflateSync(raw);       // 不吞异常：解压失败就是真失败，必须暴露
}

// ---------------------------------------------------------------------------
// 2. 解析 ToUnicode CMap：字形 id（十六进制）→ Unicode 字符串
// ---------------------------------------------------------------------------
/**
 * 十六进制串 → 文字。
 *
 * **Node 没有 `utf16be` 这个编码**（只有 `utf16le`）。
 * 第一版写的是 `Buffer.from(hex, 'hex').toString('utf16be')` —— 它**抛异常**，
 * 而异常被外层的 `catch {}` 吞掉了，表现是"ToUnicode 表 0 项"、日文全变空白，
 * **一路不报错**。教训：空着的 `catch {}` 会把"我写错了"伪装成"这份数据里没有"。
 * 这里改成显式交换字节序，并且调用方不再吞异常。
 */
function hexToStr(hex) {
  const b = Buffer.from(hex.replace(/[^0-9A-Fa-f]/g, ''), 'hex');
  if (b.length % 2) return b.toString('latin1');
  const swapped = Buffer.alloc(b.length);
  for (let i = 0; i < b.length; i += 2) { swapped[i] = b[i + 1]; swapped[i + 1] = b[i]; }
  return swapped.toString('utf16le');
}

function parseToUnicode(text) {
  const map = new Map();
  for (const blk of text.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) {
    for (const m of blk.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(m[1], 16), hexToStr(m[2]));
    }
  }
  for (const blk of text.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
    for (const m of blk.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g)) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
      if (m[4]) {
        const base = hexToStr(m[4]);
        for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, shiftLastChar(base, c - lo));
      } else if (m[5]) {
        const items = [...m[5].matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => hexToStr(x[1]));
        items.forEach((s, i) => map.set(lo + i, s));
      }
    }
  }
  return map;
}
/** bfrange 的自增：只对最后一个 UTF-16 单元加偏移（够本文件用了） */
function shiftLastChar(s, delta) {
  if (!s.length) return s;
  const cp = s.codePointAt(s.length - 1);
  return s.slice(0, -1) + String.fromCodePoint(cp + delta);
}

// ---------------------------------------------------------------------------
// 3. 解析内容流：只认 BT/ET/Tf/Tm/TJ，把 (x, y, text) 取出来
// ---------------------------------------------------------------------------
function decodeHexRun(hex, cmap) {
  // Identity-H：**两个字节一个字形 id**
  let out = '';
  for (let i = 0; i + 4 <= hex.length; i += 4) {
    out += cmap.get(parseInt(hex.slice(i, i + 4), 16)) ?? '';
  }
  return out;
}
function decodeLiteralRun(bytes, cmap) {
  let out = '';
  for (const b of bytes) out += b >= 32 ? cmap.get(b) ?? String.fromCharCode(b) : '';
  return out;
}

function parseContent(content, cmap) {
  const runs = [];
  const s = content.toString('latin1');
  let x = 0, y = 0;
  const tok = /\/F\d+\s+[\d.]+\s+Tf|1 0 0 1 ([\d.-]+) ([\d.-]+) Tm|\[((?:[^\[\]\\]|\\.)*)\]\s*TJ/g;
  let m;
  while ((m = tok.exec(s))) {
    if (m[1] !== undefined) {
      x = parseFloat(m[1]); y = parseFloat(m[2]);
    } else if (m[3] !== undefined) {
      let text = '';
      for (const part of m[3].matchAll(/<([0-9A-Fa-f]*)>|\(((?:\\.|[^\\()])*)\)|(-?[\d.]+)/g)) {
        if (part[1] !== undefined) text += decodeHexRun(part[1], cmap);
        else if (part[2] !== undefined) {
          const bytes = [];
          for (let i = 0; i < part[2].length; i++) {
            if (part[2][i] === '\\') {
              i++;
              const c = part[2][i];
              bytes.push(c === 'n' ? 10 : c === 'r' ? 13 : c === 't' ? 9 : c.charCodeAt(0) & 0xff);
            } else bytes.push(part[2].charCodeAt(i) & 0xff);
          }
          text += decodeLiteralRun(bytes, cmap);
        }
      }
      if (text) runs.push({ x, y, text });
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------
// 4. 按坐标把 runs 拼成行（同一 y 的合成一行，按 x 排序）
// ---------------------------------------------------------------------------
function runsToLines(runs) {
  const YTOL = 2.5;             // 同一行的 y 容差（磅）
  const rows = [];
  for (const r of runs.slice().sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows.find((q) => Math.abs(q.y - r.y) <= YTOL);
    if (row) row.parts.push(r);
    else rows.push({ y: r.y, parts: [r] });
  }
  for (const row of rows) row.parts.sort((a, b) => a.x - b.x);
  return rows.sort((a, b) => b.y - a.y);
}

/** 把一行拼成字符串：间距明显变大时插两个空格（保留表格的列） */
function lineText(row, gapThreshold = 8) {
  let out = '';
  let prevEnd = null;
  for (const p of row.parts) {
    const w = p.text.length * 6;   // 粗略估宽，只用来判断"要不要插空格"
    if (prevEnd !== null && p.x - prevEnd > gapThreshold) out += '  ';
    out += p.text;
    prevEnd = p.x + w;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5. 主流程
// ---------------------------------------------------------------------------
export function extractPdf(file) {
  const buf = fs.readFileSync(file);
  const { S, objs } = sliceObjects(buf);

  // 5a. 所有 /ToUnicode 引用的 CMap
  //
  // 这里**不吞异常**。第一版用 `catch {}` 空着，结果"ToUnicode 表 0 项"
  // 这个症状看起来像"这份 PDF 没有映射表"，实际是我自己代码在抛。
  // 吞异常 = 把自己的 bug 伪装成数据的特征，所以出错必须说出来。
  const globalCmap = new Map();
  const cmapDetail = [];
  const cmapErrors = [];
  for (const [num, o] of objs) {
    if (!/\/ToUnicode/.test(o.head)) continue;
    const ref = o.head.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
    if (!ref) { cmapErrors.push(`字体对象 ${num}: /ToUnicode 后面不是对象引用`); continue; }
    const cn = Number(ref[1]);
    const co = objs.get(cn);
    if (!co) { cmapErrors.push(`字体对象 ${num}: 引用的 CMap 对象 ${cn} 不存在`); continue; }
    const raw = streamBytes(buf, S, co, cn);
    if (!raw) { cmapErrors.push(`CMap 对象 ${cn}: 取不到 stream`); continue; }
    let data;
    try { data = inflateMaybe(raw, co.head); }
    catch (e) { cmapErrors.push(`CMap 对象 ${cn}: 解压失败 —— ${e.message}`); continue; }
    if (!data) { cmapErrors.push(`CMap 对象 ${cn}: 解压后为空`); continue; }
    let map;
    try { map = parseToUnicode(data.toString('latin1')); }
    catch (e) { cmapErrors.push(`CMap 对象 ${cn}: 解析抛异常 —— ${e.message}`); continue; }
    cmapDetail.push({ fontObj: num, cmapObj: cn, size: map.size });
    for (const [k, v] of map) if (!globalCmap.has(k)) globalCmap.set(k, v);
  }

  // 因为不解析对象树，无法把内容流里的 `/F1` 可靠地对应到某个具体字体对象，
  // 所以**用合并后的总表**。不同字体的字形 id 在本文件里不冲突，
  // 实测能正确还原；真的冲突时会取先写入的那条，这是已知局限。
  // （本文件的 7 个 CMap 加起来只有几十到几百项，合并的代价可以忽略。）

  // 5b. 页面对象：/Type /Page（不是 /Pages），按对象号顺序
  const pageNums = [];
  for (const [num, o] of objs) {
    if (/\/Type\s*\/Page[^s]/.test(o.head) && /\/Contents/.test(o.head)) pageNums.push(num);
  }
  pageNums.sort((a, b) => a - b);

  const pages = [];
  for (const pn of pageNums) {
    const o = objs.get(pn);
    const refs = [];
    const cm = o.head.match(/\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/);
    if (cm) for (const r of cm[1].matchAll(/(\d+)\s+\d+\s+R/g)) refs.push(Number(r[1]));
    let content = Buffer.alloc(0);
    for (const r of refs) {
      const ro = objs.get(r);
      if (!ro) continue;
      const raw = streamBytes(buf, S, ro, r);
      if (!raw) continue;
      let data;
      try { data = inflateMaybe(raw, ro.head); } catch { continue; }
      if (data) content = Buffer.concat([content, Buffer.from('\n'), data]);
    }
    if (!content.length) continue;
    const runs = parseContent(content, globalCmap);
    pages.push({ page: pages.length + 1, obj: pn, lines: runsToLines(runs) });
  }
  return { pages, cmapSize: globalCmap.size, cmapDetail, cmapErrors, fontObjects: cmapDetail.length };
}

export { lineText, parseToUnicode, hexToStr, sliceObjects, streamBytes };

// 命令行：
//   node tools/pdf-text.mjs <file.pdf>              直接打出来看
//   node tools/pdf-text.mjs <file.pdf> --md <out>   导出成 Markdown（供逐页人工过目）
if (process.argv[1] && process.argv[1].endsWith('pdf-text.mjs')) {
  const f = process.argv[2];
  if (!f) { console.error('用法: node tools/pdf-text.mjs <file.pdf> [--md <out.md>]'); process.exit(1); }
  const { pages, cmapSize, cmapDetail, cmapErrors } = extractPdf(f);
  const mdIdx = process.argv.indexOf('--md');
  const mdOut = mdIdx > 0 ? process.argv[mdIdx + 1] : '';

  console.log(`  页数 ${pages.length}，ToUnicode 表 ${cmapSize} 项`);
  console.log(`  各 CMap: ${cmapDetail.map((c) => `字体${c.fontObj}→CMap${c.cmapObj}:${c.size}项`).join('  ')}`);
  if (cmapErrors.length) console.log(`  ⚠️ CMap 错误 ${cmapErrors.length} 条：\n    ${cmapErrors.join('\n    ')}`);

  if (mdOut) {
    let out = `# ${f}\n\n- 页数 ${pages.length}\n- ToUnicode 表 ${cmapSize} 项\n`;
    out += `- 各 CMap：${cmapDetail.map((c) => `字体${c.fontObj}→CMap${c.cmapObj}:${c.size}项`).join('；')}\n`;
    out += `- 提取错误 ${cmapErrors.length} 条${cmapErrors.length ? '：' + cmapErrors.join(' / ') : ''}\n`;
    for (const p of pages) {
      out += `\n## 第 ${p.page} 页（对象 ${p.obj}，${p.lines.length} 行）\n\n\`\`\`\n`;
      for (const row of p.lines) out += lineText(row) + '\n';
      out += '```\n';
    }
    fs.writeFileSync(mdOut, out, 'utf8');
    console.log(`  已写 ${mdOut}（${out.length} 字）`);
    for (const p of pages) {
      const nonEmpty = p.lines.filter((r) => lineText(r).trim()).length;
      console.log(`    第 ${p.page} 页: ${p.lines.length} 行（非空 ${nonEmpty}）`);
    }
  } else {
    for (const p of pages) {
      console.log(`\n  ===== 第 ${p.page} 页（${p.lines.length} 行）=====`);
      for (const row of p.lines) console.log('  ' + lineText(row));
    }
  }
}
