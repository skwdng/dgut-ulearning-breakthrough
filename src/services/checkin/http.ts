/**
 * 极简 HTTP 客户端 —— 服务于优学院自动化。
 *
 * 要点（tech-spec §5.1）：
 * - 全链路 UA / Cookie 保持一致，Cookie 大小写敏感，绝不做归一化
 *   （DGUT 有 USER_INFO 与 USERINFO 两个同名不同大小写的字段，合并会掉登录态）；
 * - 手动管理 Set-Cookie，因为 RN 的 fetch 不带 Cookie Jar；
 * - 记录服务端时间，用于客户端时间校准（防 clientTime 校验失败）。
 */
import { encryptCasPassword } from './crypto/aes';

/** 取 URL 的 host（失败返回原串） */
function safeHost(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return u.slice(0, 40);
  }
}

export interface CookieJar {
  [name: string]: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** 重定向目标（不自动跟随，因为优学院登录链每一跳都要留证据） */
  location?: string;
  url: string;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  form?: Record<string, string>;
  json?: unknown;
  /**
   * 重定向策略。
   *
   * ⚠️ **只有 'follow' 与 'error' 两个值** —— 不要用 'manual'。
   *
   * 实测（真机，三种模式对同一 URL 的结果）：
   *   follow / manual / error 三者返回**完全相同**（status=200、无 location），
   *   说明这台设备上 RN 的 fetch **不支持 'manual'** ——
   *   它不会把 302 交给你，而是照样跟掉。所以"手动跟票"这条路不通。
   *
   * 因此跟票只能靠**重新请求各站点根路径**（见 followTicket）。
   */
  redirect?: 'follow' | 'error';
  timeoutMs?: number;
}

export class HttpClient {
  cookies: CookieJar;
  userAgent: string;
  private serverTimeOffsetMs = 0;
  /** 请求/响应留痕（脱敏后），供"签到日志"页展示 */
  readonly trace: Array<{ at: number; method: string; url: string; status: number; note?: string }> = [];

  constructor(opts: { cookies?: CookieJar; userAgent?: string } = {}) {
    this.cookies = { ...(opts.cookies ?? {}) };
    /**
     * ⚠️ 必须用**桌面版 UA**！
     *
     * 踩过的坑：原本用 Android 手机 UA，东莞理工的 CAS 会返回一个
     * 「移动端登录页」——那个页面里**没有 pwdEncryptSalt 字段**，
     * 而密码加密正是基于它。结果报"登录页结构异常，未找到 pwdEncryptSalt"。
     *
     * 实测（真机诊断确认）：移动 UA 返回 12.5KB 的移动版页面，
     * 桌面 UA 返回带 pwdEncryptSalt / execution 的桌面版页面。
     * 所以这里固定用桌面 UA，与 .recon 下验证过的脚本保持一致。
     */
    this.userAgent =
      opts.userAgent ??
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  }

  /** 服务端时间（含偏移校准） */
  now(): number {
    return Date.now() + this.serverTimeOffsetMs;
  }

  private cookieHeader(): string {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  /**
   * 解析 Set-Cookie。
   * 注意：不做 decodeURIComponent 以外的任何加工，保持原样。
   */
  private absorbSetCookie(setCookies: string[]): void {
    for (const raw of setCookies) {
      const first = raw.split(';')[0];
      const idx = first.indexOf('=');
      if (idx <= 0) continue;
      const name = first.slice(0, idx).trim();
      const value = first.slice(idx + 1);
      // 大小写敏感：同名不同大小写视为不同 Cookie
      this.cookies[name] = value;
    }
  }

  private parseSetCookie(headers: Headers): string[] {
    // RN 的 Headers 支持 getSetCookie，退化为 get('set-cookie') 单条
    const anyHeaders = headers as unknown as { getSetCookie?: () => string[] };
    if (typeof anyHeaders.getSetCookie === 'function') return anyHeaders.getSetCookie();
    const single = headers.get('set-cookie');
    return single ? [single] : [];
  }

  /**
   * 诊断：对指定 URL 发一次真实请求，把**响应头和正文特征**原样带出来。
   *
   * 为什么要它：登录链路反复出现"我这台机器能通、手机上不通"，
   * 而隔着屏幕只能猜。把真实请求的结果显示在界面上，
   * 就能直接看出是 UA、重定向还是服务端返回了别的页面。
   */
  async probe(
    url: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<{
    status: number;
    finalUrl: string;
    bytes: number;
    contentType: string;
    setCookies: string[];
    title: string;
    hasSalt: boolean;
    hasExecution: boolean;
    hasEncryptJs: boolean;
    salt?: string;
    execution?: string;
    head: string;
  }> {
    const finalHeaders: Record<string, string> = {
      'User-Agent': this.userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      ...extraHeaders,
    };
    const res = await fetch(url, { headers: finalHeaders, redirect: 'follow' });
    this.absorbSetCookie(this.parseSetCookie(res.headers));
    const body = await res.text();
    return {
      status: res.status,
      finalUrl: res.url || url,
      bytes: body.length,
      contentType: res.headers.get('content-type') ?? '',
      setCookies: this.parseSetCookie(res.headers).map((c) => c.split(';')[0]),
      title: (/<title>([^<]*)<\/title>/i.exec(body) ?? [])[1]?.trim() ?? '',
      hasSalt: body.includes('pwdEncryptSalt'),
      hasExecution: body.includes('execution'),
      hasEncryptJs: /src=["']?\.?\/?encrypt\.js/i.test(body),
      salt: HttpClient.extractHiddenInput(body, 'pwdEncryptSalt'),
      execution: HttpClient.extractHiddenInput(body, 'execution'),
      head: body.replace(/\s+/g, ' ').slice(0, 200),
    };
  }

  /**
   * 诊断：比较三种 redirect 模式下，**中间跳转的 Set-Cookie 能不能拿到**。
   *
   * 背景（这是登录失败的真凶）：
   *   CAS 换票链是 auth → application → lms 多次 302，
   *   `AUTHORIZATION` 只出现在**中间某一跳**的 Set-Cookie 里。
   *   用 `redirect:'follow'` 时 fetch 在内部把跳转跟完，
   *   JS 只能看到**最后一跳**的响应头 —— 中间的 Set-Cookie 全丢了，
   *   于是"登录成功但没有 token"。
   *
   *   验证过的脚本之所以能成功，是因为它**手动跟票**，每一跳都读 Set-Cookie。
   *
   * 所以要测清楚 RN 的 fetch 在 `'manual'` 下到底给什么：
   *   给 302 + Location → 可以手动跟票（最优）
   *   直接跟掉 / 报错   → 得换别的办法
   */
  async probeRedirectModes(url: string): Promise<string> {
    const lines: string[] = [];
    const modes: Array<'follow' | 'manual' | 'error'> = ['follow', 'manual', 'error'];

    for (const mode of modes) {
      const jar: string[] = [];
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': this.userAgent, Accept: 'text/html' },
          redirect: mode,
        });
        this.absorbSetCookie(this.parseSetCookie(res.headers));
        jar.push(...this.parseSetCookie(res.headers).map((c) => c.split(';')[0]));
        const loc = res.headers.get('location');
        const body = await res.text();
        lines.push(
          `${mode}: status=${res.status} ` +
            `location=${loc ?? '(无)'} ` +
            `setCookie=${jar.join(',') || '(无)'} ` +
            `字节=${body.length}`,
        );
      } catch (e) {
        lines.push(`${mode}: 异常(${(e as Error).message.slice(0, 60)})`);
      }
    }
    return lines.join('\n');
  }

  /**
   * 完整走一遍 CAS 登录 + 换票链，把**每一跳的结果**都记录下来。
   *
   * 为什么需要：登录失败长期无法定位，因为只看得到"最后没拿到 token"，
   * 看不到中间发生了什么。这个函数把每一跳的
   *   状态码 / Location / 收到的 Set-Cookie
   * 全部记下来，直接看出 token 是在哪一跳丢的。
   *
   * ⚠️ 只用一次，测试完由调用方丢弃（不要把密码留在内存里）。
   */
  async traceLogin(studentId: string, password: string, service: string): Promise<string> {
    const out: string[] = [];
    const loginUrl = `${this.baseAuthHost()}/authserver/login?service=${encodeURIComponent(service)}`;

    // ── 1) 取登录页 ──
    const page = await this.request(loginUrl);
    const salt = HttpClient.extractHiddenInput(page.body, 'pwdEncryptSalt');
    const execution = HttpClient.extractHiddenInput(page.body, 'execution');
    out.push(`① 登录页 status=${page.status} 字节=${page.body.length} salt=${salt ? '有' : '无'} exec=${execution ? '有' : '无'}`);
    out.push(`   登录页 cookie: ${Object.keys(this.cookies).join(',') || '(无)'}`);
    if (!salt || !execution) {
      out.push('   × 没有表单，终止');
      return out.join('\n');
    }

    // ── 2) 提交 ──
    // ⚠️ 这台设备上 fetch 不支持 'manual'（实测三种模式结果一致，302 会被跟掉）。
    //    所以这里改用 **POST 后看落点** 来判断：
    //      落在 lms / application 的业务页 → 登录成功
    //      落在 973 字节的「应用中心」   → CAS 没接受这次登录
    const formBody = {
      username: studentId,
      password: encryptCasPassword(password, salt),
      captcha: '',
      _eventId: 'submit',
      cllt: 'userNameLogin',
      dllt: 'generalLogin',
      lt: '',
      execution,
    };
    const post = await this.request(loginUrl, { method: 'POST', form: formBody });
    const postHost = safeHost(post.url);
    out.push(
      `② 提交 status=${post.status} 字节=${post.body.length} ` +
        `落点=${postHost} ctype=${post.headers['content-type'] ?? '(无)'}`,
    );
    out.push(`   提交后 cookie: ${Object.keys(this.cookies).join(',') || '(无)'}`);
    // ★ 关键：POST 响应的**全部响应头** —— 尤其是 Set-Cookie 与 Location。
    //   服务端怎么回应，全在这里，不用猜。
    const hdrKeys = Object.keys(post.headers).sort();
    out.push(`   响应头: ${hdrKeys.map((k) => `${k}=${post.headers[k].slice(0, 60)}`).join(' | ').slice(0, 400)}`);
    out.push(`   Location=${post.location ?? '(无)'}  正文长度=${post.body.length}`);
    // 正文很短时，把**全文**打出来（973 字节可以完整看）
    if (post.body.length <= 1200) {
      out.push(`   正文全文=${post.body.replace(/\s+/g, ' ').slice(0, 900)}`);
    }

    // 落在 auth 域名且页面里还有表单 → 密码被判错
    const backOnLoginPage =
      postHost.includes('auth.dgut.edu.cn') && post.body.includes('pwdEncryptSalt');
    if (backOnLoginPage) {
      const errMsg =
        (/id=["']showErrorTip["'][^>]*>([^<]{2,120})</i.exec(post.body) ?? [])[1] ??
        (/(用户名或密码错误|密码错误|账号或密码|验证码错误|账号被锁定|用户不存在)/.exec(post.body) ?? [])[1];
      out.push('   ⚠️ 提交后仍在登录页 → **CAS 没有接受这次登录**');
      out.push(`   CAS 错误提示=${errMsg ?? '(页面上没找到错误文案)'}`);
      out.push(`   首段=${post.body.replace(/\s+/g, ' ').slice(0, 200)}`);
    } else if (post.body.length < 1500) {
      out.push(`   落点不是登录页，且正文很短 → 可能是别的落地页`);
      out.push(`   首段=${post.body.replace(/\s+/g, ' ').slice(0, 200)}`);
    }

    // ── 3) 手动逐跳跟票，每跳都记录 ──
    const seen = new Set<string>();
    let cur = post.location;
    let hop = 0;
    const TOKEN_NAMES = ['AUTHORIZATION', 'token'];
    while (cur && hop < 8) {
      hop += 1;
      const norm = cur.startsWith('http') ? cur : new URL(cur, loginUrl).toString();
      if (seen.has(norm)) {
        out.push(`③ 第${hop}跳 ${norm.slice(0, 70)} → 已访问过，停止`);
        break;
      }
      seen.add(norm);

      const r = await this.request(norm);
      const gotToken = TOKEN_NAMES.some((t) => this.cookies[t]);
      out.push(
        `③ 第${hop}跳 status=${r.status} ${new URL(norm).host} ` +
          `location=${r.location ? new URL(r.location, norm).host : '(无)'} ` +
          `字节=${r.body.length} cookie数=${Object.keys(this.cookies).length}` +
          `${gotToken ? ' ★拿到token' : ''}`,
      );
      // 这一跳下发了什么 cookie —— token 是不是在这里出现的
      const sc = r.headers['set-cookie'];
      out.push(`   set-cookie=${sc ? sc.split(';')[0] : '(无)'}  落点=${safeHost(r.url)}`);
      if (gotToken) break;

      if (r.status >= 300 && r.status < 400 && r.location) {
        cur = new URL(r.location, norm).toString();
        continue;
      }
      break;
    }

    // ── 4) 兜底：直接访问应用中心与 lms 根路径 ──
    for (const h of ['application.dgut.edu.cn', 'lms.dgut.edu.cn']) {
      const has = TOKEN_NAMES.some((t) => this.cookies[t]);
      if (has) break;
      try {
        const r = await this.request(`https://${h}/`);
        out.push(
          `④ 访问 ${h} status=${r.status} cookie数=${Object.keys(this.cookies).length}` +
            ` set-cookie=${r.headers['set-cookie']?.split(';')[0] ?? '(无)'}`,
        );
      } catch (e) {
        out.push(`④ 访问 ${h} 异常(${(e as Error).message.slice(0, 40)})`);
      }
    }

    const token = this.cookies.AUTHORIZATION ?? this.cookies.token ?? '';
    const info = this.cookies.USER_INFO ?? this.cookies.USERINFO ?? '';
    out.push('');
    out.push(`★ 最终 token=${token ? `有(${token.length}位)` : '无'}`);
    out.push(`★ USER_INFO=${info ? '有' : '无'}`);
    out.push(`★ cookie 全量: ${Object.keys(this.cookies).join(',') || '(空)'}`);
    return out.join('\n');
  }

  /** 从当前 cookies 里没有 authHost，由调用方注入 */
  private authHostForTrace = '';
  setAuthHost(h: string): void {
    this.authHostForTrace = h;
  }
  private baseAuthHost(): string {
    return this.authHostForTrace;
  }

  async request(url: string, options: RequestOptions = {}): Promise<HttpResponse> {
    const { method = 'GET', headers = {}, form, json, redirect = 'follow', timeoutMs = 15000 } = options;

    const finalHeaders: Record<string, string> = {
      'User-Agent': this.userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      ...headers,
    };

    const cookie = this.cookieHeader();
    if (cookie) finalHeaders.Cookie = cookie;

    let body: string | undefined;
    if (form) {
      body = Object.entries(form)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
      finalHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (json !== undefined) {
      body = JSON.stringify(json);
      finalHeaders['Content-Type'] = 'application/json';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: finalHeaders,
        body,
        redirect,
        signal: controller.signal,
      });

      this.absorbSetCookie(this.parseSetCookie(res.headers));

      const dateHeader = res.headers.get('date');
      if (dateHeader) {
        const serverMs = Date.parse(dateHeader);
        if (!Number.isNaN(serverMs)) this.serverTimeOffsetMs = serverMs - Date.now();
      }

      const text = await res.text();
      const responseHeaders: Record<string, string> = {};
      res.headers.forEach?.((v: string, k: string) => {
        responseHeaders[k.toLowerCase()] = v;
      });

      const out: HttpResponse = {
        status: res.status,
        headers: responseHeaders,
        body: text,
        location: res.headers.get('location') ?? undefined,
        url: res.url || url,
      };
      this.trace.push({
        at: Date.now(),
        method,
        url: sanitizeUrl(url),
        status: res.status,
      });
      if (this.trace.length > 200) this.trace.shift();
      return out;
    } finally {
      clearTimeout(timer);
    }
  }

  get(url: string, options: Omit<RequestOptions, 'method'> = {}) {
    return this.request(url, { ...options, method: 'GET' });
  }

  post(url: string, options: Omit<RequestOptions, 'method'> = {}) {
    return this.request(url, { ...options, method: 'POST' });
  }

  /** 从 HTML 里抠隐藏域（CAS 登录页的 pwdEncryptSalt / execution） */
  static extractHiddenInput(html: string, id: string): string | undefined {
    const re = new RegExp(`id=["']${id}["'][^>]*value=["']([^"']*)["']`, 'i');
    const re2 = new RegExp(`value=["']([^"']*)["'][^>]*id=["']${id}["']`, 'i');
    return re.exec(html)?.[1] ?? re2.exec(html)?.[1];
  }
}

/** URL 脱敏：日志里不带 query，避免泄漏 token */
export function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split('?')[0];
  }
}
