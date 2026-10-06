/**
 * ui.js —— 通用 UI 组件（零依赖，原生 DOM）
 *
 * 只放"到处都要用"的东西：元素创建、提示、模态框、二次确认、格式化。
 * 各功能模块自己的界面逻辑放在 views/ 里，不要堆到这里。
 */

// ============================================================================
// 一、元素创建
// ============================================================================

/**
 * 创建元素：el('div', {class:'x', onclick:fn, dataset:{a:1}}, [子元素或字符串])
 * 比 innerHTML 拼接安全（用户粘贴的歌词/书页文字会直接进 DOM，必须走 textContent）。
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class' || k === 'className') node.className = v;
    else if (k === 'text') node.textContent = String(v);
    else if (k === 'html') node.innerHTML = v; // 只在内容完全由我们自己控制时使用
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const c of kids) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return node;
}

/** 清空一个容器 */
export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** 简写：按选择器找（限定在 root 内） */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ============================================================================
// 二、提示条（toast）
// ============================================================================

function toastLayer() {
  let layer = document.getElementById('toast-layer');
  if (!layer) {
    layer = el('div', { id: 'toast-layer', class: 'toast-layer' });
    document.body.appendChild(layer);
  }
  return layer;
}

/**
 * 弹一条提示。
 * @param {string} msg
 * @param {'info'|'ok'|'warn'|'error'} kind
 * @param {number} ms 停留毫秒；0 = 不自动消失（错误建议 0，让用户看清）
 */
export function toast(msg, kind = 'info', ms = 3200) {
  const layer = toastLayer();
  const node = el('div', { class: `toast toast-${kind}` }, [
    el('span', { class: 'toast-msg', text: msg }),
    el('button', { class: 'toast-x', title: '关闭', onclick: () => node.remove() }, '×'),
  ]);
  layer.appendChild(node);
  if (ms > 0) setTimeout(() => { node.classList.add('toast-out'); setTimeout(() => node.remove(), 200); }, ms);
  return node;
}

export const toastOk = (m, ms) => toast(m, 'ok', ms);
export const toastWarn = (m, ms) => toast(m, 'warn', ms);
export const toastError = (m, ms = 0) => toast(m, 'error', ms);

// ============================================================================
// 三、模态框与确认
// ============================================================================

/**
 * 打开一个模态框。
 * @param {{title:string, body:Node|string, buttons?:Array, width?:string, onClose?:Function}} opts
 * @returns {{close:Function, root:HTMLElement}}
 */
export function modal(opts) {
  const { title = '', body = '', buttons = [], width = '520px', onClose } = opts || {};
  const root = el('div', { class: 'modal-backdrop' });
  const box = el('div', { class: 'modal', style: { maxWidth: width } });

  const close = () => {
    root.classList.add('modal-out');
    setTimeout(() => { root.remove(); if (onClose) onClose(); }, 160);
  };

  const head = el('div', { class: 'modal-head' }, [
    el('h3', { class: 'modal-title', text: title }),
    el('button', { class: 'modal-x', title: '关闭', onclick: close }, '×'),
  ]);

  const bodyNode = el('div', { class: 'modal-body' });
  if (typeof body === 'string') bodyNode.appendChild(el('p', { text: body }));
  else if (body) bodyNode.appendChild(body);

  const foot = el('div', { class: 'modal-foot' });
  for (const b of buttons) {
    foot.appendChild(el('button', {
      class: 'btn ' + (b.class || ''),
      text: b.label,
      onclick: async () => {
        if (b.onClick) {
          const r = await b.onClick({ close });
          if (r === false) return; // 返回 false 表示不关闭
        }
        if (b.close !== false) close();
      },
    }));
  }

  box.appendChild(head);
  box.appendChild(bodyNode);
  if (buttons.length) box.appendChild(foot);
  root.appendChild(box);
  root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });
  document.body.appendChild(root);
  const focusable = box.querySelector('input,textarea,button.btn-primary,button');
  if (focusable) setTimeout(() => focusable.focus(), 30);
  return { close, root, body: bodyNode, foot };
}

/** 普通确认 */
export function confirmDialog(message, { title = '请确认', okLabel = '确定', cancelLabel = '取消', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title,
      body: message,
      buttons: [
        { label: cancelLabel, onClick: () => { done = true; resolve(false); } },
        { label: okLabel, class: danger ? 'btn-danger' : 'btn-primary', onClick: () => { done = true; resolve(true); } },
      ],
      onClose: () => { if (!done) resolve(false); },
    });
    void m;
  });
}

/**
 * 二次确认：要求用户手动输入指定短语才能通过。
 * 约束 3 要求「清空数据必须二次确认」，普通的"确定/取消"太容易误点，
 * 所以这里用"输入确认短语"的方式，让误触不可能通过。
 */
export function confirmTwice({ title, message, phrase = '确认清空', confirmLabel = '我已理解，继续' }) {
  return new Promise((resolve) => {
    let done = false;
    const input = el('input', { class: 'input', placeholder: `请输入：${phrase}`, autocomplete: 'off' });
    const warn = el('div', { class: 'field-hint' }, '');
    const body = el('div', {}, [
      el('p', { text: message }),
      el('p', { class: 'danger-text', text: `此操作不可撤销。请输入「${phrase}」以继续。` }),
      input,
      warn,
    ]);

    const check = () => {
      const ok = input.value.trim() === phrase;
      warn.textContent = input.value && !ok ? '输入不匹配' : '';
      warn.className = 'field-hint' + (input.value && !ok ? ' field-hint-error' : '');
      return ok;
    };
    input.addEventListener('input', check);

    const m = modal({
      title,
      body,
      buttons: [
        { label: '取消', onClick: () => { done = true; resolve(false); } },
        {
          label: confirmLabel,
          class: 'btn-danger',
          onClick: () => {
            if (!check()) { toastWarn('请输入完全一致的确认短语'); return false; }
            done = true; resolve(true);
          },
        },
      ],
      onClose: () => { if (!done) resolve(false); },
    });
    void m;
  });
}

// ============================================================================
// 四、格式化
// ============================================================================

/** 字节数 → 人看的字符串 */
export function humanBytes(n) {
  if (!n && n !== 0) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}

/** ISO 时间 → 本地可读 */
export function humanTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 相对时间（"3 分钟前"） */
export function humanAgo(iso) {
  if (!iso) return '-';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return String(iso);
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  if (s < 86400 * 30) return Math.floor(s / 86400) + ' 天前';
  return humanTime(iso).slice(0, 10);
}

/** 今天/昨天的 YYYY-MM-DD（统计按天归档用） */
export function dayKey(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ============================================================================
// 五、杂项
// ============================================================================

/** 防抖 */
export function debounce(fn, ms = 250) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** 简易进度条（长任务用） */
export function progressBar() {
  const fill = el('div', { class: 'progress-fill' });
  const wrap = el('div', { class: 'progress' }, [fill]);
  return {
    node: wrap,
    set(ratio, label) {
      fill.style.width = Math.max(0, Math.min(1, ratio)) * 100 + '%';
      if (label !== undefined) wrap.dataset.label = label;
    },
    done() { fill.classList.add('progress-done'); },
  };
}

/** 空状态占位 */
export function emptyState(title, hint, action) {
  return el('div', { class: 'empty' }, [
    el('div', { class: 'empty-title', text: title }),
    hint ? el('div', { class: 'empty-hint', text: hint }) : null,
    action || null,
  ]);
}

/** 一段可复制的代码/文本块 */
export function codeBlock(text) {
  const pre = el('pre', { class: 'code' }, text);
  return pre;
}
