/**
 * 把「内容文件」生成进等级文件。**这是语法内容的标准入口。**
 *
 * 用法：
 *   node tools/gen-grammar.mjs tools/内容-L3.mjs            # 增量合并（推荐，可反复跑）
 *   node tools/gen-grammar.mjs tools/内容-L3.mjs --replace  # 用内容文件完全覆盖该等级的条目
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么要有这个脚本（而不是每次临时写一个）
 * ────────────────────────────────────────────────────────────────────
 * 前两批内容（L1、L3）我是每次现写一个一次性生成脚本。问题出在**命名和真相**
 * 上：内容文件 `内容-L3.mjs` 的注释里写着"由 tools/gen-grammar-l3.mjs 读取"，
 * 而那个脚本早被删了 —— 于是**代码里留着一句假话**。
 *
 * 所以把它固定成一个工具，并且**目标等级文件由条目自己的 `level` 字段决定**：
 *   内容文件里写 level: 'N3'  → 进 N3.json
 *   内容文件里写 level: 'N2'  → 进 N2.json
 * 这样"名字里是几"和"进哪个文件"永远是同一件事，不可能错位 ——
 * 上一轮那 27 条 N3 的条目塞进 N5.json，就是这么错的。
 *
 * ⚠️ 这个脚本**不认识** `data/grammar/README.md` 里那个示例名
 *    `gen-语法-<层>.mjs`。README 已改成指向本文件。
 *    教训：**文档里写的路径必须真的存在**，否则下一个人会照着一个不存在的
 *    东西去建另一个不存在的名字。（这条已经犯过一次，见上面那段。）
 *
 * ────────────────────────────────────────────────────────────────────
 * 生成前自检（这些坑都真踩过）
 * ────────────────────────────────────────────────────────────────────
 *   ① id 必须小写字母数字连字符、全局唯一；
 *   ② 必填字段齐全；
 *   ③ 文案里不能有 Markdown 星号／反引号／链接（会原样露出星号）；
 *   ④ 中文讲解里不能混英文单词；
 *   ⑤ 例句必须只有日文、不能有 ASCII 空格（会让分词退化成单字）；
 *   ⑥ 一个内容文件的 level 必须统一（否则"进哪个文件"就有歧义了）。
 * 先自己查一遍，比生成完被 test-grammar.mjs 打回来效率高 ——
 * 因为这里的报错能精确到是哪一条的哪个字段。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ⚠️ 必须用 fileURLToPath：项目路径含空格，new URL().pathname 会变成 %20
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'data', 'grammar');

/**
 * 「中文里不许混英文」这条规则的**白名单**。
 *
 * 规则本身是为了防止讲解里冒出没解释的英文术语。但有一类拉丁字母是
 * **内容必须**的，不能一律枪毙（实测全库 666 条里只有 2 条会撞，且都是这类）：
 *   · `wa` / `ha` / `watashi` —— 讲助词 は 读音时的罗马字示例：
 *     「「私は」读作 watashi wa，不写成 watashi ha」。
 *     这三个片段**本身就是那条知识的全部内容**，删掉这条讲解就废了。
 *   · `AI` —— 讲精读页自动翻译时提到的技术名词，是当代汉语里的常用词。
 *
 * 为什么用白名单而不是放宽正则：
 *   放宽（比如"允许 2~4 个小写字母"）会让真正的英文单词一起溜过去，
 *   规则就形同虚设。白名单只放行**逐个确认过的那几个片段**，
 *   将来再有新片段撞上，会被拦下来让人确认一次 —— 这正是想要的行为。
 *   （教训：白名单要收紧到"确切的字符串"，不要收紧到"像它的一类字符串"。）
 */
const ALLOWED_LATIN = new Set(['wa', 'ha', 'watashi', 'AI']);

const args = process.argv.slice(2);
const replace = args.includes('--replace');
const rel = args.find((a) => !a.startsWith('--'));

if (!rel) {
  console.error('用法：node tools/gen-grammar.mjs tools/内容-<层>.mjs [--replace]');
  process.exit(2);
}

const contentPath = path.resolve(ROOT, rel);
if (!fs.existsSync(contentPath)) {
  console.error(`找不到内容文件：${rel}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 一、读内容文件。约定：导出一个非空数组（不管叫什么名字），
//     外加可选的 <名字>_SOURCE 作为来源说明。
// ---------------------------------------------------------------------------
const mod = await import(pathToFileURL(contentPath).href);
let items = null;
let source = '';
/**
 * 内容文件级（信封级）的 `line`。
 *
 * ⚠️ 这是**补上去的一个真 bug 的修法**。
 *    原来的写法只从信封里取 source，**完全没取 line**，
 *    而单条条目又几乎都不写 line —— 结果这一批批量加进去的条目
 *    全部**没有 line 字段**。实测：一次性加了 16 条之后，
 *    N5/N4/N3 里多出 16 条 `line` 缺失的条目，而所有测试都是绿的
 *    （因为 `line` 缺失只是让"按线统计"漏数，不会报错）。
 *
 *    这类"静默漏字段"的危害和之前 N5 缺 line 那次一样：
 *    界面按条目的 line 做筛选时，这些条目会在两条线里都消失。
 *    所以修法不是"把这 16 条补上"，而是**让工具不可能再漏**：
 *    line 按 单条 → 信封 → 目标文件已有值 的优先级取，且**取不到就报错**。
 */
let envelopeLine = '';
const candidates = [];
for (const [k, v] of Object.entries(mod)) {
  if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object' && v[0].id) {
    candidates.push([k, v]);
  }
  if (v && typeof v === 'object' && !Array.isArray(v)
      && Array.isArray(v.items) && v.items.length
      && v.items[0] && typeof v.items[0] === 'object' && v.items[0].id) {
    candidates.push([k + '.items', v.items]);
    // 信封上的 source / line 也认 —— 它们是最靠得住的那两个
    if (!source && typeof v.source === 'string' && v.source) source = v.source;
    if (!envelopeLine && typeof v.line === 'string' && v.line) envelopeLine = v.line;
  }
  if (/^[A-Z0-9_]*SOURCE$/.test(k) && typeof v === 'string') source = v;
  if (/^[A-Z0-9_]*LINE$/.test(k) && typeof v === 'string') envelopeLine = v;
}
// 同一个数组可能被上面两条规则同时看到（例如 default 是一个纯数组），去重
const uniq = [];
for (const c of candidates) if (!uniq.some((u) => u[1] === c[1])) uniq.push(c);
if (uniq.length > 1) {
  console.error(`内容文件里有多个条目数组（${uniq.map((u) => u[0]).join('、')}），不知道用哪个`);
  process.exit(2);
}
if (uniq.length === 1) items = uniq[0][1];
if (!items) { console.error('内容文件里没找到条目数组（需要导出 { id, ... } 组成的数组）'); process.exit(2); }

// ---------------------------------------------------------------------------
// 二、生成前自检
// ---------------------------------------------------------------------------
const problems = [];

// 等级必须统一
const levels = [...new Set(items.map((x) => x.level))];
if (levels.length !== 1) {
  problems.push(`一个内容文件里的 level 必须统一，现在是 [${levels.join(', ')}] —— `
    + '否则"进哪个等级文件"就有歧义了');
}
const LEVEL = levels[0];

// 全库已有的 id（查重范围：所有等级文件）
const usedIds = new Set();
for (const f of fs.readdirSync(DIR)) {
  if (!/^N\d\.json$/.test(f)) continue;
  const doc = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  for (const it of doc.items || []) usedIds.add(it.id);
}

// 目标文件的路径与现有内容 —— **要在自检之前读**，
// 因为 line 的兜底值要从这里取（见下面那段说明）。
const targetFile = `${LEVEL}.json`;
const targetPath = path.join(DIR, targetFile);
const doc = fs.existsSync(targetPath)
  ? JSON.parse(fs.readFileSync(targetPath, 'utf8'))
  : { schema: 1, level: LEVEL, source: source || '项目自编', line: envelopeLine || 'written', items: [] };
const docLine = typeof doc.line === 'string' && doc.line ? doc.line : '';

const seen = new Set();
for (const it of items) {
  const at = `[${it.id || '(没有 id)'}]`;
  if (!it.id) { problems.push(`${at} 缺 id`); continue; }
  if (!/^[a-z0-9-]+$/.test(it.id)) problems.push(`${at} id 里有非法字符（只能小写字母、数字、连字符）`);
  if (seen.has(it.id)) problems.push(`${at} 在内容文件里重复`);
  seen.add(it.id);

  for (const k of ['level', 'category', 'title', 'connection', 'meaning', 'examples', 'mistakes', 'tags']) {
    if (!it[k]) problems.push(`${at} 缺字段 ${k}`);
  }
  if (!Array.isArray(it.examples) || !it.examples.length) problems.push(`${at} 没有例句`);

  /**
   * `line` 必须能定下来（**这是补上去的"静默漏字段"防线**）。
   * 优先级：单条自带 > 信封 > 目标文件里已有的值。
   * 三个都没有就报错停手 —— 宁可让加内容的人补一行，也不要偷偷生成一批
   * "没有线"的条目，那种条目在按线筛选时会凭空消失，而且不报任何错。
   */
  if (!it.line && !envelopeLine && !docLine) {
    problems.push(`${at} 没有 line，而且内容文件信封和目标文件里都没有 —— `
      + '请在内容文件顶层写 line: \'jlpt\' 或 \'written\'，或在单条里写 line');
  }

  // 文案里不许有 Markdown（这些字走 textContent，会原样露出星号）
  const copy = [it.title, it.connection, it.meaning, it.detail || '',
    ...(it.examples || []).flatMap((e) => [e.zh, e.note || '']),
    ...(it.confusions || []).flatMap((c) => [c.with, c.diff, (c.example && c.example.zh) || '']),
    ...(it.mistakes || []), ...(it.tags || [])].join('\n');
  if (/\*\*|`|\[[^\]]+\]\([^)]+\)/.test(copy)) problems.push(`${at} 文案里有 Markdown 标记`);

  // 中文讲解里不许混英文单词（单字母的 A/B 对比是允许的）
  const cnOnly = [it.meaning, it.detail || '', ...(it.examples || []).map((e) => e.zh),
    ...(it.confusions || []).map((c) => c.diff), ...(it.mistakes || [])].join('\n');
  const en = (cnOnly.match(/[A-Za-z]{2,}/g) || []).filter((w) => !ALLOWED_LATIN.has(w));
  if (en.length) problems.push(`${at} 中文里混了英文：${[...new Set(en)].join(' ')}`);

  // 例句：只写日文、不能有 ASCII 空格
  for (const e of it.examples || []) {
    if (!e.ja) problems.push(`${at} 例句缺 ja`);
    else if (/\s/.test(e.ja)) problems.push(`${at} 例句含空格：${e.ja}`);
    if (!e.zh) problems.push(`${at} 例句缺 zh`);
  }
  for (const c of it.confusions || []) {
    if (!c.with || !c.diff) problems.push(`${at} confusions 缺 with/diff`);
  }
}

if (problems.length) {
  console.error(`生成前自检发现问题（${problems.length} 条）：`);
  for (const p of problems) console.error('  ✗ ' + p);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 三、写进对应等级文件
//
// ⚠️ targetFile / targetPath / doc 已经在上面（自检之前）读好了 ——
//    因为 line 的兜底值要从 doc.line 取。这里不要再读一次，
//    否则自检用的 doc 和写入用的 doc 是两个对象，会出难查的不一致。
// ---------------------------------------------------------------------------
if (doc.level && doc.level !== LEVEL) {
  console.error(`${targetFile} 的顶层 level 是 ${doc.level}，和内容文件的 ${LEVEL} 不一致 —— 停手`);
  process.exit(1);
}

// 来源要如实记录（见 data/grammar/README.md 第五节）
if (source && !String(doc.source || '').includes(source)) {
  doc.source = doc.source ? `${doc.source}；${source}` : source;
}

let added = 0;
let skipped = 0;
if (replace) {
  const fromThisFile = new Set(items.map((x) => x.id));
  const before = doc.items.length;

  /**
   * ⚠️ 这里曾经直接写 `doc.source = source || doc.source`，**会静默抹掉别的批次的来源记录**。
   *
   * 为什么这是个必须修的 bug：`source` 是**整个等级文件**累加出来的来源清单
   * （见上面那段"来源要如实记录"）。一个等级文件通常由好几个内容文件拼成，
   * 而 `--replace` 只负责**其中一个**内容文件的那几条。原来那行赋值的意思是
   * "我这次带了 source，所以文件级的 source 就换成我的"——结果
   * N4.json 里"N4 第一批/N4 第二批/N4 第三批"三行来源，会在
   * "用 --replace 单独重跑第二批"之后只剩第二批一行，**另外两批的来源没了**。
   * 来源是内容诚实性的一部分（README §7.8），丢了就再也追不回来。
   *
   * 修法：只把**本文件负责的那几条**的来源替换掉，其余来源原样保留。
   * 具体做法是记录被移除条目各自的 source，把它们从清单里摘掉，
   * 再把新的 source 追加进去。集合语义正好对应"来源是累加的"。
   */
  const removed = doc.items.filter((x) => fromThisFile.has(x.id));
  const dropped = new Set(removed.map((x) => x.source).filter((s) => typeof s === 'string' && s));
  doc.items = doc.items.filter((x) => !fromThisFile.has(x.id));
  if (source) {
    // 按分号拆开、去重、保持原有顺序，语义与下面那段累加逻辑一致
    const parts = String(doc.source || '').split('；').map((s) => s.trim()).filter(Boolean);
    const keep = parts.filter((p) => p !== source && !(dropped.has(p) && !doc.items.some((x) => x.source === p)));
    if (!keep.includes(source)) keep.push(source);
    doc.source = keep.join('；') || source;
  }
  console.log(`--replace：先移除本内容文件负责的 ${before - doc.items.length} 条`);
}
let tagMerged = 0;
for (const it of items) {
  const exist = doc.items.find((x) => x.id === it.id);
  if (exist) {
    // ⚠️ 同 id 时**只合并 tags**，其余字段一律不动。
    //
    // 为什么要有这一步（踩到的）：内容源文件是"唯一真相"，但同 id 会被跳过，
    // 于是我在内容文件里给老条目补的检索词**永远进不了数据文件**。
    // 实测：「四大假定」在内容文件里加了「四个假定」，gen-grammar 报
    // "跳过已存在"，数据文件没变，用户搜「四个假定」依然是 0 条。
    // 表现是"我明明改了啊" —— 又是那种不报错的静默失败。
    //
    // 只合并 tags（不覆盖正文）是有意的：
    // 正文可能有后续人工修订，机械覆盖会把它冲掉；
    // 而 tags 是纯粹累加的检索信息，合并只会变多、不会变错。
    if (Array.isArray(it.tags) && it.tags.length) {
      const cur = Array.isArray(exist.tags) ? exist.tags : [];
      const add = it.tags.filter((t) => !cur.includes(t));
      if (add.length) { exist.tags = cur.concat(add); tagMerged++; }
    }
    // alias 同理合并（同一语法点的其他写法，也是只增不减）
    if (Array.isArray(it.alias) && it.alias.length) {
      const cur = Array.isArray(exist.alias) ? exist.alias : [];
      const add = it.alias.filter((t) => !cur.includes(t));
      if (add.length) { exist.alias = cur.concat(add); tagMerged++; }
    }
    skipped++;
    continue;
  }
  // level 强制跟内容文件一致（它自己已经保证了统一，这里只是写进去）
  // line 按 单条 > 信封 > 目标文件已有值 的优先级定下来（见自检那段的说明）。
  // **没有兜底默认值**：三个都没有的话自检已经拦住了，走不到这里。
  const line = it.line || envelopeLine || docLine;
  doc.items.push({ ...it, level: LEVEL, line, source: it.source || source || doc.source });
  added++;
}

// 兜底：不许把别的等级的条目留在文件里（这正是"静默出错"的来源）
const wrong = doc.items.filter((x) => x.level !== LEVEL);
if (wrong.length) {
  console.error(`✗ ${targetFile} 里有 ${wrong.length} 条 level 不是 ${LEVEL}：${wrong.slice(0, 3).map((x) => x.id).join(', ')}`);
  process.exit(1);
}

doc.level = LEVEL;
fs.writeFileSync(targetPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
console.log(`已写入 data/grammar/${targetFile}：新增 ${added} 条、跳过已存在 ${skipped} 条（其中 ${tagMerged} 条只合并了 tags），现有 ${doc.items.length} 条`);
console.log('下一步：node tools/build-grammar-index.mjs && node tools/test-grammar.mjs');
