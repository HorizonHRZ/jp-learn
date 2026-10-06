/**
 * `tools/qa-nav.mjs` 的载荷：在真浏览器里量"滚动之后导航栏还在不在原位"。
 *
 * ────────────────────────────────────────────────────────────────────
 * 量什么
 * ────────────────────────────────────────────────────────────────────
 *   ① 把页面撑得足够长（真滚动）
 *   ② 滚到 0 / 中段 / 底部
 *   ③ 每一次都量 `#nav` 的 `getBoundingClientRect().top`
 *      —— **粘住了就应该始终是 0**（或非常接近 0）
 *   ④ 顺便把诊断信息带回来：谁是滚动容器、祖先里有没有 overflow 非 visible
 *
 * 第 ④ 步很重要：`position: sticky` 失效最常见的原因就是
 * **某个祖先有 `overflow: hidden/auto/scroll`** —— 那样 sticky 会相对
 * 那个祖先粘，而不是相对视口。光看"导航栏跑了"是查不出这一点的。
 */
window.__QA = { status: 'starting', errors: [], check: {}, diag: {} };

window.addEventListener('error', (e) => {
  window.__QA.errors.push(`window.error: ${e.message || ''} @ ${e.filename || ''}:${e.lineno || ''}`);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  window.__QA.errors.push('unhandledrejection: ' + ((r && r.message) || String(r)));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => document.querySelector(s);

try {
  await import('/js/app.js');
  // 等路由把首页渲染出来
  for (let i = 0; i < 60; i++) {
    if ($('#mount') && $('#mount').children.length > 0) break;
    await sleep(250);
  }
  await sleep(400);
  window.__QA.status = 'ready';
} catch (e) {
  window.__QA.status = 'threw';
  window.__QA.errors.push('启动 app.js 失败: ' + ((e && e.stack) || String(e)));
}

/** 把页面撑长，保证"滚得动" —— 短页面测不出 sticky 有没有坏 */
function makeLong() {
  let filler = document.getElementById('qa-filler');
  if (!filler) {
    filler = document.createElement('div');
    filler.id = 'qa-filler';
    filler.style.cssText = 'height:3000px;';
    const mount = $('#mount');
    if (mount) mount.appendChild(filler);
  }
  return document.documentElement.scrollHeight;
}

/**
 * 查"祖先链里谁会让 sticky 失效"。
 *
 * ⚠️ `overflow: hidden/auto/scroll` 的祖先会让 `position: sticky`
 *    相对**那个祖先**粘，而不是相对视口 —— 表现就是"看似没生效"。
 *    所以这个诊断比"粘没粘住"本身更有用：它直接指出**凶手是谁**。
 */
function overflowAncestors() {
  const out = [];
  let n = $('#nav');
  while (n && n !== document.documentElement) {
    const cs = getComputedStyle(n);
    const ov = [cs.overflowX, cs.overflowY].join('/');
    if (!/^visible\/visible$/.test(ov)) {
      out.push({ tag: n.tagName.toLowerCase() + (n.id ? '#' + n.id : (n.className ? '.' + String(n.className).split(' ')[0] : '')), overflow: ov });
    }
    n = n.parentElement;
  }
  return out;
}

// ===========================================================================
// 检查 1：滚动到不同位置，导航栏的 top 是否始终贴近视口顶部
// ===========================================================================
window.__QA.check.navStaysVisible = async () => {
  const total = makeLong();
  await sleep(300);

  const nav = $('#nav');
  if (!nav) return { ok: false, note: '页面上没有 #nav' };

  const cs = getComputedStyle(nav);
  const navH = Math.round(nav.getBoundingClientRect().height);
  const navW = Math.round(nav.getBoundingClientRect().width);
  const bodyEl = document.body;
  const bodyCs = getComputedStyle(bodyEl);

  // 记录诊断信息，供外面打印
  window.__QA.diag = {
    position: cs.position,
    top: cs.top,
    zIndex: cs.zIndex,
    navHeight: navH,
    navWidth: navW,
    navScrollWidth: nav.scrollWidth,
    scrollHeight: total,
    innerHeight: window.innerHeight,
    scrollingElement: (document.scrollingElement || {}).tagName || '?',
    htmlOverflow: getComputedStyle(document.documentElement).overflow,
    bodyOverflow: bodyCs.overflow,
    // ★★ 关键诊断：body 的**实际高度**和**声明的高度**
    //    `html, body { height: 100% }` 会让 body 恰好等于视口高，
    //    内容多出来的部分**溢出到 body 外面** ——
    //    这时 body 自己就变成了"粘性定位的边界容器"，
    //    子元素的 sticky 只能在 body 的 100% 高度内有效。
    bodyHeightCss: bodyCs.height,
    bodyClientHeight: bodyEl.clientHeight,
    bodyScrollHeight: bodyEl.scrollHeight,
    bodyRectHeight: Math.round(bodyEl.getBoundingClientRect().height),
    badAncestors: overflowAncestors(),
  };

  const samples = [];
  // ⚠️ 只能滚到 scrollHeight - innerHeight，**不能滚到 scrollHeight**。
  //    第一版就是滚到 scrollHeight 的，结果浏览器把它夹到最大值之前
  //    先"滚过了头"，量到 top=-1244 —— 那是**测试自己的 bug**，
  //    看起来却像"导航栏还是坏的"。滚动类断言一定要先算清上限。
  //
  // ⚠️ 而且上限要**每次重算**：页面高度会在检查过程中变（图片/字体加载、
  //    我们自己插的撑高块），用一开始量到的值去滚就会滚过头。
  const readGeom = () => ({
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
    maxScroll: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
  });
  const targets = [0, 0.5, 1];
  for (const frac of targets) {
    const g = readGeom();
    const want = Math.round(g.maxScroll * frac);
    window.scrollTo(0, want);
    await sleep(200);
    const g2 = readGeom();
    const r = nav.getBoundingClientRect();
    samples.push({
      want,
      scrolledTo: Math.round(window.scrollY),
      maxScroll: g2.maxScroll,
      navTop: Math.round(r.top),
      navBottom: Math.round(r.bottom),
      visible: r.bottom > 0 && r.top < window.innerHeight,
    });
  }

  // 复位，别影响后面的检查
  window.scrollTo(0, 0);
  await sleep(200);

  const allStuck = samples.every((s) => s.visible && Math.abs(s.navTop) <= 2);
  return {
    ok: allStuck,
    note: allStuck
      ? `滚到 0/中段/底部，导航栏 top 始终是 0（${samples.map((s) => `${s.scrolledTo}px→top ${s.navTop}`).join('，')}）`
      : `滚动后导航栏跑掉了：${samples.map((s) => `想到 ${s.want} 实际 ${s.scrolledTo}(上限 ${s.maxScroll}) 时 top=${s.navTop}${s.visible ? '' : '(看不见)'}`).join('；')}`,
    extra: { samples, diag: window.__QA.diag },
  };
};

// ===========================================================================
// 检查 2：诊断 —— 有没有"让 sticky 失效的祖先"
// ===========================================================================
window.__QA.check.navDiag = async () => {
  const d = window.__QA.diag || {};
  const bad = d.badAncestors || [];
  // 有 overflow 非 visible 的祖先 = sticky 一定会相对它粘，而不是相对视口
  const ok = bad.length === 0;
  return {
    ok,
    note: ok
      ? `祖先链干净（无 overflow 拦截）；position=${d.position} top=${d.top} z-index=${d.zIndex} 高度=${d.navHeight}px`
      : `★ 有祖先的 overflow 不是 visible，sticky 会相对它粘：`
        + bad.map((b) => `${b.tag} overflow=${b.overflow}`).join('；'),
    extra: d,
  };
};

// ===========================================================================
// 检查 4：短页面时页脚仍然贴在底部
// ===========================================================================
//
// ⚠️ 这是"修导航栏"时**必须一起验证的副作用**。
//
//    旧写法 `html, body { height: 100% }` 除了坑 sticky，还干了另一件事：
//    它让 body 恰好一个视口高，于是 `body{display:flex;flex-direction:column}`
//    里的 `.mount{flex:1}` 能把页脚**顶到屏幕底部**。
//
//    我把 body 改成 `min-height: 100%`（让它跟着内容长高）之后，
//    "短页面页脚贴底"这件事**理论上还在**（min-height 也提供了 flex 高度），
//    但"理论上"不算数 —— 布局的副作用必须量出来。
//    如果不查这一条，我很可能修好了导航栏、顺手弄坏了页脚，
//    而页脚变高这种事用户不会立刻注意到。
window.__QA.check.footAtBottomOnShortPage = async () => {
  // 先把撑高块撤掉，制造一个**短页面**
  const filler = document.getElementById('qa-filler');
  if (filler) filler.remove();
  window.scrollTo(0, 0);
  await sleep(400);

  const foot = $('#foot');
  if (!foot) return { ok: false, note: '页面上没有 #foot' };

  const viewport = window.innerHeight;
  const docH = document.documentElement.scrollHeight;
  const fr = foot.getBoundingClientRect();
  const gap = Math.round(viewport - fr.bottom);
  const needsScroll = docH > viewport + 2;

  // 页脚底边应该贴着视口底部（留 2px 容差给小数像素）
  const atBottom = Math.abs(gap) <= 2;

  return {
    ok: atBottom,
    note: atBottom
      ? `短页面(${docH}px)里页脚底边贴在视口底部（差 ${gap}px）`
      : `短页面(${docH}px)里页脚没有贴底：视口 ${viewport}px、页脚底边 ${Math.round(fr.bottom)}px，差 ${gap}px`
        + (needsScroll ? '（页面比视口还高，不是真正的短页面）' : ''),
    extra: { viewport, docH, footBottom: Math.round(fr.bottom), gap, needsScroll },
  };
};

// ===========================================================================
// 检查 5：窄屏下导航栏**不能被压扁**
// ===========================================================================
//
// ⚠️ 这一条是"修 sticky"时顺手加的护栏，理由是：
//    为了让 sticky 生效，我把 `.nav` 自己的 `overflow-x: auto` 删掉了。
//    而当初加那句恰恰是为了兜另一个坑（浏览器扩展把导航栏压成 1px 高，
//    见 theme.css 里 .nav 那段长注释）。
//    所以必须证明：删掉它之后**窄屏下导航栏依然完整可点**。
//
//    断言的是"高度没被压扁 + 链接不换行"，不是"某个具体像素值"——
//    前者是"能不能用"，后者是"好不好看"，后者不该被测试锁死。
window.__QA.check.navTallOnNarrow = async () => {
  const nav = $('#nav');
  if (!nav) return { ok: false, note: '页面上没有 #nav' };

  window.scrollTo(0, 0);
  await sleep(200);

  const r = nav.getBoundingClientRect();
  const box = { height: Math.round(r.height), navW: Math.round(r.width) };

  // 导航项必须还是**一行横排**（换行会让它占两层、把正文挤下去）
  const links = [...nav.querySelectorAll('.nav-link')];
  const tops = new Set(links.map((a) => Math.round(a.getBoundingClientRect().top)));
  const noWrap = tops.size <= 1;

  // 链接区该有自己的横滚（这是删掉 .nav overflow 之后**唯一**的兜底）
  const linksBox = nav.querySelector('.nav-links');
  const linksScrollable = linksBox
    ? getComputedStyle(linksBox).overflowX !== 'visible' && linksBox.scrollWidth >= linksBox.clientWidth - 1
    : false;

  // 高度没被压扁（正常情况下是 54px；留一点余量给扩展注入的 padding）
  const tall = box.height >= 40;

  return {
    ok: tall && noWrap,
    note: `窄屏(${window.innerWidth}px)下：导航栏高 ${box.height}px（没被压扁=${tall}）、`
      + `${links.length} 个导航项在一行内=${noWrap}、链接区可横滚=${linksScrollable}`,
    extra: { ...box, linkCount: links.length, noWrap, linksScrollable, innerWidth: window.innerWidth },
  };
};
