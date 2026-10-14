/**
 * 插件解锁状态管理。
 *
 * 与旧的白名单体系（domain/license.ts）的区别：
 *   旧：整份名单 JSON，靠"学号是否在名单里"判断
 *   新：**一人一码**，码里嵌了学号哈希 + 签名 + 有效期，本地即可校验
 *
 * 判断依据（两者都对才算解锁）：
 *   ① 已绑定优学院账号（需要学号来比对）
 *   ② 授权码校验通过（签名正确 + 学号匹配 + 未过期）
 *
 * 安全边界（如实说明）：
 *   密钥编译进 App，懂逆向可自己造码。这套机制防的是"转借"与"误传"，
 *   不是对抗逆向者。真正的强校验必须上服务端。
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  CODE_STATUS_TEXT,
  checkCodeForStudent,
  parseLicenseCode,
  type CodeCheckResult,
  type CodeCheckStatus,
  type GrantScope,
} from '../domain/licenseCode';
import { store, STORE_KEYS } from '../services/storage';
import { fetchUserAuth, getServerBase, grantPersonalCode, verifyMasterCode } from '../services/serverClient';
import { useCheckin } from './checkinStore';

interface StoredCode {
  code: string;
  /** 记录是谁的码（便于换账号时提示） */
  studentId: string;
  savedAt: number;
  /** 最近一次校验结果 */
  status: CodeCheckStatus;
  expiresAt?: number;
  /**
   * 用万能码时**服务器下发的个人授权码**。
   *
   * 用途：万能码被管理员改掉之后，这个人降级为"个人码权限"（只能改自己）——
   * 靠的就是这份码。没有它，万能码一改他就彻底不能用了。
   */
  personalCode?: string;
}

export interface UnlockState {
  /** 是否已解锁签到插件 */
  unlocked: boolean;
  /** 当前码的校验结果 */
  result: CodeCheckResult | null;
  /** 已保存的码（若有） */
  code: string | null;
  /**
   * ★★★ 交给服务器做**配额校验**（`/api/consume`）时该送的码。
   *
   * ══════════════ 🚨 为什么不能直接用 `code`（真实 bug，2026-10）══════════════
   *
   * 用户截图报错：「改成『已签到』没有成功 / 这个授权码不属于当前学号」，
   * 而设置页明明显示有权（横幅写着「个人授权码权限 · 只能改自己的」）。
   *
   * 复现确认（打云端 `/api/consume` 实测）：
   *   · 云端记的个人码 `LK1-…222MY-…`        → allow=true
   *   · 万能码（`EXPO_PUBLIC_MASTER_CODE`）  → allow=true
   *   · **旧**个人码 `LK1-…2MLVF-…`           → allow=false **code_mismatch**
   *                                              message 正是截图里那句
   *
   * 根因：`stored.personalCode` 是当初从服务器换来的，**服务器换码后它就过期了**。
   *   而"万能码被改 → 降级用个人码"这条路会把它送上去 → 服务器不认 → 拦死。
   *
   * 修法：**只要能确认手里是万能码，就优先送万能码**（服务器认它，见
   *   server.cjs `/api/consume` 里 `verifyMasterCode` 那段修复）。
   *   只有确实没有万能码时才退回个人码。
   *
   * ⚠️ 服务端 `force` 之类的问题都不影响这条 —— 纯粹是"送哪份码"的选择。
   */
  quotaCode: string | null;
  ready: boolean;
  /**
   * 服务器侧的授权状态。
   *
   * 为什么要它：授权码在本地校验，防的是"码被转借"；
   * 而**换一个学号登录**时，本地只能发现"码里的哈希对不上"。
   * 服务器这一层让管理员能：
   *   · 在管理页关掉某人的授权（立刻生效）
   *   · 确保只有"被授权的学号"能用签到
   *
   * 取值：
   *   'granted' 服务器明确说这个学号已授权
   *   'denied'  服务器明确说没授权 → **不允许签到**
   *   'unknown' 没配服务器 / 连不上 / 服务器里没这个学号 → **不拦**
   *             （不能因为服务器挂了就把人锁死）
   */
  serverAuth: 'granted' | 'denied' | 'unknown';
  /** 服务器授权的说明文字（给界面显示） */
  serverAuthMessage: string;
  /** 综合判定：本地码 + 服务器授权 都通过，才算真的能用 */
  entitled: boolean;
  /**
   * 权限范围 —— 决定能改**谁的**签到状态。
   *
   *   'all'  万能码 → 能改任何人
   *   'self' 个人码 / 万能码失效后降级 → 只能改自己
   *   'none' 没权限
   */
  scope: GrantScope;
}

export interface UnlockActions {
  /** 提交一个码（会立即校验并持久化） */
  submit(code: string): Promise<CodeCheckResult>;
  /** 清除已保存的码（锁回去） */
  clear(): Promise<void>;
}

const Ctx = createContext<(UnlockState & { actions: UnlockActions }) | null>(null);

export function UnlockProvider({ children }: { children: React.ReactNode }) {
  const { account } = useCheckin();
  const [stored, setStored] = useState<StoredCode | null>(null);
  const [ready, setReady] = useState(false);

  // 启动时读取
  useEffect(() => {
    (async () => {
      const v = await store.get<StoredCode | null>(STORE_KEYS.unlockCode, null);
      setStored(v ?? null);
      setReady(true);
    })();
  }, []);

  /**
   * 每次账号变化或码变化都重新校验。
   * 这里刻意**不信任存储时的结果** —— 重新算一遍，
   * 避免"存的时候过了、后来学号换了还显示解锁"。
   *
   * ⚠️ 万能码（LKM-）不绑定学号，所以**不需要先绑定优学院账号**。
   *    这一点很重要：万能码的用途之一就是"账号还没绑好时先开功能"。
   */
  /**
   * 计算当前权限。
   *
   * ══════════ 这里实现了"万能码改了要降级" ══════════
   *
   * 两种情况：
   *   ① 存的是**个人码** → 直接校验（scope = 'self'，只能改自己）
   *   ② 存的是**万能码** → 校验现在的万能码还对不对
   *        · 还对的     → scope = 'all'（能改任何人）
   *        · 已经不对了 → ★ 降级：改用存下来的 `personalCode` 校验
   *                      通过就是 scope = 'self'（只能改自己），
   *                      不通过才算真没权限
   *
   * 为什么要"降级"而不是直接失效：
   *   需求是"万能码改变后权限降为授权码权限"。
   *   管理员改了万能码，这批人不该突然全废 —— 应该变成只能管自己。
   *
   * ⚠️ 万能码是否变化要**问服务器**，是异步的，所以这里有个小状态。
   */
  const [masterNowOk, setMasterNowOk] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const isMasterStored = (() => {
      if (!stored?.code) return false;
      const p = parseLicenseCode(stored.code);
      return p.ok && p.info.isMaster === true;
    })();

    // 存的不是万能码 → 不需要问服务器
    if (!isMasterStored) {
      setMasterNowOk(null);
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      const base = await getServerBase();
      if (!base) {
        if (!cancelled) setMasterNowOk(null); // 没配服务器，按本地算
        return;
      }
      /**
       * ★ 用**校验接口**，而不是"把服务器的码取回来比"。
       *
       * 取回来比 → 明文在网络上传输 → 抓包就泄漏了。
       * 发过去校验 → 只有"对不对"一个布尔值回来。
       *
       * 参数是**本地存着的那个码**：问服务器"它现在还算不算数"。
       * 管理员改过万能码 → 服务器答 false → 本地降级为个人码权限。
       */
      const r = await verifyMasterCode(base, stored?.code ?? '');
      if (cancelled) return;
      if (!r.ok) {
        setMasterNowOk(null); // 连不上，不据此降级
        return;
      }
      setMasterNowOk(r.valid === true);
    })();

    return () => {
      cancelled = true;
    };
  }, [stored?.code]);

  const result = useMemo<CodeCheckResult | null>(() => {
    if (!stored?.code) return null;
    const parsed = parseLicenseCode(stored.code);
    const isMaster = parsed.ok && parsed.info.isMaster === true;

    /**
     * ══════════════ ★★★ 码必须属于**当前登录的学号**（防一份码多账号用）══════════════
     *
     * ⚠️ 用户的真实顾虑（2026-10）：
     *    「别人用有这种情况，先解决这个」——
     *    截图显示对方手机（学号 2099000000127）上「授权状态：已生效」。
     *
     * 背景：`unlockCode` 是**全局单键**（不像 courses/tasks 按账号分）。
     *   所以一份码存下来之后**换账号仍然在**。虽然码里的学号哈希
     *   会在校验时对不上新账号，但下面这条更严格：
     *
     *   ★ 存的时候记了 `stored.studentId`（"这份码是给谁的"），
     *     这里**再比一次**：当前账号必须就是它。
     *     好处：换账号后**立刻**失效，不依赖哈希比对，
     *     也不给"先输码再换账号"留缝隙。
     *
     * ⚠️ 万能码**不受此限**（它本来就不绑学号）—— 只看 `isMaster`。
     *    所以这个检查只对**个人码**生效。
     */
    const ownerMismatch =
      !isMaster &&
      Boolean(stored.studentId) &&
      Boolean(account?.studentId) &&
      stored.studentId !== account?.studentId;

    if (ownerMismatch) {
      return {
        status: 'mismatch',
        message:
          `这个授权码是发给学号 ${stored.studentId} 的，` +
          `而当前登录的是 ${account?.studentId}。` +
          '授权码与学号绑定，请用你自己的码（或换回对应账号）。',
        scope: 'none',
      };
    }

    // ── ① 个人码：直接校验 ──
    if (!isMaster) {
      if (!account?.studentId) {
        return { status: 'empty', message: '还没有绑定优学院账号，无法校验授权码' };
      }
      return checkCodeForStudent({ code: stored.code, studentId: account.studentId });
    }

    // ── ② 万能码 ──
    // 服务器说它已经变了（masterNowOk === false）→ 降级到个人码
    if (masterNowOk === false && stored.personalCode) {
      const r = checkCodeForStudent({
        code: stored.personalCode,
        studentId: account?.studentId ?? '',
      });
      if (r.status === 'granted') {
        return {
          ...r,
          message: `万能码已更换，已降级为你的个人授权码（只能改自己的签到）`,
          scope: 'self',
        };
      }
      return {
        status: r.status,
        message: `万能码已更换，且你的个人码无法通过校验：${r.message}`,
        scope: 'none',
      };
    }

    // 万能码仍有效（或无法判断）→ 按本地算，范围是 all
    if (!account?.studentId) {
      // 万能码不要求先绑账号
      return checkCodeForStudent({ code: stored.code, studentId: '' });
    }
    return checkCodeForStudent({ code: stored.code, studentId: account.studentId });
  }, [stored?.code, stored?.personalCode, stored?.studentId, account?.studentId, masterNowOk]);

  const unlocked = result?.status === 'granted';

  /**
   * 权限范围 —— 决定能改**谁的**状态。
   *   万能码 → 'all'
   *   个人码 / 降级后 → 'self'
   *   未通过 → 'none'
   */
  const scope: GrantScope = unlocked ? (result?.scope ?? 'self') : 'none';

  /**
   * 服务器授权检查。
   *
   * ⚠️ 时机很重要：`account?.studentId` 一变（换账号登录）就**重新查**，
   *    所以"登录别人的账号"会立刻被这一层发现。
   *
   * 判据（刻意宽松，避免服务器挂了把人锁死）：
   *   服务器明确返回 authorized === false → denied
   *   其余（没配 / 连不上 / 服务器里没这个学号）→ unknown（不拦）
   */
  const [serverAuth, setServerAuth] = useState<'granted' | 'denied' | 'unknown'>('unknown');
  const [serverAuthMessage, setServerAuthMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    const sid = account?.studentId;

    if (!sid) {
      setServerAuth('unknown');
      setServerAuthMessage('');
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      const base = await getServerBase();
      if (!base) {
        if (!cancelled) {
          setServerAuth('unknown');
          setServerAuthMessage('未配置管理服务器，只按本地授权码判断');
        }
        return;
      }
      const r = await fetchUserAuth(base, sid);
      if (cancelled) return;

      if (!r.ok) {
        setServerAuth('unknown');
        setServerAuthMessage(`查不到服务器授权（${r.error ?? '未知原因'}），只按本地授权码判断`);
        return;
      }
      if (r.authorized === false) {
        setServerAuth('denied');
        setServerAuthMessage('管理员已在服务器上关闭了这个学号的授权');
        return;
      }
      setServerAuth('granted');
      setServerAuthMessage(
        r.authorized === true ? '服务器确认这个学号已授权' : '这个学号还没登记到服务器',
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [account?.studentId]);

  /**
   * 综合判定 —— **签到前必须过这一关**。
   *
   * 本地码通过（已含"码里的学号哈希 == 当前登录学号"这一条）
   * **且** 服务器没有明确拒绝。
   */
  const entitled = unlocked && serverAuth !== 'denied';

  /**
   * 提交授权码 / 万能码。
   *
   * ⚠️ 现在是 **async** —— 因为万能码要先问管理服务端。
   *    这样"在网页上改万能码"能立刻生效，不用重新打包 App。
   *
   * 降级策略（关键）：
   *   服务器没配 / 连不上 / 超时 → **退回用 App 内置的码**，
   *   绝不能因为服务器挂了就把用户挡在外面。
   */
  const submit = useCallback(
    async (raw: string): Promise<CodeCheckResult> => {
      const code = raw.trim();
      const parsed = parseLicenseCode(code);
      const isMaster = parsed.ok && parsed.info.isMaster === true;

      // 只有"一人一码"才要求先绑账号；万能码放行
      if (!isMaster && !account?.studentId) {
        return { status: 'empty', message: '请先绑定优学院账号，再填授权码（万能码不受此限制）' };
      }

      // ── 万能码：先问服务器 ──
      if (isMaster) {
        const base = await getServerBase();
        /**
         * ★ 把**用户输入的这个码**发给服务器校验，不再取回明文比对。
         *
         * ⚠️ 这里有个必须区分清楚的状态：
         *    `sr.ok === false`  → **连不上服务器**（网络问题）
         *        → 退回内置码兜底（老的宽松策略，避免服务器挂了把人挡死）
         *    `sr.ok === true && sr.valid === false` → **服务器明确说不对**
         *        → 不再拿内置码兜底（否则会造成困惑：明明服务器说不对却放行）
         *    `sr.ok === true && sr.valid === true`  → 通过
         */
        let serverCodeOk: boolean | null = null;
        if (base) {
          const sr = await verifyMasterCode(base, code);
          if (sr.ok) serverCodeOk = sr.valid === true;
        }

        if (serverCodeOk === true) {
          {
            /**
             * ★ 万能码正确 → 向服务器**领取这个学号的个人授权码**并记下来。
             *
             * 这样"万能码改变后权限降为授权码权限"才有依托：
             * 管理员改了万能码，这个人本地的个人码仍然有效，
             * 只是权限从 'all'（改任何人）降为 'self'（只能改自己）。
             *
             * ⚠️ 领码失败**不影响本次解锁** —— 不能因为服务器问题把人挡在外面。
             */
            let personalCode = stored?.personalCode ?? '';
            let grantedMsg = '';
            if (account?.studentId) {
              const g = await grantPersonalCode(base, {
                studentId: account.studentId,
                studentName: account.studentName,
              });
              if (g.ok && g.personalCode) {
                personalCode = g.personalCode;
                grantedMsg = '　已记下你的个人授权码（万能码失效后仍可用）';
              } else {
                grantedMsg = '　（个人码领取失败，不影响本次使用）';
              }
            }

            const rec: StoredCode = {
              code,
              studentId: account?.studentId ?? '',
              savedAt: Date.now(),
              status: 'granted',
              ...(personalCode ? { personalCode } : {}),
            };
            setStored(rec);
            void store.set(STORE_KEYS.unlockCode, rec);
            return {
              status: 'granted',
              message: `通用码通过${grantedMsg}`,
              masterSource: 'server',
              // 万能码 → 可以改**任何人**
              scope: 'all',
            };
          }
        }

        if (serverCodeOk === false) {
          /**
           * ⚠️⚠️ 这里**绝对不能**回显服务器上的万能码。
           *
           * 原先写的是：`不对。服务器上当前的万能码是「${serverCode}」`
           * —— 那等于**填错一次就白送答案**，任何人试一次就能拿到万能码，
           * 而万能码能改所有人的签到状态。这是整个授权体系里最严重的漏洞。
           *
           * 所以：只告诉他"不对"，不透露任何关于正确答案的信息。
           */
          return {
            status: 'invalid',
            message: '通用码不对。请向管理员确认后再试。',
            masterSource: 'server',
          };
        }

        // 服务器不可用 → 退回内置码
        /**
         * 走到这里说明：**服务器不可用**（没配地址 / 连不上）。
         * 那就退回内置码 —— 这是刻意的宽松策略：
         * 服务器挂了不该把所有人挡在门外。
         */
        const r = checkCodeForStudent({ code, studentId: account?.studentId ?? '' });
        if (r.status === 'granted') {
          const rec: StoredCode = {
            code,
            studentId: account?.studentId ?? '',
            savedAt: Date.now(),
            status: r.status,
            expiresAt: r.expiresAt,
          };
          setStored(rec);
          void store.set(STORE_KEYS.unlockCode, rec);
          return {
            ...r,
            // ⚠️ 提示里**不带出任何码**
            message: `${r.message}（服务器不可用，用的是内置码）`,
            masterSource: 'builtin',
          };
        }
        return r;
      }

      // ── 普通一人一码：本地校验 ──
      const r = checkCodeForStudent({ code, studentId: account?.studentId ?? '' });
      if (r.status === 'granted') {
        const rec: StoredCode = {
          code,
          studentId: account?.studentId ?? '',
          savedAt: Date.now(),
          status: r.status,
          expiresAt: r.expiresAt,
        };
        setStored(rec);
        void store.set(STORE_KEYS.unlockCode, rec);
      }
      return r;
    },
    [account?.studentId],
  );

  const clear = useCallback(async () => {
    setStored(null);
    await store.remove(STORE_KEYS.unlockCode);
  }, []);

  /**
   * ★★★ 决定"配额校验送哪份码"。
   *
   * ══════════════ 🚨 真实 bug（2026-10，用户截图报的）══════════════
   *
   * 现象：改签到状态报「这个授权码不属于当前学号」，但设置页显示有权。
   *
   * 复现（打云端 `/api/consume` 实测）：
   *   · 云端记的个人码 `LK1-…222MY-…` → allow=true
   *   · 万能码（`EXPO_PUBLIC_MASTER_CODE`）→ allow=true
   *   · **旧**个人码 `LK1-…2MLVF-…`   → allow=false **code_mismatch** ← 截图那句
   *
   * 根因：`stored.personalCode` 是当初换来的，**服务器换码后就作废了**；
   *   而"万能码被改 → 降级用个人码"这条路会把它送上去 → 被拦死。
   *
   * 修法：**手里是万能码就优先送万能码**（服务器认它，不绑学号）；
   *   只有确实没万能码时才退回个人码。
   */
  const quotaCode = useMemo(() => {
    if (!stored) return null;
    const parsed = parseLicenseCode(stored.code);
    const isMaster = parsed.ok && parsed.info.isMaster === true;
    /**
     * ⚠️ 万能码**不受"服务器说它被改了"影响** ——
     *    即使 masterNowOk === false，把万能码送上去也是对的：
     *    服务器会自己判断认不认（认就放行，不认会明确回 reason）。
     *    退而送一份可能过期的个人码，只会得到一句看不懂的
     *    「这个授权码不属于当前学号」。
     */
    if (isMaster) return stored.code;
    return stored.personalCode || stored.code;
  }, [stored]);

  const value = useMemo(
    () => ({
      unlocked,
      result,
      code: stored?.code ?? null,
      quotaCode,
      ready,
      serverAuth,
      serverAuthMessage,
      entitled,
      scope,
      actions: { submit, clear },
    }),
    [
      unlocked,
      result,
      stored?.code,
      quotaCode,
      ready,
      serverAuth,
      serverAuthMessage,
      entitled,
      scope,
      submit,
      clear,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUnlock() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useUnlock 必须在 UnlockProvider 内使用');
  return v;
}

/** 给界面用的状态文案 */
export function unlockText(status: CodeCheckStatus): { title: string; hint: string } {
  return CODE_STATUS_TEXT[status];
}
