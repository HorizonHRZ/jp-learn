/**
 * test-airead.mjs —— 按段翻译与译文缓存的直接测试。
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么必须另起一个测试文件
 * ────────────────────────────────────────────────────────────────────
 * `test-render.mjs` 用的是假 DOM，它只能证明"页面渲染出来了"。
 * 而这次改造里最容易出错的两件事**都不是渲染问题**：
 *
 *   ① 译文缓存：写错的话用户每次打开笔记都会重翻一遍 —— 直接烧钱，
 *      而且界面上完全看不出来（译文照样显示，只是白花了钱）。
 *   ② 按段翻译：一段失败就中断、或者把整篇一次性发出去 —— 前者让人
 *      翻到一半停下，后者违反"不会一次把整本书全发出去"的承诺。
 *
 * 这两件事都藏在异步逻辑里，假 DOM 一点都测不到。
 *
 * ────────────────────────────────────────────────────────────────────
 * 这一轮**没用**的做法（记下来，下次别走）
 * ────────────────────────────────────────────────────────────────────
 * 第一版自己手写了一份假 IndexedDB。结果连吃三个"替身不合格"的亏，
 * 而且**报错全都指向别处**，看起来像 db.js 有 bug：
 *
 *   · 没实现 `ev.transaction` → db.js 的 ensureSchema 拿到 null →
 *     "Cannot read properties of null (reading 'objectStoreNames')"。
 *   · 忘了给 `store.indexNames` → "Cannot read properties of undefined
 *     (reading 'contains')"。
 *   · 赋值顺序和真浏览器不一致（`req.result` 写在 onupgradeneeded 之后）→
 *     db.js 拿到 undefined → "Cannot read properties of undefined"。
 *
 * 而 `tools/lib/fake-idb.mjs` 里这三条**全都已经踩过并写好了注释**。
 * 结论：**需要替身时先找项目里有没有现成的** —— 手写一份等于把别人
 * 踩过的坑重踩一遍，还多出一份会各自演化的实现。
 * 下面直接用 `installFakeIDB` 和 `installFakeDOM`。
 *
 * 用法：node tools/test-airead.mjs
 */
import { installFakeIDB } from './lib/fake-idb.mjs';
import { installFakeDOM } from './lib/fake-dom.mjs';
// 扫源码时**必须先剥注释和字符串** —— 否则注释里提到函数名就会被当成"真的调了"，
// 那种断言是假的（项目里踩过很多次，见 tools/lib/srcscan.mjs 顶部说明）。
import { codeLike, codeOnly } from './lib/srcscan.mjs';
import fs from 'node:fs';
// 隐私说明的**权威版本**（服务端那一份）。第 [10] 节要断言
// "取到的说明里确实写了自动翻译会发每段正文" —— 拿真数据断言才有意义，
// 随手编一句 ['a','b'] 只能证明"数组长度够"，什么都证明不了。
import { AI_PRIVACY_TEXT } from './aiconf.js';

let pass = 0;
let fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  — ' + extra : ''}`); }
}

// ---------------------------------------------------------------------------
// [0] 装好假 DOM 与假 IndexedDB（都是项目里现成的共用件）
// ---------------------------------------------------------------------------
const { docBody } = installFakeDOM();
const idb = installFakeIDB({});

/**
 * 往某张表里直接塞一条记录。
 *
 * ⚠️ 用 `store.data.set(key, value)` 而不是走 db.js 的 dbPut：
 *    那样能少测一层，但这里是**故意**的 —— 本文件测的是 airead 的缓存逻辑，
 *    不是 db.js 的写路径（那条路径 test-db.mjs 已经用 93 项断言覆盖了）。
 *    预置数据走最底层，是为了让"airead 读不读得到"这件事只受 airead 影响。
 */
function seed(storeName, key, value) {
  if (!idb.stores.has(storeName)) {
    idb.stores.set(storeName, { def: { key: 'id' }, data: new Map(), indexNames: new Set() });
  }
  idb.stores.get(storeName).data.set(key, value);
}
function peek(storeName, key) {
  const s = idb.stores.get(storeName);
  return s ? s.data.get(key) : undefined;
}

/**
 * 把"首次发送前的隐私确认"标成已确认。
 *
 * ⚠️ 为什么必须显式做这一步：`translateAll()` 第一次跑会
 *    `await ensureAck(confirmAiNotice)`，那会**弹一个真对话框等你点按钮**。
 *    在 Node 里没人点，于是这个 Promise 永不 resolve ——
 *    症状是"顶层 await 永挂"（`Detected unsettled top-level await`），
 *    而不是任何一条断言失败。**第一次遇到这种"测试静悄悄停住"，
 *    要先怀疑有个对话框在等人点，而不是怀疑业务逻辑写错了。**
 *
 * 这里不是"绕开"它 —— 第 [9] 节专门测了"没确认时会弹框、点了才继续"。
 */
async function ackAi() {
  const { setAck } = await import('../app/js/ai.js');
  await setAck(true);
}

// ---------------------------------------------------------------------------
// [0] 假 fetch：记录每次发给 AI 的请求，返回可控的回答
// ---------------------------------------------------------------------------
//
// `ai.js` 只依赖 `fetch`，所以换掉它就能在 Node 里把整条 AI 链路跑起来，
// 而且能**逐字检查发出去的到底是什么** —— 这正是隐私承诺需要被验证的地方。
const aiCalls = [];       // [{ path, body }]
let aiMode = 'ok';        // 'ok' | 'fail'
let aiReply = (text) => `【译】${text}`;

const realFetch = globalThis.fetch;
globalThis.fetch = async (path, opts = {}) => {
  const body = opts.body ? JSON.parse(opts.body) : null;
  aiCalls.push({ path, method: opts.method || 'GET', body });
  if (path === '/api/ai/config') {
    return {
      ok: true, status: 200,
      json: async () => ({
        ok: true,
        config: { enabled: true, baseURL: 'https://x/v1', model: 'm', keyHint: 'sk-••••' },
        privacy: AI_PRIVACY_TEXT,
      }),
    };
  }
  if (path === '/api/ai/chat') {
    if (aiMode === 'fail') {
      return { ok: true, status: 200, json: async () => ({ ok: false, error: '上游返回了 500', code: 'upstream' }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, text: aiReply(body.text) }) };
  }
  return { ok: false, status: 404, json: async () => ({ ok: false, error: 'not found' }) };
};

const airead = await import('../app/js/airead.js');
const chatCalls = () => aiCalls.filter((c) => c.path === '/api/ai/chat');

// ===========================================================================
console.log('\n[1] 翻译请求的形状：只有那一段正文被发出去');
{
  aiCalls.length = 0;
  const out = await airead.translateText('吾輩は猫である。');
  ok(out === '【译】吾輩は猫である。', '返回 AI 的译文');
  ok(chatCalls().length === 1, '只发了一次请求', `实际 ${chatCalls().length}`);
  ok(chatCalls()[0].body.task === 'translate', 'task 是 translate', String(chatCalls()[0].body.task));
  ok(chatCalls()[0].body.text === '吾輩は猫である。', '★ text 就是那一段正文，没有夹带别的东西');
  ok(chatCalls()[0].body.context === '', '★ 没有附带上下文（翻译是逐段的，不需要全文）');
  const keys = Object.keys(chatCalls()[0].body).sort().join(',');
  ok(keys === 'context,history,task,text', '★ 请求体只有这 4 个键，没有偷偷多带字段', keys);
}

// ===========================================================================
console.log('\n[2] 超长段落要拦住，而不是悄悄发一半');
{
  aiCalls.length = 0;
  const long = 'あ'.repeat(airead.MAX_TRANSLATE_CHARS + 1);
  let err = null;
  try { await airead.translateText(long); } catch (e) { err = e; }
  ok(!!err, '超长文本抛错而不是静默截断');
  ok(err && /拆成几段/.test(err.message), '错误信息告诉用户该怎么做', err && err.message);
  ok(chatCalls().length === 0, '★ 拦在前端，没发出去（没花用户的钱）');

  // 边界：正好等于上限应该放行
  aiCalls.length = 0;
  const exact = 'い'.repeat(airead.MAX_TRANSLATE_CHARS);
  const out2 = await airead.translateText(exact);
  ok(typeof out2 === 'string' && out2.length > 0, '正好等于上限时放行（边界包含）');
}

// ===========================================================================
console.log('\n[3] 译文缓存：读写都落在笔记记录自己的 aiCache 字段里');
{
  seed('readings', 'rd-1', { id: 'rd-1', title: '测试笔记', text: '猫である。', sourceType: 'paste' });

  const saved = await airead.saveAiCache('rd-1', 'readings', { translation: { 0: '是猫。' } });
  ok(saved === true, 'saveAiCache 返回 true', String(saved));
  const rec = peek('readings', 'rd-1');
  ok(rec.aiCache && rec.aiCache.translation['0'] === '是猫。', '译文写进了 aiCache.translation');
  ok(rec.text === '猫である。' && rec.title === '测试笔记',
    '★ 正文和标题没被覆盖（只改 aiCache 一个字段）');
  ok(typeof rec.aiCache.at === 'string' && rec.aiCache.at.length > 0, '记录了写入时间');

  // 再写一段：必须**合并**而不是替换（否则每翻一段就丢前面的）
  await airead.saveAiCache('rd-1', 'readings', { translation: { 1: '还没有名字。' } });
  const rec2 = peek('readings', 'rd-1');
  ok(rec2.aiCache.translation['0'] === '是猫。' && rec2.aiCache.translation['1'] === '还没有名字。',
    '★ 第二次写入是合并，没把第一段丢掉');

  const cache = await airead.loadAiCache('rd-1');
  ok(cache.translation['0'] === '是猫。' && cache.translation['1'] === '还没有名字。',
    'loadAiCache 能读回两段');

  // 不存在的记录不能炸。
  // ⚠️ 这里的行为**变过**，而且是有意的：以前返回 false 且**丢掉译文**，
  //    那正是用户遇到的"先翻译后保存，译文白翻了"的根因。
  //    现在改成返回 false（表示"还没落库"）但**把译文暂存到内存**，
  //    等用户第一次保存笔记时再落库。所以下面还断言"暂存里真的有东西"。
  const none = await airead.loadAiCache('不存在');
  ok(none && typeof none.translation === 'object' && Object.keys(none.translation).length === 0,
    '读不存在的记录返回空缓存（不抛错）');
  const bad = await airead.saveAiCache('不存在', 'readings', { translation: { 0: 'x' } });
  ok(bad === false, '写不存在的记录返回 false（表示"还没落库"，不抛错）');
  ok(airead.pendingCacheCount('不存在') === 1,
    '★ 但译文被暂存下来了（不是静默丢弃）', String(airead.pendingCacheCount('不存在')));
  const back = await airead.loadAiCache('不存在');
  ok(back.translation['0'] === 'x', '★ 暂存的译文在保存之前也读得到（用户不会以为翻译失败）');
}

// ===========================================================================
console.log('\n[3b] ★ 先翻译、后保存：译文不能丢（这是用户实际报的 bug）');
{
  // 用户报的原话：「保存歌词笔记之后，我发现之前让 ai 翻译的内容消失了，
  // 还得再重新翻译浪费 token」。
  // 两个原因，这一段一起盯住：
  //   ① saveNote 新建了一个干净记录对象、整条覆盖写回，字段里没有 aiCache
  //      → 已经落库的译文被冲掉；
  //   ② 还没保存笔记时（recordId 是 null）译文只活在内存里，从来没落库。
  // 所以这里模拟**真实的先后顺序**：先翻译（记录还不存在）→ 再保存 → 再看。
  const run = airead.__testHooks;
  ok(!!run && typeof run.simulateSaveNote === 'function',
    '测试钩子可用（模拟"翻译→保存笔记"这条真实顺序）');

  if (run) {
    // 场景一：先翻译、后首次保存
    const r1 = await run.simulateSaveNote({
      store: 'lyrics', id: 'lyric:test-1', text: '猫である。', title: '测试歌词',
      translate: { 0: '是猫。', 1: '还没有名字。' },
    });
    ok(r1.staged === 2, '翻译时笔记还不存在 → 2 段进入暂存', String(r1.staged));
    ok(r1.flushed === 2, '★ 保存笔记时把那 2 段落库了', String(r1.flushed));
    const rec1 = peek('lyrics', 'lyric:test-1');
    ok(!!rec1, '笔记存下来了');
    ok(rec1 && rec1.aiCache && rec1.aiCache.translation['0'] === '是猫。'
      && rec1.aiCache.translation['1'] === '还没有名字。',
      '★★ 保存之后译文还在（这就是用户报的那个 bug）',
      rec1 && rec1.aiCache ? JSON.stringify(rec1.aiCache.translation) : 'aiCache 不存在');
    ok(rec1 && rec1.text === '猫である。' && rec1.title === '测试歌词',
      '正文和标题也没被写坏');

    // 场景二：笔记已存在，翻译 → 再点一次保存（覆盖写）
    // 这一条专门盯"整条覆盖把 aiCache 冲掉"——即使不经过暂存也会中招。
    const r2 = await run.simulateSaveNote({
      store: 'lyrics', id: 'lyric:test-1', text: '猫である。改', title: '测试歌词',
      translate: null, existing: true,
    });
    const rec2 = peek('lyrics', 'lyric:test-1');
    ok(rec2 && rec2.text === '猫である。改', '第二次保存覆盖了正文');
    ok(rec2 && rec2.aiCache && rec2.aiCache.translation['0'] === '是猫。',
      '★★ 覆盖写回时 aiCache 被带过来了（saveNote 里 carryAiCache 的作用）',
      rec2 && rec2.aiCache ? JSON.stringify(rec2.aiCache.translation) : 'aiCache 被冲掉了');

    // 场景三：刷新/重开笔记 —— 必须**一个请求都不发**就能拿到译文
    const r3 = await run.simulateReopen({ store: 'lyrics', id: 'lyric:test-1' });
    ok(r3.translation['0'] === '是猫。' && r3.translation['1'] === '还没有名字。',
      '★★ 重开笔记时译文直接从缓存读出来');
    ok(r3.aiCalls === 0,
      '★★ 而且**没有再请求 AI**（不重复花 token）—— 这是用户最在意的一点',
      '实际请求 ' + r3.aiCalls + ' 次');

    run.reset();
  }
}

// ===========================================================================
console.log('\n[3c] ★ 接线检查：两个视图真的调了那两个护栏吗');
{
  // 为什么必须有这一段（而不是只靠上面 [3b] 的行为测试）：
  //   [3b] 测的是 airead.js 里的共享逻辑。但**真正被用户点的是视图里的
  //   saveNote()** —— 如果哪天有人把那两行 `carryAiCache` / `flushPendingCache`
  //   删掉，[3b] 照样全绿，bug 却回来了。
  //   这就是这次出问题的形状：**函数各自都对，接线断了。**
  //   所以再加一层"源码接线"断言。两层一起：一层测逻辑，一层测接线。
  for (const f of ['app/js/views/lyric.js', 'app/js/views/reading.js']) {
    const src = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    const code = codeLike(src);
    ok(/carryAiCache\s*\(/.test(code),
      `★ ${f} 的 saveNote 调了 carryAiCache（否则整条覆盖会冲掉译文）`);
    ok(/flushPendingCache\s*\(/.test(code),
      `★ ${f} 的 saveNote 调了 flushPendingCache（否则"先翻译后保存"那批会丢）`);
    // 顺序也很重要：必须先落正文、再落暂存译文（暂存要往已存在的记录里写）。
    // ⚠️ 这里**不能用 codeLike**：它会把字符串字面量抹成空串，
    //    于是 dbPut('lyrics', …) 变成 dbPut('', …)，
    //    再拿 "dbPut('lyrics'" 去找就永远找不到 —— 断言会因为
    //    "我把要找的东西自己抹掉了"而变红。这又是"断言写错、不是代码错"。
    //    所以这一条用 codeOnly（留字符串、只剥注释）。
    const codeKeepStr = codeOnly(src);
    const iPut = codeKeepStr.indexOf("dbPut('" + (f.includes('lyric') ? 'lyrics' : 'readings') + "'");
    const iFlush = codeKeepStr.indexOf('flushPendingCache(');
    ok(iPut >= 0 && iFlush >= 0 && iPut < iFlush,
      `★ ${f} 里是先存正文、再落暂存译文（顺序反了暂存会写不进去）`,
      `dbPut 位置=${iPut}，flush 位置=${iFlush}`);
    // 阅读器要能提示"还没存进笔记"，并给一键保存的入口
    ok(/onSaveNote/.test(code),
      `★ ${f} 把 onSaveNote 传给了阅读器（用户要看得见"译文还没进笔记"）`);
  }
}

// ===========================================================================
console.log('\n[9] 第一次点「自动翻译」会弹确认框，点了才真的发出去');
{
  // 这一节必须放在最前面：它需要"还没确认过"的干净状态，
  // 而下面的 ackAi() 会把确认标记写进 settings 表（写进去就回不来了）。
  const ai = await import('../app/js/ai.js');
  const { confirmAiNotice } = await import('../app/js/views/aipanel.js');
  ok(typeof confirmAiNotice === 'function', 'aipanel.js 导出了 confirmAiNotice');

  ok((await ai.getAck()) === false, '初始状态是"没确认过"');

  seed('readings', 'rd-first', { id: 'rd-first', text: '', title: '' });
  aiCalls.length = 0;
  aiMode = 'ok';
  aiReply = (t) => `首译(${t})`;

  const reader = await airead.buildAiReader({
    lines: [{ ja: '第一次。' }],
    recordId: () => 'rd-first',
    store: 'readings',
    prefs: { ruby: false, romaji: false },
  });

  const pending = reader.translateAll();          // 故意不 await：它现在应该卡在对话框上
  await new Promise((r) => setTimeout(r, 30));    // 让对话框有机会建出来

  ok(chatCalls().length === 0, '★ 还没点确认时，一个请求都没发出去');
  const backdrop = docBody.querySelector('.modal-backdrop') || docBody.querySelector('.modal');
  ok(!!backdrop, '弹出了确认对话框');

  // 点「我知道了，继续」
  const btn = backdrop && backdrop.querySelectorAll('button').find((b) => /继续|我知道了/.test(b.textContent));
  ok(!!btn, '对话框里有"我知道了，继续"按钮');
  if (btn) btn.click();

  const r = await pending;
  ok(r.done === 1, '★ 点过确认之后才真的翻了这一段', JSON.stringify(r));
  ok(chatCalls().length === 1, '确认后发了 1 次请求');
  ok((await ai.getAck()) === true, '确认标记被记下来了（以后不再弹）');
}

// ===========================================================================
console.log('\n[10] 确认框里显示的隐私说明，和服务端下发的是同一份');
{
  const ai = await import('../app/js/ai.js');
  aiCalls.length = 0;
  const text = await ai.getPrivacyText();
  ok(Array.isArray(text) && text.length >= 3, '取到了隐私说明', JSON.stringify(text).slice(0, 80));
  ok(chatCalls().length === 0, '取隐私说明不会发出对话请求');
  ok(text.some((s) => /自动翻译/.test(s)), '★ 说明里提到了"自动翻译会发每段正文"');
  ok(!text.some((s) => /只有你选中/.test(s)), '★ 说明里已经没有"只有你选中的"这种矛盾说法');
}

// ===========================================================================
await ackAi();
console.log('\n[4] ★★ 最关键的回归：建阅读器时还没有笔记 id（真实顺序就是如此）');
{
  // 真实的使用顺序是"先精读 → 点存为笔记 → 才有 id"。
  // 所以 buildAiReader 被调用时 id 往往是 null，那一刻**读不到任何缓存**。
  // 这里要证明的是：等 id 到手之后，`translateAll()` 会**重新读一次数据库**，
  // 从而不会把数据库里已经有的译文再翻一遍 —— 那等于让用户付两次钱。
  //
  // ⚠️ 第一版这条断言写错了，值得记下来：
  //    我断言"有了 id 之后再点一次，两段译文会被补写进缓存"。
  //    但"跳过"是**正确行为**：内存里已经有译文了，没有理由再发请求，
  //    也就没有东西可写。断言写成了"要求一个不该发生的行为"。
  //    判断标准应该是**请求次数**（花没花钱），不是缓存里有没有多一条。
  // 数据库里已经有第 0 段的译文（模拟"上次翻过、这次重新打开"）。
  // ⚠️ 只 seed 一次 —— 第一版连写了两次 seed，第二次把第一次的 aiCache
  //    整个覆盖掉了，于是"缓存里早就有译文"这个前提根本不存在。
  //    用同一张表的数据时，**后一次写会盖掉前一次**，别把两次写当成叠加。
  seed('readings', 'rd-late', {
    id: 'rd-late', text: '', title: '',
    aiCache: { translation: { 0: '数据库里早就有的译文' }, at: '2026-01-01T00:00:00.000Z' },
  });

  let currentId = null;          // 模拟"还没存笔记"
  aiCalls.length = 0;
  aiMode = 'ok';
  aiReply = (t) => `新译(${t})`;

  const reader = await airead.buildAiReader({
    lines: [{ ja: '第一段。' }, { ja: '第二段。' }],
    recordId: () => currentId,   // ✓ 传函数：每次用的时候现取
    store: 'readings',
    prefs: { ruby: false, romaji: false },
  });
  ok(!!reader.node, '阅读器建出来了');
  ok(!reader.hasTranslation(0), '建的时候 id 还是 null，所以读不到第 0 段的缓存（符合预期）');

  const r1 = await reader.translateAll();
  ok(chatCalls().length === 2, 'id 还是 null 时两段都发了（分别计费）', `实际 ${chatCalls().length}`);

  // 用户存了笔记（拿到 id），再点一次
  currentId = 'rd-late';
  aiCalls.length = 0;
  const r2 = await reader.translateAll();
  ok(chatCalls().length === 0,
    '★ id 到手后再点一次，一个请求都没发（内存里已经有了，不会重复花钱）');
  ok(r2.skipped === 2, '两段都被跳过', JSON.stringify(r2));
  ok(reader.translationOf(0) === '新译(第一段。)',
    '★ 用户填/已翻的译文没有被数据库里那条旧的覆盖');

  // 再验一次"重新读数据库"这件事本身：
  // 这次让内存里**没有**译文，但数据库里有 —— 必须有且只有一个请求。
  seed('readings', 'rd-cached', {
    id: 'rd-cached', text: '', title: '',
    aiCache: { translation: { 0: '缓存里的甲', 1: '缓存里的乙' }, at: '2026-01-01T00:00:00.000Z' },
  });
  let id2 = null;
  const reader2 = await airead.buildAiReader({
    lines: [{ ja: '甲。' }, { ja: '乙。' }],
    recordId: () => id2,
    store: 'readings',
    prefs: { ruby: false, romaji: false },
  });
  id2 = 'rd-cached';
  aiCalls.length = 0;
  const r3 = await reader2.translateAll();
  ok(chatCalls().length === 0,
    '★ 内存里空着、数据库里有：靠 reloadCache 认出来，一个请求都不发');
  ok(r3.skipped === 2, '报告跳过 2 段', JSON.stringify(r3));
  ok(reader2.translationOf(0) === '缓存里的甲' && reader2.translationOf(1) === '缓存里的乙',
    '两段都从数据库里取到了译文');

  // 反面：如果 recordId 传的是**值**（旧写法），就永远读不到 —— 证明上面不是空跑
  seed('readings', 'rd-snapshot', { id: 'rd-snapshot', text: '', title: '' });
  const reader3 = await airead.buildAiReader({
    lines: [{ ja: '甲。' }],
    recordId: null,              // ✗ 传值（模拟旧写法）
    store: 'readings',
    prefs: { ruby: false, romaji: false },
  });
  await reader3.translateAll();
  ok(!peek('readings', 'rd-snapshot').aiCache,
    '★ 传 null 时确实什么都不缓存 —— 所以这一节不是空跑');
}

// ===========================================================================
await ackAi();
console.log('\n[5] 按段翻译：逐段发、逐段存、一段失败不中断其它段');
{
  seed('readings', 'rd-batch', { id: 'rd-batch', text: '', title: '' });
  aiCalls.length = 0;
  aiMode = 'ok';
  let n = 0;
  aiReply = (t) => { n++; return `译文${n}(${t})`; };

  const reader = await airead.buildAiReader({
    lines: [{ ja: '一。' }, { ja: '二。' }, { ja: '三。' }],
    recordId: () => 'rd-batch',
    store: 'readings',
    prefs: { ruby: false, romaji: false },
  });
  const r = await reader.translateAll();
  ok(r.done === 3 && r.failed === 0, '三段全部成功', JSON.stringify(r));
  ok(chatCalls().length === 3, '★ 发了 3 次请求（逐段发），不是 1 次发全部', `实际 ${chatCalls().length}`);
  ok(reader.hasTranslation(0) && reader.hasTranslation(2), '三段都有译文');

  // 再点一次：已有译文的段必须跳过，不能再花钱
  aiCalls.length = 0;
  const r2 = await reader.translateAll();
  ok(chatCalls().length === 0, '★ 再点一次不重复发请求（不重复花钱）');
  ok(r2.skipped === 3, '报告跳过了 3 段', JSON.stringify(r2));

  // 一段失败不能中断其它段。
  //
  // ⚠️ 让"第 2 段失败"要写在 **fetch 那一层**，不能写在 aiReply 里。
  //    第一版把 `aiMode = calls === 2 ? 'fail' : 'ok'` 放进了 aiReply，
  //    但 aiReply 是**拿到成功回答之后**才被调用的 ——
  //    于是那个 'fail' 要到**第 3 段**才生效，失败的是第 3 段。
  //    断言说"失败的是第 2 段"就红了，而程序其实完全正确。
  //    教训：**要在哪一层制造故障，就得在哪一层拦。**
  seed('readings', 'rd-fail', { id: 'rd-fail', text: '', title: '' });
  aiCalls.length = 0;
  aiMode = 'ok';
  let served = 0;
  const tab = globalThis.fetch;
  globalThis.fetch = async (path, opts = {}) => {
    if (path === '/api/ai/chat') {
      served++;
      if (served === 2) {
        aiCalls.push({ path, method: opts.method || 'GET', body: JSON.parse(opts.body) });
        return { ok: true, status: 200, json: async () => ({ ok: false, error: '上游返回了 500', code: 'upstream' }) };
      }
    }
    return tab(path, opts);
  };
  const reader3 = await airead.buildAiReader({
    lines: [{ ja: '甲。' }, { ja: '乙。' }, { ja: '丙。' }],
    recordId: () => 'rd-fail',
    store: 'readings',
    prefs: { ruby: false, romaji: false },
  });
  const r3 = await reader3.translateAll();
  globalThis.fetch = tab;
  ok(served === 3, '三段都尝试了（没有在第 2 段就停）', `实际请求 ${served} 次`);
  ok(r3.done === 2 && r3.failed === 1, '★ 中间那段失败，前后两段仍然成功', JSON.stringify(r3));
  ok(reader3.hasTranslation(0) && !reader3.hasTranslation(1) && reader3.hasTranslation(2),
    '失败的是第 2 段，第 1、3 段有译文');
  const recF = peek('readings', 'rd-fail');
  ok(recF.aiCache.translation['0'] && recF.aiCache.translation['2'] && !recF.aiCache.translation['1'],
    '成功的段落存进了缓存，失败的没有（留着重试）');
}

// ===========================================================================
await ackAi();
console.log('\n[6] ★ 用户自己填的译文：AI 不许覆盖，也不许翻译');
{
  seed('readings', 'rd-user', { id: 'rd-user', text: '', title: '' });
  aiCalls.length = 0;
  aiMode = 'ok';
  aiReply = (t) => `AI(${t})`;

  const reader = await airead.buildAiReader({
    lines: [{ ja: '自己填过的。' }, { ja: '没填过的。' }],
    preTranslations: { 0: '这是我自己的译文，不许改' },
    recordId: () => 'rd-user',
    store: 'readings',
    prefs: { ruby: false, romaji: false },
  });
  ok(reader.translationOf(0) === '这是我自己的译文，不许改', '用户填的译文优先生效');
  ok(reader.hasTranslation(0) === true, '用户填的也算"有译文"');

  const r = await reader.translateAll();
  const bodies = chatCalls().map((c) => c.body.text);
  ok(bodies.length === 1 && bodies[0] === '没填过的。',
    '★ 只翻了没填的那一段，用户填的那段根本没发出去', JSON.stringify(bodies));
  ok(reader.translationOf(0) === '这是我自己的译文，不许改',
    '★ 翻完之后用户填的译文仍然是原样（没有被 AI 覆盖）');
  ok(reader.translationOf(1) === 'AI(没填过的。)', '没填的那段填上了 AI 译文');
  ok(r.done === 1, '报告只翻了 1 段', JSON.stringify(r));
}

// ===========================================================================
console.log('\n[7] AI 关闭时不发请求，而且给出说明');
{
  globalThis.fetch = async (path) => {
    if (path === '/api/ai/config') {
      return { ok: true, status: 200, json: async () => ({ ok: true, config: { enabled: false }, privacy: [] }) };
    }
    aiCalls.push({ path, body: null });
    return { ok: true, status: 200, json: async () => ({ ok: true, text: 'x' }) };
  };
  seed('readings', 'rd-off', { id: 'rd-off', text: '', title: '' });
  aiCalls.length = 0;

  const reader = await airead.buildAiReader({
    lines: [{ ja: '关着的时候。' }],
    recordId: () => 'rd-off',
    store: 'readings',
    prefs: { ruby: false, romaji: false },
  });
  const r = await reader.translateAll();
  ok(chatCalls().length === 0, '★ AI 关闭时一个请求都不发');
  ok(r.done === 0, '报告 0 段完成', JSON.stringify(r));
  const banner = await airead.aiStatusBanner();
  ok(!!banner, 'AI 关闭时返回一条长期可见的说明条');
  globalThis.fetch = realFetch;
}

// ===========================================================================
console.log('\n[8] 不变量：不挂全局监听、不绕开 askAi、不自带密钥');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const ROOT = path.resolve(import.meta.dirname, '..');
  const src = fs.readFileSync(path.join(ROOT, 'app/js/airead.js'), 'utf8');
  // 先摘注释再断言 —— 否则注释里提到的 `document.addEventListener` 会命中自己。
  // 这个坑本项目踩过多次，所以每次做源码断言都先摘注释。
  const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
  ok(!/document\.addEventListener/.test(code), 'airead.js 不挂 document 级监听');
  ok(!/window\.addEventListener/.test(code), 'airead.js 不挂 window 级监听');
  ok(!/\bfetch\s*\(/.test(code), '★ airead.js 自己不发 fetch（一律走 ai.js 的 askAi）');
  ok(/askAi\(/.test(code), 'airead.js 通过 askAi 发送');
  ok(!/sk-[A-Za-z0-9]{12,}/.test(code), 'airead.js 里没有任何形似密钥的字符串');
}

console.log('\n' + '='.repeat(74));
console.log(fail === 0 ? ` 全部通过（${pass} 项）` : ` ${fail} 项未通过（通过 ${pass} 项）`);
console.log('='.repeat(74));
process.exit(fail === 0 ? 0 : 1);
