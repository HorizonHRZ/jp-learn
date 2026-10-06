/** 逐条核对阶段 2 目标是否有真实现（不是看文件存在，而是看关键行为） */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let fail = 0;
const ck = (cond, label, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? '  — ' + detail : ''}`);
};

console.log('阶段 2 目标逐条核对');

console.log('\n1) SRS 排程算法 + 纯函数单元测试');
{
  const srs = read('app/js/srs.js');
  ck(/export function schedule/.test(srs), 'srs.js 导出 schedule');
  ck(/export function pickDue/.test(srs), 'srs.js 导出 pickDue');
  ck(/export function weightForReinforce/.test(srs), 'srs.js 导出 weightForReinforce（记忆加深）');
  ck(fs.existsSync(path.join(ROOT, 'tools/test-srs.mjs')), '有 test-srs.mjs 单元测试');
}

console.log('\n2) 复习会话流程 + 内置词库 + 本地词表导入');
{
  const vd = read('app/js/vocabdata.js');
  ck(/export async function ensureLibrary/.test(vd), 'vocabdata 有 ensureLibrary（内置 JLPT 词库）');
  ck(/export async function importWordList|export async function importFrom/.test(vd), '有本地词表导入函数');
  ck(/parseWordList|parseTable|splitCsvLine/.test(vd), '有词表解析器');
  const man = JSON.parse(read('data/index/manifest.json'));
  ck(man.total > 15000, '内置词库词量正常', `total=${man.total}`);
  ck(man.counts && man.counts.N5 > 0 && man.counts.N1 > 0, 'N5~N1 分级都在',
    `N5=${man.counts.N5} N1=${man.counts.N1}`);
}

console.log('\n3) 三种出题模式 + 记忆加深 + 小测');
{
  const q = read('app/js/quiz.js');
  // 模式已按用户要求从 5 个收敛到 3 个。这里逐条核对三个新模式，
  // 并且**核对它们各自的题干侧/作答侧/是否手打**，否则改动出题逻辑也看不出来。
  for (const m of ['jp2zh', 'zh2jp', 'zh2jp_typing']) {
    ck(new RegExp(`^\\s*${m}:`, 'm').test(q), `quiz.js 有模式 ${m}`);
  }
  ck(/MODE_ORDER = \['jp2zh', 'zh2jp', 'zh2jp_typing'\]/.test(q), 'MODE_ORDER 就是这三个（界面的唯一来源）');
  ck(/DEFAULT_MODE = 'jp2zh'/.test(q), '默认模式是 jp2zh');
  // 删掉的模式不能再复活：listen（语音听写）/ cloze（填空）/ kana（假名互认）
  for (const dead of ['listen', 'cloze', 'kana']) {
    ck(!new RegExp(`^\\s*${dead}:`, 'm').test(q), `quiz.js 已删除模式 ${dead}`);
  }
  ck(/mode === 'jp2zh'/.test(q) && /mode === 'zh2jp'/.test(q) && /mode === 'zh2jp_typing'/.test(q),
    '三个模式各有独立出题分支');
  ck(/typing: true/.test(q), '手打模式带 typing 标记（界面据此显示输入框）');
  ck(/note: /.test(q), '手打模式带 note（提示读音也算对）');
  ck(/未知练习模式/.test(q), '未知模式会抛错而不是静默出题');
  // 语音内容必须彻底消失：三种模式都不该产出 speech/audio 之类的字段
  // （旧版 listen 模式会给题目挂 speak: 词形，供界面朗读）。
  // 说明性注释里解释"为什么删掉 listen"是好事，所以只查可执行字段，不查文案。
  ck(!/speak:|speechSynthesis|'listen'|"listen"/.test(q), 'quiz.js 里没有任何语音相关字段或模式');

  const sess = read('app/js/session.js');
  ck(/reinforce:/.test(sess), 'session.js 有 reinforce 来源（记忆加深）');
  // 排序函数由视图调用（session 只负责流程，见 ARCHITECTURE §10.5）
  ck(/weightForReinforce/.test(read('app/js/views/vocab.js')), '视图用 weightForReinforce 给记忆加深排序');
  ck(/export function weightForReinforce/.test(read('app/js/srs.js')), 'srs.js 提供 weightForReinforce');
  ck(fs.existsSync(path.join(ROOT, 'app/js/testrun.js')), '有小测状态机 testrun.js');
  ck(fs.existsSync(path.join(ROOT, 'tools/test-testrun.mjs')), '有小测单元测试');
}

console.log('\n4) 生词本：融入背单词页 + 全局速查抽屉，不新增导航页');
{
  const vocab = read('app/js/views/vocab.js');
  ck(/\{ id: 'words', label: '词表'/.test(vocab), '背单词页里有「词表」页签');
  ck(fs.existsSync(path.join(ROOT, 'app/js/drawer.js')), '有 drawer.js（全局速查抽屉）');
  const app = read('app/js/app.js');
  ck(/toggleLookup/.test(app), 'app.js 挂了全局速查（Ctrl+Shift+F）');
  const nav = app.match(/const NAV = \[([\s\S]*?)\];/);
  const navCount = nav ? (nav[1].match(/id:/g) || []).length : 0;
  // ⚠️ 这里要断言的是**设计意图**，不是数字。
  // 当初写的是 `navCount === 7`，本意是"生词本没有被单独做成一个页面"。
  // 后来工具箱加了一项变成 8，这条就误报了 —— 数字变了，但意图没变。
  // 所以改成直接查意图：NAV 里不能出现生词本/词表页，且不能有重复 id。
  ck(!/id:\s*'(words|vocab-list|notebook)'/.test(nav ? nav[1] : ''),
    '生词本仍然只是背单词页里的一个页签（没有为它新增导航页）');
  const ids = nav ? (nav[1].match(/id:\s*'([^']+)'/g) || []).map((s) => s.replace(/.*'([^']+)'/, '$1')) : [];
  ck(new Set(ids).size === ids.length, `导航没有重复 id（实际 ${navCount} 项：${ids.join('/')}）`);
  ck(ids.includes('vocab') && ids.includes('settings'),
    '导航包含「背单词」与「设置」这两个基础页', ids.join('/'));
}

console.log('\n5) 错题本：按错误次数排序 + 答对回写 SRS');
{
  const vd = read('app/js/vocabdata.js');
  const lm = vd.slice(vd.indexOf('export async function listMistakes'));
  ck(/wrongCount/.test(lm.slice(0, 1200)), 'listMistakes 按 wrongCount 参与排序');
  ck(/correctStreak/.test(vd), '答对会累加 correctStreak（区分已克服/仍在挣扎）');
  ck(/export async function recordAnswer/.test(vd), 'recordAnswer 是唯一写入口');
  ck(/schedule\(card, grade/.test(vd), 'recordAnswer 里调用了 SRS schedule（答对回写排程）');
}

console.log('\n6) 快捷键体系 + destroy 清理');
{
  const vocab = read('app/js/views/vocab.js');
  ck(/function installShortcuts/.test(vocab), '有 installShortcuts');
  ck(/removeEventListener\('keydown'/.test(vocab), 'destroy 里摘掉 keydown 监听');
  ck(/stopTestTimer/.test(vocab), 'destroy 里也停掉小测倒计时');
  ck(/e\.key === 'Escape'/.test(vocab), '有 Esc 结束');
  // 评分按钮已删除，改成**自动评分**：答对 → GOOD 并自动进下一题；
  // 答错 → AGAIN、进错题本，停在反馈页等 Enter（continueAfterWrong）。
  ck(/gradeAuto/.test(vocab), '练习改成自动评分（gradeAuto）');
  ck(!/grade-row/.test(vocab), '不再渲染三档评分按钮（grade-row 已删除）');
  ck(/GRADE\.GOOD/.test(vocab) && /GRADE\.AGAIN/.test(vocab), '自动评分只用 good / again 两档');
  ck(/continueAfterWrong/.test(vocab), '答错后由用户按 Enter 继续（continueAfterWrong）');
  ck(/550/.test(vocab), '答对后短暂停留再自动进下一题（约 550ms）');
  // 语音内容必须彻底消失：旧版本这里有 speak() 调用、japaneseVoiceStatus 和 🔊 按钮。
  // 先剥掉注释再查——代码里留一句"这里原本有个朗读按钮"的说明不是功能，
  // 断言要盯的是可执行内容，否则以后写注释都得绕着词走。
  const stripC = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const rel of ['app/js/views/vocab.js', 'app/js/views/home.js', 'app/js/drawer.js']) {
    const code = stripC(read(rel));
    ck(!/\bspeak\s*\(|speechSynthesis|japaneseVoiceStatus|🔊/.test(code),
      `${rel} 不含任何朗读调用/按钮`);
  }
}

console.log('\n7) 数据备份补强（约束 3）');
{
  const db = read('app/js/db.js');
  for (const fn of ['exportAll', 'importAll', 'makeSnapshot', 'restoreSnapshot', 'wipeAllData',
                    'checkExportReminder', 'recordExport', 'validateBackup', 'pruneSnapshots']) {
    ck(new RegExp(`(export )?(async )?function ${fn}`).test(db), `db.js 有 ${fn}`);
  }
  ck(/before-wipe/.test(db), '清空前强制备份（before-wipe）');
  ck(/rawPut|rawGet/.test(db), 'openDB 用内部原语（避免首次安装死锁）');
}

console.log('\n8) 三条硬约束');
{
  const root = fs.readdirSync(ROOT);
  ck(!root.includes('package.json'), '根目录没有 package.json（零依赖）');
  ck(!root.includes('node_modules'), '没有 node_modules');
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
    if (e.isDirectory()) { if (e.name !== 'data') walk(d + '/' + e.name); }
    else files.push(d + '/' + e.name);
  } };
  walk('app');
  ck(!files.some((f) => /\.min\.|bundle|\.map$/.test(f)), 'app/ 里没有压缩/打包产物（源码明文）');
  const ver = read('app/js/version.js');
  // ⚠️ 这一条 2026-10 改过。原来硬写「SCHEMA_VERSION 仍是 2（本轮没有结构变更）」，
  //    它想表达的是**阶段 2（背单词）本身没有引入结构变更** —— 这个意思是对的。
  //    但后来 `readingOverrides`（用户手改的汉字读音）确实需要加一张表，
  //    版本合理地升到 3，这条断言就红了：**红的不是代码，是断言把"当时那个
  //    版本号"当成了"阶段 2 的分界线"。**
  //
  //    现在断言两件更稳的事：
  //      ① 版本号是**一个数字**（不是被改成了字符串/undefined 之类的怪值）
  //      ② 它 **≥ 2** —— 阶段 2 的起点；之后只应增加、不应回退
  //    真正"加了表必须加版本号"的护栏在 audit-phases.mjs 里（对照 MIGRATIONS 逐级核对）。
  const schemaMatch = /SCHEMA_VERSION = (\d+)/.exec(ver);
  ck(!!schemaMatch, 'version.js 里的 SCHEMA_VERSION 是个数字');
  ck(schemaMatch && Number(schemaMatch[1]) >= 2,
    'SCHEMA_VERSION ≥ 2（阶段 2 的起点，之后只增不减）',
    schemaMatch ? schemaMatch[1] : '没读到');
}

console.log('\n' + (fail === 0 ? '目标逐条核对全部通过' : `${fail} 项不符合`));
process.exit(fail === 0 ? 0 : 1);
