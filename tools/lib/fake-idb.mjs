/**
 * 内存版 IndexedDB（测试专用）—— 只实现 db.js 真正用到的那部分 API。
 *
 * 为什么单独一个文件：`db.js` 是用户数据安全的最后一道防线（导出/导入/快照/清空/迁移），
 * 但它只能在浏览器里跑。靠这个假实现才能在 Node 里把它**真正跑起来**，
 * 而不是只做静态检查 —— 静态检查看不出"导入时把用户数据清了"这类错误。
 *
 * 最早只在 `test-db.mjs` 里，后来 `test-flow.mjs`（端到端用户流程）也要用，
 * 而"要测的东西必须只有一份实现"，所以抽到这里共用。
 *
 * ⚠️ 假实现的**形状必须和真实 IndexedDB 对齐**，否则测的是一个不存在的世界。
 *    下面每一处 `⚠️` 都是**踩过坑之后**才写对的，改动前先读注释。
 *
 * @param {{ preexisting?: { version?: number, stores?: Record<string,string> } }} opts
 *        可预置一个"已存在的旧库"，用来测升级路径（升级只在老用户身上触发，
 *        全新安装永远走不到，所以不预置就测不到）。
 * @returns {{ version:number, stores:Map }} 内部状态，测试里可以直接查
 */
export function installFakeIDB(opts = {}) {
  const rec = { version: 0, stores: new Map() };
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const mk = () => ({ result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null });

  if (opts.preexisting) {
    rec.version = opts.preexisting.version || 1;
    for (const [name, key] of Object.entries(opts.preexisting.stores || {})) {
      rec.stores.set(name, { def: { key: key || 'id' }, data: new Map(), indexNames: new Set() });
    }
  }

  // 调试开关：JL_DB_TRACE=1 时打印每次调用的位置，便于定位挂住的地方
  const TRACE = process.env.JL_DB_TRACE === '1';
  const trace = (...a) => { if (TRACE) console.log('    ·', ...a); };

  const fire = (v) => {
    const r = mk();
    r.result = v;
    // 真实 IndexedDB 的回调是宏任务：调用方总能先挂上 onsuccess
    setTimeout(() => {
      trace('    fire → onsuccess=' + typeof r.onsuccess);
      if (r.onsuccess) r.onsuccess({ target: r });
    }, 0);
    return r;
  };

  function store(name) {
    const s = rec.stores.get(name);
    if (!s) throw new Error('没有这个表: ' + name);
    return {
      put(v) { trace('    put(' + v[s.def.key] + ')'); s.data.set(v[s.def.key], clone(v)); return fire(v[s.def.key]); },
      get(k) { trace('    get(' + k + ')'); return fire(clone(s.data.get(k))); },
      getAll() { trace('    getAll'); return fire([...s.data.values()].map(clone)); },
      count() { trace('    count=' + s.data.size); return fire(s.data.size); },
      delete(k) { s.data.delete(k); return fire(undefined); },
      clear() { s.data.clear(); return fire(undefined); },
      index() { return { getAll: () => fire([]) }; },
    };
  }

  function createStore(name, opts2) {
    trace('createObjectStore(' + name + ')');
    const s = { def: { key: (opts2 && opts2.keyPath) || 'id' }, data: new Map(), indexNames: new Set() };
    rec.stores.set(name, s);
    return {
      get indexNames() { return { contains: (x) => s.indexNames.has(x) }; },
      createIndex(name2) { s.indexNames.add(name2); },
    };
  }

  function mkTx(storeNames, mode) {
    // 真实 IndexedDB 允许传单个表名（字符串）或数组。db.js 两种都用：
    // dumpFrom 传数组，rawPut/dbGet 传单个字符串。假实现只支持数组的话，
    // 会把 "meta" 当成 ['m','e','t','a'] 逐字去查表，报出 "没有这个表: m"。
    const names = typeof storeNames === 'string' ? [storeNames] : (storeNames || []);
    // ⚠️ 真实 IndexedDB 在 storeNames 为空时会直接抛异常：
    //    "Failed to execute 'transaction' on 'IDBDatabase': The storeNames parameter was empty."
    // 假实现必须复现这一条，否则测试会放过"先建事务再判空"这个真实 bug
    // （就是它让老用户的升级路径整站打不开）。
    if (names.length === 0) {
      const err = new Error(
        "Failed to execute 'transaction' on 'IDBDatabase': The storeNames parameter was empty."
      );
      err.name = 'NotFoundError';
      throw err;
    }
    // ⚠️ 真实 IndexedDB 在 storeNames 里有**不存在的表**时也会抛 NotFoundError，
    //    原文是：
    //      Failed to execute 'transaction' on 'IDBDatabase':
    //      One of the specified object stores was not found.
    //    这一条必须复现，否则会放过一整类真实 bug：
    //      「STORE_DEFS 里加了新表，但 SCHEMA_VERSION 忘了加 1」→
    //      老用户的库永远建不出那张表 → 只有用到它的那个功能会炸，
    //      其它功能全都正常，看起来像那个功能自己的 bug。
    //    本项目真的踩过（readingOverrides / 改注音保存）。
    for (const n of names) {
      if (!rec.stores.has(n)) {
        const err = new Error(
          "Failed to execute 'transaction' on 'IDBDatabase': One of the specified object stores was not found."
        );
        err.name = 'NotFoundError';
        throw err;
      }
    }
    trace('transaction(' + names + ', ' + mode + ')');
    const tx = {
      error: null, oncomplete: null, onerror: null, onabort: null,
      // objectStore 也补上同样的检查：真实浏览器里，
      // 事务里取一个不在本次事务范围内的表同样会抛 NotFoundError。
      objectStore: (n) => {
        if (!names.includes(n)) {
          const err = new Error(
            "Failed to execute 'objectStore' on 'IDBTransaction': The specified object store was not found."
          );
          err.name = 'NotFoundError';
          throw err;
        }
        trace('  objectStore(' + n + ')');
        return store(n);
      },
      abort() { if (tx.onabort) setTimeout(() => tx.onabort(), 0); },
    };
    setTimeout(() => { trace('  tx complete (oncomplete=' + typeof tx.oncomplete + ')'); if (tx.oncomplete) tx.oncomplete(); }, 2);
    return tx;
  }

  const db = {
    get version() { return rec.version; },
    objectStoreNames: {
      contains: (n) => rec.stores.has(n),
      get length() { return rec.stores.size; },
      [Symbol.iterator]: function* () { yield* rec.stores.keys(); },
    },
    createObjectStore: createStore,
    transaction: mkTx,
    close() {},
  };

  globalThis.indexedDB = {
    /**
     * 说明：真实 IndexedDB 的 open 在"需要升级"时会先触发 upgradeneeded。
     * 这里刻意把版本比较写成 >（而不是 >=），并且**第一次 open 就把版本设为最终值**，
     * 让 db.js 的「探测 → 升级 → 建表 → 写 meta」这条链只跑一遍。
     * 之前写成"每次 open 都重建 rec"，会出现 upgradeneeded 被跳过、
     * 进而 ensureSchema 不执行、后续 await 永久挂死的情况。
     */
    open(name, version) {
      trace('open(' + name + ', ' + version + ') 当前版本=' + rec.version);
      const req = mk();
      const tv = version === undefined ? rec.version : version;
      const needsUpgrade = tv > rec.version;
      setTimeout(() => {
        if (needsUpgrade) {
          const oldVersion = rec.version;
          rec.version = tv;
          req.result = db;
          trace('  触发 upgradeneeded ' + oldVersion + ' → ' + rec.version);
          if (req.onupgradeneeded) {
            // ⚠️ 真实 IndexedDB 把 transaction 放在**事件对象本身**
            // （`event.transaction`），db.js 读的正是 `r.transaction`。
            // 曾经这里写成 `target: { result: db, transaction: ... }`，
            // 把 transaction 塞进了 target 里 → db.js 拿到 undefined →
            // ensureSchema 在"已存在的表"上抛 TypeError →
            // 表现为"只建了第一张表就悄悄停下"。
            // 假实现的形状必须和真实事件对齐，否则测的是一个不存在的世界。
            const txRef = {
              objectStore: (n) => {
                const s = rec.stores.get(n);
                if (!s) throw new Error('没有这个表: ' + n);
                return {
                  get indexNames() { return { contains: (x) => s.indexNames.has(x) }; },
                  createIndex(name2) { s.indexNames.add(name2); },
                };
              },
              createObjectStore: createStore,
              abort() {},
            };
            trace('  调用 onupgradeneeded（handler=' + typeof req.onupgradeneeded + '）');
            try {
              req.onupgradeneeded({
                target: { result: db },
                transaction: txRef,      // ← 顶层，和真实事件一致
                oldVersion,
                newVersion: tv,
              });
              trace('  onupgradeneeded 正常返回');
            } catch (e) {
              trace('  onupgradeneeded 抛错: ' + e.message);
              throw e;
            }
          }
        }
        req.result = db;
        trace('  触发 onsuccess');
        if (req.onsuccess) req.onsuccess({ target: req });
      }, 0);
      return req;
    },
    deleteDatabase(name) {
      const req = mk();
      rec.version = 0;
      rec.stores.clear();
      setTimeout(() => { if (req.onsuccess) req.onsuccess({ target: req }); }, 0);
      return req;
    },
    /** 测试用：直接预置一个旧库 */
    __seed(version, stores) {
      rec.version = version;
      rec.stores.clear();
      for (const [name, key] of Object.entries(stores || {})) {
        rec.stores.set(name, { def: { key: key || 'id' }, data: new Map(), indexNames: new Set() });
      }
      return rec;
    },
  };

  globalThis.IDBKeyRange = {
    bound: (lower, upper) => ({ lower, upper }),
    upperBound: (upper) => ({ upper }),
    lowerBound: (lower) => ({ lower }),
    only: (v) => v,
  };

  return rec;
}
