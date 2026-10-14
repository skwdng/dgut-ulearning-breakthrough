/**
 * 动态 Expo 配置 —— 让三个版本**同时装在一台手机上**。
 *
 * ══════════════ 用户需求（原话）══════════════
 *
 *   「你搞两类安装包，然后能在我手机上弄出两个应用，
 *     一个是正常的，一个在后面加上测试版，
 *     正常的分为对外和自用」
 *
 *   「好，自用版可以用万能码，对外版和测试版不可用」
 *
 * ══════════════ ⚠️ 为什么必须改 applicationId ══════════════
 *
 * Android 判定"是不是同一个 App"看的是 **applicationId**（包名）。
 *   · 两个包名相同 → 装第二个会**覆盖**第一个（还会因签名/版本冲突失败）
 *   · 两个包名不同 → **共存**，桌面出各自图标
 *
 * ⚠️ 踩过的坑：自用版原先也用 `com.lifekit.app`，和对外版撞车 ——
 *    装自用版会把对外版顶掉。所以自用版现在有**自己的包名**。
 *
 * ══════════════ 三个版本的分工 ══════════════
 *
 *   对外版  com.lifekit.app        剥离万能码   发给同学
 *   测试版  com.lifekit.app.test   剥离万能码   自己测试
 *   自用版  com.lifekit.app.self   **保留万能码** 自己用
 *
 * ══════════════ 怎么触发 ══════════════
 *
 * 打包时设 `EXPO_PUBLIC_CHANNEL`：
 *   不设 / 'release' → 对外版
 *   'test'           → 测试版
 *   'self'           → 自用版
 *
 * ⚠️ 「剥不剥离万能码」**不由这里决定** —— 那是
 *    `EXPO_PUBLIC_DISTRIBUTION` 控制的（见 src/domain/licenseCode.ts），
 *    由 tools/release.cjs 按版本类型设置。
 *
 * ══════════════ ⚠️ 与 app.json 的分工（别搞混）══════════════
 *
 *   app.json      → 版本号 / versionCode / 权限 / 插件（**唯一数据源**）
 *   app.config.js → 只**覆盖**「按版本要变」的那几项（包名、显示名）
 *
 * 这样 tools/publish-apk.cjs 那边照旧读 app.json 拿版本号，不用改。
 */
const base = require('./app.json');

const CHANNEL = process.env.EXPO_PUBLIC_CHANNEL === 'test'
  ? 'test'
  : process.env.EXPO_PUBLIC_CHANNEL === 'self'
    ? 'self'
    : 'release';

/** 正式/对外包名 */
const BASE_ID = 'com.lifekit.app';

/** 各版本独有的配置（只有这几项不同，其余一律继承 app.json） */
const VARIANTS = {
  release: {
    name: 'LifeKit',
    slug: 'lifekit',
    scheme: 'lifekit',
    package: BASE_ID,
  },
  test: {
    name: 'LifeKit 测试版',
    slug: 'lifekit-test',
    scheme: 'lifekit-test',
    package: `${BASE_ID}.test`,
  },
  self: {
    name: 'LifeKit 自用版',
    slug: 'lifekit-self',
    scheme: 'lifekit-self',
    /**
     * ★★★ 自己的包名 —— 与对外版/测试版都不冲突，可共存。
     * ⚠️ 别再改回 `com.lifekit.app`：那会和对外版互相覆盖（踩过）。
     */
    package: `${BASE_ID}.self`,
  },
};

module.exports = () => {
  const expo = base.expo ?? {};
  const android = expo.android ?? {};
  const ios = expo.ios ?? {};
  const v = VARIANTS[CHANNEL];

  /** 对外版原样返回，不多做改动 */
  if (CHANNEL === 'release') return { ...expo };

  return {
    ...expo,
    /** ★ 桌面图标下面显示的名字 */
    name: v.name,
    /** ⚠️ slug 也要区分 —— Expo 用它标识项目，不区分会认成同一个 */
    slug: v.slug,
    /** ⚠️ scheme 也要区分 —— 否则多个 App 抢同一个深链 */
    scheme: v.scheme,
    android: {
      ...android,
      /** ★★★ 这一行是"能同时装三个"的关键 */
      package: v.package,
    },
    ios: {
      ...ios,
      bundleIdentifier: v.package,
    },
  };
};
