/**
 * 语法教材（views/grammar.js）
 *
 * 设计要点（为什么这么做）：
 *
 * 1. **正文在 data/grammar/，用户状态在 IndexedDB 的 grammarState 表。**
 *    两者严格分开：正文属于"程序"（升级程序可以覆盖它），
 *    收藏/已掌握属于"你的数据"（跟着"导出全部数据"一起走）。
 *    那张表**早就建好了**，所以做这个功能**没有动 SCHEMA_VERSION、没有迁移**。
 *
 * 2. **索引和正文分开取。**
 *    列表页只取 data/grammar/index.json（几 KB），点开某条才取它的正文，
 *    避免"打开列表就把几百条正文全下载下来"。
 *    正文里例句的振假名只有服务端算得出来（分词器在服务端），所以走
 *    `/api/grammar/entry`；索引是纯静态资源，直接取。
 *
 * 3. **例句的渲染直接复用 views/jpreader.js。**
 *    歌词页、精读页、语法页的例句用的是同一套分词结果和同一套渲染函数，
 *    所以三处显示完全一致，不会出现"这一页注音方式不一样"。
 *
 * 4. **"没有等级"不等于简单。** 等级筛选刻意不做成"选 N5 就只出 N5 以下"，
 *    而是精确匹配——因为 data/grammar/README.md 里写明了等级是**标注**，
 *    不是难度分级保证。少一点自作聪明的推断，用户看到的就是数据里真实写的。
 *
 * 5. 状态一律走 db.js 封装（`dbPut`/`dbAll`），**不直接开 indexedDB**，
 *    否则会绕过迁移与快照体系，等于绕过硬约束 2 和 3。
 */
import { el, clear, toastOk } from '../ui.js';
import * as db from '../db.js';
import { renderTokens } from './jpreader.js';

const INDEX_URL = '/data/grammar/index.json';

/**
 * 「一览表」的数据（助词 / 副词 / 接续词 / 疑问词速查）。
 *
 * ⚠️ 它是**单独一份数据**，不是语法条目的一部分 —— 一览表只有"词形 + 中文意思"，
 *    而语法条目的 connection / examples 是校验器强制必填的。
 *    为什么不合在一起，见 data/grammar/yilanbiao.json 里的 _说明。
 */
const YILANBIAO_URL = '/data/grammar/yilanbiao.json';

/** 等级顺序（和 tools/build-grammar-index.mjs 的 LEVELS 一致） */
const LEVEL_ORDER = ['N5', 'N4', 'N3', 'N2', 'N1'];

/**
 * 顶部吸顶导览条要**正好贴在导航栏下沿**。
 *
 * ⚠️ 这个 54px 和 theme.css 里 `.nav { height: 54px !important }` 是同一个数。
 *    两处必须一致，否则导览条要么被导航栏盖住一条边，要么中间露一条缝。
 *    tools/test-grammar.mjs 里有一条断言直接读这两个文件，把数字抠出来比对
 *    —— 因为这种"两处必须一样"的常量是最容易在改一处时静默漂掉的。
 *    （改这里就要改 theme.css，反之亦然。）
 */
const NAV_HEIGHT_PX = 54;

/**
 * 模块级：当前挂载的导览上下文 + 键盘监听。
 *
 * 为什么必须放模块级而不是 render() 内部：
 *   `destroy()` 是视图对象上的方法，它**看不见 render() 里的局部变量**。
 *   键盘监听是挂在 document 上的，只有存在模块级才摘得掉 —— 摘不掉的后果是
 *   来回切页面会叠加多个监听器，按一次方向键会**跳两条**（vocab.js 踩过同款）。
 */
let navCtx = null;        // { list, currentId, open, setLevel }
let keyHandler = null;

/** 读出全部语法学习状态，返回以 grammarId 为键的 Map */
async function loadStates() {
  let rows = [];
  try {
    rows = await db.dbAll('grammarState');
  } catch {
    // 状态读不出来不该让整页白屏 —— 顶多是"收藏和已掌握暂时看不到"
    return new Map();
  }
  const m = new Map();
  for (const r of (rows || [])) if (r && r.grammarId) m.set(r.grammarId, r);
  return m;
}

/** 写一条状态。只写变化的字段，保留其它字段 */
async function saveState(id, patch) {
  const cur = await db.dbGet('grammarState', id);
  const rec = {
    grammarId: id,
    favorite: false,
    mastered: false,
    ...(cur || {}),
    ...patch,
    updatedAt: Date.now(),
  };
  await db.dbPut('grammarState', rec);
  return rec;
}

export default {
  id: 'grammar',
  title: '语法教材',
  icon: '文',

  async render(root) {
    // 状态放在 render 内部而不是模块顶层：
    // router 每次进来都会调 render，模块顶层变量会跨次残留。
    const S = {
      index: null,
      byId: new Map(),
      states: new Map(),
      level: '',
      category: '',
      q: '',
      onlyFav: false,
      onlyTodo: false,
      currentId: '',
      entry: null,
      loadingEntry: false,
      showRuby: true,
      indexError: '',
      // 一览表：数据 + 当前选中的分区（'' = 全部）
      yilan: null,
      yilanError: '',
      yilanGroup: '',
      yilanOpen: false,
    };

    // ---- 骨架 ----
    const side = el('div', { class: 'gram-side' });
    const body = el('div', { class: 'gram-body jpr-body' });
    const wrap = el('div', { class: 'gram-wrap' }, [side, body]);
    // 窄屏下 CSS 会把吸顶导览条改成普通流（见 theme.css 里那段注释）。
    // 标记出来是为了让**锚点跳转的补偿量**跟着变 —— 窄屏没有吸顶条，
    // 补偿量要减半，否则 scrollIntoView 会把目标滚到离顶部很远的地方。
    if (window.matchMedia && window.matchMedia('(max-width: 900px)').matches) {
      wrap.setAttribute('data-stickybar', 'off');
    }
    root.appendChild(wrap);

    // ---- 取索引 ----
    try {
      const r = await fetch(INDEX_URL, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      S.index = data;
      for (const it of (data.items || [])) S.byId.set(it.id, it);
    } catch (e) {
      S.indexError = String((e && e.message) || e);
    }
    if (!S.indexError && (!S.index || !(S.index.items || []).length)) {
      S.indexError = '语法索引是空的';
    }
    S.states = await loadStates();

    // ---- 取一览表（可有可无：取不到只是没这个功能，不该让整页报错） ----
    //
    // 为什么和索引用两个独立的 try：一览表是**额外**的东西，
    // 它坏了不该把 470 条语法一起拖下水。所以这里单独 catch、单独提示。
    try {
      const r = await fetch(YILANBIAO_URL, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (!Array.isArray(data.groups) || !data.groups.length) throw new Error('一览表数据是空的');
      S.yilan = data;
    } catch (e) {
      S.yilanError = String((e && e.message) || e);
    }

    // ---- 筛选后的列表 ----
    function filtered() {
      let items = (S.index && S.index.items) || [];
      if (S.level) items = items.filter((x) => x.level === S.level);
      if (S.category) items = items.filter((x) => x.category === S.category);
      if (S.onlyFav) items = items.filter((x) => (S.states.get(x.id) || {}).favorite);
      if (S.onlyTodo) items = items.filter((x) => !(S.states.get(x.id) || {}).mastered);
      if (S.q) {
        const n = S.q.toLowerCase();
        items = items.filter((x) =>
          String(x.title || '').toLowerCase().includes(n) ||
          String(x.meaning || '').toLowerCase().includes(n) ||
          String(x.category || '').toLowerCase().includes(n) ||
          String(x.id || '').toLowerCase().includes(n) ||
          // ⚠️ tags 必须一起搜。原因（实测发现的 bug）：
          //    索引用心良苦地把 tags 收进来了（见 build-grammar-index.mjs 里那段注释），
          //    但**这里从来没查过 tags** —— 于是用户搜「文语」「书面语」「长句」
          //    一条都搜不到。而按概念搜正是初学者最自然的用法：
          //    他不知道自己不知道什么，只能拿一个词去试。
          //    教训：**一个字段"进了数据结构"不等于"到了用户手里"。**
          //    加字段时要顺着它找一遍：索引 → 筛选项 → 渲染 → 搜索 → 测试。
          (Array.isArray(x.tags) ? x.tags : []).some((t) => String(t).toLowerCase().includes(n)));
      }
      return items;
    }

    // ---- 左栏 ----
    function renderSide() {
      side.innerHTML = '';

      if (S.indexError) {
        side.appendChild(el('div', { class: 'banner banner-warn' }, [
          el('strong', { text: '读不到语法数据：' }),
          el('span', { text: S.indexError }),
        ]));
        side.appendChild(el('div', { class: 'gram-empty' }, [
          el('div', { text: '如果这是第一次运行，可能是索引还没生成。' }),
          el('div', { class: 'gram-src', text: '在项目目录执行：node tools/build-grammar-index.mjs' }),
        ]));
        return;
      }

      // 搜索
      const search = el('input', {
        class: 'jpr-input gram-search', type: 'search',
        placeholder: '搜标题 / 意思 / 分类 / 标签…',
        value: S.q,
        oninput: (e) => { S.q = e.target.value; renderList(); },
      });
      side.appendChild(search);

      const levels = (S.index.levels || []).slice()
        .sort((a, b) => LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b));

      // 等级
      if (levels.length) {
        side.appendChild(el('div', { class: 'gram-side-label', text: '等级' }));
        const row = el('div', { class: 'gram-filters' });
        const mk = (label, val) => el('button', {
          class: 'gram-chip' + (S.level === val ? ' is-on' : ''),
          type: 'button', text: label,
          onclick: () => { S.level = val; renderSide(); renderList(); },
        });
        row.appendChild(mk('全部', ''));
        for (const lv of levels) row.appendChild(mk(lv, lv));
        side.appendChild(row);
      }

      // 分类
      if ((S.index.categories || []).length) {
        side.appendChild(el('div', { class: 'gram-side-label', text: '分类' }));
        const row = el('div', { class: 'gram-filters' });
        const mk = (label, val) => el('button', {
          class: 'gram-chip' + (S.category === val ? ' is-on' : ''),
          type: 'button', text: label,
          onclick: () => { S.category = val; renderSide(); renderList(); },
        });
        row.appendChild(mk('全部', ''));
        for (const c of S.index.categories) row.appendChild(mk(c, c));
        side.appendChild(row);
      }

      // 一览表（速查）—— 单独一行、放在分类下面，不混进那 26 个分类 chip 里。
      //
      // 为什么不混进去：一览表和"分类筛选"是**两种不同的东西** ——
      // 分类是在 470 条详讲里筛，一览表是**另一份数据**（只有词形+意思）。
      // 混在一排里，用户会以为点「副词」和点「副词分类」是同一件事。
      if (S.yilan) {
        const total = S.yilan.groups.reduce((n, g) => n + (g.items || []).length, 0);
        side.appendChild(el('div', { class: 'gram-side-label', text: '速查' }));
        const rowY = el('div', { class: 'gram-filters' });
        rowY.appendChild(el('button', {
          class: 'gram-chip gram-chip-wide' + (S.yilanOpen ? ' is-on' : ''),
          type: 'button',
          dataset: { yilan: 'toggle' },
          text: `一览表 (${total})`,
          title: '助词 / 副词 / 接续词 / 疑问词速查表 —— 只有词形和中文意思，要例句和接续请看详讲',
          onclick: () => { S.yilanOpen = !S.yilanOpen; S.yilanGroup = ''; renderSide(); renderBody(); },
        }));
        side.appendChild(rowY);
      }

      // 收藏 / 未掌握
      const favCount = [...S.states.values()].filter((x) => x.favorite).length;
      const rows2 = el('div', { class: 'gram-filters' });
      rows2.appendChild(el('button', {
        class: 'gram-chip' + (S.onlyFav ? ' is-on' : ''), type: 'button',
        text: '★ 收藏' + (favCount ? ` (${favCount})` : ''),
        onclick: () => { S.onlyFav = !S.onlyFav; renderSide(); renderList(); },
      }));
      rows2.appendChild(el('button', {
        class: 'gram-chip' + (S.onlyTodo ? ' is-on' : ''), type: 'button',
        text: '未掌握',
        onclick: () => { S.onlyTodo = !S.onlyTodo; renderSide(); renderList(); },
      }));
      side.appendChild(rows2);

      side.appendChild(el('div', { class: 'gram-list', id: 'gram-list-host' }));
      renderList();
    }

    function renderList() {
      const host = side.querySelector('#gram-list-host');
      if (!host) return;
      host.innerHTML = '';

      // 一览表打开时，左栏换成"分区"选择（助词 / 副词 / 接续词 / 疑问词）
      if (S.yilanOpen) return renderYilanList(host);

      const items = filtered();
      if (!items.length) {
        // 空结果要说清"是筛没了"还是"本来就没有" —— 否则用户以为功能坏了
        host.appendChild(el('div', { class: 'gram-empty', text:
          (S.q || S.level || S.category || S.onlyFav || S.onlyTodo)
            ? '没有符合条件的语法。试试清掉筛选条件。'
            : '这个等级还没有内容。' }));
        return;
      }
      for (const it of items) {
        const st = S.states.get(it.id) || {};
        host.appendChild(el('button', {
          class: 'gram-row' + (S.currentId === it.id ? ' is-on' : ''),
          type: 'button', dataset: { id: it.id },
          onclick: () => openEntry(it.id),
        }, [
          el('div', { class: 'gram-row-top' }, [
            el('span', { class: 'gram-row-lv', text: it.level }),
            el('span', { class: 'gram-row-title', text: it.title }),
            st.favorite ? el('span', { class: 'gram-star', text: '★' }) : null,
            st.mastered ? el('span', { class: 'gram-done', text: '✓' }) : null,
          ]),
          el('div', { class: 'gram-row-cat', text: it.category }),
          // title 属性：左栏简介被 CSS 截到 3 行，鼠标悬停能看到完整内容
          el('div', { class: 'gram-row-meaning', text: it.meaning, title: it.meaning }),
        ]));
      }
    }

    // ---- 一览表（速查）----
    //
    // 和上面 renderList 的分工：那个是"470 条详讲"的列表，这个是"另一份数据"的速查表。
    // 两者的数据来源、字段、用途都不同，所以**刻意不共用渲染函数** ——
    // 硬塞进一个函数会让"一览表为什么没有例句"这类问题变得难查。

    /** 左栏：一览表打开时显示分区选择 */
    function renderYilanList(host) {
      const groups = S.yilan ? (S.yilan.groups || []) : [];
      host.appendChild(el('div', { class: 'gram-side-label', text: '分区' }));
      // ⚠️ 这一排必须和上面"分类"那一排区分开：两排里都有「副词」这个字样的 chip，
      //    而它们含义不同（一个是筛 470 条详讲，一个是筛一览表的 36 条速查）。
      //    给容器和每个 chip 加上 data 属性，是为了让界面自检能**按语义**找到它们，
      //    而不是靠文字匹配 —— 靠文字匹配必然抓到错的那个
      //    （本项目的 qa-grammar 就这么误报过一次）。
      const row = el('div', { class: 'gram-filters gram-yilan-filters', dataset: { yilan: 'filters' } });
      const mkGroup = (label, val, count) => el('button', {
        class: 'gram-chip' + (S.yilanGroup === val ? ' is-on' : ''),
        type: 'button',
        dataset: { ygroup: val || 'all' },
        text: count === null ? label : `${label} ${count}`,
        onclick: () => {
          S.yilanGroup = val;
          renderSide();
          renderBody();
        },
      });
      const total = groups.reduce((n, g) => n + (g.items || []).length, 0);
      row.appendChild(mkGroup('全部', '', total));
      for (const g of groups) row.appendChild(mkGroup(g.name, g.id, (g.items || []).length));
      host.appendChild(row);

      host.appendChild(el('div', { class: 'gram-empty gram-yilan-hint' }, [
        el('div', { text: '一览表只有词形和中文意思 —— 这是速查，不是详讲。' }),
        el('div', { text: '要看接续规则、例句、易混对比，点上面的「全部」回到分类，或在上面的搜索框里搜这个词。' }),
      ]));
    }

    /** 右栏：一览表的密集表格 */
    function renderYilanTable() {
      const groups = (S.yilan && S.yilan.groups) || [];
      const shown = S.yilanGroup ? groups.filter((g) => g.id === S.yilanGroup) : groups;
      const total = shown.reduce((n, g) => n + (g.items || []).length, 0);

      body.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, [
          el('div', { class: 'gram-head' }, [
            el('h2', { text: '一览表' }),
            el('span', { class: 'gram-row-cat', text:
              S.yilanGroup ? (shown[0] || {}).name || '' : '助词 / 副词 / 接续词 / 疑问词' }),
            el('span', { class: 'gram-row-lv', text: `${total} 条` }),
          ]),
        ]),
        el('p', { class: 'gram-yilan-lead', text:
          '这是 L5-12 的速查页，只有词形和中文意思。需要接续、例句、易混对比时，' +
          '点左栏的「全部」回到分类，或在搜索框里搜这个词 —— 那边有 470 条详讲。' }),
        // ⚠️ 这里**故意不显示** `yilanbiao.json` 里的 `_说明`（"这份表是怎么来的"）。
        //    用户明确说：「一览表里"这份表是怎么来的"没必要写，去掉」。
        //    理由站得住：用户来这一页是**查词**的，不是查出处的。
        //    `_说明` 字段**保留在 JSON 里** —— 它是给维护的人看的
        //    （为什么单独一份文件、哪个字是 PDF 的错字），
        //    只是不该出现在用户面前。**别再加回界面。**
      ]));

      for (const g of shown) {
        const card = el('div', { class: 'card' });
        card.appendChild(el('div', { class: 'card-title' }, [
          el('h3', { text: `${g.name}（${(g.items || []).length}）` }),
        ]));
        if (g.note) card.appendChild(el('div', { class: 'gram-yilan-note', text: g.note }));

        const table = el('table', { class: 'yilan-table' });
        table.appendChild(el('thead', {}, [
          el('tr', {}, [
            el('th', { class: 'yilan-th-word', text: '词形' }),
            el('th', { class: 'yilan-th-yomi', text: '读法' }),
            el('th', { class: 'yilan-th-zh', text: '中文意思' }),
          ]),
        ]));
        const tbody = el('tbody');
        for (const it of (g.items || [])) {
          tbody.appendChild(el('tr', {}, [
            // 词形用日文字体；`〜` 是"接在别的东西后面/前面"的占位
            el('td', { class: 'yilan-word', text: it.word }),
            el('td', { class: 'yilan-yomi', text: it.yomi || '—' }),
            el('td', { class: 'yilan-zh', text: it.zh }),
          ]));
        }
        table.appendChild(tbody);
        card.appendChild(table);
        body.appendChild(card);
      }
    }

    // ---- 阅读位置：上一句 / 下一句 ----
    //
    // ────────────────────────────────────────────────────────────────────
    // 为什么加这一块（用户的原话：「只靠鼠标滚轮的形式有点太不优雅了」）
    // ────────────────────────────────────────────────────────────────────
    // 原来的语法页是"左栏列表 + 右栏正文"两栏各自滚动：
    //   想连着读下一条，得先把右栏滚到底、再去左栏里找到自己刚才那一条、
    //   往下点一格、再回来从头读。**每读一条要滚两次、找一次**，
    //   条目一多（现在 660 多条）就非常难受。
    //
    // 所以补上"顺序阅读"这条路：上一条 / 下一条 / 标记已掌握并继续，
    // 外加键盘（←→ 翻条，↑↓ 滚正文）。导航顺序**就是当前筛选结果的顺序**，
    // 于是"筛出 N3 的所有条件句、然后一条条读完"变成了两下按键的事。
    //
    // ⚠️ 这里必须用 filtered() 的结果而不是整个索引：
    //    用户看到的顺序 = 列表里的顺序。如果翻页顺序和列表顺序不一致，
    //    用户按"下一条"会跳到列表里完全没挨着的地方，比没有这个功能更困惑。
    function navList() {
      return filtered();
    }

    /** 当前条目在筛选结果里的下标；不在里面（比如从"相关条目"跳进来的）返回 -1 */
    function navIndex() {
      const list = navList();
      return list.findIndex((x) => x.id === S.currentId);
    }

    /**
     * 跳到筛选结果里相对位置 ±1 的一条。
     * 到头了**明确告诉用户**，不要静默什么都不做 —— 静默失败会被当成功能坏了。
     */
    function gotoOffset(delta) {
      const list = navList();
      const i = navIndex();
      if (i < 0) {
        // 当前条目不在筛选结果里（被筛掉了）。这时"下一条"的含义就是第一条。
        if (list.length) openEntry(list[0].id);
        return;
      }
      const j = i + delta;
      if (j < 0) { toastOk('已经是第一条了'); return; }
      if (j >= list.length) { toastOk('已经是最后一条了'); return; }
      openEntry(list[j].id);
    }

    // ---- 键盘快捷键 ----
    //
    // 为什么是这四个键：
    //   ← →  翻上一条/下一条（文档式的"翻页"，和读书一致）
    //   ↑ ↓  滚正文（不想动鼠标时的最小需求；交给浏览器原生滚动，不自己实现）
    // 输入框里打字时不接管（否则在搜索框里按左右键会跳条目）。
    // 另外**不抢组合键**：Ctrl/Alt/Meta 按下的都放行，
    // 否则会盖掉浏览器自己的 Ctrl+F、Alt+← 等。
    function onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); gotoOffset(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); gotoOffset(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); window.scrollBy({ top: -220, behavior: 'smooth' }); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); window.scrollBy({ top: 220, behavior: 'smooth' }); }
    }

    navCtx = {
      currentId: () => S.currentId,
      open: (id) => openEntry(id),
      gotoOffset,
      // 供测试与"当前进度"显示用
      list: () => navList(),
      // 让正文里的"标记已掌握并继续"能重画左栏（收藏/未掌握筛选会变）
      redraw: () => { renderSide(); },
    };

    /** 本页目录：点一下就滚到那一节（长条目不用一直往下滚） */
    function tocCard(it) {
      const items = [];
      if (it.connection) items.push(['conn', '接续']);
      if (it.meaning) items.push(['mean', '意思']);
      if (it.detail) items.push(['detail', '详细说明']);
      if (Array.isArray(it.examples) && it.examples.length) items.push(['ex', `例句（${it.examples.length}）`]);
      if (Array.isArray(it.confusions) && it.confusions.length) items.push(['conf', '容易混的地方']);
      if (Array.isArray(it.mistakes) && it.mistakes.length) items.push(['mist', '常见的错']);
      if (Array.isArray(it.related) && it.related.length) items.push(['rel', '相关条目']);
      // 一节都没有就别显示目录（否则是个空壳卡片）
      if (items.length < 2) return null;
      const c = el('div', { class: 'card gram-toc' });
      c.appendChild(el('div', { class: 'card-title' }, [
        el('h3', { text: '本页目录' }),
        el('span', { class: 'jpr-hint', text: '点一下跳过去' }),
      ]));
      const row = el('div', { class: 'gram-toc-row' });
      for (const [key, label] of items) {
        row.appendChild(el('button', {
          class: 'gram-chip gram-toc-go', type: 'button',
          dataset: { sec: key },
          text: label,
          onclick: () => {
            const target = body.querySelector(`[data-sec="${key}"]`);
            // ⚠️ 找不到就明确报错，不要静默 —— 静默会让用户以为"点了没反应"
            if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            else toastOk('这一节在当前条目里找不到');
          },
        }));
      }
      c.appendChild(row);
      return c;
    }

    /**
     * 顶部吸顶导览条。
     *
     * ⚠️ 这个导览条**不放在卡片里**，而是独立一节直接吸在 `.gram-body` 顶部。
     *    原因：`.gram-body` 是 `display:flex; flex-direction:column`，
     *    Sticky 想要生效，元素必须是"滚动容器里正常流中的子元素"，
     *    而且不能被祖先的 overflow 截断（theme.css 里记过这个坑）。
     *    `.gram-wrap` 是 grid、`.gram-body` 没有 overflow，所以 sticky 可用。
     */
    function readBar() {
      const list = navList();
      const i = navIndex();
      const total = list.length;
      const pos = i >= 0 ? `${i + 1} / ${total}` : `不在当前筛选里（共 ${total} 条）`;
      const bar = el('div', { class: 'gram-readbar', dataset: { role: 'readbar' } });
      bar.appendChild(el('div', { class: 'gram-readbar-pos', dataset: { role: 'pos' }, text: pos }));
      bar.appendChild(el('div', { class: 'gram-readbar-title', text: (S.entry && S.entry.title) || S.currentId || '' }));
      const mk = (label, title, fn, act, disabled) => el('button', {
        class: 'gram-chip gram-readbar-btn', type: 'button', title,
        dataset: { act },
        disabled: disabled ? true : null,
        text: label,
        onclick: fn,
      });
      bar.appendChild(mk('← 上一条', '上一条（键盘 ←）', () => gotoOffset(-1), 'prev', i <= 0));
      const st = (S.entry && S.states.get(S.entry.id)) || {};
      bar.appendChild(el('button', {
        class: 'gram-chip gram-readbar-btn is-primary', type: 'button',
        title: '标记为已掌握，然后直接看下一条',
        dataset: { act: 'next-done' },
        text: st.mastered ? '✓ 下一条' : '✓ 记住了，下一条',
        onclick: async () => {
          const it = S.entry;
          if (!it || it.__error) { gotoOffset(1); return; }
          await saveState(it.id, { mastered: true });
          const rec = await db.dbGet('grammarState', it.id);
          S.states.set(it.id, rec || { grammarId: it.id, mastered: true });
          gotoOffset(1);
        },
      }));
      bar.appendChild(mk('下一条 →', '下一条（键盘 →）', () => gotoOffset(1), 'next', i >= 0 && i + 1 >= total));
      bar.appendChild(el('span', { class: 'gram-readbar-hint', text: '键盘：← → 翻条，↑ ↓ 滚动' }));
      return bar;
    }
    async function openEntry(id) {
      S.currentId = id;
      S.entry = null;
      S.loadingEntry = true;
      renderList();
      renderBody();
      try {
        const r = await fetch(`/api/grammar/entry?id=${encodeURIComponent(id)}`, { cache: 'no-cache' });
        const data = await r.json();
        if (!data.ok) throw new Error(data.error || '读取失败');
        if (S.currentId !== id) return; // 用户已经点了别的
        S.entry = data.item;
      } catch (e) {
        if (S.currentId !== id) return;
        S.entry = { __error: String((e && e.message) || e) };
      } finally {
        if (S.currentId === id) { S.loadingEntry = false; renderBody(); }
      }
    }

    function renderBody() {
      body.innerHTML = '';

      // 一览表是一个**独立模式**：打开它时右栏整体换成表格，
      // 不显示某一条详讲（两者在界面上是并列的两个入口，不叠加）。
      if (S.yilanOpen) return renderYilanTable();

      if (!S.currentId) {
        body.appendChild(el('div', { class: 'card' }, [
          el('div', { class: 'card-title' }, [el('h2', { text: '语法教材' })]),
          el('p', { text: '从左边挑一条语法。每条都包含接续规则、意思、中日对照例句、易混对比和常见错误。' }),
          el('div', { class: 'banner banner-info' }, [
            el('strong', { text: '关于内容：' }),
            // ⚠️ 这段文案原来写的是"只放了 10 条样例"—— 那是**很久以前**的
            //    状态。库早就过百条了，而界面还在说 10 条。
            //    "界面在说假话"比"界面简陋"更伤：用户会以为功能没做完。
            //    所以这里**不再写死数字**，改成让页面自己去数。
            el('span', { text: `现在是 ${((S.index && S.index.items) || []).length} 条，两条线并行：` +
              '应试线（JLPT，N5→N1）和书面语阅读线（为了读《我是猫》这类原著）。' +
              '每条都包含接续规则、意思、中日对照例句、易混对比、常见错误和相关条目。' +
              '内容会继续分批补，往 data/grammar/ 里加 JSON 就行，不用改代码。' }),
          ]),
        ]));
        return;
      }

      if (S.loadingEntry) {
        body.appendChild(el('div', { class: 'card' }, [el('div', { class: 'gram-empty', text: '读取中…' })]));
        return;
      }

      const it = S.entry;
      if (!it) return;
      if (it.__error) {
        body.appendChild(el('div', { class: 'card' }, [
          el('div', { class: 'banner banner-error' }, [
            el('strong', { text: '读不到这一条：' }), el('span', { text: it.__error }),
          ]),
        ]));
        return;
      }

      const st = S.states.get(it.id) || {};

      // 顶部吸顶导览条：位置 + 上一条 / 记住了，下一条 / 下一条。
      // 放在所有卡片**之前**，这样它吸在 .gram-body 顶部时不会盖住正文。
      body.appendChild(readBar());

      // 本页目录（长条目的第一屏出口）
      const toc = tocCard(it);
      if (toc) body.appendChild(toc);

      // 头部：标题 + 收藏/已掌握
      const head = el('div', { class: 'card' });
      head.appendChild(el('div', { class: 'card-title' }, [
        el('div', { class: 'gram-head' }, [
          el('h2', { text: it.title }),
          el('span', { class: 'gram-row-lv', text: it.level }),
          el('span', { class: 'gram-row-cat', text: it.category }),
        ]),
      ]));
      head.appendChild(el('div', { class: 'gram-meta' }, [
        // dataset.act 是给"怎么区分这两个按钮"用的：
        // 左栏筛选里也有一个文案几乎一样的「★ 收藏」chip，
        // 光靠文字找会找错（测试里就踩过）。带上语义标记最省事。
        el('button', {
          class: 'gram-chip' + (st.favorite ? ' is-on' : ''), type: 'button',
          dataset: { act: 'favorite' },
          text: st.favorite ? '★ 已收藏' : '☆ 收藏',
          onclick: async () => {
            const rec = await saveState(it.id, { favorite: !st.favorite });
            S.states.set(it.id, rec);
            renderSide(); renderBody();
            toastOk(rec.favorite ? '已加入收藏' : '已取消收藏');
          },
        }),
        el('button', {
          class: 'gram-chip' + (st.mastered ? ' is-on' : ''), type: 'button',
          dataset: { act: 'mastered' },
          text: st.mastered ? '✓ 已掌握' : '标记为已掌握',
          onclick: async () => {
            const rec = await saveState(it.id, { mastered: !st.mastered });
            S.states.set(it.id, rec);
            renderSide(); renderBody();
            toastOk(rec.mastered ? '已标记为掌握' : '已取消"已掌握"');
          },
        }),
        st.updatedAt ? el('span', { class: 'jpr-hint', text: `上次更新：${new Date(st.updatedAt).toLocaleDateString('zh-CN')}` }) : null,
      ].filter(Boolean)));
      body.appendChild(head);

      // 接续规则（自学最容易错的地方，所以放最显眼的位置）
      //
      // ⚠️ 这一段和下面的"意思／详细说明"原来是和标题挤在同一个卡片里的。
      //    拆成独立卡片是为了让"本页目录"能跳到这里 —— 之前 `data-sec` 标在
      //    同一个卡片上，`querySelector('[data-sec=conn]')` 只会找到卡片起点，
      //    点"意思"也会滚到"接续"那一行，等于跳错位置。
      //    一个滚动目标 = 一个元素，这条不能省。
      const connCard = el('div', { class: 'card' });
      connCard.appendChild(el('div', { class: 'gram-conn', dataset: { sec: 'conn' } }, [
        el('span', { class: 'gram-conn-k', text: '接续' }),
        el('span', { class: 'gram-conn-v', text: it.connection || '—' }),
      ]));
      body.appendChild(connCard);

      // 意思 + 详细说明（同一节，目录里也合成一项）
      const meanCard = el('div', { class: 'card' });
      meanCard.appendChild(el('div', { class: 'gram-mean', dataset: { sec: 'mean' }, text: it.meaning || '' }));
      if (it.detail) {
        meanCard.appendChild(el('div', { class: 'gram-detail', dataset: { sec: 'detail' }, text: it.detail }));
      }
      meanCard.appendChild(el('div', { class: 'gram-toc-row' }, [
        el('span', { class: 'jpr-hint', text: '上面这些看懂了吗？' }),
        el('button', {
          class: 'gram-chip gram-readbar-btn', type: 'button',
          dataset: { act: 'back-top' },
          text: '↑ 回到顶部',
          onclick: () => window.scrollTo({ top: 0, behavior: 'smooth' }),
        }),
      ]));
      body.appendChild(meanCard);

      // 例句
      const exCard = el('div', { class: 'card', dataset: { sec: 'ex' } });
      exCard.appendChild(el('div', { class: 'card-title' }, [
        el('div', { class: 'gram-head' }, [
          el('h2', { text: '例句' }),
          el('button', {
            class: 'gram-chip' + (S.showRuby ? ' is-on' : ''), type: 'button',
            text: S.showRuby ? '有振假名' : '无振假名',
            onclick: () => { S.showRuby = !S.showRuby; renderBody(); },
          }),
        ]),
      ]));

      const examples = Array.isArray(it.examples) ? it.examples : [];
      if (!examples.length) {
        exCard.appendChild(el('div', { class: 'gram-empty', text: '这一条还没有例句。' }));
      }
      for (const ex of examples) {
        const exEl = el('div', { class: 'gram-ex' });
        if (ex.reading && Array.isArray(ex.reading.tokens)) {
          // 复用歌词页/精读页的渲染器，三处显示完全一致。
          // renderTokens 只认 { ruby, romaji, onWord } 三个选项，多传的会被忽略。
          exEl.appendChild(el('div', { class: 'gram-ex-ja' }, [
            renderTokens(ex.reading.tokens, { ruby: S.showRuby, romaji: false }),
          ]));
        } else {
          // 词库没就绪时**不要假装**：直接原文显示，并说明原因
          exEl.appendChild(el('div', { class: 'gram-ex-ja', text: ex.ja }));
          if (ex.readingError) {
            exEl.appendChild(el('div', { class: 'jpr-hint', text: `（注音暂时不可用：${ex.readingError}）` }));
          }
        }
        if (ex.zh) exEl.appendChild(el('div', { class: 'gram-ex-zh', text: ex.zh }));
        if (ex.note) exEl.appendChild(el('div', { class: 'gram-ex-note', text: ex.note }));
        exCard.appendChild(exEl);
      }
      body.appendChild(exCard);

      // 易混对比
      if (Array.isArray(it.confusions) && it.confusions.length) {
        const c = el('div', { class: 'card', dataset: { sec: 'conf' } });
        c.appendChild(el('div', { class: 'card-title' }, [el('h3', { text: '容易混的地方' })]));
        for (const cf of it.confusions) {
          const box = el('div', { class: 'gram-conf' });
          box.appendChild(el('div', { class: 'gram-conf-w', text: `和「${cf.with}」的区别` }));
          box.appendChild(el('div', { class: 'gram-conf-d', text: cf.diff || '' }));
          if (cf.example && cf.example.ja) {
            box.appendChild(el('div', { class: 'gram-conf-ex', text: cf.example.ja }));
            if (cf.example.zh) box.appendChild(el('div', { class: 'gram-ex-zh', text: cf.example.zh }));
          }
          c.appendChild(box);
        }
        body.appendChild(c);
      }

      // 常见错误
      if (Array.isArray(it.mistakes) && it.mistakes.length) {
        const c = el('div', { class: 'card', dataset: { sec: 'mist' } });
        c.appendChild(el('div', { class: 'card-title' }, [el('h3', { text: '常见的错' })]));
        c.appendChild(el('ul', { class: 'gram-mistakes' },
          it.mistakes.map((m) => el('li', { text: m }))));
        body.appendChild(c);
      }

      // 相关条目（跨等级、跨线）
      //
      // ⚠️ 为什么单独做这一块：语法库是**按难度归档**的，所以同一个语法点
      //    在不同难度的讲法分散在不同文件里。用户看到 n3-j-ni-tsurete
      //    （〜につれて）时，书面语线的 n3-l1-to-tomo-ni（〜とともに／
      //    〜に伴って）**完全摸不到** —— 而这恰恰是"语法是系统不是孤点"
      //    最需要连起来的地方。
      //
      // 标题从 S.byId 反查（索引里就有），所以 relations.json 只存 id 和理由，
      // **标题改了不用同步改关系表**。
      if (Array.isArray(it.related) && it.related.length) {
        const c = el('div', { class: 'card', dataset: { sec: 'rel' } });
        c.appendChild(el('div', { class: 'card-title' }, [
          el('h3', { text: '相关条目' }),
          el('span', { class: 'jpr-hint', text: '点一下就跳过去' }),
        ]));
        for (const rel of it.related) {
          const target = S.byId.get(rel.to);
          const row = el('div', { class: 'gram-rel' });
          if (target) {
            row.appendChild(el('button', {
              class: 'gram-rel-go', type: 'button',
              // 让用户知道跳过去是什么等级/哪条线，不然会"跳得莫名其妙"
              title: `${target.level}・${target.line === 'written' ? '书面语线' : '应试线'}`,
              text: `${target.title || target.id}`,
              onclick: () => { openEntry(rel.to); },
            }));
          } else {
            // 理论上进不来：check-related.mjs 会拦住悬空 id。
            // 但万一拦漏了，也**明确说"这条找不到"**，不要装作没有这回事。
            row.appendChild(el('span', { class: 'gram-rel-go is-missing', text: `（找不到条目 ${rel.to}）` }));
          }
          if (rel.why) row.appendChild(el('div', { class: 'gram-rel-why', text: rel.why }));
          c.appendChild(row);
        }
        body.appendChild(c);
      }

      // 标签 + 一句数据说明
      //
      // ⚠️ 这里原来还会显示一行「来源：……」（用户要求去掉）。
      //    去掉的是**界面显示**，不是数据：
      //    `data/grammar/*.json` 里的 `source` 字段仍然完整保留，
      //    它是内容诚实性的一部分（哪个批次、哪份清单来的），
      //    由 `tools/test-grammar.mjs` [5] 和 `audit-phases.mjs` 盯着。
      //
      //    为什么可以这样拆开：**"记录来源"和"每条都展示来源"是两件不同的事。**
      //    来源的价值在于**可追溯**（出问题时能查是谁写的），
      //    而不在于每读一条语法都看一遍"本项目自编（N5 地基批……）"。
      //    实测那条 source 最长有 100 多字，混在例句后面既占地方又打断阅读。
      const foot = el('div', { class: 'card' });
      if (Array.isArray(it.tags) && it.tags.length) {
        foot.appendChild(el('div', { class: 'gram-tags' },
          it.tags.map((t) => el('span', { class: 'gram-chip', text: t }))));
      }
      foot.appendChild(el('div', { class: 'gram-src' }, [
        el('div', { text: '你的收藏和「已掌握」记在本机浏览器里，跟着"导出全部数据"一起走。' }),
      ]));
      body.appendChild(foot);
    }

    renderSide();
    renderBody();

    // 如果列表里正好有一条，自动打开它，省用户一次点击
    const first = filtered()[0];
    if (first) openEntry(first.id);

    // ---- 挂键盘快捷键 ----
    // ⚠️ 先摘旧的再挂新的。router 每次进入都会调 render()，如果只挂不摘，
    //    来回切几次页面就会叠加多个监听器 —— 表现是"按一次 → 跳两条"。
    //    destroy() 里也摘一次（见文件末尾），两条路都必须有。
    if (keyHandler) document.removeEventListener('keydown', keyHandler);
    keyHandler = onKey;
    document.addEventListener('keydown', keyHandler);
  },

  destroy() {
    // 见文件头：键盘监听挂在 document 上，只有模块级变量能摘掉它
    if (keyHandler) {
      document.removeEventListener('keydown', keyHandler);
      keyHandler = null;
    }
    navCtx = null;
  },
};
