// ============================================================================
// jp-learn 数据下载脚本（零依赖，只用 Node 内置模块）
//
// 用法:
//   node tools/fetch-data.mjs              # 下载全部
//   node tools/fetch-data.mjs --only=cn    # 只下 jmdict-cn（中文词库，含 JLPT 分级与中日例句）
//   node tools/fetch-data.mjs --only=jlpt  # 只下 JLPT 官方分级词表
//   node tools/fetch-data.mjs --only=jm    # 只下 JMdict/kanjidic2（兜底查词）
//   node tools/fetch-data.mjs --force      # 忽略缓存，全部重下
//
// 产物全部落在 data-cache/，可以随时整个删掉，重跑本脚本会重新下。
// 本脚本只下载「数据」，不改 data/ 目录；把缓存编译成 data/ 的是：
//   tools/build-vocab.mjs   （词库 + 查词/分词索引）
//   tools/build-romaji.mjs  （假名 → 罗马音表）
//
// 为什么要重写这个脚本（上一版的问题，实测确认）：
//   1. 上一版抓 scriptin/jmdict-simplified 的 jmdict-zh，但**上游从 3.6.2 起已经没有中文版了**
//      （实测该 release 只有 eng/dut/fre/ger/hun/rus/slv/spa/swe），find(/^jmdict-zh-/) 恒为 undefined。
//   2. 上一版的 JLPT 词表源（Bluskyo/JLPT_Vocabulary）不可靠。
//   3. raw.githubusercontent.com 在本机连通性不稳定，必须带重试 + 断点续传。
//   4. 下载完没有校验，坏包会被静默当成好包。
//
// 数据来源与许可（会在控制台末尾与 data-cache/MANIFEST.json 里再次列出）：
//   jmdict-cn                 CC BY-SA 4.0   JMdict 的中文衍生版（自带 JLPT 分级 + 中日对照例句）
//   yomitan-jlpt-vocab        CC BY-SA 4.0   JLPT N5-N1 官方分级词表（上游为 Jonathan Waller, CC BY）
//   jmdict-simplified         CC BY-SA 4.0   JMdict / kanjidic2（英文兜底释义）
//   Tatoeba                   CC BY 2.0 FR   日文例句（可选，失败不致命）
// ============================================================================
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = path.join(ROOT, 'data-cache');
const MANIFEST = path.join(CACHE, 'MANIFEST.json');

const UA = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) jp-learn-data-fetcher/2.0',
  'accept': '*/*',
};

// ---------------------------------------------------------------------------
// 为什么不用全局 fetch（重要，别改回去）
//
// 这台机器的网络对外很不稳，实测：
//   · github.com 建立 TLS 连接需要约 7.8 秒
//   · raw.githubusercontent.com 会间歇 ECONNRESET（一次实测直接 30 秒失败）
// 而 Node 内置 fetch(undici) 的**连接超时是写死的 10 秒，且无法调整**
// （本机既没有 node_modules/undici，Node 24 也不暴露 node:undici，拿不到 Agent 来改超时）。
// 结果就是：release 资产在 fetch 下几乎必然 "Connect Timeout Error"。
//
// 所以这里改用 node:https 手写请求，自己控制连接超时、空转超时与重定向。
// ---------------------------------------------------------------------------

const CONNECT_TIMEOUT = 45000; // 建连超时（github.com 实测要 7.8s，留足余量）
const IDLE_TIMEOUT = 90000;    // 连接建好后的空转超时

/**
 * 发一个 HTTP 请求，自动处理重定向与传输层 gzip 解压。
 * 返回 { status, headers, stream, buffer() , text(), json() }
 * stream 只在 buffer() 未被调用时可用（响应体是一次性流）。
 */
function httpRequest(url, { method = 'GET', headers = {}, redirects = 8 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('非法 URL：' + url)); }
    const mod = u.protocol === 'http:' ? http : https;

    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method,
      headers: { ...UA, ...headers },
      // 关键：不校验证书链之外的东西；这里保持默认严格校验，只放宽超时
      timeout: CONNECT_TIMEOUT,
    }, (res) => {
      // 重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); // 丢掉 body，释放连接
        if (redirects <= 0) return reject(new Error('重定向次数过多：' + url));
        const next = new URL(res.headers.location, url).toString();
        return httpRequest(next, { method, headers, redirects: redirects - 1 }).then(resolve, reject);
      }

      res.setTimeout(IDLE_TIMEOUT, () => {
        res.destroy(new Error('读取响应超时'));
      });

      // 只在「传输层」解压。注意：.tgz/.gz 这类是文件本身的压缩，
      // 服务端不会再加 Content-Encoding，所以不会被误解压。
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());

      const api = {
        status: res.statusCode,
        headers: res.headers,
        stream,
        ok: res.statusCode >= 200 && res.statusCode < 300,
        bytes: Number(res.headers['content-length'] || 0), // 传输字节（解压前）
        buffer: () => new Promise((ok, bad) => {
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => ok(Buffer.concat(chunks)));
          stream.on('error', bad);
        }),
      };
      api.text = async () => (await api.buffer()).toString('utf8');
      api.json = async () => JSON.parse(await api.text());
      resolve(api);
    });

    req.on('timeout', () => req.destroy(new Error(`连接超时（${CONNECT_TIMEOUT / 1000}s）`)));
    req.on('error', reject);
    if (method === 'GET') req.end();
    else req.end();
  });
}

/** 带重试的请求（网络抖动是常态，必须重试） */
async function requestRetry(url, opts = {}, tries = 6) {
  let last = null;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await httpRequest(url, opts);
      if (r.ok) return r;
      if (r.status < 500 && r.status !== 429) return r; // 4xx 不重试，重试也没用
      last = new Error('HTTP ' + r.status);
    } catch (e) {
      last = e;
    }
    if (i < tries) {
      const wait = Math.min(1500 * i, 12000);
      log(`      · 第 ${i}/${tries} 次失败（${last && last.message}），${(wait / 1000).toFixed(1)}s 后重试`);
      await sleep(wait);
    }
  }
  throw new Error(`请求失败（已重试 ${tries} 次）：${url} —— ${last && last.message}`);
}

async function sha256File(p) {
  const h = crypto.createHash('sha256');
  await new Promise((ok, bad) => {
    const s = fs.createReadStream(p);
    s.on('data', (c) => h.update(c));
    s.on('end', ok);
    s.on('error', bad);
  });
  return h.digest('hex');
}

/**
 * 断点续传下载。
 *   · 远端未变且本地大小一致 → 跳过（除非 --force）
 *   · 本地比远端小 → 用 Range 续传
 *   · 服务端不支持 Range（回 200）→ 从头重写，绝不追加（否则文件必损坏）
 *   · 不完整就删掉坏文件并报错，不留半个文件被当成好的
 */
async function download(url, dest, label) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  // 探测远端大小（传输字节），用于判断缓存是否完整
  let remoteSize = 0;
  try {
    const head = await requestRetry(url, { method: 'HEAD' }, 3);
    remoteSize = Number(head.headers['content-length'] || 0);
  } catch {
    // 有些服务端不支持 HEAD，忽略；后面按 GET 收到的字节判断
  }

  let have = 0;
  try { have = (await fsp.stat(dest)).size; } catch { have = 0; }

  if (!FORCE && have > 0 && remoteSize && have === remoteSize) {
    log(`  [skip] ${label} 已完整缓存（${mb(have)}）`);
    return dest;
  }
  if (!FORCE && have > 1024 && !remoteSize) {
    log(`  [skip] ${label} 已存在（${mb(have)}，远端未给大小）`);
    return dest;
  }

  const resumeFrom = !FORCE && have > 0 && remoteSize > 0 && have < remoteSize ? have : 0;
  if (resumeFrom > 0) log(`  [续传] ${label} 从 ${mb(resumeFrom)} 继续（共 ${mb(remoteSize)}）`);
  else log(`  [下载] ${label} ...`);

  const headers = {};
  if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`;

  const r = await requestRetry(url, { headers });
  if (!r.ok) throw new Error(`${label} HTTP ${r.status}`);

  // 只有服务端确实回了 206 才能追加；回 200 说明不支持 Range，必须从头写
  const appending = resumeFrom > 0 && r.status === 206;
  if (resumeFrom > 0 && !appending) log(`      · 远端不支持续传（HTTP ${r.status}），改为从头下载`);

  // 注意：r.bytes 是「传输字节」（Content-Length），而 r.stream 可能是解压后的流。
  // 下载数据文件时服务端不会加 Content-Encoding（.tgz/.json 都是原样传），
  // 所以写入字节数应当等于 Content-Length。若不等则说明传输被截断。
  const expected = Number(r.headers['content-length'] || 0) || remoteSize || 0;
  const out = fs.createWriteStream(dest, { flags: appending ? 'a' : 'w' });
  let got = appending ? resumeFrom : 0;
  r.stream.on('data', (c) => { got += c.length; });
  await pipeline(r.stream, out);

  if (expected && got !== expected) {
    await fsp.rm(dest, { force: true }); // 删掉坏包，免得下次被误判为"已缓存"
    throw new Error(`${label} 下载不完整：得到 ${got} 字节，声明 ${expected} 字节（重跑本脚本会自动重下）`);
  }
  log(`  [完成] ${label}  ${mb(got)}`);
  return dest;
}

// ---------- 命令行参数 ----------
const argv = process.argv.slice(2);
const argOf = (k) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : null;
};
const ONLY = argOf('only');
const FORCE = argv.includes('--force');

// ---------- 小工具 ----------
const log = (...a) => console.log(...a);
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }


/**
 * 从 tar 流里取出第一个**普通文件**的内容，写进 outPath。
 *
 * ⚠️ 这个函数是补一个真 bug 的。原来的代码把 `.tgz` 直接喂给 `zlib.createGunzip()`
 *    就当成"解压好了" —— 但 `.tgz` = gzip( tar( file ) )，是**两层**。
 *    gunzip 之后拿到的是 tar 归档，不是 JSON：文件开头是
 *       `kanjidic2-all-3.6.2.json\0\0…` + 512 字节头 + 512 字节对齐的正文。
 *    于是字节数看着挺像（16.86 MB），但 `JSON.parse` 必然失败，
 *    而上游代码的兜底是"改用词库自举"，manifest 里只留下一行
 *    `kanjiReadings: 0`，**没有任何红灯**。这个坏包在磁盘上躺了很久。
 *
 *    教训：**"解压成功"不等于"内容正确"**。只要有 `JSON.parse`，
 *    就必须让它在数据刷新时真的跑一次，而不是只检查文件大不大。
 *
 * 这里做最小但**正确**的 tar 解析：512 字节头 + 512 字节对齐的正文，
 * 遇到全零块即结束（EOF 之前的补零）。带校验和验证 —— 这样如果上游换了
 * 打包方式，我们会得到明确的报错，而不是一个静默的坏文件。
 */
async function extractFirstFileFromTar(inPath, outPath) {
  const body = await fsp.readFile(inPath);
  let off = 0;
  let sawHeader = false;
  while (off + 512 <= body.length) {
    const header = body.subarray(off, off + 512);
    // 全零块 = 归档结束（tar 用两个零块收尾，也可能只补零到 512 的倍数）
    if (header.every((b) => b === 0)) break;
    const cstr = (start, len) => {
      const slice = body.subarray(off + start, off + start + len);
      const end = slice.indexOf(0);
      return slice.subarray(0, end < 0 ? slice.length : end).toString('utf8');
    };
    const name = cstr(0, 100);
    const sizeStr = cstr(124, 12).trim();
    const size = parseInt(sizeStr, 8);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`tar 头里的文件大小不是八进制：${JSON.stringify(sizeStr)}（偏移 ${off}）`);
    }
    // 校验和：头里 148..156 是校验和字段本身，算的时候它按 8 个空格算
    const sumField = body.subarray(off + 148, off + 156);
    const declared = parseInt(sumField.toString('utf8').replace(/[^0-7]/g, '').trim() || '0', 8);
    let actual = 0;
    for (let i = 0; i < 512; i++) actual += i >= 148 && i < 156 ? 32 : header[i];
    if (declared !== actual) {
      throw new Error(`tar 头校验和不符（偏移 ${off}，声明 ${declared}，实算 ${actual}）—— 上游打包方式可能变了`);
    }
    const type = header[156];
    // '0' 或 '\0' = 普通文件；'5' = 目录；'L' = 长文件名扩展块
    if (type === 0x30 || type === 0x00) {
      const data = body.subarray(off + 512, off + 512 + size);
      if (data.length < size) throw new Error(`tar 里的 ${name} 被截断了（要 ${size} 字节，只有 ${data.length}）`);
      await fsp.writeFile(outPath, data);
      // ★ 解压完**必须**能解析出来，否则就当失败 ——
      //   这正是原来那个坏包能静默存在的缺口。只对 JSON 做这个检查。
      if (/\.json$/i.test(outPath)) {
        try { JSON.parse(data.toString('utf8')); }
        catch (e) { throw new Error(`解压出来的 ${name} 不是合法 JSON：${e.message}`); }
      }
      log(`  [解压] tar 内取出 ${name}（${mb(data.length)}）`);
      return outPath;
    }
    sawHeader = true;
    off += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(sawHeader
    ? 'tar 里没有找到普通文件（只有目录或扩展块）'
    : '这不是一个有效的 tar 归档（开头就是全零块或长度不足）');
}

/** .tgz / .gz 解压。isTar=true 时再剥一层 tar（`.tgz` = gzip + tar）。 */
async function gunzipTo(gzPath, outPath, label, isTar = false) {
  // ⚠️ 跳过判断只在**没有 isTar 校验**时用文件大小；带校验的必须真解压一次，
  //    否则旧的那个坏包永远会被 [skip] 放过（它 16.86 MB，比 1024 大得多）。
  if (!FORCE && fs.existsSync(outPath) && fs.statSync(outPath).size > 1024 && !isTar) {
    log(`  [skip] ${label} 已解压（${mb(fs.statSync(outPath).size)}）`);
    return outPath;
  }
  log(`  [解压] ${label} ...`);
  const tmp = outPath + '.part';
  await pipeline(fs.createReadStream(gzPath), zlib.createGunzip(), fs.createWriteStream(tmp));
  if (isTar) {
    await extractFirstFileFromTar(tmp, tmp + '.tar');  // 抛出即失败，不留半个文件
    await fsp.rename(tmp + '.tar', outPath);
    await fsp.rm(tmp, { force: true });
  } else {
    await fsp.rename(tmp, outPath); // 先写 .part 再改名，避免解压中断留下半个文件被当成好的
  }
  log(`  [完成] ${label}  ${mb(fs.statSync(outPath).size)}`);
  return outPath;
}

// ---------- 数据源清单 ----------
const RAW = 'https://raw.githubusercontent.com';

// 1) jmdict-cn：JMdict 的中文衍生版，自带 JLPT 分级 + 中文释义 + 中日对照例句
//    这是本项目「中日释义」的主来源（jmdict-simplified 已不再提供中文版）
const CN_LEVELS = ['n5', 'n4', 'n3', 'n2', 'n1'];
const CN_BASE = `${RAW}/zzhuxiaojun-glitch/jmdict-cn/main/data`;

// 2) JLPT 官方分级词表：抓不到时不影响主流程，只是无法补全 jmdict-cn 未覆盖的词
const JLPT_BASE = `${RAW}/stephenmk/yomitan-jlpt-vocab/main/original_data`;

// 3) JMdict / kanjidic2：英文兜底释义 + 汉字信息（查词兜底用）
const JM_RELEASE_API = 'https://api.github.com/repos/scriptin/jmdict-simplified/releases/latest';

const results = [];   // { key, label, url, file, bytes, sha256, ok, error }

async function record(key, label, url, file, fn) {
  const t0 = Date.now();
  try {
    await fn();
    let bytes = 0, sha = '';
    try {
      bytes = (await fsp.stat(file)).size;
      sha = await sha256File(file);
    } catch {}
    results.push({ key, label, url, file: path.relative(ROOT, file), bytes, sha256: sha, ok: true });
    log(`      ✓ ${label}（${mb(bytes)}，${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  } catch (e) {
    results.push({ key, label, url, file: path.relative(ROOT, file), ok: false, error: String(e && e.message || e) });
    log(`      ✗ ${label} 失败：${e && e.message}`);
  }
}

async function partCn() {
  log('\n=== 1/4 jmdict-cn（中文释义 + JLPT 分级 + 中日对照例句，CC BY-SA 4.0）===');
  for (const lv of CN_LEVELS) {
    const name = `jmdict-cn-${lv.toUpperCase()}.json`;
    await record('cn', name, `${CN_BASE}/${name}`, path.join(CACHE, 'jmdict-cn', name),
      () => download(`${CN_BASE}/${name}`, path.join(CACHE, 'jmdict-cn', name), name));
    const meta = name.replace(/\.json$/, '.meta.json');
    await record('cn', meta, `${CN_BASE}/${meta}`, path.join(CACHE, 'jmdict-cn', meta),
      () => download(`${CN_BASE}/${meta}`, path.join(CACHE, 'jmdict-cn', meta), meta));
  }
  // untagged 很大（4 MB）但它是「JLPT 分级之外」词的唯一中文来源，值得下
  await record('cn', 'jmdict-cn-untagged.json', `${CN_BASE}/jmdict-cn-untagged.json`,
    path.join(CACHE, 'jmdict-cn', 'jmdict-cn-untagged.json'),
    () => download(`${CN_BASE}/jmdict-cn-untagged.json`, path.join(CACHE, 'jmdict-cn', 'jmdict-cn-untagged.json'), 'jmdict-cn-untagged.json'));
}

async function partJlpt() {
  log('\n=== 2/4 JLPT 官方分级词表（CC BY-SA 4.0，上游 Jonathan Waller CC BY）===');
  for (const lv of CN_LEVELS) {
    const name = `${lv}.csv`;
    await record('jlpt', `jlpt-${name}`, `${JLPT_BASE}/${name}`, path.join(CACHE, 'jlpt', name),
      () => download(`${JLPT_BASE}/${name}`, path.join(CACHE, 'jlpt', name), `JLPT ${name}`));
  }
}

async function partJm() {
  log('\n=== 3/4 JMdict / kanjidic2（英文兜底释义，CC BY-SA 4.0）===');
  log('  说明：这一段是「锦上添花」。本应用的中文释义、JLPT 分级、中日对照例句');
  log('        全部来自 jmdict-cn（第 1 段），即使本段全部失败也不影响主要功能。');
  // 实测：本机 github.com 建连要 ~8s，release 资产约一半概率会超时。
  // 所以这里只用一次短重试，失败就跳过，绝不拖住整个下载流程。
  let release = null;
  try {
    const r = await requestRetry(JM_RELEASE_API, {}, 3);
    release = await r.json();
    log(`  上游版本：${release.tag_name}`);
  } catch (e) {
    log(`  [跳过] 无法访问 GitHub Releases（${e.message}）`);
    log('         这不影响使用：中文词库已从 raw.githubusercontent 取得。');
    return;
  }
  const pick = (re) => release.assets.find((a) => re.test(a.name) && a.name.endsWith('.json.tgz'));
  // 只要 kanjidic2（1.5MB，用来补单字读音）；jmdict-eng 与 jmdict-cn 内容重复，不必再下 11MB
  const wanted = [
    ['kanjidic2', pick(/^kanjidic2-all-/), '汉字读音与意义（补单字注音兜底）'],
  ];
  for (const [key, asset, note] of wanted) {
    if (!asset) { log(`  [warn] ${key} 上游缺失，跳过（${note}）`); continue; }
    const tgz = path.join(CACHE, 'jmdict', asset.name);
    await record('jm', asset.name, asset.browser_download_url, tgz,
      () => download(asset.browser_download_url, tgz, `${asset.name}（${note}）`));
    if (fs.existsSync(tgz)) {
      await record('jm', asset.name.replace(/\.tgz$/, ''), asset.browser_download_url,
        tgz.replace(/\.tgz$/, ''),
        // ★ isTar=true：`.tgz` 是 gzip + tar 两层，只 gunzip 会得到一个 tar 归档，
        //   而它看着像 JSON、其实解析不了（见 extractFirstFileFromTar 的注释）。
        () => gunzipTo(tgz, tgz.replace(/\.tgz$/, ''), asset.name.replace(/\.tgz$/, ''), true));
    }
  }
}

async function partTatoeba() {
  log('\n=== 4/4 Tatoeba 日文例句（CC BY 2.0 FR，可选）===');
  // 注意：Tatoeba 官方只提供 .bz2，Node 内置没有 bzip2 解压，所以这里只作为「可选补充」，
  // 主要例句来源是 jmdict-cn 自带的 examples（含 tatoeba_id，可追溯原文）。
  const url = 'https://downloads.tatoeba.org/exports/per_language/jpn/jpn_sentences.tsv.bz2';
  const dest = path.join(CACHE, 'tatoeba', 'jpn_sentences.tsv.bz2');
  await record('tatoeba', 'jpn_sentences.tsv.bz2', url, dest, () => download(url, dest, 'jpn_sentences.tsv.bz2'));
  log('  说明：bz2 需外部解压，本仓库不依赖它；例句以 jmdict-cn 自带的为准。');
}

// ---------- 主流程 ----------
log('\n╔══════════════════════════════════════════════════════════╗');
log('║  jp-learn 数据下载（零依赖，只用 Node 内置模块）          ║');
log('╚══════════════════════════════════════════════════════════╝');
log(`  缓存目录：${CACHE}`);
log(`  模式    ：${ONLY ? '只下 ' + ONLY : '全部'}${FORCE ? '（--force 忽略缓存）' : ''}`);

await fsp.mkdir(CACHE, { recursive: true });

try {
  if (!ONLY || ONLY === 'cn') await partCn();
  if (!ONLY || ONLY === 'jlpt') await partJlpt();
  if (!ONLY || ONLY === 'jm') await partJm();
  if (!ONLY || ONLY === 'tatoeba') await partTatoeba();
} catch (e) {
  log(`\n[致命] ${e && e.message}`);
}

// ---------- 汇总 ----------
const ok = results.filter((r) => r.ok);
const bad = results.filter((r) => !r.ok);
log('\n' + '─'.repeat(60));
log(`下载汇总：成功 ${ok.length} 项，失败 ${bad.length} 项，合计 ${mb(ok.reduce((s, r) => s + r.bytes, 0))}`);
if (bad.length) {
  log('失败项（可重跑本脚本，会自动续传/跳过已完成的）：');
  for (const r of bad) log(`  ✗ ${r.label} —— ${r.error}`);
}
let oldManifest = null;
try { oldManifest = JSON.parse(await fsp.readFile(MANIFEST, 'utf8')); } catch {}
await fsp.writeFile(MANIFEST, JSON.stringify({
  generatedAt: new Date().toISOString(),
  node: process.version,
  force: FORCE,
  only: ONLY,
  previousGeneratedAt: oldManifest && oldManifest.generatedAt || null,
  files: results,
  licenses: {
    'jmdict-cn': 'CC BY-SA 4.0 — https://github.com/zzhuxiaojun-glitch/jmdict-cn（基于 EDRDG JMdict）',
    'yomitan-jlpt-vocab': 'CC BY-SA 4.0 — https://github.com/stephenmk/yomitan-jlpt-vocab（上游 Jonathan Waller, CC BY）',
    'jmdict-simplified': 'CC BY-SA 4.0 — https://github.com/scriptin/jmdict-simplified（EDRDG JMdict / kanjidic2）',
    tatoeba: 'CC BY 2.0 FR — https://tatoeba.org/',
  },
}, null, 2) + '\n', 'utf8');
log(`清单已写入：${path.relative(ROOT, MANIFEST)}`);
log('\n下一步：node tools/build-romaji.mjs && node tools/build-vocab.mjs');
log('数据许可：jmdict-cn / yomitan-jlpt-vocab / jmdict-simplified = CC BY-SA 4.0 (EDRDG 及衍生项目)；Tatoeba = CC BY 2.0 FR\n');
process.exit(bad.length ? 1 : 0);
