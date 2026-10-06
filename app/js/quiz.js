/**
 * 出题器（纯函数，不碰 DOM、不碰 IndexedDB）
 *
 * 和 srs.js 一样单独抽出来，是为了能在 Node 里直接验证"题出得对不对"
 * （tools/test-quiz.mjs）。出题的坑很隐蔽：干扰项重复、选项里出现正确答案的同义词、
 * 填空把整个词挖掉导致没法答——这些肉眼审代码很难发现，但用户一眼就看到。
 *
 * 三种模式（按用户要求收敛，不再混用）：
 *   jp2zh         看日文单词选意思（给日文 → 从中文选项里选）
 *   zh2jp         看汉字选日文（给中文意思 → 从日文选项里选）
 *   zh2jp_typing  看汉语意思手动输入日文（给中文意思 → 手打日文）
 *
 * 为什么「看汉字选日文」和「看中文输入日文」是两个独立模式而不是一个模式随机决定
 * 作答方式：用户明确要求"选定一个功能，界面就有且仅有这一个功能"。
 * 若由程序随机决定是点选还是手打，同一场学习里交互方式会突然变，
 * 这正是要被去掉的"混用"。所以拆成两个 id，各自固定交互方式。
 *
 * 已删除的模式（不要再加回来，除非用户明确要求）：
 *   listen  听写 —— 用户不要任何语音相关内容
 *   cloze   填空 —— 用户不要句子填空题型
 *   kana    假名汉字互认 —— 已被 zh2jp 覆盖（给中文选日文），且用户要求不做假名练习
 *   reinforce 记忆加深 —— 它是"来源"不是题型，见 session.js 的 SESSION_SOURCE
 */

import { mulberry32 } from './srs.js';

export const MODES = {
  jp2zh: {
    id: 'jp2zh', label: '看日文单词选意思', short: '日→中',
    hint: '看日语词，从中文选项里选出它的意思',
    answerKind: 'zh', typing: false,
  },
  zh2jp: {
    id: 'zh2jp', label: '看汉字选日文', short: '中→日（选）',
    hint: '看中文意思，从日语选项里选出对应的词',
    answerKind: 'jp', typing: false,
  },
  zh2jp_typing: {
    id: 'zh2jp_typing', label: '看汉语意思手动输入日文', short: '中→日（打）',
    hint: '看中文意思，自己手打出日语词',
    answerKind: 'jp', typing: true,
  },
};

/** 学习时可选的模式顺序（界面按这个顺序排） */
export const MODE_ORDER = ['jp2zh', 'zh2jp', 'zh2jp_typing'];

/** 默认模式：最轻松、适合起步的那个 */
export const DEFAULT_MODE = 'jp2zh';

/** 汉字范围（用于判断一个词是否含汉字，以及能不能出假名题） */
const RE_KANJI = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const RE_KANA = /^[\u3040-\u309f\u30a0-\u30ff\u30fc]+$/;

/**
 * 归一化用户输入，用于宽松比对。
 *
 * 处理内容及理由：
 *   · 全角→半角：中文输入法很容易打出全角字母数字
 *   · 转小写：拉丁字母大小写不该算错
 *   · 片假名→平假名：**这条是刻意的**。アパート 和 あぱーと 在书写系统上不同，
 *     但对"这个词的读音我记住了吗"这个判定来说应该算对 —— 学习者在听写时
 *     用平假名写出片假名外来语是很自然的事，判错只会让人恼火。
 *   · 去空白与句读标点：手打时标点写法差异很大
 *   · 长音符保留但统一（ー 不删，因为コーヒー 与 コヒ 是两个不同的词形）
 */
export function normalizeAnswer(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)) // 全角→半角
    .replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))   // 片假名→平假名
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, '')
    .replace(/[。、，．,.\-・]/g, '')   // 标点不参与比对（长音符 ー 保留）
    .toLowerCase()
    .trim();
}

/**
 * 判断用户输入是否正确。
 *
 * 为什么不追求"严格相等"：学习者手打日语时，长音、送假名、标点写法常有不一致，
 * 全部判错会让人抓狂。所以接受一组可解释的等价形式：
 *   · 目标词本身
 *   · 该词的所有写法（forms / kanas）
 *   · 该词的读音，以及"读音去掉长音"
 *   · 中文释义的任何一条（看中文那侧作答时）
 * 但**不**接受近义词或包含关系（"会う" 不接受 "会"）。
 *
 * @param {string} input 用户输入
 * @param {object} word 词条
 * @param {string} side 'jp' | 'zh' | 'kana'
 * @returns {{ok:boolean, matched:string}}
 */
export function checkAnswer(input, word, side) {
  const got = normalizeAnswer(input);
  if (!got) return { ok: false, matched: '' };

  const candidates = [];
  const push = (v) => { if (v) candidates.push({ raw: v, norm: normalizeAnswer(v) }); };

  if (side === 'zh') {
    for (const g of word.zh || []) push(g);
  } else {
    push(word.term);
    for (const f of word.forms || []) push(f);
    for (const k of word.kanas || []) push(k);
    push(word.reading);
    // 读音去长音：コーヒー ↔ コヒ、おう ↔ お
    if (word.reading) push(String(word.reading).replace(/[ー\u3046\u30fc]/g, ''));
  }

  for (const c of candidates) {
    if (c.norm && c.norm === got) return { ok: true, matched: c.raw };
  }
  // 长音符容忍：コーヒー ↔ こひ 这类差异在听写时很常见。
  // 单独放在精确匹配**之后**，并且要求长度 >= 2 ——
  // 否则 カ 会和 かー 之类混在一起，把不该算对的判成对。
  const stripLong = (v) => v.replace(/ー/g, '');
  if (got.length >= 2) {
    for (const c of candidates) {
      const a = stripLong(c.norm);
      const b = stripLong(got);
      if (a && a === b) return { ok: true, matched: c.raw };
    }
  }
  // 中文释义里常带括注（如"见面（人）"），允许只答主要的那个词
  if (side === 'zh') {
    for (const c of candidates) {
      const main = c.norm.split(/[（(]/)[0];
      if (main && main === got) return { ok: true, matched: c.raw };
    }
  }
  return { ok: false, matched: '' };
}

/** 从 a 里按 key 去重 */
function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

/**
 * 取这个词最适合展示的中文释义（用于出题与干扰项）。
 * 只取第一条：多条释义全列出来会让题目变成阅读理解，而不是记单词。
 * 原样保留整条，不截断——截断过的释义会误导用户。
 */
export function primaryGloss(word) {
  const z = word && word.zh;
  if (!z || !z.length) return '';
  return String(z[0]).trim();
}

/**
 * 选干扰项。
 *
 * 质量决定整张卷子的价值：
 *   · 不能和正确答案重复或同义
 *   · 优先"同一词性 + 同级或相邻级"的词 —— 这些才真的难区分
 *   · 长度要接近，不然用户靠"最短的那个"就能猜中
 *   · 不追求凑满：宁可少给一个选项，也不塞一个明显不相干的词
 *
 * @param {object} target 目标词
 * @param {object[]} pool 候选池
 * @param {string} side 'jp' | 'zh'
 * @param {number} n 需要几个
 * @param {function} rand 可注入的随机源（测试里用固定种子）
 */
export function pickDistractors(target, pool, side, n = 3, rand = Math.random) {
  const correctText = side === 'zh'
    ? (target.zh || []).map(normalizeAnswer).filter(Boolean)
    : [target.term, ...(target.forms || []), ...(target.kanas || [])].map(normalizeAnswer).filter(Boolean);

  const correctLen = side === 'zh'
    ? primaryGloss(target).length
    : String(target.term || '').length;

  const targetPos = new Set(target.pos || []);

  const scored = [];
  for (const w of pool || []) {
    if (!w || w.id === target.id) continue;

    const text = side === 'zh' ? primaryGloss(w) : w.term;
    if (!text) continue;
    const norm = normalizeAnswer(text);
    if (!norm) continue;
    // 不能与正确答案重复或同义
    if (correctText.includes(norm)) continue;
    // 同一个词的其它写法
    if ((w.kanas || []).some((k) => correctText.includes(normalizeAnswer(k)))) continue;

    let score = 0;
    // 同词性加分（最能迷惑人）
    const shared = (w.pos || []).filter((p) => targetPos.has(p)).length;
    score += shared * 6;
    // 同级加分，相邻级次之
    if (w.level === target.level) score += 4;
    else if (isNeighborLevel(w.level, target.level)) score += 2;
    // 长度接近加分（防止靠长度猜）
    const len = side === 'zh' ? text.length : String(w.term || '').length;
    score += Math.max(0, 3 - Math.abs(len - correctLen));
    // 有点随机性，避免每次都同一批干扰项
    score += rand() * 2;

    scored.push({ w, text, norm, score });
  }

  scored.sort((a, b) => b.score - a.score);

  // 先按分数取，但要保证文本互不重复（否则出现两个一样的选项）
  const out = [];
  const used = new Set();
  for (const s of scored) {
    if (used.has(s.norm)) continue;
    used.add(s.norm);
    out.push(s);
    if (out.length >= n) break;
  }
  return out;
}

const LEVEL_ORDER = ['N5', 'N4', 'N3', 'N2', 'N1', 'extra'];
function isNeighborLevel(a, b) {
  const ia = LEVEL_ORDER.indexOf(a);
  const ib = LEVEL_ORDER.indexOf(b);
  if (ia < 0 || ib < 0) return false;
  return Math.abs(ia - ib) === 1;
}

/**
 * 生成一道题。
 *
 * @param {object} word 目标词
 * @param {string} mode MODES 的键之一
 * @param {object[]} pool 干扰项候选池
 * @param {object} opts { rand, choiceCount, allowTyping }
 * @returns {object} 题目对象（自带 prompt / answer / choices）
 */
export function makeQuestion(word, mode, pool, opts = {}) {
  const { rand = Math.random, choiceCount = 4 } = opts;
  if (!word) throw new Error('makeQuestion 需要 word');
  if (!MODES[mode]) throw new Error(`未知练习模式：${mode}`);

  const base = {
    wordId: word.id,
    mode,
    term: word.term,
    reading: word.reading,
    level: word.level,
    pos: word.pos || [],
    gloss: primaryGloss(word),
    // 字段名统一用 zh（和 data/vocab 里的字段名一致）。
    // 曾经这里叫 glosses，而 checkAnswer 读的是 word.zh，
    // 结果选择题判分把正确答案判成错的（"全答对"得 0 分）。
    zh: word.zh || [],
    // 判分要用到完整写法集合，所以题目自带一份，
    // 免得判卷时再去数据库捞词条（也保证离线判分）
    forms: word.forms || [],
    kanas: word.kanas || [],
  };

  // ---- 看日文单词选意思 ----
  if (mode === 'jp2zh') {
    const dirs = pickDistractors(word, pool, 'zh', choiceCount - 1, rand);
    return {
      ...base,
      prompt: word.term,
      promptSub: word.reading,
      promptKind: 'jp',
      answerSide: 'zh',
      answer: primaryGloss(word),
      choices: shuffle([primaryGloss(word), ...dirs.map((d) => d.text)], rand),
      typing: false,
    };
  }

  // ---- 看汉字选日文 ----
  if (mode === 'zh2jp') {
    const dirs = pickDistractors(word, pool, 'jp', choiceCount - 1, rand);
    return {
      ...base,
      prompt: primaryGloss(word),
      promptSub: '',
      promptKind: 'zh',
      answerSide: 'jp',
      answer: word.term,
      choices: shuffle([word.term, ...dirs.map((d) => d.text)], rand),
      typing: false,
    };
  }

  // ---- 看汉语意思手动输入日文 ----
  // 判分仍然走 checkAnswer：手打时接受读音（かな）、其它写法、片假名↔平假名。
  // 这是刻意的——"看中文打日文"里，能打出正确读音就应该算会，
  // 否则一心想不起汉字写法的用户会被判错，而那个知识点在 jp2zh 里才考。
  if (mode === 'zh2jp_typing') {
    return {
      ...base,
      prompt: primaryGloss(word),
      promptSub: '',
      promptKind: 'zh',
      answerSide: 'jp',
      answer: word.term,
      choices: [],           // 手打题不给选项
      typing: true,
      note: word.reading ? '打出汉字写法或读音都算对' : '',
    };
  }

  throw new Error(`未知练习模式：${mode}`);
}

/**
 * 从例句里挖掉目标词。
 *
 * 关键点：必须**在词形层面**挖，而不是整个词整体替换。
 * 例句里出现的是活用形（"会いましょう"），而词条是辞书形（"会う"）——
 * 简单 replace("会う") 根本匹配不到，会挖出一个空。
 * 这里按"词条的汉字部分 + 后续假名"来定位：只要汉字部分出现，就把该处挖空。
 *
 * @returns {{sentence:string, blanked:string, ok:boolean}}
 */
export function blankOut(sentence, word) {
  const s = String(sentence || '');
  if (!s) return { sentence: s, blanked: s, ok: false };

  // 优先整体替换（最精确）
  const forms = uniqBy([word.term, ...(word.forms || [])], (x) => x);
  for (const f of forms) {
    if (f && s.includes(f)) {
      return { sentence: s, blanked: s.replace(f, '＿＿＿'), ok: true };
    }
  }

  // 退一步：用汉字词干定位（会う → 会 出现在 会いましょう）
  const kanjiPart = String(word.term || '').match(/^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/);
  if (kanjiPart && s.includes(kanjiPart[0])) {
    // 把汉字词干连同紧跟的假名（活用词尾）一起挖掉，最多 4 个假名
    const re = new RegExp(escapeRe(kanjiPart[0]) + '[\\u3040-\\u309f]{0,4}');
    const m = s.match(re);
    if (m) return { sentence: s, blanked: s.replace(m[0], '＿＿＿'), ok: true };
    return { sentence: s, blanked: s.replace(kanjiPart[0], '＿＿＿'), ok: true };
  }

  // 纯假名词：只能整体替换
  if (word.term && s.includes(word.term)) {
    return { sentence: s, blanked: s.replace(word.term, '＿＿＿'), ok: true };
  }
  return { sentence: s, blanked: s, ok: false };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 挑一条例句。优先"目标词确实出现在句子里"的，
 * 否则填空题会挖不掉东西。同级例句优先。
 */
export function pickExample(word, rand = Math.random) {
  const ex = word && word.ex;
  if (!ex || !ex.length) return null;
  const usable = ex.filter((e) => {
    if (!e || !e.jp) return false;
    return blankOut(e.jp, word).ok;
  });
  if (!usable.length) return null;
  const sameLevel = usable.filter((e) => e.level === word.level);
  const pool = sameLevel.length ? sameLevel : usable;
  return pool[Math.floor(rand() * pool.length) % pool.length];
}

/** Fisher-Yates（用注入的随机源，保证测试可复现） */
export function shuffle(arr, rand = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 组一张卷子：从词池里按模式出 n 道题。
 *
 * @param {object[]} words 候选词（已经由调用方按 SRS/错题/等级筛过）
 * @param {object} opts {
 *   modes: string[],      // 允许的模式；不传则统一用 DEFAULT_MODE（不随机混用）
 *   count: number,        // 题量
 *   pool: object[],       // 干扰项候选池（通常比 words 大）
 *   rand, choiceCount, avoidIds: Set
 *   keepOrder: boolean,   // true = 不打乱传入顺序（复习队列依赖优先级排序）
 * }
 */
export function buildQuiz(words, opts = {}) {
  const {
    modes = null,
    count = 20,
    pool = null,
    rand = Math.random,
    choiceCount = 4,
    avoidIds = new Set(),
    keepOrder = false,
  } = opts;

  const distractorPool = pool && pool.length ? pool : words;
  const candidates = (words || []).filter((w) => w && !avoidIds.has(w.id));
  // 复习会话依赖调用方排好的优先级（到期的、错得多的排前面）。
  // 这里若无条件打乱，优先级就被抹掉了 —— 复习会变成随机顺序，
  // 用户感觉不到"先练最该练的"。所以 keepOrder 时保持原序。
  const ordered = keepOrder ? candidates : shuffle(candidates, rand);
  const picked = ordered.slice(0, count);

  const questions = [];
  for (const w of picked) {
    let mode;
    if (modes && modes.length) {
      mode = modes[Math.floor(rand() * modes.length) % modes.length];
    } else {
      // 没指定模式时用默认模式，而**不是**随机挑。
      // 原来这里会按"哪种出得出来"随机选，同一场学习里交互方式会突然从
      // 点选变成手打——用户明确要求"选定一个功能就只有这一个功能"。
      // 要混合出题必须由调用方显式传入 modes 数组（小测就是这么做的）。
      mode = DEFAULT_MODE;
    }
    try {
      const q = makeQuestion(w, mode, distractorPool, { rand, choiceCount });
      // 选择题至少要有一个干扰项，否则这道题没有区分度
      if (q.choices && q.choices.length > 0 && q.choices.length < 2) continue;
      questions.push(q);
    } catch (e) {
      // 单个词出题失败不该让整张卷子崩掉
      continue;
    }
  }
  return questions;
}

/**
 * 判整张卷子的分。
 *
 * 选择题和打字题走**同一条**判分路径（checkAnswer），只是选择题的输入
 * 来自用户点的那个选项。分开写会导致"选项判得严、打字判得松"这种不一致，
 * 同一个答案点选算错、手打算对，用户会觉得程序在乱判。
 *
 * @param {Array<{question:object, input:string}>} answers
 */
export function gradeQuiz(answers) {
  const detail = [];
  let correct = 0;
  for (const a of answers || []) {
    const q = a.question;
    const r = checkAnswer(a.input, q, q.answerSide);
    if (r.ok) correct++;
    detail.push({
      wordId: q.wordId, mode: q.mode, prompt: q.prompt, answer: q.answer,
      input: a.input, ok: r.ok, level: q.level, term: q.term,
    });
  }
  const total = detail.length;
  return {
    total,
    correct,
    wrong: total - correct,
    accuracy: total ? Math.round((correct / total) * 1000) / 10 : 0,
    detail,
  };
}
