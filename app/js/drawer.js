/**
 * drawer.js —— 全局速查抽屉
 *
 * 生词本形态的第二个组成部分（第一个是背单词页里的词表管理视角）：
 * 一个全局悬浮按钮（右下角），点开是查词抽屉 ——
 * 输入日语（词形 / 读音 / 罗马音都能查），结果按优先级展示：
 *   生词本 → 内置词库缓存 → 服务端查词（能还原活用形，如 使って → 使う）
 * 每个结果都能一键「加入生词本」（已加的显示 ✓ 已加入，可移除）。
 *
 * 为什么是抽屉而不是新页面：任何页面（歌词、精读、语法）里遇到不会的词
 * 都应该能随手查、随手收，不必切走。放到导航里反而打断了当前阅读。
 *
 * 挂在 window 上供全局使用（window.JP_LOOKUP），并且处理 Esc 关闭。
 */

import { el, toast, toastOk } from './ui.js';
import { lookupWord, isInVocab, addWord, removeWord, wordIdOf } from './vocabdata.js';

let root = null;         // 抽屉 DOM
let backdrop = null;
let fab = null;
let searchInput = null;
let resultsHost = null;
let opened = false;

/**
 * 「AI 讲这个词」按钮的**回调注册点**。
 *
 * 为什么要注册而不是直接 import 一个 AI 模块：
 *   本文件是速查抽屉，它应当能在**完全没有 AI** 的情况下独立工作、独立测试。
 *   直接 import 会把 AI 变成抽屉的硬依赖（而且 ai.js/airead.js 又都要建 DOM，
 *   依赖图会绕成一团）。所以这里只留一个"挂载点"：
 *   谁想让抽屉里出现 AI 按钮，谁在启动时 setAiWordHook(fn)。
 *
 * 没注册时按钮**完全不出现** —— 而不是出现一个点了没反应的按钮。
 *
 * @param {null|((word:string, ev:Event)=>void)} fn
 */
let aiWordHook = null;
export function setAiWordHook(fn) {
  aiWordHook = typeof fn === 'function' ? fn : null;
}

/** 全局开关（快捷键与悬浮按钮都用它） */
export function toggleLookup() {
  if (!root) build();
  if (opened) close(); else open();
}

export function isLookupOpen() {
  return opened;
}

function build() {
  backdrop = el('div', { class: 'pop-backdrop', onclick: () => close() });
  root = el('div', { class: 'pop', role: 'dialog', 'aria-label': '查词' });

  searchInput = el('input', {
    class: 'input', type: 'search', placeholder: '查日语词（词形/读音/罗马音）…',
    autocomplete: 'off', spellcheck: 'false',
    oninput: debounce(() => runQuery(searchInput.value), 220),
    onkeydown: (e) => { if (e.key === 'Enter') runQuery(searchInput.value); },
  });

  resultsHost = el('div', { class: 'pop-body' });

  // ⚠️⚠️ 搜索框必须放在 `.pop-head` 里，**不能单独占一个 `.pop-body`**。
  //
  //    用户 2026-10 反馈的原话：
  //      「查词功能在输入文字后，下面显示的结果只会在页面的下半段出现，
  //        上面有大幅度的留白，看着不是很舒服。」
  //
  //    原因就在这一行上。旧写法是：
  //        root.appendChild(el('div', { class: 'pop-body' }, [searchInput]));
  //        root.appendChild(resultsHost);   // resultsHost 也是 .pop-body
  //    而 `.pop-body` 的样式是 `flex: 1; overflow: auto` ——
  //    意思是"**撑满剩余高度**"。抽屉整体是
  //    `display:flex; flex-direction:column`，高度等于整个视口，
  //    于是那个只装了一个输入框的 `.pop-body` 把**几乎全部高度**吃掉了。
  //    结果区同样有 `flex: 1`，但它排在后面、分不到空间，
  //    只能缩在抽屉最下面一小条 —— 看起来就是"上面一大片空白"。
  //
  //    `.pop-head` 不是 flex:1（它是内容高度），所以把输入框挂在那里，
  //    头部自然变成"标题 + 输入框"两块，结果区独自撑满剩下的空间。
  //    📌 **给容器加 `flex: 1` 之前，先想清楚它是不是真的该"撑满剩余高度"。**
  root.appendChild(el('div', { class: 'pop-head pop-head-search' }, [
    el('div', { class: 'pop-head-row' }, [
      el('h3', { text: '查词' }),
      el('button', { class: 'modal-x', title: '关闭（Esc）', onclick: () => close() }, '×'),
    ]),
    searchInput,
  ]));
  root.appendChild(resultsHost);
  root.appendChild(el('div', { class: 'pop-foot', text: '按住 Ctrl+Shift+F 打开 · Esc 关闭' }));

  fab = el('button', {
    class: 'pop-fab', title: '速查（Ctrl+Shift+F）',
    onclick: () => toggleLookup(),
  }, '查');

  document.body.appendChild(backdrop);
  document.body.appendChild(root);
  document.body.appendChild(fab);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && opened) { close(); e.preventDefault(); }
  });
}

function open() {
  opened = true;
  backdrop.classList.add('is-open');
  root.classList.add('is-open');
  fab.classList.add('hidden');
  searchInput.value = '';
  resultsHost.innerHTML = '';
  searchInput.focus();
}

function close() {
  opened = false;
  backdrop.classList.remove('is-open');
  root.classList.remove('is-open');
  fab.classList.remove('hidden');
}

let querySeq = 0;
async function runQuery(q) {
  const seq = ++querySeq;
  const text = String(q || '').trim();
  resultsHost.innerHTML = '';
  if (!text) return;

  resultsHost.appendChild(el('div', { class: 'loading', text: '查词中…' }));
  const res = await lookupWord(text);
  if (seq !== querySeq) return;              // 输入被后续查询覆盖，丢弃过期结果

  resultsHost.innerHTML = '';
  if (!res.words.length) {
    resultsHost.appendChild(el('div', { class: 'empty' }, [
      el('div', { class: 'empty-title', text: '没查到' }),
      el('div', { class: 'empty-hint', text: '换个写法试试：读音、词形（含活用形）都行。' }),
    ]));
    return;
  }

  for (const w of res.words) {
    resultsHost.appendChild(await renderHit(w));
  }
  // ⚠️ 命中多条时要**明确说"一共几条"**。
  //    用户报的 bug 就是"输入かた只出来一个方"；即使修好了返回 5 条，
  //    如果界面不说"共 5 条同音词"，用户也没法判断是不是全了
  //    —— 他无法区分"只有这一个"和"显示了但漏了"。
  if (res.words.length > 1) {
    resultsHost.appendChild(el('div', {
      class: 'dim', style: { fontSize: '.76rem', marginTop: '6px' },
      text: `共 ${res.total || res.words.length} 条（同音/同形词按等级排序，N5 在前）`,
    }));
  }
  resultsHost.appendChild(el('div', {
    class: 'dim', style: { fontSize: '.76rem', marginTop: '8px' },
    text: sourceLabel(res),
  }));
}

/** 结果来源的一句话说明（多种来源都命中时逐一说清） */
function sourceLabel(res) {
  const LABEL = {
    vocab: '你的生词本',
    library: '内置词库',
    server: '本地词典（含活用还原）',
  };
  const list = Array.isArray(res.sources) && res.sources.length
    ? res.sources
    : [res.source];
  const parts = list.filter((s) => LABEL[s]).map((s) => LABEL[s]);
  if (!parts.length) return '（未找到）';
  if (parts.length === 1) return '（来自' + parts[0] + '）';
  return '（合并自：' + parts.join(' + ') + '）';
}

async function renderHit(w) {
  const hit = el('div', { class: 'pop-hit' });
  const term = el('span', { class: 'pop-hit-term', text: w.term || '—' });
  const reading = el('span', { class: 'pop-hit-reading', text: w.reading || '' });
  hit.appendChild(el('div', { class: 'pop-hit-head' }, [
    term, reading,
    el('span', { class: 'badge ' + badgeClass(w.level), text: w.level || '?' }),
  ]));
  if (w.zh && w.zh.length) {
    hit.appendChild(el('div', { class: 'pop-hit-gloss', text: w.zh.join('；') }));
  }

  const id = wordIdOf(w);
  const inVocab = await isInVocab(id);
  const actions = el('div', { class: 'pop-hit-actions' });
  // 这里原本有一个 🔊 朗读按钮，已按用户要求去掉（不要任何语音相关内容）。
  actions.appendChild(el('button', {
    class: 'btn btn-sm ' + (inVocab ? 'btn-ghost' : 'btn-primary'),
    text: inVocab ? '✓ 已加入' : '＋ 加入生词本',
    onclick: async () => {
      if (inVocab) {
        await removeWord(id);
        toast('已从生词本移除：' + (w.term || ''), 'info');
      } else {
        const r = await addWord(w, { source: 'drawer' });
        toastOk(r.created ? `已加入生词本：${w.term}` : `已经在生词本里：${w.term}`);
      }
      // 重绘这条结果（按钮状态会变）
      const fresh = await renderHit(w);
      hit.replaceWith(fresh);
    },
  }));
  // 本地词典查不到时，AI 讲解就特别有用 —— 所以按钮在这里最顺手。
  // 但按钮只在"有人注册了 AI 能力"时才出现（见 setAiWordHook 的说明）。
  if (aiWordHook) {
    const w0 = w.term || '';
    actions.appendChild(el('button', {
      class: 'btn btn-sm btn-ghost', dataset: { act: 'ai-word' },
      text: 'AI 讲这个词',
      // ⚠️ 这个 title 必须说清"只发这一个词"。
      //    程序里真正会联网的地方有两处：点词（发这个词）和
      //    「自动翻译全部段落」（发每段正文）。这里只说前者的话，
      //    用户可能在抽屉里点完就以为"AI 只发单个词"，
      //    然后在精读页按下自动翻译 —— 那时发出去的就不止一个词了。
      //    所以这句里补上"整段正文只在你点自动翻译时才发"。
      //    test-render.mjs 的 [10] 节会按文件检查这一点。
      title: '把这个词发给你的 AI 服务，让它讲读音、词性、搭配和例句'
        + '（点词只发这一个词；整段正文只在你点「自动翻译全部段落」时才会发出去）',
      onclick: (ev) => {
        ev.stopPropagation();
        try { aiWordHook(w0, ev); } catch (e) {
          toast('AI 讲解打不开：' + ((e && e.message) || e), 'error');
        }
      },
    }));
  }
  hit.appendChild(actions);
  return hit;
}

function badgeClass(level) {
  return { N5: 'badge-n5', N4: 'badge-n4', N3: 'badge-n3', N2: 'badge-n2', N1: 'badge-n1' }[level] || '';
}

function debounce(fn, ms) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** 从背单词页打开抽屉并预填一个词 */
export function openLookupFor(word) {
  if (!root) build();
  open();
  searchInput.value = word || '';
  runQuery(word || '');
}

/**
 * 只把**右下角那个按钮**挂上去，不打开抽屉。
 *
 * ────────────────────────────────────────────────────────────────────
 * ⚠️ 为什么要单独有这么个函数（用户报的 bug）
 * ────────────────────────────────────────────────────────────────────
 * 原话：「这个查词功能只有在我点击了歌词/精读界面的某个词之后，
 *         才会在右下角生成一个快捷按钮。正常来讲应该是随时可见的才对。」
 *
 * 原因：`build()` 只被 `toggleLookup()` 和 `openLookupFor()` 调用，
 * 而这两个都是"要打开抽屉"的动作。所以**按钮和抽屉是同时出生的** ——
 * 没点过词，就永远没有那个按钮，用户也不知道有这个功能。
 * 快捷键 Ctrl+Shift+F 虽然能用，但**没人会去猜一个不存在的入口**。
 *
 * 修法：把"建 DOM"和"打开"解耦，启动时只建不打开。
 * `build()` 本身是幂等的（`root` 非空就直接返回），所以重复调用安全。
 */
export function mountLookup() {
  if (!root) build();
}
