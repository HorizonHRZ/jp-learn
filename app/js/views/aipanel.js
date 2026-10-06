/**
 * aipanel.js —— 「AI 讲解」的**结果面板** + 首次使用的隐私确认。
 *
 * ──────────────────────────────────────────────────────────────────
 * 这一版**删掉了"选中文字 → 弹出按钮条"**
 * ──────────────────────────────────────────────────────────────────
 * 原来这里有一个 `attachAiTo()`：监听 document 的 mouseup/keyup，
 * 一旦发现有选区就浮出一条 `翻译 / 讲解 / 讲这个词` 的小按钮。
 * 用户明确要求去掉它，理由很实在：
 *
 *   · 那条按钮条**跟着光标到处冒**，读书时反复干扰，是在看还是不在看都分不清；
 *   · 真正需要的两个动作已经各有**固定入口**了：
 *       点一个词 → 速查抽屉 → 里面就有「AI 讲这个词」
 *       点一句话旁边的「讲语法」按钮 → 结果落在**句子下方的可折叠模块**里
 *         （见 airead.js 的 paintGrammar；不再用浮层，因为浮层关掉就没了）
 *   · 它还逼着两个阅读页都挂 document 级监听，必须靠 destroy() 撤销 ——
 *     撤慢了就会"点一次弹好几个面板"，是这类 bug 的经典温床。
 *
 * 现在这个文件只负责两件事：
 *   1. `showResultPanel()` / `runAiTask()` —— 把 AI 的回答显示出来
 *   2. `confirmAiNotice()` —— 首次发送前确认一次（文案由 ai.js 提供）
 *
 * ⚠️ **这个文件里最重要的一条规矩**（对用户的承诺，界面上也写着）：
 *     发出去的文字**只可能是调用方明确传进来的那一段**。
 *     `runAiTask(task, text)` 的 `text` 是唯一的发送来源，
 *     它绝不会去读 DOM、不会读全文。这是"代码层面做得到"的保证。
 */
import { el, modal, toastWarn } from '../ui.js';
import { ensureAck, askAi } from '../ai.js';

/**
 * 把 AI 发送前的隐私确认做成对话框。
 * 只在**第一次真正发送之前**出现一次（标记记在本地 settings 表里）。
 */
export function confirmAiNotice(lines) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    modal({
      title: '这个功能会联网，先确认一下',
      width: '520px',
      body: el('div', {}, [
        el('ul', { style: { paddingLeft: '20px', margin: '0 0 10px', lineHeight: '1.8' } },
          lines.map((t) => el('li', { text: t }))),
        el('div', { class: 'banner banner-warn' }, [
          el('div', { class: 'banner-hint', text: '以后不再重复问。你可以随时在「设置 → AI」里把它关掉。' }),
        ]),
      ]),
      buttons: [
        { label: '不用了', class: 'btn-ghost', onClick: () => { finish(false); } },
        { label: '我知道了，继续', class: 'btn-primary', onClick: () => { finish(true); } },
      ],
      onClose: () => finish(false),
    });
  });
}

/** 结果面板：显示 AI 回答。用抽屉式浮层，不打断阅读位置。 */
function showResultPanel(title, subtitle, onAskAgain) {
  const bodyHost = el('div', { class: 'ai-out' });
  const status = el('div', { class: 'ai-status', text: '正在请求…' });

  const panel = el('div', { class: 'ai-panel' }, [
    el('div', { class: 'ai-panel-head' }, [
      el('strong', { text: title }),
      el('span', { class: 'ai-panel-sub', text: subtitle || '' }),
      el('button', {
        class: 'btn btn-sm btn-ghost', dataset: { act: 'ai-close' },
        onclick: () => close(),
      }, '关闭'),
    ]),
    status,
    bodyHost,
  ]);

  const root = el('div', { class: 'ai-panel-wrap' }, [panel]);
  document.body.appendChild(root);

  function close() { root.remove(); }
  return {
    root,
    close,
    setStatus(t) { status.textContent = t; status.style.display = t ? '' : 'none'; },
    setText(t) {
      bodyHost.innerHTML = '';
      // AI 返回的是纯文本。按段落切，保留换行可读性。
      for (const para of String(t).split(/\n{1,}/)) {
        if (!para.trim()) continue;
        bodyHost.appendChild(el('p', { class: 'ai-para', text: para }));
      }
    },
    setError(t) {
      bodyHost.innerHTML = '';
      bodyHost.appendChild(el('div', { class: 'banner banner-error' }, [
        el('strong', { text: '没能拿到回答' }),
        el('div', { class: 'banner-hint', text: t }),
      ]));
      if (onAskAgain) {
        bodyHost.appendChild(el('div', { class: 'btn-row' }, [
          el('button', { class: 'btn btn-sm', onclick: () => onAskAgain() }, '重试'),
        ]));
      }
    },
    isClosed() { return !root.parentNode; },
  };
}

/**
 * 真正的发送动作。
 *
 * @param {'translate'|'explain'|'word'|'custom'} task
 * @param {string} text  **只有这一段**会被发出去
 */
export async function runAiTask(task, text, opts = {}) {
  const t = String(text || '').trim();
  if (!t) { toastWarn('没有要处理的内容'); return null; }

  // 首次使用：把"会发出去什么"讲清楚，用户点了同意才继续
  const agreed = await ensureAck(confirmAiNotice);
  if (!agreed) return null;

  const labels = { translate: 'AI 翻译', explain: 'AI 讲解', word: 'AI 讲词', custom: 'AI 提问' };
  const panel = showResultPanel(
    labels[task] || 'AI',
    // 界面上的这句是对用户的承诺，要和实际发出去的东西严格对应：
    // 这里发出去的就是 t，一个字不多。所以写"只发这一段 N 个字"。
    `只发了这一段（${t.length} 个字）`,
    () => runAiTaskInto(panel, task, t, opts),
  );
  await runAiTaskInto(panel, task, t, opts);
  return panel;
}

/**
 * 「就地返回结果」版：**不建浮层**，只把 AI 的回答文本交回给调用方。
 *
 * ⚠️ 为什么需要它（用户报的第 4 个问题）：
 *   原来"讲这句语法"只能走 `runAiTask()` → `showResultPanel()` ——
 *   一个浮层面板，关掉就没了。用户的原话是
 *   「ai 的输出依旧是弹窗，无法保存。我需要你解决这一点，
 *     例如在这一段句子下方加一个可折叠的模块。」
 *
 *   所以这里把"取得回答"和"怎么显示"分开：
 *     · `runAiTask()`       —— 浮层显示（仍然保留，速查抽屉里讲词还在用）
 *     · `runAiTaskInline()` —— 只回文本，由调用方决定放在哪（阅读页放在句子下方）
 *
 * 隐私确认（ensureAck）两条路都走，一步不少。
 *
 * @returns {Promise<{text?:string, error?:string, cancelled?:boolean}>}
 */
export async function runAiTaskInline(task, text, opts = {}) {
  const t = String(text || '').trim();
  if (!t) return { error: '没有要处理的内容' };

  const agreed = await ensureAck(confirmAiNotice);
  if (!agreed) return { cancelled: true };

  try {
    const r = await askAi({ task, text: t, context: opts.context || '', history: opts.history || [] });
    // ★ 把"被长度上限截断"如实传上去。
    //   ⚠️ 以前这里只返回 { text }，于是"半截回答"和"完整回答"在调用方
    //      看起来一模一样 —— 用户会以为讲解就这么多。
    //      用户 2026-10 报的「偶尔返回讲解失败：回答被长度上限截断了」
    //      正是这条信息在**有内容**时被咽掉、在**没内容**时才冒出来的结果。
    return {
      text: r.text || '（空回答）',
      truncated: !!r.truncated,
      truncateHint: r.truncateHint || '',
    };
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (e && e.code === 'disabled') {
      return { error: msg + '（AI 默认是关闭的，需要你自己在设置里打开并填好密钥。）' };
    }
    return { error: msg };
  }
}

async function runAiTaskInto(panel, task, text, opts) {
  panel.setStatus('正在请求…');
  panel.setText('');
  try {
    const r = await askAi({ task, text, context: opts.context || '', history: opts.history || [] });
    panel.setStatus('');
    panel.setText(r.text || '（空回答）');
  } catch (e) {
    const msg = String((e && e.message) || e);
    panel.setStatus('');
    if (e && e.code === 'disabled') {
      panel.setError(`${msg}\n\n（提示：AI 默认是关闭的，需要你自己在设置里打开并填好密钥。）`);
    } else if (e && e.code === 'unconfigured') {
      panel.setError(msg);
    } else {
      panel.setError(msg);
    }
  }
}

/**
 * 「选中 → 浮出按钮条」已经**删除**（用户明确要求）。
 *
 * 原来这里有个 `attachAiTo(scope)`：监听 document 的 mouseup/keyup，
 * 一有选区就浮出一条「翻译 / 讲解 / 讲这个词」。删掉它的理由：
 *
 *   · 那条按钮条跟着光标到处冒，读书时反复干扰；
 *   · 两个真正需要的动作都已有**固定入口**：
 *       点词 → 速查抽屉里的「AI 讲这个词」（见 drawer.js 的 setAiWordHook）
 *       点句旁的「⚙ 讲语法」按钮 → 结果落在那句下方
 *         （见 airead.js 的 `askGrammar` / `runAiTaskInline`）
 *       ⚠️ 这里原先写的是"点句 → 见 airead.js 的 explainSentence"。
 *          那个函数**已经被删掉了**（它走浮层，结果无法保存）——
 *          留着这句注释会让下一个人去追一个不存在的函数。
 *   · 它逼着两个阅读页都挂 document 级监听并靠 destroy() 撤销 ——
 *     撤慢了就"点一次弹好几个面板"，是这类 bug 的经典温床。
 *
 * ⚠️ 如果你在找 `collectSelection()`：它也跟着删了。
 *    保留一个"只有被删掉的功能才用"的函数，只会让下一个人以为它还在用。
 *    真需要"取选区"时，`window.getSelection()` 三行就能写出来。
 */
