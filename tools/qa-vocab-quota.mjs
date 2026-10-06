/**
 * qa-vocab-quota.mjs —— 真浏览器端到端验证「每日复习上限」。
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么需要它（这个脚本存在的唯一理由）
 * ────────────────────────────────────────────────────────────────────
 * 纯函数那一层已经有单测了（`srs.js` 的 countsAgainstDailyReview /
 * reviewQuotaLeft / capByDailyReview，以及 `test-session.mjs` 对 buildPlan 的断言）。
 * 它们证明不了**界面有没有把两个数字都写出来** —— 而这正是那个 bug 的全部：
 *
 *   修之前：按钮写「开始复习（537 个到期）」，点进去只给 40 题，
 *           页面上任何地方都不说还有 497 个。用户以为程序吃掉了他的词。
 *   修之后：按钮写「开始复习（本轮 40 个，另有 80 个顺延）」，
 *           额度行写「每日复习：今天已复习 0 / 40，今天还剩 40 个
 *           （另有 80 个到期，会顺延到明天）」。
 *
 * 所以这个脚本要卡死三件事：
 *   ① 两个数字**必须同时可见**（额度行 + 按钮各有各的写法）；
 *   ② 两个数字**必须不相等**（只写一个数的写法要能红）；
 *   ③ 点下去之后，这一场真的只给额度内那么多个（界面真的接上了排程）。
 *
 * ────────────────────────────────────────────────────────────────────
 * 它是怎么跑的
 * ────────────────────────────────────────────────────────────────────
 * 走共用骨架 `tools/qa-harness.mjs`（起临时只读服务、把 /api/* 转发到真服务、
 * 连 headless Edge、逐条调 `window.__QA.check.*`、跑完删掉浏览器临时用户目录）。
 * 载荷是 `app/__qa__/vocab-quota.html` + `vocab-quota.js`，里面往**真 IndexedDB**
 * 预置 120 个到期复习 —— 临时用户目录跑完就删，碰不到用户自己的数据。
 *
 * 依赖：服务已启动（`node server.js 8787`）—— 载荷要建内置词库缓存、
 *       还要从 /data/vocab 读词库。没启动的话内置词库建不起来，会红。
 *
 * 用法：
 *   node tools/qa-vocab-quota.mjs              # 自检
 *   node tools/qa-vocab-quota.mjs --verbose    # 把每条断言的实测数据也打出来
 */
import { runQa } from './qa-harness.mjs';

const code = await runQa({
  title: '每日复习上限：额度行 / 按钮 / 真的点一下 / 范围 20–200',
  page: 'vocab-quota.html',
  checks: [
    ['seedDueCards', '★★ 预置的 120 张卡真的是"已到期 + 复习状态"（超过默认上限 50）'],
    ['quotaLineShowsBoth', '★★ 额度行同时写了「今天还剩」和「顺延到明天」两个数'],
    ['buttonShowsBothNumbers', '★★★ 主按钮同时出现「本轮 N 个」和「另有 M 个顺延」，且 N ≠ M'],
    ['sessionHonoursQuota', '★★★ 真的点一下按钮：这一场只给额度内那么多个，不是 120'],
    ['sessionHonoursTightLimit', '★★★ 额度调到下限 20 再点一次：本场恰好 20 题（证明"按额度收窄"真的在起作用）'],
    ['reviewLimitRange', '★★★ 范围 20–200：数据层把 0 / 99999 夹到边界，界面不再出现「不限量」，输入框 min/max 与常量一致'],
    ['settingsField', '★ 设置页「背单词」卡片有「每天最多复习多少个词」标签和输入框'],
    ['noErrors', '页面无异常、控制台无 error'],
  ],
  // 失败时最想知道的两件事：预置数据到底成没成、页面里报了什么异常
  before: async ({ evaluate }) => {
    try {
      const raw = await evaluate('JSON.stringify(window.__QA && window.__QA.facts)');
      const facts = JSON.parse(raw || 'null');
      if (facts && facts.seeded) {
        console.log(`  预置：${facts.seeded} 个词 / ${facts.dueCards} 张到期卡，`
          + `每日复习上限 ${facts.limit}`);
      }
      const steps = JSON.parse(await evaluate('JSON.stringify(window.__QA && window.__QA.steps)') || '[]');
      for (const s of steps) console.log(`  · ${s}`);
    } catch { /* 诊断拿不到就算了，不影响断言 */ }
  },
});

process.exit(code);
