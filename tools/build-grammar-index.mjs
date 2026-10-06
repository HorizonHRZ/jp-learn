/**
 * 重新生成 data/grammar/index.json。
 *
 * 用法：node tools/build-grammar-index.mjs
 *
 * 为什么要有这个脚本：语法正文按等级拆在 N5.json / N4.json … 里，但目录页
 * 只需要 id/等级/分类/标题/一句话意思 —— 不该把几百条正文全下载下来。
 * 所以生成一份小小的索引。**索引必须和正文一致**，靠脚本生成而不是手写，
 * 就不会出现"手改了正文忘了改索引"的不一致。
 *
 * `tools/test-grammar.mjs` 会检查索引和正文是否对得上。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ⚠️ 必须用 fileURLToPath：项目路径含空格，new URL().pathname 会变成 %20
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'data', 'grammar');

/** 等级顺序（JLPT 由易到难）。界面上的筛选按钮按这个顺序排 */
export const LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];

function main() {
  if (!fs.existsSync(DIR)) {
    console.error(`找不到目录：${DIR}`);
    process.exit(1);
  }

  // 找出所有形如 N5.json / N4.json 的等级文件
  //
  // ⚠️ 正则里那个点**必须转义**（\.json）。原来的写法是 `.json`，
  //    点在正则里是"任意字符"，于是 `relations.json` 也匹配上了 ——
  //    结果 index.json 里出现了一个叫 `relations` 的"等级"，
  //    384 条语法却报"5 个等级"。**一个转义符的错，不报错，只是多一个假等级。**
  //    这个坑是我加 relations.json 的同一个改动里踩出来的，
  //    下面是显式排除 + 转义两道保险。
  const files = fs.readdirSync(DIR)
    .filter((f) => /^[A-Za-z0-9]+\.json$/.test(f) && f !== 'index.json' && f !== 'relations.json')
    .sort();

  // 关系表（id -> [{to, why}]），由 tools/check-related.mjs 校验
  let rel = {};
  const relPath = path.join(DIR, 'relations.json');
  if (fs.existsSync(relPath)) {
    try {
      rel = JSON.parse(fs.readFileSync(relPath, 'utf8')).relations || {};
    } catch (e) {
      console.error('relations.json 解析失败：' + e.message);
      process.exit(1);
    }
  }

  const items = [];
  const levels = [];
  const categories = new Set();
  const problems = [];

  for (const f of files) {
    const full = path.join(DIR, f);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (e) {
      problems.push(`${f}: JSON 解析失败 —— ${e.message}`);
      continue;
    }
    const lvl = data.level || f.replace(/\.json$/, '');
    if (!levels.includes(lvl)) levels.push(lvl);
    for (const it of (data.items || [])) {
      // 关系：写进索引，界面才能显示"相关条目"并跳转。
      // 关系的合法性（悬空 id、单向关系）由 tools/check-related.mjs 强制。
      const myRel = Array.isArray(rel[it.id]) ? rel[it.id] : [];
      items.push({
        id: it.id,
        level: it.level || lvl,
        category: it.category || '',
        // ⚠️ line 也必须进索引。这是同一个错误的第二次：
        //    我在正文里给条目写了 line: "written"，但忘了写进索引，
        //    结果"过滤出书面语线的内容"这件事从索引层面就做不到。
        //    教训：**正文里新加一个字段，就要问一句"检索/筛选需不需要它"**。
        //    不填按 jlpt 处理（老条目没有这个字段，不能因为它们缺字段就报错）。
        line: it.line || 'jlpt',
        title: it.title || '',
        meaning: it.meaning || '',
        // ⚠️ tags 必须进索引。原因（实测发现）：
        //    条目上打了「书面语」「长句」「文语」这类标签，但检索只搜
        //    title/meaning/category/id —— 结果用户**搜「书面语」一条都搜不到**。
        //    而按标签搜索恰恰是初学者最自然的用法（他不知道自己不知道什么，
        //    只能按概念去翻）。tags 是短字符串数组，进索引不会让体积失控。
        tags: Array.isArray(it.tags) ? it.tags : [],
        // ⚠️ alias 也要进索引，理由和 tags 一样 —— 而且更硬：
        //    alias 是"同一语法点的其他写法"，用户搜「くせして」时，
        //    讲它的那一条标题写的是「〜くせに」。不进索引就搜不到。
        //    （这一条是 2026-10 发现 n2-j-kuse-shite 是重复条目时加的，
        //      alias 字段的由来见 tools/内容-JLPT-N3c.mjs 里 くせに 那条的注释。）
        alias: Array.isArray(it.alias) ? it.alias : [],
        // related: [{to, why}] —— 跨等级、跨线的关联条目。
        // 只放 id 和一句话理由；标题由界面从索引里反查，
        // 这样**标题改了不用同步改 relations.json**（去规范化）。
        related: myRel.map((z) => ({ to: z.to, why: z.why })),
        file: f,
      });
      if (it.category) categories.add(it.category);
    }
  }

  // 等级按 LEVELS 的顺序排，未知等级放最后（保持稳定）
  levels.sort((a, b) => {
    const ia = LEVELS.indexOf(a); const ib = LEVELS.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  // 条目排序：先按等级，再按分类，最后按 id（保证每次生成结果完全一样）
  items.sort((a, b) => {
    const la = LEVELS.indexOf(a.level); const lb = LEVELS.indexOf(b.level);
    if (la !== lb) return (la < 0 ? 99 : la) - (lb < 0 ? 99 : lb);
    if (a.category !== b.category) return a.category.localeCompare(b.category, 'zh');
    return a.id.localeCompare(b.id);
  });

  const index = {
    schema: 1,
    generatedAt: new Date().toISOString().slice(0, 10),
    count: items.length,
    levels,
    categories: [...categories].sort((a, b) => a.localeCompare(b, 'zh')),
    items,
  };

  fs.writeFileSync(path.join(DIR, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');

  console.log(`已生成 data/grammar/index.json`);
  console.log(`  ${files.length} 个等级文件、${items.length} 条语法、${levels.length} 个等级、${index.categories.length} 个分类`);
  if (levels.length) console.log(`  等级: ${levels.join(', ')}`);
  if (index.categories.length) console.log(`  分类: ${index.categories.join(', ')}`);
  if (problems.length) {
    console.log('\n⚠️ 有问题：');
    problems.forEach((p) => console.log('  ' + p));
    process.exit(1);
  }
}

main();
