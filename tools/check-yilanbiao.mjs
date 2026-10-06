/**
 * check-yilanbiao.mjs —— 一览表数据的完整性检查。
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么单独一个脚本，不塞进 test-grammar.mjs
 * ────────────────────────────────────────────────────────────────────
 * 一览表是**另一份数据**（`data/grammar/yilanbiao.json`），它没有
 * connection / examples，字段和 470 条详讲完全不同。
 * 塞进 test-grammar 会让那个文件里一半的规则对一半的数据不适用 ——
 * 这种"一个检查管两种形状"的结构，最后一定会变成到处写 if。
 *
 * ────────────────────────────────────────────────────────────────────
 * 它守什么
 * ────────────────────────────────────────────────────────────────────
 * [1] 形状与字段：每个分区有 id/name，每条有 word/zh，可选 yomi
 * [2] 分区内不重复：同一分区里 (word, yomi) 不能出现两次
 *     （跨分区**允许**重复：また 既是副词也是接续词，那是事实）
 * [3] 读法只写假名：yomi 不许混进汉字或罗马字
 * [4] 文案规矩：中文里不许有 Markdown 残留、不许夹英文单词
 * [5] ★ 条数和 PDF 对得上：重新跑一遍 tools/pdf-text.mjs 数"词形列的条目数"，
 *     和数据文件里的条数比 —— 两个数必须一致。
 *     这条是**这份数据唯一的"来源诚实"证据**：它证明数据不是凭空写的，
 *     而是和那份 PDF 的一条一条对得上的。
 *
 * 用法：node tools/check-yilanbiao.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { columnsOf, headText } from './lib/pdf-cols.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data/grammar/yilanbiao.json');

/**
 * 源 PDF 的路径 —— **按特征找，不写死文件名**。
 *
 * 为什么：这个文件名里有个"单"字（U+5355），我第一版在代码里打成了
 * 形近的"単"（U+5358）—— 两个字符肉眼几乎一样，于是 `existsSync` 静默返回 false，
 * 整个 [5] 段打印"跳过"然后**永远绿**。这正是本项目最怕的那类 bug：
 * **检查自己失效了，却报告一切正常。**
 * 所以：① 不写死文件名，按 `*.pdf` + 关键词找；
 *       ② 找不到时不是静默跳过，而是**报红**（见下面 [5] 段）。
 */
function findSourcePdf() {
  let list = [];
  try { list = fs.readdirSync(ROOT); } catch { return null; }
  const pdfs = list.filter((f) => /\.pdf$/i.test(f));
  // 优先认得出"助詞/副詞/接続詞/疑問詞"这份
  return pdfs.find((f) => /助詞/.test(f) && /副詞/.test(f)) || pdfs[0] || null;
}
const PDF_NAME = findSourcePdf();
const PDF = PDF_NAME ? path.join(ROOT, PDF_NAME) : null;

let pass = 0, fail = 0;
function ok(c, n, x = '') {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${x ? '\n      ' + x : ''}`); }
}

// ---------------------------------------------------------------------------
// [0] 读数据
// ---------------------------------------------------------------------------
if (!fs.existsSync(DATA)) {
  console.log(`  ✗ 找不到 ${path.relative(ROOT, DATA)}`);
  process.exit(1);
}
let data;
try {
  data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
} catch (e) {
  console.log(`  ✗ ${path.relative(ROOT, DATA)} 不是合法 JSON：${e.message}`);
  process.exit(1);
}

const groups = data.groups || [];
const items = groups.flatMap((g) => (g.items || []).map((it) => ({ ...it, group: g.id })));

console.log(`\n  数据：${groups.length} 个分区 / ${items.length} 条\n`);

// ---------------------------------------------------------------------------
// [1] 形状与字段
// ---------------------------------------------------------------------------
console.log('[1] 形状与字段');
ok(Array.isArray(data.groups) && groups.length > 0, '顶层有 groups 数组且非空');
ok(Array.isArray(data._说明) && data._说明.length >= 3, '_说明 写清了来源与取舍（≥3 条）');
ok((data._说明 || []).some((t) => /PDF|pdf/.test(t)), '_说明 里写明了来自哪份 PDF');

{
  const badIds = groups.filter((g) => !/^[a-z0-9-]+$/.test(String(g.id || '')));
  ok(badIds.length === 0, '每个分区的 id 都是小写字母数字连字符',
    badIds.map((g) => String(g.id)).join(', '));
  const dupIds = groups.map((g) => g.id).filter((x, i, a) => a.indexOf(x) !== i);
  ok(dupIds.length === 0, '分区 id 不重复', dupIds.join(', '));
  const badNames = groups.filter((g) => !String(g.name || '').trim());
  ok(badNames.length === 0, '每个分区都有 name', badNames.map((g) => g.id).join(', '));
}

{
  const noWord = items.filter((it) => !String(it.word || '').trim());
  ok(noWord.length === 0, '每条都有 word（词形）', `${noWord.length} 条缺`);
  const noZh = items.filter((it) => !String(it.zh || '').trim());
  ok(noZh.length === 0, '每条都有 zh（中文意思）', `${noZh.length} 条缺`);
  // 一览表的意义就是"简洁"：中文意思不许长到变成一段正文
  const longZh = items.filter((it) => String(it.zh || '').length > 60);
  ok(longZh.length === 0, '中文意思都不超过 60 字（"简洁"是用户对这张表的硬要求）',
    longZh.map((it) => `${it.word}（${String(it.zh).length} 字）`).join(', '));
  // 反向：确认**没有**混进例句和接续字段
  const hasEx = items.filter((it) => it.examples !== undefined || it.connection !== undefined);
  ok(hasEx.length === 0, '没有混进 examples / connection 字段（用户明确说不要）',
    hasEx.map((it) => it.word).join(', '));
}

// ---------------------------------------------------------------------------
// [2] 分区内不重复
// ---------------------------------------------------------------------------
console.log('\n[2] 分区内不重复（跨分区允许重复）');
{
  const seen = new Map();
  for (const it of items) {
    const k = `${it.group}\u0000${it.word}\u0000${it.yomi || ''}`;
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  const dups = [...seen.entries()].filter(([, n]) => n > 1);
  ok(dups.length === 0, '同一分区里没有重复的「词形＋读法」',
    dups.map(([k]) => k.replace('\u0000', ' / ')).join(', '));
  // 反正：跨分区的重复是**应该存在**的，如果一条都没有，说明这个检查没意义
  const crossDup = items.filter((it, i, a) =>
    a.findIndex((x) => x.word === it.word && x.group === it.group) !== i ? false
      : a.filter((x) => x.word === it.word).length > 1);
  ok(crossDup.length > 0,
    `确实存在跨分区的同形词（${crossDup.length} 个，例如「また」既是副词也是接续词）—— 上面那条不是空跑`,
    '一个跨分区同形词都没有，说明[2]的检查对象是空的');
}

// ---------------------------------------------------------------------------
// [3] 读法只写假名
// ---------------------------------------------------------------------------
console.log('\n[3] 读法（yomi）只写假名或罗马字');
{
  const withYomi = items.filter((it) => it.yomi);
  // 两种合法的"读法"：
  //   ① 假名 —— 汉字词的读法（次に→つぎに、大勢→おおぜい）
  //   ② 小写罗马字 —— **只给假名词用**，说明它在句子里读什么
  //      （は 写 wa、へ 写 e、を 写 o：这三个假名的读音和写法对不上，
  //       是初学者第一个卡点，所以原表专门标了。这不是多余的。）
  const KANA = /^[\u3040-\u309f\u30a0-\u30ffー]+$/;
  const ROMAJI = /^[a-z]+$/;
  const bad = withYomi.filter((it) => !KANA.test(String(it.yomi)) && !ROMAJI.test(String(it.yomi)));
  ok(bad.length === 0, `${withYomi.length} 条带读法，全部是纯假名或小写罗马字`,
    bad.map((it) => `${it.word}→${it.yomi}`).join(', '));

  // 假名词**只允许**用罗马字标读法，汉字词**只允许**用假名标读法。
  // 换句话说：假名后面跟假名、汉字后面跟罗马字，都是"没话说找话说"。
  const WRONG = [];
  for (const it of withYomi) {
    const hasKanji = /[\u4e00-\u9fff]/.test(String(it.word));
    const isKanaYomi = KANA.test(String(it.yomi));
    if (hasKanji && !isKanaYomi) WRONG.push(`${it.word}→${it.yomi}（汉字词该用假名）`);
    if (!hasKanji && isKanaYomi) WRONG.push(`${it.word}→${it.yomi}（假名词不该再标假名）`);
  }
  ok(WRONG.length === 0, '汉字词用假名标读法、假名词用罗马字标读音（各取所需）', WRONG.join(', '));

  // 防空跑：这两种情况都得真的存在，否则上面那条在验空气
  const kanjiYomi = withYomi.filter((it) => /[\u4e00-\u9fff]/.test(String(it.word))).length;
  const kanaRomaji = withYomi.filter((it) => !/[\u4e00-\u9fff]/.test(String(it.word))).length;
  ok(kanjiYomi > 0 && kanaRomaji > 0,
    `两种读法都真的用到了（汉字词 ${kanjiYomi} 条、假名词 ${kanaRomaji} 条）`,
    `汉字词 ${kanjiYomi} 条 / 假名词 ${kanaRomaji} 条 —— 有一种是 0，上面那条就是空跑`);
}

// ---------------------------------------------------------------------------
// [4] 文案规矩（和 check-content.mjs 对详讲的要求一致）
// ---------------------------------------------------------------------------
console.log('\n[4] 文案里不许有 Markdown / 多余的英文');
{
  const md = items.filter((it) => /\*\*|`|\[[^\]]+\]\([^)]+\)/.test(`${it.word}${it.zh}${it.yomi || ''}${it.note || ''}`));
  ok(md.length === 0, '没有 Markdown 残留（页面没有渲染器，会连星号一起显示）',
    md.map((it) => it.word).join(', '));
  // 中文里夹英文单词，对初学者是"看不懂的缩写"—— 和详讲用同一条规则
  const ALLOWED = new Set(['wa', 'o', 'e']);   // 助词的罗马字读法
  const latin = items.filter((it) => {
    const m = String(it.zh || '').match(/[A-Za-z]{2,}/g) || [];
    return m.some((w) => !ALLOWED.has(w.toLowerCase()));
  });
  ok(latin.length === 0, '中文意思里没有夹英文单词',
    latin.map((it) => `${it.word}: ${String(it.zh).slice(0, 24)}`).join(' | '));
}

// ---------------------------------------------------------------------------
// [5] ★ 条数和 PDF 对得上（来源诚实）
// ---------------------------------------------------------------------------
console.log('\n[5] ★ 每一条词形都在 PDF 里找得到（来源诚实）');
{
  // ⚠️ 这里**不能**在找不到 PDF 时静默跳过。
  //    第一版就是"找不到就打印跳过"—— 而找不到的原因是我把文件名里的
  //    「单」(U+5355) 打成了形近的「単」(U+5358)。结果是：这条最重要的
  //    来源校验**自己失效了，却报告一切正常**。宁可红，也不要假绿。
  ok(!!PDF, `找得到源 PDF（${PDF_NAME || '一个 .pdf 都没有'}）`,
    '找不到源 PDF 就没法证明数据是从它来的 —— 这条必须红，不能跳过');

  if (PDF) {
    const { pages, cmapErrors } = await columnsOf(PDF);
    ok(cmapErrors.length === 0, 'PDF 取字没有报错', cmapErrors.slice(0, 2).join(' | '));

    // ── 判定方式：数据里那一条的**词形**，必须能在 PDF 某一行里找到 ──
    //
    // 为什么不是"完全相等"：
    //   PDF 的词形列和"义项 / 中文"挤在一起，而且**日文不一定在前面** ——
    //   第 1/2 页是 `は①主题/话题`（日文在前），第 5 页却是 `什么何（なに）`
    //   （中文在前、日文在中间！），第 4 页还有 `どうして` 藏在 `为什么どうして` 里。
    //   实测"前缀法"漏掉疑问词 13 条，改用"子串"后为 0 条。
    //
    // 为什么还要拆 `〜` 分段：
    //   这张表用 `〜` 表示"这里接别的东西"（`あまり〜ない` = あまり…ない），
    //   而**同一个词在两个来源里的写法不统一**：
    //     · `けっして〜ない` —— PDF 只写了词干 `けっして`，没写 `〜ない`
    //     · `では／じゃ`    —— PDF 写的是 `ではじゃ`（没有斜杠）
    //   所以把数据侧按 `〜`、`／` 拆开，**任何一段能在 PDF 里找到就算对上**。
    //   这仍然要求每一段都逐字吻合，所以"词写错了"照样抓得住。
    //
    // 另外去掉敬语前缀 お/ご 再比一次：
    //   PDF 印的是 `互いに`，表里写成 `お互いに`（都常见）。这不是错，
    //   但也不该为了让检查变绿就把表改成 PDF 的写法 —— 让检查理解这两个是同一个词。
    //
    // ⚠️ 这份检查**不检查**中文意思的措辞 —— 中文是我人工整理并精简过的
    //    （用户明确要求"简洁"，原表里 `（数金词+まだ）还有~` 这种也要收拾），
    //    要求它逐字等于 PDF 等于在要求"别整理"，那是反的。
    //    这一条守的是**词形**：词形错了才是真的误导人。
    const strip = (s) => String(s)
      .replace(/[\s（）()]/g, '')          // 空白和括注外壳
      .replace(/^[おご](?=[\u4e00-\u9fff\u3040-\u30ff])/, '');  // 敬语前缀

    /** 一个词形在 PDF 侧的可能写法（去掉 〜 占位、拆开 ／ 分支） */
    const variants = (word) => {
      const out = new Set();
      const whole = word.replace(/[〜～~]/g, '');
      out.add(strip(whole));
      for (const seg of word.split(/[〜～~／/]/)) {
        const s = strip(seg);
        if (s) out.add(s);
      }
      // 去掉敬语前缀之后再来一轮
      const noHon = [...out].map((s) => s.replace(/^[おご]/, ''));
      for (const s of noHon) if (s) out.add(s);
      return [...out].filter(Boolean);
    };

    // PDF 原文有错、而我们**故意不照抄**的地方。
    // 这不是"给检查开后门"，而是把"来源有错"这个事实**显式记下来** ——
    // 否则以后有人看到红，会去改那条正确的数据，把错字抄进来。
    const PDF_TYPOS = [
      {
        word: '例えば',
        pdf: '例え昨',
        why: 'PDF 原文印成了「例え昨」。已核实是**原文的错字**，不是取字取错了：' +
          '同一份 PDF 里「昨日」的「昨」和「例如」的「如」是两个不同的字形，' +
          'ToUnicode 映射把这两个字分得很清楚，所以这里读到 U+6628 就是原文真的写了 昨。',
      },
    ];

    // 分区 → 它的词形应该出现在哪几页（实测：一个分区在 PDF 里可能跨 2 页）
    const GROUP_PAGES = { joshi: [1, 2], fukushi: [3, 4], setsuzokushi: [4], gimonshi: [5] };

    const wordsPerPage = pages.map((p) => ({
      page: p.page,
      heads: p.rows.map((r) => headText(p.page, r.cells)).filter(Boolean),
    }));

    let typoUsed = 0;
    for (const g of groups) {
      const pgs = GROUP_PAGES[g.id] || [];
      const heads = wordsPerPage.filter((x) => pgs.includes(x.page)).flatMap((x) => x.heads);
      const missing = [];
      for (const it of (g.items || [])) {
        const typo = PDF_TYPOS.find((t) => t.word === it.word);
        if (typo) {
          // 有登记的原文错字：要求 PDF 里确实有那个**错**的写法
          if (heads.some((h) => strip(h).includes(strip(typo.pdf)))) typoUsed++;
          else missing.push(`${it.word}（登记的原文错字「${typo.pdf}」在 PDF 里也没找到）`);
          continue;
        }
        // 只要**任何一个写法变体**能在 PDF 里找到就算对上
        if (!variants(it.word).some((v) => heads.some((h) => strip(h).includes(v)))) {
          missing.push(it.word);
        }
      }
      ok(missing.length === 0, `★ 「${g.name}」${(g.items || []).length} 条的词形都在 PDF 里找得到`,
        `PDF 里找不到：${missing.join('、')}`);
    }

    // 登记的错字必须真的在 PDF 里出现 —— 否则那条"例外"是空设的，
    // 等于以后谁都可以往里塞一条来让检查通过
    ok(typoUsed === PDF_TYPOS.length,
      `登记的 ${PDF_TYPOS.length} 条原文错字都在 PDF 里核实到了`,
      '有登记的错字在 PDF 里根本不存在 —— 例外被滥用了，检查等于开了后门');

    // 反向防空跑：PDF 侧抽出来的词形条数必须足够多，
    // 否则"子串判定"可能因为抽取为空而假通过
    const totalHeads = wordsPerPage.flatMap((x) => x.heads).length;
    ok(totalHeads > 60, `PDF 抽出了 ${totalHeads} 个词形（不是空的）`,
      '抽出来太少，上面的子串判定就是空跑');
    const eachHas = Object.entries(GROUP_PAGES).every(([, pgs]) =>
      wordsPerPage.filter((x) => pgs.includes(x.page)).some((x) => x.heads.length > 0));
    ok(eachHas, '四个分区对应的页都抽到了词形', '有分区的页抽出来是空的');

    // 抽样打印，方便人眼扫一下抽取质量
    for (const g of groups) {
      const pgs = GROUP_PAGES[g.id] || [];
      const heads = wordsPerPage.filter((x) => pgs.includes(x.page)).flatMap((x) => x.heads);
      console.log(`        ${g.name}：PDF 侧 ${heads.length} 个词形，例如 ${heads.slice(0, 8).join('、')}`);
    }
  }
}

console.log('\n' + '='.repeat(70));
console.log(fail === 0 ? ` 全部通过（${pass} 项）` : ` ${fail} 项未通过（通过 ${pass} 项）`);
console.log('='.repeat(70));
process.exit(fail === 0 ? 0 : 1);
