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

/** 优学院域名配置（写死，同样不依赖环境变量） */
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
} as const;
