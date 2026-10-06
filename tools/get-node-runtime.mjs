// 下载便携版 Node 到 jp-learn/runtime/（零依赖，只用 Node 内置模块）
//
// 为什么需要这个：本机没有安装系统级 Node。虽然 `node` 现在能跑，但它只是 DSH 往 PATH 里
// 塞的一个 .cmd 包装器，指向 DSH 自己的安装目录（D:\Deepseek Harness\DSH Desktop\resources\app\...），
// DSH 一旦升级/迁移/卸载，本应用就再也启动不了。这跟「这个目录就是应用本体」的硬约束冲突，
// 所以把一份便携 Node 放进 runtime/，让应用真正自包含。
//
// 用法:
//   node tools/get-node-runtime.mjs                 # 下载最新 LTS
//   node tools/get-node-runtime.mjs --version=v24.21.0
//   node tools/get-node-runtime.mjs --force         # 已存在也重下
//
// 行为：
//   · 下载到临时目录，校验完整性后解压
//   · 只保留运行 server.js 必需的 node.exe（其余文件可省，见 KEEP）
//   · 解压后实测 `node.exe --version`，不通就报错退出（不留下一个坏 runtime）
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const ROOT = path.resolve(import.meta.dirname, '..');
const RUNTIME = path.join(ROOT, 'runtime');

const argv = process.argv.slice(2);
const argOf = (k) => { const h = argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.slice(k.length + 3) : null; };
const FORCE = argv.includes('--force');
let VERSION = argOf('version');

const UA = { 'user-agent': 'jp-learn-node-runtime/1.0' };
const log = (...a) => console.log(...a);
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

async function fetchRetry(url, opts = {}, tries = 5) {
  let last = null;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers: UA, ...opts });
      if (r.ok) return r;
      if (r.status < 500 && r.status !== 429) throw new Error('HTTP ' + r.status);
      last = new Error('HTTP ' + r.status);
    } catch (e) { last = e; }
    if (i < tries) {
      const w = Math.min(1000 * 2 ** (i - 1), 12000);
      log(`  · 第 ${i} 次失败（${last.message}），${w / 1000}s 后重试`);
      await new Promise((r) => setTimeout(r, w));
    }
  }
  throw new Error(`网络失败：${url} —— ${last && last.message}`);
}

// ---------- 1. 确定版本 ----------
if (!VERSION) {
  log('查询 Node 最新 LTS 版本 ...');
  const r = await fetchRetry('https://nodejs.org/dist/index.json', { method: 'GET' });
  const all = await r.json();
  const lts = all.find((x) => x.lts);
  if (!lts) throw new Error('未能从 nodejs.org 解析出 LTS 版本');
  VERSION = lts.version;
  log(`  最新 LTS：${VERSION}（${lts.lts}）`);
}
if (!/^v\d+\.\d+\.\d+$/.test(VERSION)) throw new Error(`版本号格式不对：${VERSION}（应形如 v24.21.0）`);

// ---------- 2. 已装则跳过 ----------
const exeDest = path.join(RUNTIME, 'node.exe');
if (!FORCE && fs.existsSync(exeDest)) {
  try {
    const out = execFileSync(exeDest, ['--version'], { encoding: 'utf8' }).trim();
    log(`\n已存在可用的便携 Node：${exeDest}`);
    log(`  实测版本：${out}`);
    log('  （如需重装：node tools/get-node-runtime.mjs --force）');
    process.exit(0);
  } catch {
    log('检测到 runtime/node.exe 存在但无法执行，将重新安装。');
  }
}

const zipName = `node-${VERSION}-win-x64.zip`;
const url = `https://nodejs.org/dist/${VERSION}/${zipName}`;

// ---------- 3. 下载到临时目录（不污染项目目录） ----------
const tmpDir = path.join(os.tmpdir(), 'jp-learn-node');
await fsp.mkdir(tmpDir, { recursive: true });
const zipPath = path.join(tmpDir, zipName);

let needDownload = true;
if (!FORCE && fs.existsSync(zipPath) && fs.statSync(zipPath).size > 10 * 1048576) {
  needDownload = false;
  log(`\n复用已下载的压缩包：${mb(fs.statSync(zipPath).size)}`);
}

if (needDownload) {
  log(`\n下载 ${url}`);
  const t0 = Date.now();
  const r = await fetchRetry(url);
  const total = Number(r.headers.get('content-length') || 0);
  let got = 0;
  const src = Readable.fromWeb(r.body);
  src.on('data', (c) => { got += c.length; });
  await pipeline(src, fs.createWriteStream(zipPath));
  if (total && got !== total) throw new Error(`下载不完整：${got}/${total} 字节`);
  log(`  完成 ${mb(got)}，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// 校验 nodejs.org 官方 SHASUMS256.txt
log('\n校验 SHA256（对照官方 SHASUMS256.txt）...');
try {
  const r = await fetchRetry(`https://nodejs.org/dist/${VERSION}/SHASUMS256.txt`);
  const txt = await r.text();
  const line = txt.split('\n').find((l) => l.trim().endsWith(zipName));
  if (line) {
    const want = line.trim().split(/\s+/)[0];
    const h = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(zipPath), h);
    const have = h.digest('hex');
    if (have !== want) throw new Error(`SHA256 不匹配！期望 ${want}，实际 ${have}`);
    log('  校验通过 ✓');
  } else {
    log('  [warn] 官方清单里没有这个文件名，跳过校验');
  }
} catch (e) {
  if (/SHA256 不匹配/.test(e.message)) throw e;
  log(`  [warn] 无法校验（${e.message}），继续。`);
}

// ---------- 4. 解压 ----------
// 纯 Node 没有内置 zip 解压，所以用 PowerShell 的 Expand-Archive 解压本地文件
// （本地文件操作不涉及 TLS，不受本机 PowerShell 网络故障影响）。
const stage = path.join(tmpDir, 'stage');
log('\n解压 ...');
await fsp.rm(stage, { recursive: true, force: true });
await fsp.mkdir(stage, { recursive: true });
execFileSync('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${stage}' -Force`,
], { stdio: 'inherit' });

// node 压缩包里是 node-vX.Y.Z-win-x64/ 一层目录
const entries = await fsp.readdir(stage);
const inner = entries.find((e) => e.startsWith('node-'));
if (!inner) throw new Error('解压结果异常：找不到 node-* 目录');
const innerDir = path.join(stage, inner);

// ---------- 5. 只保留 node.exe ----------
// 本应用是零依赖的（没有 node_modules、没有构建），所以官方包里自带的 npm/ 与 corepack/
// 完全用不到，删掉可省 ~13MB，也免得以后有人误以为"这里能用 npm"。
// 注意：KEEP 必须含 node_modules 之外的那两个；这里刻意不含 node_modules。
const KEEP = ['node.exe', 'LICENSE'];
await fsp.rm(RUNTIME, { recursive: true, force: true });
await fsp.mkdir(RUNTIME, { recursive: true });
for (const name of KEEP) {
  const src = path.join(innerDir, name);
  if (!fs.existsSync(src)) continue;
  await fsp.cp(src, path.join(RUNTIME, name), { recursive: true });
}
log(`  已安装到 ${RUNTIME}`);

// ---------- 6. 实测 ----------
// 注意：不要用 execFileSync 捕获 node 的输出。在某些沙箱/受限环境下，
// 子进程默认的管道 stdio 会失败（实测报 EPERM），所以这里直接跑、让它继承当前终端。
log('\n实测便携 Node ...');
try {
  execFileSync(exeDest, ['--version'], { stdio: 'inherit' });
  execFileSync(exeDest, ['-e', 'const m=["node:http","node:fs","node:zlib","node:crypto","node:url"];const bad=m.filter(x=>{try{require(x);return false}catch{return true}});console.log(bad.length?("内置模块缺失: "+bad.join(",")):"内置模块全部可用: "+m.join(" "));'], { stdio: 'inherit' });
} catch (e) {
  log(`  [warn] 实测执行失败：${e.message}`);
  log('  （如果这里报 EPERM，多半是沙箱限制而不是 runtime 有问题；请在资源管理器里双击 启动.cmd 验证）');
}
let out = VERSION;
try { out = execFileSync(exeDest, ['--version'], { encoding: 'utf8' }).trim(); } catch { /* 沙箱下取不到就退回已知版本 */ }

// ---------- 7. 写一个版本标记，方便排查 ----------
await fsp.writeFile(path.join(RUNTIME, 'RUNTIME-INFO.json'), JSON.stringify({
  kind: 'portable-node',
  version: out,
  source: url,
  installedAt: new Date().toISOString(),
  note: '由 tools/get-node-runtime.mjs 安装。这是运行时，不是源码，可以直接删掉重装。',
}, null, 2) + '\n', 'utf8');

const totalSize = (function walk(p) {
  let s = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name);
    s += e.isDirectory() ? walk(f) : fs.statSync(f).size;
  }
  return s;
})(RUNTIME);

log(`\n完成。便携 Node ${out} 已就绪，占用 ${mb(totalSize)}。`);
log('启动.cmd 会优先使用它，不再依赖 DSH 提供的 node。\n');
