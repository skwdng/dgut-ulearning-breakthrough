/**
 * WebCookie 原生模块的 JS 封装。
 *
 * 为什么需要自己写原生模块：
 *   1. 注入 JS 读 `document.cookie` → `AUTHORIZATION` / `USER_INFO` 是
 *      HttpOnly，读不到。
 *   2. `@react-native-cookies/cookies` → 鸿蒙上 `getAll` 报
 *      "Get all cookies not supported"。
 *   3. 只能直接调 `android.webkit.CookieManager`（WebView 自己的存储），
 *      并在读之前 `flush()` 强制落盘 —— 不 flush 常常读到空。
 *
 * 非 Android 平台（iOS）返回 null，调用方走降级路径。
 */
import { NativeModules, Platform } from 'react-native';
interface WebCookieNative {
  getCookie(url: string, flush: boolean): Promise<Record<string, string>>;
  flush(): Promise<boolean>;
  clearAll(): Promise<boolean>;
  /**
   * 把一个 `k=v; path=/` 形式的 cookie 写进原生 CookieManager。
   *
   * 用途：WebView 与 CookieManager 的存储不同步（Android 已知问题），
   * 于是从 WebView 页面里用 JS 读 `document.cookie`，再用这个写回来。
   */
  setCookie(url: string, cookieLine: string): Promise<boolean>;
  /**
   * 原生层完整登录：取表单 → 加密 → 提交 → 逐跳跟票。
   *
   * ⚠️ 传的是**明文密码**，加密在原生做 ——
   *    因为 salt 也要原生去取（JS 的 fetch 可能把 CAS 的 302 跟掉，
   *    导致取不到登录表单）。密码不经过 JS，也不写日志。
   */
  login(
    loginUrl: string,
    studentId: string,
    password: string,
    maxHops: number,
  ): Promise<{
    steps: string[];
    finalStatus: number;
    finalUrl: string;
    finalBodyHead: string;
    cookies: Record<string, string>;
  }>;
}

function mod(): WebCookieNative | null {
  if (Platform.OS !== 'android') return null;
  const m = (NativeModules as Record<string, unknown>).WebCookie as WebCookieNative | undefined;
  return m ?? null;
}

export function isWebCookieAvailable(): boolean {
  return mod() !== null;
}

/**
 * 诊断：把原生模块的可用性和实际返回**原样**带出来。
 *
 * 为什么要这个：反复出现"读到 0 个"，但看不出是
 *   ① 原生模块没被调用（NativeModules 里没有 WebCookie）
 *   ② 模块调了但 `getCookie` 返回空
 *   ③ 模块报错了
 * 所以这里把每种情况都显式区分出来。
 */
export async function diagnoseCookieRead(hosts: string[]): Promise<string> {
  const m = mod();
  if (!m) {
    const all = Object.keys(NativeModules as Record<string, unknown>).filter((k) =>
      /cookie/i.test(k),
    );
    return `原生模块未找到（NativeModules 里含 cookie 的键：${all.join(',') || '无'}）`;
  }

  const parts: string[] = [];
  try {
    await m.flush();
    parts.push('flush=成功');
  } catch (e) {
    parts.push(`flush=失败(${(e as Error).message.slice(0, 30)})`);
  }

  for (const h of hosts) {
    const short = h.split('.')[0];
    try {
      const r = await m.getCookie(`https://${h}/`, true);
      const keys = Object.keys(r ?? {});
      const sample = keys.slice(0, 4).join(',');
      parts.push(`${short}=${keys.length}${sample ? `[${sample}]` : ''}`);
    } catch (e) {
      parts.push(`${short}=异常(${(e as Error).message.slice(0, 30)})`);
    }
  }
  return parts.join(' ');
}

/** 强制把内存中的 WebView cookie 写进存储 */
export async function flushCookies(): Promise<void> {
  try {
    await mod()?.flush();
  } catch {
    /* 失败不致命 */
  }
}

/** 读某个 URL 的 cookie；读不到返回 {} */
export async function getCookiesForUrl(url: string, flush = true): Promise<Record<string, string>> {
  const m = mod();
  if (!m) return {};
  try {
    return (await m.getCookie(url, flush)) ?? {};
  } catch {
    return {};
  }
}

/** 清空所有 WebView cookie（换账号时必须清，否则 CAS 会直接跳过登录） */
export async function clearCookies(): Promise<void> {
  try {
    await mod()?.clearAll();
  } catch {
    /* 失败不致命 */
  }
}

/**
 * 用**原生层**走一遍 CAS 登录并逐跳跟票。
 *
 * ══════════ 为什么不能在 JS 里做 ══════════
 * RN 的 fetch 真机实测有两个致命限制：
 *   1. `redirect:'follow'` → 内部把 302 跟完，**中间每一跳的 Set-Cookie 全丢**；
 *      而 `CASTGC` / `AUTHORIZATION` 正是在中途下发的 → "登录成功但没 token"。
 *   2. `redirect:'manual'` → **这台设备不支持**（三种模式结果完全一致）。
 *
 * 所以改用原生 `HttpURLConnection` + `setInstanceFollowRedirects(false)`，
 * 每一跳自己发、自己读 Set-Cookie、自己决定下一跳。
 */
/**
 * 用**原生层**完整走一遍 CAS 登录（含逐跳跟票）。
 *
 * ══════════ 为什么全部在原生做 ══════════
 * RN 的 fetch 真机实测有两个致命限制：
 *   1. `redirect:'follow'` → 内部把 302 跟完，**中间每一跳的 Set-Cookie 全丢**；
 *      而 `CASTGC` / `AUTHORIZATION` 正是在第 3 跳下发的 → "登录成功但没 token"。
 *   2. `redirect:'manual'` → **这台设备不支持**（三种模式结果完全一致）。
 *
 * 另外"取登录页"也必须原生做：JS 的 probe 用 `follow`，
 * 只要 CAS 回 302 就会跟掉，只能看到 973 字节的应用中心页。
 *
 * 密码以明文传入、在原生加密 —— 不经过 JS 的处理逻辑，也不写日志。
 */
export async function nativeLogin(
  loginUrl: string,
  studentId: string,
  password: string,
  maxHops = 8,
): Promise<{
  steps: string[];
  finalStatus: number;
  finalUrl: string;
  finalBodyHead: string;
  cookies: Record<string, string>;
} | null> {
  const m = mod();
  if (!m) return null;

  /**
   * ══════════ 登录前必须清空 cookie（踩过的坑）══════════
   *
   * 用户反馈：「换别人的账号登录，查的还是我的数据」。
   *
   * 崩溃日志暴露了真相：用 114 的学号登录，存下来的却是
   *     userId=90990001（116，也就是用户自己）
   * 因为 **cookie 罐子里还留着上一个账号的 USER_INFO**，
   * 而 userId 正是从 USER_INFO 里解析出来的 ——
   * 于是"用 A 的学号登录"实际上拿到的还是 B 的会话。
   *
   * 更糟的是：罐子里有有效会话时，CAS 会直接跳票，
   * 登录页都不会出现，压根不会去校验新填的账号密码。
   *
   * 所以每次登录前先清干净，保证拿到的会话确实属于本次登录的账号。
   */
  await clearCookies();

  // 超时保护：原生线程万一卡住，不能让界面一直转
  return Promise.race([
    m.login(loginUrl, studentId, password, maxHops),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('原生登录超时（40 秒）')), 40000),
    ),
  ]);
}

/** 遍历多个域名合并 cookie */
export async function getCookiesForHosts(hosts: string[]): Promise<{
  cookies: Record<string, string>;
  detail: string;
}> {
  const m = mod();
  if (!m) return { cookies: {}, detail: '原生模块不可用（非 Android）' };

  await flushCookies();

  const merged: Record<string, string> = {};
  const parts: string[] = [];
  for (const h of hosts) {
    try {
      const r = await getCookiesForUrl(`https://${h}/`, true);
      const names = Object.keys(r);
      for (const n of names) if (r[n]) merged[n] = r[n];
      parts.push(`${h.split('.')[0]}=${names.length}`);
    } catch {
      parts.push(`${h.split('.')[0]}=错误`);
    }
  }
  return { cookies: merged, detail: parts.join(' ') };
}

/**
 * 把一个 cookie 串写进原生 CookieManager（供多个域名使用）。
 *
 * ══════════ 为什么需要 ══════════
 * WebView 里明明已登录，但原生 `CookieManager.getCookie()` 读到 0 个 ——
 * WebView 的 cookie 存储与 CookieManager 不同步（Android 已知问题）。
 *
 * 于是改成：在 WebView 页面里用 JS 读 `document.cookie`，
 * 带回 RN 后用这个函数写进 CookieManager，
 * 之后 `getCookie` / `readSessionCookies` 就正常了。
 */
export async function setCookieInManager(
  cookies: Record<string, string>,
): Promise<{ ok: boolean; written: number; rejected: number }> {
  const m = mod();
  if (!m) return { ok: false, written: 0, rejected: 0 };

  /**
   * ⚠️ 逐条写时**只写 url 形式的域名**，不带 `domain=` 属性。
   *
   * 原因：`CookieManager.setCookie` 对 `domain=` 很挑剔 ——
   * 如果 domain 与 url 的 host 不一致（哪怕是父域），**可能直接被拒**。
   * 而我们拿到的 cookie 本来就是从这些站点读出来的，
   * 所以直接按 host 写最稳。
   *
   * 三个域名都写一遍：cookie 到底属于哪个站点，从 document.cookie 看不出来，
   * 全写一遍可以让后续任意域名的请求都带上它。
   */
  const hosts = ['application.dgut.edu.cn', 'lms.dgut.edu.cn', 'auth.dgut.edu.cn'];
  let written = 0;
  let rejected = 0;
  const pairs = Object.entries(cookies).filter(([k, v]) => k && v);

  for (const h of hosts) {
    for (const [k, v] of pairs) {
      try {
        const acc = await m.setCookie(`https://${h}/`, `${k}=${v}; path=/`);
        if (acc) written += 1;
        else rejected += 1;
      } catch {
        rejected += 1;
      }
    }
  }
  try {
    await m.flush();
  } catch {
    /* 忽略 */
  }
  return { ok: written > 0, written, rejected };
}

/**
 * 带重试地读会话凭据。
 *
 * ⚠️ 为什么要重试：WebView 的 cookie 是**异步落盘**的。
 *    刚跳转完立刻读经常是空 —— 实测用户就遇到"读到 0 个"。
 *    每轮之间等一下再 flush 重读，通常第 2~3 轮就有了。
 */
export async function readSessionCookies(
  hosts: string[],
  looksReady: (cookies: Record<string, string>) => boolean,
  rounds = 4,
  gapMs = 700,
): Promise<{ cookies: Record<string, string>; detail: string }> {
  let last: { cookies: Record<string, string>; detail: string } = { cookies: {}, detail: '' };
  for (let i = 0; i < rounds; i += 1) {
    last = await getCookiesForHosts(hosts);
    if (looksReady(last.cookies)) return last;
    if (i < rounds - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
  return last;
}
