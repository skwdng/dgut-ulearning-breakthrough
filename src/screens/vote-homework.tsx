/**
 * 「作业 / 投票」接口探测页 —— 用已登录会话读优学院接口的真实返回。
 *
 * ══════════════ 为什么先「探测」而不是直接做功能 ══════════════
 *
 * 需求是「改投票」和「补交作业」，但这两个功能的接口结构目前未知：
 *   · 投票：课堂活动列表里 relationType === 2 就是投票，
 *     可「查看 / 提交 / 修改投票」的路径与参数没有实测记录。
 *     未登录时 /apps/newVote/* 这类路径一律回「缺少访问token」，
 *     网关在路由之前就拦了 —— 未登录探测分不出真假。
 *   · 作业：/courseapi/homeworks/student（列表）与 /courseapi/homeworks/submit
 *     （提交，GET 回 405）确认存在，但请求 / 响应字段未知。
 *
 * 所以先用真实会话发只读 GET，把响应原样打印出来；
 * 拿到结构之后再实现「补交 / 改投票」，不用猜字段反复试错。
 *
 * ⚠️ 本页只发 GET：不会提交作业、不会投票、不会改任何数据。
 *    「提交接口存在性」那几条也只发 GET（服务端回 405 恰好证明路径存在）。
 *
 * 移植自 uassist 的 src/screens/vote-homework.tsx（只保留探测逻辑，
 * 界面重写成 LifeKit 的组件 + tokens；那边是一次性排查页，样式没有复用价值）。
 */
import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Badge, Button, Card, Field, Row, ScreenScroll, Section, Spacer, Txt } from '../components';
import { color, radius, spacing } from '../theme/tokens';
import { useSign } from '../state/signStore';

/** 一组要探测的路径 */
interface Probe {
  label: string;
  path: string;
}

/**
 * 作业相关候选（只读）。
 * ⚠️ submit 那条只用来确认存在性（服务端对 GET 回 405），不会真的提交。
 */
const HOMEWORK_PROBES: Probe[] = [
  { label: '作业列表（常见分页参数）', path: '/courseapi/homeworks/student?pageNum=1&pageSize=20' },
  { label: '作业列表（pn/ps 参数）', path: '/courseapi/homeworks/student?pn=1&ps=20' },
  { label: '作业列表（带 publishStatus）', path: '/courseapi/homeworks/student?publishStatus=1&pn=1&ps=20' },
  { label: '作业（旧前缀）', path: '/courseapi/homeworks?pageNum=1&pageSize=20' },
  { label: '提交接口存在性（GET 应回 405，不会真提交）', path: '/courseapi/homeworks/submit' },
  { label: 'app 作业详情', path: '/apps/homework/getDetail?id=1' },
  { label: 'app 作业列表', path: '/apps/newHomework/getDetail?id=1' },
];

/**
 * 投票 / 答题接口候选（只读 GET）。
 *
 * ★ 2026-10-30 更新：**从"猜命名"改成"已知真实路径"**。
 *
 * 依据（真机探测 + H5 源码）：
 *   · 旧猜测（newVote / vote / wisdomVote / classroomVote / getActivityDetail）
 *     在真机上全部 **404（Apache Tomcat 错误页）** —— 说明这些路径不存在，
 *     不是"没权限"。
 *   · 从优学院移动端 H5 的 API 模块（`.recon/umobile/src-async.*.js`）里挖到真名：
 *       投票详情  GET /apps/voteV2/detail/{voteId}/{userId}/{classId}
 *       投票提交  POST /apps/voteV2/stuSubmit
 *       答题详情  GET /smartapi/replyquestion/student/detail/{id}
 *       答题提交  POST /smartapi/replyquestion/stuReply
 *       活动列表  GET /courseapi/wisdomClassroom/student/classroomActivitys?…
 *   · 并且这些路径在未登录时是 401/405（存在），bogus 路径是 404（可判别）。
 *
 * ⚠️ 这里仍然只发 GET：POST 只用来确认"GET 会回 405"（存在性），不会真的提交。
 */
const VOTE_PROBES: Probe[] = [
  { label: '活动列表（真实路径，课堂 id 先用 1 试结构）', path: '/courseapi/wisdomClassroom/student/classroomActivitys?classroomId=1&pageSize=20&pageNum=1' },
  { label: '活动列表（去掉 type 参数）', path: '/courseapi/wisdomClassroom/student/classroomActivitys?classroomId=1&pageSize=20&pageNum=1&type=1' },
  { label: '投票详情 voteV2（id 占位 1/1/1，看返回结构）', path: '/apps/voteV2/detail/1/1/1' },
  { label: '答题详情 replyquestion（id 占位 1）', path: '/smartapi/replyquestion/student/detail/1' },
  { label: '投票提交存在性（GET 应回 405/401，不会真投）', path: '/apps/voteV2/stuSubmit' },
  { label: '答题提交存在性（GET 应回 405/401）', path: '/smartapi/replyquestion/stuReply' },
  { label: '对照：旧猜测 newVote（真机已确认 404）', path: '/apps/newVote/getDetail?id=1' },
];

/**
 * 用课堂 id 拼活动列表探测（投票/答题都在这一组里）。
 *
 * ★ 2026-10-31：又一次修正，这次有 H5 源码 + 真机双重证据。
 *   · H5 配置模块 mZex：`API_HOST = https://lms.<域名>/courseapi`，
 *     学生端活动列表用的就是它（`c.get("/wisdomClassroom/student/classroomActivitys?…")`）。
 *   · 真机实测（2026-10-31）：用课堂 id 447767 打 `/courseapi/...` 能读到 3 条活动；
 *     而 `/classroomapi/...` 回 `{"code":0,"message":"失败","result":null}`（路由在、业务不认）。
 *   · 2026-10-30 那句"courseapi 下这个路径是 404"是**错的**，已删 ——
 *     当时只看了未登录探测的 401/404 差异，把"另一个前缀也 401"误读成"这个前缀不行"。
 */
function activityProbes(classroomId: string): Probe[] {
  const cid = classroomId.trim() || '0';
  return [
    {
      label: `课堂活动列表（课堂 ${cid}，带 type=1）`,
      path: `/courseapi/wisdomClassroom/student/classroomActivitys?classroomId=${cid}&pageSize=100&pageNum=1&type=1`,
    },
    {
      label: `课堂活动列表（课堂 ${cid}，不带 type）`,
      path: `/courseapi/wisdomClassroom/student/classroomActivitys?classroomId=${cid}&pageSize=100&pageNum=1`,
    },
    {
      label: `课堂活动列表（课堂 ${cid}，学生视图 student/activitys）`,
      path: `/courseapi/wisdomClassroom/student/activitys?classroomId=${cid}&pageSize=100&pageNum=1`,
    },
  ];
}

/**
 * 用真实活动 id 探测「投票 / 答题」详情。
 *
 * 投票：`voteId` 用活动列表里的 relationId；userId/classId 先填占位，
 *       只要路径对，返回会是"业务错误"而不是 404 —— 那时就能看出结构。
 * 答题：`replyquestion/student/detail/{id}`，id 用 relationId。
 */
function voteDetailProbes(activityId: string): Probe[] {
  const id = activityId.trim() || '1';
  return [
    { label: `投票详情 voteV2（voteId=${id}）`, path: `/apps/voteV2/detail/${id}/1/1` },
    { label: `投票详情 voteV2（classId 占位 -1）`, path: `/apps/voteV2/detail/${id}/1/-1` },
    { label: `答题详情 replyquestion（id=${id}）`, path: `/smartapi/replyquestion/student/detail/${id}` },
    { label: '投票提交存在性（GET 应回 405）', path: '/apps/voteV2/stuSubmit' },
    { label: '答题提交存在性（GET 应回 405）', path: '/smartapi/replyquestion/stuReply' },
    { label: '答题改答案存在性（GET 应回 405）', path: '/smartapi/replyquestion/stuChangeReply' },
  ];
}

/**
 * 把一段响应压成一行再截断。
 * 为什么压空白：接口返回普遍是压缩过的一行 JSON，
 * 不压的话换行/缩进会把结果撑成几百行，手机上看不动也复制不动。
 */
function clip(s: string, n = 700): string {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n)}…（共 ${t.length} 字符）` : t;
}

export function VoteHomeworkScreen() {
  const sign = useSign();
  const [classroomId, setClassroomId] = useState('');
  /** 活动 id（= 活动列表里的 relationId；投票 / 答题详情要用它） */
  const [activityId, setActivityId] = useState('');
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState('');

  /** 把一组探测顺序跑完，拼成可复制的文本 */
  const runProbes = useCallback(
    async (title: string, probes: Probe[]) => {
      setBusy(true);
      setOut(`${title}：正在请求…`);
      const lines: string[] = [`【${title}】`];
      for (const p of probes) {
        lines.push('');
        lines.push(`── ${p.label}`);
        lines.push(`GET ${p.path}`);
        try {
          /**
           * ⚠️ 只传 method: 'GET'。rawApi 本身支持 POST/DELETE，
           *    所以这里的每个调用点都必须显式写死 GET ——
           *    少写一个就可能真的提交数据。
           */
          const r = await sign.actions.rawApi({ path: p.path, method: 'GET' });
          lines.push(`HTTP ${r.status}`);
          lines.push(clip(r.body));
        } catch (e) {
          lines.push(`异常：${(e as Error).message}`);
        }
      }
      lines.push('');
      lines.push('（以上全部为只读 GET，未提交任何数据）');
      setOut(lines.join('\n'));
      setBusy(false);
    },
    [sign.actions],
  );

  const copy = useCallback(async () => {
    if (!out) return;
    try {
      await Clipboard.setStringAsync(`【LifeKit · 作业/投票 接口探测】\n\n${out}`);
    } catch {
      /* 复制失败不弹错：结果还在页面上，用户可以手动看 */
    }
  }, [out]);

  const hasOut = useMemo(() => out.trim().length > 0, [out]);

  return (
    <ScreenScroll>
      <Section style={{ marginTop: spacing.md }}>
        <Card variant="elevated">
          <Row justify="space-between" align="center">
            <Txt variant="body" weight="semibold">
              只读接口探测
            </Txt>
            <Badge text="只发 GET" fg={color.success[600]} bg={color.success[50]} />
          </Row>
          <Spacer h={spacing.sm} />
          <Txt variant="caption" c={color.text.secondary} style={{ lineHeight: 17 }}>
            {'这一页用来读取优学院「作业」「投票」接口的真实返回结构。\n'}
            {'全部是只读 GET：不会提交作业、不会投票、不会改任何数据。\n'}
            {'点一个按钮，再把结果「复制」发我，就能照着把补交作业 / 改投票做成正式功能。'}
          </Txt>
        </Card>
      </Section>

      <Section title="参数">
        <Card>
          <Field
            label="课堂 id（用于读活动列表，可留空）"
            value={classroomId}
            onChangeText={setClassroomId}
            keyboardType="number-pad"
            placeholder="例如 437375"
          />
          <Field
            label="活动 id（活动列表里的 relationId，投票 / 答题详情要用）"
            value={activityId}
            onChangeText={setActivityId}
            keyboardType="number-pad"
            placeholder="先点③，从结果里找 relationId"
          />
          <Txt variant="caption" c={color.text.tertiary} style={{ lineHeight: 16 }}>
            {'两个都可留空：留空时活动列表用 0 占位、详情用 1 试结构，照样能看出路径是否存在。'}
          </Txt>
        </Card>
      </Section>

      <Section title="探测">
        <Card>
          <Button
            label={busy ? '正在请求…' : '① 探测作业接口'}
            loading={busy}
            onPress={() => void runProbes('作业接口', HOMEWORK_PROBES)}
          />
          <Spacer h={spacing.sm} />
          <Button
            label="② 探测投票接口（存在性）"
            variant="secondary"
            disabled={busy}
            onPress={() => void runProbes('投票接口', VOTE_PROBES)}
          />
          <Spacer h={spacing.sm} />
          <Button
            label="③ 读课堂活动列表（找 relationType=2 投票 / 18 答题）"
            variant="secondary"
            disabled={busy}
            onPress={() => void runProbes('课堂活动列表', activityProbes(classroomId))}
          />
          <Spacer h={spacing.sm} />
          <Button
            label="④ 用活动 id 探测投票 / 答题详情"
            variant="secondary"
            disabled={busy}
            onPress={() => void runProbes('投票/答题详情', voteDetailProbes(activityId))}
          />
        </Card>
      </Section>

      {hasOut ? (
        <Section title="探测结果">
          <Card>
            <Button label="复制结果" variant="secondary" onPress={() => void copy()} />
            <Spacer h={spacing.sm} />
            <View style={styles.out}>
              <Txt variant="caption" c={color.text.secondary} style={{ lineHeight: 15 }}>
                {out}
              </Txt>
            </View>
          </Card>
        </Section>
      ) : null}

      <Section>
        <Card>
          <Txt variant="caption" c={color.text.tertiary} style={{ lineHeight: 17 }}>
            {'提示：如果提示「未授权」或「没有可用的会话」，请先在「优学院设置」里登录一次。\n'}
            {'投票 / 作业的具体接口路径是按命名习惯推测的，探测结果就是用来确认真实路径的。'}
          </Txt>
        </Card>
      </Section>
    </ScreenScroll>
  );
}

const styles = {
  out: {
    backgroundColor: color.neutral[100],
    borderRadius: radius.sm,
    padding: spacing.sm,
    maxHeight: 320,
  },
} as const;
