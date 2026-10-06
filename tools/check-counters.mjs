/**
 * check-counters.mjs —— 数字・日期・量词读法的**对账脚本**
 *
 * 为什么需要它：
 *   app/js/counter.js 里的读法表是"人写出来的规则"，如果没人核对，
 *   它和"我猜的"没有区别。这个脚本把生成结果跟**内置词库**逐条比对 ——
 *   词库里真有的形式（4月=しがつ、3本=さんぼん、1匹=いっぴき、20歳=はたち…）
 *   必须完全一致，对不上就直接失败。
 *
 * 为什么可以直接 import 浏览器的模块：
 *   app/js/counter.js 是纯函数、零依赖、不碰 DOM，所以 Node 里能直接跑。
 *   这正是把它从视图里抽出来的原因 —— 规则只有一份，校验才有效。
 *
 * 三类断言：
 *   [已知答案] 我人工确认过的读法，必须精确相等（哪怕词库里没有这个词条）
 *   [词库对账] 词库里存在该形式时，生成的读法必须与词库读音一致
 *   [边界]     0 / 大数 / 无说法的量词不能崩、不能给出错答案
 *
 * 用法：node tools/check-counters.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  numberReading, dayReading, monthReading, hourReading, minuteReading,
  COUNTERS, counterReading,
} from '../app/js/counter.js';

/**
 * ⚠️ 必须用 fileURLToPath，不能用 new URL(...).pathname ——
 * 项目路径里有空格（"DSH Workshop"），pathname 会把空格编码成 %20 导致 ENOENT。
 */
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const terms = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/index/terms.json'), 'utf8')).terms;
const lookup = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/index/lookup.json'), 'utf8')).keys;

let pass = 0;
const fails = [];
function ok(cond, label) {
  if (cond) pass++;
  else fails.push(label);
}

/** 在词库里查一个写法（顺带试全角数字变体，词库里日期常用 ４月 / １日） */
function dictReading(surface) {
  const cands = [surface];
  const zenkaku = surface.replace(/[0-9]/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xFEE0));
  if (zenkaku !== surface) cands.push(zenkaku);
  for (const c of cands) {
    for (const id of (lookup[c] || [])) {
      const t = terms[id];
      if (t && t[1]) return t[1];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// [1] 数字本身
// ---------------------------------------------------------------------------
console.log('\n[1] 整数音读');
const NUM_CASES = [
  [0, 'ゼロ'], [1, 'いち'], [4, 'よん'], [7, 'なな'], [9, 'きゅう'], [10, 'じゅう'],
  [14, 'じゅうよん'], [20, 'にじゅう'], [40, 'よんじゅう'], [70, 'ななじゅう'],
  [100, 'ひゃく'], [300, 'さんびゃく'], [600, 'ろっぴゃく'], [800, 'はっぴゃく'],
  [1000, 'せん'], [3000, 'さんぜん'], [8000, 'はっせん'],
  [10000, 'いちまん'], [12345, 'いちまんにせんさんびゃくよんじゅうご'],
  [100000000, 'いちおく'],
];
for (const [n, want] of NUM_CASES) {
  const got = numberReading(n);
  ok(got === want, `数字 ${n} 应为 ${want}，得到 ${got}`);
}

// ---------------------------------------------------------------------------
// [2] 日期：1〜10 与 20 训读，14/17/19/24/27/29 有特殊"日"
// ---------------------------------------------------------------------------
console.log('[2] 日期「〜日」');
const DAY_CASES = [
  [1, 'ついたち'], [2, 'ふつか'], [3, 'みっか'], [4, 'よっか'], [5, 'いつか'],
  [6, 'むいか'], [7, 'なのか'], [8, 'ようか'], [9, 'ここのか'], [10, 'とおか'],
  [11, 'じゅういちにち'], [14, 'じゅうよっか'], [17, 'じゅうしちにち'],
  [19, 'じゅうくにち'], [20, 'はつか'], [24, 'にじゅうよっか'],
  [27, 'にじゅうしちにち'], [29, 'にじゅうくにち'], [30, 'さんじゅうにち'], [31, 'さんじゅういちにち'],
];
for (const [d, want] of DAY_CASES) {
  const got = dayReading(d);
  ok(got === want, `${d}日 应为 ${want}，得到 ${got}`);
}

// ---------------------------------------------------------------------------
// [3] 月份 / 时刻
// ---------------------------------------------------------------------------
console.log('[3] 月份与时刻');
const MONTH_CASES = [
  [1, 'いちがつ'], [4, 'しがつ'], [7, 'しちがつ'], [9, 'くがつ'], [12, 'じゅうにがつ'],
];
for (const [m, want] of MONTH_CASES) {
  const got = monthReading(m);
  ok(got === want, `${m}月 应为 ${want}，得到 ${got}`);
}
const HOUR_CASES = [[1, 'いちじ'], [4, 'よじ'], [7, 'しちじ'], [9, 'くじ'], [12, 'じゅうにじ']];
for (const [h, want] of HOUR_CASES) {
  const got = hourReading(h);
  ok(got === want, `${h}時 应为 ${want}，得到 ${got}`);
}

// ---------------------------------------------------------------------------
// [4] 分钟（词库里没有这些词条，所以只能靠人工确认的答案）
// ---------------------------------------------------------------------------
console.log('[4] 分钟');
const MIN_CASES = [[1, 'いっぷん'], [3, 'さんぷん'], [4, 'よんぷん'],
  [6, 'ろっぷん'], [8, 'はっぷん'], [10, 'じゅっぷん'], [2, 'にふん'], [5, 'ごふん']];
for (const [m, want] of MIN_CASES) {
  const got = minuteReading(m);
  ok(got === want, `${m}分 应为 ${want}，得到 ${got}`);
}

// ---------------------------------------------------------------------------
// [5] 量词：逐条和词库对账
// ---------------------------------------------------------------------------
console.log('[5] 量词（与内置词库逐条对账）');
let checked = 0;
let matched = 0;
for (const c of COUNTERS) {
  // 〜つ 是纯和语数词，词库里「1つ」这类形式存在，可以核对
  const max = c.native ? 9 : 10;
  for (let n = 1; n <= max; n++) {
    const got = counterReading(c, n);
    ok(!!got, `${n}${c.suffix} 不该没有读法`);
    const surface = String(n) + c.suffix;
    const want = dictReading(surface);
    if (want) {
      checked++;
      // 「1日」这类多音形式（いちにち / ついたち）词库会给一个，
      // 只要生成的读法是词库里列出的任一读法就算过。
      const ids = lookup[surface] || lookup[surface.replace(/[0-9]/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xFEE0))] || [];
      const allReads = ids.map((id) => (terms[id] || [])[1]).filter(Boolean);
      if (allReads.length > 1) {
        if (allReads.includes(got)) matched++;
        else fails.push(`${surface} 生成的「${got}」不在词库读音 ${allReads.join('/')} 中`);
      } else if (got === want) {
        matched++;
      } else {
        fails.push(`${surface} 生成「${got}」，词库为「${want}」`);
      }
    }
  }
}
console.log(`      词库里有读法的形式 ${checked} 条，生成结果一致 ${matched} 条`);
// 至少要核对到一批，否则说明对账逻辑本身失效了（词库读不到就成了假绿）
ok(checked >= 30, `与词库对账的形式太少（${checked} 条），对账可能没生效`);

// ---------------------------------------------------------------------------
// [6] 边界：不能崩、不能胡说
// ---------------------------------------------------------------------------
console.log('[6] 边界');
ok(numberReading(-5) === numberReading(5), '负数取绝对值');
ok(numberReading(NaN) === 'ゼロ', 'NaN 当作 0');
ok(numberReading('123') === 'ひゃくにじゅうさん', '字符串数字也能读');
const big = numberReading(123456789);
ok(big.startsWith('いちおく'), '一亿级的数能读出来：' + big);
// 〜つ 超过 9 没有说法，必须给 null 而不是硬编一个
const tsu = COUNTERS.find((c) => c.id === 'tsu');
ok(counterReading(tsu, 10) === null, '〜つ 的 10 应无说法（返回 null）');
ok(counterReading(tsu, 3) === 'みっつ', '〜つ 的 3 应为 みっつ');

// 「4月」这种词库里同时有 しがつ 与 よんがつ 的情形，确认我们选的是常用那个
ok(monthReading(4) === 'しがつ', '4月 用 しがつ 而不是 よんがつ');
ok(monthReading(7) === 'しちがつ', '7月 用 しちがつ');
ok(monthReading(9) === 'くがつ', '9月 用 くがつ');

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(72));
if (fails.length) {
  console.log(`  ✗ 失败 ${fails.length} 项：`);
  for (const f of fails) console.log('    - ' + f);
  console.log('='.repeat(72));
  process.exit(1);
}
console.log(`  ✓ 全部通过（${pass} 项断言，其中 ${matched} 项与内置词库对账一致）`);
console.log('='.repeat(72));
