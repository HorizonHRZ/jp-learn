/**
 * app.js —— 应用入口：装配导航、启动路由、做启动自检。
 *
 * 这里刻意只做"装配"，不放业务逻辑：
 *   导航表在下面，视图在 views/ 里，数据层在 db.js 里。
 */

import { APP_VERSION, SCHEMA_VERSION, APP_NAME } from './version.js';
import { el, toast, toastOk, toastWarn, toastError, modal, humanBytes, humanTime } from './ui.js';
import { createRouter } from './router.js';
import * as db from './db.js';
import { toggleLookup, isLookupOpen, mountLookup } from './drawer.js';
import { startKeepalive } from './keepalive.js';

/** 导航表：加一个页面 = 加一行 + 在 views/ 里加一个文件 */
const NAV = [
  { id: 'home', label: '首页', icon: '⌂' },
  { id: 'vocab', label: '背单词', icon: '語' },
  { id: 'lyric', label: '歌词', icon: '♪' },
  { id: 'reading', label: '精读', icon: '読' },
  { id: 'grammar', label: '语法', icon: '文' },
  { id: 'toolbox', label: '工具箱', icon: '🔧' },
  { id: 'stats', label: '统计', icon: '📈' },
  { id: 'snapshots', label: '快照', icon: '🕘' },
  { id: 'settings', label: '设置', icon: '⚙' },
];

function buildNav(navEl, router) {
  navEl.appendChild(el('div', { class: 'brand' }, [
    el('span', { class: 'brand-mark', text: 'JP' }),
    el('span', { class: 'brand-text' }, [
      el('strong', { text: APP_NAME }),
      el('small', { text: ' v' + APP_VERSION }),
    ]),
  ]));

  const links = el('div', { class: 'nav-links' });
  for (const item of NAV) {
    links.appendChild(el('a', {
      href: '#/' + item.id,
      class: 'nav-link',
      dataset: { view: item.id },
      onclick: (e) => { e.preventDefault(); router.go(item.id); },
    }, [
      el('span', { class: 'nav-icon', text: item.icon }),
      el('span', { class: 'nav-label', text: item.label }),
    ]));
  }
  navEl.appendChild(links);

  navEl.appendChild(el('div', { class: 'nav-foot' }, [
    el('button', {
      class: 'btn btn-ghost btn-sm',
      title: '切换深色/浅色',
      onclick: toggleTheme,
    }, '◐ 主题'),
  ]));
}

// ---------- 主题（约束 1：纯 CSS 变量，改 theme.css 就能换配色） ----------
export function applyTheme(theme) {
  const t = theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : 'auto';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('jp-learn.theme', t); } catch {}
}
function toggleTheme() {
  const cur = document.documentElement.dataset.theme || 'auto';
  const next = cur === 'dark' ? 'light' : cur === 'light' ? 'dark' : 'dark';
  applyTheme(next);
  db.dbPut('settings', { key: 'theme', value: next }).catch(() => {});
  toast('主题：' + (next === 'dark' ? '深色' : '浅色'), 'info', 1500);
}

// ---------- 启动自检 ----------
async function boot() {
  // 主题先应用，避免闪白
  let theme = 'auto';
  try { theme = localStorage.getItem('jp-learn.theme') || 'auto'; } catch {}
  applyTheme(theme);

  const navEl = document.getElementById('nav');
  const mount = document.getElementById('mount');
  const footEl = document.getElementById('foot');

  const router = createRouter({ mount, nav: navEl });
  buildNav(navEl, router);

  footEl.appendChild(el('span', {}, [
    el('span', { text: `${APP_NAME} v${APP_VERSION}　结构版本 v${SCHEMA_VERSION}　` }),
    el('a', { href: '#/settings', text: '数据与设置' }),
    // ⚠️ 这句话在加了 AI 功能之后**必须带上限定语**，而且限定语要写准。
    //    原来的写法是"用户数据只存在本机浏览器（IndexedDB），不会上传到任何服务器"——
    //    在只有本地功能时它是真的，但 AI 会把文字发出去。
    //    中间还改过一次写成"只发送你选中的那段文字"，后来加了
    //    「自动翻译全部段落」—— 一按那个按钮就会把每段正文依次发出去，
    //    "只发选中的"当场变成假话。所以现在按**两种触发方式**分别说。
    //
    //    页脚是每个页面都在的地方，说错话的代价最大，所以宁可说长一点。
    //    test-render.mjs 的 [9b] 会盯着：不许出现"不联网"，
    //    "不上传"必须带限定语，而且必须说清 AI 会发什么。
    el('span', { text: '　生词本、进度、笔记只存在本机浏览器（IndexedDB）；'
      + 'AI 功能开启后，你点词/点句时只发那一小段，点「自动翻译」时会把每段日文依次发给你的 AI' }),
  ]));

  // 数据层自检：IndexedDB 不可用时要明确告诉用户，而不是静默丢失保存
  const check = await db.selfCheck();
  if (check.error) {
    mount.appendChild(el('div', { class: 'banner banner-error' }, [
      el('strong', { text: '本地数据无法使用：' }),
      el('span', { text: check.error }),
      el('div', { class: 'banner-hint', text: '常见原因：浏览器隐私/无痕模式禁用了 IndexedDB。请用正常窗口打开，否则学习记录不会被保存。' }),
    ]));
  } else {
    // 太久没自动快照就存一份（约束 3）
    const snap = await db.maybeAutoSnapshot();
    if (snap) toastOk(`已自动创建数据快照（${humanBytes(snap.bytes)}）`, 2500);
  }

  // 结构版本自检
  const stored = await db.getStoredSchemaVersion();
  if (stored !== null && stored !== SCHEMA_VERSION) {
    toastWarn(`数据结构版本（${stored}）与程序（${SCHEMA_VERSION}）不一致，请到「设置 → 数据」查看`, 0);
  }

  await router.render();

  // 首屏渲染完成后，把 index.html 里的「正在启动…」占位移除。
  // 这个占位是给"页面已经打开、JS 还没跑完"那一小段空窗期用的，
  // 但它带着 40px 内边距，如果一直不删就会在导航栏上方留一条空白横条
  // （之前就漏了这一步，用户看到的就是那条"大片空白"）。
  // ⚠️ 必须等 router.render() 之后才删，否则会出现一眼可见的白屏闪烁。
  const bootEl = document.getElementById('boot');
  if (bootEl) bootEl.remove();

  // 全局速查抽屉：右下角悬浮按钮 + Ctrl+Shift+F。
  // 任何页面都能随手查词、随手收进生词本，不打断当前阅读。
  //
  // ⚠️ 这里必须**主动把按钮挂上**（mountLookup），不能等用户按快捷键。
  //    原来只挂了快捷键，于是那个悬浮按钮要等到"点过某个词、打开过一次抽屉"
  //    才出现 —— 用户的原话是「正常来讲应该是随时可见的才对」。
  //    一个没人知道的入口等于没有入口，所以启动时就建。
  window.JP_LOOKUP = toggleLookup;
  mountLookup();
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
      e.preventDefault();
      toggleLookup();
    }
  });

  // 把版本信息挂到 window 上，方便在浏览器控制台里排查
  window.JP = {
    version: APP_VERSION, schema: SCHEMA_VERSION, db, router, humanTime, modal,
    lookup: toggleLookup, isLookupOpen,
  };

  // 界面诊断浮层：只在 URL 带 ?diag=1 时加载（正常使用完全不加载）。
  // 为什么要它、而不是让人按 F12 看控制台：见 diagpanel.js 顶部注释 ——
  // 让用户做一堆操作的排查方案成功率很低，做成一个按钮最省事。
  // 用 dynamic import 是为了**不把这个诊断模块塞进启动关键路径**。
  if (/[?&]diag=1\b/.test(location.search)) {
    import('./diagpanel.js')
      .then((m) => m.mountDiagPanel())
      .catch((e) => console.warn('[jp-learn] 诊断面板加载失败', e));
  }

  // 告诉服务端"网页还开着"：关掉网页 90 秒后服务会自动退出，把内存还回去。
  // 放在这里（而不是更早）的原因：它跟首屏渲染无关，放最后就不会拖慢启动；
  // 而服务端的宽限期是 90 秒，晚几秒发第一次心跳完全没关系。
  // 详情与"为什么不用关闭通知"见 keepalive.js 顶部注释。
  startKeepalive();

  console.log(`[jp-learn] v${APP_VERSION} / schema v${SCHEMA_VERSION} 已就绪。控制台可用 window.JP 查看数据层。`);
}

boot().catch((e) => {
  const boot = document.getElementById('boot');
  if (boot) {
    boot.innerHTML = '';
    boot.appendChild(el('div', { class: 'banner banner-error' }, [
      el('strong', { text: '应用启动失败：' }),
      el('div', { text: String((e && e.message) || e) }),
      el('div', { class: 'banner-hint', text: '请把上面这行报错发给我。也可以先刷新一次页面重试。' }),
    ]));
  }
  toastError('启动失败：' + ((e && e.message) || e));
});
