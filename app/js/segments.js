/**
 * segments.js —— 用户手改的**分词切法**：只负责数据库读写。
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么需要这个功能（用户原话）
 * ────────────────────────────────────────────────────────────────────
 *   「我想了一下分词这个功能优化起来有点鸡肋，我觉得可以这样：
 *     暂时保留分词的目前功能，加一个允许用户修改分词的功能。」
 *
 * 分词器是**最长匹配 + 词库统计**，它不知道你在读什么：
 *   · `この人` 会被切成 `この` + `人`（其实你想当一个词看）
 *   · `日本語` 会被切成 `日本` + `語`（词库里没有整词时）
 *   · `今日` 有时被切成 `今` + `日`
 * 这些都是**程序做不到的判断题** —— 取决于你想怎么学、怎么记。
 * 所以必须让用户能改，而且要改一次全站生效。
 *
 * ────────────────────────────────────────────────────────────────────
 * 和「改读音」（yomi.js）的关系：同一套模式，两件事
 * ────────────────────────────────────────────────────────────────────
 * 这两个功能长得像，但**不能合并**：
 *   · 改读音改的是"这个词怎么念"—— 词还是同一个词
 *   · 改分词改的是"哪里算一个词"—— 词本身就变了
 * 所以各存一张表、各有一个入口，界面上是并列的两个动作。
 * 复用的是**模式**（按原文当主键、存在 IndexedDB、全站生效），
 * 而不是代码 —— 硬合在一起会让"到底是切错了还是念错了"变得查不清。
 *
 * ────────────────────────────────────────────────────────────────────
 * 三条设计决定
 * ────────────────────────────────────────────────────────────────────
 * ① **按"那一段原文"记，不按位置记**（和读音表同一个理由）。
 *    切法是文本本身的事实：`この人` 在哪儿都该切得一样。
 *    按原文记 → 改一次全站生效，备份里也看得懂。
 *
 * ② **存在 IndexedDB 的 segOverrides 表**（不在 localStorage）。
 *    进了表定义，导出备份 / 自动快照 / 清空前的强制备份**全部自动覆盖**。
 *
 * ③ **套用发生在浏览器里，不发请求到服务端**。
 *    分词结果本来就在页面上，用用户自己的切法**替换其中几段**是纯字符串操作。
 *    切完之后的读音由已有的 `/api/yomi` 去对齐（那里才是需要 DP 的地方）。
 *
 * ⚠️ **本文件只管数据库**，"怎么套用"在 `segments-apply.js` 里（纯函数）。
 *    这么切是因为混在一起时出过一个很难查的 bug：想单独验证套用逻辑，
 *    就必须把整个 IndexedDB 数据层一起拉起来，没法干净地一次只跑一小段。
 *    现在 `check-segments.mjs` 可以直接 `node` 跑套用逻辑，不需要浏览器。
 *
 * ⚠️ 套用顺序很重要：**先套分词，再套读音**（见 views/lyric.js、views/reading.js）。
 *    反过来会把读音套到即将被替换掉的旧 token 上，白做一遍，
 *    而且替换出来的新 token 会丢掉刚套上的读音。
 */
import * as db from './db.js';
import { applySegOverrides, surfaceOf } from './segments-apply.js';

// 把纯函数重新导出，调用方只需要认 `segments.js` 一个入口
export { applySegOverrides, surfaceOf };

/**
 * 一条切法记录的形状：
 *   {
 *     surface: 'この人',                 // 主键：被改的那一段原文（各段拼起来）
 *     segments: [{ t:'この', r:'この' }, { t:'人', r:'ひと' }],
 *     auto:     ['この','人'],           // 程序原来的切法 —— 备份里能对照"原来切成什么"
 *     at:       1699999999999,
 *   }
 *
 * r 是**建议读音**，可以为空。为空时界面上会标"读音待定"，
 * 渲染时那个 token 就按"词库查不到"处理（不注音、不假装认识）。
 */

/**
 * 读全部切法，做成 Map<surface, 记录>。
 * @returns {Promise<Map<string, object>>}
 */
export async function loadSegOverrides() {
  const map = new Map();
  try {
    const rows = await db.dbAll('segOverrides');
    for (const r of rows || []) {
      // 老/坏记录直接跳过，不要让它把整页搞崩
      if (!r || !r.surface || !Array.isArray(r.segments) || !r.segments.length) continue;
      const clean = r.segments.filter((s) => s && typeof s.t === 'string' && s.t);
      if (!clean.length) continue;
      map.set(r.surface, { ...r, segments: clean });
    }
  } catch {
    // 读不到就当没有 —— 不能因为切法表读不出来就整页不给用
  }
  return map;
}

/**
 * 重新读一遍切法表，**就地套到给定的 token 列表上**，再补振假名。
 *
 * 为什么需要这个函数（这是用户实测报上来的 bug 的修法）：
 *
 *   用户在界面上合并了两个词、点了「保存切法」，提示也显示"已改为 xxx"，
 *   **但阅读器上的词没有变**。再打开那个词却提示"这一串原文已经有一条手改切法"
 *   —— 说明记录**存进去了**，只是页面没跟着变。
 *
 *   根本问题是"保存"和"重画"之间隔着一次重新挂载（remount），
 *   而重新挂载走的是**视图自己**那条渲染路径。只要那条路径上有任何一处
 *   没把 `segOverrides` 套上（或者套上的是旧的那份），用户看到的就是"没生效"。
 *   **一条链上任何一环出问题，症状都一样，而且都不报错。**
 *
 *   所以这里不再依赖"视图重挂时会顺便套上"，而是显式做三件事：
 *     ① 从**数据库**重新读（不信任手里那份 Map，它可能过期）；
 *     ② 就地套到传进来的 token 列表上（`applySegOverrides` 返回新数组，
 *        这里按引用写回每个元素的 `.tokens`）；
 *     ③ 顺手补振假名（合并出来的词没有 ruby，不补就掉注音）。
 *
 * ⚠️ 顺序仍然是**先分词、后读音**：调用方必须在套读音**之前**调它。
 *    这里只管分词，不碰 `readingOverrides` —— 那是 yomi.js 的事。
 *
 * @param {Array} lists 若干 { tokens: Array } 形状的对象（就地改写它们的 .tokens）
 * @returns {Promise<Map<string, object>>} 重新读到的切法表（调用方可以留着下次用）
 */
export async function reapplySegOverrides(lists) {
  const map = await loadSegOverrides();
  const all = [];
  for (const item of lists || []) {
    if (!item || !Array.isArray(item.tokens) || !item.tokens.length) continue;
    item.tokens = applySegOverrides(item.tokens, map).tokens;
    all.push(item.tokens);
  }
  if (all.length) {
    // 补振假名失败不阻断（ensureRuby 自己吞异常）—— 一个词没注音
    // 远好过整页打不开。
    await Promise.all(all.map((tk) => ensureRuby(tk)));
  }
  return map;
}

/**
 * 给套用切法之后**还没有振假名**的词补上（走服务端已有的 /api/yomi）。
 *
 * 为什么需要单独一步：套用是同步的（渲染函数是同步的），而算振假名要发请求。
 * 所以流程是：套切法（同步）→ 收集缺注音的词 → 一起补 → 再渲染。
 *
 * ⚠️ 只补 `override && !ruby` 的 token，绝不去动程序自己算好的那些 ——
 *    否则每次渲染都会多发一堆没必要的请求，还会把已有的结果洗掉。
 *
 * ⚠️ 补不上（服务端没起来 / 读音对不齐）时**不弹错**：这个词就显示成
 *    "没有注音"，不影响别的词。阅读页不该因为一个词补不上注音就打断。
 *
 * @param {Array} tokens 套用切法之后的 token 列表
 * @returns {Promise<number>} 补上了几个
 */
export async function ensureRuby(tokens) {
  const need = (tokens || []).filter((t) => t && t.override && t.reading && !t.ruby);
  if (!need.length) return 0;
  let n = 0;
  await Promise.all(need.map(async (t) => {
    try {
      const url = `/api/yomi?surface=${encodeURIComponent(t.surface)}&reading=${encodeURIComponent(t.reading)}`;
      const res = await fetch(url);
      const j = await res.json();
      if (!j || !j.ok) return;
      t.ruby = j.ruby || [];
      t.romaji = j.romaji || '';
      t.rubyEstimated = !!j.estimated;
      n++;
    } catch {
      // 补不上就让它没注音，别的词照常
    }
  }));
  return n;
}

/**
 * 保存一条切法。
 *
 * ⚠️ `autoSegments`（**原来怎么切的**）是必须的，不是可选装饰：
 *    套用时就是拿它去页面上找"这一段在哪儿"。没有它，合并类的记录
 *    下次打开页面就永远匹配不上 —— 存了但没用，而用户以为保存成功了。
 *
 * @param {string} surface 这段原文（各段拼起来）
 * @param {Array<{t:string,r?:string}>} segments 新的切法
 * @param {string[]} autoSegments 程序原来的切法（**匹配用的坐标**）
 * @returns {Promise<object>} 存进去的记录
 */
export async function saveSegOverride(surface, segments, autoSegments = []) {
  const s = String(surface || '');
  if (!s) throw new Error('这一段没有文字，改不了');
  const clean = (segments || [])
    .map((x) => ({ t: String((x && x.t) || ''), r: String((x && x.r) || '') }))
    .filter((x) => x.t);
  if (!clean.length) throw new Error('切法不能是空的');

  // ⚠️ 各段拼起来必须还是原来那段文字。否则这条记录会**永远匹配不上**，
  //    变成一条"存了但没用"的垃圾数据 —— 而用户以为保存成功了。
  //    这一类"看起来成功其实没生效"的失败最难查，所以宁可在写库前就拦住。
  const joined = clean.map((x) => x.t).join('');
  if (joined !== s) {
    throw new Error(`各段拼起来必须还是原文：现在是「${joined}」，应该是「${s}」`);
  }

  // 匹配坐标（auto）也要校验：它拼出来必须和 surface 一样，
  // 否则套用时找不到位置。
  const auto = (Array.isArray(autoSegments) ? autoSegments : []).map((x) => String(x)).filter(Boolean);
  const autoText = auto.join('');
  if (!auto.length || autoText !== s) {
    throw new Error(`「原来怎么切的」对不上原文： auto 拼出来是「${autoText}」，应该是「${s}」`);
  }
  // 没改变切法就不用存（存了反而会让界面显示"已改"却看不出区别）
  if (auto.length === clean.length && auto.every((x, i) => x === clean[i].t)) {
    throw new Error('切法和现在一样，不用保存');
  }

  const rec = {
    surface: s,
    auto,
    segments: clean,
    at: Date.now(),
  };
  await db.dbPut('segOverrides', rec);
  return rec;
}

/**
 * 删掉一条切法（恢复程序自己的切法）。
 * @returns {Promise<boolean>} 是否真的删掉了
 */
export async function removeSegOverride(surface) {
  const s = String(surface || '');
  if (!s) return false;
  try {
    const existed = await db.dbGet('segOverrides', s);
    if (!existed) return false;
    await db.dbDelete('segOverrides', s);
    return true;
  } catch {
    return false;
  }
}

/** 一共有多少条手改切法（设置页/统计用） */
export async function countSegOverrides() {
  try { return await db.dbCount('segOverrides'); } catch { return 0; }
}
