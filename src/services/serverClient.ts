/**
 * 管理服务端客户端。
 *
 * 用途：
 *   ① 读万能码 —— **改服务器上的值，App 立刻生效，不用重新打包**
 *   ② 登录成功后上报用户（谁、什么学号、什么时候登的）
 *
 * 设计原则：**服务器不可用时绝不能把 App 卡住**。
 *   所有调用都有超时，失败就把原因返回，由调用方决定降级方案。
 *   万能码的降级是"用内置码"（见 domain/licenseCode.ts）。
 */
import { store, STORE_KEYS } from './storage';

/**
 * 默认服务器地址。
 *
 * ══════════════ 为什么这里写死了一个地址 ══════════════
 * 需求原话：「朋友装上就能用，什么都不用填」。
 * 所以把云服务器的地址作为默认值 —— 用户**零配置**。
 *
 * ⚠️ 公开仓库版（2026-10）：默认服务器地址**不再硬编码真实 IP**。
 *    仓库是公开的，写死等于把自建者的服务器地址公开出去。
 *
 *    两种用法：
 *      · 自建：打包时设 `EXPO_PUBLIC_SERVER_BASE=http://你的地址:8787`
 *        （或装好后在设置页里填 —— 那会存进本地存储并覆盖这里）
 *      · 留空：App 起来后服务器相关功能降级，但**授权码是本地校验的**，
 *        核心功能照样能用（见下面那段"连不上会怎样"）
 */
const DEFAULT_BASE =
  process.env.EXPO_PUBLIC_SERVER_BASE || '';

function normalizeBase(raw: string): string {
  let s = (raw ?? '').trim();
  if (!s) return '';
  // 允许只填 IP:端口
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  // 去掉结尾斜杠
  return s.replace(/\/+$/, '');
}

export async function getServerBase(): Promise<string> {
  const saved = await store.get<string | null>(STORE_KEYS.serverBase, null);
  return normalizeBase(saved ?? DEFAULT_BASE);
}

export async function setServerBase(raw: string): Promise<void> {
  await store.set(STORE_KEYS.serverBase, normalizeBase(raw));
}

export function isServerConfigured(base: string): boolean {
  return Boolean(base);
}

/** 带超时的 fetch —— 服务器挂了不能把界面卡死 */
async function fetchJson<T>(
  base: string,
  path: string,
  init?: RequestInit,
  timeoutMs = 6000,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const b = normalizeBase(base);
  if (!b) return { ok: false, error: '没有配置服务器地址' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${b}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    let j: unknown;
    try {
      j = JSON.parse(text);
    } catch {
      return { ok: false, error: `服务器返回的不是 JSON（HTTP ${res.status}）` };
    }
    const obj = j as { ok?: boolean; error?: string };
    if (!res.ok || obj.ok === false) {
      return { ok: false, error: obj.error ?? `HTTP ${res.status}` };
    }
    return { ok: true, data: j as T };
  } catch (e) {
    const msg = (e as Error).message;
    if (/abort/i.test(msg)) return { ok: false, error: `连接超时（${timeoutMs / 1000} 秒）` };
    return { ok: false, error: `连不上服务器：${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

/** 测连通性 */
export async function pingServer(base: string): Promise<{ ok: boolean; error?: string; addresses?: string[]; port?: number }> {
  const r = await fetchJson<{ addresses?: string[]; port?: number }>(base, '/api/ping', undefined, 5000);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, addresses: r.data.addresses, port: r.data.port };
}

/**
 * ★ 校验万能码 —— **把用户输入的发给服务器，只拿回"对不对"**。
 *
 * ══════════════ 为什么改成这样 ══════════════
 * 原先 App 调 `GET /api/master` **把万能码明文取回来**自己比对。
 * 后果：**抓包就能看到万能码** —— 而万能码能改所有人的签到状态。
 *
 * 现在服务端只存哈希，App 也不再取回明文：
 *   请求体里是"用户输的"，响应里只有 true/false。
 *   **整个流程中网络上不出现万能码本身。**
 *
 * ⚠️ 注意：请求体里仍然带着"用户输的那个码"。
 *    所以严格说，抓包能看到的是**用户敲进去的那串字符** ——
 *    但因为服务端不回传任何提示（不返回长度、不说"接近了"），
 *    攻击者无法从响应里逐步逼近正确答案。
 *
 * 失败时返回 `ok:false` —— 调用方应降级为「用内置码」，而不是直接判用户输错。
 */
export async function verifyMasterCode(
  base: string,
  code: string,
): Promise<{ ok: boolean; valid?: boolean; error?: string }> {
  const r = await fetchJson<{ valid?: boolean }>(base, '/api/verify-master', {
    method: 'POST',
    body: JSON.stringify({ code }),
  }, 5000);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, valid: r.data.valid === true };
}

/**
 * ★ 配额校验：写操作（签到 / 改状态）**之前**调用。
 *
 * ══════════════ 为什么次数只能靠服务器 ══════════════
 * 需求：「次数根据改了几次状态来算，我可以在管理端自由设定生效时间和次数」。
 *
 *   · **截止时间**编在授权码里 → App 断网也能本地判到期，不需要服务器
 *   · **次数**不行：本地计数一清数据（重装/清缓存）就归零，等于没限
 *     → 所以次数由服务器记，每次写操作前问一次，服务端顺手 +1
 *
 * 返回：
 *   `ok:false` → **连不上服务器**（网络/未配置）→ 调用方**放行**
 *                （刻意的宽松策略：服务器挂了不该把所有人挡死）
 *   `allow:false` → **服务器明确说不能用**（到期 / 次数用完）→ 调用方拦住
 *
 * ⚠️ 这个区分很重要：把"连不上"当成"不能用"会让服务器一抖就全员无法签到。
 */
export async function consumeQuota(
  base: string,
  info: { studentId: string; code?: string },
): Promise<{
  ok: boolean;
  allow?: boolean;
  reason?: string;
  message?: string;
  used?: number;
  maxUses?: number | null;
  expiresAt?: number | null;
  error?: string;
}> {
  const r = await fetchJson<{
    allow?: boolean;
    reason?: string;
    message?: string;
    used?: number;
    maxUses?: number | null;
    expiresAt?: number | null;
  }>(
    base,
    '/api/consume',
    { method: 'POST', body: JSON.stringify(info) },
    5000,
  );
  if (!r.ok) return { ok: false, error: r.error };
  return {
    ok: true,
    allow: r.data.allow === true,
    reason: r.data.reason,
    message: r.data.message,
    used: r.data.used,
    maxUses: r.data.maxUses ?? null,
    expiresAt: r.data.expiresAt ?? null,
  };
}

/**
 * 读万能码状态。
 *
 * ⚠️ **不再返回万能码本身**（服务端也不存明文了）。
 *    这里只回答"服务器上有没有设置万能码"，供设置页显示连通性。
 *    需要校验请用 `verifyMasterCode`。
 */
export async function fetchMasterCode(base: string): Promise<{ ok: boolean; code?: string; error?: string }> {
  const r = await fetchJson<{ masterCode?: string; hasMasterCode?: boolean }>(base, '/api/master', undefined, 5000);
  if (!r.ok) return { ok: false, error: r.error };
  /**
   * ⚠️ 老服务器会回明文 masterCode，新服务器回空串 + hasMasterCode。
   *    这里**刻意不把老服务器回的明文往上传** ——
   *    调用方（设置页）只需要"通不通"，不该把码带进界面。
   *    所以无论新旧，都只返回"有没有设置"。
   */
  const has = r.data.hasMasterCode === true || Boolean(r.data.masterCode);
  if (!has) return { ok: false, error: '服务器上还没有设置万能码' };
  return { ok: true, code: '(服务端不再回传明文)' };
}

/**
 * 登录成功后上报用户。
 *
 * ⚠️ **失败不抛错** —— 上报只是给你在管理页看，不该影响登录本身。
 */
export async function reportUser(
  base: string,
  info: { studentId: string; studentName?: string; school?: string; tenant?: string },
): Promise<{ ok: boolean; error?: string }> {
  const r = await fetchJson(base, '/api/register', {
    method: 'POST',
    body: JSON.stringify(info),
  });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/**
 * 用万能码解锁时，向服务器**领取这个学号的个人授权码**。
 *
 * 需求：
 *   填了万能码的人可以改任何人的状态；
 *   同时自动记录该学号的个人授权码 —— 万能码一改，
 *   他们就降级为"个人码权限"（只能改自己），而码已经存在本地，不会突然不能用。
 *
 * ⚠️ 调用前 App 已经自己校验过万能码；这里只负责领码与记账。
 */
export async function grantPersonalCode(
  base: string,
  info: { studentId: string; studentName?: string; school?: string; tenant?: string },
): Promise<{ ok: boolean; personalCode?: string; error?: string }> {
  const r = await fetchJson<{ personalCode: string }>(base, '/api/grant', {
    method: 'POST',
    body: JSON.stringify(info),
  });
  if (!r.ok) return { ok: false, error: r.error };
  const code = r.data.personalCode;
  if (typeof code !== 'string' || !code) return { ok: false, error: '服务器没有返回个人授权码' };
  return { ok: true, personalCode: code };
}

/**
 * 问服务器"这个学号有没有被授权"。
 *
 * ⚠️ 用 `/api/auth-state` 而不是 `/api/users`：
 *    后者要管理口令（口令是给管理页用的，App 里带凭据等于公开）。
 *    踩过的坑：加了管理口令之后，这里一直在吃 401，
 *    于是"管理员远程关掉某人"悄悄失效了 —— 只能走"未知、不拦"的分支。
 *    新接口只回答**这一个学号**的是/否，不泄露整份用户列表。
 *
 * 服务器没配 / 连不上时返回 `ok:false` —— 调用方**不要**据此拒绝用户。
 */
export async function fetchUserAuth(
  base: string,
  studentId: string,
): Promise<{ ok: boolean; authorized?: boolean; error?: string }> {
  const r = await fetchJson<{ authorized?: boolean; known?: boolean }>(
    base,
    `/api/auth-state?studentId=${encodeURIComponent(studentId)}`,
    undefined,
    5000,
  );
  if (!r.ok) return { ok: false, error: r.error };
  /**
   * ══════════════ ★★★ 这里原来把服务端的"不许"翻成了"放行" ★★★ ══════════════
   *
   * 原代码：
   *     // 服务器里没有这个学号 → authorized 为 true（宽松：不登记不算被拒）
   *     return { ok: true, authorized: r.data.authorized !== false };
   *
   * ⚠️ `authorized !== false` 的意思是"**只有显式 false 才算拒绝**"，
   *    但它把 `undefined` 也当成放行 —— 而服务端在**未知学号**时
   *    本来就回的是 false，会被这行**原样保留**……
   *    问题是这个写法会掩盖"服务端根本没回答"的情况，
   *    而且它的注释写着"没这个学号 → true"，与收紧后的服务端语义**相反**。
   *
   * 用户需求：「我希望别人不能从我的 app 里得到这些功能的完成」
   *
   * 现在**如实转达服务端的判定**：
   *   · 服务端说 true  → true
   *   · 服务端说 false → false（未知学号现在也回 false，见 server.cjs 的 isGranted）
   *   · 字段缺失       → undefined，由调用方按"连不上"处理（仍然不拦）
   *
   * ★ 注意区分两件事：
   *     `ok:false` = **请求本身失败**（网络/主机）→ 调用方按 unknown 处理，**不拦**
   *     `ok:true, authorized:false` = **服务端明确说不许** → 调用方判 denied，拦住
   *    两者不能混。
   */
  return { ok: true, authorized: r.data.authorized };
}
