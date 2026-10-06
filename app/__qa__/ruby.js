/**
 * ruby.js —— `qa-ruby.mjs` 的载荷（在真浏览器里跑）。
 *
 * 目标：把「振假名 / 罗马音 / 表面形」三者的**几何关系**量出来，
 * 变成可以判定的数字，而不是靠人眼看。
 *
 * 量什么（每个词量三个矩形）：
 *   · rt（振假名）的矩形      —— 应该在表面形的**上方**
 *   · 表面形（rb / span）的矩形 —— 主体
 *   · .jpr-romaji 的矩形      —— 应该在表面形的**下方**
 *
 * 判定依据（用中线比较，不用上边，因为字号不同会让上边差一点点）：
 *   rt.centerY      <  主体.centerY      → 振假名在主体上面
 *   romaji.centerY  >  主体.centerY      → 罗马音在主体下面
 *   并且 romaji.top  >= rt.bottom 才叫"没挤在一起"
 *
 * ⚠️ 为什么用"中心线"而不是"上边界"：
 *    振假名字号是 .52em、罗马音是 .6em，两者上边界可能差 1px；
 *    中心线对字号差异更稳，也更能反映"视觉上是不是同一行"。
 *
 * 另外把已知的多音汉字词（日々／今日／一日 等）的实际注音也报出来，
 * 供 `qa-ruby.mjs` 判断"读音是否与词库一致"。
 */
import { el } from '/js/ui.js';
import { renderTokens } from '/js/views/jpreader.js';

const mount = document.getElementById('mount');
const QA = { status: 'starting', cases: [], readings: [], errors: [] };
window.__QA = QA;

window.addEventListener('error', (e) => QA.errors.push(String((e && e.message) || e)));

/** 量一个词 chip 里的三个盒子 */
function measureChip(chip) {
  const rb = chip.querySelector('ruby');
  const body = rb || chip.querySelector('span:not(.jpr-romaji)');
  const rt = chip.querySelector('rt');
  const romaji = chip.querySelector('.jpr-romaji');
  const rect = (n) => {
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return { top: +r.top.toFixed(2), bottom: +r.bottom.toFixed(2), left: +r.left.toFixed(2), right: +r.right.toFixed(2), cy: +((r.top + r.bottom) / 2).toFixed(2), h: +r.height.toFixed(2) };
  };
  return {
    surface: chip.dataset.term || '',
    reading: chip.dataset.reading || '',
    rtCount: chip.querySelectorAll('rt').length,
    hasRuby: !!rb,
    chipW: +chip.getBoundingClientRect().width.toFixed(2),
    body: rect(body),
    rt: rect(rt),
    romaji: rect(romaji),
  };
}

/**
 * 造一批 token 直接喂给 renderTokens。
 * ⚠️ 这里是**手写 token**，不是走分词 —— 目的是把「々」「长词」「混合词」
 *    这些形状固定下来，让几何问题可复现。真实分词的读音正确性由
 *    readings 一节单独检查（走 /api/analyze）。
 */
const CASES = [
  {
    // ★ 这一条原本是「整词一个 rt（rubyEstimated）」—— 那是 々 修复前的**错误**形状。
    //   修复后服务端能把 ひび 切成 ひ/び，所以这里必须跟着改成真实形状，
    //   否则这条用例会一直"通过"，却测的是已经不存在的情况。
    name: '叠字：日々（拆成两段）',
    tokens: [{ surface: '日々', known: true, reading: 'ひび', romaji: 'hibi', ruby: [{ t: '日', r: 'ひ' }, { t: '々', r: 'び' }], rubyEstimated: false }],
  },
  {
    name: '叠字：人々（拆成两段）',
    tokens: [{ surface: '人々', known: true, reading: 'ひとびと', romaji: 'hitobito', ruby: [{ t: '人', r: 'ひと' }, { t: '々', r: 'びと' }], rubyEstimated: false }],
  },
  {
    name: '疊字：時々（拆成两段）',
    tokens: [{ surface: '時々', known: true, reading: 'ときどき', romaji: 'tokidoki', ruby: [{ t: '時', r: 'とき' }, { t: '々', r: 'どき' }], rubyEstimated: false }],
  },
  {
    name: '普通两字汉字：生活',
    tokens: [{ surface: '生活', known: true, reading: 'せいかつ', romaji: 'seikatsu', ruby: [{ t: '生', r: 'せい' }, { t: '活', r: 'かつ' }], rubyEstimated: false }],
  },
  {
    name: '长词：日本語',
    tokens: [{ surface: '日本語', known: true, reading: 'にほんご', romaji: 'nihongo', ruby: [{ t: '日', r: 'に' }, { t: '本', r: 'ほん' }, { t: '語', r: 'ご' }], rubyEstimated: false }],
  },
  {
    name: '带送假名：食べる',
    tokens: [{ surface: '食べる', known: true, reading: 'たべる', romaji: 'taberu', ruby: [{ t: '食', r: 'た' }, { t: 'べる', r: '' }], rubyEstimated: false }],
  },
  {
    name: '假名词（无振假名）：これ',
    tokens: [{ surface: 'これ', known: true, reading: 'これ', romaji: 'kore', ruby: null }],
  },
  {
    name: '混排：日々の生活',
    tokens: [
      { surface: '日々', known: true, reading: 'ひび', romaji: 'hibi', ruby: [{ t: '日々', r: 'ひび' }], rubyEstimated: true },
      { surface: 'の', known: true, reading: 'の', romaji: 'no', ruby: null, isSpace: false },
      { surface: '生活', known: true, reading: 'せいかつ', romaji: 'seikatsu', ruby: [{ t: '生', r: 'せい' }, { t: '活', r: 'かつ' }], rubyEstimated: false },
    ],
  },
];

for (const c of CASES) {
  const wrap = el('div', { class: 'case' });
  wrap.appendChild(el('div', { class: 'case-label', text: c.name }));
  wrap.appendChild(renderTokens(c.tokens, { ruby: true, romaji: true }));
  mount.appendChild(wrap);

  const chips = [...wrap.querySelectorAll('.jpr-w')].map(measureChip);
  QA.cases.push({ name: c.name, chips });
}

/**
 * 第二段：走真实服务端拿分词 + 注音，检查多音汉字词的读音。
 * `/api/analyze` 由临时服务转发到真服务（127.0.0.1:8787）。
 */
const READING_CASES = ['日々の生活', '今日はいい天気ですね', '一日中働いた', '人々の声', '時々雨が降る'];

try {
  for (const text of READING_CASES) {
    // ⚠️ /api/lyric/parse 返回的是 lines[]（每行有 reading.tokens）；
    //    /api/analyze 返回的是 sentences[]。歌词页走的是前者，所以这里用前者。
    const res = await fetch('/api/lyric/parse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, romaji: 'hepburn', ruby: true, particle: true }),
    });
    const j = await res.json();
    const line = (j.lines && j.lines[0]) || (j.sentences && j.sentences[0]) || null;
    const toks = (line && line.reading && line.reading.tokens) || [];
    QA.readings.push({
      text,
      status: res.status,
      ok: !!j.ok,
      tokens: toks
        .filter((t) => !t.isSpace && !t.isPunct)
        .map((t) => ({
          surface: t.surface,
          reading: t.reading || '',
          romaji: t.romaji || '',
          ruby: (t.ruby || []).map((p) => ({ t: p.t, r: p.r || '' })),
          estimated: !!t.rubyEstimated,
        })),
    });
  }
} catch (e) {
  QA.errors.push('读音用例失败：' + String((e && e.message) || e));
}

/**
 * 第三段：把**真实服务端产出的 token** 也渲染一遍（不是手写 token）。
 * 手写 token 只能覆盖我想得到的形状；真实 token 才能覆盖真实数据里的形状。
 * 这一段是"用户看到的那一行"的等价物。
 */
try {
  const REAL_CASES = ['日々の生活', '時々雨が降る', '人々の声', '色々な人がいる'];
  for (const text of REAL_CASES) {
    const res = await fetch('/api/lyric/parse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, romaji: 'hepburn', ruby: true, particle: true }),
    });
    const j = await res.json();
    const toks = (j.lines && j.lines[0] && j.lines[0].reading && j.lines[0].reading.tokens) || [];
    if (!toks.length) continue;
    const wrap = el('div', { class: 'case' });
    wrap.appendChild(el('div', { class: 'case-label', text: '真实分词：' + text }));
    wrap.appendChild(renderTokens(toks, { ruby: true, romaji: true }));
    mount.appendChild(wrap);
    QA.cases.push({ name: '真实分词：' + text, chips: [...wrap.querySelectorAll('.jpr-w')].map(measureChip) });
  }
} catch (e) {
  QA.errors.push('真实分词渲染失败：' + String((e && e.message) || e));
}

/**
 * 第四段：**改读音功能**的真实端到端检查（用户报的问题 2）。
 *
 * 这一段刻意走**真代码 + 真 IndexedDB + 真服务端**，不是手写 token：
 *   1. 用 js/yomi.js 的 saveOverride() 存一条手改读音
 *      → 它会请求 /api/yomi 算振假名与罗马音，然后写进 IndexedDB
 *   2. 再用 applyOverrides() 把表套到**真实服务端产出的 token** 上
 *   3. 渲染出来，量几何 —— 改过读音之后振假名和罗马音**仍然不能挤在一行**
 *   4. 最后从 IndexedDB 读回来，确认真的落盘了
 *
 * 为什么要量第 3 步：改读音会换掉整棵 <ruby> 子树里的 <rt> 内容，
 * 如果新读音比旧的长（こんにち 比 きょう 长），很可能把 chip 撑宽、
 * **把罗马音挤到振假名同一行** —— 那正是用户报的那个现象的形状。
 * 所以"改完读音版式还对不对"必须单独验一次。
 */
async function sectionOverrides() {
  const out = { store: false, saved: null, applied: [], persisted: null, chips: [], errors: [] };
  try {
    const { saveOverride, applyOverrides, loadOverrides, removeOverride } = await import('/js/yomi.js');
    const { dbCount } = await import('/js/db.js');

    // 先确认表存在。readingOverrides 是**累加式新增**的 store：
    // db.js 的 ensureSchema() 是幂等的"只增不减"补全，老用户的库打开时
    // 会自动补上这张表，**一条数据都不会丢** —— 这正是本项目
    // "绝不用清库来升级"的核心表现，所以值得钉一条断言。
    try {
      await dbCount('readingOverrides');
      out.store = true;
    } catch (e) {
      out.store = false;
      out.storeError = String((e && e.message) || e);
    }

    // 拿一条真实分词：今日 是多音字（きょう / こんにち），正是用户遇到的情形
    const res = await fetch('/api/lyric/parse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '今日はいい天気ですね', romaji: 'hepburn', ruby: true, particle: true }),
    });
    const j = await res.json();
    const toks = (j.lines && j.lines[0] && j.lines[0].reading && j.lines[0].reading.tokens) || [];
    const target = toks.find((t) => t.surface === '今日');
    if (!target) {
      out.errors.push('没拿到 今日 这个 token，无法验证改读音');
    } else {
      // 程序默认给的是 きょう；这里**故意改成 こんにち**（更长，更容易撑破版式）
      const before = { reading: target.reading, romaji: target.romaji };
      const saved = await saveOverride('今日', 'こんにち');
      out.saved = { before, after: { reading: 'こんにち', romaji: saved.romaji, ruby: saved.ruby, estimated: !!saved.estimated } };

      // 套到全部 token 上（这就是两个页面在渲染前做的事）
      const n = applyOverrides(toks, await loadOverrides());
      out.appliedCount = n;
      out.applied = toks
        .filter((t) => !t.isSpace && !t.isPunct)
        .map((t) => ({ surface: t.surface, reading: t.reading || '', override: !!t.override }));

      // 渲染 + 量几何：改过读音之后版式仍然要对
      const wrap = el('div', { class: 'case' });
      wrap.appendChild(el('div', { class: 'case-label', text: '改读音后：今日 → こんにち' }));
      wrap.appendChild(renderTokens(toks, { ruby: true, romaji: true }));
      mount.appendChild(wrap);
      out.chips = [...wrap.querySelectorAll('.jpr-w')].map(measureChip);
      // 把 今日 那一段的**真实 HTML** 也带回去：
      // rtCount=0 这种失败光看数字不知道是"没切分"还是"切了但没渲染成 <rt>"，
      // 有 HTML 就能一眼看出是哪一层的问题。
      const todayChip = wrap.querySelector('.jpr-w[data-term="今日"]');
      out.todayChipHTML = todayChip ? todayChip.outerHTML : '(没找到 今日 的 chip)';
      out.targetRuby = JSON.stringify(target.ruby);
      QA.cases.push({ name: '改读音后：今日 → こんにち', chips: out.chips });

      // 落盘确认：换一条独立的读取路径，避免"内存里对就算过"
      const table = await loadOverrides();
      const rec = table.get('今日') || null;
      // ⚠️ 表里存的是**记录对象**（含 ruby / romaji / estimated），不是读音字符串。
      //    这里只把要断言的那几个字段带回去，附带"这条记录里有没有振假名" ——
      //    有振假名才说明"套用读音可以完全同步、不发请求"，那是个关键设计点。
      out.persisted = rec ? { reading: rec.reading, hasRuby: Array.isArray(rec.ruby) && rec.ruby.length > 0, romaji: rec.romaji } : null;

      // 收尾：删掉测试写入的记录。**必须删** ——
      // 这条 QA 页和真实页面共用同一个浏览器 profile 的 IndexedDB，
      // 留着会让用户的真实页面把 今日 念成 こんにち。
      await removeOverride('今日');
      const after = await loadOverrides();
      out.cleanedUp = !after.get('今日');
    }
  } catch (e) {
    out.errors.push(String((e && e.message) || e));
  }
  return out;
}

try {
  QA.overrides = await sectionOverrides();
} catch (e) {
  QA.errors.push('改读音用例失败：' + String((e && e.message) || e));
}

QA.status = 'ready';
