/**
 * 服务器用户管理 —— **把某个账号踢出我的服务器**。
 *
 * ══════════════ 用户需求（原话）══════════════
 *
 *   「能不能给我 lifekit 加一个功能，把某个账号踢出我的服务器，
 *     别人查的时候找不到我」
 *
 * ══════════════ 这个页面做什么 ══════════════
 *
 * LifeKit 的服务器（`server.cjs`）会登记每个登录过的学号。
 * 这个页面让你在**手机上**直接管理这份名单：
 *
 *   · 读用户列表（学号/姓名/最后登录/是否授权）
 *   · **踢出**：删除该学号的记录 → 它从名单里消失；
 *     对方 App 再来查授权状态时得到"未登记" → 需要授权的功能用不了
 *   · **停用 / 恢复**：保留记录，只是 `authorized=false`（可恢复）
 *
 * ══════════════ ⚠️ 安全设计（必读）══════════════
 *
 * 服务端这三个接口都要 **HTTP Basic 管理口令**（`admin:<口令>`）：
 *   GET  /api/users         —— 用户列表
 *   POST /api/user/delete   —— 踢出（删除）
 *   POST /api/user/update   —— 停用/恢复
 *
 * ⚠️ 口令**只存在这个页面的内存里**：
 *    · 不写进本地存储（否则谁拿到手机就拿到了管理权）
 *    · 不硬编码进 APK（APK 能反编译，等于公开）
 *    · 离开页面即丢弃，下次进来要重新输
 *
 * ⚠️ 「踢出」不可恢复（记录删了就没了）。想留后路用「停用」。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import {
  Badge,
  Banner,
  Button,
  Card,
  Col,
  Field,
  Row,
  ScreenScroll,
  Section,
  Spacer,
  Txt,
} from '../components';
import { color, spacing } from '../theme/tokens';
import {
  adminFetchUsers,
  adminKickUser,
  adminSetUserAuthorized,
  getServerBase,
  type AdminUserRecord,
} from '../services/serverClient';

/** 学号打码：只留前 4 位和后 2 位（管理页面上也少露一点） */
function maskStudentId(sid: string): string {
  const s = String(sid ?? '');
  if (s.length <= 6) return s;
  return `${s.slice(0, 4)}****${s.slice(-2)}`;
}

function fmtTime(t?: number): string {
  if (!t || !Number.isFinite(t)) return '—';
  try {
    return new Date(t).toLocaleString('zh-CN');
  } catch {
    return '—';
  }
}

export function ServerAdminScreen() {
  const [base, setBase] = useState('');
  /** ⚠️ 只放内存，不落盘（见文件头注释） */
  const [password, setPassword] = useState('');
  const [users, setUsers] = useState<AdminUserRecord[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'info' | 'error' | 'warning'; text: string } | null>(null);

  useEffect(() => {
    void (async () => {
      setBase(await getServerBase());
    })();
  }, []);

  const load = useCallback(async () => {
    if (!base.trim()) {
      setMsg({ tone: 'warning', text: '还没配置服务器地址 —— 先到「设置 → 管理服务器」里填。' });
      return;
    }
    if (!password.trim()) {
      setMsg({ tone: 'warning', text: '请输入管理口令（和电脑上管理页那个口令一样）。' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await adminFetchUsers(base, password);
      if (!r.ok) {
        setMsg({ tone: 'error', text: r.error });
        return;
      }
      /** 最近登录的排前面，找谁在用更直观 */
      const sorted = [...r.users].sort((a, b) => (b.lastLoginAt ?? 0) - (a.lastLoginAt ?? 0));
      setUsers(sorted);
      setMsg({ tone: 'info', text: `读取成功：共 ${sorted.length} 个账号` });
    } finally {
      setBusy(false);
    }
  }, [base, password]);

  /**
   * 踢出：删除记录（不可恢复）。
   *
   * ⚠️ 必须二次确认 —— 删错了只能让对方重新登录再登记一遍，
   *    而授权码也要重发，所以别手滑。
   */
  const doKick = useCallback(
    async (studentId: string) => {
      setBusyId(studentId);
      setMsg(null);
      try {
        const r = await adminKickUser(base, password, studentId);
        if (!r.ok) {
          setMsg({ tone: 'error', text: `踢出失败：${r.error}` });
          return;
        }
        setUsers((prev) => (prev ? prev.filter((x) => x.studentId !== studentId) : prev));
        setMsg({ tone: 'info', text: `已踢出 ${studentId}（记录已删除）` });
      } finally {
        setBusyId(null);
      }
    },
    [base, password],
  );

  /**
   * ⚠️ `kick` 必须写在 `doKick` **之后**：
   *    依赖数组 `[doKick]` 是在**渲染时求值**的，
   *    写在前面会立刻读到一个还在暂时性死区里的 const → 直接 ReferenceError。
   *    （同样的坑在 LoginEntry 那次也踩过，报错信息完全不指向这里。）
   */
  const kick = useCallback(
    (u: AdminUserRecord) => {
      Alert.alert(
        '踢出这个账号？',
        `学号：${u.studentId}\n姓名：${u.studentName ?? '（未填）'}\n\n` +
          '会把这条记录从服务器上**删除**：\n' +
          '· 用户列表里再也看不到它\n' +
          '· 对方 App 查不到授权 → 需要授权的功能用不了\n\n' +
          '⚠️ 不可恢复。只想暂时停用 → 用「停用」。',
        [
          { text: '取消', style: 'cancel' },
          {
            text: '踢出',
            style: 'destructive',
            onPress: () => void doKick(u.studentId),
          },
        ],
      );
    },
    [doKick],
  );

  /** 停用 / 恢复（保留记录） */
  const toggleAuthorized = useCallback(
    async (u: AdminUserRecord) => {
      const next = !u.authorized;
      setBusyId(u.studentId);
      setMsg(null);
      try {
        const r = await adminSetUserAuthorized(base, password, u.studentId, next);
        if (!r.ok) {
          setMsg({ tone: 'error', text: `操作失败：${r.error}` });
          return;
        }
        setUsers((prev) =>
          prev ? prev.map((x) => (x.studentId === u.studentId ? { ...x, authorized: next } : x)) : prev,
        );
        setMsg({ tone: 'info', text: next ? `已恢复 ${u.studentId} 的授权` : `已停用 ${u.studentId}（记录保留）` });
      } finally {
        setBusyId(null);
      }
    },
    [base, password],
  );

  const authorizedCount = users?.filter((u) => u.authorized).length ?? 0;

  return (
    <ScreenScroll>
      <Section style={{ marginTop: spacing.md }} title="服务器用户管理">
        <Card>
          <Txt variant="small" c={color.text.secondary} style={{ lineHeight: 19 }}>
            {'管理服务器上登记过的账号 —— 可以把某个账号「踢出」：\n'}
            {'记录被删掉后，对方 App 查不到授权，需要授权的功能就用不了。\n\n'}
            {'口令只在本页面内存里，不会保存；离开页面要重新输入。'}
          </Txt>

          <Spacer h={spacing.md} />
          <Txt variant="caption" c={color.text.tertiary}>
            {`服务器：${base || '（未配置，去「设置 → 管理服务器」填）'}`}
          </Txt>

          <Spacer h={spacing.sm} />
          <Field
            label="管理口令"
            value={password}
            onChangeText={setPassword}
            placeholder="和电脑上管理页的口令一样"
            secureTextEntry
            hint="服务端只存哈希，所以这里必须手输；我们不保存它"
          />

          <Button
            label={busy ? '读取中…' : '读取用户列表'}
            onPress={() => void load()}
            disabled={busy}
          />

          {users ? (
            <>
              <Spacer h={spacing.md} />
              <Row justify="space-between">
                <Txt variant="caption" c={color.text.secondary}>
                  {`共 ${users.length} 个账号`}
                </Txt>
                <Txt variant="caption" c={color.text.tertiary}>
                  {`已授权 ${authorizedCount} 个`}
                </Txt>
              </Row>
            </>
          ) : null}
        </Card>
      </Section>

      {msg ? (
        <Section>
          <Banner
            tone={msg.tone === 'info' ? 'info' : msg.tone === 'warning' ? 'warning' : 'error'}
            title={msg.text}
            actionLabel="知道了"
            onAction={() => setMsg(null)}
          />
        </Section>
      ) : null}

      {users && users.length > 0 ? (
        <Section title="用户列表">
          {users.map((u, i) => (
            <Card key={u.studentId} style={{ marginBottom: i === users.length - 1 ? 0 : spacing.sm }}>
              <Row justify="space-between" align="center" gap={spacing.sm}>
                <Col flex={1} gap={2}>
                  <Row gap={spacing.sm} align="center">
                    <Txt variant="body2" weight="medium">
                      {u.studentName?.trim() || '（未填姓名）'}
                    </Txt>
                    <Badge
                      text={u.authorized ? '已授权' : '未授权'}
                      fg={u.authorized ? color.success[600] : color.neutral[500]}
                      bg={u.authorized ? color.success[50] : color.neutral[100]}
                    />
                  </Row>
                  <Txt variant="caption" c={color.text.tertiary}>
                    {`学号 ${maskStudentId(u.studentId)}　最后登录 ${fmtTime(u.lastLoginAt)}`}
                  </Txt>
                </Col>
              </Row>

              <Spacer h={spacing.sm} />
              <Row gap={spacing.sm}>
                <Button
                  label={u.authorized ? '停用' : '恢复'}
                  variant="secondary"
                  onPress={() => void toggleAuthorized(u)}
                  disabled={busyId === u.studentId}
                  style={{ flex: 1 }}
                />
                <Button
                  label={busyId === u.studentId ? '处理中…' : '踢出'}
                  variant="danger"
                  onPress={() => kick(u)}
                  disabled={busyId === u.studentId}
                  style={{ flex: 1 }}
                />
              </Row>
            </Card>
          ))}
        </Section>
      ) : null}

      {users && users.length === 0 ? (
        <Section>
          <Card>
            <Txt variant="body2" c={color.text.secondary}>
              服务器上还没有登记任何账号。
            </Txt>
          </Card>
        </Section>
      ) : null}

      <Section>
        <Txt variant="caption" c={color.text.tertiary} style={{ lineHeight: 17 }}>
          {'「踢出」= 删除记录（不可恢复）；「停用」= 保留记录但取消授权（可恢复）。\n'}
          {'⚠️ 这是管理操作，别把口令告诉不该告诉的人。'}
        </Txt>
      </Section>
    </ScreenScroll>
  );
}
