/**
 * ocrtext.js —— OCR 文本清洗（纯函数，零 DOM、零依赖）。
 *
 * 为什么单独一个文件，而不是留在 `views/jpreader.js` 里：
 *   jpreader.js 会 import ui.js，而 ui.js 建 DOM —— 在 Node 里没法直接 import。
 *   把清洗逻辑放这里，就能用 `tools/test-ocrtext.mjs` **直接单测**，
 *   不用为了测一个字符串函数去搭一整套假 DOM。
 *   （和 `counter.js` 单独存在是同一个理由。）
 *
 * ──────────────────────────────────────────────────────────────────
 * 这里做过什么、现在还剩什么用（换引擎之后必须说清楚）
 * ──────────────────────────────────────────────────────────────────
 * 这个文件最早是为 **Windows.Media.Ocr** 写的。那个引擎的特性是：
 * **在每个字符之间插一个空格**，不管那是汉字、假名还是数字：
 *
 *     「日本語を勉強しています」→ "日 本 語 を 勉 強 し て い ま す"
 *     「3月1日」                → "3 月 1 日"
 *     「りんごを3つ買った」       → "り ん ご を 3 つ 買 っ た"
 *
 * 后果（同一句话实测）：
 *   带空格 → 分词成 日｜本｜語｜を｜勉｜強｜…，注音覆盖率 **77.8%**
 *   去空格 → 分词成 日本語｜を｜勉強｜しています，注音覆盖率 **100%**
 *
 * ⚠️ 现在的引擎已经换成 rapidocr + 日文 ONNX 模型（见 ARCHITECTURE §十九），
 *    它**不会**逐字插空格，所以这段清洗对"新引擎的输出"多半是空转。
 *
 * 那为什么还要留着？两个理由：
 *   1. 用户可能从别处（手机 OCR、截图工具、别人的笔记）拿到逐字带空格的文本
 *      再粘进本程序 —— 那时候这段清洗仍然救命。
 *   2. 它是纯函数、有完整单测、零成本。删掉它省不下什么，但万一需要就得重写。
 *
 * ⚠️ 版面重建（横排/竖排、分列、排序、去注音）**不在这个文件里**，
 *    在 `ocrlayout.js`。那个才是新引擎管线的核心。
 */

/**
 * 清洗 OCR 文本。
 *
 * 规则只有一条：**空格只在"两侧都是拉丁字母"时保留**（那是真实词界，如 "my book"），
 * 其余一律删掉。日语本来就不用空格分词，所以删掉是安全的。
 *
 * @param {string} s OCR 原始输出
 * @returns {string} 清洗后的文本
 */
export function cleanOcrText(s) {
  const t = String(s ?? '')
    .replace(/\r\n?/g, '\n')      // 统一换行
    .replace(/[\u3000\t]/g, ' '); // 全角空格与制表符统一成半角空格
  const isLatin = (c) => c !== undefined && /[A-Za-z]/.test(c);
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c !== ' ') { out += c; continue; }
    const prev = out[out.length - 1];
    const next = t[i + 1];
    // 只有 "字母 空格 字母" 才留空格
    if (isLatin(prev) && isLatin(next)) out += ' ';
  }
  // 去掉行首行尾残留空格（OCR 有时会在行首带空格）
  return out.split('\n').map((l) => l.replace(/^ +| +$/g, '')).join('\n');
}

/**
 * OCR 结果是否"看起来可疑"，返回需要提醒用户的话（没有可疑之处则返回 null）。
 *
 * 为什么要有这个：OCR 会认错字，用户直接拿错字去解析会得到莫名其妙的结果，
 * 却不知道是识别的问题。宁可提前说一句。
 *
 * ⚠️ 提示语里**不要写具体引擎名**。写死了就会像这样过时：
 *     "Windows OCR 会在每个字符之间加空格" —— 换引擎之后这句话就是错的，
 *     而它恰恰会出现在用户最困惑的时候（识别结果奇怪），误导性最大。
 *     只说"识别引擎"就够了。
 */
export function ocrWarning(raw, cleaned) {
  const src = String(raw || '');
  if (!src.trim()) return '没有识别出任何文字。';
  // 全是符号/乱码（没有任何假名、汉字、字母、数字）
  if (!/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaffA-Za-z0-9]/.test(src)) {
    return '识别结果里没有可用的文字，可能图片内容不是文字。';
  }
  const removed = src.length - String(cleaned || '').length;
  if (removed > 0) {
    return `去掉了 ${removed} 个识别引擎插入的多余空格。`;
  }
  return null;
}
