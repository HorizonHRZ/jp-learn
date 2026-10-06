/**
 * 语法数据校验（纯数据检查，不需要浏览器、不需要起服务）。
 *
 * 用法：node tools/test-grammar.mjs
 *
 * 为什么需要它：语法内容会**持续增长**（现在是 10 条样例，以后几百条），
 * 而内容是最容易出错的地方 —— 漏字段、id 重复、索引和正文不一致、
 * 例句里忘了写中文……这些靠人眼看是看不完的。
 * 这个脚本把"格式对不对"变成机器能查的事，加内容时跑一下就放心了。
 *
 * 它同时守住一条**诚实要求**：`source` 字段必须如实写（见 data/grammar/README.md 第五节）。
 * 项目别的地方就吃过教训（jmdict-cn 的中文释义是模型生成的，文档里如实标了）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'data', 'grammar');

// 等级清单**扫目录**得出，不写死。写死的清单会在新增等级时静默漏查
// （check-grammar-dup.mjs 就因为写死 N5..N2、漏了 N1 而报过假失败）。
const LEVELS = fs.readdirSync(DIR)
  .filter((f) => /^N\d+\.json$/.test(f))
  .map((f) => f.replace(/\.json$/, ''))
  .sort();

let fail = 0; let pass = 0;
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
};

console.log('='.repeat(74));
console.log(' 语法数据校验');
console.log('='.repeat(74));

if (!fs.existsSync(DIR)) {
  console.log(`\n找不到 ${DIR}\n（如果还没做语法功能，这个脚本应当被跳过）`);
  process.exit(1);
}

// ⚠️ 必须显式排除 relations.json —— 它住在同一个目录里，但它**不是等级文件**，
//    （它是"条目之间的关系表"，没有 items / level 字段）。
//    ⚠️ 而且正则里那个点**必须转义**：原来写的是 `.json`，点在正则里是
//    "任意字符"，所以 relations.json 也能过。踩到过两次（build-grammar-index
//    和这里各一次），症状都是"多出一个假等级 / 报两条莫名其妙的断言失败"。
// ⚠️ `yilanbiao.json` 也住在同一个目录里，但它**不是等级文件** ——
//    它是"一览表"（助词/副词/接续词/疑问词 的词表），没有 items / level 字段，
//    而且**故意**不走语法条目的那套结构（见 ARCHITECTURE §38）。
//    它由 `tools/check-yilanbiao.mjs` 单独校验。
//    放它进来的症状和当初 relations.json 那次一模一样：
//    "多出一个假等级 + 两条莫名其妙的断言失败"。
const NOT_LEVEL_FILE = new Set(['index.json', 'relations.json', 'yilanbiao.json']);
const levelFiles = fs.readdirSync(DIR)
  .filter((f) => /^[A-Za-z0-9]+\.json$/.test(f) && !NOT_LEVEL_FILE.has(f))
  .sort();

console.log(`\n[1] 等级文件与索引`);
ok(levelFiles.length > 0, `找到 ${levelFiles.length} 个等级文件`, levelFiles.join(', '));
ok(fs.existsSync(path.join(DIR, 'index.json')), 'index.json 存在');

// ★ 反向验证锚点：relations.json 住在同一个目录里，但**不是等级文件**，必须被排除。
//   曾经因为正则里的 `.` 没转义（`.json` 匹配任意字符）而把它收进来，
//   症状是索引里多出一个叫 "relations" 的假等级，以及两条莫名其妙的断言失败。
//   所以这里直接卡死"它没被当成等级文件"。
ok(levelFiles.indexOf('relations.json') < 0,
  '★ relations.json 没被当成等级文件（正则里的点必须转义，且显式排除）',
  'levelFiles = ' + levelFiles.join(', '));
ok(levelFiles.indexOf('index.json') < 0,
  '★ index.json 没被当成等级文件', 'levelFiles = ' + levelFiles.join(', '));

const index = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
ok(index.schema === 1, 'index.schema === 1');

// ⚠️ 这一条必须在 index 读出来**之后**才能写。
//    第一版把它放在了 index 赋值之前，于是 ReferenceError
//    "Cannot access 'index' before initialization" —— 报的是崩溃，
//    不是断言失败，看起来像脚本坏了。**用 const 声明的变量有暂时性死区，
//    提前用它不会得到 undefined，而是直接抛错。**
ok((index.levels || []).indexOf('relations') < 0 && (index.levels || []).indexOf('index') < 0,
  '★ 索引里没有叫 relations / index 的假等级',
  'levels = ' + (index.levels || []).join(', '));

// ---- 逐个等级文件做结构校验 ----
console.log(`\n[2] 逐条字段完整性`);
const allItems = [];
const allIds = new Map();
for (const f of levelFiles) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    ok(true, `${f} JSON 可解析`);
  } catch (e) {
    ok(false, `${f} JSON 可解析`, e.message);
    continue;
  }
  ok(Array.isArray(data.items) && data.items.length > 0, `${f} 有 items 且非空`);
  ok(typeof data.level === 'string' && data.level.length > 0, `${f} 有 level 字段`);

  for (const it of (data.items || [])) {
    const where = `${f} / ${it.id || '(缺 id)'}`;
    allItems.push({ it, where, file: f });

    ok(!!it.id && /^[a-z0-9-]+$/.test(it.id), `${where} id 合法（小写字母数字连字符）`);
    ok(!!it.level, `${where} 有 level`);
    ok(!!it.category, `${where} 有 category`);
    ok(!!it.title, `${where} 有 title`);
    ok(!!it.connection, `${where} 有 connection（接续规则）`);
    ok(!!it.meaning, `${where} 有 meaning`);
    ok(typeof it.source === 'string' || typeof data.source === 'string',
      `${where} 有 source（诚实要求）`);

    // ⚠️ 条目的 line 必须存在，而且只能是 jlpt / written 之一。
    //
    // 为什么要单钉这一条：**这是本项目的"静默漏字段"重灾区**，已经踩过两次。
    //   第一次：N5.json 里 10 条老条目没有 line，而所有测试都是绿的。
    //   第二次（就是这一次）：gen-grammar.mjs 在批量加条目时**根本没写 line**，
    //     一次性加了 16 条库外的条目，N5/N4/N3 里多出 16 条"没有线"的条目。
    //   为什么测试不报：line 缺失**不会引发任何错误**，它只是让"按线统计/筛选"
    //     悄悄漏数 —— 那 16 条在 jlpt 和 written 两条线里都会消失。
    //   所以断言必须直接钉字段本身，不能靠"有没有报错"来判断。
    ok(it.line === 'jlpt' || it.line === 'written',
      `${where} 的 line 是 jlpt 或 written（不能缺、不能是别的值）`,
      `实际 ${JSON.stringify(it.line)}`);

    // 例句：至少 1 条，每条必须有 ja 和 zh
    const ex = Array.isArray(it.examples) ? it.examples : [];
    ok(ex.length >= 1, `${where} 至少 1 条例句`);
    ex.forEach((e, i) => {
      ok(!!e.ja, `${where} 例句${i + 1} 有 ja`);
      ok(!!e.zh, `${where} 例句${i + 1} 有 zh（不能只有日文）`);
      // ⚠️ 例句里不能有空格：Windows OCR 那个坑的同类问题 —— 空格会让分词退化成单字，
      // 振假名就算不出来了。这条是踩过坑才加的。
      ok(!/[  \t]/.test(e.ja || ''), `${where} 例句${i + 1} 的 ja 不含空格`);
      ok(/[。！？、]|$/.test((e.ja || '').slice(-1)) || !e.ja, `${where} 例句${i + 1} 的 ja 结尾正常`);
    });

    // 易混对比
    if (it.confusions !== undefined) {
      ok(Array.isArray(it.confusions), `${where} confusions 是数组`);
      (it.confusions || []).forEach((c, i) => {
        ok(!!c.with, `${where} confusions${i + 1} 有 with`);
        ok(!!c.diff, `${where} confusions${i + 1} 有 diff（说明差别）`);
      });
    }
    // 常见错误
    if (it.mistakes !== undefined) {
      ok(Array.isArray(it.mistakes), `${where} mistakes 是数组`);
      (it.mistakes || []).forEach((m, i) => ok(typeof m === 'string' && m.length > 0,
        `${where} mistakes${i + 1} 是非空字符串`));
    }
    if (it.tags !== undefined) {
      ok(Array.isArray(it.tags), `${where} tags 是数组`);
    }

    // id 全局唯一
    if (allIds.has(it.id)) {
      ok(false, `${where} id 全局唯一`, `和 ${allIds.get(it.id)} 重复`);
    } else {
      allIds.set(it.id, where);
    }
  }
}
ok(true, `共校验 ${allItems.length} 条语法、${new Set(allItems.map((x) => x.it.level)).size} 个等级`);

// ---- 索引与正文必须一致 ----
console.log(`\n[3] index.json 与正文是否一致（防止手改正文忘了改索引）`);
{
  const indexIds = index.items.map((x) => x.id).sort();
  const bodyIds = allItems.map((x) => x.it.id).sort();
  ok(JSON.stringify(indexIds) === JSON.stringify(bodyIds),
    '索引里的 id 集合和正文完全一致',
    indexIds.length === bodyIds.length ? '' : `索引 ${indexIds.length} 个 vs 正文 ${bodyIds.length} 个`);
  ok(index.count === allItems.length, `index.count 等于实际条数（${index.count} vs ${allItems.length}）`);

  // ---- ★ 两种"搜库"工具不能漂移（2026-10 加） ----
  //
  // `audit-gap.mjs` 和 `search-json.mjs` 是"写新条目之前先查有没有写过"的
  // **两种搜法**，它们的错误方向相反，所以**两个都得跑**：
  //   · audit-gap  —— 只搜 title/meaning/category/id/detail/tags（字段级）。
  //                   **会假有**（子串匹配高估），但**不漏**。
  //   · search-json —— 搜整条 JSON（连例句、注意事项也算）。
  //                   **会假缺**（某条只是被别人的例句提到过），但**不会假有**。
  //   规矩：**两个都判"缺"的，才是真缺口。**
  //
  // ⚠️ 为什么这里要断言，而不是只写在注释里：
  //    这两个脚本**各自独立地重新解析了一遍 `data/grammar/*.json`**
  //    （它们不是 import 谁的库，是各写各的 `readFileSync`）。
  //    也就是说**同一份数据有三套解析代码**（test-grammar 一套、它俩各一套）。
  //    将来若有人把 `index.json` 加个包装层、或把条数挪进别的字段、
  //    或改了文件名规则，这三个数字就会**各说各话**，
  //    而症状只是"搜出来结果怪怪的" —— 没有任何东西会报错。
  //    所以这里卡死三条：① 两个工具算出的总数一致；
  //                       ② 都等于正文条数；③ 都还能跑通。
  {
    const tools = [
      ['audit-gap.mjs', /库内条目总数\s*=\s*(\d+)/],
      ['search-json.mjs', /库内\s+(\d+)\s+条/],
    ];
    for (const [name, re] of tools) {
      // ① 静态锚点：必须显式指定 data/grammar 目录。
      //    只在源码里找 `data`, `grammar` 两个词（不写死拼法），
      //    这样改写法（path.join 换模板串）不会误报。
      const src = fs.readFileSync(path.join(ROOT, 'tools', name), 'utf8');
      ok(/'data'/.test(src) && /'grammar'/.test(src),
        `★ ${name} 显式读了 data/grammar（改了数据目录它会跟着改）`);

      // ② 真的跑一遍，从它自己打印的数字里取条数。
      //    stdio 用 'pipe' 抓输出 —— 这两个脚本只打印两行，不会死锁。
      let out = '';
      let ran = true;
      try {
        out = execFileSync(process.execPath, [path.join(ROOT, 'tools', name)], {
          cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        ran = false;
        out = String((e && (e.stdout || e.message)) || '');
      }
      ok(ran, `★ ${name} 能正常跑完（退出码 0）`,
        ran ? '' : out.split('\n').slice(0, 2).join(' '));

      const m = out.match(re);
      const n = m ? Number(m[1]) : -1;
      ok(n >= 0, `★ ${name} 打印出了条目总数`, m ? '' : out.split('\n')[0]);
      // ③ 三套解析代码必须看到同一份数据
      ok(n === allItems.length,
        `★ ${name} 看到的条数和正文一致（${n} vs ${allItems.length}）`,
        n === allItems.length ? ''
          : `${name} 自己解析 data/grammar/*.json 的写法已经和正文不一致了 —— `
            + `两边会各说各话，而且不报错。检查它的读文件那段。`);
    }
  }

  const lv = new Set(allItems.map((x) => x.it.level));
  ok(index.levels.length === lv.size && index.levels.every((l) => lv.has(l)),
    '索引里的等级集合和正文一致', `索引 [${index.levels}] vs 正文 [${[...lv]}]`);

  // 索引里每条都要指向真实文件
  const filesSet = new Set(levelFiles);
  const badFile = index.items.filter((x) => !filesSet.has(x.file));
  ok(badFile.length === 0, '索引里每条都指向存在的文件',
    badFile.map((x) => `${x.id}→${x.file}`).join(', '));

  // 索引里的关键展示字段不能空（否则列表页会出现空白行）
  const emptyFields = index.items.filter((x) => !x.title || !x.meaning || !x.level || !x.category);
  ok(emptyFields.length === 0, '索引里 title/meaning/level/category 都不为空',
    emptyFields.map((x) => x.id).join(', '));

  // 索引字段必须和正文对应字段**逐字相同**，不能只是"都存在"
  let mismatch = [];
  for (const { it } of allItems) {
    const ix = index.items.find((x) => x.id === it.id);
    if (!ix) { mismatch.push(`${it.id} 不在索引里`); continue; }
    for (const k of ['level', 'category', 'title', 'meaning']) {
      if (ix[k] !== it[k]) mismatch.push(`${it.id}.${k}: 索引"${ix[k]}" vs 正文"${it[k]}"`);
    }
    // line 也要逐字比对（正文不填就是 jlpt）
    const wantLine = it.line || 'jlpt';
    if (ix.line !== wantLine) {
      mismatch.push(`${it.id}.line: 索引"${ix.line}" vs 正文"${wantLine}"`);
    }
  }
  ok(mismatch.length === 0, '索引里各字段与正文逐字一致', mismatch.slice(0, 3).join(' | '));

  // ---- tags 必须在索引里（否则"按标签搜"会静默失效）----
  // ⚠️ 实测踩到：条目打了「书面语」「长句」标签，用户搜「书面语」却**一条都搜不到**。
  //    原因是 build-grammar-index.mjs 没把 tags 写进索引，而检索只搜索引字段。
  //    这类错误的可怕之处：**不报错、不崩，只是搜不到**，
  //    用户会以为"这个功能没有我要的内容"，而不是"索引少了个字段"。
  const missingTags = [];
  for (const { it } of allItems) {
    const ix = index.items.find((x) => x.id === it.id);
    if (!ix) continue;
    if (!Array.isArray(ix.tags)) { missingTags.push(`${it.id} 索引里没有 tags 字段`); continue; }
    const a = [...(it.tags || [])].sort().join('|');
    const b = [...ix.tags].sort().join('|');
    if (a !== b) missingTags.push(`${it.id}: 索引[${b}] vs 正文[${a}]`);
  }
  ok(missingTags.length === 0, '索引里的 tags 和正文一致（按标签搜才不会静默失效）',
    missingTags.slice(0, 3).join(' | '));

  // 至少要有条目真的带标签，否则上面那条是空跑
  const tagged = allItems.filter(({ it }) => (it.tags || []).length > 0);
  ok(tagged.length > 0, '确实有带标签的条目（上面那条不是空跑）', `${tagged.length} 条带标签`);
}

// ---- 索引要足够小，否则"拆文件"就白拆了 ----
console.log(`\n[4] 索引体积（拆文件的意义就是让列表页加载快）`);
{
  const size = fs.statSync(path.join(DIR, 'index.json')).size;
  /**
   * ⚠️ 这里原来断言 `size < 200 * 1024`（写死 200 KB）。
   *
   * 那是一个**会在内容变多时自己失效**的阈值 —— 200 KB 从来不是设计目标，
   * 只是"当时 384 条索引长这样"留下的快照。2026-10 补完 N1/N2/N3 内容、
   * 条目从 384 涨到 666 之后它变成 450 KB，断言就红了，
   * 而**索引本身完全是正常的**：列表页要多显示 282 条，索引自然要变大。
   *
   * 写死绝对体积的断言，等于把"当时的数据规模"当成了"必须发生的行为"。
   * 真正要守的性质是**索引相对正文要小一个量级**（拆文件的目的就是这个），
   * 所以改成比值判据 —— 它随内容一起长大，永远在问同一个问题。
   */
  let body = 0;
  for (const lv of LEVELS) {
    const p = path.join(DIR, `${lv}.json`);
    if (fs.existsSync(p)) body += fs.statSync(p).size;
  }
  const ratio = body > 0 ? body / size : 0;
  ok(ratio > 3,
    `index.json 比正文小得多（索引 ${(size / 1024).toFixed(1)} KB / 正文 ${(body / 1024).toFixed(1)} KB = 1:${ratio.toFixed(1)}，要求 > 3 倍）`);
  ok(size > 0, '索引不是空文件（上面那条不是空跑）', `${size} 字节`);
}

// ---- 同一个语法点不许出现两条 ----
console.log(`\n[5b] 同一个语法点只能有一条（用户报过重复）`);
{
  /**
   * 用户原话：「我在语法搜索的时候注意到不同难度、甚至同一难度下都存在
   *           重复的条目，例如『つつある』在 n3 有一个、n2 有两个。」
   *
   * 这条断言盯的就是那件事：**同一个句型不该有两条单点条目**。
   *
   * 为什么要有它：这种重复**任何字段校验都抓不到** ——
   * 两条各自的 id 唯一、字段齐全、例句合规、索引一致，
   * 全部检查都会是绿的，只有"人搜两次搜到同一个语法点"才会发现。
   * 而语法库是分批写出来的，不同批次各写一遍同一个句型是**必然会再发生**的事。
   *
   * 判定规则（有意保守，宁可漏报不可错杀）：
   *   · 标题以「归纳/总结/…」开头的是总结条目，不参与（它们本来就不对应单个句型）
   *   · 标题里用 ／ 并列了多个句型的（复合条目）不参与
   *     —— 它和单点条目"讲同一个句型"是**设计如此**（一个是总览、一个是细讲）
   *   · 只有"标题就是一个句型"的条目之间比，才算真重复
   */
  const norm = (s) => String(s).replace(/[〜～~]/g, '').replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s・･、,，]/g, '').trim();
  const isSummary = (t) => /^(归纳|总结|小结|一览|复习)/.test(String(t || '').trim());
  const pointSet = (t) => {
    const head = String(t || '').split(/[：:]/)[0];
    return [...new Set(head.split(/[／\/]/).map(norm)
      .filter((x) => x && /[\u3040-\u30ff\u4e00-\u9fff]/.test(x))
      .filter((x) => /[\u3040-\u30ff]/.test(x) || x.length <= 6))].sort();
  };

  /**
   * ⚠️ 断言的范围必须和**真正的规则**一样宽，否则会"绿着但其实是错的"。
   *
   * 这里原来只比"单点条目"（句型集合长度 === 1）。于是
   *     `〜ながら（も）／〜つつ`  和  `〜ながら（も）／〜つつも`
   * 这一对**集合相同、值不同**的漏检了 —— 用户搜「つつ」会看到两条，
   * 而这套自检一路全绿。教训：检查比规则窄，比没有检查更危险。
   *
   * 所以改成两层，都由 `findNearDups` 的同一套归一化提供：
   *   1) 句型集合 + "纲"（第一个句型）都相同 → 一定是同一个语法点，必须只有一条
   *   2) 单点句型重复 → 之前那条，保留
   * 另外**空集合必须排除**：有些条目是"怎么读长句"这类方法条目，
   * 标题里没有 ／ 分隔，集合为空；空集合之间互相"相等"，
   * 会凭空产生几十对假重复（实测 12 条条目 → 66 对）。
   */
  const firstPointOf = (t) => String(t || '').split(/[：:]/)[0]
    .split(/[／\/]/)[0].replace(/[（(][^）)]*[）)]/g, '').replace(/[〜～~\s]/g, '').trim();

  const allItems = [];
  for (const f of levelFiles) {
    const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    for (const it of (d.items || [])) allItems.push(it);
  }
  const byPoint = new Map();
  const bySetHead = new Map();
  let singles = 0, noList = 0;
  for (const it of allItems) {
    if (isSummary(it.title)) continue;
    const ps = pointSet(it.title);
    if (ps.length === 0) { noList++; continue; }        // 方法类条目，跳过
    const head = firstPointOf(it.title);
    const k = ps.join('|') + '§' + head;
    if (!bySetHead.has(k)) bySetHead.set(k, []);
    bySetHead.get(k).push(it);
    if (ps.length !== 1) continue;      // 复合条目不参与"单点"那一层
    singles++;
    if (!byPoint.has(ps[0])) byPoint.set(ps[0], []);
    byPoint.get(ps[0]).push(it);
  }
  const dups = [...byPoint.entries()].filter(([, g]) => g.length > 1);
  const dups2 = [...bySetHead.entries()].filter(([, g]) => g.length > 1);
  // 反向：确认真的读到了条目（防止路径/规则写错导致整段空转）。
  //
  // ⚠️ 这里原来写的是固定 `singles > 300`。去重做第二轮之后单点条目从
  //    307 掉到 238，这条断言就红了 —— 而**数据是对的**。
  //    教训：防空跑的断言不该钉死在某个绝对数字上，否则每次正常合并
  //    （合并本来就会把单点并进复合条目、减少单点数）都要来改一次测试。
  //    改成按比例：单点条目至少要占全部条目的三分之一，
  //    既能挡住"整段空转"，又不会因为合并而误报。
  ok(singles > allItems.length / 3,
    `确实扫到了大量单点条目（${singles} / ${allItems.length} 条，断言不是空跑）`);
  ok(noList > 5,
    `确实扫到了"没有句型列表"的方法类条目（${noList} 条，它们被排除在比对之外）`);
  ok(dups.length === 0,
    `★ 没有同一个单点句型出现两条（${byPoint.size} 个句型，重复 ${dups.length} 组）`,
    dups.slice(0, 5).map(([k, g]) => `${k}: ${g.map((x) => x.id).join('、')}`).join('  |  '));
  ok(dups2.length === 0,
    `★ 没有"章节+纲都相同"的两条（${bySetHead.size} 个语法点，重复 ${dups2.length} 组）`,
    dups2.slice(0, 5).map(([k, g]) => `${k}: ${g.map((x) => x.id).join('、')}`).join('  |  '));
  for (const [k, g] of [...dups, ...dups2].slice(0, 10)) {
    console.log(`      ✗ 【${k}】${g.map((x) => `${x.id}[${x.level}]`).join(', ')}`);
  }
}

// ---- 诚实要求 ----
console.log(`\n[5] 来源标注的诚实要求`);
{
  const srcs = new Set();
  for (const f of levelFiles) {
    const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    if (d.source) srcs.add(d.source);
    for (const it of (d.items || [])) if (it.source) srcs.add(it.source);
  }
  ok(srcs.size > 0, '至少有一处 source 标注');
  srcs.forEach((s) => console.log(`      · ${s}`));
  // 反向：不许出现"看起来像抄的"但没署名的模糊来源
  const vague = [...srcs].filter((s) => /^[?\s]*(未知|不详|无|待定)\s*$/.test(s));
  ok(vague.length === 0, '没有使用"来源未知"这类等于没标的写法', vague.join(', '));
}

// ---- 内容里不许出现会误导的字样 ----
console.log(`\n[6] 文案里不出现会被误解成"程序联网"的说法`);
{
  // 项目有 [9b] 节盯着视图文件；语法数据也是会显示给用户看的文本，同样要盯
  const raw = levelFiles.map((f) => fs.readFileSync(path.join(DIR, f), 'utf8')).join('\n');
  ok(!/不联网/.test(raw), '语法数据里没有"不联网"字样');
  ok(!/不上传/.test(raw), '语法数据里没有"不上传"字样');
}

// ---- 讲解文字必须"打开就能看"，不能带 Markdown 标记 ----
console.log(`\n[7] 讲解文案里不能混进 Markdown 标记（界面上会原样露出星号）`);
{
  // ⚠️ 这一节是**第三次踩同一个坑**了：
  //    1. AI 隐私文案里写过 `只有你**选中的那段文字**`
  //    2. 页脚文案
  //    3. 这里的语法数据 —— 10 条样例里 9 条的 detail/mistakes 都带 `**`
  //    为什么屡次发生：这些文字最终都走 `el(..., { text })` → `textContent`，
  //    **不解析 Markdown**。写的人在编辑器里看着像加粗，用户看到的是星号。
  //    所以每条走 textContent 的文案，都要有一条断言盯着。
  const MARKDOWN = /\*\*|__|`|\[[^\]]*\]\([^)]*\)/;
  const flat = [];   // [路径, 文本]
  const walk = (v, pathStr) => {
    if (typeof v === 'string') flat.push([pathStr, v]);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${pathStr}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${pathStr}.${k}`);
  };
  for (const f of levelFiles) {
    const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    // ⚠️ 不要扫整个文件 —— `ja` 例句里出现 `**` 是合法的日语正文。
    //    只扫"给用户看的讲解字段"。
    for (const it of (d.items || [])) {
      walk([it.title, it.connection, it.meaning, it.detail], `${f}:${it.id}`);
      walk(it.examples, `${f}:${it.id}.examples`);
      walk(it.confusions, `${f}:${it.id}.confusions`);
      walk(it.mistakes, `${f}:${it.id}.mistakes`);
    }
  }
  const bad = flat.filter(([, t]) => MARKDOWN.test(t));
  ok(bad.length === 0, '讲解文案里没有 Markdown 标记（星号/反引号/链接）',
    bad.map(([p, t]) => `${p}: ${t.slice(0, 30)}…`).join(' ｜ '));

  // 反向：确认上面真的扫到了东西，不是空跑
  ok(flat.length > 100, '确实扫到了大量文案字段（断言不是空跑）', `${flat.length} 个字段`);

  // 中文讲解里不该混进英文单词（初学者看不懂，且说明是随手写的）
  const mixed = flat.filter(([, t]) => /[\u4e00-\u9fff][a-zA-Z]{3,}|[a-zA-Z]{3,}[\u4e00-\u9fff]/.test(t));
  ok(mixed.length === 0, '中文讲解里没有混进英文单词',
    mixed.map(([p, t]) => `${p}: ${t.slice(0, 30)}…`).join(' ｜ '));
}

// ---- 具体的知识点正确性（人工确认过的几条）----
console.log(`\n[8] 读音类说法必须自洽（这里踩过真错）`);
{
  // ⚠️ 真实事故：n5-wa 原来写「は读作「わ」，不读「は」」，
  //    以及常见错误写「把「は」读成「ha」」。
  //    两处都不准：は 这个假名本身读 ha，只有**当助词时**读 wa，
  //    而且**写法不变**（还是写 は）。把"字音"和"助词音"混为一谈，
  //    会让初学者以为"は 永远读 wa"，那是错的（「はい」就读 hai）。
  const raw = levelFiles.map((f) => fs.readFileSync(path.join(DIR, f), 'utf8')).join('\n');
  ok(!/は读作「わ」，不读「は」/.test(raw), '没有"は读作わ，不读は"这种把字音说死的写法');
  ok(!/把「は」读成「ha」/.test(raw), '没有"把は读成ha"这种把正常读法说成错误的话');
  for (const f of levelFiles) {
    const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    const wa = (d.items || []).find((x) => x.id === 'n5-wa');
    if (!wa) continue;
    const all = [wa.detail, ...(wa.mistakes || [])].join(' ');
    ok(/当助词|助词.*读/.test(all), 'n5-wa 里说明了"只有当助词时才读 wa"');
    ok(/写法不变|还是写/.test(all), 'n5-wa 里说明了"读音变、写法不变"');
  }
}

// ---- UI 侧"两处必须一样"的常量 ----
console.log(`\n[9] 吸顶导览条的贴合量：CSS 与 JS 必须写同一个数`);
{
  /**
   * 为什么专门盯这一个数字：
   *   语法页的吸顶导览条要正好贴在顶部导航栏下沿，所以它的 `top`
   *   必须等于 `.nav` 的高度。这个数**同时出现在三个地方**：
   *     · app/css/theme.css   `.nav { height: 54px }`
   *     · app/css/theme.css   `.gram-readbar { top: 54px }`
   *     · app/js/views/grammar.js  `NAV_HEIGHT_PX = 54`（给锚点补偿量用）
   *   只改其中一处，症状是"导览条被导航栏盖住一条边"或者"中间露一条缝" ——
   *   这种视觉偏差不会让任何功能报错，只会一直难看下去。
   *   所以把三个数抠出来比对（**抠不到就报错**，防止正则空转后永远通过）。
   */
  const css = fs.readFileSync(path.join(ROOT, 'app', 'css', 'theme.css'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'app', 'js', 'views', 'grammar.js'), 'utf8');
  const navH = /\.nav\s*\{[^}]*?height:\s*(\d+)px\s*!important/s.exec(css);
  const barTop = /\.gram-readbar\s*\{[^}]*?top:\s*(\d+)px/s.exec(css);
  const jsH = /NAV_HEIGHT_PX\s*=\s*(\d+)/.exec(js);
  ok(!!navH, '能从 theme.css 里抠到 .nav 的高度', '.nav { height: Npx !important } 没匹配到');
  ok(!!barTop, '能从 theme.css 里抠到 .gram-readbar 的 top', '.gram-readbar { top: Npx } 没匹配到');
  ok(!!jsH, '能从 views/grammar.js 里抠到 NAV_HEIGHT_PX', '常量可能改名了');
  if (navH && barTop && jsH) {
    const a = Number(navH[1]); const b = Number(barTop[1]); const c = Number(jsH[1]);
    ok(a === b && b === c,
      `导览条的贴合量三处一致（.nav=${a} / .gram-readbar top=${b} / JS=${c}）`,
      '改一处要同时改三处：theme.css 的 .nav 与 .gram-readbar、grammar.js 的 NAV_HEIGHT_PX');
  }
}

console.log('\n' + '='.repeat(74));
if (fail === 0) console.log(` 全部通过（${pass} 项）`);
else console.log(` ${fail} 项未通过（通过 ${pass} 项）`);
console.log('='.repeat(74));
process.exit(fail === 0 ? 0 : 1);
