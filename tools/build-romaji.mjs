// ============================================================================
// build-romaji.mjs —— 生成「假名 → 罗马音」数据表（零依赖）
//
// 产物（都在 data/kana/）：
//   kana-table.json    五十音表 + 浊音/半浊音/拗音的结构化数据（给前端五十音图用）
//   romaji-table.json  最长匹配用的「假名串 → 罗马音」映射 + 规则元数据（给注音/罗马音用）
//
// 设计取舍（为什么要有 romaji-table.json 这份"展开表"）：
//   罗马音本质是"最长匹配 + 少数特殊规则"（促音 っ、长音 ー、拨音 ん、助词 は/へ/を）。
//   与其在服务端写一大堆分支，不如在构建期把 1~3 个假名的所有组合都展开成一张表，
//   运行期只要"从当前位置贪心取最长能命中的键"就行 —— 简单、快、不易出错。
//   表大小约 10 万字符以内（本地服务传输，完全不需要担心体积）。
//
// 两种罗马音体系：
//   hepburn（黑本式，默认）：し=shi ち=chi つ=tsu ふ=fu じ=ji しゃ=sha じゃ=ja
//   kunrei （训令式/日本式）：し=si  ち=ti  つ=tu  ふ=hu  じ=zi しゃ=sya じゃ=zya
//
// 用法: node tools/build-romaji.mjs
// ============================================================================
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'data', 'kana');

const log = (...a) => console.log(...a);

// ---------------------------------------------------------------------------
// 一、基础表：清音 / 浊音 / 半浊音
// 每项 [平假名, 片假名, 黑本式, 训令式]；训令式留空表示与黑本式相同
// ---------------------------------------------------------------------------
const BASE = [
  // あ行
  ['あ', 'ア', 'a'], ['い', 'イ', 'i'], ['う', 'ウ', 'u'], ['え', 'エ', 'e'], ['お', 'オ', 'o'],
  // か行
  ['か', 'カ', 'ka'], ['き', 'キ', 'ki'], ['く', 'ク', 'ku'], ['け', 'ケ', 'ke'], ['こ', 'コ', 'ko'],
  // さ行
  ['さ', 'サ', 'sa'], ['し', 'シ', 'shi', 'si'], ['す', 'ス', 'su'], ['せ', 'セ', 'se'], ['そ', 'ソ', 'so'],
  // た行
  ['た', 'タ', 'ta'], ['ち', 'チ', 'chi', 'ti'], ['つ', 'ツ', 'tsu', 'tu'], ['て', 'テ', 'te'], ['と', 'ト', 'to'],
  // な行
  ['な', 'ナ', 'na'], ['に', 'ニ', 'ni'], ['ぬ', 'ヌ', 'nu'], ['ね', 'ネ', 'ne'], ['の', 'ノ', 'no'],
  // は行
  ['は', 'ハ', 'ha'], ['ひ', 'ヒ', 'hi'], ['ふ', 'フ', 'fu', 'hu'], ['へ', 'ヘ', 'he'], ['ほ', 'ホ', 'ho'],
  // ま行
  ['ま', 'マ', 'ma'], ['み', 'ミ', 'mi'], ['む', 'ム', 'mu'], ['め', 'メ', 'me'], ['も', 'モ', 'mo'],
  // や行
  ['や', 'ヤ', 'ya'], ['ゆ', 'ユ', 'yu'], ['よ', 'ヨ', 'yo'],
  // ら行
  ['ら', 'ラ', 'ra'], ['り', 'リ', 'ri'], ['る', 'ル', 'ru'], ['れ', 'レ', 're'], ['ろ', 'ロ', 'ro'],
  // わ行
  ['わ', 'ワ', 'wa'], ['ゐ', 'ヰ', 'wi', 'i'], ['ゑ', 'ヱ', 'we', 'e'], ['を', 'ヲ', 'wo', 'o'],
  // 拨音
  ['ん', 'ン', 'n'],
  // 浊音
  ['が', 'ガ', 'ga'], ['ぎ', 'ギ', 'gi'], ['ぐ', 'グ', 'gu'], ['げ', 'ゲ', 'ge'], ['ご', 'ゴ', 'go'],
  ['ざ', 'ザ', 'za'], ['じ', 'ジ', 'ji', 'zi'], ['ず', 'ズ', 'zu'], ['ぜ', 'ゼ', 'ze'], ['ぞ', 'ゾ', 'zo'],
  ['だ', 'ダ', 'da'], ['ぢ', 'ヂ', 'ji', 'zi'], ['づ', 'ヅ', 'zu', 'du'], ['で', 'デ', 'de'], ['ど', 'ド', 'do'],
  ['ば', 'バ', 'ba'], ['び', 'ビ', 'bi'], ['ぶ', 'ブ', 'bu'], ['べ', 'ベ', 'be'], ['ぼ', 'ボ', 'bo'],
  // 半浊音
  ['ぱ', 'パ', 'pa'], ['ぴ', 'ピ', 'pi'], ['ぷ', 'プ', 'pu'], ['ぺ', 'ペ', 'pe'], ['ぽ', 'ポ', 'po'],
  // ヴ（外来语）
  ['ゔ', 'ヴ', 'vu', 'bu'],
  // 小写假名（单独出现时按元音处理）
  ['ぁ', 'ァ', 'a'], ['ぃ', 'ィ', 'i'], ['ぅ', 'ゥ', 'u'], ['ぇ', 'ェ', 'e'], ['ぉ', 'ォ', 'o'],
  ['ゃ', 'ャ', 'ya'], ['ゅ', 'ュ', 'yu'], ['ょ', 'ョ', 'yo'],
  ['ゎ', 'ヮ', 'wa'],
  ['ゕ', 'ヵ', 'ka'], ['ゖ', 'ヶ', 'ke'],
];

// ---------------------------------------------------------------------------
// 二、拗音（い段 + 小写や/ゆ/ょ）
// 同样 [平假名, 片假名, 黑本式, 训令式]
// ---------------------------------------------------------------------------
const YOON = [
  ['きゃ', 'キャ', 'kya'], ['きゅ', 'キュ', 'kyu'], ['きょ', 'キョ', 'kyo'],
  ['しゃ', 'シャ', 'sha', 'sya'], ['しゅ', 'シュ', 'shu', 'syu'], ['しょ', 'ショ', 'sho', 'syo'],
  ['ちゃ', 'チャ', 'cha', 'tya'], ['ちゅ', 'チュ', 'chu', 'tyu'], ['ちょ', 'チョ', 'cho', 'tyo'],
  ['にゃ', 'ニャ', 'nya'], ['にゅ', 'ニュ', 'nyu'], ['にょ', 'ニョ', 'nyo'],
  ['ひゃ', 'ヒャ', 'hya'], ['ひゅ', 'ヒュ', 'hyu'], ['ひょ', 'ヒョ', 'hyo'],
  ['みゃ', 'ミャ', 'mya'], ['みゅ', 'ミュ', 'myu'], ['みょ', 'ミョ', 'myo'],
  ['りゃ', 'リャ', 'rya'], ['りゅ', 'リュ', 'ryu'], ['りょ', 'リョ', 'ryo'],
  ['ぎゃ', 'ギャ', 'gya'], ['ぎゅ', 'ギュ', 'gyu'], ['ぎょ', 'ギョ', 'gyo'],
  ['じゃ', 'ジャ', 'ja', 'zya'], ['じゅ', 'ジュ', 'ju', 'zyu'], ['じょ', 'ジョ', 'jo', 'zyo'],
  ['ぢゃ', 'ヂャ', 'ja', 'zya'], ['ぢゅ', 'ヂュ', 'ju', 'zyu'], ['ぢょ', 'ヂョ', 'jo', 'zyo'],
  ['びゃ', 'ビャ', 'bya'], ['びゅ', 'ビュ', 'byu'], ['びょ', 'ビョ', 'byo'],
  ['ぴゃ', 'ピャ', 'pya'], ['ぴゅ', 'ピュ', 'pyu'], ['ぴょ', 'ピョ', 'pyo'],
  // 外来语常见合拗音
  ['ふぁ', 'ファ', 'fa'], ['ふぃ', 'フィ', 'fi'], ['ふぇ', 'フェ', 'fe'], ['ふぉ', 'フォ', 'fo'],
  ['ふゅ', 'フュ', 'fyu'],
  ['てぃ', 'ティ', 'ti'], ['でぃ', 'ディ', 'di'], ['とぅ', 'トゥ', 'tu'], ['どぅ', 'ドゥ', 'du'],
  ['つぁ', 'ツァ', 'tsa'], ['つぃ', 'ツィ', 'tsi'], ['つぇ', 'ツェ', 'tse'], ['つぉ', 'ツォ', 'tso'],
  ['うぁ', 'ウァ', 'wa'], ['うぃ', 'ウィ', 'wi'], ['うぇ', 'ウェ', 'we'], ['うぉ', 'ウォ', 'wo'],
  ['しぇ', 'シェ', 'she', 'sye'], ['じぇ', 'ジェ', 'je', 'zye'], ['ちぇ', 'チェ', 'che', 'tye'],
  ['すぃ', 'スィ', 'si'], ['ずぃ', 'ズィ', 'zi'],
  ['きぇ', 'キェ', 'kye'], ['ぎぇ', 'ギェ', 'gye'], ['にぇ', 'ニェ', 'nye'],
  ['ひぇ', 'ヒェ', 'hye'], ['びぇ', 'ビェ', 'bye'], ['ぴぇ', 'ピェ', 'pye'],
  ['みぇ', 'ミェ', 'mye'], ['りぇ', 'リェ', 'rye'],
  ['いぇ', 'イェ', 'ye'],
  ['くぁ', 'クァ', 'kwa'], ['くぃ', 'クィ', 'kwi'], ['くぇ', 'クェ', 'kwe'], ['くぉ', 'クォ', 'kwo'],
  ['ぐぁ', 'グァ', 'gwa'],
  // ヴ + 小写元音：这是"整体读 va/vi/ve/vo"，不能拆成 vu+a（否则 ヴァイオリン 会变成 vuaiorin）
  ['ゔぁ', 'ヴァ', 'va'], ['ゔぃ', 'ヴィ', 'vi'], ['ゔぇ', 'ヴェ', 've'], ['ゔぉ', 'ヴォ', 'vo'],
];

// ---------------------------------------------------------------------------
// 三、构建映射
// ---------------------------------------------------------------------------
const SOKUON = ['っ', 'ッ'];

/** 生成 { kana串: {hepburn, kunrei} } 的基础映射（不含促音/长音规则） */
function buildBaseMap() {
  const map = new Map();
  const add = (hira, kata, hep, kun) => {
    const entry = { hepburn: hep, kunrei: kun || hep };
    map.set(hira, entry);
    map.set(kata, entry);
    // 片假名长音符单独处理；半角片假名不处理（上游数据里基本不出现）
  };
  for (const [h, k, hep, kun] of BASE) add(h, k, hep, kun);
  for (const [h, k, hep, kun] of YOON) add(h, k, hep, kun);
  return map;
}

/** 促音前缀：把下一个音的首辅音字母双写（っか→kka、っさ→ssa、っし→sshi）。
 *  特例 ch：っ 在 ch 前写作 t，即 っち→tchi、っちゃ→tcha。
 *  依据：まっちゃ = matcha 是标准黑本式写法，这正是「t + cha」的结果；
 *        同理 こっち = kotchi、しゅっちょう = shutchou。 */
function sokuonPrefix(nextRomaji) {
  if (!nextRomaji) return '';
  if (/^ch/.test(nextRomaji)) return 't';
  const m = nextRomaji.match(/^[bcdfghjklmnpqrstvwxyz]/);
  return m ? m[0] : '';
}

const VOWELS = 'aiueo';

/** 长音符 ー：重复前一个元音 */
function lastVowel(romaji) {
  for (let i = romaji.length - 1; i >= 0; i--) {
    if (VOWELS.includes(romaji[i])) return romaji[i];
  }
  return '';
}

/**
 * 把「基础映射」展开成 1~3 个假名的全部最长匹配键。
 * 只展开真正可能出现的组合，避免无意义的爆炸：
 *   · 1 个假名：全部基础表
 *   · 2 个假名：基础 + 拗音（拗音本身就是 2 个假名）+ 促音/长音组合
 *   · 3 个假名：只做「促音 + 拗音」这一种真实存在的形式（っきゃ 之类）
 */
function expand(baseMap) {
  const hepburn = {};
  const kunrei = {};

  const put = (kana, h, k) => {
    if (!hepburn[kana]) hepburn[kana] = h;
    if (!kunrei[kana]) kunrei[kana] = k;
  };

  // 1 个假名
  for (const [kana, e] of baseMap) {
    put(kana, e.hepburn, e.kunrei);
  }

  // 促音 + 假名（2 个假名）
  for (const [kana, e] of baseMap) {
    const p = sokuonPrefix(e.hepburn);
    put(SOKUON[0] + kana, p + e.hepburn, p + e.kunrei);
    put(SOKUON[1] + kana, p + e.hepburn, p + e.kunrei);
  }

  // 长音符（假名 + ー）
  for (const [kana, e] of baseMap) {
    const v = lastVowel(e.hepburn);
    if (v) {
      put(kana + 'ー', e.hepburn + v, e.kunrei + v);
      put(kana + '－', e.hepburn + v, e.kunrei + v); // 全角连字符也当长音
    }
  }

  // 促音 + 拗音（3 个假名，如 っきゃ / っしゃ / っちゃ）
  for (const [kana, e] of baseMap) {
    if (kana.length !== 2) continue; // 只要拗音
    const p = sokuonPrefix(e.hepburn);
    put(SOKUON[0] + kana, p + e.hepburn, p + e.kunrei);
    put(SOKUON[1] + kana, p + e.hepburn, p + e.kunrei);
  }

  return { hepburn, kunrei };
}

// ---------------------------------------------------------------------------
// 四、自检（构建期就把错误暴露出来，而不是等用户在歌词里看到乱码）
// ---------------------------------------------------------------------------
function selfTest(hepburn, kunrei) {
  const problems = [];
  let cases = 0;
  const expect = [
    // [假名, 黑本式, 训令式]
    ['ありがとう', 'arigatou', 'arigatou'],
    ['ありがとうございました', 'arigatougozaimashita', 'arigatougozaimasita'],
    ['しんぶん', 'shinbun', 'sinbun'],
    ['がっこう', 'gakkou', 'gakkou'],
    ['ちょっと', 'chotto', 'tyotto'],
    ['きょう', 'kyou', 'kyou'],
    ['しゃしん', 'shashin', 'syasin'],
    ['じゃあ', 'jaa', 'zyaa'],
    ['コーヒー', 'koohii', 'koohii'],
    ['ふるさと', 'furusato', 'hurusato'],
    ['つくえ', 'tsukue', 'tukue'],
    ['ちいさい', 'chiisai', 'tiisai'],
    ['ふじさん', 'fujisan', 'huzisan'],
    ['ぴったり', 'pittari', 'pittari'],
    // 促音在 ch 前写作 t（依据：まっちゃ = matcha，这是标准黑本式写法）。
    // 本转换器遵循同一个规则，所以 ピッチャー → pitcha、しゅっちょう → shutchou。
    // 说明：外来语里确实有人把 ピッチャー 写成 piccha，但那是外来语照搬英文拼法，
    // 不属于「按假名机械转写」的范畴。本工具的原则是规则一致、可预测。
    ['まっちゃ', 'matcha', 'mattya'],
    ['ピッチャー', 'pitcha', 'pittya'],
    ['しゅっちょう', 'shutchou', 'syuttyou'],
    ['こっち', 'kotchi', 'kotti'],
    ['いっしょ', 'issho', 'issyo'],
    ['きっさてん', 'kissaten', 'kissaten'],
    // 外来语的小写假名：ティ 是一个整体，发音是 ti 而不是 tei
    ['ティッシュ', 'tisshu', 'tissyu'],
    ['パーティー', 'paatii', 'paatii'],
    ['ヴァイオリン', 'vaiorin', 'vaiorin'],
    ['ヴィーナス', 'viinasu', 'viinasu'],
  ];
  for (const [kana, hep, kun] of expect) {
    const h = convert(kana, hepburn, 'hepburn');
    const k = convert(kana, kunrei, 'kunrei');
    cases += 2;
    if (h !== hep) problems.push(`黑本式 ${kana}: 期望 ${hep}，实际 ${h}`);
    if (k !== kun) problems.push(`训令式 ${kana}: 期望 ${kun}，实际 ${k}`);
  }
  return { problems, cases };
}

/** 与运行期算法一致的最长匹配转换（只看表，不含助词规则） */
function convert(str, table, _kind) {
  let out = '';
  let i = 0;
  let guard = 0;
  while (i < str.length && guard++ < 10000) {
    let matched = false;
    for (let len = 3; len >= 1; len--) {
      const key = str.slice(i, i + len);
      if (table[key] !== undefined) {
        out += table[key];
        i += len;
        matched = true;
        break;
      }
    }
    if (!matched) i++; // 表外的字符（汉字/标点/拉丁字母）直接跳过
  }
  return out;
}

// ---------------------------------------------------------------------------
// 五、五十音图结构（给前端渲染用）
// ---------------------------------------------------------------------------
const GOJUON_LAYOUT = [
  { row: 'あ', cells: ['あ', 'い', 'う', 'え', 'お'] },
  { row: 'か', cells: ['か', 'き', 'く', 'け', 'こ'] },
  { row: 'さ', cells: ['さ', 'し', 'す', 'せ', 'そ'] },
  { row: 'た', cells: ['た', 'ち', 'つ', 'て', 'と'] },
  { row: 'な', cells: ['な', 'に', 'ぬ', 'ね', 'の'] },
  { row: 'は', cells: ['は', 'ひ', 'ふ', 'へ', 'ほ'] },
  { row: 'ま', cells: ['ま', 'み', 'む', 'め', 'も'] },
  { row: 'や', cells: ['や', '', 'ゆ', '', 'よ'] },
  { row: 'ら', cells: ['ら', 'り', 'る', 'れ', 'ろ'] },
  { row: 'わ', cells: ['わ', '', '', '', 'を'] },
  { row: 'ん', cells: ['ん', '', '', '', ''] },
];
const DAKUON_LAYOUT = [
  { row: 'が', cells: ['が', 'ぎ', 'ぐ', 'げ', 'ご'] },
  { row: 'ざ', cells: ['ざ', 'じ', 'ず', 'ぜ', 'ぞ'] },
  { row: 'だ', cells: ['だ', 'ぢ', 'づ', 'で', 'ど'] },
  { row: 'ば', cells: ['ば', 'び', 'ぶ', 'べ', 'ぼ'] },
  { row: 'ぱ', cells: ['ぱ', 'ぴ', 'ぷ', 'ぺ', 'ぽ'] },
];

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
log('\n=== 构建假名 / 罗马音表 ===');

const baseMap = buildBaseMap();
const { hepburn, kunrei } = expand(baseMap);

log(`  基础假名条目：${baseMap.size / 2} 个（平假名+片假名成对）`);
log(`  最长匹配表（黑本式）：${Object.keys(hepburn).length} 个键`);
log(`  最长匹配表（训令式）：${Object.keys(kunrei).length} 个键`);

log('\n  自检 ...');
const { problems, cases } = selfTest(hepburn, kunrei);
if (problems.length) {
  log('  ✗ 自检失败：');
  for (const p of problems) log('     · ' + p);
  process.exitCode = 1;
} else {
  log(`  ✓ ${cases} 组转换用例全部通过`);
}

// 五十音图数据：附带每种假名的两种罗马音
const kanaTable = {
  format: 'jp-learn-kana-table',
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  note: '五十音 / 浊音 / 半浊音 / 拗音的结构化表，供前端五十音图与假名练习使用。',
  layouts: { gojuon: GOJUON_LAYOUT, dakuon: DAKUON_LAYOUT },
  yoon: YOON.map(([h, k, hep, kun]) => ({ hira: h, kata: k, hepburn: hep, kunrei: kun || hep })),
  single: BASE.map(([h, k, hep, kun]) => ({ hira: h, kata: k, hepburn: hep, kunrei: kun || hep })),
};

const romajiTable = {
  format: 'jp-learn-romaji-table',
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  note:
    '假名 → 罗马音的「最长匹配表」。使用方式：从当前位置贪心取最长能命中的键。' +
    '促音、长音符已经展开进表里；但助词 は/へ/を 的读音与拨音 ん 的连读需要调用方额外处理（见 server.js）。',
  maxKeyLength: 3,
  sokuon: SOKUON,
  longVowelMarks: ['ー', '－'],
  particles: {
    // 助词读音（默认开启；罗马音里 は=wa、へ=e、を=o 才是正确读法）
    'は': { hepburn: 'wa', kunrei: 'wa' },
    'へ': { hepburn: 'e', kunrei: 'e' },
    'を': { hepburn: 'o', kunrei: 'o' },
  },
  tables: { hepburn, kunrei },
};

await fsp.mkdir(OUT, { recursive: true });

const write = async (name, obj) => {
  const p = path.join(OUT, name);
  const text = JSON.stringify(obj, null, 1) + '\n';
  await fsp.writeFile(p, text, 'utf8');
  log(`  → data/kana/${name}  ${(text.length / 1024).toFixed(1)} KB`);
};

await write('kana-table.json', kanaTable);
await write('romaji-table.json', romajiTable);

log('\n完成。可用 node tools/build-romaji.mjs 随时重建。');
log('数据许可：本表由算法生成，属于本项目原创，不受第三方许可约束。\n');
