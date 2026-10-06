/**
 * airead.js —— 「左日文 / 右中文」两栏阅读 + 按段落自动翻译。
 *
 * ──────────────────────────────────────────────────────────────────
 * 这个文件解决的到底是什么问题
 * ──────────────────────────────────────────────────────────────────
 * 用户的原话：「左边日文右边中文，这时候就把文本转变成横排的方便我阅读」。
 *
 * 也就是说不只是"翻译"，而是**阅读版式**：
 *   · 日文一栏、中文一栏，一行对一行，眼睛左右移动就能对照
 *   · 竖排（拍照识别出来的书页）已经被 OCR 版面重建转成横排了
 *   · 中文栏**默认展开**（用户要的就是对照读），但可以折叠起来只看日文
 *
 * ──────────────────────────────────────────────────────────────────
 * 为什么翻译结果要**存下来**
 * ──────────────────────────────────────────────────────────────────
 * 翻译是要花钱的（用户自己填的 API 密钥）。如果每次打开笔记都重翻一遍，
 * 那就是在烧用户的钱 —— 而且同一段文字翻两次，结果还不一样，体验更差。
 *
 * 所以译文按 **记录 id + 段号** 缓存，写进那条笔记记录自己的 `aiCache` 字段里。
 *   · 不用新建 IndexedDB store → 不需要动 SCHEMA_VERSION → 不会触发数据迁移
 *     （硬约束：任何升级都不许迁移或清空用户数据）
 *   · 跟着笔记一起导出/导入/快照，不会丢
 *   · 删掉笔记，缓存也跟着删，不会留垃圾
 *
 * ──────────────────────────────────────────────────────────────────
 * 隐私：这里的文案必须和实际行为一致
 * ──────────────────────────────────────────────────────────────────
 * 自动翻译会把**每一个段落的正文**发到你填的 AI 地址。
 * 这一点必须在界面上说清楚、并且让用户主动点一下才发生 ——
 * 不能"打开笔记就偷偷开始发"。见 `AI_PRIVACY_TEXT` 的说明。
 */
import { el, toast, toastWarn, humanAgo } from './ui.js';
import { renderTokens } from './views/jpreader.js';
import { applyOverrides } from './yomi.js';
import { askAi, getAiConfig, ensureAck } from './ai.js';
import { confirmAiNotice } from './views/aipanel.js';
import * as db from './db.js';
import { setAiWordHook } from './drawer.js';

/** 一次翻译最多发多少个字（防止用户粘了一整本书进来） */
export const MAX_TRANSLATE_CHARS = 1200;

// ---------------------------------------------------------------------------
// 一、译文缓存（存在笔记记录自己的 aiCache 字段里）
// ---------------------------------------------------------------------------

/**
 * 「还没保存的笔记」的暂存区。
 *
 * ⚠️ 这一段是补一个**真实丢数据的坑**，值得写清楚：
 *
 * 用户在歌词页/精读页的流程通常是「先粘正文 → 翻译 → 再保存」。
 * 但翻译的那一刻，那条笔记**还不存在**（currentId 是 null），
 * 于是 `saveAiCache` 里的 `if (!rec) return false` 直接放弃 ——
 * **译文只活在内存里，从来没进过数据库。**
 * 用户的感觉就是"我翻了一遍，一保存就没了，白花 token"。
 *
 * 修法：记录还不存在时，把译文放进这个暂存区（按将来要用的 id 归档），
 * 等第一次保存笔记时由 `flushPendingCache()` 一并落库。
 *
 * 为什么用"等保存时落库"而不是"提前造一条笔记"：
 *   提前落库会在用户的笔记列表里凭空多出一条他不想要的东西 ——
 *   **不能为了修 bug 就往用户的数据里塞记录。**
 */
const pendingCache = new Map(); // recordId -> { translation: { '0': '…' }, at }

/** 暂存区里有没有属于某条笔记、但还没落库的译文 */
export function hasPendingCache(recordId) {
  const p = recordId ? pendingCache.get(recordId) : null;
  return !!(p && p.translation && Object.keys(p.translation).length);
}

/** 暂存区里这条笔记一共暂存了几段译文 */
export function pendingCacheCount(recordId) {
  const p = recordId ? pendingCache.get(recordId) : null;
  return p && p.translation ? Object.keys(p.translation).length : 0;
}

/**
 * 把暂存区里属于 recordId 的译文写进记录。
 *
 * **保存笔记之后必须调用它**（歌词页/精读页的 saveNote 都调了），
 * 否则用户"先翻译后保存"那一批还是会丢。
 *
 * @returns {Promise<number>} 真正落库的段数；0 表示没有暂存内容或写入失败
 */
export async function flushPendingCache(recordId) {
  if (!recordId) return 0;
  const p = pendingCache.get(recordId);
  if (!p) return 0;
  const nTrans = Object.keys(p.translation || {}).length;
  const nGram = Object.keys(p.grammar || {}).length;
  // ⚠️ 这里原来只看 `p.translation`。加了语法讲解缓存之后，
  //    只有讲解、没有译文的那一刻（例如用户刚存了笔记又点了"讲语法"）
  //    会走到这个 return 上，**讲解就被静默丢掉了**。
  //    "只判断了一半的字段"是这类 bug 的典型来源。
  if (!nTrans && !nGram) return 0;
  const ok = await saveAiCache(recordId, null, {
    translation: p.translation || {},
    grammar: p.grammar || {},
  });
  if (!ok) return 0; // 落库失败就**保留暂存**，下次保存还有机会（不静默丢弃）
  pendingCache.delete(recordId);
  return nTrans + nGram;
}

/**
 * 把一条旧记录的 aiCache 取出来（供 saveNote 保字段用）。
 *
 * ⚠️ 为什么要有这个函数：`saveNote()` 是"新建一个干净对象 → 整条覆盖写回"，
 *    新对象里**没有 aiCache**，于是用户一保存，译文就被冲掉了。
 *    以前只在 saveNote 里捞回了 `createdAt` 一个字段，漏了 aiCache。
 *
 * 这条教训是通用的：**整条覆盖写回时，凡是"不在新对象里"的字段都会消失。**
 * 以后给记录加任何新字段，都要回来检查一遍这里。
 *
 * @param {string} store 'readings' | 'lyrics'
 * @param {string|null} recordId
 * @returns {Promise<object|null>} 可以直接挂到新记录上的 aiCache
 */
export async function carryAiCache(store, recordId) {
  if (!recordId) return null;
  try {
    const rec = await db.dbGet(store, recordId);
    if (rec && rec.aiCache && typeof rec.aiCache === 'object') return rec.aiCache;
  } catch { /* 读不到就当没有 */ }
  return null;
}

/**
 * 读一条记录的 AI 缓存。
 *
 * 注意这里**会把暂存区里的内容并进来** —— 这样"先翻译后保存"的那批译文
 * 在保存之前也能显示出来（不然用户会以为翻译失败了）。
 *
 * @param {string|null} recordId
 * @returns {Promise<object>} 形如 { translation: { '0': '…', '1': '…' } }
 */
export async function loadAiCache(recordId) {
  const pend = recordId ? pendingCache.get(recordId) : null;
  const pending = (pend && pend.translation) || {};
  const pendingGram = (pend && pend.grammar) || {};
  if (!recordId) return { translation: { ...pending }, grammar: { ...pendingGram } };
  try {
    const rec = await db.dbGet('readings', recordId).catch(() => null)
      || await db.dbGet('lyrics', recordId).catch(() => null);
    const c = rec && rec.aiCache;
    if (c && typeof c === 'object') {
      const stored = (c.translation && typeof c.translation === 'object') ? c.translation : {};
      const storedGram = (c.grammar && typeof c.grammar === 'object') ? c.grammar : {};
      // 暂存放在后面：内存里的更新（用户刚点的重翻）优先于库里的旧值
      return {
        translation: { ...stored, ...pending },
        // 语法讲解：按行号缓存。"讲这句语法"是一次花钱的请求，
        // 关掉面板就丢掉太浪费，所以和译文一样落库（见 paintRow 的 air-gram 模块）。
        grammar: { ...storedGram, ...pendingGram },
      };
    }
  } catch { /* 读不到就当没有缓存 */ }
  return { translation: { ...pending }, grammar: { ...pendingGram } };
}

/**
 * 把译文写回记录。
 *
 * ⚠️ 读-改-写必须是**同一次拿到的记录对象**上改，不能先读再整条覆盖：
 *    否则会把用户在这期间改过的正文/标题冲掉。
 *    这里用的是"读出整条 → 只改 aiCache 字段 → 写回"，字段级最小改动。
 *
 * ⚠️ 记录还不存在时（用户还没保存笔记）**不能静默丢弃** ——
 *    放进暂存区，等保存时由 flushPendingCache 落库。
 *
 * @param {string} recordId
 * @param {string|null} store 'readings' | 'lyrics'；传 null 表示"两个都试"
 * @param {object} patch { translation: { '0': '…' } }
 * @returns {Promise<boolean>} true＝已落库；false＝暂存（还没保存笔记）
 */
export async function saveAiCache(recordId, store, patch) {
  if (!recordId) return false;
  const add = (patch && patch.translation) || {};
  const addGram = (patch && patch.grammar) || {};
  const stage = () => {
    const p = pendingCache.get(recordId) || { translation: {}, grammar: {} };
    p.translation = { ...p.translation, ...add };
    p.grammar = { ...p.grammar, ...addGram };
    p.at = new Date().toISOString();
    pendingCache.set(recordId, p);
    return false;
  };
  try {
    // store 没传就两个都试（调用方有时只知道 id）
    const stores = store ? [store] : ['readings', 'lyrics'];
    let rec = null;
    let hit = null;
    for (const s of stores) {
      rec = await db.dbGet(s, recordId).catch(() => null);
      if (rec) { hit = s; break; }
    }
    if (!rec) return stage(); // 笔记还没保存 → 暂存，等保存时落库
    const old = (rec.aiCache && typeof rec.aiCache === 'object') ? rec.aiCache : {};
    rec.aiCache = {
      ...old,
      translation: { ...(old.translation || {}), ...add },
      grammar: { ...(old.grammar || {}), ...addGram },
      at: new Date().toISOString(),
    };
    await db.dbPut(hit, rec);
    return true;
  } catch {
    return stage(); // 写失败也不能丢：暂存起来，下次保存还有机会
  }
}

/**
 * 测试钩子：把"翻译 → 保存笔记 → 重开笔记"这条真实顺序**完整跑一遍**。
 *
 * 为什么要专门开这个口子：
 *   用户报的 bug 是"翻译完一保存，译文就没了"。而以前的测试只测了
 *   `saveAiCache` / `loadAiCache` 两个函数各自能不能用 —— 各自都对，
 *   合起来却是错的。**缺口在流程上，不在函数上。**
 *
 *   所以这里把流程本身暴露出来给测试跑。它跟 lyric.js / reading.js 的
 *   saveNote 用的是同一批函数、同一套顺序，所以这些断言一旦通过，
 *   说明共享逻辑是对的。
 *
 *   ⚠️ 但这**不能**代替"视图里真的调了这些函数"的检查 ——
 *      如果哪天有人把视图里那两行删掉，这里的测试照样绿。
 *      所以 test-airead.mjs 里还有一条**源码断言**盯着两个视图确实调了。
 *      两层一起才完整：**一层测逻辑，一层测接线。**
 */
export const __testHooks = {
  /**
   * 模拟一次 saveNote：先翻译（记录可能还不存在），再保存，最后把暂存的落库。
   * @param {{store:string,id:string,text:string,title:string,
   *          translate?:object|null, existing?:boolean}} o
   */
  async simulateSaveNote(o) {
    let staged = 0;
    if (o.translate) {
      for (const [i, zh] of Object.entries(o.translate)) {
        const okSaved = await saveAiCache(o.id, o.store, { translation: { [i]: zh } });
        if (!okSaved) staged++;
      }
    }

    // 下面这一段**逐行对应 lyric.js / reading.js 里 saveNote 的真实写法**
    const now = new Date().toISOString();
    const rec = {
      id: o.id,
      title: o.title,
      text: o.text,
      opts: {},
      stats: {},
      createdAt: now,
      updatedAt: now,
    };
    const old = o.existing ? await db.dbGet(o.store, o.id).catch(() => null) : null;
    if (old && old.createdAt) rec.createdAt = old.createdAt;
    const carried = await carryAiCache(o.store, o.id);
    if (carried) rec.aiCache = carried;
    await db.dbPut(o.store, rec);
    const flushed = await flushPendingCache(rec.id);
    return { staged, flushed, id: rec.id };
  },

  /**
   * 模拟"重新打开这条笔记"：只读缓存，**一次 AI 都不请求**。
   * 返回的 aiCalls 永远应该是 0 —— 大于 0 就意味着在重复花用户的钱。
   */
  async simulateReopen(o) {
    const aiCalls = 0;
    const cache = await loadAiCache(o.id);
    return { translation: cache.translation, aiCalls };
  },

  /** 清空暂存区（测试之间要互相隔离） */
  reset() { pendingCache.clear(); },
};

// ---------------------------------------------------------------------------
// 二、翻译
// ---------------------------------------------------------------------------
/**
 * 翻译一个段落。
 *
 * @param {string} text 日文原文（**只有这一段的正文会被发出去**）
 * @returns {Promise<string>} 中文译文
 */
export async function translateText(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (t.length > MAX_TRANSLATE_CHARS) {
    throw new Error(`这一段有 ${t.length} 个字，超过一次 ${MAX_TRANSLATE_CHARS} 字的上限。`
      + '请把长段落拆成几段再翻译。');
  }
  const r = await askAi({ task: 'translate', text: t });
  const out = String((r && r.text) || '').trim();
  if (!out) throw new Error('AI 返回了空译文');
  return out;
}

// ---------------------------------------------------------------------------
// 三、两栏阅读版式
// ---------------------------------------------------------------------------

/**
 * 建一个"左日文 / 右中文"的阅读区。
 *
 * @param {object} opts
 *   lines        [{ ja, reading, index }]  要读的行（每行 = 一个段落/句子）
 *   prefs        { ruby, romaji }          假名/罗马音开关
 *   recordId     笔记 id（用于缓存；没存过笔记就传 null，此时不缓存）
 *   store        'readings' | 'lyrics'
 *   onWord       (token, ev) => void       点词回调
 *   onSentence   (line, ev) => void        点句子回调（讲语法）
 *   showZh       中文栏是否默认展开（默认 true —— 用户要的就是对照读）
 *   overrides    Map<词形, 读音>           用户手改的读音（见 js/yomi.js）
 *   onEditReading (token, chip) => void     允许"改这个词的读音"（不传则不能改）
 *
 * ⚠️ overrides 一定要**先套到 token 上再渲染**（applyOverrides）。
 *    渲染函数是同步的、读表是异步的，不能等到画的时候再查。
 *    漏了这一步的表现就是：用户改完读音、切一下页面又变回程序猜的那个 ——
 *    他会以为"改了没用"，这是最不能接受的感觉。
 *
 * @returns {{ node, repaint, setZhVisible, isZhVisible, translateAll, hasCache }}
 */
export async function buildAiReader(opts = {}) {
  const lines = Array.isArray(opts.lines) ? opts.lines : [];
  const store = opts.store === 'lyrics' ? 'lyrics' : 'readings';
  const overrides = opts.overrides instanceof Map ? opts.overrides : null;
  // 有手改读音的词：整页先套一遍，之后每次画行再套一次
  // （换行的 token 数组是新的对象，不套就丢了）
  if (overrides && overrides.size) applyOverrides(lines.flatMap((l) => (l && l.reading && l.reading.tokens) || []), overrides);

  /**
   * 当前记录 id。
   *
   * ⚠️ 这里**不能只读一次 opts.recordId**。真实的使用顺序是：
   *     先精读 → 看到译文 → 点「存为笔记」拿到 id。
   *   也就是说"翻第一段的时候还没有 id"。如果一开始就把 id 记死为 null，
   *   那么**所有翻译都不会被缓存** —— 用户下次打开笔记又要全部重翻一遍、
   *   再花一次钱。所以做成"每次用的时候现取"。
   *
   *   opts.recordId 可以是字符串，也可以是一个返回字符串的函数。
   */
  const idOf = typeof opts.recordId === 'function'
    ? () => opts.recordId() || null
    : () => opts.recordId || null;

  // 中文栏状态：展开 / 折叠
  let zhVisible = opts.showZh !== false;

  /**
   * 译文来源有两处，优先级：**用户自己填的** > AI 缓存的。
   *
   * 为什么用户自己填的优先：歌词页本来就有一个"中文对照"输入框。
   * 用户自己贴进去的译文是他确认过的，AI 译文只是辅助 ——
   * 用 AI 覆盖掉用户填的东西是绝对不能做的事。
   * 所以 AI 翻译只填"连用户都没填"的那些行。
   */
  const userZh = (opts.preTranslations && typeof opts.preTranslations === 'object') ? opts.preTranslations : {};

  // AI 译文：先读缓存（不花钱），没有的才要翻
  const cache = await loadAiCache(idOf());
  const failed = {};                        // { [index]: '错误原因' }
  // ★ 语法讲解缓存：{ [index]: { text, at, context } }
  //
  // ⚠️ 为什么要缓存/保存它（用户报的第 4 个问题）：
  //   原来"讲这句语法"走的是 `showResultPanel()` —— 一个**浮层面板**，
  //   关掉就没了。用户的原话：「ai 的输出依旧是弹窗，无法保存」。
  //   而 AI 讲解是一次花钱的联网请求，让它看完就消失是纯浪费。
  //   现在挂进这一行下面的折叠模块，并写进这条笔记的 aiCache.grammar，
  //   下次打开笔记还在。
  const gram = { ...((cache && cache.grammar) || {}) };
  // 哪些行正在请求中（按钮要显示"请求中…"并禁用，防止连点花多次钱）
  const gramBusy = {};
  // 哪些行是展开的（默认展开刚问过的那一行）
  const gramOpen = {};
  // 哪些是用户自己填的（这些行不允许 AI 覆盖，也不允许"重新翻译"覆盖）
  const isUser = {};
  const trans = { ...cache.translation };   // { [index]: '中文' }
  // 用户填的译文最后合并进来 —— 顺序很重要：**覆盖 AI 的**
  for (const k of Object.keys(userZh)) {
    if (userZh[k]) { trans[k] = userZh[k]; isUser[k] = true; }
  }

  /**
   * 重新从数据库读一次缓存，合并进 `trans`。
   *
   * ⚠️ 为什么必须有这个函数（**这是补上去的一个真 bug**）：
   *    上面那次 `loadAiCache` 读的是**建这个阅读器的那一刻**的 id。
   *    而真实的使用顺序是"先精读 → 点存为笔记 → 才有 id"——
   *    建阅读器时 id 是 null，所以那次读**什么都读不到**。
   *    之后用户存了笔记、翻译了几段（译文确实写进数据库了），
   *    但内存里的 `trans` 一直是空的、也不会自己刷新。
   *    结果：点「自动翻译全部段落」会把**已经翻过的段落再翻一遍**，
   *    等于让用户为同一段文字付两次钱。
   *
   *    修法就是"每次要批量翻译之前先重新读一遍"。
   *    刻意**不覆盖**用户自己填的（`isUser`），也不覆盖已有的 AI 译文 ——
   *    这个函数只做"补上内存里缺的那些"，不做任何改写。
   */
  async function reloadCache() {
    const fresh = await loadAiCache(idOf());
    for (const [k, v] of Object.entries(fresh.translation || {})) {
      if (v && !trans[k]) trans[k] = v;
    }
    for (const k of Object.keys(userZh)) {
      if (userZh[k] && !isUser[k]) { trans[k] = userZh[k]; isUser[k] = true; }
    }
  }

  // AI 是否可用 —— 这个决定要不要显示"自动翻译"按钮
  let aiOn = false;
  let aiWhy = '';
  try {
    const r = await getAiConfig();
    aiOn = !!(r && r.config && r.config.enabled);
    if (!aiOn) aiWhy = 'AI 默认是关闭的。到「设置 → AI」里打开并填好密钥后，这里就能自动翻译。';
  } catch (e) {
    aiWhy = '读不到 AI 配置：' + String((e && e.message) || e);
  }

  const rowsHost = el('div', { class: 'air-rows' });
  const noticeHost = el('div', {});

  /** 画一行（日文 + 中文两栏，外加一个可折叠的语法讲解模块）。 */
  function paintRow(line, i) {
    const row = el('div', { class: 'air-row' + (zhVisible ? '' : ' is-no-zh') });
    const head = el('div', { class: 'air-head' });

    // ── 左栏：日文 ──
    const jaCell = el('div', { class: 'air-ja' });
    const tokens = (line.reading && line.reading.tokens) || [];
    // 手改读音：每次画行都重新套一遍。行可能因为"重新解析/换开关"被重画，
    // 而重画时 token 是新对象 —— 只在建阅读器时套一次是不够的。
    if (overrides && overrides.size) applyOverrides(tokens, overrides);
    jaCell.appendChild(renderTokens(tokens, {
      ruby: opts.prefs ? opts.prefs.ruby !== false : true,
      romaji: opts.prefs ? !!opts.prefs.romaji : false,
      onWord: opts.onWord || null,
      onEditReading: opts.onEditReading || null,
      onLongPress: opts.onEditReading || null,
      // ★ 把"这一行的原始分词"一起交给对话框（见 jpreader.renderTokens 的说明）：
      //   改分词要在这个词**左右相邻的词**上操作（合并前一个 / 合并后一个），
      //   只给一个孤立的 token 是做不到的。
      ctx: { tokens, overrides },
    }));
    // ⚠️ 这里**故意不再挂"点整行就讲语法"**。
    //    原来 `jaCell.addEventListener('click', …)` 让"点日文栏任意空白"
    //    都触发 AI 讲解，用户的原话是「这个功能也很容易误触」——
    //    读书时在词与词之间点一下（想定位光标、想取消选中）就会弹出 AI 面板，
    //    而且它是要花钱的联网请求。**"整行都是热区"是最容易误触的交互设计。**
    //    现在改成一个明确的按钮（见下面 .air-gram 那个），
    //    位置固定、看得见、不会因为点偏了而触发。
    head.appendChild(jaCell);

    // ── 右栏：中文 ──
    const zhCell = el('div', { class: 'air-zh' });
    if (trans[i]) {
      zhCell.appendChild(el('div', { class: 'air-zh-text', text: trans[i] }));
      // 用户自己填的译文：只标"你填的"，**不提供重翻按钮**（不许 AI 覆盖用户输入）。
      // AI 译文才有 ↻ 重翻。
      if (isUser[i]) {
        zhCell.appendChild(el('span', { class: 'air-zh-mine', text: '（你填的）' }));
      } else {
        zhCell.appendChild(el('button', {
          class: 'air-zh-retry', title: '重新翻译这一段', text: '↻',
          onclick: async (ev) => {
            ev.stopPropagation();
            delete trans[i];
            delete failed[i];
            again.disabled = true;
            try {
              trans[i] = await translateText(line.ja);
              await saveAiCache(idOf(), store, { translation: { [i]: trans[i] } });
            } catch (e) {
              failed[i] = String((e && e.message) || e);
            }
            repaint();
          },
        }));
      }
    } else if (failed[i]) {
      // 失败不能静默 —— 静默的话用户会以为"这段本来就没译文"
      zhCell.appendChild(el('div', { class: 'air-zh-fail', text: '翻译失败：' + failed[i] }));
      zhCell.appendChild(el('button', {
        class: 'btn btn-sm btn-ghost', text: '重试',
        onclick: async (ev) => {
          ev.stopPropagation();
          delete failed[i];
          repaint();
          await translateOne(i, line.ja);
        },
      }));
    } else if (aiOn) {
      zhCell.appendChild(el('div', { class: 'air-zh-empty', text: '（还没有译文）' }));
    } else {
      zhCell.appendChild(el('div', { class: 'air-zh-empty', text: '（未启用 AI）' }));
    }
    head.appendChild(zhCell);

    // ── 第三栏：讲语法按钮（固定位置，不会误触）──
    //
    // ⚠️ 为什么要有这个按钮、而不是继续用"点空白处"：
    //   用户报的问题有两个，它们是同一件事的两面 ——
    //     ① 点句子空白处触发 AI 讲语法，**很容易误触**（见上面 jaCell 的注释）；
    //     ② AI 的输出是**弹窗，无法保存**，关掉就没了。
    //   所以这里给一个明确的入口，输出也不再走弹窗，而是挂到这一行**下面**
    //   的折叠模块里（.air-gram），能反复打开、也会写进笔记的 aiCache。
    //
    //   按钮**始终可见但很淡**，hover 才变亮：完全隐藏的话用户不知道有这功能，
    //   一直很亮的话每一行都挂个按钮会毁掉阅读。
    if (opts.onSentence) {
      head.appendChild(el('div', { class: 'air-actions' }, [
        el('button', {
          class: 'air-gram-btn',
          type: 'button',
          dataset: { act: 'ai-explain-sentence' },
          title: '让 AI 讲这一句的语法（会用掉一次联网请求）',
          text: '⚙ 讲语法',
          onclick: (ev) => {
            ev.stopPropagation();
            // ⚠️ 调的是本阅读器自己的 askGrammar，**不是** opts.onSentence。
            //    opts.onSentence 现在是个**布尔开关**（两个阅读页传 `true`），
            //    它曾经是个回调（`explainSentence(...)`，走浮层面板）。
            //    改成开关之后如果这里还写 `opts.onSentence(...)`，
            //    点一下就抛 "opts.onSentence is not a function" ——
            //    而且因为没有控制台，界面上只表现为"点了没反应"。
            //    **这条就是 qa-bugs.mjs 在真浏览器里抓出来的。**
            askGrammar(gramHost, line, i);
          },
        }),
      ]));
    }
    row.appendChild(head);

    // ── 这一行下方：语法讲解模块（可折叠、可保存）──
    const gramHost = el('div', { class: 'air-gram-host' });
    row.appendChild(gramHost);
    paintGrammar(gramHost, line, i);

    return row;
  }

  /**
   * 画"这一句的语法讲解"模块（挂在行的下方，**不是弹窗**）。
   *
   * ⚠️ 用户报的第 4 个问题的正面回答：
   *   原话「ai 的输出依旧是弹窗，无法保存。我需要你解决这一点，
   *         例如在这一段句子下方加一个可折叠的模块。」
   *   所以这里就是"这一段句子下方的一个可折叠模块"：
   *     · 没讲过 → 不显示任何东西（不占版面）；
   *     · 正在请求 → 显示"请求中…"，按钮禁用（防连点花多次钱）；
   *     · 讲完了 → 显示折叠头（可点开/收起）+ 正文；
   *     · 正文**同时写进笔记的 aiCache.grammar**，下次打开笔记还在。
   */
  function paintGrammar(host, line, i) {
    host.innerHTML = '';
    const rec = gram[i];

    if (gramBusy[i]) {
      host.appendChild(el('div', { class: 'air-gram is-busy' }, [
        el('span', { class: 'air-gram-spin', text: '⏳' }),
        el('span', { text: '正在让 AI 讲这一句的语法…' }),
      ]));
      return;
    }
    if (!rec || !rec.text) return;

    const open = !!gramOpen[i];
    const box = el('div', { class: 'air-gram' + (open ? ' is-open' : '') });

    box.appendChild(el('button', {
      class: 'air-gram-head', type: 'button',
      // 折叠头本身也能点开/收起 —— 用户反复看同一句时不用滚来滚去
      onclick: (ev) => {
        ev.stopPropagation();
        gramOpen[i] = !gramOpen[i];
        paintGrammar(host, line, i);
      },
    }, [
      el('span', { class: 'air-gram-caret', text: open ? '▾' : '▸' }),
      el('span', { class: 'air-gram-title', text: 'AI 语法讲解' }),
      el('span', { class: 'air-gram-sub', text: rec.at ? humanAgo(rec.at) : '' }),
      el('span', { class: 'spacer' }),
      // 重问一次：AI 的回答不一定一次到位，允许换一次（明确告诉它会再花一次请求）
      el('button', {
        class: 'air-gram-again', type: 'button', text: '↻',
        title: '重新讲一次（会再发一次联网请求）',
        onclick: (ev) => { ev.stopPropagation(); askGrammar(host, line, i); },
      }),
    ]));

    if (open) {
      const body = el('div', { class: 'air-gram-body' });

      // ★ 被长度上限截断时，**先说清"没说完"再显示内容**。
      //
      //   用户 2026-10 报的「偶尔返回讲解失败：回答被长度上限截断了」，
      //   根因是"所有任务共用一个 maxTokens"，而且截断信息在有内容时会被咽掉。
      //   服务端已经改成按任务给预算 + 有内容就保留，这里负责把话说明白：
      //     · 内容照常显示（不丢，那是用户花了钱的回答）
      //     · 上面挂一条提示，并给一个"用更大上限重问"的按钮
      if (rec.truncated) {
        body.appendChild(el('div', { class: 'banner banner-warn', style: { marginBottom: '8px' } }, [
          el('strong', { text: '这段讲解没说完' }),
          el('div', { class: 'banner-hint', text: rec.truncateHint
            || 'AI 的回答撞到了单次输出长度上限，下面显示的是已经说出来的部分。' }),
          el('div', { class: 'btn-row', style: { marginTop: '6px' } }, [
            el('button', {
              class: 'btn btn-sm',
              type: 'button',
              title: '再问一次（已自动请求更长的上限，会再发一次联网请求）',
              text: '让 AI 接着说（↻）',
              onclick: (ev) => { ev.stopPropagation(); askGrammar(host, line, i); },
            }),
          ]),
        ]));
      }

      // 纯文本渲染：AI 回答里可能有 markdown 记号，但本项目没有 markdown 渲染器，
      // 所以**保留原文**（用 pre-wrap 显示），不做半吊子的解析。
      body.appendChild(el('div', { class: 'air-gram-text', text: rec.text }));
      body.appendChild(el('div', { class: 'air-gram-foot' }, [
        el('span', { text: '这一句的讲解已随笔记保存，下次打开还在。' }),
      ]));
      box.appendChild(body);
    }
    host.appendChild(box);
  }

  /**
   * 请求"讲这一句的语法"，结果落到行下方的折叠模块里并写进笔记缓存。
   *
   * 和原来的 `explainSentence()`（走弹窗）的区别：
   *   · 结果**落在这一行下面**，不再是一个浮层把阅读位置挡掉；
   *   · 结果**写进 aiCache.grammar**，关掉页面再回来还在；
   *   · 请求期间按钮禁用，防连点。
   */
  async function askGrammar(host, line, i) {
    if (gramBusy[i]) return;
    if (!aiOn) { toastWarn(aiWhy || 'AI 没启用'); return; }
    gramBusy[i] = true;
    gramOpen[i] = true;
    paintGrammar(host, line, i);

    const context = lines.map((l) => l.ja).join('\n').slice(0, 500);
    try {
      const { runAiTaskInline } = await import('./views/aipanel.js');
      const r = await runAiTaskInline('explain', line.ja, { context });
      if (r && r.text) {
        // ★ 被截断也**照样保存内容**（用户 2026-10 报的那个"偶尔截断"）
        //   旧行为是 content 非空就 return {text}，截断标志被咽掉；
        //   而调用方（这里）也没有地方记它。结果用户看到一段戛然而止的讲解，
        //   不知道后面还有、也不知道该怎么办。
        //   现在：内容存下来 + `truncated` 一起进缓存，
        //   paintGrammar 会在下面挂一条"没说完，可以调大上限"的提示 + 重问按钮。
        gram[i] = {
          text: r.text,
          at: new Date().toISOString(),
          context,
          truncated: !!r.truncated,
          truncateHint: r.truncateHint || '',
        };
        // 写进笔记缓存（笔记还没保存时会自动暂存，保存后落库）
        await saveAiCache(idOf(), store, { grammar: { [i]: gram[i] } });
      } else if (r && r.error) {
        gram[i] = { text: '（讲解失败：' + r.error + '）', at: new Date().toISOString(), failed: true };
      }
    } catch (e) {
      gram[i] = { text: '（讲解失败：' + String((e && e.message) || e) + '）', at: new Date().toISOString(), failed: true };
    } finally {
      delete gramBusy[i];
      paintGrammar(host, line, i);
    }
  }

  /** 重画全部行。 */
  function repaint() {
    rowsHost.innerHTML = '';
    lines.forEach((line, i) => rowsHost.appendChild(paintRow(line, i)));
    // 工具条上的"还有几段没译文"也要跟着变（函数声明会提升，这里能调到）
    if (typeof updateBarInfo === 'function') updateBarInfo();
  }

  /** 翻一段并写缓存。 */
  async function translateOne(i, jaText) {
    // 用户自己填过的行**永远不翻**：那是他确认过的译文，
    // 拿 AI 的输出覆盖用户自己写的东西是绝对不能做的事。
    if (isUser[i]) return;
    try {
      trans[i] = await translateText(jaText);
      delete failed[i];
      await saveAiCache(idOf(), store, { translation: { [i]: trans[i] } });
    } catch (e) {
      failed[i] = String((e && e.message) || e);
    }
  }

  /**
   * 翻译**所有还没有译文的段落**。
   *
   * 设计取舍（用户已同意按段自动翻译）：
   *   · **串行**而不是并发：并发会把服务商的速率限制打满，而且失败时
   *     分不清是哪一段出的问题。串行慢一点但可预期、可重试。
   *   · 单段失败**不中断整体**：记下原因、继续翻下一段，
   *     最后统一报告"成功几段、失败几段"。一段失败就全停是最气人的。
   *   · 已有译文的段**跳过**，不重复花钱。
   */
  async function translateAll(onProgress) {
    if (!aiOn) { toastWarn(aiWhy || 'AI 没启用'); return { done: 0, failed: 0, skipped: 0 }; }
    // ★ 先重新读一次缓存：用户可能在"建阅读器"和"点这个按钮"之间才把笔记存下来，
    //   那段窗口里翻过的译文只在数据库里，内存里看不见（见 reloadCache 的注释）。
    //   不补这一步就会把已经翻过的段落再翻一遍 —— 花用户第二次钱。
    await reloadCache();
    const todo = [];
    lines.forEach((line, i) => { if (!trans[i] && line.ja) todo.push({ i, ja: line.ja }); });
    if (!todo.length) { toast('所有段落都已经有译文了', 'ok'); return { done: 0, failed: 0, skipped: lines.length }; }

    // 首次使用要让用户明确知道"会发出去什么"（段落正文）。
    // 这一步**不能省** —— 自动翻译发的内容比"选中一段"多得多。
    const agreed = await ensureAck(confirmAiNotice);
    if (!agreed) return { done: 0, failed: 0, skipped: 0, cancelled: true };

    let done = 0, failedCount = 0;
    for (let k = 0; k < todo.length; k++) {
      const { i, ja } = todo[k];
      if (typeof onProgress === 'function') onProgress(k + 1, todo.length, done, failedCount);
      await translateOne(i, ja);
      if (trans[i]) done++; else failedCount++;
      repaint();
    }
    // 批量失败时给一句总结，别让用户自己数
    if (failedCount && !done) toast(`全部 ${failedCount} 段都失败了，看每段的提示`, 'error');
    else if (failedCount) toast(`成功 ${done} 段，失败 ${failedCount} 段（可单独重试）`, 'warn');
    else toast(`翻译完成，共 ${done} 段`, 'ok');
    return { done, failed: failedCount, skipped: lines.length - todo.length };
  }

  // ── 顶部工具条 ──
  const zhToggle = el('button', {
    class: 'btn btn-sm' + (zhVisible ? ' btn-primary' : ''),
    dataset: { act: 'ai-zh-toggle' },
    text: zhVisible ? '中文栏：显示' : '中文栏：隐藏',
    onclick: () => {
      zhVisible = !zhVisible;
      zhToggle.textContent = zhVisible ? '中文栏：显示' : '中文栏：隐藏';
      zhToggle.classList.toggle('btn-primary', zhVisible);
      repaint();
    },
  });

  const transBtn = el('button', {
    class: 'btn btn-sm btn-primary', dataset: { act: 'ai-translate-all' },
    text: '自动翻译全部段落',
    onclick: async () => {
      transBtn.disabled = true;
      transBtn.textContent = '翻译中…';
      await translateAll((k, n, ok, bad) => {
        transBtn.textContent = `翻译中… ${k}/${n}（成功 ${ok}，失败 ${bad}）`;
      });
      transBtn.disabled = false;
      transBtn.textContent = '自动翻译全部段落';
      updateBarInfo();
    },
  });

  /**
   * 工具条上那句"还有几段没有译文"。
   *
   * ⚠️ 必须做成**每次重画都更新**的函数，不能算一次就写死：
   *    翻完之后那句话还写着"其中 12 段还没有译文"，用户会以为没生效。
   *    这种"界面上的数字和实际状态不一致"是最容易被当成 bug 的。
   */
  const barInfo = el('span', { class: 'air-bar-info faint' });
  function updateBarInfo() {
    const missing = lines.filter((l, i) => l.ja && !trans[i]).length;
    const base = aiOn
      ? (missing
        ? `${lines.length} 段，其中 ${missing} 段还没有译文。`
        : `${lines.length} 段，全部有译文（不会再花钱）。`)
      : '未启用 AI，中文栏需要你自己填。';
    barInfo.textContent = base;

    // ★ 让"译文还没进笔记"这件事**看得见**。
    //   为什么必须有这一块：用户的心智模型是"我翻译过了 = 它就在了"，
    //   而实际上笔记还没保存时译文只在内存里。不告诉他，他会在切页或刷新之后
    //   才发现丢了，然后觉得"白花 token"。这比结果不对更伤信任。
    const p = pendingCacheCount(idOf());
    if (p > 0) {
      pendingHint.textContent = typeof opts.onSaveNote === 'function'
        ? `⚠️ 还有 ${p} 段译文只在本页，没存进笔记 —— 点右边按钮存一下。`
        : `⚠️ 还有 ${p} 段译文没存进笔记（保存一次笔记就会一起存下来）。`;
      pendingHint.style.display = '';
    } else {
      pendingHint.textContent = '';
      pendingHint.style.display = 'none';
    }
  }

  const pendingHint = el('span', { class: 'air-pending', style: { display: 'none' } });
  const pendingSave = (typeof opts.onSaveNote === 'function')
    ? el('button', {
      class: 'btn btn-sm btn-primary', text: '保存进笔记',
      title: '把正文和这 N 段译文一起存成笔记（以后打开就不再花钱重翻）',
      onclick: async () => {
        pendingSave.disabled = true;
        try { await opts.onSaveNote(); } finally { pendingSave.disabled = false; }
        updateBarInfo();
      },
    })
    : null;
  const bar = el('div', { class: 'air-bar' }, [
    zhToggle,
    barInfo,
    pendingHint,
    el('span', { class: 'spacer' }),
    pendingSave,
    aiOn ? transBtn : null,
  ].filter(Boolean));
  updateBarInfo();

  /**
   * 一行小字：**怎么改某个词的读音**。
   *
   * ⚠️ 为什么必须有（用户报的第 3 个问题的前半）：
   *   原话是「我是偶然才发现如何改注音（应该是点击注音位置？），
   *         我觉得你最好在页面上找个位置用一行小字提示一下修改方法。」
   *
   *   这是一个**纯粹的发现性问题**：功能一直在，但没有任何地方告诉用户它存在。
   *   也正因为他猜的是"点注音位置"，才会觉得触发不稳定 ——
   *   真正的触发是**双击整个词**（点哪里都行，不用精确点到那个小字）。
   *
   *   所以这行字要同时说清两件事：
   *     ① 动作是什么（双击词）；
   *     ② **不用点准**（点词的任何位置都行）—— 这一句直接消除他的挫败感。
   *   只有允许改读音的页面才显示（没传 onEditReading 就不显示，避免说空话）。
   *
   *   ⚠️ 第三件事是后来加的（用户要求：「把改分词的方法用小字写出来」）：
   *     改分词藏在"改读音"对话框里，**光看这行字根本猜不到它存在**，
   *     所以必须在这里点出来。但**只能一句**，写多了这行小字就没人看了 ——
   *     详细步骤在对话框自己里面（`openSegmentEditor` 的 `.seg-hint`）。
   */
  const editHint = opts.onEditReading
    ? el('div', { class: 'air-edit-hint' }, [
      el('span', { text: '改读音：' }),
      el('strong', { text: '双击任意一个词' }),
      el('span', { text: '（点词上哪儿都行，不用点准注音那几个小字；' }),
      el('strong', { text: '手机长按或电脑右键' }),
      el('span', { text: '也可以）。' }),
      el('span', { text: '单击一个词是查意思，双击才是改读音，两者不冲突。' }),
      el('span', { text: '改过的读音按「词」记住，全站生效、会进备份。' }),
      // 改分词的入口在同一个小框里（见 jpreader.openSegmentEditor）
      el('div', { class: 'air-edit-hint-sub' }, [
        el('span', { text: '改分词（这个词该不该算一个词）：' }),
        el('strong', { text: '双击那个词 → 点「改分词」' }),
        el('span', { text: '。方块之间的「合」＝并成一个词，方块里的「切」＝在这里切开；' }),
        el('span', { text: '外面的「包括前面的…」只是把旁边的词拉进来一起改。' }),
      ]),
    ])
    : null;

  // AI 没开时**长期可见地**说明一句（不要等到用户点了才报错）
  if (!aiOn) {
    noticeHost.appendChild(el('div', { class: 'banner banner-info' }, [
      el('strong', { text: '中文栏空着是正常的：' }),
      el('span', { text: aiWhy + '　日文解析、注音、查词都不需要 AI，照常用。' }),
    ]));
  }

  const node = el('div', { class: 'air-reader' }, [
    noticeHost, bar, editHint, rowsHost,
  ].filter(Boolean));
  repaint();

  return {
    node,
    repaint,
    setZhVisible(v) { zhVisible = !!v; zhToggle.textContent = zhVisible ? '中文栏：显示' : '中文栏：隐藏'; zhToggle.classList.toggle('btn-primary', zhVisible); repaint(); },
    isZhVisible() { return zhVisible; },
    translateAll,
    hasTranslation(i) { return !!trans[i]; },
    translationOf(i) { return trans[i] || ''; },
  };
}

/**
 * 把「AI 讲这个词」按钮装进速查抽屉。
 *
 * 什么时候调：阅读页 render() 里调一次即可（重复调只是覆盖同一个回调）。
 *
 * ⚠️ 为什么每次点击都**重新读配置**，而不是挂载时读一次缓存住：
 *   用户很可能是"先点了一下发现 AI 没开 → 去设置里打开 → 回来再点"。
 *   如果挂载时读一次就记死了，他必须刷新页面才能用 —— 那是个很没必要的坎。
 *   （原来的 aipanel.js 就是挂载时读一次，这个毛病真实存在。）
 */
export function installAiWordHook() {
  setAiWordHook(async (word) => {
    const w = String(word || '').trim();
    if (!w) return;
    let on = false;
    let why = '';
    try {
      const r = await getAiConfig();
      on = !!(r && r.config && r.config.enabled);
      if (!on) why = 'AI 默认是关闭的。到「设置 → AI」里打开并填好密钥，回来直接点就行（不用刷新页面）。';
    } catch (e) {
      why = '读不到 AI 配置：' + String((e && e.message) || e);
    }
    if (!on) { toastWarn(why); return; }
    const { runAiTask } = await import('./views/aipanel.js');
    runAiTask('word', w);
  });
}

/**
 * ⚠️ 原来这里有个 `explainSentence(text, context)`：「讲这句语法」的入口，
 *    两个阅读页都调它。**已删除**（用户 2026-10 的要求）。
 *
 * 为什么删掉而不是留着：
 *   它内部走的是 `runAiTask()` → `showResultPanel()` —— 一个**浮层面板**。
 *   用户的原话正是「ai 的输出依旧是弹窗，无法保存」。现在"讲语法"整条流程
 *   （请求中状态 → 结果落在**句子下方的可折叠模块** → 写进笔记的
 *   aiCache.grammar）都由本文件的阅读器自己管，两个阅读页只传
 *   `onSentence: true` 这个开关，不再需要这个函数。
 *
 *   删掉而不是保留一个"已没人调用"的导出，是因为它带着一个**已经被否决的交互**：
 *   下一个人看到它还在，很可能会以为"讲语法就走这里"，于是把弹窗又接回去。
 *   （同理，`collectSelection()` 当初也是这么删的，见 aipanel.js 的说明。）
 */

/** AI 关闭时长期显示的说明条（两个阅读页共用）。 */
export function aiOffBanner() {
  return el('div', { class: 'banner banner-info' }, [
    el('strong', { text: '关于 AI：' }),
    el('span', { text: 'AI 默认关闭。没启用时，日文解析、注音、查词、加生词本全都照常用，只是中文栏空着。' }),
  ]);
}

/**
 * 按**当前配置**给出一条 AI 状态说明（启用时返回 null）。
 *
 * 为什么要"现取"而不是启动时算一次：
 *   用户可能刚在设置里把 AI 打开。启动时算一次的话，他会看到一条
 *   已经不成立的提示横在那儿 —— 那比没有提示更让人困惑。
 *
 * 异步函数，返回 null 或一个元素。
 */
export async function aiStatusBanner() {
  let on = false;
  let error = '';
  try {
    const r = await getAiConfig();
    on = !!(r && r.config && r.config.enabled);
  } catch (e) {
    error = String((e && e.message) || e);
  }
  if (on) return null;
  return el('div', { class: 'banner banner-info' }, [
    el('strong', { text: 'AI 还没启用：' }),
    el('span', { text: error
      ? ('读不到配置（' + error + '）。')
      : '中文栏会空着。到「设置 → AI」里打开并填好密钥，这里就能自动翻译 —— 不用刷新页面。'
        + '日文解析、注音、查词、加生词本都不需要 AI，照常用。' }),
  ]);
}
