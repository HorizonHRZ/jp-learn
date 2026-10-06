/**
 * test-idle-exit.mjs —— "关掉网页就自动停服务" 这个功能的真实端到端测试
 *
 * 为什么必须真起一个进程来测（而不是读源码断言字符串）：
 *   这个功能的核心是**一个定时器**。定时器写错了（单位错、条件反了、
 *   忘了 unref、判定用了 >= 还是 >）在源码里看不出来，症状要等用户
 *   "关掉网页之后内存没释放"才会暴露 —— 那时候已经过去很久了。
 *   所以这里真的拉起一个 server.js，真的发心跳，真的等它自己退出。
 *
 * 不能等 90 秒（会让测试套变得很慢），所以用 JP_LEARN_IDLE_EXIT_SEC
 * 把超时压到几秒。**这正说明了那个环境变量为什么必须存在。**
 *
 * ⚠️ 两个运行环境的坑：
 *   1. 子进程输出**不能走管道**（沙箱下 stdio:'pipe' 会 EPERM），
 *      所以重定向到文件，再从文件里读日志。
 *   2. 端口要挑没人用的（见下面 PORT 的注释）。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;

// 端口不能和别的测试撞：test-ai-e2e 用 8791/8792，这里是 8891。
const PORT = 8891;
const BASE = `http://127.0.0.1:${PORT}`;
const EXIT_SEC = 3;                 // 把 90 秒压到 3 秒，测试才跑得动

const LOG = path.join(os.tmpdir(), 'jp-learn-idle-exit-test.log');

let pass = 0;
const failures = [];
function ck(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '  — ' + detail : ''}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 端口在不在听（用 HTTP 探，避免依赖 netstat） */
async function alive() {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

/** 等端口起来 */
async function waitUp(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await alive()) return true;
    await sleep(200);
  }
  return false;
}

function startServer(extraEnv = {}) {
  const out = fs.openSync(LOG, 'w');
  const child = spawn(NODE, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      JP_LEARN_PORT: String(PORT),
      JP_LEARN_IDLE_EXIT_SEC: String(EXIT_SEC),
      ...extraEnv,
    },
    stdio: ['ignore', out, out],   // 不用管道（沙箱会 EPERM）
    windowsHide: true,
  });
  fs.closeSync(out);
  return child;
}

function readLog() {
  try { return fs.readFileSync(LOG, 'utf8'); } catch { return ''; }
}

console.log('='.repeat(72));
console.log(' 自动停止服务（关掉网页 → 心跳停 → 自己退出）');
console.log(` 端口 ${PORT}　超时 ${EXIT_SEC}s（用 JP_LEARN_IDLE_EXIT_SEC 压缩，默认 90s）`);
console.log('='.repeat(72));

try {
  // =========================================================================
  console.log('\n[1] 发心跳时，服务不该死');
  // =========================================================================
  {
    const child = startServer();
    let exited = false;
    child.on('exit', () => { exited = true; });

    const up = await waitUp(20000);
    ck(up, '服务起来了');

    if (up) {
      // 心跳间隔要明显小于超时，才代表"页面还开着"
      const half = Math.round((EXIT_SEC * 1000) / 3);
      for (let i = 0; i < 10; i++) {   // 覆盖 ~3.3 倍超时的时长
        await fetch(`${BASE}/api/alive`, { method: 'POST' });
        await sleep(half);
      }
      const stillUp = await alive();
      ck(stillUp, `持续发心跳 ${(10 * half / 1000).toFixed(1)}s 后服务仍然在（没被误杀）`);
      ck(!exited, '子进程没有退出');
    }

    child.kill();
    await sleep(500);
    fs.rmSync(LOG, { force: true });
  }

  // =========================================================================
  console.log('\n[2] 心跳停了之后，服务该自己退出（核心用例）');
  // =========================================================================
  {
    const child = startServer();
    let exited = false;
    let exitCode = null;
    child.on('exit', (c) => { exited = true; exitCode = c; });

    const up = await waitUp(20000);
    ck(up, '服务起来了');

    if (up) {
      await fetch(`${BASE}/api/alive`, { method: 'POST' });
      ck(true, '发了一次心跳（看门狗此时才启动）');

      // 之后再也不发。等服务自己退。
      const t0 = Date.now();
      const budgetMs = (EXIT_SEC + 10) * 1000;
      while (!exited && Date.now() - t0 < budgetMs) await sleep(200);

      const waited = (Date.now() - t0) / 1000;
      ck(exited, `停了心跳之后服务自己退出了（等了 ${waited.toFixed(1)}s）`);
      ck(waited >= EXIT_SEC * 0.9, `没有提前退出（应 ≥${(EXIT_SEC * 0.9).toFixed(1)}s，实际 ${waited.toFixed(1)}s）`);
      ck(waited <= EXIT_SEC + 8, `也在合理时间内退出（实际 ${waited.toFixed(1)}s）`);
      ck(exitCode === 0, `退出码是 0（优雅退出，实际 ${exitCode}）`);

      const log = readLog();
      ck(/没有收到页面的心跳/.test(log), '退出前打印了"为什么停"的说明（不是静默消失）');
      ck(/JP_LEARN_NO_IDLE_EXIT/.test(log), '说明里告诉了用户怎么关掉这个行为');
    } else {
      child.kill();
    }
  }

  // =========================================================================
  console.log('\n[3] 从来没发过心跳的客户端：行为必须和以前一样（不许退出）');
  // =========================================================================
  // 这是最重要的一条回归。它保证了 Node 测试、curl、脚本等"不发心跳"的
  // 用法完全不受这个新功能影响 —— 否则整个测试套会莫名其妙地服务消失。
  {
    const child = startServer();
    let exited = false;
    child.on('exit', () => { exited = true; });

    const up = await waitUp(20000);
    ck(up, '服务起来了');

    if (up) {
      const waitMs = (EXIT_SEC + 4) * 1000;
      // 这期间只打 /api/health，从不打 /api/alive
      const t0 = Date.now();
      while (Date.now() - t0 < waitMs) {
        await alive();
        await sleep(400);
      }
      ck(!exited, `只问健康检查、不发心跳，${(waitMs / 1000).toFixed(1)}s 后服务仍在（不会误退）`);
      ck(await alive(), '而且还能正常响应');
    }

    child.kill();
  }

  // =========================================================================
  console.log('\n[4] 逃生开关：JP_LEARN_NO_IDLE_EXIT 能让它一直开着');
  // =========================================================================
  {
    const child = startServer({ JP_LEARN_NO_IDLE_EXIT: '1' });
    let exited = false;
    child.on('exit', () => { exited = true; });

    const up = await waitUp(20000);
    ck(up, '服务起来了');

    if (up) {
      await fetch(`${BASE}/api/alive`, { method: 'POST' });
      const waitMs = (EXIT_SEC + 4) * 1000;
      await sleep(waitMs);
      ck(!exited, `发了心跳但设了逃生开关，${(waitMs / 1000).toFixed(1)}s 后仍然活着`);
      const log = readLog();
      ck(/已禁用"关掉网页自动停止"/.test(log), '启动时如实说明了"自动停止已被禁用"');
    }

    child.kill();
  }
  // =========================================================================
  console.log('\n[5] 客户端心跳间隔 vs 服务端超时：两个数必须配合好');
  // =========================================================================
  // 这是纯函数，不需要起服务。为什么单独测它：
  // 心跳间隔只要 ≥ 服务端超时，**一个正常开着的页面也会被杀掉** ——
  // 用户正在用，服务自己没了。所以两个常量的关系必须被钉住。
  // 而客户端是"按服务端报出来的超时算间隔"，所以这里同时验证：
  //   · 默认 90 秒时，间隔算出来是 20 秒（安全）
  //   · 服务端超时被压小（测试用）时，间隔跟着变小
  //   · 下限兜底，不会算出 1ms 这种刷屏值
  {
    const KA = await import(pathToFileURL(path.join(ROOT, 'app/js/keepalive.js')).href);
    ck(typeof KA.pingIntervalFor === 'function', 'keepalive 导出了 pingIntervalFor');

    const DEFAULT_TIMEOUT = 90 * 1000;   // server.js 的默认值
    const iv = KA.pingIntervalFor(DEFAULT_TIMEOUT);
    ck(iv === KA.PING_MS, `90 秒超时 → 间隔 ${KA.PING_MS / 1000}s（期望 ${iv / 1000}s）`);
    ck(DEFAULT_TIMEOUT >= iv * 4,
      `余量足够：超时 ${DEFAULT_TIMEOUT / 1000}s ≥ 4 × 间隔 ${iv / 1000}s（连续丢 3 次也不误杀）`);

    // 服务端超时变小 → 间隔跟着变小（但不能小于下限）
    ck(KA.pingIntervalFor(8000) === 2000, '8 秒超时 → 2 秒间隔（按 1/4 跟算）');
    ck(KA.pingIntervalFor(1000) === 1500, '1 秒超时 → 命中间隔下限 1.5 秒（不会算出 250ms）');
    ck(KA.pingIntervalFor(0) === KA.PING_MS, '非法超时（0）→ 回退默认间隔');
    ck(KA.pingIntervalFor('abc') === KA.PING_MS, '非法超时（字符串）→ 回退默认间隔');
    ck(KA.pingIntervalFor(-5) === KA.PING_MS, '负数超时 → 回退默认间隔');

    // app.js 必须真的调用它 —— 否则整个心跳根本没启动
    const appSrc = fs.readFileSync(path.join(ROOT, 'app/js/app.js'), 'utf8');
    ck(/startKeepalive\s*\(\s*\)/.test(appSrc.replace(/^\s*\/\/.*$/gm, '')),
      'app.js 在启动流程里真的调用了 startKeepalive()');
  }
} finally {
  fs.rmSync(LOG, { force: true });
}

console.log('\n' + '='.repeat(72));
if (failures.length) {
  console.log(` 失败 ${failures.length} 项 / 通过 ${pass} 项`);
  for (const f of failures) console.log(`   ✗ ${f}`);
  process.exit(1);
}
console.log(` 全部通过（${pass} 项）`);
console.log('='.repeat(72));
