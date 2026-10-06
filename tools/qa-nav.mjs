/**
 * qa-nav.mjs —— 真浏览器量"滚动之后顶部导航栏还在不在原位"。
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么需要它
 * ────────────────────────────────────────────────────────────────────
 * 用户 2026-10 反馈的原话：
 *
 *     「页面滑动到下面的时候，顶部导航栏也跟着上去了，
 *       我希望导航栏不管页面滑动到哪都随时可见。」
 *
 * 这是一个**滚动之后的几何事实**，只有真排版引擎知道答案：
 *   `position: sticky` 有没有生效，取决于
 *     · 它的祖先里有没有 `overflow: hidden/auto/scroll` 的元素
 *       （有的话 sticky 会相对**那个祖先**粘，而不是相对视口）
 *     · 真正产生滚动的是 `documentElement` 还是别的容器
 *     · 有没有浏览器扩展注入的 CSS 把它覆盖掉（本项目真的遇到过，
 *       见 theme.css 里 `.nav` 那段注释：扩展把导航栏压成了 1px 高）
 *
 * 假 DOM 里连"滚动"这个概念都没有，所以这个脚本不可替代。
 *
 * 用法：
 *   node tools/qa-nav.mjs              # 自检
 *   node tools/qa-nav.mjs --verbose    # 把量到的几何数据全打出来
 */
import { runQa } from './qa-harness.mjs';

const code = await runQa({
  title: '顶部导航栏在滚动后是否始终可见',
  page: 'nav.html',
  checks: [
    ['navStaysVisible', '★★ 滚到页面中段和底部时，导航栏仍然贴在视口顶部'],
    ['navDiag', '★ 没有 overflow 祖先会让 sticky 失效'],
    // ★ 带视口宽度 = 这一条在 420px 窄屏下量。
    //   因为"为了修 sticky 而删掉 .nav 自己的 overflow"之后，
    //   必须证明窄屏下导航栏没被压扁（那正是当初加 overflow 想兜的坑）。
    ['navTallOnNarrow', '★ 窄屏下导航栏没被压扁、导航项仍在一行内', 420],
    // ★ 修导航栏的**副作用**：body 从 height:100% 改成 min-height:100% 之后，
    //   "短页面页脚贴底"这件事必须还在（它本来也是靠 height:100% 实现的）。
    ['footAtBottomOnShortPage', '★ 短页面时页脚仍然贴在视口底部（修导航栏的副作用）'],
  ],
  // 把诊断打出来 —— sticky 坏掉时，"谁是滚动容器/哪个祖先拦了它"
  // 比"它跑了"这一句有用得多
  before: async ({ evaluate }) => {
    try {
      const d = await evaluate('JSON.stringify(window.__QA && window.__QA.diag)');
      const parsed = JSON.parse(d || 'null');
      if (parsed && parsed.navHeight) {
        console.log(`  导航栏：position=${parsed.position} top=${parsed.top} z-index=${parsed.zIndex} `
          + `高度=${parsed.navHeight}px`);
        console.log(`  滚动容器=${parsed.scrollingElement}  `
          + `html.overflow=${parsed.htmlOverflow}  body.overflow=${parsed.bodyOverflow}`);
        if (parsed.badAncestors && parsed.badAncestors.length) {
          console.log('  ⚠ 会让 sticky 失效的祖先：'
            + parsed.badAncestors.map((b) => `${b.tag}(overflow=${b.overflow})`).join('、'));
        } else {
          console.log('  ✓ 祖先链干净（没有 overflow 拦截）');
        }
      }
    } catch { /* 诊断拿不到就算了，不影响断言 */ }
  },
});

process.exit(code);
