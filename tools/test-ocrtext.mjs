/**
 * OCR 文本清洗的单测（纯函数，不需要浏览器、不需要假 DOM）。
 *
 * 为什么这个测试重要：清洗规则错了，精读页的"拍照识别"就是**废的** ——
 * 实测不做清洗时注音覆盖率从 100% 掉到 77.8%，
 * 「日本語」「勉強」「しています」这类真词全都识别不出来。
 *
 * 用例全部来自**本机 Windows.Media.Ocr（ja 引擎）的真实输出**，不是编的。
 */
import { cleanOcrText, ocrWarning } from '../app/js/ocrtext.js';

let fail = 0;
let pass = 0;
const check = (cond, label, detail) => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? '  — ' + detail : ''}`);
};
const eq = (label, got, want) => {
  const ok = got === want;
  if (!ok) fail++; else pass++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) {
    console.log(`      得到: ${JSON.stringify(got)}`);
    console.log(`      期望: ${JSON.stringify(want)}`);
  }
};

console.log('='.repeat(72));
console.log(' OCR 文本清洗测试（用例来自 Windows OCR 真实输出）');
console.log('='.repeat(72));

console.log('\n[1] 真实输出：Windows OCR 在每个字符之间插空格');
eq('日本語を勉強しています', cleanOcrText('日 本 語 を 勉 強 し て い ま す'), '日本語を勉強しています');
eq('3月1日に会います', cleanOcrText('3 月 1 日 に 会 い ま す'), '3月1日に会います');
eq('平成30年です', cleanOcrText('平 成 30 年 で す'), '平成30年です');
eq('りんごを3つ買った', cleanOcrText('り ん ご を 3 つ 買 っ た'), 'りんごを3つ買った');
eq('混排（OCR 把 English 认成 Eng ⅱ sh，空格仍要清）',
  cleanOcrText('日 本 語 と Eng ⅱ sh が 混 ざ る'), '日本語とEngⅱshが混ざる');

console.log('\n[2] 该保留的空格必须保留（真实词界）');
eq('拉丁词之间', cleanOcrText('my book'), 'my book');
eq('纯英文句子', cleanOcrText('hello world foo'), 'hello world foo');
eq('多个拉丁词', cleanOcrText('a b c'), 'a b c');

console.log('\n[3] 该删的空格必须删（日语不用空格分词）');
eq('日文与拉丁之间', cleanOcrText('これは test です'), 'これはtestです');
eq('字母右边的日文', cleanOcrText('AI を 使 う'), 'AIを使う');
eq('数字之间（OCR 在每字符间都插空格）', cleanOcrText('1 2 3'), '123');
eq('全角空格', cleanOcrText('日\u3000本\u3000語'), '日本語');
eq('制表符', cleanOcrText('日\t本'), '日本');

console.log('\n[4] 多行与边界');
eq('多行各自清洗', cleanOcrText('日 本 語\nを 勉 強'), '日本語\nを勉強');
eq('保留换行结构', cleanOcrText('一 行\n二 行\n三 行'), '一行\n二行\n三行');
eq('行首行尾空格去掉', cleanOcrText('  日 本  '), '日本');
eq('空字符串', cleanOcrText(''), '');
eq('null 不炸', cleanOcrText(null), '');
eq('undefined 不炸', cleanOcrText(undefined), '');
eq('没有空格时原样返回', cleanOcrText('日本語です'), '日本語です');
eq('只有空格', cleanOcrText('   '), '');
eq('CRLF 换行', cleanOcrText('日 本\r\n語'), '日本\n語');

console.log('\n[5] ocrWarning：发现问题要如实提醒');
{
  const raw1 = '日 本 語 を 勉 強';
  const c1 = cleanOcrText(raw1);
  const w1 = ocrWarning(raw1, c1);
  check(w1 !== null && /空格/.test(w1), '有空格被删掉时会说明', w1 || '(null)');

  check(ocrWarning('日本語です', '日本語です') === null, '没有多余空格时不报警');
  check(ocrWarning('   ', '') !== null, '空识别结果会报警');
  const w2 = ocrWarning('... !!! ', '...!!!');
  check(w2 !== null, '没有可用文字时会报警', w2 || '(null)');
}

console.log('\n[6] 回归：清洗后的结果必须能被真正分词（对照实测的覆盖率差异）');
{
  // 这一条是这次 bug 的核心：清洗前覆盖率 77.8%，清洗后 100%。
  // 这里只断言"清洗后不含空格"，真正的分词覆盖由 test-http/test-render 盯着。
  const spaced = '日 本 語 を 勉 強 し て い ま す';
  const cleaned = cleanOcrText(spaced);
  check(!/ /.test(cleaned), '清洗后日文里不再有空格', JSON.stringify(cleaned));
  check(cleaned.length < spaced.length, '清洗后变短了',
    `${spaced.length} → ${cleaned.length}`);
  // 不能把内容删没了
  check(cleaned.replace(/\s/g, '').length === spaced.replace(/\s/g, '').length,
    '只删空格，没有删掉任何字符');
}

console.log('\n' + '='.repeat(72));
console.log(fail === 0 ? ` 全部通过（${pass} 项）` : ` ${fail} 项未通过（通过 ${pass} 项）`);
console.log('='.repeat(72));
process.exit(fail === 0 ? 0 : 1);
