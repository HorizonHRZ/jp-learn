/**
 * 设置：数据与显示。
 * 这一页是 ARCHITECTURE.md 约束 3 的界面部分：
 *   一键导出 JSON / 导入恢复 / 自动快照（保留最近 N 份）/ 清空必须二次确认且先强制备份。
 * 所有操作都在本机浏览器里完成，不经过任何服务器。
 *
 * ⚠️ 唯一的例外是「AI 翻译/讲解」那一块：它**确实会联网**。
 *    但密钥仍然不经过浏览器存储 —— 它由服务端读写 `config.local.json`，
 *    浏览器只拿到一个遮罩后的提示。见 `renderAiCard()` 的注释。
 */
import {
  el, clear, humanBytes, humanTime, humanAgo, toast, toastOk, toastWarn, toastError,
  modal, confirmDialog, confirmTwice, progressBar,
} from '../ui.js';
import * as db from '../db.js';
import { APP_VERSION, SCHEMA_VERSION } from '../version.js';
import { getAiConfig, saveAiConfig, testAiConnection, getAck, setAck, AI_PRIVACY_TEXT } from '../ai.js';

const STORE_LABELS = {
  meta: '系统信息', settings: '设置', words: '生词本', srs: 'SRS 排程',
  reviews: '答题记录', mistakes: '错题本', imports: '词表导入记录',
  lyrics: '歌词笔记', readings: '精读笔记', grammarState: '语法学习状态', snapshots: '数据快照',
};

export default {
  id: 'settings',
  title: '数据与设置',

  async render(root) {
    root.appendChild(el('h2', { text: '数据与设置' }));

    // ================= 一、数据安全说明 =================
    root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [el('h3', { text: '你的数据在哪' })]),
      el('p', { text: '全部用户数据（进度、SRS 排程、历史、生词本、错题本、笔记）只保存在这台电脑的浏览器里，' +
                     '数据库名 jp-learn（IndexedDB）。' }),
      // ⚠️ 这里原来写的是"这些数据不会上传到任何地方"。
      //    加了 AI 之后这句话就**不准确**了，所以拆成"哪些绝不会动"和"哪些会出去"两段。
      //    含糊过去最省事，但用户正是靠这句话决定要不要存私人笔记的。
      //    另外：这是 el(..., {text})，走的是 textContent，**不能用 Markdown 的星号**，
      //    否则界面上会原样显示出 `**绝不会**` 六个字符加两个星号。
      // ⚠️ 这一段是**对用户数据的承诺**，必须和程序的实际行为一致。
      //    改过两次，每次都是因为行为变了：
      //      ① 加 AI 之前写的是"程序完全不联网、不上传" —— 加了 AI 就变成假话；
      //      ② 改成"只发你选中的那一小段" —— 后来加了「自动翻译全部段落」，
      //         一按那个按钮就会把每一段的日文正文依次发出去，又变成假话。
      //    所以现在按**两种触发方式**分别写清楚。含糊过去最省事，
      //    但用户正是靠这句话决定要不要存私人笔记的。
      //    另外：这是 el(..., {text})，走的是 textContent，**不能用 Markdown 的星号**，
      //    否则界面上会原样显示出 `**绝不会**` 六个字符加两个星号。
      el('p', { text: '生词本、学习进度、复习记录、笔记这些绝不会被发送到任何地方；' +
                     '本程序也不会自动获取任何外部内容。' }),
      el('p', { class: 'dim', text: '查词、注音、活用还原、精读解析、OCR 全部在本机完成，不需要联网。' }),
      el('p', { class: 'dim', text: '只有你自己启用 AI 之后才会联网，而且发出去的东西就两种：' +
                                     '① 你点「AI 讲这个词 / 讲这句」时，只发你点的那一小段；' +
                                     '② 你点「自动翻译全部段落」时，会把每一段的日文正文依次发出去。' +
                                     '两种都发给你自己填的 AI 地址，不会发给别人，也不会一次把整本书全发出去。' }),
      el('p', { class: 'dim', text: '因此：升级/覆盖 app/ 与 data/ 里的程序文件不会影响你的数据；' +
                                    '但清理浏览器数据、换浏览器、或重装系统会。' }),
      el('div', { class: 'banner banner-warn', style: { marginTop: '8px' } }, [
        el('strong', { text: '重要：下面的「快照」救不了浏览器数据被清理' }),
        el('div', { class: 'banner-hint', text: '快照和你的学习数据存在同一个数据库里，所以它能救「误操作」（删错词、导入错文件、清空数据）；' +
                                                  '但浏览器数据一被清理，快照会跟着一起没。唯一能跨过这种情况的是「导出备份」——' +
                                                  '导出成 JSON 文件存到你自己的硬盘或网盘上。' }),
      ]),
      el('div', { class: 'btn-row', style: { marginTop: '10px' } }, [
        el('button', { class: 'btn btn-primary', text: '① 立即导出备份', onclick: doExport }),
        el('button', { class: 'btn', text: '② 从文件导入恢复', onclick: doImportDialog }),
        el('button', { class: 'btn', text: '③ 立即创建快照', onclick: doManualSnapshot }),
        el('button', { class: 'btn btn-danger', text: '清空所有数据…', onclick: doWipe }),
      ]),
    ]));

    // ================= 一之二、备份状态（导出提醒） =================
    const exportHost = el('div', {});
    root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [el('h3', { text: '备份状态' })]),
      exportHost,
    ]));

    // ================= 二、当前数据状态 =================
    const selfHost = el('div', {});
    root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [
        el('h3', { text: '数据状态' }),
        el('button', { class: 'btn btn-sm', text: '重新检测', onclick: () => renderSelfCheck(selfHost) }),
      ]),
      selfHost,
    ]));

    // ================= 三、快照（已拆成独立页面） =================
    // 快照列表原本内嵌在这里，现已移到「快照备份」页（#/snapshots）。
    // 为什么拆走而不是两处都留：同一个列表放两个地方，以后改一处忘一处就会不一致。
    // 设置页只留入口 + 一句"它解决什么问题"，深内容在独立页里做。
    const snapSummaryText = el('p', { class: 'faint', style: { fontSize: '.84rem' } });
    root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [el('h3', { text: '数据快照' })]),
      el('p', { class: 'dim', text: '快照是"存档点"：程序定期自动把你全部学习数据整份存下来，' +
        '并在结构升级前、导入前、清空前各存一份。误操作可以靠它撤回。' }),
      snapSummaryText,
      el('div', { class: 'btn-row', style: { marginTop: '8px' } }, [
        el('a', { class: 'btn', href: '#/snapshots', text: '查看全部快照 →' }),
        el('button', { class: 'btn btn-sm', text: '立即创建快照', onclick: doManualSnapshot }),
      ]),
    ]));

    // ================= 四、显示设置 =================
    //
    // ⚠️ 这里原来有个"文字重复"的 bug（用户报的是"浅色浅色"），原因值得记：
    //
    //   `el(tag, attrs, children)` 的 `attrs.text` 会设置 `textContent`（ui.js:21），
    //   而第三个参数 `children` 会**追加**文本节点（ui.js:32）。
    //   原来两个都传了同一个字符串（`text: '浅色'` 之外，第三个参数又是 `'浅色'`）。
    //   结果 textContent='浅色' 之后再 append 一个 '浅色' 文本节点，
    //   渲染出来就是「浅色浅色」。
    //
    //   **两个参数做同一件事，写的人以为互为备份，实际是叠加。**
    //   修法：只留 `text`，第三个参数不传。
    //
    //   （`tools/check-render-patterns.mjs` 会机械扫描这种写法，防止再犯。
    //     注意：本注释里**故意不写出完整的调用示例** ——
    //     否则扫描脚本会把注释里的例子当成真的 bug 报出来。）
    //   顺带补了 `aria-pressed` —— 原来的"当前选中"只靠 CSS 的 `.active` 类，
    //   读屏软件完全不知道哪个是选中的（纯视觉状态）。
    const THEME_LABELS = { auto: '跟随系统', light: '浅色', dark: '深色' };
    const themeNow = document.documentElement.dataset.theme || 'auto';
    root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [el('h3', { text: '显示' })]),
      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', text: '主题' }),
        el('div', { class: 'segmented' }, ['auto', 'light', 'dark'].map((t) =>
          el('button', {
            class: themeNow === t ? 'active' : '',
            text: THEME_LABELS[t],
            'aria-pressed': themeNow === t ? 'true' : 'false',
            onclick: (e) => {
              document.documentElement.dataset.theme = t;
              try { localStorage.setItem('jp-learn.theme', t); } catch {}
              db.dbPut('settings', { key: 'theme', value: t }).catch(() => {});
              for (const b of e.target.parentNode.children) {
                const on = b === e.target;
                b.classList.toggle('active', on);
                b.setAttribute('aria-pressed', on ? 'true' : 'false');
              }
            },
          })
        )),
      ]),
    ]));

    // ================= 四之二、背单词 =================
    // 每天学几个新词是用户明确要求"能手动改"的数字，所以这里必须能改。
    // 今日页也放了一个「修改」入口，两边读写同一个设置项（dailyNewLimit）。
    //
    // 2026-10 补了「每日复习上限」(dailyReviewLimit)：复习量会随每天新学量
    // 累积（实测长期约等于每天新学量的 12 倍），之前完全没有上限，
    // 到期几百个就一次全摆出来。现在超出的顺延到明天。
    {
      const cur = await db.getSetting('dailyNewLimit');
      const curRev = await db.getSetting('dailyReviewLimit');
      const numInput = el('input', {
        class: 'input', type: 'number', style: { maxWidth: '120px' },
        min: String(db.DAILY_NEW_LIMIT_MIN), max: String(db.DAILY_NEW_LIMIT_MAX),
        value: String(cur),
      });
      const revInput = el('input', {
        class: 'input', type: 'number', style: { maxWidth: '120px' },
        min: String(db.DAILY_REVIEW_LIMIT_MIN), max: String(db.DAILY_REVIEW_LIMIT_MAX),
        value: String(curRev),
      });
      root.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, [el('h3', { text: '背单词' })]),
        el('div', { class: 'field' }, [
          el('label', { class: 'field-label', text: '每天学几个新词' }),
          el('div', { class: 'btn-row' }, [
            numInput,
            el('button', {
              class: 'btn btn-primary',
              onclick: async () => {
                // 钳位统一走 db.clampLimitInput（和「今日」页弹窗共用同一个公式）
                const v = db.clampLimitInput(numInput.value, db.DAILY_NEW_LIMIT_MIN, db.DAILY_NEW_LIMIT_MAX);
                if (v === null) { toastWarn('请填一个数字'); return; }
                await db.setSetting('dailyNewLimit', v);
                numInput.value = String(v);
                toastOk(`已保存：每天最多学 ${v} 个新词`);
              },
            }, '保存'),
          ]),
          el('div', { class: 'field-hint',
            text: `范围 ${db.DAILY_NEW_LIMIT_MIN}–${db.DAILY_NEW_LIMIT_MAX}，填 0 表示只复习不学新词。` +
                  '这是「每天」的总量：今天学够了就不会再给你新词。它只管新词，和下面的复习上限是两个独立的数字。' }),
        ]),
        el('div', { class: 'field' }, [
          el('label', { class: 'field-label', text: '每天最多复习多少个词' }),
          el('div', { class: 'btn-row' }, [
            revInput,
            el('button', {
              class: 'btn btn-primary',
              onclick: async () => {
                // 钳位统一走 db.clampLimitInput（和「今日」页弹窗共用同一个公式）
                const v = db.clampLimitInput(revInput.value, db.DAILY_REVIEW_LIMIT_MIN, db.DAILY_REVIEW_LIMIT_MAX);
                if (v === null) { toastWarn('请填一个数字'); return; }
                await db.setSetting('dailyReviewLimit', v);
                revInput.value = String(v);
                toastOk(`已保存：每天最多复习 ${v} 个词`);
              },
            }, '保存'),
          ]),
          el('div', { class: 'field-hint',
            text: `范围 ${db.DAILY_REVIEW_LIMIT_MIN}–${db.DAILY_REVIEW_LIMIT_MAX}。` +
                  '到期的词按逾期最久的优先排给你；额度用完的会顺延到明天，一个都不会漏。' }),
          el('div', { class: 'field-hint',
            text: '⚠️ 这一项和「每天学几个新词」要配着看：长期下来每天到期的量大约是每天新学量的 12 倍' +
                  '（每天学 10 个 → 每天约 120 个到期）。复习上限明显小于这个数的话，' +
                  '到期队列会一直增长、永远清不完 —— 这时「今日」页会给你具体建议。' }),
        ]),
        el('div', { class: 'field' }, [
          el('label', { class: 'field-label', text: '练习方式' }),
          el('div', { class: 'field-hint',
            text: '看日文单词选意思 / 看汉字选日文 / 看汉语意思手动输入日文。' +
                  '在「背单词 → 练习」页选择，整场练习只用你选的那一个方式。' }),
        ]),
      ]));
    }

    // ================= 四之二、AI 翻译 / 讲解（默认关闭） =================
    // 注意：右上角那个状态徽章**不写在这里**，由 renderAiCard() 自己建好再插进
    // `.card-title`。原因见那个函数里的注释（别用 id 在两个地方暗中约定）。
    const aiHost = el('div', {});
    root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [el('h3', { text: 'AI 翻译 / 讲解' })]),
      el('p', { class: 'dim', text: '开了这个功能之后，在歌词页和精读页：' +
                                    '点一个词 → 速查抽屉里有「AI 讲这个词」；' +
                                    '点每一句右上角的「⚙ 讲语法」→ 在那一句下方展开语法讲解；' +
                                    '阅读区右上角还有「自动翻译全部段落」，一键把中文栏填满。' }),
      aiHost,
    ]));

    // ================= 五、版本与许可证 =================
    root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [el('h3', { text: '版本与数据来源' })]),
      el('dl', { class: 'kv' }, [
        el('dt', { text: '应用版本' }), el('dd', { text: 'v' + APP_VERSION }),
        el('dt', { text: '数据结构版本' }), el('dd', { text: 'v' + SCHEMA_VERSION }),
        el('dt', { text: '程序目录' }), el('dd', { class: 'mono', text: 'app/ · server.js · tools/' }),
        el('dt', { text: '内置数据' }), el('dd', { class: 'mono', text: 'data/' }),
      ]),
      el('h4', { text: '第三方数据许可', style: { marginTop: '14px' } }),
      el('ul', { class: 'dim', style: { fontSize: '.86rem', paddingLeft: '20px' } }, [
        el('li', { text: 'jmdict-cn（中文释义为模型生成，非人工词典；JLPT 分级 / 中日对照例句）— CC BY-SA 4.0，基于 EDRDG JMdict' }),
        el('li', { text: 'yomitan-jlpt-vocab（JLPT 官方分级词表）— CC BY-SA 4.0，上游 Jonathan Waller (CC BY)' }),
        el('li', { text: 'kanjidic2（本程序未使用；汉字读音表由内置词表统计推导，仅供参考）' }),
      ]),
      el('p', { class: 'faint', style: { fontSize: '.82rem', marginTop: '8px' },
        text: '歌词与精读文本一律由你自己提供，本程序不连接任何歌词站点、不自动获取任何外部内容。' }),
      el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn btn-sm', text: '强制刷新页面', onclick: () => location.reload() }),
        el('a', { class: 'btn btn-sm', href: '/ARCHITECTURE.md', target: '_blank', text: '查看架构与硬约束' }),
      ]),
    ]));

    await renderSelfCheck(selfHost);
    await renderSnapSummary();
    await renderExportCard(exportHost, doExport);
    await renderAiCard(aiHost);

    // ================= 具体操作 =================

    /**
     * AI 设置卡。
     *
     * ⚠️ 这一块**和别的设置不一样**：它是唯一会真正联网的功能。
     *    所以界面上必须做到三件事，缺一不可：
     *      1. 默认关闭，且状态**一眼可见**（右上角那个徽章）
     *      2. 第一次真要发送之前，把"发出去的是什么"讲清楚，让用户点确认
     *      3. 密钥框显示的是**遮罩串**，用户不重新输入就不会改动已存的密钥
     *         （否则用户改个模型名就把密钥清空了 —— 这个坑很常见）
     *
     * 密钥本身**不进浏览器存储**：这里只是把它 POST 给本机服务端，
     * 由服务端写进 config.local.json。
     */
    async function renderAiCard(host) {
      clear(host);
      // 徽章**由这里自己建**，再插到卡片标题行里去。
      // 为什么不一开始就写在标题里、然后 getElementById 去找它：
      //   那样就是"两个地方靠一个 id 字符串暗中约定"，很脆 ——
      //   假 DOM 里视图没挂到 document 上时直接拿不到，真有节点改名也会静默失效。
      //   自己建、自己插，逻辑只有一处，测试里也照样能验证。
      const badge = el('span', { class: 'ai-badge', id: 'ai-state', text: '读取中…' });
      const titleRow = host.parentNode && host.parentNode.querySelector
        ? host.parentNode.querySelector('.card-title')
        : null;
      if (titleRow) titleRow.appendChild(badge);
      else host.appendChild(el('div', { class: 'btn-row', style: { marginBottom: '8px' } }, [badge]));

      let cfg = null;
      let presets = [];
      // 隐私说明用**服务端下发的**那份（单一来源在 tools/aiconf.js），
      // 拿不到才退回本地兜底副本。这样设置页和首次确认框的说法永远一致。
      let privacyLines = AI_PRIVACY_TEXT;
      try {
        const r = await getAiConfig();
        cfg = r.config;
        presets = (r.presets && r.presets.length) ? r.presets : [];
        if (Array.isArray(r.privacy) && r.privacy.length) privacyLines = r.privacy;
      } catch (e) {
        host.appendChild(el('div', { class: 'banner banner-error' }, [
          el('strong', { text: '读不到 AI 配置' }),
          el('div', { class: 'banner-hint', text: String((e && e.message) || e) }),
        ]));
        badge.textContent = '不可用';
        badge.className = 'ai-badge is-off';
        return;
      }

      const paintBadge = (c) => {
        if (!c.enabled) { badge.textContent = '已关闭'; badge.className = 'ai-badge is-off'; }
        else if (!c.configured) { badge.textContent = '已开启·未配全'; badge.className = 'ai-badge is-warn'; }
        else { badge.textContent = '已开启'; badge.className = 'ai-badge is-on'; }
      };
      paintBadge(cfg);

      // ---- 开关 ----
      const enabledBox = el('input', { type: 'checkbox', checked: cfg.enabled, id: 'ai-enabled' });

      // ---- 服务商预设 ----
      const presetSel = el('select', { class: 'select' }, [
        el('option', { value: '', text: '选择服务商（自动填地址和模型名）' }),
        ...presets.map((p) => el('option', { value: p.id, text: p.label })),
      ]);

      // ---- 三个输入框 ----
      const baseInput = el('input', {
        class: 'input mono', type: 'text', value: cfg.baseURL || '',
        placeholder: 'https://api.deepseek.com/v1',
      });
      const modelInput = el('input', {
        class: 'input mono', type: 'text', value: cfg.model || '',
        placeholder: 'deepseek-chat',
      });
      // 密钥框：**永远不回填原文**，placeholder 显示遮罩提示
      const keyInput = el('input', {
        class: 'input mono', type: 'password',
        placeholder: cfg.hasKey ? `已保存：${cfg.keyHint}（留空 = 不改）` : '粘贴你的 API 密钥',
        autocomplete: 'off', spellcheck: false,
      });
      const tempInput = el('input', { class: 'input', type: 'number', min: '0', max: '2', step: '0.1', value: String(cfg.temperature) });
      const maxTokInput = el('input', { class: 'input', type: 'number', min: '1', max: '128000', step: '100', value: String(cfg.maxTokens) });
      const timeoutInput = el('input', { class: 'input', type: 'number', min: '1000', max: '300000', step: '1000', value: String(Math.round(60000)) });

      presetSel.addEventListener('change', () => {
        const p = presets.find((x) => x.id === presetSel.value);
        if (!p) return;
        if (p.baseURL) baseInput.value = p.baseURL;
        if (p.model) modelInput.value = p.model;
      });

      const stateLine = el('div', { class: 'field-hint' });
      const paintState = () => {
        const on = enabledBox.checked;
        const hasKey = !!keyInput.value.trim() || cfg.hasKey;
        if (!on) {
          stateLine.textContent = '已关闭。关着的时候，程序不会连接任何外部服务。';
        } else if (!baseInput.value.trim() || !modelInput.value.trim() || !hasKey) {
          stateLine.textContent = '还差一点：地址、模型、密钥三样都要填。';
        } else {
          stateLine.textContent = '配置看起来齐全了。点「测试连接」确认一下能不能通。';
        }
      };
      for (const n of [enabledBox, baseInput, modelInput, keyInput]) n.addEventListener('input', paintState);
      enabledBox.addEventListener('change', paintState);
      paintState();

      /** 收集当前表单内容 */
      const collect = () => {
        const patch = {
          enabled: enabledBox.checked,
          baseURL: baseInput.value.trim(),
          model: modelInput.value.trim(),
          temperature: Number(tempInput.value),
          maxTokens: Number(maxTokInput.value),
          timeoutMs: Number(timeoutInput.value),
        };
        // 只有用户真输了新密钥才带上这个字段（留空 = 不改动已存的）
        const k = keyInput.value.trim();
        if (k) patch.apiKey = k;
        return patch;
      };

      const saveBtn = el('button', {
        class: 'btn btn-primary', dataset: { act: 'ai-save' },
        onclick: async () => {
          try {
            const r = await saveAiConfig(collect());
            cfg = r.config;
            paintBadge(cfg);
            keyInput.value = '';
            keyInput.placeholder = cfg.hasKey ? `已保存：${cfg.keyHint}（留空 = 不改）` : '粘贴你的 API 密钥';
            paintState();
            toastOk('AI 设置已保存');
          } catch (e) {
            toastError(String((e && e.message) || e));
          }
        },
      }, '保存');

      const testBtn = el('button', {
        class: 'btn', dataset: { act: 'ai-test' },
        onclick: async () => {
          const orig = testBtn.textContent;
          testBtn.disabled = true;
          testBtn.textContent = '测试中…';
          try {
            // 测试前先把当前表单存下来，否则测的还是旧配置，容易误导
            await saveAiConfig(collect());
            const r = await testAiConnection();
            toastOk(`连接成功（${r.model}）：${(r.text || '').slice(0, 40)}`);
          } catch (e) {
            toastError(String((e && e.message) || e), 8000);
          } finally {
            testBtn.disabled = false;
            testBtn.textContent = orig;
          }
        },
      }, '测试连接');

      const clearKeyBtn = el('button', {
        class: 'btn btn-sm btn-ghost', dataset: { act: 'ai-clear-key' },
        onclick: async () => {
          const yes = await confirmDialog('删除已保存的 API 密钥？删掉之后 AI 功能就不能用了，需要重新粘贴。',
            { title: '删除密钥', okLabel: '删除', danger: true });
          if (!yes) return;
          try {
            const r = await saveAiConfig({ apiKey: '' });
            cfg = r.config;
            paintBadge(cfg);
            keyInput.placeholder = '粘贴你的 API 密钥';
            paintState();
            toastOk('密钥已删除');
          } catch (e) {
            toastError(String((e && e.message) || e));
          }
        },
      }, '删除已保存的密钥');

      // ---- 隐私说明（这一块是硬要求，不能省） ----
      const privacy = el('div', { class: 'banner banner-info' }, [
        el('strong', { text: '开之前请先看清楚：这个功能会联网' }),
        el('ul', { class: 'banner-hint', style: { paddingLeft: '18px', margin: '6px 0 0' } },
          privacyLines.map((t) => el('li', { text: t }))),
      ]);

      host.appendChild(el('div', {}, [
        el('label', { class: 'checkline' }, [
          enabledBox,
          el('span', { class: 'checkline-text' }, [
            el('strong', { text: '启用 AI 翻译 / 讲解' }),
            el('span', { class: 'checkline-sub', text: '默认关闭。打开后才会连接你自己填的地址。' }),
          ]),
        ]),

        privacy,

        el('div', { class: 'field' }, [
          el('label', { class: 'field-label', text: '服务商' }),
          presetSel,
          el('div', { class: 'field-hint', text: '只是帮你自动填地址和模型名，填完还可以改。' }),
        ]),
        el('div', { class: 'field' }, [
          el('label', { class: 'field-label', text: '接口地址（baseURL）' }),
          baseInput,
          el('div', { class: 'field-hint', text: 'OpenAI 兼容的接口地址，多数以 /v1 结尾。' }),
        ]),
        el('div', { class: 'field' }, [
          el('label', { class: 'field-label', text: '模型名' }),
          modelInput,
        ]),
        el('div', { class: 'field' }, [
          el('label', { class: 'field-label', text: 'API 密钥' }),
          keyInput,
          el('div', { class: 'field-hint', text: '密钥由本机服务写进项目目录的 config.local.json（明文，你选的方案），' +
                                                '不会存进浏览器，也不会出现在导出的备份里。' }),
          el('div', { class: 'btn-row' }, [clearKeyBtn]),
        ]),
        el('details', { class: 'field' }, [
          el('summary', { text: '高级（一般不用改）' }),
          el('div', { class: 'field' }, [
            el('label', { class: 'field-label', text: '温度（0–2，越小越稳定）' }), tempInput,
          ]),
          el('div', { class: 'field' }, [
            el('label', { class: 'field-label', text: '单次回答长度上限（token）' }), maxTokInput,
            // ⚠️ 这句说明是必要的：用户报过「偶尔提示被长度上限截断」。
            //    根因是"翻译"和"讲语法"共用一个上限，而讲解的输出长得多。
            //    现在服务端按任务自动放宽（讲解类至少 3000），
            //    这里如实告诉用户"这是底线、不是天花板"，他就不会以为要自己算。
            el('div', { class: 'field-hint', text:
              '这是翻译这类任务的长度上限。'
              + '「讲语法 / 讲词」的输出比原文长得多，程序会自动用更大的值（至少 3000），'
              + '所以你把它填小了也不会截断讲解。调大它只会让单次回答更长、花的额度更多。' }),
          ]),
          el('div', { class: 'field' }, [
            el('label', { class: 'field-label', text: '超时（毫秒）' }), timeoutInput,
          ]),
        ]),

        stateLine,
        el('div', { class: 'btn-row' }, [saveBtn, testBtn]),
      ]));
    }

    /** 刷新快照摘要那一行（份数 + 合计大小） */
    async function renderSnapSummary() {
      try {
        const snaps = await db.dbAll('snapshots');
        const bytes = snaps.reduce((a, s) => a + (s.bytes || 0), 0);
        snapSummaryText.textContent = `当前 ${snaps.length} 份，内容合计 ${humanBytes(bytes)}。` +
          '自动保留最近 10 份；「结构升级前」与「清空前强制」这两类不会被自动删掉。';
      } catch (e) {
        snapSummaryText.textContent = '读不到快照数量：' + ((e && e.message) || e);
      }
    }

    async function doExport() {
      try {
        const dump = await db.exportAll({ includeSnapshots: false });
        const r = db.downloadJSON(dump, `jp-learn-${stamp()}.json`);
        // 记下这次导出，导出提醒才有依据
        await db.recordExport({ bytes: r.bytes, filename: r.filename, counts: dump.counts });
        await renderExportCard(exportHost, doExport);
        toastOk(`已导出 ${humanBytes(r.bytes)}：${r.filename}（文件在浏览器的下载目录）`, 6000);
      } catch (e) {
        toastError('导出失败：' + ((e && e.message) || e));
      }
    }

    /** 数据变动（导入/清空/恢复）后，把受影响的卡片一起刷一遍 */
    async function refreshAfterDataChange() {
      await renderSelfCheck(selfHost);
      await renderSnapSummary();
      await renderExportCard(exportHost, doExport);
    }

    function doImportDialog() {
      const input = el('input', { type: 'file', accept: '.json,application/json' });
      let parsed = null;
      const infoHost = el('div', {});
      const modeBtns = el('div', { class: 'segmented' }, [
        el('button', { class: 'active', text: '合并（推荐）', dataset: { mode: 'merge' } }),
        el('button', { text: '替换', dataset: { mode: 'replace' } }),
      ]);
      let mode = 'merge';
      for (const b of modeBtns.children) {
        b.addEventListener('click', () => {
          mode = b.dataset.mode;
          for (const x of modeBtns.children) x.classList.toggle('active', x === b);
        });
      }

      const body = el('div', {}, [
        el('p', { text: '选择之前导出的 jp-learn JSON 备份文件。导入前会自动创建一份当前数据的快照。' }),
        input,
        el('div', { style: { margin: '12px 0 6px' } }, [
          el('div', { class: 'field-label', text: '导入方式' }), modeBtns,
          el('div', { class: 'field-hint', text: '合并：同一条记录以备份为准，其余保留。替换：备份里有的表整体替换成备份内容。' }),
        ]),
        infoHost,
      ]);

      input.addEventListener('change', async () => {
        infoHost.innerHTML = '';
        const f = input.files && input.files[0];
        if (!f) return;
        try {
          const text = await f.text();
          parsed = JSON.parse(text);
          const v = db.validateBackup(parsed);
          if (!v.ok) {
            infoHost.appendChild(el('div', { class: 'banner banner-error', text: '格式不正确：' + v.error }));
            parsed = null;
            return;
          }
          const rows = Object.entries(v.info.counts).map(([k, n]) =>
            el('tr', {}, [el('td', { text: STORE_LABELS[k] || k }), el('td', { text: String(n) })])
          );
          infoHost.appendChild(el('div', { class: 'banner banner-ok' }, [
            el('div', { text: `格式正确。导出自 v${v.info.appVersion}，时间 ${humanTime(v.info.exportedAt)}` }),
            el('div', { class: 'table-wrap', style: { marginTop: '8px' } }, [
              el('table', { class: 'table' }, [
                el('thead', {}, el('tr', {}, [el('th', { text: '数据表' }), el('th', { text: '条数' })])),
                el('tbody', {}, rows),
              ]),
            ]),
            v.info.unknownStores && v.info.unknownStores.length
              ? el('div', { class: 'banner-hint', text: '忽略未知表：' + v.info.unknownStores.join('、') })
              : null,
          ].filter(Boolean)));
        } catch (e) {
          parsed = null;
          infoHost.appendChild(el('div', { class: 'banner banner-error', text: '无法解析：' + ((e && e.message) || e) }));
        }
      });

      modal({
        title: '从备份导入恢复',
        body,
        buttons: [
          { label: '取消' },
          {
            label: '开始导入',
            class: 'btn-primary',
            onClick: async () => {
              if (!parsed) { toastWarn('请先选择一个有效的备份文件'); return false; }
              try {
                const r = await db.importAll(parsed, mode);
                toastOk(`导入完成：写入 ${r.written} 条，涉及 ${r.stores} 张表（导入前快照已保存）`, 6000);
                await refreshAfterDataChange();
              } catch (e) {
                toastError('导入失败：' + ((e && e.message) || e));
              }
            },
          },
        ],
      });
    }

    async function doManualSnapshot() {
      try {
        const s = await db.makeSnapshot('manual', '用户在设置页手动创建');
        toastOk(`已创建快照（${humanBytes(s.bytes)}）`, 4000);
        await renderSnapSummary();
      } catch (e) {
        toastError('创建快照失败：' + ((e && e.message) || e));
      }
    }

    async function doWipe() {
      // 约束 3：清空必须二次确认，且清空前强制备份（备份由 db.wipeAllData 强制做，无法绕过）
      const ok = await confirmTwice({
        title: '清空所有用户数据',
        message: '这会删除：生词本、SRS 排程、全部答题历史、错题本、导入记录、歌词笔记、精读笔记、语法学习状态。' +
                 '程序文件与内置数据不受影响。',
        phrase: '确认清空',
        confirmLabel: '我已理解，清空数据',
      });
      if (!ok) return;
      try {
        const r = await db.wipeAllData();
        toastOk(`已清空。清空前的备份已保存为快照 ${r.backupId}（可在下方「数据快照」里恢复）`, 0);
        await refreshAfterDataChange();
      } catch (e) {
        toastError('清空失败：' + ((e && e.message) || e));
      }
    }
  },
};

// ============================================================================
// 渲染子块
// ============================================================================

/**
 * 备份状态卡：上次导出时间 + 是否需要提醒。
 * 为什么这张卡要独立存在：快照和主数据在同一个 IndexedDB 里，
 * 它能救误操作，但救不了「浏览器数据被清理」。只有导出成文件才行。
 * 所以这里不是「锦上添花的提示」，而是约束 3（用户数据永不丢失）的最后一环。
 */
async function renderExportCard(host, onExport) {
  clear(host);
  let info;
  try {
    info = await db.checkExportReminder();
  } catch (e) {
    host.appendChild(el('div', { class: 'banner banner-error', text: '读不到备份状态：' + ((e && e.message) || e) }));
    return;
  }

  const last = info.last;
  host.appendChild(el('dl', { class: 'kv' }, [
    el('dt', { text: '数据量' }), el('dd', { text: `${info.total} 条（生词/排程/历史/错题/笔记等合计）` }),
    el('dt', { text: '上次导出备份' }),
    el('dd', { text: last ? `${humanTime(last.at)}（${humanAgo(last.at)}）` : '从未导出过' }),
    last && last.filename ? el('dt', { text: '文件名' }) : null,
    last && last.filename ? el('dd', { class: 'mono', text: last.filename }) : null,
    last && last.bytes ? el('dt', { text: '大小' }) : null,
    last && last.bytes ? el('dd', { text: humanBytes(last.bytes) }) : null,
    last ? el('dt', { text: '当时数据量' }) : null,
    last ? el('dd', { text: `${last.total || 0} 条` }) : null,
  ].filter(Boolean)));

  if (info.should) {
    host.appendChild(el('div', {
      class: 'banner ' + (info.level === 'warn' ? 'banner-warn' : 'banner-info'),
      style: { marginTop: '10px' },
    }, [
      el('strong', { text: info.level === 'warn' ? '建议导出备份：' : '提示：' }),
      el('div', { class: 'banner-hint', text: info.reason }),
    ]));
  } else {
    host.appendChild(el('div', { class: 'banner banner-ok', style: { marginTop: '10px' } }, [
      el('span', { text: last ? '备份看起来是新的，不用急着再导一次。' : '还没有需要备份的学习数据。' }),
    ]));
  }

  host.appendChild(el('div', { class: 'btn-row', style: { marginTop: '10px' } }, [
    el('button', {
      class: 'btn btn-primary btn-sm', text: '立即导出备份',
      // onExport 由 render() 注入（它需要刷新同一屏里的其它卡片）。
      // 这样「导出逻辑」只有一处，不会分叉成两份实现。
      onclick: () => onExport(),
    }),
    el('span', { class: 'faint', style: { fontSize: '.8rem' }, text: '导出的文件不包含内置词库缓存（约 15,000 条），只含你自己的数据。' }),
  ]));
}

async function renderSelfCheck(host) {
  host.innerHTML = '';
  host.appendChild(el('div', { class: 'loading', text: '检测中…' }));
  const s = await db.selfCheck();
  host.innerHTML = '';

  if (s.error) {
    host.appendChild(el('div', { class: 'banner banner-error' }, [
      el('strong', { text: '数据层不可用' }), el('span', { text: s.error }),
      el('div', { class: 'banner-hint', text: '若是无痕/隐私模式，请换普通窗口打开，否则学习记录不会被保存。' }),
    ]));
    return;
  }

  host.appendChild(el('dl', { class: 'kv' }, [
    el('dt', { text: 'IndexedDB' }), el('dd', { text: '可用' }),
    el('dt', { text: '程序结构版本' }), el('dd', { text: 'v' + s.schemaVersion }),
    el('dt', { text: '安装时间' }), el('dd', { text: s.installedAt ? humanTime(s.installedAt) : '（本次首次运行）' }),
    s.lastMigration ? el('dt', { text: '上次结构升级' }) : null,
    s.lastMigration ? el('dd', { text: `v${s.lastMigration.from} → v${s.lastMigration.to}（${humanTime(s.lastMigration.at)}）` }) : null,
    s.lastImport ? el('dt', { text: '上次导入' }) : null,
    s.lastImport ? el('dd', { text: `${humanTime(s.lastImport.at)}（${s.lastImport.mode === 'merge' ? '合并' : '替换'} ${s.lastImport.written} 条）` }) : null,
    s.lastWipe ? el('dt', { text: '上次清空' }) : null,
    s.lastWipe ? el('dd', { text: `${humanTime(s.lastWipe.at)}（备份 ID：${s.lastWipe.backupId}）` }) : null,
  ].filter(Boolean)));

  const rows = Object.entries(s.stores).map(([k, v]) =>
    el('tr', {}, [
      el('td', { text: STORE_LABELS[k] || k }),
      el('td', { class: 'mono faint', text: k }),
      el('td', { text: String(v) }),
    ])
  );
  host.appendChild(el('div', { class: 'table-wrap', style: { marginTop: '12px' } }, [
    el('table', { class: 'table' }, [
      el('thead', {}, el('tr', {}, [
        el('th', { text: '数据表' }), el('th', { text: '内部名' }), el('th', { text: '条数' }),
      ])),
      el('tbody', {}, rows),
    ]),
  ]));
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
