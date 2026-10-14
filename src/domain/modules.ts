/**
 * 功能模块注册表（插件化）。
 *
 * 设计三原则（按用户选择）：
 * 1. **按平台能力自动过滤** —— iOS 上"外卖自动记录"根本不会出现在模块栏
 * 2. **用户选择优先于平台能力** —— 用户主动开的，即使平台不支持也保留（但会标注不可用）
 * 3. **模块自己声明所需权限** —— 缺权限时提示而不是报错
 */
import { Platform } from 'react-native';

export type ModuleKey =
  | 'youxue'
  | 'delivery'
  | 'course'
  | 'todo'
  | 'stats'
  | 'schedule'
  | 'qr-tool'
  | 'exam';

export type PermKey = 'notification' | 'camera' | 'location' | 'notificationAccess';

export const PERM_LABEL: Record<PermKey, string> = {
  notification: '发送通知',
  camera: '相机',
  location: '定位',
  notificationAccess: '通知使用权（读取外卖订单通知）',
};

export type PlatformKey = 'ios' | 'android' | 'web';

export interface ModuleDef {
  key: ModuleKey;
  label: string;
  glyph: string;
  tint: string;
  /** 一句话说明（模块管理页展示） */
  summary: string;
  /** 支持的平台；不在其中的平台直接隐藏 */
  platforms: PlatformKey[];
  /** 需要的能力 */
  permissions: PermKey[];
  /** 是否允许用户在设置里关闭 */
  userToggleable: boolean;
  /** 默认是否启用 */
  defaultEnabled: boolean;
  /**
   * 是否需要授权（白名单）才能使用。
   * 目前只有「签到」需要 —— 授权由远程名单控制，有效期到期自动失效。
   */
  requiresLicense?: boolean;
  /** 不可用时的替代方案说明（给用户看的） */
  fallbackHint?: string;
}

export const MODULES: ModuleDef[] = [
  {
    /**
     * ══════════════ ★ 2026-10 结构调整（用户要求）══════════════
     * 「小操作类与任务查询同级，都归于优学院类」
     *
     * 所以：
     *   优学院（本模块）
     *     ├─ 任务查询      ← 不需要授权
     *     └─ 小操作        ← **需要授权码**，里面是：签到 / 加减分 / 点不中
     *
     * ⚠️ 因此这里**没有** `requiresLicense` ——
     *    因为门槛只该管「小操作」，而 `requiresLicense` 是**整模块**生效的
     *    （见 computeModuleRuntime）。挂在这里会让「任务查询」也被拦住，
     *    而任务查询是本来就该能用的。
     *
     *    门槛改由 `screens/checkin.tsx` 上的 `<LicensedScreen>` 承担 ——
     *    它读的是 `useUnlock().entitled`（**授权码**机制，本地校验 + 服务端确认），
     *    与模块定义无关。
     */
    key: 'youxue',
    label: '优学院',
    glyph: '🎓',
    tint: '#4F46E5',
    summary: '任务查询（作业 / 课件）与小操作（签到 / 加减分 / 点不中）',
    platforms: ['android', 'ios'],
    permissions: [],
    userToggleable: true,
    /**
     * ⚠️ **默认锁定**。
     * 需求：优学院整体默认关闭，需要在「设置 → 功能模块」里手动开启；
     * 开启前，首页不显示入口、底部栏也不出现这一页。
     */
    defaultEnabled: false,
  },
  {
    key: 'delivery',
    label: '外卖',
    glyph: '🍜',
    tint: '#F59E0B',
    summary: '自动记录你在哪个平台点过哪家店、点过几次',
    platforms: ['android'],
    permissions: ['notificationAccess'],
    userToggleable: true,
    defaultEnabled: true,
    fallbackHint:
      'iOS 系统不允许第三方 App 读取其他 App 的通知，所以无法自动记录。可以手动记一笔，或从外卖 App 复制订单信息后粘贴识别。',
  },
  {
    key: 'course',
    label: '课程',
    glyph: '▤',
    tint: '#6366F1',
    summary: '课表与课程签到统计',
    platforms: ['android', 'ios'],
    permissions: [],
    userToggleable: true,
    defaultEnabled: true,
  },
  {
    key: 'schedule',
    label: '日程',
    glyph: '▦',
    tint: '#818CF8',
    summary: '周视图日程与上课时间线',
    platforms: ['android', 'ios'],
    permissions: [],
    userToggleable: true,
    defaultEnabled: true,
  },
  {
    key: 'todo',
    label: '待办',
    glyph: '☑',
    tint: '#6366F1',
    summary: '待办事项与优先级管理',
    platforms: ['android', 'ios'],
    permissions: [],
    userToggleable: true,
    defaultEnabled: true,
  },
  {
    key: 'stats',
    label: '统计',
    glyph: '◔',
    tint: '#6B7280',
    summary: '签到与外卖的汇总数据',
    platforms: ['android', 'ios'],
    permissions: [],
    userToggleable: true,
    defaultEnabled: true,
  },
  {
    key: 'qr-tool',
    label: '二维码',
    glyph: '▩',
    tint: '#0EA5E9',
    summary: '本地生成与识别二维码',
    platforms: ['android', 'ios'],
    permissions: ['camera'],
    userToggleable: true,
    defaultEnabled: false,
  },
  {
    key: 'exam',
    label: '考试',
    glyph: '✎',
    tint: '#EF4444',
    summary: '考试安排与提醒（规划中）',
    platforms: ['android', 'ios'],
    permissions: ['notification'],
    userToggleable: true,
    defaultEnabled: false,
  },
];

export function currentPlatform(): PlatformKey {
  if (Platform.OS === 'ios') return 'ios';
  if (Platform.OS === 'android') return 'android';
  return 'web';
}

export function getModule(key: string): ModuleDef | undefined {
  return MODULES.find((m) => m.key === key);
}

/** 该模块在当前平台是否受支持 */
export function isPlatformSupported(def: ModuleDef, platform: PlatformKey = currentPlatform()): boolean {
  return def.platforms.includes(platform);
}

export function unsupportedReason(def: ModuleDef, platform: PlatformKey = currentPlatform()): string | undefined {
  if (isPlatformSupported(def, platform)) return undefined;
  return def.fallbackHint ?? `${def.label} 不支持当前平台（${platform}）`;
}

/** 已授予的能力 */
export type GrantedPerms = Partial<Record<PermKey, boolean>>;

/** 该模块是否还有未授予的权限 */
export function missingPerms(def: ModuleDef, granted: GrantedPerms): PermKey[] {
  return def.permissions.filter((p) => !granted[p]);
}

// ---------------- 可见性与启用状态计算 ----------------

export interface ModuleRuntime {
  def: ModuleDef;
  /** 平台是否支持 */
  platformSupported: boolean;
  /** 用户是否启用（用户选择优先） */
  userEnabled: boolean;
  /** 未授予的权限 */
  missing: PermKey[];
  /** 平台支持 + 权限齐备 */
  platformReady: boolean;
  /**
   * 最终是否显示在模块栏。
   * 规则：用户主动开的**一定显示**（即使平台不支持，也好让用户知道为什么不能用）；
   *       用户没主动开、但平台不支持 → 隐藏。
   */
  visible: boolean;
  /**
   * 是否可正常使用 = 平台支持 + 用户启用 + 授权通过。
   * 注意：`requiresLicense` 的模块（签到）即使平台支持、用户开启，
   * 没有授权也**不可用** —— 但模块仍显示，好让用户看到原因。
   */
  usable: boolean;
  /** 需要授权时的授权状态 */
  license?: { required: boolean; granted: boolean; message?: string };
}

/** 授权查询函数：给出某模块的授权状态 */
export type LicenseChecker = (def: ModuleDef) => { granted: boolean; message?: string } | undefined;

export function computeModuleRuntime(
  def: ModuleDef,
  cfg: { enabled: string[]; disabled: string[] },
  granted: GrantedPerms = {},
  platform: PlatformKey = currentPlatform(),
  checkLicense?: LicenseChecker,
): ModuleRuntime {
  const platformSupported = isPlatformSupported(def, platform);
  const explicitlyEnabled = cfg.enabled.includes(def.key);
  const explicitlyDisabled = cfg.disabled.includes(def.key);

  // 用户选择优先：显式开的算开；显式关的算关；都没有则看默认值
  const userEnabled = explicitlyEnabled ? true : explicitlyDisabled ? false : def.defaultEnabled;

  const missing = missingPerms(def, granted);

  // 授权校验（目前只有签到需要）
  let license: ModuleRuntime['license'];
  let licenseOk = true;
  if (def.requiresLicense && checkLicense) {
    const res = checkLicense(def);
    if (res) {
      license = { required: true, granted: res.granted, message: res.message };
      licenseOk = res.granted;
    }
  }

  return {
    def,
    platformSupported,
    userEnabled,
    missing,
    platformReady: platformSupported && missing.length === 0,
    // 用户主动开的即使平台不支持也显示（便于解释原因）；否则按平台能力过滤
    visible: userEnabled && (platformSupported || explicitlyEnabled),
    usable: userEnabled && platformSupported && licenseOk,
    license,
  };
}

/** 计算所有模块的运行时状态，按注册顺序返回 */
export function computeAllModules(
  cfg: { enabled: string[]; disabled: string[] },
  granted: GrantedPerms = {},
  platform: PlatformKey = currentPlatform(),
  checkLicense?: LicenseChecker,
): ModuleRuntime[] {
  return MODULES.map((def) => computeModuleRuntime(def, cfg, granted, platform, checkLicense));
}

/** 只取要在模块栏显示的 */
export function visibleModules(
  cfg: { enabled: string[]; disabled: string[] },
  granted: GrantedPerms = {},
  platform: PlatformKey = currentPlatform(),
  checkLicense?: LicenseChecker,
): ModuleRuntime[] {
  return computeAllModules(cfg, granted, platform, checkLicense).filter((r) => r.visible);
}
