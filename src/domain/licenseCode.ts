/**
 * 授权码（一人一码）体系。
 *
 * ══════════ 设计目标 ══════════
 * 1. **一码一人**：码与学号绑定，别人拿到你的码也用不了
 * 2. **可离线校验**：码里自带签名，App 断网也能判断真伪与有效期
 * 3. **网页端生成**：管理员在网页填「姓名 + 学号」→ 自动返回该人的码
 * 4. **可撤销**：名单里 disabled 或删除后，重新联网即失效
 *
 * ══════════ 码的格式 ══════════
 *   LK1-XXXXX-XXXXX-XXXXX
 *   │   │     │     └── 校验段（签名截断）
 *   │   └─────┴──────── 载荷段（学号哈希 + 有效期）
 *   └────────────────── 版本前缀
 *
 * 相比"整份名单 JSON"，一人一码的好处：
 * - 用户只需保存一串短码，不用处理文件
 * - 分享自己的码给别人**没用**（学号对不上）
 * - 泄露一个码不会泄露整份名单
 *
 * ══════════ 安全边界（如实说明）══════════
 * 签名密钥会编译进 App，因此**懂逆向的人可以自己造码**。
 * 这套机制的目标是"一码一人 + 可撤销 + 防误传"，不是对抗逆向者。
 * 想真正防伪造必须走服务端在线校验（本项目保留了在线校验钩子）。
 */

/** 码前缀（版本标识）—— 一人一码 */
export const CODE_PREFIX = 'LK1';

/**
 * 万能码前缀。
 *
 * 为什么要独立前缀 + 独立密钥，而不是"某个特殊的学号哈希"：
 *   - 独立密钥：即使万能码泄露，也无法据此推导出普通码的签发方式（反之亦然）
 *   - 独立前缀：解析时一眼区分，不会与普通码的载荷空间产生任何碰撞可能
 *
 * ⚠️ 和普通码一样，万能码的密钥也编译进 App，懂逆向的人能造出来。
 *    它解决的是"忘记带码 / 临时调试"，不是防破解。
 */
export const MASTER_PREFIX = 'LKM';

/** 万能码的签名密钥（与普通码刻意不同） */
const MASTER_KEY = 'LifeKit::master::v1::2026';

/**
 * 便利万能码 —— 一个**好记的字面量**，不进算法。
 *
 * 为什么需要单独处理：
 *   算法生成的码只会出现 Base32 字母表里的字符
 *   （`23456789ABCDEFGHJKLMNPQRSTUVWXYZ`，刻意去掉了 0/1/I/O），
 *   而且格式是 `前缀-XXXXX-…`；
 *   所以这种纯小写、没横线、长度也不对的东西，
 *   **算法永远造不出来**，只能在这里显式放行。
 *
 * 用途：日常自用 / 临时排障，不用去网页生成。
 * 注意：它同样编译进 App，等于"公开的口令"，别当成安全机制。
 */
/**
 * 便利万能码 —— **只用于自用版，对外发布的包必须剥离它**。
 *
 * ══════════════ 🚨 为什么必须能剥离 ══════════════
 *
 * 这个常量**编译进 APK**。用户要把安装包发给别人（每人一个授权码），
 * 而如果包里留着便利万能码的明文，任何人反编译（或直接 `strings` 搜）
 * 就能拿到它 —— 而万能码的权限是 `scope: 'all'`，
 * **能改任何人**的签到状态。
 *
 * 用户早就交代过：「万能码我自己会记住的，不要往外显露」。
 * 所以对外版的包里**绝不能有这个明文**。
 *
 * ══════════════ 怎么剥离 ══════════════
 *
 * 打包时设环境变量：
 *     EXPO_PUBLIC_DISTRIBUTION=1   → 这个常量变成空串 → 包里没有明文万能码
 * 不设（默认）→ 用 `EXPO_PUBLIC_MASTER_CODE`，没有则占位符（不能用）。
 *
 * 见 tools/release.cjs 的 `--dist` 参数。
 *
 * ══════════════ 剥离后你自己怎么用万能码 ══════════════
 *
 * 用**服务器生成的 `LKM-` 签名万能码**（管理后台 → 生成万能码）。
 *    · 它是 `MASTER_KEY` + 载荷**签名算出来**的
 *    · 反编译只能拿到 MASTER_KEY，但**造不出服务器认可的有效期组合**，
 *      而且真正的门是服务端的 `masterCodeHash` —— 签名码也得服务端认才行
 *    · 所以 `MASTER_KEY` 保留在包里是**安全**的（必需，否则解析不了 LKM- 码）
 * ══════════════ 🔓 公开仓库版（2026-10 改）══════════════
 *
 * 这个常量原先**硬编码**在源码里。仓库要公开到 GitHub / Gitee，
 * 所以改成**从环境变量注入**：
 *
 *     EXPO_PUBLIC_MASTER_CODE=你自己的码    → 写进 .env.local（**不入库**）
 *     不设                                   → 默认 CHANGEMEPLEASE（占位，不能用）
 *
 * ⚠️ 占位符必须**纯字母数字**：判定走的是
 *    `canonicalizeCodeInput(输入) === CONVENIENCE_MASTER_CODE.toUpperCase()`，
 *    输入侧会**丢掉非字母数字**（横线/空格/下划线），常量侧不会 ——
 *    所以占位符里带下划线（`CHANGE_ME`）会导致"连占位符都不匹配"，
 *    测试里表现为莫名其妙的全不命中（踩过）。
 *
 * ⚠️ 为什么必须这么改：这个常量**编译进 APK**，
 *    而公开仓库里的明文 = 全世界都知道你能改任何人的签到状态。
 *    自建的人应该用**自己**的码，而不是抄这一个。
 *
 * ⚠️ 本地要保留原来的万能码：在 `.env.local` 里写
 *       EXPO_PUBLIC_MASTER_CODE=你的万能码
 *    （`.env.local` 已在 .gitignore 里）
 */
export const CONVENIENCE_MASTER_CODE =
  process.env.EXPO_PUBLIC_DISTRIBUTION === '1'
    ? ''
    : (process.env.EXPO_PUBLIC_MASTER_CODE || 'CHANGEMEPLEASE');



/**
 * Base32 字母表 —— **必须正好 32 个字符**。
 *
 * ⚠️ 踩过的坑：一开始为了"去掉易混淆字符"删得太多（只剩 30 个），
 * 而 5 位掩码 `& 31` 能取到 0~31，于是 index 30/31 取到 undefined，
 * 生成的码里出现字面量 "undefined"。
 *
 * 现在：从 36 个（0-9 + A-Z）里只删 4 个 —— 0 / 1 / I / O（最易互混），
 * 恰好剩 32 个。校验：`B32.length === 32`。
 */
const B32 = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** 开发期自检：字母表长度必须是 32，否则 5 位掩码会越界 */
if (B32.length !== 32) {
  throw new Error(`Base32 字母表长度必须是 32，当前 ${B32.length}`);
}

/** 同步签名密钥 —— ⚠️ 会进 APK，只防误改不防逆向 */
const SIGN_KEY = 'LifeKit::checkin::v1::2026';

/** 一段的字符数 */
const SEG_LEN = 5;

/** 载荷段数（学号哈希 + 有效期） */
const PAYLOAD_SEGS = 2;

export interface LicenseCodePayload {
  /** 学号归一化后的哈希（前 8 字节 hex） */
  studentHash: string;
  /** 到期时间：自 2026-01-01 起的天数（0 表示永久） */
  expireDays: number;
}

export interface LicenseCodeInfo {
  /** 学号（校验成功时才有，用于比对） */
  studentIdHash: string;
  /** 到期时间戳；undefined 表示永久 */
  expiresAt?: number;
  /** 规范化后的码 */
  code: string;
  /** 是否是万能码（不绑定学号） */
  isMaster?: boolean;
}

// ---------------------------------------------------------------- 工具

/**
 * 学号归一化。
 * 去空格、统一小写 —— 保证「2099000000116」与「 2099000000116 」得到同一个哈希。
 */
export function normalizeStudentId(studentId: string): string {
  return (studentId ?? '').replace(/\s+/g, '').toLowerCase();
}

/**
 * 纯 JS 的字符串哈希（FNV-1a 变体 → 8 字节 hex）。
 * 刻意不用 crypto，因为 React Native 环境里同步可用性不稳定。
 * 这里只需要"稳定且分散"，不需要密码学强度。
 */
export function hashStudentId(studentId: string): string {
  const s = normalizeStudentId(studentId);
  // 两组不同种子的 FNV-1a，拼成 8 字节，降低碰撞
  const fnv = (seed: number): number => {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  };
  const a = fnv(0x811c9dc5);
  const b = fnv(0x9e3779b9);
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** 生成签名（把载荷 + 密钥做哈希）。返回 **Base32 字母表内**的字符，便于拼接。 */
function signWith(key: string, payloadStr: string): string {
  const raw = `${key}|${payloadStr}`;
  // 用两轮哈希拉长，降低截断碰撞
  const h1 = hashStudentId(raw);
  const h2 = hashStudentId(`${raw}#2`);
  // ⚠️ hashStudentId 返回的是 hex（含 0/1/a-f），而 Base32 字母表刻意去掉了 0/1/IO，
  // 直接拼接会导致解析时找不到字符（踩过的坑）。所以先把 hex 转成字节再编码成 Base32。
  return toBase32(hexToBytes(h1 + h2));
}

/** 普通码的签名 */
function sign(payloadStr: string): string {
  return signWith(SIGN_KEY, payloadStr);
}

/**
 * 字节数组 → Base32 字符串（无填充）。
 *
 * ⚠️ 踩过的坑：如果用一个累加器累积**多个**字节再右移，当 bits > 31 时
 * JS 的 `>>>` 会超出 32 位整数范围，算出 undefined，输出里出现 "undefined"。
 * 这里改成每次只累积 1 字节，bits 始终 < 13，安全。
 */
function toBase32(bytes: number[]): string {
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of bytes) {
    acc = ((acc << 8) | (b & 0xff)) & 0xfff; // 只保留低 12 位（bits 最大 12）
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
      acc &= (1 << bits) - 1;
    }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

/** hex 字符串 → 字节数组 */
function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

/** 把一串字符按固定长度切段，用 - 连接 */
function group(s: string): string {
  const parts: string[] = [];
  for (let i = 0; i < s.length; i += SEG_LEN) parts.push(s.slice(i, i + SEG_LEN));
  return parts.join('-');
}

/** 去掉所有非字母数字并转大写（用户输入时可能带空格、小写、缺横线） */
export function canonicalizeCodeInput(input: string): string {
  return (input ?? '').replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
}

// ---------------------------------------------------------------- 生成

/**
 * 生成授权码（网页端管理员用）。
 *
 * @param studentId 学号
 * @param options.expiresAt 到期时间戳；不传表示永久
 */
export function generateLicenseCode(
  studentId: string,
  options: { expiresAt?: number } = {},
): string {
  const sid = normalizeStudentId(studentId);
  if (!sid) throw new Error('学号不能为空');

  // 载荷：学号哈希前 6 字节 + 有效期 2 字节 → 共 8 字节
  const hashBytes = hexToBytes(hashStudentId(sid)).slice(0, 6);
  const days = expireDaysFrom(options.expiresAt);
  const expireBytes = [(days >> 8) & 0xff, days & 0xff];
  const payloadBytes = [...hashBytes, ...expireBytes];
  const payloadStr = toBase32(payloadBytes);

  // 签名：取 Base32 签名的前 15 字符（3 段）
  const sigStr = sign(payloadStr).slice(0, SEG_LEN * 3);

  const body = group(payloadStr + sigStr);
  return `${CODE_PREFIX}-${body}`;
}

/** 到期时间 → 天数（自 2026-01-01）；0 表示永久 */
function expireDaysFrom(expiresAt?: number): number {
  if (!expiresAt) return 0;
  const EPOCH = Date.UTC(2026, 0, 1);
  const days = Math.round((expiresAt - EPOCH) / 86400000);
  if (days <= 0) return 1; // 至少 1 天，避免 0 被当成永久
  return Math.min(days, 0xffff);
}

/**
 * 万能码 —— 不绑定学号，任何人输入都能解锁签到插件。
 *
 * 格式：LKM-XXXXX-XXXXX-XXXXX-XXXXX
 *   载荷 5 字符（只有有效期 + 固定魔数）+ 签名 15 字符
 *
 * ⚠️ 泄漏风险：万能码一旦流出，等于所有人都能解锁。
 *    建议只在开发和临时排障时用，正式发放仍用一人一码。
 */
export function generateMasterCode(options: { expiresAt?: number } = {}): string {
  // 载荷 3 字节：魔数 0x4D('M') + 有效期 2 字节
  const days = expireDaysFrom(options.expiresAt);
  const payloadBytes = [0x4d, (days >> 8) & 0xff, days & 0xff];
  const payloadStr = toBase32(payloadBytes);
  const sigStr = signWith(MASTER_KEY, payloadStr).slice(0, SEG_LEN * 3);
  return `${MASTER_PREFIX}-${group(payloadStr + sigStr)}`;
}

/** 万能码载荷的字节数 */
const MASTER_PAYLOAD_BYTES = 3;
/** 万能码载荷的 Base32 字符数 */
const MASTER_PAYLOAD_CHARS = Math.ceil((MASTER_PAYLOAD_BYTES * 8) / 5);

/** 解析万能码 */
function parseMasterCode(raw: string): CodeParseResult {
  const body = raw.slice(MASTER_PREFIX.length);
  const sigChars = SEG_LEN * 3;
  if (body.length !== MASTER_PAYLOAD_CHARS + sigChars) return { ok: false, reason: 'length' };

  const payloadStr = body.slice(0, MASTER_PAYLOAD_CHARS);
  const sigStr = body.slice(MASTER_PAYLOAD_CHARS);
  if (signWith(MASTER_KEY, payloadStr).slice(0, sigChars) !== sigStr) {
    return { ok: false, reason: 'signature' };
  }

  const bytes = fromBase32(payloadStr, MASTER_PAYLOAD_BYTES);
  if (bytes[0] !== 0x4d) return { ok: false, reason: 'signature' };
  const days = ((bytes[1] ?? 0) << 8) | (bytes[2] ?? 0);

  return {
    ok: true,
    info: {
      studentIdHash: '',
      expiresAt: expireDaysTo(days),
      code: `${MASTER_PREFIX}-${group(body)}`,
      isMaster: true,
    },
  };
}

/** 天数 → 到期时间戳 */
function expireDaysTo(days: number): number | undefined {
  if (!days) return undefined;
  const EPOCH = Date.UTC(2026, 0, 1);
  return EPOCH + days * 86400000;
}

// ---------------------------------------------------------------- 解析校验

export type CodeParseResult =
  | { ok: true; info: LicenseCodeInfo }
  | { ok: false; reason: 'empty' | 'prefix' | 'length' | 'signature' };

/**
 * 解析并校验授权码（App 端用）。
 *
 * 只校验**码本身**的结构与签名；是否与当前登录学号匹配由调用方比对。
 * 万能码（LKM-）在此放行，不需要学号。
 */
export function parseLicenseCode(input: string): CodeParseResult {
  const raw = canonicalizeCodeInput(input);
  if (!raw) return { ok: false, reason: 'empty' };

  // 便利万能码：字面量直通（算法造不出这种字符组合，只能显式放行）
  if (raw === CONVENIENCE_MASTER_CODE.toUpperCase()) {
    return {
      ok: true,
      info: { studentIdHash: '', code: CONVENIENCE_MASTER_CODE, isMaster: true },
    };
  }
  // 万能码先判（前缀不同，不会与普通码混淆）
  if (raw.startsWith(MASTER_PREFIX)) return parseMasterCode(raw);

  if (!raw.startsWith(CODE_PREFIX)) return { ok: false, reason: 'prefix' };

  // 去掉前缀后剩下的 Base32 主体
  const body = raw.slice(CODE_PREFIX.length);
  /** 8 字节载荷的 Base32 字符数 */
  const expectPayloadChars = Math.ceil((6 + 2) * 8 / 5);
  const sigChars = SEG_LEN * 3;

  if (body.length !== expectPayloadChars + sigChars) return { ok: false, reason: 'length' };

  const payloadStr = body.slice(0, expectPayloadChars);
  const sigStr = body.slice(expectPayloadChars);

  if (sign(payloadStr).slice(0, sigChars) !== sigStr) return { ok: false, reason: 'signature' };

  // 解出学号哈希与有效期
  const payloadBytes = fromBase32(payloadStr, 8);
  const hashHex = payloadBytes.slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
  const days = (payloadBytes[6] << 8) | payloadBytes[7];

  return {
    ok: true,
    info: {
      studentIdHash: hashHex,
      expiresAt: expireDaysTo(days),
      code: `${CODE_PREFIX}-${group(body)}`,
    },
  };
}

/** Base32 → 字节数组（取前 n 字节） */
function fromBase32(s: string, n: number): number[] {
  let bits = 0;
  let acc = 0;
  const out: number[] = [];
  for (const ch of s) {
    const v = B32.indexOf(ch);
    if (v < 0) continue;
    acc = ((acc << 5) | v) & 0x3fff; // 同样限制在安全位宽内
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 0xff);
      bits -= 8;
      acc &= (1 << bits) - 1;
      if (out.length >= n) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------- 综合判定

export type CodeCheckStatus =
  | 'granted'
  | 'expired'
  | 'mismatch'   // 码不属于当前学号
  | 'invalid'    // 格式/签名错
  | 'empty';     // 没填

/**
 * 权限范围 —— 决定能改**谁的**签到状态。
 *
 *   'self'  ：只能改自己（用个人授权码时的范围）
 *   'all'   ：能改任何人（用万能码时的范围）
 *   'none'  ：没权限
 */
export type GrantScope = 'none' | 'self' | 'all';

export interface CodeCheckResult {
  status: CodeCheckStatus;
  message: string;
  expiresAt?: number;
  /**
   * 万能码是从哪来的 —— 用于在界面上说清"服务器改了没生效"这类问题。
   *   server   ：来自管理服务端（改服务器立刻生效）
   *   builtin  ：服务器不可用，退回 App 里内置的码
   */
  masterSource?: 'server' | 'builtin';
  /**
   * 权限范围。
   *
   * ⚠️ 这是"万能码 / 个人码"权限差别的落点：
   *   万能码 → 'all'（能改任何人）
   *   个人码 → 'self'（只能改自己）
   *   服务器明确拒绝 → 'none'
   */
  scope?: GrantScope;
}

/**
 * 判定「这个码能不能给这个学号用」。
 *
 * 这是"一码一人"的核心：
 * 别人拿到你的码，输进他的 App 会因为学号哈希对不上而被拒。
 */
export function checkCodeForStudent(input: {
  code: string;
  studentId: string;
  now?: number;
}): CodeCheckResult {
  const now = input.now ?? Date.now();
  if (!input.code?.trim()) {
    return { status: 'empty', message: '还没有填写授权码' };
  }
  const parsed = parseLicenseCode(input.code);
  if (!parsed.ok) {
    const map: Record<string, string> = {
      empty: '授权码为空',
      prefix: `授权码格式不对（应以 ${CODE_PREFIX}- 或 ${MASTER_PREFIX}- 开头）`,
      length: '授权码长度不对，可能复制不完整',
      signature: '授权码校验失败，可能被改动过',
    };
    return { status: 'invalid', message: map[parsed.reason] ?? '授权码无效' };
  }

  // 万能码：不绑学号，直接看有效期。
  // 范围是 'all' —— 拿万能码的人可以改**任何人**的签到状态。
  if (parsed.info.isMaster) {
    if (parsed.info.expiresAt && now > parsed.info.expiresAt) {
      return {
        status: 'expired',
        message: `万能码已于 ${formatDate(parsed.info.expiresAt)} 到期`,
        expiresAt: parsed.info.expiresAt,
        scope: 'none',
      };
    }
    return {
      status: 'granted',
      message: parsed.info.expiresAt
        ? `万能码 · ${formatDate(parsed.info.expiresAt)} 到期`
        : '万能码 · 长期有效',
      expiresAt: parsed.info.expiresAt,
      scope: 'all',
      masterSource: 'builtin',
    };
  }

  // 一码一人：比对学号哈希前 6 字节
  const mine = hashStudentId(input.studentId).slice(0, 12);
  if (parsed.info.studentIdHash !== mine) {
    return {
      status: 'mismatch',
      message: reqMismatchText(),
      scope: 'none',
    };
  }

  if (parsed.info.expiresAt && now > parsed.info.expiresAt) {
    return {
      status: 'expired',
      message: `授权码已于 ${formatDate(parsed.info.expiresAt)} 到期`,
      expiresAt: parsed.info.expiresAt,
      scope: 'none',
    };
  }

  return {
    status: 'granted',
    message: parsed.info.expiresAt ? `${formatDate(parsed.info.expiresAt)} 到期` : '长期有效',
    expiresAt: parsed.info.expiresAt,
    // 个人授权码 → 只能改自己
    scope: 'self',
  };
}

function reqMismatchText(): string {
  return '这个授权码不属于当前账号（授权码与学号绑定，不能转借）';
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 给用户看的提示 */
export const CODE_STATUS_TEXT: Record<CodeCheckStatus, { title: string; hint: string }> = {
  granted: { title: '已解锁', hint: '' },
  expired: { title: '授权码已过期', hint: '请重新获取' },
  mismatch: { title: '授权码不属于此账号', hint: '授权码与学号绑定，请向管理员索取自己的码' },
  invalid: { title: '授权码无效', hint: '请检查是否完整复制' },
  empty: { title: '未填写授权码', hint: '签到插件需要授权码才能解锁' },
};
