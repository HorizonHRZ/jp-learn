/**
 * yomi.js —— 用户手改的汉字读音（**歌词页与精读页共用**）。
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么需要这个模块（用户原话）
 * ────────────────────────────────────────────────────────────────────
 *   「歌词在识别之后标注汉字读音时，有的多音汉字表音并不是歌里唱的那个读法，
 *     需要添加一个允许我修改的功能。这点在精读模块应该也适用。」
 *
 * 这是**程序做不到的事**：汉字多音（今日 = きょう / こんにち，日 = ひ / にち / か，
 * 生 = せい / しょう / いきる…），词库统计只能给出"最可能的读音"。
 * 歌里唱的、文章里念的是哪一个，只有听的人知道。所以必须让用户能改，
 * 而且改完之后**整页注音都要跟着变**，不能只改那一个显示。
 *
 * ────────────────────────────────────────────────────────────────────
 * 三条设计决定
 * ────────────────────────────────────────────────────────────────────
 * ① **按"词"记，不按"位置"记**。
 *    同一个词在这首歌里出现三次、在那篇文章里也出现，读音是同一个事实。
 *    按词记 → 改一次全站生效；也更容易在备份 JSON 里看懂。
 *    代价：如果同一词在不同歌里真要读不同音，这个模型就表达不了。
 *    （日文里这种情况极少 —— 除非是**人名**。人名确实会有歧义，
 *      所以界面上会提示"这个词的读音已经改过，全站生效"。）
 *
 * ② **存在 IndexedDB 的 readingOverrides 表，不在 localStorage**。
 *    这张表在 STORE_DEFS 里，所以 exportAll / 快照 / 清空保护**全部自动覆盖**，
 *    换电脑导入备份后手改的读音还在。
 *
 * ③ **对齐由服务端算**（/api/yomi）。
 *    振假名怎么切要用 DP + data/index/kanji.json 的单字读音统计（3000+ 条），
 *    没必要为了改个读音把它也发给浏览器。所以这里只发一个请求拿结果。
 *
 * ⚠️ 本模块**不缓存**读音表：请求量极小（用户改一次发一次），
 *    缓存反而会有"改了没生效"的风险 —— 那正是用户最不能接受的感觉。
 */
import * as db from './db.js';

/** 一次改动的记录形状：{ surface, reading, at } */

/**
 * 读全部手改读音，做成 Map<surface, 记录>。
 * 页面初始化时读一次，之后每次改动各页面自己维护内存副本。
 *
 * 记录形状：{ surface, reading, ruby, romaji, estimated, at }
 *   ruby / romaji 是**存库时算好的**，这样套用的时候不用发请求（见 applyOverrides）。
 *   旧版本只存了 { surface, reading, at }，也照收 —— 向后兼容，不丢用户的改动。
 *
 * @returns {Promise<Map<string, object>>}
 */
export async function loadOverrides() {
  const map = new Map();
  try {
    const rows = await db.dbAll('readingOverrides');
    for (const r of rows || []) {
      if (r && r.surface && r.reading) map.set(r.surface, r);
    }
  } catch {
    // 读不到就当没有 —— 不能因为读音表读不出来就整页不给用
  }
  return map;
}

/**
 * 把表里的读音套到 token 上（**就地修改**，返回改了几个）。
 *
 * 为什么不是渲染时再查：
 *   渲染函数（jpreader.renderTokens）是**同步**的，而读表是异步的。
 *   所以流程是"先取表 → 套到 token → 再渲染"，渲染函数保持纯同步。
 *
 * ⚠️ 这里**必须把存好的振假名和罗马音一起套上去** —— 这是踩过的一个坑：
 *    第一版只改 `t.reading` 并把 `t.ruby` 置空（想"等重新对齐"），
 *    但**没有任何代码会去补这个空**，结果页面上那个词变成
 *    「读音是对的、振假名却整个消失、罗马音还是旧的」。
 *    所以存库时就把算好的 ruby / romaji 一起存（见 saveOverride），
 *    这里直接取用，全程同步、不发请求、不出现中间态。
 *
 * 老记录（早期版本只存了 reading）也会被兼容：没有 ruby 就退化成
 * 不显示振假名，但读音和罗马音仍然是用户改的那个 —— 不会报错、不会崩。
 *
 * @param {Array} tokens 分词结果
 * @param {Map<string, object|string>} overrides surface → 记录（或旧版只有读音字符串）
 * @returns {number} 被改写的 token 数
 */
export function applyOverrides(tokens, overrides) {
  if (!overrides || !overrides.size) return 0;
  let n = 0;
  for (const t of tokens || []) {
    if (!t || t.isSpace || t.isPunct || !t.surface) continue;
    const rec = overrides.get(t.surface);
    if (!rec) continue;
    // 兼容两种形状：新的是对象，旧的可能只是读音字符串
    const reading = typeof rec === 'string' ? rec : rec.reading;
    if (!reading) continue;
    if (reading !== t.reading) n++;
    t.reading = reading;
    t.override = true;          // 界面据此显示"这个读音是你定的"
    if (typeof rec === 'object') {
      if (Array.isArray(rec.ruby) && rec.ruby.length) t.ruby = rec.ruby;
      if (typeof rec.romaji === 'string' && rec.romaji) t.romaji = rec.romaji;
      t.rubyEstimated = !!rec.estimated;
    }
  }
  return n;
}

/**
 * 问服务端要「词形 + 读音 → 振假名切分 + 罗马音」。
 *
 * @param {string} surface 词形
 * @param {string} reading 平假名/片假名读音
 * @returns {Promise<{ruby:Array<{t:string,r:string}>, romaji:string, estimated:boolean}>}
 * @throws {Error} 读音不是假名、或服务端不可用时抛出（调用方要把话说明白）
 */
export async function alignReading(surface, reading) {
  const url = `/api/yomi?surface=${encodeURIComponent(surface)}&reading=${encodeURIComponent(reading)}`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error('连不上本地服务，读音对齐算不了：' + ((e && e.message) || e));
  }
  let j = null;
  try { j = await res.json(); } catch { /* 下面统一报错 */ }
  if (!res.ok || !j || !j.ok) {
    throw new Error((j && j.error) || `服务端返回 ${res.status}`);
  }
  return { ruby: j.ruby || [], romaji: j.romaji || '', estimated: !!j.estimated };
}

/**
 * 保存一条手改读音，并返回算好的对齐结果。
 *
 * 顺序很重要：**先问服务端算对齐，成功了再写库**。
 * 反过来的话，如果读音不合法（用户填了罗马音），库里会留一条用不了的记录，
 * 而用户看到的是"保存失败" —— 数据和使用状态就不一致了。
 *
 * 为什么把 ruby / romaji 也一起存进库（而不是只存读音）：
 *   套用读音发生在**同步的渲染过程**里（applyOverrides），那时不能发请求。
 *   如果库里只有读音，渲染时就没有振假名可用，只能先画个"没有注音"的样子
 *   再异步补 —— 用户会看到一闪、而且离线/服务没跑时就永远补不上。
 *   存下来还有个好处：导出的 JSON 备份是**自解释**的，
 *   以后看备份能直接看出"这个词你改成了这个读音、当时显示成这样"。
 *
 * @returns {{ruby,romaji,estimated}}
 */
export async function saveOverride(surface, reading) {
  const s = String(surface || '').trim();
  const r = String(reading || '').trim();
  if (!s) throw new Error('这个词没有词形，改不了');
  if (!r) throw new Error('读音不能为空');
  const aligned = await alignReading(s, r);   // 先算；算不出来就不写库
  await db.dbPut('readingOverrides', {
    surface: s,
    reading: r,
    ruby: aligned.ruby || [],
    romaji: aligned.romaji || '',
    estimated: !!aligned.estimated,
    at: Date.now(),
  });
  return aligned;
}

/**
 * 删除一条手改读音（恢复程序自己猜的读音）。
 * @returns {Promise<boolean>} 是否真的删掉了
 */
export async function removeOverride(surface) {
  const s = String(surface || '').trim();
  if (!s) return false;
  try {
    const existed = await db.dbGet('readingOverrides', s);
    if (!existed) return false;
    await db.dbDelete('readingOverrides', s);
    return true;
  } catch {
    return false;
  }
}

/**
 * 一共有多少条手改读音（设置页/统计用）。
 */
export async function countOverrides() {
  try { return await db.dbCount('readingOverrides'); } catch { return 0; }
}
