/**
 * 面板式界面诊断（`app/js/diagpanel.js`）。
 *
 * 与 `views/diag.js` 的区别，也是为什么要单独做这一个：
 *   `views/diag.js` 是**一个页面**（`#/diag`）。问题是它检查的是**它自己** ——
 *   而"导航栏看不见"这个毛病只在**某些页面**出现，在诊断页上却是正常的，
 *   于是诊断页永远报"一切正常"，等于白测。
 *
 *   这个模块改成**浮层面板**，可以开在**出问题的那一页上**，
 *   检查的就是那一页的真实布局：导航栏跑到哪去了、有没有被盖住、整页有没有被撑宽。
 *
 * 打开方式：地址栏在 `#/...` **前面**加 `?diag=1`，例如
 *   http://127.0.0.1:8787/?diag=1#/home
 * 面板只在带这个参数时出现，正常使用时完全不加载、不占任何资源。
 */
import { el } from './ui.js';

/** 采集一份环境报告。纯读取，不改任何东西。 */
export function collectReport() {
  const nav = document.getElementById('nav');
  const cs = nav ? getComputedStyle(nav) : null;
  const rect = nav ? nav.getBoundingClientRect() : null;

  // 导航栏左上角那个点上，最顶层的元素是谁？
  // 这是"导航栏在 DOM 里、但屏幕上被别的东西盖住"的唯一可靠判据 ——
  // 只看 display / visibility 是查不出来的。
  let topElement = null;
  if (nav && rect && rect.width > 0 && rect.height > 0) {
    const x = Math.min(Math.max(rect.left + 8, 0), window.innerWidth - 1);
    const y = Math.min(Math.max(rect.top + 8, 0), window.innerHeight - 1);
    const hit = document.elementFromPoint(x, y);
    if (hit) {
      topElement = {
        tag: hit.tagName,
        className: String(hit.className || '').slice(0, 120),
        id: hit.id || '',
        isNavItself: hit === nav || nav.contains(hit),
      };
    }
  }

  // 逐个导航项也测一遍：可能导航栏在，但后面的项被挤出了视口
  const linkHits = [];
  if (nav) {
    for (const a of nav.querySelectorAll('a[data-view]')) {
      const r = a.getBoundingClientRect();
      const cx = Math.min(Math.max(r.left + r.width / 2, 0), window.innerWidth - 1);
      const cy = Math.min(Math.max(r.top + r.height / 2, 0), window.innerHeight - 1);
      const hit = document.elementFromPoint(cx, cy);
      linkHits.push({
        view: a.dataset.view,
        x: Math.round(r.x), y: Math.round(r.y),
        w: Math.round(r.width), h: Math.round(r.height),
        visible: r.width > 0 && r.height > 0,
        inViewport: r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth,
        hitTag: hit ? hit.tagName : null,
        hitIsSelf: hit ? (hit === a || a.contains(hit)) : false,
      });
    }
  }

  const mount = document.getElementById('mount');
  const mountRect = mount ? mount.getBoundingClientRect() : null;
  let sheets = [];
  try {
    sheets = [...document.styleSheets].map((s) => {
      try { return { href: s.href || '(inline)', rules: s.cssRules ? s.cssRules.length : -1 }; }
      catch { return { href: s.href || '(inline)', rules: -1 }; }
    });
  } catch { sheets = []; }

  return {
    // 关键：报告里必须带上"这是在哪个页面上测的"
    hash: location.hash || '(空)',
    search: location.search || '',
    url: location.href,
    at: new Date().toISOString(),
    env: {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      devicePixelRatio: window.devicePixelRatio,
      documentScrollWidth: document.documentElement.scrollWidth,
      documentScrollHeight: document.documentElement.scrollHeight,
      scrollY: Math.round(window.scrollY || 0),
    },
    nav: nav ? {
      exists: true,
      childCount: nav.children.length,
      linkCount: nav.querySelectorAll('a[data-view]').length,
      classList: [...nav.classList],
      inlineStyle: nav.getAttribute('style') || '',
      computed: cs ? {
        display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
        position: cs.position, top: cs.top, zIndex: cs.zIndex,
        height: cs.height, width: cs.width, overflowX: cs.overflowX,
        transform: cs.transform, clipPath: cs.clipPath, maxHeight: cs.maxHeight,
      } : null,
      rect: rect ? {
        x: Math.round(rect.x), y: Math.round(rect.y),
        width: Math.round(rect.width), height: Math.round(rect.height),
      } : null,
    } : { exists: false },
    topElementAtNav: topElement,
    linkHits,
    mount: mountRect ? {
      nodeCount: mount.childNodes.length,
      rect: {
        x: Math.round(mountRect.x), y: Math.round(mountRect.y),
        width: Math.round(mountRect.width), height: Math.round(mountRect.height),
      },
    } : null,
    bodyStyle: {
      display: getComputedStyle(document.body).display,
      overflow: getComputedStyle(document.body).overflow,
      height: getComputedStyle(document.body).height,
    },
    htmlStyle: {
      overflow: getComputedStyle(document.documentElement).overflow,
      height: getComputedStyle(document.documentElement).height,
    },
    styleSheets: sheets,
  };
}

/** 把报告翻译成人话结论。用户不看报告原文也能知道问题出在哪一类。 */
export function verdictOf(r) {
  const out = [];
  const n = r.nav;
  if (!n || !n.exists) {
    out.push('❌ #nav 元素根本不存在 —— app.js 的 buildNav() 没跑成功。');
    return out;
  }
  const c = n.computed || {};
  if (c.display === 'none') out.push('❌ #nav 的 display 是 none，被隐藏了。');
  if (c.visibility === 'hidden') out.push('❌ #nav 的 visibility 是 hidden。');
  if (Number(c.opacity) === 0) out.push('❌ #nav 的 opacity 是 0（全透明）。');
  if (n.rect && (n.rect.width === 0 || n.rect.height === 0)) {
    out.push(`❌ #nav 尺寸是 ${n.rect.width}×${n.rect.height}，等于没有高度。`);
  }
  if (n.rect && n.rect.y < 0) out.push(`❌ #nav 跑到屏幕上方外面了（y=${n.rect.y}）。`);
  if (n.rect && n.rect.y > r.env.innerHeight) {
    out.push(`❌ #nav 被挤到屏幕下方外面了（y=${n.rect.y} > 窗口高 ${r.env.innerHeight}）。`);
  }
  if (r.topElementAtNav && !r.topElementAtNav.isNavItself) {
    out.push(`❌ 导航栏位置上最顶层的元素是 <${r.topElementAtNav.tag} class="${r.topElementAtNav.className}">，`
      + '不是导航栏自己 —— 有东西盖在它上面。');
  }
  if (n.rect && n.rect.x + n.rect.width < 0) {
    out.push(`❌ #nav 被横向推到了屏幕左侧外面（x=${n.rect.x}）。`);
  }
  if (r.env.documentScrollWidth > r.env.innerWidth + 2) {
    out.push(`⚠ 整页宽度 ${r.env.documentScrollWidth} 超过窗口宽度 ${r.env.innerWidth}，`
      + '页面出现横向滚动，可能把导航栏带出可视区。');
  }
  if (r.env.innerWidth < 1024) {
    out.push(`ℹ 窗口只有 ${r.env.innerWidth}px 宽：导航栏 9 项加品牌约需 930px，`
      + '可能已被压到很窄或需要横向滚动。');
  }
  if (Number(c.zIndex) < 50) {
    out.push(`ℹ #nav 的 z-index 是 ${c.zIndex}（预期 ≥ 50），可能被更高层的东西挡住。`);
  }
  const offscreen = (r.linkHits || []).filter((l) => !l.visible || !l.inViewport);
  if (offscreen.length) {
    out.push(`⚠ 有 ${offscreen.length} 个导航项不在可视区内：`
      + offscreen.map((l) => `${l.view}(y=${l.y})`).join('、'));
  }
  const covered = (r.linkHits || []).filter((l) => l.visible && !l.hitIsSelf);
  if (covered.length) {
    out.push(`⚠ 有 ${covered.length} 个导航项被别的元素盖住：`
      + covered.map((l) => `${l.view}→<${l.hitTag}>`).join('、'));
  }
  if (!out.length) {
    out.push('✅ 当前这一页没发现异常：导航栏存在、可见、尺寸正常、没有被遮挡。');
    out.push('ℹ 如果界面上确实看不到它，请换到确实看不到的那一页再点「重新检测」。');
  }
  return out;
}

/**
 * 扫描所有样式表，找出**每一条**能作用到 #nav 上的规则。
 *
 * 为什么需要这个：
 *   实测报告显示 #nav 的 computed height 是 **1px**，而我们的 CSS 声明的是 54px，
 *   并且 9 个导航项的 y 是 **-19**（被顶到屏幕上边外面）。
 *   既然我们的样式表里没有这条规则，它就是**别人**加的 ——
 *   而浏览器扩展注入的 CSS 同样会出现在 document.styleSheets 里，能被读到。
 *   所以这里直接把"谁把 #nav 弄成 1px"点名出来。
 */
export function scanNavRules() {
  const hits = [];
  let sheets;
  try { sheets = [...document.styleSheets]; } catch { return hits; }

  for (let si = 0; si < sheets.length; si++) {
    const sheet = sheets[si];
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }  // 跨域样式表读不到规则
    if (!rules) continue;

    const walk = (list, mediaText) => {
      for (const rule of list) {
        // 递归进 @media / @supports 等分组规则
        if (rule.cssRules && rule.conditionText !== undefined) {
          walk(rule.cssRules, (mediaText ? mediaText + ' && ' : '') + (rule.conditionText || ''));
          continue;
        }
        const sel = rule.selectorText;
        if (!sel) continue;
        // 只关心"可能选中 #nav 或 .nav"的规则
        if (!/(^|[\s,>+~(])\.nav\b|(^|[\s,>+~(])#nav\b/.test(sel)) continue;
        const decl = rule.style;
        if (!decl) continue;
        const interesting = [];
        for (const prop of ['height', 'min-height', 'max-height', 'padding', 'display',
          'visibility', 'opacity', 'position', 'overflow', 'overflow-x', 'transform',
          'margin', 'flex', 'font-size', 'line-height']) {
          const v = decl.getPropertyValue(prop);
          if (v) interesting.push(`${prop}: ${v}`);
        }
        hits.push({
          sheet: sheet.href || `(inline #${si})`,
          media: mediaText || '',
          selector: sel,
          declarations: interesting,
        });
      }
    };
    walk(rules, '');
  }
  return hits;
}

/**
 * 挂载诊断浮层。只在 `?diag=1` 时由 app.js 调用。
 * 面板是普通 DOM（不是 iframe），所以要小心别让它自己变成遮挡源 ——
 * 它固定在左下角，并留出「重新检测 / 关闭」两个按钮。
 */
export function mountDiagPanel() {
  if (document.getElementById('diag-panel')) return null;

  const body = el('div', { id: 'diag-panel', class: 'diag-panel' });
  const verdictHost = el('div', {});
  const rawHost = el('div', {});
  const sendHost = el('div', {});
  const rulesHost = el('div', {});

  const ta = el('textarea', {
    class: 'input',
    style: { width: '100%', minHeight: '150px', fontFamily: 'var(--mono)', fontSize: '.72rem' },
    readonly: true,
  });

  function refresh() {
    const r = collectReport();
    r.navRules = scanNavRules();
    verdictHost.innerHTML = '';
    verdictHost.appendChild(el('div', { class: 'diag-head', text: '诊断：' + (r.hash || '(空)') }));
    for (const v of verdictOf(r)) {
      verdictHost.appendChild(el('div', { class: 'diag-line', text: v }));
    }
    ta.value = JSON.stringify(r, null, 2);

    // 把"谁在改 .nav"直接列出来，重点是 height 那几条
    rulesHost.innerHTML = '';
    const bad = r.navRules.filter((h) => h.declarations.some((d) => /^height:/.test(d)));
    if (bad.length) {
      rulesHost.appendChild(el('div', { class: 'diag-line', text:
        `发现 ${bad.length} 条给 .nav 设了 height 的规则（我们自己的只有 height: 54px）：` }));
      for (const h of bad) {
        rulesHost.appendChild(el('div', { class: 'diag-line diag-err',
          text: `  ${h.sheet}${h.media ? ' @' + h.media : ''}  ·  ${h.selector}  →  ${h.declarations.join('; ')}` }));
      }
    }
    return r;
  }

  const sendBtn = el('button', {
    class: 'btn btn-sm btn-primary',
    text: '发回开发者',
    onclick: async () => {
      sendBtn.disabled = true;
      sendHost.innerHTML = '';
      sendHost.appendChild(el('div', { class: 'faint', text: '发送中…' }));
      try {
        const r = collectReport();
        r.navRules = scanNavRules();
        const res = await fetch('/api/diag', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(r),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
        sendHost.innerHTML = '';
        sendHost.appendChild(el('div', { class: 'diag-ok', text: '✓ 已发回：' + data.saved }));
        ta.value = JSON.stringify(r, null, 2);
      } catch (e) {
        sendHost.innerHTML = '';
        sendHost.appendChild(el('div', { class: 'diag-err', text: '✗ 发送失败：' + ((e && e.message) || e) }));
        sendBtn.disabled = false;
      }
    },
  });

  body.appendChild(el('div', { class: 'diag-bar' }, [
    el('strong', { text: '界面诊断' }),
    el('span', { class: 'spacer' }),
    el('button', { class: 'btn btn-sm', text: '重新检测', onclick: refresh }),
    el('button', {
      class: 'btn btn-sm btn-ghost', text: '隐藏',
      onclick: () => { body.remove(); },
    }),
  ]));
  body.appendChild(verdictHost);
  body.appendChild(rulesHost);

  const rawToggle = el('button', {
    class: 'btn btn-sm btn-ghost', text: '显示原始报告',
    onclick: () => {
      if (rawHost.firstChild) { rawHost.innerHTML = ''; rawToggle.textContent = '显示原始报告'; }
      else { rawHost.appendChild(ta); rawToggle.textContent = '隐藏原始报告'; }
    },
  });

  body.appendChild(el('div', { class: 'btn-row', style: { margin: '8px 0' } }, [sendBtn, rawToggle]));
  body.appendChild(sendHost);
  body.appendChild(rawHost);

  document.body.appendChild(body);
  refresh();
  return body;
}
