/**
 * 更新状态（全局）。
 *
 * ══════════════ 为什么要一个 store ══════════════
 * 更新涉及好几步（检查 → 询问 → 下载 → 安装）且要跨页面显示：
 *   · 首页/设置页都可能要提示"有新版本"
 *   · 下载进度要持续显示，不能因为切页面就丢
 * 散在各页面里会互相打架（重复下载、状态不同步），所以集中在这里。
 *
 * ══════════════ 两种触发方式 ══════════════
 *   ① App 启动后**静默检查**（延迟几秒，不拖慢冷启动）
 *      → 有新版才提示，没有就什么都不做
 *   ② 设置页**手动检查**（用户主动点，要给出明确反馈）
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { store, STORE_KEYS } from '../services/storage';
import { logFault } from '../services/crashLog';
import { checkUpdate, currentVersion, downloadApk, fmtSize, installApk, type UpdateInfo } from '../services/updater';

export type UpdatePhase =
  | 'idle' // 什么都不知道
  | 'checking' // 正在问服务器
  | 'uptodate' // 已是最新
  | 'available' // 有新版本，等用户决定
  | 'downloading' // 下载中
  | 'installing' // 已交给系统安装器
  | 'error';

interface UpdateState {
  phase: UpdatePhase;
  info: UpdateInfo | null;
  /** 下载进度 0-1 */
  progress: number;
  /** 出错信息（面向用户，不是错误码） */
  error: string | null;
  /** 当前安装的版本，供界面显示 */
  current: { version: string; versionCode: number };
  /** 这次是用户主动点的吗（决定"已是最新"要不要提示） */
  manual: boolean;
  /**
   * ★ 启动弹窗要不要显示。
   *
   * 需求：「如果有新版本那么在刚进去的时候就有弹窗检查更新……
   *        弹窗可以关闭，以免应急」
   *
   * 所以：查到新版本 → 弹；用户关掉 → 本次启动不再弹，
   * 但**首页那个板块还在**，他随时能自己点。
   */
  promptVisible: boolean;
  /**
   * ★★★ 强制更新（服务端 `version.json` 的 `force: true`）。
   *
   * 用户需求（原话）：
   *   「这次更新要设置为强制更新，有人要用我的诊断工具」
   *
   * 背景：1.1.1 之前的包带着「接口测试器」（能对任意 /apps/... 发
   * POST/DELETE、改真实数据）。只要不强制，装了旧包的人不点更新就能一直用。
   *
   * ⚠️ 为 true 时：
   *   · 更新弹窗**关不掉**（`dismiss` / `dismissPrompt` 直接忽略）
   *   · 也不受"关过的版本不再弹"影响（必须能反复弹）
   */
  forceUpdate: boolean;
  /**
   * ★ "连的是哪台服务器" 的展示文案（例如 `已连接：云端`）。
   *
   * ⚠️ 为什么单独存一个字段、而不是从 `info` 里取：
   *    "已是最新版本"时 `info` 会被**清空**（见 check() 里的 uptodate 分支），
   *    那一刻恰好是用户最想确认"我连上服务器了吗"的时候 ——
   *    如果跟着 info 一起没了，就白加了。
   */
  serverText: string;
}

interface UpdateActions {
  /** 检查更新。manual=true 时会把"已是最新"也报出来 */
  check(manual?: boolean): Promise<void>;
  /** 下载并调起安装 */
  downloadAndInstall(): Promise<void>;
  /** 关掉提示（首页横幅/错误提示用） */
  dismiss(): void;
  /** 关掉启动弹窗 —— 记住"这个版本的弹窗我关过了" */
  dismissPrompt(): void;
}

const Ctx = createContext<(UpdateState & { actions: UpdateActions }) | null>(null);

const INITIAL: UpdateState = {
  phase: 'idle',
  info: null,
  progress: 0,
  error: null,
  current: { version: '?', versionCode: 0 },
  manual: false,
  promptVisible: false,
  forceUpdate: false,
  serverText: '',
};

/**
 * 把服务端回的主机名转成一句人话。
 *
 * ══════════════ 为什么要"翻译"而不是直接显示主机名 ══════════════
 * 有两台服务器在跑同一套代码：
 *   · 阿里云那台 → 主机名形如 `iZwz9cni4uro1ctp2jt3vdZ`（阿里云自动生成的）
 *   · 宿舍局域网那台 → 就是你这台电脑的名字
 *
 * 直接显示 `iZwz9cni4uro1ctp2jt3vdZ` 用户看不懂。所以：
 *   · 主机名以 `iZ` 开头（阿里云实例的命名惯例）→ 认成「云端」
 *   · 其余 → 当作「本机/局域网」
 *   · 没有 server 字段（旧版服务端）→ 不显示，不要瞎猜
 */
function serverLabel(host: string | undefined): string {
  if (!host) return '';
  if (/^iZ/i.test(host)) return '已连接：云端服务器';
  return `已连接：${host}`;
}

export function UpdateProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<UpdateState>(INITIAL);
  /** 防止并发检查（用户狂点 / 启动检查与手动检查撞上） */
  const busyRef = useRef(false);
  /**
   * ★ 已关掉弹窗的版本号。
   *
   * ══════════════ 为什么记的是"版本号"而不是一个布尔 ══════════════
   * 如果只记"关过了"（布尔），那用户关掉 0.17 的弹窗之后，
   * 我发 0.18 他就**再也看不到弹窗**了 —— 会漏掉更新。
   *
   * 记版本号就不会：
   *   关掉 85 → 服务器出了 86 → 86 !== 85 → 重新弹 ✅
   */
  const dismissedRef = useRef<number | null>(null);

  useEffect(() => {
    setState((s) => ({ ...s, current: currentVersion() }));
    // 读回上次关掉的版本号
    void (async () => {
      try {
        const v = await store.get<number | null>(STORE_KEYS.updatePromptDismissed, null);
        dismissedRef.current = typeof v === 'number' ? v : null;
      } catch {
        dismissedRef.current = null;
      }
    })();
  }, []);

  const check = useCallback(async (manual = false) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setState((s) => ({ ...s, phase: 'checking', error: null, manual }));
    try {
      const r = await checkUpdate();
      if (!r.ok) {
        /**
         * ⚠️ 连不上服务器 → **静默失败**。
         *    绝不能因为"检查更新失败"在启动时弹个错 —— 那太吵，
         *    而且和用户要做的事无关。只有手动检查才告诉他原因。
         */
        setState((s) => ({
          ...s,
          phase: manual ? 'error' : 'idle',
          error: manual ? `检查失败：${r.error}` : null,
        }));
        return;
      }
      if (!r.info) {
        setState((s) => ({
          ...s,
          phase: 'uptodate',
          info: null,
          progress: 0,
          error: null,
          promptVisible: false,
          /** ★ "已是最新"时也要显示连的是哪台 —— 这正是用户想确认的时刻 */
          serverText: serverLabel(r.server) || s.serverText,
        }));
        return;
      }
      /**
       * ★ 有新版本 → 决定要不要弹启动弹窗。
       *
       * ⚠️ 只有**自动检查**（启动那次）才弹：
       *    手动点了"检查更新"是用户主动的行为，他已经在看这一页了，
       *    再弹个窗很莫名其妙。
       *
       * ⚠️ 关过的版本不重复弹（同一次启动内也不重复 —— 靠 promptVisible 复位）。
       *
       * ⚠️⚠️ **强制更新时无视上面两条**（用户 2026-10：
       *      「这次更新要设置为强制更新，有人要用我的诊断工具」）：
       *      如果强制还允许"关过就不再弹"，那关一次就绕过去了 —— 等于没强制。
       */
      const forced = r.info.force === true;
      const shouldPrompt = forced || (!manual && dismissedRef.current !== r.info.versionCode);
      setState((s) => ({
        ...s,
        phase: 'available',
        info: r.info,
        progress: 0,
        error: null,
        promptVisible: shouldPrompt,
        forceUpdate: forced,
        serverText: serverLabel(r.server) || s.serverText,
      }));
    } catch (e) {
      logFault(`[更新] 检查异常：${(e as Error).message}`, 'updateStore.check');
      setState((s) => ({ ...s, phase: manual ? 'error' : 'idle', error: manual ? (e as Error).message : null }));
    } finally {
      busyRef.current = false;
    }
  }, []);

  const downloadAndInstall = useCallback(async () => {
    const info = state.info;
    if (!info) return;
    // 开始装了就把弹窗收起来，别挡着看进度
    setState((s) => ({ ...s, phase: 'downloading', progress: 0, error: null, promptVisible: false }));

    let localUri = '';
    try {
      localUri = await downloadApk(info, (ratio) => setState((s) => ({ ...s, progress: ratio })));
    } catch (e) {
      logFault(`[更新] 下载失败：${(e as Error).message}`, 'updateStore.download');
      setState((s) => ({ ...s, phase: 'error', error: `下载失败：${(e as Error).message}` }));
      return;
    }

    setState((s) => ({ ...s, phase: 'installing', progress: 1 }));
    try {
      await installApk(localUri);
      /**
       * 走到这里说明系统安装器**已经打开**了。
       * 之后用户点"安装"、装完 App 会重启 —— 我们这边不用再做什么。
       */
    } catch (e) {
      const msg = (e as Error).message;
      logFault(`[更新] 调起安装器失败：${msg}`, 'updateStore.install');
      /**
       * ⚠️ 这是**最常见**的失败，而且错误信息（ActivityNotFound 之类）
       *    对用户毫无意义。翻译成能照做的指引。
       */
      setState((s) => ({
        ...s,
        phase: 'error',
        error:
          `没能打开安装界面。\n\n` +
          `最常见的原因是：系统还没允许这个 App「安装未知应用」。\n` +
          `请到「设置 → 应用 → LifeKit → 安装未知应用」里打开开关，然后重试。\n\n` +
          `（原始错误：${msg}）`,
      }));
    }
  }, [state.info]);

  const dismiss = useCallback(() => {
    /**
     * ⚠️ 强制更新时**不允许**收起来 —— 否则用户一关就绕过去了，等于没强制。
     *    用户原话：「这次更新要设置为强制更新，有人要用我的诊断工具」。
     */
    if (state.forceUpdate) return;
    setState((s) => ({ ...s, phase: 'idle', info: null, error: null, progress: 0, promptVisible: false }));
  }, [state.forceUpdate]);

  /**
   * 关掉启动弹窗。
   *
   * ⚠️ 只影响**弹窗**，不影响首页那个板块 ——
   *    需求原话：「弹窗可以关闭，以免应急」，
   *    关掉是为了"现在没空、别挡着我"，不是"我不想更新了"。
   *    所以首页的提示必须留着，让他回头还能找到。
   *
   * ⚠️ 强制更新时这个函数**什么都不做**：
   *    而且要连"记下已关闭的版本号"一起跳过 ——
   *    否则一旦被写进存储，下次启动"关过的版本不再弹"那条会把强制也吃掉。
   */
  const dismissPrompt = useCallback(() => {
    if (state.forceUpdate) return;
    const code = state.info?.versionCode ?? null;
    dismissedRef.current = code;
    if (code !== null) {
      void store.set(STORE_KEYS.updatePromptDismissed, code);
    }
    setState((s) => ({ ...s, promptVisible: false }));
  }, [state.info, state.forceUpdate]);

  /**
   * ★ 启动后静默检查。
   *
   * ⚠️ 延后 6 秒：启动瞬间要读本地存储、拉起界面，
   *    这时候插一个网络请求会拖慢冷启动。检查更新不着急。
   *    （比补发上报的 3 秒再晚一点，两者错开。）
   *
   * ⚠️ 这里是 `check(false)`（非手动）—— 只有它会弹启动弹窗。
   */
  useEffect(() => {
    const t = setTimeout(() => {
      void check(false);
    }, 6000);
    return () => clearTimeout(t);
  }, [check]);

  const actions = useMemo<UpdateActions>(
    () => ({ check, downloadAndInstall, dismiss, dismissPrompt }),
    [check, downloadAndInstall, dismiss, dismissPrompt],
  );

  const value = useMemo(() => ({ ...state, actions }), [state, actions]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUpdate() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useUpdate 必须在 UpdateProvider 内使用');
  return ctx;
}

export { fmtSize };
