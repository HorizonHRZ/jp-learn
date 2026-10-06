/**
 * test-draft.mjs —— 草稿保护（未保存的正文不丢）
 *
 * ──────────────────────────────────────────────────────────────────────
 * 这个测试想证明什么
 * ──────────────────────────────────────────────────────────────────────
 * 用户报的 bug 是"翻译完一保存，译文没了"。修它的时候发现同一类风险还有
 * 一个没盖住：**粘了正文、切到别的页再回来，正文本身就没了**（只活在 textarea）。
 * 这一份测试盯的就是这条。
 *
 * ──────────────────────────────────────────────────────────────────────
 * 为什么分两层写
 * ──────────────────────────────────────────────────────────────────────
 *   第一层：草稿模块自己的行为（存、读、清、过期、坏数据、存储不可用）
 *   第二层：**接线** —— 两个视图真的装了吗？destroy() 真的收尾了吗？
 *          没保存成功之后真的把草稿清掉了吗？
 *
 * 只测第一层是不够的：模块写得再对，视图里没调它就等于没有这个功能。
 * 以前"AI 译文会丢"的 bug 正是这个形状 —— **函数各自都对，接线断了。**
 *
 * 用法：node tools/test-draft.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeDOM } from './lib/fake-dom.mjs';
import { codeLike } from './lib/srcscan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

installFakeDOM();

let pass = 0;
let fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  — ' + extra : ''}`); }
}

// draft.js 的 `el()` 来自 ui.js，需要 document —— fake DOM 已经装好了。
const D = await import('../app/js/draft.js');

// ===========================================================================
console.log('\n[1] 存 / 读 / 清：来回一趟不丢东西');
{
  localStorage.clear();
  const saved = D.saveDraft('lyric', { text: '猫である。\n名前はまだ無い。', translation: '是猫。' });
  ok(saved === true, 'saveDraft 返回 true');
  const back = D.loadDraft('lyric');
  ok(!!back, 'loadDraft 读得回来');
  ok(back && back.text === '猫である。\n名前はまだ無い。', '正文一字不差（含换行）', back && JSON.stringify(back.text));
  ok(back && back.translation === '是猫。', '中文对照也存下来了');
  ok(back && typeof back.at === 'string' && back.at.length > 0, '记了时间（界面要显示"什么时候的草稿"）');

  D.clearDraft('lyric');
  ok(D.loadDraft('lyric') === null, 'clearDraft 之后读不到');

  // 两个视图的草稿不能串
  D.saveDraft('lyric', { text: '歌词内容' });
  D.saveDraft('reading', { text: '精读内容' });
  ok(D.loadDraft('lyric').text === '歌词内容', '歌词草稿读的是歌词那份');
  ok(D.loadDraft('reading').text === '精读内容', '精读草稿读的是精读那份（两边不串）');
  localStorage.clear();
}

// ===========================================================================
console.log('\n[2] 空内容不覆盖已有草稿（误删也要能救回来）');
{
  localStorage.clear();
  D.saveDraft('lyric', { text: '重要内容' });
  const r = D.saveDraft('lyric', { text: '', translation: '' });
  ok(r === false, '空内容保存返回 false（不写入）');
  ok(D.loadDraft('lyric').text === '重要内容', '★ 已有草稿没被空内容盖掉');
  localStorage.clear();
}

// ===========================================================================
console.log('\n[3] 坏数据 / 过期的草稿一律当成"没有"');
{
  localStorage.clear();
  localStorage.setItem(D.draftKey('lyric'), '{这不是合法 JSON');
  ok(D.loadDraft('lyric') === null, 'JSON 坏了返回 null（不抛错）');

  localStorage.setItem(D.draftKey('lyric'), JSON.stringify({ text: 123 }));
  ok(D.loadDraft('lyric') === null, 'text 不是字符串返回 null');

  const old = new Date(Date.now() - (D.DRAFT_TTL_MS + 86400000)).toISOString();
  localStorage.setItem(D.draftKey('lyric'), JSON.stringify({ text: '很久以前的内容', at: old }));
  ok(D.loadDraft('lyric') === null, '★ 超过 30 天的草稿不再提示恢复（不翻出上个月的东西）');

  const fresh = new Date().toISOString();
  localStorage.setItem(D.draftKey('lyric'), JSON.stringify({ text: '新内容', at: fresh }));
  ok(D.loadDraft('lyric') !== null, '没过期的草稿照样能读');
  localStorage.clear();
}

// ===========================================================================
console.log('\n[4] localStorage 不可用时（隐私模式）不能把页面弄挂');
{
  const realSet = localStorage.setItem;
  const realGet = localStorage.getItem;
  localStorage.setItem = () => { throw new Error('QuotaExceededError 之类'); };
  let threw = '';
  let r = null;
  try { r = D.saveDraft('lyric', { text: 'x' }); } catch (e) { threw = e.message; }
  ok(!threw && r === false, '★ 写入抛错时 saveDraft 安静返回 false，不把异常抛给调用方', threw);

  localStorage.getItem = () => { throw new Error('SecurityError'); };
  threw = '';
  let v = 'x';
  try { v = D.loadDraft('lyric'); } catch (e) { threw = e.message; }
  ok(!threw && v === null, '★ 读取抛错时 loadDraft 返回 null，不抛', threw);

  localStorage.setItem = realSet;
  localStorage.getItem = realGet;
  localStorage.clear();
}

// ===========================================================================
console.log('\n[5] 自动保存：真的会写，而且 stop() 之后真的会停');
{
  // 用真实的定时器（间隔调很小），这样测的是真行为而不是"我以为它调了 setInterval"。
  localStorage.clear();
  const data = { text: '第一版' };
  const h = D.installDraftAutosave({
    viewId: 'lyric', getData: () => data, intervalMs: 20,
  });
  data.text = '第二版';
  await new Promise((r) => setTimeout(r, 90));
  const got = D.loadDraft('lyric');
  ok(got && got.text === '第二版', '★ 定时那一路真的把草稿写进去了', got && got.text);

  h.flush();
  ok(D.loadDraft('lyric').text === '第二版', 'flush() 立刻写一次');

  h.stop();
  data.text = '停了之后不该再写';
  await new Promise((r) => setTimeout(r, 80));
  ok(D.loadDraft('lyric').text === '第二版', '★ stop() 之后定时器真的停了（不会一直写、不会泄漏）');

  // touch（防抖那一路）
  localStorage.clear();
  const h2 = D.installDraftAutosave({ viewId: 'lyric', getData: () => ({ text: '打字中' }), intervalMs: 100000 });
  h2.touch();
  await new Promise((r) => setTimeout(r, 1400));
  ok(D.loadDraft('lyric') && D.loadDraft('lyric').text === '打字中', '★ 输入停下来之后（防抖）也会写草稿');
  h2.stop();
  localStorage.clear();
}

// ===========================================================================
console.log('\n[6] 提示条：长得出来，而且有明确的"恢复 / 不要了"两个出口');
{
  localStorage.clear();
  const draft = { text: '猫である。', translation: '', at: new Date().toISOString() };
  let restored = null;
  let discarded = false;
  const banner = D.buildDraftBanner({
    draft,
    onRestore: (d) => { restored = d; },
    onDiscard: () => { discarded = true; },
  });
  const text = banner._walk([]).map((n) => n.textContent).join(' ');
  ok(banner.classList.contains('banner') && banner.classList.contains('banner-warn'),
    '提示条是 warn 样式（这是"会丢东西"的警告，不是普通说明）');
  ok(/草稿/.test(text), '文案里说明了这是草稿', text.slice(0, 60));

  const btns = banner._walk([]).filter((n) => n.tagName === 'BUTTON');
  ok(btns.length === 2, '有恢复和放弃两个按钮', String(btns.length));
  const restoreBtn = btns.find((b) => /恢复/.test(b.textContent));
  const discardBtn = btns.find((b) => /不要/.test(b.textContent));
  ok(!!restoreBtn && !!discardBtn, '两个按钮的文字能认出来');
  if (restoreBtn) { restoreBtn.click(); ok(restored && restored.text === '猫である。', '点「恢复草稿」把内容交回给回调'); }
  if (discardBtn) { discardBtn.click(); ok(discarded === true, '点「不要了」通知回调'); }
}

// ===========================================================================
console.log('\n[7] ★ 接线：两个视图真的装了草稿保护，而且收尾了');
{
  // 这一层是必须的。模块再对，视图没接上就等于没这个功能 ——
  // "AI 译文会丢"那个 bug 就是这个形状（函数都对、接线断了）。
  for (const f of ['app/js/views/lyric.js', 'app/js/views/reading.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const code = codeLike(src);
    ok(/installDraftAutosave\s*\(/.test(code), `★ ${f} 装了自动草稿`);
    ok(/loadDraft\s*\(/.test(code), `★ ${f} 进页面时会查有没有草稿`);
    ok(/buildDraftBanner\s*\(/.test(code), `★ ${f} 会提示"发现草稿"`);
    ok(/clearDraft\s*\(/.test(code), `★ ${f} 在保存笔记/清空之后会清掉草稿`);
    // 定时器必须收尾，否则离开页面之后还在跑
    ok(/destroy\s*\(\s*\)\s*\{/.test(code), `★ ${f} 实现了 destroy()`);
    ok(/autosaveHandle[\s\S]{0,80}\.stop\s*\(/.test(code),
      `★ ${f} 的 destroy 里停掉了自动保存的定时器`);
    // 输入事件那一路也要接上
    ok(/\.touch\b/.test(code), `★ ${f} 把输入事件接到了草稿防抖那一路`);
  }
}

// ===========================================================================
console.log('\n[8] 草稿必须是"本机临时"的：不许进导出、不许进快照');
{
  // 把草稿放进 localStorage 是一个刻意的取舍（见 draft.js 顶部）。
  // 这条断言把取舍变成可检查的事实：草稿不参与用户数据的导出/快照，
  // 所以永远不会踩"升级不许迁移用户数据"那条硬约束。
  const exportSrc = fs.readFileSync(path.join(ROOT, 'app/js/views/settings.js'), 'utf8');
  ok(!/draft/i.test(codeLike(exportSrc)),
    '导出/设置页完全不碰草稿（草稿不是用户数据资产）');
  const draftSrc = fs.readFileSync(path.join(ROOT, 'app/js/draft.js'), 'utf8');
  ok(/localStorage/.test(codeLike(draftSrc)), '草稿存在 localStorage');
  ok(!/indexedDB|dbPut/.test(codeLike(draftSrc)), '★ 草稿不写 IndexedDB（不碰用户数据模型）');
}

// ===========================================================================
console.log('\n[9] ★ 用户报的 bug：已保存的笔记被误判成"没保存的草稿"');
// ===========================================================================
//
// 用户原话：「已经保存过的歌词笔记，重新进入歌词页时会误判为未保存的草稿，
//            每次返回都弹窗提示。」
//
// 根因是一条**看不见的自动路径**（不是用户操作）：
//   ① openNote() 把笔记正文填进输入框；
//   ② 自动保存每 5 秒无条件把 textarea 写一遍草稿 —— 它分不清
//      "用户刚打的字"和"刚从已保存笔记里读出来的字"；
//   ③ 于是 saveNote()/openNote() 那一刻虽然清过草稿，5 秒后草稿又被重建；
//   ④ 下次进页面 → loadDraft() 发现有草稿 → 弹提示，**每次都弹**。
//
// 修法是引入"基准"概念 + draftMatches()/draftAlreadySaved() 两个判断。
// 这一节就是盯这两个判断。
{
  localStorage.clear();

  // ---- 9.1 draftMatches：内容等价就算"同一个东西" ----
  {
    const draft = { text: '猫である。', translation: '我是猫。' };
    ok(D.draftMatches(draft, { text: '猫である。', translation: '我是猫。' }) === true,
      '★ 内容一模一样 → 判定为等价（这份草稿是多余的）');
    ok(D.draftMatches(draft, { text: '猫である。', translation: '我是猫！' }) === false,
      '★ 差一个字 → 不等价（用户真的改过，草稿要留着）');
    // 多一个空格也算改过：宁可多弹一次，也不要漏掉真实修改
    ok(D.draftMatches(draft, { text: '猫である。 ', translation: '我是猫。' }) === false,
      '★ 多一个空格也算改过（不 trim —— 宁可多保护一次）');
    ok(D.draftMatches(null, { text: 'x' }) === false, '没有草稿时不认为是等价');
    ok(D.draftMatches({ text: '', translation: '' }, { text: '', translation: '' }) === true,
      '两边都空也算等价（不会因为空内容反复提示）');
  }

  // ---- 9.2 showDraft 的判断（shouldOfferDraft）----
  {
    const d = { text: '猫である。', translation: '', at: new Date().toISOString() };
    ok(D.shouldOfferDraft(d, { text: '', translation: '' }) === true,
      '输入框空 + 有草稿 → 值得提示恢复');
    ok(D.shouldOfferDraft(d, { text: '别的字', translation: '' }) === false,
      '★ 输入框里已经有东西 → 不打扰（用户正在编辑）');
    ok(D.shouldOfferDraft(null, { text: '', translation: '' }) === false,
      '没有草稿 → 不提示');
  }

  // ---- 9.3 ★ 核心：自动保存不能把"已保存笔记的内容"重新写成草稿 ----
  //
  // 这一段直接模拟真实顺序：打开笔记 → 基准被设成笔记内容 → 定时器跑一轮。
  // 以前这里必然写出草稿（这就是 bug），修好之后必须是"不写、并清掉"。
  {
    localStorage.clear();
    const savedNote = { text: '君の名前は。', translation: '你的名字是。' };
    // 模拟 openNote：填输入框 + 设基准 + 清残留草稿
    const input = { text: savedNote.text, translation: savedNote.translation };
    const baseline = { text: input.text, translation: input.translation };
    D.clearDraft('lyric');

    const getData = () => {
      const cur = { text: input.text, translation: input.translation };
      if (D.draftMatches(baseline, cur)) return null;   // ← 视图里就是这么写的
      return cur;
    };
    const h = D.installDraftAutosave({ viewId: 'lyric', getData, intervalMs: 20 });
    await new Promise((r) => setTimeout(r, 90));
    ok(D.loadDraft('lyric') === null,
      '★★ 打开已保存的笔记后，自动保存**没有**重建草稿（这就是用户报的那个 bug）',
      JSON.stringify(D.loadDraft('lyric')));
    h.stop();

    // 反面对照：用户真的改了字 → 必须照常存草稿
    localStorage.clear();
    input.text = '君の名前は？';   // 改了
    const h2 = D.installDraftAutosave({ viewId: 'lyric', getData, intervalMs: 20 });
    await new Promise((r) => setTimeout(r, 90));
    const got = D.loadDraft('lyric');
    ok(got && got.text === '君の名前は？',
      '★★ 但用户真改了字之后，草稿照常存下来（没修坏原来的保护）', got && got.text);
    h2.stop();
    localStorage.clear();
  }

  // ---- 9.4 draftAlreadySaved：靠"库里有同内容的笔记"来免除提示 ----
  //
  // 自动保存之外还有第二条路径会重建草稿：用户打开旧笔记之后立刻切页
  // （定时器可能刚好在那 5 秒内跑过一次，或者是升级前留下的老草稿）。
  // 所以进页面时还要**回库里核对一遍**：这份内容是不是已经有归属了。
  {
    const fakeDb = {
      dbAll: async () => [
        { id: 'a', text: '别的歌', translation: '' },
        { id: 'b', text: '君の名前は。', translation: '你的名字是。' },
      ],
    };
    ok(await D.draftAlreadySaved(fakeDb, 'lyrics', { text: '君の名前は。', translation: '你的名字是。' }) === true,
      '★★ 草稿内容已是库里的笔记 → 判定为"已保存"，不再提示恢复');
    ok(await D.draftAlreadySaved(fakeDb, 'lyrics', { text: '君の名前は。', translation: '' }) === false,
      '★ 只有正文相同、译文不同 → 不算已保存（译文也是用户的内容）');
    ok(await D.draftAlreadySaved(fakeDb, 'lyrics', { text: '全新的东西', translation: '' }) === false,
      '★ 库里没有的内容 → 照常提示恢复（不能因为修 bug 就吞掉真草稿）');

    // 查不动时倾向"多保护一次"，绝不能误清
    const brokenDb = { dbAll: async () => { throw new Error('库坏了'); } };
    ok(await D.draftAlreadySaved(brokenDb, 'lyrics', { text: 'x', translation: '' }) === false,
      '★ 查询失败时返回"没存过"（宁可多弹一次，也不误清用户内容）');
    ok(await D.draftAlreadySaved(null, 'lyrics', { text: 'x' }) === false,
      '没传数据库对象时安全返回 false');
  }
}

// ===========================================================================
console.log('\n[10] ★ 接线：两个视图都用了"基准 + 已保存核对"这套修法');
// ===========================================================================
//
// ⚠️ 必须测接线：[9] 只证明 draft.js 里的判断写对了。
//    如果视图里还在用"无条件写草稿"，那些判断就是死代码，bug 一点没修。
//    这个项目上已经吃过一次同样的亏 —— "AI 译文会丢"就是函数对、接线断。
{
  for (const f of ['app/js/views/lyric.js', 'app/js/views/reading.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const code = codeLike(src);
    ok(/baseline/.test(code), `★ ${f} 维护了"基准"（区分用户输入 vs 读出来的笔记）`);
    ok(/draftMatches\s*\(/.test(code), `★ ${f} 用 draftMatches 判断内容是否等价`);
    ok(/draftAlreadySaved\s*\(/.test(code),
      `★ ${f} 进页面时回库核对"这份草稿是不是已经存成笔记了"`);
    ok(/return null/.test(code),
      `★ ${f} 在"和已保存笔记一致"时返回 null（约定：让自动保存清掉旧草稿）`);
    // ⚠️ 这一条必须盯**传进自动保存的那个函数**，不能只盯"源码里有没有 baseline"。
    //    第一版写成 `/baseline/` + `/draftMatches/`，结果我把 getData 退回旧写法
    //    （`() => ({ text: jaInput.value … })`）测试**照样全绿** ——
    //    因为 baseline 和 draftMatches 还在文件里，只是没人调用了。
    //    这种"死代码断言"是最危险的：它让人以为接线是好的。
    ok(/getData:\s*draftData\b/.test(code),
      `★★ ${f} 自动保存实际用的是 draftData（而不是旧的无条件写法）`);
    // 打开笔记时必须设基准，否则打开后 5 秒草稿又被重建
    ok(/async function openNote[\s\S]{0,400}?baseline\s*=/.test(code),
      `★ ${f} 在 openNote() 里设了基准（这是修 bug 的关键一步）`);
    // 保存笔记时也要更新基准
    ok(/async function saveNote[\s\S]{0,1600}?baseline\s*=/.test(code),
      `★ ${f} 在 saveNote() 里也更新了基准`);
  }
}

console.log('\n' + '='.repeat(74));
console.log(fail === 0 ? ` 全部通过（${pass} 项）` : ` ${fail} 项未通过（通过 ${pass} 项）`);
console.log('='.repeat(74));
process.exit(fail === 0 ? 0 : 1);
