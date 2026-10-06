// ============================================================================
// views/stats.js —— 学习统计
//
// 设计原则：**只显示"看完知道该干什么"的数字**。
//
// 明确**不做**热力图（用户 2026-10 反馈："对实际学习没有帮助的花哨功能"）。
// 理由记在这里，免得以后有人又想加回来：
//   · 热力图衡量的是"打卡"，不是"学会"——它奖励每天来点一下，
//     却分不清"练了 20 个已经记牢的词"和"啃下 10 个新词"；
//   · 它最容易诱使人为了不断 streak 去做无效复习，与"真正记住"这个目标背道而驰；
//   · 它占一大块版面，信息量却不如下面三个数字。
//
// 保留的三块都是**行动导向**的：
//   1. 熟练度分布  → 我是在原地打转，还是在往前走？
//   2. 未来 14 天到期量 → 我是不是给自己堆了还不完的债？
//   3. 错题 Top 20 → 下一步该练哪些词？
//
// ⚠️ 本视图不注册任何全局监听，因此 destroy() 只需要清空内容。
//    如果以后要加监听，必须同时补 destroy（test-contract.mjs 会静态检查）。
// ============================================================================
import { el } from '../ui.js';
import * as db from '../db.js';
import { summarize, forecast } from '../srs.js';
import * as vd from '../vocabdata.js';
// 唯一允许的跨视图 import，理由：统计页最该做的事是"指出下一步练什么"，
// 而练的地方是背单词的错题标签页。若改成 location.hash='#/vocab'，
// 用户会落到「今日」而不是「错题」，还得自己再点一次，等于没指路。
import { goVocabTab } from './vocab.js';

/** 熟练度分档：从"刚接触"到"记牢"，按 SRS 状态 + 间隔划分 */
const BUCKETS = [
  { key: 'new', label: '还没开始', hint: '加进生词本但一次都没练过', color: 'var(--text-dim)' },
  { key: 'learning', label: '学习中', hint: '才练过几次，记忆还不稳', color: 'var(--warn)' },
  { key: 'young', label: '复习中', hint: '能想起来，但间隔还很短（不满 21 天）', color: 'var(--accent)' },
  { key: 'mature', label: '已记牢', hint: '间隔已超过 21 天，算真正进入长期记忆', color: 'var(--ok)' },
];

export default {
  id: 'stats',
  title: '学习统计',

  async render(root) {
    root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [el('h2', { text: '学习统计' })]),
      el('p', { class: 'faint', text: '这里只放"看完知道下一步该干什么"的数字。热力图之类的打卡指标刻意不做——它衡量的是活跃度，不是掌握度。' }),
    ]));

    let cards, overview, mistakes, srsOk = true;
    try {
      [cards, overview, mistakes] = await Promise.all([
        vd.allCards(),
        vd.reviewOverview(),
        vd.listMistakes({ includeResolved: true }),
      ]);
    } catch (e) {
      srsOk = false;
      root.appendChild(el('div', { class: 'banner banner-error', text: '读取学习数据失败：' + ((e && e.message) || e) }));
    }
    if (!srsOk) return;

    renderMastery(root, cards, overview);
    renderForecast(root, cards);
    renderMistakes(root, mistakes);
    renderLibraryTotals(root).catch(() => { /* 累计数字是装饰，读失败不影响主体 */ });
  },
};

// ---------------------------------------------------------------------------
// 一、熟练度分布
// ---------------------------------------------------------------------------
function renderMastery(root, cards, overview) {
  const s = summarize(cards);
  const counts = {
    new: s.new,
    learning: s.learning + s.relearning,
    young: s.young,
    mature: s.mature,
  };
  const total = s.total || 0;
  const card = el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, [
      el('h3', { text: '熟练度分布' }),
      el('span', { class: 'badge', text: `${total} 个词在学` }),
    ]),
  ]);

  if (!total) {
    card.appendChild(el('p', { class: 'faint', text: '还没有开始练习的词。去「背单词」加几个词，这里就会长出进度条。' }));
    root.appendChild(card);
    return;
  }

  const bars = el('div', { class: 'dist' });
  for (const b of BUCKETS) {
    const n = counts[b.key] || 0;
    const pct = total ? Math.round((n / total) * 100) : 0;
    bars.appendChild(el('div', { class: 'dist-row' }, [
      el('div', { class: 'dist-head' }, [
        el('span', { class: 'dist-label', text: b.label }),
        el('span', { class: 'dist-num', text: `${n} 个 · ${pct}%` }),
      ]),
      el('div', { class: 'dist-track' }, [
        el('div', { class: 'dist-fill', style: { width: pct + '%', background: b.color } }),
      ]),
      el('div', { class: 'dist-hint', text: b.hint }),
    ]));
  }
  card.appendChild(bars);

  // 一句"该怎么解读"的结论 —— 这才是统计页存在的意义，不是给一堆数字让人自己猜
  const maturePct = total ? Math.round((s.mature / total) * 100) : 0;
  let verdict;
  if (maturePct >= 50) verdict = '已记牢的占了一半以上，节奏很健康。继续保持，别急着加新词。';
  // ⚠️ 这些 verdict 会**原样显示在页面上**，所以不能用 Markdown 的 `**加粗**`
  //   （本项目没有 Markdown 渲染器，`**` 会连星号一起显示出来）。
  //   要强调就用中文引号「」。tools/find-markdown.mjs 会扫这类问题。
  else if (s.young > s.mature) verdict = '大部分词还在短间隔复习里打转。这时候「加新词」要克制，先把这一批推到 21 天以上，否则复习量会滚雪球。';
  else verdict = '正在积累期。前 21 天是最难的，坚持把同一批词推到长间隔，比不停换新词有效得多。';
  card.appendChild(el('p', { class: 'faint', style: { marginTop: '12px', fontSize: '.86rem' }, text: verdict }));

  root.appendChild(card);
}

// ---------------------------------------------------------------------------
// 二、未来 14 天到期量
// ---------------------------------------------------------------------------
function renderForecast(root, cards) {
  const days = forecast(cards, Date.now(), 14);
  const max = Math.max(1, ...days.map((d) => d.count));
  const tomorrow = days[1] ? days[1].count : 0;
  const week = days.slice(0, 7).reduce((a, d) => a + d.count, 0);

  const card = el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, [
      el('h3', { text: '未来 14 天到期量' }),
      el('span', { class: 'badge', text: `今天 ${days[0] ? days[0].count : 0} 个` }),
    ]),
  ]);

  // 柱状图：每天一根，今天在最左
  const chart = el('div', { class: 'fore' });
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const h = Math.round((d.count / max) * 100);
    const label = i === 0 ? '今天' : i === 1 ? '明天' : `${i}天后`;
    chart.appendChild(el('div', { class: 'fore-col', title: `${d.day}：${d.count} 个` }, [
      el('div', { class: 'fore-count', text: d.count ? String(d.count) : '' }),
      el('div', { class: 'fore-bar-wrap' }, [
        el('div', { class: 'fore-bar' + (i === 0 ? ' today' : ''), style: { height: Math.max(d.count ? 4 : 0, h) + '%' } }),
      ]),
      el('div', { class: 'fore-label', text: label }),
    ]));
  }
  card.appendChild(chart);

  let verdict;
  if (!week && !tomorrow) verdict = '未来一周没有到期的复习。可以放心加新词。';
  else if (week > 150) verdict = `未来 7 天要复习 ${week} 个词，负担偏重。建议先「停加新词」，把这批消化掉再看。`;
  else verdict = `未来 7 天共 ${week} 个复习，平均每天 ${Math.round(week / 7)} 个。这个量比较舒服。`;
  card.appendChild(el('p', { class: 'faint', style: { marginTop: '12px', fontSize: '.86rem' }, text: verdict }));

  root.appendChild(card);
}

// ---------------------------------------------------------------------------
// 三、错题 Top 20
// ---------------------------------------------------------------------------
function renderMistakes(root, mistakes) {
  const unresolved = mistakes.filter((m) => !m.resolved);
  const card = el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, [
      el('h3', { text: '最该练的词' }),
      el('span', { class: 'badge', text: `错题本 ${unresolved.length} 个未消` }),
    ]),
  ]);

  if (!mistakes.length) {
    card.appendChild(el('p', { class: 'faint', text: '错题本是空的。答错的词会自动进来，在错题本里连续答对 3 次就会自动移出。' }));
    root.appendChild(card);
    return;
  }

  const top = mistakes.slice(0, 20);
  const list = el('div', { class: 'miss-list' });
  for (const m of top) {
    const w = m.word || {};
    list.appendChild(el('div', { class: 'miss-row' + (m.resolved ? ' resolved' : '') }, [
      el('div', { class: 'miss-main' }, [
        el('span', { class: 'miss-term', text: w.term || m.wordId }),
        w.reading && w.reading !== w.term ? el('span', { class: 'miss-reading', text: w.reading }) : null,
        el('span', { class: 'miss-zh', text: (w.zh || []).slice(0, 2).join('；') || '（无释义）' }),
      ]),
      el('div', { class: 'miss-stat' }, [
        el('span', { class: 'miss-wrong', text: `错 ${m.wrongCount || 0} 次` }),
        m.resolved
          ? el('span', { class: 'miss-ok', text: '已消' })
          : el('span', { class: 'miss-streak', text: `连对 ${m.correctStreak || 0}/3` }),
      ]),
    ]));
  }
  card.appendChild(list);

  const btn = el('button', { class: 'btn btn-primary', text: '去错题本练这几个' });
  btn.addEventListener('click', () => goVocabTab('mistakes'));
  card.appendChild(el('div', { style: { marginTop: '12px' } }, [btn]));

  root.appendChild(card);
}

// ---------------------------------------------------------------------------
// 四、累计（保留原来的真实计数，作为背景信息）
// ---------------------------------------------------------------------------
async function renderLibraryTotals(root) {
  const [words, srs, reviews, lyrics, readings, imports] = await Promise.all([
    db.dbCount('words'), db.dbCount('srs'), db.dbCount('reviews'),
    db.dbCount('lyrics'), db.dbCount('readings'), db.dbCount('imports'),
  ]);
  const host = el('div', { class: 'grid grid-3' });
  for (const [label, n] of [['生词本', words], ['已排程', srs], ['答题记录', reviews],
    ['歌词笔记', lyrics], ['精读笔记', readings], ['导入词表', imports]]) {
    host.appendChild(el('div', { class: 'stat' }, [
      el('div', { class: 'stat-num', text: String(n) }),
      el('div', { class: 'stat-label', text: label }),
    ]));
  }
  root.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, [el('h3', { text: '当前累计' })]),
    host,
    el('p', { class: 'faint', style: { marginTop: '12px', fontSize: '.84rem' },
      text: '这些数字直接来自本机 IndexedDB。学习数据只存在你自己的浏览器里，随时可以在「设置」导出备份。' }),
  ]));
}
