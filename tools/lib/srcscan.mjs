/**
 * 测试共用小工具：把源码里的"噪音"剥掉，只留下真正会执行的代码。
 *
 * ⚠️ **这个文件的存在本身就是一次教训的产物。**
 *
 * 写"源码扫描"类断言（"这个文件里不许出现 X"）时，最容易犯的错是
 * **把注释里的提及当成真的使用**。比如：
 *
 * ```js
 * // ai.js 顶部写着：密钥进 localStorage 会让泄漏面变大
 * ```
 *
 * 那是在说明**为什么不那么做**，但 `!/localStorage/.test(src)` 会报错。
 * 结果就是"测试红了，红的是测试不是代码"，而最糟的处理方式是
 * **去改本来正确的代码**让它变绿。
 *
 * 光靠"记得剥注释"是不够的 —— 项目里这段逻辑原本被手写了五六遍，
 * 每一遍都略有不同，于是每一遍都可能漏。所以抽到这里，
 * **测试要扫描源码就必须用这个函数**。
 */

/**
 * 剥掉注释，保留字符串字面量。
 *
 * 大多数场景用这个：想找 `fetch('https://…')` 里的那个地址时，
 * **字符串必须留着**。注释里提到这个词则要消掉。
 *
 * @param {string} src 源码
 * @returns {string} 去掉注释的源码（长度可能变化，不要拿它做位置计算）
 */
export function codeOnly(src) {
  return String(src)
    // 块注释（跨行）
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // 行注释。注意 `[^:]` 是为了**不误伤** `https://` 这种协议头，
    // 否则 `//` 后面整行都会被当成注释删掉，扫描结果就不可信了。
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/**
 * 剥掉注释**和**字符串字面量。
 *
 * 用在"这个文件里有没有调用某个 API"这类判断上：
 * 字符串内容和注释一样，都是"提及"而不是"使用"。
 * 例：`!/localStorage/.test(codeLike(src))` 才算真的"没用 localStorage"。
 *
 * @param {string} src 源码
 * @returns {string} 去注释、去字符串内容后的源码
 */
export function codeLike(src) {
  return codeOnly(src)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/**
 * 从一段代码里取出所有字符串字面量的内容并拼起来。
 *
 * 用在"页面上到底显示了什么字"这类判断上 ——
 * 只有字符串才是用户能看见的，注释不是。
 *
 * 会先把上一行的行注释剥掉，因为注释里常常带引号，
 * 那些引号会让 `'[^']*'` 的配对整体错位。
 *
 * @param {string} src 源码片段
 * @returns {string} 所有字符串字面量，用换行连接
 */
export function stringLiterals(src) {
  const noComments = codeOnly(src);
  const out = [];
  const re = /'([^'\\\n]|\\.)*'|"([^"\\\n]|\\.)*"/g;
  let m;
  while ((m = re.exec(noComments)) !== null) {
    out.push(m[0].slice(1, -1));
  }
  return out.join('\n');
}
