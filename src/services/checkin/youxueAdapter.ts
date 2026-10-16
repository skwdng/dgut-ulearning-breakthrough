/**
 * 优学院 DGUT 适配器 —— 真实实现。
 *
 * 全部端点与参数来自实测（见 youxue-api-verified.md 与 checkin-todo.md）：
 * - BasePath `/apps`
 * - 头 `AUTHORIZATION`（全大写）+ `X-Requested-With: cn.ulearning.yxy`
 * - `userID` 必须传**数字** userId（传学号字符串会 400 code 1201）
 * - `getAttendanceForStu` 里的 userName/userID 是**教师**信息
 *
 * 仍需一次真实签到才能确认的：
 * - 进行中签名时 `attendanceCode` / `location` 是否被强制校验
 * - 提交成功的响应是否带业务字段（实测已结束的签到返回 200 空体）
 */
import type {
  BindResult,
  CheckinAdapter,
  DetectResult,
  PasswordLoginInput,
  SessionImportInput,
  SubmitPayload,
  SubmitResult,
} from './types';
import type {
  Course,
  PollPlan,
  RollcallTask,
  SessionState,
  SignType,
  TenantCode,
  YouxueAccount,
} from '../../domain/types';
import { DEFAULT_POLL_PLAN } from '../../domain/types';
import { getTenant, type TenantConfig } from '../../config/tenants';
import { HttpClient } from './http';
import { encryptCasPassword, selfTest as aesSelfTest } from './crypto/aes';
import { logFault } from '../crashLog';
import { makeError, mapServerError } from './errors';
import { YouxueSignApi, ENDPOINTS, methodFromType, stateFromStatus, isSignedState } from './signApi';
import { store, STORE_KEYS } from '../storage';

/** 已废弃的猜测端点（保留仅为历史对照，勿使用） */
export const DEPRECATED_ENDPOINTS = {
  pendingActivities: '/api/activity/pending',
  rollcallDetail: '/api/rollcall/{id}',
  submit: '/api/rollcall/{id}/sign',
  myCourses: '/api/course/my',
  history: '/api/rollcall/history',
} as const;

/** 智慧课堂（独立鉴权，学生无账号，本适配器不使用） */
export const SMART_CLASSROOM_HOST = 'https://zhlb.dgut.edu.cn';

interface StoredCredential {
  mode: 'session' | 'password';
  cookies?: Record<string, string>;
  userAgent?: string;
  studentId: string;
  /** 实测：提交签到需要数字 userId */
  userId?: number;
}

export class YouxueCheckinAdapter implements CheckinAdapter {
  readonly id = 'youxue';
  tenant: TenantCode;
  private cfg: TenantConfig;
  private http: HttpClient;
  /**
   * 已建立的签到 API 客户端（绑定后可用）。
   *
   * ⚠️ 它带着某个账号的 token + userId，所以**必须记住它属于谁**。
   *    本类是模块级单例（getAdapter() 复用同一实例），
   *    不记住归属就会出现"换账号后还在查上一个人的数据"（踩过）。
   */
  private signApi: YouxueSignApi | null = null;
  /**
   * signApi 属于哪个账号（account.id，形如 dgut-2099000000116）。
   *
   * ⚠️ 光有 account.id **不够**：同一个人重新登录时 id 不变，
   *    于是旧客户端被复用 → 还在用那次已经失效的 token。
   */
  private signApiAccountId: string | null = null;
  /**
   * ★ 那次登录的时间戳（account.boundAt）。
   *
   * 踩过的坑：用户反馈「发给他最新版，查询还是 401 无效的 token，
   * 让他在登录口重新登一次也一样」。
   *
   * 根因：`ensureSignApi` 原先只比 `signApiAccountId === account.id`。
   *      他**用同一个学号**重新登录 → id 没变 → 判定"可以复用" →
   *      继续用第一次绑定时的旧 token。所以**重新登录完全没生效**。
   *
   * 现在把 boundAt 也纳入判断：重新登录会刷新 boundAt → 缓存作废 → 用新 token。
   */
  private signApiBoundAt: number | null = null;

  constructor(tenant: TenantCode, http?: HttpClient) {
    this.tenant = tenant;
    this.cfg = getTenant(tenant);
    this.http = http ?? new HttpClient();
  }

  private credRef(accountId: string) {
    return `${this.tenant}.${accountId}`;
  }

  // ---------------- 认证 ----------------

  async loginWithPassword(input: PasswordLoginInput): Promise<BindResult> {
    if (!aesSelfTest()) {
      return {
        ok: false,
        error: makeError('E_SIGNATURE', '本地密码加密实现自检失败，已禁用账号密码登录，请改用会话导入'),
      };
    }
    const { authHost, appHost, casServicePath } = this.cfg;
    const service = `${appHost ?? this.cfg.lmsHost}${casServicePath}`;
    const loginUrl = `${authHost}/authserver/login?service=${encodeURIComponent(service)}`;

    try {
      // ── 步骤 1：找一个能返回「CAS 登录表单」的地址 ──
      //
      // 为什么要试多个地址：
      //   实测同一台服务器，从不同网络/客户端访问会得到**不同结果** ——
      //   诊断机上 GET 带 service 的登录页 → 200 + JSESSIONID + 完整表单；
      //   而手机上是 200 + 0 cookie + 973 字节的「应用中心」页。
      //   不确定是哪一环（DNS / 运营商 / CDN 调度）导致的，所以用**兜底列表**。
      //
      // 每个候选的成败都会记进诊断，方便定位到底哪个地址在设备上可用。
      const candidates: Array<{ label: string; url: string }> = [
        { label: 'A 带 service 参数', url: loginUrl },
        { label: 'B 不带 service 参数', url: `${authHost}/authserver/login` },
        { label: 'C 应用中心 CAS 回调', url: service },
        { label: 'D lms 首页（可能触发 CAS）', url: `${this.cfg.lmsHost}/` },
      ];

      const tried: string[] = [];
      let page = { body: '', status: 0, url: '' } as { body: string; status: number; url: string };
      let salt: string | undefined;
      let execution: string | undefined;
      let pickedUrl = '';

      for (const c of candidates) {
        let res;
        try {
          res = await this.http.get(c.url);
        } catch (e) {
          tried.push(`${c.label} → 请求异常(${(e as Error).message})`);
          continue;
        }
        const s = HttpClient.extractHiddenInput(res.body, 'pwdEncryptSalt');
        const x = HttpClient.extractHiddenInput(res.body, 'execution');
        const title = (/<title>([^<]*)<\/title>/i.exec(res.body) ?? [])[1] ?? '';
        // 把正文开头也带上：只看"字节数"没法判断这是登录页、错误页还是 SPA 外壳。
        const head = (res.body ?? '').replace(/\s+/g, ' ').slice(0, 260);
        // 顺便记录页面里出现的 input 名字，判断表单长什么样
        const inputNames = [...(res.body ?? '').matchAll(/<input[^>]*name=["']([^"']+)["']/gi)]
          .map((mm) => mm[1])
          .slice(0, 10)
          .join(',');
        tried.push(
          `${c.label} → status=${res.status} 字节=${res.body.length} cookie=${Object.keys(this.http.cookies).length} ` +
            `表单=${s && x ? '有' : '无'} title=${title || '(无)'} ` +
            `input=${inputNames || '(无)'} 首段=${head || '(空)'}`,
        );
        if (s && x) {
          salt = s;
          execution = x;
          page = { body: res.body, status: res.status, url: res.url || c.url };
          pickedUrl = c.url;
          break;
        }
      }

      // 都没拿到表单 → 但只要已经有 token，仍可按会话导入处理
      if (!salt || !execution) {
        const tok = this.http.cookies.AUTHORIZATION ?? this.http.cookies.token ?? '';
        if (tok) {
          logFault(`[绑定] 无登录表单但已有 token，按会话导入。尝试记录: ${tried.join(' | ')}`, 'adapter.loginWithPassword');
          return this.persistSession(input.studentId, 'password', undefined, undefined, input.studentName);
        }

        const detail = tried.join(' ｜ ');
        logFault(`[绑定] 所有登录地址都没返回表单。${detail}`, 'adapter.loginWithPassword');
        return {
          ok: false,
          error: makeError('E_UNKNOWN', `没拿到 CAS 登录表单。各地址实测结果：${detail}`),
        };
      }

      logFault(`[绑定] 用「${pickedUrl}」拿到登录表单，开始提交`, 'adapter.loginWithPassword');
      void page;

      let encrypted: string;
      try {
        encrypted = encryptCasPassword(input.password, salt);
      } catch (e) {
        return { ok: false, error: makeError('E_SIGNATURE', (e as Error).message) };
      }

      // ── 步骤 2：提交登录 ──
      // ⚠️ form 必须是字符串（对象会让 Content-Length 算成 0，表现为"密码错误"）
      // 提交地址用**刚才真正捡到表单的那个**（pickedUrl），而不是写死的 loginUrl ——
      // 如果候选 A 不可用、是候选 B 拿到了表单，就必须往 B 提交，否则 execution 对不上。
      const res = await this.http.post(pickedUrl || loginUrl, {
        form: {
          username: input.studentId,
          password: encrypted,
          captcha: '',
          _eventId: 'submit',
          cllt: 'userNameLogin',
          dllt: 'generalLogin',
          lt: '',
          execution,
        },
      });

      const text = res.body ?? '';

      // 二次验证页面
      if (/多因子|reAuthType|isMultifactor/.test(text)) {
        const continuation = encodeURIComponent(JSON.stringify({ studentId: input.studentId, service }));
        return { ok: false, needMfa: { kind: 'need_mfa', continuation, hint: '学校要求短信验证，请输入验证码' } };
      }

      // 密码错 / 验证码错等：CAS 会**重新渲染登录页**并带错误提示（HTTP 仍是 200！）
      if (errMsgOf(text) || /pwdEncryptSalt/.test(text)) {
        const msg = errMsgOf(text);
        if (msg) {
          logFault(`[绑定] CAS 返回错误提示: ${msg}`, 'adapter.loginWithPassword');
          return { ok: false, error: makeError('E_SESSION_EXPIRED', `学校返回：${msg}`) };
        }
      }

      if (res.status >= 400) {
        return { ok: false, error: mapServerError(text.slice(0, 300)) };
      }

      // ── 步骤 3：跟票（拿 AUTHORIZATION）──
      // follow 之后可能已经拿到 token；没有的话再主动访问应用侧，
      // 让 CAS 把剩余的 cookie（含 USER_INFO，里面有数字 userId）下发完。
      if (!(this.http.cookies.AUTHORIZATION ?? this.http.cookies.token)) {
        await this.followTicket(loginUrl);
        await this.http.get(`${this.cfg.appHost ?? this.cfg.lmsHost}/`);
      }

      return this.persistSession(input.studentId, 'password', undefined, undefined, input.studentName);
    } catch (e) {
      return { ok: false, error: makeError('E_NETWORK', (e as Error).message) };
    }
  }

  async submitMfa(continuation: string, code: string): Promise<BindResult> {
    const { authHost } = this.cfg;
    try {
      const payload = JSON.parse(decodeURIComponent(continuation)) as { studentId: string; service: string };
      await this.http.post(`${authHost}/authserver/reAuthCheck/reAuthSubmit.do`, {
        form: {
          service: payload.service,
          reAuthType: '3',
          isMultifactor: 'true',
          password: '',
          dynamicCode: code,
          uuid: '',
          answer1: '',
          answer2: '',
          otpCode: '',
          skipTmpReAuth: 'true',
        },
      });
      const loginUrl = `${authHost}/authserver/login?service=${encodeURIComponent(payload.service)}`;
      const page = await this.http.get(loginUrl);
      await this.followTicket(loginUrl);
      void page;
      return this.persistSession(payload.studentId);
    } catch (e) {
      return { ok: false, error: makeError('E_MFA_REQUIRED', (e as Error).message) };
    }
  }

  async importSession(input: SessionImportInput): Promise<BindResult> {
    // 导入新会话前先丢弃旧的 —— 防止旧账号的 signApi 残留（踩过）
    this.signApi = null;
    this.signApiAccountId = null;
    this.signApiBoundAt = null;

    // Cookie 原样保存，不做大小写归一化（USER_INFO 与 USERINFO 必须并存）
    this.http = new HttpClient({ cookies: input.cookies, userAgent: input.userAgent });
    const state = await this.probeWith(input.cookies, input.userAgent);
    if (state !== 'valid') {
      return { ok: false, error: makeError('E_SESSION_EXPIRED', '导入的会话无效或已过期') };
    }
    return this.persistSession(input.studentId, 'session', input.cookies, input.userAgent, input.studentName);
  }

  async probeSession(account: YouxueAccount): Promise<SessionState> {
    const cred = await store.get<StoredCredential | null>(`${STORE_KEYS.account}.cred.${account.id}`, null);
    if (!cred) return 'unknown';
    if (account.lastProbeAt && Date.now() - account.lastProbeAt < 5 * 60_000 && account.lastProbeOk) {
      return account.sessionState;
    }
    return this.probeWith(cred.cookies, cred.userAgent, cred.userId);
  }

  /**
   * 探活：用实测确认可用的 `getUserByUserID`。
   * 返回 200 且带 userID 即认为会话有效。
   */
  private async probeWith(
    cookies?: Record<string, string>,
    ua?: string,
    userId?: number,
  ): Promise<SessionState> {
    try {
      const http = new HttpClient({ cookies, userAgent: ua });
      const uid = userId ?? 0;
      const path = uid > 0 ? ENDPOINTS.userInfo(uid) : '/courseweb/ulearning/index.html';
      const res = await http.get(`${this.cfg.lmsHost}${path}`, {
        headers: {
          AUTHORIZATION: http.cookies.AUTHORIZATION ?? '',
          'X-Requested-With': 'cn.ulearning.yxy',
        },
      });
      if (res.status === 401 || res.status === 403) return 'expired';
      if (res.status === 200) {
        // 若返回了登录页 HTML，说明会话失效
        if (/authserver\/login|请登录/.test(res.body)) return 'expired';
        return 'valid';
      }
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async unbind(accountId: string): Promise<void> {
    await store.remove(`${STORE_KEYS.account}.cred.${accountId}`);
    // 丢弃会话客户端 —— 否则解绑后重新查还会用到上一个人的 token（踩过）
    this.signApi = null;
    this.signApiAccountId = null;
    this.signApiBoundAt = null;
  }

  private async persistSession(
    studentId: string,
    mode: 'session' | 'password' = 'session',
    cookies?: Record<string, string>,
    userAgent?: string,
    studentName?: string,
  ): Promise<BindResult> {
    const cookiesFinal = cookies ?? this.http.cookies;
    const uaFinal = userAgent ?? this.http.userAgent;
    const token = cookiesFinal.AUTHORIZATION ?? cookiesFinal.token ?? '';

    // ⚠️ 没有 token 就说明 CAS 换票链没走完 —— 这种"绑定成功但没会话"的状态
    // 最坑：账号显示已连接，但任何接口都调不通。这里直接失败，把现场记下来。
    if (!token) {
      const cookieNames = Object.keys(cookiesFinal);
      logFault(
        `[绑定] 登录后没拿到 token（换票链未完成）cookie数=${cookieNames.length} ` +
          `cookie名称=${cookieNames.join(',') || '(空)'}`,
        'adapter.persistSession',
      );
      return {
        ok: false,
        error: makeError(
          'E_SESSION_EXPIRED',
          `登录没有拿到会话 token（换票链未走完）。` +
            `诊断：收到 ${cookieNames.length} 个 cookie` +
            `${cookieNames.length ? `（${cookieNames.slice(0, 8).join(', ')}）` : '（一个都没有）'}。` +
            `请重试；若反复失败请把这条发给开发者。`,
        ),
      };
    }

    // 用 getUserByUserID 换出数字 userId（提交签到时必需）
    // 注意：token 本身就是 32 位；而 userId 需要另一次调用才能拿到。
    // 这里先尝试从 USER_INFO cookie 里解析 userId。
    let userId = parseUserIdFromCookie(cookiesFinal);

    /**
     * ══════════ 身份一致性校验（踩过的坑）══════════
     *
     * 用户反馈：「换别人的账号登录，查的还是我的数据」。
     * 崩溃日志显示：用 114 的学号登录，存下来的 userId 却是 90990001（他自己的）。
     * 原因是 cookie 罐子里残留着上一个账号的 USER_INFO。
     *
     * 清 cookie 是最根本的修法（见 webCookie.nativeLogin），
     * 但这里再校验一次**双保险**：万一 userId 明显不属于本次登录的学号，
     * 宁可让绑定失败并说明原因，也绝不能把"别人的会话"当成本次账号存下来 ——
     * 那会导致后续所有查询都返回上一个人的数据，而界面上完全看不出来。
     */
    if (userId !== undefined) {
      const studentIdInCookie = parseStudentIdFromCookies(cookiesFinal);
      /**
       * ⚠️ 必须用**归一化后**的学号比较。
       *
       * 实测：cookie 里是 `dgut2099000000114`，用户输入的是 `2099000000114`，
       * 同一个账号但字符串不等 —— 不归一化就会把合法会话拒掉，
       * 界面报"拿到的会话属于另一个学号"（看起来像串号，其实是同一个人的两种写法）。
       */
      const reqNorm = normalizeStudentIdForCompare(studentId);
      if (studentIdInCookie && studentIdInCookie !== reqNorm) {
        logFault(
          `[绑定] ★ 会话与学号不符：请求登录 ${studentId}（归一化 ${reqNorm}），` +
            `但 cookie 里是 ${studentIdInCookie}（userId=${userId}）—— 拒绝保存`,
          'adapter.persistSession',
        );
        return {
          ok: false,
          error: makeError(
            'E_SESSION_EXPIRED',
            `拿到的会话属于另一个学号（${studentIdInCookie}），不是你要登录的 ${studentId}。` +
              `这通常是换了账号但旧登录状态没清干净。请重试一次；若还不行请反馈这条。`,
          ),
        };
      }
    }

    /**
     * ══════════ ★ 用 token 真的验证一次（这一条以前漏了）══════════
     *
     * 用户反馈：「有时候必须重新登录才能用任务和签到」，
     * 查询时报 `HTTP=401 {"code":2101,"message":"无效的token"}`。
     *
     * 根因：绑定时的"探活"走错了接口。
     *   `probeWith()` 在 importSession 路径下拿到的是 uid=0，
     *   于是去请求 **静态页** `/courseweb/ulearning/index.html` ——
     *   那张页面**只看 cookie，不看 AUTHORIZATION 头**，必然返回 200。
     *   结果：一个 **无效的 token 也能"绑定成功"**，
     *        等到真正调 `/apps/*` 接口时才 401，而且是在用户毫不知情的情况下。
     *
     * 现在绑定前必须用 `getUserByUserID` 验一次 ——
     * 这个接口**必须带 AUTHORIZATION**，token 无效就返回 401。
     */
    if (userId !== undefined) {
      const probeHttp = new HttpClient({ cookies: cookiesFinal, userAgent: uaFinal });
      let tokenOk = false;
      let probeStatus = 0;
      let probeBody = '';
      try {
        const pr = await probeHttp.get(`${this.cfg.lmsHost}${ENDPOINTS.userInfo(userId)}`, {
          headers: {
            AUTHORIZATION: token,
            'X-Requested-With': 'cn.ulearning.yxy',
          },
        });
        probeStatus = pr.status;
        probeBody = (pr.body ?? '').replace(/\s+/g, ' ').slice(0, 120);
        // 200 且不是登录页 → token 真的有效
        tokenOk = pr.status === 200 && !/authserver\/login|请登录/.test(pr.body ?? '');
      } catch (e) {
        logFault(`[绑定] token 校验请求异常：${(e as Error).message}`, 'adapter.persistSession');
      }

      if (!tokenOk) {
        logFault(
          `[绑定] ★ token 校验未通过：studentId=${studentId} userId=${userId} ` +
            `HTTP=${probeStatus} 返回=${probeBody || '(空)'} cookie数=${Object.keys(cookiesFinal).length}`,
          'adapter.persistSession',
        );
        return {
          ok: false,
          error: makeError(
            'E_SESSION_EXPIRED',
            `这次拿到的会话 token 无效（服务端 HTTP ${probeStatus}）` +
              `${probeBody.includes('无效') ? '，服务端说：无效的 token' : ''}。\n` +
              `绑定已取消，免得你之后查询时突然报错。\n` +
              `请退出账号后重新登录一次（网页登录方式最稳）。`,
          ),
        };
      }
    }

    const account: YouxueAccount = {
      id: `${this.tenant}-${studentId}`,
      tenant: this.tenant,
      studentId,
      studentName: studentName?.trim() || undefined,
      school: this.cfg.schoolName,
      // 数字 userId —— 「只能改自己的签到」要靠它比对（见 types.ts 的注释）
      userId: userId ?? undefined,
      sessionState: 'valid',
      authMode: mode,
      boundAt: Date.now(),
      lastProbeAt: Date.now(),
      lastProbeOk: true,
      capabilities: { mockLocation: false, backgroundKeepAlive: false, notification: false, camera: true },
    };

    // ⚠️ 无论 token/userId 是否齐全，都要清掉上一个账号的 signApi，
    //    否则本次会话不完整时，后续查询会静默复用旧账号的 API（踩过）。
    this.signApi = null;
    this.signApiAccountId = null;
    this.signApiBoundAt = null;

    if (token && userId) {
      this.signApi = new YouxueSignApi({ token, userId, cookies: cookiesFinal, userAgent: uaFinal });
      this.signApiAccountId = account.id;
      this.signApiBoundAt = account.boundAt ?? null;
    }

    const cred: StoredCredential = { mode, studentId, cookies: cookiesFinal, userAgent: uaFinal, userId };
    // ⚠️ 用 setVerified：写入后读回校验。
    // 之前是静默写入，一旦落盘失败，用户会看到"明明绑定了却说没绑定"，
    // 且错误发生在很久之后，完全对不上因果。现在当场发现、当场报。
    const credKey = `${STORE_KEYS.account}.cred.${account.id}`;
    const saved = await store.setVerified(credKey, cred);
    logFault(
      `[绑定] 写凭据 key=${credKey} userId=${userId ?? '(空)'} token=${token ? '有' : '无'} ` +
        `cookie数=${Object.keys(cookiesFinal).length} 结果=${saved.ok ? '成功' : '失败:' + saved.error}`,
      'adapter.persistSession',
    );
    if (!saved.ok) {
      return {
        ok: false,
        error: makeError(
          'E_UNKNOWN',
          `登录成功，但凭据保存失败：${saved.error ?? '未知原因'}。请重试；若反复失败请反馈这一条。`,
        ),
      };
    }
    return { ok: true, account };
  }

  /**
   * 跟随 CAS 换票链。
   *
   * ⚠️ 不能用 `redirect:'manual'` —— RN 的 fetch 在真机上会把它当 follow 处理，
   * 你既拿不到 302 也拿不到 Location，只能拿到落地页。
   * 这里改成：**直接 GET 目标 URL 并让它自己跟完**，
   * 需要多跳时靠重复访问各站点来补齐 cookie（尤其是 USER_INFO）。
   */
  private async followTicket(url: string): Promise<string> {
    if (!url) return '';
    const seen = new Set<string>();
    const targets: string[] = [url];

    // 把换票链上会经过的几个站点都排进去，确保 cookie 收齐
    const { authHost, appHost, lmsHost } = this.cfg;
    targets.push(`${appHost ?? lmsHost}/`, `${lmsHost}/`);

    let last = '';
    for (const target of targets) {
      const current = target.startsWith('http') ? target : `${authHost}${target}`;
      let key = current;
      try {
        const u = new URL(current);
        key = `${u.host}${u.pathname}`;
      } catch {
        /* 用原串 */
      }
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const res = await this.http.get(current);
        last = res.body || last;
      } catch {
        /* 某一跳失败不致命，继续把其他站点走完 */
      }
    }
    return last;
  }

  /** 建立签到 API（懒加载） */
  private async ensureSignApi(account: YouxueAccount): Promise<YouxueSignApi | null> {
    /**
     * ══════════ 缓存必须绑定账号（踩过的坑）══════════
     *
     * 用户反馈：「换账号后查询还都是我的数据，连解绑后重新查也是我的数据」。
     *
     * 根因就在这里：`YouxueAdapter` 是**模块级单例**（getAdapter() 每次返回同一个实例），
     * 而 this.signApi 里装着 **token + userId**。原先写成：
     *     if (this.signApi) return this.signApi;
     * 完全不看传进来的 account 是谁 —— 于是：
     *     用 A 登录 → signApi = A 的 API
     *     换 B 登录 → 若某次调用没重建 signApi，
     *                 B 的fetchCourses 就复用 A 的 API → **返回 A 的数据**
     *
     * 现在记下 signApi 属于哪个账号，只有一致才复用；
     * 不一致就丢弃重建（凭据本来就按 account.id 分开存）。
     */
    if (
      this.signApi &&
      this.signApiAccountId === account.id &&
      /**
       * ★ 同时要比 boundAt —— 见字段注释。
       *   相同账号重新登录后 boundAt 会变，必须重建。
       */
      this.signApiBoundAt === (account.boundAt ?? null)
    ) {
      return this.signApi;
    }

    // 账号变了 / 重新登录了（或首次）→ 丢掉旧的，别让旧 token 继续用
    this.signApi = null;
    this.signApiAccountId = null;
    this.signApiBoundAt = null;

    const cred = await store.get<StoredCredential | null>(`${STORE_KEYS.account}.cred.${account.id}`, null);
    if (!cred) return null;
    const token = cred.cookies?.AUTHORIZATION ?? cred.cookies?.token ?? '';
    if (!token || !cred.userId) return null;

    this.signApi = new YouxueSignApi({
      token,
      userId: cred.userId,
      cookies: cred.cookies,
      userAgent: cred.userAgent,
    });
    this.signApiAccountId = account.id;
    this.signApiBoundAt = account.boundAt ?? null;
    return this.signApi;
  }

  // ---------------- 数据 ----------------

  /**
   * 拉课程列表。
   *
   * ══════════════ ★★★ 2026-10：保留本地设置（踩过的坑）══════════════
   *
   * ⚠️ **原来的写法会清掉用户设的签到位置。**
   *
   *    原实现每次都用服务端数据**重新构造** Course 对象：
   *        return overview.courses.map((c) => ({ id, name, teacher, autoCheckin, ... }));
   *    里面**没有 `location`**（也硬编码 `autoCheckin: true`）——
   *    而 `location` 是**纯本地数据**，服务端根本不返回它。
   *
   *    后果：用户在「设置签到位置」里辛苦圈好范围 →
   *          下次打开 App 查一次课程 → **位置没了，位置签到又只能用真实 GPS**。
   *          而且没有任何提示，用户只会觉得"设了没用"。
   *
   * ✅ 现在：把**上一次的本地设置**按课程 id 合并回来。
   *    服务端字段（名字/教师/统计）照旧覆盖，本地字段（location）保留。
   *
   * ⚠️ 为什么 `autoCheckin` 也一并保留：
   *    它同样是本地开关（用户在课程列表里关掉某门课）。
   *    原来每次拉取都被重置成 true —— 用户关掉的课会**自己又开回来**。
   *    这是同一个 bug 的另一个表现，顺手一起修。
   *
   * ⚠️ 新出现的课程没有本地记录 → 用默认值（autoCheckin: true）。
   *    已经消失的课程直接丢掉（服务端没有了就是没有了）。
   */
  async fetchCourses(account: YouxueAccount, prev?: Course[]): Promise<Course[]> {
    const api = await this.ensureSignApi(account);
    if (!api) throw makeError('E_SESSION_EXPIRED', '缺少会话或 userId，请重新绑定');
    const overview = await api.fetchOverview();
    /** 上一次的本地设置（按课程 id 索引）—— 没有就空 Map，行为与老版本一致 */
    const prevById = new Map((prev ?? []).map((c) => [c.id, c]));
    // 用签到记录聚合出的课程（实测 /courses/students 在公网 502，改用此路径）
    return overview.courses.map((c) => {
      const id = String(c.ocId);
      const old = prevById.get(id);
      return {
        id,
        name: c.name,
        teacher: c.teacher ?? '',
        /** ★ 保留用户设的开关；新课程默认开 */
        autoCheckin: old?.autoCheckin ?? true,
        /** ★ 保留用户圈好的签到位置（服务端不返回它） */
        location: old?.location,
        schedule: old?.schedule ?? [],
        totalCheckins: c.records.length,
        completedCheckins: c.signedCount,
      };
    });
  }

  async fetchStats(account: YouxueAccount) {
    const api = await this.ensureSignApi(account);
    if (!api) return { todayDone: 0, todayTotal: 0, successRate: 0, streakDays: 0 };
    const o = await api.fetchOverview();
    const today = new Date().toDateString();
    const todayRecords = o.allRecords.filter((r) => r.beginTime && new Date(r.beginTime).toDateString() === today);
    return {
      todayDone: todayRecords.filter((r) => isSignedState(r.state)).length,
      todayTotal: todayRecords.length,
      successRate: o.summary.signedRate,
      streakDays: 0,
    };
  }

  async fetchHistory(account: YouxueAccount, limit = 20): Promise<RollcallTask[]> {
    const api = await this.ensureSignApi(account);
    if (!api) return [];
    const o = await api.fetchOverview();
    return o.allRecords.slice(0, limit).map(recordToTask);
  }

  // ---------------- 签到 ----------------

  /**
   * 检测待签到项。
   *
   * 判定依据（源码确认）：
   *   `status` = 学生签到状态（0=缺勤 1/2=已签到 3=迟到 4=早退 5=病假 6=事假）
   *   `state`  = 活动是否结束（"0"=已结束 "1"=进行中）
   * 只有「未签到 且 活动进行中」才是可操作的待签到项；其余归入 closed。
   */
  async detect(account: YouxueAccount, courses: Course[]): Promise<DetectResult> {
    const api = await this.ensureSignApi(account);
    if (!api) {
      return { found: [], closed: [], sessionState: 'expired' };
    }
    const o = await api.fetchOverview();
    const found: RollcallTask[] = [];
    const closed: RollcallTask[] = [];

    for (const r of o.allRecords) {
      const task = recordToTask(r);
      const notSigned = r.state === 'absent';
      const active = r.activityState === '1';
      if (notSigned && active) {
        found.push(task);
      } else {
        closed.push(task);
      }
    }
    void courses;
    return { found, closed, sessionState: 'valid' };
  }

  async submit(_account: YouxueAccount, payload: SubmitPayload): Promise<SubmitResult> {
    const api = await this.ensureSignApi(_account);
    if (!api) return { ok: false, error: makeError('E_SESSION_EXPIRED', '会话不可用') };

    const { task, signCode, qrPayload, location } = payload;
    if (!task.rollcallId) return { ok: false, error: makeError('E_UNKNOWN', '缺少 attendanceID') };

    const attendanceID = Number(task.rollcallId);
    const method = task.signType === 'qrcode' ? 'qrcode' : 'location';

    // 位置签到：坐标格式实测为 "经度,纬度"
    let locationStr: string | undefined;
    if (method === 'location' && location) {
      locationStr = `${location.longitude},${location.latitude}`;
    }

    const res = await api.submitSign({
      attendanceID,
      // ⚠️ 必须传数字 userId（api.userId 已保证是 number）
      userID: api.userId,
      method,
      location: locationStr,
      attendanceCode: qrPayload ?? signCode,
    });

    if (!res.ok) {
      return { ok: false, error: makeError('E_UNKNOWN', res.message ?? mapServerError(res.raw ?? '').message) };
    }

    // 复核：submitSign 内部已做状态复核，这里只在明确拿到"未变更"时补一次确认
    const detail = await api.fetchSignDetail(attendanceID);
    if (detail && !isSignedState(detail.state)) {
      return {
        ok: false,
        error: makeError(
          'E_UNKNOWN',
          detail.state === 'absent'
            ? '服务端已受理，但状态仍是缺勤。可能该点名已结束（业务码 202），或定位/二维码/数字码校验未通过。'
            : `未能确认状态（当前为「${detail.state}」），请手动搜索一次查看结果。`,
        ),
      };
    }
    return { ok: true, confirmedAt: Date.now() };
  }

  supportedSignTypes(): SignType[] {
    return ['location', 'qrcode'];
  }

  pollPlan(): PollPlan {
    return { ...DEFAULT_POLL_PLAN };
  }
}

// ---------------- 辅助 ----------------

/**
 * 从 CAS 返回的 HTML 里提取错误提示。
 *
 * 为什么要单独做：CAS 登录失败时**不返回 4xx**，而是重新渲染登录页
 * 并在里面放一段错误文案（HTTP 状态仍是 200）。
 * 只看状态码会把"密码错误"误判成"登录成功"。
 */
function errMsgOf(html: string): string | undefined {
  if (!html) return undefined;
  const patterns = [
    /id=["']showErrorTip["'][^>]*>([^<]{2,120})</i,
    /id=["']errorMsg["'][^>]*>([^<]{2,120})</i,
    /class=["'][^"']*error[^"']*["'][^>]*>([^<]{2,120})</i,
    /<div[^>]*id=["']msg["'][^>]*>([^<]{2,120})</i,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    const text = m?.[1]?.replace(/&nbsp;/g, ' ').trim();
    if (text) return text;
  }
  // 关键词兜底
  const kw = /(用户名或密码错误|密码错误|账号或密码|验证码错误|账号被锁定|用户不存在)/.exec(html);
  return kw?.[1];
}

/**
 * 从 USER_INFO cookie 里解出数字 userId。
 * 实测 cookie 名可能是 USER_INFO / USERINFO，值是 URL 编码的 JSON。
 */
export function parseUserIdFromCookie(cookies?: Record<string, string>): number | undefined {
  if (!cookies) return undefined;
  for (const key of ['USER_INFO', 'USERINFO']) {
    const rawVal = cookies[key];
    if (!rawVal) continue;
    try {
      let s = rawVal.replace(/%u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      s = decodeURIComponent(s);
      const j = JSON.parse(s) as { userId?: number; userID?: number; id?: number };
      const v = j.userId ?? j.userID ?? j.id;
      if (typeof v === 'number' && v > 0) return v;
      if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
    } catch {
      /* 解析失败继续试下一个 */
    }
  }
  return undefined;
}

/**
 * 学号归一化：去掉租户前缀与分隔符，只留纯字母数字并转小写。
 *
 * ══════════ 为什么必须做 ══════════
 * 实测踩到的坑：网页会话里 `USER_INFO` 的 `loginName` 是
 *     `dgut2099000000114`     ← 带学校前缀
 * 而用户输入的学号是
 *     `2099000000114`         ← 不带前缀
 * 两者**指向同一个账号**，但字符串不等 ——
 * 我原先的"会话学号必须等于请求学号"校验因此把**合法会话拒掉了**，
 * 界面报"拿到的会话属于另一个学号"，看起来像串号，其实是同一个人的两种写法。
 *
 * 归一化后比较即可：`dgut2099000000114` → `2099000000114`。
 */
export function normalizeStudentIdForCompare(sid: string): string {
  let s = String(sid ?? '').trim().toLowerCase();
  // 去掉常见分隔符
  s = s.replace(/[\s_-]/g, '');
  // 去掉开头的租户前缀（dgut / dgut- / 学校代码等）
  s = s.replace(/^(dgut|dgutdx|dgutedu)/, '');
  return s;
}

/**
 * 从 USER_INFO cookie 里解出**学号**（loginName）。
 *
 * 用途：绑定后校验"拿到的会话是不是本次登录的这个学号"。
 * 踩过的坑：残留的上一个账号 cookie 会让 userId 串号，
 * 表现为"换账号后查到的还是上一个人的数据"。
 */
export function parseStudentIdFromCookies(cookies?: Record<string, string>): string | undefined {
  if (!cookies) return undefined;
  for (const key of ['USER_INFO', 'USERINFO']) {
    const rawVal = cookies[key];
    if (!rawVal) continue;
    try {
      let s = rawVal.replace(/%u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      s = decodeURIComponent(s);
      const j = JSON.parse(s) as Record<string, unknown>;
      for (const f of ['loginName', 'loginname', 'studentId', 'studentNumber', 'userName', 'username', 'code']) {
        const v = j[f];
        // ⚠️ 返回**归一化后**的学号，避免 dgut 前缀导致误判
        if (typeof v === 'string' && v.trim()) return normalizeStudentIdForCompare(v);
      }
    } catch {
      /* 继续试下一个 cookie 名 */
    }
  }
  return undefined;
}

/** 把实测的签到详情转成内部任务模型 */
function recordToTask(r: {
  attendanceID: number;
  title: string;
  method: ReturnType<typeof methodFromType>;
  state: ReturnType<typeof stateFromStatus>;
  classes: Array<{ classID: number; className: string }>;
  teacherName?: string;
  location?: string;
  createDate?: number;
  courseName?: string;
  ocId?: number;
}): RollcallTask {
  // SignMethod → 内部 SignType（内部只区分 location/qrcode，数字码与一键签到按 location 走）
  const signType: SignType = r.method === 'qrcode' ? 'qrcode' : 'location';
  return {
    id: `att-${r.attendanceID}`,
    accountId: '',
    courseId: String(r.ocId ?? r.classes[0]?.classID ?? ''),
    courseName: r.courseName ?? r.title,
    teacher: r.teacherName,
    location: r.location,
    rollcallId: String(r.attendanceID),
    signType,
    state: isSignedState(r.state) ? 'success' : 'failed',
    windowStart: r.createDate,
    attempts: 0,
    method: 'auto',
  } as RollcallTask;
}
