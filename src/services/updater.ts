/**
 * 应用内更新。
 *
 * ══════════════ 需求 ══════════════
 * 「可不可以让他们在应用内部更新」
 *
 * 背景：这个 App 迭代很频繁，每次改点东西都要手动把 APK 传给朋友、他手动装，
 * 太累。做成 App 自己检查 → 下载 → 调系统安装器。
 *
 * ══════════════ 为什么不用 OTA（热更新）══════════════
 * `expo-updates` 能只更新 JS 包（几 MB、无需重装、体验最好），但：
 *   · 需要配一套 OTA 服务与签名密钥
 *   · **只对 JS 变更有效**；一旦动了原生（比如这次加 FileProvider、装新依赖），
 *     必须走 APK 重装 —— 而我们改动经常涉及原生
 * 所以这里做的是 **APK 自更新**：能覆盖所有变更，代价是每次要装一次。
 *
 * ══════════════ Android 的两个硬性要求 ══════════════
 *   ① `REQUEST_INSTALL_PACKAGES` 权限（Android 8+ 装未知来源应用）
 *      → 见 tools/android/wire-native.cjs 自动写入 manifest
 *   ② 交给系统安装器的必须是 **content:// URI**（Android 7+ 禁止 file://）
 *      → 靠 FileProvider（authority = `<包名>.fileprovider`），
 *        路径配置见 android-native/update-filepaths.xml
 *
 * ⚠️ 还有一个**用户侧**的门槛：首次安装时 Android 会让他
 *    "允许来自此来源的应用"，那是系统级开关，App 无法绕过。
 *    所以我们把这种情况识别出来并给出可照做的指引。
 */
import * as Application from 'expo-application';
import * as FileSystem from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import { Platform } from 'react-native';
import { getServerBase } from './serverClient';

/** 服务器上的版本信息 */
export interface UpdateInfo {
  available: boolean;
  version: string;
  versionCode: number;
  sizeBytes: number;
  note: string;
  url: string;
  updatedAt?: number;
  /**
   * ★ 服务器的身份（服务端用 `os.hostname()` 回的主机名）。
   *
   * ══════════════ 为什么需要它 ══════════════
   * 有两台服务器在跑同一套代码：
   *   · 局域网内那台（本机管理后台）
   *   · 公网那台（主机名就是靠这个字段读出来的）
   * 而 App 的服务器地址**可以指向任意一台**，也能在设置页里手动改。
   *
   * 于是有个很难自查的问题：「我检查更新是好的，但连的到底是哪台？」
   * ——**看版本号分不出来**（两台版本号当然一样）。
   *
   * 有了这个字段，界面上就能显示主机名，一眼分辨。
   */
  server?: string;
  /**
   * ★★★ 强制更新（服务端 `version.json` 的 `force`）。
   *
   * 用户需求（原话）：
   *   「这次更新要设置为强制更新，有人要用我的诊断工具」
   *
   * 为什么需要：1.1.1 之前的包带着「接口测试器」（能对任意 /apps/...
   * 发 POST/DELETE，能改真实数据）。不强制的话，装了旧包的人只要不点
   * 更新就能一直用那些排查工具。
   *
   * ⚠️ 服务端老版本没这个字段 → 视为 `false`（不强制），
   *    绝不能因为缺字段就把所有人锁在门外。
   */
  force?: boolean;
}

/** 当前安装的版本 */
export function currentVersion(): { version: string; versionCode: number } {
  return {
    version: Application.nativeApplicationVersion ?? '0',
    versionCode: Number(Application.nativeBuildVersion ?? 0),
  };
}

/**
 * 比较版本。
 *
 * ⚠️ 用 **versionCode（整数）** 比较，不要比 version 字符串 ——
 *    字符串比较会让 "0.9.0" > "0.15.0"（因为 '9' > '1'），
 *    于是新版本反而被判定成"不需要更新"。这个坑很隐蔽。
 */
export function isNewer(remoteCode: number, remoteVersion: string): boolean {
  const cur = currentVersion();
  if (Number.isFinite(remoteCode) && remoteCode > 0) {
    return remoteCode > cur.versionCode;
  }
  // 服务器没给 versionCode 时退化成字符串比较（但不推荐）
  return remoteVersion !== cur.version && remoteVersion > cur.version;
}

/**
 * 问服务器有没有新版本。
 *
 * 返回 `ok:false` 表示**没网/连不上** —— 调用方应静默忽略，
 * 绝不能因为"检查更新失败"去打扰用户。
 */
/**
 * ══════════════ ★★★ 版本通道（正式 / 测试 / 自用）══════════════
 *
 * 需求（用户 2026-10）：
 *   「帮我新开一个测试版，用于测试，完成后再向正式版更新，
 *     上面的安装包我已经发出去，不要动那个」
 *
 * ══════════════ ⚠️ 2026-10：自用通道已删除 ══════════════
 *
 * 用户要求「把自用版删除吧」（理由：三个版太麻烦，只留正式 + 测试）。
 * 所以现在**两条通道**：
 *   · 正式版（不设变量）      → `/api/version`          → 正式通道
 *   · 测试版（CHANNEL=test）  → `/api/version?ch=test`  → 测试通道
 *
 * ⚠️ 已发出的自用版 APK 会继续问 `?ch=self` —— 那条通道服务端已不再提供，
 *    它会拿到正式通道的应答或被拒。**这是预期行为**：自用版已停止维护。
 *
 * ⚠️ 默认必须是正式通道 —— 已发出的老客户端不带参数，
 *    服务端也必须把它们当成正式版（见 server.cjs 的 channelOf）。
 *
 * ⚠️ 打包时换通道**必须强制重打 bundle**（Gradle 会因"输入没变"跳过，
 *    踩过：两个包 sha256 完全相同）。见 tools/release.cjs。
 */
const CH = process.env.EXPO_PUBLIC_CHANNEL;
/**
 * ⚠️ 只认 'test'，其余一律 'release'。
 *    原来还有 `CH === 'self' ? 'self'`（已随自用版一起删除）——
 *    留着的话，一条传 'self' 的旧流水线会让 App 去问 `/api/version?ch=self`，
 *    而那个通道已经不存在了。
 */
const BUILD_CHANNEL: 'release' | 'test' = CH === 'test' ? 'test' : 'release';

/** 当前安装包的通道（界面上可显示，方便确认自己装的是哪个） */
export const currentChannel: 'release' | 'test' = BUILD_CHANNEL;

export async function checkUpdate(): Promise<
  | { ok: true; info: UpdateInfo | null; server?: string }
  | { ok: false; error: string }
> {
  const base = await getServerBase();
  if (!base) return { ok: false, error: '未配置服务器' };

  try {
    /**
     * ★ 带上自己的通道 —— 各版本只看自己那条通道。
     * ⚠️ 只有测试版才带参数；正式版不带（老客户端也不带，服务端按正式处理）。
     */
    const qs = BUILD_CHANNEL === 'release' ? '' : `?ch=${BUILD_CHANNEL}`;
    const res = await fetch(`${base}/api/version${qs}`, { method: 'GET' });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const j = (await res.json()) as {
      ok?: boolean;
      available?: boolean;
      version?: string;
      versionCode?: number;
      sizeBytes?: number;
      note?: string;
      url?: string;
      updatedAt?: number;
      /**
       * ★★★ 强制更新标记。
       *
       * 用户需求（原话）：
       *   「这次更新要设置为强制更新，有人要用我的诊断工具」
       *
       * 背景：1.1.1 之前的包带着「接口测试器」（能对任意 /apps/... 发
       * POST/DELETE），装了旧包的人不更新就能一直用。
       *
       * ⚠️ 服务端**老版本没有这个字段** → 必须容忍 undefined
       *    （那时按"不强制"处理，不能因为缺字段就把人锁死）。
       */
      force?: boolean;
      /** ★ 服务端身份（新版 server.cjs 才有；旧版没有这个字段，缺了要能容忍） */
      server?: string;
    };
    /**
     * ⚠️ 注意几个分支都带上 `server` ——
     *    "已是最新版本"时 `info` 是 null，那一刻用户最想确认
     *    "我到底连上服务器了吗"，所以身份必须单独带回去。
     */
    if (!j.available || !j.url) return { ok: true, info: null, server: j.server };

    const info: UpdateInfo = {
      available: true,
      version: String(j.version ?? ''),
      versionCode: Number(j.versionCode ?? 0),
      sizeBytes: Number(j.sizeBytes ?? 0),
      note: String(j.note ?? ''),
      url: j.url,
      updatedAt: j.updatedAt,
      /** ★ 只有服务端**明确**写 true 才算强制（缺字段/写别的值都按不强制） */
      force: j.force === true,
      /** ★ 服务端身份（主机名）—— 用来在界面上分辨连的是哪台 */
      server: j.server,
    };
    // 服务器上的不比本机新 → 无需更新，但仍回报服务器身份
    if (!isNewer(info.versionCode, info.version)) return { ok: true, info: null, server: j.server };
    return { ok: true, info, server: j.server };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** 下载进度（0-1） */
export type ProgressFn = (ratio: number) => void;

/**
 * 下载 APK 到 App 私有目录，返回本地 file:// 路径。
 *
 * ⚠️ 放在 `documentDirectory`（= `/data/user/0/<包名>/files/`）——
 *    这正是 FileProvider 的 `<files-path>` 映射的目录，
 *    放别处会拿不到 content:// URI。
 */
export async function downloadApk(info: UpdateInfo, onProgress?: ProgressFn): Promise<string> {
  if (Platform.OS !== 'android') {
    throw new Error('只有 Android 支持应用内安装');
  }
  const dir = FileSystem.documentDirectory;
  if (!dir) throw new Error('拿不到 App 私有目录');

  const target = `${dir}lifekit-update.apk`;

  /**
   * ⚠️ 先删旧的：同名文件存在时 downloadAsync 的行为在不同版本不一致
   *    （有的覆盖、有的报错），删掉最稳。
   *    而且要防止上次下载到一半的残包被当成完整包安装。
   */
  try {
    await FileSystem.deleteAsync(target, { idempotent: true });
  } catch {
    /* 删不掉就算了，下面下载会覆盖 */
  }

  /**
   * ⚠️ 用 `createDownloadResumable` 而不是 `downloadAsync`：
   *    前者能报进度（30+ MB 要下几十秒，没进度用户以为卡死了）。
   */
  const resumable = FileSystem.createDownloadResumable(
    info.url,
    target,
    {},
    (p) => {
      const total = p.totalBytesExpectedToWrite || info.sizeBytes || 0;
      if (total > 0) onProgress?.(Math.min(1, p.totalBytesWritten / total));
    },
  );
  const res = await resumable.downloadAsync();
  if (!res?.uri) throw new Error('下载失败（没有返回文件路径）');

  // 校验大小：下到一半就断的情况必须认出来，否则安装会失败且原因难查
  const st = await FileSystem.getInfoAsync(res.uri, { size: true });
  if (!st.exists) throw new Error('下载后文件不存在');
  const got = (st as { size?: number }).size ?? 0;
  if (info.sizeBytes > 0 && got > 0 && got !== info.sizeBytes) {
    throw new Error(`下载不完整（${got} / ${info.sizeBytes} 字节），请重试`);
  }

  return res.uri;
}

/**
 * 把下载好的 APK 交给**系统安装器**。
 *
 * ⚠️ 这里会抛错，而且最常见的一种是——
 *    用户没开"允许来自此来源的应用"。
 *    那种情况下 IntentLauncher 通常抛 ActivityNotFound，
 *    调用方要把它翻译成"去设置里打开开关"的指引，不能只报个错误码。
 */
export async function installApk(fileUri: string): Promise<void> {
  if (Platform.OS !== 'android') throw new Error('只有 Android 支持应用内安装');

  /**
   * ★ file:// → content://
   *   Android 7（API 24）起禁止把 file:// URI 传给别的应用，
   *   直接传会抛 FileUriExposedException。
   *   这个函数依赖 FileProvider 已配置（authority 必须是 `<包名>.fileprovider`）。
   */
  const contentUri = await FileSystem.getContentUriAsync(fileUri);

  await IntentLauncher.startActivityAsync('android.intent.action.INSTALL_PACKAGE', {
    data: contentUri,
    flags: 1, // FLAG_GRANT_READ_URI_PERMISSION —— 不给的话安装器读不到文件
  });
}

/** 人看的体积 */
export function fmtSize(bytes: number): string {
  if (!bytes) return '';
  const mb = bytes / 1048576;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
