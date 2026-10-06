/**
 * jpreader.js —— 歌词页与精读页的**共用渲染器**。
 *
 * 为什么不各写一份：
 *   歌词页和精读页有大约 70% 是同一件事 —— 把"日文句子 → 分词 → 逐字振假名 →
 *   罗马音 → 可点击的词"渲染出来。各写一份就是两份分词展示逻辑、两个地方处理未知词、
 *   两处要同步改。抽成一份之后，"未知词怎么显示""点词怎么查"这类决定只有一处。
 *   （和当初把数字读法抽成 counter.js 是同一个理由：只有一份规则，才不会自相矛盾。）
 *
 * 两页各自负责的是"数据从哪来"和"外壳功能"：
 *   歌词页：粘贴日文 + 中文对照 → /api/lyric/parse
 *   精读页：粘贴或拍照 OCR → /api/analyze（额外返回 vocab 生词候选）
 *
 * ⚠️ 本模块**不发起任何请求**、**不写任何数据**（除了显示偏好）。
 *    请求由两个视图自己做，这样才能各自控制 loading / 错误提示的措辞。
 *
 * 三条硬约束在这里的体现：
 *   - 源码明文：普通 ESM，无构建
 *   - 数据分离：只读服务端返回的分析结果；显示偏好写 settings 表（会进备份）
 *   - 数据不丢：加入生词本走 vocabdata.addWord()，它是幂等的（连点两次不会变两条）
 */
import { el, toast, toastOk, modal, debounce } from '../ui.js';
import * as db from '../db.js';
import { addWord, lookupWord, isInVocab } from '../vocabdata.js';
import { saveOverride, removeOverride, alignReading } from '../yomi.js';
import { saveSegOverride, removeSegOverride } from '../segments.js';

// ---------------------------------------------------------------------------
// 一、显示偏好（存 settings 表，跟着导出备份走）
// ---------------------------------------------------------------------------

/**
 * 为什么存 settings 而不是 localStorage：
 *   settings 表会被 exportAll() 导出、也会进快照。换电脑导入备份后，
 *   "我习惯看振假名、用黑本式罗马音"这些偏好还在。
 *   localStorage 不在这套备份体系里，换机器就丢。
 */
const PREF_KEYS = ['readerRuby', 'readerRomaji', 'readerShowZh'];

/** 读三个显示开关。缺省：振假名开、罗马音关、中文对照开 */
export async function loadPrefs() {
  const out = { ruby: true, romaji: false, showZh: true };
  try {
    const rows = await db.getSettings();
    if (rows.readerRuby !== undefined) out.ruby = !!rows.readerRuby;
    if (rows.readerRomaji !== undefined) out.romaji = !!rows.readerRomaji;
    if (rows.readerShowZh !== undefined) out.showZh = !!rows.readerShowZh;
  } catch { /* 读不到就用默认值，不能因为偏好读不到就不给用 */ }
  return out;
}

export async function savePref(key, value) {
  if (!PREF_KEYS.includes(key)) return;
  try { await db.setSetting(key, value); } catch { /* 偏好存不上不影响主流程 */ }
}

// ---------------------------------------------------------------------------
// 二、句子渲染（核心）
// ---------------------------------------------------------------------------

/**
 * 把一行日文的 tokens 渲染成可交互的行内 DOM。
 *
 * @param {Array} tokens buildReading() / decorate() 产出的 token 数组
 *                 每个 token: { surface, known, reading, romaji, ruby?, rubyEstimated?,
 *                               id?, level?, zh?, pos?, isSpace?, isPunct?, override? }
 * @param {{ ruby?:boolean, romaji?:boolean, onWord?:(token, ev)=>void,
 *           onEditReading?:(token, chip)=>void, onLongPress?:(token, ev)=>void }} opts
 *        onEditReading 有值时才允许改读音（歌词页/精读页会传，语法页不传）
 *        为什么默认不给改：语法正文里的例句是**教材内容**，读音由服务端保证，
 *        不该让用户在读语法时改到全局读音表里去。
 * @returns {HTMLElement} 一个 <span class="jpr-line">
 */
/**
 * 渲染一行词。
 *
 * @param {Array} tokens 分词结果
 * @param {{ ruby?:boolean, romaji?:boolean, onWord?:Function, onEditReading?:Function,
 *           onLongPress?:Function, ctx?:object }} opts
 *        ctx 会**原样并进** onEditReading 的第二个参数里，
 *        用来把"这一行的原始分词"传进对话框 —— 改分词需要左右相邻的词
 *        （合并前一个 / 合并后一个），只给一个孤立的 token 做不到。
 *        参见 jpreader.openReadingEditor 与 openSegmentEditor。
 */
export function renderTokens(tokens, opts = {}) {
  const { ruby = true, romaji = false, onWord = null, onEditReading = null, onLongPress = null, ctx = null } = opts;
  const line = el('span', { class: 'jpr-line' });

  for (let ti = 0; ti < (tokens || []).length; ti++) {
    const t = tokens[ti];
    // 空白：分词把换行/空格保留成 isSpace 的 token。
    // 这里换成一个可视的间隔，否则整段会挤成一坨、看不出原来的断句。
    if (t.isSpace) {
      line.appendChild(el('span', { class: 'jpr-space', text: ' ' }));
      continue;
    }
    // 标点：不可点（点它没有意义），但保留以便标点规则正确显示
    if (t.isPunct) {
      line.appendChild(el('span', { class: 'jpr-punct', text: t.surface }));
      continue;
    }

    const chip = el('span', {
      class: 'jpr-w'
        + (t.known ? '' : ' is-unknown')
        + (t.rubyEstimated ? ' is-estimated' : '')
        + (t.override ? ' is-overridden' : ''),
      dataset: { term: t.surface, reading: t.reading || '', level: t.level || '' },
      title: t.override ? '读音是你自己定的（点开可改回）' : null,
    });

    // 主体：有振假名就上 <ruby>，否则直接写表面形
    if (ruby && t.ruby && t.ruby.length) {
      const rb = el('ruby', { class: 'jpr-ruby' });
      for (const part of t.ruby) {
        rb.appendChild(el('span', { text: part.t }));
        // r 为空表示这段没有读音（如送假名），不生成 rt，避免出现空白注音
        if (part.r) rb.appendChild(el('rt', { text: part.r }));
      }
      chip.appendChild(rb);
    } else {
      chip.appendChild(el('span', { text: t.surface }));
    }

    // 罗马音挂在词下面（整行罗马音拼起来看很累，逐词看更有用）
    if (romaji && t.romaji) {
      chip.appendChild(el('span', { class: 'jpr-romaji', text: t.romaji }));
    }

    // 改读音入口：只有调用方明确允许时才挂。
    //
    // ⚠️ 用"双击 / 长按 / 右键"三条路，而不是每个词都挂一个可见小按钮：
    //    页面上每行十来个词，加十来个按钮会毁掉阅读 —— 而这是低频操作。
    //
    // ⚠️ 关于"触发不稳定"（用户 2026-10 反馈的原话：
    //    「注音太小了很容易点歪，单击到单词上就会变成查意思，触发非常不稳定」）：
    //    他以为要点**注音那几个小字**。其实监听挂在**整个词**（chip）上，
    //    所以点词里任何位置都行，不需要点准。
    //    但"误解"本身也是设计问题 —— 所以我做了三件事：
    //      ① 在阅读器工具条下面加一行小字，写清"双击任意一个词，不用点准"
    //         （见 airead.js 的 air-edit-hint）；
    //      ② 把**右键**也接上（contextmenu）：右键不会触发单击查词，
    //         所以它是最"稳"的一条路 —— 手抖也不会误触；
    //      ③ 误触了也不怕：查词抽屉打开后按 Esc 就关，没有副作用。
    //
    // ⚠️⚠️ 而单击和双击的**冲突**是后来才发现的一个真 bug（用户第二轮反馈）：
    //    双击会先派发两次 click、再派发 dblclick，于是
    //      click → 查词 open；click → 查词 close；dblclick → 改读音
    //    用户看到的就是"双击只把查词开了又关，改注音根本没出来"。
    //    所以有 onEditReading 的页面上，**单击必须延迟投递**，
    //    并且一旦 dblclick 来了就把那次单击取消掉 ——
    //    见上面 `bindClickLookup` 与 `CLICK_DELAY` 的长注释。
    if (onEditReading) {
      chip.style.cursor = 'pointer';
      // 把"这个词在这一行里的位置 + 这一行的分词"一起交出去：
      // 改分词要在**相邻词**上操作（合并前一个 / 合并后一个），
      // 只给一个孤立的 token 是做不到的（见下面的 openSegmentEditor）。
      const pass = Object.assign({}, ctx || {}, { rawTokens: tokens, index: ti });
      const edit = (ev) => {
        if (ev) { ev.preventDefault(); ev.stopPropagation(); }
        // ★ 关键：双击意味着"我不要查词"，把待定的那次单击撤掉
        cancelPendingClick();
        onEditReading(t, chip, pass);
      };
      chip.addEventListener('dblclick', edit);
      // 右键：最稳的一条。preventDefault 挡掉浏览器自带菜单，
      // 而且右键本来就**不会**派发 click，和单击查词毫无冲突，不用延迟。
      chip.addEventListener('contextmenu', edit);
      if (onLongPress) {
        let timer = null;
        let fired = false;
        const start = (ev) => {
          if (ev.button !== undefined && ev.button !== 0) return;
          fired = false;
          clearTimeout(timer);
          timer = setTimeout(() => {
            timer = null;
            fired = true;
            // 长按成功给一点点触感反馈（支持的设备上），
            // 让用户确信"我按住了"而不是"我点歪了"
            try { if (navigator.vibrate) navigator.vibrate(12); } catch { /* 不支持就算了 */ }
            // 长按也是"改读音"，同样要撤掉待定的单击查词
            cancelPendingClick();
            onEditReading(t, chip, pass);
          }, 550);
        };
        const cancel = () => { clearTimeout(timer); timer = null; };
        chip.addEventListener('touchstart', start, { passive: true });
        chip.addEventListener('touchend', (ev) => {
          // 长按已经触发过了，就不要再让它变成一次"单击查词"
          if (fired) { ev.preventDefault(); ev.stopPropagation(); }
          cancel();
        });
        chip.addEventListener('touchmove', cancel);
        chip.addEventListener('touchcancel', cancel);
      }
      // ★ 单击查词：延迟投递（给 dblclick 一个"反悔"的机会）
      if (onWord) bindClickLookup(chip, t, onWord);
    } else if (onWord) {
      // 没有改读音入口的页面（例如语法页）不存在冲突，**不延迟**，保持手感
      chip.addEventListener('click', (ev) => onWord(t, ev));
    }

    line.appendChild(chip);
  }
  return line;
}

/**
 * 单击"查词"的**延迟投递**状态（模块级：一个页面同一时刻只可能有一次待定单击）。
 *
 * ⚠️⚠️ 为什么需要这个（用户 2026-10 报的真 bug）
 * ────────────────────────────────────────────────────────────────────
 *   用户原话：「你现在把改注音功能变成了双击触发，但是双击的时候
 *              只会打开再关闭查词界面，无法改注音。」
 *
 *   原因是一条很基础的浏览器行为：
 *     **双击会先派发两次 `click`，然后才派发 `dblclick`。**
 *   于是点两下会发生这件事：
 *       第 1 次 click → onWord → 查词抽屉 open()
 *       第 2 次 click → onWord → 查词抽屉 close()   ← 用户看到的"又关上了"
 *       dblclick      → 改读音对话框
 *   而那个对话框是 `modal()`，它和抽屉的层级/焦点互相打架，
 *   最后表现出来的就是"只打开又关闭了查词界面，改注音没出来"。
 *
 *   修法：**把单击延迟一小段再投递**；如果在延迟窗口内来了 `dblclick`，
 *   就把这次单击取消掉。
 *     · 单击 → 等 250ms → 没有第二次点击 → 投递查词（有 250ms 延迟，
 *              但查词是"看一眼"的操作，这点延迟感知不到）
 *     · 双击 → 第一次的待定单击被取消 → 只改读音，抽屉根本不会开
 *
 *   为什么阈值是 250ms：
 *     太短（比如 100ms）→ 手慢一点的双击会被判成"两次单击"，bug 复现；
 *     太长（比如 500ms）→ 单击查词明显发木。
 *     250ms 接近系统默认的双击间隔，是这两者之间的常用折中。
 *     ⚠️ 系统双击间隔是可以调的（辅助功能），所以这个值是**启发式**，
 *        不是精确解 —— 但即使判错，用户也只是"多点一次"，不会丢数据。
 */
const CLICK_DELAY = 250;

let pendingClick = null;      // { timer, ev, token }
let pendingOwner = null;      // 这份待定单击是哪个 chip 上的

function cancelPendingClick() {
  if (pendingClick) { clearTimeout(pendingClick.timer); pendingClick = null; }
  pendingOwner = null;
}

/**
 * 绑一个"延迟的单击查词"。
 *
 * ⚠️ 待定状态是**跨 chip** 的：在同一个词上点两下会取消掉第一次 ——
 *    这正是我们要的（双击）。但如果第二次点的是**别的词**，
 *    也会把上一个词的待定单击取消掉 —— 那正是浏览器的正常语义
 *    （快速点 A 再点 B 只应该打开 B），所以不用额外区分。
 */
function bindClickLookup(chip, token, onWord) {
  chip.addEventListener('click', (ev) => {
    // 换了一个词：上一次的待定单击作废
    if (pendingOwner && pendingOwner !== chip) cancelPendingClick();
    pendingOwner = chip;
    if (pendingClick) clearTimeout(pendingClick.timer);
    const timer = setTimeout(() => {
      pendingClick = null;
      pendingOwner = null;
      onWord(token, ev);
    }, CLICK_DELAY);
    pendingClick = { timer, ev, token };
  });
}

/**
 * 把一个词 chip 按当前 token 重新画一遍（读音改过之后用它就地刷新）。
 *
 * 为什么不整页重渲染：
 *   用户改的是一个词，整页重渲染会把他**滚动的位置和阅读的上下文弄丢**。
 *   而且歌词页/精读页的 token 数组比这一个词大得多，没必要全部重画。
 *
 * ⚠️ 只替换 chip 的**内容**，不替换 chip 本身 —— 事件监听挂在 chip 上，
 *    换掉节点等于把监听丢了（改一次读音之后就不能再改第二次）。
 *
 * @param {HTMLElement} chip 原来的 .jpr-w 节点
 * @param {object} token 更新后的 token
 * @param {{ruby?:boolean, romaji?:boolean}} opts
 */
export function repaintChip(chip, token, opts = {}) {
  const { ruby = true, romaji = false } = opts;
  if (!chip || !token) return;
  while (chip.firstChild) chip.removeChild(chip.firstChild);

  chip.className = 'jpr-w'
    + (token.known ? '' : ' is-unknown')
    + (token.rubyEstimated ? ' is-estimated' : '')
    + (token.override ? ' is-overridden' : '');
  chip.dataset.reading = token.reading || '';

  if (ruby && token.ruby && token.ruby.length) {
    const rb = el('ruby', { class: 'jpr-ruby' });
    for (const part of token.ruby) {
      rb.appendChild(el('span', { text: part.t }));
      if (part.r) rb.appendChild(el('rt', { text: part.r }));
    }
    chip.appendChild(rb);
  } else {
    chip.appendChild(el('span', { text: token.surface }));
  }
  if (romaji && token.romaji) {
    chip.appendChild(el('span', { class: 'jpr-romaji', text: token.romaji }));
  }
}

/**
 * 渲染一行"日文 + 可选中文"。
 * @param {{ ja:string, zh?:string, reading?:object }} line
 * @param {object} opts { ruby, romaji, showZh, onWord, index, onEditReading, onLongPress }
 */
export function renderSentence(line, opts = {}) {
  const { ruby = true, romaji = false, showZh = true, onWord = null, index = null,
    onEditReading = null, onLongPress = null, ctx = null } = opts;
  const tokens = (line.reading && line.reading.tokens) || [];
  const row = el('div', { class: 'jpr-sent' });

  if (index !== null) {
    row.appendChild(el('span', { class: 'jpr-idx', text: String(index) }));
  }

  const body = el('div', { class: 'jpr-body' });
  body.appendChild(renderTokens(tokens, { ruby, romaji, onWord, onEditReading, onLongPress, ctx }));

  // 覆盖率低的行明确标出来 —— 词库查不到的片段多，说明这行的注音不可靠
  const cov = line.reading && line.reading.coverage;
  if (typeof cov === 'number' && cov < 100) {
    const unk = (line.reading.unknownSurfaces || []);
    body.appendChild(el('div', { class: 'jpr-warn' }, [
      el('span', { text: `注音覆盖 ${cov}%` }),
      unk.length ? el('span', { class: 'jpr-warn-list', text: '　查不到：' + unk.join('、') }) : null,
    ].filter(Boolean)));
  }

  if (showZh && line.zh) {
    body.appendChild(el('div', { class: 'jpr-zh', text: line.zh }));
  }
  row.appendChild(body);
  return row;
}

// ---------------------------------------------------------------------------
// 三、点词 → 速查抽屉
// ---------------------------------------------------------------------------

/**
 * 点词的默认行为：打开全局速查抽屉。
 *
 * 为什么复用抽屉而不是自己弹一个小框：
 *   抽屉已经有完整的"生词本 → 内置词库缓存 → 服务端查词（带活用还原）"三级回退，
 *   而且每条结果都能一键加入生词本。自己再做一个只会多一套要维护的逻辑。
 *
 * ⚠️ 用 dynamic import：drawer.js 会建 DOM 和挂全局快捷键，
 *    纯阅读不点词的用户不该为它付出启动成本。
 *
 * ⚠️⚠️ 路径必须是 `../drawer.js`，不是 `./drawer.js`。
 *    drawer.js 在 `app/js/` 下；而**这个文件在 `app/js/views/` 下**，
 *    所以相对路径要多退一层。写成 `./` 会去要 `app/js/views/drawer.js`，
 *    那个文件不存在 —— 而错误只会在**用户真的去点一个单词时**才炸出来：
 *        「速查抽屉打不开：Failed to fetch dynamically imported module: …/js/views/drawer.js」
 *    这个 bug 之前没被任何测试抓到，因为：
 *      · 静态检查只看了"有没有 import"，没验证**解析后的路径存不存在**
 *      · test-render 是直接 `import('../app/js/drawer.js')` 按真实路径加载的，
 *        根本没走 jpreader 里那条动态导入
 *    现在 `test-contract.mjs` 里加了一条断言：**把相对导入解析成绝对路径，
 *    再确认文件真的存在**（见那条"相对导入必须指向真实文件"）。
 */
export async function openWord(token) {
  const q = token && (token.surface || token.term);
  if (!q) return;
  try {
    const m = await import('../drawer.js');
    m.openLookupFor(q);
  } catch (e) {
    toast('速查抽屉打不开：' + ((e && e.message) || e), 'error');
  }
}

// ---------------------------------------------------------------------------
// 三之二、改读音（用户报的问题 2）
// ---------------------------------------------------------------------------

/**
 * 打开"改这个词的读音"对话框。
 *
 * 为什么必须让用户改（用户原话）：
 *   「歌词在识别之后标注汉字读音时，有的多音汉字表音并不是歌里唱的那个读法，
 *     需要添加一个允许我修改的功能。这点在精读模块应该也适用。」
 *
 * 这是**程序原理上做不到的事**：汉字多音（今日=きょう/こんにち、日=ひ/にち/か），
 * 词库统计只能给"最可能的读音"，而歌里唱的是哪一个只有听的人知道。
 * 所以这里把决定权交给用户，并且**当场让他看到改完的样子**。
 *
 * 三条交互决定：
 *   ① **实时预览**：输入框一变就请求对齐并显示"会变成什么样"。
 *      改读音是"试出来"的过程，看不到结果就得反复保存-撤销，很难用。
 *   ② **保存前先算**：算不出来（填了罗马音/填错）就不写库，
 *      否则库里会留一条用不了的记录 —— 数据状态和用户看到的不一致。
 *   ③ **能改回来**：本来有手改记录的，多一个"恢复程序读音"按钮。
 *
 * @param {object} token 被改的词
 * @param {HTMLElement} chip 它在页面上的节点（改完就地重画）
 * @param {{ ruby?:boolean, romaji?:boolean, overrides?:Map<string,string> }} ctx
 *        overrides 是本页的内存副本，改完要同步更新它，否则下次渲染又变回去
 */
export function openReadingEditor(token, chip, ctx = {}) {
  if (!token || !token.surface) return;
  const surface = token.surface;
  // ⚠️ 表里存的是**记录对象**（{surface, reading, ruby, romaji, estimated, at}），
  //    不是字符串。这里取 .reading 才是读音。
  const rec = ctx.overrides ? ctx.overrides.get(surface) : null;
  const currentAuto = rec ? (typeof rec === 'string' ? rec : rec.reading) : '';
  const start = currentAuto || token.reading || '';

  const input = el('input', {
    class: 'input',
    type: 'text',
    value: start,
    placeholder: '用平假名或片假名填，例如 こんにち',
    spellcheck: 'false',
    autocomplete: 'off',
  });
  const preview = el('div', { class: 'yomi-preview' });
  const hint = el('div', { class: 'yomi-hint' });

  hint.appendChild(el('div', { text: `词形：${surface}` }));
  if (!token.known) {
    hint.appendChild(el('div', { class: 'yomi-warn', text: '这个词不在词库里，程序本来就猜不出读音 —— 你填的就是唯一依据。' }));
  } else {
    hint.appendChild(el('div', { text: `程序给的读音：${token.reading || '（无）'}${token.rubyEstimated ? '（推算的，不一定对）' : ''}` }));
  }
  hint.appendChild(el('div', { class: 'yomi-note', text: '改过的读音按「词」记住，全站生效（这首歌里再出现、别的文章里出现，都用这个读音）。会进备份。' }));

  const body = el('div', { class: 'yomi-form' }, [
    el('label', { class: 'yomi-label', text: '读音（假名）' }),
    input,
    preview,
    hint,
  ]);

  /** 输入一变就预览：把服务端算出来的振假名和罗马音画出来 */
  let seq = 0;
  async function refreshPreview() {
    const r = input.value.trim();
    const my = ++seq;
    preview.textContent = '';
    if (!r) return;
    try {
      const out = await alignReading(surface, r);
      if (my !== seq) return;              // 有更新的输入了，丢弃这次结果
      preview.appendChild(el('div', { class: 'yomi-preview-label', text: '会显示成：' }));
      const line = el('span', { class: 'jpr-line' });
      const chip2 = el('span', { class: 'jpr-w' });
      const rb = el('ruby', { class: 'jpr-ruby' });
      for (const part of out.ruby || []) {
        rb.appendChild(el('span', { text: part.t }));
        if (part.r) rb.appendChild(el('rt', { text: part.r }));
      }
      chip2.appendChild(rb);
      if (out.romaji) chip2.appendChild(el('span', { class: 'jpr-romaji', text: out.romaji }));
      line.appendChild(chip2);
      preview.appendChild(line);
      if (out.estimated) {
        preview.appendChild(el('div', { class: 'yomi-warn', text: '提示：这个读音和词形对不齐（假名数量不匹配），会整词标一个音。检查一下是不是漏字或多了字。' }));
      }
    } catch (e) {
      if (my !== seq) return;
      preview.textContent = '';
      preview.appendChild(el('div', { class: 'yomi-warn', text: '算不出来：' + ((e && e.message) || e) }));
    }
  }
  input.addEventListener('input', debounce(refreshPreview, 220));
  setTimeout(refreshPreview, 60);

  const buttons = [
    { label: '取消', class: 'btn-ghost' },
    {
      label: '保存读音',
      class: 'btn-primary',
      onClick: async ({ close }) => {
        const r = input.value.trim();
        if (!r) { toast('读音不能为空', 'warn'); return false; }
        try {
          const out = await saveOverride(surface, r);
          token.reading = r;
          token.ruby = out.ruby;
          token.rubyEstimated = !!out.estimated;
          token.romaji = out.romaji;
          token.override = true;
          // 内存副本要一起更新成**完整记录**，否则同一个词再改一次时
          // 读到的还是旧记录（含旧 ruby），界面会回退到上一次的样子。
          if (ctx.overrides) {
            ctx.overrides.set(surface, {
              surface, reading: r, ruby: out.ruby || [], romaji: out.romaji || '',
              estimated: !!out.estimated, at: Date.now(),
            });
          }
          if (chip) repaintChip(chip, token, { ruby: ctx.ruby !== false, romaji: !!ctx.romaji });
          toastOk(`「${surface}」的读音已改为 ${r}（全站生效）`);
          return true;
        } catch (e) {
          toast('保存失败：' + ((e && e.message) || e), 'error');
          return false;
        }
      },
    },
  ];
  if (currentAuto) {
    buttons.unshift({
      label: '恢复程序读音',
      class: 'btn-ghost',
      onClick: async ({ close }) => {
        await removeOverride(surface);
        if (ctx.overrides) ctx.overrides.delete(surface);
        toast('已删除手改读音，请刷新这一页看程序读音', 'info');
        if (ctx.onRemoved) ctx.onRemoved(surface);
        close();
      },
    });
  }

  // ★ 「改分词」入口。
  //
  // 为什么不干脆把两件事合在一个对话框里：
  //   它们回答的是**两个不同的问题** ——
  //     · 改读音：「这个词怎么念？」（词还是同一个词）
  //     · 改分词：「这里该不该算一个词？」（词本身就变了）
  //   合在一起做出来的界面会是"一段可以改字的输入框"，用户分不清
  //   "我把字改了"和"我把切法改了"，出错时也查不清是哪一边的问题。
  //   所以这里**只放一个入口**，点开是另一个对话框，各管各的。
  //
  // 为什么需要 ctx.rawTokens：合并/拆分是**在相邻词之间**做的操作
  //   （把这个词和前一个并起来、在这个词中间切开），
  //   只知道"当前这一个 token"是不够的。见 renderTokens 里 pass 的构造。
  const canSegment = !!(ctx.rawTokens && typeof ctx.index === 'number' && ctx.index >= 0);
  if (canSegment) {
    buttons.unshift({
      label: '改分词',
      class: 'btn-ghost',
      onClick: ({ close }) => {
        close();
        // 关掉读音框再开分词框 —— 两层模态叠在一起，用户按 Esc 会不知道关掉了哪一层
        setTimeout(() => openSegmentEditor(ctx.rawTokens, ctx.index, ctx), 0);
      },
    });
  }

  return modal({
    title: '改这个词的读音',
    body,
    buttons,
    width: '560px',
  });
}

// ---------------------------------------------------------------------------
// 三之二、改分词（合并 / 拆分）
// ---------------------------------------------------------------------------

/**
 * 改分词对话框：把一个词和它前面的词**合并**，或者把它**拆开**。
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么是这个形状
 * ────────────────────────────────────────────────────────────────────
 * 用户能做的操作只有两种，而且是**局部**的：
 *   ① 合并：把这个词和前一个词并成一个（「この」+「人」→「この人」）
 *   ② 拆分：把这个词从某个字后面切开（「この人」→「この」+「人」）
 * 所以界面上不需要"自由编辑一串字"，只需要：
 *   · 显示当前切法（几个方块）
 *   · 每个方块之间一个"合起来"的按钮
 *   · 每个方块内部一个"在这里切开"的按钮
 * 这样用户**只能做出合法结果**（各段拼起来一定等于原文），
 * 不会出现"手打错一个字 → 存不下来 / 存下来匹配不上"的情况。
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么按"原文"记，不按位置记
 * ────────────────────────────────────────────────────────────────────
 * 和改读音同一个道理：切法是**文本本身**的事实。改一次，
 * 这两个字在所有地方出现时都按新切法显示 —— 也更容易在备份里看懂。
 * 代价是：同一串字在别处若需要另一种切法，这个模型表达不了（刻意接受）。
 *
 * @param {Array} rawTokens 这一行**原始**的分词结果（不是套用之后的）
 * @param {number} startIdx 用户在页面上点的那个词的下标
 * @param {{ overrides?:Map, ruby?:boolean, romaji?:boolean, onSaved?:Function }} ctx
 */
export function openSegmentEditor(rawTokens, startIdx, ctx = {}) {
  const list = Array.isArray(rawTokens) ? rawTokens : [];
  const t0 = list[startIdx];
  if (!t0 || !t0.surface) return;

  // 词在列表里的下标（跳过空白/标点）—— 合并只能在词与词之间做
  const wordPositions = [];
  for (let k = 0; k < list.length; k++) {
    if (list[k] && !list[k].isSpace && !list[k].isPunct && list[k].surface) wordPositions.push(k);
  }
  const pos = wordPositions.indexOf(startIdx);
  if (pos < 0) { toast('这个词不能改分词', 'warn'); return; }

  // 这一段当前的分段：默认就是"这一个词"。
  // 用户每点一次"合并前一个"，就把范围往前扩一个词。
  let lo = pos;                       // 覆盖的词范围（wordPositions 里的下标）
  let hi = pos;
  let cuts = [list[startIdx].surface];   // 当前切法（各段文字）
  let readings = [t0.reading || ''];     // 各段的读音（可编辑）

  /** 按当前 lo..hi 重算"原文"和"默认切法" */
  function spanInfo() {
    const segs = [];
    for (let w = lo; w <= hi; w++) {
      const tk = list[wordPositions[w]];
      segs.push(tk.surface);
    }
    return { text: segs.join(''), auto: segs };
  }

  const host = el('div', { class: 'seg-form' });
  const hint = el('div', { class: 'seg-hint' });

  function render() {
    try {
      host.textContent = '';
      const { text, auto } = spanInfo();
      readings = cuts.map((_, i) => readings[i] || '');
      buildBody(text, auto);
    } catch (e) {
      // ⚠️ 这个 try/catch 是**特意留着**的，不是为了吞异常：
      //    重画发生在按钮的 onclick 里，抛出去就只剩浏览器控制台里一行字，
      //    而页面上的表现是"点了没反应"——最难查的那一类。
      //    把异常**写进界面**（用户和自检都看得见），同时重新抛出去让上层知道。
      host.textContent = '';
      host.appendChild(el('div', { class: 'seg-warn',
        text: '分词界面重画失败：' + ((e && e.message) || e) }));
      throw e;
    }
  }

  function buildBody(text, auto) {

    // ---- 合并 / 拆分 按钮 ----
    //
    // ⚠️ 措辞很讲究，别退回上一版：
    //    「和前面的 X 合并」容易让人以为"点一下就并成一个词了"。
    //    实际上它只是**把 X 也拉进这次编辑的范围**（盒子会多一个），
    //    真正合并两个盒子的是盒子之间那个「合」按钮。
    //    所以这里用「包括」，把"合并"这个词留给真正合并的那个按钮 ——
    //    自检里就是被这两个词撞在一起，白查了一轮。
    const tools = el('div', { class: 'seg-tools' });
    if (lo > 0) {
      tools.appendChild(el('button', {
        class: 'btn btn-ghost seg-tool',
        type: 'button',
        title: '把这个词前面的词也拉进来一起改',
        text: `← 包括前面的「${list[wordPositions[lo - 1]].surface}」`,
        onclick: () => { lo--; cuts = spanInfo().auto; readings = cuts.map(() => ''); syncReadingOfSpan(); render(); },
      }));
    }
    if (hi < wordPositions.length - 1) {
      tools.appendChild(el('button', {
        class: 'btn btn-ghost seg-tool',
        type: 'button',
        title: '把这个词后面的词也拉进来一起改',
        text: `包括后面的「${list[wordPositions[hi + 1]].surface}」→`,
        onclick: () => { hi++; cuts = spanInfo().auto; readings = cuts.map(() => ''); syncReadingOfSpan(); render(); },
      }));
    }
    host.appendChild(tools);

    // ---- 当前切法：方块 + 方块之间的"切开" ----
    const strip = el('div', { class: 'seg-strip' });
    cuts.forEach((part, i) => {
      if (i > 0) {
        strip.appendChild(el('button', {
          class: 'seg-cut',
          type: 'button',
          // ⚠️ 文案就是语义，别写含糊。「合并」这个词只能出现在
          //    **真的把两个方块并成一个**的按钮上；上面那两个
          //    「和前面的 X 合并」其实只是"把 X 也拉进这次编辑的范围"，
          //    盒子并不会并起来 —— 现在改叫"包括"，名副其实。
          //    （自检里就因为这两个词撞在一起而白查了一轮。）
          title: '把这两个盒子并成一个词',
          text: '合',
          onclick: () => {
            // 把第 i-1 和第 i 个盒子并成一个 —— 这才是"合并"
            cuts.splice(i - 1, 2, String(cuts[i - 1]) + String(cuts[i]));
            readings.splice(i - 1, 2, '', '');
            render();
          },
        }));
      }
      const chip = el('div', { class: 'seg-chip' });
      chip.appendChild(el('div', { class: 'seg-chip-text', text: part }));
      chip.appendChild(el('div', { class: 'seg-chip-reading', text: readings[i] || '读音待定' }));
      strip.appendChild(chip);

      // 段内还能再切：给出"在这个字后面切开"的位置
      if (part.length > 1) {
        const inner = el('div', { class: 'seg-inner' });
        for (let c = 1; c < part.length; c++) {
          inner.appendChild(el('button', {
            class: 'seg-inner-btn',
            type: 'button',
            title: '从这里切开',
            text: part.slice(0, c) + '切' + part.slice(c),
            onclick: () => {
              cuts.splice(i, 1, part.slice(0, c), part.slice(c));
              readings.splice(i, 1, '', '');
              render();
            },
          }));
        }
        chip.appendChild(inner);
      }
    });
    host.appendChild(strip);

    // ---- 各段读音（可留空 = 程序不猜，等你填）----
    const rt = el('div', { class: 'seg-readings' });
    rt.appendChild(el('div', { class: 'seg-readings-title', text: '各段读音（可留空）' }));
    cuts.forEach((part, i) => {
      rt.appendChild(el('div', { class: 'seg-reading-row' }, [
        el('span', { class: 'seg-reading-word', text: part }),
        el('input', {
          class: 'input seg-reading-input',
          type: 'text',
          value: readings[i] || '',
          placeholder: '假名，可不填',
          spellcheck: 'false',
          autocomplete: 'off',
          oninput: (ev) => { readings[i] = ev.target.value; },
        }),
      ]));
    });
    host.appendChild(rt);

    hint.textContent = '';
    hint.appendChild(el('div', { text: `原文：${text}` }));
    hint.appendChild(el('div', { class: 'seg-note',
      text: '切法按「原文」记住，全站生效（这两个字在别处出现也按这个切法）。会进备份。' }));
    hint.appendChild(el('div', { class: 'seg-note',
      text: '盒子之间那个「合」＝把两个盒子并成一个词；盒子里的「切」＝在这里切开。'
        + '外面那两个「包括…」只是把旁边的词拉进来一起改，不会并起来。' }));
    if (auto.length === 1) {
      hint.appendChild(el('div', { class: 'seg-warn',
        text: '现在和程序原来的切法一样 —— 先用「切」切开，或者用「包括…」把旁边的词拉进来。' }));
    }
    if (readings.some((r) => !r)) {
      hint.appendChild(el('div', { class: 'seg-warn',
        text: '有段没填读音：程序不会去猜（猜错比不猜更糟），这几段会按"查不到的词"显示。之后可以用"改读音"单独补。' }));
    }

    // ---- 已有手改记录时，给一个恢复入口 ----
    if (ctx.segOverrides && ctx.segOverrides.get(text)) {
      host.appendChild(el('div', { class: 'seg-existing' }, [
        el('span', { text: '这一串原文已经有一条手改切法。' }),
      ]));
    }
  }

  /** 合并范围变化后，把各段读音尽量沿用原来的值 */
  function syncReadingOfSpan() {
    // 简单策略：能对上的沿用，对不上的清空（宁可让用户重填，也不要塞一个错的）
    readings = cuts.map((part) => {
      const hit = list.slice(0, list.length).find((x) => x && x.surface === part);
      return hit && hit.reading ? hit.reading : '';
    });
  }

  // 先把界面画一遍。第一遍就失败也要让用户看见原因，
  // 而不是打开一个空白框（见 render() 里的说明）。
  try { render(); } catch { /* render() 已经把原因写进界面了 */ }

  const buttons = [
    { label: '取消', class: 'btn-ghost' },
  ];
  // 有手改记录时提供"恢复程序切法"
  {
    const { text } = spanInfo();
    if (ctx.segOverrides && ctx.segOverrides.get(text)) {
      buttons.push({
        label: '恢复程序切法',
        class: 'btn-ghost',
        onClick: async ({ close }) => {
          await removeSegOverride(text);
          ctx.segOverrides.delete(text);
          // ⚠️ 这里也要走 onSaved()，不能只 toast 一句"请刷新这一页"。
          //    恢复和保存是**同一个动作的两个方向**，用户预期是同一种反馈：
          //    点完就该看到页面变回去。只给提示 = 让用户自己刷新 = 他会以为没成功。
          toast('已恢复成程序切法');
          if (ctx.onSaved) ctx.onSaved();
          close();
        },
      });
    }
  }
  buttons.push({
    label: '保存切法',
    class: 'btn-primary',
    onClick: async ({ close }) => {
      const { text, auto } = spanInfo();
      // 拼起来必须还是原文 —— 界面上的操作天然保证这一点，
      // 但存库前的校验不能省（坏数据是"存了但永远不生效"，最难查）
      if (cuts.join('') !== text) {
        toast(`各段拼起来必须还是原文（现在是「${cuts.join('')}」）`, 'error');
        return false;
      }
      if (auto.length === cuts.length && auto.every((x, i) => x === cuts[i])) {
        toast('切法和现在一样，先用上面的按钮改一下', 'warn');
        return false;
      }
      try {
        await saveSegOverride(text, cuts.map((t, i) => ({ t, r: readings[i] || '' })), auto);
        if (ctx.segOverrides) {
          ctx.segOverrides.set(text, {
            surface: text, auto: auto.slice(),
            segments: cuts.map((t, i) => ({ t, r: readings[i] || '' })),
            at: Date.now(),
          });
        }
        toastOk(`「${text}」的切法已改为 ${cuts.join(' + ')}（全站生效）`);
        if (ctx.onSaved) ctx.onSaved();
        return true;
      } catch (e) {
        toast('保存失败：' + ((e && e.message) || e), 'error');
        return false;
      }
    },
  });

  return modal({
    title: '改分词（合并 / 拆分）',
    body: el('div', {}, [host, hint]),
    buttons,
    width: '620px',
  });
}

// ---------------------------------------------------------------------------
// 四、一键加入生词本（单条 / 批量）
// ---------------------------------------------------------------------------

/**
 * 把一条 token 加入生词本。
 *
 * 幂等性交给 vocabdata.addWord()：同一个词重复加入不会变成两条。
 * 所以这里不需要预先查重 —— 查重和写入之间会有竞态，交给下层更安全。
 *
 * @returns {{added:boolean, word?:object, reason?:string}}
 */
export async function addTokenToVocab(token, opts = {}) {
  const term = token && (token.surface || token.term);
  if (!term) return { added: false, reason: '没有词形' };
  // 纯假名且词库未命中的片段：加进去也没有释义，意义不大，但仍允许用户主动加
  if (!token.known && !opts.force) {
    // 未知片段照样允许加 —— 用户可能就是想记这个词。
    // 只是它没有 id / 等级 / 释义，标注出来让用户知道。
  }
  try {
    // 服务端查词（能处理活用形），拿到词条信息再入库
    let src = token;
    if (!src.id || !src.zh || !src.zh.length) {
      const r = await lookupWord(term);
      if (r.words && r.words.length) src = { ...r.words[0], surface: term };
    }
    const res = await addWord({
      term: src.term || term,
      reading: src.reading || token.reading || '',
      forms: src.forms || [],
      kanas: src.kanas || [],
      level: src.level || token.level || '',
      zh: src.zh || [],
      pos: src.pos || [],
    }, {
      source: opts.source || 'manual',
      sourceRef: opts.sourceRef || null,
      withCard: true,
    });
    return { added: true, word: res.word, created: res.created };
  } catch (e) {
    return { added: false, reason: String((e && e.message) || e) };
  }
}

/**
 * 批量加入。按等级筛选，并**跳过已在生词本里的词**。
 *
 * @param {Array<{term,reading,level,zh,pos,count?}>} words 生词候选
 * @param {object} opts { minLevel:'N2', source, sourceRef, onProgress }
 *        minLevel：'N2' 表示只加 N2 及更难的（N1、N2，以及无等级的）
 * @returns {{added:number, skipped:number, failed:number, titles:string[]}}
 */
export async function addManyToVocab(words, opts = {}) {
  const { minLevel = '', source = 'manual', sourceRef = null, onProgress = null } = opts;
  const allowed = levelFilter(minLevel);

  // 去重（同一篇里同一个词会重复出现）
  const seen = new Set();
  const picked = [];
  for (const w of words || []) {
    const term = w.term || w.surface;
    if (!term || seen.has(term)) continue;
    seen.add(term);
    if (allowed && !allowed(w.level)) continue;
    picked.push({ ...w, term });
  }

  let added = 0; let skipped = 0; let failed = 0;
  const titles = [];
  for (let i = 0; i < picked.length; i++) {
    const w = picked[i];
    if (onProgress) onProgress(i + 1, picked.length, w.term);
    try {
      // 已在生词本就跳过：不给用户制造"重复加入"的错觉
      const id = w.id;
      if (id && await isInVocab(id)) { skipped++; continue; }
      const r = await addTokenToVocab(w, { source, sourceRef, force: true });
      if (r.added) { added++; titles.push(w.term); } else { failed++; }
    } catch {
      failed++;
    }
  }
  return { added, skipped, failed, titles };
}

/**
 * 等级筛选器。
 * JLPT 等级有个坑：**「没有等级」不等于「简单」**。
 * 词库里 N5–N1 之外的 extra 词也可能很难，所以「N2 及以上」应当把无等级的也算进来，
 * 否则会漏掉一大堆真正该学的词。
 */
export function levelFilter(minLevel) {
  if (!minLevel) return null;
  const order = { N5: 5, N4: 4, N3: 3, N2: 2, N1: 1 };
  const min = order[minLevel];
  if (!min) return null;
  return (level) => {
    const v = order[level];
    if (v === undefined) return true;   // 无等级：算进"N2 及以上"
    return v <= min;                     // 数字越小越难
  };
}

// ---------------------------------------------------------------------------
// 五、生词候选汇总
// ---------------------------------------------------------------------------

/**
 * 从分析结果里汇总生词候选（出现次数降序）。
 * 精读页的 /api/analyze 已经返回了 vocab，歌词页没有，所以这里也支持从句子自己汇总。
 *
 * @param {Array} sentences [{ reading:{ tokens } }]
 * @param {{ minLevel?:string, onlyUnknown?:boolean }} opts
 */
export function collectVocab(sentences, opts = {}) {
  const { minLevel = '', onlyUnknown = true } = opts;
  const allowed = levelFilter(minLevel);
  const map = new Map();
  for (const s of sentences || []) {
    for (const t of (s.reading && s.reading.tokens) || []) {
      if (t.isSpace || t.isPunct) continue;
      if (onlyUnknown && t.known) continue;
      // 纯假名片段多是助词/词尾，不是要背的词
      if (/^[\u3040-\u309f\u30a0-\u30ff\u30fc]+$/.test(t.surface) && !t.id) continue;
      if (allowed && !allowed(t.level)) continue;
      const key = t.id || t.surface;
      const cur = map.get(key) || {
        term: t.surface, reading: t.reading || '', level: t.level || '',
        zh: t.zh || [], pos: t.pos || [], id: t.id || null, count: 0,
      };
      cur.count++;
      map.set(key, cur);
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.term.localeCompare(b.term, 'ja'));
}

// ---------------------------------------------------------------------------
// 六、阅读界面外壳（两个页面共用）
// ---------------------------------------------------------------------------

/**
 * 造一排显示开关。返回 { node, state, rerender }。
 *
 * @param {object} prefs loadPrefs() 的结果
 * @param {() => void} onChange 任何开关变化后调用（由页面决定怎么重画）
 */
export function buildToggles(prefs, onChange, extras = []) {
  const mk = (label, key, title) => {
    const btn = el('button', {
      class: 'chip' + (prefs[key] ? ' is-on' : ''),
      title: title || '',
      text: label,
      onclick: () => {
        prefs[key] = !prefs[key];
        btn.classList.toggle('is-on', prefs[key]);
        savePref(key, prefs[key]);
        onChange();
      },
    });
    return btn;
  };
  const node = el('div', { class: 'jpr-toggles' }, [
    mk('振假名', 'ruby', '汉字上方显示假名读音'),
    mk('罗马音', 'romaji', '每个词下面显示罗马音'),
    mk('中文对照', 'showZh', '显示你粘贴的中文翻译'),
    ...extras,
  ]);
  return { node, prefs };
}

/**
 * 改一条笔记的标题。
 *
 * ⚠️ **只改 title 一个字段**，其余一律不动。
 *
 * 为什么不"读出内容、改完写回整条"：笔记记录里除了标题还有正文、统计、
 * `aiCache`（AI 译文缓存）等等。整条覆盖写回时，凡是**没被写进新对象**的字段
 * 都会消失 —— 用户就遇到过"保存之后译文全没了"，根因正是这个形状。
 * 所以这里读出整条记录、只动 `title`、写回同一对象：**字段级最小改动**。
 *
 * @param {string} store 'lyrics' | 'readings'
 * @param {object} rec 记录（或至少含 id）
 * @param {string} title 新标题（会 trim；空的话保持原样不改）
 * @returns {Promise<string|null>} 生效后的标题；失败返回 null
 */
export async function renameNote(store, rec, title) {
  const id = rec && rec.id;
  const next = String(title == null ? '' : title).trim();
  if (!id || !next) return null;
  try {
    const fresh = await db.dbGet(store, id);
    if (!fresh) return null;
    fresh.title = next.slice(0, 120);
    fresh.updatedAt = new Date().toISOString();
    await db.dbPut(store, fresh);
    return fresh.title;
  } catch {
    return null;
  }
}

/**
 * 笔记列表（歌词笔记 / 精读笔记共用）。
 *
 * @param {string} store 'lyrics' | 'readings'
 * @param {object} opts { onOpen(id), onDelete(id), emptyHint }
 */
export async function renderNoteList(store, opts = {}) {
  const { onOpen, onDelete, emptyHint } = opts;
  const all = await db.dbAll(store);
  all.sort((a, b) => String(b.updatedAt || b.createdAt || '')
    .localeCompare(String(a.updatedAt || a.createdAt || '')));

  if (!all.length) {
    return el('div', { class: 'empty' }, [
      el('div', { class: 'empty-title', text: '还没有保存的笔记' }),
      el('div', { class: 'empty-hint', text: emptyHint || '上面解析之后点「存为笔记」就会出现在这里。' }),
    ]);
  }

  const rows = all.map((n) => {
    const titleNode = el('a', {
      class: 'jpr-note-title note-title', href: 'javascript:void(0)',
      text: n.title || '(无标题)',
      title: n.title || '(无标题)',
      onclick: () => onOpen && onOpen(n),
    });
    const btnRow = el('div', { class: 'btn-row' });

    /** 进入行内重命名。点标题不改路由、不弹窗 —— 就地变成输入框最快。 */
    function beginRename() {
      const input = el('input', {
        class: 'note-title-edit', type: 'text', value: n.title || '',
        placeholder: '给这条笔记起个名字',
        onkeydown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          // Esc 放弃。必须有逃出口 —— 否则用户点了重命名就只能改名才能走。
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        },
      });
      const actions = el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn btn-sm btn-primary', text: '保存', onclick: () => commit() }),
        el('button', { class: 'btn btn-sm btn-ghost', text: '取消', onclick: () => cancel() }),
      ]);
      let done = false;
      function cancel() {
        if (done) return;
        done = true;
        input.replaceWith(titleNode);
        actions.replaceWith(btnRow);
      }
      async function commit() {
        if (done) return;
        const next = input.value.trim();
        if (!next) { input.focus(); return; }
        const applied = await renameNote(store, n, next);
        if (!applied) { toast('改名失败，请重试', 'error'); return; }
        done = true;
        // ★ 只改这一个节点，**不整块重画列表** —— 重画会把滚动位置和
        //   用户正在看的上下文一起丢掉，而且下面的【重新解析】也要重跑。
        n.title = applied;
        titleNode.textContent = applied;
        titleNode.title = applied;
        input.replaceWith(titleNode);
        actions.replaceWith(btnRow);
        toastOk('已改名为：' + applied);
      }
      input.addEventListener('blur', () => {
        // 焦点跑掉超过一小会儿就自动存 —— 用户点了别处通常就是想确认。
        setTimeout(() => { if (!done && document.activeElement !== input) commit(); }, 150);
      });
      titleNode.replaceWith(input);
      btnRow.replaceWith(actions);
      input.focus();
      input.select();
    }

    btnRow.appendChild(el('button', { class: 'btn btn-sm', text: '打开', onclick: () => onOpen && onOpen(n) }));
    if (opts.onRename !== false) {
      btnRow.appendChild(el('button', {
        class: 'btn btn-sm', text: '改名', title: '给这条笔记换个名字（只改名字，正文和 AI 译文都不动）',
        onclick: () => beginRename(),
      }));
    }
    btnRow.appendChild(el('button', {
      class: 'btn btn-sm btn-ghost', text: '删除',
      onclick: () => onDelete && onDelete(n),
    }));

    return el('div', { class: 'jpr-note' }, [
      el('div', { class: 'jpr-note-main' }, [
        titleNode,
        el('div', { class: 'jpr-note-meta faint', text: noteMeta(n) }),
      ]),
      btnRow,
    ]);
  });
  return el('div', { class: 'jpr-notes' }, rows);
}

function noteMeta(n) {
  const parts = [];
  if (n.updatedAt || n.createdAt) parts.push('改动于 ' + String(n.updatedAt || n.createdAt).slice(0, 16).replace('T', ' '));
  if (n.stats && n.stats.lineCount) parts.push(n.stats.lineCount + ' 行');
  if (n.stats && n.stats.charCount) parts.push(n.stats.charCount + ' 字');
  if (n.sourceType) parts.push(n.sourceType === 'ocr' ? '拍照识别' : '粘贴文本');
  return parts.join('　');
}

// ---------------------------------------------------------------------------
// 七、小工具
// ---------------------------------------------------------------------------

/*
 * `cleanOcrText` 与 `ocrWarning` 定义在 `app/js/ocrtext.js`（纯函数、零 DOM），
 * 这里只是转出去方便调用方一次 import。
 *
 * 为什么不写在本文件里：本文件 import 了 ui.js，而 ui.js 要建 DOM，
 * 于是它没法在 Node 里直接 import —— 单测一个字符串清洗函数不该先搭一套假 DOM。
 * （和 `counter.js` 单独存在是同一个理由。）
 */
export { cleanOcrText, ocrWarning } from '../ocrtext.js';

/** 从文本里取一个像样的标题：第一行非空文本，截断 */
export function guessTitle(text, fallback = '未命名') {
  const first = String(text || '').split('\n').map((s) => s.trim()).find(Boolean);
  if (!first) return fallback;
  return first.length > 40 ? first.slice(0, 40) + '…' : first;
}

/** 覆盖率徽标：低于 80% 用警示色，提示注音可能不可靠 */
export function coverageBadge(coverage) {
  const cov = typeof coverage === 'number' ? coverage : null;
  if (cov === null) return null;
  const kind = cov >= 90 ? 'ok' : cov >= 70 ? 'warn' : 'err';
  return el('span', { class: 'badge jpr-cov is-' + kind, text: `注音覆盖 ${cov}%` });
}

export { toast, toastOk };
