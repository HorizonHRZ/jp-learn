/**
 * srcscan 工具的测试 + **整个 app/ 的语法体检**。
 *
 * 为什么这个"工具"也值得测：
 *   它的作用是**防止测试写出假错**。如果它自己有 bug
 *   （比如把注释剥漏了、或者把字符串也误删了），
 *   那所有用它的断言都会变成不可信 —— 而且**不会有任何东西报错**，
 *   只是测试从此学会了说谎。
 *   这类"用来验证别人的东西自己没被验证"的模块，最该有测试。
 *
 * 用法：node tools/test-srcscan.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { codeOnly, codeLike, stringLiterals } from './lib/srcscan.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

let fail = 0; let pass = 0;
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
};
const eq = (a, b, label) => ok(a === b, label, `得到 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`);

console.log('='.repeat(74));
console.log(' srcscan（源码扫描小工具）');
console.log('='.repeat(74));

// ---------------------------------------------------------------------------
console.log('\n[1] codeOnly：剥注释，留代码');
{
  const src = [
    '// 这行是注释，提到了 localStorage',
    "const a = 'localStorage';",
    '/* 块注释里也提到 localStorage */',
    'const b = 1; // 行尾注释',
  ].join('\n');
  const out = codeOnly(src);
  ok(!/这行是注释/.test(out), '行注释被剥掉了');
  ok(!/块注释里也提到/.test(out), '块注释被剥掉了');
  ok(!/行尾注释/.test(out), '行尾注释被剥掉了');
  ok(/'localStorage'/.test(out), '**字符串里的内容保留**（这是关键）');
  ok(/const a =/.test(out) && /const b = 1;/.test(out), '代码本身保留');

  // ⚠️ 最容易写错的一条：不能把协议头的 // 当成注释
  const url = "const u = 'https://api.example.com/v1';";
  eq(codeOnly(url).trim(), url, 'https:// 里的 // 不被当成注释');
  const inComment = '// 见 https://example.com\nconst x = 1;';
  ok(/const x = 1/.test(codeOnly(inComment)), '注释里的 URL 之后，代码仍被保留');
  ok(!/example\.com/.test(codeOnly(inComment)), '注释里的 URL 本身被剥掉');

  // 模板字符串里含 // 的情况
  const tpl = 'const s = `a//b`;\nconst y = 2;';
  ok(/const y = 2/.test(codeOnly(tpl)), '模板字符串里的 // 不影响后面的代码');
}

// ---------------------------------------------------------------------------
console.log('\n[2] codeLike：连字符串内容一起去掉');
{
  const src = [
    "// 注释提到 fetch",
    "fetch('/api/x');",
    "const msg = 'fetch failed';",
  ].join('\n');
  const out = codeLike(src);
  ok(/fetch\(/.test(out), '真正的 fetch 调用保留');
  ok(!/api\/x/.test(out), '字符串内容被清掉');
  ok(!/fetch failed/.test(out), '字符串里提到的 fetch 也被清掉');
}

// ---------------------------------------------------------------------------
console.log('\n[3] stringLiterals：只取用户看得见的字');
{
  // 这段模拟"页脚代码 + 一条解释为什么改的注释"
  const src = [
    '// 原来的说法是 "不会上传到任何服务器"，已改掉',
    "footEl.appendChild(el('span', {",
    "  text: '数据只存在本机浏览器；AI 只发送你选中的那段文字',",
    '}));',
  ].join('\n');
  const lit = stringLiterals(src);
  ok(/数据只存在本机浏览器/.test(lit), '取到了真正的界面文案');
  ok(!/不会上传到任何服务器/.test(lit), '**没把注释里的引号内容取进来**（这正是它要防的坑）');
  ok(!/footEl/.test(lit), '没有把代码当作文案');

  // 空输入不能崩
  eq(stringLiterals(''), '', '空字符串返回空');
  eq(stringLiterals('const n = 1;'), '', '没有字符串时返回空');
}

// ---------------------------------------------------------------------------
console.log('\n[4] 真实回归：这三个函数要能在真实源码上得出结论');
{
  const appSrc = fs.readFileSync(path.join(ROOT, 'app/js/app.js'), 'utf8');
  const appCode = codeOnly(appSrc);
  ok(!/不会上传到任何服务器/.test(appCode),
    'app.js 的**代码**里不再有旧文案（注释里提不算）');
  ok(/只存在本机浏览器/.test(appCode), 'app.js 的代码里有新的说法');

  // ai.js：真正的代码里不写 localStorage（注释里提了没关系）
  const aiCode = codeLike(fs.readFileSync(path.join(ROOT, 'app/js/ai.js'), 'utf8'));
  ok(!/localStorage/.test(aiCode), 'ai.js 的代码里没有 localStorage');
  const aiRaw = fs.readFileSync(path.join(ROOT, 'app/js/ai.js'), 'utf8');
  ok(/localStorage/.test(aiRaw), '但原文里确实提到了它（在注释里）—— 说明剥注释这一步是必要的');

  // settings.js：代码里确实用了 localStorage 存主题，不该被判违规
  const setCode = codeLike(fs.readFileSync(path.join(ROOT, 'app/js/views/settings.js'), 'utf8'));
  ok(/localStorage/.test(setCode), 'settings.js 的代码里**确实**有 localStorage（存主题，正当用途）');
}

// ---------------------------------------------------------------------------
// [5] 整个 app/ 的**语法体检** —— 把每个文件当 ES 模块真正解析一遍。
//
// 为什么必须单独做这一步（这是踩出来的，不是想出来的）：
//
//   `node --check app/js/views/reading.js` **查不出** ESM 的语法错误！
//   实测（写过一个临时探针确认过，四种组合都跑了一遍）：
//
//     bad  .mjs  → 报错    ✓
//     good .mjs  → 通过
//     bad  .js   → **通过**  ← 就是这里
//     good .js   → 通过
//
//   原因：`.js` 没有 `package.json` 的 `"type": "module"` 时，
//   **`node --check` 按 CommonJS 解析**，于是它按 CJS 的规则看这份源码，
//   该报的错就漏了。本项目**故意没有 `package.json`**（它是浏览器里的
//   原生 ESM，不是 Node 包），所以这个坑会一直在。
//
//   后果有多严重：我在 `renderResult()` 里加了一句 `await ensureRuby(...)`，
//   忘了把函数改成 `async`。**浏览器**直接
//   `SyntaxError: Unexpected reserved word`，整个精读页/歌词页打不开；
//   而 `node --check` 全绿。我是靠真浏览器自检才抓到的。
//
//   所以：**复制成 `.mjs` 再 `--check`**。这一步把这类错误从
//   "只有真浏览器能抓"变成"`node` 秒级就能抓"，而且和真浏览器同一个解析器。
console.log('\n[5] app/ 下每个 .js 都能当 ES 模块解析（await 位置、括号、引号…）');
{
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  })(path.join(ROOT, 'app'));
  files.sort();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-syntax-'));
  const bad = [];
  let checked = 0;
  for (const f of files) {
    // 扩展名换成 .mjs，逼 Node 按 ES 模块解析
    const tmp = path.join(tmpDir, path.basename(f, '.js') + '.mjs');
    fs.writeFileSync(tmp, fs.readFileSync(f, 'utf8'));
    try {
      execFileSync(process.execPath, ['--check', tmp], { stdio: ['ignore', 'pipe', 'pipe'] });
      checked++;
    } catch (e) {
      const rel = path.relative(ROOT, f).replace(/\\/g, '/');
      const msg = String(e.stderr || e.message).split('\n').slice(0, 4).join(' / ').slice(0, 300);
      bad.push({ rel, msg });
    }
  }
  // 收尾：临时目录必须清干净，别在系统盘留垃圾
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清不掉也不影响结论 */ }

  ok(bad.length === 0,
    `app/ 下 ${checked}/${files.length} 个 .js 当 ES 模块解析通过`,
    bad.map((b) => `${b.rel} :: ${b.msg}`).join('  ||  '));

  // ★ 反向验证锚点：这个方法**真的能**抓到"await 写在非 async 函数里"。
  //   没有这一条，上面那个"全部通过"只说明脚本没崩，不说明它有用。
  const badProbe = path.join(tmpDir + '-probe', 'bad.mjs');
  fs.mkdirSync(path.dirname(badProbe), { recursive: true });
  fs.writeFileSync(badProbe, 'export function f() {\n  await g();\n}\n');
  let caught = false;
  try {
    execFileSync(process.execPath, ['--check', badProbe], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { caught = true; }
  try { fs.rmSync(path.dirname(badProbe), { recursive: true, force: true }); } catch { /* 忽略 */ }
  ok(caught, '★ 反向验证：这段"await 写在非 async 函数里"的坏代码**确实**会被抓出来');
  ok(files.length > 20, `扫到的文件数合理（${files.length} 个），不是空跑`);
}

console.log('\n' + '='.repeat(74));
console.log(fail === 0 ? ` 全部通过（${pass} 项）` : ` ${fail} 项未通过（通过 ${pass} 项）`);
console.log('='.repeat(74));
process.exit(fail === 0 ? 0 : 1);
