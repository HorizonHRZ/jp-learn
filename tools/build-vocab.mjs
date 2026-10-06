// ============================================================================
// build-vocab.mjs —— 把 data-cache/ 的原始数据编译成 data/ 里的可用词库（零依赖）
//
// 输入（由 tools/fetch-data.mjs 下载）：
//   data-cache/jmdict-cn/jmdict-cn-{N5..N1,untagged}.json
//        JMdict 的中文衍生版：汉字/假名表面形、词性、英文释义、中文释义、中日对照例句、JLPT 等级
//   data-cache/jlpt/{n5..n1}.csv
//        JLPT 官方分级词表（Jonathan Waller / tanemk）——用来补全与校验分级，保证分级完整
//   data-cache/jmdict/kanjidic2-*.json（可选）
//        单字读音，作为词库外生字的注音兜底
//
// 输出（全部是可被静态服务直接读取的 JSON）：
//   data/vocab/n{5..1}.json    分级词库（背单词用）
//   data/vocab/extra.json      分级之外的高频词（供查词与精读解析）
//   data/index/lookup.json     表面形 → 词条 id 列表（查词/分词用）
//   data/index/readings.json   读音   → 词条 id 列表（联想/假名检索用）
//   data/index/terms.json      条目 id → {中释义} 的紧凑表（离线点词查询用）
//   data/index/kanji.json      单字 → 读音列表（词库外生字的注音兜底，可能为空）
//   data/index/manifest.json   构建元信息与统计（供界面显示"词库版本/条数"）
//
// 用法: node tools/build-vocab.mjs [--max-extra=0]
// ============================================================================
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = path.join(ROOT, 'data-cache');
const OUT_VOCAB = path.join(ROOT, 'data', 'vocab');
const OUT_INDEX = path.join(ROOT, 'data', 'index');

const argv = process.argv.slice(2);
const argOf = (k) => { const h = argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.slice(k.length + 3) : null; };

/**
 * 分级之外收录多少条（**0 = 全部收录**）。
 *
 * ⚠️ 默认值是 **0（全收）**，不是 8000。这里改过一次，原因值得记：
 *
 *   原来默认 8000，而实际交付的数据是用 `--max-extra=0` 建的（extra 15364 条）。
 *   于是出现了一个**很隐蔽的陷阱**：
 *     用户照着使用说明跑「重建词库」那条命令（不带参数），
 *     会因为默认 8000 而**静默丢掉 7364 个词** ——
 *     命令成功、没有报错、库里还是能查词，只是**少了一大半**。
 *     这种"重建之后东西变少了，而且没人知道"的情况是最难发现的，
 *     因为它看起来完全正常。
 *
 *   规矩：**如果一个构建脚本的"默认行为"会产出和已交付数据不一样的东西，
 *   那这个默认值就是错的。** 默认必须等于"交付时用的那个参数"，
 *   否则"照着文档重建"和"我手上这份数据"就是两回事。
 *
 *   代价是 extra.json 会到 ~11 MB。这是知情的取舍：用户要的是"查得到"。
 */
const MAX_EXTRA = Number(argOf('max-extra') ?? 0);
/** 干跑：算完所有内容但**一个文件都不写**，只报告"主词形会怎么变"。
 *  数据重建不该盲跑 —— 先用它核对变更清单，确认没误伤再真正落盘。 */
const DRY_RUN = argv.includes('--dry-run');

const LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];
const log = (...a) => console.log(...a);
const kb = (n) => (n / 1024).toFixed(0) + ' KB';

// ---------------------------------------------------------------------------
// 一、工具
// ---------------------------------------------------------------------------
const isKanji = (ch) => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch);
/** 含汉字的判断（不用带 g 的正则，避免 lastIndex 状态带来的诡异 bug） */
const hasKanji = (s) => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(s);

/** 判断一个词形是否"全是汉字以外的可读字符"（纯假名/含拉丁等） */
const isKanaOnly = (s) => /^[\u3040-\u309f\u30a0-\u30ff\u30fc\u30fbー]+$/.test(s);

/** CSV 解析：支持双引号包裹（字段内可含逗号） */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function writeJson(file, obj, { pretty = false } = {}) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const text = pretty ? JSON.stringify(obj, null, 1) + '\n' : JSON.stringify(obj) + '\n';
  await fsp.writeFile(file, text, 'utf8');
  log(`  → ${path.relative(ROOT, file).replace(/\\/g, '/')}  ${kb(text.length)}`);
  return text.length;
}

/** 词性标签 → 中文简称（用于界面显示，取第一个即可） */
const POS_ZH = {
  n: '名词', 'n-suf': '名词(接尾)', 'n-pref': '名词(接头)', pn: '代名词',
  v1: '动1', 'v1-s': '动1', v5u: '动1(五段)', v5k: '动1', v5g: '动1', v5s: '动1',
  v5t: '动1', v5n: '动1', v5b: '动1', v5m: '动1', v5r: '动1', v5aru: '动1',
  v5u_s: '动1', v5uru: '动1', vz: '动1', vi: '自动词', vt: '他动词',
  'adj-i': '形1', 'adj-ix': '形1', 'adj-na': '形2', 'adj-no': '连体',
  adv: '副词', prt: '助词', conj: '接续', int: '感叹', aux: '助动',
  ctr: '量词', num: '数词', exp: '惯用', 'expressions': '惯用',
  suf: '接尾', pref: '接头', adj: '形容词', 'aux-v': '助动', 'aux-adj': '助形',
  unc: '未分类',
};

// ---------------------------------------------------------------------------
// 二、读取 jmdict-cn
// ---------------------------------------------------------------------------
log('\n=== build-vocab：编译词库 ===\n');
log('[1/5] 读取 jmdict-cn ...');

const cnDir = path.join(CACHE, 'jmdict-cn');
if (!fs.existsSync(cnDir)) {
  log(`  ✗ 找不到 ${cnDir}`);
  log('    请先运行：node tools/fetch-data.mjs');
  process.exit(1);
}

/** id → 词条。注意：同一个词条可能同时出现在分级文件与 untagged 里，以带等级的那份为准。 */
const entries = new Map();

for (const f of (await fsp.readdir(cnDir)).filter((x) => x.endsWith('.json') && !x.includes('meta'))) {
  const m = f.match(/jmdict-cn-(.+)\.json$/);
  if (!m) continue;
  const tag = m[1];
  const lv = LEVELS.includes(tag.toUpperCase()) ? tag.toUpperCase() : null;
  const arr = JSON.parse(await fsp.readFile(path.join(cnDir, f), 'utf8'));
  let added = 0;
  for (const e of arr) {
    const id = String(e.id);
    const prev = entries.get(id);
    // 已有带等级的记录时，不被 untagged 覆盖
    if (prev && prev.level && !lv) continue;
    entries.set(id, { raw: e, level: lv || (prev && prev.level) || null });
    added++;
  }
  log(`  ${f.padEnd(30)} ${String(arr.length).padStart(6)} 条  (${lv || '分级外'})`);
}

// 分级来源统计（同一词可能被多个等级标注，取最低等级 = 最容易的那个）
const levelById = new Map();
for (const [id, v] of entries) {
  if (v.level) levelById.set(id, v.level);
  const rawLv = v.raw.jlpt;
  if (rawLv && LEVELS.includes(String(rawLv).toUpperCase())) {
    const cur = levelById.get(id);
    const next = String(rawLv).toUpperCase();
    if (!cur || LEVELS.indexOf(next) < LEVELS.indexOf(cur)) levelById.set(id, next);
  }
}
log(`  去重后词条：${entries.size} 条；其中带 JLPT 等级：${levelById.size} 条`);

// ---------------------------------------------------------------------------
// 三、读取 JLPT 官方词表，补全分级
// ---------------------------------------------------------------------------
log('\n[2/5] 读取 JLPT 官方分级词表 ...');

/** id → 官方等级（同一 id 出现在多级时取最低级） */
const officialLevel = new Map();
/** 官方表里有、但 jmdict-cn 里没有的条目：{ id, kana, kanji, en } */
const officialOnly = [];
let officialTotal = 0;

for (const lv of LEVELS) {
  const p = path.join(CACHE, 'jlpt', lv.toLowerCase() + '.csv');
  if (!fs.existsSync(p)) { log(`  [warn] 缺少 ${path.relative(ROOT, p)}，跳过`); continue; }
  const raw = await fsp.readFile(p, 'utf8');
  // 注意：这个 CSV 是「逗号分隔」，字段可能被双引号包裹（里面含逗号）
  const lines = raw.split('\n').map((s) => (s.endsWith('\r') ? s.slice(0, -1) : s)).filter((s) => s.trim());
  lines.shift(); // 表头 jmdict_seq,kana,kanji,waller_definition
  let matched = 0;
  for (const line of lines) {
    const c = parseCsvLine(line);
    const id = (c[0] || '').trim();
    const kana = (c[1] || '').trim();
    const kanji = (c[2] || '').trim();
    const en = (c[3] || '').trim();
    if (!id) continue;
    officialTotal++;
    const cur = officialLevel.get(id);
    if (!cur || LEVELS.indexOf(lv) < LEVELS.indexOf(cur)) officialLevel.set(id, lv);
    if (entries.has(id)) matched++;
    else officialOnly.push({ id, kana, kanji, en, level: lv });
  }
  log(`  ${lv}  官方 ${String(lines.length).padStart(5)} 条，其中 ${matched} 条在词库中找到`);
}

// 把官方等级合并进词库（jmdict-cn 漏标的，用官方表补上）
let levelPatched = 0;
for (const [id, lv] of officialLevel) {
  const cur = levelById.get(id);
  if (!cur) { levelById.set(id, lv); levelPatched++; }
  else if (LEVELS.indexOf(lv) < LEVELS.indexOf(cur)) { levelById.set(id, lv); levelPatched++; }
}
log(`  官方表合计 ${officialTotal} 条；用官方表补/修正等级 ${levelPatched} 条`);
log(`  官方表有、词库没有的：${officialOnly.length} 条（这些暂时没有释义，会在界面上如实标注）`);

// ---------------------------------------------------------------------------
// 四、编译词条
// ---------------------------------------------------------------------------
log('\n[3/5] 编译词条 ...');

/**
 * 「罕用汉字形」的标记。JMdict 用这几个人工标注来区分"这个汉字写法存在、
 * 但日本人基本不写"，我们的词表必须尊重它。
 *   rK = rarely-used kanji form（罕用汉字形）
 *   oK = obsolete kanji form（过时汉字形）
 *   sK = search-only kanji form（只为检索而收，实际不写）
 */
const RARE_KANJI_TAGS = new Set(['rK', 'oK', 'sK']);

/** 这个写法是不是被标成了罕用 */
function isRare(form) {
  return (form.tags || []).some((t) => RARE_KANJI_TAGS.has(t));
}

/**
 * 人工例外名单：**「读音 → 该改用假名主形的汉字写法」**。
 *
 * ⚠️ 为什么不能只按读音判断（第一版就是这么写的，结果错了，记下来）：
 *
 * 一开始写成"这些读音一律用假名"，结果把同音词全牵连了：
 *   · 读音 いる → 把 射る（射击）、鋳る（铸造）、入る（进入）也改成了 いる
 *   · 读音 なる → 把 鳴る（响）、生る 也改成了 なる
 *   · 读音 する → 把 擦る、刷る 也改成了 する
 *   · 读音 ここ → 把 個々（各个）也改成了 ここ
 *   · 读音 だれ → 把 誰 也改成了 だれ
 * 这些都是**完全不同的词**，只是碰巧同音。按读音一刀切是错的。
 *
 * ⚠️ 也不能只按"假名更常见"判断：
 *   · 事/時/物/所/方 —— 假名形诚然常见，但**汉字形在真实文章里满地都是**
 *     （「事がある」「時々」「物語」「所」「方法」）。改成假名主形，
 *     学习者就学不到"看到「事」要读 こと"，读课文会卡住。
 *     → 这些保持汉字主形，改用 kanaHint 把假名形一并带出来（见 KANA_HINT_READINGS）。
 *
 * 所以判定标准写成**明确到"哪个汉字写法"**：
 *   只有当「这个汉字写法本身罕见到学习者短期内不会在文章里碰到」时，才改假名。
 *   判断口诀：**「如果我在日本网站上看新闻，会看到这个汉字吗？」**
 *   会 → 保留汉字；不会 → 用假名。
 *
 * 这份名单必须逐条可解释，加之前先过一遍口诀。想撤销某个词，
 * 删掉对应那一项即可，重建后立刻恢复成汉字主形。
 */
const KANA_PREFERRED = new Map([
  // 读音 → 该改用假名的汉字写法（用「/」分隔多个）
  ['ある', ['有る', '在る', '或']],
  ['いる', ['居る', '要る']],
  ['おる', ['居る']],
  ['する', ['為る']],
  ['なる', ['成る']],
  ['まだ', ['未だ']],
  ['どこ', ['何処']],
  ['ここ', ['此処']],
  ['そこ', ['其処']],
  ['あそこ', ['彼処']],
  ['これ', ['此れ']],
  ['それ', ['其れ']],
  ['あれ', ['彼れ']],
  ['どれ', ['何れ']],
  ['だれ', ['誰']],
  ['いつ', ['何時']],
  ['とても', ['迚も']],
  ['ちょっと', ['一寸']],
  ['やはり', ['矢張り']],
  ['たぶん', ['多分']],
  ['ぜひ', ['是非']],
  ['ほとんど', ['殆ど']],
  ['すべて', ['全て']],
  ['やがて', ['軈て']],
  ['やっと', ['漸と']],
  ['さっと', ['颯と']],
  ['ふと', ['不図']],
  ['いよいよ', ['愈', '愈々']],
  ['ますます', ['益々']],
]);

/** 人工例外：这些读音保留汉字主形，但额外把假名形写进 kanaHint */
const KANA_HINT_READINGS = new Set([
  'こと', 'とき', 'もの', 'ところ', 'ため', 'よう',   // 事/時/物/所/為/様
  'わけ', 'はず', 'くせ', 'つもり', 'ほう', 'かた',   // 訳/筈/癖/積もり/方/方
  'ほど', 'くらい', 'ばかり', 'だけ',                  // 程/位/許り/丈
  'また', 'もう',                                     // 又/巳う
]);

/** 这个汉字写法在该读音下是否属于"罕见到不必认，改用假名主形" */
function prefersKana(reading, kanjiText) {
  const list = KANA_PREFERRED.get(reading);
  return !!list && list.includes(kanjiText);
}
/** 这个读音是否"该在汉字旁边标出假名写法" */
const wantsKanaHint = (reading) => KANA_HINT_READINGS.has(reading);

/**
 * 选主词形。
 *
 * ⚠️ 这里踩过一个很典型的坑，务必读懂再动：
 *
 * 旧规则是「常用汉字形 → 汉字形 → 常用假名 → 假名」，**优先级是错的** ——
 * `kanji[0]`（随便一个汉字形）排在了「被标记为常用」的假名前面。
 * 后果：只要 JMdict 给这个词挂了任何汉字写法，哪怕它被标注为 rK（罕用），
 * 也会被选成主词形。实测把 そこ 显示成了「其処」、とても 显示成「迚も」、
 * やはり 显示成「矢張り」、する 显示成「為る」。
 *
 * 正确的问题是「**哪个写法才是日本人真正在写的**」，而不是「有没有汉字写法」。
 * 上游其实早就把答案标好了：其処 的 common=false 且 tags=["rK"]，
 * 而 そこ 的 common=true。是编译时把这个信息扔掉了。
 *
 * 所以规则改成三步：
 *   1. 「现代习惯写假名」的读音（KANA_PREFERRED_READINGS）→ 直接用假名；
 *   2. 否则剔除罕用汉字形（rK/oK/sK），剩下的按"常用优先"排；
 *   3. 一个汉字形都不剩就退到假名。
 *
 * 效果：
 *   · そこ/とても/やはり/まとめる → 汉字形被标记为罕用，全剔除 → term = 假名  ✅
 *   · まだ/ある/こと/とき       → 上游标的是 common=true，靠名单兜住 → term = 假名  ✅
 *   · 会う/物/日本語/勉強/先生   → 汉字 common=true 且不在名单里 → 保持汉字  ✅
 *   · 底/そこ                    → 底 这个读音不在名单里（名单按读音是 そこ，
 *                                  但 底 的 reading 也是 そこ！）→ 见下方说明
 *
 * ⚠️ 关于 底(そこ) 这类"同读音不同词"的情况：名单按**读音**匹配，
 * 所以 底 也会被改成假名。这是**已知且刻意接受**的取舍：
 * 名单是"这个读音在现代日语里通常怎么写"的判断，而 そこ 这个读音确实通常写假名
 * （「そこ」当"底部"讲时也常写假名）。若要把 底 单独拉回汉字，
 * 就在这里加一个"按 id 豁免"的集合 —— 但那属于逐词微调，
 * 在没看到真实使用反馈前不值得做。
 */
function pickPrimary(kanji, kana, reading) {
  const kanaPick = kana.find((k) => k.common) || kana[0] || { text: '', common: false };
  // 第 1 步：罕用汉字形（rK/oK/sK）不参选 —— 这是上游已经标好的客观事实
  const usableKanji = kanji.filter((k) => !isRare(k));
  // 第 2 步：在剩下的里面挑"常用优先"
  const hit = usableKanji.find((k) => k.common) || usableKanji[0] || null;
  // 第 3 步：如果挑出来的汉字写法命中人工名单（有る/未だ/矢張り…），改用假名。
  //         注意判断的是**挑出来的那个写法**，"有る"命中、"居る"不命中，
  //         所以同读音的其它词不会被牵连。
  if (hit && prefersKana(reading, hit.text) && kanaPick.text) {
    return { text: kanaPick.text, common: true, reason: 'kana-preferred' };
  }
  if (hit) return { text: hit.text, common: !!hit.common, reason: 'kanji' };
  // 第 4 步：一个能用的汉字形都没有 → 退到假名
  return { text: kanaPick.text, common: !!kanaPick.common, reason: 'kana-fallback' };
}

/** 统一成内部结构 */
function compile(id, raw, level) {
  const kanji = (raw.kanji || []).map((k) => ({ text: k.text, common: !!k.common, tags: k.tags || [] })).filter((k) => k && k.text);
  const kana = (raw.kana || []).map((k) => ({ text: k.text, common: !!k.common, tags: k.tags || [] })).filter((k) => k && k.text);
  // 上游数据里 senses_zh / senses_en 的元素可能是 null，必须逐步防御
  const zh = [];
  for (const s of raw.senses_zh || []) {
    if (!s) continue;
    for (const g of s.glosses || []) if (g) zh.push(String(g));
  }
  const en = [];
  for (const s of raw.senses_en || []) {
    if (!s) continue;
    for (const g of s.glosses || []) if (g) en.push(String(g));
  }
  const pos = [];
  for (const s of raw.senses_en || []) {
    if (!s) continue;
    for (const p of s.pos || []) if (p && !pos.includes(p)) pos.push(p);
  }
  // 词性中文：优先取能翻译出来的
  const posZh = [];
  for (const p of pos) {
    const t = POS_ZH[p];
    if (t && !posZh.includes(t)) posZh.push(t);
  }
  // 例句：优先保留有中文的，最多 4 条
  const ex = [];
  for (const e of raw.examples || []) {
    if (!e || !e.jp) continue;
    if (ex.length >= 4) break;
    ex.push({ jp: e.jp, zh: e.zh || '', level: e.level || level || '', src: e.source || '' });
  }
  // 主词形：见下方 pickPrimary 的长注释
  const primaryKana = (kana.find((k) => k.common) || kana[0] || { text: '' }).text;
  const primary = pickPrimary(kanji, kana, primaryKana);
  // 主词形是汉字、但这个读音"平时也常写假名"时，把假名形记下来给界面提示用。
  // 目的是两头都不丢：主形仍是要认的汉字，旁边告诉你它平时怎么写。
  // 主形本身就是假名时不需要（假名形 = term 本身），所以留空。
  const kanaHint = (primary.reason === 'kanji' && wantsKanaHint(primaryKana) && primaryKana !== primary.text)
    ? primaryKana : '';
  return {
    id: 'jmdict:' + id,
    term: primary.text,     // 词形（该写汉字写汉字，该写假名写假名，由 pickPrimary 决定）
    reading: primaryKana,   // 读音（假名）
    // 词形是否"确实常用"。false 表示这是退而求其次的结果（例如整个词条都没有常用形），
    // 界面可以据此弱化展示，但不要拿它决定"该不该学"。
    common: primary.common,
    // 为什么选了这个词形（kanji / kana-preferred / kana-fallback）。
    // 留这个字段是为了以后排查"为什么某词显示了假名"时有据可查，
    // 而不是只能靠读代码猜。
    termReason: primary.reason,
    // 平时更常写的假名形（仅当主形是汉字且该读音属于"常写假名"时非空）
    kanaHint,
    forms: kanji.map((k) => k.text),
    kanas: kana.map((k) => k.text),
    level: level || '',
    zh: zh.slice(0, 8),     // 中文释义（最多 8 条，避免单条过大）
    en: en.slice(0, 3),     // 英文兜底释义
    pos: posZh.length ? posZh : pos.slice(0, 2),
    ex,
  };
}



const byLevel = { N5: [], N4: [], N3: [], N2: [], N1: [], extra: [] };
let noZh = 0;

for (const [id, v] of entries) {
  const lv = levelById.get(id) || null;
  const item = compile(id, v.raw, lv);
  if (!item.term && !item.reading) continue;
  if (!item.zh.length) noZh++;
  if (lv) byLevel[lv].push(item);
  else byLevel.extra.push(item);
}

// 分级外的词太多，按「质量」排序后截断：有中文释义 > 例句多 > 有英文释义
const QUALITY = (x) => (x.zh.length ? 1000 : 0) + x.ex.length * 50 + (x.en.length ? 10 : 0) + (x.term ? 1 : 0);
byLevel.extra.sort((a, b) => QUALITY(b) - QUALITY(a) || a.id.localeCompare(b.id));
const extraKept = MAX_EXTRA > 0 ? byLevel.extra.slice(0, MAX_EXTRA) : byLevel.extra;
const extraDropped = byLevel.extra.length - extraKept.length;
byLevel.extra = extraKept;

for (const lv of [...LEVELS, 'extra']) {
  byLevel[lv].sort((a, b) => a.reading.localeCompare(b.reading, 'ja') || a.term.localeCompare(b.term, 'ja'));
}
log(`  分级词库：${LEVELS.map((l) => l + '=' + byLevel[l].length).join('  ')}`);
log(`  分级外收录：${byLevel.extra.length} 条（候选 ${byLevel.extra.length + extraDropped} 条，按质量截断）`);
log(`  没有中文释义的词条：${noZh} 条（界面会如实标注，不编造释义）`);

// ---------------------------------------------------------------------------
// 四之二、报告主词形变更（只在干跑时做）
// ---------------------------------------------------------------------------
// 用**旧规则**重算一遍 term，和新的逐一对照。
// 这是本次改动唯一的"肉眼验收"手段：数据重建看不见摸不着，
// 必须先把"哪些词的词形变了"摊开，确认全是想要的那种变化，才允许落盘。
if (DRY_RUN) {
  /** 旧规则：常用汉字形 → 汉字形 → 常用假名 → 假名（错误地把罕用汉字形也算数） */
  const oldPick = (raw) => {
    const kanji = (raw.kanji || []).map((k) => ({ text: k.text, common: !!k.common })).filter((k) => k && k.text);
    const kana = (raw.kana || []).map((k) => ({ text: k.text, common: !!k.common })).filter((k) => k && k.text);
    return (kanji.find((k) => k.common) || kanji[0] || kana.find((k) => k.common) || kana[0] || { text: '' }).text;
  };

  const changed = [];
  /** 把上游 raw 规整成 pickPrimary 需要的形状（两处复用，避免不一致） */
  const shape = (raw) => ({
    kanji: (raw.kanji || []).map((k) => ({ text: k.text, common: !!k.common, tags: k.tags || [] })).filter((k) => k && k.text),
    kana: (raw.kana || []).map((k) => ({ text: k.text, common: !!k.common, tags: k.tags || [] })).filter((k) => k && k.text),
  });
  for (const [id, v] of entries) {
    const oldTerm = oldPick(v.raw);
    const s = shape(v.raw);
    const reading = (s.kana.find((k) => k.common) || s.kana[0] || { text: '' }).text;
    const picked = pickPrimary(s.kanji, s.kana, reading);
    if (oldTerm !== picked.text) {
      const lv = levelById.get(id) || 'extra';
      const rareTags = (v.raw.kanji || [])
        .filter((k) => (k.tags || []).some((t) => RARE_KANJI_TAGS.has(t)))
        .map((k) => k.text + '[' + (k.tags || []).join(',') + ']');
      changed.push({ id, lv, oldTerm, newTerm: picked.text, rareTags, reason: picked.reason });
    }
  }

  console.log('\n' + '='.repeat(72));
  console.log(`【干跑】主词形会变的词条：${changed.length} 条 / 共 ${entries.size} 条`);
  console.log('='.repeat(72));

  // 按等级分布
  const byLv = {};
  const byReason = {};
  for (const c of changed) {
    byLv[c.lv] = (byLv[c.lv] || 0) + 1;
    byReason[c.reason] = (byReason[c.reason] || 0) + 1;
  }
  console.log('按等级分布：', JSON.stringify(byLv));
  console.log('按原因分布：', JSON.stringify(byReason));
  console.log('  （kana-preferred = 人工名单判定现代习惯写假名）');
  console.log('  （kana-fallback  = 汉字形全被标为罕用，只能退到假名）');

  // 全量清单写成文件，便于逐条核对（不算交付物，只是本次验收用）
  const lines = ['等级\tid\t旧词形\t新词形\t原因\t被剔除的罕用汉字形'];
  for (const c of changed.sort((a, b) => String(a.lv).localeCompare(String(b.lv)) || a.id.localeCompare(b.id))) {
    lines.push([c.lv, c.id, c.oldTerm, c.newTerm, c.reason, c.rareTags.join(' ')].join('\t'));
  }
  const outFile = path.join(ROOT, 'tools', '_term-changes.tsv');
  fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
  console.log(`完整清单已写出（本次验收用，核对完即删）：${path.relative(ROOT, outFile)}`);

  // 随机抽样 60 条给人看
  console.log('\n【抽样 60 条】');
  const step = Math.max(1, Math.floor(changed.length / 60));
  for (let i = 0, n = 0; i < changed.length && n < 60; i += step, n++) {
    const c = changed[i];
    console.log(`  [${c.lv}] ${c.oldTerm} → ${c.newTerm}   (${c.id})  ${c.reason}  剔除: ${c.rareTags.join(' ') || '—'}`);
  }

  // 反向抽查：确认该保留汉字的没被误伤
  // ⚠️ 这份名单是**刻意选的**，不是随手写的：它包含了
  //   · 汉字必须保留的（会う/青い/明日/日本語/勉強/先生）
  //   · 曾经被我误判成"应该改假名"、后来纠正回来的（事/時/物/所/方 —— 见 kanaHint 那段注释）
  // 如果哪天这里出现 ✗，先回去读 KANA_PREFERRED_READINGS 的注释再改名单。
  console.log('\n【反向抽查：这些词的 term 应该保持汉字不变】');
  const MUST_KEEP = ['会う', '青い', '明日', '日本語', '勉強', '先生',
    '事', '時', '物', '所', '方', '訳', '筈', '程', '又'];
  const termById = new Map();
  for (const [id, v] of entries) {
    const s = shape(v.raw);
    const reading = (s.kana.find((k) => k.common) || s.kana[0] || { text: '' }).text;
    const t = pickPrimary(s.kanji, s.kana, reading).text;
    if (!termById.has(t)) termById.set(t, []);
    termById.get(t).push(id);
  }
  let keepMiss = 0;
  for (const t of MUST_KEEP) {
    const ids = termById.get(t) || [];
    if (!ids.length) keepMiss++;
    console.log(`  ${t.padEnd(6)} ${ids.length ? '✓ 仍存在（' + ids.length + ' 条）' : '✗ 不见了！'}`);
  }
  if (keepMiss) console.log(`  ⚠️ 有 ${keepMiss} 个本该保留的词形不见了，别急着落盘。`);

  // 另抽样看 kanaHint 是否按预期生成了
  console.log('\n【kanaHint 抽查：主形保留汉字，同时带出假名写法】');
  for (const t of ['事', '時', '物', '所', '方', '訳', '又']) {
    const ids = termById.get(t) || [];
    if (!ids.length) { console.log(`  ${t}  (无此主形)`); continue; }
    const v = entries.get(ids[0]);
    const s = shape(v.raw);
    const reading = (s.kana.find((k) => k.common) || s.kana[0] || { text: '' }).text;
    const p = pickPrimary(s.kanji, s.kana, reading);
    const hint = (p.reason === 'kanji' && wantsKanaHint(reading) && reading !== p.text) ? reading : '';
    console.log(`  ${t.padEnd(6)} reading=${reading.padEnd(8)} kanaHint=${hint || '（空）'}`);
  }

  console.log('\n【干跑结束：没有写任何文件】加不加 --dry-run 决定是否真的落盘。\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 五、写 data/vocab/
// ---------------------------------------------------------------------------
log('\n[4/5] 写出分级词库 ...');

const meta = {
  format: 'jp-learn-vocab',
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  note: '词形 term 取"日本人实际在写的写法"（罕用汉字形 rK/oK/sK 不参选，该写假名就写假名）；'
    + 'reading 为假名读音；zh 为中文释义；common 表示 term 是否确实常用。',
};
let totalVocabBytes = 0;
for (const lv of LEVELS) {
  const name = lv.toLowerCase() + '.json';
  const body = { ...meta, level: lv, count: byLevel[lv].length, items: byLevel[lv] };
  totalVocabBytes += await writeJson(path.join(OUT_VOCAB, name), body);
}
totalVocabBytes += await writeJson(path.join(OUT_VOCAB, 'extra.json'),
  { ...meta, level: 'extra', count: byLevel.extra.length, items: byLevel.extra });

// ---------------------------------------------------------------------------
// 六、写 data/index/（查词 / 分词 / 注音用）
// ---------------------------------------------------------------------------
log('\n[5/5] 写出查词与分词索引 ...');

/** 表面形 → 词条 id（按"质量"排序，查词时第一个最优先） */
const lookup = new Map();
/** 读音 → 词条 id */
const readings = new Map();
/** id → 中文释义精简表（离线点词查询用，不含例句等大字段） */
const terms = {};

const pushTo = (map, key, id, rank) => {
  if (!key) return;
  let arr = map.get(key);
  if (!arr) { arr = []; map.set(key, arr); }
  arr.push([id, rank]);
};

const allItems = [...LEVELS.flatMap((l) => byLevel[l]), ...byLevel.extra];

for (const it of allItems) {
  // rank 越小越优先：有中文释义 → 有英文 → 常用等级
  const lvRank = it.level ? LEVELS.indexOf(it.level) : 9;
  const rank = (it.zh.length ? 0 : 100) + lvRank * 10 + (it.ex.length ? 0 : 1);
  for (const f of it.forms) pushTo(lookup, f, it.id, rank);
  for (const k of it.kanas) pushTo(lookup, k, it.id, rank + 5); // 假名形略微降权
  for (const k of it.kanas) pushTo(readings, k, it.id, rank);
  // 读音索引也收汉字词形对应的读音
  if (it.reading) pushTo(readings, it.reading, it.id, rank);
  terms[it.id] = [it.term, it.reading, it.level, it.zh.slice(0, 4), it.pos.slice(0, 1)];
}

const finalize = (map) => {
  const obj = {};
  const keys = [...map.keys()].sort((a, b) => a.localeCompare(b, 'ja'));
  for (const k of keys) {
    // 去重 + 按 rank 排序 + 只保留前 6 个候选（避免文件过大）
    const seen = new Set();
    const arr = map.get(k)
      .sort((x, y) => x[1] - y[1] || String(x[0]).localeCompare(String(y[0])))
      .filter(([id]) => (seen.has(id) ? false : (seen.add(id), true)))
      .slice(0, 6)
      .map(([id]) => id);
    obj[k] = arr;
  }
  return obj;
};

const lookupObj = finalize(lookup);
const readingsObj = finalize(readings);

const idxMeta = {
  format: 'jp-learn-index',
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  note:
    '表面形/读音 → 词条 id 列表，列表按优先级排序（越靠前越常用、越可能有中文释义）。' +
    '分词时用它做最长匹配，查词时取列表第一个。',
};

await writeJson(path.join(OUT_INDEX, 'lookup.json'), { ...idxMeta, kind: 'surface', keys: lookupObj });
await writeJson(path.join(OUT_INDEX, 'readings.json'), { ...idxMeta, kind: 'reading', keys: readingsObj });
await writeJson(path.join(OUT_INDEX, 'terms.json'), {
  ...idxMeta, kind: 'terms',
  note: 'id → [词形, 读音, 等级, 中文释义(<=4), 词性]。供离线点词查询，不含例句。',
  terms,
});

// 单字读音兜底（kanjidic2 可选）
//
// ⚠️⚠️ 这段曾经**整体失效而没有任何红灯**，两个独立的坑叠在一起，都记在这里：
//
//  坑一（在 fetch-data.mjs）：`.tgz` 只 gunzip、没剥 tar，
//     所以这里的 JSON.parse 永远抛异常 → 走到 catch → "改用词库自举"。
//     那个坏文件 16.86 MB，看着完全正常。
//
//  坑二（就在这里）：解析代码按**想象中的结构**取值 ——
//     `readingMeaning.onYomi` / `readingMeaning.kunYomi`。
//     而 kanjidic2 的真实结构是三层：
//       readingMeaning.groups[] → .readings[] → { type: "ja_on" | "ja_kun", value }
//     于是即便 JSON 能解析，`onYomi`/`kunYomi` 也永远是 `[]`，
//     `kanjiCount` 恒为 0，manifest 里只写一行 `kanjiReadings: 0` —— **静默降级**。
//
// 教训：**"取不到数据"必须让程序说出来**。所以下面不再"取不到就算了"，
// 而是取不到就进入 catch 打日志；最后 ③ 处还有一道硬断言，
// 只要 kanjidic2 文件在、却一条读音都提不出来，就直接让构建失败。
let kanjiCount = 0;
let kanjiFrom = 'kanjidic2';
try {
  const jmDir = path.join(CACHE, 'jmdict');
  const kd = fs.existsSync(jmDir)
    ? (await fsp.readdir(jmDir)).find((f) => /^kanjidic2-all-.*\.json$/.test(f))
    : null;
  if (kd) {
    const doc = JSON.parse(await fsp.readFile(path.join(jmDir, kd), 'utf8'));
    const list = doc.characters || doc.kanji || [];

    /** 从一条 character 记录里取 [音读, 训读]。兼容新旧两种结构。 */
    const readingsOf = (c) => {
      const rm = c.readingMeaning || {};
      const on = [];
      const kun = [];
      // 结构 A（kanjidic2 官方 JSON，当前上游就是这种）
      for (const g of rm.groups || []) {
        for (const r of g.readings || []) {
          const v = r && (r.value ?? r);
          if (!v) continue;
          if (r.type === 'ja_on') on.push(String(v));
          else if (r.type === 'ja_kun') kun.push(String(v));
        }
      }
      // 结构 B（旧版/别的打包方式）：onYomi / kunYomi 平铺
      for (const r of rm.onYomi || []) { const v = r && (r.value ?? r); if (v) on.push(String(v)); }
      for (const r of rm.kunYomi || []) { const v = r && (r.value ?? r); if (v) kun.push(String(v)); }
      return [on, kun];
    };

    const kanji = {};
    for (const c of list) {
      const ch = c.literal || c.character;
      if (!ch) continue;
      const [onRaw, kunRaw] = readingsOf(c);
      const on = [...new Set(onRaw)].slice(0, 4);
      // 训读去掉送假名标记：「つ.ぐ」→「つぐ」、「た.べる」→「たべる」
      const kun = [...new Set(kunRaw.map((r) => r.replace(/[.-].*$/, '')))].filter(Boolean).slice(0, 4);
      if (on.length || kun.length) kanji[ch] = [on, kun];
    }
    kanjiCount = Object.keys(kanji).length;

    // ★ 硬断言：文件在、却提不出读音 = 结构又变了。宁可直接失败，
    //   也不要再静默降级成"自举"，那样问题会一直藏着。
    if (list.length > 0 && kanjiCount === 0) {
      const sample = JSON.stringify(list[0]?.readingMeaning ?? list[0]).slice(0, 240);
      throw new Error(
        `读到了 ${list.length} 个汉字，却一条读音都提不出来 —— kanjidic2 的结构可能变了。第一条样本：${sample}`);
    }

    await writeJson(path.join(OUT_INDEX, 'kanji.json'), {
      ...idxMeta, kind: 'kanji',
      note: '单字 → [音读, 训读]。来自 kanjidic2。仅作为词库外生字的注音兜底；单字读音往往不对，慎用。',
      kanji,
    });
  } else {
    log('  · 没有 kanjidic2 缓存（GitHub Releases 在本机不可达），改用词库自举的单字读音表');
  }
} catch (e) {
  log(`  · kanjidic2 处理失败：${e.message}（改用词库自举）`);
}

// ---------------------------------------------------------------------------
// 六之二、词库自举的单字读音统计表
//
// 为什么需要：振假名要把「日本語 → にほんご」切分成 日(にほ)本(ん)語(ご)，
// 光靠"平均分配"会切错（比如 大人 → お/と/な 这种）。有了「每个汉字最常读什么」的统计，
// 切分时就能优先选最可能的组合。
//
// 数据来源就是词库自己：
//   ① 单字词条（御金＝おかね 这种"单字表面形 + 完整读音"）
//   ② 熟字对（前送假名＋单字，如 お金 → 金=かね）
// 统计每个汉字在「单字对应」中的读音频次，取前几个。
// ---------------------------------------------------------------------------
{
  const freq = new Map(); // 汉字 → Map(读音 → 次数)
  const bump = (ch, rd, w = 1) => {
    if (!ch || !rd || !isKanji(ch)) return;
    if (!/^[\u3040-\u309f\u30a0-\u30ff\u30fc]+$/.test(rd)) return;
    if (rd.length > 4) return;              // 单字读音不会太长
    let m = freq.get(ch);
    if (!m) { m = new Map(); freq.set(ch, m); }
    m.set(rd, (m.get(rd) || 0) + w);
  };

  // ---- 第一步：先收「表面形 → [汉字序列, 读音]」的可靠样本 ----
  // 只取「表面形含汉字 且 表面形里的假名与读音首尾吻合」的词，这样切分才可信
  const samples = [];
  for (const it of allItems) {
    const forms = it.forms.length ? it.forms : [it.term];
    const reading = it.reading;
    if (!reading) continue;
    for (const form of forms) {
      if (!hasKanji(form)) continue;
      // 表面形里的汉字个数
      const kcount = [...form].filter((c) => isKanji(c)).length;
      if (kcount < 1) continue;
      // 前后送假名必须与读音首尾一致，否则这份样本的切分不可靠
      const preS = (form.match(/^[^0-9A-Za-z\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/) || [''])[0];
      const postS = (form.match(/[^0-9A-Za-z\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+$/) || [''])[0];
      let r = reading;
      if (preS) {
        if (!r.startsWith(preS)) continue;
        r = r.slice(preS.length);
      }
      if (postS) {
        if (!r.endsWith(postS)) continue;
        r = r.slice(0, r.length - postS.length);
      }
      if (!r) continue;
      // 此时 form 去掉前后送假名后应当只剩汉字
      const core = form.slice(preS.length, form.length - postS.length);
      if (!core || [...core].some((c) => !isKanji(c))) continue;
      samples.push([[...core], r]);
    }
  }

  // ---- 第二步：迭代自举 ----
  // 每轮：用当前统计把样本的读音切分到各汉字（DP 取最高分路径），
  //       再用切分结果更新统计。迭代几轮后统计会收敛变准。
  const align = (chars, reading) => {
    if (!chars.length) return null;
    if (chars.length === 1) return [reading];
    const n = chars.length;
    const L = reading.length;
    if (L < n) return null;
    const KEY = (i, j) => i * (L + 1) + j;
    const best = new Map();
    const from = new Map();
    const score1 = (ch, seg) => {
      if (!seg) return -1e9;
      const m = freq.get(ch);
      if (!m) return 0.05;                     // 未见过的字：给个很小的基础分，避免全零
      const c = m.get(seg);
      if (c) return 20 + Math.min(c, 10);      // 命中已知读音：高分
      // 未命中但读音长度合理：给一点分，允许新读音被发现
      return 1 / (1 + Math.abs(seg.length - 2));
    };
    const walk = (i, j) => {
      if (i === n) return j === L ? 0 : -1e9;
      const k = KEY(i, j);
      if (best.has(k)) return best.get(k);
      let bestVal = -1e9;
      let bestNext = -1;
      // 给最后一个汉字留够长度
      const maxLen = L - j - (n - i - 1);
      for (let len = 1; len <= maxLen; len++) {
        const seg = reading.slice(j, j + len);
        const v = score1(chars[i], seg) + walk(i + 1, j + len);
        if (v > bestVal) { bestVal = v; bestNext = j + len; }
      }
      best.set(k, bestVal);
      from.set(k, bestNext);
      return bestVal;
    };
    if (walk(0, 0) <= -1e8) return null;
    const out = [];
    let i = 0, j = 0;
    while (i < n) {
      const nj = from.get(KEY(i, j));
      if (nj === undefined || nj < 0) return null;
      out.push(reading.slice(j, nj));
      j = nj; i++;
    }
    return out;
  };

  for (let round = 0; round < 4; round++) {
    for (const [chars, reading] of samples) {
      const segs = align(chars, reading);
      if (!segs) continue;
      for (let k = 0; k < chars.length; k++) bump(chars[k], segs[k]);
    }
  }
  // 迭代会把"自我强化"的分数越堆越高，这里统一按频次排序即可（相对大小才重要）

  const kanji = {};
  for (const [ch, m] of freq) {
    const top = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja')).slice(0, 6);
    if (top.length) kanji[ch] = top.map(([rd, n]) => [rd, n]);
  }
  // 只在没有 kanjidic2 表时才写（kanjidic2 是权威数据，别覆盖它）
  const kanjiFile = path.join(OUT_INDEX, 'kanji.json');
  if (!fs.existsSync(kanjiFile)) {
    const cnt = Object.keys(kanji).length;
    await writeJson(kanjiFile, {
      ...idxMeta, kind: 'kanji',
      note:
        '单字 → [[读音, 频次], ...]，按出现次数降序。由词库自举统计：对「汉字词 + 读音」样本做 DP 切分迭代收敛。' +
        '用途：把复合词的读音切分到各个汉字（振假名对齐），而不是"平均分配"。' +
        '注意：它不是权威字典读音，只是统计结果，仅用于对齐，不要当释义来源。',
      source: 'derived-from-vocab',
      sampleCount: samples.length,
      kanji,
    });
    kanjiCount = cnt;
    kanjiFrom = 'derived-from-vocab';
  }
}

// ---------------------------------------------------------------------------
// 七、清单与自检
// ---------------------------------------------------------------------------
const stats = {
  builtAt: new Date().toISOString(),
  node: process.version,
  source: {
    'jmdict-cn': entries.size,
    'jlpt-official': officialTotal,
    'jlpt-official-only': officialOnly.length,
    kanjiReadings: kanjiCount,
    kanjiReadingsFrom: kanjiFrom,
  },
  counts: Object.fromEntries([...LEVELS, 'extra'].map((l) => [l, byLevel[l].length])),
  total: allItems.length,
  noChineseGloss: noZh,
  lookupKeys: Object.keys(lookupObj).length,
  readingKeys: Object.keys(readingsObj).length,
  bytes: { vocab: totalVocabBytes },
  maxExtra: MAX_EXTRA,
  extraDropped,
};

await writeJson(path.join(OUT_INDEX, 'manifest.json'), stats, { pretty: true });

// 自检：抽几个必然存在的词，验证索引能查到
const probe = [
  ['日本語', 'にほんご'],
  ['ありがとう', 'ありがとう'],
  ['食べる', 'たべる'],
  ['学校', 'がっこう'],
  ['お金', 'おかね'],
  ['コンピュータ', 'コンピュータ'],
];
log('\n  自检（抽查索引） ...');
let bad = 0;
for (const [term, reading] of probe) {
  const a = lookupObj[term];
  const b = readingsObj[reading];
  const ok = a && a.length && b && b.length;
  if (!ok) bad++;
  log(`    ${ok ? '✓' : '✗'} ${term}（${reading}）→ 表面形索引 ${a ? a.length : 0} 个候选，读音索引 ${b ? b.length : 0} 个候选`);
}
if (bad) {
  log(`  ✗ 有 ${bad} 个抽查项没查到，索引可能有问题`);
  process.exitCode = 1;
} else {
  log('  ✓ 抽查全部通过');
}

log('\n完成。可用 node tools/build-vocab.mjs 随时重建（现在默认就收录全部分级外词）。');
log('数据许可：jmdict-cn = CC BY-SA 4.0；JLPT 官方词表 = CC BY-SA 4.0（上游 CC BY）；kanjidic2 = CC BY-SA 4.0。\n');
