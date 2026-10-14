/**
 * 诊断页 —— 把运行时真实状态摊开，用来定位"在我这儿对、在你手机上不对"的问题。
 *
 * 为什么需要它：
 *   顶部留白、账号"已绑定却说未绑定"这两个问题，
 *   我这边没有你的设备，只能靠猜 —— 猜了两轮都没中。
 *   这个页面把关键数据直接显示出来，长按可复制，一次就能定位。
 *
 * ⚠️ 只显示"密钥名 + 值长度"，不显示 cookie 全文（避免泄露会话）。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native';
import * as FileSystem from 'expo-file-system';
import Constants from 'expo-constants';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { currentAdapterKind, resolveTenant } from '../services/checkin';
import { store, storageFaults, STORE_KEYS } from '../services/storage';
import { useCheckin } from '../state/checkinStore';
import { parseUserIdFromCookie } from '../services/checkin/youxueAdapter';
import { useTopInset, useBottomInset } from '../theme/useInsets';

interface Report {
  title: string;
  rows: Array<[string, string]>;
}

export function DiagnosticsScreen() {
  const insets = useSafeAreaInsets();
  const topInset = useTopInset();
  const bottomInset = useBottomInset();
  const { account, courses, sessionState } = useCheckin();

  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);

  const build = useCallback(async () => {
    setLoading(true);
    const out: Report[] = [];

    // ---- 0. 构建标识（最关键：确认装的是哪个包）----
    out.push({
      title: '⓪ 构建与适配器',
      rows: [
        ['App 版本', Constants.expoConfig?.version ?? '(未知)'],
        ['versionCode', String(Constants.expoConfig?.android?.versionCode ?? '(未知)')],
        ['★ 适配器', currentAdapterKind() === 'youxue' ? 'youxue（连真实优学院）' : '★ mock（假数据！）'],
        ['★ 判断依据', 'src/config/buildConfig.ts 的 ADAPTER 常量（编译期生效）'],
        ['租户', resolveTenant()],
        ['包名', Constants.expoConfig?.android?.package ?? '(未知)'],
      ],
    });

    // ---- 1. 安全区 ----
    const sbHeight = Platform.OS === 'android' ? StatusBar.currentHeight : undefined;
    out.push({
      title: '① 安全区（顶部留白）',
      rows: [
        ['平台', Platform.OS],
        ['Provider insets.top', String(insets.top)],
        ['Provider insets.bottom', String(insets.bottom)],
        ['StatusBar.currentHeight', sbHeight === undefined ? '(无)' : String(sbHeight)],
        ['→ 实际用的顶部留白', `${topInset} dp`],
        ['→ 实际用的底部留白', `${bottomInset} dp`],
        [
          '判断',
          insets.top > 0
            ? 'Provider 正常'
            : sbHeight
              ? 'Provider 给 0，已用 StatusBar 兜底'
              : '两个来源都没值，用了最小值 24',
        ],
      ],
    });

    // ---- 2. 账号状态 ----
    const isMockAccount = Boolean(account?.id?.startsWith('mock-'));
    out.push({
      title: '② 优学院账号',
      rows: [
        ['是否有 account', account ? '有' : '没有'],
        ['account.id', account?.id ?? '(空)'],
        [
          '★ 账号类型',
          isMockAccount
            ? '★ mock 账号（假数据）—— 请「换账号」重新绑定真实学号'
            : account
              ? '真实账号'
              : '(无)',
        ],
        ['学号', account?.studentId ?? '(空)'],
        ['姓名', account?.studentName ?? '(空)'],
        ['会话状态', sessionState],
        ['已读课程数', String(courses.length)],
        ['绑定时间', account ? new Date(account.boundAt).toLocaleString('zh-CN') : '(空)'],
      ],
    });

    // ---- 3. 登录凭据（关键！）----
    if (account) {
      const key = `${STORE_KEYS.account}.cred.${account.id}`;
      const cred = await store.get<{
        mode?: string;
        studentId?: string;
        userId?: number;
        cookies?: Record<string, string>;
        userAgent?: string;
      } | null>(key, null);

      const cookieKeys = cred?.cookies ? Object.keys(cred.cookies) : [];
      const token = cred?.cookies?.AUTHORIZATION ?? cred?.cookies?.token ?? '';
      const cookieUserId = parseUserIdFromCookie(cred?.cookies);
      const effectiveUserId = cred?.userId ?? cookieUserId;

      out.push({
        title: '③ 登录凭据（签到功能依赖它）',
        rows: [
          ['存储键', key],
          ['凭据是否存在', cred ? '有' : '★ 没有（这就是"未绑定"的原因）'],
          ['cred.mode', cred?.mode ?? '(空)'],
          ['cred.studentId', cred?.studentId ?? '(空)'],
          ['cred.userId', cred?.userId === undefined ? '(空)' : String(cred.userId)],
          ['cookie 里解析出的 userId', cookieUserId === undefined ? '(空)' : String(cookieUserId)],
          ['→ 最终能用的 userId', effectiveUserId === undefined ? '★ 没有（签到接口用不了）' : String(effectiveUserId)],
          ['token 是否存在', token ? `有（${token.length} 字符）` : '★ 没有'],
          ['cookie 数量', String(cookieKeys.length)],
          ['cookie 名称', cookieKeys.length ? cookieKeys.join(', ') : '(空)'],
          ['userAgent', cred?.userAgent ? `有（${cred.userAgent.length} 字符）` : '(空)'],
        ],
      });
    }

    // ---- 3.1 ★ 列出磁盘上所有账号凭据（排查"换账号串数据"）----
    // 这节是为了回答"到底存了几个账号、当前用的是哪个"。
    // 之前只能逐个 key 猜，导致换账号串数据的排查绕了很久。
    {
      const allCredKeys = await store.listKeys(`${STORE_KEYS.account}.cred.`);
      const rows: Array<[string, string]> = [];
      rows.push(['磁盘上的账号凭据数', String(allCredKeys.length)]);
      rows.push(['当前账号 id', account?.id ?? '(未绑定)']);

      for (const k of allCredKeys) {
        const id = k.slice(`${STORE_KEYS.account}.cred.`.length);
        const c = await store.get<{ studentId?: string; userId?: number } | null>(k, null);
        const isCurrent = account?.id === id;
        rows.push([
          `${isCurrent ? '★ 当前 ' : '· '}${id}`,
          `学号=${c?.studentId ?? '?'} userId=${c?.userId ?? '?'}`,
        ]);
      }

      // 关键判断：当前账号有没有对应凭据？
      if (account) {
        const mine = allCredKeys.includes(`${STORE_KEYS.account}.cred.${account.id}`);
        rows.push([
          '★ 当前账号有凭据吗',
          mine ? '有' : '★ 没有 —— 换账号没有真正登录成功，仍在用旧账号',
        ]);
      }

      // 概览缓存也按账号分开，一并列出来
      const ovKeys = await store.listKeys(STORE_KEYS.signOverview);
      rows.push(['概览缓存 key', ovKeys.length ? ovKeys.join('、') : '(无)']);
      const legacyOv = await store.get<{ user?: { userId?: number } } | null>(STORE_KEYS.signOverview, null);
      if (legacyOv) {
        rows.push([
          '★ 旧版全局缓存',
          `还在（userId=${legacyOv.user?.userId ?? '?'}）—— 属于旧账号残留`,
        ]);
      }

      out.push({ title: '③-1 ★ 所有已存账号（排查换账号）', rows });
    }

    // ---- 4. 关键存储键逐个探 ----
    // store 没有 keys()，所以按已知键逐个查（更直接，也顺带验证读写是否正常）
    const probeKeys: Array<[string, string]> = [
      ['账号列表', STORE_KEYS.account],
      ['解锁码', STORE_KEYS.unlockCode],
      ['签到概览缓存', STORE_KEYS.signOverview],
      ['崩溃日志', STORE_KEYS.crashLog],
    ];
    if (account) probeKeys.push(['本账号凭据', `${STORE_KEYS.account}.cred.${account.id}`]);

    const probeRows: Array<[string, string]> = [];
    for (const [label, k] of probeKeys) {
      try {
        const v = await store.get<unknown>(k, null);
        if (v === null || v === undefined) {
          probeRows.push([label, '（空）']);
        } else if (typeof v === 'object') {
          probeRows.push([label, `有（${Object.keys(v as object).length} 个字段）`]);
        } else {
          probeRows.push([label, `有（${String(v).slice(0, 40)}）`]);
        }
      } catch (e) {
        probeRows.push([label, `读取失败: ${(e as Error).message}`]);
      }
    }
    out.push({ title: '④ 关键存储键', rows: probeRows });

    // ---- 4.2 文件系统自测（关键！）----
    // 直接测试"写一个文件再读回来"，看存储到底能不能用。
    // 如果这里失败，那凭据、日志全都存不住 —— 一切异常的根因。
    const fsRows: Array<[string, string]> = [];
    fsRows.push(['FileSystem 是否有 API', typeof FileSystem.writeAsStringAsync === 'function' ? '有' : '★ 没有（API 不匹配）']);
    fsRows.push(['documentDirectory', FileSystem.documentDirectory ?? '★ null']);
    fsRows.push(['cacheDirectory', FileSystem.cacheDirectory ?? '★ null']);
    try {
      const dir = `${FileSystem.documentDirectory}lifekit`;
      fsRows.push(['目标目录', dir]);
      const di = await FileSystem.getInfoAsync(dir);
      fsRows.push(['目录是否存在', di.exists ? '是' : '★ 否']);
      if (!di.exists) {
        await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
        fsRows.push(['尝试建目录', '已执行']);
      }
      const testPath = `${dir}/__selftest.json`;
      const payload = JSON.stringify({ t: Date.now(), probe: 'ok' });
      await FileSystem.writeAsStringAsync(testPath, payload);
      fsRows.push(['写入测试文件', '成功']);
      const ri = await FileSystem.getInfoAsync(testPath);
      fsRows.push(['写后文件存在', ri.exists ? '是' : '★ 否']);
      const back = await FileSystem.readAsStringAsync(testPath);
      fsRows.push(['读回内容一致', back === payload ? '是' : '★ 否']);
      fsRows.push(['读回内容', back.slice(0, 60)]);
    } catch (e) {
      fsRows.push(['★ 自测抛错', (e as Error).message]);
      fsRows.push(['★ 错误栈', (e as Error).stack?.split('\n').slice(0, 3).join(' | ') ?? '(无)']);
    }
    out.push({ title: '④.2 文件系统自测', rows: fsRows });

    // ---- 4.5 存储故障记录 ----
    out.push({
      title: '④.5 存储故障（读写报错会记在这里）',
      rows: storageFaults.length
        ? storageFaults.map((f, i) => [`[${i}]`, f] as [string, string])
        : [['（无）', '没有出现过读写错误']],
    });

    // ---- 5. 期望的键 ----
    out.push({
      title: '⑤ STORE_KEYS 定义',
      rows: Object.entries(STORE_KEYS).map(([k, v]) => [k, String(v)]),
    });

    setReports(out);
    setLoading(false);
  }, [account, courses.length, insets.bottom, insets.top, sessionState, topInset, bottomInset]);

  useEffect(() => {
    void build();
  }, [build]);

  const fullText = reports
    .map((r) => `【${r.title}】\n` + r.rows.map(([k, v]) => `  ${k}: ${v}`).join('\n'))
    .join('\n\n');

  return (
    <View style={styles.wrap}>
      <View style={styles.bar}>
        <Pressable onPress={() => void build()} style={styles.btn}>
          <Text style={styles.btnText}>{loading ? '读取中…' : '重新读取'}</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.hint}>
          长按下面任意文字可选中复制，把整段发给开发者即可定位问题。
        </Text>

        {reports.map((r) => (
          <View key={r.title} style={styles.card}>
            <Text style={styles.cardTitle} selectable>
              {r.title}
            </Text>
            {r.rows.map(([k, v], i) => (
              <View key={`${k}-${i}`} style={styles.row}>
                <Text style={styles.key} selectable>
                  {k}
                </Text>
                <Text style={[styles.val, v.startsWith('★') && styles.bad]} selectable>
                  {v}
                </Text>
              </View>
            ))}
          </View>
        ))}

        <View style={styles.card}>
          <Text style={styles.cardTitle} selectable>
            ⑥ 可复制的纯文本
          </Text>
          <Text style={styles.mono} selectable>
            {fullText}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#F9FAFB' },
  bar: {
    flexDirection: 'row',
    padding: 12,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
  },
  btn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 8, backgroundColor: '#EEF2FF' },
  btnText: { fontSize: 14, color: '#4F46E5', fontWeight: '500' },
  content: { padding: 14, paddingBottom: 80 },
  hint: { fontSize: 12.5, color: '#6B7280', marginBottom: 12, lineHeight: 18 },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    padding: 12,
    marginBottom: 12,
  },
  cardTitle: { fontSize: 14, fontWeight: '700', color: '#111827', marginBottom: 8 },
  row: { flexDirection: 'row', paddingVertical: 3, gap: 8 },
  key: { width: 150, fontSize: 11.5, color: '#6B7280', fontFamily: 'monospace' },
  val: { flex: 1, fontSize: 11.5, color: '#111827', fontFamily: 'monospace' },
  bad: { color: '#DC2626', fontWeight: '700' },
  mono: { fontSize: 10.5, color: '#374151', fontFamily: 'monospace', lineHeight: 15 },
});
