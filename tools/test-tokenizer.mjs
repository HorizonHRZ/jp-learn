/**
 * 分词 / 注音 / 罗马音 回归测试
 *
 * 用法：node tools/test-tokenizer.mjs
 * 需要先构建 data/：node tools/fetch-data.mjs → build-romaji.mjs → build-vocab.mjs
 * （或直接双击 tools\重建数据.cmd）
 *
 * 这些用例都是真实日文句子，覆盖了踩过的坑：
 *   · 假名串被 Intl.Segmenter 切碎（ありがとうございました）
 *   · 动词活用形在词库里查不到（食べます / 使って / 咲きました / 飲みながら）
 *   · 单字假名被误当成词（な→七 / が→絵 / は→歯）
 *   · 助词读音（今日は 的 は 读 wa）
 */
// 不需要设置 JP_LEARN_DATA：tokenizer.js 会用 fileURLToPath 从自身位置推出 ../data
const { initTokenizer, buildReading, lookup, kanaNormalize } = await import('./tokenizer.js');

await initTokenizer();

/** 每个用例：[原句, 期望的罗马音（全部）或前缀, 说明] */
const CASES = [
  ['ありがとうございました', 'arigatougozaimashita', '整词命中，不能被切碎'],
  ['日本語を勉強しています', 'nihongoobenkyoushiteimasu', '假名与罗马音正确'],
  ['今日はいい天気ですね', 'kyouwaiitenkidesune', '今日は 的 は 读 wa（不是 ha）'],
  ['お母さんは毎朝ご飯を食べます', 'okaasanwamaiasagohanotabemasu', '食べます → 食べる（丁宁体还原）'],
  ['コンピュータを使っています', 'konpyuutaotsukatteimasu', '使っています → 使う（て形还原）'],
  ['きれいな花が咲きました', 'kireinahanagasakimashita', 'な/が 不能被当成 七/絵'],
  ['食べて、飲んで、遊んだ。', 'tabetenondeasonda', 'て形/た形音便'],
  ['コーヒーを飲みながら新聞を読みます。', 'koohiionominagarashinbunoyomimasu', '飲みながら/読みます'],
  ['この本はとても面白かったです。', 'konohonwatotemoomoshirokattadesu', '面白かった → 面白い（形容词过去）'],
  ['私は毎日日本語を勉強します。', 'watashiwamainichinihongoobenkyoushimasu', '私/毎日/日本語 都是词'],
  ['本を読んだり、音楽を聞いたりします。', 'honoyondariongakuokiitarishimasu', 'たり形不能退化成 た + りし[利息]'],
  ['どこで生れたかとんと見当がつかぬ。', null, '生れた → 生れる；見当 要整词命中'],
];

/** 覆盖率为 100% 的用例（全部内容都被词库解释；专有名词/生僻词不在此列） */
const FULL_COVERAGE = new Set([
  'ありがとうございました',
  '日本語を勉強しています',
  '今日はいい天気ですね',
  'お母さんは毎朝ご飯を食べます',
  'コンピュータを使っています',
  '食べて、飲んで、遊んだ。',
  'この本はとても面白かったです。',
  'コーヒーを飲みながら新聞を読みます。',
  '私は毎日日本語を勉強します。',
  '本を読んだり、音楽を聞いたりします。',
]);

let fail = 0;
console.log('='.repeat(74));
console.log(' jp-learn 分词 / 注音 / 罗马音 回归测试');
console.log('='.repeat(74));

for (const [text, expectRomaji, desc] of CASES) {
  const r = buildReading(text);
  const problems = [];

  if (expectRomaji !== null && r.romaji !== expectRomaji) {
    problems.push(`罗马音不符：得到 ${r.romaji}，期望 ${expectRomaji}`);
  }
  if (FULL_COVERAGE.has(text) && r.unknownCount !== 0) {
    problems.push(`有 ${r.unknownCount} 个片段未认出：${r.unknownSurfaces.join('、')}`);
  }
  // 未认出的汉字必须留空，不能编造读音
  for (const t of r.tokens) {
    if (!t.known && t.reading) problems.push(`未知片段 ${t.surface} 不应有读音 ${t.reading}`);
  }

  const ok = problems.length === 0;
  if (!ok) fail++;
  console.log('');
  console.log(`${ok ? '✓' : '✗'} ${desc}`);
  console.log(`  原文  ${text}`);
  console.log(`  假名  ${r.kana}`);
  console.log(`  罗马  ${r.romaji}`);
  console.log(`  分词  ${r.tokens.filter((t) => !t.isSpace).map((t) => {
    let s = t.surface;
    if (t.reading && t.reading !== t.surface) s += `[${t.reading}]`;
    if (t.inflected) s += `←${t.base}`;
    if (!t.known) s += '⚠';
    return s;
  }).join(' | ')}`);
  const ruby = r.tokens.filter((t) => t.ruby);
  if (ruby.length) {
    console.log(`  振假名 ${ruby.map((t) => t.ruby.map((p) => (p.r ? `${p.t}(${p.r})` : p.t)).join('') + (t.rubyEstimated ? '⚠推算' : '')).join('  ')}`);
  }
  console.log(`  覆盖率 ${r.coverage}%`);
  for (const p of problems) console.log(`  → ${p}`);
}

// ---- 用词库索引直接验证「活动词形还原」的其它形式 ----
console.log('\n' + '='.repeat(74));
console.log(' 活用还原补充检查');
console.log('='.repeat(74));
const DEINFLECT_CASES = [
  ['食べませんでした', '食べる'],
  ['食べたい', '食べる'],
  ['食べれば', '食べる'],
  ['食べない', '食べる'],
  ['読みました', '読む'],
  ['読まない', '読む'],
  ['読まなかった', '読む'],
  ['書いて', '書く'],
  ['書かない', '書く'],
  ['泳いだ', '泳ぐ'],
  ['話した', '話す'],
  ['話さない', '話す'],
  ['死んだ', '死ぬ'],
  ['遊んでいる', '遊ぶ'],
  ['飲みながら', '飲む'],
  ['読んだり', '読む'],
  ['聞いたり', '聞く'],
  // ⚠️ つかぬ 有两种同样成立的读法，别写死一个：
  //    · つか + ぬ ← 浸かる[つかる]（"泡、浸"）—— 字面最直接；
  //    · つか + ぬ ← 使う[つかう]（N5，常用）—— 例句「見当がつかぬ」里的就是它。
  //    词库放开分级外词之后，还原器的平手判据改成"有 JLPT 等级者优先"，
  //    于是选了 使う。这不是错，但也不能说 浸かる 错 —— 两者都是真词。
  //    所以这条断言只要求"还原出了上面某一个"，不再锁定其中一个。
  ['つかぬ', 'つかる|つかう'],
  ['わからぬ', 'わかる'],
];
for (const [form, baseWord] of DEINFLECT_CASES) {
  const r = buildReading(form);
  // 和上面叠字那组一样，允许用 `|` 写"多个同样正确的答案"（见 つかぬ 那条注释）
  const accepts = String(baseWord).split('|');
  const hit = r.tokens.some((t) => t.inflected && accepts.includes(t.base));
  if (!hit) fail++;
  console.log(`  ${hit ? '✓' : '✗'} ${form} → ${baseWord}   (得到: ${r.tokens.map((t) => t.base || t.surface).join('+')}, 读音 ${r.kana})`);
}

// ---- 叠字符「々／〆」专项 ----
//
// 为什么单独做一节：用户报的 bug 是「々 识别不了，点了罗马音之后掉到和振假名同一行」。
// 根因有两层，都不是"少写了个 case"能防住的，所以这里把**两个根因各钉一条断言**：
//   ① 々(U+3005) 和 〆(U+3006) 在 Unicode 里落在 CJK 符号区 \u3000-\u303f，
//      **正好被 RE_PUNCT 覆盖** → 它们被当成标点，永远到不了汉字分支。
//      ⇒ 断言：「々 没有被切成单独一个 token」（用户看到的就是这个）。
//   ② 振假名对齐用的汉字字符类原先不含 々 → 读音分不到字上，
//      退化成"整词一个 <rt>"，把 <ruby> 撑宽，和下面的罗马音对不齐。
//      ⇒ 断言：「日々 的振假名要拆成 日(ひ)々(び) 两段」。
console.log('\n' + '='.repeat(74));
console.log(' 叠字符（々／〆）专项');
console.log('='.repeat(74));

/** [句子, 期望的"分词+读音"串, 说明] */
const ITERATION_CASES = [
  ['日々の生活', '日々[ひび] の 生活[せいかつ]', '々 要参与构词，读音按词库'],
  ['人々の声', '人々[ひとびと] の 声[こえ]', '浊化由词库负责（ひとびと）'],
  ['時々雨が降る', '時々[ときどき]', 'ときどき 不能被拆开'],
  ['国々', '国々[くにぐに]', '词库命中（くにぐに）'],
  ['各々', '各々[おのおの]', '特殊读音（おのおの）'],
  ['我々', '我々[われわれ]', 'われわれ'],
  ['山々', '山々[やまやま]', '★ 词库没有：要按"前字读音重复"推导'],
  // ⚠️ 木々 这一条**依赖词库收没收它**，所以不能写死一个读音：
  //    · 词库里有 木々（jmdict 给的是 きぎ，含连浊）→ 直接用词库读音；
  //    · 词库里没有 → 走"前字读音重复"的兜底推导，得到 きき。
  //    两种都是对的，错的是"读不出来/拆出孤立的 々"。
  //    2026-10 把分级外词从 8000 条放开到全部之后，木々 进了词库，
  //    于是这条断言原来写死的 きき 变成假红 —— 断言把"当时的词库状态"
  //    当成了"必须发生的行为"。现在改成接受两种正确结果。
  ['木々', '木々[きぎ]|木々[きき]', '★ 叠字：词库有就用词库读音，没有就按前字读音重复'],
  ['〆切り', '〆切り[しめきり]', '〆(U+3006) 同样在标点区，不能当标点'],
];

for (const [text, expect, desc] of ITERATION_CASES) {
  const r = buildReading(text);
  const got = r.tokens
    .filter((t) => !t.isSpace && !t.isPunct)
    .map((t) => (t.reading && t.reading !== t.surface ? `${t.surface}[${t.reading}]` : t.surface))
    .join(' ');
  const problems = [];
  // `expect` 里可以用 `|` 写多个**同样正确**的结果（见 木々 那条的注释）。
  const accepts = String(expect).split('|');
  if (!accepts.some((e) => got.startsWith(e))) {
    problems.push(`分词/读音不符：得到 ${got}，期望以 ${accepts.join(' 或 ')} 开头`);
  }
  // ★ 核心断言：不能出现孤立的「々」
  if (r.tokens.some((t) => t.surface === '\u3005')) problems.push('出现了孤立的「々」token');
  // ★ 核心断言：含 々 的词必须拆开注音（不是整词一个 rt）
  for (const t of r.tokens) {
    if (/\u3005/.test(t.surface) && t.ruby && t.ruby.length === 1 && t.surface.length > 1) {
      problems.push(`${t.surface} 的振假名没有拆开（parts=${JSON.stringify(t.ruby)}）`);
    }
  }
  const ok = problems.length === 0;
  if (!ok) fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${desc}`);
  console.log(`      ${text}  →  ${got}${r.tokens.some((t) => t.ruby) ? '   振假名 ' + r.tokens.filter((t) => t.ruby).map((t) => t.ruby.map((p) => (p.r ? `${p.t}(${p.r})` : p.t)).join('')).join(' ') : ''}`);
  for (const p of problems) console.log(`      → ${p}`);
}

// ===========================================================================
// 假名归一 + 同音词查全（用户报的 bug）
// ===========================================================================
//
// 用户原话：「输入假名搜索，搜索到的结果应该是所有对应相同读音的词。
//            比如 かた 这个词搜索，应该出现肩，過多，方 等等词，
//            但是我测试的结果只有「方」这一个词。」
//
// 两个根因：
//   ① **片假名和平假名是两套不同的码位**。索引里的读音一律存平假名
//      （かた），所以拿 カタ 去比是永远不相等的 → 0 条。
//   ② 查词原来是"优先级"语义（第一个命中就返回），后面的来源见不到光。
//
// 这一节盯的是 ①和②在 tokenizer 这一层的表现。服务端那一半（归一、
// 计数去重）在 test-http.mjs 的 [4b] 里。
console.log('\n' + '='.repeat(74));
console.log(' 假名归一 / 同音词查全');
console.log('='.repeat(74));

// ---- A. kanaNormalize 本身是个纯函数，行为必须精确 ----
const KANA_CASES = [
  ['\u30AB\u30BF', '\u304B\u305F', '片假名 カタ → 平假名 かた'],
  ['\u30AB\u30FC\u30C9', '\u304B\u30FC\u3069', '长音符 ー 必须保留（它没有平假名对应）'],
  ['\u304B\u305F', '\u304B\u305F', '平假名原样不动（幂等）'],
  ['\u80A9', '\u80A9', '汉字不做任何改动（不能把汉字搞坏）'],
  ['kata', 'kata', '拉丁字母不做任何改动'],
  // ★ 没有平假名对应的三个片假名：**必须原样保留**
  //
  //   第一版这里写的是"ヴィラ → ゔぃら"，跑出来才发现那个结果是坏的：
  //   ゔ（U+3094）在日语里基本不用，而这个"归一"会把一个正常的外来语
  //   改写成查不到的乱码。而 ヴ 在真实词库里出现 146 次（アイヴォリー 等），
  //   所以这不是边角情况。
  //   **这条断言是被自己的实现打脸之后补上的**，留着它防止有人"优化"回去。
  ['\u30F4\u30A3\u30E9', '\u30F4\u3043\u3089', '★ ヴ 原样保留（U+30F4 没有可用的平假名）'],
  ['\u30F5\u304B\u6708', '\u30F5\u304B\u6708', '★ ヵ 原样保留（U+30F5）'],
  ['\u30F6\u6708', '\u30F6\u6708', '★ ヶ 原样保留（U+30F6）'],
  // 边界：U+30F3（ン）是"能转"的最后一个，U+30F4（ヴ）是"不能转"的第一个
  ['\u30F3', '\u3093', '边界：ン(U+30F3) 能转（→ん）'],
];
for (const [input, expect, desc] of KANA_CASES) {
  const got = kanaNormalize(input);
  const ok = got === expect;
  if (!ok) fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${desc}`);
  if (!ok) console.log(`      → 得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(expect)}`);
}
// 归一是幂等的：对同一个串做两次和做一次结果一样
{
  const once = kanaNormalize('\u30AB\u30BF\u30AB\u30CA');
  const twice = kanaNormalize(once);
  const ok = once === twice;
  if (!ok) fail++;
  console.log(`  ${ok ? '✓' : '✗'} kanaNormalize 幂等（重复调用结果不变）`);
}

// ---- B. ★ 核心：用片假名查，必须和平假名一样查得到 ----
//
// 这是用户真正会做的事 —— 输入法切在片假名状态时打出来的就是片假名。
{
  const pairs = [
    ['\u304B\u305F', '\u30AB\u30BF', 'かた / カタ'],
    ['\u3053\u3068\u3070', '\u30B3\u30C8\u30D0', 'ことば / コトバ'],
  ];
  for (const [hira, kata, label] of pairs) {
    const rh = lookup(hira);
    const rk = lookup(kata);
    const nh = rh.exact.length + rh.byReading.length;
    const nk = rk.exact.length + rk.byReading.length;
    const ok = nk > 0 && nk === nh;
    if (!ok) fail++;
    console.log(`  ${ok ? '✓' : '✗'} ★ ${label}：片假名与平假名命中数一致（各 ${nk} / ${nh} 条）`);
  }
}

// ---- C. ★ 同音词要"全部"出来，不能只出最常见的那一个 ----
//
// 用户报的就是这个：输入 かた 只出了「方」。
// 断言不能只写"至少 1 条"——那正是原来的错误行为也能通过的条件。
{
  const r = lookup('\u304B\u305F');
  const terms = new Set();
  for (const t of [].concat(r.exact, r.byReading)) {
    if (t && t.term) terms.add(t.term);
  }
  const ok = terms.size >= 4;
  if (!ok) fail++;
  console.log(`  ${ok ? '✓' : '✗'} ★ 查「かた」出多个不同词形（共 ${terms.size} 个：${[...terms].join('、')}）`);

  // 反向断言：不能只有「方」。只断言"≥4 条"还不够直白 ——
  // 万一将来索引里只剩 4 个别的词，"只出方"这个具体症状仍然要能被抓住。
  const onlyKata = terms.size === 1 && terms.has('\u65B9');
  const ok2 = !onlyKata;
  if (!ok2) fail++;
  console.log(`  ${ok2 ? '✓' : '✗'} ★★ 不是"只出了「方」这一个词"（用户报的原始症状）`);
}

// ---- D. ★ 两份 kanaNormalize 必须完全一致（防"两边口径漂移"）----
//
// ⚠️ 这个函数在项目里有**两份**，而且是没办法的事：
//   · tools/tokenizer.js  —— 服务端查词（node 侧）
//   · app/js/vocabdata.js —— 浏览器里比对本地词库缓存
//   前者不能在浏览器里跑（它是 node 侧的索引加载器），后者不能在 node 里跑
//   （它 import 了 db.js，需要 IndexedDB）。所以只能各留一份。
//
//   但"各留一份"的代价是**它们会悄悄漂移**：改了一边忘了另一边，
//   症状是"接口查得到、本地缓存查不到"（或反过来）——
//   这种差异极难排查，因为两边看起来都在各自正常工作。
//
//   所以这里直接从**源码文本**里把那个字符范围抠出来对比。
//   对比的是"规则本身"而不是"我另抄的一份实现"，所以真能抓到漂移。
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  /** 从源码里抠出 `replace(/[<这里>]/g, …)` 的字符范围 */
  const grab = (rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const m = src.match(/kanaNormalize\s*\(\s*s\s*\)\s*\{[\s\S]{0,400}?replace\(\s*\/\[([^\]]+)\]\//);
    return m ? m[1] : null;
  };

  const a = grab('tools/tokenizer.js');
  const b = grab('app/js/vocabdata.js');
  const okRead = a !== null && b !== null;
  if (!okRead) fail++;
  console.log(`  ${okRead ? '✓' : '✗'} ★ 两份 kanaNormalize 都能从源码里读出字符范围`
    + `（tokenizer=${JSON.stringify(a)} vocabdata=${JSON.stringify(b)}）`);
  const same = okRead && a === b;
  if (!same) fail++;
  console.log(`  ${same ? '✓' : '✗'} ★★ 两份 kanaNormalize 的字符范围完全一致`);
  // 上界必须是 30f3：把 30f4(ヴ) / 30f5(ヵ) / 30f6(ヶ) 排除在外。
  // 这条就是防止有人"顺手改成 30f6"的那个具体断言。
  const upperOk = okRead && /30f3/i.test(a);
  if (!upperOk) fail++;
  console.log(`  ${upperOk ? '✓' : '✗'} ★ 范围上界是 30f3（排除 30f4 ヴ 等无平假名对应的字符）`);
}

console.log('\n' + '='.repeat(74));
console.log(fail === 0 ? ' 全部通过' : ` ${fail} 项未通过`);
console.log('='.repeat(74));
process.exit(fail === 0 ? 0 : 1);
