/**
 * 课堂互动：投票 / 答题（2026-10）。
 *
 * ══════════════ 用户需求 ══════════════
 *
 *   「老师发布的投票、答题，在结束的状态下提交一下」
 *   「补投票这些功能该做了吧」
 *
 * ══════════════ 行为约定（2026-10-31 按用户要求改过）══════════════
 *
 * 客户端**不再**把"已结束"当成不可提交：
 *   · 界面上照常给选择按钮和提交按钮；
 *   · 提交直接发给服务端，结果以服务端返回码为准（201=活动已结束、203=活动不存在）；
 *   · 失败时把服务端 message 原样显示，不再由客户端替平台下结论。
 *
 * 依据：H5 `stuSubmitAnswer` 的提交回调里就写着
 *   `201 == code` → 「活动已结束」、`203 == code` → 「活动不存在」
 * —— 说明能不能交是**服务端**判定的，客户端拦不拦不影响结果。
 * 早期版本在客户端硬拦并把文案写死在页面上，已按用户要求删掉。
 *
 * ══════════════ 接口依据（不是猜的）══════════════
 *
 * 从优学院移动端 H5 里挖出来的（见 services/interactionApi.ts 文件头）：
 *   · 活动列表：GET /courseapi/wisdomClassroom/student/classroomActivitys
 *   · 投票详情：GET /apps/voteV2/detail/{voteId}/{userId}/{classId}
 *   · 投票提交：POST /apps/voteV2/stuSubmit   { userId, classIds:-1, optionIds, voteId }
 *   · 答题详情：GET /smartapi/replyquestion/student/detail/{id}
 *   · 答题提交：POST /classroomapi/replyquestion/stuReply { replyoptionId, optionIds }
 *
 * 全部走 `sign.actions.rawApi`（带当前会话、按站点解析域名、受授权闸门约束）。
 */
import React, { useCallback, useState } from 'react';
import { Alert, View } from 'react-native';
import { Badge, Banner, Button, Card, Card as CardBox, Col, Field, Row, ScreenScroll, Section, Spacer, Txt } from '../components';
import { color, spacing } from '../theme/tokens';
import { useSign } from '../state/signStore';
import { useLocalSearchParams } from '../nav/router';
import {
  deleteVote,
  endAnswer,
  endVote,
  getAnswerDetail,
  getVoteDetail,
  listClassroomActivities,
  resolveStudentClassId,
  submitAnswer,
  submitVote,
  type AnswerDetail,
  type ClassroomActivity,
  type VoteDetail,
} from '../services/interactionApi';

type Detail =
  | { kind: 'vote'; activity: ClassroomActivity; vote: VoteDetail }
  | { kind: 'answer'; activity: ClassroomActivity; answer: AnswerDetail };

function fmtTime(t?: number): string {
  if (!t || !Number.isFinite(t)) return '无截止时间';
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 活动类型码：2 = 投票；答题有两种编码 —— 文档里的 18，和 H5 投屏层用的 6
 * （`appscreen/createScreen` 传 `type:6` 表示答题屏）。两个都显示成「答题」。
 */
const TYPE_LABEL: Record<number, string> = { 2: '投票', 6: '答题', 18: '答题' };

export function VoteListScreen() {
  const sign = useSign();
  const userId = sign.user?.userId;

  const params = useLocalSearchParams<{ classroomId?: string }>();

  /** 路由参数带过来的课堂 id（从「课堂 id」页跳过来时自动填好） */
  const paramCid = Number(params.classroomId) || 0;

  const [manualCid, setManualCid] = useState(() => (paramCid ? String(paramCid) : ''));
  const [activities, setActivities] = useState<ClassroomActivity[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'error' | 'warning'; text: string } | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [submitting, setSubmitting] = useState(false);
  /**
   * 提交结果就地显示在**按钮下面**。
   *
   * ⚠️ 踩过的坑：以前只用顶部那条 Banner 显示结果，而详情在页面下半部分，
   *    用户点完提交根本看不到顶部变化，反馈就是"没有任何返回"。
   *    所以提交反馈必须贴在按钮旁边。
   */
  const [submitNote, setSubmitNote] = useState<{ tone: 'info' | 'error' | 'warning'; text: string } | null>(null);
  /**
   * 打开投票时实际用的 classId 及其来源。
   * 投票统计按班级维度返回，传 -1 只能拿到空统计（0 票、无截止时间）——
   * 之前"票数变 0"的假象就是这么来的，所以这里必须把它显示出来。
   */
  const [usedClassId, setUsedClassId] = useState<number>(-1);
  const [classSource, setClassSource] = useState<string>('');
  /** 活动的原始字段（只读）：查 classId / ocId 到底藏在哪个键里 */
  const [rawDump, setRawDump] = useState<string | null>(null);
  /**
   * 我的课程列表（只读）。
   *
   * 为什么需要：活动对象里**没有 classId / ocId**（实测 14 个键：id、relationType、
   * relationId、status、beginTime、title、state、joinUserDtos、options、url、
   * contentId、isFile、publishAnswer、right），所以只能从课程列表里挑出这门课，
   * 拿它的 classId（甚至 ocId）去查投票详情。
   */
  const [courses, setCourses] = useState<Array<{ ocId: number; classId: number; name: string }>>([]);
  const [courseErr, setCourseErr] = useState<string>('');
  /**
   * 「按 ID 只读查投票详情」。
   *
   * 用途：restart 重置统计之后，需要判断老记录是不是还在服务端
   *   （若 restart 是"新建一条投票"，旧 voteId 仍能查到原票数）。
   * ⚠️ 全流程只发 GET，不写任何数据。
   */
  const [probeId, setProbeId] = useState('');
  const [probeClass, setProbeClass] = useState('');
  const [probeOut, setProbeOut] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);

  /** 读活动列表 */
  const load = useCallback(async () => {
    const useCid = Number(manualCid.trim()) || 0;
    if (!useCid) {
      setMsg({ tone: 'warning', text: '先填课堂 id。' });
      return;
    }
    setBusy(true);
    setMsg(null);
    setDetail(null);
    try {
      const r = await listClassroomActivities(sign.actions.rawApi, useCid);
      if (!r.ok) {
        setMsg({
          tone: 'error',
          text: `读活动列表失败（${r.error ?? '未知'}）。\n返回：${r.snippet || '(空)'}`,
        });
        return;
      }
      setActivities(r.activities);
      /**
       * ⚠️ 0 条时不能只说"没有活动" —— 真机反馈过：
       * 接口明明 200，但字段结构没对上就会显示 0 条。
       * 所以把**原始返回前 300 字**也显示出来，用户一键复制发我，
       * 下次就能按真实结构改解析，而不是继续猜。
       */
      if (r.activities.length) {
        /** 成功不弹提示（用户嫌乱）—— 结果直接显示在下面 */
        setMsg(null);
      } else {
        setMsg({
          tone: 'warning',
          text: `这个课堂没有解析出投票/答题活动（HTTP ${r.status}）。\n原始返回：${r.snippet || '(空)'}`,
        });
      }
    } finally {
      setBusy(false);
    }
  }, [manualCid, sign.actions]);

  /** 打开详情 */
  const open = useCallback(
    async (a: ClassroomActivity) => {
      if (!userId) {
        setMsg({ tone: 'warning', text: '还没登录优学院，先回优学院页登录一次。' });
        return;
      }
      setBusy(true);
      setMsg(null);
      setPicked([]);
      setSubmitNote(null);
      try {
        if (a.relationType === 2) {
          /**
           * 投票详情的最后一段是**班级 id**，不是课堂 id。
           * 活动列表项里经常没有 classId，以前直接传 -1 → 服务端返回空统计（0 票），
           * 看起来像"数据被清空"。这里补上兜底：活动自带 → 课程列表里找。
           */
          const raw = a.raw as Record<string, unknown>;
          let classId = Number(raw.classId ?? raw.classID ?? -1) || -1;
          let source = '活动自带';
          if (classId <= 0) {
            const ocId = Number(raw.ocId ?? raw.courseId ?? raw.ocId ?? 0) || undefined;
            const resolved = await resolveStudentClassId(sign.actions.rawApi, { ocId });
            classId = resolved.classId || -1;
            source = resolved.source;
          }
          setUsedClassId(classId);
          setClassSource(source);
          const r = await getVoteDetail(sign.actions.rawApi, { voteId: a.relationId, userId, classId });
          if (!r.ok || !r.detail) {
            setMsg({ tone: 'error', text: `读投票详情失败：${r.error ?? '未知'}。返回：${r.snippet}` });
            return;
          }
          setDetail({ kind: 'vote', activity: a, vote: r.detail });
        } else {
          const r = await getAnswerDetail(sign.actions.rawApi, { id: a.relationId });
          if (!r.ok || !r.detail) {
            setMsg({ tone: 'error', text: `读答题详情失败：${r.error ?? '未知'}。返回：${r.snippet}` });
            return;
          }
          setDetail({ kind: 'answer', activity: a, answer: r.detail });
          /**
           * 已经答过就把上次的答案预选上（H5 也这样：`isEdit` 时用 myAnswer 回填）。
           * `myAnswer` 是 value→id 映射后的 option id，正好是界面选择用的 key。
           */
          setPicked(r.detail.myAnswer);
        }
      } finally {
        setBusy(false);
      }
    },
    [sign.actions, userId],
  );

  const toggle = useCallback(
    (id: number, multi: boolean) => {
      setPicked((prev) => {
        if (!multi) return prev.includes(id) ? [] : [id];
        return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      });
    },
    [],
  );

  /**
   * 详情是否"只读"（不能再提交）。
   *
   * ★ 2026-10-31 按用户要求：客户端不再拦截"已结束"的提交，直接发给服务端。
   *
   * 依据（H5 78.js stuSubmitAnswer 的提交回调）：
   *   `201 == code` → 弹「活动已结束」；`203 == code` → 「活动不存在」并返回上一页。
   * 也就是说"能不能交"由**服务端**判定：客户端怎么拦都不改变结果，
   * 相反，客户端拦了只会让人看不出到底是本地限制还是平台拒绝。
   * 所以这里只负责把服务端原话显示出来（submitVote / submitAnswer 里
   * 已经把 201/203 归为失败并把 message 带出来）。
   */

  /** 提交：不再本地拦"已结束"，结果以服务端返回为准，并就地显示在按钮下面 */
  const submit = useCallback(async () => {
    if (!detail) return;
    if (!userId) {
      setSubmitNote({ tone: 'warning', text: '还没登录优学院，先回优学院页登录一次。' });
      return;
    }
    if (!picked.length) {
      setSubmitNote({ tone: 'warning', text: '先选一个选项再提交。' });
      return;
    }
    setSubmitting(true);
    setSubmitNote(null);
    try {
      if (detail.kind === 'vote') {
        /** 投票：optionIds 传的是 option.id（H5 stuSubmitVote 里 push 的就是 id） */
        const r = await submitVote(sign.actions.rawApi, {
          userId,
          voteId: detail.activity.relationId,
          optionIds: picked,
        });
        setSubmitNote({ tone: r.ok ? 'info' : 'error', text: r.ok ? '投票已提交。' : `提交失败：${r.message}` });
        if (r.ok) {
          setPicked([]);
          await open(detail.activity);
        }
      } else {
        /**
         * 答题：optionIds 传 option.id（数值）。
         * H5 先把服务端返回的 value 串翻成 id 存进状态，提交时直接用 id —— 别传 value。
         * 详见 interactionApi.submitAnswer 顶部注释。
         */
        const r = await submitAnswer(sign.actions.rawApi, {
          replyoptionId: detail.activity.relationId,
          optionIds: picked,
          change: detail.answer.answered,
        });
        setSubmitNote({ tone: r.ok ? 'info' : 'error', text: r.ok ? '答案已提交。' : `提交失败：${r.message}` });
        if (r.ok) {
          setPicked([]);
          await open(detail.activity);
        }
      }
    } catch (e) {
      /** 以前这里没有 catch：抛异常就是"点了没反应"，什么都看不到 */
      setSubmitNote({
        tone: 'error',
        text: `提交时出错：${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setSubmitting(false);
    }
  }, [detail, picked, sign.actions, userId, open]);


  /**
   * 按 voteId 只读查详情（GET）。用来确认旧投票记录是否还在。
   *
   * classId 不填就用当前活动里带的那个；都拿不到就传 -1（H5 里也有这种写法）。
   */
  /**
   * 自动找出这条投票属于哪个班级（纯只读）。
   *
   * 活动对象里没有 classId/ocId（14 个键里没有），所以只能拿课程列表里的
   * classId 一个个试 `GET /apps/voteV2/detail/{voteId}/{userId}/{classId}`：
   *   · 传 -1 时服务端会返回标题+选项，但票数全 0、无截止时间（看起来像数据没了）
   *   · 传对班级时才会带统计（票数/截止时间）
   * 命中条件：任一选项票数 > 0，或者能拿到截止时间。
   * 全程 GET，不写任何数据；课程数上限 25，串行发。
   */
  const autoFindClass = useCallback(async () => {
    if (!userId) {
      setCourseErr('还没登录优学院，先回优学院页登录一次。');
      return;
    }
    const vid = Number(probeId.trim()) || (detail ? detail.activity.relationId : 0);
    if (!vid) {
      setCourseErr('先填 voteId，或先打开一条投票。');
      return;
    }
    setProbing(true);
    setCourseErr('');
    setProbeOut(null);
    try {
      const r = await sign.actions.rawApi({
        path: '/courseapi/courses/students?publishStatus=1&pn=1&ps=99999&type=1',
        method: 'GET',
      });
      const j = JSON.parse(String(r.body ?? '{}')) as Record<string, unknown>;
      const list = Array.isArray(j.courseList) ? (j.courseList as Record<string, unknown>[]) : [];
      if (!list.length) {
        setCourseErr('课程列表为空');
        return;
      }
      /**
       * 两轮试：先 **ocId**（H5 学生投票页路由是 /vote/detailOfStu/:userId/:ocId/:role/:voteId，
       * 第三段很可能就是 ocId），再试 classId。
       * 2026-10-31 实测：25 门课的 classId 全试过都是 0 票，所以 classId 这条基本可以排除。
       */
      const tried: string[] = [];
      let hit: { value: number; label: string; counts: string; end: string } | null = null;
      const courses = list.slice(0, 25).map((c) => ({
        ocId: Number(c.id) || 0,
        classId: Number(c.classId) || 0,
        name: String(c.name ?? ''),
      }));
      for (const pass of [
        { key: 'ocId' as const, label: 'ocId' },
        { key: 'classId' as const, label: 'classId' },
      ]) {
        for (const c of courses) {
          const candidate = c[pass.key];
          if (!candidate) continue;
          const rr = await getVoteDetail(sign.actions.rawApi, { voteId: vid, userId, classId: candidate });
          if (!rr.ok || !rr.detail) {
            tried.push(`${c.name} · ${pass.label} ${candidate}: HTTP ${rr.status}`);
            continue;
          }
          const d = rr.detail;
          const hasStat = d.options.some((o) => o.count > 0) || d.endTime !== undefined;
          if (hasStat) {
            hit = {
              value: candidate,
              label: `${c.name}（${pass.label} ${candidate}）`,
              counts: d.options.map((o) => `${o.content}=${o.count}`).join(' / '),
              end: d.endTime ? fmtTime(d.endTime) : '无',
            };
            break;
          }
          tried.push(`${c.name} · ${pass.label} ${candidate}: 0 票`);
        }
        if (hit) break;
      }
      if (hit) {
        setUsedClassId(hit.value);
        setClassSource(`自动匹配到 ${hit.label}`);
        setProbeClass(String(hit.value));
        setProbeOut(
          `找到了：${hit.label}\n截止：${hit.end}\n票数：${hit.counts}\n` + '（已自动填进 classId，可点「查询」复核）',
        );
      } else {
        setProbeOut(
          `ocId 和 classId 都试过了，没有一门能读到统计。\n${tried.slice(0, 30).join('\n')}\n\n` +
            '说明第三段要的既不是课程 ocId 也不是课程 classId —— 大概率是签到详情里那种"教学班 classID"。',
        );
      }
    } catch (e) {
      setCourseErr(`出错：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setProbing(false);
    }
  }, [userId, probeId, detail, sign.actions]);

  /**
   * 从签到记录里取「教学班 classID」，再用它查投票统计（全只读）。
   *
   * 为什么走这条路：投票详情第三段要的是**教学班**维度（同学那边 13+13+3+10=39 人），
   * 而课程列表里的 classId（25 个都试过）属于课程/行政班，统计恒为 0。
   * 教学班 id 只出现在签到详情：`getAttendanceForStu` 的 `classez[].classID`。
   *
   * 步骤：课堂 id → 活动列表里找点名（relationType=1）→ attendanceID
   *       → 签到详情取 claszez[0].classID → 查投票详情。全程 GET。
   */
  const probeFromAttendance = useCallback(async () => {
    const cid = Number(manualCid.trim()) || 0;
    const vid = Number(probeId.trim()) || (detail ? detail.activity.relationId : 0);
    if (!cid) {
      setCourseErr('先在页面顶部填课堂 id。');
      return;
    }
    if (!userId) {
      setCourseErr('还没登录优学院，先回优学院页登录一次。');
      return;
    }
    if (!vid) {
      setCourseErr('先填 voteId，或先打开一条投票。');
      return;
    }
    setProbing(true);
    setCourseErr('');
    setProbeOut(null);
    try {
      const r1 = await sign.actions.rawApi({
        path: `/courseapi/wisdomClassroom/student/classroomActivitys?classroomId=${cid}&pageSize=100&pageNum=1&type=1`,
        method: 'GET',
      });
      const j1 = JSON.parse(String(r1.body ?? '{}')) as Record<string, unknown>;
      const result = (j1.result ?? {}) as Record<string, unknown>;
      const arr = Array.isArray(result.list)
        ? (result.list as Record<string, unknown>[])
        : Array.isArray(j1.list)
          ? (j1.list as Record<string, unknown>[])
          : Array.isArray(j1)
            ? (j1 as unknown as Record<string, unknown>[])
            : [];
      if (!arr.length) {
        setProbeOut(`活动列表没读到数据（HTTP ${r1.status}）。原始返回：${String(r1.body ?? '').slice(0, 200)}`);
        return;
      }
      const signAct = arr.find((a) => Number(a.relationType ?? a.activityType ?? 0) === 1);
      if (!signAct) {
        setProbeOut('这个课堂的活动里没有点名（relationType=1），拿不到教学班 id。');
        return;
      }
      const attId = Number(signAct.relationId ?? signAct.activityId ?? signAct.id ?? 0) || 0;
      const r2 = await sign.actions.rawApi({
        path: `/apps/newAttendance/getAttendanceForStu/${attId}/${userId}`,
        method: 'GET',
      });
      const j2 = JSON.parse(String(r2.body ?? '{}')) as Record<string, unknown>;
      const classes = Array.isArray(j2.classez) ? (j2.classez as Record<string, unknown>[]) : [];
      const classID = Number(classes[0]?.classID ?? 0) || 0;
      if (!classID) {
        setProbeOut(
          `签到详情里没拿到 classez（attendanceID=${attId}，HTTP ${r2.status}）。\n原始返回：${String(r2.body ?? '').slice(0, 200)}`,
        );
        return;
      }
      const r3 = await getVoteDetail(sign.actions.rawApi, { voteId: vid, userId, classId: classID });
      if (!r3.ok || !r3.detail) {
        setProbeOut(`用教学班 classID ${classID} 查投票失败（HTTP ${r3.status}）。\n${r3.snippet}`);
        return;
      }
      const d = r3.detail;
      setUsedClassId(classID);
      setClassSource(`签到教学班 classID ${classID}`);
      setProbeClass(String(classID));
      setProbeOut(
        `教学班 classID：${classID}（来自 attendanceID ${attId}）\n` +
          `投票：${d.title}\n截止：${d.endTime ? fmtTime(d.endTime) : '无'}\n` +
          `票数：${d.options.map((o) => `${o.content}=${o.count}`).join(' / ')}\n` +
          `我是否已投：${d.myVoted ? '是' : '否'}`,
      );
    } catch (e) {
      setCourseErr(`出错：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setProbing(false);
    }
  }, [manualCid, probeId, detail, userId, sign.actions]);

  /**
   * 在当前 voteId 附近找"带票数或截止时间"的记录（全只读）。
   *
   * 背景：voteId 79274 用任何 classID 查都是 0 票 + 无截止时间，
   * 说明这条记录本身是空的；而同学那边能看到 13/13/3，说明平台上还有另一条带票的记录
   * （restart 很可能不是"重置"，而是**新建了一条空投票**）。
   * 这里以当前 id 为中心，前后各扫 12 个，用同一个 classID 查，命中就报出来。
   */
  const scanNearby = useCallback(async () => {
    const center = Number(probeId.trim()) || (detail ? detail.activity.relationId : 0);
    const classId = Number(probeClass.trim()) || usedClassId;
    if (!center) {
      setCourseErr('先填 voteId，或先打开一条投票。');
      return;
    }
    if (!userId) {
      setCourseErr('还没登录优学院，先回优学院页登录一次。');
      return;
    }
    if (!classId || classId <= 0) {
      setCourseErr('先拿到一个有效 classId（先点上面「从签到记录取班级 id 并查询」）。');
      return;
    }
    setProbing(true);
    setCourseErr('');
    setProbeOut(null);
    try {
      const tried: string[] = [];
      let hit: string | null = null;
      for (let d = 0; d <= 12 && !hit; d += 1) {
        const batch = d === 0 ? [center] : [center - d, center + d];
        for (const vid of batch) {
          if (vid <= 0) continue;
          const r = await getVoteDetail(sign.actions.rawApi, { voteId: vid, userId, classId });
          if (!r.ok || !r.detail) {
            tried.push(`${vid}: HTTP ${r.status}`);
            continue;
          }
          const dd = r.detail;
          const hasStat = dd.options.some((o) => o.count > 0) || dd.endTime !== undefined;
          if (hasStat) {
            hit =
              `${vid}: ${dd.title}\n截止：${dd.endTime ? fmtTime(dd.endTime) : '无'}\n` +
              `票数：${dd.options.map((o) => `${o.content}=${o.count}`).join(' / ')}`;
            break;
          }
          tried.push(`${vid}: 0 票`);
        }
      }
      setProbeOut(
        hit
          ? `找到了（classID ${classId}）：\n${hit}\n\n把 voteId 改成这个再点「查询」可复核。`
          : `以 ${center} 为中心前后各 12 个 id 都是 0 票：\n${tried.join('\n')}`,
      );
    } catch (e) {
      setCourseErr(`出错：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setProbing(false);
    }
  }, [probeId, probeClass, usedClassId, detail, userId, sign.actions]);

  /** 拉「我的课程」列表（纯 GET），用于挑出这门课对应的 classId / ocId */
  const loadCourses = useCallback(async () => {
    setCourseErr('');
    try {
      const r = await sign.actions.rawApi({
        path: '/courseapi/courses/students?publishStatus=1&pn=1&ps=99999&type=1',
        method: 'GET',
      });
      if (!r.ok || r.status !== 200) {
        setCourseErr(`课程列表读取失败（HTTP ${r.status}）`);
        return;
      }
      const j = JSON.parse(String(r.body ?? '{}')) as Record<string, unknown>;
      const list = Array.isArray(j.courseList) ? (j.courseList as Record<string, unknown>[]) : [];
      setCourses(
        list.map((c) => ({
          ocId: Number(c.id) || 0,
          classId: Number(c.classId) || 0,
          name: String(c.name ?? '(未命名课程)'),
        })),
      );
      if (!list.length) setCourseErr('课程列表为空');
    } catch (e) {
      setCourseErr(`出错：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [sign.actions]);

  const probeVote = useCallback(    async (overrideId?: number) => {
      const vid = overrideId ?? (Number(probeId.trim()) || 0);
      if (!vid) {
        setProbeOut('先填一个 voteId（纯数字）。');
        return;
      }
      if (!userId) {
        setProbeOut('还没登录优学院，先回优学院页登录一次。');
        return;
      }
      const rawClass = (detail?.activity.raw as Record<string, unknown> | undefined)?.classId;
      const cid = Number(probeClass.trim()) || Number(rawClass) || -1;
      setProbing(true);
      setProbeOut(null);
      try {
        const r = await getVoteDetail(sign.actions.rawApi, { voteId: vid, userId, classId: cid });
        if (!r.ok || !r.detail) {
          setProbeOut(`读取失败：${r.error ?? '未知'}（HTTP ${r.status}）\n原始返回：${r.snippet || '(空)'}`);
          return;
        }
        const d = r.detail;
        /**
         * 服务端对"不存在 / 不是投票"的 ID 会回一个空壳：
         * 标题退化成默认值、options 为空、截止时间没。这时候要明确说"没查到"，
         * 否则会被误读成"这条投票 0 票 = 数据被清空"。
         */
        if (d.options.length === 0) {
          setProbeOut(
            `没有查到这条投票（ID ${vid}）：选项为空。\n` +
              `原始返回（前 300 字）：${r.snippet || '(空)'}\n` +
              '提示：classId 要填**班级 id**（形如 949597），不是课堂 id（447767 那种）。',
          );
          return;
        }
        const counts = d.options.map((o) => `${o.content}=${o.count}`).join(' / ');
        setProbeOut(
          `标题：${d.title}\n截止：${d.endTime ? fmtTime(d.endTime) : '无'}\n选项票数：${counts}\n我是否已投：${d.myVoted ? '是' : '否'}` +
            `\n\n原始返回（前 300 字，看票数真实字段名）：\n${r.snippet || '(空)'}`,
        );
      } catch (e) {
        setProbeOut(`出错：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setProbing(false);
      }
    },
    [probeId, probeClass, userId, detail, sign.actions],
  );

  /**
   * 「高级操作」折叠区（默认不可见）+ 里面的删除投票。
   *
   * ★ 2026-10-31 用户明确要求「把这个投票删掉」。按 AGENTS.md 0.3 的例外条款执行：
   *   ① 折叠在高级区里 ② 二次确认写明不可恢复与账号痕迹 ③ 结果原样显示。
   * ⚠️ 删除是不可逆的：投票和它的统计会从平台消失，"匿名"也不可能 ——
   *   请求必须带 AUTHORIZATION token，平台侧能定位到账号与 IP。
   */
  const [showAdvanced, setShowAdvanced] = useState(false);

  const doDelete = useCallback(async () => {
    if (!detail || !userId) {
      setSubmitNote({ tone: 'warning', text: '还没登录优学院，先回优学院页登录一次。' });
      return;
    }
    setSubmitting(true);
    setSubmitNote(null);
    try {
      const r = await deleteVote(sign.actions.rawApi, {
        voteId: detail.activity.relationId,
        userId,
      });
      setSubmitNote({
        tone: r.ok ? 'info' : 'error',
        text: `${r.ok ? '删除请求已完成。' : `删除失败（HTTP ${r.status}）：`}${r.body ? `\n服务端返回：${r.body}` : ''}`,
      });
      if (r.ok) {
        const gone = detail.activity;
        setActivities((prev) =>
          prev ? prev.filter((a) => !(a.relationType === gone.relationType && a.relationId === gone.relationId)) : prev,
        );
        setDetail(null);
      }
    } catch (e) {
      setSubmitNote({ tone: 'error', text: `删除时出错：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setSubmitting(false);
    }
  }, [detail, userId, sign.actions]);

  const tryDelete = useCallback(() => {
    if (!detail) return;
    if (detail.kind !== 'vote') {
      setSubmitNote({ tone: 'warning', text: '删除目前只对投票开放，答题没有对应的删除接口。' });
      return;
    }
    Alert.alert(
      '这会删除这个投票，且无法恢复',
      '删除之后：\n· 你和同学的活动列表里都会少掉这个投票\n· 票数统计一起消失\n· 平台操作记录里能查到你的账号\n\n确定要删吗？',
      [
        { text: '取消', style: 'cancel' },
        { text: '确定删除', style: 'destructive', onPress: () => void doDelete() },
      ],
    );
  }, [detail, doDelete]);

  /**
   * 把活动结束（教师侧 end）。
   * 补投完之后用它把"进行中"关掉。
   * ⚠️ 结束时间会变成**现在**，恢复不成原来的截止时间（投票按时长算结束，
   *    改回原时间只能走发布接口 save 重写，风险更高）。
   */
  const doEnd = useCallback(async () => {
    if (!detail || !userId) {
      setSubmitNote({ tone: 'warning', text: '还没登录优学院，先回优学院页登录一次。' });
      return;
    }
    setSubmitting(true);
    setSubmitNote(null);
    try {
      const r =
        detail.kind === 'vote'
          ? await endVote(sign.actions.rawApi, { voteId: detail.activity.relationId, userId })
          : await endAnswer(sign.actions.rawApi, { id: detail.activity.relationId });
      if (r.ok) {
        await open(detail.activity); // 先刷新（open 会清提示），再写提示
        setSubmitNote({ tone: 'info', text: `已结束。${r.body ? `\n服务端返回：${r.body}` : ''}` });
      } else {
        setSubmitNote({
          tone: 'error',
          text: `结束失败（HTTP ${r.status}）${r.body ? `：${r.body}` : '：服务端没有返回内容'}`,
        });
      }
    } catch (e) {
      setSubmitNote({ tone: 'error', text: `结束时出错：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setSubmitting(false);
    }
  }, [detail, userId, sign.actions, open]);

  const tryEnd = useCallback(() => {
    if (!detail) return;
    Alert.alert(
      '把这个活动改成「已结束」',
      '补投完之后用它把投票关掉。\n\n注意：\n· 结束时间会变成现在（原来那个截止时间恢复不回来了）\n· 操作会在平台留下你的账号记录\n\n确定要结束吗？',
      [
        { text: '取消', style: 'cancel' },
        { text: '确定结束', style: 'destructive', onPress: () => void doEnd() },
      ],
    );
  }, [detail, doEnd]);

  const ongoing = activities?.filter((a) => !a.over) ?? [];  const ended = activities?.filter((a) => a.over) ?? [];

  /**
   * 服务端下发的正确答案（option.id 列表）。
   *
   * 依据：课堂答题的 detail 响应本来就带 `replyquestion.answer`（H5 只是用
   * `answer != "" && isOver` 控制"结束了才显示"），判分后还会多给 `correctAnswer`。
   * 所以进行中的答题也可能直接拿到答案 —— 有了它就能一键作答。
   */
  const answerDetail = detail && detail.kind === 'answer' ? detail.answer : null;
  const serverAnswerIds = answerDetail
    ? answerDetail.options
        .filter((o) => o.value !== '' && answerDetail.correctAnswerValues.includes(o.value))
        .map((o) => o.id)
    : [];

  return (
    <ScreenScroll>
      {/*
        ★ 用户要求（2026-10，两次）：
          「把投票答题那一块的上面内容只留一个填写课程 id，不要多余的东西」
          「只要一个填 id 的框和下面的读取，其他不要，太乱了」

        所以顶部**只有一个输入框 + 读取按钮**：
        没有标题、没有说明、没有自动课堂列表、没有跳转按钮。
        读取结果（进行中 / 已结束 / 详情）显示在下面。
      */}
      <Section style={{ marginTop: spacing.md }}>
        <Card>
          <Field
            label="课堂 id"
            value={manualCid}
            onChangeText={setManualCid}
            keyboardType="number-pad"
            placeholder="填写课堂 id"
          />
          <Button label={busy ? '读取中…' : '读取投票 / 答题'} onPress={() => void load()} disabled={busy} />
        </Card>
      </Section>

      {/*
        只有**出错/异常**才显示横幅（成功不弹提示，太吵）：
        · 读不到 / 解析不出活动时，把原始返回带上，方便定位
      */}
      {msg ? (
        <Section>
          <Banner tone={msg.tone} title={msg.text} actionLabel="知道了" onAction={() => setMsg(null)} />
        </Section>
      ) : null}

      {activities ? (
        <>
          <Section title={`进行中（${ongoing.length}）`}>
            {ongoing.length ? (
              <Card style={{ padding: 0 }}>
                {ongoing.map((a, i) => (
                  <View key={`${a.relationType}-${a.relationId}-${i}`}>
                    <ActivityRow a={a} onPress={() => void open(a)} />
                    {i < ongoing.length - 1 ? <View style={{ height: 1, backgroundColor: color.neutral[100] }} /> : null}
                  </View>
                ))}
              </Card>
            ) : (
              <Card>
                <Txt variant="body2" c={color.text.secondary}>
                  这个课堂现在没有进行中的投票/答题。
                </Txt>
              </Card>
            )}
          </Section>

          <Section title={`已结束（${ended.length}）`}>
            {ended.length ? (
              <Card style={{ padding: 0 }}>
                {ended.map((a, i) => (
                  <View key={`e-${a.relationType}-${a.relationId}-${i}`}>
                    <ActivityRow a={a} onPress={() => void open(a)} />
                    {i < ended.length - 1 ? <View style={{ height: 1, backgroundColor: color.neutral[100] }} /> : null}
                  </View>
                ))}
              </Card>
            ) : (
              <Card>
                <Txt variant="body2" c={color.text.secondary}>
                  没有已结束的记录。
                </Txt>
              </Card>
            )}
          </Section>
        </>
      ) : null}

      {detail ? (
        <Section title={detail.kind === 'vote' ? '投票详情' : '答题详情'}>
          <Card>
            <Row justify="space-between" align="center">
              <Txt variant="body2" weight="semibold" style={{ flex: 1 }}>
                {detail.kind === 'vote' ? detail.vote.title : detail.answer.title}
              </Txt>
              <Badge
                text={detail.activity.over ? '已结束' : '进行中'}
                fg={detail.activity.over ? color.neutral[500] : color.success[600]}
                bg={detail.activity.over ? color.neutral[100] : color.success[50]}
              />
            </Row>
            <Spacer h={4} />
            <Txt variant="caption" c={color.text.tertiary}>
              {detail.kind === 'vote'
                ? `截止 ${fmtTime(detail.vote.endTime)} · 最多选 ${detail.vote.selectableCount} 项`
                : detail.answer.type === 1
                  ? '单选'
                  : detail.answer.type === 2
                    ? '多选'
                    : '判断题'}
            </Txt>
            {/* 只读诊断：提交被拒（202/201）时，先看这几个值判断是状态问题还是班级/已投问题 */}
            <Txt variant="caption" c={color.text.tertiary}>
              {`活动 ID ${detail.activity.relationId} · classId ${detail.kind === 'vote' ? usedClassId : '-'}${
                detail.kind === 'vote' && classSource ? `（${classSource}）` : ''
              }${
                detail.kind === 'vote'
                  ? detail.vote.myVoted
                    ? ' · 已投过'
                    : ' · 未投'
                  : detail.answer.answered
                    ? ' · 已作答'
                    : ' · 未作答'
              }`}
            </Txt>

            <Spacer h={spacing.md} />
            {(detail.kind === 'vote' ? detail.vote.options : detail.answer.options).map((o) => {
              /** 已投过的选项也要高亮（H5 用 myVoted 里的 id） */
              const chosen =
                picked.includes(o.id) ||
                (detail.kind === 'vote' && detail.vote.myVotedIds.includes(o.id));
              /**
               * 已结束的答题会把 `correctAnswer` 一起下发（value 串），
               * 在这里把正确选项标出来 —— 这既是"对答案"，也是后面做题库的基础。
               */
              const optValue = 'value' in o ? String((o as { value?: unknown }).value ?? '') : '';
              const isAnswer =
                detail.kind === 'answer' &&
                detail.answer.over &&
                optValue !== '' &&
                detail.answer.correctAnswerValues.includes(optValue);
              return (
                <CardBox
                  key={o.id}
                  style={{
                    marginBottom: spacing.sm,
                    borderWidth: 1,
                    borderColor: isAnswer ? color.success[500] : chosen ? color.primary[500] : color.neutral[200],
                    backgroundColor: isAnswer
                      ? color.success[50]
                      : chosen
                        ? color.primary[50]
                        : color.background.primary,
                  }}
                >
                  <Row justify="space-between" align="center" gap={spacing.sm}>
                    <Txt variant="body2" style={{ flex: 1 }}>
                      {o.content}
                    </Txt>
                    {isAnswer ? <Badge text="正确答案" fg={color.success[600]} bg={color.success[50]} /> : null}
                    {detail.kind === 'vote' && 'count' in o ? (
                      <Txt variant="caption" c={color.text.tertiary}>
                        {`${(o as { count?: number }).count ?? 0} 票`}
                      </Txt>
                    ) : null}
                  </Row>
                  <Spacer h={spacing.sm} />
                  <Button
                    label={chosen ? '已选' : '选择'}
                    variant={chosen ? undefined : 'secondary'}
                    onPress={() =>
                      toggle(
                        o.id,
                        detail.kind === 'vote'
                          ? detail.vote.selectableCount > 1
                          : detail.answer.type === 2,
                      )
                    }
                  />
                </CardBox>
              );
            })}

            <Spacer h={spacing.md} />
            {detail.kind === 'answer' ? (
              serverAnswerIds.length ? (
                <>
                  <Txt variant="caption" c={color.success[600]} style={{ lineHeight: 17 }}>
                    {'服务端已下发这道题的答案，可以一键填入。\n'}
                  </Txt>
                  <Spacer h={4} />
                  <Button
                    label="填入正确答案"
                    variant="secondary"
                    onPress={() => setPicked(serverAnswerIds)}
                  />
                  <Spacer h={spacing.sm} />
                </>
              ) : detail.answer.over ? (
                <>
                  <Txt variant="caption" c={color.text.tertiary} style={{ lineHeight: 17 }}>
                    {'服务端没有下发正确答案（老师可能没公开）。\n'}
                  </Txt>
                  <Spacer h={spacing.sm} />
                </>
              ) : null
            ) : null}
            {detail.kind === 'answer' && detail.answer.answered ? (
              <Txt variant="caption" c={color.text.tertiary} style={{ lineHeight: 17 }}>
                {detail.answer.isRight === true
                  ? '你已答对，下面是你的选择。\n'
                  : detail.answer.isRight === false
                    ? '你已作答（答错了），下面是你的选择。\n'
                    : '你已作答，下面是你的选择。\n'}
              </Txt>
            ) : null}
            <Button
              label={submitting ? '提交中…' : '提交'}
              onPress={() => void submit()}
              disabled={submitting}
            />
            <Spacer h={spacing.sm} />
            <Button
              label={showAdvanced ? '收起高级操作 ▲' : '高级操作（会改平台数据）▼'}
              variant="secondary"
              onPress={() => setShowAdvanced((v) => !v)}
            />
            {showAdvanced ? (
              <>
                <Spacer h={spacing.sm} />
                <Button
                  label={submitting ? '处理中…' : '结束这个活动（需确认）'}
                  variant="secondary"
                  onPress={() => tryEnd()}
                  disabled={submitting}
                />
                <Spacer h={spacing.sm} />
                <Button
                  label={submitting ? '处理中…' : '删除这个投票（需确认，不可恢复）'}
                  variant="secondary"
                  onPress={() => tryDelete()}
                  disabled={submitting}
                />
              </>
            ) : null}
            {/*
              提交结果就地显示（贴在按钮下面）。
              不放顶部：详情在页面下半部分，顶部那条 Banner 用户看不到 ——
              之前就是因此报"点了没有任何返回"。
            */}
            {submitNote ? (
              <Txt
                variant="caption"
                c={
                  submitNote.tone === 'error'
                    ? color.error[600]
                    : submitNote.tone === 'warning'
                      ? color.warning[600]
                      : color.text.secondary
                }
                style={{ lineHeight: 18, marginTop: spacing.sm }}
              >
                {submitNote.text}
              </Txt>
            ) : null}
          </Card>
        </Section>
      ) : null}

      {/*
        只读排查工具：按 voteId 直接查投票详情。
        用途：确认 restart 之后老记录还在不在（若还在，旧 voteId 能查回原票数）。
        ⚠️ 只发 GET，不改任何数据。
      */}
      <Section title="按 ID 查投票详情（只读）">
        <Card>
          <Field
            label="voteId"
            value={probeId}
            onChangeText={setProbeId}
            keyboardType="number-pad"
            placeholder="例如 1234567"
          />
          <Field
            label="classId（班级 id，不是课堂 id）"
            value={probeClass}
            onChangeText={setProbeClass}
            keyboardType="number-pad"
            placeholder="例如 949597；不填则用当前活动里的 classId"
          />
          <Button label={probing ? '查询中…' : '查询'} onPress={() => void probeVote()} disabled={probing} />
          <Spacer h={spacing.sm} />
          {/* 只读：把「我的课程」列出来，点一下就填进 classId —— 活动对象里没有 classId */}
          <Button label="列出我的课程（只读）" variant="secondary" onPress={() => void loadCourses()} />
          <Spacer h={spacing.sm} />
          {/* 只读：在当前 voteId 前后各 12 个里找带票数/截止时间的记录 */}
          <Button
            label={probing ? '扫描中…' : '在附近找有票数的记录（只读，最多 25 次请求）'}
            variant="secondary"
            onPress={() => void scanNearby()}
            disabled={probing}
          />
          <Spacer h={spacing.sm} />
          {/* 只读：从签到详情取教学班 classID，再查投票统计（课程 classId 全是 0 票） */}
          <Button
            label={probing ? '读取中…' : '从签到记录取班级 id 并查询（只读）'}
            variant="secondary"
            onPress={() => void probeFromAttendance()}
            disabled={probing}
          />
          <Button
            label={probing ? '逐个试课程中…' : '自动找出班级（只读，最多 25 次请求）'}
            variant="secondary"
            onPress={() => void autoFindClass()}
            disabled={probing}
          />
          {courseErr ? (
            <>
              <Spacer h={4} />
              <Txt variant="caption" c={color.error[600]}>
                {courseErr}
              </Txt>
            </>
          ) : null}
          {courses.slice(0, 12).map((c) => (
            <View key={`${c.ocId}-${c.classId}`} style={{ marginTop: spacing.xs ?? 4 }}>
              <Button
                label={`${c.name} · classId ${c.classId} · ocId ${c.ocId}`}
                variant="secondary"
                onPress={() => setProbeClass(String(c.classId))}
              />
            </View>
          ))}
          {detail ? (
            <>
              <Spacer h={spacing.sm} />
              <Button
                label={`用当前活动的 ID 查（${detail.activity.relationId}）`}
                variant="secondary"
                onPress={() => {
                  setProbeId(String(detail.activity.relationId));
                  void probeVote(detail.activity.relationId);
                }}
                disabled={probing}
              />
              <Spacer h={spacing.sm} />
              {/* 只读：把活动原始字段摊开，看 classId / ocId 到底叫什么键 */}
              <Button
                label={rawDump ? '收起活动原始字段 ▲' : '查看活动原始字段 ▼'}
                variant="secondary"
                onPress={() => {
                  if (rawDump) {
                    setRawDump(null);
                    return;
                  }
                  const raw = detail.activity.raw as Record<string, unknown>;
                  const keys = Object.keys(raw);
                  const picked: Record<string, unknown> = {};
                  for (const k of keys) {
                    if (/class|ocId|course|id$/i.test(k)) picked[k] = raw[k];
                  }
                  setRawDump(
                    `共 ${keys.length} 个键：${keys.join(', ')}\n\n与班级/课程相关的：\n${JSON.stringify(picked).slice(0, 600)}`,
                  );
                }}
              />
            </>
          ) : null}
          {probeOut ? (
            <>
              <Spacer h={spacing.sm} />
              <Txt variant="caption" c={color.text.secondary} style={{ lineHeight: 18 }}>
                {probeOut}
              </Txt>
            </>
          ) : null}
          {rawDump ? (
            <>
              <Spacer h={spacing.sm} />
              <Txt variant="caption" c={color.text.secondary} style={{ lineHeight: 18 }}>
                {rawDump}
              </Txt>
            </>
          ) : null}
        </Card>
      </Section>
    </ScreenScroll>
  );
}

function ActivityRow({ a, onPress }: { a: ClassroomActivity; onPress: () => void }) {
  return (
    <Row justify="space-between" align="center" style={{ padding: spacing.base }} gap={spacing.md}>
      <Col flex={1} gap={2}>
        <Row gap={spacing.sm} align="center">
          <Badge
            text={TYPE_LABEL[a.relationType] ?? '活动'}
            fg={color.primary[600]}
            bg={color.primary[50]}
          />
          <Txt variant="body2" weight="medium" style={{ flex: 1 }} numberOfLines={2}>
            {a.title}
          </Txt>
        </Row>
        <Txt variant="caption" c={color.text.tertiary}>
          {a.over ? '已结束' : `截止 ${fmtTime(a.endTime)}`}
        </Txt>
      </Col>
      <Button label="查看" variant="secondary" onPress={onPress} style={{ marginLeft: 4 }} />
    </Row>
  );
}
