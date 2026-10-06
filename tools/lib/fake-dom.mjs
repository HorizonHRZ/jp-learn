/**
 * 最小可用的假 DOM（测试专用）。
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么要有这个文件
 * ────────────────────────────────────────────────────────────────────
 * 本项目的界面代码是"原生 DOM 直接建节点"，没有任何框架，
 * 所以想在 Node 里测它，就必须提供一个**形状对得上**的假 DOM。
 *
 * 原来这套东西只长在 `test-render.mjs` 里。后来要做"按段翻译 + 译文缓存"
 * 的测试（`test-airead.mjs`），也需要一套假 DOM —— 这时候有两条路：
 *
 *   · 再抄一份到新文件里 —— 快，但两份会**各自演化**。
 *     抄出来的那份一定会在某次改动后和真实现不一致，
 *     而且不一致的时候**测试还是会绿**（因为它测的是那份抄来的世界）。
 *   · 抽到这里共用 —— 多花几分钟。
 *
 * 这个项目里已经吃过一次同样的亏：假 IndexedDB 最早只长在 `test-db.mjs` 里，
 * 后来的端到端流程测试又抄了一份，于是有了 `tools/lib/fake-idb.mjs`。
 * 同一个教训不重复踩，所以这里也抽出来。
 *
 * ────────────────────────────────────────────────────────────────────
 * ⚠️ 这个文件的每一处 `⚠️` 都是踩过坑才写对的，改之前先读注释。
 * ────────────────────────────────────────────────────────────────────
 */

/** 极简 classList：只实现视图代码真正用到的 add/remove/contains/toggle */
class FakeClassList {
  constructor(node) { this._n = node; this._s = new Set(); }
  add(...c) { for (const x of c) if (x) this._s.add(x); }
  remove(...c) { for (const x of c) this._s.delete(x); }
  contains(c) { return this._s.has(c); }
  toggle(c, force) {
    const on = force === undefined ? !this._s.has(c) : !!force;
    if (on) this._s.add(c); else this._s.delete(c);
    return on;
  }
  get value() { return Array.from(this._s).join(' '); }
}

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const kebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

export class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || '').toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this._listeners = new Map();
    this._className = '';
    this._text = '';
    this._html = '';
    this.style = {};
    this.classList = new FakeClassList(this);
    this._dataset = {};
    // dataset 必须是 Proxy：同时支持 node.dataset.x = v 与
    // Object.assign(node.dataset, {...})，后者是 el() 的写法。
    this.dataset = new Proxy(this._dataset, {
      set: (t, k, v) => { t[k] = String(v); this.attributes.set('data-' + kebab(String(k)), String(v)); return true; },
      get: (t, k) => (k in t ? t[k] : undefined),
      has: (t, k) => k in t,
      ownKeys: (t) => Reflect.ownKeys(t),
      getOwnPropertyDescriptor: (t, k) => ({ value: t[k], enumerable: true, configurable: true, writable: true }),
    });
  }
  get className() { return this._className || Array.from(this.classList._s).join(' '); }
  set className(v) {
    this._className = String(v);
    this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  // textContent 要像浏览器一样递归拼接后代文本，否则查文案会全是空的
  get textContent() {
    if (this.childNodes.length === 0) return this._text;
    return this.childNodes.map((c) => (c instanceof FakeNode ? c.textContent : '')).join('');
  }
  set textContent(v) { this._text = String(v); this.childNodes = []; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); if (String(v) === '') this.childNodes = []; }
  get firstChild() { return this.childNodes[0] || null; }
  get children() { return this.childNodes.filter((c) => c instanceof FakeNode); }
  get id() { return this.attributes.get('id') || ''; }
  set id(v) { this.attributes.set('id', String(v)); }
  get value() { return this._value === undefined ? '' : this._value; }
  set value(v) { this._value = v; }

  appendChild(c) {
    if (!c) return c;
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    this.childNodes.push(c);
    return c;
  }
  removeChild(c) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    if (c) c.parentNode = null;
    return c;
  }
  /**
   * 测试辅助：触发 click。
   * 为什么要这个：`el(tag, { onclick })` 内部是 `addEventListener('click', fn)`
   * （见 ui.js），所以假 DOM 想测"点按钮会发生什么"就得能触发监听器。
   * 真浏览器里这是 .click()，假 DOM 里没有事件系统，这里手工把监听器叫一遍。
   */
  click() {
    const fns = this._listeners.get('click') || [];
    for (const fn of fns) fn({ target: this, preventDefault() {}, stopPropagation() {} });
  }
  insertBefore(c, ref) {
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) return this.appendChild(c);
    c.parentNode = this;
    this.childNodes.splice(i, 0, c);
    return c;
  }
  /** 部分视图会调用 node.remove() */
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  /**
   * node.replaceWith(newNode) —— 真实浏览器里就有的方法。
   *
   * 补它的原因：笔记「行内改名」用的是"把标题节点就地换成输入框"，
   * 这是最省事也最不容易出错的做法（不用记位置、不用重画整块列表）。
   * 假 DOM 缺这个方法的话，测试只能在改名那一步炸掉 ——
   * 而**炸掉的原因是假 DOM 不真，不是代码有问题**。
   * 遇到这种"测试环境缺一个标准方法"的情况，正确做法是把它补上，
   * 而不是为了迁就假 DOM 去改本来更好的实现。
   */
  replaceWith(next) {
    const p = this.parentNode;
    if (!p) return next;
    const i = p.childNodes.indexOf(this);
    if (i < 0) return next;
    if (next instanceof FakeNode) next.parentNode = p;
    p.childNodes.splice(i, 1, next);
    this.parentNode = null;
    return next;
  }
  /**
   * 兜底：有些代码会用 contains */
  contains(n) { return this._walk([]).includes(n); }
  /**
   * focus / select / blur —— 真实浏览器里表单元素都有。
   *
   * 补它的原因：行内改名的实现里必须给输入框自动对焦（不然用户还得再点一下），
   * 焦点离开时还要判断"是不是还停在输入框上"。假 DOM 缺这几个方法，
   * 测试就会在 focus 那一行炸掉 —— 那是**假 DOM 不真**，不是代码错。
   * 顺带维护 `document.activeElement`，因为真实代码正是靠它判断焦点的。
   */
  focus() { if (globalThis.document) globalThis.document.activeElement = this; }
  blur() { if (globalThis.document && globalThis.document.activeElement === this) globalThis.document.activeElement = null; }
  select() { this._selected = true; }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const a = this._listeners.get(type);
    if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
  }
  dispatch(type, ev) { for (const fn of [...(this._listeners.get(type) || [])]) fn(ev || { type, target: this }); }
  setAttribute(k, v) {
    this.attributes.set(k, String(v));
    if (k === 'class') this.className = v;
    if (k.startsWith('data-')) this._dataset[camel(k.slice(5))] = String(v);
    // ⚠️ `value` 必须同时反映成属性。真实 DOM 里 input.value 和 value 特性
    //    会互相同步，假 DOM 不补这一下的话，测试里读 input.value 永远拿到
    //    undefined —— 那会让人误以为"代码没把原名填进输入框"。
    //    这类"假 DOM 不够真"造成的红，是最容易把正确代码改坏的一种红。
    if (k === 'value') this.value = String(v);
  }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  removeAttribute(k) { this.attributes.delete(k); }
  hasAttribute(k) { return this.attributes.has(k); }
  /**
   * 简易选择器：tag / .class / #id / [data-x] / tag.class
   *
   * ⚠️ 只支持这几种形状。写了别的（比如后代选择器 `.a .b`）**不会报错，
   *    只会静默地什么都匹配不到** —— 那种"测试绿着但什么都没测到"最危险。
   *    所以用之前先看这里支持什么。
   */
  _match(sel) {
    if (sel.startsWith('#')) return this.id === sel.slice(1);
    if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
    const m = sel.match(/^([a-zA-Z]*)(\.[\w-]+)?(\[data-[\w-]+\])?$/);
    if (!m || (!m[1] && !m[2] && !m[3])) return false;
    if (m[1] && this.tagName !== m[1].toUpperCase()) return false;
    if (m[2] && !this.classList.contains(m[2].slice(1))) return false;
    if (m[3] && !this.attributes.has(m[3].slice(1, -1))) return false;
    return true;
  }
  _walk(out) { for (const c of this.childNodes) if (c instanceof FakeNode) { out.push(c); c._walk(out); } return out; }
  querySelector(sel) { return this._walk([]).find((n) => n._match(sel)) || null; }
  querySelectorAll(sel) { return this._walk([]).filter((n) => n._match(sel)); }
  get firstElementChild() { return this.children[0] || null; }
  closest(sel) { let n = this; while (n) { if (n._match && n._match(sel)) return n; n = n.parentNode; } return null; }
}

/**
 * 装好一整套假 DOM 并挂到 `globalThis` 上。
 *
 * 返回的对象里有几个是测试自己要用的（`docBody`、`fakeWindow`），
 * 所以不能只 `return undefined`。
 *
 * ⚠️ 根节点叫 `docBody` 而不是 `body` —— 这是**踩过坑才改的**：
 *    调用方文件后面只要还有一处 `const body = …`（哪怕在 `{}` 块里），
 *    **同一个模块里出现同名 `const` 就会让整个模块作用域的 `body` 进入
 *    暂时性死区（TDZ）**，于是 `getElementById` 里引用的 `body` 在调用时
 *    抛 `document.getElementById is not a function`。
 *    症状极有迷惑性：数据其实已经写进 IndexedDB 了，但紧接着的 toast 一抛错，
 *    看起来就像"收藏没生效"。所以这里和导出名都带上 `doc` 前缀。
 */
export function installFakeDOM() {
  const docBody = new FakeNode('body');
  const documentElement = new FakeNode('html');
  const document = {
    body: docBody,
    documentElement,
    createElement: (t) => new FakeNode(t),
    createTextNode: (t) => { const n = new FakeNode('#text'); n._text = String(t); return n; },
    getElementById: (id) => docBody._walk([]).find((n) => n.id === id) || null,
    // 真实代码会用 document.activeElement 判断"焦点还在不在这个输入框上"
    activeElement: null,
    querySelector: (s) => docBody.querySelector(s),
    querySelectorAll: (s) => docBody.querySelectorAll(s),
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  // window 必须是独立对象（router.js 里调用 window.addEventListener）
  const fakeWindow = new FakeNode('#window');
  // ⚠️ location.hash 必须是访问器：浏览器里 location.hash = '#/x' 是"导航"，
  //    普通对象赋值只会把 hash 属性改成字面量 '#/x'，路由就永远停在首页。
  let _hash = '';
  const fakeLocation = {
    reload: () => {},
    get hash() { return _hash; },
    set hash(v) {
      _hash = String(v);
      // 真实浏览器改 hash 会触发 hashchange，router 靠它切页
      setTimeout(() => fakeWindow.dispatch('hashchange', { type: 'hashchange', newURL: _hash }), 0);
    },
  };
  fakeWindow.location = fakeLocation;
  /**
   * localStorage 的**真实现**（内存版）。
   *
   * ⚠️ 原来这里是个空壳（setItem 什么都不做、getItem 永远返回 null）。
   *    那个空壳在很长时间里够用，因为没人真的去读自己写的值。
   *    加"草稿保护"之后就露馅了：草稿整个功能就是"写进去、读回来"，
   *    空壳会让**每一个**草稿断言都失败 —— 而失败的原因是假环境不真，
   *    不是代码有问题。这种红最危险，因为它会诱导人去改本来正确的代码。
   *
   * 现在的实现跟真实 localStorage 一致：键值都当字符串、删得掉、清得空、
   * key() 按下标取键名（真实 API 就是这样）。
   */
  const lsMap = new Map();
  const fakeLocalStorage = {
    getItem: (k) => (lsMap.has(String(k)) ? lsMap.get(String(k)) : null),
    setItem: (k, v) => { lsMap.set(String(k), String(v)); },
    removeItem: (k) => { lsMap.delete(String(k)); },
    clear: () => { lsMap.clear(); },
    key: (i) => Array.from(lsMap.keys())[i] ?? null,
    get length() { return lsMap.size; },
  };
  fakeWindow.localStorage = fakeLocalStorage;
  fakeWindow.document = document;

  globalThis.document = document;
  globalThis.window = fakeWindow;
  globalThis.localStorage = fakeWindow.localStorage;
  globalThis.location = fakeWindow.location;
  // Node 里 navigator 是只读 getter，必须用 defineProperty 覆盖
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true, writable: true });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

  return { docBody, documentElement, document, fakeWindow, fakeLocation, FakeNode };
}
