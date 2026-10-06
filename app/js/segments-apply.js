/**
 * segments-apply.js —— 把用户手改的切法**套到分词结果上**（纯函数，不碰数据库）。
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么单独一个文件
 * ────────────────────────────────────────────────────────────────────
 * 这段逻辑原来写在 `segments.js` 里，而那个文件第一行就
 * `import * as db from './db.js'` —— 于是想单独测它就必须把整个 IndexedDB
 * 数据层一起拉起来，没法在一个干净环境里一次只跑这一小段。
 * 切开之后 `check-segments.mjs` 可以直接 `node` 跑，不需要浏览器。
 * 这不是"代码风格"，是**让错误能被看见**的前提。
 *
 * ────────────────────────────────────────────────────────────────────
 * 核心模型（改了三版才对，每一版错在哪都写在下面）
 * ────────────────────────────────────────────────────────────────────
 * 一条切法记录描述的是**一次改写**：
 *
 *     「页面上原来是 `[この][人]` 这样切的，改成 `[この人]` 这样切」
 *       └────── auto：在哪里 ──────┘   └─ segments：改成什么 ─┘
 *
 * 所以套用就两步：**① 用 auto 找到位置 ② 把那段换成 segments。**
 * 合并是"多个 token → 一段"，拆分是"一个 token → 多段"，同一套代码。
 *
 * ── 第一版错在哪（逐段比对）──
 * 拿 `auto` 的每一段去和每一个 token 的 surface 逐个比。
 *   · 合并时 auto=['この','人']，页面上两个 token 也正好是 この/人，
 *     "全都能对上"，但生成出来的每段还是 この 和 人 —— **一个词都没并起来**；
 *   · 拆分时 auto=['この人']，页面上是一个 token この人，
 *     逐段比第一段就对不上，直接判"没命中" —— **拆分永远做不出来**。
 * 两种改法都失效，而 `changed` 还是 1。症状是"函数执行了，就是没效果"。
 *
 * ── 第二版错在哪（按字数拼接）──
 * 改成"把接下来的 token 一个个拼起来，拼到等于 auto 拼出来的串为止"。
 * 看着对，实则错：拼的时候是**一个字一个字**地推进 token，
 * 于是 `auto = ['この','人']` 会被拿去尝试匹配 `この` 这**一个** token
 * （因为它拼出来的串 `この人` 长度是 3，而第一个 token 只有 2 个字，
 * 代码就继续往后拼），位置永远对不上。
 * 正确做法是**按 token 数对齐**：auto 有几段，就取接下来几个词 token。
 *
 * ── 第三版（本版）──
 * 比较的是"token 序列"：**auto 有几段，就取接下来几个词 token，逐段比 surface**。
 * 这既能认出一整段的原文（不管它在页面上被切成了几个 token），
 * 也不会把 token 的边界搞错。
 *
 * ⚠️ 另一个坑（也踩过）：跳空白/标点时 `nextChunk(list, to)` 写成 `to` 而不是
 *    `to + 1`，会**反复取到同一个 token**，拼出 `このこのこの…`。
 *    `nextChunk` 的语义是"从 idx 开始找"（包含 idx 本身），所以必须 +1 前进。
 */

/** 只保留"能参与分词的东西"：空白和标点不参与匹配 */
function isChunk(t) {
  return !!(t && !t.isSpace && !t.isPunct && t.surface);
}

/** 从 idx 开始（**包含 idx**）找下一个词 token；找不到返回 -1 */
function chunkAt(list, idx) {
  for (let k = idx; k < list.length; k++) if (isChunk(list[k])) return k;
  return -1;
}

/** 一串 token 拼起来的原文（切法表的主键） */
export function surfaceOf(tokens) {
  return (tokens || []).filter(isChunk).map((t) => String(t.surface)).join('');
}

/**
 * 把切法表**预处理**成匹配用的规则数组。
 *
 * 每条规则：
 *   surface —— auto 拼起来的原文（只用于日志/调试，匹配时按 token 数对齐）
 *   auto    —— **原来怎么切的**（在哪里）
 *   parts   —— **改成什么**（新切法，至少 1 段）
 *   readings—— 每一段的建议读音（可能为空串）
 */
export function buildRules(overrides) {
  const rules = [];
  if (!overrides) return rules;
  for (const rec of overrides.values()) {
    if (!rec || !Array.isArray(rec.segments)) continue;

    const parts = rec.segments.map((s) => String((s && s.t) || '')).filter(Boolean);
    if (!parts.length) continue;

    // ⚠️ auto 是"在哪里"，parts 是"改成什么" —— 这两个绝不能搞反。
    //    老记录（只有 segments、没有 auto 的）退化用 parts 当 auto：
    //    对"拆分"是对的（拆之前本来就是整词），对"合并"会匹配不上，
    //    但**不会出错，只是不生效**，这比乱改用户的分词好。
    const auto = Array.isArray(rec.auto) && rec.auto.length
      ? rec.auto.map((x) => String(x)).filter(Boolean)
      : parts.slice();
    if (!auto.length) continue;

    // 文字总量必须一致（切法只改"怎么切"，不改文字）
    if (auto.join('') !== parts.join('')) continue;

    // ⚠️ "没有改变切法"的判据是**新旧切法完全一样**，不是"新切法只有一段"。
    //    合并恰恰就是一段（`この`+`人` → `この人`）——
    //    写成 `if (parts.length < 2) continue` 会把**所有合并记录**过滤掉，
    //    rules 直接是空的、changed 永远是 0，而拆分却正常。
    //    症状是"拆分能改、合并改了没反应"，很难联想到是这个过滤条件。
    if (auto.length === parts.length && auto.every((x, i) => x === parts[i])) continue;

    const readings = parts.map((_, idx) => {
      const s = rec.segments[idx];
      return s && s.r ? String(s.r) : '';
    });
    rules.push({ surface: auto.join(''), auto, parts, readings });
  }
  // 长的先试 —— 保证"最长匹配"（否则 `この人` 会永远抢在 `この人たち` 前面）
  rules.sort((a, b) => b.auto.length - a.auto.length || b.surface.length - a.surface.length);
  return rules;
}

/**
 * 在 list 的 from 位置起，试每一条规则，返回命中的那条。
 *
 * 匹配方式是**按 token 数对齐**：auto 有几段，就取接下来几个词 token，
 * 逐段比 surface。中间夹着的空白/标点跳过不算。
 *
 * @returns {{rule:object, from:number, to:number}|null}
 *   from/to = 被覆盖的 token **下标范围**（左闭右闭）
 */
export function matchRule(list, from, rules) {
  for (const rule of rules) {
    const anchors = [];
    let cursor = from;
    let ok = true;
    for (const part of rule.auto) {
      const at = chunkAt(list, cursor);
      if (at < 0 || String(list[at].surface) !== part) { ok = false; break; }
      anchors.push(at);
      cursor = at + 1;               // ⚠️ 必须 +1，否则会反复取到同一个 token
    }
    if (ok && anchors.length === rule.auto.length) {
      return { rule, from: anchors[0], to: anchors[anchors.length - 1] };
    }
  }
  return null;
}

/**
 * 把用户的切法**套到 token 列表上**。
 *
 * 从左往右扫一遍：能用某条切法覆盖接下来的一段，就把那一段整个换成
 * 规则里的几段；不能就把当前 token 原样放进结果、往后走一格。
 *
 * ⚠️ 输出时**要保留原来的间隔**（空格/标点），否则 `この 人` 会挤成一坨。
 * ⚠️ 替换出来的新 token 带 `override: true`（界面据此显示"这段是你自己切的"）；
 *    读音用记录里的 r，**没有 r 就当未知词**（known:false）——
 *    绝不拿旧 token 的读音硬拼，拼出来的读音可能是错的，而错读音比没读音更糟。
 * ⚠️ **不改动入参**（返回新数组）：页面上的 token 数组被就地改了会非常难查。
 *
 * @param {Array} tokens 分词结果
 * @param {Map<string, object>} overrides surface → 记录
 * @returns {{tokens:Array, changed:number}} 新的 token 列表；changed = 被改写的段数
 */
export function applySegOverrides(tokens, overrides) {
  const list = Array.isArray(tokens) ? tokens : [];
  const rules = buildRules(overrides);
  if (!rules.length || !list.length) return { tokens: list, changed: 0 };

  // ---- 第一步：把 token 列表看成"一串词，词与词之间夹着空白/标点" ----
  //
  //   wordAt[]   第 n 个词在 list 里的下标
  //   wordGaps[] 第 n 个词**和它后面那一段空隙**（可能是空的）
  //              —— 空隙跟着"它前面的那个词"，这样输出时能原样还原排版。
  //   leadGaps   第一个词**之前**的空隙（比如一段开头的换行/缩进）
  //
  // ⚠️ 第一版只处理"词与词之间"的空隙，**段首和段尾的空隙全丢了** ——
  //    症状是每改写一次就悄悄吃掉一个换行，而原文的其他字都对，
  //    肉眼几乎看不出来，只有把"套用前后拼起来的原文"逐字比才会露出来。
  //    见 check-segments.mjs [5b] 的批量不变量断言（就是它抓到的）。
  const wordAt = [];
  for (let k = 0; k < list.length; k++) if (isChunk(list[k])) wordAt.push(k);
  if (!wordAt.length) return { tokens: list, changed: 0 };

  const leadGaps = [];
  for (let k = 0; k < wordAt[0]; k++) leadGaps.push(list[k]);
  const wordGaps = [];
  for (let n = 0; n < wordAt.length; n++) {
    const stop = n + 1 < wordAt.length ? wordAt[n + 1] : list.length;
    const gaps = [];
    for (let k = wordAt[n] + 1; k < stop; k++) gaps.push(list[k]);
    wordGaps.push(gaps);
  }

  // ---- 第二步：从左往右扫，能套规则的那一段整个换掉 ----
  const out = [...leadGaps];
  let changed = 0;
  let n = 0;
  while (n < wordAt.length) {
    const hit = matchRule(list, wordAt[n], rules);
    if (!hit) {
      out.push(list[wordAt[n]]);
      for (const g of wordGaps[n]) out.push(g);
      n++;
      continue;
    }

    // 这一段盖住了第 n .. nLast 个词
    let nLast = n;
    while (nLast < wordAt.length && wordAt[nLast] <= hit.to) nLast++;
    nLast--;                                   // 闭区间

    // 被盖住的词之间夹着的空隙。**最后一个词的 wordGaps 不算进来** ——
    // 那是"这一段之后"的排版，属于后面还没处理的内容。
    const inner = [];
    for (let k = n; k < nLast; k++) for (const g of wordGaps[k]) inner.push(g);

    const fresh = hit.rule.parts.map((part, idx) => {
      const r = hit.rule.readings[idx] || '';
      const seg = {
        surface: part,
        reading: r,
        ruby: null,          // 由 ensureRuby() 走 /api/yomi 补
        romaji: '',
        known: !!r,          // 没有读音记录 → 不假装认识这个词
        override: true,
        isSpace: false,
        isPunct: false,
      };
      // 等级/中文挂在**第一段**上：用户改的是"怎么分"，不是"这串什么意思"，
      // 原来查到的释义不该丢。
      if (idx === 0) {
        const first = list[hit.from];
        if (first && first.level) seg.level = first.level;
        if (first && first.zh) seg.zh = first.zh;
      }
      return seg;
    });

    if (fresh.length === 1) {
      // **合并**：新的只有一段。
      // ⚠️ 这种情况下被盖住的词之间**可能**真的夹着空隙 —— 比如
      //    `この` + ` ` + `人`，用户想把这两个词合成一个 `この人`。
      //    （auto 是 ['この','人']，拼出来正好是 `この人` = segments 拼出来的，
      //      所以这条记录**合法**，不会被 buildRules 丢掉。）
      //    那个空隙必须摆在**合并后的词后面** ——
      //      丢掉 → 悄悄改掉原文；
      //      摆前面 → 变成「 この人」，空格从词后面跑到了词前面，位置不对。
      out.push(fresh[0]);
      for (const g of inner) out.push(g);
    } else {
      // **拆分**：新的有多段，被盖住的词之间的空隙按顺序摊到新段之间，
      // 这样 `この 人` 拆开之后那个空格还在原来的位置上。
      const per = fresh.length - 1;
      for (let idx = 0; idx < fresh.length; idx++) {
        out.push(fresh[idx]);
        if (idx >= per) break;                 // 最后一段后面不摊空隙
        const from = Math.floor((idx * inner.length) / per);
        const to = Math.floor(((idx + 1) * inner.length) / per);
        for (let x = from; x < to; x++) out.push(inner[x]);
      }
    }

    // 最后一个被盖住的词的 wordGaps 原样跟在新切法后面
    for (const g of wordGaps[nLast]) out.push(g);

    n = nLast + 1;
    changed++;
  }

  return { tokens: out, changed };
}
