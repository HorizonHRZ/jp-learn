/**
 * conj.js —— 日语活用（变形）规则引擎：**从辞书形出发，正向推出各种形态**。
 *
 * ──────────────────────────────────────────────────────────────────────
 * 它和 tokenizer.js 里的"活用还原器"是什么关系
 * ──────────────────────────────────────────────────────────────────────
 *   还原器（`explainDeinflect`）：**反向**。给你一个已经变过形的词
 *       （使って），猜它原本是什么（使う）。它靠词库校验，猜得准但**不解释规则**。
 *   本模块：**正向**。给你辞书形（使う），按规则推出 使います / 使って / 使えば…
 *       并**写出这一步用的是什么规则**。它不查词库，纯粹讲规则。
 *
 *   两个方向都留着，因为它们回答的是不同的问题：
 *     "这个词我认不出来" → 用还原器
 *     "这个词该怎么变" → 用本模块
 *
 * ──────────────────────────────────────────────────────────────────────
 * 为什么单独成文件、而且要能脱离浏览器跑
 * ──────────────────────────────────────────────────────────────────────
 * 变形规则对初学者（本项目的用户就是）来说**没法自己验错**：他看到一个错的
 * 变形表也认不出来。所以正确性不能靠"我写的时候很仔细"，只能靠机器反复验。
 * 放在纯函数模块里，tools/test-conj.mjs 就能：
 *   ① 直接调用，断言具体形态；
 *   ② **往返验证**：本模块推出来的每一个形态，都丢回项目里已有的还原器，
 *      要求它能还原回原来的辞书形。往返对得上，才说明两边至少自洽。
 *
 * 界面（toolbox.js）和测试（test-conj.mjs）用的是**同一份规则**，
 * 不存在"界面上一套、测试里另一套"的情况。
 */

// ---------------------------------------------------------------------------
// 一、基础工具
// ---------------------------------------------------------------------------

/** 把字符串按"码位"切开（日语用不到代理对，但这样写不会因为别的内容出错） */
const chars = (s) => Array.from(String(s));

/** 最后一个字 */
const lastCh = (s) => chars(s).slice(-1)[0] || '';

/** 去掉最后一个字 */
const dropLast = (s) => chars(s).slice(0, -1).join('');

/**
 * 去掉结尾的「する」（两个假名，不是一个字）。
 *
 * ⚠️ 别用 `dropLast(dropLast(w))` 来干这件事 —— 那正是我第一版写的，
 *    看着挺合理，实际上「する」是两个字符，`dropLast` 只去掉最后一个，
 *    套两次确实能去掉两个……但一旦有人给 dropLast 加了新语义就会悄悄错。
 *    更要命的是它**读起来不表达意图**：看代码的人得数一遍才知道去掉了什么。
 *    写一个名字直接说明意图的函数，比省这一行值。
 */
const stripSuru = (s) => (s.endsWith('する') ? s.slice(0, -2) : dropLast(s));

/** 最后一个字是元音（假名）吗 */
function isKana(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (c >= 0x3041 && c <= 0x3096) || (c >= 0x30A1 && c <= 0x30F6);
}

// ---------------------------------------------------------------------------
// 二、五段动词的"音便"表
// ---------------------------------------------------------------------------
/**
 * 五段动词接 て / た 时的音便（读音变化）。规则本身不复杂，但必须写全：
 *
 *   う・つ・る → って / った     買う→買って、待つ→待って、取る→取って
 *   む・ぶ・ぬ → んで / んだ     読む→読んで、遊ぶ→遊んで、死ぬ→死んで
 *   く        → いて / いた     書く→書いて
 *   ぐ        → いで / いだ     泳ぐ→泳いで
 *   す        → して / した     話す→話して
 *
 * ⚠️ 「行く」是五段里唯一的例外：行く→行って（不是 行いて）。
 *    这种例外必须单独处理，而且要在界面上**说出来**，不能悄悄改掉。
 *    初学者最容易在这里被教材坑到。
 */
const TE_TA = {
  う: ['って', 'った'],
  つ: ['って', 'った'],
  る: ['って', 'った'],
  む: ['んで', 'んだ'],
  ぶ: ['んで', 'んだ'],
  ぬ: ['んで', 'んだ'],
  く: ['いて', 'いた'],
  ぐ: ['いで', 'いだ'],
  す: ['して', 'した'],
};

/** 片假名动词（极少，但要一致）：把 て/た 表也做一份片假名的 */
const TE_TA_KATA = Object.fromEntries(
  Object.entries(TE_TA).map(([k, v]) => [
    String.fromCharCode(k.charCodeAt(0) + 0x60),
    v.map((x) => chars(x).map((c) => String.fromCharCode(c.charCodeAt(0) + 0x60)).join('')),
  ]),
);

function teTaOf(ch) {
  return TE_TA[ch] || TE_TA_KATA[ch] || null;
}

// ---------------------------------------------------------------------------
// 三、词类判定
// ---------------------------------------------------------------------------
/**
 * 判断一个词属于哪一类。**不做词库查询**，只看形状。
 *
 * 这是本模块最需要向用户交代清楚的一点：只看结尾的话，
 * 「帰る」「切る」「入る」这些**看起来像一段、其实是五段**的词会被判错。
 * 所以：
 *   · 界面上必须把判定结果**显式说出来**，并允许用户手动改成别的类型；
 *   · 判定不确定时（以 る 结尾），要**明说"可能是五段也可能是一段"**，
 *     而不是假装很确定。
 *
 * 返回 { type, reason, uncertain }
 *   type: 'godan' | 'ichidan' | 'suru' | 'kuru' | 'i-adj' | 'na-adj' | 'noun' | 'unknown'
 *   uncertain: true 表示"光看形状分不出来，需要用户确认"
 */
/**
 * 汉字词尾 → 假名读音。
 *
 * ⚠️ **这张表是为了修一个真 bug 才加的。**
 *
 * 「る」结尾的动词要判断它前面那个音在哪一段（一段 / 五段）。
 * 但像「見る」「帰る」这样**词干部分是汉字**的词，`る` 前面是**汉字**，
 * 拿汉字去五十音表里查是查不到的 —— 于是 見る 被判成五段，
 * 变出「見ります」「見らない」这种根本不存在的写法。
 *
 * 而更危险的是：这类错误**看起来很像日语**，初学者根本发现不了。
 * 修法是"看穿汉字"：用它的读音来判断。读音也不确定的（当用汉字
 * 可能有好几种读法）就退回保守判断并明确提醒用户。
 */
const KANJI_TAIL_READING = {
  // い段（读音基本唯一，可以放心用来判断"一段"）
  見: 'み', 起: 'き', 切: 'き', 着: 'き', 似: 'に', 煮: 'に', 干: 'ひ',
  過: 'ぎ', 伸: 'び', 浴: 'び', 借: 'り', 限: 'り', 足: 'り', 懲: 'り',
  // え段
  寝: 'ね', 出: 'で', 得: 'え', 経: 'へ', 建: 'て', 逃: 'げ', 混: 'ぜ',
  比: 'べ', 並: 'べ',
  // ⚠️ 故意**不收录**「帰」。
  //    帰る 读 かえる，末尾的「帰」单独看是「か」（あ段），
  //    但这个词是五段里的例外，光凭一个字判断会把"依据"弄虚。
  //    收进去的话结论碰巧对，但那是运气 —— 表里现在只放"读音唯一"的字。
};

/** 假名 → 它在五十音里属于哪一段（a/i/u/e/o）。查不到返回 null。 */
const KANA_SEG = (() => {
  const ROWS = [
    ['あ', 'い', 'う', 'え', 'お'], ['か', 'き', 'く', 'け', 'こ'],
    ['が', 'ぎ', 'ぐ', 'げ', 'ご'], ['さ', 'し', 'す', 'せ', 'そ'],
    ['ざ', 'じ', 'ず', 'ぜ', 'ぞ'], ['た', 'ち', 'つ', 'て', 'と'],
    ['だ', 'ぢ', 'づ', 'で', 'ど'], ['な', 'に', 'ぬ', 'ね', 'の'],
    ['は', 'ひ', 'ふ', 'へ', 'ほ'], ['ば', 'び', 'ぶ', 'べ', 'ぼ'],
    ['ぱ', 'ぴ', 'ぷ', 'ぺ', 'ぽ'], ['ま', 'み', 'む', 'め', 'も'],
    ['ら', 'り', 'る', 'れ', 'ろ'],
  ];
  const segs = ['a', 'i', 'u', 'e', 'o'];
  const m = new Map();
  for (const row of ROWS) row.forEach((ch, i) => m.set(ch, segs[i]));
  return m;
})();

export function detectType(word) {
  const w = String(word || '').trim();
  if (!w) return { type: 'unknown', reason: '没有内容', uncertain: false };

  // ⚠️ 先挡住"根本不是日语"的输入。
  //    第一版没有这一道，于是输入 "12345" 会被判成名词，并生成一整张
  //    「12345だ / 12345です / 12345ではない…」的表 —— 看着像正经结果，
  //    实际全是垃圾。**垃圾输出比报错更糟**：用户会以为程序看懂了。
  //    判据：日语词一定含有假名；汉字词（学生）另放行。
  const hasKana = /[ぁ-ゖァ-ヺー]/.test(w);
  const allKanji = /^[\u4e00-\u9fff々〆ヶ]+$/.test(w);
  if (!hasKana && !allKanji) {
    return { type: 'unknown', reason: `「${w}」看起来不是日语词（既没有假名，也不是汉字词）`, uncertain: false };
  }

  // 不规则动词优先（它们的形状最特殊，也最容易被误判）
  if (w === '来る' || w === 'くる' || w === '來る') {
    return { type: 'kuru', reason: '「来る」是不规则动词（カ变）', uncertain: false };
  }
  if (w === 'する' || w === '為る') {
    return { type: 'suru', reason: '「する」是不规则动词（サ变）', uncertain: false };
  }
  // 〜する 的复合动词：勉強する / 説明する / 愛する…
  // ⚠️ 但「愛する」这类在敬体里是 愛します，和普通 する 一样，所以归到 suru。
  if (chars(w).length >= 3 && w.endsWith('する')) {
    return {
      type: 'suru',
      reason: `以「する」结尾的复合动词（${stripSuru(w)} + する）`,
      uncertain: false,
    };
  }

  const c = lastCh(w);

  if (c === 'る') {
    // 一段动词：る 前面是 い段 或 え段 假名（食べる / 見る / 起きる）
    // 五段动词：る 前面是 あ/う/お 段（分かる / 取る / 折る）
    //
    // ⚠️⚠️ 这里有个**真 bug 修过一次**，必须写下来：
    //    原来的写法是「看 る 前面那一个字符在不在い段/え段表里」。
    //    可「見る」「帰る」的词干是**汉字**，`る` 前面是 見 / 帰，
    //    拿汉字去假名表里查当然查不到 → 被判成五段 →
    //    生成「見ります」「見らない」这种**根本不存在**的写法。
    //    最危险的地方在于：它看着像日语，初学者完全发现不了。
    //    修法：**看穿汉字**，用它的读音（み / かえ…）来判断。
    const prev = chars(w).slice(-2, -1)[0] || '';
    let probe = prev;                 // 用来判断段的那个音
    let usedReading = '';             // 如果是靠汉字读音判断的，记下来给用户看
    if (prev && !KANA_SEG.has(prev) && KANJI_TAIL_READING[prev]) {
      probe = KANJI_TAIL_READING[prev];
      usedReading = `${prev}（读作「${probe}」）`;
    }

    // え段 → 几乎可以确定是一段，不吓唬用户
    if (KANA_SEG.get(probe) === 'e') {
      return {
        type: 'ichidan',
        reason: `以「${usedReading || prev}る」结尾，前面在え段上 → 一段动词`,
        uncertain: false,
      };
    }
    // い段 → 一段和五段**外形完全一样**（食べる vs 帰る），只能存疑
    if (KANA_SEG.get(probe) === 'i') {
      return {
        type: 'ichidan',
        reason: `以「${usedReading || prev}る」结尾，前面在い段上 → 按一段动词处理`,
        uncertain: true,
      };
    }
    // 剩下的（あ/う/お段、汉字读不出来）都按五段。
    // ⚠️ 汉字读音判断不了的时候要**明说存疑**。
    //    这里踩过一次：我把「帰」也塞进了读音表（帰→か），
    //    结果「帰る」被判成"前面在あ段 → 五段，很确定"。
    //    五段的结论**碰巧对了**，但"很确定"是假的 ——
    //    我根本不知道它的读音，是在瞎猜。
    //    教训：**结论对不等于依据对**。依据不牢就必须标 uncertain，
    //    否则用户看到"很确定"就不会去核对，下次换个词就真错了。
    if (!KANA_SEG.has(probe)) {
      return {
        type: 'godan',
        reason: `以「る」结尾，但前面是汉字「${prev}」，读音判断不了 → 先按五段动词处理`,
        uncertain: true,
      };
    }
    return { type: 'godan', reason: `以「る」结尾、前面在${KANA_SEG.get(probe)}段 → 五段动词`, uncertain: false };
  }

  if ('うつくぐすぬぶむ'.includes(c)) {
    return { type: 'godan', reason: `以「${c}」结尾 → 五段动词`, uncertain: false };
  }

  if (c === 'い') {
    // ⚠️ 「きれい」「嫌い」是な形容词，虽然以 い 结尾。这是著名陷阱。
    if (/[き嫌]れい$|嫌い$|^きれい$/.test(w)) {
      return { type: 'na-adj', reason: `「${w}」虽然以「い」结尾，但是な形容词（著名的例外）`, uncertain: false };
    }
    return { type: 'i-adj', reason: '以「い」结尾 → い形容词', uncertain: false };
  }

  return {
    type: 'noun',
    reason: '不像动词也不像形容词 → 按名词处理（可以接「だ / です」等）。'
      // ⚠️ 这里要如实告诉用户"名词和な形容词怎么分"：
      //    光看一个词分不出来（「静か」是な形容词，「学生」是名词），
      //    但**变形几乎一样**，所以判错的代价很小。
      //    不写清楚的话，用户会以为把一个な形容词判成名词是"程序坏了"。
      + 'な形容词（静か・元気）和名词（学生）光看词形分不出来，但两者变形几乎一样；'
      + '如果它是な形容词，把类型改成「な形容词」会更准确。',
    uncertain: false,
  };
}

// ---------------------------------------------------------------------------
// 四、各词类的词干
// ---------------------------------------------------------------------------
/**
 * 五段动词的四个词干。用"把最后一个假名换掉"来算，而不是查表 ——
 * 换掉之后**同一个辅音行的其他段**就是词干，这样规则看得见、可验证。
 *
 * 五十音的行表：给一个假名，返回它所在行的五个假名 [あ段, い段, う段, え段, お段]
 */
const ROW_OF = (() => {
  const ROWS = [
    ['あ', 'い', 'う', 'え', 'お'],
    ['か', 'き', 'く', 'け', 'こ'],
    ['が', 'ぎ', 'ぐ', 'げ', 'ご'],
    ['さ', 'し', 'す', 'せ', 'そ'],
    ['ざ', 'じ', 'ず', 'ぜ', 'ぞ'],
    ['た', 'ち', 'つ', 'て', 'と'],
    ['だ', 'ぢ', 'づ', 'で', 'ど'],
    ['な', 'に', 'ぬ', 'ね', 'の'],
    ['は', 'ひ', 'ふ', 'へ', 'ほ'],
    ['ば', 'び', 'ぶ', 'べ', 'ぼ'],
    ['ぱ', 'ぴ', 'ぷ', 'ぺ', 'ぽ'],
    ['ま', 'み', 'む', 'め', 'も'],
    ['ら', 'り', 'る', 'れ', 'ろ'],
  ];
  const m = new Map();
  for (const row of ROWS) for (const ch of row) m.set(ch, row);
  return m;
})();

/**
 * 取五段动词的某个词干。
 * @param {string} dict 辞书形（以う段假名结尾）
 * @param {0|1|2|3|4} seg 0=あ段(未然) 1=い段(連用) 2=う段(辞书) 3=え段(仮定) 4=お段
 */
function godanStem(dict, seg) {
  const c = lastCh(dict);
  const row = ROW_OF.get(c);
  const base = dropLast(dict);
  if (!row) {
    // 片假名动词（比如「サボる」）。走同一套段位移，但码位整体 +0x60。
    // 注意「ウ」的あ段同样是「ワ」而不是「ア」，理由同下面的注释。
    const kata = String.fromCharCode(c.charCodeAt(0) - 0x60);
    const krow = ROW_OF.get(kata);
    if (krow) {
      if (seg === 0 && krow[0] === 'あ') return base + 'ワ';
      return base + String.fromCharCode(krow[seg].charCodeAt(0) + 0x60);
    }
    return base + c;
  }
  // ⚠️⚠️ 一个必须单独处理的例外，踩过才知道：
  //    「う」的**あ段是「わ」，不是「あ」**。
  //    五十音图上是把 あ 摆在 う 下面，但实际接续用的是 わ：
  //      使う → 使わない / 使われる / 使わせる  （不是 使あない）
  //      買う → 買わない / 買われる
  //    第一版直接拿五十音图那一列取值，于是产出「使あない」这种
  //    **日语里不存在的写法**。危险之处在于「あ」单独出现看着也不像错的，
  //    初学者会照着背下来。
  //    现代日语里 わ 行只有「わ」这一个音还在当词尾用（ゐ・ゑ・を 都退了）。
  if (seg === 0 && row[0] === 'あ') return base + 'わ';
  return base + row[seg];
}

// ---------------------------------------------------------------------------
// 五、变形表
// ---------------------------------------------------------------------------
/**
 * 一条变形的结构：
 *   { name, form, note, rule }
 *     name  用户看的名字（ます形 / て形 / ない形…）
 *     form  变出来的写法
 *     rule  这一条用的规则（一句话讲清"怎么变"）
 *     note  额外提醒（例外、口语说法、意思差别）
 *
 * ⚠️ 设计原则：**只写有把握的**。
 *    没把握的形式（比如各种文语残留、罕用敬语）宁可**不列**，
 *    也不列一个可能是错的。用户是初学者，看到错的也认不出来 ——
 *    错误会直接变成他的错误记忆。宁少勿错。
 */

/** 五段动词的全部变形 */
function godanForms(dict) {
  const c = lastCh(dict);
  const a = godanStem(dict, 0);   // 未然形
  const i = godanStem(dict, 1);   // 連用形
  const e = godanStem(dict, 3);   // 仮定形
  const o = godanStem(dict, 4);   // 意向形
  const teTa = teTaOf(c);

  const out = [];
  out.push({ name: 'ます形（敬体现在）', form: i + 'ます', rule: `把「${c}」变成い段「${lastCh(i)}」，再加「ます」` });
  out.push({ name: 'ません（敬体否定）', form: i + 'ません', rule: 'ます形把「ます」换成「ません」' });
  out.push({ name: 'ました（敬体过去）', form: i + 'ました', rule: 'ます形把「ます」换成「ました」' });
  out.push({ name: 'ませんでした（敬体过去否定）', form: i + 'ませんでした', rule: 'ません + でした' });
  out.push({ name: '辞书形（原形）', form: dict, rule: '词典里查到的就是这一形' });
  // ⚠️ 规则的说明文字里要说清"变成哪一段的哪个音"。
  //    「う」的あ段是「わ」—— 直接写「变成あ段「わ」」会让人觉得前后不一致，
  //    所以那一档把话说明白（详见 godanStem 上方那段注释）。
  const aLabel = lastCh(a) === 'わ' ? 'あ段「わ」' : `あ段「${lastCh(a)}」`;
  out.push({ name: 'ない形（简体否定）', form: a + 'ない', rule: `把「${c}」变成${aLabel}，再加「ない」` });
  out.push({ name: 'なかった（简体过去否定）', form: a + 'なかった', rule: 'ない形把「ない」换成「なかった」' });
  // ⚠️⚠️ 这里踩过一个很典型的坑，写下来免得再犯：
  //    て/た 的接续对象是**词干**（去掉词尾那个音之后剩下的部分），不是连用形。
  //      書く → 書い + て = 書いて       （词干 書い）
  //      書く → 書き + て = 書きて ✗    （连用形 書き 是接「ます」用的）
  //    第一版写成了 `i + teTa[0]`，于是产出「書きいて」——
  //    而且**看着挺像日语**，不逐条对着标准答案验根本发现不了。
  //    这正是必须给变形引擎写测试的原因：用户自己能发现的错不算最坏，
  //    他验不出来的错才会变成他的错误记忆。
  const stem = dropLast(i);   // 連用形去掉最后一个假名 = 词干
  const teForm = stem + (teTa ? teTa[0] : 'て');
  out.push({
    name: 'た形（简体过去）',
    form: stem + (teTa ? teTa[1] : 'た'),
    rule: teTa ? `词干「${stem}」接「た」时发生音便：「${c}」→「${teTa[1]}」` : `词干接「た」`,
    note: teTa ? undefined : '（这个词的音便规则没覆盖到，请核对）',
  });
  out.push({
    name: 'て形',
    form: teForm,
    rule: teTa ? `词干「${stem}」接「て」时发生音便：「${c}」→「${teTa[0]}」` : `词干接「て」`,
  });
  out.push({ name: 'ば形（条件）', form: e + 'ば', rule: `把「${c}」变成え段「${lastCh(e)}」，再加「ば」` });
  out.push({
    name: '可能形（能做）',
    form: e + 'る',
    rule: `把「${c}」变成え段「${lastCh(e)}」，再加「る」`,
    note: '口语里也常说「〜ことができる」',
  });
  out.push({
    name: '被动形（被…）',
    form: a + 'れる',
    rule: `未然形（${lastCh(a)}）+「れる」`,
    note: '和可能形长得不一样，别看混',
  });
  out.push({
    name: '使役形（让…做）',
    form: a + 'せる',
    rule: `未然形（${lastCh(a)}）+「せる」`,
  });
  out.push({
    name: '使役被动形（被迫做）',
    form: a + 'せられる',
    rule: `未然形（${lastCh(a)}）+「せられる」`,
    note: '口语里常缩成「〜される」（話される）',
  });
  out.push({ name: '命令形（下命令）', form: e, rule: `把「${c}」变成え段「${lastCh(e)}」` });
  out.push({
    name: '意志形（…吧）',
    form: o + 'う',
    rule: `把「${c}」变成お段「${lastCh(o)}」，再加「う」`,
    note: '「〜ましょう」是它的敬体',
  });
  out.push({
    name: '敬体意志形（…吧，客气）',
    form: i + 'ましょう',
    rule: 'ます形把「ます」换成「ましょう」',
  });
  out.push({ name: 'ている（正在…／…着）', form: teForm + 'いる', rule: 'て形 + 「いる」', note: '口语常缩成「〜てる」' });
  return out;
}

/** 一段动词的全部变形 */
function ichidanForms(dict) {
  const stem = dropLast(dict);            // 食べる → 食べ
  const c = lastCh(dict);                 // る
  const out = [];
  out.push({ name: 'ます形（敬体现在）', form: stem + 'ます', rule: `去掉词尾「${c}」，再加「ます」` });
  out.push({ name: 'ません（敬体否定）', form: stem + 'ません', rule: 'ます形把「ます」换成「ません」' });
  out.push({ name: 'ました（敬体过去）', form: stem + 'ました', rule: 'ます形把「ます」换成「ました」' });
  out.push({ name: 'ませんでした（敬体过去否定）', form: stem + 'ませんでした', rule: 'ません + でした' });
  out.push({ name: '辞书形（原形）', form: dict, rule: '词典里查到的就是这一形' });
  out.push({ name: 'ない形（简体否定）', form: stem + 'ない', rule: `去掉「${c}」，再加「ない」` });
  out.push({ name: 'なかった（简体过去否定）', form: stem + 'なかった', rule: 'ない形把「ない」换成「なかった」' });
  out.push({
    name: 'た形（简体过去）', form: stem + 'た',
    rule: `去掉「${c}」，加「た」`,
    note: '★ 一段动词没有音便，直接接就好 —— 这是它和五段最大的区别',
  });
  out.push({ name: 'て形', form: stem + 'て', rule: `去掉「${c}」，加「て」`, note: '★ 也没有音便' });
  out.push({ name: 'ば形（条件）', form: stem + 'れば', rule: `去掉「${c}」，加「れば」` });
  out.push({ name: '可能形（能做）', form: stem + 'られる', rule: `${stem} + 「られる」`, note: '口语里常缩成「〜れる」（食べれる）' });
  out.push({ name: '被动形（被…）', form: stem + 'られる', rule: `${stem} + 「られる」`, note: '★ 形态和可能形一模一样，靠句子意思区分' });
  out.push({ name: '使役形（让…做）', form: stem + 'させる', rule: `${stem} + 「させる」` });
  out.push({ name: '使役被动形（被迫做）', form: stem + 'させられる', rule: `${stem} + 「させられる」` });
  out.push({
    name: '命令形（下命令）', form: stem + 'ろ',
    rule: `去掉「${c}」，加「ろ」`,
    note: '⚠️ 一段动词的命令形很生硬，日常基本不用（「食べろ」听着很凶）',
  });
  out.push({ name: '意志形（…吧）', form: stem + 'よう', rule: `${stem} + 「よう」`, note: '「〜ましょう」是它的敬体' });
  out.push({ name: '敬体意志形（…吧，客气）', form: stem + 'ましょう', rule: 'ます形把「ます」换成「ましょう」' });
  out.push({ name: 'ている（正在…／…着）', form: stem + 'ている', rule: 'て形 + 「いる」', note: '口语常缩成「〜てる」' });
  return out;
}

/** する / 〜する 的变形 */
function suruForms(dict) {
  const isPlainSuru = (dict === 'する' || dict === '為る');
  const prefix = isPlainSuru ? '' : stripSuru(dict);  // 勉強する → 勉強
  const base = prefix || 'する';
  const out = [];
  const push = (name, form, rule, note) => out.push({ name, form, rule, note });

  push('ます形（敬体现在）', prefix + 'します', `「する」→「します」${prefix ? `（${prefix} + します）` : ''}`);
  push('ません（敬体否定）', prefix + 'しません', 'します → しません');
  push('ました（敬体过去）', prefix + 'しました', 'します → しました');
  push('ませんでした（敬体过去否定）', prefix + 'しませんでした', 'しません + でした');
  push('辞书形（原形）', dict, '词典里查到的就是这一形');
  push('ない形（简体否定）', prefix + 'しない', `${base} → ${prefix}しない`);
  push('なかった（简体过去否定）', prefix + 'しなかった', 'しない → しなかった');
  push('た形（简体过去）', prefix + 'した', 'する → した');
  push('て形', prefix + 'して', 'する → して');
  push('ば形（条件）', prefix + 'すれば', 'する → すれば');
  push('可能形（能做）', prefix + 'できる', '★「する」的可能形是「できる」，不是「しれる」', '「勉強する」→「勉強できる」');
  push('被动形（被…）', prefix + 'される', 'する → される');
  push('使役形（让…做）', prefix + 'させる', 'する → させる');
  push('使役被动形（被迫做）', prefix + 'させられる', 'する → させられる');
  push('命令形（下命令）', prefix + 'しろ', 'する → しろ', '也有「せよ」这种较古的说法');
  push('意志形（…吧）', prefix + 'しよう', 'する → しよう', '「〜ましょう」是它的敬体');
  push('敬体意志形（…吧，客气）', prefix + 'しましょう', 'します → しましょう');
  push('ている（正在…／…着）', prefix + 'している', 'して + いる', '口语常缩成「〜してる」');
  return out;
}

/** 来る 的变形 */
function kuruForms(dict) {
  const out = [];
  const push = (name, form, rule, note) => out.push({ name, form, rule, note });
  push('ます形（敬体现在）', '来ます（きます）', '★ 汉字写「来ます」，读音变成「きます」', '「来る」是カ变，读音会变，这是它最难的地方');
  push('ません（敬体否定）', '来ません（きません）', '来ます → 来ません');
  push('ました（敬体过去）', '来ました（きました）', '来ます → 来ました');
  push('ませんでした（敬体过去否定）', '来ませんでした（きませんでした）', '来ません + でした');
  push('辞书形（原形）', dict, '词典里查到的就是这一形');
  push('ない形（简体否定）', '来ない（こない）', '★ 读音是「こない」，不是「きない」');
  push('なかった（简体过去否定）', '来なかった（こなかった）', '来ない → 来なかった');
  push('た形（简体过去）', '来た（きた）', '来る → 来た（读音 きた）');
  push('て形', '来て（きて）', '来る → 来て（读音 きて）');
  push('ば形（条件）', '来れば（くれば）', '★ 读音是「くれば」');
  push('可能形（能做）', '来られる（こられる）', '来られる', '口语里常说「来れる（これる）」');
  push('被动形（被…）', '来られる（こられる）', '来られる', '形态和可能形一样');
  push('使役形（让…做）', '来させる（こさせる）', '来させる');
  push('使役被动形（被迫做）', '来させられる（こさせられる）', '来させられる');
  push('命令形（下命令）', '来い（こい）', '★ 命令形是「来い」');
  push('意志形（…吧）', '来よう（こよう）', '来よう');
  push('敬体意志形（…吧，客气）', '来ましょう（きましょう）', '来ます → 来ましょう');
  push('ている（正在…／…着）', '来ている（きている）', '来て + いる');
  return out;
}

/** い形容词的变形 */
function iAdjForms(dict) {
  const stem = dropLast(dict);   // 高い → 高
  const out = [];
  const push = (name, form, rule, note) => out.push({ name, form, rule, note });
  push('辞书形（原形）', dict, '词典里查到的就是这一形');
  push('ない形（否定）', stem + 'くない', `去掉「い」，加「くない」`);
  push('なかった（过去否定）', stem + 'くなかった', 'くない → くなかった');
  push('た形（过去）', stem + 'かった', `★ 去掉「い」，加「かった」（不是「いだった」）`);
  push('く形（副词化）', stem + 'く', `去掉「い」，加「く」`, '「高い」→「高く」（高く売れる：能卖高价）');
  push('ば形（条件）', stem + 'ければ', `去掉「い」，加「ければ」`);
  push('たら形（口语条件）', stem + 'かったら', 'た形 + 「ら」');
  push('なる（变得…）', stem + 'くなる', 'く形 + 「なる」');
  push('そう（看起来…）', stem + 'そう', `去掉「い」，加「そう」`, '⚠️「いい」是例外：よさそう');
  push('敬体现在', dict + 'です', '形容词 + 「です」', '★ 敬体只是加「です」，形容词本身不变');
  push('敬体否定', stem + 'くないです', 'ない形 + 「です」', '也有「〜くありません」这种说法');
  push('敬体过去', stem + 'かったです', 'た形 + 「です」');
  push('て形（并列）', stem + 'くて', `去掉「い」，加「くて」`);
  if (dict === 'いい' || dict === 'よい') {
    push('★ 注意：いい 的变形', 'いい → よくない / よかった / よくて', '「いい」所有变形都用「よ」', '这是初学者最容易错的词');
  }
  return out;
}

/** な形容词 / 名词的变形 */
function naAdjForms(dict, kind) {
  const isNoun = kind === 'noun';
  const out = [];
  const push = (name, form, rule, note) => out.push({ name, form, rule, note });
  push('辞书形（原形）', dict, isNoun ? '名词本身' : '词典里查到的就是这一形');
  push('だ（简体现在）', dict + 'だ', `${dict} + 「だ」`, isNoun ? undefined : 'な形容词在名词前要用「な」：静かな部屋');
  push('です（敬体现在）', dict + 'です', `${dict} + 「です」`);
  push('ではない（简体否定）', dict + 'ではない', `${dict} + 「ではない」`, '口语常说「〜じゃない」');
  push('じゃない（口语否定）', dict + 'じゃない', `${dict} + 「じゃない」`);
  push('ではありません（敬体否定）', dict + 'ではありません', `${dict} + 「ではありません」`, '口语常说「〜じゃありません」');
  push('だった（简体过去）', dict + 'だった', `${dict} + 「だった」`);
  push('でした（敬体过去）', dict + 'でした', `${dict} + 「でした」`);
  push('ではなかった（过去否定）', dict + 'ではなかった', `${dict} + 「ではなかった」`, '口语：〜じゃなかった');
  push('ではありませんでした（敬体过去否定）', dict + 'ではありませんでした', `${dict} + 「ではありませんでした」`);
  push('なら（条件）', dict + 'なら', `${dict} + 「なら」`, '「〜ならば」是较正式的说法');
  // ⚠️ 名字要短、要能当"筛选用关键字"，所以不要把「＋名词」这种说明塞进名字里
  //    （塞进去之后按「名词」筛规则会把这一条也捞出来，很怪）。说明放 rule / note。
  if (!isNoun) {
    push('な + 名词', dict + 'な', `${dict} + 「な」，后面接名词`, 'な形容词修饰名词必须加「な」：静かな部屋');
  }
  push('に（副词化）', dict + 'に', `${dict} + 「に」`, '静かに話す：安静地说');
  return out;
}

// ---------------------------------------------------------------------------
// 六、对外主函数
// ---------------------------------------------------------------------------

/** 词类的中文显示名 */
export const TYPE_LABELS = {
  godan: '五段动词（う段结尾，词尾活用）',
  ichidan: '一段动词（る 结尾，去る加词尾）',
  suru: 'サ变（する / 〜する）',
  kuru: 'カ变（来る）',
  'i-adj': 'い形容词',
  'na-adj': 'な形容词',
  noun: '名词（接「だ / です」）',
  unknown: '认不出来',
};

/** 有哪几类可以手动切换（界面上要让用户能改，因为光看形状会判错） */
export const CHOOSABLE_TYPES = ['godan', 'ichidan', 'suru', 'kuru', 'i-adj', 'na-adj', 'noun'];

/**
 * 主函数：给一个辞书形，推出它的各种形态。
 *
 * @param {string} word 辞书形（例：使う / 食べる / 静か / 高い）
 * @param {object} opts { type } —— 可以强制指定词类（界面上让用户改）
 * @returns {{word, type, typeLabel, reason, uncertain, forms, warnings}}
 */
export function conjugate(word, opts = {}) {
  const w = String(word || '').trim();
  const detected = detectType(w);
  const type = opts.type || detected.type;

  const warnings = [];
  if (!w) return { word: '', type: 'unknown', typeLabel: TYPE_LABELS.unknown, reason: '没有内容', uncertain: false, forms: [], warnings };
  if (type === 'unknown') return { word: w, type, typeLabel: TYPE_LABELS.unknown, reason: detected.reason, uncertain: false, forms: [], warnings };

  // 用户手动改过类型时，要说清楚"我是按你选的类型变的"
  if (opts.type && opts.type !== detected.type) {
    warnings.push(`你手动指定了「${TYPE_LABELS[opts.type] || opts.type}」。形状上看它更像「${TYPE_LABELS[detected.type]}」——如果变形不对，先把类型改回去。`);
  }
  if (detected.uncertain && type === detected.type) {
    warnings.push(`⚠️ 以「る」结尾的动词光看形状分不出五段还是一段（帰る・切る・入る 都是五段，食べる・見る 是一段）。这里按「${TYPE_LABELS[type]}」处理，不对就一定手动改类型。`);
  }

  let forms = [];
  if (type === 'godan') {
    const c = lastCh(w);
    if (!teTaOf(c) && chars(w).length <= 1) {
      warnings.push(`「${w}」太短，不像完整的五段动词。`);
    }
    forms = godanForms(w);
    // 五段动词里唯一的音便例外
    if (w === '行く' || w === 'いく' || w === '逝く') {
      const i = forms.find((f) => f.name === 'て形');
      const t = forms.find((f) => f.name === 'た形（简体过去）');
      if (i) { i.form = w === 'いく' ? 'いって' : '行って'; i.note = '★ 例外：行く 的て形是「行って」，不是「行いて」'; }
      if (t) { t.form = w === 'いく' ? 'いった' : '行った'; t.note = '★ 同上，行く 的た形是「行った」'; }
    }
  } else if (type === 'ichidan') {
    if (!w.endsWith('る')) {
      warnings.push(`一段动词必须以「る」结尾，但「${w}」不是 —— 类型可能选错了。`);
    }
    forms = ichidanForms(w);
  } else if (type === 'suru') {
    forms = suruForms(w);
  } else if (type === 'kuru') {
    forms = kuruForms(w);
  } else if (type === 'i-adj') {
    if (!w.endsWith('い')) warnings.push(`い形容词必须以「い」结尾，但「${w}」不是 —— 类型可能选错了。`);
    forms = iAdjForms(w);
  } else if (type === 'na-adj' || type === 'noun') {
    forms = naAdjForms(w, type);
  }

  // 过滤掉空的（理论上不会有，但宁可少一条也不要显示一条空的）
  forms = forms.filter((f) => f && f.form && String(f.form).trim());

  return {
    word: w, type, typeLabel: TYPE_LABELS[type] || type,
    reason: detected.reason, uncertain: detected.uncertain, forms, warnings,
  };
}

/**
 * "给定一个形态，规则是什么" —— 反向查规则表。
 *
 * 为什么用户会需要这个：他可能在课文里看到「食べさせられた」，
 * 想知道"这是怎么变出来的"。还原器告诉他"← 食べる"，但没告诉他**规则**。
 *
 * @param {string} key 形态关键字（如 'て' 'た' 'ない' 'ます' 'ば' 'られる'），会做包含匹配
 * @returns {Array<{type:string, typeLabel:string, rule:string, example:string}>}
 */
export function ruleTable(key) {
  const k = String(key || '').trim();
  const rows = [];
  const add = (type, name, rule, example, note) => {
    // ⚠️ 筛选时也要看 note。
    //    为什么：像「一段动词的て形没有音便」这种**最关键的提醒**是写在 note 里的，
    //    不参与筛选的话，用户搜「音便」就会漏掉它 —— 而那恰恰是他最该看到的一条。
    if (k && !(name.includes(k) || rule.includes(k) || example.includes(k) || String(note || '').includes(k))) return;
    rows.push({ type, typeLabel: TYPE_LABELS[type], name, rule, example, note });
  };

  // 用几个代表性词跑一遍，直接拿真实结果当例子 —— 这样规则和例子永远一致，
  // 不会出现"规则改了、例子还是旧的"那种文档腐坏。
  const demo = { godan: '書く', ichidan: '食べる', suru: 'する', kuru: '来る', 'i-adj': '高い', 'na-adj': '静か', noun: '学生' };
  for (const [type, w] of Object.entries(demo)) {
    const r = conjugate(w, { type });
    for (const f of r.forms) add(type, f.name, f.rule, f.form, f.note);
  }
  return rows;
}
