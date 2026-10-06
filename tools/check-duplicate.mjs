/**
 * 同一语法点重复检查（**按 alias 精确匹配**）。
 *
 * ────────────────────────────────────────────────────────────────────
 * ⚠️ 这个工具解决的是一个"审计抓不到"的缝
 * ────────────────────────────────────────────────────────────────────
 * 我写完 n2-j-kuse-shite（〜くせして）后才发现它是**重复的** ——
 * n3-j-kuse-ni（〜くせに）里早就把 くせして 当口语变体讲过了。
 *
 * 两个审计脚本（audit-gap.mjs / search-json.mjs）都没抓住，因为它们查的是
 * "**这个字符串**出现过没有"：
 *   · 搜「くせに」→ 搜不到「くせして」这个串；
 *   · 搜「くせして」→ 在 くせに 那条的**对比小节**里出现过，于是判"已有"。
 *     结论碰巧对了，理由却不对：它以为"正文提过就算有"。
 *
 * **审计按字符串，重复按语法点 —— 中间有个缝。** 补法是给条目声明 alias。
 *
 * ────────────────────────────────────────────────────────────────────
 * ⚠️ 为什么不再用"从标题拆斜杠"的办法（上一版的教训）
 * ────────────────────────────────────────────────────────────────────
 * 上一版拿标题里 `A／B` 的片段当别名，结果报出 **77 组**"疑重复"，
 * 几乎全是假阳性：
 *   · n5-masu 标题是「〜ます／〜ません／〜ました／〜ませんでした」，
 *     n5-mashita 标题是「ました／ません」→ 片段重合 100%，但这是
 *     **同一个点在不同难度分两级写**（语法书分层讲解），不是重复；
 *   · 「なり」被 4 条 N2 文语条目共用，但它们讲的是 なり 的不同用法。
 * **标题是给人读的，里面的斜杠切分不等于"语法点身份"。**
 * 所以现在只信**显式声明的 alias**，不猜。
 */
import fs from 'node:fs';
import path from 'node:path';

// ⚠️ 路径相对**脚本自己**解析，不要相对当前工作目录。
//    原来写的是 'jp-learn/data/grammar/' —— 只有在**工作区根目录**跑才对；
//    而使用说明第六节让用户在**项目目录里**跑（node tools\xxx.mjs），
//    于是路径拼成 jp-learn/jp-learn/... 直接 ENOENT 崩掉。
//    崩掉的审计脚本比"不过的审计"更危险：它什么都没查就退出了。
const ROOT = path.resolve(import.meta.dirname, '..');
const d = path.join(ROOT, 'data', 'grammar') + path.sep;
const all = [];
// ★ 等级列表要有 N1 —— 少一个等级 = 那个等级的重复**永远查不出来**。
//   （加 N1 时它还是空的，所以以前没暴露；现在 N1 有正文了，必须一起查。）
for (const f of ['N5', 'N4', 'N3', 'N2', 'N1']) {
  if (!fs.existsSync(d + f + '.json')) continue;
  for (const x of JSON.parse(fs.readFileSync(d + f + '.json', 'utf8')).items) all.push({ f, x });
}

const out = [];
out.push('按 alias 查重（同一别名出现在 ≥2 条不同条目里）');
out.push('');
out.push('说明：只有**显式声明了 alias 的条目**才参与比对。');
out.push('没声明 alias 的条目不会误报 —— 这是刻意的（见脚本头部注释）。');
out.push('');

// 收集：alias -> [(条目, 该 alias 来自哪条)]
const idx = new Map();
for (const { f, x } of all) {
  for (const a of (Array.isArray(x.alias) ? x.alias : [])) {
    if (!idx.has(a)) idx.set(a, []);
    idx.get(a).push({ f, x });
  }
}

let bad = 0;
for (const [a, v] of [...idx.entries()].sort()) {
  if (v.length < 2) continue;
  bad++;
  out.push('⚠ 别名「' + a + '」被 ' + v.length + ' 条声明为别名：');
  for (const e of v) {
    out.push('   ' + e.f + ' ' + e.x.id.padEnd(34) + ' line=' + String(e.x.line).padEnd(8) + ' ' + String(e.x.title).slice(0, 46));
  }
  out.push('   → 同一个语法点不应该有两条，请选一条留、把另一条删掉（tools/drop-grammar.mjs）');
  out.push('');
}

// 反向检查：别名有没有指向一个**真的作为主条目存在**的 id？
// （alias 应该是"其他写法"，如果这个写法本身另有一条，就是重复）
out.push('═══ 交叉检查：alias 是否指向另一条真实存在的条目 ═══');
out.push('');
let cross = 0;
for (const { f, x } of all) {
  for (const a of (Array.isArray(x.alias) ? x.alias : [])) {
    // 别的条目的标题里以这个别名为主
    for (const { f: g, x: y } of all) {
      if (y.id === x.id) continue;
      const head = String(y.title || '').split(/[：:]/)[0].replace(/[〜～\s]/g, '');
      if (head.split(/[／/]/).some((z) => z === a)) {
        cross++;
        out.push('⚠ ' + x.id + '（' + f + '）把「' + a + '」声明为别名，');
        out.push('   但 ' + y.id + '（' + g + '）的标题主形式就是「' + a + '」→ 疑重复');
        out.push('');
      }
    }
  }
}
if (!cross) out.push('（无）');
out.push('');

out.push('─── 汇总 ───');
out.push('声明了 alias 的条目：' + all.filter((e) => (e.x.alias || []).length).length + ' 条');
out.push('别名冲突：' + bad + ' 组；交叉命中：' + cross + ' 处');
out.push(bad || cross ? '★ 有需要处理的问题' : '✓ 无重复');

/**
 * ⚠️ 报告写到 `reports/` 而不是项目根目录（2026-10 改，理由同 audit-gap.mjs）：
 * 根目录原来会被塞进一个 `_dup.txt`，既不属于项目，也没人检查它。
 * 挪进 `reports/` 之后语义清楚（"脚本产物"），目录不存在就建。
 */
const REPORTS = path.join(ROOT, 'reports');
fs.mkdirSync(REPORTS, { recursive: true });
const DUP_OUT = path.join(REPORTS, 'dup.txt');
fs.writeFileSync(DUP_OUT, out.join('\n'), 'utf8');
console.log('声明 alias 的条目 ' + all.filter((e) => (e.x.alias || []).length).length + ' 条');
console.log('别名冲突 ' + bad + ' 组；交叉命中 ' + cross + ' 处');
console.log(bad || cross ? '★ 有需要处理的问题 → 见 ' + DUP_OUT : '✓ 无重复 → 报告 reports/dup.txt');
process.exit(bad || cross ? 1 : 0);
