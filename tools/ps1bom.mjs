/**
 * 给 PowerShell 脚本补上 UTF-8 BOM。
 *
 * 为什么必须这样做（真事故）：
 *   Windows PowerShell 5.1 判断脚本编码**只看 BOM**。
 *   没有 BOM 时它按**系统 ANSI 代码页**解码 —— 中文机器上是 GBK。
 *   于是脚本里的 UTF-8 中文注释/字符串被解成乱码，
 *   而 GBK 解码会把某些字节吞掉，**连字符串的结束引号都被吃掉**，
 *   结果是整个文件**解析失败**（连 -Probe 都跑不起来，报"字符串缺少终止符"）。
 *
 *   实测：`tools/win-ocr.ps1` 里 `"系统未安装 $Lang 的 OCR 语言包"` 这行，
 *   在无 BOM 时被解成 `"系统未安?$Lang ?OCR 语言? ; languages = ...`，
 *   `$Lang` 后面那个字的尾字节把空格和引号一起吞了 → 解析崩。
 *
 * 为什么会被弄丢：本项目的 `edit`/`write` 工具按 UTF-8 读写文本，**不保留 BOM**。
 * 所以凡是用编辑工具改过带中文的 .ps1，就会踩这个坑。
 *
 * 用法：node tools/ps1bom.mjs
 * 之后请跑 `node tools/test-ps1.mjs` 验证。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = path.join(ROOT, 'tools');
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

let fixed = 0;
let already = 0;
for (const name of fs.readdirSync(TOOLS)) {
  if (!name.endsWith('.ps1')) continue;
  const full = path.join(TOOLS, name);
  const buf = fs.readFileSync(full);
  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  if (hasBom) { already++; console.log(`  ok  已有 BOM：${name}`); continue; }
  const text = buf.toString('utf8');
  const nonAscii = [...text].filter((c) => c.codePointAt(0) > 127).length;
  fs.writeFileSync(full, Buffer.concat([BOM, buf]));
  fixed++;
  console.log(`  FIX 补上 BOM：${name}（含 ${nonAscii} 个非 ASCII 字符）`);
}
console.log(`\n完成：补了 ${fixed} 个，本来就有 ${already} 个。`);
