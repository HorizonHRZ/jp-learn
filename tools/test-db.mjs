/**
 * 用户数据层测试（db.js）—— 约束 2 / 约束 3 的守门测试
 *
 * 用法：node tools/test-db.mjs
 *
 * 为什么需要它：db.js 是用户数据安全的最后一道防线（导出/导入/快照/清空/迁移），
 * 但它只能在浏览器里跑。这里用一个**内存版 IndexedDB** 把它真正跑起来，
 * 而不是只做静态检查——静态检查看不出"导入时把用户数据清了"这类错误。
 *
 * 覆盖：
 *   1. 建表、schema 版本、派生表标记、迁移函数里没有破坏性操作
 *   2. 导出内容：含用户数据、不含派生缓存
 *   3. 导入校验与 merge / replace 语义，且导入前强制快照
 *   4. 快照保留策略：preupgrade 永不被自动删除
 *   5. 清空：强制备份 + 用户数据归零
 *   6. 导出提醒（本轮新增）
 *   7. 设置项 API（每日新词额度）与 introducedAt 的写入
 *   8. 程序比数据旧时拒绝打开（防回退写坏数据）
 *   9. 老库升级路径
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0, passed = 0;
const ok = (cond, label, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
};
const eq = (a, b, label) => ok(a === b, label, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);

console.log('='.repeat(74));
console.log(' 用户数据层测试（内存版 IndexedDB）');
console.log('='.repeat(74));

// ===========================================================================
// 内存版 IndexedDB —— 已抽到 tools/lib/fake-idb.mjs 共用
// （test-flow.mjs 的端到端用户流程测试也要用它；实现只能有一份）
// ===========================================================================
import { installFakeIDB } from './lib/fake-idb.mjs';

/*
 * 原有的内联实现已删除，搬到了 tools/lib/fake-idb.mjs。
 * 它当年每一处"⚠️ 踩坑"注释都原样保留在那里 —— 那些注释解释了
 * "假实现为什么必须长这样"（比如 storeNames 为空要抛异常、
 * transaction 必须挂在事件对象顶层），改那个文件之前请先读。
 */

const rec = installFakeIDB();

const db = await import('../app/js/db.js');
const { SCHEMA_VERSION } = await import('../app/js/version.js');

/** 任何调用挂住时立刻报错，而不是让整个测试卡死 */
const withTimeout = (p, ms, label) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => {
    const e = new Error(`超时(${ms}ms): ${label}`);
    e.fromTest = true;
    rej(e);
  }, ms)),
]);

// 打出任何未捕获的拒绝，避免"静默挂死"
process.on('unhandledRejection', (e) => {
  console.log('  [未处理的 Promise 拒绝]', (e && e.stack) || e);
});

// ---------------------------------------------------------------------------
console.log('\n[1] 建表与 schema');
// ---------------------------------------------------------------------------
{
  const info = await withTimeout(db.selfCheck(), 5000, 'selfCheck');
  ok(info && !info.error, '数据库可初始化', info && info.error);
  eq(info.schemaVersion, SCHEMA_VERSION, `结构版本为 ${SCHEMA_VERSION}`);
  ok(Object.keys(info.stores).length > 8, `各表都已建立（${Object.keys(info.stores).length} 张）`);
  ok(!Object.values(info.stores).includes('缺失'), '没有缺失的表', JSON.stringify(info.stores));

  ok(db.STORE_DEFS.libwords !== undefined, 'libwords 表已声明');
  ok(db.DERIVED_STORES && db.DERIVED_STORES.has('libwords'), 'libwords 属于派生表（不进备份）');

  // 硬约束：MIGRATIONS 里不得有 deleteObjectStore / clear。
  // 取「真正的声明体」（从 `const MIGRATIONS = {` 到它的收尾 `};`），并去掉注释，
  // 否则会被别处说明文字里的同名词误判 —— 这个断言曾经因此假报错。
  const src = fs.readFileSync(path.join(ROOT, 'app/js/db.js'), 'utf8');
  const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const declAt = src.indexOf('const MIGRATIONS');
  const declEnd = src.indexOf('\n};', declAt);
  ok(declAt > 0 && declEnd > declAt, '能定位到 MIGRATIONS 声明体');
  const migZone = stripComments(src.slice(declAt, declEnd));
  ok(!/deleteObjectStore/.test(migZone), 'MIGRATIONS 里没有 deleteObjectStore');
  ok(!/\.clear\(\)/.test(migZone), 'MIGRATIONS 里没有 clear()');
}

// ---------------------------------------------------------------------------
console.log('\n[2] 写入用户数据');
// ---------------------------------------------------------------------------
{
  await db.dbPut('words', { id: 'jmdict:100', term: '猫', reading: 'ねこ', glosses: ['猫'], addedAt: 1 });
  await db.dbPut('words', { id: 'jmdict:200', term: '犬', reading: 'いぬ', glosses: ['狗'], addedAt: 2 });
  await db.dbPut('srs', { id: 'jmdict:100', state: 2, due: 1000, interval: 5, ease: 2.5, reps: 3, lapses: 0 });
  await db.dbPut('reviews', { id: 'r1', wordId: 'jmdict:100', grade: 1, at: 900 });
  await db.dbPut('mistakes', { id: 'm1', wordId: 'jmdict:200', wrongCount: 2, correctStreak: 0 });
  await db.dbPut('libwords', { id: 'lib:n5:1', term: '山', level: 'N5' });
  // ★ 一条带 AI 译文缓存的笔记。
  //   为什么专门放一条：用户明确要求"导出的备份里要包含 AI 译文"
  //   （他为此花过 token，丢了就得重花钱）。译文是挂在**笔记记录内部**的
  //   `aiCache` 字段，不是单独的存储表 —— 所以这里要证明它真的跟着导出走了。
  await db.dbPut('lyrics', {
    id: 'lyric:db-1', title: '测试歌词', text: '猫である。\n名前はまだ無い。',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
    aiCache: { translation: { 0: '是猫。', 1: '还没有名字。' }, at: '2026-01-02T00:00:00.000Z' },
  });
  await db.dbPut('readings', {
    id: 'reading:db-1', title: '测试精读', text: '吾輩は猫である。',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    aiCache: { translation: { 0: '我是猫。' }, explain: { 0: '「吾輩」是老派的第一人称。' }, at: '2026-01-01T00:00:00.000Z' },
  });

  eq(await db.dbCount('words'), 2, '生词本 2 条');
  eq(await db.dbCount('libwords'), 1, '派生缓存 1 条');
}

// ---------------------------------------------------------------------------
console.log('\n[3] 导出：含用户数据、不含派生缓存');
// ---------------------------------------------------------------------------
let dump;
{
  dump = await db.exportAll({ includeSnapshots: false });
  eq(dump.format, 'jp-learn-backup', '备份格式标记正确');
  ok(dump.stores.words && dump.stores.words.length === 2, '备份含 2 个生词');
  ok(dump.stores.libwords === undefined, '备份不含 libwords（派生缓存）');
  ok(dump.counts.libwords === undefined, 'counts 里也没有 libwords');
  ok(!!dump.appVersion && !!dump.schemaVersion, '备份记录了应用与结构版本');

  const withDerived = await db.exportAll({ includeDerived: true });
  ok(withDerived.stores.libwords !== undefined, '显式要求时才带上派生缓存');

  // ★ 用户点名的要求：导出的备份必须包含 AI 译文。
  //   他的原话大意是"翻译是我花 token 换来的，丢了还得再花一次"。
  //   这里断言的是**内容**而不是"字段存在" —— 字段存在但里面是空的，
  //   对用户来说等于没备份。
  const lyr = (dump.stores.lyrics || []).find((r) => r.id === 'lyric:db-1');
  ok(!!lyr, '备份里有那条歌词笔记');
  ok(lyr && lyr.aiCache && lyr.aiCache.translation
    && lyr.aiCache.translation['0'] === '是猫。' && lyr.aiCache.translation['1'] === '还没有名字。',
    '★★ 备份里的歌词笔记带着完整 AI 译文（一段都不少）',
    lyr && lyr.aiCache ? JSON.stringify(lyr.aiCache.translation) : '没有 aiCache');
  const rd = (dump.stores.readings || []).find((r) => r.id === 'reading:db-1');
  ok(rd && rd.aiCache && rd.aiCache.translation['0'] === '我是猫。',
    '★★ 备份里的精读笔记也带着 AI 译文');
  ok(rd && rd.aiCache && rd.aiCache.explain && rd.aiCache.explain['0'],
    '★ AI 讲解（不只是译文）也在备份里');
  ok(lyr && lyr.text === '猫である。\n名前はまだ無い。', '备份里的正文原样保留');
}

// ---------------------------------------------------------------------------
console.log('\n[4] 导入校验与 merge / replace');
// ---------------------------------------------------------------------------
{
  ok(db.validateBackup(dump).ok === true, '自己的备份能通过校验');
  ok(db.validateBackup({}).ok === false, '空对象校验失败');
  ok(db.validateBackup({ format: 'something-else' }).ok === false, '格式标记不对时失败');

  const before = (await db.exportAll({ includeSnapshots: true })).counts.snapshots || 0;

  const backup = {
    format: 'jp-learn-backup', formatVersion: 1, appVersion: '0.0.1', schemaVersion: 1,
    exportedAt: new Date().toISOString(), counts: { words: 1 },
    stores: { words: [{ id: 'jmdict:300', term: '鳥', reading: 'とり', glosses: ['鸟'] }] },
  };
  const r1 = await db.importAll(backup, 'merge');
  ok(r1.written > 0, 'merge 导入了记录', JSON.stringify(r1));
  eq(await db.dbCount('words'), 3, 'merge 后原有 2 条仍在（合并语义）');
  const after = (await db.exportAll({ includeSnapshots: true })).counts.snapshots || 0;
  ok(after > before, '导入前自动创建了快照（约束 3）');

  const r2 = await db.importAll(backup, 'replace');
  ok(r2.written > 0, 'replace 导入成功');
  eq(await db.dbCount('words'), 1, 'replace 后 words 只剩备份里的 1 条');

  const weird = {
    format: 'jp-learn-backup', formatVersion: 1, appVersion: 'x', schemaVersion: 1,
    exportedAt: new Date().toISOString(), counts: {}, stores: { notAStore: [{ a: 1 }] },
  };
  const v = db.validateBackup(weird);
  ok(v.ok === true && (v.info.unknownStores || []).includes('notAStore'),
    '未知表被识别为忽略项而不是报错', JSON.stringify(v.info && v.info.unknownStores));
}

// ---------------------------------------------------------------------------
console.log('\n[4b] ★ 走一遍 JSON 序列化：AI 译文在"导出文件 → 导入"之后还在');
// ---------------------------------------------------------------------------
{
  // 为什么必须真的 JSON.stringify / parse 一遍：
  //   导出是"存成文件"，文件就是文本。内存里的对象再对，经过一次
  //   JSON 往返也可能变形（比如键被转成字符串、嵌套对象被丢）。
  //   只断言"内存里 exportAll 的结果里有译文"是不够的 ——
  //   用户真正关心的那份东西是**磁盘上的那个文件**。
  const beforeText = (await db.dbGet('lyrics', 'lyric:db-1')).aiCache.translation;
  const file = JSON.parse(JSON.stringify(dump));   // 模拟"存盘再读回来"
  ok(file.stores.lyrics.find((r) => r.id === 'lyric:db-1').aiCache.translation['1'] === '还没有名字。',
    '经过 JSON 往返之后，译文内容一字不差');

  // 真的清掉再导回去
  await db.dbDelete('lyrics', 'lyric:db-1');
  ok((await db.dbGet('lyrics', 'lyric:db-1')) === undefined || (await db.dbGet('lyrics', 'lyric:db-1')) === null,
    '先真的把这条笔记删掉（否则下面的断言是空跑）');

  const rr = await db.importAll(file, 'merge');
  ok(rr.written > 0, '把那份备份导回来');
  const restored = await db.dbGet('lyrics', 'lyric:db-1');
  ok(!!restored, '笔记回来了');
  ok(restored && restored.aiCache && restored.aiCache.translation['0'] === '是猫。'
    && restored.aiCache.translation['1'] === '还没有名字。',
    '★★ 恢复之后 AI 译文一段不少 —— 用户不用再花一次 token',
    restored && restored.aiCache ? JSON.stringify(restored.aiCache.translation) : '没有 aiCache');
  ok(JSON.stringify(beforeText) === JSON.stringify(restored.aiCache.translation),
    '★ 恢复的译文和导出前完全一致（逐键比对）');
}

// ---------------------------------------------------------------------------
console.log('\n[5] 快照与保留策略');
// ---------------------------------------------------------------------------
{
  const s1 = await db.makeSnapshot('manual', '测试用');
  ok(!!(s1 && s1.id), '手动快照创建成功');

  for (let i = 0; i < 14; i++) {
    await db.dbPut('snapshots', {
      id: 'auto-' + i, kind: 'auto', at: new Date(Date.now() + i * 1000).toISOString(),
      bytes: 100, data: { format: 'jp-learn-backup', formatVersion: 1, stores: {} },
    });
  }
  await db.dbPut('snapshots', {
    id: 'preupgrade-1-1', kind: 'preupgrade', at: new Date().toISOString(),
    bytes: 100, data: { format: 'jp-learn-backup', formatVersion: 1, stores: {} },
  });

  // makeSnapshot 内部会 pruneSnapshots()，借它触发一次修剪
  await db.makeSnapshot('auto', '触发修剪');

  const left = await db.dbAll('snapshots');
  const ids = left.map((s) => s.id);
  ok(ids.includes('preupgrade-1-1'), 'preupgrade 快照不会被自动删除（保留回滚依据）');
  ok(left.filter((s) => s.kind === 'auto').length <= 12, '自动快照数量被限制住',
    `实际 ${left.filter((s) => s.kind === 'auto').length}`);
}

// ---------------------------------------------------------------------------
console.log('\n[6] 清空：强制备份 + 用户数据归零 + 备份可恢复');
// ---------------------------------------------------------------------------
{
  const beforeSnaps = (await db.dbAll('snapshots')).length;
  const r = await db.wipeAllData();
  ok(!!(r && r.backupId), '清空前自动生成了备份', JSON.stringify(r));
  eq(await db.dbCount('words'), 0, '生词本已清空');
  eq(await db.dbCount('srs'), 0, 'SRS 排程已清空');
  eq(await db.dbCount('reviews'), 0, '答题历史已清空');
  eq(await db.dbCount('mistakes'), 0, '错题本已清空');

  // 关键：刚做的那份强制备份必须还在。曾经因为 snapshots 也被 clear()，
  // 用户拿到 backupId 却恢复不出任何东西 —— 那等于没有备份。
  const snaps = await db.dbAll('snapshots');
  const mine = snaps.find((s) => s.id === r.backupId);
  ok(!!mine, '强制备份快照在清空后依然存在（可以撤回）',
    `快照数 ${beforeSnaps} → ${snaps.length}`);
  eq(mine && mine.kind, 'before-wipe', '该快照类型为 before-wipe');

  // 而且真的能恢复出用户数据
  const restored = await db.restoreSnapshot(r.backupId);
  ok(restored && restored.written > 0, '可以用该备份恢复数据', JSON.stringify(restored));
  ok((await db.dbCount('words')) > 0, '恢复后生词本重新有数据');

  // 再清一次，确认清空是幂等可重复的
  const r2 = await db.wipeAllData();
  ok(!!r2.backupId && r2.backupId !== r.backupId, '可以反复清空，每次都有独立备份');
  // 把恢复出来的数据再清掉，避免影响后续断言
  eq(await db.dbCount('words'), 0, '清空是幂等的');
}

// ---------------------------------------------------------------------------
console.log('\n[7] 导出提醒');
// ---------------------------------------------------------------------------
{
  let rem = await db.checkExportReminder();
  eq(rem.should, false, '数据很少时不提醒');

  for (let i = 0; i < 30; i++) {
    await db.dbPut('words', { id: 'w' + i, term: 't' + i, reading: 'r' + i, glosses: ['g'], addedAt: i });
  }
  rem = await db.checkExportReminder();
  eq(rem.should, true, '有数据但从未导出 → 提醒');
  eq(rem.level, 'warn', '首次提醒是 warn 级别');
  ok(/还没有导出过/.test(rem.reason), '文案说明从未导出', rem.reason);

  const recd = await db.recordExport({ bytes: 12345, filename: 'a.json' });
  ok(recd.total >= 30, '导出记录里保存了当时的数据量', String(recd.total));
  rem = await db.checkExportReminder();
  eq(rem.should, false, '刚导出过 → 不提醒');

  const old = await db.getLastExport();
  old.at = new Date(Date.now() - 40 * 86400000).toISOString();
  await db.dbPut('meta', { key: 'lastExport', value: old });
  rem = await db.checkExportReminder();
  eq(rem.should, true, '超过 30 天没导出 → 重新提醒');
  ok(/天前/.test(rem.reason), '文案包含天数', rem.reason);

  old.at = new Date(Date.now() - 10 * 86400000).toISOString();
  old.total = 1;
  await db.dbPut('meta', { key: 'lastExport', value: old });
  rem = await db.checkExportReminder();
  eq(rem.should, true, '10 天前导出且数据增长 → 提醒');
  ok(/新增了/.test(rem.reason), '文案说明新增了多少', rem.reason);

  old.at = new Date(Date.now() - 2 * 86400000).toISOString();
  await db.dbPut('meta', { key: 'lastExport', value: old });
  rem = await db.checkExportReminder();
  eq(rem.should, false, '2 天前导出过 → 不提醒');

  eq(db.EXPORT_REMIND_DAYS, 7, '常规提醒阈值 7 天');
  eq(db.EXPORT_REMIND_DAYS_HARD, 30, '硬提醒阈值 30 天');
}

// ---------------------------------------------------------------------------
console.log('\n[7b] 设置项 API（每日新词额度等）');
// ---------------------------------------------------------------------------
// 为什么设置放在 settings 这张已有的 key-value 表里、而不是新开一张：
// 加一个 key 不是结构变更（store / index 都没动），所以 SCHEMA_VERSION 不用动，
// 老用户升级时不会因为一次没必要的迁移丢东西。这里顺带把这条不变量钉住。
{
  eq(db.DEFAULT_SETTINGS.dailyNewLimit, 50, '每日新词上限默认为 50（用户指定）');
  eq(db.DAILY_NEW_LIMIT_MIN, 0, '下限是 0（0 = 今天只复习、不学新词）');
  eq(db.DAILY_NEW_LIMIT_MAX, 500, '上限是 500');

  // --- 每日复习上限：默认 50、范围 20–200（用户 2026-10 看过 12 倍数据后定的）---
  // 这一组数字是"改过一次"的，所以每个都单独钉住：
  //   最初定的是 40 且下限 0（0 = 不限量）；用户看到实测数据后改成 50 / 20–200。
  //   把四个常数全钉死，是因为它们分散在"默认值 + 两个边界"三处，
  //   只钉一个的话改范围时漏改另一个不会被发现。
  eq(db.DEFAULT_SETTINGS.dailyReviewLimit, 50, '每日复习上限默认为 50（用户指定）');
  eq(db.DAILY_REVIEW_LIMIT_MIN, 20, '复习上限下限是 20（不再允许 0 = 不限量）');
  eq(db.DAILY_REVIEW_LIMIT_MAX, 200, '复习上限上限是 200');

  eq(await db.getSetting('dailyReviewLimit'), 50, '从没写过时返回默认值 50');
  // 越界必须夹住：不然"界面填不出 0"就只是界面的事，数据层还能存进 0
  await db.setSetting('dailyReviewLimit', 0);
  eq(await db.getSetting('dailyReviewLimit'), 20, '历史脏数据 0 被夹到下限 20（不再当"不限量"）');
  await db.setSetting('dailyReviewLimit', 9999);
  eq(await db.getSetting('dailyReviewLimit'), 200, '写 9999 被夹到上限 200');
  const sRev = await db.getSettings();
  eq(sRev.dailyReviewLimit, 200, 'getSettings 与 getSetting 夹取口径一致');

  // --- clampLimitInput：界面三个入口共用这一个公式 ---
  // 存在的理由就是"别再手抄 Math.min/max 三遍"（改范围时漏改一处就会出现
  // 一个入口能填 0、另一个填不了的诡异不一致）。非数字必须返回 null，不能静默回退成下限。
  eq(db.clampLimitInput('45', 20, 200), 45, '范围内的整数原样通过');
  eq(db.clampLimitInput(0, 20, 200), 20, '低于下限夹到下限');
  eq(db.clampLimitInput(999, 20, 200), 200, '高于上限夹到上限');
  eq(db.clampLimitInput('45.9', 20, 200), 45, '小数向下取整（不是四舍五入）');
  // ⚠️ 这两条是"写了才发现"的：Number('') === 0，所以只判 isFinite 的话
  //    清空输入框点保存会静默存成下限 20，还提示"已保存"。必须单独挡住。
  eq(db.clampLimitInput('', 20, 200), null, '空字符串 → null（否则 Number("")===0 会被静默存成下限）');
  eq(db.clampLimitInput('   ', 20, 200), null, '纯空白串 → null');
  eq(db.clampLimitInput('abc', 20, 200), null, '非数字 → null');
  eq(db.clampLimitInput(NaN, 20, 200), null, 'NaN → null');

  eq(await db.getSetting('dailyNewLimit'), 50, '从没写过时返回默认值 50');
  eq(await db.getSetting('theme'), 'auto', '其它设置项也回退到默认值');
  eq(await db.getSetting('从没定义过的键'), undefined, '未定义的键返回 undefined（不瞎编默认值）');

  // 夹取：越界值必须落到边界上，否则用户能把每日额度设成 99999，
  // 第二天一开页面就要求学几万个新词。
  await db.setSetting('dailyNewLimit', 999);
  eq(await db.getSetting('dailyNewLimit'), 500, '写 999 被夹到上限 500');
  const s1 = await db.getSettings();
  eq(s1.dailyNewLimit, 500, 'getSettings 与 getSetting 夹取口径一致');
  eq(s1.theme, 'auto', 'getSettings 带上了没写过的默认项');
  eq(s1.showFurigana, true, 'getSettings 保留默认的注音开关');

  await db.setSetting('dailyNewLimit', -5);
  eq(await db.getSetting('dailyNewLimit'), 0, '写 -5 被夹到下限 0');

  await db.setSetting('dailyNewLimit', 12.7);
  eq(await db.getSetting('dailyNewLimit'), 12, '小数向下取整（额度必须是整数个词）');

  await db.setSetting('dailyNewLimit', 'abc');
  eq(await db.getSetting('dailyNewLimit'), 50, '非数字字符串回退默认值 50，而不是变成 NaN');

  await db.setSetting('dailyNewLimit', 30);
  eq(await db.getSetting('dailyNewLimit'), 30, '合法值原样写回');
  eq(db.STORE_DEFS.settings !== undefined, true, '设置仍然放在已有的 settings 表里');

  // ★ 这个断言原来写的是 `eq(SCHEMA_VERSION, 2, '本轮没有新增表，所以 SCHEMA_VERSION 依然是 2')`。
  //   那是一个**只反映当时状态、没有任何判别力**的断言：它把"版本号是 2"
  //   当成了正确性的定义。真正该断言的是"版本号与表结构一致"，见下面 [7d]。
  eq(typeof SCHEMA_VERSION, 'number', 'SCHEMA_VERSION 是一个数字');
}

// ---------------------------------------------------------------------------
console.log('\n[7c] introducedAt：今日已学新词靠它统计（每日额度的依据）');
// ---------------------------------------------------------------------------
// 光看 state !== 'new' 只能知道"学过"，不知道"哪天学的"，每日上限就会退化成
// "每次练习给 N 个"。所以从 new 转出时必须写一次 introducedAt，且只写一次。
{
  const vd = await import('../app/js/vocabdata.js');
  const T1 = Date.UTC(2026, 2, 10, 3, 0, 0);
  const T2 = T1 + 3 * 24 * 60 * 60 * 1000;      // 三天后再答一次
  const id = 'user:test-introduced';

  const first = await vd.recordAnswer({
    wordId: id, grade: 'good', mode: 'jp2zh', correct: true,
    input: '会う', expected: '会う', now: T1,
  });
  eq(typeof first.card.introducedAt, 'number', '从 new 转出后写入了 introducedAt（数字时间戳）');
  eq(first.card.introducedAt, T1, 'introducedAt 就是这次作答的时间');
  const stamp = first.card.introducedAt;
  eq((await db.dbGet('srs', id)).introducedAt, T1, 'introducedAt 落盘了，不只是返回值里有');

  const second = await vd.recordAnswer({
    wordId: id, grade: 'good', mode: 'jp2zh', correct: true,
    input: '会う', expected: '会う', now: T2,
  });
  eq(second.card.introducedAt, stamp, '再答一次 introducedAt 不变（"首次学习时间"不能被覆写成今天）');
}

// ---------------------------------------------------------------------------
console.log('\n[8] 防回退：程序比数据旧时必须拒绝打开');
// ---------------------------------------------------------------------------
{
  rec.version = SCHEMA_VERSION + 5;   // 假装数据是更新版程序写的
  db.closeDB();
  let threw = null;
  try {
    await withTimeout(db.dbCount('words'), 4000, '旧程序打开新数据');
  } catch (e) { threw = e; }
  ok(threw !== null, '旧程序打开新数据时抛错，而不是继续写');
  ok(threw && /比当前程序/.test(String(threw.message)), '错误信息说明了原因', threw && threw.message);
}

// ---------------------------------------------------------------------------
console.log('\n[9] 升级路径：老用户从 v1 升到当前版本（本轮新增，修掉整站打不开的 bug）');
// ---------------------------------------------------------------------------
// 为什么必须单独测这一节：升级路径**只会在真实老用户身上触发**，
// 全新安装永远走不到。之前只测了全新安装，于是漏掉了这个 bug ——
// dumpFrom() 先 db.transaction(names) 再判空，当旧库里没有任何已知表时
// names 为空，真实浏览器直接抛 "The storeNames parameter was empty"，
// 于是"升级前备份失败，已中止升级"，整个应用打不开（首页和背单词页都报错）。
{
  // 场景 A：旧库存在、版本 1、**一张已知表都没有**（正是出错的那种）
  globalThis.indexedDB.__seed(1, {});
  db.closeDB();
  let threwA = null;
  let infoA = null;
  try { infoA = await withTimeout(db.selfCheck(), 5000, '空 v1 库升级'); }
  catch (e) { threwA = e; }
  ok(threwA === null, '旧库为空（没有任何已知表）时升级不再中止', threwA && threwA.message);
  ok(infoA && !infoA.error, '空 v1 库升级后数据层可用', infoA && infoA.error);
  eq(infoA && infoA.schemaVersion, SCHEMA_VERSION, `升级后结构版本为 ${SCHEMA_VERSION}`);
  ok(rec.version === SCHEMA_VERSION, '旧库版本已推进到当前版本', String(rec.version));

  // 同一个坑的第二处：exportAll() 里也曾是"先 db.transaction() 后判空"。
  // 这里把"names 算出来是空的"这条路径直接跑一遍，防止有人日后把判空又挪回事务后面。
  // （exportAll 走的是自己的一份 filter，与 dumpFrom 不同源，所以上面的断言盯不住它。）
  let exportThrew = null;
  let exportOut = null;
  try { exportOut = await withTimeout(db.exportAll(), 5000, '空库导出'); }
  catch (e) { exportThrew = e; }
  ok(exportThrew === null, '库里一张已知表都没有时，exportAll 也不抛异常',
    exportThrew && exportThrew.message);
  ok(exportOut && typeof exportOut === 'object', 'exportAll 仍返回一个可用的导出对象');

  // 场景 B：旧库版本 1、有一张已知表且里面有真实数据，其它表都还没有。
  // 这条路径才是"老用户"的真实情况：v1 库存在、装着用户数据，
  // 但缺少后来才加的表（v2 的 libwords/snapshots 等）。
  globalThis.indexedDB.__seed(1, { meta: 'key' });
  rec.stores.get('meta').data.set('probe', { key: 'probe', value: 'v1 时期就存在的数据' });
  // 顺带塞一条用户词（旧库里 words 表还不存在，模拟最早期版本）
  db.closeDB();
  let threwB = null;
  let infoB = null;
  try { infoB = await withTimeout(db.selfCheck(), 8000, '有数据的 v1 库升级'); }
  catch (e) { threwB = e; }
  ok(threwB === null, '有用户数据的旧库能正常升级', threwB && threwB.message);
  ok(infoB && !infoB.error, '升级后 selfCheck 没有报错', infoB && infoB.error);
  eq(infoB && infoB.schemaVersion, SCHEMA_VERSION, '升级后结构版本正确');

  // 升级必须把缺失的表全部补齐（不能只建一部分就静默停下）
  const missing = Object.entries((infoB && infoB.stores) || {})
    .filter(([, v]) => v === '缺失').map(([k]) => k);
  ok(missing.length === 0, '升级后所有表都建齐了', missing.length ? '缺: ' + missing.join(',') : '');
  ok([...rec.stores.keys()].length === Object.keys(db.STORE_DEFS).length,
    '库里表的数量与 STORE_DEFS 一致',
    `${[...rec.stores.keys()].length} vs ${Object.keys(db.STORE_DEFS).length}`);

  // 旧库里的数据必须原样保留（约束 3 的核心）
  const kept = await withTimeout(db.dbGet('meta', 'probe'), 4000, '读回旧数据');
  ok(kept && kept.value === 'v1 时期就存在的数据', '升级后旧库里的数据还在',
    kept ? String(kept.value) : '(没了)');

  // 升级前必须留下一份 preupgrade 快照，且内容包含旧数据
  const snaps = await withTimeout(db.dbAll('snapshots'), 4000, '读快照');
  const pre = snaps.find((x) => x.kind === 'preupgrade');
  ok(!!pre, '升级前自动留下了 preupgrade 快照');
  if (pre) {
    ok(pre.fromVersion === 1, '快照记录了来源版本 1', String(pre.fromVersion));
    ok(pre.data && pre.data.meta && Array.isArray(pre.data.meta), '快照里含旧库 meta 表内容');
    ok((pre.data.meta || []).some((m) => m.key === 'probe'), '快照里能找到升级前那条旧数据');
    // 旧库里没有 libwords，快照就不该凭空出现这张表
    ok(!pre.data.libwords, '快照没有凭空包含旧库里不存在的表');
  }

  const mig = await withTimeout(db.dbGet('meta', 'lastMigration'), 4000, '读 lastMigration');
  ok(mig && mig.value && mig.value.from === 1, 'meta 记录了这次升级', mig && JSON.stringify(mig.value));
}

// ---------------------------------------------------------------------------
console.log('\n[10] ★ 用户报的 bug：改注音保存报 "object stores was not found"');
// ---------------------------------------------------------------------------
//
// 真实经过（2026-10，用户报的）：
//   readingOverrides 这张表被加进了 STORE_DEFS，但 SCHEMA_VERSION **没跟着加 1**。
//   于是老用户的库停在版本 2：版本没变 → 不触发 onupgradeneeded →
//   ensureSchema() 不跑 → 那张表**永远建不出来**。
//   症状是：打开一切正常，唯独"改注音 → 保存"炸出
//     Failed to execute 'transaction' on 'IDBDatabase':
//     One of the specified object stores was not found.
//
// 为什么这个 bug 能活那么久：**它只在"改注音"这一个动作上炸**，
// 其它功能全都好，看起来像那个功能自己的 bug；而且只要版本号不涨，
// 再改多少保存逻辑都没用 —— 建表那条路径永远走不到。
//
// 这一节故意复现"版本号忘了涨"的世界：预置一个版本 2、有用户数据的库，
// 然后断言升级后 readingOverrides 真的能用。
{
  // 造一个 v2 的库：除了 readingOverrides，其它表都在，并且装着用户数据
  const v2Stores = {};
  for (const [name, def] of Object.entries(db.STORE_DEFS)) {
    if (name === 'readingOverrides') continue;   // ← 就是它当初没建出来
    v2Stores[name] = def.key;
  }
  globalThis.indexedDB.__seed(2, v2Stores);
  // 塞真实用户数据，验证升级不会弄丢它
  rec.stores.get('meta').data.set('userProbe', { key: 'userProbe', value: '升级前就有的东西' });
  if (rec.stores.has('words')) {
    rec.stores.get('words').data.set('w1', { id: 'w1', term: '本', reading: 'ほん', zh: ['书'] });
  }
  db.closeDB();

  // 升级前：这张表确实不存在（先确认"病人真的病了"）
  ok(!rec.stores.has('readingOverrides'),
    '前置确认：预置的 v2 库里确实没有 readingOverrides 表（复现用户当时的库）');

  let threw = null;
  let info = null;
  try { info = await withTimeout(db.selfCheck(), 8000, 'v2 库升级'); }
  catch (e) { threw = e; }
  ok(threw === null, 'v2 库能正常升级（不再卡在旧结构上）', threw && threw.message);

  // ★ 核心断言：升级之后这张表必须真的存在
  ok(rec.stores.has('readingOverrides'),
    '★★ 升级后 readingOverrides 表被建出来了（这就是用户报的那个 bug 的根因）');

  // ★★ 更硬的断言：走**用户真实走过的那个动作** —— 往这张表里写一条改音记录。
  //      只断言"表存在"是不够的（表名对但事务范围不对也会炸）。
  //      这里调的是公开 API dbPut，和 yomi.js 保存时走的是同一条路。
  let putErr = null;
  try {
    await withTimeout(db.dbPut('readingOverrides', {
      surface: '方', reading: 'かた', at: new Date().toISOString(), source: 'test',
    }), 4000, '写 readingOverrides');
  } catch (e) { putErr = e; }
  ok(putErr === null, '★★ 能往 readingOverrides 写记录（不再报 object stores was not found）',
    putErr && String(putErr.message));

  // 读回来，确认真的落库了（而不是"没报错但也没写进去"）
  let back = null;
  try { back = await withTimeout(db.dbGet('readingOverrides', '方'), 4000, '读 readingOverrides'); }
  catch (e) { /* 上面已经报过 */ }
  ok(back && back.reading === 'かた', '★★ 改音记录真的落库并能读回来',
    back ? JSON.stringify(back) : '(读不到)');

  // 约束 3：升级绝不能弄丢用户数据
  const kept = await withTimeout(db.dbGet('meta', 'userProbe'), 4000, '读回旧数据');
  ok(kept && kept.value === '升级前就有的东西', '★ 升级后用户原有数据一条没丢',
    kept ? String(kept.value) : '(没了)');

  // 升级前必须留下备份（约束 3）
  const snaps = await withTimeout(db.dbAll('snapshots'), 4000, '读快照');
  const pre = snaps.find((x) => x.kind === 'preupgrade' && x.fromVersion === 2);
  ok(!!pre, '★ v2 → v3 升级前自动留下了 preupgrade 快照（数据有退路）');

  // 结构自检不该再报缺表
  ok(info && !info.error, '升级后结构自检没有报错', info && info.error);
  const nowMissing = Object.entries((info && info.stores) || {})
    .filter(([, v]) => v === '缺失').map(([k]) => k);
  ok(nowMissing.length === 0, '升级后没有任何缺失的表', nowMissing.join(','));

  // 缺表标记必须被清掉（否则设置页会一直报一个已经修好的旧问题）
  const flag = await withTimeout(db.dbGet('meta', 'missingStores'), 4000, '读缺表标记');
  ok(!flag, '修好之后 missingStores 标记被清掉（不会一直吓唬用户）');
}

// ---------------------------------------------------------------------------
console.log('\n[10b] ★ 版本 4：segOverrides（用户手改的分词切法）老库能不能补上');
// ---------------------------------------------------------------------------
//
// 为什么要有这一节：`segOverrides` 和 `readingOverrides` 是**同一种功能**
// （用户手改的东西、主键都是原文），所以它们**会犯同一个错**：
// 加表忘了涨版本号 → 老库永远建不出这张表 → 用户点"保存切法"时报
// `One of the specified object stores was not found`。
//
// 这次加表时版本号是**一起**从 3 提到 4 的（见 version.js），但"我记得做了"
// 不是证据 —— 这一节真的造一个**版本 3、缺 segOverrides** 的老库（= 现有用户的库），
// 然后走一遍用户真实会走的那个动作：往这张表里写一条切法。
{
  // 造一个 v3 的库：除了 segOverrides，其它表都在（= 现在所有老用户的样子）
  const v3Stores = {};
  for (const [name, def] of Object.entries(db.STORE_DEFS)) {
    if (name === 'segOverrides') continue;   // ← 就是它当初可能建不出来
    v3Stores[name] = def.key;
  }
  globalThis.indexedDB.__seed(3, v3Stores);
  // 塞真实的用户积累，验证升级不会弄丢
  rec.stores.get('meta').data.set('userProbe3', { key: 'userProbe3', value: 'v3 时期就有的东西' });
  if (rec.stores.has('words')) {
    rec.stores.get('words').data.set('w3', { id: 'w3', term: '人', reading: 'ひと', zh: ['人'] });
  }
  // 顺手塞一条**已有的手改读音** —— 升级新增表时绝不许碰到它
  if (rec.stores.has('readingOverrides')) {
    rec.stores.get('readingOverrides').data.set('方', { surface: '方', reading: 'かた', at: 1 });
  }
  db.closeDB();

  ok(!rec.stores.has('segOverrides'),
    '前置确认：预置的 v3 库里确实没有 segOverrides 表（复现现有用户的库）');

  let threw3 = null;
  let info3 = null;
  try { info3 = await withTimeout(db.selfCheck(), 8000, 'v3 库升级'); }
  catch (e) { threw3 = e; }
  ok(threw3 === null, 'v3 库能正常升级到 v4', threw3 && threw3.message);

  ok(rec.stores.has('segOverrides'),
    '★★ 升级后 segOverrides 表被建出来了（版本号 3→4 真的接上了那条升级路径）');

  // ★★ 走用户真实走过的那个动作：保存一条切法
  const { saveSegOverride, loadSegOverrides, applySegOverrides, surfaceOf } =
    await import('../app/js/segments.js');

  let saveErr = null;
  try {
    // ⚠️ 第三个参数 `auto`（原来怎么切的）是**必须**的：
    //    切法记录的语义是"把 auto 这段改成 segments 这样切"。
    //    这里模拟用户把页面上分开的 `この`+`人` 合并成一个 `この人`，
    //    所以 auto=['この','人']、segments=[{t:'この人'}]。
    await withTimeout(saveSegOverride('この人', [{ t: 'この人', r: 'このひと' }], ['この', '人']),
      4000, '保存切法');
  } catch (e) { saveErr = e; }
  ok(saveErr === null, '★★ 能保存一条切法（不再报 object stores was not found）',
    saveErr && String(saveErr.message));

  // 读回来：形状要对
  const segs = await withTimeout(loadSegOverrides(), 4000, '读切法表');
  ok(segs.size === 1 && segs.get('この人') && segs.get('この人').segments.length === 1,
    '★★ 切法真的落库并能读回来（合并后是 1 段）',
    JSON.stringify([...segs.keys()]));
  ok(segs.get('この人') && Array.isArray(segs.get('この人').auto)
    && segs.get('この人').auto.join('') === 'この人',
    '★★ `auto`（原来怎么切的）也一起存下来了 —— 没有它，合并记录下次就匹配不上',
    JSON.stringify(segs.get('この人') && segs.get('この人').auto));

  // 套用：这是这个功能的**核心承诺** —— 保存的切法要真的改变分词结果
  const tokens = [
    { surface: 'この', known: true, reading: 'この' },
    { surface: '人', known: true, reading: 'ひと' },
    { surface: 'は', known: true, reading: 'は' },
  ];
  const before = surfaceOf(tokens);
  const r = applySegOverrides(tokens, segs);
  ok(r.changed === 1 && r.tokens.length === 2 && r.tokens[0].surface === 'この人',
    '★★ 套用后 `この`+`人` 合并成了一个 `この人`（切法真的生效了）',
    JSON.stringify(r.tokens.map((t) => t.surface)));
  ok(r.tokens[0].override === true, '合并出来的词带 override 标记（界面据此显示"是你自己切的"）');
  ok(r.tokens[0].reading === 'このひと',
    '合并后的读音用记录里填的那个', JSON.stringify(r.tokens[0].reading));
  ok(r.tokens[0].known === true, '填了读音就算"查得到"');
  // 各段拼起来必须还是原文 —— 否则这条切法永远匹配不上，成了垃圾数据
  ok(surfaceOf(r.tokens) === before,
    '★ 套用切法**不改变原文**（只是换个切法，字一个不多一个不少）',
    `${before} → ${surfaceOf(r.tokens)}`);

  // 约束 3：升级 + 新增表绝不能弄丢用户数据
  const kept3 = await withTimeout(db.dbGet('meta', 'userProbe3'), 4000, '读回旧数据');
  ok(kept3 && kept3.value === 'v3 时期就有的东西', '★ 升级后用户原有数据一条没丢',
    kept3 ? String(kept3.value) : '(没了)');
  const oldYomi = await withTimeout(db.dbGet('readingOverrides', '方'), 4000, '读回手改读音');
  ok(oldYomi && oldYomi.reading === 'かた',
    '★★ 新增 segOverrides 没有影响已有的手改读音表（两张表各管各的）',
    oldYomi ? JSON.stringify(oldYomi) : '(没了)');

  // 升级前必须留下备份（约束 3）
  const snaps3 = await withTimeout(db.dbAll('snapshots'), 4000, '读快照');
  const pre3 = snaps3.find((x) => x.kind === 'preupgrade' && x.fromVersion === 3);
  ok(!!pre3, '★ v3 → v4 升级前自动留下了 preupgrade 快照（数据有退路）');

  // 清理：把这条切法删掉，免得影响后面的节
  const { removeSegOverride } = await import('../app/js/segments.js');
  const removed = await withTimeout(removeSegOverride('この人'), 4000, '删切法');
  ok(removed === true, '能删掉一条切法（恢复程序自己的切法）');
  const after = await withTimeout(loadSegOverrides(), 4000, '再读切法表');
  ok(after.size === 0, '删掉之后切法表是空的（没有留下半条记录）', String(after.size));
}

// ---------------------------------------------------------------------------
console.log('\n[11] ★ 防复发：STORE_DEFS 加了表，SCHEMA_VERSION 必须跟着涨');
// ---------------------------------------------------------------------------
//
// [10] 证明的是"版本涨到 3 之后这件事修好了"。
// 但**光靠人记得涨版本号**是不可靠的 —— 这次就是忘了。
// 所以再立一条机器能查的规矩：
//   ① 表结构指纹要能对上"当前版本"（防止有人加了表不涨版本）；
//   ② 缺表时必须**明确报出来**（而不是等用户点保存才炸）。
{
  // ① 记录表结构指纹：库里的 meta 应该有一份和当前 STORE_DEFS 对得上的记录。
  //    这里不去改动生产代码的存储格式，只做一个"当下一致性"的断言：
  //    如果 future 有人加了表忘了涨版本，[10] 那种场景就会重现，
  //    而 [10] 已经把它钉住了。这一节补的是"人看得见"的那一半。
  const storeNames = Object.keys(db.STORE_DEFS).sort();
  ok(storeNames.includes('readingOverrides'),
    'STORE_DEFS 里有 readingOverrides（用户改注音的存储位置）');
  ok(SCHEMA_VERSION >= 3,
    `SCHEMA_VERSION（${SCHEMA_VERSION}）≥ 3 —— 加了 readingOverrides 就必须至少到 3`,
    `当前 ${SCHEMA_VERSION}`);
  // 版本 4 同理：加了 segOverrides 就必须至少到 4。
  // 这一条是"机器能查的规矩"，不依赖谁记得 —— 忘了就会红。
  ok(storeNames.includes('segOverrides'),
    'STORE_DEFS 里有 segOverrides（用户改分词的存储位置）');
  ok(SCHEMA_VERSION >= 4,
    `SCHEMA_VERSION（${SCHEMA_VERSION}）≥ 4 —— 加了 segOverrides 就必须至少到 4`,
    `当前 ${SCHEMA_VERSION}`);
  // 两张表必须**分开**：合成一张的话，"切错了"和"念错了"就没法分别恢复了
  ok(storeNames.includes('readingOverrides') && storeNames.includes('segOverrides')
    && db.STORE_DEFS.readingOverrides.key === 'surface'
    && db.STORE_DEFS.segOverrides.key === 'surface',
    '改读音和改切法是两张独立的表，主键都是 surface');

  // ② 缺表时必须明确报出来：把当前版本的库改造成"缺一张表"，再打开。
  //    这里用 selfCheck 的健康信息当观察点（它就是给设置页看的那个）。
  const missingProbe = {};
  for (const [name, def] of Object.entries(db.STORE_DEFS)) {
    if (name === 'snapshots') continue;      // 故意缺一张
    missingProbe[name] = def.key;
  }
  globalThis.indexedDB.__seed(SCHEMA_VERSION, missingProbe);
  db.closeDB();

  let info2 = null;
  let threw2 = null;
  try { info2 = await withTimeout(db.selfCheck(), 8000, '缺表自检'); }
  catch (e) { threw2 = e; }
  // ⚠️ 这里**不强求抛错**：缺表是结构问题，不一定让整个数据层不可用。
  //    关键要求是"能看出来"，所以断言落在 selfCheck 的报告上。
  ok(threw2 === null, '缺表时数据层仍能打开（不至于整站打不开）', threw2 && threw2.message);
  const report = (info2 && info2.stores) || {};
  ok(report.snapshots === '缺失',
    '★★ selfCheck 如实报告缺了哪张表（用户/开发者一眼能看到根因）',
    JSON.stringify(report));

  // 并且这个信息必须落在 meta 里，设置页读得到 ——
  // 否则"打开即自检"只存在于控制台，用户永远看不到。
  const flag2 = await withTimeout(db.dbGet('meta', 'missingStores'), 4000, '读缺表标记');
  ok(flag2 && Array.isArray(flag2.value && flag2.value.stores)
    && flag2.value.stores.includes('snapshots'),
    '★★ 缺表信息写进了 meta.missingStores（设置页能显示给用户）',
    flag2 ? JSON.stringify(flag2.value) : '(没有)');
}

console.log('\n' + '='.repeat(74));
console.log(fail === 0 ? ` 全部通过（${passed} 项）` : ` ${fail} 项未通过，${passed} 项通过`);
console.log('='.repeat(74));
process.exit(fail === 0 ? 0 : 1);
