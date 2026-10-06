/**
 * router.js —— hash 路由（零依赖）
 *
 * 为什么用 hash 而不是 History API：本应用是本地静态服务，hash 路由不需要服务端配合，
 * 直接双击 HTML 或换端口都不会 404。
 *
 * 视图约定：app/js/views/<id>.js 导出一个对象
 *   { id, title, icon?, order?, render(container, params) }
 * 视图之间不互相 import，共享能力通过 ui.js / db.js 引入。
 */

import { el, clear, toastError } from './ui.js';

/** 动态 import 视图，拿到它的定义对象 */
async function loadView(id) {
  const mod = await import(`./views/${id}.js`);
  const view = mod.default || mod.view;
  if (!view || typeof view.render !== 'function') {
    throw new Error(`视图 ${id} 没有导出 { render(container) }`);
  }
  return view;
}

export function createRouter({ mount, nav, fallback = 'home' }) {
  let current = null;
  let currentId = null;

  function parseHash() {
    const raw = (location.hash || '').replace(/^#\/?/, '');
    const [id, ...rest] = raw.split('/');
    return { id: id || fallback, params: rest };
  }

  async function render() {
    const { id, params } = parseHash();
    if (id === currentId && current && typeof current.onReenter === 'function') {
      current.onReenter(mount, params);
      return;
    }
    // 先销毁上一个视图（让它有机会停掉定时器/清理状态）
    if (current && typeof current.destroy === 'function') {
      try { current.destroy(); } catch (e) { console.warn('[router] destroy 失败', e); }
    }
    current = null;
    currentId = id;

    clear(mount);
    mount.appendChild(el('div', { class: 'loading', text: '加载中…' }));

    let view;
    try {
      view = await loadView(id);
    } catch (e) {
      clear(mount);
      mount.appendChild(el('div', { class: 'empty' }, [
        el('div', { class: 'empty-title', text: `页面「${id}」打不开` }),
        el('div', { class: 'empty-hint', text: String((e && e.message) || e) }),
        el('div', { class: 'empty-hint', text: '该模块可能还没做完。可以点左上角的「首页」返回。' }),
      ]));
      toastError('视图加载失败：' + ((e && e.message) || e));
      markNav(null);
      return;
    }

    current = view;
    clear(mount);
    try {
      await view.render(mount, params);
    } catch (e) {
      clear(mount);
      mount.appendChild(el('div', { class: 'empty' }, [
        el('div', { class: 'empty-title', text: '页面渲染出错' }),
        el('div', { class: 'empty-hint', text: String((e && e.message) || e) }),
      ]));
      toastError('渲染失败：' + ((e && e.message) || e));
    }
    markNav(id);
    document.title = (view.title ? view.title + ' · ' : '') + '日语学习';
    mount.scrollTop = 0;
  }

  function markNav(id) {
    if (!nav) return;
    for (const a of nav.querySelectorAll('a[data-view]')) {
      a.classList.toggle('active', a.dataset.view === id);
    }
  }

  function go(id, ...params) {
    const target = '#/' + [id, ...params].filter(Boolean).join('/');
    if (location.hash === target) render();
    else location.hash = target;
  }

  window.addEventListener('hashchange', render);
  return { render, go, get current() { return current; }, get currentId() { return currentId; } };
}
