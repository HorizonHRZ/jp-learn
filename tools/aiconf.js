/**
 * aiconf.js —— AI 配置的**纯逻辑**（零 I/O、零网络、零依赖），可直接单测。
 *
 * 和 `exportfmt.js` 同样的理由拆出来：这里最要紧的事情（**密钥不能泄漏**）
 * 全是字符串处理，而字符串处理最容易在边角上出错，
 * 用测试逐条断言比"跑起来看看"可靠得多。
 *
 * `server.js` 负责真正读写文件与发请求，它调用这里的函数。
 *
 * ⚠️ 用户的选择（问 2 = 甲）：**密钥明文存在 `config.local.json`**。
 *    用户明确拒绝用 Windows 账号加密（DPAPI），所以不做加密 ——
 *    但正因如此，"不让密钥跑出去"这件事必须靠代码纪律 + 测试来保证。
 */

/** 配置文件放在项目根目录，和程序代码同级（但被 .gitignore 排除） */
export const CONFIG_FILENAME = 'config.local.json';

/** 默认配置：**默认关闭**。用户不主动开，就永远不联网。 */
export const DEFAULT_CONFIG = {
  enabled: false,
  baseURL: '',
  apiKey: '',
  model: '',
  // 生成参数
  temperature: 0.3,
  maxTokens: 1200,
  timeoutMs: 60000,
};

/** 已知服务商的 baseURL 速查（用户也可以自己填） */
export const PROVIDER_PRESETS = [
  { id: 'openai', label: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'deepseek', label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'moonshot', label: '月之暗面 Kimi', baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'zhipu', label: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { id: 'dashscope', label: '阿里通义千问', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'ollama', label: '本机 Ollama（不联网）', baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
  { id: 'custom', label: '其他（自己填地址）', baseURL: '', model: '' },
];

/**
 * ★★ 每种任务的**输出长度预算**（token）。
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么需要"按任务分别给预算"（用户 2026-10 报的真 bug）
 * ────────────────────────────────────────────────────────────────────
 *   用户原话：
 *     「点击 ai 讲语法，偶尔会返回『（讲解失败：回答被长度上限截断了，
 *       可以把上限调大或缩短文本）』，但也有运行成功的时候。」
 *
 *   "偶尔"这个词是关键线索：说明不是配置错，而是**回答长度正好卡在上限附近** ——
 *   短句子讲得完，长句子讲到一半就被截断了。
 *
 *   根因是**一个上限被所有任务共用**：默认 1200 token。
 *     · 翻译一段话 → 输出和输入差不多长，1200 够用；
 *     · 讲一句语法 → 要拆结构、说明接续、给例句、列易混点，
 *       输出常常比原文长好几倍，1200 很容易撞上限。
 *   两个需求差一个数量级，却共用一个数字，必然有一边不合适。
 *
 *   所以这里给"讲解类"任务一个更宽的预算。
 *
 * ⚠️ 三条设计约束（别随手改）：
 *   ① **用户设的值是下限，不是上限**：用户把 maxTokens 调大时我们照用；
 *      我们只在"他没意识到这个任务需要更多"时帮他兜底。
 *      绝不能反过来把用户设的大值压小 —— 那是擅改用户配置。
 *   ② **有硬上限**：不能无限大。有些服务商对 max_tokens 有自己的天花板，
 *      传太大直接被拒（那会变成另一个更难懂的报错）。
 *   ③ 这份表放在 `tools/aiconf.js`（**服务端与测试共用**），
 *      前端不重复一份 —— 两处各写一份必然漂移。
 */
export const TASK_MAX_TOKENS = {
  // 翻译：输出长度和输入同量级，默认值就够
  translate: 1200,
  // 讲语法 / 讲词：要拆结构 + 例句 + 易混，输出比原文长得多
  explain: 3000,
  word: 2000,
  custom: 2000,
};

/** 任何情况下都不超过这个数（多数服务商能接受，再高也没必要） */
export const HARD_MAX_TOKENS = 8000;

/**
 * 算出这次请求实际该用多少 max_tokens。
 *
 * @param {string} task     任务类型
 * @param {number} userMax  用户配置里的 maxTokens
 * @returns {number}
 */
export function maxTokensFor(task, userMax) {
  const base = Number.isFinite(userMax) && userMax > 0 ? userMax : DEFAULT_CONFIG.maxTokens;
  const want = TASK_MAX_TOKENS[String(task)] || TASK_MAX_TOKENS.custom;
  // 取两者较大的那个，但不超过硬上限。
  // 取大而不是取小：**截断的伤害大于多花一点额度** ——
  // 截断的结果是用户白花一次钱还什么都读不到。
  return Math.min(Math.max(base, want), HARD_MAX_TOKENS);
}

/**
 * 把任意读进来的对象整理成合法配置。
 *
 * 为什么要"整理"而不是直接信任文件：`config.local.json` 是用户手改的，
 * 类型写错（比如把 maxTokens 写成字符串）不该让服务崩掉或把怪值传给上游。
 */
export function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const str = (v, d = '') => (typeof v === 'string' ? v.trim() : d);
  const num = (v, d, lo, hi) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return d;
    return Math.min(hi, Math.max(lo, n));
  };
  return {
    enabled: c.enabled === true,                 // 只有**严格 true** 才算开启
    baseURL: str(c.baseURL).replace(/\/+$/, ''), // 去掉结尾斜杠，避免拼出 //chat
    apiKey: str(c.apiKey),
    model: str(c.model),
    temperature: num(c.temperature, DEFAULT_CONFIG.temperature, 0, 2),
    maxTokens: num(c.maxTokens, DEFAULT_CONFIG.maxTokens, 1, 128000),
    timeoutMs: num(c.timeoutMs, DEFAULT_CONFIG.timeoutMs, 1000, 300000),
  };
}

/** 配置是否"够用"（能真正发请求） */
export function isConfigured(cfg) {
  return !!(cfg && cfg.baseURL && cfg.apiKey && cfg.model);
}

/**
 * 状态摘要：**给前端看的**，必须能安全地放进 JSON 响应。
 *
 * ⚠️ 这里是防泄漏的关键函数：**它绝不能返回 apiKey 原文**。
 *    测试 `tools/test-ai.mjs` 会把一个假密钥塞进配置，
 *    然后断言整个摘要里搜不到它。
 */
export function configSummary(cfg) {
  const c = normalizeConfig(cfg);
  return {
    enabled: c.enabled,
    configured: isConfigured(c),
    baseURL: c.baseURL,          // 地址不是秘密，用户自己填的
    model: c.model,
    hasKey: !!c.apiKey,
    keyHint: maskKey(c.apiKey),  // 只给"能认出是哪把钥匙"的程度
    temperature: c.temperature,
    maxTokens: c.maxTokens,
  };
}

/**
 * 把密钥遮起来，只留头尾几个字符。
 *
 * 为什么留头尾：用户有几把钥匙的时候，需要能认出"现在用的是哪一把"。
 * 但不能留太多 —— 留 4+4 位对常见 40+ 位的 key 来说信息量足够辨认、又不足以使用。
 * 短 key（≤12 位）直接全遮，因为留头尾等于泄了大半。
 */
export function maskKey(key) {
  const k = typeof key === 'string' ? key : '';
  if (!k) return '';
  if (k.length <= 12) return '•'.repeat(k.length);
  return `${k.slice(0, 4)}${'•'.repeat(Math.min(12, k.length - 8))}${k.slice(-4)}`;
}

/**
 * 拼接 chat completions 地址。
 * 用户填的 baseURL 有的带 `/v1` 有的不带，有的结尾有斜杠 —— 统一处理。
 */
export function chatEndpoint(baseURL) {
  const b = String(baseURL || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  // 已经写全了就别重复加
  if (/\/chat\/completions$/.test(b)) return b;
  return `${b}/chat/completions`;
}

/** 允许的用途。白名单而不是自由文本 —— 前端不能随便指挥服务端发什么。 */
export const TASK_LABELS = {
  translate: '翻译这段日文',
  explain: '讲解这段日文的语法和用词',
  word: '讲解这个词',
  custom: '自定义提问',
};

/**
 * 给用户看的隐私说明。**界面、弹窗、测试三处共用同一份文字**，
 * 避免"设置页说一套、首次确认框说另一套"。
 *
 * ⚠️ 这份文字是**纯文本**（用 `textContent` 渲染，不解析 Markdown），
 *    所以里面**不能出现 `**加粗**` 这类标记** —— 界面上会原样露出星号。
 *    想强调就用中文引号「」。`tools/test-ai.mjs` 的 [10] 节在盯这件事。
 *
 * ⚠️⚠️ **这份文字必须和程序的实际行为一致，改行为就要改这里。**
 *    真实发生过一次：原文写的是「只有你选中的那段文字会被发送」，
 *    后来加了"按段落自动翻译"，一按按钮就会把**每一段的正文**都发出去 ——
 *    那句话当场变成假话。承诺比措辞重要，所以现在按"两种触发方式"分别说清楚。
 *
 * 放在这个**纯逻辑**文件里（而不是 app/js/ai.js）的原因：
 *   `ai.js` 会 import IndexedDB 封装，Node 里跑不了；
 *   而这份文字必须能被测试直接读到，否则测的就只是"另一个副本"。
 */
export const AI_PRIVACY_TEXT = [
  '这个功能默认关闭。关掉之后，程序不会连接任何外部服务。',
  '你点「AI 讲这个词 / 讲这句」时，只把你点的那一小段发给 AI。',
  '你点「自动翻译全部段落」时，会把每一段的日文正文依次发给你填的 AI 地址。',
  '生词本、学习进度、复习记录、笔记标题都不会被发送；整本书也不会一次性发出去。',
  '你填的 API 密钥保存在本机项目目录的 config.local.json 里（明文，这是你选的方案），不会发给浏览器。',
];

/**
 * 地址类错误的统一提示。
 *
 * ⚠️ 这条文案是有来历的 —— 用户本人踩过一次：
 *   他把 baseURL 写成了 `https://api.deepseek.com`，**漏了结尾的 /v1**。
 *   上游于是回 404（路径不存在），而当时的提示只泛泛说"检查地址"。
 *   实测这就是最常见的配置错误，所以：
 *     · 文案里**必须点名 /v1**，并且给出"正确的样子"作为对照；
 *     · 凡是"地址不对"这一类错误（404/405/路径不通/返回里没有 choices）
 *       都复用这一条，避免同一个坑有好几种说法。
 */
export const BASE_URL_HINT =
  '多数 OpenAI 兼容服务的地址要以 /v1 结尾，例如 https://api.deepseek.com/v1'
  + '（注意：https://api.deepseek.com 少了 /v1 就会报 404）。';

/**
 * 构造系统提示词。
 *
 * 设计要点：
 *   · 明确要求"只处理给到的文本"—— 降低模型自作主张扩写的概率
 *   · 要求输出中文（用户是中文母语者）
 *   · 不要 markdown 表格/代码块，因为我们是塞进一个窄侧栏显示的
 */
export function buildSystemPrompt(task) {
  const base = '你是一位日语老师，面向中文母语的日语学习者。回答一律用简体中文。';
  const style = '回答要简洁、直给结论，不要客套话。不要用 markdown 表格或代码块，用短的段落或短横线列表。';
  switch (task) {
    case 'translate':
      return `${base}${style}任务：把用户给的日文翻译成自然的中文。先给整段译文，再对其中较难的词或表达做简短说明（每条一行，格式：词 — 读音 — 意思）。只处理给到的文本，不要额外扩写。`;
    case 'explain':
      return `${base}${style}任务：讲解用户给的日文。按这个顺序讲：1) 整句意思；2) 句子结构（主语/谓语/修饰关系）；3) 逐个讲值得注意的语法点和助词；4) 如果有惯用表达或语气上的细节，单独说明。只讲给到的文本里真实出现的东西。`;
    case 'word':
      return `${base}${style}任务：讲解用户给的这个日语词。给：读音、词性、中文意思、常见搭配、一个简短例句（带中文翻译）、以及容易和它混的词的区别。`;
    default:
      return `${base}${style}`;
  }
}

/**
 * 把"任务 + 文本"组装成要发给服务端的 messages。
 *
 * ⚠️ **只放用户选中的那段文本**，不放上下文、不放整页歌词、不放生词本。
 *    这是对用户的承诺（界面上写着"只发送你选中的那段文本"），
 *    所以在这里硬性做到 —— 调用方想多塞东西都没有入口。
 */
export function buildMessages(task, text, extra = {}) {
  const t = String(text || '').trim();
  if (!t) return null;
  const msgs = [{ role: 'system', content: buildSystemPrompt(task) }];
  if (extra.context) {
    // context 只用于"这个词出现在这句话里"这种最小必要信息
    msgs.push({ role: 'user', content: `（这个词所在的句子：${String(extra.context).slice(0, 500)}）` });
  }
  msgs.push({ role: 'user', content: t.slice(0, 8000) });
  return msgs;
}

/**
 * 从上游返回体里取出要显示的文本。
 * 不同服务商字段名略有差异，所以宽松一点取，但**绝不抛错**——
 * 上游返回怪东西时给用户一句人话，比抛异常好。
 */
export function extractContent(body) {
  if (!body || typeof body !== 'object') return { text: '', reason: '上游没有返回可解析的内容' };
  const choice = Array.isArray(body.choices) ? body.choices[0] : null;
  if (!choice) {
    const msg = body.error && (body.error.message || body.error.type);
    if (msg) return { text: '', reason: `上游报错：${msg}` };
    // ⚠️ 没有 choices 且没有 error，是"地址指向了别的接口"的典型症状。
    //    实测：baseURL 漏了 /v1 时，有的服务商不回 404，而是回一个
    //    完全无关的 JSON（比如首页/错误页），于是这里就走到这一支。
    //    只说"没有 choices 字段"用户完全不知道该改什么，所以带上地址提示。
    return {
      text: '',
      reason: '上游返回的内容里没有对话结果（缺少 choices 字段）—— '
        + `这通常说明地址指向的不是对话接口。${BASE_URL_HINT}`,
    };
  }
  const m = choice.message || {};
  const text = typeof m.content === 'string' ? m.content
    : (Array.isArray(m.content) ? m.content.map((p) => (p && p.text) || '').join('') : '');
  const trimmed = String(text || '').trim();
  const truncated = choice.finish_reason === 'length';

  // ★★ 被长度上限截断时，**半截回答也要交给用户**（用户 2026-10 报的真 bug）。
  //
  //    旧版本是这么写的：
  //        if (!trimmed) {
  //          return { text: '', reason: fr === 'length' ? '回答被长度上限截断了…' : '…' };
  //        }
  //    只处理了"一个字都没出来"的情况。而实际发生的是：
  //    模型**说到一半**被截断 —— `trimmed` 非空，于是走 `return { text: trimmed }`，
  //    **截断这件事被完全咽掉了**，前端显示一段戛然而止的文字，
  //    用户完全不知道后面还有内容。（他看到的报错那种，是截断得极早、
  //    连一句完整话都没说出来的情况。）
  //
  //    两件事都要做对：
  //      ① 有内容时：**保留内容** + 明确告诉调用方"这是半截"；
  //      ② 没内容时：给一句人话，并说清怎么办。
  //    绝不因为"被截断了"就把已经拿到的内容丢掉 —— 那是用户花了钱的回答。
  if (!trimmed) {
    return {
      text: '',
      truncated,
      reason: truncated
        ? '回答被长度上限截断了，可以把上限调大或缩短文本'
        : '上游返回了空回答',
    };
  }
  return {
    text: trimmed,
    truncated,
    reason: truncated ? '回答被长度上限截断了，后面可能还有内容没说完' : '',
  };
}

/**
 * 把错误里的所有可用信息拼成一个字符串，供下面的关键词匹配。
 *
 * ⚠️ 为什么需要这个（实测踩的坑）：
 *    Node 的 `fetch()` 在遇到网络层问题时，**外层 message 一律只是 "fetch failed"**，
 *    真正有信息的是 `err.cause`：
 *        TypeError: fetch failed
 *          cause: Error: getaddrinfo ENOTFOUND api.example.invalid  (code: ENOTFOUND)
 *          cause: Error: connect ECONNREFUSED 127.0.0.1:59999       (code: ECONNREFUSED)
 *    第一版只读 `err.message`，于是 DNS 错和端口没人听都显示成
 *    "请求失败：fetch failed" —— 等于什么也没说，正是这个函数要避免的事情。
 *    `cause` 还可能再嵌一层，所以顺着链找。
 */
function errorChain(err) {
  const parts = [];
  let cur = err;
  for (let i = 0; i < 5 && cur; i++) {
    // name 也要收进来：超时的错误类型是 `TimeoutError`，而它的 message
    // 有时候只是干巴巴的 "x"，光看 message 认不出是超时（实测踩到过）。
    if (cur.name && cur.name !== 'Error' && cur.name !== 'TypeError') parts.push(String(cur.name));
    if (cur.message) parts.push(String(cur.message));
    if (cur.code) parts.push(String(cur.code));
    if (cur.errno !== undefined && cur.errno !== null) parts.push(String(cur.errno));
    cur = cur.cause;
  }
  return parts.join(' | ');
}

/**
 * 把上游/网络的错误翻译成用户看得懂的话。
 * 和 `ocrFailureMessage()` 同一个思路：底层错误码对用户等于没说话。
 */
export function aiFailureMessage(err) {
  const m = errorChain(err);
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) {
    return '连不上这个地址 —— 检查「接口地址」有没有写错，以及电脑是否能上网。';
  }
  if (/ECONNREFUSED/i.test(m)) {
    return '对方拒绝了连接 —— 如果填的是本机地址（比如 Ollama），确认那个程序正在运行。';
  }
  if (/ECONNRESET/i.test(m)) {
    return '连接被中途断开了 —— 可能是网络不稳，或对方限制了这次请求。稍后再试。';
  }
  if (/ETIMEDOUT|timeout|aborted|TimeoutError/i.test(m)) {
    return '请求超时了。可以换一个更快的模型，或在设置里把超时时间调大。';
  }
  if (/certificate|self.signed|UNABLE_TO_VERIFY/i.test(m)) {
    return '证书验证失败 —— 这个地址可能不是 https，或者证书有问题。';
  }
  if (/\b401\b|unauthorized|invalid.api.key|incorrect api key/i.test(m)) {
    return '密钥不对（401）—— 到「设置 → AI」里重新粘贴一次，注意别把空格带进去。';
  }
  if (/\b403\b|forbidden/i.test(m)) {
    return '密钥没有权限（403）—— 检查这个密钥是否开通了要用的模型。';
  }
  if (/\b404\b|not found/i.test(m)) {
    return `接口地址不对（404）—— 这个路径不存在。${BASE_URL_HINT}`;
  }
  if (/\b429\b|rate.?limit|quota/i.test(m)) {
    return '请求太频繁或额度用完了（429）—— 等一会儿再试，或去服务商后台看看余额。';
  }
  if (/\b5\d\d\b/.test(m)) {
    return '对方服务器出错了（5xx）—— 这不是你的问题，稍后再试。';
  }
  // 兜底：如果是个 HTTP 状态码（上游返回了非 2xx），至少把码说出来并给出最可能的解释。
  // 为什么单列这一条：实测把地址指向一个真实存在但**不是** chat 接口的服务时，
  // 上游回了 405，而上面的关键词都没命中，用户只看到"请求失败：405"。
  const hm = m.match(/\b([45]\d\d)\b/);
  if (hm) {
    return `上游返回了 ${hm[1]} —— 这个地址多半不是 OpenAI 兼容的对话接口。${BASE_URL_HINT}`
      + '同时也确认一下模型名填对了。';
  }
  return `请求失败：${m || '原因不明'}`;
}

/** 只保留最近几条对话，避免越聊越长把上下文撑爆（也就越省钱） */
export function trimHistory(history, maxTurns = 6) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-maxTurns * 2);
}
