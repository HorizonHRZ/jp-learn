/**
 * draft.js —— 「还没保存的正文」的草稿保护。
 *
 * ──────────────────────────────────────────────────────────────────
 * 为什么要有这个文件
 * ──────────────────────────────────────────────────────────────────
 * 用户报的 bug 是"翻译完一保存，译文没了"。修那个 bug 的时候发现同一类
 * 风险还有一个没盖住：**页面上粘了正文、翻了译文，切到别的页再回来，
 * 正文本身就没了** —— 因为正文只活在 DOM 的 textarea 里。
 *
 * 用户的原话是「这是必须项而非可选项」，指的虽然是 AI 译文，
 * 但"我辛苦粘进来的东西不该自己消失"是同一个诉求。
 * 所以这里把"正在编辑但还没保存的内容"也保护起来。
 *
 * ──────────────────────────────────────────────────────────────────
 * 为什么放 localStorage，不放 IndexedDB
 * ──────────────────────────────────────────────────────────────────
 *   · 草稿是**临时的、本机的、每台设备各管各的**，不是用户数据资产。
 *     它的价值只有几分钟：救回"手滑切页"这一次。
 *   · 放 IndexedDB 就要考虑"草稿算不算用户数据、导出要不要带上、
 *     快照要不要包含" —— 那些都会污染真正的数据模型。
 *   · 硬约束要求"任何升级都不许迁移或清空用户数据"。
 *     草稿不进去，就永远不会踩到这条线。
 *
 * ⚠️ 代价（如实写下来，不藏）：**换浏览器/清缓存草稿就没了。**
 *    这是刻意的取舍：草稿不是数据，正式内容请点「存为笔记」。
 *    界面上那句话也必须照实说，不能让用户以为草稿等于保存。
 */
import { el } from './ui.js';

/** 草稿超过这个时间就不再提示恢复（避免翻出一份上个月的内容） */
export const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 草稿的存储键。一个视图一个键 —— 歌词的草稿不能跑到精读页去。
 * @param {string} viewId
 */
export function draftKey(viewId) {
  return 'jp-learn:draft:' + String(viewId || 'unknown');
}

/**
 * 存草稿。
 *
 * ⚠️ 空内容**不覆盖**已有草稿。原因：用户清空输入框常常是"我想重来"，
 *    但更多时候是**误删**。把草稿留着，他还能按「恢复草稿」找回来；
 *    一覆盖就真没了。宁可留一份多余的东西，也不要制造一次不可逆的丢失。
 *
 * @returns {boolean} 是否真的写入了
 */
export function saveDraft(viewId, data) {
  try {
    const text = String((data && data.text) || '');
    const translation = String((data && data.translation) || '');
    if (!text.trim() && !translation.trim()) return false;
    const payload = {
      text,
      translation,
      at: new Date().toISOString(),
    };
    localStorage.setItem(draftKey(viewId), JSON.stringify(payload));
    return true;
  } catch {
    // 隐私模式 / 存储被禁用时 localStorage 会抛。**不能因此让页面挂掉** ——
    // 草稿只是兜底功能，它失败了正文编辑也必须照常能用。
    return false;
  }
}

/**
 * 读草稿。过期、损坏、格式不对一律当成"没有草稿"。
 * @returns {{text:string, translation:string, at:string}|null}
 */
export function loadDraft(viewId) {
  try {
    const raw = localStorage.getItem(draftKey(viewId));
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || typeof d.text !== 'string') return null;
    if (!d.text.trim() && !String(d.translation || '').trim()) return null;
    const at = Date.parse(d.at || '');
    if (Number.isFinite(at) && Date.now() - at > DRAFT_TTL_MS) return null;
    return { text: d.text, translation: String(d.translation || ''), at: d.at || '' };
  } catch {
    return null;
  }
}

/** 删草稿（用户点了「不要了」，或者内容已经正式存成笔记） */
export function clearDraft(viewId) {
  try { localStorage.removeItem(draftKey(viewId)); } catch { /* 忽略 */ }
}

/**
 * 一份草稿和"当前输入框里的内容"是不是**实际上同一个东西**。
 *
 * ⚠️ 为什么需要这个函数（用户报的第 5 个问题）
 * ────────────────────────────────────────────────────────────────────
 * 用户的原话：「已经保存过的歌词笔记，重新进入歌词页时会误判为未保存的草稿，
 *              每次返回都弹窗提示。」
 *
 * 根因是一条**看不见的自动路径**，不是用户操作：
 *   ① `openNote()` 把笔记正文填进输入框；
 *   ② 草稿自动保存的 5 秒兜底定时器**只是"每 5 秒把 getData() 写一遍"**，
 *      它不知道"这份内容其实来自一条已保存的笔记"；
 *   ③ 于是尽管 `saveNote()` / `openNote()` 那一刻清过草稿，
 *      5 秒后草稿又被**原样重建**了；
 *   ④ 下次进页面 → `loadDraft()` 发现草稿 → 弹"发现一份没保存的草稿"。
 *      而输入框是空的（还没打开笔记），所以条件成立 → **每次都弹**。
 *
 * 所以要判断的不是"有没有草稿文件"，而是"**草稿和当前内容是否真的等价**"。
 * 等价 = 这份内容已经有归属（就是那条笔记），草稿没有存在的理由。
 *
 * 比较刻意用 `String()` + 不 trim：**多一个空格就算改过**，
 * 宁可多弹一次也不要漏掉用户真实的修改。
 *
 * @param {object|null} draft  loadDraft() 的结果
 * @param {{text?:string, translation?:string}} cur 当前输入框内容
 * @returns {boolean} true＝两者等价（这份草稿是多余的）
 */
export function draftMatches(draft, cur) {
  if (!draft) return false;
  const a = draft.text == null ? '' : String(draft.text);
  const b = (cur && cur.text) == null ? '' : String((cur && cur.text) || '');
  const c = draft.translation == null ? '' : String(draft.translation);
  const d = (cur && cur.translation) == null ? '' : String((cur && cur.translation) || '');
  return a === b && c === d;
}

/**
 * 判断"要不要因为这个草稿去打扰用户"。
 *
 * 除了 `draftMatches`（内容等价），还要求**输入框里没有内容** ——
 * 用户正在编辑的东西不该被一条恢复提示盖住。
 *
 * @param {object|null} draft
 * @param {{text?:string, translation?:string}} cur
 * @returns {boolean} true＝值得提示恢复
 */
export function shouldOfferDraft(draft, cur) {
  if (!draft) return false;
  const t = String((cur && cur.text) || '').trim();
  const z = String((cur && cur.translation) || '').trim();
  if (t || z) return false;              // 输入框里有东西 → 不打扰
  if (!String(draft.text || '').trim() && !String(draft.translation || '').trim()) return false;
  return true;
}

/**
 * 这份草稿的内容，是不是**已经作为一条笔记存在库里**了？
 *
 * ⚠️ 为什么要专门查一次（用户报的第 5 个问题）
 *   `saveNote()` 已经会在保存那一刻清掉草稿。但真实顺序常常是：
 *     打开一条**旧笔记** → 输入框被填满 → 自动保存每 5 秒把它写回草稿。
 *   于是下次进页面就看到"发现一份没保存的草稿"，可那内容明明早就存好了。
 *
 *   所以判断依据不能是"草稿文件在不在"，而是
 *   **"这份内容有没有已经存下来的归属"** —— 就是这个函数干的事。
 *
 * 比较用**严格相等**（不 trim、不忽略空白）：用户多打一个空格也算改过，
 * 宁可多弹一次恢复提示，也不要漏掉他真实的修改、把内容当"已保存"清掉。
 * （这一条和 `draftMatches` 的取舍一致。）
 *
 * ⚠️ 查不动时返回 **false**（当"没存过"）—— 倾向多保护一次，
 *    宁可多弹一次提示，也不要误清用户的东西。
 *
 * @param {object} dba      db.js 模块（作为参数传进来，draft.js 不依赖它）
 * @param {string} store    'lyrics' | 'readings'
 * @param {{text?:string, translation?:string}} draft
 * @returns {Promise<boolean>} true＝库里已有同内容的笔记，这份草稿是多余的
 */
export async function draftAlreadySaved(dba, store, draft) {
  if (!draft || !dba || typeof dba.dbAll !== 'function') return false;
  const wantText = String(draft.text || '');
  const wantZh = String(draft.translation || '');
  if (!wantText.trim() && !wantZh.trim()) return false;
  try {
    const all = await dba.dbAll(store);
    return (all || []).some((n) => String((n && n.text) || '') === wantText
      && String((n && n.translation) || '') === wantZh);
  } catch {
    return false;
  }
}

/**
 * 造一条"发现草稿"的提示条。
 *
 * 设计取舍：**不自动恢复**。
 *   自动恢复看起来更贴心，但风险是"我以为页面是空的，结果它自己填进去一堆
 *   我没在编辑的旧内容"，用户会搞不清当前状态。所以给一个明确的按钮，
 *   他点了他就知道自己在恢复什么。
 *
 * ⚠️ 这里用 ui.js 的 `el()` 而不是自己拼 DOM：
 *    手写 `Object.assign(document.createElement('span'), { textContent })`
 *    是**不会生效的** —— Object.assign 只赋属性，textContent 在假 DOM 里
 *    也不是普通可写属性。这种写法在真实浏览器里"看着像能用"，
 *    实际会把文字丢掉。用项目统一的 el() 最稳。
 *
 * @param {{viewId:string, draft:object, onRestore:Function, onDiscard?:Function}} o
 * @returns {object} DOM 节点
 */
export function buildDraftBanner(o) {
  const { draft, onRestore, onDiscard } = o;
  const when = draft.at ? String(draft.at).slice(0, 16).replace('T', ' ') : '';
  const len = draft.text ? draft.text.length : 0;
  return el('div', { class: 'banner banner-warn' }, [
    el('strong', { text: '发现一份没保存的草稿' }),
    el('span', { text: `${when ? `（${when}）` : ''}约 ${len} 字。` }),
    el('button', {
      class: 'btn btn-sm btn-primary', text: '恢复草稿',
      onclick: (ev) => {
        if (ev && ev.currentTarget && ev.currentTarget.parentNode) ev.currentTarget.parentNode.remove();
        onRestore && onRestore(draft);
      },
    }),
    el('button', {
      class: 'btn btn-sm btn-ghost', text: '不要了',
      onclick: (ev) => {
        if (ev && ev.currentTarget && ev.currentTarget.parentNode) ev.currentTarget.parentNode.remove();
        onDiscard && onDiscard();
      },
    }),
  ]);
}

/**
 * 给一个视图装上"自动存草稿"。
 *
 * 两条触发路径，刻意都要有：
 *   · **输入停下来就存**（防抖）—— 覆盖"一直在打字、没切页"的情况；
 *   · **定时兜底**（默认 5 秒）—— 覆盖"一直在打字、防抖一直没到点"的情况，
 *     以及"输入事件没触发"的边角情况（粘贴、输入法组合输入）。
 *
 * @param {{viewId:string, getData:Function, intervalMs?:number}} o
 * @returns {{flush:Function, stop:Function}} stop() 必须挂到视图的 destroy() 里
 */
export function installDraftAutosave(o) {
  const viewId = o.viewId;
  const getData = o.getData || (() => ({}));
  const intervalMs = o.intervalMs || 5000;
  let timer = null;

  const write = () => {
    try {
      // ⚠️ getData() 返回 null ＝「当前内容和已保存的笔记一致，没有草稿可存」。
      //    这时**必须把旧草稿清掉**，否则下次进页面还是会弹"发现没保存的草稿"
      //    —— 那正是用户报的第 5 个问题。
      //    清掉是安全的：返回 null 的含义就是"这份内容已经有归属（那条笔记）"，
      //    内容本身存在 IndexedDB 的笔记里，草稿是多余的一份拷贝。
      const data = getData();
      if (data === null) { clearDraft(viewId); return; }
      saveDraft(viewId, data || {});
    } catch { /* 草稿失败不影响编辑 */ }
  };
  const debounced = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; write(); }, 1200);
  };
  const tick = setInterval(write, intervalMs);

  return {
    /** 立刻写一次（保存笔记前、切页前都该调） */
    flush: write,
    /** 停止自动存草稿。⚠️ 视图 destroy() 里必须调，否则定时器会跟着页面泄漏 */
    stop() {
      if (timer) { clearTimeout(timer); timer = null; }
      clearInterval(tick);
    },
    /** 输入事件时调它（防抖那一路径） */
    touch: debounced,
  };
}
