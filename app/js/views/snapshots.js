/**
 * 快照备份页。
 *
 * 为什么把快照从「数据与设置」里拆出来单独一页：
 *   快照是约束 3（用户数据永不丢失）最核心的机制，但用户根本不知道它存在 ——
 *   藏在设置页中段的一个表格里，看不懂也不敢点。单独成页之后能做三件事：
 *     1. 讲清楚"快照是什么、能救什么、救不了什么"；
 *     2. 把占用空间摊开（总量 / 每份多大 / 谁会被自动淘汰），
 *        "会不会越占越多"这个问题用户能自己一眼看到；
 *     3. 把「恢复」这个关键动作放在最顺手的位置。
 *
 * ⚠️ 最重要的一句必须写在最显眼处：**快照救不了浏览器数据被清理**。
 *    快照和你的学习数据存在**同一个 IndexedDB 数据库**里，
 *    所以浏览器数据一被清，快照会跟着一起没。能跨过这种情况的只有「导出文件」。
 *    这两者不是替代关系，页面上必须同时把导出指出来 —— 否则用户会以为
 *    "有快照就不用导出了"，那正好是最危险的误解。
 *
 * 本页完全不改数据结构：快照本来就在 IndexedDB 的 snapshots 表里，
 * 这里只是换了个界面来展示和操作它，SCHEMA_VERSION 不变。
 */
import {
  el, humanBytes, humanTime, humanAgo, toast, toastOk, toastError,
  confirmDialog,
} from '../ui.js';
import * as db from '../db.js';

/**
 * 快照类型的中文名。
 * 与 db.js 的 pruneSnapshots() 优先级表对应：
 *   auto(0) < before-import(1) < manual(2) < before-wipe(3) < preupgrade(4)
 * 数字越大越"不该被删"。
 */
const KIND_LABELS = {
  auto: '定期自动',
  manual: '手动创建',
  'before-import': '导入前自动',
  'before-wipe': '清空前强制',
  preupgrade: '结构升级前',
};

/** 这两类**永远不会被自动淘汰**，页面上要标出来 */
const PINNED_KINDS = new Set(['preupgrade', 'before-wipe']);

/** 各表条数的中文名（"学习数据"那张表用） */
const STORE_LABELS = {
  words: '生词本', srs: 'SRS 排程', reviews: '答题记录', mistakes: '错题本',
  imports: '词表导入记录', lyrics: '歌词笔记', readings: '精读笔记',
  grammarState: '语法学习状态', settings: '设置', meta: '系统信息',
};

export default {
  id: 'snapshots',
  title: '快照备份',

  async render(root) {
    root.appendChild(el('h2', { text: '快照备份' }));

    // 整页统一的刷新入口。
    // ⚠️ 刻意**不用模块级变量**来让子函数回调它 —— 那会让"当前哪个视图实例在显示"
    //    变成全局状态，一旦将来出现两个实例（或快速切换路由）就会串台。
    //    这里把它作为参数往下传，作用域就是这一次 render。
    async function refresh() {
      await renderUsage(usageHost);
      await renderList(listHost, { onChanged: refresh });
    }

    async function doManualSnapshot() {
      try {
        const s = await db.makeSnapshot('manual', '手动创建');
        toastOk(`已创建快照（${humanBytes(s.bytes)}）`, 4000);
        await refresh();
      } catch (e) {
        toastError('创建快照失败：' + ((e && e.message) || e));
      }
    }

    // ================= 一、这个页面解决什么问题 =================
    root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [
        el('h3', { text: '快照是什么' }),
      ]),
      el('p', { text: '快照 = 把你当前全部学习数据（生词本、SRS 排程、答题记录、错题本、歌词笔记、精读笔记）' +
        '整份存下来的一个存档点。你不需要做任何事：程序会定期自动存，另外在这几个时刻也会自动存一份 —— ' +
        '数据结构升级前、导入文件前、清空数据前（强制）。' }),
      el('p', { class: 'dim', text: '有了快照，误操作是可以撤回的：删错词、导错文件、点错「清空数据」、' +
        '程序升级出问题 —— 都能一键回到之前某个时间点。' }),

      el('div', { class: 'banner banner-warn', style: { marginTop: '8px' } }, [
        el('strong', { text: '但它救不了「浏览器数据被清理」' }),
        el('div', { class: 'banner-hint', text: '快照和你的学习数据存在同一个数据库里。' +
          '所以清理浏览器数据、换浏览器、换电脑、重装系统 —— 快照会跟着一起没。' }),
      ]),
      el('div', { class: 'banner banner-info', style: { marginTop: '8px' } }, [
        el('strong', { text: '能跨过上面那种情况的，只有「导出文件」' }),
        el('div', { class: 'banner-hint', text: '把数据导出成 JSON 文件，存到你的硬盘或网盘上。' +
          '这样即使整台电脑出问题，数据也还在。两者不是替代关系：快照救误操作，导出救电脑出事。' }),
      ]),
      el('div', { class: 'btn-row', style: { marginTop: '10px' } }, [
        el('button', { class: 'btn btn-primary', text: '立即创建快照', onclick: doManualSnapshot }),
        el('a', { class: 'btn', href: '#/settings', text: '去导出 / 导入备份 →' }),
      ]),
    ]));

    // ================= 二、占用与数据量 =================
    const usageHost = el('div', {});
    root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [
        el('h3', { text: '占用与数据量' }),
        el('button', { class: 'btn btn-sm', text: '重新检测', onclick: () => renderUsage(usageHost) }),
      ]),
      usageHost,
    ]));

    // ================= 三、快照列表 =================
    const listHost = el('div', {});
    root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [
        el('h3', { text: '全部快照' }),
        el('span', { class: 'faint', text: '自动保留最近 10 份；「结构升级前」与「清空前强制」这两类不会被自动删掉' }),
      ]),
      listHost,
    ]));

    await refresh();
  },
};

/** 占用空间 + 各表条数 */
async function renderUsage(host) {
  host.innerHTML = '';
  host.appendChild(el('div', { class: 'loading', text: '检测中…' }));

  let snaps = [];
  let counts = {};
  try {
    snaps = await db.dbAll('snapshots');
    counts = await db.dataCounts();
  } catch (e) {
    host.innerHTML = '';
    host.appendChild(el('div', { class: 'banner banner-error' }, [
      el('strong', { text: '读不到数据：' }), el('span', { text: String((e && e.message) || e) }),
    ]));
    return;
  }
  host.innerHTML = '';

  const snapTotal = snaps.reduce((a, s) => a + (s.bytes || 0), 0);
  const liveTotal = Object.values(counts).reduce((a, b) => a + (b || 0), 0);

  // 浏览器给本站的配额（Storage API）。
  // 为什么两个数字都显示：snapshot.bytes 是 JSON 文本长度，量的是"内容"；
  // Storage API 报的是浏览器真实占用的磁盘量，含索引与内部开销，通常更大。
  // 只给一个都会让人误解，所以两个都列。
  let quotaLine = null;
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const est = await navigator.storage.estimate();
      if (est && est.usage != null) {
        quotaLine = el('div', {}, [
          el('dt', { text: '浏览器实际占用' }),
          el('dd', { text: humanBytes(est.usage) + (est.quota ? `／配额 ${humanBytes(est.quota)}` : '') }),
        ]);
      }
    } catch { /* 拿不到就不显示，不影响其它信息 */ }
  }

  host.appendChild(el('dl', { class: 'kv' }, [
    el('dt', { text: '学习数据' }), el('dd', { text: `${liveTotal} 条记录` }),
    el('dt', { text: '快照份数' }), el('dd', { text: `${snaps.length} 份` }),
    el('dt', { text: '快照内容合计' }), el('dd', { text: humanBytes(snapTotal) }),
    quotaLine,
  ].filter(Boolean)));

  // 为什么"快照合计"会明显偏大：每份快照都是全部数据的一份完整拷贝。
  if (snaps.length >= 8) {
    host.appendChild(el('div', { class: 'banner banner-info', style: { marginTop: '10px' } }, [
      el('strong', { text: `已经存了 ${snaps.length} 份。` }),
      el('span', { text: '每份快照都是全部数据的一份完整拷贝，所以份数越多占得越多。' +
        '上限是 10 份，到顶之后最旧的「定期自动」快照会被自动删掉，不会无限增长。' }),
    ]));
  }

  // 各表条数（只列有内容的，全 0 时整张表都不显示）
  const rows = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => el('tr', {}, [
      el('td', { text: STORE_LABELS[k] || k }),
      el('td', { class: 'mono faint', text: k }),
      el('td', { text: String(n) }),
    ]));
  if (rows.length) {
    host.appendChild(el('div', { class: 'table-wrap', style: { marginTop: '12px' } }, [
      el('table', { class: 'table' }, [
        el('thead', {}, el('tr', {}, [
          el('th', { text: '数据表' }), el('th', { text: '内部名' }), el('th', { text: '条数' }),
        ])),
        el('tbody', {}, rows),
      ]),
    ]));
  }
}

/**
 * 快照列表。
 * @param {{ onChanged?: () => Promise<void> }} opts
 *        任何会改变快照集合的操作（恢复 / 删除）之后调用它刷新整页两块内容。
 */
async function renderList(host, opts = {}) {
  const onChanged = opts.onChanged || null;
  host.innerHTML = '';
  let snaps = [];
  try {
    snaps = await db.dbAll('snapshots');
  } catch (e) {
    host.appendChild(el('div', { class: 'banner banner-error', text: '读不到快照：' + ((e && e.message) || e) }));
    return;
  }
  if (!snaps.length) {
    host.appendChild(el('div', { class: 'empty' }, [
      el('div', { class: 'empty-title', text: '还没有快照' }),
      el('div', { class: 'empty-hint', text: '有学习数据之后会自动生成（每 6 小时最多一份）；也可以点上面的「立即创建快照」。' }),
    ]));
    return;
  }
  snaps.sort((a, b) => String(b.at).localeCompare(String(a.at)));

  const rows = snaps.map((s) => {
    const pinned = PINNED_KINDS.has(s.kind);
    return el('tr', {}, [
      el('td', {}, [
        el('div', {}, [
          el('span', { text: KIND_LABELS[s.kind] || s.kind }),
          pinned ? el('span', { class: 'badge', style: { marginLeft: '6px' }, text: '不会被自动删' }) : null,
        ].filter(Boolean)),
        s.note ? el('div', { class: 'faint', style: { fontSize: '.78rem' }, text: s.note }) : null,
        // 记录这份快照是哪个程序/结构版本存的，恢复旧快照时能对上号
        s.appVersion
          ? el('div', { class: 'faint', style: { fontSize: '.78rem' }, text: `程序 v${s.appVersion} / 结构 v${s.schemaVersion}` })
          : null,
      ].filter(Boolean)),
      el('td', {}, [
        el('div', { text: humanTime(s.at) }),
        el('div', { class: 'faint', style: { fontSize: '.78rem' }, text: humanAgo(s.at) }),
      ]),
      el('td', { class: 'faint', text: humanBytes(s.bytes) }),
      el('td', {}, el('div', { class: 'btn-row' }, [
        el('button', {
          class: 'btn btn-sm',
          text: '恢复',
          onclick: async () => {
            const ok = await confirmDialog(
              `将把数据恢复到 ${humanTime(s.at)} 的状态（${KIND_LABELS[s.kind] || s.kind}）。` +
              '当前状态会先自动存成一份新快照，所以这一步不会让你丢失现在的数据。',
              { title: '从快照恢复', okLabel: '恢复', danger: true }
            );
            if (!ok) return;
            try {
              const r = await db.restoreSnapshot(s.id);
              toastOk(`已恢复 ${r.written} 条记录`, 5000);
              if (onChanged) await onChanged();
            } catch (e) {
              toastError('恢复失败：' + ((e && e.message) || e));
            }
          },
        }),
        el('button', {
          class: 'btn btn-sm',
          text: '导出',
          onclick: () => {
            try {
              const r = db.downloadJSON(
                { format: 'jp-learn-backup', formatVersion: 1, ...s.data },
                `jp-learn-snapshot-${s.kind}-${String(s.at).replace(/[:.]/g, '-')}.json`
              );
              toastOk('已导出 ' + humanBytes(r.bytes), 4000);
            } catch (e) { toastError('导出失败：' + ((e && e.message) || e)); }
          },
        }),
        el('button', {
          class: 'btn btn-sm btn-ghost',
          text: '删除',
          onclick: async () => {
            const ok = await confirmDialog(victimWarning(s), { title: '删除快照', okLabel: '删除', danger: true });
            if (!ok) return;
            try {
              await db.dbDelete('snapshots', s.id);
              toast('已删除该快照', 'info', 2500);
              if (onChanged) await onChanged();
            } catch (e) { toastError('删除失败：' + ((e && e.message) || e)); }
          },
        }),
      ])),
    ]);
  });

  host.appendChild(el('div', { class: 'table-wrap' }, [
    el('table', { class: 'table' }, [
      el('thead', {}, el('tr', {}, [
        el('th', { text: '类型' }), el('th', { text: '时间' }), el('th', { text: '大小' }), el('th', { text: '操作' }),
      ])),
      el('tbody', {}, rows),
    ]),
  ]));
}

/**
 * 删除确认文案。
 * 「结构升级前」和「清空前强制」这两类删掉就没有回滚依据了，必须单独警告 ——
 * 它们正是 db.js 里 PINNED 那两类，是约束 3 的兜底。
 */
function victimWarning(s) {
  if (s.kind === 'preupgrade') {
    return '这是结构升级前的备份。删掉它之后，如果新版代码有问题，就没有回滚依据了。确定删除吗？';
  }
  if (s.kind === 'before-wipe') {
    return '这是清空数据前的强制备份。删掉它，被清空的数据就真的找不回来了。确定删除吗？';
  }
  return '确定删除这份快照吗？';
}
