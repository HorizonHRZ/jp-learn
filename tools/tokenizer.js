/**
 * tokenizer.js —— 日语分词 + 汉字注音 + 假名转罗马音（零依赖，服务端使用）
 *
 * 为什么自己写而不用 Intl.Segmenter：
 *   Node 内置的 Intl.Segmenter('ja', {granularity:'word'}) 是「词」粒度，对纯假名串很差。
 *   实测：'ありがとうございました' 被切成 ありがとう|ご|ざ|いま|した —— 完全没法用，
 *   而歌词里假名串恰恰是主体。所以必须用词库做「最长匹配」。
 *
 * 三大能力：
 *   1. tokenize(text)     把日文切成 token（词/助词/标点/未知片段）
 *   2. buildReading(text) 给整行生成 振假名 + 罗马音 + 逐 token 细节
 *   3. lookup(text)       查词
 *
 * 诚实原则（重要）：
 *   · 词库查不到的生词，reading 返回空字符串并标 known:false，
 *     绝不用「单字音读」之类规则去猜 —— 猜错的假名比空着更害人。
 *   · 振假名无法可靠切分时标 rubyEstimated:true，让界面可以提示"仅供参考"。
 *
 * 数据来源：data/index/{lookup,readings,terms,kanji}.json、data/kana/romaji-table.json，
 * 分别由 tools/build-vocab.mjs 与 tools/build-romaji.mjs 生成。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 常量与字符类
// ---------------------------------------------------------------------------
const KANJI = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff';
/**
 * 「叠字符」—— 々(U+3005)、〆(U+3006)、ヶ(U+30F6)。
 *
 * ⚠️ 这三个字符**在 Unicode 里不在汉字区**（々 在 CJK 符号区 \u3000-\u303f），
 *    但它们在日文里**就是汉字的一部分**：日々=日び、人々=人びと、三ヶ月=三かげつ。
 *
 * 为什么必须单独列一个类，而不是直接并进 KANJI：
 *    KANJI 的用途是**分词**（"这里是不是一个汉字串"），把它扩大会改变分词行为，
 *    风险面大；而**振假名对齐**只需要知道"哪些字符要参与读音切分"。
 *    所以这里用一个**只给对齐用**的更宽的类，把影响面锁死在 rubyAlign 里。
 *
 * 不修的时候会怎样（用户报的 bug）：
 *    日々 的读音是 ひび，[[...s].filter(RE_KANJI.test)] 会把 々 滤掉，
 *    只剩 1 个"汉字"却要分 2 个假名 → 走不通 → 退化成"整词一个 rt"：
 *    得到 <ruby>日々<rt>ひび</rt></ruby>。整词一个 rt 时，
 *    <rt> 会**撑宽整个 <ruby>**，而下面的罗马音是按词宽居中排的 ——
 *    两者宽度对不上，视觉上就是用户说的"罗马音掉到和振假名同一行"。
 */
const MOJI = '\\u3005\\u3006\\u30f6';
const KANJI_ALIGN = KANJI + MOJI;
const RE_KANJI_ALIGN = new RegExp(`[${KANJI_ALIGN}]`);

/**
 * 这个字符是不是"靠前一个字活着"的记号（迭字符）。
 *   々 = 重复前一个汉字（日々 = 日 + 日）
 *   〆 = 締 的略字（〆切 = 締め切り），它自己带读音，但也常写在汉字后
 *   ヶ = 箇 的略字（三ヶ月 = 三箇月），读音是 か/ケ
 */
function isIterationMark(ch) { return ch === '\u3005' || ch === '\u3006' || ch === '\u30f6'; }

/**
 * 这个记号"实际代表哪个汉字"——用来兜底查读音统计。
 *   ⚠️ 只有 ヶ 有确定的对应字（箇）。々 和 〆 **没有**固定的对应汉字
 *   （々 对应前一个字，是上下文相关的；〆 是日本自造略字），
 *   所以这两个返回 null，交给"继承前字统计"那条路处理。
 */
function iterationBase(ch) {
  if (ch === '\u30f6') return '\u7b87';   // ヶ → 箇
  return null;
}

const KANA = '\\u3040-\\u309f\\u30a0-\\u30ff\\u30fc';
// 注意：这些正则都不带 g 标志 —— 带 g 的 RegExp.test() 会记忆 lastIndex，
// 在循环里会产生间隔性失败的诡异 bug。
const RE_KANJI = new RegExp(`[${KANJI}]`);
const RE_KANJI_RUN = new RegExp(`[${KANJI}]+`, 'g');
const RE_KANA = new RegExp(`[${KANA}]`);
const RE_KANA_ONLY = new RegExp(`^[${KANA}]+$`);
const RE_LATIN = /[A-Za-z0-9]/;
const RE_PUNCT = /[\s\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65!-\/:-@\[-`{-~]/;

/** 单字助词：单独成 token，便于正确标罗马音（は→wa、へ→e、を→o）。
 *  只放单字，多字助词（から/まで/ので…）由词库正常匹配。 */
const PARTICLE_SET = new Set([
  'は', 'が', 'を', 'に', 'へ', 'と', 'で', 'も', 'の', 'や', 'か', 'ね', 'よ', 'な', 'ぞ', 'ぜ', 'わ',
]);

// ---------------------------------------------------------------------------
// 活用（词形变化）还原规则
//
// 为什么必须做：词库里只有「辞书形」。实测 data/index/lookup.json：
//   使って / 食べます / 咲きました / 勉強した / 生れた … 全部未命中。
// 真实日文里动词几乎都以活用形出现，不还原的话分词会在最常见的词上崩掉：
//   「使っています」被切成 使|って|いま|す（把 いま=今 这类词误认进来）。
//
// 规则排序：后缀长度降序，长的先试（ませんでした 不会被 た 抢走）。
/**
 * 一段动词词干末尾可能出现的假名（い行 + え行）。
 *
 * 用途：使役受身还原时决定先试「る」还是先试元音行位移。
 * 食べ + させられた → 词干「食べ」，べ 在 え行 ⇒ 先试 食べる（正确），
 * 而不是先试 食ぼ → 食う（虽然也是真词，但答案错了）。
 * 这只是**优先顺序**，不是硬判定 —— 所有候选都会试一遍。
 */
const I_ROW_STEM = new Set([
  'い', 'き', 'し', 'ち', 'に', 'ひ', 'み', 'り', 'ぎ', 'じ', 'び', 'ぴ',
  'え', 'け', 'せ', 'て', 'ね', 'へ', 'め', 'れ', 'げ', 'ぜ', 'べ', 'ぺ',
]);

/**
 * 辞书形可能以哪些假名结尾（动词/形容词）。用于使役受身那种"剥完还剩一个词干"
 * 的情形：食べさせられた → 剥掉「させられた」→ 词干「食べ」必须靠 +る 补成 食べる。
 * 顺序按"常见程度"排，先命中先返回。
 */
const DICT_ENDINGS = ['る', 'う', 'く', 'ぐ', 'す', 'つ', 'ぬ', 'ぶ', 'む', 'い'];

/**
 * 「裸的て形/た形词尾」——这些后缀挂上来时，**不能**再对词干末尾做元音行位移。
 *
 * 踩过的坑（真实误匹配）：
 *   静かだった 被还原成「づつ」（每……）。推导过程是
 *     だった = だ + った → 拿掉「った」→ 词干剩「だ」
 *     → 元音行位移表（由 d 行推出）里有 だ→づ → 得到假词「づつ」，
 *       而「づつ」恰好是词库里的一个条目，于是"命中"了。
 *   同理「勉強した」被还原成「しる」（した → し + た → し→る）。
 *
 * 为什么这些后缀不该触发位移：促音便/い音便 的词尾（った/いて/いで/して/んで…）
 * 已经**就是**词干在该活用下的形态，词干末尾不该再变 ——
 * 読ん + だ、書い + た、使っ + た，词干末尾分别是 ん/い/っ，
 * 它们本来也就不在位移表里。真正会被误伤的是「だ」「た」「て」「で」这些
 * 既可以当后缀、又可以当词干末尾假名的情况 —— 而它们几乎总是助动词，
 * 不是动词词干。所以这四种后缀直接禁用位移。
 *
 * 注意：只禁「位移」，不禁「补辞书形词尾」。所以 食べ + て → 食べる、
 * 使っ + た → 使う（靠音便表）都照常工作。
 */
const NO_STEM_SHIFT_SUFFIX = new Set(['た', 'だ', 'て', 'で']);

/**
 * 后缀替换表：[原文右端的活用后缀, [辞书形可能的词尾...]]
 * 顺序按后缀长度降序，长的先匹配（ませんでした 不会被 た 抢走）。
 */
const SUFFIX_RULES = [
  ['ませんでした', ['る', 'う', 'く', 'ぐ', 'す', 'つ', 'ぬ', 'ぶ', 'む']],
  ['ましょう', ['る', 'う', 'く', 'ぐ', 'す', 'つ', 'ぬ', 'ぶ', 'む']],
  ['ません', ['る', 'う', 'く', 'ぐ', 'す', 'つ', 'ぬ', 'ぶ', 'む']],
  ['ました', ['る', 'う', 'く', 'ぐ', 'す', 'つ', 'ぬ', 'ぶ', 'む']],
  ['まして', ['る', 'う', 'く', 'ぐ', 'す', 'つ', 'ぬ', 'ぶ', 'む']],
  ['ます', ['る', 'う', 'く', 'ぐ', 'す', 'つ', 'ぬ', 'ぶ', 'む']],
  ['なかった', ['る', 'う', 'く', 'ぐ', 'す', 'つ', 'ぬ', 'ぶ', 'む']],
  ['ない', ['る', 'う', 'く', 'ぐ', 'す', 'つ', 'ぬ', 'ぶ', 'む']],
  // 文语/口语否定「ぬ」「ん」：つかぬ → つかん → つかむ、わからぬ → わかる
  // ん 的候选越多越容易误命中，所以必须有"真实词条"兜底（consider 会校验）；
  // 促音便的 ん（読んで 的 ん）前面一定还有 で/だ，不会被这条抢走。
  ['ぬ', ['る', 'う', 'く', 'ぐ', 'す', 'つ', 'ぬ', 'ぶ', 'む']],
  ['ん', ['る', 'う', 'く', 'ぐ', 'す', 'つ', 'ぬ', 'ぶ', 'む']],
  // …たり…たり（与て形/た形同一套音便，必须写成独立后缀，
  // 否则「聞いたり」会被 た 先匹配成「聞いた」+「り」）
  ['ったり', ['う', 'つ', 'る']],
  ['いたり', ['く']],
  ['いだり', ['ぐ']],
  ['したり', ['す']],
  ['んだり', ['ぬ', 'ぶ', 'む']],
  ['って', ['う', 'つ', 'る']],
  ['った', ['う', 'つ', 'る']],
  ['いて', ['く']],
  ['いた', ['く']],
  ['いで', ['ぐ']],
  ['いだ', ['ぐ']],
  ['して', ['す']],
  ['した', ['す']],
  ['んで', ['ぬ', 'ぶ', 'む']],
  ['んだ', ['ぬ', 'ぶ', 'む']],
  ['て', ['る']],
  ['た', ['る']],
  ['れば', ['る']],
  // …なければ（否定假定形："如果不…"）整体当后缀。
  // 拆成 ない + ければ 是不行的 —— 那样词干会是「書かな」，而 な 的候选里
  // 没有 く，还原不出来。整体匹配之后词干是「書か」，か→く 一步就到位。
  ['なければ', ['る', 'う', 'く', 'ぐ', 'す', 'つ', 'ぬ', 'ぶ', 'む']],
  // …て + いる/います（"正在…"）整体当后缀。
  // 为什么必须整体写：如果只留「て」，剩下的「います」会被当成另一个词，
  // 而「話しています」这种最常见的句子恰恰需要一次还原到位。
  // 注意这两条要排在下面的 ['います', …] 前面（表最后会按长度降序排，所以顺序不敏感，
  // 但写在一起更清楚它们是同一族）。
  ['ていました', ['る', 'う', 'く', 'ぐ', 'す', 'つ', 'ぬ', 'ぶ', 'む']],
  ['ています', ['る', 'う', 'く', 'ぐ', 'す', 'つ', 'ぬ', 'ぶ', 'む']],
  ['ている', ['る', 'う', 'く', 'ぐ', 'す', 'つ', 'ぬ', 'ぶ', 'む']],
  ['えば', ['う', 'く', 'ぐ', 'す', 'つ', 'ぬ', 'ぶ', 'む']],
  ['います', ['る']],
  ['いる', ['る']],
  ['いたい', ['る']],
  ['たい', ['る', 'う', 'く', 'ぐ', 'す', 'つ', 'ぬ', 'ぶ', 'む']],
  ['れる', ['る', 'う', 'く', 'ぐ', 'す', 'つ', 'ぬ', 'ぶ', 'む']],
  ['せる', ['る', 'う', 'く', 'ぐ', 'す', 'つ', 'ぬ', 'ぶ', 'む']],
  ['かった', ['い']],
  ['くて', ['い']],
  ['くない', ['い']],
  ['ければ', ['い']],
  // 只还原词干、不接词尾的接续（一边…一边…）
  ['ながら', []],
];
SUFFIX_RULES.sort((a, b) => b[0].length - a[0].length);
/**
 * 词干末尾假名的"元音行位移"表：把活用形里的假名换回辞书形假名。
 *
 * 为什么需要按行位移而不是单个映射：五段动词按活用形改变元音行
 *   未然形（あ行）：読ま + ない → 読む、書か + ない → 書く、話さ + ない → 話す
 *   連用形（い行）：読み + ます → 読む、書きます 的 書き → 書く、生れ → 生れる
 *   仮定形（え行）：書け + ば → 書く、食べれ + ば → 食べる
 * 所以同一个假名（如 し）在不同活用下可能对到 す 或 せ/し，必须靠行判断。
 *   あ行→う行、い行→う行、え行→う行。
 * 表中形如 "まむ"：原文音在前、辞书形音在后。
 */
const VOWEL_ROW_SHIFT = (() => {
  // 五十音表：行（辅音）× 段（元音）→ 假名。用表算，避免手写串对不齐。
  const ROWS = {
    '': ['あ', 'い', 'う', 'え', 'お'],
    k: ['か', 'き', 'く', 'け', 'こ'],
    g: ['が', 'ぎ', 'ぐ', 'げ', 'ご'],
    s: ['さ', 'し', 'す', 'せ', 'そ'],
    z: ['ざ', 'じ', 'ず', 'ぜ', 'ぞ'],
    t: ['た', 'ち', 'つ', 'て', 'と'],
    d: ['だ', 'ぢ', 'づ', 'で', 'ど'],
    n: ['な', 'に', 'ぬ', 'ね', 'の'],
    h: ['は', 'ひ', 'ふ', 'へ', 'ほ'],
    b: ['ば', 'び', 'ぶ', 'べ', 'ぼ'],
    p: ['ぱ', 'ぴ', 'ぷ', 'ぺ', 'ぽ'],
    m: ['ま', 'み', 'む', 'め', 'も'],
    y: ['や', null, 'ゆ', null, 'よ'],
    r: ['ら', 'り', 'る', 'れ', 'ろ'],
    w: ['わ', null, null, null, 'を'],
  };
  const VOW = { a: 0, i: 1, u: 2, e: 3, o: 4 };
  const map = {};
  for (const [row, cells] of Object.entries(ROWS)) {
    for (const [v, col] of Object.entries(VOW)) {
      const ch = cells[col];
      if (!ch || v === 'u' || v === 'o') continue;   // 只做 あ/い/え → う
      const target = cells[VOW.u];
      if (!target) continue;
      if (!map[ch]) map[ch] = [];
      if (!map[ch].includes(target)) map[ch].push(target);
    }
  }
  // 片假名同步（カタカナ动词极少，但保持一致）
  for (const k of Object.keys(map)) {
    const kata = String.fromCharCode(k.charCodeAt(0) + 0x60);
    map[kata] = map[k].map((c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
  }
  // 拨音便（口语/文语否定）：つかぬ → つかん → つかむ、わからぬ → わからん → わかる。
  // ん 也可能来自 む/ぶ/ぬ 的促音便或方言，所以只在候选真的存在于词库时才生效
  // （tryDeinflect 的 consider 会做校验），不会凭空造词。
  map['ん'] = ['む', 'ぬ', 'ぶ'];
  map['ン'] = ['ム', 'ヌ', 'ブ'];
  return map;
})();

/**
 * 連用形（い行）→ 辞書形 専用の復元表。
 *
 * 為什麼需要単独一張表、而不併進 VOWEL_ROW_SHIFT：
 * VOWEL_ROW_SHIFT 的語義是「あ行/い行/え行 → う行」，服務的是**音便形**
 * （書い+た → 書く、読ま+ない → 読む）。但「動詞連用形」是**另一個語法現象**：
 *   話し + ます → 話す、書き + ます → 書く、食べ + ます → 食べる
 * 這裡的 し→す、き→く 不是「元音行位移」，而是"連用形詞尾 + 辭書形詞尾"的對應。
 * 舊代碼靠 VOWEL_ROW_SHIFT 順帶覆蓋了一部分（き→く 恰好也在裡面），
 * 但 し→す / ち→つ / に→ぬ / み→む / り→る / び→ぶ 全都漏了 ——
 * 所以「話しています」這種最常見的句子反而还原不了。
 *
 * 表中形如 "しす"：原文音在前、辭書形音在後。
 * 只在候選真的存在於詞庫時才會被採用（consider 會校驗），不會凭空造詞。
 */
const I_ROW_RESTORE = (() => {
  const pairs = [['し', 'す'], ['き', 'く'], ['ぎ', 'ぐ'], ['ち', 'つ'],
    ['に', 'ぬ'], ['み', 'む'], ['り', 'る'], ['び', 'ぶ'], ['ひ', 'ふ']];
  const map = {};
  for (const [from, to] of pairs) {
    map[from] = [to];
    // 片假名同步（カタカナ動詞極少，但保持一致）
    map[String.fromCharCode(from.charCodeAt(0) + 0x60)] = [String.fromCharCode(to.charCodeAt(0) + 0x60)];
  }
  return map;
})();

// ---------------------------------------------------------------------------
// 索引：按首字符分桶，支持最长匹配
// ---------------------------------------------------------------------------
class PrefixIndex {
  constructor(keysObj) {
    this.keys = keysObj || {};
    /** 首字符 → 该字符开头的所有键（长度降序，保证最长匹配优先） */
    this.buckets = new Map();
    this.maxLen = 1;
    /** 单字符键集合（纯假名单字如 を 必须能命中） */
    this.single = new Set();
    for (const k of Object.keys(this.keys)) {
      if (!k) continue;
      const c = k[0];
      let arr = this.buckets.get(c);
      if (!arr) { arr = []; this.buckets.set(c, arr); }
      arr.push(k);
      if (k.length > this.maxLen) this.maxLen = Math.min(k.length, 20);
      if (k.length === 1) this.single.add(k);
    }
    for (const arr of this.buckets.values()) arr.sort((a, b) => b.length - a.length);
  }

  /** 从 text[i] 开始做最长匹配，返回命中的键或 null */
  matchAt(text, i) {
    const c = text[i];
    if (!c) return null;
    const arr = this.buckets.get(c);
    if (!arr) return null;
    const maxLen = Math.min(this.maxLen, text.length - i);
    for (const key of arr) {
      if (key.length > maxLen) continue;
      if (key.length === 1) break;          // 单字符统一放最后判断
      if (text.startsWith(key, i)) return key;
    }
    return this.single.has(c) ? c : null;
  }

  /**
   * 快速判断「以 text[i] 开头是否可能存在任何键」。
   * 用途：假名串里寻找下一个可能的词边界时，靠它把两两枚举压成线性扫描。
   * 只看 1~2 字符前缀，保守（只在确定"绝无可能"时才返回 false）。
   */
  possibleAt(text, i) {
    const c = text[i];
    if (!c) return false;
    if (this.buckets.has(c)) return true;
    const two = text.slice(i, i + 2);
    return two.length === 2 && this.buckets.has(two);
  }
}

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------
const state = {
  ready: false,
  loading: null,
  error: null,
  lookup: null,     // 表面形 → id 列表
  readings: null,   // 读音 → id 列表
  terms: {},        // id → [term, reading, level, zh[], pos[]]
  kanji: {},        // 汉字 → [[读音, 频次], ...]（振假名对齐用）
  romaji: null,
  stats: null,
};

/**
 * 索引文件所在目录，默认 <项目根>/data。
 * 注意：必须用 fileURLToPath 而不是 new URL(...).pathname ——
 * 后者会把路径里的空格编码成 %20（本项目路径就带空格），导致 ENOENT。
 */
const DATA_DIR =
  process.env.JP_LEARN_DATA ||
  path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'data');

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 载入索引。服务启动时调用一次；失败不致命（接口会返回明确错误而不是崩服务）。 */
export async function initTokenizer() {
  if (state.ready) return state;
  if (state.loading) return state.loading;

  state.loading = (async () => {
    try {
      const idxDir = path.join(DATA_DIR, 'index');
      const kanaDir = path.join(DATA_DIR, 'kana');
      const [lookup, readings, terms, romaji] = await Promise.all([
        fsp.readFile(path.join(idxDir, 'lookup.json'), 'utf8').then(JSON.parse),
        fsp.readFile(path.join(idxDir, 'readings.json'), 'utf8').then(JSON.parse),
        fsp.readFile(path.join(idxDir, 'terms.json'), 'utf8').then(JSON.parse),
        fsp.readFile(path.join(kanaDir, 'romaji-table.json'), 'utf8').then(JSON.parse),
      ]);
      // 单字读音表可选：没有也能跑，只是振假名切分退化为均匀分配
      const kanjiDoc = await fsp.readFile(path.join(idxDir, 'kanji.json'), 'utf8')
        .then(JSON.parse).catch(() => null);

      state.lookup = new PrefixIndex(lookup.keys);
      state.readings = new PrefixIndex(readings.keys);
      state.terms = terms.terms || {};
      state.kanji = (kanjiDoc && kanjiDoc.kanji) || {};
      state.romaji = {
        hepburn: new PrefixIndex(romaji.tables.hepburn),
        kunrei: new PrefixIndex(romaji.tables.kunrei),
        particles: romaji.particles || {},
        maxKeyLength: romaji.maxKeyLength || 3,
      };
      state.stats = readJsonSafe(path.join(idxDir, 'manifest.json')) || {};
      state.ready = true;
      state.error = null;
    } catch (e) {
      state.error =
        `词库索引未就绪：${(e && e.message) || e}。` +
        '请先运行 node tools/fetch-data.mjs，再运行 node tools/build-romaji.mjs 与 node tools/build-vocab.mjs。';
      throw new Error(state.error);
    }
    return state;
  })();

  return state.loading;
}

export const isReady = () => state.ready;
export const getIndexError = () => state.error;
export const getIndexStats = () => state.stats;

// ---------------------------------------------------------------------------
// 罗马音
// ---------------------------------------------------------------------------

/** 用最长匹配把假名转成罗马音（不含助词规则，那是上层的事） */
function kanaToRomaji(kana, table) {
  let out = '';
  let i = 0;
  let guard = 0;
  while (i < kana.length && guard++ < 100000) {
    const hit = table.matchAt(kana, i);
    if (hit) {
      out += table.keys[hit];
      i += hit.length;
    } else {
      const ch = kana[i];
      if (RE_LATIN.test(ch)) out += ch;    // 拉丁/数字原样保留
      i++;                                  // 其余无法转换的字符跳过（不编造）
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 振假名（ruby）对齐
// ---------------------------------------------------------------------------

/**
 * 用「单字读音统计」把读音切分到各汉字：对每个汉字片段按统计频次打分，取总分最高的路径（DP）。
 *
 * 为什么比"平均分配"好：
 *   日本語 = にほんご，平均分配得到 に/ほ/んご ❌；
 *   统计表里 日→にち(108) 本→ほん(180) 語→ご(182)，加权后 に/ほん/ご ✅。
 *
 * ── 叠字符（々）的处理 ──
 * 々 在统计表里**没有条目**（它不是一个独立的字），如果不特殊处理，
 * segScore 会给它中性分 1，等于"随便切"，遇到 各々(おのおの) 这类词就可能切错。
 *
 * 但 々 的语义是明确的：**它读作前一个字的读音**（日々=ひ+び、人々=ひと+びと）。
 * 所以这里让 々 **继承前一个字的读音统计**，DP 就有了真实依据。
 * 只在 chars 的每个 々 位置复制一份前字的列表，**不写回 state.kanji**
 * （写回就错了：々 前面的字每次都可能不同，全局表存不下这个依赖关系）。
 *
 * @returns {string[]|null} 每段读音，长度等于 chars.length
 */
function splitReadingByStats(chars, reading) {
  const n = chars.length;
  const L = reading.length;
  if (n <= 0 || L < n) return null;
  if (n === 1) return [reading];

  // 叠字符的统计 = 前一个字的统计。前一个是 々 或没有前字时留空（中性分）。
  const stats = new Array(n);
  for (let k = 0; k < n; k++) {
    if (isIterationMark(chars[k])) stats[k] = k > 0 ? stats[k - 1] : null;
    else stats[k] = state.kanji[chars[k]]
      || (state.kanji[iterationBase(chars[k])] || null);
  }

  const memo = new Map();
  const KEY = (i, j) => i * (L + 1) + j;

  const segScore = (idx, seg) => {
    const list = stats[idx];
    if (!list || !list.length) return 1;    // 该字没有统计：中性分
    for (let k = 0; k < list.length; k++) {
      if (list[k][0] === seg) {
        // 命中统计读音：位置越靠前分越高，并叠加频次
        return 100 - k * 8 + Math.min(list[k][1] || 0, 40) / 10;
      }
    }
    return 1 / (1 + Math.abs(seg.length - 2));  // 未命中：低分但允许
  };

  const walk = (i, j) => {
    if (i === n) return j === L ? 0 : -1e9;
    const k = KEY(i, j);
    if (memo.has(k)) return memo.get(k);
    let best = -1e9;
    const maxLen = L - j - (n - i - 1);     // 给后面的汉字各留 1 个假名
    for (let len = 1; len <= maxLen; len++) {
      const seg = reading.slice(j, j + len);
      const lenPenalty = len > 4 ? (len - 4) * 30 : 0;
      const v = segScore(i, seg) - lenPenalty + walk(i + 1, j + len);
      if (v > best) best = v;
    }
    memo.set(k, best);
    return best;
  };

  if (walk(0, 0) <= -1e8) return null;

  const out = [];
  let i = 0, j = 0;
  while (i < n) {
    let bestVal = -1e9;
    let bestLen = -1;
    const maxLen = L - j - (n - i - 1);
    for (let len = 1; len <= maxLen; len++) {
      const seg = reading.slice(j, j + len);
      const lenPenalty = len > 4 ? (len - 4) * 30 : 0;
      const v = segScore(i, seg) - lenPenalty + walk(i + 1, j + len);
      if (v > bestVal) { bestVal = v; bestLen = len; }
    }
    if (bestLen < 1) return null;
    out.push(reading.slice(j, j + bestLen));
    j += bestLen;
    i++;
  }
  return out.join('') === reading ? out : null;
}

/** 均匀切分（没有单字读音统计时的退路） */
function evenSplit(str, n) {
  if (n <= 0 || str.length < n) return null;
  const total = str.length;
  const base = Math.floor(total / n);
  const extra = total % n;
  const out = [];
  let p = 0;
  for (let i = 0; i < n; i++) {
    const L = base + (i < extra ? 1 : 0);
    out.push(str.slice(p, p + L));
    p += L;
  }
  return out.join('') === str && out.every((x) => x.length > 0) ? out : null;
}

/** 合并相邻的无读音片段，减少 DOM 节点 */
function mergePlain(parts) {
  const out = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && !last.r && !p.r) last.t += p.t;
    else out.push({ ...p });
  }
  return out;
}

/**
 * 把读音分配到词形里的每个汉字（用于渲染 <ruby>漢字<rt>かんじ</rt></ruby>）。
 * 先剥掉词形首尾的送假名及读音中对应部分，再把剩下的读音在汉字之间加权切分。
 *
 * @returns {{ parts: Array<{t:string, r:string}>, estimated: boolean }|null}
 */
function rubyAlign(surface, reading) {
  if (!surface || !reading) return null;
  if (!RE_KANJI_ALIGN.test(surface)) return null;   // 没有汉字就不需要振假名

  // 1) 剥前后送假名
  //    ⚠️ 这一对正则用的是 KANJI_ALIGN（含叠字符），否则 日々 的 々 会被
  //       当成"送假名"剥出去 —— 而它不是送假名，它是汉字本体的一部分。
  let s = surface;
  const preS = (surface.match(new RegExp(`^[^${KANJI_ALIGN}0-9A-Za-z]+`)) || [''])[0];
  let ok = true;
  if (preS) {
    if (reading.startsWith(preS)) s = surface.slice(preS.length);
    else ok = false;
  }
  let r = ok && preS ? reading.slice(preS.length) : reading;
  if (ok) {
    const postS = (s.match(new RegExp(`[^${KANJI_ALIGN}0-9A-Za-z]+$`)) || [''])[0];
    if (postS) {
      if (r.endsWith(postS)) {
        s = s.slice(0, s.length - postS.length);
        r = r.slice(0, r.length - postS.length);
      } else {
        ok = false;
      }
    }
  }
  if (!ok) return { parts: [{ t: surface, r: reading }], estimated: true };

  const kanjiChars = [...s].filter((c) => RE_KANJI_ALIGN.test(c));
  if (!kanjiChars.length) return null;

  // 2) 读音分配到汉字：每段至少 1 个假名
  if (r.length >= kanjiChars.length) {
    const segs = splitReadingByStats(kanjiChars, r) || evenSplit(r, kanjiChars.length);
    if (segs) {
      const parts = [];
      const readPrefix = preS && surface.startsWith(preS) && reading.startsWith(preS) ? preS.length : 0;
      if (readPrefix) parts.push({ t: surface.slice(0, readPrefix), r: '' });
      let ki = 0;
      for (const ch of [...surface].slice(readPrefix)) {
        if (RE_KANJI_ALIGN.test(ch)) {
          parts.push({ t: ch, r: segs[ki] });
          ki++;
        } else {
          parts.push({ t: ch, r: '' });
        }
      }
      return { parts: mergePlain(parts), estimated: false };
    }
  }

  // 3) 退化为整词一个 ruby
  return { parts: [{ t: surface, r: reading }], estimated: true };
}

// ---------------------------------------------------------------------------
// 分词
// ---------------------------------------------------------------------------

/** 取某个表面形的首选词条 id */
function firstId(index, key) {
  const arr = index.keys[key];
  return arr && arr.length ? arr[0] : null;
}

/**
 * 判断单字符命中是否可信。
 *
 * 为什么需要：词库收录了 54 个「单字假名」条目，但它们是汉字的假名写法：
 *   は→歯[は]、が→絵[え]、な→七[しち]、す→巣[す]。
 * 直接采用会造成荒唐结果：
 *   「きれいな花が」被切成 きれい | な[しち 七] | 花 | が[え 絵]
 *
 * 规则：
 *   · 单字**汉字**（花[はな]、本[ほん]、木[き]）→ 接受，它们是真实存在的常用词。
 *   · 单字**假名** → 只有"首选词条的读音 = 该字符本身"时才接受
 *     （を[を]、ん[ん] 接受；は[歯]、が[絵]、な[七] 拒绝）。
 *     拒绝的单字假名会在分词里按助词单独成 token。
 */
function acceptSingleChar(index, ch) {
  if (ch.length !== 1) return null;
  const id = firstId(index, ch);
  if (!id) return null;
  const rec = state.terms[id];
  if (!rec) return null;
  if (RE_KANJI.test(ch)) return id;      // 单字汉字：直接接受
  return rec[1] === ch ? id : null;      // 单字假名：要求读音就是它自己
}

/** 助词的中文说明（词库里 を 之类虽是条目，但释义面向查词，这里给更贴合语法的说明） */
const PARTICLE_GLOSS = {
  は: ['提示主题（读 wa）'],
  が: ['提示主语'],
  を: ['提示宾语（读 o）'],
  に: ['表时间/地点/对象'],
  へ: ['表方向（读 e）'],
  と: ['表并列/引用'],
  で: ['表地点/手段'],
  も: ['也、都'],
  の: ['的（所属/修饰）'],
  や: ['和、或（部分列举）'],
  か: ['疑问、或者'],
  ね: ['确认、感叹'],
  よ: ['告知、强调'],
  な: ['感叹、禁止（接动词原形）'],
  ぞ: ['强调（男性用语）'],
  ぜ: ['强调（男性用语）'],
  わ: ['轻微感叹（女性用语）'],
};

/**
 * 活用还原：找出 text[i..cap) 内「覆盖最长、能还原到词库辞书形」的片段。
 *
 * 为什么需要：词库只有辞书形。实测 data/index/lookup.json 里
 *   使って / 食べます / 咲きました / 勉強した / 生れた 全部未命中，
 * 而真实日文里动词几乎都以活用形出现。不还原的话分词会在最常见的词上崩掉。
 *
 * 做法（非递归，两步）：
 *   ① 后缀替换：把右端的活用后缀换成辞书形可能的词尾
 *        食べ + ます → 食べる（一段动词：词干直接用）
 *        咲き + ました → 咲きる？不行 —— 所以还要第 ② 步
 *   ② 词干末尾假名还原：把活用形里那个假名换回辞书形假名，再配词尾
 *        咲き → 咲(く)，配 く → 咲く ✓
 *   也有"裸词干"的情况：咲き → 咲く、読み → 読む。
 *
 * 排序判据：覆盖更长者优先；覆盖相同时还原步数少者优先。
 *   （例：食べます 既能 食べ+る→食べる（0 次还原），也能 べ→ぶ 再套 ます（1 次），取前者。）
 *
 * @returns {{key,id,base,form,reading,len,stemFix,fixes}|null}
 */
function tryDeinflect(text, i, cap) {
  const limit = Math.min(text.length, cap, i + 12);   // 一个词不会太长，封顶防退化
  let best = null;

  /**
   * @param base     候选辞书形
   * @param consumed 覆盖的原文长度
   * @param form     原文里实际出现的后缀（空串 = 只有词干）
   * @param to       被替换掉的辞书形词尾（空串 = 没替换）
   * @param stemFix  词干末尾假名还原，形如 "きく"（原文音在前、辞书音在后）
   * @param fixes    还原步数（同覆盖时择优）
   */
  /**
   * 同一个覆盖长度、同样步数的多个还原候选之间，怎么选？
   *
   * ⚠️ 原来是"先到先得"（`consider` 里只比 consumed / fixes），
   *    而候选顺序取决于 SUFFIX_RULES 里那个词尾数组的书写顺序。
   *    后果（2026-10 词库放开分级外词之后暴露）：
   *      「わかった」→ った 的候选是 ['う','つ','る']，
   *      ・わか + つ → わかつ → 词库命中「分かつ」（无 JLPT 等级、生僻）
   *      ・わか + る → わかる → 词库命中「分かる」（N5、常用）
   *    两者 consumed 和 fixes 完全相同，先到先得让**生僻词**赢了，
   *    用户查 わかった 会看到"分かつ"—— 明显不对。
   */

  /**
   * 平手时"哪个更像用户要查的词"的排序（数字越小越优先）。
   *
   * 两级判据：
   *   ① 有 JLPT 等级（N5..N1）的优先 —— 等级是"这词值得学"的最强信号。
   *   ② 同级时：**表记与输入一致**的优先。用户输入的是假名（つかぬ），
   *      那么辞书形也是假名的「つかう」比汉字表记的「浸かる」更可能是他要的
   *      （他要是想查汉字，就会输入汉字）。
   *
   * 起因（词库放开分级外词之后暴露的两个真错）：
   *   · わかった → わか+つ →「分かつ」（无等级）比 わか+る →「分かる」(N5) 先到先得
   *   · つかぬ   → 词干位移先命中「浸かる」，「つかう」(N5) 反而轮不上
   * 两处都不是"变形规则错"，而是**同分候选挑错了**。
   */
  const candRank = (id, surface) => {
    const rec = state.terms[id];
    if (!rec) return 99;
    const lv = rec[2] ? 0 : 10;
    const kanaMatch = RE_KANA_ONLY.test(surface || '') && !RE_KANJI.test(rec[0] || '') ? 0 : 1;
    return lv + kanaMatch;
  };

  const consider = (base, consumed, form, to, stemFix, fixes) => {
    const id = firstId(state.lookup, base);
    if (!id || !state.terms[id]) return;
    if (!best
      || consumed > best.consumed
      || (consumed === best.consumed && fixes < best.fixes)
      || (consumed === best.consumed && fixes === best.fixes
        && candRank(id, base) < candRank(best.id, best.base))) {
      best = { id, base, consumed, form, to, stemFix, fixes };
    }
  };

  for (const [end, tos] of SUFFIX_RULES) {
    for (let sp = i + 1; sp + end.length <= limit; sp++) {
      if (!text.startsWith(end, sp)) continue;
      const stem = text.slice(i, sp);
      if (!stem.length) continue;
      const consumed = sp + end.length - i;

      // ① 词干直接用（一段动词：食べ + ます → 食べる）
      for (const to of tos) consider(stem + to, consumed, end, to, '', 0);

      // ② 词干末尾假名按元音行位移回辞书形（五段动词）：
      //     咲き + ました → 咲 + きました → 咲く；読ま + ない → 読む
      //     同時也要试「連用形詞尾 → 辞書形詞尾」那一套（話し+て → 話す），
      //     両者只是候選來源不同，命中判定完全一樣，所以合成一個数組合併跑。
      const last = stem[stem.length - 1];

      // ② 词干末尾假名按元音行位移回辞书形（五段动词）：
      //     咲き + ました → 咲 + きました → 咲く；読ま + ない → 読む
      //     同時也要试「連用形詞尾 → 辞書形詞尾」那一套（話し+て → 話す），
      //     両者只是候選來源不同，命中判定完全一樣，所以合成一個数組合併跑。
      // 见 NO_STEM_SHIFT_SUFFIX 的注释：裸て形/た形后缀不做词干末尾位移。
      const fixes = NO_STEM_SHIFT_SUFFIX.has(end)
        ? []
        : [...(VOWEL_ROW_SHIFT[last] || []), ...(I_ROW_RESTORE[last] || [])];
      for (const fixed of fixes) {
        const stem2 = stem.slice(0, -1) + fixed;
        const stemFix = last + fixed;
        consider(stem2, consumed, end, fixed, stemFix, 1);           // 还原后本身就是辞书形
        for (const to of tos) consider(stem2 + to, consumed, end, to, stemFix, 1);
      }
    }
  }

  // ③ 裸词干：咲き → 咲く、読み → 読む、話し → 話す（没有活用语尾，只有ます形词干）
  {
    const stem = text.slice(i, limit);
    if (stem.length >= 2) {
      const last = stem[stem.length - 1];
      for (const fixed of [...(VOWEL_ROW_SHIFT[last] || []), ...(I_ROW_RESTORE[last] || [])]) {
        const base = stem.slice(0, -1) + fixed;
        const id = firstId(state.lookup, base);
        if (id && state.terms[id]) {
          const consumed = stem.length;
          // 平手时同样按"有 JLPT 等级者优先"（见 candRank 的注释）。
          // 这里也必须用同一条判据，否则会出现"两个入口给出不同答案"：
          // わかれる（可能形）走的就是这条裸词干路径，不用会还原成生僻的「別れる」。
          if (!best || consumed > best.consumed
            || (consumed === best.consumed && candRank(id, base) < candRank(best.id, best.base))) {
            best = { id, base, consumed, form: '', to: fixed, stemFix: last + fixed, fixes: 1 };
          }
        }
      }
    }
  }

  if (!best) return null;
  const h = best;
  const dictReading = (state.terms[h.id] && state.terms[h.id][1]) || '';

  // ---- 由辞书形读音推出原文读音 ----
  // 原文读音 = 辞书形词干读音（减去被替换的音） + 词干末尾还原回的音 + 实际后缀
  //   咲く[さく] (き↔く) + ました  → さ + き + ました = さきました
  //   食べる[たべる] (无还原) + ます → たべ + ます = たべます
  const fixFrom = h.stemFix ? h.stemFix[0] : '';
  const fixTo = h.stemFix ? h.stemFix[h.stemFix.length - 1] : '';
  const stripTail = fixTo || h.to || '';
  let reading = stripTail && dictReading.endsWith(stripTail)
    ? dictReading.slice(0, dictReading.length - stripTail.length)
    : dictReading;
  if (fixFrom && fixTo) reading += fixFrom;
  if (h.to) reading += h.form;

  return {
    key: text.slice(i, i + h.consumed),
    id: h.id,
    base: h.base,
    form: h.form || h.stemFix,
    reading,
    len: h.consumed,
    stemFix: h.stemFix,
    fixes: h.fixes,
    // 辞书形以假名结尾 → 是动词/形容词活用，可信度高。
    // 这个标志是 matchWord 的准入条件：只有像动词的还原才允许覆盖词库直接命中，
    // 否则「生れ」这类本身就是词库条目的形会被误还原。
    verbLike: RE_KANA_ONLY.test(h.base[h.base.length - 1] || ''),
  };
}

/**
 * 把一个活用形**拆开讲清楚**（工具箱的「活用还原器」用）。
 *
 * 和 tokenize() 的区别：tokenize 只告诉你"这是哪个词"，这里要告诉学习者
 * **「它是怎么变来的」** —— 这是自学者查词典查不到的关键一步：
 * 词典只收辞书形，看到 食べさせられた 根本不知道从哪查起。
 *
 * 复用 tryDeinflect 的匹配结果，再由匹配结果反推出人类可读的推导步骤。
 * 不重新实现一套规则 —— 两套规则迟早会不一致。
 *
 * @param {string} input 用户输入（可以是单个活用形，也可以是一小段话）
 * @returns {{input,found,results:Array}}
 */
export function explainDeinflect(input) {
  const text = String(input || '').trim();
  if (!text) return { input: text, found: false, results: [] };
  if (!state.ready) return { input: text, found: false, error: state.error || '词库索引尚未就绪', results: [] };

  const results = [];
  const seen = new Set();

  /** 把词条精简信息 + 匹配结果整理成完整的解释 */
  const build = (surface, d) => {
    const term = state.terms[d.id];
    if (!term) return null;
    const dict = term[0];
    const dictReading = term[1] || '';
    const steps = [];

    // 步骤 1：原样摆出来，学习者才知道后面在改什么
    steps.push({ kind: 'input', from: surface, to: surface, note: '原文出现的写法' });

    // 步骤 2：拆后缀。词干末尾的假名归位是「元音行位移」，
    //   归位之后还可能再补一个辞书形词尾（如 咲き → 咲 + く = 咲く）。
    const suffix = d.form || '';
    const afterStrip = suffix ? surface.slice(0, surface.length - suffix.length) : surface;
    if (suffix) {
      steps.push({ kind: 'suffix', from: surface, to: afterStrip, note: `拿掉后缀「${suffix}」` });
    }
    if (d.stemFix) {
      steps.push({
        kind: 'vowel',
        from: afterStrip,
        to: dict,
        note: `词干末尾「${d.stemFix[0]}」按元音行位移归位成「${d.stemFix[d.stemFix.length - 1]}」，`
          + `得到辞书形「${dict}」`,
      });
    } else if (dict !== afterStrip) {
      // 没有元音位移、但辞书形不同 → 是"补上辞书形词尾"的情形（食べ → 食べる）
      steps.push({ kind: 'restore', from: afterStrip, to: dict, note: `补上辞书形词尾，得到「${dict}」` });
    }

    // 最后一步统一标成"结果"，界面据此高亮
    if (steps.length) {
      const last = steps[steps.length - 1];
      steps[steps.length - 1] = { ...last, kind: 'result', note: `辞书形「${dict}」—— 词典里查得到的就是这个形` };
    }

    return {
      surface,
      dict,
      reading: d.reading || dictReading,   // 原文读音
      dictReading,                          // 辞书形读音
      zh: (term[3] || []).slice(0, 4),
      pos: (term[4] || []).slice(0, 2),
      level: term[2] || '',
      id: d.id,
      stemFix: d.stemFix || '',
      suffix,
      fixes: d.fixes || 0,
      alreadyDict: surface === dict,
      steps,
    };
  };

  /**
   * 已经就是辞书形时的解释（不需要还原）。
   * 注意：doc 注释必须完整写出来，别漏了开头或结尾的星号
   * —— 少一个字符就会把下面整段函数吞进注释里，症状是"函数未定义"。
   */
  const buildDirect = (surface, id) => {
    const term = state.terms[id];
    if (!term) return null;
    return {
      surface, dict: term[0], reading: term[1] || '', dictReading: term[1] || '',
      zh: (term[3] || []).slice(0, 4), pos: (term[4] || []).slice(0, 2),
      level: term[2] || '', id, stemFix: '', suffix: '', fixes: 0,
      alreadyDict: true,
      steps: [{ kind: 'result', from: surface, to: term[0], note: '本身就是辞书形，不需要还原' }],
    };
  };

  /** 造一条"带说明的"解释（用于几种规则的通用还原覆盖不了的情形） */
  const buildSpecial = (surface, dict, dictId, steps, extra = {}) => {
    const term = dictId ? state.terms[dictId] : null;
    return {
      surface,
      dict,
      reading: extra.reading || (term ? term[1] : '') || '',
      dictReading: term ? term[1] || '' : '',
      zh: term ? (term[3] || []).slice(0, 4) : [],
      pos: term ? (term[4] || []).slice(0, 2) : [],
      level: term ? term[2] || '' : '',
      id: dictId || null,
      stemFix: '', suffix: extra.suffix || '', fixes: 1,
      alreadyDict: false,
      special: extra.kind || '',
      steps,
    };
  };

  /**
   * 三种规则覆盖不了、但学习者一定会碰到的情形。
   *
   * 为什么必须单独写（每条都是实测还原不出来的）：
   *   1. サ変複合動詞：索引里**没有**「勉強する」这个表记
   *      （data/index/lookup.json 实测：勉強する → 无，只有 勉強 和 する），
   *      所以 勉強した 会被拆成 勉強 + した，还原不出"する"。
   *      同理 為る 的索引命中是 する/なる 两个，也不可靠。
   *      规则：末尾是「し」+ た/て/ます/ない/よう… → 词干 + する。
   *   2. 断定助动词：だ/だった/です/でした 都不是词库条目，
   *      却被元音行位移表误配成假词（だった → づつ）。
   *   3. 使役受身：食べさせられた 这类有三层（使役+受身+过去），
   *      后缀表最多剥一层，剥完剩「食べさせられ」还是查不到。
   *      规则：剥掉 させられる/させられた → 词干 + 辞书形词尾。
   */
  const specialExplain = (s) => {
    const out = [];

    // ---- 0) 「する」这一族：必须先挡住，否则会被通用规则冤判 ----
    //    //
    // ⚠️ 这是实测发现的一个**真错**，而且错得很隐蔽：
    //    通用规则把「して」判成了「知る」—— 因为「〜て」这条后缀规则里
    //    写着词尾可以是「る」，于是 して 被当成"知る 的て形"，
    //    还原器给出的答案是「知る」，而正确答案是「する」。
    //    同理 した / しない / します / すれば 也都会被带偏。
    //
    //    为什么必须在这里（specialExplain 的最前面）挡：
    //      「する」是**不规则动词**，形态上不服从任何通用规则 ——
    //      通用规则能"解释"它，但解释出来的都是别的词。
    //      对不规则词只能**先点名**，再交给通用规则处理剩下的。
    //
    //    另外，这条也顺带修好了"正向变形引擎 → 还原器"的往返验证：
    //      conj.js 推出的 して/した/します… 丢回来，终于能回到「する」。
    {
      const SURU_FORMS = ['します', 'しました', 'しません', 'しませんでした',
        'しない', 'しなかった', 'して', 'した', 'すれば', 'しよう', 'しましょう',
        'しろ', 'できる', 'される', 'させる', 'させられる', 'している', 'する'];
      if (SURU_FORMS.includes(s)) {
        out.push(buildSpecial(s, 'する', null, [
          { kind: 'input', from: s, to: s, note: '原文出现的写法' },
          { kind: 'result', from: s, to: 'する', note: '「する」是不规则动词（サ变），它的各种形态要整条记住，不能按通用规则拆' },
        ], { kind: 'suru', suffix: '' }));
        return out;
      }
    }

    // ---- 1) サ変複合動詞 ----
    // 守卫两条，缺一不可：
    //   ① 词干本身必须**确实是词库里的一个词**（否则「はし」→「はする」之类乱命中）；
    //   ② 「词干 + す」不能也是个真词 —— 否则 話しています 会被当成
    //      「話」+「する」，而正确答案是「話す」。这一条是实测踩出来的。
    {
      const m = s.match(/^(.+?)し(た|て|ます|ました|ている|ています|たい|ない|なかった|よう|ろ|続ける|始める|終わる)$/);
      if (m && (state.lookup.keys[m[1]] || []).length && !firstId(state.lookup, m[1] + 'す')) {
        const stem = m[1];
        const tail = m[2];
        const dict = stem + 'する';
        out.push(buildSpecial(s, dict, null, [
          { kind: 'input', from: s, to: s, note: '原文出现的写法' },
          { kind: 'suffix', from: s, to: stem + 'し', note: '拿掉「' + tail + '」' },
          { kind: 'result', from: stem + 'し', to: dict, note: '「' + stem + '」是サ変複合動詞，加上「する」就是辞书形（词库里通常只收「' + stem + '」和「する」两条）' },
        ], { kind: 'suru', suffix: tail }));
        return out;
      }
    }

    // ---- 2) 使役受身 ----
    // ⚠️ 顺序：这条**必须排在断定助动词前面**。
    //    理由：食べさせられた 的尾部也能被断定的正则匹配到
    //    （stem = 食べさせら，尾 = だ），但断定的守卫查不到「食べさせら」这个词，
    //    于是它会先返回空、把机会让给通用规则，最后落到"没找到"。
    //    把使役受身放在前面，「食べ」+ る 才能正确命中 食べる。
    {
      const CAUS_TAILS = ['させられなかった', 'させられます', 'させられた', 'させられて',
        'させられない', 'させられる', 'されなかった', 'されます', 'された', 'されて', 'されない', 'される'];
      for (const tail of CAUS_TAILS) {
        if (!s.endsWith(tail) || s.length <= tail.length) continue;
        const stem = s.slice(0, s.length - tail.length);
        const lastCh = stem[stem.length - 1];
        const stemBase = stem.slice(0, -1);
        // ⚠️ 这里有两套**语义不同**的候选，混起来就会出错（连着踩了两次）：
        //    A. 替换：stemBase + 单个假名  → 行か → 行く（か 换成 く）
        //       VOWEL_ROW_SHIFT / I_ROW_RESTORE 给的就是这种单假名候选。
        //    B. 接续：stem + 一整个音节     → 食べ → 食べる（べ 不动，后面接 る）
        //       一段动词走这条：辞书形词尾是「べる」这个音节，不是「る」一个假名。
        //    先写成"统一 stemBase + to"，一段动词就会拼出「食る」这种不存在的词，
        //    正确答案 食べる 根本不在候选里 —— 结果落到兜底的「食う」上。
        //
        // ⚠️ 顺序决定对错：食べさせられた 的词干是「食べ」，
        //    真词里有 食べる（正确）也有 食う（错误），必须让 食べる 先被看到。
        //    判据是"词干末尾假名落在 い行/え行"（一段动词几乎都长这样）。
        const isIchidan = I_ROW_STEM.has(lastCh);
        const cands = [];
        if (isIchidan) {
          // B 优先：整个音节接上去
          cands.push({ dict: stem + 'る', to: 'べる' });
        }
        // A：把末尾假名换行
        for (const to of [...(VOWEL_ROW_SHIFT[lastCh] || []), ...(I_ROW_RESTORE[lastCh] || [])]) {
          cands.push({ dict: stemBase + to, to });
        }
        if (!isIchidan) {
          // 非一段时，「词干 + 辞书形词尾」也值得一试（例：来させられる → 来る 这类）
          for (const to of DICT_ENDINGS) cands.push({ dict: stem + to, to });
        }
        for (const c of cands) {
          const dict = c.dict;
          const id = firstId(state.lookup, dict);
          if (!id || !state.terms[id]) continue;
          out.push(buildSpecial(s, dict, id, [
            { kind: 'input', from: s, to: s, note: '原文出现的写法' },
            { kind: 'suffix', from: s, to: stem, note: '拿掉「' + tail + '」（使役・受身・时态合在一起的语尾）' },
            { kind: 'result', from: stem, to: dict, note: '补上辞书形词尾「' + c.to + '」，得到「' + dict + '」' },
          ], { kind: 'causative-passive', suffix: tail }));
          break;
        }
        if (out.length) return out;
      }
    }

    // ---- 3) 断定助动词（名词/ナ形容词 + だ/です）----
    // 守卫三条，缺一不可：
    //   ① 词干至少 2 个字 —— 否则「まだ」会被切成「ま」+「だ」，
    //      而 ま 恰好是「まあ」的假名形，于是 まだ 被解释成"まあ"（实测发生过）；
    //   ② 词干必须**单独是一个词库条目**（否则 体 会被切成 体 + だ）；
    //   ③ 词干**不能以 さ/せ 结尾** —— 「行かされた」的字面切分正是
    //      行かさ + だ（さ 是使役的痕迹），不排除的话会被解释成"行かさ + だ"。
    //      （使役受身规则已排在这条前面，这一守卫是第二道防线。）
    // 注意：「だ/です」这类断定助动词**不能**写进 SUFFIX_RULES。
    //    通用还原要求"还原结果必须是词库条目"，而 だ/です 本身不是词条，
    //    所以规则永远无效；而且「だった」还会被 ['った'] 规则抢走，
    //    还原成假词「づつ」。这正是当初 静かだった → づつ 的成因。
    {
      const m = s.match(/^(.+?)(だったら|だった|でした|です|だ)$/);
      const stemTail = m ? m[1][m[1].length - 1] : '';
      if (m && m[1].length >= 2 && stemTail !== 'さ' && stemTail !== 'せ'
        && (state.lookup.keys[m[1]] || []).length) {
        const stem = m[1];
        const tail = m[2];
        const id = (state.lookup.keys[stem] || [])[0];
        out.push(buildSpecial(s, stem, id, [
          { kind: 'input', from: s, to: s, note: '原文出现的写法' },
          { kind: 'suffix', from: s, to: stem, note: '拿掉断定助动词「' + tail + '」' },
          { kind: 'result', from: stem, to: stem, note: '「' + stem + '」是名词/ナ形容词，「' + tail + '」只是断定（是／曾是），词典里查「' + stem + '」' },
        ], { kind: 'copula', suffix: tail }));
        return out;
      }
    }

    return out;
  };

  const add = (surface, d) => {
    const key = surface + '→' + d.id;
    if (seen.has(key)) return;
    seen.add(key);
    const r = build(surface, d);
    if (r) results.push(r);
  };
  const pushRaw = (r) => {
    if (!r) return;
    const key = r.surface + '→' + (r.id || r.dict);
    if (seen.has(key)) return;
    seen.add(key);
    results.push(r);
  };

  // 0) 先试"规则覆盖不了但一定要会"的三种情形（使役受身 / サ変複合動詞 / 断定助动词）。
  //    必须排在最前：否则 静かだった 会先被通用规则误还原成「づつ」，
  //    而错误结果一旦进了 results，正确解释就再也轮不上了。
  //    整串先试；整串不是"一个词"时，留给下面 B) 对每个 token 再试。
  {
    const specials = specialExplain(text);
    if (specials.length) {
      for (const r of specials) pushRaw(r);
      return { input: text, found: true, results };
    }
  }

  // A) 整串先当"一个词"试：用户多半就是输入一个活用形
  const hit = matchWord(text, 0);
  if (hit && hit.len === text.length) {
    if (hit.inflected) {
      const d = tryDeinflect(text, 0, text.length);
      if (d) add(text, d);
    } else {
      const r = buildDirect(text, hit.id);
      if (r) { seen.add(text + '→' + hit.id); results.push(r); }
      // ⚠️ 直接命中**不等于**"它就没有活用解释"。
      //    例子：わかれる 本身就是词库条目「別れる」，但它同时也是
      //    「分かる」的可能形。只给"別れる"的话，用户在工具箱里问
      //    "わかれる 是什么形"会被告知"本身就是辞书形，不需要还原" —— 对，
      //    但他真正想问的那个答案没出现。
      //    所以直接命中之后**再补一次还原尝试**，把活用解释也列出来。
      //    注意用 add()（会去重、会 build）而不是直接 push，避免和
      //    下面的分值逻辑打架；顺序上直接命中仍然排在前面。
      const d2 = tryDeinflect(text, 0, text.length);
      if (d2 && d2.key === text) add(text, d2);
    }
  }

  // B) 整串不是一个词 → 当句子分词，把里面**发生活用**的词逐个解释。
  //    ⚠️ tokenize() 返回的是**数组**本身，不是 {tokens: [...]}（踩过：写成
  //    tokenize(text).tokens 会得到 undefined，句子永远"没找到"）。
  //    另外 token 上**没有** index 字段，还原时要自己用 indexOf 算偏移。
  if (!results.length) {
    let tokens = [];
    try { tokens = tokenize(text) || []; } catch (e) { tokens = []; }
    if (!Array.isArray(tokens)) tokens = tokens.tokens || [];
    let cursor = 0;
    for (const t of tokens) {
      if (!t || !t.surface) continue;
      const at = text.indexOf(t.surface, cursor);
      if (at < 0) continue;
      cursor = at + t.surface.length;
      // B1) 先让"特殊情形"看一眼这个 token。
      //     句子里的断定助动词（「静かだったので…」里的「だった」）、使役受身
      //     通用规则都处理不了，只有 specialExplain 认得出。
      //     注意：**不能**只对 t.inflected 的 token 做这一步 ——
      //     「だった」被分词器当成了一个"活用形"，但「です」之类的 token
      //     未必带 inflected 标志，漏掉就会退化成"没找到"。
      const sp = specialExplain(t.surface);
      if (sp.length) {
        for (const r of sp) pushRaw({ ...r, at });
        continue;
      }

      if (!t.inflected || !t.id) continue;
      // ⚠️ 这里必须传 **token 自己**、从 0 开始，不能传 (text, at)。
      //    tryDeinflect 的第一个参数就是"待还原的字符串"，
      //    误传长文本 + 起始下标会让它从整个句子的第 at 位往后扫，
      //    结果只切出尾巴（实测：行かされた → 只还原出「れた」→「列」）。
      const d = tryDeinflect(t.surface, 0, t.surface.length + 8);
      if (d && d.key === t.surface) add(t.surface, d);
    }
  }

  // C) 兜底：还原不上、分词也没找到活用词 —— 但整串可能本身就是辞书形
  if (!results.length) {
    const bySurface = (state.lookup.keys && state.lookup.keys[text]) || [];
    const byReading = (state.readings.keys && state.readings.keys[text]) || [];
    const id = bySurface[0] || byReading[0];
    if (id && state.terms[id]) {
      const r = buildDirect(text, id);
      if (r) results.push(r);
    }
  }

  return { input: text, found: results.length > 0, results };
}

/**
 * 在位置 i 找一个「词」：直接命中词库 与 活用还原 都试，取覆盖更长的那个。
 * 覆盖相同时优先活用还原 —— 活用形是真实出现的语法形，
 * 而单字命中往往只是"汉字被当成了词"（如把 食べます 的「食」当成名词 食[しょく]）。
 *
 * @returns {{key,id,len,form,base,reading,inflected,verbLike}|null}
 */
function matchWord(text, i) {
  const ch = text[i];

  // A) 直接命中
  let direct = null;
  const hit = state.lookup.matchAt(text, i);
  if (hit) {
    if (hit.length > 1) {
      direct = { key: hit, id: firstId(state.lookup, hit), len: hit.length, form: '', reading: null, inflected: false, verbLike: false };
    } else {
      const id = acceptSingleChar(state.lookup, hit);
      if (id) direct = { key: hit, id, len: 1, form: '', reading: null, inflected: false, verbLike: false };
    }
  }

  // B) 活用还原（只对含汉字或假名的片段有意义）
  let deinf = null;
  if (RE_KANJI.test(ch) || RE_KANA.test(ch)) {
    let cap = text.length;
    if (RE_KANJI.test(ch)) {
      let runEnd = i;
      while (runEnd < text.length && RE_KANJI.test(text[runEnd])) runEnd++;
      cap = Math.min(text.length, runEnd + 8);   // 汉字串 + 后面的假名词尾
    } else {
      cap = Math.min(text.length, i + 8);        // 纯假名：别把长串整段当动词
    }
    const d = tryDeinflect(text, i, cap);
    if (d && d.verbLike) {
      deinf = { key: d.key, id: d.id, len: d.len, form: d.form, base: d.base, reading: d.reading, inflected: true, verbLike: true };
    }
  }

  // ⚠️ 平手时**直接命中优先**（这里曾经是 `deinf.len >= direct.len`，踩过坑）。
  //
  //    实例：この本はとても面白かったです。
  //      词库里 とても 是 N5 副词，直接命中、长度 3。
  //      但「とて」也会被活用还原成「撮る」—— 词干 と + 后缀 て，长度也是 3。
  //      用 `>=` 时还原结果胜出，于是 とても 被切成「と + て」两个碎片，
  //      整句的分词、读音、罗马音全错（用户看到的是 konohonwatotemoomoshiro…）。
  //
  //    为什么平手必须让给直接命中：
  //      · 直接命中是**词库里就有这个词**，是事实；
  //      · 还原只是"看起来像某个活用的形"，是猜测。
  //      有事实时不该让猜测赢。
  //
  //    为什么只在平手时才让、其余照旧：
  //      「見当がつかぬ」里的 見当 直接命中（长度 2）、「がつ」还原成 がつ
  //      —— 那种情况还原结果更长，仍然应该赢（否则会吞掉助词 が）。
  //      所以只把 `>=` 收成 `>`，不动别的。
  return direct && deinf ? (deinf.len > direct.len ? deinf : direct) : (deinf || direct);
}

/**
 * 把叠字符接到前一个 token 上，并算出叠加后的读音。
 *
 * 语义：々 读作前一个字的读音。所以 山々 = やま + やま = やまやま。
 * 浊化（日々=ひび、人々=ひとびと、国々=くにぐに）由数据表里的整词读音负责 ——
 * **词库里有 91 个带叠字符的词，全部带正确读音**，所以能命中的一律走词库，
 * 只有词库没有的（山々／木々／星々 这类）才走这条推导路，而它们基本都是不浊化的。
 *
 * @returns {{surface:string, reading:string}|null} 接不上就返回 null
 */
function appendIterationMark(prev, mark) {
  if (!prev || typeof prev.surface !== 'string' || !prev.surface) return null;
  const baseCh = prev.base || prev.surface;
  if (!/^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]$/.test(baseCh)) return null;
  if (isIterationMark(baseCh)) return null;
  const prevReading = prev.reading || '';
  // 前一个 token 的读音就是那个字的读音（它是单字 token，见调用点）
  const lastReading = prevReading || '';
  const surface = prev.surface + mark;
  return { surface, reading: lastReading ? lastReading + lastReading : '' };
}

/**
 * 合并相邻的「未知汉字」片段：它们大概率属于同一个未收录的词，
 * 合成一个 token 对用户更友好（也少一次"不认识"的提示）。
 * 注意：未知汉字后面若跟着已知词/助词，不会跨越合并。
 *
 * ⚠️ 这里用 RE_KANJI_ALIGN 而不是 RE_KANJI：
 *    未收录的叠字词（山々 不在词库里）会被切成 山 + 々 两个片段，
 *    只有把 々 也认成"汉字"，这两个片段才会被合并回 山々。
 *    否则界面上会出现一个孤零零的「々」token（既没读音也没释义），
 *    而它左边那个字又只有一半的读音 —— 正是用户报的那个现象。
 */
function isKanjiAlignedSurface(x) {
  return !!x && !x.known && !x.isParticle && !x.isKana && !x.isOther
    && !x.isLatin && !x.isPunct && RE_KANJI_ALIGN.test(x.surface);
}
function mergeUnknownKanji(tokens) {
  const out = [];
  for (const t of tokens) {
    const last = out[out.length - 1];
    if (isKanjiAlignedSurface(last) && isKanjiAlignedSurface(t)) {
      last.surface += t.surface;
      if (!last.reading && t.reading) last.reading = t.reading;
      else if (last.reading && t.reading) last.reading += t.reading;
    } else out.push(t);
  }
  return out;
}

/**
 * 把日文文本切成 token。
 *
 * 处理顺序：
 *   1. 空白 / 标点 / 数字拉丁 → 独立 token
 *   2. 词库命中（含活用还原）→ 已知词，带假名读音
 *   3. 汉字串未命中 → 整段未知（日语连续汉字基本都是同一个词）
 *   4. 假名串未命中 → 在助词/词尾边界切开，避免整段被吞
 *   5. 其余 → 单字符未知
 *
 * 未知片段 reading 一律留空并标 known:false —— 不用单字音读去猜，猜错比空着更害人。
 */
export function tokenize(text) {
  if (!state.ready) throw new Error(state.error || '词库索引尚未加载');
  const s = String(text ?? '');
  const tokens = [];
  let i = 0;
  let guard = 0;

  const pushKnown = (key, id, extra) => {
    const rec = id ? state.terms[id] : null;
    const t = {
      surface: key,
      known: true,
      id: id || null,
      reading: (extra && extra.reading) || (rec ? rec[1] : '') || '',
      level: rec ? rec[2] || '' : '',
      zh: rec ? rec[3] || null : null,
      pos: rec && rec[4] ? rec[4][0] || '' : '',
    };
    if (extra && extra.form) {
      t.form = extra.form;      // 语法形（て形/丁宁体/过去…）
      t.base = extra.base;      // 辞书形
      t.inflected = true;
    }
    tokens.push(t);
  };
  const pushUnknown = (surface, kind) => {
    if (!surface) return;
    const t = { surface, known: false, id: null, reading: '', level: '', zh: null, pos: '' };
    if (kind) t[kind] = true;
    if (kind === 'isParticle') {
      // 助词单独成 token 并给语法说明：它们读音特殊（は→wa、へ→e、を→o），
      // 而且词库里的同形条目是别的词（は＝歯），不能直接用。
      t.known = true;
      t.reading = surface;
      t.zh = PARTICLE_GLOSS[surface] || null;
      t.pos = '助词';
      t.id = null;
    }
    tokens.push(t);
    return t;
  };

  while (i < s.length && guard++ < 200000) {
    const ch = s[i];

    // 0) 叠字符（々／〆）接龙 —— **必须放在最前面**（见下面标点分支的说明）。
    //
    //    语义：々 读作前一个字的读音。词库里带叠字符的词（共 91 个）全都有正确读音，
    //    所以能整词命中的一律走词库；走不到这里就说明词库没有（山々／木々／星々）。
    //    这时把 々 接到前一个单字 token 上，并推导读音（前字的读音重复一次），
    //    而不是留下一个孤立的「々」—— 那样用户既看不到读音，也不知道它是什么。
    //
    //    ⚠️ 只接"前一个 token 就是一个汉字"的情况。像 一ヶ所 这种
    //       一 + ヶ所 的切法（ヶ所 是词库里的词）不该被改。
    if (isIterationMark(ch) && (ch === '\u3005' || ch === '\u3006')) {
      const prev = tokens[tokens.length - 1];
      const baseCh = prev && (prev.base || prev.surface);
      if (prev && typeof baseCh === 'string'
          && /^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]$/.test(baseCh)
          && !isIterationMark(baseCh)) {
        const merged = appendIterationMark(prev, ch);
        if (merged) {
          // 就算前一个字命中了词库（山 是词），合并后整体是"词库没有的词"，
          // 所以要转成未知 token：known=false、清掉词条引用和释义。
          prev.known = false;
          prev.id = null;
          prev.zh = null;
          prev.level = '';
          prev.pos = '';
          prev.surface = merged.surface;
          if (merged.reading) prev.reading = merged.reading;
          i++;
          continue;
        }
      }
      // 接不上（前面没有单字汉字）→ 交给下面的普通逻辑，至少别丢字符
    }

    // 1) 空白
    if (/\s/.test(ch)) {
      let j = i;
      while (j < s.length && /\s/.test(s[j])) j++;
      tokens.push({ surface: s.slice(i, j), known: true, id: null, reading: '', level: '', zh: null, pos: '', isSpace: true });
      i = j;
      continue;
    }

    // 2) 标点
    //    ⚠️⚠️ 这几行**必须**在叠字符判断之后（`isIterationMark(ch) ||`）！
    //    因为 々(U+3005) 和 〆(U+3006) 在 Unicode 里落在 CJK 符号区
    //    \u3000-\u303f，**正好被 RE_PUNCT 覆盖**。不先拦住的话：
    //      · 々 会被当成标点，标点分支直接 continue → 它永远到不了汉字分支
    //      · mergeUnknownKanji 又因为 isPunct 不合并它
    //      · 结果：山々 变成「山」+ 一个孤立标点「々」，日々 的词内对齐也拿不到 々
    //    这是用户报的"々 识别不了、罗马音掉到振假名同一行"的真正根因。
    //    （ヶ 在 U+30F6 不在这个区，不受影响，但一起判断更稳。）
    if (RE_PUNCT.test(ch) && !isIterationMark(ch)) {
      tokens.push({ surface: ch, known: true, id: null, reading: '', level: '', zh: null, pos: '', isPunct: true });
      i++;
      continue;
    }

    // 3) 数字/拉丁
    if (RE_LATIN.test(ch)) {
      let j = i;
      while (j < s.length && RE_LATIN.test(s[j])) j++;
      while (j < s.length && /[.,'’]/.test(s[j]) && RE_LATIN.test(s[j + 1] || '')) j++;
      const seg = s.slice(i, j);
      tokens.push({ surface: seg, known: true, id: null, reading: seg, level: '', zh: null, pos: '', isLatin: true });
      i = j;
      continue;
    }

    // 4) 词（含活用还原）
    // 最长匹配优先：先按当前位置能匹配到的最长词切；切不动时再逐级缩短位置，
    // 直到剩下一个单字（单字也切不动就交给下面的未知片段逻辑）。
    // 这样 花柄 会整词命中，而 今日は 会先被词库整体命中、再由 4a 拆成 今日 + は。
    {
      // 选「下一个词」，分两个阶段：
      //  ① 先只问 i 本身：能成词就用（在 i 的所有候选里取最长）。
      //     必须优先于往后扫，否则「見当がつかぬ」会先命中「がつ」而吞掉助词 が。
      //  ② i 完全不成词时，才在窗口内往后找最近的成词位置，
      //     把 i 到那里之间的内容当作未知片段（多为未收录的汉字串）。
      let hit = matchWord(s, i);
      let hitAt = i;
      if (!hit) {
        const scanEnd = Math.min(s.length, i + 16);
        for (let k = i + 1; k < scanEnd; k++) {
          const w = matchWord(s, k);
          if (w) { hit = w; hitAt = k; break; }
        }
      }
      if (hit) {
        // 4a) 词尾是单字助词、且去掉它之后前缀本身也是词库里的词时，把助词拆出来。
        //     词库里「今日は」是一个叹词条目，但句子里通常是「今日 + は」；
        //     不拆的话罗马音会变成 konnichiha（应为 konnichiwa），助词也无法单独点击查询。
        //     拆不出来（如 こんにちは 的 こんにち 不是词）就保持整词，不硬拆。
        //
        // ⚠️⚠️ 但"尾巴是助词"**不等于**"该拆"。这里踩过一个很隐蔽的坑：
        //
        //   句子：この本はとても面白かったです。（词表重建后 test-tokenizer 变红）
        //     ① 最长匹配在 は 的位置拿到「はと」—— 词库里确实有这个词（戸／外）。
        //     ② 4a 看它尾巴 と 是助词、头「は」也查得到，于是拆成「は + と」。
        //     ③ 这一拆把 と 吃掉了，后面的「とても」再也接不上（とても 的首字是 と），
        //        只剩「て」「も」各自成碎片。整句分词/读音/罗马音全错。
        //
        //   注意 とても 单独出现时完全正常 —— 所以这个 bug 只在"前面恰好有个助词"
        //   时暴露，非常难从现象反推。
        //
        //   为什么会这样：这是**贪心最长匹配**的固有弱点。在 は 这个位置上，
        //   「はと」(2 字) 比「は」(1 字) 长，贪心就选了它，却没看见
        //   "放弃 はと 能让 とても 成立"这件事。彻底的解法是全局最优切分（DP），
        //   这里先用一条**有界前瞻**把这类错法挡住（只用相邻一个位置，代价可忽略）。
        //
        //   规则：如果让出尾字之后，从尾字开始能构成一个更长的词，
        //        说明这个"词"其实横跨了真正的词边界 → 让出尾字。
        //        具体让法：先把**首字**按它的本相处理（是助词就按助词），
        //        然后从尾字位置重新进入主循环，让它自己去匹配更长的词。
        //   为什么是让"首字"而不是别的：只有首字之前的部分（= 空）与它是安全的，
        //        让出的尾字留给后面的匹配，正好把 はと 拆成 は|とても。
        const lastCh = hit.key[hit.key.length - 1];
        if (hit.key.length > 1 && !hit.inflected && PARTICLE_SET.has(lastCh)) {
          const head = hit.key.slice(0, -1);
          const headId = firstId(state.lookup, head);
          // 只对短词做前瞻，避免影响正常的词内助词（如 今日は）
          let yieldTail = false;
          if (headId && hit.len <= 3) {
            const tailAt = hitAt + hit.key.length - 1;            // 尾字所在位置
            const cand = state.lookup.matchAt(s, tailAt);          // 从尾字开始能匹配什么
            if (cand && cand.length > hit.len && firstId(state.lookup, cand)) yieldTail = true;
          }
          if (headId && yieldTail) {
            const firstCh = hit.key[0];
            if (hitAt > i) pushUnknown(s.slice(i, hitAt), RE_KANJI_ALIGN.test(s[i]) ? undefined : 'isKana');
            if (PARTICLE_SET.has(firstCh)) pushUnknown(firstCh, 'isParticle');
            else pushKnown(firstCh, firstId(state.lookup, firstCh), null);
            i = hitAt + 1;          // 从第二个字重新开始，留给后面去匹配
            continue;
          }
          if (headId) {
            if (hitAt > i) pushUnknown(s.slice(i, hitAt), RE_KANJI_ALIGN.test(s[i]) ? undefined : 'isKana');
            pushKnown(head, headId, null);
            pushUnknown(lastCh, 'isParticle');
            i = hitAt + hit.len;
            continue;
          }
        }
        // 从 i 到 hitAt 之间的内容没有成词：未知片段（多为汉字串或假名残片）
        // ⚠️ 判断"是不是汉字串"要用 RE_KANJI_ALIGN：山々 会先命中「山」，
        //    中间的 々 走的就是这条路，用 RE_KANJI 会把它标成 isKana，
        //    于是 mergeUnknownKanji 不再认为它和 山 同类，合并失败、
        //    界面上留下一个孤立的「々」。
        if (hitAt > i) pushUnknown(s.slice(i, hitAt), RE_KANJI_ALIGN.test(s[i]) ? undefined : 'isKana');
        pushKnown(hit.key, hit.id, hit);
        i = hitAt + hit.len;
        continue;
      }
    }

    // 5) 汉字串未命中 → 整段未知
    //    ⚠️ 条件里带上 isIterationMark，且后面额外吸收 々〆。
    //       未收录的叠字词（山々）在词库里查不到，会走到这里；
    //       如果不把 々 一起收进来，它就会掉进"兜底"分支变成孤立 token，
    //       前一个字那半个读音也就丢了 —— 正是用户报的那个现象。
    if (RE_KANJI.test(ch) || isIterationMark(ch)) {
      let j = i;
      while (j < s.length && RE_KANJI.test(s[j])) j++;
      // 只额外吸收紧跟在汉字后面的「々／〆」—— 它们是**纯粹的重复记号**，
      // 一定属于前一个词。⚠️ 刻意**不吃 ヶ**：ヶ 是量词（三ヶ月／一ヶ所），
      // 它既可能属于前词也可能自成一段，而词库里 ヶ月／ヶ所 都是独立词条。
      // 实测：把 ヶ 也吃进来会让 三ヶ月 变成「三ヶ（さんさん）」—— 反而错了。
      while (j < s.length && (s[j] === '\u3005' || s[j] === '\u3006')) j++;
      const t = pushUnknown(s.slice(i, j));
      if (t) t.base = ch;   // 记住原始字，叠字符接龙时要看它
      i = j;
      continue;
    }

    // 6) 假名串：按"下一个可能成词的位置"和助词边界切开
    if (RE_KANA.test(ch)) {
      // 先取纯假名范围；紧随其后的标点属于"别的东西"，稍后单独补上，
      // 不然后面 s.slice(i,end) 会把标点粘进未知片段（出现「り、」这种 token）。
      let j = i;
      while (j < s.length && RE_KANA.test(s[j])) j++;
      const punctLen = (j < s.length && RE_PUNCT.test(s[j])) ? 1 : 0;
      let end = j;
      for (let k = i + 1; k < j; k++) {
        if (!state.lookup.possibleAt(s, k)) continue;
        const inner = matchWord(s, k);
        if (inner) { end = k; break; }
      }
      const seg = s.slice(i, end);
      if (seg.length === 1) {
        pushUnknown(seg, PARTICLE_SET.has(seg) ? 'isParticle' : 'isKana');
      } else {
        // 逐字切：单字助词单独成 token，便于正确标罗马音（は→wa）
        let buf = '';
        for (const c of seg) {
          if (PARTICLE_SET.has(c) || c === 'っ' || c === 'ッ') {
            if (buf) { pushUnknown(buf, 'isKana'); buf = ''; }
            pushUnknown(c, PARTICLE_SET.has(c) ? 'isParticle' : 'isKana');
          } else {
            buf += c;
          }
        }
        if (buf) pushUnknown(buf, 'isKana');
      }
      i = end;
      // 补上刚被切出去的标点（仅当它没有被上面的切分吸收）
      if (punctLen && end === j) {
        tokens.push({ surface: s[j], known: true, id: null, reading: '', level: '', zh: null, pos: '', isPunct: true });
        i = j + 1;
      }
      continue;
    }

    // 7) 兜底
    pushUnknown(ch, 'isOther');
    i++;
  }

  return mergeUnknownKanji(tokens);
}

// ---------------------------------------------------------------------------
// 注音装饰与对外主接口
// ---------------------------------------------------------------------------

/** 给 token 补上振假名与罗马音 */
function decorate(tokens, opts) {
  const { romajiStyle = 'hepburn', particleRule = true, ruby = true } = opts || {};
  const table = romajiStyle === 'kunrei' ? state.romaji.kunrei : state.romaji.hepburn;

  const out = [];
  for (const t of tokens) {
    const d = { ...t };

    // 振假名
    if (ruby && t.known && t.reading && RE_KANJI.test(t.surface)) {
      const al = rubyAlign(t.surface, t.reading);
      if (al) {
        d.ruby = al.parts;
        d.rubyEstimated = al.estimated;
      }
    }

    // 罗马音：单独成词的 は/へ/を 走助词读音
    let src = t.reading || t.surface;
    let done = false;
    if (particleRule && t.surface && t.surface.length === 1 && state.romaji.particles[t.surface]) {
      const bareParticle = !t.known || t.reading === t.surface;
      if (bareParticle) {
        const p = state.romaji.particles[t.surface];
        d.romaji = romajiStyle === 'kunrei' ? p.kunrei : p.hepburn;
        done = true;
      }
    }
    if (!done) d.romaji = (t.isSpace || t.isPunct) ? '' : kanaToRomaji(src || '', table);

    out.push(d);
  }

  // 整行罗马音 = 各 token 拼接。
  // 这样 今日は 若被词库整体命中为「こんにちは」，就不会被误读成 wa。
  const romaji = out.map((t) => t.romaji || '').join('');
  return { tokens: out, romaji };
}

/**
 * 解析一行日文：分词 + 注音 + 罗马音。
 *
 * @param {string} text
 * @param {{romajiStyle?:'hepburn'|'kunrei', particleRule?:boolean, ruby?:boolean}} opts
 * @returns {{kana,romaji,tokens,knownCount,unknownCount,coverage,unknownSurfaces,rubyEstimated,error?}}
 */
export function buildReading(text, opts = {}) {
  const s = String(text ?? '');
  if (!state.ready) {
    // 索引没准备好时如实报告，不假装成功
    return {
      kana: '', romaji: '', tokens: [],
      knownCount: 0, unknownCount: 0, coverage: 0, unknownSurfaces: [], rubyEstimated: 0,
      error: state.error || '词库索引尚未加载',
    };
  }

  const { tokens, romaji } = decorate(tokenize(s), opts);

  let kana = '';
  let known = 0;
  let unknown = 0;
  let rubyEst = 0;
  const unknownSurfaces = [];
  for (const t of tokens) {
    if (t.isSpace || t.isPunct) { kana += t.surface; continue; }
    if (t.known) {
      kana += t.reading || t.surface;
      known++;
    } else {
      // 未知片段：假名能保留，汉字留空（不猜）
      kana += t.surface.replace(RE_KANJI_RUN, '');
      unknown++;
      if (unknownSurfaces.length < 12 && RE_KANJI.test(t.surface)) unknownSurfaces.push(t.surface);
    }
    if (t.rubyEstimated) rubyEst++;
  }

  const denom = known + unknown;
  return {
    kana: kana.trim(),
    romaji,
    tokens,
    knownCount: known,
    unknownCount: unknown,
    coverage: denom ? Math.round((known / denom) * 1000) / 10 : 100,
    unknownSurfaces,
    rubyEstimated: rubyEst,
  };
}

/**
 * 用一个**用户给定的读音**给某个词形生成振假名对齐结果。
 *
 * 用途：汉字多音，程序猜的读音未必是歌里唱的那个。用户在界面上改读音时，
 * 客户端不能自己算对齐（那套 DP 在这里，而且它依赖 data/index/kanji.json 的统计），
 * 所以由服务端算好、客户端只负责显示。
 *
 * 与 buildReading 的分工：
 *   buildReading  —— 给定**文本**，让程序去猜读音
 *   buildRubyFor  —— 给定**词形 + 读音**，只做对齐，不猜
 *
 * @param {string} surface 词形（如 今日 / 人々）
 * @param {string} reading 用户给的读音（平假名/片假名，如 こんにち）
 * @returns {{surface,reading,ruby,romaji,estimated}|null} 参数不合法返回 null
 */
export function buildRubyFor(surface, reading) {
  const s = String(surface ?? '').trim();
  const r = String(reading ?? '').trim();
  if (!s || !r) return null;
  // 读音必须是纯假名：用户可能输入罗马音或汉字，那种情况明确退回，不硬猜
  if (!RE_KANA_ONLY.test(r)) return null;
  const aligned = rubyAlign(s, r);
  // ⚠️ kanaToRomaji 需要**罗马音表**作为第二个参数（表在 state.romaji 里，
  //    由 initTokenizer 加载）。不传表会抛 "Cannot read properties of undefined"。
  //    这里默认用平文式（hepburn）—— 和歌词页默认的罗马音风格一致。
  let romaji = '';
  try { romaji = kanaToRomaji(r, state.romaji.hepburn); } catch { romaji = ''; }
  return {
    surface: s,
    reading: r,
    // 对不上时 rubyAlign 会返回"整词一个 rt"并标 estimated:true —— 照实告诉客户端，
    // 界面上会显示成"这个读音对不齐"的提示，而不是假装对齐成功。
    ruby: aligned ? aligned.parts : [{ t: s, r }],
    estimated: aligned ? !!aligned.estimated : true,
    romaji,
  };
}

/**
 * 把片假名归一化成平假名，供查词做"同音"比对。
 *
 * ⚠️ 为什么必须有它（用户报的 bug）：输入 カタ（片假名）时一条都查不到，
 *   因为索引里的读音键是 **かた**（平假名），严格相等永远不成立。
 *   日语里同一个音既可以写平假名也可以写片假名，查词必须视作等价。
 *
 * ⚠️⚠️ 但不能闭着眼睛"减 0x60"。有三个片假名**没有对应的平假名**，
 *   机械转换会把一个正常的词变成乱码：
 *
 *     ヴ U+30F4 → U+3094（ゔ）   ゔ 在日语里基本不用，只出现在现代外来语
 *     ヵ U+30F5 → U+3095（ゕ）   同样几乎不用
 *     ヶ U+30F6 → U+3096（ゖ）   同样几乎不用
 *
 *   📌 这不是理论问题：`ヴ` 在 readings.json 里**出现 146 次**
 *     （アイヴォリー / アヴェニュー / アクティヴ …）。
 *     把它们也转换，就等于"查 ヴィラ 永远查不到，因为键被改写成了乱码"。
 *
 *   这个坑是**测试抓出来的**：我一开始写了一条断言说 ヴィラ → ゔぃら，
 *   跑出来才发现那个结果本身就是坏的。所以现在**排除掉这三个字符**，
 *   让它们原样保留 —— 片假名对片假名，比较照样成立。
 *
 * 长音符 ー（U+30FC）在片假名区但两边通用，本来就不该动。
 */
export function kanaNormalize(s) {
  // 排除 U+30F4（ヴ）、U+30F5（ヵ）、U+30F6（ヶ）：它们没有可用的平假名对应
  return String(s ?? '').replace(/[\u30a1-\u30f3]/g,
    (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/**
 * 查词。支持汉字形、假名形与读音。
 *
 * 假名查询会**同时搜平假名与片假名**（例如「かた」也能查到片假名词条）。
 *
 * @returns {{query, exact, byReading}}
 */
export function lookup(query) {
  if (!state.ready) throw new Error(state.error || '词库索引尚未加载');
  const q = String(query ?? '').trim();
  const results = [];
  const seen = new Set();
  const collect = (ids, how) => {
    for (const id of ids || []) {
      if (seen.has(id)) continue;
      seen.add(id);
      const rec = state.terms[id];
      if (!rec) continue;
      results.push({ id, term: rec[0], reading: rec[1], level: rec[2], zh: rec[3] || [], pos: rec[4] || [], matchedBy: how });
    }
  };
  if (state.lookup.keys[q]) collect(state.lookup.keys[q], 'surface');
  // 读音键：原样一次，再把片假名归一化成平假名再一次。
  // 只查**归一化后**的键就够了（索引的读音键基本都是平假名），
  // 但原样那次也留着 —— 万一日后索引里出现片假名读音键，不至于漏。
  if (state.readings.keys[q]) collect(state.readings.keys[q], 'reading');
  const nq = kanaNormalize(q);
  if (nq !== q && state.readings.keys[nq]) collect(state.readings.keys[nq], 'reading');
  return {
    query: q,
    exact: results.filter((r) => r.matchedBy === 'surface'),
    byReading: results.filter((r) => r.matchedBy === 'reading'),
  };
}

/** 取词条精简信息（完整释义含例句在 data/vocab/*.json，由前端按需加载） */
export function getTerm(id) {
  const rec = state.terms[id];
  if (!rec) return null;
  return { id, term: rec[0], reading: rec[1], level: rec[2], zh: rec[3] || [], pos: rec[4] || [] };
}

// 以下导出只为便于写单元测试与排查（tools/_test-tokenizer.mjs 会用到）
export const _internals = { tryDeinflect, matchWord, rubyAlign, splitReadingByStats, kanaToRomaji, tokenize, mergeUnknownKanji, isIterationMark };
