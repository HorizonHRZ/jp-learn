/**
 * speak.js —— 发音朗读（听写模式用）
 *
 * 用浏览器内置的 SpeechSynthesis，**不引入任何音频文件或第三方 TTS**：
 *   · 符合硬约束（零依赖、离线可用、不联网）
 *   · 日语发音质量取决于系统装了哪个语音包，所以这里如实告知用户，
 *     而不是假装发音一定准
 *
 * 已知现实：Windows 上日语语音（Microsoft Haruka / Nanami / Ayumi）需要
 * 在「设置 → 时间和语言 → 语音」里安装。没装的话 speechSynthesis 可能
 * 只提供非日语语音，读日语会读得很怪或干脆不出声。所以：
 *   · 优先挑 ja-* 的语音
 *   · 挑不到就明确提示用户，而不是静默用英语语音乱读
 */

let voicesCache = null;

/** 列出可用语音（浏览器异步加载，可能要等 voiceschanged） */
export function listVoices() {
  return new Promise((resolve) => {
    if (!hasSpeech()) return resolve([]);
    const got = window.speechSynthesis.getVoices();
    if (got && got.length) return resolve(got);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(window.speechSynthesis.getVoices() || []);
    };
    window.speechSynthesis.addEventListener('voiceschanged', finish, { once: true });
    // 有些浏览器永远不触发 voiceschanged，兜一个超时，避免界面卡住
    setTimeout(finish, 800);
  });
}

export function hasSpeech() {
  try {
    return typeof window !== 'undefined'
      && 'speechSynthesis' in window
      && typeof window.SpeechSynthesisUtterance === 'function';
  } catch { return false; }
}

/** 日语音源是否可用（决定听写模式能不能用） */
export async function japaneseVoiceStatus() {
  if (!hasSpeech()) {
    return { available: false, reason: '这个浏览器不支持语音朗读（speechSynthesis 不可用）', voice: null };
  }
  const voices = await listVoices();
  voicesCache = voices;
  const ja = voices.filter((v) => /^ja/i.test(v.lang || ''));
  if (!ja.length) {
    return {
      available: false,
      reason: '系统里没有日语语音包。听写模式需要日语发音，'
        + '请在 Windows「设置 → 时间和语言 → 语音 → 添加语音」里添加「日语」，装好后刷新本页。',
      voice: null,
      allCount: voices.length,
    };
  }
  // 优先本地语音（离线可用），其次名字里带 Haruka/Nanami/Ayumi 的常见日语语音
  const local = ja.filter((v) => v.localService);
  const preferred = (local.length ? local : ja).sort((a, b) => {
    const rank = (v) => (/haruka|nanami|ayumi|ichiro|kyoko/i.test(v.name) ? 0 : 1);
    return rank(a) - rank(b);
  });
  return { available: true, voice: preferred[0], all: ja, reason: '' };
}

/**
 * 朗读一段日语。
 * @param {string} text
 * @param {object} opts { rate, pitch, voice }
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function speak(text, opts = {}) {
  if (!hasSpeech()) return { ok: false, reason: '浏览器不支持语音朗读' };
  const t = String(text || '').trim();
  if (!t) return { ok: false, reason: '没有可朗读的内容' };

  const status = await japaneseVoiceStatus();
  if (!status.available) return { ok: false, reason: status.reason };

  try {
    // 连续点朗读时要先取消上一次，否则会叠在一起念
    window.speechSynthesis.cancel();
    const u = new window.SpeechSynthesisUtterance(t);
    u.voice = opts.voice || status.voice || (voicesCache || []).find((v) => /^ja/i.test(v.lang));
    u.lang = (u.voice && u.voice.lang) || 'ja-JP';
    u.rate = opts.rate === undefined ? 0.9 : opts.rate;   // 稍慢一点，学习者需要
    u.pitch = opts.pitch === undefined ? 1 : opts.pitch;
    window.speechSynthesis.speak(u);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

export function stopSpeaking() {
  try { if (hasSpeech()) window.speechSynthesis.cancel(); } catch { /* ignore */ }
}
