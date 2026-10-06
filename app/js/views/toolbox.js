/**
 * 工具箱：三件自学者查不到、但天天要用的语言学小事。
 *
 * 为什么是这三个（而不是别的）：
 *   1. 活用还原器 —— 词典**只收辞书形**。看到 使って / 食べさせられた /
 *      書かなければ，学习者根本不知道该拿哪个形去查。还原规则其实早就有了
 *      （tools/tokenizer.js，有单元测试守着），但一直藏在「查词」抽屉后面，
 *      用户看不到"它是怎么变来的"。
 *   2. 汉字读音反查 —— 多音字是真难点（日=ひ/にち/じつ/か、
 *      生=せい/い/う/しょう/なま）。data/index/readings.json 里已经有
 *      17,491 条"读音 → 词条"的反查索引，但一直没有界面用上它。
 *   3. 数字・日期・量词读法 —— 纯规则、完全离线，而且是教科书里最容易被
 *      忽略的一块：4月14日 读 しがつじゅうよっか 而不是 よんがつじゅうよんにち；
 *      3本/3枚/3匹 的促音便与连浊各不相同。
 *
 * 为什么**没有**第四、第五个工具（都明确砍掉了）：
 *   - 「查词」：全局速查抽屉已经做了（Ctrl+Shift+F / 侧栏「速查」），
 *     结果优先级 生词本 → 内置词库缓存 → 服务端 /api/dict/lookup（带活用还原），
 *     每条都能一键加入生词本。在工具箱里再放一份是纯粹的重复。
 *   - 「假名练习」：用户已明确否决。
 *   - 「词表格式转换」：降到「数据与设置 → 导入」里，它本来就是导入的一环。
 *
 * 数据来源说明（诚实标注，避免用户误当权威）：
 *   - 读音反查读的是 data/index/readings.json，来自内置 JLPT 词库，
 *     与「背单词」用的是同一份数据；中文释义由上游 LLM 生成，仅作提示。
 *   - 数字读法里凡是能命中内置词库的（4月=しがつ、3本=さんぼん…），
 *     都会把词库读音一并显示出来，方便用户自己对照，不是我说了算。
 */
import { el } from '../ui.js';
// 数字・日期・量词的规则引擎（纯函数模块，视图与校验脚本共用同一份规则）
import {
  numberReading, dayReading, monthReading, hourReading, COUNTERS, counterReading,
} from '../counter.js';
// 活用（变形）正向规则引擎（纯函数模块，视图与校验脚本共用同一份规则）
import { conjugate, ruleTable, TYPE_LABELS, CHOOSABLE_TYPES } from '../conj.js';

const TABS = [
  { id: 'deinflect', label: '活用还原器' },
  { id: 'conj', label: '动词・形容词变形表' },
  { id: 'reading', label: '汉字读音反查' },
  { id: 'counter', label: '数字・日期・量词' },
];

/**
 * 汉字读音反查要用的两份索引。都是大文件（terms 1.3MB / readings 638KB），
 * 所以**按需加载一次**并缓存，不在页面渲染时就拉。
 * 用 dynamic import 不行（它们是 JSON 不是模块），走 fetch。
 */
let idxCache = null;
let idxLoading = null;
function loadIndex() {
  if (idxCache) return Promise.resolve(idxCache);
  if (idxLoading) return idxLoading;
  idxLoading = Promise.all([
    fetch('/data/index/terms.json').then((r) => r.json()),
    fetch('/data/index/readings.json').then((r) => r.json()),
    fetch('/data/index/lookup.json').then((r) => r.json()),
  ]).then(([termsDoc, readingsDoc, lookupDoc]) => {
    idxCache = {
      terms: termsDoc.terms || {},
      readings: readingsDoc.keys || {},
      lookup: lookupDoc.keys || {},
    };
    return idxCache;
  }).catch((e) => {
    idxLoading = null;
    throw e;
  });
  return idxLoading;
}

// ---------------------------------------------------------------------------
// 工具 1：活用还原器
// ---------------------------------------------------------------------------

function renderDeinflect(host) {
  const input = el('input', {
    class: 'input',
    type: 'text',
    placeholder: '输入活用形，例如：使って / 食べさせられた / 書かなければ',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const btn = el('button', { class: 'btn', text: '还原' });
  const out = el('div', { class: 'tool-out' });

  const SAMPLES = ['使って', '食べさせられた', '書かなければ', '話しています', '静かだった', '勉強した'];

  async function run(q) {
    const text = String(q == null ? input.value : q).trim();
    if (!text) { out.innerHTML = ''; return; }
    out.innerHTML = '';
    out.appendChild(el('div', { class: 'loading', text: '还原中…' }));
    try {
      const r = await fetch('/api/deinflect?q=' + encodeURIComponent(text)).then((x) => x.json());
      out.innerHTML = '';
      if (!r.ok) {
        out.appendChild(el('div', { class: 'banner banner-error' }, [
          el('strong', { text: '出错了：' }), el('span', { text: r.error || '未知错误' }),
        ]));
        return;
      }
      if (!r.found) {
        out.appendChild(el('div', { class: 'empty' }, [
          el('div', { class: 'empty-title', text: '没能还原出辞书形' }),
          el('div', { class: 'empty-hint', text: '可能是专有名词、人名、或者拼写有误。也可能它本身就是辞书形，但不在内置词库里。' }),
        ]));
        return;
      }
      for (const item of r.results) out.appendChild(deinflectCard(item, text));
    } catch (e) {
      out.innerHTML = '';
      out.appendChild(el('div', { class: 'banner banner-error' }, [
        el('strong', { text: '请求失败：' }), el('span', { text: String((e && e.message) || e) }),
      ]));
    }
  }

  btn.addEventListener('click', () => run());
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });

  host.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, [
      el('h3', { text: '活用还原器' }),
      el('span', { class: 'badge', text: '离线' }),
    ]),
    el('p', { class: 'dim', text: '词典只收辞书形。把看到的形式粘进来，它告诉你「拿掉了哪段语尾、词干怎么归位」，' +
      '最后给出该去查的那个形。' }),
    el('div', { class: 'tool-row' }, [input, btn]),
    el('div', { class: 'tool-samples' }, [
      el('span', { class: 'faint', text: '试试：' }),
      ...SAMPLES.map((s) => el('button', {
        class: 'chip', text: s,
        onclick: () => { input.value = s; run(s); },
      })),
    ]),
    out,
  ]));
}

function deinflectCard(item, original) {
  const head = el('div', { class: 'tool-head' }, [
    el('span', { class: 'tool-from', text: item.surface || original }),
    el('span', { class: 'tool-arrow', text: '→' }),
    el('span', { class: 'tool-to', text: item.dict }),
    item.dictReading ? el('span', { class: 'tool-reading', text: '（' + item.dictReading + '）' }) : null,
    item.level ? el('span', { class: 'badge', text: item.level }) : null,
  ].filter(Boolean));

  const steps = el('ol', { class: 'tool-steps' });
  for (const s of (item.steps || [])) {
    // 只在 from/to 真的有区别时显示箭头对照。
    // 第 ① 步（input）两者相同，第 ④ 步（result）后端刻意写成 from===to，
    // 不做这个判断就会出现「食べた → 食べた」这种废话。
    const pair = (s.from && s.to && s.from !== s.to) ? s.from + ' → ' + s.to : '';
    steps.appendChild(el('li', { class: 'tool-step tool-step-' + s.kind }, [
      el('span', { class: 'tool-step-note', text: s.note }),
      pair ? el('span', { class: 'tool-step-pair', text: pair }) : null,
    ].filter(Boolean)));
  }

  const gloss = (item.zh && item.zh.length)
    ? el('div', { class: 'tool-gloss', text: item.zh.join('；') })
    : el('div', { class: 'tool-gloss faint', text: '（内置词库里没有这条的中文释义）' });

  return el('div', { class: 'tool-card' }, [
    head,
    item.pos && item.pos.length ? el('div', { class: 'faint', style: { fontSize: '.82rem' }, text: item.pos.join('・') }) : null,
    gloss,
    steps,
    item.special === 'suru'
      ? el('div', { class: 'banner banner-info', style: { marginTop: '8px' } }, [
        el('strong', { text: '说明：' }),
        el('span', { text: '「〜する」型复合动词在词库里通常只收「' + item.dict.replace(/する$/, '') + '」和「する」两条，' +
          '并不存在「' + item.dict + '」这个词条，所以查词要查前半部分。' }),
      ])
      : null,
    item.special === 'copula'
      ? el('div', { class: 'banner banner-info', style: { marginTop: '8px' } }, [
        el('strong', { text: '说明：' }),
        el('span', { text: '「だ / です / だった」是断定助动词，本身不是词条。名词和ナ形容词查词干就行。' }),
      ])
      : null,
  ].filter(Boolean));
}

// ---------------------------------------------------------------------------
// 工具 2：汉字读音反查
// ---------------------------------------------------------------------------

function renderReading(host) {
  const input = el('input', {
    class: 'input', type: 'text',
    placeholder: '输入假名读音（如 こう）或汉字词（如 日本）',
    autocomplete: 'off', spellcheck: 'false',
  });
  const levelSel = el('select', { class: 'input', style: { maxWidth: '130px' } }, [
    el('option', { value: '', text: '全部等级' }),
    ...['N5', 'N4', 'N3', 'N2', 'N1'].map((l) => el('option', { value: l, text: l })),
    el('option', { value: 'extra', text: '词库外' }),
  ]);
  const btn = el('button', { class: 'btn', text: '查询' });
  const out = el('div', { class: 'tool-out' });

  let last = null;

  async function run() {
    const q = String(input.value || '').trim();
    out.innerHTML = '';
    if (!q) return;
    out.appendChild(el('div', { class: 'loading', text: '加载索引中…' }));
    let idx;
    try {
      idx = await loadIndex();
    } catch (e) {
      out.innerHTML = '';
      out.appendChild(el('div', { class: 'banner banner-error' }, [
        el('strong', { text: '索引加载失败：' }), el('span', { text: String((e && e.message) || e) }),
      ]));
      return;
    }
    out.innerHTML = '';
    last = { idx, q };
    paint();
  }

  function paint() {
    if (!last) return;
    const { idx, q } = last;
    const level = levelSel.value;

    // 两种入口：直接给汉字形（走 lookup），或给假名读音（走 readings）。
    // 两边都查，合并去重 —— 用户不该关心自己给的是哪一种。
    const byId = new Map();
    const addAll = (ids, via) => {
      for (const id of (ids || [])) {
        const t = idx.terms[id];
        if (!t) continue;
        if (!byId.has(id)) byId.set(id, { id, term: t, via: new Set() });
        byId.get(id).via.add(via);
      }
    };
    addAll(idx.lookup[q], 'form');
    addAll(idx.readings[q], 'reading');
    // 假名开头就顺手做个前缀扩展（查 こう 想看 こう〜 的词）
    if (/^[\u3040-\u309f\u30a0-\u30ffー]+$/.test(q) && q.length >= 1) {
      let n = 0;
      for (const k of Object.keys(idx.readings)) {
        if (k !== q && k.startsWith(q)) { addAll(idx.readings[k], 'reading'); n++; if (n > 60) break; }
      }
    }

    let rows = [...byId.values()];
    if (level) rows = rows.filter((r) => (r.term[2] || '') === level);
    const total = rows.length;
    if (!total) {
      out.appendChild(el('div', { class: 'empty' }, [
        el('div', { class: 'empty-title', text: '没找到' }),
        el('div', { class: 'empty-hint', text: '换个写法试试：读音用平假名（こう），汉字词用原形（日本）。' }),
      ]));
      return;
    }

    // 排序：完全命中的排前面，然后按等级（N5→N1）、再按词形长度
    const order = { N5: 0, N4: 1, N3: 2, N2: 3, N1: 4 };
    rows.sort((a, b) => {
      const av = a.via.has('form') ? 0 : 1;
      const bv = b.via.has('form') ? 0 : 1;
      if (av !== bv) return av - bv;
      const al = order[a.term[2]] == null ? 5 : order[a.term[2]];
      const bl = order[b.term[2]] == null ? 5 : order[b.term[2]];
      if (al !== bl) return al - bl;
      return String(a.term[0]).length - String(b.term[0]).length;
    });

    const CAP = 80;
    out.appendChild(el('div', { class: 'tool-count', text: `找到 ${total} 条` + (total > CAP ? `（只显示前 ${CAP} 条）` : '') }));
    const list = el('div', { class: 'tool-list' });
    for (const r of rows.slice(0, CAP)) {
      list.appendChild(el('div', { class: 'tool-rowitem' }, [
        el('span', { class: 'tool-rowterm', text: r.term[0] }),
        el('span', { class: 'tool-rowread', text: r.term[1] || '' }),
        r.term[2] ? el('span', { class: 'badge', text: r.term[2] }) : null,
        el('span', { class: 'tool-rowzh', text: (r.term[3] || []).slice(0, 3).join('；') }),
      ].filter(Boolean)));
    }
    out.appendChild(list);
  }

  btn.addEventListener('click', run);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  levelSel.addEventListener('change', paint);

  host.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, [
      el('h3', { text: '汉字读音反查' }),
      el('span', { class: 'badge', text: '内置词库' }),
    ]),
    el('p', { class: 'dim', text: '给一个读音，列出一堆同音词；或者给一个汉字词，看它读什么。' +
      '多音字的坑（日=ひ/にち/じつ/か、生=せい/い/う/しょう/なま）用这个最快。' }),
    el('div', { class: 'tool-row' }, [input, levelSel, btn]),
    el('div', { class: 'tool-samples' }, [
      el('span', { class: 'faint', text: '试试：' }),
      ...['こう', 'じん', '日本', '生', 'はな'].map((s) => el('button', {
        class: 'chip', text: s, onclick: () => { input.value = s; run(); },
      })),
    ]),
    out,
  ]));
}

// ---------------------------------------------------------------------------
// 工具 3：数字・日期・量词读法
// ---------------------------------------------------------------------------
// 规则引擎在 app/js/counter.js（纯函数、零依赖、不碰 DOM）。
// 之所以要单独一个模块：视图负责渲染，tools/check-counters.mjs 负责拿同一套规则
// 去和内置词库对账。规则只有一份，校验才不是自欺欺人。

export default {
  id: 'toolbox',
  title: '工具箱',
  async render(root) {
    let active = 'deinflect';
    const body = el('div');

    function paint() {
      body.innerHTML = '';
      if (active === 'deinflect') renderDeinflect(body);
      else if (active === 'conj') renderConj(body);
      else if (active === 'reading') renderReading(body);
      else renderCounter(body);
    }

    const tabs = el('div', { class: 'tabs' });
    for (const t of TABS) {
      tabs.appendChild(el('button', {
        class: 'tab' + (t.id === active ? ' active' : ''),
        text: t.label,
        onclick: () => { active = t.id; paintTabs(); paint(); },
      }));
    }
    function paintTabs() {
      [...tabs.children].forEach((b, i) => b.classList.toggle('active', TABS[i].id === active));
    }

    root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [
        el('h2', { text: '工具箱' }),
        el('span', { class: 'badge', text: '离线可用' }),
      ]),
      el('p', { class: 'dim', text: '四件查词典查不到、但自学时天天会遇到的小事。四个工具都在本机算，' +
                                     '不请求任何外部服务。' }),
      tabs,
    ]));
    root.appendChild(body);
    paintTabs();
    paint();
  },
};

// ---------------------------------------------------------------------------
// 工具 2：动词・形容词变形表
// ---------------------------------------------------------------------------
/**
 * 这个工具和上面的"活用还原器"是**一对**：
 *   还原器：给你一个变过的形（使って）→ 告诉你它原本是 使う。**反向。**
 *   本工具：给你辞书形（使う）→ 把各种形态一次列全。**正向。**
 *
 * 为什么要两个：它们回答的是不同的问题。
 *   「这个词我认不出来」→ 还原器
 *   「这个词该怎么变」   → 本工具
 *
 * ⚠️ 这里有一条**刻意设计**、必须保留的东西：
 *   引擎只看词形猜类型（五段/一段），而「帰る」「切る」这类
 *   "长得像一段、其实是五段"的词光看形状是猜不准的。
 *   所以界面上要**把猜的结果说出来 + 允许手动改**。
 *   如果哪天为了界面简洁把类型选择器去掉，用户就会拿到错的变形表
 *   而自己发现不了 —— 那比没有这个工具更糟。
 */
function renderConj(host) {
  const SAMPLES = ['使う', '食べる', '書く', '静か', '高い', '勉強する', '来る', '行く'];

  const input = el('input', {
    class: 'input', type: 'text', autocomplete: 'off', spellcheck: 'false',
    placeholder: '输入辞书形（词典里那个形），例如：使う / 食べる / 高い',
  });
  const typeSel = el('select', { class: 'input', style: { maxWidth: '20rem' } });
  const runBtn = el('button', { class: 'btn btn-primary', text: '列出所有变形' });
  const out = el('div', { class: 'tool-out' });
  const ruleOut = el('div', { class: 'tool-out' });

  // 类型选择器：第一项是"自动判断"，其余是手动指定。
  // 手动指定不是"高级功能"，是**纠错入口**，所以要放在显眼的地方。
  typeSel.appendChild(el('option', { value: '', text: '自动判断词类' }));
  for (const t of CHOOSABLE_TYPES) {
    typeSel.appendChild(el('option', { value: t, text: TYPE_LABELS[t] || t }));
  }

  function paint(result) {
    out.innerHTML = '';
    if (!result || !result.word) return;

    if (!result.forms.length) {
      out.appendChild(el('div', { class: 'empty' }, [
        el('div', { class: 'empty-title', text: '没法给这个词变形' }),
        el('div', { class: 'empty-hint', text: result.reason || '' }),
      ]));
      return;
    }

    // ---- 判断结果：必须显式摆出来，用户才知道程序是怎么理解的 ----
    const head = el('div', { class: 'tool-card' }, [
      el('div', { class: 'tool-head' }, [
        el('span', { class: 'tool-to', text: result.word }),
        el('span', { class: 'badge', text: (TYPE_LABELS[result.type] || result.type).split('（')[0] }),
        result.uncertain ? el('span', { class: 'badge badge-warn', text: '拿不准' }) : null,
      ].filter(Boolean)),
      el('div', { class: 'faint', style: { fontSize: '.85rem' }, text: '判断依据：' + result.reason }),
    ]);

    // ---- 警告：这些都是"你可能会拿到错表"的提醒，一条都不能省 ----
    for (const w of (result.warnings || [])) {
      head.appendChild(el('div', { class: 'banner banner-warn', text: w }));
    }

    out.appendChild(head);

    // ---- 变形表 ----
    const table = el('table', { class: 'table conj-table' }, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: '形态' }),
          el('th', { text: '写法' }),
          el('th', { text: '怎么变的' }),
        ]),
      ]),
      el('tbody', {}, result.forms.map((f) => el('tr', {}, [
        el('td', { class: 'conj-name', text: f.name }),
        el('td', { class: 'conj-form', text: f.form }),
        el('td', { class: 'conj-rule faint' }, [
          el('div', { text: f.rule }),
          f.note ? el('div', { class: 'conj-note', text: f.note }) : null,
        ].filter(Boolean)),
      ]))),
    ]);
    out.appendChild(table);

    // 边界说明：为什么"没列全"也是有意为之
    out.appendChild(el('div', { class: 'banner banner-info' }, [
      el('strong', { text: '为什么只有这些：' }),
      el('span', { text: '这里只列日常最常用的形态。文语（文言）残留、罕用敬语、'
        + '方言等一律不列 —— 因为对初学者来说，一条错的变形比少一条更糟：'
        + '少的那条你查得到，错的那条你会直接背下来。' }),
    ]));
  }

  function run(word) {
    const w = String(word == null ? input.value : word).trim();
    if (!w) { out.innerHTML = ''; return; }
    input.value = w;
    paint(conjugate(w, typeSel.value ? { type: typeSel.value } : {}));
  }

  runBtn.addEventListener('click', () => run());
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  // 换词类立刻重算 —— 用户改类型的目的就是想马上看到对不对。
  // 不自动重算的话他会以为按钮没生效。
  typeSel.addEventListener('change', () => { if (input.value.trim()) run(); });

  host.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, [
      el('h3', { text: '动词・形容词变形表' }),
      el('span', { class: 'badge', text: '离线' }),
    ]),
    el('p', { class: 'dim', text: '给你辞书形，把 ます形、て形、た形、ない形、可能形、被动形、使役形…'
      + '一次列全，并写清每一步是怎么变的。反过来（给你一个变过的形、问它原本是什么）请用左边的「活用还原器」。' }),
    el('div', { class: 'tool-row' }, [input, typeSel, runBtn]),
    el('div', { class: 'tool-samples' }, [
      el('span', { class: 'faint', text: '试试：' }),
      ...SAMPLES.map((s) => el('button', {
        class: 'chip', text: s, onclick: () => run(s),
      })),
    ]),
    out,
  ]));

  // ---- 第二块：变化规则表（用户点名要的） ----
  //
  // 用户原话：
  //   「工具箱里的变位规则这个很好，但是我还需要你保留"输入原型——给出所有变化"
  //     这一功能的前提下，直接给出变化规则表，例如一段五段动词的具体通用规则。」
  //
  // 所以这里刻意**不删**上面的「输入原型→所有变化」（那是他最常用的），
  // 而是在它下面**直接铺开规则表**：不用先输入、不用先知道关键词，
  // 进页面就能看见"五段动词到底有哪 18 种变形、每一种怎么变"。
  //
  // 旧版的毛病：只有一个**空白**的搜索框，下面什么都没有。
  // 对已经知道"て形""音便"这些词的人来说够用，但对**初学者**等于空页面 ——
  // 他不知道该输什么，也就看不到规则。规则表的价值恰恰在"我还不知道要搜什么"。
  //
  // 三条交互设计：
  //   ① 词类用**折叠块**，五段/一段**默认展开**（最常用的两个），
  //      其余折叠 —— 110 行一次性铺开会把人吓跑，但全折叠又要点七下。
  //   ② **一搜索就全部自动展开** —— 搜了还折叠着、让人手动点开，
  //      那是"明明搜到了却看不见"，比搜不到更让人恼火。
  //   ③ 词类名做成**跳转按钮**：点"五段动词"就筛出五段动词的规则，
  //      再点一次取消。比让人自己想关键词直观得多。
  const ruleInput = el('input', {
    class: 'input', type: 'text', autocomplete: 'off',
    placeholder: '筛选规则：输入 て / た / ない / ます / ば / 音便 / 可能 / 命令 …（留空＝看全部）',
  });
  const ruleTableHost = el('div', { class: 'tool-out conj-rules' });

  /** 五段/一段默认展开，其余折叠。用户最常查的就是这两类。 */
  const OPEN_BY_DEFAULT = new Set(['godan', 'ichidan']);

  /** 当前按词类筛的是哪一类（'' = 不按词类筛）。点词类按钮设置它。 */
  let ruleTypeFilter = '';

  /**
   * 画规则表。
   * @param {string} key 文本筛选词（用户在输入框里敲的）
   *
   * ⚠️ 为什么词类筛选要**单独一个参数**、而不是也当成文本去 includes：
   *    实测过用按钮文字（"五段动词"）去喂 ruleTable，结果**命中 0 条** ——
   *    因为 ruleTable 的匹配范围是 name/rule/example/note，
   *    这些字段里写的是"把「く」变成い段「き」"，并不包含"五段动词"这四个字。
   *    词类是**行上的一个字段**（r.type），要按它筛就老老实实比字段，
   *    拿显示用的中文去撞文本是碰运气。
   */
  function paintRules(key) {
    ruleTableHost.innerHTML = '';
    const k = String(key || '').trim();
    let rows = ruleTable(k);
    if (ruleTypeFilter) rows = rows.filter((r) => r.type === ruleTypeFilter);
    if (!rows.length) {
      ruleTableHost.appendChild(el('div', { class: 'empty' }, [
        el('div', { class: 'empty-title', text: '没有匹配的规则' }),
        el('div', { class: 'empty-hint', text: '换个关键字试试，比如 て / た / ない / ます / ば / 可能 / 命令；'
          + '或点一下上面的词类按钮取消词类筛选。' }),
      ]));
      return;
    }
    // 按词类分组：同一件事（比如"て形"）在不同词类下变法完全不同，混着看会乱
    const byType = new Map();
    for (const r of rows) {
      if (!byType.has(r.type)) byType.set(r.type, []);
      byType.get(r.type).push(r);
    }
    // 搜索时全部展开（见上面交互设计 ②）
    const forceOpen = !!k;
    for (const [type, list] of byType) {
      const box = el('details', { class: 'conj-rules-group' });
      if (forceOpen || OPEN_BY_DEFAULT.has(type)) box.open = true;
      box.appendChild(el('summary', { class: 'conj-rules-summary' }, [
        el('span', { class: 'conj-rules-type', text: TYPE_LABELS[type] || type }),
        el('span', { class: 'badge', text: `${list.length} 条` }),
      ]));
      box.appendChild(el('table', { class: 'table conj-table' }, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: '形态' }), el('th', { text: '例子' }), el('th', { text: '规则' }),
        ])]),
        el('tbody', {}, list.map((r) => el('tr', {}, [
          el('td', { class: 'conj-name', text: r.name }),
          el('td', { class: 'conj-form', text: r.example }),
          el('td', { class: 'conj-rule faint' }, [
            el('div', { text: r.rule }),
            r.note ? el('div', { class: 'conj-note', text: r.note }) : null,
          ].filter(Boolean)),
        ]))),
      ]));
      ruleTableHost.appendChild(box);
    }
  }

  ruleInput.addEventListener('input', () => paintRules(ruleInput.value));

  // 词类快捷按钮：点一下只留这一类，再点一下取消。
  // 文字用 TYPE_LABELS 去掉括号后的短名（如"五段动词""サ变"）。
  const typeChips = el('div', { class: 'tool-samples' }, [
    el('span', { class: 'faint', text: '只看某类：' }),
    ...CHOOSABLE_TYPES.map((t) => el('button', {
      class: 'chip', text: (TYPE_LABELS[t] || t).replace(/（.*$/, ''),
      dataset: { type: t },
      onclick: () => {
        ruleTypeFilter = ruleTypeFilter === t ? '' : t;
        syncTypeChips();
        paintRules(ruleInput.value);
      },
    })),
  ]);

  /**
   * 把按钮高亮同步成当前筛选状态。
   * 为什么不靠"再点一次取消"以外的线索：用户点了"五段动词"之后，
   * 表格里的**其它词类整块消失**了。如果没有高亮，他很容易以为
   * "规则表坏了、只剩一类"，而不是"我筛过了"。高亮就是那个"我在筛"的提示。
   */
  function syncTypeChips() {
    for (const b of typeChips.querySelectorAll('.chip')) {
      b.classList.toggle('is-on', !!ruleTypeFilter && b.dataset.type === ruleTypeFilter);
    }
  }

  host.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, [
      el('h3', { text: '变化规则表' }),
      el('span', { class: 'badge', text: '通用规则' }),
    ]),
    el('p', { class: 'dim', text: '下面是每一类词的全部变形规则，不用先输入。'
      + '五段动词、一段动词默认展开；想看别的词类，点它的标题展开，或点下面的词类按钮。' }),
    typeChips,
    ruleInput,
    ruleTableHost,
  ]));

  // 默认先给一个例子 —— 空白的工具没人知道该怎么用。
  run('使う');
  paintRules('');
}

// ---------------------------------------------------------------------------
// 工具 3 的正文
// ---------------------------------------------------------------------------
// 规则引擎见文件顶部的 import（app/js/counter.js）。

function renderCounter(host) {

  // ---- 日期 ----
  // dayReading / monthReading / hourReading / counterReading 都来自 app/js/counter.js。
  // ⚠️ 这里**不要**再定义同名局部函数 —— 曾经留过一个本地 dayReading 副本，
  //    它引用已删除的 DAYS 常量，会直接把整个页面炸掉（模块级 import 被同名函数遮蔽）。
  const dateCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, [el('h3', { text: '日期读法' })]),
    el('p', { class: 'dim', text: '1〜10 日、20 日 是训读，必须单独记。14・24 日读 よっか，17・27 日读 しちにち，19・29 日读 くにち。' }),
  ]);
  const dayGrid = el('div', { class: 'counter-grid' });
  for (let d = 1; d <= 31; d++) {
    dayGrid.appendChild(el('div', { class: 'counter-cell' }, [
      el('span', { class: 'counter-num', text: d + '日' }),
      el('span', { class: 'counter-read', text: dayReading(d) }),
    ]));
  }
  dateCard.appendChild(dayGrid);

  // ---- 月份与时刻 ----
  const monthGrid = el('div', { class: 'counter-grid' });
  for (let m = 1; m <= 12; m++) {
    monthGrid.appendChild(el('div', { class: 'counter-cell' }, [
      el('span', { class: 'counter-num', text: m + '月' }),
      el('span', { class: 'counter-read', text: monthReading(m) }),
    ]));
  }
  const hourGrid = el('div', { class: 'counter-grid' });
  for (let h = 1; h <= 12; h++) {
    hourGrid.appendChild(el('div', { class: 'counter-cell' }, [
      el('span', { class: 'counter-num', text: h + '時' }),
      el('span', { class: 'counter-read', text: hourReading(h) }),
    ]));
  }
  const timeCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, [el('h3', { text: '月份与时刻' })]),
    el('p', { class: 'dim', text: '4月=しがつ、7月=しちがつ、9月=くがつ；4時=よじ、7時=しちじ、9時=くじ。其余按数字音读 + がつ / じ。' }),
    el('h4', { text: '月份' }), monthGrid,
    el('h4', { text: '时刻', style: { marginTop: '10px' } }), hourGrid,
  ]);

  // ---- 量词 ----
  const cntCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, [el('h3', { text: '量词读法（1〜10）' })]),
    el('p', { class: 'dim', text: '同一个数字配不同量词，读音会变：3本=さんぼん、3枚=さんまい、3匹=さんびき、3階=さんがい。' }),
  ]);
  for (const c of COUNTERS) {
    const max = c.max || 10;
    const grid = el('div', { class: 'counter-grid' });
    for (let n = 1; n <= max; n++) {
      const r = counterReading(c, n);
      grid.appendChild(el('div', { class: 'counter-cell' + (r ? '' : ' counter-na') }, [
        el('span', { class: 'counter-num', text: n + c.suffix }),
        el('span', { class: 'counter-read', text: r || '—' }),
      ]));
    }
    cntCard.appendChild(el('div', { class: 'counter-block' }, [
      el('h4', { text: c.label }),
      c.note ? el('div', { class: 'faint', style: { fontSize: '.82rem' }, text: c.note }) : null,
      grid,
    ].filter(Boolean)));
  }

  // ---- 任意数字 ----
  const numInput = el('input', { class: 'input', type: 'number', min: '0', max: '9999999999999', value: '1234' });
  const numOut = el('div', { class: 'tool-out' });
  function paintNum() {
    const n = Number(numInput.value);
    numOut.innerHTML = '';
    if (!Number.isFinite(n) || n < 0) return;
    numOut.appendChild(el('div', { class: 'counter-cell counter-wide' }, [
      el('span', { class: 'counter-num', text: String(Math.floor(n)) }),
      el('span', { class: 'counter-read', text: numberReading(n) }),
    ]));
  }
  numInput.addEventListener('input', paintNum);

  const numCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, [el('h3', { text: '任意数字' })]),
    el('p', { class: 'dim', text: '输入一个整数，看它的音读。规则是纯算法，不查表，所以多大都行（受 JS 整数精度限制）。' }),
    el('div', { class: 'tool-row' }, [numInput]),
    numOut,
  ]);
  paintNum();

  host.appendChild(dateCard);
  host.appendChild(timeCard);
  host.appendChild(cntCard);
  host.appendChild(numCard);
}
