/**
 * 词库与生词本的数据服务层（浏览器侧，会用到 IndexedDB）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 【重要设计决定】内置词库缓存是"可再生的派生数据"，不是用户数据
 * ═══════════════════════════════════════════════════════════════════════════
 * 内置 JLPT 词库有 15,225 条。如果把它们直接写进用户的 words 表，会有两个后果：
 *   1. 用户数据会被内置数据淹没（"生词本 15,225 个"毫无意义）；
 *   2. 以后重建 data/vocab（新版本词库）就变成"改动用户数据"，
 *      直接违反硬约束 2（程序与用户数据彻底分离）。
 *
 * 所以拆成两层，用不同的 id 前缀区分，靠前缀就能安全批量识别与清理：
 *
 *   words 表（**用户数据，永不自动清理**）
 *     id = 'jmdict:1198180'      → 用户正在学的词（有自己的 SRS 卡）
 *     id = 'import:<importId>:0' → 用户自己导入的词表里的词
 *
 *   libwords 表（**可再生的派生缓存，可以安全重建/清空**）
 *     id = 'lib:jmdict:1198180'  → 内置词库的镜像，只用于查词、抽样、
 *                                  以及"加入生词本"时取词的原始资料
 *
 * 缓存用词库内容指纹（manifest 的 builtAt + 条目数）做版本标记：
 * 指纹变了就整表重建。**重建缓存不会碰 words / srs / reviews / mistakes**。
 * 这样"词库升级"和"用户数据"在代码层面就不可能互相影响。
 */

import {
  dbGet, dbAll, dbPut, dbPutMany, dbDelete, dbAllByIndex, newId,
} from './db.js';

export const PREFIX_USER = 'jmdict:';      // 用户正在学的内置词
export const PREFIX_IMPORT = 'import:';    // 用户导入的词表的词
export const PREFIX_LIB = 'lib:';          // 内置词库缓存（可丢弃）

/** 内置缓存的当前版本标记（manifest 指纹） */
const META_LIB_VERSION = 'libVersion';

/** 级别顺序，用于"相邻级别"判断与展示 */
export const LEVEL_ORDER = ['N5', 'N4', 'N3', 'N2', 'N1', 'extra'];

export const LEVEL_LABEL = {
  N5: 'N5', N4: 'N4', N3: 'N3', N2: 'N2', N1: 'N1', extra: '常用补充',
};

// ---------------------------------------------------------------------------
// 一、内置词库缓存
// ---------------------------------------------------------------------------

/** 把内置词条转成缓存条目 */
function toLibWord(raw, level) {
  return {
    id: PREFIX_LIB + raw.id,
    srcId: raw.id,
    term: raw.term,
    reading: raw.reading,
    forms: raw.forms || [],
    kanas: raw.kanas || [],
    level: raw.level || level,
    zh: raw.zh || [],
    pos: raw.pos || [],
    ex: raw.ex || [],
    cachedAt: Date.now(),
  };
}

/** 从缓存条目还原成"题目/展示"需要的词形 */
export function fromLibWord(w) {
  if (!w) return null;
  return {
    id: w.srcId || String(w.id).replace(PREFIX_LIB, ''),
    term: w.term, reading: w.reading,
    forms: w.forms || [], kanas: w.kanas || [],
    level: w.level, zh: w.zh || [], pos: w.pos || [], ex: w.ex || [],
  };
}

/** 读服务端的词库清单 */
export async function fetchManifest() {
  const r = await fetch('/data/index/manifest.json', { cache: 'no-store' });
  if (!r.ok) throw new Error(`读不到词库清单（HTTP ${r.status}）`);
  return r.json();
}

/**
 * 词库指纹：内容变了指纹就变，用来决定是否需要重建缓存。
 * 用 manifest 的 builtAt + 各级条目数，不用文件大小（换行符差异会误判）。
 */
export function manifestFingerprint(manifest) {
  const counts = manifest && manifest.counts ? manifest.counts : {};
  const parts = LEVEL_ORDER.map((l) => `${l}=${counts[l] || 0}`).join(',');
  return `${(manifest && manifest.builtAt) || 'unknown'}|${parts}|${(manifest && manifest.total) || 0}`;
}

/**
 * 确保内置词库缓存可用。
 *
 * @param {object} opts {
 *   force: boolean,            强制重建
 *   onProgress: (阶段文字, 已完成, 总数) => void
 * }
 * @returns {{ready:boolean, rebuilt:boolean, count:number, fingerprint:string}}
 */
export async function ensureLibrary(opts = {}) {
  const { force = false, onProgress } = opts || {};
  const manifest = await fetchManifest();
  const fingerprint = manifestFingerprint(manifest);

  const stored = await dbGet('meta', META_LIB_VERSION);
  const haveCount = (await dbAll('libwords')).length;

  if (!force && stored && stored.value === fingerprint && haveCount > 0) {
    return { ready: true, rebuilt: false, count: haveCount, fingerprint };
  }

  // 需要重建：先清空派生缓存（这一步绝不影响 words / srs / reviews / mistakes）
  onProgress && onProgress('清理旧缓存', 0, 0);
  const old = await dbAll('libwords');
  for (const w of old) await dbDelete('libwords', w.id);

  const levels = LEVEL_ORDER.filter((l) => (manifest.counts || {})[l]);
  let done = 0;
  let total = 0;
  for (const lv of levels) total += (manifest.counts || {})[lv] || 0;

  for (const lv of levels) {
    onProgress && onProgress(`载入 ${LEVEL_LABEL[lv] || lv}`, done, total);
    const r = await fetch(`/data/vocab/${lv.toLowerCase()}.json`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`读不到词库文件 ${lv}（HTTP ${r.status}）`);
    const data = await r.json();
    const items = (data.items || []).map((raw) => toLibWord(raw, lv));

    // 分批写，避免一次性构造上万个对象的对象存储事务过长
    const BATCH = 800;
    for (let i = 0; i < items.length; i += BATCH) {
      await dbPutMany('libwords', items.slice(i, i + BATCH));
      done += Math.min(BATCH, items.length - i);
      onProgress && onProgress(`载入 ${LEVEL_LABEL[lv] || lv}`, done, total);
    }
  }

  await dbPut('meta', { key: META_LIB_VERSION, value: fingerprint, at: Date.now() });
  const count = (await dbAll('libwords')).length;
  return { ready: true, rebuilt: true, count, fingerprint };
}

/** 内置缓存是否就绪（不触发构建，用于界面快速判断） */
export async function libraryStatus() {
  const stored = await dbGet('meta', META_LIB_VERSION);
  let manifest = null;
  try { manifest = await fetchManifest(); } catch { /* 服务没起时容忍 */ }
  const count = (await dbAll('libwords')).length;
  const fingerprint = manifest ? manifestFingerprint(manifest) : null;
  return {
    count,
    ready: count > 0,
    upToDate: !!(stored && fingerprint && stored.value === fingerprint),
    fingerprint,
    storedFingerprint: stored ? stored.value : null,
  };
}

/** 按级别随机取一批内置词（用于抽样练习、小测出题） */
export async function sampleLibrary(levels, n, opts = {}) {
  const { excludeIds = new Set() } = opts;
  const all = await dbAll('libwords');
  const want = levels && levels.length ? new Set(levels) : null;
  const pool = all.filter((w) => (!want || want.has(w.level)) && !excludeIds.has(w.srcId));
  // Fisher-Yates 取前 n 个，避免 sort(() => Math.random()) 的偏置
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n).map(fromLibWord);
}

/** 取某级别的全部内置词（用于"按等级批量加入"） */
export async function libraryByLevel(levels) {
  const all = await dbAll('libwords');
  const want = levels && levels.length ? new Set(levels) : null;
  return all.filter((w) => !want || want.has(w.level));
}

// ---------------------------------------------------------------------------
// 二、生词本（用户数据）
// ---------------------------------------------------------------------------

/**
 * 把词加入生词本，并（可选）立刻建 SRS 卡。
 *
 * 幂等：同一个词重复加入不会产生两条记录，只会补齐缺失字段。
 * 这一点很重要 —— 从歌词、精读、速查抽屉、练习页都可能触发"加入"，
 * 用户连点两次不该变成两条。
 *
 * @param {object} word 词条（内置词或导入词）
 * @param {object} opts { source, sourceRef, tags, withCard, now }
 * @returns {{word:object, created:boolean, carded:boolean}}
 */
export async function addWord(word, opts = {}) {
  const {
    source = 'manual',
    sourceRef = null,
    tags = [],
    withCard = true,
    now = Date.now(),
  } = opts;
  if (!word || !word.term) throw new Error('addWord 需要一个带 term 的词条');

  const id = wordIdOf(word);
  const existing = await dbGet('words', id);

  const rec = existing ? { ...existing } : {
    id,
    term: word.term,
    reading: word.reading || '',
    forms: word.forms || [],
    kanas: word.kanas || [],
    level: word.level || '',
    zh: word.zh || [],
    pos: word.pos || [],
    ex: word.ex || [],
    source,
    sourceRef,
    tags: [],
    createdAt: now,
    updatedAt: now,
  };

  if (existing) {
    // 补齐可能缺失的字段，但**不覆盖**用户已有的标签与来源标记
    if (!rec.zh || !rec.zh.length) rec.zh = word.zh || [];
    if (!rec.pos || !rec.pos.length) rec.pos = word.pos || [];
    if (!rec.reading) rec.reading = word.reading || '';
    if (!rec.level) rec.level = word.level || '';
    if (!rec.ex || !rec.ex.length) rec.ex = word.ex || [];
  }
  if (tags && tags.length) {
    rec.tags = Array.from(new Set([...(rec.tags || []), ...tags]));
  }
  rec.updatedAt = now;
  await dbPut('words', rec);

  let carded = false;
  if (withCard) {
    const existingCard = await dbGet('srs', id);
    if (!existingCard) {
      const { newCard } = await import('./srs.js');
      await dbPut('srs', newCard(id, now));
      carded = true;
    }
  }
  return { word: rec, created: !existing, carded };
}

/** 由词条算出它在 words 表里的 id */
export function wordIdOf(word) {
  if (word.id && (word.id.startsWith(PREFIX_USER) || word.id.startsWith(PREFIX_IMPORT))) return word.id;
  if (word.importId !== undefined && word.index !== undefined) {
    return `${PREFIX_IMPORT}${word.importId}:${word.index}`;
  }
  if (word.id) return word.id.startsWith(PREFIX_LIB) ? String(word.id).replace(PREFIX_LIB, '') : word.id;
  // 没 id 的词（用户手输）用词形+读音生成稳定 id，保证重复加入幂等
  return PREFIX_USER + 'custom:' + hashStr(`${word.term}|${word.reading || ''}`);
}

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** 生词本全量（按加入时间倒序） */
export async function listWords() {
  const all = await dbAll('words');
  return all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/** 词是否已在生词本 */
export async function isInVocab(wordId) {
  const id = wordIdOf({ id: wordId });
  return !!(await dbGet('words', id));
}

/** 从生词本移除（同时移除 SRS 卡、错题记录；答题历史保留作统计） */
export async function removeWord(wordId, opts = {}) {
  const { keepHistory = true } = opts;
  const id = wordIdOf({ id: wordId });
  await dbDelete('words', id);
  await dbDelete('srs', id);
  await dbDelete('mistakes', id);
  // reviews 是历史记录，默认保留（它属于"统计"，不该因为删词而丢）
  if (!keepHistory) {
    const rs = await dbAllByIndex('reviews', 'byWordId', IDBKeyRange.only(id));
    for (const r of rs) await dbDelete('reviews', r.id);
  }
}

/** 批量移除 */
export async function removeWords(wordIds) {
  for (const id of wordIds) await removeWord(id);
  return wordIds.length;
}

/** 给词打标签 / 取消标签 */
export async function setWordTags(wordId, tags) {
  const id = wordIdOf({ id: wordId });
  const w = await dbGet('words', id);
  if (!w) throw new Error('词不在生词本里');
  w.tags = Array.from(new Set(tags || []));
  w.updatedAt = Date.now();
  await dbPut('words', w);
  return w;
}

/** 生词本用到的所有标签（含计数），用于筛选界面 */
export async function listTags() {
  const all = await dbAll('words');
  const map = new Map();
  for (const w of all) {
    for (const t of w.tags || []) map.set(t, (map.get(t) || 0) + 1);
  }
  return [...map.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// 三、SRS 排程读写
// ---------------------------------------------------------------------------

/** 取某个词的排程卡 */
export async function getCard(wordId) {
  return dbGet('srs', wordIdOf({ id: wordId }));
}

/** 生词本里所有词的排程卡（一次取完，避免 N 次查询） */
export async function allCards() {
  return dbAll('srs');
}

/**
 * 今天已经复习过**几个不同的词**（每日复习额度按它扣）。
 *
 * 为什么查 reviews 表而不是看卡的 lastAt：
 *   `reviews` 是"每次作答都追加一条"的历史表，`day` 字段就是 dayKey，
 *   而且已经建了 `byDay` 索引 —— 用它统计最准，也不给 srs 表加字段。
 *
 * 为什么只数**不同词**（去重）而不是答题条数：
 *   错词在会话里会被重排再考一次（st.requeued）。那是"一次复习里的重复"，
 *   如果按条数算，答错一个词就等于吃掉了两份额度，用户会觉得额度莫名其妙少掉。
 *   而且"每天复习 N 个词"本来就是以词为单位说的。
 *
 * 只统计进入天级复习（state === 'review'）的作答：
 *   学习步/重学步是分钟级的入门过程，不是"复习负担"，不该占额度。
 *   注意存的是**作答后**的状态（recordAnswer 写的是 next.state），
 *   所以"忘了"那一笔会记成 relearning —— 它确实要被排除，语义一致。
 *
 * @param {number} now
 * @returns {Promise<{words:number, total:number}>} words=不同词数（额度用），total=作答条数（仅展示）
 */
export async function reviewedToday(now = Date.now()) {
  const { dayKey } = await import('./srs.js');
  const day = dayKey(now);
  let rows = [];
  try {
    rows = await dbAllByIndex('reviews', 'byDay', IDBKeyRange.only(day));
  } catch {
    // 索引取不到（理论上不会发生：byDay 从第 1 版就有）就退回全表扫，
    // 宁可慢一点，也不能让"今日额度"算错或抛错把页面打崩。
    const all = await dbAll('reviews');
    rows = all.filter((r) => r && r.day === day);
  }
  const ids = new Set();
  for (const r of rows) {
    if (!r) continue;
    if (r.state !== 'review') continue;   // 学习步/重学步不占额度
    if (r.wordId) ids.add(r.wordId);
  }
  return { words: ids.size, total: rows.length };
}

/**
 * 只保留"生词本里还在"的卡，并给没有卡的词补卡。
 * 用于数据自检与"导入后修正"——生词本和排程表理论上应一一对应，
 * 出现不一致说明出过异常（比如半途中断的导入），这里做一次对齐。
 */
export async function reconcileCards(now = Date.now()) {
  const { newCard } = await import('./srs.js');
  const words = await dbAll('words');
  const cards = await dbAll('srs');
  const wordIds = new Set(words.map((w) => w.id));
  const cardIds = new Set(cards.map((c) => c.wordId));

  const missing = words.filter((w) => !cardIds.has(w.id));
  if (missing.length) {
    await dbPutMany('srs', missing.map((w) => newCard(w.id, now)));
  }
  const orphan = cards.filter((c) => !wordIds.has(c.wordId));
  for (const c of orphan) await dbDelete('srs', c.wordId);

  return { added: missing.length, removed: orphan.length };
}

// ---------------------------------------------------------------------------
// 四、复习作答（SRS + 错题本 + 历史，一次写清）
// ---------------------------------------------------------------------------

/**
 * 记录一次作答。这是"复习"这个动作**唯一**的写入口，
 * 保证 SRS、错题本、历史三张表永远同步 —— 分包写会造成
 * "复习了但错题本没记"这类不一致。
 *
 * @param {object} p {
 *   wordId, grade, mode,
 *   correct: boolean,      // 客观对错（错题本按它记）
 *   input: string,         // 用户答案
 *   expected: string,      // 正确答案
 *   now: number,
 *   config: object         // SRS 参数覆盖
 * }
 * @returns {{card:object, mistake:object|null}}
 */
export async function recordAnswer(p) {
  const {
    wordId, grade, mode = '', correct = false,
    input = '', expected = '', now = Date.now(), config = null,
  } = p || {};
  if (!wordId) throw new Error('recordAnswer 需要 wordId');
  if (!grade) throw new Error('recordAnswer 需要 grade');

  const { schedule, newCard, GRADE } = await import('./srs.js');
  const id = wordIdOf({ id: wordId });

  const existing = await dbGet('srs', id);
  const card = existing || newCard(id, now);
  const wasNew = card.state === 'new';
  const next = schedule(card, grade, now, config);

  // 首次学习时间：用于统计"今天学了几个新词"，从而实现**真正的**每日新词上限。
  //
  // 为什么必须有这个字段：光看 `firstAt`（首次作答时间）不行，因为"复习一个
  // 早就学过的词"也会更新它；而只看 state !== 'new' 又只能知道"学过"，
  // 不知道"哪天学的"。没有它，每日上限就退化成"每次练习给 N 个"——
  // 上午练 20 个、下午再点一次又给 20 个，用户看到的"每天 20 个"是假的。
  if (wasNew && next.state !== 'new' && !next.introducedAt) next.introducedAt = now;
  await dbPut('srs', next);

  // 答错：进错题本（累计次数）
  let mistake = null;
  if (!correct || grade === GRADE.AGAIN) {
    const mid = id;
    const m = (await dbGet('mistakes', mid)) || {
      wordId: mid, wrongCount: 0, lastWrongAt: null, firstWrongAt: now,
      byMode: {}, lastInput: '', expected: '',
    };
    m.wrongCount = (m.wrongCount || 0) + 1;
    m.lastWrongAt = now;
    if (!m.firstWrongAt) m.firstWrongAt = now;
    m.lastInput = input;
    m.expected = expected;
    m.byMode = { ...(m.byMode || {}) };
    if (mode) m.byMode[mode] = (m.byMode[mode] || 0) + 1;
    await dbPut('mistakes', m);
    mistake = m;
  } else {
    // 答对：错题本里的记录**保留**（它是"曾经错过"的历史），
    // 但把"连续答对"记下来，供界面区分"已经克服"与"仍在挣扎"。
    const m = await dbGet('mistakes', id);
    if (m) {
      m.correctStreak = (m.correctStreak || 0) + 1;
      m.lastCorrectAt = now;
      await dbPut('mistakes', m);
      mistake = m;
    }
  }

  // 历史（只追加）
  const { dayKey } = await import('./srs.js');
  await dbPut('reviews', {
    id: newId('rev-'),
    wordId: id,
    at: now,
    day: dayKey(now),
    mode,
    grade,
    correct: !!correct,
    input: String(input || '').slice(0, 120),
    expected: String(expected || '').slice(0, 120),
    state: next.state,
    interval: next.interval,
  });

  return { card: next, mistake };
}

/** 错题本：按错误次数降序。只列生词本里还在的词。 */
export async function listMistakes(opts = {}) {
  const { minCount = 1, includeResolved = true } = opts;
  const all = await dbAll('mistakes');
  const words = new Map((await dbAll('words')).map((w) => [w.id, w]));
  const cards = new Map((await dbAll('srs')).map((c) => [c.wordId, c]));

  const rows = [];
  for (const m of all) {
    if ((m.wrongCount || 0) < minCount) continue;
    const w = words.get(m.wordId);
    if (!w) continue;                        // 词已从生词本移除
    const resolved = (m.correctStreak || 0) >= 3;
    if (!includeResolved && resolved) continue;
    rows.push({
      ...m,
      word: w,
      card: cards.get(m.wordId) || null,
      resolved,
    });
  }
  rows.sort((a, b) => (b.wrongCount || 0) - (a.wrongCount || 0)
    || (b.lastWrongAt || 0) - (a.lastWrongAt || 0));
  return rows;
}

/** 清掉某词的错题记录（用户认为已经掌握，手动移除） */
export async function clearMistake(wordId) {
  await dbDelete('mistakes', wordIdOf({ id: wordId }));
}

/** 复习概览（首页 / 背单词页顶部用） */
export async function reviewOverview(now = Date.now()) {
  const { summarize, pickDue } = await import('./srs.js');
  const cards = await dbAll('srs');
  const s = summarize(cards, now);
  const due = pickDue(cards, now);
  const mistakes = await dbAll('mistakes');
  return {
    ...s,
    dueCount: due.length,
    dueCards: due,
    mistakeCount: mistakes.filter((m) => (m.wrongCount || 0) > 0).length,
    unresolvedMistakes: mistakes.filter((m) => (m.wrongCount || 0) > 0 && (m.correctStreak || 0) < 3).length,
  };
}

// ---------------------------------------------------------------------------
// 五、本地词表导入
// ---------------------------------------------------------------------------

/**
 * 解析用户词表文本。
 *
 * 支持的格式（自动嗅探，不要求用户先选格式）：
 *   1. 制表符/多空白分隔：  会う	あう	见面
 *   2. 逗号分隔（CSV）：     会う,あう,见面
 *   3. 只有词：             会う          （读音与释义留空，允许事后补）
 *   4. 带表头：             term,reading,zh  （表头行自动跳过）
 *   5. 井号或双斜杠开头是注释
 *
 * 为什么容忍这么多写法：用户手边的词表来源五花八门（Excel、Anki 导出、
 * 从网页复制的），要求先转成某一种格式等于把麻烦推给用户。
 *
 * @returns {{items:Array, skipped:Array, columns:string[], warnings:Array}}
 */
export function parseWordList(text) {
  const raw = String(text || '');
  const lines = raw.split(/\r?\n/);
  const items = [];
  const skipped = [];
  const warnings = [];

  // 嗅探分隔符：看前 20 个非空行里哪种分隔符出现最多
  const sample = lines.filter((l) => l.trim() && !isComment(l)).slice(0, 20);
  const tabs = sample.filter((l) => l.includes('\t')).length;
  const commas = sample.filter((l) => l.includes(',')).length;
  const semis = sample.filter((l) => l.includes('；') || l.includes(';')).length;
  let sep = null;
  if (tabs >= Math.max(commas, semis) && tabs > 0) sep = '\t';
  else if (commas >= semis && commas > 0) sep = ',';
  else if (semis > 0) sep = /[;；]/;

  let headerSkipped = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (isComment(line)) continue;

    let cells;
    if (sep === null) cells = [line.trim()];
    else if (sep instanceof RegExp) cells = line.split(sep);
    else if (sep === '\t') cells = line.split('\t');
    else cells = splitCsvLine(line);

    cells = cells.map((c) => c.trim().replace(/^["']|["']$/g, ''));

    // 表头识别：第一行含 term/词/日文/reading/读音/zh/中文 这类字样
    if (!headerSkipped && i === firstContentIndex(lines)) {
      headerSkipped = true;
      if (cells.some((c) => /^(term|word|词|单词|日文|日语|reading|读音|假名|读法|zh|cn|中文|释义|意思|meaning)$/i.test(c))) {
        continue;
      }
    }

    const term = cells[0];
    if (!term) { skipped.push({ line: i + 1, text: line, reason: '空行首列' }); continue; }

    // 只有词形且不含汉字也不含假名 —— 大概是别的东西，跳过并告知
    if (!/[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]/.test(term)) {
      skipped.push({ line: i + 1, text: line, reason: '首列不是日文' });
      continue;
    }

    const reading = cells[1] && /^[\u3040-\u309f\u30a0-\u30ffー]+$/.test(cells[1]) ? cells[1] : '';
    // 第二列不是假名时，它可能是释义（用户只写了 词,释义 两列）
    const zhCells = reading ? cells.slice(2) : cells.slice(1);
    const zh = zhCells.filter(Boolean).flatMap((c) => c.split(/[\/／|、;；]/).map((x) => x.trim())).filter(Boolean);

    if (!reading) {
      warnings.push({ line: i + 1, term, msg: '没有读音，注音与听写会受影响（可事后补）' });
    }
    items.push({ term, reading, zh, forms: [], kanas: reading ? [reading] : [], level: '', pos: [] });
  }

  return {
    items,
    skipped,
    warnings,
    columns: sep === '\t' ? '制表符' : sep === ',' ? '逗号' : sep instanceof RegExp ? '分号' : '单列',
  };
}

function isComment(line) {
  const t = line.trim();
  return t.startsWith('#') || t.startsWith('//');
}
function firstContentIndex(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() && !isComment(lines[i])) return i;
  }
  return 0;
}
/** 支持带引号的 CSV 字段 */
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * 导入一份词表：存下原始文本（便于以后"重新解析"而不用再让用户传一次）
 * 并把词写进 words 表。
 *
 * @returns {{importId, name, added, updated, total, parsed}}
 */
export async function importWordList(text, name, opts = {}) {
  const { withCard = true, tags = [], now = Date.now() } = opts;
  const parsed = parseWordList(text);
  if (!parsed.items.length) {
    throw new Error('没有解析出任何词条。请检查文件格式：每行至少要有日文词，可选读音和中文释义。');
  }

  const importId = newId('imp-');
  let added = 0;
  let updated = 0;

  for (let i = 0; i < parsed.items.length; i++) {
    const it = parsed.items[i];
    const id = `${PREFIX_IMPORT}${importId}:${i}`;
    const rec = {
      id,
      term: it.term, reading: it.reading,
      forms: it.forms, kanas: it.kanas,
      level: '', zh: it.zh, pos: it.pos, ex: [],
      source: 'import', sourceRef: importId,
      tags: [...tags],
      importIndex: i,
      createdAt: now, updatedAt: now,
    };
    const existing = await dbGet('words', id);
    if (existing) updated++; else added++;
    await dbPut('words', rec);
    if (withCard) {
      const { newCard } = await import('./srs.js');
      if (!(await dbGet('srs', id))) await dbPut('srs', newCard(id, now));
    }
  }

  const rec = {
    id: importId,
    name: name || `词表 ${new Date(now).toLocaleString()}`,
    at: now,
    count: parsed.items.length,
    rawText: text,
    columns: parsed.columns,
    skipped: parsed.skipped.length,
    warnings: parsed.warnings.length,
  };
  await dbPut('imports', rec);

  return { importId, name: rec.name, added, updated, total: parsed.items.length, parsed, record: rec };
}

/** 已导入的词表列表 */
export async function listImports() {
  const all = await dbAll('imports');
  return all.sort((a, b) => (b.at || 0) - (a.at || 0));
}

/** 删除一份导入（连带它的词与排程） */
export async function deleteImport(importId) {
  const words = (await dbAll('words')).filter((w) => w.sourceRef === importId);
  for (const w of words) await removeWord(w.id);
  await dbDelete('imports', importId);
  return words.length;
}

/** 重新解析一份已导入的词表（用户改了原始文本后） */
export async function reparseImport(importId, newText) {
  const rec = await dbGet('imports', importId);
  if (!rec) throw new Error('找不到这份导入记录');
  const text = newText === undefined ? rec.rawText : newText;
  const parsed = parseWordList(text);
  const words = (await dbAll('words')).filter((w) => w.sourceRef === importId).sort((a, b) => a.importIndex - b.importIndex);

  let updated = 0;
  for (let i = 0; i < parsed.items.length && i < words.length; i++) {
    const it = parsed.items[i];
    const w = words[i];
    w.term = it.term;
    w.reading = it.reading;
    w.zh = it.zh;
    w.kanas = it.kanas;
    w.updatedAt = Date.now();
    await dbPut('words', w);
    updated++;
  }
  rec.rawText = text;
  rec.count = parsed.items.length;
  rec.skipped = parsed.skipped.length;
  rec.warnings = parsed.warnings.length;
  rec.reparsedAt = Date.now();
  await dbPut('imports', rec);
  return { updated, parsed, record: rec };
}

// ---------------------------------------------------------------------------
// 六、速查抽屉用的查词
// ---------------------------------------------------------------------------

/**
 * 把片假名统一成平假名，用来做"同音词"比对。
 *
 * ⚠️ 为什么必须做这件事（用户报的第一个 bug 的一半）：
 *   用户输入 カタ（片假名），本地词库里的读音存的是 **かた**（平假名）。
 *   不做归一化的话 `w.reading === 'カタ'` 永远是 false，
 *   于是**一条都搜不到** —— 明明本地有 5 条同音词。
 *   日语里外来语写片假名、和语写平假名，**读音本身是同一串音**，
 *   所以查词必须把两者视作等价。
 *
 * ⚠️⚠️ 但**不能闭着眼睛"减 0x60"**。有三个片假名没有可用的平假名对应，
 *   机械转换会把一个正常的词改成乱码：
 *     ヴ U+30F4 → ゔ U+3094、ヵ U+30F5 → ゕ U+3095、ヶ U+30F6 → ゖ U+3096
 *   这三个（尤其 ヴ）在真实词库里大量出现（readings.json 里 ヴ 有 146 处，
 *   如 アイヴォリー / アヴェニュー），所以必须原样保留。
 *   长音符 ー 与 ゝゞ 同样不动（它们两边通用，没有平假名形态）。
 *
 * 📌 这一段和 tools/tokenizer.js 里的同名函数**必须保持一致**：
 *   一个是服务端查词用，一个是本地词库缓存比对用，两边口径不同就会出现
 *   "接口能查到、本地缓存查不到"这种极难排查的差异。
 */
export function kanaNormalize(s) {
  return String(s || '').replace(/[\u30a1-\u30f3]/g,
    (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** 归一化后的"这个词能不能被 q 命中"判据（大小写也统一，罗马音查询才有用） */
function wordMatches(w, q) {
  const nq = kanaNormalize(q).toLowerCase();
  const cand = [w.term, w.reading, w.kanaHint, ...(w.forms || []), ...(w.kanas || [])];
  for (const c of cand) {
    if (!c) continue;
    if (kanaNormalize(c).toLowerCase() === nq) return true;
  }
  return false;
}

/** 等级排序权重（N5 最简单，排前面；未知等级排最后） */
const LEVEL_RANK = { N5: 0, N4: 1, N3: 2, N2: 3, N1: 4, extra: 5 };

/**
 * 查词。**三个来源全部合并**，而不是命中一个就早退。
 *
 * ────────────────────────────────────────────────────────────────────
 * ⚠️ 这里原来有本项目最典型的一类 bug：**早退（early return）**
 * ────────────────────────────────────────────────────────────────────
 * 原实现是：
 *   if (生词本命中) return …;
 *   if (内置词库命中) return …;      ← 问题在这
 *   …再问服务端
 *
 * 用户报的现象：输入「かた」应该给出 肩 / 過多 / 方 / 型 / 潟 五个同音词，
 * **却只返回了「方」一个**。
 *
 * 原因有两层，缺一不可：
 *   ① **早退**：内置词库里「方」这一条命中了，于是**直接 return**，
 *      服务端明明能返回全部 5 条，却根本没被问到。
 *      而本地词库其实也有 5 条（`reading` 都是 かた），
 *      过滤逻辑却没一起给出 —— 见 ②。
 *   ② **假名不归一化**：读音比对是 `w.reading === q` 的严格相等。
 *      用户输入 カタ（片假名）时，库存的 かた（平假名）永远不相等 → 0 条。
 *
 * 📌 **教训：查词是"合并"语义，不是"优先级"语义。**
 * 优先级思维用在**展示排序**（生词本优先显示）是对的，
 * 用在**取数据**上就是错的 —— 它会让后面的来源永远见不到光。
 * 现在改成：三个来源全取，去重，按"生词本 → 等级"排序。
 */
export async function lookupWord(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return { source: 'none', words: [] };

  const seen = new Set();
  const out = [];

  // ① 生词本（用户自己的词永远排最前，并标出来源）
  let mineCount = 0;
  try {
    for (const w of await dbAll('words')) {
      if (!wordMatches(w, q)) continue;
      const key = w.id || w.term;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...w, fromVocab: true });
      mineCount++;
    }
  } catch { /* 生词本读不到不影响查词 */ }

  // ② 内置词库缓存（可再生的派生数据）
  let libCount = 0;
  try {
    for (const w of await dbAll('libwords')) {
      if (!wordMatches(w, q)) continue;
      const key = w.srcId || w.id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...fromLibWord(w), fromLibrary: true });
      libCount++;
    }
  } catch { /* 缓存没建好时继续问服务端 */ }

  // ③ 服务端词库（能处理活用形、罗马音；也覆盖本地缓存里没有的词）
  let serverCount = 0;
  let raw = null;
  try {
    const r = await fetch('/api/dict/lookup?q=' + encodeURIComponent(q));
    if (r.ok) {
      raw = await r.json();
      // ⚠️ `*Normalized` 那两组是服务端**把片假名归一成平假名之后**再查的命中。
      //    为什么要单独一组、而不是让服务端直接替换掉原来的结果：
      //    原始查询的结果必须原样保留 —— 万一将来有片假名词条，
      //    替换会让它反而查不到。这里两组都收，去重交给 seen。
      //    不读这两组就会重现"用片假名查不到任何词"的问题。
      const rows = [].concat(
        raw.exact || [], raw.byReading || [],
        raw.exactNormalized || [], raw.byReadingNormalized || [],
      );
      for (const t of rows) {
        const key = t.id || t.wordId || t.term;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          id: t.id || t.wordId,
          term: t.term, reading: t.reading, level: t.level,
          zh: t.zh || [], pos: t.pos || [], forms: t.forms || [], kanas: t.kanas || [],
          fromServer: true,
        });
        serverCount++;
      }
    }
  } catch { /* 服务不可用时静默降级到前两层 */ }

  // 排序：生词本优先，其次按等级（N5 → N1），同级按词形长度（短的更像"基本义"）
  out.sort((a, b) => {
    if (!!b.fromVocab !== !!a.fromVocab) return b.fromVocab ? 1 : -1;
    const la = LEVEL_RANK[a.level] ?? 9;
    const lb = LEVEL_RANK[b.level] ?? 9;
    if (la !== lb) return la - lb;
    return String(a.term || '').length - String(b.term || '').length;
  });

  // 有多个来源都命中时，如实说清楚（用户能判断"这是不是完整的同音词表"）
  const sources = [];
  if (mineCount) sources.push('vocab');
  if (libCount) sources.push('library');
  if (serverCount) sources.push('server');

  return {
    source: sources.length === 1 ? sources[0] : (sources.length ? 'mixed' : 'none'),
    sources,
    counts: { vocab: mineCount, library: libCount, server: serverCount },
    words: out.slice(0, 60),
    total: out.length,
    raw,
  };
}

// ---------------------------------------------------------------------------
// 七、自检
// ---------------------------------------------------------------------------

/** 数据一致性自检（设置页与首页用） */
export async function vocabSelfCheck() {
  const words = await dbAll('words');
  const cards = await dbAll('srs');
  const mistakes = await dbAll('mistakes');
  const wordIds = new Set(words.map((w) => w.id));
  const cardIds = new Set(cards.map((c) => c.wordId));

  const noCard = words.filter((w) => !cardIds.has(w.id));
  const orphanCard = cards.filter((c) => !wordIds.has(c.wordId));
  const orphanMistake = mistakes.filter((m) => !wordIds.has(m.wordId));
  const noGloss = words.filter((w) => !w.zh || !w.zh.length);
  const noReading = words.filter((w) => !w.reading);

  return {
    words: words.length,
    cards: cards.length,
    mistakes: mistakes.length,
    noCard: noCard.length,
    orphanCard: orphanCard.length,
    orphanMistake: orphanMistake.length,
    noGloss: noGloss.length,
    noReading: noReading.length,
    // 有卡没词、或有错题没词，都说明出过异常
    healthy: orphanCard.length === 0 && orphanMistake.length === 0,
  };
}
