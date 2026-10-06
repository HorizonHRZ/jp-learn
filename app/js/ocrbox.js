/**
 * ocrbox.js —— 「拍照 / 截图识别」的**共用组件**。
 *
 * ──────────────────────────────────────────────────────────────────
 * 为什么抽成独立文件
 * ──────────────────────────────────────────────────────────────────
 * 这段代码原来内联在 `views/reading.js` 里（约 140 行）。现在**歌词页也要**，
 * 所以必须是共用的 —— 否则就是复制粘贴两份，改一处漏一处。
 *
 * 抽出来还顺带解决了三个原本藏在内联代码里的毛病：
 *   ① 文案写死了"Windows OCR"（引擎早就换了，文案成了假话）
 *   ② 没有"手动纠正竖排/横排判断"的入口（自动判断总有出错的时候）
 *   ③ 拖拽、粘贴、选择文件三条入口各自重复了一遍校验逻辑
 *
 * ──────────────────────────────────────────────────────────────────
 * 隐私边界（这条要一直保持）
 * ──────────────────────────────────────────────────────────────────
 * 图片只发到**本机**服务（同一个进程里的 /api/ocr），
 * 由项目自带的 Python 引擎识别；识别完临时文件立刻删除。
 * **不外传、不联网。** 界面上的文案必须如实这么说，不要提"Windows"。
 *
 * ──────────────────────────────────────────────────────────────────
 * 依赖
 * ──────────────────────────────────────────────────────────────────
 * 只依赖 `ui.js`（建 DOM）与浏览器原生 API（FileReader / fetch / URL）。
 * **不依赖 jpreader.js** —— 这样以后哪里想用都行，不会绕回词库那一坨。
 */
import { el, toast, toastOk, progressBar } from './ui.js';
import { cleanOcrText, ocrWarning } from './ocrtext.js';

/** 允许上传的图片类型（和后端 handleOcr 的 safeExt 保持一致）。 */
export const OK_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/tiff'];

/** 单张图片的大小上限。超过这个尺寸先让用户压缩，比传到一半失败体验好。 */
export const MAX_BYTES = 12 * 1024 * 1024;

/**
 * 从文件名/类型推断扩展名（后端按扩展名决定怎么解码）。
 *
 * @param {File} file
 * @returns {string} 小写扩展名，兜底 'png'
 */
export function extOf(file) {
  const m = /\.([a-z0-9]+)$/i.exec((file && file.name) || '');
  if (m) return m[1].toLowerCase();
  const t = String((file && file.type) || '').split('/')[1];
  return t || 'png';
}

/**
 * 把图片文件转成 base64（**不带** `data:` 前缀，后端自己解 base64）。
 *
 * @param {File|Blob} file
 * @returns {Promise<string>}
 */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result || '');
      const comma = s.indexOf(',');
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    fr.onerror = () => reject(new Error('图片读取失败'));
    fr.readAsDataURL(file);
  });
}

/**
 * 选文件之前先在前端拦一道。
 *
 * 为什么值得：类型不对时**不用浪费一次往返**，而且错误提示能更贴近用户
 * （"这不是图片文件"比后端返回的 400 清楚得多）。
 *
 * @returns {string|null} 有问题返回提示语，没问题返回 null
 */
export function validateImageFile(file) {
  if (!file) return '没有选择图片';
  const mime = String(file.type || '');
  if (mime && OK_MIME.indexOf(mime) < 0 && !/^image\//.test(mime)) return '这不是图片文件';
  if (file.size > MAX_BYTES) {
    return `图片太大了（${(file.size / 1048576).toFixed(1)} MB，上限 12 MB），先压缩一下再试`;
  }
  return null;
}

/**
 * 调 `/api/ocr` 识别一张图。
 *
 * @param {File|Blob} file
 * @param {object} opts
 *   layout        'auto' | 'vertical' | 'horizontal'（默认 auto）
 *   stripFurigana 是否去掉注音，默认 true
 * @returns {Promise<object>} 后端返回的 JSON（已确认 ok）
 */
export async function ocrScan(file, opts = {}) {
  const b64 = await fileToBase64(file);
  const res = await fetch('/api/ocr', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageBase64: b64,
      ext: extOf(file),
      layout: opts.layout || 'auto',
      stripFurigana: opts.stripFurigana !== false,
    }),
  });
  let data = null;
  try { data = await res.json(); } catch { /* 下面统一报错 */ }
  if (!res.ok || !data || !data.ok) {
    const msg = (data && data.error) || ('HTTP ' + res.status);
    const e = new Error(msg);
    e.code = data && data.code;
    e.status = res.status;
    throw e;
  }
  return data;
}

/**
 * 建一个"拍照识别"区块。
 *
 * @param {object} opts
 *   title       区块标题（默认「拍照识别」）
 *   onText      (text, info) => void  识别成功后回调。
 *               info = { data, cleaned, warning, vertical, furiganaRemoved, summary }
 *   onBusy      (busy:boolean) => void  识别开始时/结束时回调（用来禁用别的按钮）
 *   allowPaste  是否在 `pasteTarget` 上监听 Ctrl+V 粘截图（默认 false）
 *   pasteTarget 粘贴事件挂载的元素（挂局部元素而不是 document，
 *               这样宿主被清空时监听器自动消失，不需要 destroy 去撤销）
 *   append      true = 追加到输入框，false = 覆盖（默认由调用方在 onText 里决定）
 * @returns {{ node, run(file), reset(), setBusy(b), elements }}
 */
export function buildOcrBox(opts = {}) {
  const title = opts.title || '拍照识别';
  let busy = false;

  // ── 手动纠正版面判断 ──
  // 为什么要给这个开关：自动判断横排/竖排**会出错**
  // （投影带判据在极端排版上会失效，见 ocrlayout.js 里的说明）。
  // 判错的表现是"文字顺序乱了"，用户一眼能看出来；
  // 但如果没有开关，他就只能干瞪眼。给个三选一，成本极低、价值极高。
  const layoutSel = el('select', { class: 'input input-sm jpr-ocr-layout' }, [
    el('option', { value: 'auto', text: '自动判断版面' }),
    el('option', { value: 'vertical', text: '竖排（从右往左）' }),
    el('option', { value: 'horizontal', text: '横排（从左往右）' }),
  ]);

  const stripChk = el('input', { type: 'checkbox', checked: true });
  const stripLabel = el('label', { class: 'checkline' }, [
    stripChk,
    el('span', { text: '去掉注音（ふりがな）' }),
  ]);

  const fileInput = el('input', {
    type: 'file', accept: 'image/*', style: { display: 'none' },
  });

  const preview = el('img', { class: 'jpr-ocr-preview', alt: '待识别图片' });
  const progress = progressBar();
  const host = el('div', {});

  const pickBtn = el('button', { class: 'btn btn-sm', text: '选择图片…', onclick: () => fileInput.click() });

  const area = el('div', {
    class: 'jpr-ocr-area',
    ondragover: (ev) => { ev.preventDefault(); area.classList.add('is-drag'); },
    ondragleave: () => area.classList.remove('is-drag'),
    ondrop: (ev) => {
      ev.preventDefault();
      area.classList.remove('is-drag');
      const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (f) run(f);
    },
  }, [
    el('div', { class: 'jpr-ocr-hint' }, [
      el('strong', { text: title + '：' }),
      el('span', { text: '图片只在这台电脑上识别（本项目自带的日文引擎），不会上传到任何地方。' }),
    ]),
    el('div', { class: 'btn-row', style: { justifyContent: 'center', marginTop: '8px' } }, [pickBtn]),
    el('div', { class: 'jpr-ocr-hint', text: '也可以把图片拖到这里，或按 Ctrl+V 粘贴截图。竖排的书页会自动转成横排。' }),
    el('div', { class: 'jpr-controls', style: { justifyContent: 'center', marginTop: '6px' } }, [
      layoutSel, stripLabel,
    ]),
    host,
    fileInput,
    progress.node,
    preview,
  ]);
  preview.style.display = 'none';
  progress.node.style.display = 'none';

  fileInput.addEventListener('change', (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (f) run(f);
    ev.target.value = '';   // 允许再次选同一张图
  });

  function setBusy(b) {
    busy = !!b;
    pickBtn.disabled = busy;
    layoutSel.disabled = busy;
    stripChk.disabled = busy;
    if (typeof opts.onBusy === 'function') opts.onBusy(busy);
  }

  function showError(msg) {
    host.innerHTML = '';
    host.appendChild(el('div', { class: 'banner banner-error' }, [
      el('strong', { text: '识别失败：' }),
      el('span', { text: String(msg) }),
    ]));
  }

  function showNotice(kind, head, body) {
    host.innerHTML = '';
    host.appendChild(el('div', { class: 'banner banner-' + kind }, [
      el('strong', { text: head }),
      el('span', { text: body }),
    ]));
  }

  /** 识别一张图。 */
  async function run(file) {
    if (busy) { toast('正在识别上一张，稍等一下', 'warn'); return; }
    const bad = validateImageFile(file);
    if (bad) { toast(bad, 'error'); return; }

    setBusy(true);
    host.innerHTML = '';
    progress.node.style.display = '';
    progress.set(0.15, '读取图片…');
    try {
      preview.src = URL.createObjectURL(file);
      preview.style.display = '';
    } catch { /* 预览失败不影响识别 */ }

    try {
      progress.set(0.45, '识别中（本机引擎，第一次会慢一点）…');
      const data = await ocrScan(file, {
        layout: layoutSel.value,
        stripFurigana: stripChk.checked,
      });
      progress.set(1, '识别完成');

      // ⚠️ 这里**必须**清洗，而不是直接把 data.text 拿去用。
      //
      // 为什么：OCR 引擎（任何一家）都可能把汉字/假名逐个用空格隔开，
      // 或者在词之间插进多余空格。不清洗的后果不是"多个空格不好看"，
      // 而是**分词会退化成一个个单字** —— 实测覆盖率从 100% 掉到 77.8%，
      // 「日本語」「勉強」这类真词一个都识别不出来，整页注音全废。
      // 这件事有专门的测试：tools/test-ocrtext.mjs。
      const text = cleanOcrText(String(data.text || '')).trim();
      // 清洗前 vs 清洗后差异明显时，如实告诉用户（不假装识别得很完美）
      const warning = ocrWarning(String(data.text || ''), text);

      if (!text) {
        showNotice('warn', '识别不出文字：',
          (data.summary || '') + '　可能图片太模糊、太暗，或者拍的是一片空白。换一张更清楚的照片试试。');
        toast('没识别出文字', 'warn');
        return;
      }

      // 交给调用方处理（填输入框、存笔记……）
      if (typeof opts.onText === 'function') {
        opts.onText(text, {
          data,
          cleaned: text,
          warning,
          vertical: !!data.vertical,
          furiganaRemoved: Number(data.furiganaRemoved || 0),
          summary: data.summary || '',
        });
      }

      const bits = [];
      if (data.summary) bits.push(data.summary);
      bits.push(`识别到 ${(data.blocks || []).length} 处文字。`);
      if (warning) bits.push(warning);
      bits.push('请先扫一眼有没有认错的字再继续。');
      showNotice('ok', '识别完成：', bits.join(''));
      toastOk('识别完成');
    } catch (e) {
      const msg = String((e && e.message) || e);
      // 运行时没装是最常见的一次性错误，给一条能照着做的指引
      if (e && e.code === 'NO_RUNTIME') {
        showNotice('warn', '还差一步：',
          msg + '　装好后回到这一页刷新即可，之后一直可用。');
      } else {
        showError(msg);
      }
      toast('识别失败，看页面上的提示', 'error');
    } finally {
      setBusy(false);
    }
  }

  /** 清空识别区（"清空"按钮要用）。 */
  function reset() {
    host.innerHTML = '';
    preview.style.display = 'none';
    progress.node.style.display = 'none';
  }

  // Ctrl+V 粘截图。
  //
  // 为什么挂在**局部元素**上而不是 document：
  //   document 级监听是全局的，视图换掉之后它还在，必须靠 destroy() 撤销；
  //   而路由重新进入同一视图时会复用同一个模块对象，destroy 的注册时机
  //   一旦没跟上就会叠加多个监听（粘一次图片触发好几次识别，实测踩过）。
  //   挂在局部元素上，宿主被清空时监听器自动一起消失，没有忘记撤销的可能。
  const pasteTarget = opts.pasteTarget;
  if (opts.allowPaste && pasteTarget && pasteTarget.addEventListener) {
    pasteTarget.addEventListener('paste', (ev) => {
      const t = ev.target;
      const inField = t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT');
      if (inField) return;   // 焦点在输入框里时，粘贴本来就该归输入框
      const items = (ev.clipboardData && ev.clipboardData.items) || [];
      for (const it of items) {
        if (it.type && it.type.indexOf('image') === 0) {
          const f = it.getAsFile();
          if (f) { ev.preventDefault(); run(f); return; }
        }
      }
    });
  }

  return {
    node: area,
    run,
    reset,
    setBusy,
    elements: { area, host, preview, progress, layoutSel, stripChk, fileInput, pickBtn },
  };
}
