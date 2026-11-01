/**
 * 构建配置 —— 决定 App 连真实优学院还是跑本地假数据。
 *
 * ══════════ 为什么不用 process.env ══════════
 * 踩过的坑：原本用 `process.env.EXPO_PUBLIC_YOUXUE_ADAPTER`，
 * 但**实测在 release 构建里这个变量没有被内联**：
 *   - 包内确认没有 process.env 残留（看起来像被替换了）
 *   - 但运行时的诊断页显示适配器仍然是 'mock'
 *   → 也就是变量值根本没传进去，代码退回了默认值。
 *
 * 结果非常隐蔽：App 能启动、绑定还"成功"（mock 适配器不验密码），
 * 但所有数据都是假的，而且没有任何报错。为此浪费了好几轮排查。
 *
 * ══════════ 现在的做法 ══════════
 * 把配置**直接写在源码里**，不经过任何环境变量机制：
 *   - 编译期一定生效（就是普通常量）
 *   - 一眼能看到当前构建是什么模式
 *   - 打包脚本会校验（见 tools/android/wire-native.cjs）
 *
 * 要切回 mock 演示模式，把 ADAPTER 改成 'mock' 即可。
 */
import Constants from 'expo-constants';

/** 优学院数据来源 */
export type AdapterKind = 'mock' | 'youxue';

/**
 * ⚠️ 唯一需要改的地方。
 *
 * 'youxue' —— 连真实优学院（正常使用必须是这个）
 * 'mock'   —— 本地假数据，仅用于没有账号时演示 UI
 *
 * 类型标注为 AdapterKind 而不是字面量，
 * 否则 isMock 那行会被 TS 判成"永远为假"的比较。
 */
const ADAPTER: AdapterKind = 'youxue';

/** 租户（决定域名与适配器实现） */
const TENANT = 'dgut';

/**
 * ⚠️ 这几个域名**只是"默认站点"的快照**，不再作为运行时真值。
 *
 * ══════════════ ★★★ 多站点改造（2026-10）══════════════
 *
 * 用户需求：「现在有一个优学院走的中国站点不是东莞理工站点的，怎么改」
 *
 * 原来这里是**唯一**的域名来源 → 全 App 只能连东莞理工。
 * 现在真正的站点定义在 `src/config/sites.ts`，运行时取
 * `getCurrentSite()`（用户可在登录页选中国站）。
 *
 * 保留这个字段的原因：
 *   · 打包自检脚本（tools/android/wire-native.cjs）会打印/校验它
 *   · 有些诊断工具需要"打包默认值"作为对照
 *
 * ⚠️ 新代码**不要**再从这里取域名，请用 `getCurrentSite().services.*`
 *    或 `resolvePath(站点, 路径)`。
 */
const HOSTS = {
  lms: 'https://lms.dgut.edu.cn',
  app: 'https://application.dgut.edu.cn',
  auth: 'https://auth.dgut.edu.cn',
};

export const BUILD_CONFIG = {
  /** 数据来源 */
  adapter: ADAPTER,
  tenant: TENANT,
  hosts: HOSTS,
  /** App 版本（来自 app.json，只用于显示与自检） */
  version: Constants.expoConfig?.version ?? '(未知)',
  versionCode: Constants.expoConfig?.android?.versionCode ?? -1,
  /** 是否跑假数据（用 String() 包一层，避免 TS 把字面量比较判成恒假） */
  isMock: String(ADAPTER) === 'mock',
  /**
   * 是否为测试版（版本号带 `-test`，例如 `1.1.7-test.46`）。
   *
   * ★ 为什么用版本号判断，而不是 env / 渠道变量：
   *   本项目踩过坑 —— `EXPO_PUBLIC_*` 在 release 构建里不会被内联，
   *   运行时拿到 undefined，代码静默退回默认值（见本文件开头的记录）。
   *   而 `app.json` 的 version 一定会被 Expo 注入到 expoConfig，
   *   正式版是 `1.1.7`、测试版是 `1.1.7-test.x`，这个区分 100% 可靠。
   *
   * 用途：测试期才有的功能（投票/答题、接口探测等）在正式版里隐藏，
   *       正式版只保留稳定功能 + 体验修复。
   */
  isTestBuild: String(Constants.expoConfig?.version ?? '').includes('-test'),
} as const;
