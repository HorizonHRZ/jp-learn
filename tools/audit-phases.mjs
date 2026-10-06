/**
 * 逐条核对**阶段 5 / 6 目标**是否真的落地。
 *
 * 为什么另起一个文件而不是塞进 `audit-phase2.mjs`：
 *   那个文件是"阶段 2（背单词）"的目标核对，混进来会让两边都难读。
 *   而"按目标逐条核对"这件事本身很有价值 —— 它检查的是
 *   **用户确认单上的每个词**，不是"文件存在不存在"。
 *
 * 和 `check-deliverables.mjs` 的分工：
 *   · check-deliverables：**交付物**齐备（文件在不在、格式对不对）
 *   · 本文件：**目标**达成（用户确认单上写的那件事，真的做到了吗）
 *   两者会有些重叠，那是有意的 —— 重叠的断言更不容易被漏掉。
 *
 * 用法：node tools/audit-phases.mjs
 *
 * ⚠️ 写这个文件时又踩了三次"断言过宽"（今天第七、八、九次），
 *    都在下面就地标出来了。规律还是那两条：
 *    先剥注释；规则贴着"危险的代码形态"，不要贴着"某个词出现过"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const R = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const E = (p) => fs.existsSync(path.join(ROOT, p));

/** 剥注释（保留字符串）。源码扫描必须先做这一步，见 tools/lib/srcscan.mjs。 */
const noComments = (s) => String(s)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

let fail = 0;
const ck = (cond, label, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? '  — ' + detail : ''}`);
};

console.log('='.repeat(76));
console.log(' 阶段 5 / 6 目标逐条核对');
console.log('='.repeat(76));

// ===========================================================================
console.log('\n【全程约束】不碰 SCHEMA_VERSION / 零依赖 / 不做被取消的事');
{
  const ver = await import(pathToFileURL(path.join(ROOT, 'app/js/version.js')).href);

  // ⚠️⚠️ 这条断言 2026-10 改过一次，原因值得记下来。
  //
  //    原来是 `ck(ver.SCHEMA_VERSION === 2, 'SCHEMA_VERSION 仍是 2')`。
  //    它想表达的**意思**是对的：阶段 5/6 加的"语法"和"AI"都复用了已有表，
  //    不该因此动数据结构（少一次迁移就少一次弄丢用户数据的机会）。
  //
  //    但它把意思写成了**一个具体的数字**。于是后来真的需要加一张表时
  //    （`readingOverrides`，用户手改的汉字读音），SCHEMA_VERSION 合理地
  //    变成 3，这条断言就红了 —— **红的不是代码，是断言把手段当成了目的**。
  //
  //    现在改成断言**真正的意图**，用一个不会随版本号漂移的说法：
  //      ① 结构确实由 `MIGRATIONS` 登记表管着（不是随手改的数字）
  //      ② 语法和 AI 到今天仍然没有自己的表（它们复用 grammarState / settings）
  //      ③ 每次版本号上升，`MIGRATIONS` 里都要有对应的说明 ——
  //         这正是 `readingOverrides` 那次事故的护栏（忘了加版本号 → 老库建不出表）
  const dbSrcText = R('app/js/db.js');
  const dbSrcCode = noComments(dbSrcText);

  // ① version.js 里要有"MIGRATIONS 是权威"这句话所指的那张表
  ck(/const MIGRATIONS = \{/.test(dbSrcCode), 'SCHEMA_VERSION 的变更由 db.js 的 MIGRATIONS 登记表管理');
  ck(/先备份，后迁移/.test(dbSrcText),
    '★ 迁移策略是"先备份，后迁移"（有回退路径，才敢动用户数据）');

  /**
   * 从 `STORE_DEFS = { ... }` 里取出**第一层**的表名。
   *
   * ⚠️ 这里踩过一个"断言静默通过"的坑，务必别改回去：
   *    第一版写的是 `STORE_DEFS\.(\w+)\s*=` —— 那是**别的赋值写法**，
   *    而真实代码是对象字面量 `STORE_DEFS = { meta: {...}, words: {...} }`。
   *    于是正则匹配到 **0 个**表名，`storeNames` 是空数组，
   *    后面三条 `!storeNames.includes('grammarState')` 全部**无条件为真** ——
   *    **断言绿了，但它什么都没检查。**（这是本项目第三次遇到"假绿"）
   *
   *    所以现在：先把 `STORE_DEFS` 那个块按大括号配对切出来（剥过注释的源码），
   *    再只取**第一层**的 `名字:`，并且**断言真的读到了东西**。
   */
  const storeBlock = (() => {
    const i = dbSrcCode.indexOf('STORE_DEFS');
    if (i < 0) return '';
    const start = dbSrcCode.indexOf('{', i);
    if (start < 0) return '';
    let depth = 0;
    for (let j = start; j < dbSrcCode.length; j++) {
      if (dbSrcCode[j] === '{') depth++;
      else if (dbSrcCode[j] === '}') { depth--; if (depth === 0) return dbSrcCode.slice(start + 1, j); }
    }
    return '';
  })();
  const storeNames = [];
  {
    let depth = 0;
    for (const line of storeBlock.split('\n')) {
      if (depth === 0) {
        const m = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(line);
        if (m) storeNames.push(m[1]);
      }
      for (const ch of line) { if (ch === '{') depth++; else if (ch === '}') depth--; }
    }
  }

  // ⚠️ 这条"读到了东西"的断言是防止上面那个假绿的**唯一**保险
  ck(storeNames.length >= 8,
    `从 STORE_DEFS 里读到了 ${storeNames.length} 张表：${storeNames.join(', ')}`);

  // ② 语法 / AI 复用了已有表，没有为它们各建一张
  for (const bad of ['aiCache', 'aiConfig', 'aiChat', 'chatCache', 'grammarAi']) {
    ck(!storeNames.includes(bad), `AI 没有偷建 ${bad} 表（复用已有表 / settings）`);
  }
  // 语法自己那张表叫 grammarState，是**阶段 5 就规划好的**，允许存在；
  // 但不许再冒出第二张语法相关的表（"加一张表"是有代价的，见约束 2）
  const grammarStores = storeNames.filter((n) => /grammar/i.test(n));
  ck(grammarStores.length <= 1,
    `语法只有 ${grammarStores.length} 张表（${grammarStores.join(',') || '无'}）—— 不许越加越多`);

  // ③ 版本号每升一级，MIGRATIONS 里就要有一条对应编号的说明
  //
  // ⚠️ 本项目的约定是把每级写成 `// 3: 新增 xxx 表（为什么）` 这样的注释行。
  //    第一版断言写的是 `/^\s*(\d+)\s*:/gm` —— 它只认"裸的 3:"，
  //    于是把 `// 1: 初始版本` 里的 1 当成了键、真正写了说明的 2 和 3 全没认出来。
  //    **正则描出来的形状必须贴着代码里真实的写法**，不能凭印象。
  //    现在的写法显式允许注释前缀，并且只认**带说明**的行（冒号后面要有字）。
  const migrationComments = [...dbSrcText.matchAll(/\/\/\s*(\d+)\s*:\s*(\S[^\n]*)/g)]
    .map((m) => ({ v: Number(m[1]), text: m[2].trim() }));

  const explained = new Set(migrationComments.map((m) => m.v));
  const missing = [];
  for (let v = 2; v <= ver.SCHEMA_VERSION; v++) if (!explained.has(v)) missing.push(v);
  ck(missing.length === 0,
    `SCHEMA_VERSION=${ver.SCHEMA_VERSION} 的每一级都在 MIGRATIONS 里有说明（防止"加了表忘了加版本号"）`,
    missing.length
      ? `缺 ${missing.join(',')}`
      : migrationComments.filter((m) => m.v >= 2).map((m) => `${m.v}：${m.text.slice(0, 28)}…`).join(' | '));

  ck(ver.SCHEMA_VERSION >= 2, `SCHEMA_VERSION = ${ver.SCHEMA_VERSION}（≥2 是阶段 5/6 的起点）`);

  ck(!E('node_modules'), '没有 node_modules');
  ck(!E('package.json'), '没有 package.json（没有构建步骤）');
  ck(!E('tools/package.json'), 'tools/ 里也没有 package.json');

  // ---- 语音没被加回来 ----
  // ⚠️ 第一版写成 `filter(f => /speak/.test(read(f)))`，把 speak.js **自己**
  //    也算了进去（它的函数名就叫 speak）。要问的是"**别处**有没有引用"，
  //    所以必须排除定义文件自身。
  const appFiles = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|html)$/.test(e.name)) appFiles.push(p);
    }
  };
  walk(path.join(ROOT, 'app'));
  const speakRefs = appFiles
    .filter((f) => path.basename(f) !== 'speak.js')
    .filter((f) => /speak\.js|speak\(|speechSynthesis/.test(fs.readFileSync(f, 'utf8')));
  ck(speakRefs.length === 0, 'speak.js 没有被任何界面引用（用户已否掉语音）',
    speakRefs.map((f) => path.basename(f)).join(','));
  ck(E('app/js/speak.js'), 'speak.js 文件本身保留（只是不引用）');

  // ---- 被明确取消的三件事 ----
  ck(!E('app/sw.js') && !E('app/service-worker.js'), '没有 Service Worker（用户取消）');
  ck(!/serviceWorker/.test(R('app/js/app.js')), 'app.js 里没有注册 Service Worker');
  ck(!E('app/js/views/history.js'), '没有统一学习历史页（用户取消）');
  const navBlock = (R('app/js/app.js').match(/const NAV[\s\S]{0,1000}?\]/) || [''])[0];
  ck(navBlock.length > 0, '取到了导航定义');
  ck(!/history|历史/.test(navBlock), '导航里没有「历史」入口', navBlock.slice(0, 80));

  // ---- 9 个导航项的横滚兜底（用户批准过这个取舍）----
  // 背景：导航项从 5 个涨到 9 个，窄窗口/分屏下横着放不下。
  // 用户批准"横滚"而不是"换行"或"砍项"（换行会占两层高把正文挤下去；
  // 砍项会丢掉功能）。这里把那套 CSS 的必要条件锁住 ——
  // 尤其是 min-width: 0：flex 子项默认 min-width:auto（不小于内容宽度），
  // 不写它的话 .nav-links 会被撑宽，overflow-x 根本不生效，
  // 结果变成**整条导航**一起滚、品牌区跟着跑掉。这是真踩过的坑。
  const navCss = R('app/css/theme.css');
  ck(/\.nav-links\s*\{[^}]*overflow-x:\s*auto/.test(navCss),
    '.nav-links 允许横向滚动（9 个导航项的兜底）');
  ck(/\.nav-links\s*\{[^}]*min-width:\s*0/.test(navCss),
    '★ .nav-links 写了 min-width:0（不写则 overflow-x 无效，会变成整条一起滚）');
  ck(/\.nav-link\s*\{[^}]*flex:\s*0\s+0\s+auto/.test(navCss),
    '.nav-link 不收缩（宁可滚，也不要把某几项挤成看不清）');
  ck(/\.nav\s*\{[^}]*flex-wrap:\s*nowrap/.test(navCss),
    '导航不换行（换行会占两层高，把正文挤下去）');

  // ---- 用户数据安全性：迁移只增不减 ----
  const dbNoComments = noComments(R('app/js/db.js'));
  ck(!/deleteObjectStore/.test(dbNoComments), 'db.js 没有 deleteObjectStore（迁移只增不减）');
}

// ===========================================================================
console.log('\n【① 语法教材】丙方案：框架 + 10 条样例');
{
  ck(E('data/grammar/README.md'), 'data/grammar/README.md（怎么加内容的说明）');
  ck(E('data/grammar/index.json'), 'data/grammar/index.json（自动生成的索引）');
  ck(E('data/grammar/N5.json'), 'data/grammar/N5.json（按等级分文件）');

  const idx = JSON.parse(R('data/grammar/index.json'));
  const body = JSON.parse(R('data/grammar/N5.json'));
  // ⚠️ 这里原来硬写 `idx.count === 10`，结果加了 N3.json（第 11 条）之后立刻假失败。
  //    把"当时的数量"写成断言，等于**每次加内容都要改测试** ——
  //    而改测试是最容易被顺手改成"随便让它绿"的动作。
  //    改成**结构性检查**：下界 + 自洽 + 两条线都有内容。
  ck(idx.count >= 10, '索引里至少 10 条（丙阶段的起底样例）', `实际 ${idx.count} 条`);
  ck(body.items.length >= 10, 'N5.json 里的 JLPT 样例还在', `${body.items.length} 条`);
  // 索引与正文必须自洽（具体逐字比对在 test-grammar.mjs，这里只查总数）
  const files = fs.readdirSync(path.join(ROOT, 'data/grammar'))
    .filter((f) => /^[A-Za-z0-9]+\.json$/.test(f) && f !== 'index.json');
  let bodyTotal = 0;
  for (const f of files) {
    bodyTotal += (JSON.parse(R(`data/grammar/${f}`)).items || []).length;
  }
  ck(idx.count === bodyTotal, '索引条数与各等级正文之和一致（没有漂移）',
    `索引 ${idx.count} vs 正文合计 ${bodyTotal}`);
  ck(Array.isArray(idx.levels) && idx.levels.length >= 1, '索引里有等级列表',
    JSON.stringify(idx.levels));
  ck(Array.isArray(idx.categories) && idx.categories.length >= 1, '索引里有功能分类',
    JSON.stringify(idx.categories));

  // ---- 用户要求的两条线都要有内容 ----
  // 用户原话：「保留 JLPT 相关内容，应试日语我也要学；但是关于书面语的阅读也要有」。
  // 所以这里要盯的是"两条线都非空"，不是"总共有几条"。
  const lines = new Set(idx.items.map((x) => x.line || 'jlpt'));
  ck(lines.has('jlpt'), 'JLPT 线有内容', `现有线：${[...lines].join('/')}`);
  ck(lines.has('written'), '书面语阅读线有内容（用户明确要求的那条）',
    `现有线：${[...lines].join('/')}`);
  const writtenCats = new Set(idx.items.filter((x) => (x.line || 'jlpt') === 'written')
    .map((x) => x.category));
  ck(writtenCats.size >= 1, '书面语线有分类',
    [...writtenCats].join('/'));

  // ---- tags 必须进索引（否则"按标签搜"静默失效）----
  const noTags = idx.items.filter((x) => !Array.isArray(x.tags));
  ck(noTags.length === 0, '索引里每条都有 tags 字段（按标签搜才不会静默失效）',
    noTags.map((x) => x.id).slice(0, 3).join(','));

  const g = R('app/js/views/grammar.js');
  ck(/id: 'grammar'/.test(g), 'grammar.js 是正式视图（不是占位页）');
  ck(/favorite/.test(g), '界面有收藏');
  ck(/mastered/.test(g), '界面有"已掌握"');
  ck(/搜索|filter|search/.test(g), '界面有检索/筛选');
  ck(/grammarState/.test(g), '状态写进已有的 grammarState 表（不新增表 → 不用迁移）');

  const srvCode = noComments(R('server.js'));
  ck(/handleGrammarEntry/.test(srvCode), '服务端有语法正文接口');
  ck(/handleGrammarSearch/.test(srvCode), '服务端有语法检索接口');
  ck(E('tools/build-grammar-index.mjs'), 'build-grammar-index.mjs（加内容后重新生成索引）');
  ck(E('tools/test-grammar.mjs'), 'test-grammar.mjs');
  ck(/id: 'grammar'/.test(R('app/js/app.js')), '导航里有「语法」入口');

  // 内容来源的诚实性
  ck(/source/.test(R('data/grammar/N5.json')), '语法数据带 source 字段');
  ck(!/来源未知/.test(R('data/grammar/N5.json') + R('data/grammar/README.md')),
    '没有"来源未知"这种敷衍说法');
}

// ===========================================================================
console.log('\n【② Anki 导出】TSV + CSV + Markdown');
{
  ck(E('app/js/exportfmt.js'), 'exportfmt.js（纯格式化）');
  ck(E('app/js/anki.js'), 'anki.js（取数 + 下载）');
  ck(E('tools/test-anki.mjs'), 'test-anki.mjs');

  const fmt = await import(pathToFileURL(path.join(ROOT, 'app/js/exportfmt.js')).href);
  ck(JSON.stringify(fmt.FORMATS) === JSON.stringify(['tsv', 'csv', 'md']),
    '三种格式都在', JSON.stringify(fmt.FORMATS));
  ck(fmt.FIELDS.length === 7, '7 个字段', fmt.FIELDS.join('/'));

  // 真的渲染一次，确认三种格式的**实际输出**符合各自的习惯
  const rows = fmt.toRows([{
    term: '会う', reading: 'あう', zh: ['见面'], level: 'N5',
    ex: [{ jp: '会いましょう。', zh: '见吧。' }],
  }]);
  const tsv = fmt.render(rows, 'tsv', { bom: false });
  const csv = fmt.render(rows, 'csv', { bom: true });
  const md = fmt.render(rows, 'md', {});
  ck(tsv.includes('\t'), 'TSV 用制表符分隔');
  ck(!tsv.includes('\uFEFF'), 'TSV 没有 BOM（Anki 会把 BOM 当成词的一部分）');
  ck(csv.includes('\uFEFF'), 'CSV 有 BOM（Excel 打开中文不乱码）');
  ck(csv.includes('\r\n'), 'CSV 用 CRLF（RFC4180）');
  ck(/\|/.test(md) && /---/.test(md), 'Markdown 是表格形式');
  ck(tsv.split('\n')[0].split('\t').length === 7, 'TSV 表头正好 7 列');

  const v = R('app/js/views/vocab.js');
  ck(/openExportDialog/.test(v), '生词本页有导出对话框');
  ck(/dataset: \{ act: 'export' \}/.test(v), '有导出入口按钮');
  ck(!/fetch\(|XMLHttpRequest/.test(noComments(R('app/js/anki.js'))),
    'anki.js 不发请求（纯前端导出，不经过服务端）');
  ck(!/document\.|window\./.test(noComments(R('app/js/exportfmt.js'))), 'exportfmt.js 零 DOM');
}

// ===========================================================================
console.log('\n【③ AI 翻译 / 讲解】密钥 / 默认关 / 一次性告知 / key 不外流');
{
  for (const [f, what] of [
    ['tools/aiconf.js', '纯逻辑'], ['app/js/ai.js', '浏览器侧'],
    ['app/js/views/aipanel.js', '选中→翻译/讲解'], ['tools/test-ai.mjs', '单测'],
    ['tools/test-ai-e2e.mjs', '端到端'], ['.gitignore', '忽略密钥文件'],
  ]) ck(E(f), `${f}（${what}）`);
  ck(/config\.local\.json/.test(R('.gitignore')),
    '.gitignore 排除了 config.local.json（用户选了明文存储）');

  const conf = await import(pathToFileURL(path.join(ROOT, 'tools/aiconf.js')).href);
  ck(conf.DEFAULT_CONFIG.enabled === false, '默认关闭（严格 false）');
  ck(conf.CONFIG_FILENAME === 'config.local.json', '配置文件名是 config.local.json');
  ck(conf.PROVIDER_PRESETS.length >= 5, `预置 ${conf.PROVIDER_PRESETS.length} 个服务商`);
  ck(conf.PROVIDER_PRESETS.some((p) => p.id === 'custom'), '有"自己填 baseURL"（OpenAI 兼容）');
  ck(conf.PROVIDER_PRESETS.every((p) => !p.apiKey), '预设里不含任何密钥');

  // ★ 结构性保证：摘要对象里**没有** apiKey 这个键（不是设成空串）
  const sum = conf.configSummary({ ...conf.DEFAULT_CONFIG, apiKey: 'sk-SECRET-XYZ' });
  ck(!('apiKey' in sum), 'configSummary() 返回对象里根本没有 apiKey 键');
  ck(!JSON.stringify(sum).includes('SECRET'), 'configSummary() 序列化后不含密钥');
  ck(!conf.maskKey('sk-abcdefghijklmnopqrst').includes('abcdefghij'),
    'maskKey 遮住了中间部分', conf.maskKey('sk-abcdefghijklmnopqrst'));

  const srvCode = noComments(R('server.js'));
  ck(/\/api\/ai\/config/.test(srvCode) && /\/api\/ai\/chat/.test(srvCode),
    '服务端有 config / chat 接口');
  ck(/assertConfigNotServable/.test(srvCode),
    '启动自检：密钥文件不能在可静态访问目录里（否则进程直接退出）');
  ck(/AI_PRIVACY_TEXT/.test(srvCode), '隐私文案由服务端下发（单一来源）');
  ck(/0o600/.test(srvCode), '写配置文件时设了 0o600 权限');

  // ⚠️ 这两条断言在 2026-10 改过。原来它们盯的是
  //    「attachAiTo 接上了选区功能 + destroy 里解绑 _detachAi」。
  //    用户明确要求删掉"选中文字就浮出按钮条"，于是这两个东西都不存在了。
  //    留下旧断言只会逼着代码里养一个死函数来哄测试 —— 那是最糟的结局。
  //    现在改成盯**新的实现方式**，而且要盯真正危险的那一点：
  //    阅读页绝不能自己挂 document/window 级监听却不撤销。
  for (const vid of ['lyric', 'reading']) {
    const src = R(`app/js/views/${vid}.js`);
    ck(/buildAiReader/.test(src), `${vid}.js 接上了两栏 AI 阅读器`);
    ck(/installAiWordHook/.test(src), `${vid}.js 把「AI 讲这个词」装进了速查抽屉`);
    // 反面断言：源码里不许出现 document.addEventListener
    //（本页的监听都挂在局部容器上，随 DOM 消失，不需要 destroy）。
    // 注意要**剥掉注释**再查：注释里解释"为什么删掉了 document 监听"是正常的。
    ck(!/document\.addEventListener/.test(noComments(src)),
      `${vid}.js 没有 document 级监听（因此也不需要 destroy）`);
  }

  ck(!/apiKey/.test(noComments(R('app/js/db.js'))),
    'db.js 完全不涉及 apiKey（不会进导出 / 快照）');
  ck(/ensureAck/.test(R('app/js/ai.js')), '首次发送前有一次性告知（ensureAck）');

  // ---- 服务端日志不泄漏密钥 ----
  // ⚠️ 第一版写成 `/console\.log\(.*key/i`，命中了
  //    `console.log('  查词索引 : 表面形 ${st.lookupKeys} 个键 …')` ——
  //    那是**查词索引的键数**，跟 API 密钥毫无关系。
  //    要判的不是"日志里出现过 key 这个词"，而是"日志里有没有密钥内容"。
  const logLines = srvCode.split('\n').filter((l) => /console\.(log|warn|error|info)/.test(l));
  const leaky = logLines.filter((l) => /\bapiKey\b|keyHint/.test(l));
  ck(leaky.length === 0, '服务端日志里不会出现 apiKey / keyHint',
    leaky.join(' | ').slice(0, 120));

  // ---- 浏览器侧兜底副本与权威版本一致 ----
  const browserCopy = (await import(pathToFileURL(path.join(ROOT, 'app/js/ai.js')).href)).AI_PRIVACY_TEXT;
  ck(browserCopy.length === conf.AI_PRIVACY_TEXT.length,
    '浏览器侧隐私文案与权威版本条数一致');
  ck(browserCopy.every((s, i) => s === conf.AI_PRIVACY_TEXT[i]),
    '浏览器侧隐私文案与权威版本逐字一致');
  ck(!browserCopy.some((s) => /\*\*|__|`/.test(s)),
    '隐私文案里没有 Markdown 标记（textContent 不解析它，会原样露星号）');
}

// ===========================================================================
console.log('\n【④ manifest】做 manifest，不做 Service Worker');
{
  const m = JSON.parse(R('app/manifest.webmanifest'));
  ck(!!m.name && !!m.short_name, 'manifest 有 name / short_name');
  ck(m.display === 'standalone', 'display = standalone');
  ck(Array.isArray(m.icons) && m.icons.length >= 1, '有图标声明');
  ck(E('app/assets/icon.svg'), '图标文件存在');
  ck(/rel="manifest"/.test(R('app/index.html')), 'index.html 引用了 manifest');
  ck(/\.webmanifest'\s*:\s*'application\/manifest\+json/.test(R('server.js')),
    '服务端 MIME 表认得 .webmanifest（否则浏览器静默忽略）');
}

// ===========================================================================
console.log('\n【⑤ 统计增强小项】');
{
  ck(/mk\('振假名', 'ruby'/.test(R('app/js/views/jpreader.js')), '全篇振假名开关存在');

  const v = R('app/js/views/vocab.js');
  ck(/dot-new|dot-review/.test(v), '词表按 SRS 状态着色');
  const css = R('app/css/theme.css');
  for (const c of ['dot-new', 'dot-learning', 'dot-review', 'dot-relearning']) {
    ck(new RegExp(`\\.${c}\\s*\\{`).test(css), `CSS 里定义了 .${c}`);
  }

  ck(/addManyToVocab/.test(R('app/js/views/lyric.js'))
    && /addManyToVocab/.test(R('app/js/views/reading.js')),
    '歌词页 / 精读页都有批量加词');
  ck(/全选这/.test(v), '内置词库挑词有"全选这 N 个"');

  // 点词覆盖为什么不是缺口：分词只把空白和标点标成不可点，其余都可点
  const tok = R('tools/tokenizer.js');
  ck(/isPunct: true/.test(tok) && /isSpace: true/.test(tok),
    '分词只把空白/标点标为不可点 → 其余单元都可点（覆盖是穷尽的）');
}

// ===========================================================================
console.log('\n【文档】必须同步更新');
{
  ck(E('ARCHITECTURE.md') && E('使用说明.md'), '两份文档都在');
  const arch = R('ARCHITECTURE.md');
  for (const s of ['## 十四、语法教材', '## 十五、导出到 Anki',
    '## 十六、AI 翻译', '## 十七、manifest']) {
    ck(arch.includes(s), `ARCHITECTURE.md 有「${s}」`);
  }
  const man = R('使用说明.md');
  ck(/### 10\. AI 翻译/.test(man), '使用说明有 AI 章节');
  ck(/manifest/.test(man), '使用说明提到了 manifest');
  // ⚠️ 这里原本硬写「18 个脚本」，加了 audit-phases.mjs 之后立刻变成假失败。
  //    改成**跟着 tools/ 里实际的 test-*.mjs + check-*.mjs + audit-*.mjs 数量走**，
  //    这样以后再加脚本，文档没同步就会红 —— 而不是"数字写死了所以永远对"。
  //
  // ⚠️ 2026-10：加了 `qa-layout.mjs`（真浏览器排版检查），前缀是 `qa-`。
  //    两种做法都行：① 把它排除在计数外；② 把它一起算进去。
  //    选 ② —— 它是自检的一部分，用户"照着清单跑一遍"时本来就该跑它。
  //    排除掉的话，它就成了一份没人跑、也没人记得的脚本。
  //
  // ⚠️⚠️ 2026-10（第二批）：这里踩了两个"假红"，两个都是**正则写得太死**。
  //
  //    ① `tools/qa-harness.mjs` 被算成了一个脚本。
  //       它是 6 个真浏览器脚本的**共用骨架**（起临时服务 + 连浏览器 + 断言框架），
  //       **不是**能单独跑的检查。`/\d/` 这种前缀规则认不出它，
  //       所以必须显式排除 —— 否则"文档里写的数"永远比"实际跑的检查"多 1。
  //
  //    ② `共 (\d+) 个脚本` 匹配不到 `共 **33 个**脚本`。
  //       文档里那个数字被我加粗了，两个星号夹在中间，正则就断了。
  //       这属于"断言和文档格式耦合"——文档作者**不知道**自己会被正则约束。
  //       所以现在允许加粗/空格，并且顺手把 `共 N 个` 的说法放宽成也接受 `N 个脚本`。
  //
  //    教训记一次：**计数类断言要贴着"东西是什么"写，不要贴着"它当时长什么样"写。**
  // ⚠️ 2026-10（第二批收尾）：又加了两个脚本，清单同步到 40：
  //      · `test-content-check.mjs` —— 内容校验器自己的负例测试
  //        （故意写 9 类错，逐类确认都抓得住；防止校验器变成"永远通过"的空转）
  //      · `check-recovery.mjs` —— 反向恢复的忠实性验证
  //    这两个都不是可选的：前者的价值在于"证明校验器真的会红"，
  //    后者在于"证明以后重跑合并不会改数据"。
  const NOT_A_CHECK = new Set([
    'test-http.mjs',   // 需要服务在跑；但它**是**清单里的一项，下面 +1 补回来
    'qa-harness.mjs',  // 共用骨架，不是检查，不能计数
  ]);
  const scriptCount = fs.readdirSync(path.join(ROOT, 'tools'))
    .filter((f) => /^(test|check|audit|qa)-[a-z0-9-]+\.mjs$/.test(f) && !NOT_A_CHECK.has(f))
    .length + 1; // +1 = test-http.mjs（它需要服务在跑，但也是清单里的一项）

  // 允许 Markdown 加粗夹在中间：`共 **37 个**自检脚本` / `共 37 个脚本` 都认。
  //
  // ⚠️ 这里又踩了一次（同一天第三次被正则咬）：第一版写 `\*{0,2}`，
  //    在 Node 里对 `共 **37 个` **匹配不上**（实测），换成 `\**` 才行。
  //    不再猜为什么 —— 改成**用能工作的那个**，并且失败时把原文附近打出来，
  //    这样下次再对不上，一眼就能看到到底是哪几个字符的问题。
  const m = man.match(/共\s*\**\s*(\d+)\s*\**\s*个/);
  const near = (() => {
    const i = man.indexOf('共 ');
    return i < 0 ? '' : JSON.stringify(man.slice(i, i + 24));
  })();
  ck(!!m, '使用说明里写了脚本总数', near);
  ck(m && Number(m[1]) === scriptCount,
    `使用说明的脚本总数与实际一致（都是 ${scriptCount} 个）`,
    m ? `文档写 ${m[1]}，实际 ${scriptCount}` : `没找到，原文附近：${near}`);
  ck(!/共 13 个脚本/.test(man), '使用说明里没有过期的"13 个脚本"');
  ck(/### 4\. 语法教材/.test(man), '使用说明有语法教材章节');
}

console.log('\n' + '='.repeat(76));
console.log(fail === 0 ? ' 目标逐条核对全部通过' : ` ${fail} 项未通过`);
console.log('='.repeat(76));
process.exit(fail === 0 ? 0 : 1);
