/**
 * AI 层测试（纯逻辑，不联网、不需要真密钥）。
 *
 * 用法：node tools/test-ai.mjs
 *
 * 这个文件里最要紧的一组断言是 **[2] 密钥不能泄漏** ——
 * 用户选了"密钥明文存 config.local.json"（问 2 = 甲），
 * 所以"不让密钥跑出去"这件事没有加密兜底，只能靠代码纪律。
 * 纪律靠不住，所以用测试钉死。
 */
import {
  DEFAULT_CONFIG, normalizeConfig, isConfigured, configSummary, maskKey,
  chatEndpoint, buildSystemPrompt, buildMessages, extractContent,
  aiFailureMessage, trimHistory, PROVIDER_PRESETS, TASK_LABELS, CONFIG_FILENAME,
  AI_PRIVACY_TEXT,
  // 按任务给输出长度预算（用户报的"讲语法偶尔被截断"就是它没有的时候）
  maxTokensFor, TASK_MAX_TOKENS, HARD_MAX_TOKENS,
} from './aiconf.js';

let fail = 0; let pass = 0;
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
};
const eq = (a, b, label) => {
  const good = a === b;
  if (good) pass++; else fail++;
  console.log(`  ${good ? '✓' : '✗'} ${label}`);
  if (!good) { console.log(`      得到: ${JSON.stringify(a)}`); console.log(`      期望: ${JSON.stringify(b)}`); }
};

console.log('='.repeat(74));
console.log(' AI 层测试（配置 / 密钥安全 / 提示词 / 错误翻译）');
console.log('='.repeat(74));

// ---------------------------------------------------------------------------
console.log('\n[1] 默认必须是关闭的（用户不主动开，就永远不联网）');
eq(DEFAULT_CONFIG.enabled, false, '默认 enabled = false');
eq(DEFAULT_CONFIG.baseURL, '', '默认没有地址');
eq(DEFAULT_CONFIG.apiKey, '', '默认没有密钥');
eq(normalizeConfig(null).enabled, false, '配置缺失 → 关闭');
eq(normalizeConfig({}).enabled, false, '空对象 → 关闭');
eq(normalizeConfig(undefined).enabled, false, 'undefined → 关闭');
// 只有严格 true 才算开 —— 避免 "true" 字符串或 1 被误当成开启
eq(normalizeConfig({ enabled: 'true' }).enabled, false, '字符串 "true" 不算开启（严格判断）');
eq(normalizeConfig({ enabled: 1 }).enabled, false, '数字 1 不算开启（严格判断）');
eq(normalizeConfig({ enabled: true }).enabled, true, '只有布尔 true 才算开启');

// ---------------------------------------------------------------------------
console.log('\n[2] 密钥不能泄漏（这一组是重点）');
{
  const FAKE = 'sk-test-FAKEKEY-1234567890abcdefghijklmnop';
  const cfg = normalizeConfig({
    enabled: true, baseURL: 'https://api.example.com/v1', apiKey: FAKE, model: 'm',
  });
  const summary = configSummary(cfg);
  const dumped = JSON.stringify(summary);

  ok(!dumped.includes(FAKE), 'configSummary() 的 JSON 里搜不到密钥原文');
  eq(summary.hasKey, true, '但能告诉用户"已经设了密钥"');
  ok(summary.keyHint && summary.keyHint.length > 0, '给一个遮罩提示（能认出是哪把钥匙）');
  ok(!summary.keyHint.includes(FAKE), '遮罩提示里也不含原文');
  eq(Object.prototype.hasOwnProperty.call(summary, 'apiKey'), false,
    'configSummary() 里根本没有 apiKey 这个键');
  // 序列化整个 summary 也不该出现密钥的任何长片段
  ok(!dumped.includes(FAKE.slice(8, 30)), '密钥中段也没漏出来');

  // maskKey 的具体行为
  eq(maskKey(''), '', '空密钥 → 空字符串');
  eq(maskKey(null), '', 'null → 空字符串');
  eq(maskKey('short'), '•••••', '短密钥全部遮掉');
  eq(maskKey('123456789012'), '••••••••••••', '12 位及以下全遮（留头尾等于泄了大半）');
  const m = maskKey('sk-abcdefghijklmnopqrstuvwxyz');
  eq(m.slice(0, 4), 'sk-a', '长密钥保留前 4 位（够辨认）');
  eq(m.slice(-4), 'wxyz', '长密钥保留后 4 位');
  ok(m.includes('•'), '中间是遮罩字符');
  ok(m.length < 28, '遮罩结果不保留原长度信息（不给人爆破线索）');
  // 关键：遮罩结果绝不能让人还原出密钥
  ok(!m.includes('efghijkl'), '中段内容没有保留');
}

// ---------------------------------------------------------------------------
console.log('\n[3] 配置整理：手改配置文件写错类型也不该崩');
{
  const c = normalizeConfig({
    enabled: true, baseURL: 'https://x.com/v1/', apiKey: ' k ', model: ' m ',
    temperature: '0.7', maxTokens: '999999999', timeoutMs: 'abc',
  });
  eq(c.baseURL, 'https://x.com/v1', '去掉结尾斜杠（避免拼出 //chat）');
  eq(c.apiKey, 'k', '密钥去掉首尾空格（粘贴常带空格）');
  eq(c.model, 'm', '模型名去空格');
  eq(c.temperature, 0.7, '字符串数字会转成数字');
  eq(c.maxTokens, 128000, '超上限会被夹到上限');
  eq(c.timeoutMs, DEFAULT_CONFIG.timeoutMs, '非法超时时间退回默认值');
  eq(normalizeConfig({ temperature: -5 }).temperature, 0, '温度下限 0');
  eq(normalizeConfig({ temperature: 99 }).temperature, 2, '温度上限 2');
  eq(normalizeConfig({ maxTokens: 0 }).maxTokens, 1, 'maxTokens 下限 1');
  ok(normalizeConfig('不是对象').enabled === false, '传字符串也不崩');

  eq(isConfigured({ baseURL: '', apiKey: 'k', model: 'm' }), false, '缺地址 → 没配好');
  eq(isConfigured({ baseURL: 'u', apiKey: '', model: 'm' }), false, '缺密钥 → 没配好');
  eq(isConfigured({ baseURL: 'u', apiKey: 'k', model: '' }), false, '缺模型 → 没配好');
  eq(isConfigured({ baseURL: 'u', apiKey: 'k', model: 'm' }), true, '三样齐全 → 配好了');

// ---------------------------------------------------------------------------
console.log('\n[4] 接口地址拼接（用户填的写法五花八门）');
eq(chatEndpoint('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions', '标准地址');
eq(chatEndpoint('https://api.openai.com/v1/'), 'https://api.openai.com/v1/chat/completions', '结尾多余斜杠');
eq(chatEndpoint('https://api.openai.com/v1///'), 'https://api.openai.com/v1/chat/completions', '多个结尾斜杠');
eq(chatEndpoint('  https://x.com/v1  '), 'https://x.com/v1/chat/completions', '首尾空格');
eq(chatEndpoint('https://x.com/v1/chat/completions'), 'https://x.com/v1/chat/completions',
  '用户已经写全了就不重复加（否则会变成 .../chat/completions/chat/completions）');
eq(chatEndpoint(''), '', '空地址 → 空（调用方据此判断）');
eq(chatEndpoint(null), '', 'null → 空');
eq(chatEndpoint('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1/chat/completions',
  '本机 Ollama 的地址也支持（不联网场景）');

// ---------------------------------------------------------------------------
console.log('\n[5] 提示词与消息组装');
{
  for (const task of Object.keys(TASK_LABELS)) {
    const p = buildSystemPrompt(task);
    ok(p.length > 20, `任务「${task}」有提示词`);
    ok(/中文/.test(p), `任务「${task}」要求用中文回答`);
  }
  ok(/翻译/.test(buildSystemPrompt('translate')), 'translate 提示词讲的是翻译');
  ok(/语法|结构/.test(buildSystemPrompt('explain')), 'explain 提示词讲的是语法讲解');
  ok(/读音|词性/.test(buildSystemPrompt('word')), 'word 提示词讲的是讲词');
  ok(buildSystemPrompt('不存在的任务').length > 20, '未知任务也有兜底提示词（不返回空）');

  const msgs = buildMessages('translate', '  こんにちは  ');
  eq(msgs.length, 2, '基本是 2 条：system + user');
  eq(msgs[0].role, 'system', '第一条是 system');
  eq(msgs[1].role, 'user', '第二条是 user');
  eq(msgs[1].content, 'こんにちは', '文本去掉首尾空格');

  eq(buildMessages('translate', ''), null, '空文本 → null（调用方据此拒绝）');
  eq(buildMessages('translate', '   '), null, '纯空格 → null');
  eq(buildMessages('translate', null), null, 'null → null');

  // 带上下文时多一条，但**上下文是截断的**
  const withCtx = buildMessages('word', '食べる', { context: 'x'.repeat(2000) });
  eq(withCtx.length, 3, '带上下文时 3 条');
  ok(withCtx[1].content.length < 700, '上下文被截断（不会把整页文本带上去）');

  // 超长文本必须截断
  const long = buildMessages('translate', 'あ'.repeat(20000));
  ok(long[long.length - 1].content.length <= 8000, '超长文本被截到 8000 字符以内',
    `实际 ${long[long.length - 1].content.length}`);
}

// ---------------------------------------------------------------------------
console.log('\n[6] 解析上游返回（各家字段略有差异，且绝不能抛错）');
eq(extractContent({ choices: [{ message: { content: '你好' } }] }).text, '你好', '标准 OpenAI 返回');
eq(extractContent({ choices: [{ message: { content: '  你好  ' } }] }).text, '你好', '去掉首尾空白');
eq(extractContent({ choices: [{ message: { content: [{ text: '甲' }, { text: '乙' }] } }] }).text,
  '甲乙', 'content 是数组时拼起来（部分服务商这么返回）');
ok(extractContent({}).reason.includes('choices'), '没有 choices 时给出原因');
ok(extractContent({ error: { message: '额度不足' } }).reason.includes('额度不足'),
  '上游 error 字段会被读出来给用户看');
eq(extractContent({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }).reason.includes('截断'),
  true, '被长度截断时给出专门说明');

// ★★ 截断但有内容时，**内容必须保留**（用户 2026-10 报的那个 bug）
//
//    用户原话：「点击 ai 讲语法，偶尔会返回『（讲解失败：回答被长度上限截断了，
//               可以把上限调大或缩短文本）』，但也有运行成功的时候。」
//
//    "偶尔"= 回答长度正好卡在上限附近。旧代码只在**一个字都没出来**时才提"截断"，
//    有内容时 `return { text }` 把截断标志咽掉了 —— 用户看到一段戛然而止的讲解，
//    不知道后面还有。更糟的是如果实现改成"截断就丢内容"，用户就白花一次钱。
//    所以这里同时卡死两件事：**标志要有、内容不许丢**。
{
  const partial = extractContent({
    choices: [{ message: { content: '这句是「〜は〜です」句型，主语是"君の名前"' }, finish_reason: 'length' }],
  });
  eq(partial.text, '这句是「〜は〜です」句型，主语是"君の名前"',
    '★★ 被截断但已有内容时，内容照样返回（不许丢掉用户花了钱的回答）');
  eq(partial.truncated, true, '★★ 同时把"被截断了"如实告诉调用方');
  eq(partial.reason.includes('截断'), true, '★★ 截断时 reason 也要说清是截断');

  const full = extractContent({ choices: [{ message: { content: '完整回答' }, finish_reason: 'stop' }] });
  eq(full.truncated, false, '正常结束（stop）时不该被标成截断');
  eq(full.reason, '', '正常结束时没有 reason');

  const empty = extractContent({ choices: [{ message: { content: '' }, finish_reason: 'length' }] });
  eq(empty.truncated, true, '截断且没内容时也要标出来');
  eq(empty.text, '', '截断且没内容时 text 是空字符串（不是 undefined）');
}

ok(extractContent(null).reason.length > 0, 'null 不抛错，给出原因');
ok(extractContent('字符串').reason.length > 0, '非对象不抛错');
ok(extractContent({ choices: [{}] }).reason.length > 0, 'choice 里没有 message 也不抛错');
// 绝不该抛异常
let threw = false;
try { extractContent({ choices: [{ message: null }] }); } catch { threw = true; }
ok(!threw, '上游返回怪东西时 extractContent 不抛异常');
}

// ---------------------------------------------------------------------------
console.log('\n[6.5] ★★ 按任务给输出长度预算（讲语法不许再被 1200 截断）');
{
  // 这一组对应的问题：用户报「点击 ai 讲语法，偶尔会返回
  // 『（讲解失败：回答被长度上限截断了）』，但也有运行成功的时候」。
  // 根因是**翻译和讲语法共用一个默认 1200 token**，而讲解的输出长得多。
  //
  // ⚠️ 断言全部要求"实际算出来的数"，不去断言"表里写了多少"——
  //    后者只是抄一遍实现，改坏了也照样绿。

  // ① 讲语法必须比翻译宽得多（这是当初那个 bug 的核心）
  const tExplain = maxTokensFor('explain', DEFAULT_CONFIG.maxTokens);
  const tTranslate = maxTokensFor('translate', DEFAULT_CONFIG.maxTokens);
  ok(tExplain >= 3000, `讲语法拿到 ${tExplain} token（≥3000，不再被 1200 卡住）`);
  ok(tExplain > tTranslate, `讲语法(${tExplain}) 的预算严格大于翻译(${tTranslate})`);

  // ② 原来只给 1200 时**必然**会被截断的那个场景，现在够用
  ok(tExplain >= 2500, '讲语法至少 2500 token —— 一段中等长度的讲解能说完');

  // ③ 用户把上限调**大**时要照用（绝不能擅改用户配置把值压小）
  ok(maxTokensFor('explain', 6000) === 6000, '用户把上限调到 6000 时，讲语法就用 6000');
  ok(maxTokensFor('translate', 5000) === 5000, '用户把上限调大时，翻译也照用（不擅自压小）');

  // ④ 用户把上限调**小**时，讲解类要兜底
  ok(maxTokensFor('explain', 100) >= 3000, '用户把上限填成 100 时，讲语法仍然拿到 ≥3000（截断比省额度更伤）');

  // ⑤ 硬上限：不能无限大（有的服务商会对过大的 max_tokens 直接报错）
  ok(maxTokensFor('explain', 999999) === HARD_MAX_TOKENS,
    `用户填 999999 时被夹到硬上限 ${HARD_MAX_TOKENS}`);
  ok(maxTokensFor('explain', 128000) <= HARD_MAX_TOKENS, '无论怎么填都不超过硬上限');

  // ⑥ 兜底：未知任务、空值、非数字都不能算出 NaN / undefined
  for (const [task, val] of [['不存在的任务', 1200], ['', undefined], ['custom', null], ['explain', 'abc']]) {
    const n = maxTokensFor(task, val);
    ok(Number.isFinite(n) && n > 0, `任务「${task}」+ 上限 ${String(val)} → ${n}（是个正数，不是 NaN）`);
  }

  // ⑦ 每个登记过的任务都要有预算，不允许漏
  for (const t of ['translate', 'explain', 'word', 'custom']) {
    ok(Number.isFinite(TASK_MAX_TOKENS[t]) && TASK_MAX_TOKENS[t] > 0, `任务「${t}」登记了预算`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n[7] 错误翻译成人话（含实测踩的 fetch failed 坑）');
{
  // ⚠️ 这一组是**实测复现过的形状**：Node 的 fetch 把网络错误包成
  //    TypeError("fetch failed")，真正有信息的是 err.cause。
  //    第一版只读 err.message，于是 DNS 错和端口没人听都显示"fetch failed"。
  const dnsErr = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.example.invalid'), { code: 'ENOTFOUND' }),
  });
  ok(/连不上这个地址/.test(aiFailureMessage(dnsErr)), 'fetch failed + cause ENOTFOUND → 说"连不上这个地址"');
  ok(!/fetch failed/.test(aiFailureMessage(dnsErr)), '不会再露出 "fetch failed" 这种等于没说的话');

  const refuseErr = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:59999'), { code: 'ECONNREFUSED' }),
  });
  ok(/对方拒绝了连接/.test(aiFailureMessage(refuseErr)), 'ECONNREFUSED → 说"对方拒绝了连接"');
  ok(/Ollama/.test(aiFailureMessage(refuseErr)), '还提示了本机场景（Ollama 没开）');

  const resetErr = Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNRESET') });
  ok(/中途断开/.test(aiFailureMessage(resetErr)), 'ECONNRESET → 说"连接被中途断开"');

  ok(/超时/.test(aiFailureMessage(new Error('The operation was aborted'))), '超时 → 说"请求超时"');
  ok(/超时/.test(aiFailureMessage(Object.assign(new Error('x'), { name: 'TimeoutError' }))), 'TimeoutError → 超时');
  ok(/401/.test(aiFailureMessage(new Error('401 Unauthorized'))), '401 → 说密钥不对');
  ok(/403/.test(aiFailureMessage(new Error('403 Forbidden'))), '403 → 说没权限');
  ok(/404/.test(aiFailureMessage(new Error('404 Not Found'))), '404 → 说地址不对');
  ok(/429/.test(aiFailureMessage(new Error('429 Too Many Requests'))), '429 → 说太频繁');
  ok(/额度/.test(aiFailureMessage(new Error('429 rate limit exceeded'))), 'rate limit 也认');
  ok(/5xx|服务器/.test(aiFailureMessage(new Error('503 Service Unavailable'))), '503 → 说对方服务器出错');
  ok(/证书/.test(aiFailureMessage(new Error('unable to verify the first certificate'))), '证书问题有专门说明');

  // 405（实测：地址指向一个真实存在但不是 chat 接口的服务）
  const msg405 = aiFailureMessage(new Error('405'));
  ok(msg405.includes('405'), '405 会把状态码说出来', msg405);
  ok(msg405.includes('兼容'), '405 会提示"地址可能不是 OpenAI 兼容接口"', msg405);

  // 兜底
  ok(aiFailureMessage(null).length > 0, 'null 也给一句话');
  ok(aiFailureMessage(new Error('莫名其妙')).includes('莫名其妙'), '不认识的错误原样带上（便于排查）');
  // 绝不把 undefined 显示给用户
  ok(!/undefined/.test(aiFailureMessage(undefined)), '不会显示 "undefined"');
  ok(!/undefined/.test(aiFailureMessage({})), '空对象不会显示 "undefined"');
}

// ---------------------------------------------------------------------------
console.log('\n[8] 多轮历史裁剪（防止越聊越贵）');
{
  const h = [];
  for (let i = 0; i < 20; i++) {
    h.push({ role: 'user', content: 'u' + i });
    h.push({ role: 'assistant', content: 'a' + i });
  }
  const t = trimHistory(h, 6);
  eq(t.length, 12, '6 轮 = 12 条');
  eq(t[t.length - 1].content, 'a19', '保留的是最新的（不能裁掉刚说的）');
  eq(t[0].content, 'u14', '裁掉的是最旧的');
  eq(trimHistory(null).length, 0, 'null → 空数组');
  eq(trimHistory('x').length, 0, '字符串 → 空数组');
  eq(trimHistory([{ role: 'system', content: 's' }]).length, 0, 'system 消息不放进历史（提示词是服务端定的）');
  eq(trimHistory([{ role: 'user' }]).length, 0, '没有 content 的条目被丢掉');
  eq(trimHistory([{ role: 'user', content: 123 }]).length, 0, 'content 不是字符串的丢掉');
}

// ---------------------------------------------------------------------------
console.log('\n[9] 服务商预设（给不知道该填什么的用户）');
{
  ok(PROVIDER_PRESETS.length >= 5, `有 ${PROVIDER_PRESETS.length} 个预设`);
  for (const p of PROVIDER_PRESETS) {
    ok(p.id && p.label, `预设「${p.id}」有 id 和 label`);
  }
  ok(PROVIDER_PRESETS.some((p) => p.id === 'ollama'), '有本机 Ollama 选项（不想联网的用户需要）');
  ok(PROVIDER_PRESETS.some((p) => p.id === 'custom'), '有"自己填"选项');
  const ollama = PROVIDER_PRESETS.find((p) => p.id === 'ollama');
  ok(/127\.0\.0\.1|localhost/.test(ollama.baseURL), 'Ollama 预设指向本机');
  ok(PROVIDER_PRESETS.every((p) => !p.apiKey), '预设里不能带任何密钥');
  eq(CONFIG_FILENAME, 'config.local.json', '配置文件名固定（.gitignore 里也是这个名字）');
}

// ---------------------------------------------------------------------------
console.log('\n[10] 给用户看的文案：不能混进 Markdown 标记');
{
  // ⚠️ 这一节是**真踩过的坑**：AI_PRIVACY_TEXT 里原来写着
  //    「只有你**选中的那段文字**会被发送」。这个串是通过 el(..., {text}) 渲染的，
  //    走 textContent，**不解析 Markdown** —— 结果界面上会原样显示
  //    `**选中的那段文字**`，看起来像程序出了故障。
  //    这类错误不会让任何别的测试变红，只能靠"专门盯它"的断言发现。
  const bad = AI_PRIVACY_TEXT.filter((s) => /\*\*|__|`|\]\(/.test(s));
  ok(bad.length === 0, '隐私说明里没有 Markdown 标记（星号/反引号/链接）', bad.join(' | '));

  // 每一条都必须是有意义的完整句子，不能是空串或半句话
  for (const [i, s] of AI_PRIVACY_TEXT.entries()) {
    ok(typeof s === 'string' && s.trim().length >= 8, `隐私说明第 ${i + 1} 条不是空话`);
    ok(/[。！？]$/.test(String(s).trim()), `隐私说明第 ${i + 1} 条以句号收尾`);
  }

  // 该说的信息，一条都不能少。
  //
  // ⚠️ 这一节在 2026-10 改过一次，因为**程序行为变了**：
  //    原文断言"说了只发选中的"。后来加了「自动翻译全部段落」——
  //    一按那个按钮就会把每一段的日文正文依次发出去，
  //    于是"只发选中的"这句**变成了假话**。
  //    承诺比措辞重要：行为改了就必须改文案，所以断言也跟着改成
  //    "两种触发方式都要说清楚"。
  const whole = AI_PRIVACY_TEXT.join('\n');
  ok(/讲这个词|讲这句/.test(whole), '说了"点词/点句时只发那一小段"');
  ok(/自动翻译/.test(whole), '★ 说了"自动翻译会把每段正文发出去"（最容易漏掉的一条）');
  ok(/密钥/.test(whole) && /config\.local\.json/.test(whole), '说了密钥在哪');
  ok(/默认关闭/.test(whole), '说了默认关闭');
  ok(/生词本|进度|笔记/.test(whole), '说了哪些数据不会被发送');
  // 反面：不许一边说"只有你选的"、一边又能自动翻译全部 —— 那是自相矛盾。
  ok(!/只有你/.test(whole), '★ 不再说"只有你选中的"（那与自动翻译矛盾，是过时文案）');
}

console.log('\n' + '='.repeat(74));
console.log(fail === 0 ? ` 全部通过（${pass} 项）` : ` ${fail} 项未通过（通过 ${pass} 项）`);
console.log('='.repeat(74));
process.exit(fail === 0 ? 0 : 1);
