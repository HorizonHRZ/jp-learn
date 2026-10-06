// qa-profile.mjs —— 真浏览器 QA 的**临时用户目录**（`--user-data-dir`）生命周期
//
// ⚠️ 为什么要有这个文件：2026-10 发现 `%TEMP%` 里堆了 **539 个** `jp-qa-*` /
//    `jp-qabugs-*` / `jp-ruby-*` … 目录，**合计 18.3 GB**。六个 QA 脚本各自
//    `mkdtempSync()` 建一个浏览器用户目录，`cleanup()` 里只 `child.kill()`
//    和 `server.close()` —— **从来没人删那个目录**。每跑一遍自检就涨约 150 MB。
//
// 光在 `cleanup()` 里补一句 `rmSync` 是**不够的**，两个坑：
//
//   ① `child.kill()` 只是**发出**终止信号，浏览器**还没退**。CDP 会话一断就
//      立刻删目录，Windows 上浏览器还攥着里面的文件句柄 → `EBUSY`/`EPERM`，
//      删不掉。所以要先**等进程真的退出**（killAndWait，有超时上限）。
//   ② `rmSync` 的 `maxRetries` 只对少数错误码重试，`EBUSY` 不一定被覆盖，
//      而且 Node 自己的文档就写着"遇到 EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM
//      要重试"。所以这里**自己写重试循环**，退避间隔逐步拉长。
//
// 设计约束：`process.on('exit')` 里**只能跑同步代码**，所以这两个函数都是同步的。
// 如果退避重试都用完还是删不掉（极少见），最后用一个**分离的**后台进程再试 ——
// 它不阻塞测试退出，而且万一 spawn 失败也只是留下一个目录，**绝不能让 QA 崩**。
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const sleep = (ms) => {
  // 同步睡：Atomics.wait 比忙等干净，且不需要 setTimeout（exit 里不能等异步）
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
};

/**
 * 杀浏览器并**等它真的退出**。
 *
 * 为什么不能只 kill 了就走：见文件头 ①。进程退干净了，它占的文件句柄才释放，
 * 后面的删目录才不会 EBUSY。
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} timeoutMs 最多等多久（超时不报错，只是不再等）
 * @returns {boolean} 是否确认已退出
 */
export function killAndWait(child, timeoutMs = 4000) {
  if (!child) return true;
  try { child.kill(); } catch { /* 可能已经退了 */ }

  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    // exitCode !== null 表示已退出；signalCode 有值也算
    if (child.exitCode !== null || child.signalCode) return true;
    sleep(60);
  }

  // 还没退：强杀再等一小会儿。SIGKILL 在 Windows 上被 Node 映射为 TerminateProcess。
  try { child.kill('SIGKILL'); } catch { /* 忽略 */ }
  const t1 = Date.now();
  while (Date.now() - t1 < 1500) {
    if (child.exitCode !== null || child.signalCode) return true;
    sleep(60);
  }
  return false;
}

/**
 * 删掉一个临时目录，自带退避重试。
 *
 * @param {string} dir
 * @returns {boolean} 是否确认删掉了
 */
export function removeProfile(dir) {
  if (!dir) return true;
  const waits = [40, 120, 250, 500, 900, 1500];  // 合计约 3.3 秒
  for (let i = 0; i < waits.length; i++) {
    if (i) sleep(waits[i]);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* 还被占着，下一轮再试 */ }
    if (!fs.existsSync(dir)) return true;
  }
  return false;
}

/**
 * 收尾：**先等浏览器退出，再删它那个用户目录**。两个都做完才算干净。
 *
 * 用法（把原来的 `cleanup` 换掉）：
 *   import { finishBrowser } from './lib/qa-profile.mjs';
 *   const cleanup = () => { finishBrowser(child, profile); try { server.close(); } catch {} };
 *   process.on('exit', cleanup);
 *   process.on('SIGINT', () => { cleanup(); process.exit(130); });
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {string} profile
 * @param {{timeoutMs?: number}} [opts]
 * @returns {{killed: boolean, removed: boolean}}
 */
export function finishBrowser(child, profile, opts = {}) {
  const killed = killAndWait(child, opts.timeoutMs ?? 4000);
  const removed = removeProfile(profile);

  // 兜底：重试都用完还没删掉（浏览器迟迟不退 / 杀不掉），交给一个分离的
  // 后台进程稍后再删。它不阻塞本进程退出（detached + unref）。
  // ⚠️ 整个兜底必须包在 try 里：spawn 在受限环境可能直接抛（EPERM），
  //    而**兜底失败绝不能让 QA 脚本崩**。
  if (!removed) {
    try {
      const code = `
        const fs = require('fs');
        const dir = process.argv[1];
        let n = 0;
        const t = setInterval(() => {
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
          if (!fs.existsSync(dir) || ++n > 40) { clearInterval(t); process.exit(0); }
        }, 500);
      `;
      const p = spawn(process.execPath, ['-e', code, profile], {
        detached: true, stdio: 'ignore', windowsHide: true,
      });
      p.unref();
    } catch { /* 兜底失败就留着，不影响测试结论 */ }
  }

  return { killed, removed };
}
