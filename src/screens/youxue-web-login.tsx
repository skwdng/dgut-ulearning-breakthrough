/**
 * 应用内登录页 —— 用 WebView 走学校自己的登录流程。
 *
 * ══════════ 为什么不能在 App 里自动填表 ══════════
 * 手机端拿到的登录页是 **JS 渲染**的（`<script src=./encrypt.js>`），
 * 源码里没有 `pwdEncryptSalt`，无法程序化提交；
 * 而桌面端是静态表单。所以只能用 WebView 让学校页面自己处理登录。
 *
 * ══════════ Cookie 怎么取（踩了三个坑）══════════
 *   1. 注入 JS 读 `document.cookie`
 *      → `AUTHORIZATION` / `USER_INFO` 是 **HttpOnly**，读不到。
 *   2. `@react-native-cookies/cookies`
 *      → 鸿蒙上 `getAll` 报 "Get all cookies not supported"，三个域名全 0。
 *   3. **最终方案：自己写的原生模块 `WebCookie`**
 *      → 直接调 `android.webkit.CookieManager`（WebView 自己的存储），
 *        并在读之前 `flush()` 强制落盘（不 flush 常常读到空）。
 *
 * 需求：这页**不填学号**，就是一个跳转页。
 * 学号从 `USER_INFO` cookie 里解出来，解不到再让用户补。
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, TextInput, View } from 'react-native';
import { WebView, type WebViewNavigation } from 'react-native-webview';
import { Banner, Button, Card, Row, ScreenScroll, Section, Spacer, Txt } from '../components';
import { color, spacing } from '../theme/tokens';
import { getTenant } from '../config/tenants';
import { getCurrentSite } from '../config/currentSite';
import { hostsOfSite } from '../config/sites';
import { useCheckin } from '../state/checkinStore';
import { BUILD_CONFIG } from '../config/buildConfig';
import { logFault } from '../services/crashLog';
import {
  clearCookies,
  readSessionCookies,
  setCookieInManager,
} from '../services/webCookie';
import { getServerBase } from '../services/serverClient';
import { reportUserQueued } from '../services/reportQueue';

/** 会话必需的 cookie 名 */
const SESSION_COOKIE_NAMES = ['AUTHORIZATION', 'token', 'USER_INFO', 'USERINFO'];

/** WebView 回传 cookie 的消息前缀 */
const WEB_COOKIE_PREFIX = '@lifekit:cookies:';

/**
 * 在 WebView 页面里执行的 JS：读 document.cookie 并回传。
 *
 * ⚠️ 只读得到**非 HttpOnly** 的 cookie。这是 WebView 的限制，无法绕过。
 *    但很多学校系统把 USER_INFO / JSESSIONID 放在非 HttpOnly 里。
 */
const JS_HARVEST_COOKIES = `
(function () {
  try {
    var c = document.cookie || '';
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(${JSON.stringify(WEB_COOKIE_PREFIX)} + c);
    }
  } catch (e) {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(${JSON.stringify(WEB_COOKIE_PREFIX)} + 'ERROR:' + e.message);
    }
  }
  true;
})();
`;

/** 解析 "a=1; b=2" 形式的 cookie 串 */
function parseCookiePairs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || raw.startsWith('ERROR:')) return out;
  for (const pair of raw.split(';')) {
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function hasSession(cookies: Record<string, string>): boolean {
  return SESSION_COOKIE_NAMES.some((n) => Boolean(cookies[n]));
}

/**
 * 从 USER_INFO cookie 里解出学号（URL 编码的 JSON）。
 * 解不出来就返回 undefined，交给界面兜底。
 */
function studentIdFromCookies(cookies: Record<string, string>): string | undefined {
  const raw = cookies.USER_INFO ?? cookies.USERINFO;
  if (!raw) return undefined;
  try {
    let s = raw.replace(/%u([0-9a-fA-F]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
    s = decodeURIComponent(s);
    const j = JSON.parse(s) as Record<string, unknown>;
    const id = j.studentId ?? j.userName ?? j.loginName ?? j.account;
    return typeof id === 'string' && id.trim() ? id.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function YouxueWebLoginScreen({ onDone }: { onDone: () => void }) {
  const { account, actions } = useCheckin();
  const tenant = getTenant(account?.tenant ?? BUILD_CONFIG.tenant);

  /**
   * ★ 登录入口的叫法要跟着**站点**走（2026-10 多站点改造的收尾）。
   *
   * ⚠️ 原来三处文案写死"学校登录页"：
   *       · 「会打开**学校**的登录页面」
   *       · 按钮「打开**学校**登录页」
   *       · 加载中「正在打开**学校**登录页…」
   *
   *    这对东莞理工没问题，但**优学院中国站不是学校的页面** ——
   *    它打开的是优学院官网（www.ulearning.cn）的账号密码登录页。
   *    中国站用户看到"学校登录页"会以为自己选错了站点，直接退出。
   */
  const loginPageName = tenant.code === 'dgut' ? '学校登录页' : '优学院登录页';

  const [showWeb, setShowWeb] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'error' | 'warning'; text: string } | null>(null);
  const [needId, setNeedId] = useState(false);
  const [manualId, setManualId] = useState('');
  const [pending, setPending] = useState<Record<string, string> | null>(null);
  /** WebView 实例 —— 用于注入 JS 读 cookie */
  const webRef = useRef<WebView>(null);
  /** 从 WebView 页面里读到的 cookie（原始） */
  const webJarRef = useRef<Record<string, string>>({});
  /** 从 WebView 页面里同步到的 cookie 个数 */
  const [webCookieCount, setWebCookieCount] = useState(0);
  /** 页面内 cookie 的名字（显示出来便于判断有没有会话凭据） */
  const [webCookieNames, setWebCookieNames] = useState<string[]>([]);
  /**
   * ★ WebView 加载失败的原因（2026-10 加）。
   *
   * ⚠️ 用户报「登录页打不开」时，界面上原来**一片空白** ——
   *    既分不清是没网、域名解析失败，还是站点选错（东莞理工 / 中国站）。
   *    把原生错误（`net::ERR_NAME_NOT_RESOLVED` / `ERR_CONNECTION_TIMED_OUT`）
   *    或 HTTP 状态码，连同实际地址一起显示出来：
   *    · 用户能自救（重试 / 换个浏览器打开）
   *    · 反馈问题时也带上了关键证据，不用再猜。
   *
   * ⚠️ 默认 null —— 加载成功时横幅**不占任何空间**
   *    （用户要求登录页只留登录口，不能为了诊断反过来把界面撑满）。
   */
  const [loadErr, setLoadErr] = useState<{ url: string; reason: string } | null>(null);

  /**
   * 要读写 cookie 的宿主列表。
   *
   * ══════════════ ★★★ 多站点改造（2026-10）══════════════
   *
   * 原来写死成 `[tenant.appHost, tenant.lmsHost, tenant.authHost]` ——
   * 那三个域名是**东莞理工专有**的（application / lms / auth）。
   *
   * 优学院全国站没有 application，也没有 auth（没有 CAS），
   * 而真正承载接口的是 `apps.ulearning.cn` / `courseapi.ulearning.cn` 这些子域。
   * 只写 lms 一个域的话，App 发请求时**带不上 cookie** → 401。
   *
   * 所以改成从站点配置里算：`hostsOfSite()` 会把 services 里所有域名都列出来。
   */
  const hosts = useMemo(() => {
    const list = hostsOfSite(getCurrentSite());
    return list;
  }, [tenant]);

  /**
   * 读 cookie（带重试）。
   *
   * ⚠️ 必须重试：WebView 的 cookie 是异步落盘的，
   *    刚跳转完立刻读常常是 0 个 —— 用户实测就遇到了。
   */
  const readCookies = useCallback(
    async (): Promise<{ cookies: Record<string, string>; detail: string }> =>
      readSessionCookies(hosts, hasSession),
    [hosts],
  );

  /**
   * 候选学号：用户手填的 → 已绑定账号的。
   * cookie 里解不出学号时用它兜底（避免因为"解析不到学号"就整个流程走不下去）。
   */
  const studentIdFromCandidates = useCallback((): string | undefined => {
    const manual = manualId.trim();
    if (manual.length >= 4) return manual;
    return account?.studentId || undefined;
  }, [account?.studentId, manualId]);

  /** 保存会话 */
  const saveSession = useCallback(
    async (cookies: Record<string, string>, sid: string) => {
      setBusy(true);
      try {
        const res = await actions.bindWithSession(sid, cookies);
        if (res.ok) {
          /**
           * ★ 上报到管理服务端（谁、什么学号、什么时候登的）。
           *
           * ⚠️ 这里原来**漏了上报** —— 而网页登录现在是主入口，
           *    等于"用网页登录的人在管理页里看不到"。
           *    踩过的坑就是这样：功能都在，但两条路径行为不一致，
           *    表现为"某人明明在用，列表里却没有他"。
           *
           * ⚠️ 用队列版：服务器可能没开，先存本地，连上自动补发。
           *    失败不影响登录（上报只是给管理页看）。
           */
          void (async () => {
            try {
              const base = await getServerBase();
              const rep = await reportUserQueued(base, {
                studentId: sid,
                school: tenant.schoolName,
                tenant: tenant.code,
              });
              if (!rep.ok && rep.queued) {
                setMsg({
                  tone: 'info',
                  text: '登录成功。管理服务器暂时连不上，这次记录已存在本机，连上后会自动补发（不影响使用）。',
                });
              } else if (!rep.ok) {
                setMsg({
                  tone: 'warning',
                  text: `登录成功，但上报到管理服务失败：${rep.error ?? '未知原因'}（不影响使用）`,
                });
              }
            } catch {
              /* 上报是副作用，绝不影响登录 */
            }
          })();
          /**
           * ★ 必须把 **userId** 和**本次登录的学号**显示出来。
           *
           * ⚠️ 这不是装饰 —— 「换账号后查询还是我的数据」那次，
           *    正是因为界面上看不到 userId，才查了三轮才定位到
           *    "适配器单例里残留了上一个账号的会话"。
           *    有了这个值，用户自己就能看出"登的到底是谁"。
           *
           * ⚠️ 这段原来是写在"学号+密码登录"里的，
           *    那条路废掉后**必须搬到这里**，否则诊断线索就断了。
           *    （是回归测试把这条抓出来的：它盯的是"登录成功后要把
           *      userId 显示给用户"，搬家时我漏了。）
           */
          setMsg({
            tone: 'info',
            text:
              `登录成功，已保存会话。\n` +
              `本次登录学号：${sid}\n` +
              `服务端认到的 userId：${res.userId ?? '(未取到)'}`,
          });
          setTimeout(onDone, 900);
        } else {
          setMsg({ tone: 'error', text: res.error?.message ?? '保存会话失败' });
        }
      } finally {
        setBusy(false);
      }
    },
    [actions, onDone],
  );

  /**
   * ══════════ 从 WebView 内部把 cookie 同步出来 ══════════
   *
   * 踩过的坑：WebView 里明明已登录（页面显示"欢迎您，XXX 学生"），
   * 但原生 `CookieManager.getCookie()` 读到 **0 个** ——
   * WebView 的 cookie 存储与 CookieManager 不同步（Android 已知问题）。
   *
   * 所以这里在页面里执行 JS 读 `document.cookie`，用 postMessage 带回 RN，
   * 再交给原生 `setCookie` 写进 CookieManager，之后整条读取链路就正常了。
   *
   * 局限：`document.cookie` **读不到 HttpOnly 的 cookie**。
   *       但先把能拿到的（JSESSIONID / USER_INFO / CASTGC 等）同步过去，
   *       很多情况下足够让后续请求被服务端认作已登录。
   */
  const syncFromWebView = useCallback(async (): Promise<Record<string, string>> => {
    const ref = webRef.current;
    if (!ref) return {};
    try {
      await ref.injectJavaScript(JS_HARVEST_COOKIES);
    } catch (e) {
      logFault(`[WebView登录] 注入读取 cookie 失败：${(e as Error).message}`, 'webLogin.inject');
    }
    // 等页面的 postMessage 回来（onMessage 会把结果存进 webJarRef）
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 150));
      if (Object.keys(webJarRef.current).length) break;
    }
    return webJarRef.current;
  }, []);

  /**
   * 把从 WebView 拿到的 cookie **写进原生 CookieManager**。
   *
   * ⚠️ 这里是异步的，而且很慢：10 个 cookie × 3 个域名 = 30 次原生调用。
   *    所以调用方**必须 await 它**，否则会出现
   *    "同步到 10 个" 但 "读回 0 个" 的竞态（实测踩过）。
   */
  const onWebViewMessage = useCallback(async (data: string) => {
    if (!data.startsWith(WEB_COOKIE_PREFIX)) return;
    const raw = data.slice(WEB_COOKIE_PREFIX.length);
    const jar = parseCookiePairs(raw);
    const names = Object.keys(jar);
    if (!names.length) return;
    webJarRef.current = jar;
    setWebCookieCount(names.length);
    setWebCookieNames(names);
    /**
     * 写回 CookieManager（成功与否不影响保存会话 —— 会话优先用从这里拿到的 cookie）。
     * ⚠️ 这里**故意不显示"写入 x 次成功/y 次被拒"**：用户要求登录页只留登录口，
     *    这类诊断文字会把界面弄乱；真出问题用 /diagnostics 看。
     */
    await setCookieInManager(jar);
    /**
     * ══════════════ ★ 这里**不再**写崩溃日志 ══════════════
     *
     * 原先用 `logFault` 记这条，结果是：
     *   · 每次 WebView 发消息都记一条
     *   · WebView 天然会把同一条消息发好几次 → 一次登录刷出五条一模一样的
     *   · 于是「崩溃日志」页被**正常操作**塞满，**真正的崩溃被淹没**
     *     （用户发来的日志里 30 条全是这个，一条崩溃都没有）
     *
     * 而且这条本身根本不算故障：
     *   `被拒 36` = 12 个 cookie × 3 个域名 —— 每个 cookie 往三个域名
     *   各写一遍，**总有两个域名是白写的**（见 webCookie.ts 的实现）。
     *   会话真正的成败看下面那行 `写凭据 … 结果=成功`。
     *
     * 所以成功路径既不写崩溃日志，也不再往界面刷同步结果（登录页只管登录）。
     */
  }, []);

  const harvest = useCallback(
    async (auto = false) => {
      if (!auto) setMsg({ tone: 'info', text: '正在读取会话…' });

      /**
       * ★ 路线一：直接用**网页里读到的** cookie 保存会话。
       *
       * ══════════ 为什么这条路最可靠 ══════════
       * 实测证据（用户截图）：
       *     网页内读到 10 个：app_login_way, loginFrom, **AUTHORIZATION**,
       *                      **token**, lms_user_org, USER_INFO, USERINFO, ...
       *     已读到 Cookie: 0 个        ← CookieManager 仍然读不到
       *
       * 也就是说：**cookie 明明拿到了（含 AUTHORIZATION！），
       * 只是写回 CookieManager 这条路不通**（Android 上 WebView 与
       * CookieManager 不同步，写回去也不一定读得回来）。
       *
       * 既然数据已经在手上，就**不要绕那一圈** —— 直接用它建会话。
       * 这样登录成功与否不再依赖 CookieManager 的读取行为。
       */
      const fromWeb = await syncFromWebView();
      if (hasSession(fromWeb)) {
        /**
         * ★ 学号必须**优先从这次网页会话里解出来**。
         *
         * ⚠️ 不能优先用 `account.studentId`：换账号时它还是**上一个人的**，
         *    而 persistSession 现在会校验"会话学号 == 请求学号"，
         *    拿旧学号去绑新会话会被直接拒掉（看起来像"登录失败"，其实是我们传错了）。
         */
        const cookieSid = studentIdFromCookies(fromWeb);
        const sidFinal = cookieSid ?? studentIdFromCandidates();
        if (sidFinal) {
          /**
           * ⚠️ 这条是**成功路径**，不再写崩溃日志 ——
           *    原因同上面 onWebViewMessage 那段注释：
           *    WebView 会重复发消息，一次登录刷五条，把真崩溃挤掉。
           *    会话成功与否界面上已有反馈。
           */
          // 顺便尝试写回 CookieManager（成功了更好，失败也不影响）
          void setCookieInManager(fromWeb);
          await saveSession(fromWeb, sidFinal);
          return;
        }
        // 有会话但解不出学号 → 让用户补
        setPending(fromWeb);
        setNeedId(true);
        setMsg({ tone: 'info', text: '已拿到会话，但没能自动识别学号，请补填一次。' });
        return;
      }

      // 写回 CookieManager（也用于诊断）
      if (Object.keys(fromWeb).length) {
        await setCookieInManager(fromWeb);
      }

      const { cookies, detail } = await readCookies();
      const n = Object.keys(cookies).length;
      const names = Object.keys(cookies);

      // ★ 把"实际读到的 cookie 名字"显示出来 ——
      //   没有会话凭据时，最容易的判断就是看名字里有没有 AUTHORIZATION / USER_INFO。

      if (!hasSession(cookies)) {
        if (auto) return;
        logFault(
          `[WebView登录] 没拿到会话凭据 cookie数=${n} 名称=${names.slice(0, 12).join(',') || '(空)'} 明细=${detail}`,
          'webLogin.harvest',
        );
        setMsg({
          tone: 'warning',
          text:
            n === 0
              ? `没读到任何 Cookie（${detail}）。网页内同步到 ${webCookieCount} 个` +
                `${webCookieNames.length ? `（${webCookieNames.slice(0, 8).join(',')}）` : ''}。` +
                `若网页内也读不到，说明会话 cookie 是 HttpOnly —— 请把这条反馈给开发者。`
              : `读到 ${n} 个 cookie，但没有会话凭据（缺 AUTHORIZATION / USER_INFO）。实际读到：${names
                  .slice(0, 10)
                  .join(', ')}。`,
        });
        return;
      }

      const sid = studentIdFromCookies(cookies);
      if (sid) {
        await saveSession(cookies, sid);
      } else if (account?.studentId) {
        await saveSession(cookies, account.studentId);
      } else {
        // 会话有了，但解不出学号 —— 这时才需要用户补一个
        setPending(cookies);
        setNeedId(true);
        setMsg({ tone: 'info', text: '已拿到会话，但没能自动识别学号，请补填一次。' });
      }
    },
    [account?.studentId, readCookies, saveSession, studentIdFromCandidates, syncFromWebView],
  );



  const onNav = useCallback(
    (_nav: WebViewNavigation) => {
      setTimeout(() => void harvest(true), 700);
    },
    [harvest],
  );

  /**
   * 开始登录前先清空 WebView cookie。
   *
   * 不清的话：如果之前登录过，CAS 会认为"已登录"直接跳过去，
   * 我们读到的就是旧会话，甚至读不到 —— 表现为"跳到工作台但没 cookie"。
   */
  const startLogin = useCallback(async () => {
    setMsg({ tone: 'info', text: '正在准备…' });
    await clearCookies();
    setMsg(null);
    // 上一次登录留下的失败横幅不能带进这次
    setLoadErr(null);
    setShowWeb(true);
  }, []);

  /**
   * 失败横幅上的「重试」：清掉旧错误再让 WebView 重新加载。
   *
   * ⚠️ 先清状态再 reload —— 重试是用户明确表示"再试一次"，
   *    横幅应该立刻消失；等 `onLoadStart` 再清会有一瞬间的残留。
   */
  const retryLoad = useCallback(() => {
    setLoadErr(null);
    webRef.current?.reload();
  }, []);

  /**
   * 失败横幅上的「用浏览器打开」：把入口地址交给系统浏览器。
   *
   * ⚠️ 必须接住异常 —— 设备上没有任何能处理 http 的应用时，
   *    `Linking.openURL` 会 reject；不接就是未处理的 Promise（用户只觉得"点了没反应"）。
   *    失败时至少留一条崩溃日志，方便事后查。
   */
  const openInBrowser = useCallback(async () => {
    try {
      await Linking.openURL(tenant.entryUrl);
    } catch (e) {
      logFault(
        `[WebView登录] 打开系统浏览器失败：${(e as Error).message} url=${tenant.entryUrl}`,
        'webLogin.openBrowser',
      );
    }
  }, [tenant.entryUrl]);

  /* ─────────── 需要补学号 ─────────── */
  if (needId && pending) {
    return (
      <ScreenScroll>
        <Section style={{ marginTop: spacing.sm }}>
          <Card>
            <Txt variant="body" weight="semibold">
              还差一步：学号
            </Txt>
            <Spacer h={spacing.sm} />
            <Txt variant="small" c={color.text.secondary} style={{ lineHeight: 19 }}>
              会话已经拿到了，但没能从学校返回的数据里识别出学号。填一次即可（只用于标识这份会话）。
            </Txt>
            <Spacer h={spacing.md} />
            <TextInput
              value={manualId}
              onChangeText={setManualId}
              placeholder="请输入学号"
              placeholderTextColor={color.neutral[400]}
              style={{
                borderWidth: 1,
                borderColor: color.neutral[200],
                borderRadius: 8,
                paddingHorizontal: spacing.md,
                paddingVertical: spacing.sm,
                fontSize: 15,
                color: color.text.primary,
                backgroundColor: color.neutral[50],
              }}
            />
            <Spacer h={spacing.md} />
            <Button
              label={busy ? '保存中…' : '保存会话'}
              loading={busy}
              onPress={() => void saveSession(pending, manualId.trim())}
              disabled={manualId.trim().length < 4}
            />
          </Card>
        </Section>
        {msg ? (
          <Section>
            <Banner tone={msg.tone} title={msg.text} actionLabel="知道了" onAction={() => setMsg(null)} />
          </Section>
        ) : null}
      </ScreenScroll>
    );
  }

  /* ─────────── 进入前 ─────────── */
  if (!showWeb) {
    return (
      <ScreenScroll>
        <Section style={{ marginTop: spacing.sm }}>
          <Card>
            <Txt variant="body" weight="semibold">
              应用内登录
            </Txt>
            <Spacer h={spacing.sm} />
            <Txt variant="small" c={color.text.secondary} style={{ lineHeight: 19 }}>
              {`会打开${loginPageName}。你在里面正常登录即可 —— 支持短信验证码、动态码、微信登录。\n`}
              App 不会接触你的密码，学号会自动识别。
            </Txt>
            <Spacer h={spacing.md} />
            <Button label={`打开${loginPageName}`} onPress={() => void startLogin()} />
          </Card>
        </Section>

        {msg ? (
          <Section>
            <Banner tone={msg.tone} title={msg.text} actionLabel="知道了" onAction={() => setMsg(null)} />
          </Section>
        ) : null}
      </ScreenScroll>
    );
  }

  /* ─────────── WebView ─────────── */
  return (
    <View style={{ flex: 1, backgroundColor: color.background.secondary }}>
      {msg ? (
        <Pressable onPress={() => setMsg(null)}>
          <Banner tone={msg.tone} title={msg.text} />
        </Pressable>
      ) : null}

      {/*
        ★ 加载失败横幅（2026-10 加）。
        ⚠️ 只有 `loadErr` 非空才渲染 —— 正常加载时这里**完全不占高度**，
           不破坏"登录页只留登录口"的精简布局。
        ⚠️ 必须放在 WebView **上方**：失败时 WebView 只有一片白，
           用户要先看到原因和自救按钮，才知道下一步做什么。
      */}
      {loadErr ? (
        <View>
          <Banner
            tone="error"
            title="登录页没能打开"
            message={
              `地址：${loadErr.url}\n` +
              `原因：${loadErr.reason}\n` +
              '先确认手机能联网、站点选对；还是打不开，就用「用浏览器打开」试试。'
            }
          />
          <Row gap={spacing.sm} style={{ marginTop: spacing.sm, paddingHorizontal: spacing.base }}>
            <Button label="重试" onPress={retryLoad} style={{ flex: 1 }} />
            <Button
              label="用浏览器打开"
              variant="secondary"
              onPress={() => void openInBrowser()}
              style={{ flex: 1 }}
            />
          </Row>
        </View>
      ) : null}

      <WebView
        ref={webRef}
        source={{ uri: tenant.entryUrl }}
        /** 每次开始加载都清掉上一次的失败横幅，否则重试成功后旧错误会残留在页面上 */
        onLoadStart={() => setLoadErr(null)}
        /**
         * ★ 加载失败要说出原因（2026-10 加）。
         *   description 形如 `net::ERR_NAME_NOT_RESOLVED` / `net::ERR_CONNECTION_TIMED_OUT` ——
         *   这些正是判断"没网 / 域名解析失败 / 站点选错"最关键的证据。
         */
        onError={(e) => {
          const reason = e.nativeEvent?.description || `加载错误（code ${e.nativeEvent?.code ?? 0}）`;
          const url = e.nativeEvent?.url || tenant.entryUrl;
          setLoadErr({ url, reason });
          logFault(`[WebView登录] onError ${reason} url=${url}`, 'webLogin.onError');
        }}
        /** 服务器返回 4xx/5xx 时同样要说清状态码（页面可能是错误页而不是白屏） */
        onHttpError={(e) => {
          const code = e.nativeEvent?.statusCode ?? 0;
          const url = e.nativeEvent?.url || tenant.entryUrl;
          setLoadErr({ url, reason: `服务器返回 HTTP ${code}` });
          logFault(`[WebView登录] onHttpError HTTP ${code} url=${url}`, 'webLogin.onHttpError');
        }}
        /**
         * ★ 接收页面里注入的 JS 回传的 cookie。
         *   这是解决"网页已登录但 CookieManager 读到 0 个"的关键 ——
         *   WebView 与 CookieManager 是两套 cookie 存储（Android 已知问题）。
         */
        onMessage={(e) => void onWebViewMessage(e.nativeEvent.data ?? '')}
        onNavigationStateChange={onNav}
        onLoadEnd={() => setTimeout(() => void harvest(true), 900)}
        /**
         * ⚠️ 关键：把**所有**跳转都留在 WebView 内。
         *
         * 用户实测：点「校园统一身份认证登录」会跳到**系统浏览器**，
         * 登录完成后回到 App，WebView 里依然是空的 ——
         * 因为外部浏览器有它自己的 cookie，和 WebView 完全不共享。
         *
         * 所以这里拦截一切非 WebView 的跳转（自定义 scheme / 外链），
         * 用 injectJavaScript 在当前页面内导航，保证 cookie 落在同一个存储里。
         */
        onShouldStartLoadWithRequest={(req) => {
          const url = req.url ?? '';
          // about:blank 之类的内部导航直接放行
          if (url.startsWith('about:') || url.startsWith('data:') || url.startsWith('blob:')) return true;
          // http/https 一律在 WebView 内加载
          if (url.startsWith('http://') || url.startsWith('https://')) return true;

          // 其他 scheme（例如某些学校用的 App 唤起链接）：不交给系统，就地忽略
          logFault(`[WebView登录] 拦截外部跳转 ${url.slice(0, 120)}`, 'webLogin.shouldStart');
          return false;
        }}
        // 阻止 target="_blank" / window.open 弹到外部浏览器
        setSupportMultipleWindows={false}
        javaScriptCanOpenWindowsAutomatically={false}
        // ⚠️ CAS 换票链跨三个域名，必须允许第三方 cookie，否则链断
        thirdPartyCookiesEnabled
        sharedCookiesEnabled
        domStorageEnabled
        javaScriptEnabled
        // 让 WebView 用桌面 UA：与 CAS 返回静态表单的环境一致（不是必需，但更稳）
        startInLoadingState
        renderLoading={() => (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={color.primary[500]} />
            <Txt variant="small" c={color.text.tertiary} style={{ marginTop: spacing.sm }}>
              正在打开{loginPageName}…
            </Txt>
          </View>
        )}
        style={{ flex: 1 }}
      />
    </View>
  );
}

