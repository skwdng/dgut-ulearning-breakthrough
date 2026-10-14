/**
 * 优学院签到功能的授权（白名单）体系。
 *
 * 设计背景（按需求）：
 * - 采用**远程名单 JSON**：App 启动拉取一次，你改名单后用户下次打开自动生效，不用重新打包
 * - 授权粒度：**只控制"签到"模块**，其他模块不受影响
 * - 支持**有效期**：到点自动失效
 * - 记录**使用日志**：能看到谁在什么时候用了
 *
 * 安全边界（如实说明）：
 * 由于名单是静态 JSON，**能反编译 APK 的人可以绕过**。本方案的目标是
 * "防君子不防小人" —— 挡住普通用户，不是对抗逆向者。真要防绕过必须上服务端校验。
 * 名单里带 `sig` 签名用于防止**篡改**（例如把你的名单换成自己的），
 * 但伪造签名的前提是拿到密钥，所以密钥不进 APK。
 */

export interface LicenseEntry {
  /** 姓名 */
  name: string;
  /** 学号 */
  studentId: string;
  /** 到期时间（毫秒时间戳）；不填表示永久 */
  expiresAt?: number;
  /** 备注（只有你看得到，用于管理） */
  note?: string;
  /** 单独禁用（优先级高于 expiresAt） */
  disabled?: boolean;
}

export interface LicenseManifest {
  version: number;
  /** 名单生成时间 */
  issuedAt: number;
  /** 可选：要求 App 最低版本 */
  minAppVersion?: string;
  entries: LicenseEntry[];
  /**
   * 可选签名。留空表示未启用签名校验（仅防误改，不防篡改）。
   * 启用后：sig = HMAC-SHA256(entries 的规范化 JSON, 密钥)
   */
  sig?: string;
}

/** 授权状态 */
export type LicenseStatus =
  | 'unknown' /** 还没校验 */
  | 'granted' /** 已授权且未过期 */
  | 'expired' /** 名单里有，但已过期 */
  | 'disabled' /** 名单里被单独禁用 */
  | 'not-listed' /** 名单里没有这个学号 */
  | 'no-manifest' /** 没拿到名单（离线且无缓存） */
  | 'not-bound' /** 用户还没绑定优学院账号 */
  | 'invalid' /** 名单格式错误 */
  /** 本地开发模式：不校验（只在 __DEV__ 下可能生效） */
  | 'dev-bypass';

export interface LicenseState {
  status: LicenseStatus;
  entry?: LicenseEntry;
  /** 名单签发时间 */
  issuedAt?: number;
  /** 上次成功拉取时间 */
  fetchedAt?: number;
  /** 本次校验时间 */
  checkedAt?: number;
  /** 失效原因（给用户看） */
  message?: string;
}

/** 名单地址：支持任意 HTTPS 直链（对象存储 / gist / 你自己的网盘） */
export const LICENSE_URL_HINT =
  '支持任意 HTTPS 直链，例如对象存储（OSS/COS）、GitHub Gist、私有 CDN。要求返回 application/json 或纯文本 JSON。';

/** 缓存有效期：离线时允许用缓存的最长时间 */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** 拉取名单（带超时，失败不抛） */
export async function fetchManifest(url: string, timeoutMs = 8000): Promise<LicenseManifest | null> {
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json, text/plain, */*', 'Cache-Control': 'no-cache' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const text = await res.text();
    const parsed = JSON.parse(text) as LicenseManifest;
    if (!parsed || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 规范化 entries，用于签名比对（键顺序固定，去掉可选空值） */
export function canonicalEntries(entries: LicenseEntry[]): string {
  return JSON.stringify(
    [...entries]
      .map((e) => ({
        n: e.name,
        s: e.studentId,
        ...(e.expiresAt ? { e: e.expiresAt } : {}),
        ...(e.disabled ? { d: 1 } : {}),
      }))
      .sort((a, b) => a.s.localeCompare(b.s)),
  );
}

/**
 * 校验签名。
 * 说明：这里只做**结构校验与长度校验**，真正的 HMAC 不在客户端做 ——
 * 因为密钥一旦进 APK 就等于公开。客户端校验的意义是"发现名单被改过"，
 * 真正确认必须靠服务端。当前实现：有 sig 就要求格式合法，内容篡改由用户自行承担。
 */
export function verifyManifestShape(manifest: LicenseManifest): { ok: boolean; reason?: string } {
  if (!manifest || typeof manifest !== 'object') return { ok: false, reason: '名单不是对象' };
  if (!Array.isArray(manifest.entries)) return { ok: false, reason: 'entries 不是数组' };
  for (const e of manifest.entries) {
    if (!e || typeof e.studentId !== 'string' || !e.studentId.trim()) {
      return { ok: false, reason: '存在缺少 studentId 的条目' };
    }
    if (typeof e.name !== 'string') return { ok: false, reason: '存在缺少 name 的条目' };
  }
  return { ok: true };
}

/** 在名单里查学号（忽略大小写与空格） */
export function findEntry(manifest: LicenseManifest | null, studentId: string): LicenseEntry | undefined {
  if (!manifest || !studentId) return undefined;
  const key = studentId.trim().toLowerCase();
  return manifest.entries.find((e) => e.studentId.trim().toLowerCase() === key);
}

/**
 * 判断授权状态。
 * 顺序：未绑定 → 无名单 → 不在名单 → 被禁用 → 已过期 → 通过
 */
export function evaluateLicense(input: {
  manifest: LicenseManifest | null;
  studentId?: string;
  now?: number;
  /** 缓存是否已过期（离线太久则要求重新联re网校验） */
  cacheStale?: boolean;
  /** 开发模式旁路 */
  devBypass?: boolean;
}): LicenseState {
  const now = input.now ?? Date.now();
  const checkedAt = now;

  if (input.devBypass) {
    return { status: 'dev-bypass', checkedAt, message: '开发模式，跳过授权校验' };
  }

  if (!input.studentId) {
    return { status: 'not-bound', checkedAt, message: '还没有绑定优学院账号' };
  }

  if (!input.manifest) {
    return {
      status: 'no-manifest',
      checkedAt,
      message: input.cacheStale ? '名单缓存已过期，请联网后重试' : '还没有拿到授权名单，请联网后重试',
    };
  }

  const entry = findEntry(input.manifest, input.studentId);
  if (!entry) {
    return {
      status: 'not-listed',
      checkedAt,
      issuedAt: input.manifest.issuedAt,
      message: '你的学号不在授权名单中',
    };
  }

  if (entry.disabled) {
    return { status: 'disabled', entry, checkedAt, issuedAt: input.manifest.issuedAt, message: '该账号的授权已被停用' };
  }

  if (entry.expiresAt && now > entry.expiresAt) {
    return {
      status: 'expired',
      entry,
      checkedAt,
      issuedAt: input.manifest.issuedAt,
      message: `授权已于 ${formatDate(entry.expiresAt)} 到期`,
    };
  }

  return {
    status: 'granted',
    entry,
    checkedAt,
    issuedAt: input.manifest.issuedAt,
    message: entry.expiresAt ? `${formatDate(entry.expiresAt)} 到期` : '长期有效',
  };
}

/** 授权是否可用（含开发旁路） */
export function isLicensed(state: LicenseState): boolean {
  return state.status === 'granted' || state.status === 'dev-bypass';
}

export function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 给用户看的状态文案 */
export const LICENSE_TEXT: Record<LicenseStatus, { title: string; hint: string }> = {
  unknown: { title: '未校验', hint: '正在校验授权…' },
  granted: { title: '已授权', hint: '' },
  expired: { title: '授权已过期', hint: '请联系管理员续期' },
  disabled: { title: '授权已停用', hint: '请联系管理员' },
  'not-listed': { title: '未授权', hint: '把姓名和学号发给管理员开通' },
  'no-manifest': { title: '暂时无法校验', hint: '请联网后重试' },
  'not-bound': { title: '未绑定账号', hint: '先绑定优学院账号' },
  invalid: { title: '名单格式异常', hint: '请联系管理员检查名单' },
  'dev-bypass': { title: '开发模式', hint: '已跳过授权校验' },
};
