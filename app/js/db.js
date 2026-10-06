/**
 * db.js —— 用户数据层（IndexedDB 手写封装）
 *
 * 这是整个应用最重要的一层，对应 ARCHITECTURE.md 的约束 2 与约束 3：
 *   约束 2：程序与用户数据彻底分离。用户数据只存在浏览器 IndexedDB，任何升级都不得清空/重置/迁移掉它。
 *   约束 3：用户数据永不丢失。一键导出 JSON / 导入恢复 / 自动快照（保留最近 N 份）/ 清空必须二次确认且先强制备份。
 *
 * 设计要点：
 *   1. 【先备份，后迁移】升级 schema 前先把现有数据整包导出，写进"迁移快照"。
 *      顺序是：探测当前版本 → 需要升级就先备份 → 再 open(新版本) 触发迁移。
 *      这样即使迁移函数写错，用户数据也有快照可回滚。
 *   2. 【只增不减】MIGRATIONS 里禁止 deleteObjectStore / clear()。
 *   3. 【不阻塞】任何数据的失败都只影响当前操作，不抛到 UI 之外。
 *   4. 【单例】整个应用共用一个 DB 连接；用 BroadcastChannel 处理多标签页同时升级的情况。
 *
 * 零依赖：不使用任何第三方 IndexedDB 库。
 */

import { SCHEMA_VERSION, APP_VERSION, APP_NAME } from './version.js';

// ============================================================================
// 一、库表定义
// ============================================================================

/**
 * 每个 store 的声明。'key' 是主键路径，'indexes' 是要建的索引。
 * 只增不减：后续版本只能往里加 store 或 index。
 */
export const STORE_DEFS = {
  // 系统元信息：schema 版本、安装时间、上次迁移时间等（不是用户内容，但也不能随便丢）
  meta: { key: 'key', indexes: [] },

  // 设置项：主题、注音开关、罗马音体系、每日新词上限、SRS 参数等
  settings: { key: 'key', indexes: [] },

  // 生词本：一个词条 = 一条记录（自建词库 + 从歌词/精读里收藏进来的词都在这）
  words: {
    key: 'id',
    indexes: [
      { name: 'byTerm', keyPath: 'term' },
      { name: 'byReading', keyPath: 'reading' },
      { name: 'byLevel', keyPath: 'level' },
      { name: 'bySource', keyPath: 'source' },
      { name: 'byCreatedAt', keyPath: 'createdAt' },
      { name: 'byTags', keyPath: 'tags', multiEntry: true },
    ],
  },

  // SRS 排程：一个词一条，记录间隔重复状态（与 words 分开，便于整表导出/统计）
  srs: {
    key: 'wordId',
    indexes: [
      { name: 'byDue', keyPath: 'due' },
      { name: 'byState', keyPath: 'state' },
      { name: 'byLapses', keyPath: 'lapses' },
    ],
  },

  // 答题历史：每次作答一条（只追加，不修改）。用于统计与"哪些模式最弱"的分析。
  // 注意：热力图已按用户要求取消，但这个表要留着——它是历史，删掉就找不回来了。
  reviews: {
    key: 'id',
    indexes: [
      { name: 'byWordId', keyPath: 'wordId' },
      { name: 'byAt', keyPath: 'at' },
      { name: 'byMode', keyPath: 'mode' },
      { name: 'byDay', keyPath: 'day' },
    ],
  },

  // 错题本：累计错误次数与最后错误时间
  mistakes: {
    key: 'wordId',
    indexes: [
      { name: 'byWrongCount', keyPath: 'wrongCount' },
      { name: 'byLastWrongAt', keyPath: 'lastWrongAt' },
    ],
  },

  // 内置 JLPT 词库的镜像缓存（**可再生的派生数据，不是用户数据**）
  //
  // 为什么不写进 words 表：word 表是用户数据。把 15,225 条内置词塞进去会有两个后果：
  //   1. "生词本"计数被内置数据淹没，界面失去意义；
  //   2. 以后重建 data/vocab（换词库版本）就变成"改动用户数据"，
  //      直接违反约束 2。
  // 放独立表后，重建/清空这张表**永远不碰** words / srs / reviews / mistakes。
  // id 前缀 'lib:' 使批量识别与清理不会误伤用户数据。
  libwords: {
    key: 'id',
    indexes: [
      { name: 'byTerm', keyPath: 'term' },
      { name: 'byReading', keyPath: 'reading' },
      { name: 'byLevel', keyPath: 'level' },
      { name: 'bySrcId', keyPath: 'srcId' },
    ],
  },

  // 用户导入的本地词表（保留原始文本 + 解析结果，便于"重新解析"而不必再让用户传一次）
  imports: {
    key: 'id',
    indexes: [
      { name: 'byAt', keyPath: 'at' },
      { name: 'byName', keyPath: 'name' },
    ],
  },

  // 歌词学习笔记（歌词文本全部由用户自己提供）
  lyrics: {
    key: 'id',
    indexes: [
      { name: 'byTitle', keyPath: 'title' },
      { name: 'byUpdatedAt', keyPath: 'updatedAt' },
      { name: 'byCreatedAt', keyPath: 'createdAt' },
    ],
  },

  // 精读笔记（用户粘贴的文本或自己拍的书页 OCR 结果）
  readings: {
    key: 'id',
    indexes: [
      { name: 'byTitle', keyPath: 'title' },
      { name: 'byUpdatedAt', keyPath: 'updatedAt' },
      { name: 'bySource', keyPath: 'sourceType' },
    ],
  },

  // 语法条目的学习状态（收藏 / 已掌握 / 待复习）。语法正文在 data/grammar/，这里只存用户状态
  grammarState: {
    key: 'grammarId',
    indexes: [
      { name: 'byStatus', keyPath: 'status' },
      { name: 'byUpdatedAt', keyPath: 'updatedAt' },
    ],
  },

  // ★ 用户手改的汉字读音（歌词页 / 精读页共用）。
  //
  // 为什么需要它：词库和统计只能给出"最可能的读音"，但**日文汉字往往多音**，
  //   而歌里唱的、文章里念的是哪一个，程序无从知晓。用户听到的和显示的不一致时，
  //   他必须能改 —— 否则整页注音对他就是错的。
  //
  // 为什么主键是 surface（表面形）而不是"句子 + 位置"：
  //   同一个词在这首歌里出现三次、在那篇文章里也出现，读音是**同一个事实**。
  //   按词记，改一次全站生效，也更容易在备份里看懂。
  //
  // ⚠️ 这是**累加式**新增 store：不修改也不删除任何已有 store，
  //    ensureSchema() 是幂等的，所以老用户的库会自动补上这一张表，数据一条不丢。
  //    这也是本项目"只增不减"迁移规则的直接体现（见文件头的约束说明）。
  readingOverrides: {
    key: 'surface',
    indexes: [
      { name: 'byAt', keyPath: 'at' },
    ],
  },

  // ★ 用户手改的**分词切法**（歌词页 / 精读页共用）。
  //
  // 为什么需要它：分词器是"最长匹配 + 词库统计"，它不知道你在读什么。
  //   `この人` 会被切成 `この` + `人`、`日本語` 可能被切成 `日本` + `語`
  //   —— 这些都取决于你想怎么学、怎么记，程序猜不出来，所以让用户能改。
  //
  // 为什么和 readingOverrides 分两张表，不合成一张：
  //   改读音改的是"这个词怎么念"（词还是同一个词），
  //   改切法改的是"哪里算一个词"（词本身就变了）—— 是两件事。
  //   合成一张会让"到底是切错了还是念错了"变得查不清，也没法只恢复其中一样。
  //
  // 为什么主键是 surface（那一段原文）而不是"句子 + 位置"：
  //   和 readingOverrides 同一个理由 —— 切法是**文本本身**的事实，
  //   `この人` 在哪儿都该切得一样。按原文记，改一次全站生效。
  //
  // ⚠️ 这是**累加式**新增 store：不修改也不删除任何已有 store，
  //    ensureSchema() 是幂等的，所以老用户的库会自动补上这一张表，数据一条不丢。
  //    加了这张表 → version.js 的 SCHEMA_VERSION 必须从 3 提到 **4**（已提）。
  //    理由见 version.js 里记的那次真实事故（readingOverrides 忘提版本号）。
  segOverrides: {
    key: 'surface',
    indexes: [
      { name: 'byAt', keyPath: 'at' },
    ],
  },

  // 快照：自动快照 + 迁移前快照 + 用户手动快照
  snapshots: {
    key: 'id',
    indexes: [
      { name: 'byAt', keyPath: 'at' },
      { name: 'byKind', keyPath: 'kind' },
    ],
  },
};

/** 快照最多保留几份（超出后按时间淘汰最旧的"自动"快照；迁移快照与手动快照优先保留） */
const SNAPSHOT_LIMIT = 10;
/** 自动快照的最小间隔（毫秒）：默认 6 小时，避免每次开页面都存一份 */
const AUTO_SNAPSHOT_INTERVAL = 6 * 60 * 60 * 1000;

// ============================================================================
// 二、迁移注册表
// ============================================================================

/**
 * 迁移函数：键 = 目标 schema 版本。
 * 约束：只能新增/改写，绝不允许删库或清空用户数据。
 *
 * 因为 onupgradeneeded 里 IndexedDB 已经处于"升级事务"中（且此时还读不到旧版本号），
 * 所以结构创建统一由 ensureSchema() 按 STORE_DEFS 幂等补全，
 * 这里只放「数据层面的增量改写」。
 */
const MIGRATIONS = {
  // 1: 初始版本，无数据迁移（结构由 ensureSchema 创建）
  //
  // 2: 新增 libwords 表（内置词库的可再生缓存）。
  //    纯新增结构，**没有任何数据改写**：words / srs / reviews / mistakes
  //    一个字都不动，所以这里不需要（也不应该）写迁移函数。
  //    结构由 onupgradeneeded → ensureSchema() 幂等补建。
  //    libwords 是派生数据，导入旧备份后会在首次使用时自动重建。
  //
  // 3: 新增 readingOverrides 表（用户手改的汉字读音）。
  //    ⚠️ 这张表当初是**悄悄**加进 STORE_DEFS 的，SCHEMA_VERSION 没跟着加，
  //       结果停在版本 2 的老库永远建不出它 —— 用户改注音保存时报
  //       "One of the specified object stores was not found"。
  //       把版本提到 3，就是把那条一直走不到的升级路径**接上**。
  //    同样是纯新增结构、无数据改写，所以这里没有也不该有迁移函数；
  //    结构由 ensureSchema() 幂等补建，升级前的整包备份由 openDB 负责。
  //    另见 db.js 第 4.5 步的「结构自检」——它会在缺表时立刻报出来，
  //    而不是等用户点保存才炸。
  //
  // 4: 新增 segOverrides 表（用户手改的分词切法）。
  //    ⚠️ 上一次（版本 3）就是因为"加表忘了加版本号"出了一次事故，
  //       这一次**加表的同时就把版本提到 4**，没有重犯。
  //    同样是纯新增结构、无数据改写，所以这里没有也不该有迁移函数；
  //    结构由 ensureSchema() 幂等补建，升级前的整包备份由 openDB 负责。
  //    （为什么 segOverrides 不并进 readingOverrides，见上面 STORE_DEFS 里的注释。）
  //    另见 db.js 第 4.5 步的「结构自检」——它会在缺表时立刻报出来。
};

// ============================================================================
// 三、基础封装
// ============================================================================

const DB_NAME = 'jp-learn';

/** IndexedDB 是否可用（隐私模式/被禁用时不可用，此时必须优雅降级而不是白屏） */
export function hasIDB() {
  try { return typeof indexedDB !== 'undefined' && indexedDB !== null; } catch { return false; }
}

/** 把 IDBRequest 包成 Promise */
function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB 请求失败'));
  });
}

/** 等待事务真正提交（关键：写操作必须等 complete，否则可能丢数据） */
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('事务失败'));
    tx.onabort = () => reject(tx.error || new Error('事务被中止'));
  });
}

let dbPromise = null;
let dbInstance = null;

/** 打开数据库；自动探测版本、必要时先备份再升级 */
function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = (async () => {
    if (!hasIDB()) throw new Error('当前浏览器不支持或禁用了 IndexedDB，用户数据无法保存');

    // --- 第 1 步：探测现有版本（不带版本号打开，拿到当前真实版本）---
    let existingVersion = 0;
    let probe = null;
    try {
      probe = await new Promise((resolve, reject) => {
        const r = indexedDB.open(DB_NAME);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error || new Error('无法打开数据库'));
        // 老库存在但结构较旧时也会走到这里；我们只读 version，不做修改
      });
      existingVersion = probe.version;
    } catch (e) {
      throw new Error('无法打开本地数据库：' + (e && e.message || e));
    }

    // --- 第 2 步：代码比数据旧 → 拒绝打开，避免把新版数据写坏 ---
    if (existingVersion > SCHEMA_VERSION) {
      try { probe.close(); } catch {}
      throw new Error(
        `本地数据的版本（${existingVersion}）比当前程序（${SCHEMA_VERSION}）新。` +
        `请更新程序，不要用旧版打开新版数据，否则可能损坏数据。`
      );
    }
    const needsUpgrade = existingVersion > 0 && existingVersion < SCHEMA_VERSION;

    // --- 第 3 步：需要升级 → 先整包备份（约束 2：迁移前自动快照）---
    //
    // 备份失败要不要中止升级？这里刻意**区分两种情况**：
    //   · 旧库里还有表（有数据可能丢）→ 中止升级，宁可打不开也不能弄丢数据（约束 3）。
    //   · 旧库里一张已知的表都没有 → 没有任何可丢的东西，
    //     "备份了空集合"没有意义，此时中止只会把用户永远锁在门外。
    //     所以放行，并留一条控制台记录说明发生了什么。
    // 曾经这里不区分，加上 dumpFrom 的空列表 bug，导致"旧库存在但还没有
    // 业务表"的用户一进页面就整站打不开。升级路径必须按"最坏情况"假设来写，
    // 因为它只会在真实用户身上触发，测试很难覆盖到。
    let preUpgradeDump = null;
    let backupStores = [];
    if (needsUpgrade) {
      try {
        const snap = await dumpFrom(probe);
        preUpgradeDump = snap.data;
        backupStores = snap.stores;
        probe.close();
      } catch (e) {
        try { probe.close(); } catch {}
        throw new Error('升级前备份失败，已中止升级以保护你的数据：' + (e && e.message || e));
      }
      if (!backupStores.length) {
        // 旧库存在但没有任何已知表：没有东西可备份，继续升级
        console.warn(
          `[jp-learn] 检测到结构版本 ${existingVersion} 的旧库，但其中没有任何可识别的数据表；` +
          '没有可备份的内容，直接升级（不会丢失任何用户数据）。'
        );
        preUpgradeDump = null;
      }
    } else {
      try { probe.close(); } catch {}
    }

    // --- 第 4 步：正式打开（触发 onupgradeneeded 建表/补索引）---
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, SCHEMA_VERSION);
      r.onupgradeneeded = (ev) => {
        try {
          // ⚠️ transaction 在**事件对象**上（`ev.transaction`），
          // 不在 IDBOpenDBRequest 上（`r.transaction` 是 undefined）。
          // 这里同时接受两种来源，是为了兼容不同的调用方/测试替身；
          // 但真实浏览器只会给 ev.transaction。
          ensureSchema(r.result, (ev && ev.transaction) || r.transaction);
        } catch (e) {
          // 建表失败**绝不能静默**：一旦吞掉，后续所有操作都会报
          // "reading 'objectStore' of undefined" 这类完全指不到根因的错误。
          // 这里先把真实原因打出来，再中止升级。
          console.error('[jp-learn] 建表/补索引失败，已中止升级：', e);
          try { r.transaction.abort(); } catch {}
          reject(new Error('初始化数据库结构失败：' + ((e && e.message) || e)));
        }
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error || new Error('打开数据库失败'));
      r.onblocked = () => reject(new Error('数据库被其他标签页占用，请关掉本应用的其他标签页后重试'));
    });

    dbInstance = db;

    // 别的标签页要升级时，主动让路，避免把对方卡死
    db.onversionchange = () => {
      try { db.close(); } catch {}
      dbInstance = null;
      dbPromise = null;
    };

    // --- 第 4.5 步：结构自检（**这一条是用户报的那个 bug 的兜底**）---
    //
    // ⚠️ 背景：ensureSchema() 只在 onupgradeneeded 里跑，也就是**只有版本号变大才跑**。
    //    于是一旦出现下面这种组合，问题就永远修不好：
    //      · 老用户的库停在结构版本 2；
    //      · 我们在 STORE_DEFS 里加了一张新表（readingOverrides）；
    //      · SCHEMA_VERSION 当时**没有跟着加**（还是 2）。
    //    → 版本没变 → 不触发升级 → 新表永远建不出来 →
    //      改注音时保存报 "One of the specified object stores was not found"。
    //    而且**再改多少代码都没用**：只要版本号不涨，那条路径就永远不会走到。
    //
    //    所以这里加一道"打开即自检"：发现缺表就**明确报出来**。
    //    不静默、不含糊 —— 让根因在第一时间可见，而不是等用户点保存时才炸。
    const missingStores = Object.keys(STORE_DEFS).filter((n) => !db.objectStoreNames.contains(n));
    if (missingStores.length) {
      const msg = '本地数据库缺少这几张表：' + missingStores.join('、')
        + '。这通常是程序新增了表但结构版本号没有跟着提升导致的（老用户的库不会被升级）。'
        + '请把 version.js 的 SCHEMA_VERSION 提高 1 后重新打开页面。';
      console.error('[jp-learn] ' + msg);
      // 记在 meta 里，设置页的健康检查能读到，用户可以自己看到
      try {
        await rawPut(db, 'meta', {
          key: 'missingStores',
          value: { stores: missingStores, at: new Date().toISOString(), appVersion: APP_VERSION },
        });
      } catch { /* 记不上也不影响主流程 */ }
    } else {
      // 上次的残缺状态已经修好，把标记清掉（否则设置页会一直报旧问题）
      try {
        if (await rawGet(db, 'meta', 'missingStores')) await rawDelete(db, 'meta', 'missingStores');
      } catch { /* 清不掉不影响主流程 */ }
    }

    // --- 第 5 步：写回升级后的快照 ---
    // 同样只能用 raw*：此刻 openDB 尚未返回，公开 API 会 await 到自己身上。
    //
    // ⚠️ 这里原来的判断是 `needsUpgrade && preUpgradeDump`，**是错的**。
    //    preUpgradeDump 只在"旧库里有已知表"时才有值；旧库是空的时它是 null，
    //    于是 runMigrations() 被一起跳过 —— 结构升级了，数据迁移却没跑。
    //    正确判断只看 needsUpgrade（要不要升级），
    //    备份写不写再看 preUpgradeDump（有没有东西可备份）——这是两件事。
    if (needsUpgrade) {
      await runMigrations(db, existingVersion);
      if (preUpgradeDump) {
        await rawPut(db, 'snapshots', {
          id: 'preupgrade-' + existingVersion + '-' + Date.now(),
          kind: 'preupgrade',
          at: new Date().toISOString(),
          fromVersion: existingVersion,
          toVersion: SCHEMA_VERSION,
          note: `从结构版本 ${existingVersion} 升级到 ${SCHEMA_VERSION} 之前的自动备份`,
          bytes: JSON.stringify(preUpgradeDump).length,
          data: preUpgradeDump,
        });
      }
      await rawPut(db, 'meta', { key: 'lastMigration', value: { from: existingVersion, to: SCHEMA_VERSION, at: new Date().toISOString() } });
    }

    // 【重要】这里必须用 rawPut / rawGet（直接拿 db 句柄操作），不能调用
    // 公开的 dbPut / dbGet —— 它们内部会 `await openDB()`，而 openDB 此刻还
    // 没返回（正在执行本函数），于是 await 到自己身上，永久挂起。
    // 这个坑只在"首次安装"（没有任何数据、不需要备份升级）时暴露：
    // 全新用户第一次打开页面就白屏，而且不报错，极难排查。
    await rawPut(db, 'meta', { key: 'schemaVersion', value: SCHEMA_VERSION });
    if (!(await rawGet(db, 'meta', 'installedAt'))) {
      await rawPut(db, 'meta', { key: 'installedAt', value: new Date().toISOString() });
    }
    await rawPut(db, 'meta', { key: 'appVersion', value: APP_VERSION });

    return db;
  })();

  // 打开失败后允许重试
  dbPromise.catch(() => { dbPromise = null; });

  return dbPromise;
}

/**
 * 按 STORE_DEFS 幂等创建缺失的 store 与 index（只增不减，绝不删）。
 *
 * ⚠️ 为什么对 `_tx` 做了兜底：真实 IDBDatabase 并没有 `objectStore()`，
 * 只有 **versionchange 事务**才有。所以补索引必须靠 `_tx`。
 * 但如果某天 `_tx` 没传进来（调用方写错 / 测试用的事件对象形状不对），
 * 这里绝不能静默停下——那会造成"只建了前几张表"的半成品库，
 * 而且后续所有操作都报 "reading 'objectStore' of undefined"，指不到根因。
 * 所以拿不到事务时直接抛一条说清楚的错误，宁可失败也不要半成品。
 */
function ensureSchema(db, _tx) {
  const storeOf = (name) => {
    if (_tx && typeof _tx.objectStore === 'function') return _tx.objectStore(name);
    throw new Error(
      `建表时拿不到 versionchange 事务，无法为已存在的表「${name}」补索引。` +
      '这属于程序 bug，不是数据问题；请反馈这条信息。'
    );
  };
  for (const [name, def] of Object.entries(STORE_DEFS)) {
    let store;
    if (!db.objectStoreNames.contains(name)) {
      store = db.createObjectStore(name, { keyPath: def.key });
    } else {
      store = storeOf(name);
    }
    for (const ix of def.indexes || []) {
      if (!store.indexNames.contains(ix.name)) {
        store.createIndex(ix.name, ix.keyPath, {
          unique: !!ix.unique,
          multiEntry: !!ix.multiEntry,
        });
      }
    }
  }
}

/** 依次执行从 fromVersion+1 到 SCHEMA_VERSION 的数据迁移函数 */
async function runMigrations(db, fromVersion) {
  for (let v = fromVersion + 1; v <= SCHEMA_VERSION; v++) {
    const fn = MIGRATIONS[v];
    if (typeof fn !== 'function') continue;
    const tx = db.transaction(Object.keys(STORE_DEFS), 'readwrite');
    try {
      await fn({ db, tx });
      await txDone(tx);
    } catch (e) {
      try { tx.abort(); } catch {}
      throw new Error(`迁移到版本 ${v} 失败：${(e && e.message) || e}`);
    }
  }
}

// ============================================================================
// 四、CRUD（全部走 Promise，且写操作都等事务提交）
// ============================================================================

/**
 * 【底层原语】直接拿已打开的 db 句柄读写，绝不调用 openDB()。
 *
 * 为什么必须有这一层：openDB() 自己在初始化过程中就要往 meta 里写 schemaVersion，
 * 如果它调用公开的 dbPut()，而 dbPut() 又 `await openDB()`，就会 await 到自己
 * 那个还没 resolve 的 promise 上 —— 永久挂起。首次安装（不需要备份升级）时必然触发。
 * 所以规则是：openDB() 内部只用 raw*，外部代码只用 db*。
 */
async function rawGet(db, store, key) {
  return req(db.transaction(store, 'readonly').objectStore(store).get(key));
}

async function rawPut(db, store, value) {
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  await txDone(tx);
  return value;
}

async function rawDelete(db, store, key) {
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await txDone(tx);
  return true;
}

export async function dbGet(store, key) {
  const db = await openDB();
  return req(db.transaction(store, 'readonly').objectStore(store).get(key));
}

export async function dbAll(store, query) {
  const db = await openDB();
  return req(db.transaction(store, 'readonly').objectStore(store).getAll(query));
}

export async function dbCount(store) {
  const db = await openDB();
  return req(db.transaction(store, 'readonly').objectStore(store).count());
}

export async function dbPut(store, value) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  await txDone(tx);
  return value;
}

export async function dbPutMany(store, values) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const v of values) os.put(v);
  await txDone(tx);
  return values.length;
}

export async function dbDelete(store, key) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await txDone(tx);
}

export async function dbClearStore(store) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).clear();
  await txDone(tx);
}

/** 按索引取范围（SRS 到期查询等用） */
export async function dbAllByIndex(store, indexName, query, count) {
  const db = await openDB();
  const os = db.transaction(store, 'readonly').objectStore(store);
  return req(os.index(indexName).getAll(query, count));
}

/** 生成一个够用的本地 id（不用 crypto.randomUUID，避免个别环境缺失） */
export function newId(prefix = '') {
  const rnd = () => Math.random().toString(36).slice(2, 10);
  return prefix + Date.now().toString(36) + '-' + rnd() + rnd();
}

// ============================================================================
// 五之一、设置项（用户偏好，随导出/导入一起走）
// ============================================================================
//
// 为什么放 settings 表而不是新开一张：约束 2 要求"结构变更必须做增量迁移"。
// 往已有的 key-value 表里加一个 key **不是结构变更**（store 与 index 都没动），
// 所以这次改动 SCHEMA_VERSION 不用变，老用户升级时也不会丢任何东西。
// 反过来，如果为设置新开一张表，就必须走一次 schema 升级——那是没必要的风险。

/**
 * 设置项默认值。
 *
 * `dailyNewLimit` 是"每天最多学几个新词"，**默认 50**（用户指定）。
 * 注意它和"每次练习给多少题"不是一回事：
 *   · dailyNewLimit 是每天的总量，靠 SRS 卡的 introducedAt 统计今天已学多少；
 *   · 一次练习实际会给多少个新词，取 min(剩余额度, 本次计划量)。
 * 用户把它调大就能一次多学，调小就细水长流。
 *
 * `dailyReviewLimit` 是"每天最多复习几个不同的词"，**默认 50**（用户指定）。
 *
 * 为什么复习也必须有个每日上限（这是 2026-10 补的，之前完全没有）：
 *   复习量会随"每天新学量"累积。实测（tools/test-srs.mjs 里的长期模拟）：
 *   长期稳定下来，每天到期的复习量约等于**每天新学量的 12 倍** ——
 *   每天学 10 个 → 每天 122 个到期；学 20 个 → 242 个；默认 50 个 → 537 个。
 *   原来没有上限，539 个到期就一次摆 539 个到用户面前，做不完就一直堆着，
 *   而且**新词额度拦不住它**（新词是"入水口"，复习是"蓄水池"）。
 *   加上限之后：每天有一件确定能做完的事，超出的**顺延到明天**（不丢词）。
 *
 * ⚠️ 需求变更留档（2026-10，同一天）：
 *   这个默认值一开始定的是 **40**（用户当时说"默认值定 40"）。后来实测出
 *   "上限 40 只撑得住每天新学 3 个词"，用户看过数据后改成：
 *   **默认 50、范围 20–200**，并且要能在设置里随时改。
 *   所以下面 `DAILY_REVIEW_LIMIT_MIN` 也一起从 0 提到了 20。
 *
 * 语义细节（想清楚再改）：
 *   · 统计口径是**那天答过的不同词的个数**（不是答题次数）——
 *     错词在会话里会被重排再考一次，那是"一次复习里的重复"，不该吃掉两份额度；
 *   · 只有进入天级复习（review）的词才占额度，学习步/重学步（分钟级）不占；
 *   · 上限是**当天总额度**，不是"每场题量"。所以一场做满后还能再开一场，
 *     直到当天总数到顶。这和"一场 40 题"是两个不同的旋钮，别混。
 */
export const DEFAULT_SETTINGS = {
  dailyNewLimit: 50,
  dailyReviewLimit: 50,
  /** 背单词当前选定的练习模式（单一模式，整场只有它一个） */
  vocabMode: '',
  theme: 'auto',
  showFurigana: true,
};

/** dailyNewLimit 的允许范围：0 表示"今天不学新词，只复习" */
export const DAILY_NEW_LIMIT_MIN = 0;
export const DAILY_NEW_LIMIT_MAX = 500;

/**
 * dailyReviewLimit 的允许范围：**20–200**（用户指定）。
 *
 * ⚠️ 下限为什么是 20 而不是 0：这里原来允许 0 = "不限量"，改掉了。
 *    理由是"不限量"这个选项看着方便，实际是个陷阱 ——
 *    它把"每天做多少"的确定性又还给了那条永远在涨的到期队列，
 *    等于把刚加这个上限的理由撤掉了。真积压多了，把上限调到 200 就够用，
 *    不需要一个"无上限"的挡箭牌。
 *    （顺带：`reviewQuotaLeft()` 里对 `limit <= 0` 返回不限量的那段逻辑**保留着**，
 *      因为它是纯函数的防御分支，且 `getSetting` 在读到 0 这种历史脏数据时
 *      也不该抛错。只是界面上再也填不出 0 了。）
 */
export const DAILY_REVIEW_LIMIT_MIN = 20;
export const DAILY_REVIEW_LIMIT_MAX = 200;

/** 把可能来自表单/旧数据的值夹成合法整数；非数字回退 undefined 交给调用方 */
function clampLimit(raw, lo, hi) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

/** 读一个设置项（不存在或非法时回退默认值） */
export async function getSetting(key) {
  const row = await dbGet('settings', key);
  const dflt = DEFAULT_SETTINGS[key];
  if (!row) return dflt;
  const v = row.value;
  if (v === undefined || v === null) return dflt;
  if (key === 'dailyNewLimit') {
    return clampLimit(v, DAILY_NEW_LIMIT_MIN, DAILY_NEW_LIMIT_MAX) ?? dflt;
  }
  if (key === 'dailyReviewLimit') {
    return clampLimit(v, DAILY_REVIEW_LIMIT_MIN, DAILY_REVIEW_LIMIT_MAX) ?? dflt;
  }
  return v;
}

/**
 * 把一个用户输入的额度**钳到允许范围**，供界面各处共用。
 *
 * 为什么单独抽出来：这一行（Math.min(max, Math.max(min, Math.floor(n)))）
 * 原来在「今日」页的复习上限弹窗、新词上限弹窗、设置页的复习输入框里各抄了一遍，
 * **三份手抄的同一个公式**。范围一改（0–500 → 20–200）就必须三处同时改对，
 * 漏一处就会出现"一个入口能填 0、另一个入口填不了"的诡异不一致。
 *
 * 非数字返回 `null`（调用方自己提示"请填一个数字"），而不是偷偷回退成 min ——
 * 静默把空输入变成 20 会让用户以为保存成功了。
 *
 * ⚠️ 空字符串**必须单独挡掉**（这是写完单测才发现的）：
 *    `Number('')` 等于 **0**，而 `Number.isFinite(0)` 是真 ——
 *    所以只判 `isFinite` 的话，用户把输入框清空、点保存，会**静默存成下限 20**，
 *    还弹一句"已保存"。清空输入框是很容易发生的动作（全选删掉），
 *    这种"看起来保存成功了但其实填了别的数"是最难发现的一类 bug。
 *    同理挡掉纯空白串 `'   '`。
 */
export function clampLimitInput(raw, min, max) {
  // 先挡空/空白串：它们会被 Number() 变成 0，不能当"合法数字"
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** 一次读出所有设置项（界面上多处要用，避免多次 await） */
export async function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  const rows = await dbAll('settings');
  for (const r of rows) {
    if (!r || !r.key) continue;
    if (r.key === 'dailyNewLimit') {
      const n = clampLimit(r.value, DAILY_NEW_LIMIT_MIN, DAILY_NEW_LIMIT_MAX);
      if (n !== undefined) out.dailyNewLimit = n;
    } else if (r.key === 'dailyReviewLimit') {
      const n = clampLimit(r.value, DAILY_REVIEW_LIMIT_MIN, DAILY_REVIEW_LIMIT_MAX);
      if (n !== undefined) out.dailyReviewLimit = n;
    } else if (r.value !== undefined && r.value !== null) {
      out[r.key] = r.value;
    }
  }
  return out;
}

/** 写一个设置项 */
export async function setSetting(key, value) {
  await dbPut('settings', { key, value, at: new Date().toISOString() });
  return value;
}

// ============================================================================
// 五之二、导出提醒（约束 3：用户数据永不丢失）
// ============================================================================
//
// 快照存在 IndexedDB 里，和主数据在同一个数据库。这意味着：
//   「快照」能救"误操作"，但**救不了**"浏览器数据被清理/换浏览器/重装系统"。
// 唯一能跨过这些灾难的是**导出到文件**。所以必须主动提醒用户导出，
// 而不是把按钮放在设置页里等用户自己想起来。
//
// 提醒策略（刻意保守，不做成烦人的弹窗）：
//   · 没有实质数据 → 不提
//   · 从没导出过，且已有实质数据 → 首次提醒
//   · 距上次导出超过 7 天，且期间数据有变化 → 提醒
//   · 距上次导出超过 30 天 → 即使没变化也提醒一次（文件本身也可能丢）

/** 参与"有没有实质数据"判断的表（快照/缓存不算） */
const MEANINGFUL_STORES = ['words', 'srs', 'reviews', 'mistakes', 'lyrics', 'readings', 'grammarState'];

/** 距上次导出多少天算"该提醒了" */
export const EXPORT_REMIND_DAYS = 7;
export const EXPORT_REMIND_DAYS_HARD = 30;

/** 统计各表条数（导出提醒与界面展示都用） */
export async function dataCounts() {
  const out = {};
  for (const s of MEANINGFUL_STORES) {
    try { out[s] = await dbCount(s); } catch { out[s] = 0; }
  }
  return out;
}

/** 把各表条数加起来，用作"数据量"指纹 */
function totalOf(counts) {
  return Object.values(counts || {}).reduce((a, b) => a + (b || 0), 0);
}

/** 读上次导出的记录 */
export async function getLastExport() {
  const r = await dbGet('meta', 'lastExport');
  return r ? r.value : null;
}

/**
 * 记一次成功导出。由调用方（设置页）在下载真正发起后调用。
 * @param {object} info { bytes, filename, counts }
 */
export async function recordExport(info = {}) {
  const counts = info.counts || await dataCounts();
  const value = {
    at: new Date().toISOString(),
    bytes: info.bytes || 0,
    filename: info.filename || '',
    counts,
    total: totalOf(counts),
  };
  await dbPut('meta', { key: 'lastExport', value });
  return value;
}

/**
 * 现在该不该提醒导出？
 * @returns {{should:boolean, reason:string, level:'info'|'warn', days:number|null, last:object|null, total:number}}
 */
export async function checkExportReminder() {
  const counts = await dataCounts();
  const total = totalOf(counts);
  const last = await getLastExport();

  // 还没什么数据，不必打扰
  if (total < 20) {
    return { should: false, reason: '', level: 'info', days: null, last, total };
  }

  if (!last) {
    return {
      should: true, level: 'warn', days: null, last, total,
      reason: `你已经有 ${total} 条学习数据，但还没有导出过备份。`
        + '数据只存在这个浏览器里，清理浏览器数据会全部丢失。建议现在导出一份文件保存到别处。',
    };
  }

  const days = Math.floor((Date.now() - new Date(last.at).getTime()) / 86400000);

  if (days >= EXPORT_REMIND_DAYS_HARD) {
    return {
      should: true, level: 'warn', days, last, total,
      reason: `上次导出备份是 ${days} 天前。备份文件本身也可能丢失或被你移动，建议重新导出一份。`,
    };
  }

  if (days >= EXPORT_REMIND_DAYS && total > (last.total || 0)) {
    return {
      should: true, level: 'info', days, last, total,
      reason: `上次导出是 ${days} 天前，此后又新增了 ${total - (last.total || 0)} 条数据。建议导出一次。`,
    };
  }

  return { should: false, reason: '', level: 'info', days, last, total };
}

// ============================================================================
// 六、导出 / 导入 / 快照（约束 3）
// ============================================================================

/**
 * 从任意 IDBDatabase 实例读出所有"当前真实存在"的 store（迁移前备份用，
 * 此时还没有全局连接，所以不能用公开 API）。
 *
 * ⚠️ 两个必须遵守的细节（都踩过）：
 *   1. **`transaction([])` 会直接抛异常**（Chrome：`The storeNames parameter
 *      was empty.`），所以"没有可读 store"必须在建事务**之前**就返回，
 *      不能先建事务再判空。曾经把断言写在 `transaction()` 之后，结果
 *      任何"旧库还没有这些表"的用户一升级就被这条异常挡住，升级中止、
 *      整个应用打不开——而这正好是升级路径最容易遇到的情况。
 *   2. store 列表必须是"STORE_DEFS ∩ 库里真实存在的表"。旧版本库里
 *      不会有后来才加的表（如 v2 的 libwords），把它们塞进 transaction
 *      同样会抛 NotFoundError。
 *
 * @returns {Promise<{data: object, stores: string[]}>}
 */
function dumpFrom(db) {
  return new Promise((resolve, reject) => {
    const names = Object.keys(STORE_DEFS).filter((n) => {
      try { return db.objectStoreNames.contains(n); } catch { return false; }
    });

    // 先判空，再建事务。顺序不能颠倒。
    if (!names.length) return resolve({ data: {}, stores: [] });

    let tx;
    try {
      tx = db.transaction(names, 'readonly');
    } catch (e) {
      return reject(e);
    }

    const out = {};
    let left = names.length;
    let done = false;
    const finish = () => { if (!done) { done = true; resolve({ data: out, stores: names }); } };

    for (const n of names) {
      const r = tx.objectStore(n).getAll();
      r.onsuccess = () => {
        out[n] = r.result || [];
        if (--left === 0) finish();
      };
      r.onerror = () => reject(r.error || new Error('读取 ' + n + ' 失败'));
    }
    tx.onerror = () => reject(tx.error || new Error('导出事务失败'));
    tx.onabort = () => reject(tx.error || new Error('导出事务被中止'));
  });
}

/**
 * 派生数据表：内容可以随时从 data/ 重建，不属于用户数据。
 * 导出时默认排除 —— 否则每次备份都会多带上万条内置词库镜像，
 * 备份文件白白膨胀十几倍，而它还还原不出任何"用户做过的事"。
 *
 * 导出这个集合是刻意为之：这个不变量（哪些表不是用户数据）必须可被
 * 自检脚本断言，否则将来有人把用户数据表错加进来，会静默地从备份里消失。
 */
export const DERIVED_STORES = new Set(['libwords']);

/**
 * 整包导出。
 * @param {{ includeSnapshots?: boolean, includeDerived?: boolean }} opts
 *        includeSnapshots 默认 false：快照是备份的备份，默认不塞进导出文件，
 *        否则文件会指数级膨胀。
 *        includeDerived 默认 false：内置词库缓存是派生数据，导入后会自动重建。
 */
export async function exportAll(opts = {}) {
  const includeSnapshots = !!opts.includeSnapshots;
  const includeDerived = !!opts.includeDerived;
  const db = await openDB();
  const names = Object.keys(STORE_DEFS).filter(
    (n) => db.objectStoreNames.contains(n)
      && (includeSnapshots || n !== 'snapshots')
      && (includeDerived || !DERIVED_STORES.has(n))
  );
  const stores = await new Promise((resolve, reject) => {
    // ⚠️ 先判空，再建事务。`db.transaction([])` 在真实浏览器里**抛异常**
    // （"The storeNames parameter was empty."），不是返回空事务。
    // 曾经因为在 `db.transaction()` 之后才判空，把用户锁在门外过，
    // 见 ARCHITECTURE.md §10.17。这里虽然理论上走不到（除非库里一张已知表都没有），
    // 但同一个坑不要留第二处。
    if (!names.length) return resolve({});
    const tx = db.transaction(names, 'readonly');
    const out = {};
    let left = names.length;
    for (const n of names) {
      const r = tx.objectStore(n).getAll();
      r.onsuccess = () => {
        out[n] = r.result || [];
        if (--left === 0) resolve(out);
      };
      r.onerror = () => reject(r.error || new Error('读取 ' + n + ' 失败'));
    }
    tx.onerror = () => reject(tx.error || new Error('导出事务失败'));
  });

  const counts = {};
  for (const [k, v] of Object.entries(stores)) if (Array.isArray(v)) counts[k] = v.length;

  return {
    format: 'jp-learn-backup',
    formatVersion: 1,
    app: APP_NAME,
    appVersion: APP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    counts,
    stores,
  };
}

/** 触发浏览器下载一个 JSON 文件（不经过任何服务器） */
export function downloadJSON(obj, filename) {
  const text = JSON.stringify(obj, null, 2);
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || `jp-learn-backup-${stamp()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return { bytes: text.length, filename: a.download };
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 校验一个导入文件是否符合格式，返回 { ok, error, info } */
export function validateBackup(obj) {
  if (!obj || typeof obj !== 'object') return { ok: false, error: '不是有效的 JSON 对象' };
  if (obj.format !== 'jp-learn-backup') return { ok: false, error: '不是本应用导出的备份文件（缺少 format: jp-learn-backup）' };
  if (typeof obj.formatVersion !== 'number') return { ok: false, error: '缺少 formatVersion' };
  if (obj.formatVersion > 1) return { ok: false, error: `备份文件版本 ${obj.formatVersion} 比当前程序支持的版本（1）新，请先更新程序` };
  if (!obj.stores || typeof obj.stores !== 'object') return { ok: false, error: '缺少 stores 数据段' };
  const unknown = Object.keys(obj.stores).filter((k) => !(k in STORE_DEFS));
  return {
    ok: true,
    info: {
      appVersion: obj.appVersion || '未知',
      schemaVersion: obj.schemaVersion ?? '未知',
      exportedAt: obj.exportedAt || '未知',
      counts: obj.counts || Object.fromEntries(Object.entries(obj.stores).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])),
      unknownStores: unknown,
    },
  };
}

/**
 * 导入恢复。
 * @param {'merge'|'replace'} mode
 *   merge   = 合并（同 id 覆盖，其余保留）—— 默认，比较安全
 *   replace = 用备份内容替换对应 store（导入前强制自动快照）
 */
export async function importAll(obj, mode = 'merge') {
  const v = validateBackup(obj);
  if (!v.ok) throw new Error(v.error);

  // 约束 3：导入会改动数据 → 先强制备份一次，无论哪种模式
  await makeSnapshot('before-import', '导入备份前的自动快照');

  const db = await openDB();
  const names = Object.keys(obj.stores).filter((n) => n in STORE_DEFS && db.objectStoreNames.contains(n));
  if (!names.length) throw new Error('备份文件里没有任何本程序认识的表，已中止导入');

  const tx = db.transaction(names, 'readwrite');
  let written = 0;
  for (const n of names) {
    const os = tx.objectStore(n);
    if (mode === 'replace') os.clear();
    const rows = Array.isArray(obj.stores[n]) ? obj.stores[n] : [];
    for (const row of rows) { os.put(row); written++; }
  }
  await txDone(tx);
  await dbPut('meta', { key: 'lastImport', value: { at: new Date().toISOString(), mode, written, from: v.info } });
  return { written, mode, stores: names.length };
}

/**
 * 生成一份快照并存进 snapshots 表。
 * @param {'auto'|'manual'|'preupgrade'|'before-import'|'before-wipe'} kind
 */
export async function makeSnapshot(kind = 'auto', note = '') {
  const dump = await exportAll({ includeSnapshots: false });
  const snap = {
    id: kind + '-' + Date.now(),
    kind,
    at: new Date().toISOString(),
    note,
    appVersion: APP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    bytes: JSON.stringify(dump).length,
    data: dump,
  };
  await dbPut('snapshots', snap);
  await pruneSnapshots();
  return { id: snap.id, bytes: snap.bytes, at: snap.at };
}

/**
 * 快照淘汰。
 *
 * 淘汰顺序：auto → before-import → manual → before-wipe。
 * 「绝不自动删」：preupgrade（迁移前备份）与 before-wipe（清空前的强制备份）。
 * 这两类是用户唯一的"撤回"依据，删掉它们等于把约束 3 的承诺作废。
 */
async function pruneSnapshots() {
  const all = await dbAll('snapshots');
  if (all.length <= SNAPSHOT_LIMIT) return { removed: 0, kept: all.length };

  const prio = { auto: 0, 'before-import': 1, manual: 2, 'before-wipe': 3, preupgrade: 4 };
  const PINNED = new Set(['preupgrade', 'before-wipe']);
  const sorted = all.slice().sort((a, b) => {
    const pa = prio[a.kind] ?? 1, pb = prio[b.kind] ?? 1;
    if (pa !== pb) return pa - pb;              // 先淘汰低优先级的
    return String(a.at).localeCompare(String(b.at)); // 同优先级淘汰最旧的
  });

  const removeCount = all.length - SNAPSHOT_LIMIT;
  const victims = sorted.slice(0, removeCount).filter((s) => !PINNED.has(s.kind));
  for (const s of victims) await dbDelete('snapshots', s.id);
  return { removed: victims.length, kept: all.length - victims.length };
}

/** 页面加载时调用：太久没自动快照就存一份 */
export async function maybeAutoSnapshot() {
  try {
    const all = await dbAll('snapshots');
    const autos = all.filter((s) => s.kind === 'auto');
    const last = autos.length ? Math.max(...autos.map((s) => new Date(s.at).getTime() || 0)) : 0;
    if (Date.now() - last < AUTO_SNAPSHOT_INTERVAL) return null;
    // 没有任何数据时不必要地存快照
    const hasContent = (await dbCount('words')) + (await dbCount('srs')) + (await dbCount('lyrics')) + (await dbCount('readings')) > 0;
    if (!hasContent) return null;
    return await makeSnapshot('auto', '定期自动快照');
  } catch {
    return null; // 自动快照失败绝不能影响应用启动
  }
}

/**
 * 从快照恢复。
 * 恢复前会再存一份当前状态的快照（否则"恢复错了"就没退路了）。
 */
export async function restoreSnapshot(snapshotId) {
  const snap = await dbGet('snapshots', snapshotId);
  if (!snap || !snap.data) throw new Error('找不到该快照');
  await makeSnapshot('before-import', '从快照恢复之前的自动快照');
  const r = await importAll(snap.data, 'replace');
  // importAll 内部还会再存一份，这里顺手清理重复的（只保留它刚存的那份）
  return { ...r, restoredFrom: snapshotId, at: snap.at };
}

/**
 * 清空所有用户数据。
 * 约束 3 硬性要求：必须二次确认 + 清空前强制备份。
 * 本函数只负责「强制备份 + 清空」，二次确认由 UI 负责（ui.js 的 confirmTwice）。
 *
 * 【为什么不清 snapshots】早期版本把 snapshots 也一起 clear()，结果刚做的那份
 * 强制备份连带被删掉 —— 用户拿到了 backupId，却什么也恢复不出来，等于没有备份。
 * 现在保留 snapshots，并让 pruneSnapshots 保证 before-wipe 不被淘汰，
 * 所以"清空后还能撤回"这件事是真的成立。
 * @returns {{ backupId: string, cleared: string[] }}
 */
export async function wipeAllData() {
  const backup = await makeSnapshot('before-wipe', '清空数据前的强制备份');
  const db = await openDB();
  // meta 保留：schemaVersion / installedAt 是程序信息，不是用户内容。
  // snapshots 保留：那是"清空之前的备份"，删了就等于没有强制备份（见上方说明）。
  const clearable = Object.keys(STORE_DEFS).filter((n) => n !== 'meta' && n !== 'snapshots');
  const tx = db.transaction(clearable, 'readwrite');
  for (const n of clearable) tx.objectStore(n).clear();
  await txDone(tx);
  await pruneSnapshots();
  await dbPut('meta', { key: 'lastWipe', value: { at: new Date().toISOString(), backupId: backup.id } });
  return { backupId: backup.id, cleared: clearable, backupKind: 'before-wipe' };
}

/** 数据库自检：返回一份给人看的状态，用于「设置 → 数据」面板 */
export async function selfCheck() {
  const out = { idb: hasIDB(), schemaVersion: SCHEMA_VERSION, appVersion: APP_VERSION, stores: {}, error: null };
  if (!out.idb) { out.error = 'IndexedDB 不可用'; return out; }
  try {
    const db = await openDB();
    for (const n of Object.keys(STORE_DEFS)) {
      if (!db.objectStoreNames.contains(n)) { out.stores[n] = '缺失'; continue; }
      out.stores[n] = await dbCount(n);
    }
    out.installedAt = (await dbGet('meta', 'installedAt'))?.value || null;
    out.lastMigration = (await dbGet('meta', 'lastMigration'))?.value || null;
    out.lastImport = (await dbGet('meta', 'lastImport'))?.value || null;
    out.lastWipe = (await dbGet('meta', 'lastWipe'))?.value || null;
    // 缺表标记（openDB 第 4.5 步写的）。这里是"给人看"的出口：
    // 只在控制台报错的话，用户永远不知道根因是什么。
    const flag = (await dbGet('meta', 'missingStores'))?.value || null;
    out.missingStores = flag && Array.isArray(flag.stores) ? flag.stores : [];
  } catch (e) {
    out.error = (e && e.message) || String(e);
  }
  return out;
}

/** 当前 schema 版本（从库里读，用于和代码版本对比） */
export async function getStoredSchemaVersion() {
  if (!hasIDB()) return null;
  try {
    const r = await dbGet('meta', 'schemaVersion');
    return r ? r.value : null;
  } catch { return null; }
}

/** 关闭连接（测试与"强制刷新"时用） */
export function closeDB() {
  try { dbInstance && dbInstance.close(); } catch {}
  dbInstance = null;
  dbPromise = null;
}
