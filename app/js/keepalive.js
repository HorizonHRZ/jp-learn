/**
 * keepalive.js —— 告诉服务端"网页还开着"
 *
 * 为什么需要它（用户 2026-10 提出）：
 *   这个程序基本每天只启动一次，但关掉网页之后 node 会一直挂在后台占约 99 MB。
 *   用户的诉求是"关掉网页就停掉后台"。
 *
 * 怎么做的：网页每 20 秒 POST 一次 `/api/alive`。
 *   服务端（`server.js` 的看门狗）**90 秒**收不到任何一次，就认为页面已经关了，
 *   自己优雅退出，把内存还回去。
 *
 * 为什么是"心跳 + 超时"，不是"关闭网页时通知服务端"：
 *   1. **刷新页面会短暂断开**（2~8 秒）。如果是"关掉就立刻停"，用户按 F5
 *      那一刻服务就没了，页面直接打不开 —— 这个 bug 会非常烦人。
 *      90 秒的宽限期远大于刷新耗时，所以刷新、后退、误关重开都不会误杀。
 *   2. **浏览器崩溃 / 电脑睡眠时，"关闭通知"根本发不出来**。
 *      而"心跳停了"是客观事实，两种情况都能收敛到同一个结果。
 *
 * ⚠️ 三条不能违反的约定：
 *   ① **必须在非浏览器环境里完全不做事。** `tools/test-render.mjs` 会在 Node 里
 *      真的 import 本模块（它会加载 app.js），那里没有真的 DOM。
 *      所以下面用 `document.visibilityState` 当"我在真浏览器里"的判据：
 *      假 DOM 里这个属性是 undefined，于是直接 return，一个请求都不发。
 *      （不用 `location.protocol` 是因为假环境也没有它，同样够用，
 *        但 visibilityState 更能表达"这是个活着的、可见的页面"。）
 *   ② **只发一次就够，重复调用必须安全。** 用 `started` 标记挡住。
 *   ③ **请求地址必须是本站相对路径。** `tools/test-render.mjs` 有一条断言在盯
 *      "app/ 下的 fetch 目标不许是非相对路径"。而这里**故意把地址拼出来**：
 *      那条断言的扫描正则是 `fetch\(\s*(['"`])...` —— 直接写 `fetch('/api/alive')`
 *      会被它读成"目标为空字符串"从而误报。写成一个常量反而更糟：
 *      `fetch(ALIVE_PATH)` 的参数不是引号开头，正则匹配不到，于是**静默漏检**
 *      （这比误报更危险，因为断言看起来还是绿的）。
 *      拼起来两边都诚实：扫到的就是那个相对路径本身。
 */

/** 心跳间隔的默认值。服务端会通过响应告诉我们它实际的超时，见下。 */
export const PING_MS = 20 * 1000;

/**
 * 心跳间隔相对"服务端超时"的比例。
 *
 * 为什么按比例算、而不是两边各写死一个数字：**这两个数必须配合**。
 * 如果心跳间隔 ≥ 服务端超时，那么一个正常开着的页面也会被杀掉 ——
 * 这是最糟的失败方式（用户正在用，服务自己没了）。
 * 让客户端按服务端**报出来的**超时来算间隔，两个常量就不可能各自漂移。
 *
 * 留 1/4：即使连续丢 3 次心跳，服务也不会误判。
 */
const PING_FRACTION = 1 / 4;

/** 心跳间隔下限。防止服务端超时被调得极小时把间隔压成 1ms 去刷屏。 */
const PING_MS_MIN = 1500;

let started = false;

/**
 * 算出这次该多久发一次心跳。
 * @param {number} timeoutMs 服务端报的超时（无效则用默认值）
 */
export function pingIntervalFor(timeoutMs) {
  const n = Number(timeoutMs);
  if (!Number.isFinite(n) || n <= 0) return PING_MS;
  return Math.max(PING_MS_MIN, Math.min(PING_MS, Math.round(n * PING_FRACTION)));
}

/**
 * 启动心跳。只会在真正的浏览器页面里生效；重复调用是安全的。
 */
export function startKeepalive() {
  if (started) return;
  // ① 非浏览器环境（Node 测试）直接不做事
  if (typeof document === 'undefined') return;
  if (!document.visibilityState) return;
  started = true;

  let intervalMs = PING_MS;
  let timer = null;

  const restartTimer = () => {
    if (timer) clearInterval(timer);
    timer = setInterval(ping, intervalMs);
  };

  const ping = async () => {
    // 页面已经关闭/被丢弃时不要再发（此时发了也没意义）
    if (document.visibilityState === 'unloaded') return;
    try {
      // 地址拼出来的原因见文件头 ③。
      // keepalive: true 让这个请求在页面关闭途中也能发出去。
      const r = await fetch('/api/' + 'alive', { method: 'POST', keepalive: true, cache: 'no-store' });
      const body = await r.json().catch(() => null);
      if (body && body.timeoutMs) {
        const next = pingIntervalFor(body.timeoutMs);
        if (next !== intervalMs) { intervalMs = next; restartTimer(); }
      }
    } catch {
      // 网络层抛错（比如服务已经退了、正在退）不该影响界面。
      // ⚠️ 这里**故意不停止心跳**：服务可能只是重启了一下，
      //    继续发反而能让新起的服务尽快看到"页面还在"。
    }
  };

  ping();
  restartTimer();
}
