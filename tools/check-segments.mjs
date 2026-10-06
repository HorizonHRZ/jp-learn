/**
 * check-segments.mjs —— 用户改分词（segOverrides）的**套用逻辑**检查。
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么单独一个脚本
 * ────────────────────────────────────────────────────────────────────
 * `test-db.mjs` 管的是"表和版本号"（加表必须涨版本、老库能补上、数据不丢）。
 * 而**套用切法的算法**是另一个风险点，它有一套自己的边界情况：
 *   · 合并（この + 人 → この人）
 *   · 拆分（この人 → この + 人）
 *   · 最长匹配（この人 和 この人たち 同时存在时该命中哪个）
 *   · 空白/标点夹在中间（この 人 / この、人）
 *   · 套用**不改变原文**（字一个不多一个不少）
 *   · 套用**不改动入参**（页面上的 token 数组被就地改了会很难查）
 *   · 多条切法相邻时的推进（不能漏段、不能重复套）
 * 这些用 node 直接跑最快、也最容易写清楚，不需要浏览器。
 *
 * 本文件只 import `segments-apply.js`（**纯函数**，不碰数据库）。
 * 为什么不去 import `segments.js`：那个文件第一行就 `import db.js`，
 * 会顺带把整个 IndexedDB 数据层拉起来 —— 那样测的就不只是切法逻辑了。
 *
 * 用法：node tools/check-segments.mjs
 */
import {
  applySegOverrides,
  surfaceOf,
} from '../app/js/segments-apply.js';

let pass = 0, fail = 0;
function ok(c, n, x = '') {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${x ? '\n      ' + x : ''}`); }
}

/** 造一个 token（默认是"词库里查得到的普通词"） */
const tok = (surface, reading = surface) => ({ surface, reading, known: true, ruby: [], romaji: '' });

/**
 * 造一条切法记录。
 *
 * ⚠️ 参数是**两个**：`auto`（原来怎么切的 = 匹配用的坐标）和 `segments`（改成什么）。
 *    这和 `saveSegOverride(surface, segments, autoSegments)` 存库的形状一致 ——
 *    测试里的记录形状必须和真实存库的一样，否则测的不是真东西。
 *
 *   rec(['この','人'], [{t:'この'},{t:'人',r:'ひと'}])
 *      = 页面上本来是 `この`+`人`，把它改成各自的切法并配读音
 *   rec(['この','人'], [{t:'この人'}])
 *      = 页面上本来是 `この`+`人`，**合并**成 `この人`
 *   rec(['この人'], [{t:'この'},{t:'人'}])
 *      = 页面上本来是一个词 `この人`，**拆开**成 `この`+`人`
 */
const rec = (auto, segments) => new Map([[
  auto.join(''),
  { surface: auto.join(''), auto: auto.slice(), segments, at: 1 },
]]);
const got = (r) => r.tokens.map((t) => t.surface);

/**
 * 把**所有** token（含空白/标点）的 surface 拼起来 = 页面上的原文。
 *
 * ⚠️ 这和 `surfaceOf` 是**两个不同的口径**，不能混用：
 *   · `surfaceOf` 只拼"词"，跳过空白和标点 —— 它是**查切法表用的键**；
 *   · 本函数拼全部 —— 它是**排版/原文**。
 *   第一版测试拿 `surfaceOf` 去断言"空格没丢"，当然永远不成立
 *   （`この 人` 和 `この人` 的 surfaceOf 是同一个值）。
 */
const out_text = (tokens) => (tokens || []).map((t) => String(t.surface)).join('');

// ---------------------------------------------------------------------------
console.log('\n[1] 合并：把两个词并成一个');
// ---------------------------------------------------------------------------
{
  const t = [tok('この'), tok('人'), tok('は')];
  const r = applySegOverrides(t, rec(['この', '人'], [{ t: 'この人', r: 'このひと' }]));
  ok(r.changed === 1, '命中 1 段', String(r.changed));
  ok(JSON.stringify(got(r)) === '["この人","は"]',
    '★ `この`+`人` 变成一个 `この人`（后面那个「は」原样保留）', JSON.stringify(got(r)));
  ok(r.tokens[0].override === true, '合并出来的词带 override 标记');
  ok(r.tokens[0].reading === 'このひと' && r.tokens[0].known === true,
    '合并后的读音用记录里填的那个', JSON.stringify(r.tokens[0].reading));
  ok(r.tokens[1] === t[2], '★ 没有被切法覆盖的词是**原来那个对象**，不是复制品');
}

// ---------------------------------------------------------------------------
console.log('\n[2] 拆分：把一个词拆成两个');
// ---------------------------------------------------------------------------
{
  const t = [tok('この人', 'このひと'), tok('は')];
  const r = applySegOverrides(t, rec(['この人'], [{ t: 'この', r: 'この' }, { t: '人', r: 'ひと' }]));
  ok(r.changed === 1, '命中 1 段', String(r.changed));
  ok(JSON.stringify(got(r)) === '["この","人","は"]',
    '★ `この人` 被拆成 `この`+`人`', JSON.stringify(got(r)));
  ok(r.tokens[0].reading === 'この' && r.tokens[1].reading === 'ひと',
    '两段各自的读音按记录填上了', JSON.stringify([r.tokens[0].reading, r.tokens[1].reading]));
  ok(r.tokens[0].known === true && r.tokens[1].known === true, '有读音的两段算"查得到"');
}

// ---------------------------------------------------------------------------
console.log('\n[3] 只填了切法、没填读音：不许假装认识');
// ---------------------------------------------------------------------------
{
  const t = [tok('この'), tok('人')];
  const r = applySegOverrides(t, rec(['この', '人'], [{ t: 'この人' }]));
  ok(r.tokens[0].reading === '', '没有读音记录 → reading 是空的');
  ok(r.tokens[0].known === false,
    '★ known=false（界面会按"查不到的词"处理，不注音、不假装认识）');
}

// ---------------------------------------------------------------------------
console.log('\n[4] ★ 最长匹配：`この人` 和 `この人たち` 同时存在');
// ---------------------------------------------------------------------------
{
  // 两条记录放进同一个 Map（一条把 この人 合并，一条把 この人たち 合并）
  const m = new Map();
  m.set('この人', { surface: 'この人', auto: ['この', '人'], segments: [{ t: 'この人' }], at: 1 });
  m.set('この人たち', { surface: 'この人たち', auto: ['この', '人', 'たち'], segments: [{ t: 'この人たち' }], at: 1 });

  const t = [tok('この'), tok('人'), tok('たち'), tok('は')];
  const r = applySegOverrides(t, m);
  ok(JSON.stringify(got(r)) === '["この人たち","は"]',
    '★ 长的那条优先（`この人たち` 整段命中，而不是先被 `この人` 抢走）', JSON.stringify(got(r)));

  // 反向：页面上没有 `たち`，只有 `この`+`人`，这时才该命中短的那条
  const t2 = [tok('この'), tok('人'), tok('は')];
  const r2 = applySegOverrides(t2, m);
  ok(JSON.stringify(got(r2)) === '["この人","は"]',
    '长的那条对不上时，命中短的', JSON.stringify(got(r2)));
}

// ---------------------------------------------------------------------------
console.log('\n[5] 空白与标点：不在被改写范围内的必须原样留着');
// ---------------------------------------------------------------------------
{
  // ⚠️ 这里的规则**必须真实可达** —— 切法只改"怎么切"，不改文字，
  //    所以 auto 拼出来的原文和 segments 拼出来的必须完全一样，
  //    否则 buildRules 会直接丢掉它。第一版测试拿了一条不可能存下来的规则
  //    去断言，于是怎么改代码都红 —— **测试数据本身要先合法**，否则测的是空气。
  //    下面三条都是真实可达的：
  //      ① 一个词拆成两段（auto=['この']，segments=['こ','の']）；
  //      ② 一个词拆成两段，后面紧跟着顿号；
  //      ③ 两个词合并，中间夹着空格（auto=['この','人']，segments=['この人']）。

  // ① 拆分 + 中间有空格
  const t = [
    tok('この'),
    { surface: ' ', isSpace: true },
    tok('人'),
    { surface: '、', isPunct: true },
    tok('は'),
  ];
  const r = applySegOverrides(t, rec(['この'], [{ t: 'こ', r: 'こ' }, { t: 'の', r: 'の' }]));
  ok(r.changed === 1, '拆分命中 1 段', String(r.changed));
  ok(JSON.stringify(got(r)) === '["こ","の"," ","人","、","は"]',
    '★ 拆出来的两段贴在原位，中间的空格和顿号一个没丢', JSON.stringify(got(r)));
  ok(surfaceOf(r.tokens) === 'この人は',
    '★ 原文（词的内容）不变 —— 标点/空白**不进主键**，所以这里只剩词', surfaceOf(r.tokens));
  // 而"排版有没有变"要另算一笔账：把所有 token（含空白标点）的 surface 拼起来。
  // 这两个口径必须分开看 —— surfaceOf 是给你查表用的键，不是"原文"。
  ok(out_text(r.tokens) === 'この 人、は',
    '★ 连空格和顿号一起拼，原文一字不差', out_text(r.tokens));

  // ② 拆分，被覆盖范围之外的空隙不受影响
  const t2 = [tok('この人'), { surface: '、', isPunct: true }, tok('は')];
  const r2 = applySegOverrides(t2, rec(['この人'], [{ t: 'この' }, { t: '人' }]));
  ok(JSON.stringify(got(r2)) === '["この","人","、","は"]',
    '★ 拆分后，紧随其后的顿号仍在原位', JSON.stringify(got(r2)));
  ok(out_text(r2.tokens) === 'この人、は',
    '★ 原文（含顿号）一字不差', out_text(r2.tokens));
  ok(r2.tokens[2] === t2[1],
    '★ 那个顿号是**原来那个对象**，位置也没动（下标 2：この/人/、/は）');

  // ③ 合并时，两个词**中间**夹着的空格必须摆在新词**前面** ——
  //    不能丢（丢了就是悄悄改掉原文），也不能挪到后面
  //    （挪后面就成了 `この人 `，空格从"词中间"跑到了"词后面"，位置不对）。
  const t3 = [tok('この'), { surface: ' ', isSpace: true }, tok('人'), tok('は')];
  const r3 = applySegOverrides(t3, rec(['この', '人'], [{ t: 'この人' }]));
  ok(JSON.stringify(got(r3)) === '["この人"," ","は"]',
    '★ 合并后那个空格留在原位（在 `この人` 和 `は` 之间）', JSON.stringify(got(r3)));
  ok(out_text(r3.tokens) === 'この人 は',
    '★ 原文一字不差（这里最容易被悄悄丢掉的正是这个空格）', out_text(r3.tokens));
}

// ---------------------------------------------------------------------------
console.log('\n[5b] ★ 不变量：套用前后「文字」必须一字不差（批量扫）');
// ---------------------------------------------------------------------------
{
  // 光靠上面几条手写用例不够 —— 这里把"各种形状的 token 列表 × 各种形状的切法"
  // 组合起来跑一遍，逐条断言**文字不变**。这是这个功能唯一真正的硬承诺：
  // 改的是"怎么切"，不是"写的什么"。
  //
  // ⚠️ 口径说明：这里比的是 `textOnly`（去掉空白/标点后的文字），
  //    **不是**逐字对比整个原文。原因是一个**设计决定**：
  //    把 `この`+`人` 合并成 `この人` 时，两个词中间原来那个空格会跟到
  //    合并后的词**后面**（原文「この 人は」→「この人 は」）。
  //    空格没丢，但它的位置相对词边界动了 —— 这是"合并"这个动作本身的含义：
  //    原来那个空格就在被合成的两个词中间，合成之后它只能落在新词的边界上。
  //    所以逐字对比会误报，而"文字不变"才是真正该守的底线。
  //    至于空隙**在不在**、**有没有被吃掉**，上面 [5] 已经逐条钉住了
  //    （而且当初就是那条严格的逐字对比抓出了"段首换行被吃掉"这个真 bug）。
  const textOnly = (tokens) => (tokens || []).filter((t) => !t.isSpace && !t.isPunct)
    .map((t) => String(t.surface)).join('');

  const shapes = [
    [tok('この'), tok('人'), tok('は')],
    [tok('この'), tok('人'), tok('は'), tok('学生'), tok('です')],
    [tok('この人'), tok('は'), tok('学生'), tok('です')],
    [tok('この'), { surface: ' ', isSpace: true }, tok('人'), tok('は')],
    [tok('この'), { surface: '、', isPunct: true }, tok('人'), { surface: '。', isPunct: true }],
    [{ surface: '\n', isSpace: true }, tok('この'), tok('人')],
    [tok('日本語'), tok('を'), tok('勉強'), tok('します')],
    // 段首空隙 + 段尾空隙同时存在（最容易两头都丢掉的一种）
    [{ surface: '\n', isSpace: true }, tok('この'), tok('人'), { surface: '\n', isSpace: true }],
    // 词与词之间同时夹着空格和标点
    [tok('この'), { surface: ' ', isSpace: true }, { surface: '、', isPunct: true }, tok('人')],
  ];
  const rewrites = [
    [['この'], [{ t: 'こ' }, { t: 'の' }]],
    [['この人'], [{ t: 'この' }, { t: '人' }]],
    [['この', '人'], [{ t: 'この人' }]],
    [['学生', 'です'], [{ t: '学生です' }]],
    [['日本語'], [{ t: '日本' }, { t: '語' }]],
    [['は'], [{ t: 'は' }]],          // 空改写（应该被忽略）
  ];
  let bad = 0, applied = 0;
  for (const tokens of shapes) {
    const before = textOnly(tokens);
    const beforeRaw = out_text(tokens);
    for (const [auto, segments] of rewrites) {
      const r = applySegOverrides(tokens, rec(auto, segments));
      if (r.changed) applied++;
      if (textOnly(r.tokens) !== before) {
        bad++;
        console.log(`      「${beforeRaw}」→ 「${out_text(r.tokens)}」（auto=${JSON.stringify(auto)}）`);
      }
      // 空隙一个都不能少（只许换位置，不许消失）
      const gapChars = (t) => (t || []).filter((x) => x.isSpace || x.isPunct)
        .map((x) => String(x.surface)).sort().join('');
      if (gapChars(r.tokens) !== gapChars(tokens)) {
        bad++;
        console.log(`      空隙被改掉了：「${out_text(tokens)}」→「${out_text(r.tokens)}」`
          + `（空白标点 ${JSON.stringify(gapChars(tokens))} → ${JSON.stringify(gapChars(r.tokens))}）`);
      }
    }
  }
  ok(bad === 0,
    `★ ${shapes.length} 种句子 × ${rewrites.length} 种切法 = ${shapes.length * rewrites.length} 次套用：文字一字不差、空隙一个不少`,
    `${bad} 处被改坏`);
  ok(applied > 0, `其中真的有套上的（${applied} 次）—— 这条反例防止"全都没匹配所以当然没变"`, String(applied));
}

// ---------------------------------------------------------------------------
console.log('\n[6] ★ 套用不改变原文（这条是硬承诺）');
// ---------------------------------------------------------------------------
{
  const cases = [
    ['この人は学生です',
      [tok('この'), tok('人'), tok('は'), tok('学生'), tok('です')],
      rec(['この', '人'], [{ t: 'この人' }])],
    ['日本語を勉強します',
      [tok('日本'), tok('語'), tok('を'), tok('勉強'), tok('します')],
      rec(['日本', '語'], [{ t: '日本語' }])],
    ['今日はいい天気ですね',
      [tok('今日'), tok('は'), tok('いい'), tok('天気'), tok('です'), tok('ね')],
      rec(['今日'], [{ t: '今', r: 'きょ' }, { t: '日', r: 'う' }])],
  ];
  let allSame = true;
  for (const [text, tokens, overrides] of cases) {
    const before = surfaceOf(tokens);
    const r = applySegOverrides(tokens, overrides);
    if (surfaceOf(r.tokens) !== before || before !== text) {
      allSame = false;
      console.log(`      「${text}」→ 「${surfaceOf(r.tokens)}」`);
    }
  }
  ok(allSame, '★ 合并和拆分都不改变原文一个字', '有句子的字变了');
}

// ---------------------------------------------------------------------------
console.log('\n[7] ★ 套用不改动入参（不做就地修改）');
// ---------------------------------------------------------------------------
{
  const t = [tok('この'), tok('人'), tok('は')];
  const snapshot = JSON.stringify(t);
  const r = applySegOverrides(t, rec(['この', '人'], [{ t: 'この人' }]));
  ok(JSON.stringify(t) === snapshot,
    '★ 传进去的 token 数组一个字都没被改',
    `调用前 ${snapshot}\n      调用后 ${JSON.stringify(t)}`);
  ok(r.tokens !== t, '返回的是新数组，不是原来那个（调用方能看出来变了没）');
}

// ---------------------------------------------------------------------------
console.log('\n[8] 多条切法相邻，推进不能漏段也不能重复');
// ---------------------------------------------------------------------------
{
  const m = new Map();
  m.set('この人', { surface: 'この人', auto: ['この', '人'], segments: [{ t: 'この人' }], at: 1 });
  m.set('学生です', { surface: '学生です', auto: ['学生', 'です'], segments: [{ t: '学生です' }], at: 1 });
  const t = [tok('この'), tok('人'), tok('は'), tok('学生'), tok('です')];
  const r = applySegOverrides(t, m);
  ok(r.changed === 2, '两条切法都命中了', String(r.changed));
  ok(JSON.stringify(got(r)) === '["この人","は","学生です"]',
    '★ 相邻的两条都正确套上，中间的「は」没被吃掉也没重复',
    JSON.stringify(got(r)));
  ok(surfaceOf(r.tokens) === 'この人は学生です', '原文不变', surfaceOf(r.tokens));
}

// ---------------------------------------------------------------------------
console.log('\n[9] 边界：没有记录 / 空输入 / 单段记录');
// ---------------------------------------------------------------------------
{
  const t = [tok('この'), tok('人')];
  ok(applySegOverrides(t, new Map()).changed === 0, '空表 → 不改动');
  ok(applySegOverrides(t, null).changed === 0, '传 null → 不改动（不抛错）');
  ok(applySegOverrides([], rec(['この', '人'], [{ t: 'この人' }])).changed === 0, '空 token 列表 → 不改动');
  // 只有 1 段的记录 = 没真正改变切法，不该参与匹配（否则界面会显示"已改"却看不出区别）
  const one = rec(['この'], [{ t: 'この' }]);
  ok(applySegOverrides(t, one).changed === 0,
    '只有一段的记录不参与匹配（它没有改变任何东西）');
}

// ---------------------------------------------------------------------------
console.log('\n[10] 反例：页面上分出来的和记录的 auto 对不上时，不许硬套');
// ---------------------------------------------------------------------------
{
  // 记录说"原来是 この + 人"，但页面上分出来的是 この + 人は
  const t = [tok('この'), tok('人は')];
  const r = applySegOverrides(t, rec(['この', '人'], [{ t: 'この人' }]));
  ok(r.changed === 0 && JSON.stringify(got(r)) === '["この","人は"]',
    '★ 对不上就不套（宁愿不改，也不要把词切错）', JSON.stringify(got(r)));

  // 记录说"原来是一个整词 この人"，但页面上是两个词
  const t2 = [tok('この'), tok('人')];
  const r2 = applySegOverrides(t2, rec(['この人'], [{ t: 'この', r: 'この' }, { t: '人', r: 'ひと' }]));
  ok(r2.changed === 0,
    '★ 记录的是"整词拆分"，但页面上本来就是分开的 → 不套（避免重复处理）');
}

// ---------------------------------------------------------------------------
console.log('\n[11] ★ surfaceOf：主键是怎么算的');
// ---------------------------------------------------------------------------
{
  ok(surfaceOf([tok('この'), tok('人')]) === 'この人', '两个词拼起来');
  ok(surfaceOf([tok('この'), { surface: ' ', isSpace: true }, tok('人')]) === 'この人',
    '★ 空白和标点**不进主键**（否则同一个切法在不同排版下会有好几个键）');
  ok(surfaceOf([tok('この'), { surface: '、', isPunct: true }, tok('人')]) === 'この人',
    '标点也不进主键');
  ok(surfaceOf([]) === '' && surfaceOf(null) === '', '空输入 → 空串（不抛错）');
}

console.log('\n' + '='.repeat(70));
console.log(fail === 0 ? ` 全部通过（${pass} 项）` : ` ${fail} 项未通过（通过 ${pass} 项）`);
console.log('='.repeat(70));
process.exit(fail === 0 ? 0 : 1);
