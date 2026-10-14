/**
 * 应用根组件。
 *
 * 重要：这里**不使用 expo-router，也不使用任何原生导航库**。
 *
 * 原因：实测在鸿蒙（HarmonyOS）上，react-navigation 的原生栈
 * （由 react-native-screens 提供）会让界面白屏且完全无法操作，只能大退。
 * 崩溃发生在原生层，JS 的错误边界抓不到。
 * 华为开发者论坛有对应反馈：
 * https://developer.huawei.com/consumer/cn/forum/topic/0208225281800297243
 *
 * 因此改用 src/nav/ 下的纯 JS 路由（页面栈就是普通 React state）。
 */
import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { getServerBase } from './src/services/serverClient';
import { flushPendingReports } from './src/services/reportQueue';
import { UpdateProvider } from './src/state/updateStore';
import { UpdatePromptDialog } from './src/components/UpdatePromptDialog';
import { CheckinProvider } from './src/state/checkinStore';
import { DeliveryProvider } from './src/state/deliveryStore';
import { ModuleProvider } from './src/state/moduleStore';
import { LicenseProvider, useLicense } from './src/state/licenseStore';
import { SignProvider } from './src/state/signStore';
import { TaskProvider } from './src/state/taskStore';
import { UnlockProvider } from './src/state/unlockStore';
import { ErrorBoundary } from './src/components/ErrorBoundary';
import { RouterProvider } from './src/nav/router';
import { NavigationShell } from './src/nav/shell';
import { installCrashLogger, logFault } from './src/services/crashLog';
import { markStart, mark, markReady } from './src/services/startupTiming';
import { beginStartup, completeStartup, readStartupMark } from './src/services/startupGuard';

// 尽早安装全局崩溃兜底：未捕获的异常会写进本地日志，
// 用户可在「设置 → 崩溃日志」里读出来。release 白屏时这是唯一的线索来源。
installCrashLogger('root');
/**
 * ★★★ 启动守卫：写下"正在启动"标记（越早越好）。
 *
 * ⚠️ 用户实测：「就是刚点进软件退出去这种，崩溃日志没有」——
 *    没有日志说明**没走到 JS 层**（ANR 被系统杀掉 / 原生崩溃）。
 *    这个标记能在下次启动时告诉我们"上次没走完"，以及连续几次。
 *    详见 services/startupGuard.ts。
 */
void beginStartup();
/**
 * ★ 启动计时（必须在 installCrashLogger 之后）。
 *
 * 用户实测：「每次更新完再进去都会闪退，要隔一阵子才能进入」——
 * 那不是真崩，是**卡住要等**。但卡在哪一步光看代码猜不出来。
 * 这里打点，超过阈值就写进崩溃日志，下次直接能看到是哪一段慢。
 */
markStart();
mark('root-module-loaded');

/**
 * Provider 链（顺序有讲究）：
 *   CheckinProvider（提供账号 —— 校验解锁码需要学号）
 *     → UnlockProvider（一人一码的插件解锁）
 *       → LicenseProvider（旧的白名单体系，暂时保留兼容）
 *         → ModuleLayer（把授权校验器注入模块系统）
 *           → SignProvider / DeliveryProvider
 */
function ModuleLayer({ children }: { children: React.ReactNode }) {
  const { licensed, license } = useLicense();

  // 只有「签到」需要授权；其他模块不受影响
  const checkLicense = React.useCallback(
    (def: { key: string; requiresLicense?: boolean }) =>
      def.requiresLicense ? { granted: licensed, message: license.message } : undefined,
    [licensed, license.message],
  );

  return <ModuleProvider checkLicense={checkLicense}>{children}</ModuleProvider>;
}

export default function App() {
  /** ★ 启动计时：首帧渲染完成 */
  React.useEffect(() => {
    mark('first-render');
    /**
     * ★★★ 启动守卫：判断"上次启动有没有走完"。
     *
     * ⚠️ 为什么需要（用户反馈「早上点击软件会闪退几次」）：
     *    崩溃日志只能抓 **JS 层异常**，而
     *    **ANR（启动时 JS 线程阻塞太久 → 系统直接杀进程）走不到 JS 层，
     *    一条日志都没有** —— 用户看到的就是"点几次才进去"。
     *    靠这个标记才能知道"上次是异常结束的"，以及连续几次。
     *
     * 详见 services/startupGuard.ts。
     */
    void (async () => {
      try {
        const prev = await readStartupMark();
        if (prev) {
          logFault(
            `[启动异常] 上次启动未完成（连续第 ${prev.streak ?? 1} 次，版本 ${prev.version ?? '?'}）` +
              ' —— 可能被系统杀掉（ANR）或原生崩溃，JS 层无异常记录',
            'startup-guard',
          );
        }
        await completeStartup();
      } catch {
        /* 探测失败不该影响启动 */
      }
    })();
    /**
     * 再等一拍（下一帧）才算"界面真的可用了" ——
     * React 的 effect 在提交之后立刻跑，此时布局还没画完。
     */
    const t = setTimeout(() => markReady(), 0);
    return () => clearTimeout(t);
  }, []);

  /**
   * ★ 启动时补发积压的上报。
   *
   * 管理员的需求原话：「不是实时管理，需要的时候刷新一下」——
   * 也就是他的服务器可能几天没开。那段时间里别人登录的记录
   * 会先存在本机（见 services/reportQueue.ts），现在补发出去。
   *
   * ⚠️ 延后 3 秒再发：启动瞬间要读一堆本地存储、拉起界面，
   *    这时候插网络请求会拖慢冷启动。补发不着急。
   * ⚠️ 失败不提示 —— 静默留着，下次启动再试，不给用户添噪音。
   */
  React.useEffect(() => {
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const base = await getServerBase();
          if (!base) return;
          await flushPendingReports(base);
        } catch {
          /* 补发失败无所谓，下次启动再来 */
        }
      })();
    }, 3000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <SafeAreaProvider>
      <CheckinProvider>
        <UnlockProvider>
          <LicenseProvider>
            <ModuleLayer>
              <SignProvider>
                <TaskProvider>
                  <DeliveryProvider>
                    {/*
                      ★ UpdateProvider 放在最外层附近：
                      "有没有新版本"是全局信息，首页和设置页都要能读。
                      位置无所谓依赖（它只依赖 serverClient），
                      放这里是为了让下面的每个页面都能 useUpdate()。
                    */}
                    <UpdateProvider>
                      <StatusBar style="dark" />
                      <ErrorBoundary>
                        <RouterProvider>
                          <NavigationShell />
                          {/*
                            ★ 启动弹窗挂在这里（而不是某个页面里）——
                            它需要在**任何页面之上**弹出，且只弹一次。
                            放页面里的话，用户切到别的 tab 就看不到了。
                            显示与否由 updateStore 的 promptVisible 决定：
                            查到新版本且用户没关过这一版才弹。
                          */}
                          <UpdatePromptDialog />
                        </RouterProvider>
                      </ErrorBoundary>
                    </UpdateProvider>
                  </DeliveryProvider>
                </TaskProvider>
              </SignProvider>
            </ModuleLayer>
          </LicenseProvider>
        </UnlockProvider>
      </CheckinProvider>
    </SafeAreaProvider>
  );
}
