/**
 * 二级页面注册表 —— 路径 → 组件 + 标题。
 *
 * 每个页面组件都是普通 React 组件，读取参数用 useLocalSearchParams()。
 * 外层壳（header / 参数作用域 / 入场动画）由 NavigationShell 统一提供。
 */
import React from 'react';
import type { RoutePath, RouteParams } from './router';
import { useNavigation } from './router';
import { SettingsScreen } from '../screens/settings';
import { ProfileScreen } from '../screens/profile';
import { ScheduleScreen } from '../screens/schedule';
import { TodoScreen } from '../screens/todo';
import { YouxueBindScreen } from '../screens/youxue-bind';
import { YouxueWebLoginScreen } from '../screens/youxue-web-login';
import { YouxueTaskScreen } from '../screens/youxue-task';
import { XiaoCaoScreen } from '../screens/xiaocao';
import { SignQrScreen } from '../screens/sign-qr';
import { SignLocationScreen } from '../screens/sign-location';
import { CourseLocationScreen } from '../screens/course-location';
import { SignOneshotScreen } from '../screens/sign-oneshot';
import { CheckinManualScreen } from '../screens/checkin-manual';
import { CheckinLogScreen } from '../screens/checkin-log';
import { ModulesScreen } from '../screens/modules';
import { LicenseScreen } from '../screens/license';
import { DiagnosticsScreen } from '../screens/diagnostics';
import { DianBuZhongScreen } from '../screens/dianbuzhong';
import { ServerAdminScreen } from '../screens/server-admin';
import { VoteHomeworkScreen } from '../screens/vote-homework';
import { VoteListScreen } from '../screens/vote-list';
import { ClassroomIdsScreen } from '../screens/classroom-ids';
import { LicensedScreen } from '../components/LicensedScreen';

export interface PushedScreenDef {
  title: string;
  Component: React.ComponentType<{ params: RouteParams; isTop: boolean }>;
}

/**
 * 应用内登录页需要 onDone（登录完成后回上一页）。
 * 直接包一层，避免为一个回调把注册表类型搞复杂。
 */
function WebLoginWrapper({ params }: { params: RouteParams; isTop: boolean }) {
  const { back } = useNavigation();
  return <YouxueWebLoginScreen onDone={back} />;
}

/**
 * ★★ 给「签到类」页面统一加**授权码门槛**（路由层）。
 *
 * ══════════════ ⚠️ 这是补一个我自己造成的漏洞 ══════════════
 *
 * 原先门槛只挂在 `/checkin`（自动签到设置页）上，
 * 而 `/sign-qr`（签到记录列表）等页面**自己没有门槛** ——
 * 它们靠"必须先过 /checkin 才跳进来"这条链间接受保护：
 *
 *     小操作 → /checkin（有门槛）→ /sign-qr
 *
 * 后来按用户要求把 `/checkin` **整个删掉**，链路变成：
 *
 *     小操作 → /sign-qr        ← ❌ 门槛没了！
 *
 * 于是**没有授权码的人也能用签到**（改状态走的是教师接口，
 * 服务端不校验"改的是不是自己"，所以这道闸是唯一的防线）。
 *
 * 修法：把门槛提到**路由层**，所有签到类页面统一包一层。
 * 好处：
 *   · 不必给每个页面文件都加一遍（漏一个就是漏洞，刚才就漏了六个）
 *   · 以后新增签到类页面，加进这个集合就自动受保护
 *   · 即使有人直接 push 路由也拦得住（不依赖"从哪个入口进来"）
 */
function licensed(Component: PushedScreenDef['Component']): PushedScreenDef['Component'] {
  return function Licensed({ params, isTop }) {
    return (
      <LicensedScreen>
        <Component params={params} isTop={isTop} />
      </LicensedScreen>
    );
  };
}

export const PUSHED_SCREENS: Record<RoutePath, PushedScreenDef> = {
  '/settings': { title: '设置', Component: SettingsScreen },
  '/profile': { title: '我的', Component: ProfileScreen },
  '/schedule': { title: '日程', Component: ScheduleScreen },
  '/todo': { title: '待办', Component: TodoScreen },
  '/youxue-bind': { title: '优学院设置', Component: YouxueBindScreen },
  '/youxue-web-login': { title: '应用内登录', Component: WebLoginWrapper },
  '/youxue-task': { title: '任务查询', Component: YouxueTaskScreen },
  /**
   * ★「小操作」—— 优学院下的二级页，与「任务查询」同级。
   * 授权门槛由 XiaoCaoScreen 内部套的 LicensedScreen 负责。
   */
  '/xiaocao': { title: '小操作', Component: XiaoCaoScreen },
  /**
   * ══════════ ★★ 签到类页面 —— 全部经过授权码门槛 ══════════
   * 用 `licensed(...)` 包一层。新增签到类页面时务必也包上，
   * 否则就是"没授权码也能用"的漏洞（这个坑踩过一次，见上面 licensed 的注释）。
   */
  '/sign-qr': { title: '签到记录', Component: licensed(SignQrScreen) },
  '/sign-location': { title: '地点签到', Component: licensed(SignLocationScreen) },
  /**
   * ★ 课程签到位置设置（地图围范围，2026-10 新增）
   *
   * ⚠️ 它是**签到类**页面（设置之后会影响定位签到提交什么坐标），
   *    所以必须和别的签到页一样过 `licensed(...)` 授权码门槛。
   */
  '/course-location': { title: '设置签到位置', Component: licensed(CourseLocationScreen) },
  '/sign-oneshot': { title: '一键签到', Component: licensed(SignOneshotScreen) },
  /**
   * ⚠️ `/checkin`（自动签到设置页）**已删除** ——
   *    用户明确说「不要自动签到」，所以那个页面（开关 / 策略 /
   *    单日上限 / 立即检测 / 演示面板）整页拿掉了。
   *
   *    底层 `checkinStore` 仍保留：
   *      · signStore / taskStore / unlockStore / licenseStore 都从它取 `account`
   *      · 轮询受 `autoEnabled` 闸住（`if (!account || !s.autoEnabled) return`），
   *        **不去开就永远不会自动跑**，所以留着是惰性的，无害
   */
  '/checkin-manual': { title: '手动签到', Component: licensed(CheckinManualScreen) },
  '/checkin-log': { title: '签到日志', Component: licensed(CheckinLogScreen) },
  '/modules': { title: '功能模块', Component: ModulesScreen },
  '/license': { title: '签到授权', Component: LicenseScreen },
  '/diagnostics': { title: '诊断信息', Component: DiagnosticsScreen },
  /**
   * ══════════════ ★★★ 这里删掉了两页 ══════════════
   *
   * 用户要求（2026-10）：
   *   「帮我把小操作里的接口测试器和崩溃日志还有签到功能里的接口测试删掉」
   *
   * 删掉的是：
   *   · `/crash-log`  （崩溃日志页面）
   *   · `/api-tester` （接口测试器页面）
   *
   * ⚠️ **底层能力没有删**：
   *   · `crashLog.ts` 的 `logFault()` 仍被 9 个模块调用，崩了照样记录到磁盘
   *     （只是界面上不再给查看入口；要看用 /diagnostics）
   *   · `signApi.ts` 里的探测函数（probeTeacherSignShape 等）仍在，
   *     因为它们也被正规流程用到，删了会影响签到
   *
   * → 也就是说：删的是"**给自己排查用的界面**"，不是"排查能力本身"。
   */
  /** ★ 点不中 —— 只碰 /apps/selectperson/*，不碰考勤 */
  '/dianbuzhong': { title: '点不中', Component: DianBuZhongScreen },
  /**
   * ★ 服务器用户管理 —— 踢出账号 / 停用（2026-10）
   *
   * ⚠️ 不套 `licensed()`（授权码门槛）：它管的是"服务器上的账号名单"，
   *    不是签到功能；真正的门槛是 **HTTP Basic 管理口令**（只在页面内存里）。
   */
  '/server-admin': { title: '服务器用户管理', Component: ServerAdminScreen },
  /**
   * ★ 「作业 / 投票」接口探测（2026-10 新增）
   *
   * ⚠️ 不套 `licensed()`：它唯一的入口是「小操作」（XiaoCaoScreen 内部已套
   *    LicensedScreen），而且它用的 `sign.actions.rawApi` 自己就过授权闸，
   *    没有授权码发不出请求。所以这里只注册，不重复加门槛。
   * ⚠️ 只读页面：只发 GET，不会提交作业 / 投票。
   */
  '/vote-homework': { title: '作业 / 投票', Component: VoteHomeworkScreen },
  /**
   * ★ 「投票 / 答题」真实功能页（2026-10）
   *
   * ⚠️ 只在活动**进行中**允许提交；已结束只能看（事后补交不做）。
   * ⚠️ 同样不套 licensed()：入口在「小操作」（已有 LicensedScreen），
   *    而且提交走 rawApi（自带授权闸），没有码发不出去。
   */
  '/vote-list': { title: '投票 / 答题', Component: VoteListScreen },
  /**
   * ★ 「课堂 id」查询（2026-10）
   *
   * 投票/答题按课堂组织，但优学院不直接显示课堂 id。
   * 这页把签到记录按课程分组，列出每门课用过的全部课堂 id。
   */
  '/classroom-ids': { title: '课堂 id', Component: ClassroomIdsScreen },
};
