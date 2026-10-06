/**
 * `tools/qa-layout.mjs` 的载荷：用真浏览器把「精读页」渲染出来。
 *
 * 只做一件事：渲染精读页 → 填一段真文本 → 点「开始精读」→ 等两栏出现。
 *
 * ⚠️ 全程把错误收进 `window.__QA`。
 *    headless 里没有控制台可看，出错时页面就是**一片空白**，
 *    光看 DOM 根本分不清"模块没加载"和"渲染时抛了错"。
 *    所以主动把错误+进度收进一个可以被 CDP 读到的全局对象。
 *
 *    （这个教训是踩出来的：第一版什么记录都没做，
 *     量出来就是"没有 .air-reader 节点"，完全不知道该往哪查。）
 */
window.__QA = { status: 'starting', errors: [], steps: [] };
const log = (s) => window.__QA.steps.push(s);
window.addEventListener('error', (e) => {
  window.__QA.errors.push(`window.error: ${e.message || ''} @ ${e.filename || ''}:${e.lineno || ''}`);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  window.__QA.errors.push('unhandledrejection: ' + ((r && r.message) || String(r)));
});

try {
  // 这里**不需要**装假的 IndexedDB。
  // ⚠️ 第一版试过，被浏览器挡住了：`window.indexedDB` 是只读访问器，
  //    赋值直接抛 "Cannot set property indexedDB of #<Window> which has only a getter"。
  //    其实也不必装：本页只点「开始精读」，不碰用户数据；db 调用在视图里
  //    都包了 try/catch，顶多多一条提示条，不影响量两栏的几何。
  //    **能用真环境就用真环境，别急着造替身。**
  log('using real IndexedDB');

  log('import reading.js');
  const view = (await import('/js/views/reading.js')).default;
  log('imported, id=' + view.id);

  const mount = document.getElementById('mount');
  await view.render(mount, {});
  log('rendered, mount children=' + mount.children.length);

  // 《我是猫》开头（公版）。用户的实际困难正是这类长句，
  // 所以用真文本量出来的宽度才有代表性。
  const TEXT = [
    '吾輩は猫である。名前はまだ無い。',
    'どこで生れたかとんと見当がつかぬ。何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。',
    '吾輩はここで始めて人間というものを見た。しかもあとで聞くと、それは書生という人間中で一番獰悪な種族であったそうだ。',
  ].join('\n');

  const ta = mount.querySelector('textarea');
  if (!ta) throw new Error('找不到输入框');
  ta.value = TEXT;

  const btn = [...mount.querySelectorAll('button')].find((b) => /开始精读/.test(b.textContent));
  if (!btn) throw new Error('找不到「开始精读」按钮');
  log('clicking 开始精读');
  btn.click();

  // 等分析回来并渲染完（本地服务 + 本地词库，正常 1 秒内）
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (document.querySelector('.air-reader')) break;
  }
  const has = !!document.querySelector('.air-reader');
  log('reader present=' + has);
  window.__QA.status = has ? 'ready' : 'no-reader';
  if (!has) {
    window.__QA.errors.push('等不到 .air-reader；页面文本：' + document.body.innerText.slice(0, 300));
  }
  document.title = has ? 'QA 就绪' : 'QA 失败';
} catch (e) {
  window.__QA.status = 'threw';
  window.__QA.errors.push('QA 载荷抛错: ' + ((e && e.stack) || String(e)));
  document.title = 'QA 失败';
}
