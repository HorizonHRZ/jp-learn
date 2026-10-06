/**
 * 首页：功能入口 + 当前数据概览。
 *
 * 刻意保持"轻"：首页只做导航和状态展示，没有业务逻辑，
 * 这样即使某个功能模块还没做完，首页也永远能用。
 */
import { el, toastOk } from '../ui.js';
import * as db from '../db.js';
import { APP_VERSION, SCHEMA_VERSION } from '../version.js';

const TILES = [
  { view: 'vocab', icon: '語', title: '背单词', desc: '本地词表 + 内置 JLPT N5–N1，三种练习方式 + 小测，间隔重复排程' },
  { view: 'lyric', icon: '♪', title: '歌词学习', desc: '粘贴你自己的歌词，自动注音、罗马音、中日逐句对照' },
  { view: 'reading', icon: '読', title: '读书 / 精读', desc: '粘贴文本或上传你自己拍的书页，本机 OCR 识别后逐词解析' },
  { view: 'grammar', icon: '文', title: '语法教材', desc: '按级别与功能分类的语法条目，含接续、例句、易混对比' },
  { view: 'toolbox', icon: '🔧', title: '工具箱', desc: '活用还原、汉字读音反查、数字日期量词读法' },
  { view: 'stats', icon: '📈', title: '学习统计', desc: '熟练度分布、未来到期量、最该练的词' },
  { view: 'snapshots', icon: '🕘', title: '快照备份', desc: '自动存档点：误删、导错文件、升级出问题都能撤回' },
  { view: 'settings', icon: '⚙', title: '数据与设置', desc: '导出 / 导入 / 清空，主题与显示选项' },
];

export default {
  id: 'home',
  title: '首页',

  async render(root) {
    root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [
        el('h2', { text: '日语学习' }),
        el('span', { class: 'badge', text: 'v' + APP_VERSION }),
      ]),
      el('p', { class: 'dim', text: '本地优先的日语学习工具：学习数据全部保存在这台电脑的浏览器里，不需要安装。' }),
      el('p', { class: 'faint', style: { fontSize: '.84rem' } ,
        // ⚠️ 这段是首页对用户的**隐私承诺**，必须和程序实际行为一致。
        //    改过两次：① 原来是"程序完全不联网"——加了 AI 就成假话；
        //    ② 后来是"只发你选中的那段"——加了「自动翻译全部段落」之后
        //      一按按钮就会发每段正文，又成假话。
        //    所以现在按**两种触发方式**分别说清楚。
        //    test-render.mjs 的 [9b]/[9f] 会盯着：不许出现"不联网"，
        //    也不许再出现"只发选中的"这种和自动翻译矛盾的说法。
        text: '你的学习进度、排程、生词本、笔记全部只保存在这台电脑的浏览器里（IndexedDB），' +
              '升级程序不会动它们。' +
              '只有你自己打开 AI 之后才会联网，发出去的也只有你要处理的日文：' +
              '点词/点句时只发那一小段，点「自动翻译全部段落」时会把每段正文依次发出去。' +
              '其余数据（笔记标题、生词本、进度）都不出本机。建议定期到「数据与设置」里导出备份。' }),
    ]));

    // ---- 数据概览 ----
    const statsHost = el('div', { class: 'grid grid-4' });
    root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [el('h3', { text: '我的数据' })]),
      statsHost,
      el('div', { class: 'btn-row', style: { marginTop: '12px' } }, [
        el('a', { class: 'btn btn-sm', href: '#/settings', text: '导出 / 导入 / 快照' }),
      ]),
    ]));

    try {
      const [words, srs, reviews, lyrics, readings, snaps] = await Promise.all([
        db.dbCount('words'), db.dbCount('srs'), db.dbCount('reviews'),
        db.dbCount('lyrics'), db.dbCount('readings'), db.dbCount('snapshots'),
      ]);
      const items = [
        ['生词本', words], ['已排程', srs], ['答题记录', reviews],
        ['歌词笔记', lyrics], ['精读笔记', readings], ['数据快照', snaps],
      ];
      for (const [label, n] of items) {
        statsHost.appendChild(el('div', { class: 'stat' }, [
          el('div', { class: 'stat-num', text: String(n) }),
          el('div', { class: 'stat-label', text: label }),
        ]));
      }
      if (!words && !lyrics && !readings) {
        statsHost.after(el('div', { class: 'banner banner-info', style: { marginTop: '12px' } }, [
          el('strong', { text: '还是空的。' }),
          el('span', { text: '建议先到「语法」随便看看，或到「设置 → 数据」确认一下数据层是否正常。' }),
        ]));
      }
    } catch (e) {
      statsHost.appendChild(el('div', { class: 'banner banner-error' }, [
        el('strong', { text: '读不到本地数据：' }),
        el('span', { text: String((e && e.message) || e) }),
      ]));
    }

    // ---- 功能入口 ----
    // 用 .tiles（固定 3 列）而不是 .grid-3（auto-fit）：
    // 6 个入口在 auto-fit 下会排成 5+1，要求是齐整的两行 3+3。
    const grid = el('div', { class: 'tiles' });
    for (const t of TILES) {
      grid.appendChild(el('a', { class: 'tile', href: '#/' + t.view, onclick: (e) => {
        e.preventDefault();
        location.hash = '#/' + t.view;
      } }, [
        el('div', { class: 'tile-icon', text: t.icon }),
        el('div', { class: 'tile-title', text: t.title }),
        el('div', { class: 'tile-desc', text: t.desc }),
      ]));
    }
    root.appendChild(el('h3', { text: '功能', style: { marginTop: '6px' } }));
    root.appendChild(grid);

    // ---- 环境自检小卡 ----
    const diag = el('div', { class: 'card' });
    diag.appendChild(el('div', { class: 'card-title' }, [
      el('h3', { text: '运行环境' }),
      el('button', {
        class: 'btn btn-sm',
        text: '重新检测',
        onclick: () => refreshHealth(),
      }),
    ]));
    const healthHost = el('dl', { class: 'kv' });
    diag.appendChild(healthHost);
    root.appendChild(diag);

    async function refreshHealth() {
      healthHost.innerHTML = '';
      healthHost.appendChild(el('dt', { text: '状态' }));
      healthHost.appendChild(el('dd', { text: '检测中…' }));
      const data = await fetch('/api/health').then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
      healthHost.innerHTML = '';
      const rows = [
        ['本地服务', data.ok ? `正常（v${data.version}）` : '异常：' + (data.error || '未知')],
        ['Node', data.node || '-'],
        ['歌词接口', data.lyric ? data.lyric.mode + '（' + data.lyric.endpoint + '）' : '-'],
        ['OCR 引擎', data.ocr
          ? (data.ocr.available
            ? '可用，语言：' + (data.ocr.languages || []).map((l) => l.tag).join('、')
            : '不可用：' + (data.ocr.error || '没有 ja 语言包'))
          : '未探测'],
        ['数据版本', `程序 v${data.version || APP_VERSION} / 结构 v${SCHEMA_VERSION}`],
      ];
      for (const [k, v] of rows) {
        healthHost.appendChild(el('dt', { text: k }));
        healthHost.appendChild(el('dd', { text: String(v) }));
      }
    }

    await refreshHealth();
  },
};

