/**
 * 歌词学习页（阶段 3）。
 *
 * 分工：本页只负责"数据从哪来"和外壳功能；
 *      把日文渲染成可点的词、振假名、罗马音、点词速查、批量加词
 *      全部复用 `jpreader.js` —— 那些逻辑和精读页是同一件事，不该有两份。
 *
 * 边界（写在界面上，不藏着）：
 *   歌词文本**一律由你本人输入**。本程序不连接、不获取任何歌词网站的内容，
 *   也没有"输入歌名→自动获取歌词"这类功能。
 *
 * 数据：
 *   笔记写入 IndexedDB 的 `lyrics` 表（表结构早就在 db.js 里建好了，这里不新增 store、
 *   不动 SCHEMA_VERSION）。只存**原始文本 + 解析选项**，不存解析结果 ——
 *   解析结果随时能重算，存下来会让导出文件膨胀，而且代码升级后旧结果就过期了。
 */
import { el, toast, toastOk, confirmDialog } from '../ui.js';
import * as db from '../db.js';
import {
  loadPrefs, buildToggles, openWord,
  collectVocab, addManyToVocab, addTokenToVocab,
  renderNoteList, guessTitle, coverageBadge, openReadingEditor,
} from './jpreader.js';
import { loadOverrides, applyOverrides } from '../yomi.js';
import { loadSegOverrides, applySegOverrides, ensureRuby, reapplySegOverrides } from '../segments.js';
import { buildOcrBox } from '../ocrbox.js';
import {
  buildAiReader, installAiWordHook, aiStatusBanner,
  carryAiCache, flushPendingCache,
} from '../airead.js';
import {
  loadDraft, clearDraft, buildDraftBanner, installDraftAutosave, draftMatches,
  draftAlreadySaved,
} from '../draft.js';

const SAMPLE_HINT = '把你自己的日文歌词粘贴到这里（支持多行）';

/** 草稿的标识。歌词和精读各用各的键，两边的草稿不会串。 */
const DRAFT_ID = 'lyric';

/**
 * 草稿自动保存的句柄（**模块级**，不是 render 里的局部变量）。
 *
 * 为什么必须放在模块级：`destroy()` 是视图对象上的方法，它**看不见
 * render() 里的局部变量**。要能让 destroy 停掉定时器，句柄就得放在
 * 两边都够得着的地方。
 *
 * 顺带解决另一个坑：用户"进页面 → 离开 → 再进来"时，render 会**再装一个**
 * 自动保存。如果不在装之前先停掉旧的，定时器就会越积越多
 * （每进出一次多一个，每个都在写同一份草稿）。所以 render 开头先 stop。
 */
let autosaveHandle = null;

export default {
  id: 'lyric',
  title: '歌词学习',

  /**
   * 本页**不需要** destroy —— 这是刻意的设计，不是忘了写。
   *
   * 原来这里有一个 `destroy()`，专门用来解绑 `attachAiTo()` 挂在
   * document 上的 mouseup/keyup（选区按钮条）。**那个功能已经被删掉了**
   * （用户明确要求，见 aipanel.js 顶部说明），所以现在本页：
   *   · 图片粘贴监听挂在 buildOcrBox 的 pasteTarget（本页 root）上 ——
   *     root 被清空时监听自动消失，没有要撤的东西；
   *   · AI 走两个固定入口：点词 → 速查抽屉；点每句右上角的「⚙ 讲语法」按钮 → 讲语法。
   *
   * ⚠️ 以后**如果**再挂 document/window 级监听，必须补回 destroy()。
   *    `tools/test-contract.mjs` 有一条断言专门盯这件事。
   */

  async render(root) {
    // ---------- 状态（刻意放在 render 内，不放模块级）----------
    // 模块级状态会在"离开页面再回来"时残留，导致看到上次的数据却以为是新的。
    // 放在 render 里，每次进页面都是干净的。
    const view = this;
    const prefs = await loadPrefs();
    // 用户手改的读音表（词形 → 读音）。进页面读一次，改的时候同步更新这一份。
    // 为什么放 render 内而不是模块级：模块级会残留，用户"离开再回来"时
    // 看到的可能还是上一次的表格 —— 而这张表是会被改的，残留就会读到旧值。
    const readingOverrides = await loadOverrides();
    // 用户手改的**分词切法**表（见 js/segments.js）。和精读页共用同一张表 ——
    // 切法是文本本身的事实，在哪一页改的都一样。
    const segOverrides = await loadSegOverrides();
    let parsed = null;        // /api/lyric/parse 的结果
    let currentId = null;     // 当前正在编辑的笔记 id（保存时用于覆盖而不是新建）
    let busy = false;
    // 重新挂一次 AI 阅读器。doParse 里会把它指向真正的实现；
    // 保存笔记之后需要调它 —— 因为那时候"译文还没存进笔记"的提醒要消失、
    // 阅读器也要去数据库里重新读一遍缓存。默认给个空函数，
    // 免得"还没解析就点了保存"这种顺序下报错。
    let repaintReader = () => {};

    // 把「AI 讲这个词」按钮装进速查抽屉（和精读页是同一个入口）
    installAiWordHook();

    // ---------- 输入区 ----------
    const jaInput = el('textarea', {
      class: 'input jpr-input',
      rows: '8',
      placeholder: SAMPLE_HINT,
    });
    const zhInput = el('textarea', {
      class: 'input jpr-input',
      rows: '8',
      placeholder: '中文对照，可选。一行对一行，行数对不上也能用（对不上的行会留空）',
    });

    const romajiSel = el('select', { class: 'input' }, [
      el('option', { value: 'hepburn', text: '平文式（hepburn，常用）' }),
      el('option', { value: 'kunrei', text: '训令式（kunrei）' }),
    ]);

    const parseBtn = el('button', {
      class: 'btn btn-primary', text: '解析',
      onclick: () => doParse(),
    });

    const statusHost = el('div', { class: 'jpr-status' });
    const resultHost = el('div', {});
    const notesHost = el('div', {});
    const draftHost = el('div', {});

    // ---------- 草稿保护 ----------
    //
    // 为什么要有：用户粘了歌词、点了翻译、切到别的页再回来，正文就没了
    // （它只活在 textarea 里）。这和"AI 译文会丢"是同一类风险：
    // **用户辛苦弄出来的东西不该自己消失。**
    //
    // 两条触发路径都装：输入停下来就存（防抖）＋ 每 5 秒兜底定时。
    // stop() 必须挂到 destroy()，否则定时器会跟着页面泄漏。
    // 先停掉可能存在的旧句柄（用户可能"进来→离开→又进来"）。
    if (autosaveHandle) autosaveHandle.stop();

    /**
     * 「基准」＝ 当前输入框里的内容**最后一次和某条已保存笔记一致**的状态。
     *
     * ⚠️ 为什么必须有它（用户报的第 5 个问题，根因在这里）：
     *   自动保存是每 5 秒无条件把 textarea 写一遍草稿，它**分不清**
     *   "用户刚打的字"和"刚从已保存笔记里读出来的字"。
     *   于是打开一条笔记后 5 秒，草稿就被重建了 ——
     *   下次进页面就弹"发现一份没保存的草稿"，明明那个笔记早存好了。
     *
     *   有了基准就能区分：
     *     · 内容 === 基准  → 这份内容已经有归属（那条笔记），返回 null，
     *                       不写草稿、并把残留的草稿清掉；
     *     · 内容 ≠ 基准    → 用户真的改了东西，正常存草稿。
     *
     *   基准在三个地方更新：打开笔记、保存笔记、以及**用户明确点「恢复草稿」**。
     *   最后那个很重要：恢复出来的内容来自一份**没保存过**的草稿，
     *   它没有归属，所以基准要设成**空**而不是设成恢复后的内容 ——
     *   否则用户恢复完再切页，这份东西就没人保护了。
     */
    let baseline = { text: '', translation: '' };

    /**
     * 给自动保存取数据。
     * 返回 `null` 的约定见 draft.js 的 installDraftAutosave：
     * **null ＝ 没有草稿可存，请把旧草稿清掉**。
     */
    const draftData = () => {
      const cur = { text: jaInput.value, translation: zhInput.value };
      if (draftMatches({ text: baseline.text, translation: baseline.translation }, cur)) {
        return null;   // 和已保存的笔记一模一样 → 不是草稿
      }
      return cur;
    };

    const autosave = installDraftAutosave({
      viewId: DRAFT_ID,
      getData: draftData,
    });
    autosaveHandle = autosave;
    jaInput.addEventListener('input', autosave.touch);
    zhInput.addEventListener('input', autosave.touch);

    // 进页面时如果发现草稿，问一句"要不要恢复"。
    // **不自动恢复**：自动填进去一堆用户没在编辑的旧内容，他会搞不清当前状态。
    // 已经有内容（比如刚点了"打开笔记"）就不打扰 —— 那时草稿只会添乱。
    //
    // ⚠️ 这里原来只判断"输入框是不是空的"。那个条件**不够**：
    //    输入框空着、而草稿内容其实早就存成笔记了 —— 这种情况照样会弹，
    //    用户就会看到"每次返回都弹提示"（他报的第 5 个问题）。
    //    现在先按草稿内容**去库里找有没有同内容的笔记**，有就直接清掉草稿、
    //    不弹。找的过程是纯读取，没有任何副作用。
    const foundDraft = loadDraft(DRAFT_ID);
    if (foundDraft && !jaInput.value.trim() && !zhInput.value.trim()) {
      if (await draftAlreadySaved(db, 'lyrics', foundDraft)) {
        // 这份"草稿"的内容已经是一条保存过的笔记了 → 静默清掉，不打扰用户
        clearDraft(DRAFT_ID);
      } else {
        draftHost.appendChild(buildDraftBanner({
          draft: foundDraft,
          onRestore: (d) => {
            jaInput.value = d.text || '';
            zhInput.value = d.translation || '';
            // 恢复出来的是**没保存过**的内容 → 基准留空，
            // 这样它继续被草稿保护（见上面 baseline 的注释）
            baseline = { text: '', translation: '' };
            toastOk('草稿已恢复，记得点「存为笔记」正式保存');
          },
          onDiscard: () => { clearDraft(DRAFT_ID); },
        }));
      }
    }

    // ---------- 拍照识别（和精读页共用同一个组件） ----------
    //
    // 为什么歌词页也要有：歌词经常只有印在 CD 内页/写真集上的版本，
    // 手打一遍既慢又容易错。识别结果**填进输入框**而不是直接解析 ——
    // OCR 会认错字，必须给用户一个先改正的机会。
    // 中文对照框**不自动填**：识别出来的中日混排文字分不清哪句是哪句的译文。
    const ocr = buildOcrBox({
      title: '拍照识别歌词',
      allowPaste: true,
      pasteTarget: root,
      onBusy: (b) => { parseBtn.disabled = b; },
      onText: (text) => {
        if (jaInput.value.trim()) {
          jaInput.value = jaInput.value.trim() + '\n\n' + text;
        } else {
          jaInput.value = text;
        }
      },
    });

    // ---------- 解析 ----------
    async function doParse() {
      const text = jaInput.value.trim();
      if (!text) { toast('先把歌词粘贴到左边的框里', 'warn'); return; }
      if (busy) return;
      busy = true;
      parseBtn.disabled = true;
      statusHost.innerHTML = '';
      statusHost.appendChild(el('div', { class: 'faint', text: '正在分词与注音…' }));
      try {
        const res = await fetch('/api/lyric/parse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            translation: zhInput.value,
            romaji: romajiSel.value,
            ruby: true,
            particle: true,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
        parsed = data;
        statusHost.innerHTML = '';
        if (!data.reading.ready) {
          statusHost.appendChild(el('div', { class: 'banner banner-warn' }, [
            el('strong', { text: '注音引擎未就绪：' }),
            el('span', { text: (data.reading.error || '词库索引没加载成功') +
              '　—— 分行和中文对照仍然可用，但汉字读音会缺失。' }),
          ]));
        }
        renderResult();
      } catch (e) {
        statusHost.innerHTML = '';
        statusHost.appendChild(el('div', { class: 'banner banner-error' }, [
          el('strong', { text: '解析失败：' }),
          el('span', { text: String((e && e.message) || e) }),
        ]));
        toast('解析失败，看页面上的提示', 'error');
      } finally {
        busy = false;
        parseBtn.disabled = false;
      }
    }

    // ---------- 结果区 ----------
    // ⚠️ 必须是 async —— 里面要 `await ensureRuby(...)` 给手改切法切出来的词补振假名。
    //    这个 `async` 是**必需品**，漏了就是浏览器里的
    //    `SyntaxError: Unexpected reserved word`（await 出现在非 async 函数里），
    //    而表现是整个视图打不开、路由显示"页面「lyric」打不开"。
    async function renderResult() {
      resultHost.innerHTML = '';
      if (!parsed) return;

      const st = parsed.stats || {};
      const lines = parsed.lines || [];
      const sentences = lines.map((l) => ({ ja: l.ja, zh: l.zh, reading: l.reading }));
      // ⚠️ 顺序：**先套分词，再套读音**。
      //    套分词会整段换掉 token（`こ`+`の` → `この`），
      //    如果先套读音，那些读音会跟着被换掉的旧 token 一起丢掉 ——
      //    结果就是"读音改了没生效"，而用户完全看不出为什么。
      //
      // ⚠️⚠️ 这里**必须把返回值写回去**：`applySegOverrides` 是纯函数，
      //    返回新数组、不改入参。丢掉返回值 = 数据存了但页面永远显示旧切法
      //    （没有报错，只有端到端断言抓得住）。精读页踩过，见那边的长注释。
      for (const s of sentences) {
        if (!(s.reading && s.reading.tokens)) continue;
        s.reading.tokens = applySegOverrides(s.reading.tokens, segOverrides).tokens;
      }
      // 手改切法切出来的词，`ruby` 是空的（只有 `reading`）。
      // 这里走 `/api/yomi` 把振假名补上 —— **不补的话合并出来的词就掉注音**，
      // 而它旁边程序切的词都带注音，用户会以为"这个词查不到"。
      // 失败就让它没注音（不阻断整页），所以是 await 但不抛。
      await Promise.all(sentences.map(async (s) => {
        if (s.reading && s.reading.tokens) await ensureRuby(s.reading.tokens);
      }));
      // 手改读音在这里就套上（在收集生词和渲染之前）。
      // 顺序很关键：套晚了，生词清单里的读音和正文里的会不一致。
      applyOverrides(sentences.flatMap((s) => (s.reading && s.reading.tokens) || []), readingOverrides);

      // 统计条
      const statsRow = el('div', { class: 'jpr-stats' }, [
        el('span', { class: 'badge', text: `${st.lineCount || lines.length} 行` }),
        el('span', { class: 'badge', text: `${st.charCount || 0} 字` }),
        el('span', { class: 'badge', text: `汉字 ${st.kanjiCount || 0} / 假名 ${st.kanaCount || 0}` }),
        el('span', { class: 'badge', text: `${parsed.reading.romajiStyle === 'kunrei' ? '训令式' : '平文式'}罗马音` }),
        coverageBadge(parsed.reading.coverage),
      ].filter(Boolean));

      // 中文对照行数对不上时明确提示，否则用户会以为程序错了
      if (st.translationAligned === false) {
        statsRow.appendChild(el('span', {
          class: 'badge jpr-cov is-warn',
          text: `中文 ${st.translationLines} 行 ≠ 日文 ${st.lineCount} 行（按行号对的，请检查）`,
        }));
      }

      // 左日文 / 右中文两栏阅读器（和精读页共用，见 airead.js）。
      //
      // 本页比精读页多一样东西：**用户自己填的中文对照**（zhInput 那个框）。
      // 所以把 parased.lines[].zh 作为 preTranslations 传进去 ——
      // 阅读器会让"用户填的"优先于 AI 译文，绝不用 AI 覆盖用户自己写的东西。
      const preTranslations = {};
      lines.forEach((l, i) => { if (l.zh) preTranslations[i] = l.zh; });

      const readerHost = el('div', {});
      const aiNoticeHost = el('div', {});
      (async () => {
        const b = await aiStatusBanner();
        if (b) aiNoticeHost.appendChild(b);
      })();

      function mountReader() {
        readerHost.innerHTML = '';
        buildAiReader({
          lines: sentences,
          prefs: { ruby: prefs.ruby, romaji: prefs.romaji },
          showZh: true,
          preTranslations,
          recordId: () => currentId,
          store: 'lyrics',
          // 用户手改的读音（见 js/yomi.js）。**必须传** ——
          // 否则用户改完读音、切一下开关重画，又变回程序猜的那个，
          // 他会以为"改了没用"。
          overrides: readingOverrides,
          onEditReading: (t, chip, octx) => openReadingEditor(t, chip, Object.assign({
            overrides: readingOverrides,
            ruby: prefs.ruby,
            romaji: prefs.romaji,
            // 「改分词」入口需要这两样：手改切法表（判断要不要显示"恢复程序切法"）
            // 和"存完之后重画"的回调。
            //
            // ⚠️ 这个回调**必须自己重新套一遍切法**，不能只调 mountReader() ——
            //    用户实测报过"改了分词但页面上没变"（记录存进去了、提示也弹了）。
            //    详细原因见 segments.js 的 reapplySegOverrides() 长注释。
            segOverrides,
            onSaved: async () => {
              await reapplySegOverrides(sentences.map((s) => s.reading).filter(Boolean));
              mountReader();
            },
          }, octx || {})),
          // 让阅读器能自己提示"译文还没进笔记"，并给一个一键保存的按钮。
          // 这是修"译文会丢"的核心一环：光修数据不够，得让用户看得见。
          onSaveNote: () => saveNote(),
          onWord: (t, ev) => { if (ev && ev.stopPropagation) ev.stopPropagation(); openWord(t); },
          // 讲这一句的语法（AI）。只传开关，流程归阅读器自己管 ——
          // 这样两个阅读页行为必然一致，而且结果落在句子下方的折叠模块里、
          // 并写进笔记的 aiCache.grammar（不再是关掉就没的弹窗）。
          onSentence: true,
        }).then((r) => readerHost.appendChild(r.node));
      }
      repaintReader = mountReader;

      const toggles = buildToggles(prefs, mountReader, []);
      mountReader();

      // 生词候选（歌词接口不返回 vocab，从句子自己汇总）
      const vocab = collectVocab(sentences, { minLevel: '', onlyUnknown: true });
      const vocabCard = buildVocabCard(vocab);

      resultHost.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, [
          el('h2', { text: '解析结果' }),
          el('span', { class: 'spacer' }),
          el('button', { class: 'btn btn-sm', text: '存为笔记', onclick: () => saveNote() }),
        ]),
        statsRow,
        aiNoticeHost,
        toggles.node,
        el('div', { class: 'jpr-hint faint', text:
          '点词 → 查意思（抽屉里有「AI 讲这个词」）；'
          + '每句右上角的「⚙ 讲语法」按钮 → 在那一句下方展开语法讲解（不是弹窗，会跟着笔记保存）。'
          + '查不到的词用虚线下划线标出（不猜读音）。' }),
        readerHost,
      ]));
      resultHost.appendChild(vocabCard);
    }

    // ---------- 生词候选 + 批量加词 ----------
    function buildVocabCard(vocab) {
      const body = el('div', {});
      if (!vocab.length) {
        return el('div', { class: 'card' }, [
          el('div', { class: 'card-title' }, [el('h2', { text: '生词候选' })]),
          el('div', { class: 'empty' }, [
            el('div', { class: 'empty-title', text: '没有查不到的词' }),
            el('div', { class: 'empty-hint', text: '这一篇里的词词库都认识，说明你选的材料偏简单，或者词库覆盖得很好。' }),
          ]),
        ]);
      }

      const levelSel = el('select', { class: 'input jpr-lv' }, [
        el('option', { value: '', text: '全部等级' }),
        el('option', { value: 'N1', text: '只加 N1 及以上' }),
        el('option', { value: 'N2', text: '只加 N2 及以上' }),
        el('option', { value: 'N3', text: '只加 N3 及以上' }),
      ]);

      const listHost = el('div', { class: 'jpr-vocab' });
      function paint() {
        listHost.innerHTML = '';
        const rows = vocab.slice(0, 200);
        for (const w of rows) {
          listHost.appendChild(el('div', { class: 'jpr-vocab-row' }, [
            el('span', { class: 'jpr-vocab-term', text: w.term }),
            w.reading ? el('span', { class: 'jpr-vocab-read', text: w.reading }) : null,
            w.level ? el('span', { class: 'badge', text: w.level }) : el('span', { class: 'badge', text: '无等级' }),
            el('span', { class: 'jpr-vocab-count faint', text: `×${w.count}` }),
            w.zh && w.zh.length ? el('span', { class: 'jpr-vocab-zh faint', text: w.zh.slice(0, 2).join('；') }) : null,
            el('button', {
              class: 'btn btn-sm btn-ghost', text: '加入',
              onclick: async (ev) => {
                const btn = ev.target;
                btn.disabled = true;
                btn.textContent = '加入中…';
                const r = await addTokenToVocab(w, { source: 'lyric', sourceRef: currentId });
                if (r.added) { btn.textContent = r.created ? '✓ 已加入' : '✓ 已在'; toastOk(`已加入生词本：${w.term}`); }
                else { btn.textContent = '失败'; btn.disabled = false; toast('加入失败：' + (r.reason || ''), 'error'); }
              },
            }),
          ].filter(Boolean)));
        }
        if (vocab.length > rows.length) {
          listHost.appendChild(el('div', { class: 'faint', text: `（只列出前 ${rows.length} 个，共 ${vocab.length} 个）` }));
        }
      }
      paint();

      const addBtn = el('button', {
        class: 'btn btn-sm btn-primary', text: '批量加入生词本',
        onclick: async (ev) => {
          const btn = ev.target;
          const minLevel = levelSel.value;
          btn.disabled = true;
          btn.textContent = '加入中…';
          const r = await addManyToVocab(vocab, {
            minLevel, source: 'lyric', sourceRef: currentId,
            onProgress: (i, n, term) => { btn.textContent = `加入中… ${i}/${n}（${term}）`; },
          });
          btn.disabled = false;
          btn.textContent = '批量加入生词本';
          toastOk(`新加入 ${r.added} 个，跳过已在内 ${r.skipped} 个` + (r.failed ? `，失败 ${r.failed} 个` : ''));
        },
      });

      body.appendChild(el('div', { class: 'jpr-vocab-head' }, [
        el('span', { class: 'faint', text: `共 ${vocab.length} 个词库里查不到的片段` }),
        el('span', { class: 'spacer' }),
        levelSel, addBtn,
      ]));
      body.appendChild(listHost);

      return el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, [el('h2', { text: '生词候选' })]),
        el('div', { class: 'jpr-hint faint', text:
          '「查不到」不等于「难词」—— 也可能是人名、专有名词、或词库没收的活用形。加入前扫一眼。' }),
        body,
      ]);
    }

    // ---------- 保存 / 打开 / 删除笔记 ----------
    async function saveNote() {
      if (!parsed) { toast('先解析一次再保存', 'warn'); return; }
      const title = guessTitle(jaInput.value, '未命名歌词');
      const now = new Date().toISOString();
      const rec = {
        id: currentId || ('lyric:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8)),
        title,
        text: jaInput.value,
        translation: zhInput.value,
        opts: { romaji: romajiSel.value, ruby: true, particle: true },
        stats: parsed.stats || {},
        createdAt: now,
        updatedAt: now,
      };
      try {
        const old = currentId ? await db.dbGet('lyrics', currentId) : null;
        if (old && old.createdAt) rec.createdAt = old.createdAt;
        // ★★ 必须把 AI 译文一起带上写回。
        //    这里是整个"译文会丢"bug 的根因：rec 是新建的干净对象，
        //    而 dbPut 是**整条覆盖**，凡是没出现在 rec 里的字段都会消失。
        //    以前只捞回了 createdAt，漏了 aiCache —— 用户一保存，译文全没了。
        //    ⚠️ 以后给笔记记录加任何新字段，都要回到这里补一行。
        const carried = await carryAiCache('lyrics', currentId);
        if (carried) rec.aiCache = carried;
        await db.dbPut('lyrics', rec);
        currentId = rec.id;
        // ★ 输入框里的内容现在有了正式归属（这条笔记）→ 更新基准。
        //   不更新的话，下一次自动保存会认为"内容 ≠ 基准"，
        //   又把这份内容写成草稿 —— 那就回到用户报的那个 bug 了。
        baseline = { text: jaInput.value, translation: zhInput.value };
        // ★ 用户"先翻译、后保存"的那批译文平时暂存在内存里，
        //   现在记录有了，落的这一刻把它们写进这条笔记。
        //   不做这一步的话，第一次保存之后译文还是会丢（白花 token）。
        //   flushPendingCache 内部就是"读出整条 → 只改 aiCache → 写回"，
        //   所以这里不需要再补一次写。
        const flushed = await flushPendingCache(rec.id);
        toastOk(flushed
          ? `已存为笔记：${title}（含 ${flushed} 段 AI 译文）`
          : '已存为笔记：' + title);
        await refreshNotes();
        await repaintReader();
        // 内容已经正式存成笔记了，草稿的使命就结束了 —— 留着只会下次进页面时
        // 弹一句"发现没保存的草稿"，反而让人以为没存上。
        clearDraft(DRAFT_ID);
      } catch (e) {
        toast('保存失败：' + ((e && e.message) || e), 'error');
      }
    }

    async function openNote(n) {
      jaInput.value = n.text || '';
      zhInput.value = n.translation || '';
      // ★ 基准 = 刚填进来的这条笔记的内容。
      //   这样自动保存（每 5 秒一次）会判定"和已保存的笔记一致"→ 不写草稿。
      //   不设这一行，就会重现用户报的问题：打开旧笔记后 5 秒草稿被重建，
      //   下次进页面弹"发现一份没保存的草稿"。
      baseline = { text: jaInput.value, translation: zhInput.value };
      // 顺手把残留草稿清掉：内容已经属于这条笔记了，留着只会下次误弹
      clearDraft(DRAFT_ID);
      if (n.opts && n.opts.romaji) romajiSel.value = n.opts.romaji;
      currentId = n.id;
      toast('打开了笔记《' + (n.title || '') + '》，已重新解析');
      // 打开笔记时**重新解析**而不是读存下来的结果：
      // 代码升级后旧结果就过期了，重算才能保证显示和当前引擎一致。
      await doParse();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    async function deleteNote(n) {
      const yes = await confirmDialog(`删除笔记《${n.title || '(无标题)'}》？此操作无法撤销。`,
        { title: '删除笔记', okLabel: '删除', danger: true });
      if (!yes) return;
      try {
        await db.dbDelete('lyrics', n.id);
        if (currentId === n.id) currentId = null;
        toastOk('已删除');
        await refreshNotes();
      } catch (e) {
        toast('删除失败：' + ((e && e.message) || e), 'error');
      }
    }

    async function refreshNotes() {
      notesHost.innerHTML = '';
      const list = await renderNoteList('lyrics', {
        onOpen: (n) => openNote(n),
        onDelete: (n) => deleteNote(n),
        emptyHint: '上面解析之后点「存为笔记」就会出现在这里。',
      });
      notesHost.appendChild(list);
    }

    // ---------- 组装页面 ----------
    root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [
        el('h2', { text: '歌词学习' }),
        el('span', { class: 'badge', text: '本地解析' }),
      ]),
      draftHost,
      ocr.node,
      el('div', { class: 'jpr-grid' }, [
        el('div', {}, [
          el('label', { class: 'jpr-label', text: '日文歌词（必填）' }),
          jaInput,
        ]),
        el('div', {}, [
          el('label', { class: 'jpr-label', text: '中文对照（可选）' }),
          zhInput,
        ]),
      ]),
      el('div', { class: 'jpr-controls' }, [
        el('label', { class: 'faint', text: '罗马音体系' }),
        romajiSel,
        el('span', { class: 'spacer' }),
        el('button', {
          class: 'btn btn-sm btn-ghost', text: '清空',
          onclick: () => {
            jaInput.value = ''; zhInput.value = ''; parsed = null;
            currentId = null; resultHost.innerHTML = ''; statusHost.innerHTML = '';
            // 用户明确点了「清空」，草稿也一起清掉 ——
            // 否则下次进来会问"要不要恢复草稿"，恢复出他刚清掉的东西。
            clearDraft(DRAFT_ID);
            ocr.reset();
          },
        }),
        parseBtn,
      ]),
      el('div', { class: 'banner banner-info' }, [
        el('strong', { text: '边界：' }),
        el('span', { text: '歌词文本一律由你本人输入（手打或拍照识别）。本程序不连接、' +
          '不获取任何歌词网站的内容，也没有"输入歌名→自动获取歌词"这类功能。' }),
      ]),
      statusHost,
    ]));

    root.appendChild(resultHost);

    root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [el('h2', { text: '我的歌词笔记' })]),
      el('div', { class: 'jpr-hint faint', text:
        '笔记存在这台电脑的浏览器里（IndexedDB），会跟「导出备份」一起走。' }),
      notesHost,
    ]));

    await refreshNotes();
  },

  /**
   * 离开本页时收尾。
   *
   * ⚠️ 必须存在，因为本页装了**定时器**（草稿自动保存每 5 秒一次）。
   *    不在这里清掉，定时器会跟着页面一直跑下去：用户切到别的页之后
   *    它还在读一个已经脱离文档的 textarea ——内存泄漏，而且行为诡异。
   *    上一轮删掉选区按钮条之后本页一度没有 destroy()，
   *    加草稿功能时就必须把它补回来。**加了新的全局资源，就要检查收尾。**
   */
  destroy() {
    if (autosaveHandle) { autosaveHandle.stop(); autosaveHandle = null; }
  },
};
