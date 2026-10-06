/**
 * exportfmt.js —— 生词本导出**格式化**（纯函数，零 DOM、零依赖）。
 *
 * 为什么和 `anki.js` 分开：
 *   导出最容易出错的地方全是**边角字符**（制表符、换行、逗号、引号、竖线），
 *   而这些用假 DOM 根本测不出来。所以把纯格式化的部分单独放这里，
 *   `tools/test-anki.mjs` 就能直接 import 并逐条断言转义对不对，
 *   不用为了测一个字符串函数去搭一整套假 DOM。
 *   （和 `counter.js`、`ocrtext.js` 单独存在是同一个理由。）
 *
 * `anki.js` 负责"取数据 + 触发浏览器下载"，它 re-export 这里的东西。
 *
 * 三种格式各有用处：
 *   · TSV —— **Anki 官方推荐的导入格式**，字段用制表符分隔，最不容易出错
 *   · CSV —— Excel 能直接打开（我们带 UTF-8 BOM，否则 Excel 会显示乱码）
 *   · Markdown —— 给人看的，能直接贴进笔记软件
 */

/** 导出字段顺序。Anki 导入时按这个顺序映射到笔记字段。 */
export const FIELDS = ['term', 'reading', 'meaning', 'example', 'level', 'tags', 'source'];

/** 给用户看的字段中文名（Markdown 表头与界面提示用） */
export const FIELD_LABELS = {
  term: '词形',
  reading: '读音',
  meaning: '释义',
  example: '例句',
  level: '等级',
  tags: '标签',
  source: '来源',
};

export const FORMATS = ['tsv', 'csv', 'md'];

/**
 * 清洗一个字段值：**抹掉所有会破坏分隔结构的东西**。
 *
 * 为什么不分别在每种格式里处理：制表符会毁 TSV，换行会毁 TSV 与 CSV 的行结构，
 * 而这两样在释义/例句里都可能出现（用户导入的词表里什么都有）。
 * 统一在这里换成空格，三种格式就都安全了。
 * 这是**有损**的，但一张单词卡里本来也不该有换行。
 */
export function cleanCell(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/\t/g, ' ')          // 制表符 → 空格（保住 TSV）
    .replace(/[\r\n]+/g, ' ')     // 换行 → 空格（保住 TSV / CSV 的行结构）
    .replace(/ {2,}/g, ' ')       // 连续空格压成一个
    .trim();
}

/** 释义：词条里 `zh` 是数组，可能有多个意思 */
function joinMeanings(zh) {
  if (Array.isArray(zh)) return zh.filter(Boolean).join('；');
  return zh ? String(zh) : '';
}

/** 取第一条例句（`ex` 里是 `{jp, zh}`），拼成"日文　中文" */
function firstExample(ex) {
  if (!Array.isArray(ex) || !ex.length) return '';
  const e = ex.find((x) => x && x.jp) || null;
  if (!e) return '';
  return e.zh ? `${e.jp}　${e.zh}` : e.jp;
}

/**
 * 把词条记录整理成导出用的行。
 *
 * @param {Array} words 生词本记录（`vocabdata.listWords()` 的产物）
 * @param {object} opts
 *   @param {Map|object} opts.cardById   SRS 卡片表（wordId → card），用来补熟练度标签
 *   @param {Set|Array}  opts.mistakeIds 错题 id 集合，用来补"错题"标签
 * @returns {Array<object>} 每行一个对象，字段见 FIELDS
 */
export function toRows(words, opts = {}) {
  const cardById = opts.cardById || null;
  const mistakeIds = opts.mistakeIds
    ? (opts.mistakeIds instanceof Set ? opts.mistakeIds : new Set(opts.mistakeIds))
    : null;
  const get = (map, k) => (map instanceof Map ? map.get(k) : (map ? map[k] : undefined));

  return (words || []).map((w) => {
    const tags = Array.isArray(w.tags) ? [...w.tags] : [];
    // 自动补两个有信息量的标签，省得用户自己标
    const card = cardById ? get(cardById, w.id) : null;
    if (card && card.state && card.state !== 'new') tags.push(card.state);
    if (mistakeIds && mistakeIds.has(w.id) && !tags.includes('错题')) tags.push('错题');

    return {
      term: cleanCell(w.term || ''),
      reading: cleanCell(w.reading || ''),
      meaning: cleanCell(joinMeanings(w.zh)),
      example: cleanCell(firstExample(w.ex)),
      level: cleanCell(w.level || ''),
      tags: tags.map(cleanCell).filter(Boolean).join(' '),
      source: cleanCell(w.source || ''),
    };
  }).filter((r) => r.term); // 没有词形的行没有意义
}

/**
 * 从"已经在手上的数据"直接准备导出行，**不访问数据库**。
 *
 * 和 `anki.js` 的 `collect()` 的区别：
 *   `collect()` 从 IndexedDB 读全部数据（整库导出用）；
 *   `collectFrom()` 拿现成的数组（页面上已经筛好、已经在内存里）——
 *   这样界面导出"当前筛选结果"时不需要再查一遍库，
 *   也让这个函数保持纯函数，能直接单测。
 *
 * @param {Array} words    词条数组
 * @param {Map|object} cardMap  wordId → SRS 卡片（用来补熟练度与错题标签）
 */
export function collectFrom(words, cardMap = null) {
  const get = (map, k) => (map instanceof Map ? map.get(k) : (map ? map[k] : undefined));
  const mistakeIds = new Set();
  if (cardMap) {
    for (const w of words || []) {
      const c = get(cardMap, w.id);
      if (c && (c.wrongCount || 0) > 0) mistakeIds.add(w.id);
    }
  }
  return { rows: toRows(words, { cardById: cardMap, mistakeIds }), total: (words || []).length };
}

/** CSV 字段：按 RFC4180 加引号，内部的 `"` 写成 `""` */
export function csvCell(v) {
  return '"' + String(v === undefined || v === null ? '' : v).replace(/"/g, '""') + '"';
}

/** Markdown 表格单元：竖线要转义，否则列会错位 */
export function mdCell(v) {
  return String(v === undefined || v === null ? '' : v).replace(/\|/g, '\\|');
}

/**
 * 渲染成最终文本。
 *
 * @param {Array<object>} rows toRows() 的产物
 * @param {'tsv'|'csv'|'md'} format
 * @param {object} opts
 *   @param {boolean} opts.bom    是否加 UTF-8 BOM（CSV 给 Excel 用时需要）
 *   @param {boolean} opts.header 是否输出表头行（默认输出）
 * @returns {string}
 */
export function render(rows, format = 'tsv', opts = {}) {
  const list = rows || [];
  const header = opts.header !== false;

  if (format === 'csv') {
    const lines = [];
    if (header) lines.push(FIELDS.map((f) => csvCell(FIELD_LABELS[f])).join(','));
    for (const r of list) lines.push(FIELDS.map((f) => csvCell(r[f])).join(','));
    // CSV 用 CRLF（RFC4180），Excel 兼容性最好
    return (opts.bom ? '\uFEFF' : '') + lines.join('\r\n') + '\r\n';
  }

  if (format === 'md') {
    const lines = [];
    if (header) {
      lines.push('| ' + FIELDS.map((f) => FIELD_LABELS[f]).join(' | ') + ' |');
      lines.push('|' + FIELDS.map(() => '---').join('|') + '|');
    }
    for (const r of list) lines.push('| ' + FIELDS.map((f) => mdCell(r[f])).join(' | ') + ' |');
    return lines.join('\n') + '\n';
  }

  // 默认 TSV：Anki 官方推荐。
  // ⚠️ **不加 BOM** —— Anki 会把 BOM 当成第一个字段名的一部分，
  // 于是"词形"这一列会变成 "\uFEFF词形"，字段映射就对不上了。
  const cell = (v) => String(v === undefined || v === null ? '' : v);
  const lines = [];
  if (header) lines.push(FIELDS.map((f) => cell(FIELD_LABELS[f])).join('\t'));
  for (const r of list) lines.push(FIELDS.map((f) => cell(r[f])).join('\t'));
  return lines.join('\n') + '\n';
}

/** 文件名（带日期，方便区分多次导出） */
export function exportFilename(format, now = new Date()) {
  const d = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const ext = format === 'md' ? 'md' : format;
  return `jp-learn-生词本-${d}.${ext}`;
}

/** 给用户看的格式说明（免得用户不知道该选哪个） */
export const FORMAT_HINT = {
  tsv: 'TSV — 导入 Anki 用这个（Anki 官方推荐格式）',
  csv: 'CSV — 用 Excel 打开用这个（已带 BOM，中文不乱码）',
  md: 'Markdown — 贴进笔记软件、或给人看',
};
