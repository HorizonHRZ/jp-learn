/**
 * 生词本导出的格式化测试（纯函数，不需要浏览器、不需要假 DOM）。
 *
 * 用法：node tools/test-anki.mjs
 *
 * 为什么重点测"边角字符"：导出格式坏掉的地方几乎全是
 * **制表符 / 换行 / 逗号 / 双引号 / 竖线** —— 一个词条释义里混进一个换行，
 * 整份 CSV 的行结构就错位，导进 Anki 会变成一堆废卡，而用户往往看不出原因。
 * 这类问题靠"导出一次看看"是发现不了的，必须按字符断言。
 */
import {
  FIELDS, cleanCell, toRows, render, csvCell, mdCell, exportFilename, FORMATS,
} from '../app/js/exportfmt.js';

let fail = 0; let pass = 0;
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
};
const eq = (a, b, label) => {
  const good = a === b;
  if (good) pass++; else fail++;
  console.log(`  ${good ? '✓' : '✗'} ${label}`);
  if (!good) { console.log(`      得到: ${JSON.stringify(a)}`); console.log(`      期望: ${JSON.stringify(b)}`); }
};

console.log('='.repeat(74));
console.log(' 生词本导出格式化测试（Anki TSV / CSV / Markdown）');
console.log('='.repeat(74));

// ---------------------------------------------------------------------------
console.log('\n[1] cleanCell：把所有会破坏分隔结构的字符抹掉');
eq(cleanCell('吃\t饭'), '吃 饭', '制表符 → 空格（保住 TSV）');
eq(cleanCell('吃\n饭'), '吃 饭', '换行 → 空格（保住行结构）');
eq(cleanCell('吃\r\n饭'), '吃 饭', 'CRLF → 空格');
eq(cleanCell('吃   饭'), '吃 饭', '连续空格压成一个');
eq(cleanCell('  吃饭  '), '吃饭', '去掉首尾空格');
eq(cleanCell(''), '', '空字符串');
eq(cleanCell(null), '', 'null 不炸');
eq(cleanCell(undefined), '', 'undefined 不炸');
eq(cleanCell(123), '123', '数字也能处理');
// 这几个字符**不该**被抹掉，它们只是需要转义
eq(cleanCell('说"话"'), '说"话"', '双引号保留（CSV 里再转义，不是删掉）');
eq(cleanCell('a,b'), 'a,b', '逗号保留（CSV 里靠引号包住）');
eq(cleanCell('a|b'), 'a|b', '竖线保留（Markdown 里再转义）');
eq(cleanCell('吃饭。'), '吃饭。', '日文标点不动');

// ---------------------------------------------------------------------------
console.log('\n[2] toRows：从词条记录整理成导出行');
{
  const words = [
    {
      id: 'jmdict:1', term: '会う', reading: 'あう', level: 'N5',
      zh: ['见面', '遇到'], tags: ['手动'],
      ex: [{ jp: '明日駅で会いましょう。', zh: '明天在车站见吧。' }],
      source: 'manual',
    },
    { id: 'jmdict:2', term: '犬', reading: 'いぬ', level: 'N5', zh: ['狗'] },
    { id: 'jmdict:3', reading: 'なし', zh: ['没有词形'] },   // 应被丢掉
  ];
  const rows = toRows(words);
  eq(rows.length, 2, '没有词形的记录被丢掉（3 条进、2 条出）');
  eq(rows[0].term, '会う', 'term 正确');
  eq(rows[0].reading, 'あう', 'reading 正确');
  eq(rows[0].meaning, '见面；遇到', '多个释义用「；」连起来');
  eq(rows[0].example, '明日駅で会いましょう。　明天在车站见吧。', '例句拼成"日文　中文"');
  eq(rows[0].level, 'N5', '等级带上了');
  eq(rows[0].tags, '手动', '用户自己的标签保留');
  eq(rows[1].example, '', '没有例句时留空，不编');
  eq(rows[1].tags, '', '没有标签时留空');

  // SRS 状态与错题标记
  const rows2 = toRows(words, {
    cardById: new Map([['jmdict:1', { wordId: 'jmdict:1', state: 'review' }]]),
    mistakeIds: new Set(['jmdict:2']),
  });
  eq(rows2[0].tags, '手动 review', '补上了熟练度标签');
  eq(rows2[1].tags, '错题', '补上了错题标签');
  // 不重复加
  const rows3 = toRows([{ id: 'x', term: 'x', tags: ['错题'] }], { mistakeIds: ['x'] });
  eq(rows3[0].tags, '错题', '已经是错题时不重复加');
  // new 状态不加标签（没有信息量）
  const rows4 = toRows([{ id: 'y', term: 'y' }], { cardById: { y: { state: 'new' } } });
  eq(rows4[0].tags, '', 'new 状态不加标签（没有信息量）');
}

// ---------------------------------------------------------------------------
console.log('\n[3] TSV：Anki 官方推荐格式');
{
  const rows = toRows([
    { id: 'a', term: '会う', reading: 'あう', zh: ['见面'], level: 'N5', ex: [{ jp: '会いましょう。' }], source: 'manual' },
    { id: 'b', term: '犬', reading: 'いぬ', zh: ['狗'], level: 'N5' },
  ]);
  const tsv = render(rows, 'tsv');
  const lines = tsv.split('\n').filter(Boolean);
  eq(lines.length, 3, '表头 + 2 行数据');
  eq(lines[0], FIELDS.map((f) => ({
    term: '词形', reading: '读音', meaning: '释义', example: '例句',
    level: '等级', tags: '标签', source: '来源',
  }[f])).join('\t'), '表头字段顺序正确');
  eq(lines[1].split('\t').length, 7, '每行 7 个字段');
  eq(lines[1].split('\t')[0], '会う', '第一列是词形');
  eq(lines[1].split('\t')[2], '见面', '释义列正确');

  // ⚠️ 关键：TSV 绝不能带 BOM。Anki 会把 BOM 当字段名的一部分，
  // 于是"词形"会变成 "\uFEFF词形"，字段映射就对不上了。
  ok(!tsv.startsWith('\uFEFF'), 'TSV 不带 BOM（否则 Anki 认不出第一列）');
  ok(!tsv.includes('\r'), 'TSV 用 LF 换行（Anki 两边都认，但 LF 更标准）');
  // 每行的制表符数量必须**恰好是字段数−1**。
  // 第一版我写的是"不许出现连续制表符"，这是错的：
  // 空字段本来就该渲染成两个挨着的制表符（那是 TSV 表达"空值"的正常方式）。
  // 真正要防的是"字段数对不上"，所以直接数字段数。
  for (const [i, line] of lines.entries()) {
    const tabs = (line.match(/\t/g) || []).length;
    ok(tabs === FIELDS.length - 1, `第 ${i + 1} 行制表符数 = 字段数−1（${tabs}）`);
  }
  ok(lines[1].includes('\t\t'), '空字段渲染成两个挨着的制表符（TSV 的正常空值写法）');

  // 恶意字符：释义里带制表符/换行也不能破坏结构
  const nasty = toRows([{ id: 'n', term: 'x', zh: ['a\tb\nc'], ex: [{ jp: 'e\tf' }] }]);
  const nastyTsv = render(nasty, 'tsv');
  const nastyLines = nastyTsv.split('\n').filter(Boolean);
  eq(nastyLines.length, 2, '恶意字符不会多出额外行');
  eq(nastyLines[1].split('\t').length, 7, '恶意字符不会多出额外列');
}

// ---------------------------------------------------------------------------
console.log('\n[4] CSV：Excel 能打开（带 BOM）');
{
  const rows = toRows([
    { id: 'a', term: '会う', reading: 'あう', zh: ['见面'], level: 'N5' },
    { id: 'b', term: '说"话"', reading: 'はなす', zh: ['说话，讲话'], level: 'N4' },
  ]);
  const csv = render(rows, 'csv', { bom: true });
  ok(csv.startsWith('\uFEFF'), 'CSV 带 UTF-8 BOM（否则 Excel 里中文是乱码）');
  const lines = csv.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
  eq(lines.length, 3, '表头 + 2 行数据（CRLF 分隔）');
  eq(lines[0], '"词形","读音","释义","例句","等级","标签","来源"', '表头每个字段都加了引号');
  ok(lines[2].includes('"说""话"""'), '双引号按 RFC4180 转成两个双引号');
  ok(lines[2].includes('"说话，讲话"'), '逗号被引号包住，不会裂成两列');

  // csvCell 单独测
  eq(csvCell('a"b'), '"a""b"', 'csvCell 转义双引号');
  eq(csvCell(''), '""', 'csvCell 空值也是空引号对');
  eq(csvCell(null), '""', 'csvCell null 不炸');
  // 不带 BOM 时就不该有 BOM
  ok(!render(rows, 'csv').startsWith('\uFEFF'), '不要求 BOM 时就不加');
}

// ---------------------------------------------------------------------------
console.log('\n[5] Markdown：给人看，竖线必须转义');
{
  const rows = toRows([
    { id: 'a', term: 'A|B', reading: 'x', zh: ['含|竖线'], level: 'N5' },
  ]);
  const md = render(rows, 'md');
  const lines = md.split('\n').filter(Boolean);
  eq(lines.length, 3, '表头 + 分隔行 + 1 行数据');
  ok(/^\| 词形 \| 读音 \|/.test(lines[0]), '表头是 Markdown 表格');
  ok(/^\|---\|---\|/.test(lines[1]), '有 Markdown 分隔行');
  ok(lines[2].includes('A\\|B'), '单元格里的竖线被转义（否则列会错位）');
  ok(lines[2].includes('含\\|竖线'), '释义里的竖线也被转义');
  // 转义后每行的竖线数量应该一致
  const pipes = (s) => (s.match(/(?<!\\)\|/g) || []).length;
  eq(pipes(lines[0]), pipes(lines[2]), '转向后表头与数据行的真竖线数量一致');
  eq(mdCell('a|b'), 'a\\|b', 'mdCell 转义竖线');
  eq(mdCell('已经\\|转义'), '已经\\\\|转义', 'mdCell 对已有反斜杠也安全');
}

// ---------------------------------------------------------------------------
console.log('\n[6] 空数据与边界');
{
  eq(render([], 'tsv').split('\n').filter(Boolean).length, 1, '空数据时只有表头');
  eq(render([], 'tsv', { header: false }), '\n', '空数据且不要表头时只有换行');
  // 空数据默认仍然有表头（这样导出的文件用 Excel 打开也能看懂是什么）
  eq(render([], 'csv').replace(/^\uFEFF/, ''), '"词形","读音","释义","例句","等级","标签","来源"\r\n',
    '空数据 CSV 仍有表头（默认输出表头）');
  eq(render([], 'csv', { header: false }), '\r\n', '空数据且不要表头时只有 CRLF');
  eq(render([], 'md').split('\n').filter(Boolean).length, 2, '空 Markdown 有表头+分隔行');
  eq(render([], 'md', { header: false }), '\n', '空数据且不要表头时 Markdown 只有换行');
  eq(render(toRows([]), 'tsv'), render([], 'tsv'), 'toRows([]) 与 [] 等价');
  eq(render(null, 'tsv').split('\n').filter(Boolean).length, 1, 'null 不炸');
  // 未知格式退回 TSV（不抛错，导出不该因为一个参数就失败）
  eq(render([{ term: 'x' }], 'bogus'), render([{ term: 'x' }], 'tsv'), '未知格式退回 TSV');
}

// ---------------------------------------------------------------------------
console.log('\n[7] 字段契约（改了要同步改测试与文档）');
eq(FIELDS.length, 7, '7 个字段');
eq(FIELDS.join(','), 'term,reading,meaning,example,level,tags,source', '字段顺序固定');
eq(FORMATS.join(','), 'tsv,csv,md', '三种格式');
// 注意：文件名前面有 "jp-learn-生词本-" 前缀，所以数字**不在开头**。
// 第一版我把正则写成 /^\d{8}\./，忘了前缀，断错了自己刚写的实现。
eq(exportFilename('tsv', new Date(2026, 9, 7)), 'jp-learn-生词本-20261007.tsv',
  '文件名 = 前缀 + 日期 + 扩展名（2026 年 10 月 7 日）');
eq(exportFilename('md', new Date(2026, 0, 3)), 'jp-learn-生词本-20260103.md',
  '月份/日期补零（1 月 3 日 → 0103）');
eq(exportFilename('csv').split('.').pop(), 'csv', 'CSV 扩展名正确');
ok(/\d{8}\.(tsv|csv|md)$/.test(exportFilename('csv')), '文件名以 8 位日期 + 扩展名结尾');

// ---------------------------------------------------------------------------
console.log('\n[8] 真实数据能跑通（用内置词库的前 20 条）');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/vocab/n5.json'), 'utf8'));
  const words = (raw.words || raw.items || []).slice(0, 20);
  const rows = toRows(words);
  ok(rows.length > 0, `真实词条能转换成导出行（${rows.length} 行）`);
  // 真实数据里必须没有制表符/换行残留，否则说明 cleanCell 漏了
  const bad = rows.filter((r) => FIELDS.some((f) => /[\t\r\n]/.test(r[f])));
  ok(bad.length === 0, '真实数据里没有残留的制表符/换行',
    bad.slice(0, 2).map((r) => r.term).join(', '));
  for (const fmt of FORMATS) {
    const text = render(rows, fmt, { bom: fmt === 'csv' });
    ok(text.length > 0, `${fmt} 能渲染出内容（${text.length} 字符）`);
  }
}

console.log('\n' + '='.repeat(74));
console.log(fail === 0 ? ` 全部通过（${pass} 项）` : ` ${fail} 项未通过（通过 ${pass} 项）`);
console.log('='.repeat(74));
process.exit(fail === 0 ? 0 : 1);
