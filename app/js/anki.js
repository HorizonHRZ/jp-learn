/**
 * anki.js —— "把生词本导出成能导入 Anki 的文件"这件事的**浏览器侧**。
 *
 * 纯格式化的部分在 `app/js/exportfmt.js`（零 DOM，可直接单测，见 `tools/test-anki.mjs`）。
 * 这里只做两件事：**取数据** 和 **触发下载**。
 *
 * 为什么纯前端下载：这样用户词表不需要经过任何服务端，
 * 也就不会因为"加了个导出功能"多出一个数据外泄面。
 */
import * as vd from './vocabdata.js';
import {
  FIELDS, FIELD_LABELS, FORMATS, FORMAT_HINT,
  cleanCell, toRows, collectFrom, render, exportFilename, csvCell, mdCell,
} from './exportfmt.js';

// 纯函数原样转出去，调用方只 import 这一个模块就够了
export {
  FIELDS, FIELD_LABELS, FORMATS, FORMAT_HINT,
  cleanCell, toRows, collectFrom, render, exportFilename, csvCell, mdCell,
};

/**
 * 取出生词本（可选带上错题标记与熟练度标签）。
 *
 * @param {object} opts
 *   @param {boolean} opts.onlyMistakes 只导出错题本里的词
 *   @param {boolean} opts.withCardTags  是否补上熟练度标签（默认 true）
 */
export async function collect(options = {}) {
  const { onlyMistakes = false, withCardTags = true } = options;

  const words = await vd.listWords();

  let mistakeIds = null;
  try {
    const rows = await vd.listMistakes({ includeResolved: true });
    mistakeIds = new Set((rows || []).map((m) => m.wordId));
  } catch {
    // 错题本读不出来不该让导出整个失败 —— 顶多少两个标签
    mistakeIds = null;
  }

  let cardById = null;
  if (withCardTags) {
    try {
      const cards = await vd.allCards();
      cardById = new Map((cards || []).map((c) => [c.wordId, c]));
    } catch {
      cardById = null;
    }
  }

  let src = words || [];
  if (onlyMistakes) {
    src = mistakeIds ? src.filter((w) => mistakeIds.has(w.id)) : [];
  }

  return { rows: toRows(src, { cardById, mistakeIds }), total: src.length };
}

/** 导出需要多大数据量时的提示（词多的时候 CSV 会挺大） */
export function estimateBytes(rows, format) {
  const text = render(rows, format, { bom: format === 'csv' });
  return text.length;
}

/**
 * 生成并下载。
 *
 * @param {'tsv'|'csv'|'md'} format
 * @param {object} opts 同 collect()
 * @returns {Promise<{rows:number, filename:string, bytes:number}>}
 */
export async function exportAndDownload(format = 'tsv', opts = {}) {
  const { rows } = await collect(opts);
  const text = render(rows, format, { bom: format === 'csv' });
  const filename = exportFilename(format);
  const mime = format === 'csv'
    ? 'text/csv;charset=utf-8'
    : (format === 'md' ? 'text/markdown;charset=utf-8' : 'text/tab-separated-values;charset=utf-8');
  downloadText(filename, text, mime);
  return { rows: rows.length, filename, bytes: text.length };
}

/**
 * 把文本变成浏览器下载。
 *
 * 用 Blob + 临时 `<a>` 是纯前端下载的标准做法，不需要服务端参与。
 */
export function downloadText(filename, text, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 立刻 revoke 在部分浏览器上会打断下载，延后一点更稳
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
