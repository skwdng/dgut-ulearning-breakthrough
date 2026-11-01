/**
 * 优学院「站点」配置 —— 让 App 支持**非东莞理工**的优学院站点。
 *
 * ══════════════ 用户需求（原话）══════════════
 *
 *   「现在有一个优学院走的中国站点不是东莞理工站点的，怎么改」
 *
 * ══════════════ ⚠️ 为什么不能只改一个域名 ══════════════
 *
 * 优学院是 SaaS，同一套后端有**两种对外暴露方式**（这是查证过的事实）：
 *
 * ① **路径前缀模式**（东莞理工在用）
 *       https://lms.dgut.edu.cn/apps/newAttendance/...
 *       https://lms.dgut.edu.cn/courseapi/courses/students
 *       https://lms.dgut.edu.cn/classroomapi/wisdomClassroom/...
 *     —— 全部服务挤在**同一个域名**下，靠路径第一段区分。
 *
 * ② **子域名模式**（优学院中国站）
 *       https://apps.ulearning.cn/newAttendance/...
 *       https://courseapi.ulearning.cn/courses/students
 *       https://classroomapi.ulearning.cn/wisdomClassroom/...
 *     —— 服务名变成**子域名**，路径里**不再有** `/apps` 那段前缀。
 *
 *   实测依据：`https://apps.ulearning.cn/` 与
 *             `https://lms.dgut.edu.cn/apps/` 返回**完全相同的**
 *             `{"code":2001,"message":"缺少访问token"}`
 *             → 同一个网关，只是入口不同。
 *
 * 所以"支持别的站点"= 换 base URL + 换模式，**不是**改一个常量。
 *
 * ══════════════ ⚠️ 本项目里的路径约定 ══════════════
 *
 * `signApi.ts` 的 ENDPOINTS 里存的是**带服务前缀的完整路径**，
 * 例如 `/apps/user/getUserByUserID/123`、`/courseapi/courses/students`。
 *
 * 于是两种模式可以用**同一个函数**消化：
 *   · pathPrefix → lms 域名 + 原路径（前缀保留）
 *   · subdomain  → 按第一段选子域名 + **去掉**那一段前缀
 *
 * 见下方 `resolvePath()`。这样改造面很小（不用改几十个端点常量）。
 *
 * ══════════════ ⚠️ 尚未实测的部分（诚实说明）══════════════
 *
 *   · 中国站的具体接口是否**都存在**：只有登录后才能确认（401 拦在路由之前，
 *     连"故意写错的路径"都回 401，所以没登录时探不出真假）。
 *   · 中国站的登录页是普通账号密码表单（`www.ulearning.cn/ulearning_web/login.do`），
 *     没有东莞理工那套 CAS，所以 WebView 登录流程可能更简单 —— 也可能有验证码。
 *   · 学号前缀：东莞理工是 `dgut2024…`，中国站未必有前缀。
 */

/** 单个服务的基址（不带结尾斜杠） */
export interface SiteServices {
  /**
   * 通用/旧接口宿主。
   * ⚠️ 路径前缀模式用它承载**所有**服务；子域名模式只用来拼
   *    `/static`、`/courseweb`、`/umobile` 这类非服务前缀的路径。
   */
  lms: string;
  /** 签到 / 选人 / 用户（移动端网关） */
  apps: string;
  /** 课程 / 课堂活动 */
  courseApi: string;
  /** 智慧课堂 */
  classroomApi: string;
  /**
   * ★ 智慧课堂（application 域那一份）—— 答题（replyquestion）等接口只在这里。
   *
   * 为什么不能复用上一条：优学院移动端 H5 的配置模块（`.recon/umobile/app.*.js`
   * 的 mZex 模块）写得很清楚：
   *   g = https://lms.<域名> /courseapi       ← API_HOST
   *   m = https://lms.<域名> /apps            ← API_HOST_OLD
   *   h = https://application.<域名> /classroomapi  ← SMART_API_HOST
   * 而答题接口 `src-async.*.js` 里是
   *   r = Object(i.a)(o.a.SMART_API_HOST)
   *   r.get('/replyquestion/student/detail/'+id) / r.post('/replyquestion/stuReply')
   * 也就是 **答题走 application 域**，不是 lms 域的 /classroomapi。
   * 用错域名的表现是：接口回 401/404，页面读不到题。
   */
  smartApi?: string;
  /** 作业 / 测验 */
  homeworkApi: string;
  /** 考试 */
  utestApi: string;
  /** CAS 认证（只有校级站有） */
  auth?: string;
}

export interface SiteConfig {
  code: string;
  /** 界面上显示的名字 */
  label: string;
  /** 一句话说明（给用户看，尤其是"该选哪个"） */
  hint: string;
  /**
   * ★ API 暴露模式
   *   'pathPrefix' —— 所有服务在同一域名下用路径前缀（东莞理工）
   *   'subdomain'  —— 服务名即子域名（优学院中国站）
   */
  apiMode: 'pathPrefix' | 'subdomain';
  services: SiteServices;
  /** WebView 登录入口 */
  portalUrl: string;
  /**
   * ⚠️ 校方"应用中心"域名（东莞理工是 `application.dgut.edu.cn`）。
   *    只用于 CAS 登录与 cookie 回写；全国站没有这一层。
   */
  appHost?: string;
  /**
   * CAS 回调路径（用作 `service` 参数）。
   * ⚠️ 只有校级站有；中国站是普通账号密码登录，没有 CAS。
   */
  casServicePath?: string;
  /**
   * 学号可能带的租户前缀（如 `dgut`）。
   * ⚠️ 东莞理工的 cookie 里登录名是 `dgut2099000000114`，
   *    用户输入的是 `2099000000114`，比对前要剥掉前缀。
   *    中国站没有这个前缀，留空。
   */
  loginPrefix?: string;
  /**
   * 是否有东莞理工专属的 `application.dgut.edu.cn/appapi` 网关。
   * ⚠️ 那是**校方定制层**，不是优学院通用前缀，别处没有。
   */
  useAppApiGateway?: boolean;
}

/* ══════════════════ 站点表 ══════════════════ */

/** 东莞理工学院（原有，唯一**完全实测通过**的站点） */
export const SITE_DGUT: SiteConfig = {
  code: 'dgut',
  label: '东莞理工学院',
  hint: '学校域名 lms.dgut.edu.cn，登录走学校统一认证（CAS）',
  apiMode: 'pathPrefix',
  services: {
    lms: 'https://lms.dgut.edu.cn',
    apps: 'https://lms.dgut.edu.cn/apps',
    courseApi: 'https://lms.dgut.edu.cn/courseapi',
    classroomApi: 'https://lms.dgut.edu.cn/classroomapi',
    homeworkApi: 'https://lms.dgut.edu.cn/homeworkapi',
    utestApi: 'https://lms.dgut.edu.cn/utestapi',
    // ★ 答题（replyquestion）只在 application 域的 /classroomapi 下（见 SiteServices.smartApi 注释）
    smartApi: 'https://application.dgut.edu.cn/classroomapi',
    auth: 'https://auth.dgut.edu.cn',
  },
  portalUrl: 'https://application.dgut.edu.cn',
  appHost: 'https://application.dgut.edu.cn',
  casServicePath: '/appapi/cas/fromcas',
  loginPrefix: 'dgut',
  useAppApiGateway: true,
};

/**
 * 优学院中国站（全国站）。
 *
 * ⚠️ 域名来自公开资料 + 实测：
 *    · `www.ulearning.cn` 是官网首页/登录页（HTTP 200）
 *    · `apps.ulearning.cn` / `courseapi.ulearning.cn` / `classroomapi.ulearning.cn`
 *      都解析到 119.3.211.94，且 `apps.ulearning.cn/` 与
 *      `lms.dgut.edu.cn/apps/` 返回**同一段** 401 JSON
 *    · 官网登录页 `/ulearning_web/login.do`
 * ⚠️ 但**接口是否齐全、登录是否顺畅，还没用真实账号验证过**。
 */
export const SITE_ULEARNING_CN: SiteConfig = {
  code: 'ulearning-cn',
  label: '优学院（中国站 / 全国站）',
  hint: '不是某所学校自己的站，账号在 www.ulearning.cn 注册的那种',
  apiMode: 'subdomain',
  services: {
    lms: 'https://www.ulearning.cn',
    apps: 'https://apps.ulearning.cn',
    courseApi: 'https://courseapi.ulearning.cn',
    classroomApi: 'https://classroomapi.ulearning.cn',
    homeworkApi: 'https://homeworkapi.ulearning.cn',
    utestApi: 'https://utestapi.ulearning.cn',
    // 中国站没有 application 域，答题仍在 classroomapi 子域名下
    smartApi: 'https://classroomapi.ulearning.cn',
    // 中国站没有校级 CAS
  },
  portalUrl: 'https://www.ulearning.cn/ulearning_web/login.do',
  // 中国站没有学号前缀
};

export const SITES: Record<string, SiteConfig> = {
  [SITE_DGUT.code]: SITE_DGUT,
  [SITE_ULEARNING_CN.code]: SITE_ULEARNING_CN,
};

/** 打包时的默认站点（用户可在设置里改） */
export const DEFAULT_SITE_CODE = 'dgut';

export function getSiteConfig(code: string | undefined | null): SiteConfig {
  if (code && SITES[code]) return SITES[code];
  return SITES[DEFAULT_SITE_CODE];
}

/* ══════════════════ 路径 → URL ══════════════════ */

/**
 * 把 `signApi` 风格的"完整路径"变成真正的 URL。
 *
 * 两种模式的差别就在这个函数里：
 *
 *   pathPrefix（东莞理工）
 *     `/apps/user/getUserByUserID/1`
 *       → https://lms.dgut.edu.cn/apps/user/getUserByUserID/1
 *
 *   subdomain（中国站）
 *     `/apps/user/getUserByUserID/1`
 *       → https://apps.ulearning.cn/user/getUserByUserID/1
 *         （`/apps` 那一段**去掉**，因为服务名已经是子域名了）
 *
 * ⚠️ 不在服务前缀表里的路径（`/static/...`、`/courseweb/...`、`/umobile/...`）
 *    一律落到 `lms` 基址 —— 两种模式都是这样。
 */
export function resolvePath(site: SiteConfig, path: string): string {
  /** 已经是绝对地址就不动 */
  if (/^https?:\/\//i.test(path)) return path;

  /**
   * ★ `/smartapi/...` = `SiteServices.smartApi`（答题专用，跨域名）。
   *
   * 必须在 `pathPrefix` 分支**之前**判：东莞理工是 pathPrefix 模式，
   * 那个分支无脑拼 `services.lms`，会把答题打到 `lms.dgut.edu.cn/classroomapi`，
   * 而真正能答题的是 `application.dgut.edu.cn/classroomapi`（见 SiteServices 注释）。
   */
  if (path.startsWith('/smartapi/')) {
    const base = site.services.smartApi || site.services.classroomApi;
    return `${base}${path.slice('/smartapi'.length)}`;
  }

  if (site.apiMode === 'pathPrefix') {
    return `${site.services.lms}${path}`;
  }

  /**
   * 子域名模式：按路径第一段挑服务。
   * ⚠️ 顺序无所谓，用 Map 更清楚，但这里路径很固定，直接判即可。
   */
  const PREFIX_TO_SERVICE: Array<[string, keyof SiteServices]> = [
    ['/apps/', 'apps'],
    ['/courseapi/', 'courseApi'],
    ['/classroomapi/', 'classroomApi'],
    ['/homeworkapi/', 'homeworkApi'],
    ['/utestapi/', 'utestApi'],
  ];

  for (const [prefix, key] of PREFIX_TO_SERVICE) {
    if (path.startsWith(prefix)) {
      const base = site.services[key];
      const rest = path.slice(prefix.length - 1); // 保留前导斜杠
      return `${base}${rest}`;
    }
  }

  /** 其它（静态资源、H5 入口、移动端无关路径）→ lms 基址 */
  return `${site.services.lms}${path}`;
}

/**
 * 某个路径属于哪个服务（给诊断/界面显示用）。
 * 返回 `null` 表示"不归属任何服务前缀"。
 */
export function serviceOfPath(site: SiteConfig, path: string): keyof SiteServices | null {
  /** /smartapi/* 物理上是 classroomApi（application 域那一份） */
  if (path.startsWith('/smartapi/')) return 'classroomApi';
  if (site.apiMode === 'pathPrefix') return 'lms';
  const order: Array<[string, keyof SiteServices]> = [
    ['/apps/', 'apps'],
    ['/courseapi/', 'courseApi'],
    ['/classroomapi/', 'classroomApi'],
    ['/homeworkapi/', 'homeworkApi'],
    ['/utestapi/', 'utestApi'],
  ];
  for (const [prefix, key] of order) {
    if (path.startsWith(prefix)) return key;
  }
  return null;
}

/**
 * 这个站点所有"需要读写 cookie 的宿主"（WebView 登录后回写、读会话用）。
 *
 * ══════════════ ★★★ 踩过的坑：漏了「应用中心」域名（2026-10）══════════════
 *
 * 多站点改造时这里只遍历了 `site.services` —— 那里面只有
 * lms / apps / courseapi / classroomapi / homeworkapi / utestapi / auth 这些**服务域名**。
 *
 * 但东莞理工的登录入口是 **应用中心 `application.dgut.edu.cn`**：
 *   · 用户点「打开登录页面」→ 打开的是 application.dgut.edu.cn
 *   · CAS 登录完成后，会话相关的 cookie 就落在**那个域**下
 *   · 而 `site.appHost` 是**独立字段**，不在 `services` 里
 *
 * 后果（真实 bug）：登录明明成功，但"读取会话 / 读取课程"失败 ——
 *   因为读 cookie 时根本没读 application.dgut.edu.cn。
 * 旧代码是写死 `['application.dgut.edu.cn', 'lms.dgut.edu.cn', 'auth.dgut.edu.cn']`，
 * 里面**第一个就是它**；改造时漏掉了，等价于把这条链路砍断。
 *
 * 所以现在必须把 `appHost`（应用中心）和 `portalUrl`（登录门户）也算进来。
 * 顺序上让"服务域名"在前、"门户域名"在后 —— 读写都不依赖顺序，只是好看点。
 */
export function hostsOfSite(site: SiteConfig): string[] {
  const hostOf = (u: string | undefined) => (u ?? '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const set = new Set<string>();
  for (const v of Object.values(site.services)) {
    if (typeof v === 'string' && v) set.add(hostOf(v));
  }
  /** ★ 应用中心（DGUT 的登录/会话入口，必须读它） */
  if (site.appHost) set.add(hostOf(site.appHost));
  /** ★ 登录门户（例如中国站 www.ulearning.cn，登录后 cookie 也可能落在这里） */
  if (site.portalUrl) set.add(hostOf(site.portalUrl));
  set.delete('');
  return [...set];
}
