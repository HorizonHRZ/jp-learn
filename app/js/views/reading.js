/**
 * 读书 / 精读页（阶段 4）。
 *
 * 分工和歌词页一样：本页只管"数据从哪来"和外壳，
 * 渲染日文、振假名、罗马音、点词速查、批量加词复用 `jpreader.js`。
 *
 * 两种输入来源：
 *   ① 粘贴文本 → /api/analyze（段落 → 句子 → 词，附注音与生词清单）
 *   ② 拍照 / 截图 → /api/ocr（**项目自带的日文 OCR 引擎**，完全离线、不外传）
 *
 * 边界（写在界面上）：
 *   - 只处理你自己提供的文本与图片，没有"输入书名→获取全书"这类功能
 *   - **翻译不是你配的 AI 就不做**。没配 AI 时中文一栏留给你自己填（见本页第②条说明）
 *
 * 数据：笔记写入 IndexedDB 的 `readings` 表。表结构早就在 db.js 里建好，
 *      这里不新增 store、不动 SCHEMA_VERSION。只存原始文本 + 选项，不存解析结果。
 */
import { el, toast, toastOk, confirmDialog } from '../ui.js';
import * as db from '../db.js';
import {
  loadPrefs, buildToggles, openWord,
  addManyToVocab, addTokenToVocab,
  renderNoteList, guessTitle, coverageBadge, levelFilter, openReadingEditor,
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

/** 草稿的标识。歌词和精读各用各的键，两边的草稿不会串。 */
const DRAFT_ID = 'reading';

/**
 * 草稿自动保存的句柄（模块级 —— 理由见 lyric.js 里同样的说明：
 * destroy() 看不见 render() 里的局部变量）。
 */
let autosaveHandle = null;

export default {
  id: 'reading',
  title: '读书 / 精读',

  /**
   * 本页**不需要** destroy —— 这是刻意的设计，不是忘了写。
   *
   * 为什么：本页所有全局性的监听都已经不存在了。
   *   · 图片粘贴（Ctrl+V）：挂在 buildOcrBox 收到的 pasteTarget（本页 root）上，
   *     root 被宿主清空时监听器自动一起消失，没有要撤的东西。
   *   · AI：原来那个"选中文字就浮出按钮条"的 attachAiTo 需要 document 级
   *     mouseup/keyup，所以必须靠 destroy 撤销；**它已经被删掉了**
   *     （见 aipanel.js 顶部说明），现在 AI 走两个固定入口：
   *     点词 → 速查抽屉里的按钮；点每句右上角的「⚙ 讲语法」按钮 → 讲语法。
   *
   * ⚠️ 也就是说：以后**如果**本页再挂 document/window 级监听，
   *    就必须在这里加 destroy 把它撤掉。`tools/test-contract.mjs`
   *    有一条断言专门盯这件事（挂了全局监听的视图必须有 destroy）。
   */

  async render(root) {
    const view = this;
    const prefs = await loadPrefs();
    // 用户手改的读音表。和歌词页共用同一张 IndexedDB 表 ——
    // 同一个词在哪一页改的，另一页也跟着变（读音是同一个事实）。
    const readingOverrides = await loadOverrides();
    // 用户手改的**分词切法**表（见 js/segments.js）。同样是全站共用。
    // 和读音表分开两张：改读音改的是"怎么念"，改分词改的是"哪里算一个词"——
    // 是两件事，合在一起会让"到底是切错了还是念错了"变得查不清。
    const segOverrides = await loadSegOverrides();
    let analyzed = null;      // /api/analyze 的结果
    let currentId = null;
    let busy = false;
    let ocrText = '';         // OCR 识别出来的文字（用于"存笔记"时记录来源）
    // 重新挂一次 AI 阅读器（保存笔记之后要调，见 lyric.js 里同样的说明）。
    // 默认给空函数，免得"还没分析就点了保存"时报错。
    let repaintReader = () => {};

    // 把「AI 讲这个词」按钮装进速查抽屉。
    //
    // 为什么在阅读页装：这个按钮只在"你正在读一段日文、随手点了个词"时有用。
    // 装在这里，抽屉里的按钮就跟着阅读功能一起出现；不装的话用户点开抽屉
    // 只会看到查词结果，心里会想"那 AI 呢"。
    // 幂等：重复调用只是覆盖同一个回调，不会叠出多个按钮。
    installAiWordHook();

    // ---------- 输入区 ----------
    const textInput = el('textarea', {
      class: 'input jpr-input',
      rows: '10',
      placeholder: '把你要精读的日文粘贴到这里，或点下面的「选择图片」拍照识别。\n\n空行分段；句号、问号、感叹号断句。',
    });

    const romajiSel = el('select', { class: 'input' }, [
      el('option', { value: 'hepburn', text: '平文式（hepburn）' }),
      el('option', { value: 'kunrei', text: '训令式（kunrei）' }),
    ]);

    const analyzeBtn = el('button', { class: 'btn btn-primary', text: '开始精读', onclick: () => doAnalyze() });
    const statusHost = el('div', { class: 'jpr-status' });
    const resultHost = el('div', {});
    const notesHost = el('div', {});
    const draftHost = el('div', {});

    // ---------- 草稿保护 ----------
    //
    // 为什么要有：粘了一大段日文、点了翻译，切到别的页再回来，正文就没了
    // （它只活在 textarea 里）。这和"AI 译文会丢"是同一类风险：
    // 用户辛苦弄出来的东西不该自己消失。
    if (autosaveHandle) autosaveHandle.stop();

    /**
     * 「基准」＝ 输入框内容**最后一次和某条已保存笔记一致**的状态。
     * 返回 null 的约定见 draft.js 的 installDraftAutosave：
     * **null ＝ 没有草稿可存，请把旧草稿清掉**。
     *
     * 精读页和歌词页是同一个 bug（打开旧笔记 → 自动保存重建草稿 → 下次误弹），
     * 所以修法完全一样。**两个页面共用一个逻辑，不要只修一边。**
     */
    let baseline = { text: '', translation: '' };
    const draftData = () => {
      const cur = { text: textInput.value, translation: '' };
      if (draftMatches({ text: baseline.text, translation: baseline.translation }, cur)) {
        return null;
      }
      return cur;
    };

    const autosave = installDraftAutosave({
      viewId: DRAFT_ID,
      getData: draftData,
    });
    autosaveHandle = autosave;
    textInput.addEventListener('input', autosave.touch);
    const foundDraft = loadDraft(DRAFT_ID);
    if (foundDraft && !textInput.value.trim()) {
      // ★ 先确认这份"草稿"是不是已经存成笔记了。是的话静默清掉、不打扰用户 ——
      //   否则就会出现用户报的"每次返回都弹提示"。
      if (await draftAlreadySaved(db, 'readings', foundDraft)) {
        clearDraft(DRAFT_ID);
      } else {
        draftHost.appendChild(buildDraftBanner({
          draft: foundDraft,
          onRestore: (d) => {
            textInput.value = d.text || '';
            // 恢复出来的是没保存过的内容 → 基准留空，让它继续被草稿保护
            baseline = { text: '', translation: '' };
            toastOk('草稿已恢复，记得点「存为笔记」正式保存');
          },
          onDiscard: () => { clearDraft(DRAFT_ID); },
        }));
      }
    }

    // ---------- OCR（共用组件，歌词页用的是同一个） ----------
    //
    // 这段原来是内联在这里的 140 行。抽到 `app/js/ocrbox.js` 的原因：
    // 歌词页也要"拍照识别"，内联就意味着复制粘贴两份，改一处必漏一处。
    const ocr = buildOcrBox({
      title: '拍照识别',
      allowPaste: true,
      pasteTarget: root,        // 挂局部元素，宿主清空时监听自动消失
      onBusy: (b) => { analyzeBtn.disabled = b; },
      onText: (text) => {
        // 识别结果**追加进输入框**而不是直接覆盖分析结果：
        // OCR 会出错，用户必须有机会先改错字再解析。
        // 所以这里不做任何自动解析，只填文本。
        if (textInput.value.trim()) {
          textInput.value = textInput.value.trim() + '\n\n' + text;
        } else {
          textInput.value = text;
        }
        // 记下来源，"存笔记"时要写进 sourceType
        ocrText = textInput.value;
      },
    });

    // ---------- 精读 ----------
    async function doAnalyze() {
      const text = textInput.value.trim();
      if (!text) { toast('先粘贴要精读的日文', 'warn'); return; }
      if (busy) return;
      busy = true;
      analyzeBtn.disabled = true;
      statusHost.innerHTML = '';
      statusHost.appendChild(el('div', { class: 'faint', text: '正在分段、断句、分词…' }));
      try {
        const res = await fetch('/api/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text, romaji: romajiSel.value, ruby: true, particle: true, paragraph: true,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
        analyzed = data;
        statusHost.innerHTML = '';
        renderResult();
      } catch (e) {
        statusHost.innerHTML = '';
        statusHost.appendChild(el('div', { class: 'banner banner-error' }, [
          el('strong', { text: '精读失败：' }),
          el('span', { text: String((e && e.message) || e) }),
        ]));
        toast('精读失败，看页面上的提示', 'error');
      } finally {
        busy = false;
        analyzeBtn.disabled = false;
      }
    }

    // ---------- 结果区 ----------
    // ⚠️ 必须是 async —— 里面要 `await ensureRuby(...)` 给手改切法切出来的词补振假名。
    //    这个 `async` 是**必需品**，漏了就是浏览器里的
    //    `SyntaxError: Unexpected reserved word`（await 出现在非 async 函数里），
    //    而表现是整个视图打不开、路由显示"页面「reading」打不开"。
    //    `node --check` 也会抓到——前提是你真的去跑它。
    async function renderResult() {
      resultHost.innerHTML = '';
      if (!analyzed) return;

      const st = analyzed.stats || {};
      // 后端返回的字段是 text，共用渲染器期望 ja —— 在这里对接，不改后端
      const lines = (analyzed.sentences || []).map((s) => ({
        ja: s.text, zh: '', reading: s.reading, index: s.index,
      }));
      // ⚠️ 顺序：**先套分词，再套读音**。
      //    套分词会整段换掉 token（`こ`+`の` → `この`），
      //    如果先套读音，那些读音会跟着被换掉的旧 token 一起丢掉 ——
      //    结果就是"读音改了没生效"，而用户完全看不出为什么。
      //    反过来先分词、再套读音，读音作用在**最终**的 token 上，稳。
      //
      // ⚠️⚠️ 这里**必须把返回值写回去**。`applySegOverrides` 是纯函数，
      //    它返回一个**新数组**，不改传入的那个（这是它自己的承诺，
      //    见 segments-apply.js 的注释，check-segments.mjs [7] 还专门断言了这点）。
      //    第一版写成 `applySegOverrides(tk, segOverrides);` 就把结果丢了 ——
      //    数据层全绿、保存也真的写进了库，**但页面永远显示旧切法**，
      //    表现为"我改的分词保存了却不生效"。这类"返回值被丢掉"的 bug
      //    没有任何报错，只有端到端断言抓得住。
      for (const l of lines) {
        if (!(l.reading && l.reading.tokens)) continue;
        l.reading.tokens = applySegOverrides(l.reading.tokens, segOverrides).tokens;
      }
      // 手改切法切出来的词，`ruby` 是空的（只有 `reading`）。
      // 这里走 `/api/yomi` 把振假名补上 —— **不补的话合并出来的词就掉注音**，
      // 而它旁边程序切的词都带注音，用户会以为"这个词查不到"。
      // 失败就让它没注音（不阻断整页），所以是 await 但不抛。
      await Promise.all(lines.map(async (l) => {
        if (l.reading && l.reading.tokens) await ensureRuby(l.reading.tokens);
      }));
      // 手改读音在这里就套上（在收集生词和渲染之前）：
      // 套晚了，生词清单和正文的读音会不一致。
      applyOverrides(lines.flatMap((l) => (l.reading && l.reading.tokens) || []), readingOverrides);

      const statsRow = el('div', { class: 'jpr-stats' }, [
        el('span', { class: 'badge', text: `${st.paragraphCount || 0} 段` }),
        el('span', { class: 'badge', text: `${st.sentenceCount || 0} 句` }),
        el('span', { class: 'badge', text: `${st.charCount || 0} 字` }),
        el('span', { class: 'badge', text: `生词候选 ${st.uniqueVocab || 0} 个` }),
        coverageBadge(st.coverage),
      ].filter(Boolean));

      // 左日文 / 右中文两栏阅读器。
      //
      // 为什么用它替代原来的单栏 renderSentence 列表：
      //   用户的原话是「左边日文右边中文，这时候就把文本转变成横排的方便我阅读」。
      //   两栏对照是**版式**需求，不是"多显示一个字段"——
      //   单栏里中日文上下叠着，长段落对照起来眼睛要来回找位置。
      //   译文还会被缓存进这条笔记（见 airead.js 的说明），不会重复花钱。
      const readerHost = el('div', {});
      let reader = null;

      // AI 没启用时，在阅读区上方**长期**说明一句，而不是等用户点了才报错。
      // ⚠️ 用**独立**的容器装这条提示：mountReader() 里会 innerHTML='' 清空
      //    readerHost 来重挂阅读器，如果提示和阅读器在同一个容器里，
      //    一按「重排」提示就被清掉了（而且再也不会回来）。
      const aiNoticeHost = el('div', {});
      (async () => {
        const b = await aiStatusBanner();
        if (b) aiNoticeHost.appendChild(b);
      })();

      function mountReader() {
        readerHost.innerHTML = '';
        buildAiReader({
          lines,
          // 中文栏默认展开；假名/罗马音跟着上面的开关走。
          // 注意这里**不再传 showZh: false** —— 中文栏由阅读器自己的开关管。
          prefs: { ruby: prefs.ruby, romaji: prefs.romaji },
          showZh: true,
          // ⚠️ 传函数而不是当前值：真实的先后顺序是"先精读、后存笔记"——
          //    翻第一段的时候还没有 id。传死值会让所有译文都存不下来，
          //    下次打开又要重翻一遍（再花一次钱）。详见 airead.js 的说明。
          recordId: () => currentId,
          store: 'readings',
          // 用户手改的读音（见 js/yomi.js）。和歌词页是**同一张表** ——
          // 同一个词在哪一页改的，另一页也跟着变（读音是同一个事实）。
          overrides: readingOverrides,
          onEditReading: (t, chip, octx) => openReadingEditor(t, chip, Object.assign({
            overrides: readingOverrides,
            ruby: prefs.ruby,
            romaji: prefs.romaji,
            // 「改分词」入口需要这两样：手改切法表（判断要不要显示"恢复程序切法"）
            // 和"存完之后重画"的回调。
            //
            // ⚠️ 这个回调**必须自己重新套一遍切法**，不能只调 mountReader()。
            //    踩过的坑（用户实测报的"改了分词但页面上没变"）：
            //    保存 → 提示"已改为 xxx" → mountReader() 重挂 → **还是旧切法**。
            //    原因是"重新挂载"走的是视图自己那条渲染路径，
            //    只要那一环没把 segOverrides 套上（或套的是旧的），
            //    表现就是"存进去了但没生效"，而且**全程不报错**。
            //    所以这里显式做：从数据库重读 → 就地套 → 再重挂。
            //    这样即使渲染路径将来又出问题，用户至少看到的还是新切法。
            onSaved: async () => {
              await reapplySegOverrides(lines.map((l) => l.reading).filter(Boolean));
              mountReader();
            },
            segOverrides,
          }, octx || {})),
          // 让阅读器自己提示"译文还没进笔记"，并给一个一键保存的按钮。
          // 光修数据层不够 —— 用户看不见的状态等于没有状态，他会以为已经存了。
          onSaveNote: () => saveNote(),
          onWord: (t, ev) => { if (ev && ev.stopPropagation) ev.stopPropagation(); openWord(t); },
          // 讲这一句的语法（AI）。
          //
          // ⚠️ 这里只传一个**开关**，不传回调 —— 整条流程（请求中状态、
          //    结果落在这一行下方的折叠模块、写进笔记的 aiCache.grammar）
          //    都归阅读器自己管。以前传的是
          //    `explainSentence(...)`，它走的是**浮层面板**，关掉就没了
          //    —— 用户报的「ai 的输出依旧是弹窗，无法保存」正是这个。
          //    把流程收进阅读器还有一个好处：两个阅读页（歌词/精读）的
          //    行为不可能因为某一边忘了改而不一致。
          onSentence: true,
        }).then((r) => {
          reader = r;
          readerHost.appendChild(r.node);
        });
      }
      repaintReader = mountReader;

      const toggles = buildToggles(prefs, mountReader, []);
      mountReader();

      resultHost.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, [
          el('h2', { text: '精读结果' }),
          el('span', { class: 'spacer' }),
          el('button', { class: 'btn btn-sm', text: '存为笔记', onclick: () => saveNote() }),
        ]),
        statsRow,
        aiNoticeHost,
        toggles.node,
        el('div', { class: 'jpr-hint faint', text:
          '点词 → 查意思（抽屉里有「AI 讲这个词」）；'
          + '每句右上角的「⚙ 讲语法」按钮 → 在那一句下方展开语法讲解（不是弹窗，会跟着笔记保存）。'
          + '虚线标出的是词库没收录的片段 —— 可能是人名、专有名词，或词库没收的活用形。' }),
        readerHost,
      ]));
      resultHost.appendChild(buildVocabCard(analyzed.vocab || []));
      // reader 会在异步里就绪；留个引用给"存为笔记"用（保存译文缓存）
      view._reader = () => reader;
    }

    // ---------- 生词候选 ----------
    function buildVocabCard(vocab) {
      if (!vocab.length) {
        return el('div', { class: 'card' }, [
          el('div', { class: 'card-title' }, [el('h2', { text: '生词候选' })]),
          el('div', { class: 'empty' }, [
            el('div', { class: 'empty-title', text: '没有生词候选' }),
            el('div', { class: 'empty-hint', text: '这一篇里的词词库都认识。' }),
          ]),
        ]);
      }

      // 默认只看"词库不认识的"，但也允许把已认识的词加进来（有时就是想复习）
      let onlyUnknown = true;
      const levelSel = el('select', { class: 'input jpr-lv' }, [
        el('option', { value: '', text: '全部等级' }),
        el('option', { value: 'N1', text: '只加 N1 及以上' }),
        el('option', { value: 'N2', text: '只加 N2 及以上' }),
        el('option', { value: 'N3', text: '只加 N3 及以上' }),
      ]);
      levelSel.value = 'N2';   // 默认 N2 及以上：这是"该学的词"最常用的筛选

      const listHost = el('div', { class: 'jpr-vocab' });

      function currentList() {
        return vocab.filter((v) => (onlyUnknown ? !v.known : true));
      }

      function paint() {
        listHost.innerHTML = '';
        const rows = currentList().slice(0, 300);
        if (!rows.length) {
          listHost.appendChild(el('div', { class: 'empty' }, [
            el('div', { class: 'empty-title', text: '没有符合条件的词' }),
            el('div', { class: 'empty-hint', text: '换个筛选条件试试。' }),
          ]));
          return;
        }
        for (const w of rows) {
          const zh = Array.isArray(w.zh) ? w.zh : (w.zh ? [String(w.zh)] : []);
          listHost.appendChild(el('div', { class: 'jpr-vocab-row' }, [
            el('span', { class: 'jpr-vocab-term', text: w.surface }),
            w.reading ? el('span', { class: 'jpr-vocab-read', text: w.reading }) : null,
            w.level ? el('span', { class: 'badge', text: w.level }) : el('span', { class: 'badge', text: '无等级' }),
            w.known ? el('span', { class: 'badge', text: '词库认识' }) : null,
            el('span', { class: 'jpr-vocab-count faint', text: `×${w.count}` }),
            zh.length ? el('span', { class: 'jpr-vocab-zh faint', text: zh.slice(0, 2).join('；') }) : null,
            el('button', {
              class: 'btn btn-sm btn-ghost', text: '加入',
              onclick: async (ev) => {
                const btn = ev.target;
                btn.disabled = true; btn.textContent = '加入中…';
                const r = await addTokenToVocab({ ...w, term: w.surface },
                  { source: 'reading', sourceRef: currentId, force: true });
                if (r.added) { btn.textContent = r.created ? '✓ 已加入' : '✓ 已在'; toastOk(`已加入生词本：${w.surface}`); }
                else { btn.textContent = '失败'; btn.disabled = false; toast('加入失败：' + (r.reason || ''), 'error'); }
              },
            }),
          ].filter(Boolean)));
        }
        if (currentList().length > rows.length) {
          listHost.appendChild(el('div', { class: 'faint', text: `（只列出前 ${rows.length} 个）` }));
        }
      }
      paint();

      const unknownToggle = el('button', {
        class: 'chip is-on', text: '只看不认识的',
        onclick: () => {
          onlyUnknown = !onlyUnknown;
          unknownToggle.classList.toggle('is-on', onlyUnknown);
          paint();
        },
      });

      const addBtn = el('button', {
        class: 'btn btn-sm btn-primary', text: '批量加入生词本',
        onclick: async (ev) => {
          const btn = ev.target;
          const minLevel = levelSel.value;
          const list = currentList().map((v) => ({ ...v, term: v.surface }));
          const allowed = levelFilter(minLevel);
          const picked = allowed ? list.filter((v) => allowed(v.level)) : list;
          if (!picked.length) { toast('当前筛选下没有可加入的词', 'warn'); return; }
          btn.disabled = true;
          btn.textContent = '加入中…';
          const r = await addManyToVocab(picked, {
            minLevel, source: 'reading', sourceRef: currentId,
            onProgress: (i, n, term) => { btn.textContent = `加入中… ${i}/${n}（${term}）`; },
          });
          btn.disabled = false;
          btn.textContent = '批量加入生词本';
          toastOk(`新加入 ${r.added} 个，跳过已在内 ${r.skipped} 个` + (r.failed ? `，失败 ${r.failed} 个` : ''));
        },
      });

      const head = el('div', { class: 'jpr-vocab-head' }, [
        el('span', { class: 'faint', text: `共 ${vocab.length} 个候选` }),
        unknownToggle,
        el('span', { class: 'spacer' }),
        levelSel, addBtn,
      ]);

      return el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, [el('h2', { text: '生词候选' })]),
        el('div', { class: 'jpr-hint faint', text:
          '默认筛到 N2 及以上。注意：「没有等级」不等于「简单」，所以它也算在 N2 及以上里 —— 否则会漏掉词库里真正该学的词。' }),
        head,
        listHost,
      ]);
    }

    // ---------- 笔记 ----------
    async function saveNote() {
      if (!analyzed) { toast('先精读一次再保存', 'warn'); return; }
      const title = guessTitle(textInput.value, '未命名精读');
      const now = new Date().toISOString();
      const rec = {
        id: currentId || ('reading:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8)),
        title,
        text: textInput.value,
        // 来源：这次分析用的是 OCR 识别结果，还是手工粘贴
        sourceType: (ocrText && ocrText === textInput.value) ? 'ocr' : 'paste',
        opts: { romaji: romajiSel.value, ruby: true, particle: true, paragraph: true },
        stats: analyzed.stats || {},
        createdAt: now,
        updatedAt: now,
      };
      try {
        const old = currentId ? await db.dbGet('readings', currentId) : null;
        if (old && old.createdAt) rec.createdAt = old.createdAt;
        // ★★ 必须把 AI 译文一起带上写回。
        //    这里是"译文会丢"bug 的根因：rec 是新建的干净对象，
        //    而 dbPut 是**整条覆盖**，没出现在 rec 里的字段都会消失。
        //    以前只捞回了 createdAt，漏了 aiCache。
        //    ⚠️ 以后给笔记记录加任何新字段，都要回到这里补一行。
        const carried = await carryAiCache('readings', currentId);
        if (carried) rec.aiCache = carried;
        await db.dbPut('readings', rec);
        currentId = rec.id;
        // ★ 内容现在有正式归属了 → 更新基准，否则自动保存又把它写成草稿
        baseline = { text: textInput.value, translation: '' };
        // ★ "先翻译、后保存"的那批译文暂存在内存里，这一刻落库。
        const flushed = await flushPendingCache(rec.id);
        toastOk(flushed
          ? `已存为笔记：${title}（含 ${flushed} 段 AI 译文）`
          : '已存为笔记：' + title);
        await refreshNotes();
        await repaintReader();
        // 内容已经正式存成笔记了，草稿的使命就结束了 —— 留着只会在下次进页面时
        // 弹一句"发现没保存的草稿"，反而让人以为没存上。
        clearDraft(DRAFT_ID);
      } catch (e) {
        toast('保存失败：' + ((e && e.message) || e), 'error');
      }
    }

    async function openNote(n) {
      textInput.value = n.text || '';
      // ★ 基准 = 刚填进来的这条笔记的内容；顺手清掉残留草稿。
      //   不设这一行就会重现用户报的问题：打开旧笔记后 5 秒草稿被重建，
      //   下次进页面弹"发现一份没保存的草稿"。
      baseline = { text: textInput.value, translation: '' };
      clearDraft(DRAFT_ID);
      if (n.opts && n.opts.romaji) romajiSel.value = n.opts.romaji;
      currentId = n.id;
      ocrText = n.sourceType === 'ocr' ? (n.text || '') : '';
      toast('打开了笔记《' + (n.title || '') + '》，已重新解析');
      await doAnalyze();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    async function deleteNote(n) {
      const yes = await confirmDialog(`删除笔记《${n.title || '(无标题)'}》？此操作无法撤销。`,
        { title: '删除笔记', okLabel: '删除', danger: true });
      if (!yes) return;
      try {
        await db.dbDelete('readings', n.id);
        if (currentId === n.id) currentId = null;
        toastOk('已删除');
        await refreshNotes();
      } catch (e) {
        toast('删除失败：' + ((e && e.message) || e), 'error');
      }
    }

    async function refreshNotes() {
      notesHost.innerHTML = '';
      notesHost.appendChild(await renderNoteList('readings', {
        onOpen: (n) => openNote(n),
        onDelete: (n) => deleteNote(n),
        emptyHint: '上面精读之后点「存为笔记」就会出现在这里。',
      }));
    }

    // ---------- 组装 ----------
    root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [
        el('h2', { text: '读书 / 精读' }),
        el('span', { class: 'badge', text: '本地解析' }),
      ]),
      draftHost,
      ocr.node,
      el('label', { class: 'jpr-label', text: '要精读的日文（粘贴，或用上面的拍照识别）' }),
      textInput,
      el('div', { class: 'jpr-controls' }, [
        el('label', { class: 'faint', text: '罗马音体系' }),
        romajiSel,
        el('span', { class: 'spacer' }),
        el('button', {
          class: 'btn btn-sm btn-ghost', text: '清空',
          onclick: () => {
            textInput.value = ''; analyzed = null; currentId = null;
            ocrText = '';
            resultHost.innerHTML = ''; statusHost.innerHTML = '';
            // 用户明确点了「清空」，草稿也一起清 —— 否则下次进来会问
            // "要不要恢复草稿"，恢复出他刚清掉的东西。
            clearDraft(DRAFT_ID);
            ocr.reset();
          },
        }),
        analyzeBtn,
      ]),
      el('div', { class: 'banner banner-info' }, [
        el('strong', { text: '边界与限制：' }),
        el('div', { text: '① 只处理你自己提供的文本与图片，没有「输入书名→获取全书内容」这类功能。' }),
        el('div', { text: '② 翻译要用你自己配的 AI。没配 AI 时中文一栏留空 —— 本机没有离线翻译模型。' }),
        // ⚠️ 这一条不能省。用户就是在**这一页**按「自动翻译全部段落」的，
        //    所以"按下它会把什么发出去"必须写在他眼前，不能只写在设置页。
        //    程序里会联网的入口有两处：点词/点句（发那一小段），
        //    和自动翻译（把每段正文依次发出去）—— 这里两处都要说到。
        el('div', { text: '③ 点「自动翻译全部段落」时，会把每一段的日文正文依次发给你配的那个 AI 地址；'
          + '只点「AI 讲这个词」或某句的「⚙ 讲语法」时，只发你点的那一小段。'
          + '生词本、进度、笔记标题都不会被发送。' }),
        el('div', { text: '④ 拍照识别由本项目自带的日文引擎在这台电脑上完成，图片不会上传到任何地方。' }),
      ]),
      statusHost,
    ]));

    root.appendChild(resultHost);

    root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [el('h2', { text: '我的精读笔记' })]),
      el('div', { class: 'jpr-hint faint', text:
        '笔记存在这台电脑的浏览器里（IndexedDB），会跟「导出备份」一起走。' }),
      notesHost,
    ]));

    await refreshNotes();
  },

  /**
   * 离开本页时收尾。
   *
   * ⚠️ 必须存在：本页装了草稿自动保存的**定时器**（每 5 秒一次）。
   *    不清掉的话，用户切到别的页之后它还在读一个已经脱离文档的 textarea。
   *    本页以前没有 destroy()（选区按钮条删掉之后就没了），
   *    加草稿功能时必须把它补回来：**加了新的全局资源，就要检查收尾。**
   */
  destroy() {
    if (autosaveHandle) { autosaveHandle.stop(); autosaveHandle = null; }
  },
};
