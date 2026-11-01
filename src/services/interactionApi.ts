/**
 * 课堂互动（投票 / 答题）接口封装 —— 2026-10。
 *
 * ══════════════ 接口来源（不是猜的，是从优学院移动端 H5 里挖出来的）══════════════
 *
 * 存档：`.recon/umobile/src-async.*.js`（优学院移动端 H5 的 API 模块）
 *
 *   投票（KfuA 模块，base = apps 网关）：
 *     GET  /apps/voteV2/detail/{voteId}/{userId}/{classId}
 *     POST /apps/voteV2/stuSubmit     body: { userId, classIds: -1, optionIds: [...], voteId }
 *
 *   答题（uwO2 模块，base = classroomapi 网关）：
 *     GET  /classroomapi/replyquestion/student/detail/{id}
 *     POST /classroomapi/replyquestion/stuReply       body: { replyoptionId, optionIds: [...] }
 *     POST /classroomapi/replyquestion/stuChangeReply 同上（改答案）
 *
 *   课堂活动列表（用来拿 relationId / relationType / 截止时间）：
 *     GET /courseapi/wisdomClassroom/student/classroomActivitys?classroomId=…&pageSize=100&pageNum=1&type=1
 *
 * ══════════════ ★ 2026-10-31 修正：三个接口的前缀各不相同 ══════════════
 *
 * 之前把活动列表和答题都写成 `/classroomapi/…`，实测下不对。证据来自 H5 的配置模块
 * （`.recon/umobile/app.8fe085d050dc3b4ddb46.js` 的 mZex 模块）：
 *
 *     g = https://lms.<域名>/courseapi                ← API_HOST
 *     m = https://lms.<域名>/apps                     ← API_HOST_OLD
 *     h = https://application.<域名>/classroomapi     ← SMART_API_HOST
 *
 * 以及各接口模块用的是哪个 base：
 *   · 课堂活动列表 `src-async` 同包里的 xt 模块：`c = Object(l.a)(s.a.API_HOST)`
 *     → `c.get("/wisdomClassroom/student/classroomActivitys?…")` ⇒ `/courseapi/…`
 *   · 投票 `src-async` 的 KfuA：`r = Object(i.a)(o.a.API_HOST_OLD)`
 *     → `/voteV2/detail/…`、`/voteV2/stuSubmit` ⇒ `/apps/…`
 *   · 答题 `src-async` 的 uwO2：`r = Object(i.a)(o.a.SMART_API_HOST)`
 *     → `/replyquestion/student/detail/…`、`/replyquestion/stuReply` ⇒ application 域 `/classroomapi`
 *
 * 所以本文件里答题一律走 `/smartapi/…`，由 `resolvePath` 映射到 `services.smartApi`。
 *
 * ══════════════ 可达性实测（未登录探测，2026-10-31 复核）══════════════
 *
 *   · /classroomapi/__bogus__        → 404  （该前缀可判别）
 *   · /courseapi/__bogus__           → 404  （可判别）
 *   · /courseapi/wisdomClassroom/student/classroomActivitys → 401（存在，需登录）
 *   · /classroomapi/replyquestion/…  → 401  （存在，但域名不对：应答在整个 application 域）
 *   · /apps/__bogus__                → 401  （/apps 前缀"先拦后路由"，不可判别）
 *   · /apps/voteV2/…                 → 401
 *
 * ══════════════ ⚠️ 产品边界（重要）══════════════
 *
 * 只在活动**进行中**时提交。
 * 已结束的活动只显示结果、禁用提交 —— 事后补投/补答等于伪造参与记录，
 * 属于用户与我约定「不做」的范围（见 docs/需求清单.md 的 N1）。
 */
/** rawApi 的返回（与 signStore 的定义保持一致；这里本地声明，避免循环依赖） */
export interface RawApiResult {
  status: number;
  body: string;
  ok: boolean;
}

/** signStore 暴露的 rawApi 签名（保持结构化，避免循环依赖） */
export type RawApiFn = (input: {
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
}) => Promise<RawApiResult>;

/** 一个课堂活动（从活动列表里解析出来） */
export interface ClassroomActivity {
  /** 活动 id（列表里的 activityId） */
  activityId: number;
  /** 关联的业务 id：投票 id / 答题 id（relationId） */
  relationId: number;
  /** 2 = 投票，18 = 答题 */
  relationType: number;
  title: string;
  /** 开始时间（毫秒；没有就是 undefined） */
  startTime?: number;
  /** 截止时间（毫秒；没有就是 undefined） */
  endTime?: number;
  /** 是否已结束（服务端字段 + 截止时间双重判断） */
  over: boolean;
  /** 原始对象，调试/兜底用 */
  raw: Record<string, unknown>;
}

/** 投票详情 */
export interface VoteDetail {
  title: string;
  /** 可选项数量上限（多选时 >1） */
  selectableCount: number;
  endTime?: number;
  /**
   * 选项。`id` 用于提交（H5 `stuSubmitVote` 里 push 的就是 option.id），
   * `content` 取 `value`（H5 模板里显示的是 `option.value`）。
   */
  options: Array<{ id: number; content: string; selected: boolean; count: number }>;
  /** 已投票数 / 总人数（服务端有时给） */
  votedCount?: number;
  studentCount?: number;
  /** 我是否已经投过（此时 H5 显示结果饼图、不再给提交按钮） */
  myVoted: boolean;
  /** 我投的是哪几个选项（H5 的 `myVoted` 是 `[{id}]`，用来高亮自己的选择） */
  myVotedIds: number[];
  /** 活动是否已结束（H5：`myVoted || isOver` 时只展示结果） */
  over: boolean;
  raw: string;
}

/** 答题详情 */
export interface AnswerDetail {
  title: string;
  /** 1 单选 / 2 多选 / 3 判断 */
  type: number;
  /**
   * 选项。★ 注意 `value` 与 `id` 是两回事：
   *   · 显示与提交都用 `value`（H5 `stuSubmitAnswer` 传的 optionIds 是 value 串）
   *   · `myAnswer` 里存的也是 value
   */
  options: Array<{ id: number; value: string; content: string; selected: boolean }>;
  /** 我上次的答案（value 列表，与 options[i].value 对应） */
  myAnswerValues: string[];
  /** 我上次的答案映射成选项 id（给界面做预选用） */
  myAnswer: number[];
  /** 正确答案（value 列表；服务端可能不下发） */
  correctAnswerValues: string[];
  /** 服务端判题结果（true/false；没判就是 undefined） */
  isRight?: boolean;
  /** 是否已作答过（用于决定 stuReply 还是 stuChangeReply） */
  answered: boolean;
  /** 活动是否结束（`replyquestion.status` 0 = 进行中，其余 = 已结束） */
  over: boolean;
  raw: string;
}

/* ─────────────── 小工具：容错解析 ─────────────── */

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 从各种包装里取出数组（服务端有 {data:[…]} / 直接数组 / {list:[…]} 三种风格） */
function asArray(j: unknown): unknown[] {
  if (Array.isArray(j)) return j;
  if (j && typeof j === 'object') {
    const o = j as Record<string, unknown>;
    for (const k of ['data', 'list', 'rows', 'records', 'activitys', 'result']) {
      if (Array.isArray(o[k])) return o[k] as unknown[];
    }
    if (o.data && typeof o.data === 'object') return asArray(o.data);
  }
  return [];
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback;
}

/** 时间字段可能是毫秒、秒、也可能没有 */
function timeMs(v: unknown): number | undefined {
  const n = num(v, 0);
  if (!n) return undefined;
  return n < 1e12 ? n * 1000 : n;
}

/* ─────────────── 活动列表 ─────────────── */

/** 活动对象里可能出现的包装键（服务端有几种返回风格，实测发现只认顶层不够） */
const WRAP_KEYS = ['activity', 'classroomActivity', 'classroomActivityVo', 'activityVo', 'info'];
/** 列表可能出现的数组键 */
const LIST_KEYS = [
  'classroomActivitys',
  'classroomActivities',
  'activitys',
  'activities',
  'activityList',
  'list',
  'rows',
  'records',
  'data',
  'result',
];

function asArrayDeep(j: unknown, depth = 0): unknown[] {
  if (depth > 4) return [];
  if (Array.isArray(j)) return j;
  if (j && typeof j === 'object') {
    const o = j as Record<string, unknown>;
    for (const k of LIST_KEYS) {
      if (Array.isArray(o[k])) return o[k] as unknown[];
    }
    for (const k of LIST_KEYS) {
      if (o[k] && typeof o[k] === 'object') {
        const inner = asArrayDeep(o[k], depth + 1);
        if (inner.length) return inner;
      }
    }
  }
  return [];
}

/**
 * 从一条活动记录里解析出「投票/答题」信息。
 * ⚠️ 字段名要兼容多种写法（服务端不同接口风格不一致）。
 */
function parseActivity(it: unknown): ClassroomActivity | null {
  if (!it || typeof it !== 'object') return null;
  let o = it as Record<string, unknown>;
  /** 如果有包装对象，取里面的（活动字段通常在里面） */
  for (const k of WRAP_KEYS) {
    const v = o[k];
    if (v && typeof v === 'object') {
      o = { ...o, ...(v as Record<string, unknown>) };
      break;
    }
  }

  const relationType = num(
    o.relationType ?? o.relation_type ?? o.activityType ?? o.activity_type ?? o.type,
    0,
  );
  /**
   * ★ 答题的类型码有两个来源，都能是它：
   *   · 文档/活动类型表里写的是 18；
   *   · 但 H5 投屏那层 `appscreen/createScreen` 里，投票传 `type: 2`、答题传 `type: 6`
   *     （`.recon/umobile/src-async.*.js`：投票 `{userId, type:2, activityId}`，
   *      答题 `{userId, type:6, activityId}`）。
   * 所以 6 和 18 都当答题收，否则答题活动会在列表里被整批过滤掉（表现又是"0 条"）。
   */
  if (relationType !== 2 && relationType !== 6 && relationType !== 18) return null;

  const relationId = num(
    o.relationId ?? o.relation_id ?? o.relationID ?? o.activityId ?? o.activity_id ?? o.id,
    0,
  );
  if (!relationId) return null;

  const endTime = timeMs(o.endTime ?? o.end_time ?? o.deadline ?? o.closeTime ?? o.finishTime);
  const startTime = timeMs(o.startTime ?? o.start_time ?? o.beginTime ?? o.createTime);
  /** 服务端 state：'0' 结束 / '1' 进行中（签到那边已验证过这套语义） */
  const stateRaw = str(o.state ?? o.activityState ?? o.activity_state ?? '');
  const over = stateRaw === '0' || (endTime ? endTime < Date.now() : false);

  return {
    activityId: num(o.activityId ?? o.activity_id ?? o.id, relationId),
    relationId,
    relationType,
    title: str(
      o.title ?? o.activityName ?? o.name ?? o.content ?? o.remark,
      relationType === 2 ? '投票' : '答题',
    ),
    startTime,
    endTime,
    over,
    raw: o,
  };
}

/**
 * 读某个课堂的活动列表（只读 GET）。
 * relationType：2 投票 / 18 答题（这两个码是从优学院前端代码里挖出来的，见文件头）。
 *
 * ⚠️ 2026-10-30 真机反馈「这个课堂没有投票或答题活动」：
 *    接口回了 200，但我们的字段过滤没命中 → 0 条。
 *    现在改成：
 *      ① 兼容更多字段名与嵌套结构
 *      ② 如果第一组参数解析为 0，自动换参数再试一次（type 可能该去掉）
 *      ③ 把原始返回前 300 字放进 snippet，页面在 0 条时会显示出来，
 *         下一次就能按真实结构改，而不是继续猜
 */
export async function listClassroomActivities(
  api: RawApiFn,
  classroomId: number,
): Promise<{ ok: boolean; activities: ClassroomActivity[]; error?: string; status: number; snippet: string }> {
  /** 参数变体：先带 type=1，再不带 type（有些部署不认这个参数） */
  const variants = [
    `/courseapi/wisdomClassroom/student/classroomActivitys?classroomId=${classroomId}&pageSize=100&pageNum=1&type=1`,
    `/courseapi/wisdomClassroom/student/classroomActivitys?classroomId=${classroomId}&pageSize=100&pageNum=1`,
  ];

  let last: { status: number; snippet: string; error?: string } = { status: 0, snippet: '' };
  for (const path of variants) {
    const r = await api({ path, method: 'GET' });
    const snippet = String(r.body ?? '').replace(/\s+/g, ' ').slice(0, 300);
    last = { status: r.status, snippet, error: r.ok && r.status === 200 ? undefined : `HTTP ${r.status}` };
    if (!r.ok || r.status !== 200) continue;

    const j = tryJson(r.body);
    const list = asArrayDeep(j);
    const activities: ClassroomActivity[] = [];
    const seen = new Set<string>();
    for (const it of list) {
      const a = parseActivity(it);
      if (!a) continue;
      const key = `${a.relationType}-${a.relationId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      activities.push(a);
    }
    /** 解析到东西就返回；否则换下一组参数再试 */
    if (activities.length) {
      return { ok: true, activities, status: r.status, snippet };
    }
  }

  /**
   * ⚠️ 不能无脑 `ok: true`。
   *
   * 页面靠 `r.ok` 区分「请求没成功」和「真没有活动」。之前这里恒 true，
   * 于是下面四种情况在界面上都是同一句「没有解析出投票/答题活动」：
   *   · 授权闸 denyStatusChange 拦下（status 0）
   *   · 401 会话过期
   *   · 200 但正文是 HTML（网关 catch-all / 登录页）
   *   · 真的没有活动
   * 分不清就没法修，所以失败必须如实报出来。
   */
  const failed = last.status !== 200;
  return {
    ok: !failed,
    activities: [],
    status: last.status,
    error: failed
      ? last.status === 0
        ? '请求没有发出去（被授权闸或会话拦下）'
        : `HTTP ${last.status}`
      : undefined,
    snippet: last.snippet,
  };
}

/* ─────────────── 投票 ─────────────── */

export async function getVoteDetail(
  api: RawApiFn,
  input: { voteId: number; userId: number; classId: number },
): Promise<{ ok: boolean; detail?: VoteDetail; error?: string; status: number; snippet: string }> {
  const path = `/apps/voteV2/detail/${input.voteId}/${input.userId}/${input.classId}`;
  const r = await api({ path, method: 'GET' });
  const snippet = String(r.body ?? '').replace(/\s+/g, ' ').slice(0, 200);
  if (!r.ok || r.status !== 200) return { ok: false, error: `HTTP ${r.status}`, status: r.status, snippet };
  const j = tryJson(r.body);
  if (!j || typeof j !== 'object') return { ok: false, error: '返回不是 JSON', status: r.status, snippet };
  const o = j as Record<string, unknown>;
  /**
   * H5 的投票详情响应本身就是 voteData：
   *   { vote: { title, picture, selectableCount, endTime }, options: [...], myVoted, isOver }
   * 兼容被 { voteData: … } 包一层的情况。
   */
  const root = o.voteData && typeof o.voteData === 'object' ? (o.voteData as Record<string, unknown>) : o;
  const vote = (root.vote ?? {}) as Record<string, unknown>;
  const optionList = asArray(root.options ?? root.optionList);
  const options = optionList.map((x) => {
    const q = x as Record<string, unknown>;
    return {
      id: num(q.id ?? q.optionId, 0),
      /** H5 模板里显示的是 option.value（不是 content） */
      content: str(q.value ?? q.content ?? q.optionContent ?? q.title, '(未命名选项)'),
      selected: Boolean(q.selected),
      count: num(q.votedCount ?? q.count ?? q.num, 0),
    };
  });
  const endTime = timeMs(vote.endTime ?? vote.endDate ?? vote.deadline ?? root.endTime);
  /**
   * ⚠️ 两个字段的语义都跟直觉不同，都踩过：
   *   · `myVoted` 是数组（H5 里 `myVoted: [{id}]`），空数组/undefined 才是"没投过"。
   *     直接 Boolean([]) 恒 true —— 会把"没投过"当成"已投"。
   *   · 响应里**没有** `isOver` 字段；H5 判断结束只看 `vote.endDate < Date.now()`。
   *     这里以截止时间为准，`isOver` 只作兜底。
   */
  const myVotedRaw = root.myVoted ?? root.voted;
  const myVotedIds = Array.isArray(myVotedRaw)
    ? myVotedRaw
        .map((x) => (typeof x === 'number' ? x : num((x as Record<string, unknown> | null)?.id, 0)))
        .filter((n) => n > 0)
    : [];
  const myVoted = myVotedIds.length > 0 || (!Array.isArray(myVotedRaw) && Boolean(myVotedRaw));
  const over = Boolean(root.isOver ?? vote.isOver) || (endTime !== undefined ? endTime < Date.now() : false);
  return {
    ok: true,
    status: r.status,
    snippet,
    detail: {
      title: str(vote.title ?? root.title, '投票'),
      selectableCount: Math.max(1, num(vote.selectableCount ?? root.selectableCount, 1)),
      endTime,
      options,
      votedCount: num(root.votedCount, 0) || undefined,
      studentCount: num(root.studentCount ?? vote.studentCount, 0) || undefined,
      myVoted,
      myVotedIds,
      /** H5：`myVoted || isOver` 时只展示结果，不再给提交按钮 */
      over,
      raw: String(r.body ?? '').slice(0, 4000),
    },
  };
}

export async function submitVote(
  api: RawApiFn,
  input: { userId: number; voteId: number; optionIds: number[] },
): Promise<{ ok: boolean; status: number; message: string }> {
  /** 请求体照抄移动端 H5：classIds 固定 -1（表示不限班级） */
  const body = { userId: input.userId, classIds: -1, optionIds: input.optionIds, voteId: input.voteId };
  const r = await api({ path: '/apps/voteV2/stuSubmit', method: 'POST', body });
  const text = String(r.body ?? '').replace(/\s+/g, ' ');
  const j = tryJson(r.body) as Record<string, unknown> | null;
  const code = j ? num(j.code, 0) : 0;
  const msg = j ? str(j.message ?? j.msg ?? j.error, '') : '';
  /**
   * ⚠️ 投票接口的成功/失败标记跟别人不一样：
   *   · 失败时是 `{"success":false}`（真机探测 /apps/voteV2/detail/1/1/1 就是这个），
   *     既没有 code 也没有 message；
   *   · 旧判定只看 code（`code===0 || code===200`），于是 `{"success":false}`
   *     会被当成成功，界面还显示"投票已提交" —— 假成功，必须堵掉。
   */
  const successFlag = j && typeof j.success === 'boolean' ? j.success : undefined;
  /**
   * 投票的拒绝原因放在 `status` 里（真机实测：已结束的投票提交返回
   * `{"success":false,"status":202}`，HTTP 200，既没有 code 也没有 message）。
   * H5 自己也不解析这个字段（提交后直接重拉详情），所以只能按状态码翻译成人话。
   */
  const statusField = j ? num(j.status, 0) : 0;
  const STATUS_HINT: Record<number, string> = {
    201: '活动已结束',
    202: '不接受提交（活动已结束或不允许）',
    203: '活动不存在',
  };
  const hint = STATUS_HINT[statusField] ?? '';
  /** 常见失败码：201 已结束 / 203 活动不存在（H5 里就是这么判的） */
  const ok = r.status === 200 && successFlag !== false && (code === 0 || code === 200) && !/fail|失败|结束/i.test(msg);
  const detailText = msg || hint || text.slice(0, 160);
  const codePart = statusField ? ` · status ${statusField}` : code ? ` · code ${code}` : '';
  return { ok, status: r.status, message: `${detailText || '(服务端没有返回消息)'}（HTTP ${r.status}${codePart}）` };
}

/* ─────────────── 答题 ─────────────── */

export async function getAnswerDetail(
  api: RawApiFn,
  input: { id: number },
): Promise<{ ok: boolean; detail?: AnswerDetail; error?: string; status: number; snippet: string }> {
  /**
   * 答题走 application 域的 /classroomapi（SMART_API_HOST）——这是 H5 实际调的地址。
   *
   * ⚠️ 但 2026-10-31 无凭据探测发现 `lms.dgut.edu.cn/classroomapi/...` 也真实存在
   *    （`PUT .../student/detail/1` → 405 Allow: GET），说明网关也代理了这一份。
   *    两个都试，谁先回 200 用谁；这样既跟 H5 一致，又不至于因为域名单点挂掉。
   */
  const paths = [
    `/smartapi/replyquestion/student/detail/${input.id}`,
    `/classroomapi/replyquestion/student/detail/${input.id}`,
  ];
  let r = await api({ path: paths[0], method: 'GET' });
  if (!r.ok || r.status !== 200) {
    const alt = await api({ path: paths[1], method: 'GET' });
    if (alt.ok && alt.status === 200) r = alt;
  }
  const snippet = String(r.body ?? '').replace(/\s+/g, ' ').slice(0, 200);
  if (!r.ok || r.status !== 200) return { ok: false, error: `HTTP ${r.status}`, status: r.status, snippet };
  const j = tryJson(r.body);
  if (!j || typeof j !== 'object') return { ok: false, error: '返回不是 JSON', status: r.status, snippet };
  const o = j as Record<string, unknown>;
  /**
   * H5 的读法（78.js getAnswerQueDtail）：
   *   e.result.replyquestion  → **JSON 字符串**，parse 出来是 { type, status, answer, content… }
   *   e.result.options        → 选项数组 [{ id, value }]
   *   e.result.myAnswer       → 「逗号分隔的 value」；null = 没答过
   *   e.result.correctAnswer  → 同上，正确答案
   *   e.result.isRight        → 服务端判题结果
   *
   * 三处最容易写错的地方：
   *   ① replyquestion 是字符串，不 parse 就读不到 type/status
   *   ② options 在 result 上，不在 replyquestion 里
   *   ③ myAnswer 存的是 value，不是 option.id
   */
  const result = (o.result && typeof o.result === 'object' ? o.result : o) as Record<string, unknown>;
  const rawQue = result.replyquestion ?? result.question;
  const que =
    typeof rawQue === 'string'
      ? ((tryJson(rawQue) as Record<string, unknown> | null) ?? {})
      : ((rawQue as Record<string, unknown> | undefined) ?? {});
  const optionList = asArray(result.options ?? que.options);
  const options = optionList.map((x) => {
    const q = x as Record<string, unknown>;
    const value = str(q.value ?? q.optionValue ?? q.content ?? q.title, '');
    return {
      id: num(q.id ?? q.optionId ?? q.replyoptionId, 0),
      value,
      content: value || str(q.content ?? q.title, '(未命名选项)'),
      selected: false,
    };
  });
  const splitValues = (v: unknown): string[] =>
    str(v, '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
  const myAnswerValues = splitValues(result.myAnswer);
  /**
   * 正确答案有两个来源，都要收：
   *   · `result.correctAnswer` —— 判分后由服务端单独给出
   *   · `replyquestion.answer` —— 老师建题时就存在题面 JSON 里（H5 用它做对错着色，
   *     只是界面上用 `answer != "" && isOver` 控制"结不结束才显示"）
   * 后者意味着：**进行中的答题，detail 响应里可能本来就带着答案**。
   * 所以这里不能只看 correctAnswer，否则永远拿不到。
   */
  const correctAnswerValues = [
    ...new Set([...splitValues(result.correctAnswer), ...splitValues(que.answer)]),
  ];
  /** value → option.id（界面预选、以及判断"已答过"都用得到） */
  const myAnswer = myAnswerValues
    .map((v) => options.find((op) => op.value === v)?.id ?? 0)
    .filter((n) => n > 0);
  /** H5：`0 == answerQueData.status ? isOver = false : isOver = true` —— 0 才是进行中 */
  const statusRaw = que.status ?? result.state;
  const over =
    statusRaw === undefined || statusRaw === null
      ? Boolean(que.isOver ?? result.isOver)
      : num(statusRaw, -1) !== 0;
  const isRightRaw = result.isRight ?? que.isRight;
  return {
    ok: true,
    status: r.status,
    snippet,
    detail: {
      title: str(que.title ?? que.content ?? o.title, '答题'),
      type: num(que.type ?? result.type, 1),
      options,
      myAnswerValues,
      myAnswer,
      correctAnswerValues,
      isRight: typeof isRightRaw === 'boolean' ? isRightRaw : undefined,
      answered: myAnswerValues.length > 0,
      over,
      raw: String(r.body ?? '').slice(0, 4000),
    },
  };
}

/* ─────────────── 教师侧接口（"已结束后提交"要靠它们） ─────────────── */

/**
 * 把活动**重新打开**（变回进行中），之后就能正常提交。
 *
 * 来源（`.recon/umobile/src-async.*.js`）：
 *   · 投票  `r.post("/voteV2/restart/" + voteId)`   base = /apps
 *   · 答题  `r.get("/replyquestion/restart/" + id)`  base = application/classroomapi
 * 2026-10-31 无凭据探测确认三处路由真实存在（405 + Allow: POST / GET）。
 *
 * ⚠️⚠️ 2026-10-31 实测事故（务必先读）：
 *   对**已结束**的投票调用 restart 之后，这个投票的票数从 42/43/12 变成 0/0/0 ——
 *   也就是说"重开"的语义是**重置活动统计**，全体同学原本的投票记录被清空，
 *   而且 end 只能把状态改回"已结束"，**票数回不来**。
 *   因此投票/答题页的「重开活动」「恢复为已结束」两个入口已全部从 UI 移除。
 *   这里的函数保留仅为将来研究，**不要再接回界面**。
 *
 * ⚠️ 这是**教师端**功能。学生 token 调它会不会被服务端按角色拦，只能实测；
 * 这里把服务端原文返回给界面，不替它下结论。
 */
/**
 * 教师侧动作的统一判定。
 *
 * ⚠️ 不能只看 HTTP 200：这些接口业务失败也是 200，靠 body 里的
 *    `code`（0/200 才算成功）或 `success:false` 表达。只看状态码会把
 *    "被角色拦下"当成"重开成功"，界面还会把提示清掉 —— 表现就是点了没反应。
 */
function judgeTeacherAction(r: { status: number; body: string }): {
  ok: boolean;
  status: number;
  body: string;
} {
  const text = String(r.body ?? '');
  const j = tryJson(text) as Record<string, unknown> | null;
  const code = j ? num(j.code, NaN) : NaN;
  const successFlag = j && typeof j.success === 'boolean' ? j.success : undefined;
  const codeOk = !Number.isFinite(code) || code === 0 || code === 200;
  const ok = r.status === 200 && successFlag !== false && codeOk;
  return { ok, status: r.status, body: text.slice(0, 400) };
}

export async function restartVote(
  api: RawApiFn,
  input: { voteId: number },
): Promise<{ ok: boolean; status: number; body: string }> {
  const r = await api({ path: `/apps/voteV2/restart/${input.voteId}`, method: 'POST' });
  return judgeTeacherAction(r);
}

export async function restartAnswer(
  api: RawApiFn,
  input: { id: number },
): Promise<{ ok: boolean; status: number; body: string }> {
  const paths = [
    `/smartapi/replyquestion/restart/${input.id}`,
    `/classroomapi/replyquestion/restart/${input.id}`,
  ];
  let r = await api({ path: paths[0], method: 'GET' });
  if (!r.ok || r.status !== 200) {
    const alt = await api({ path: paths[1], method: 'GET' });
    if (alt.ok && alt.status === 200) r = alt;
  }
  return judgeTeacherAction(r);
}

/**
 * 结束投票（教师侧）：`PUT /voteV2/end/{voteId}/{userId}`（实测 `Allow: POST, PUT`）。
 * 重开、提交、再结束 —— 这样不会把课堂的活动状态挂成"进行中"。
 */
export async function endVote(
  api: RawApiFn,
  input: { voteId: number; userId: number },
): Promise<{ ok: boolean; status: number; body: string }> {
  const r = await api({ path: `/apps/voteV2/end/${input.voteId}/${input.userId}`, method: 'PUT' });
  return judgeTeacherAction(r);
}

/**
 * 结束答题（教师侧）：`GET /replyquestion/end/{id}`（H5：`r.get("/replyquestion/end/"+t)`）。
 * 用途：万一 restart 把活动打开了，用它把状态恢复成"已结束"。
 */
export async function endAnswer(
  api: RawApiFn,
  input: { id: number },
): Promise<{ ok: boolean; status: number; body: string }> {
  const paths = [
    `/smartapi/replyquestion/end/${input.id}`,
    `/classroomapi/replyquestion/end/${input.id}`,
  ];
  let r = await api({ path: paths[0], method: 'GET' });
  if (!r.ok || r.status !== 200) {
    const alt = await api({ path: paths[1], method: 'GET' });
    if (alt.ok && alt.status === 200) r = alt;
  }
  return judgeTeacherAction(r);
}

/**
 * 删除投票（教师侧）：`GET /apps/voteV2/delete/{voteId}/{userId}`。
 * 2026-10-31 无凭据探测确认路由存在（PUT → 405 `Allow: GET`；少一段参数 → 401 兜底）。
 *
 * ⚠️⚠️ 破坏性操作：
 *   · 删掉之后这个投票从活动列表里消失，统计一并没了，**不可恢复**；
 *   · 请求必然带你的 AUTHORIZATION token，平台侧日志里能定位到账号和 IP ——
 *     "匿名删除"在协议层不成立（不带 token 就只有 401）。
 * 只在用户明确要求时调用，界面上必须折叠 + 二次确认 + 讲清后果。
 */
export async function deleteVote(
  api: RawApiFn,
  input: { voteId: number; userId: number },
): Promise<{ ok: boolean; status: number; body: string }> {
  const r = await api({ path: `/apps/voteV2/delete/${input.voteId}/${input.userId}`, method: 'GET' });
  return judgeTeacherAction(r);
}

/**
 * 解析"我的班级 id"（投票详情最后一段要它）。
 *
 * ⚠️ 为什么需要它：投票统计是**按班级**返回的，
 *    传 -1 只能拿到空统计（0 票、无截止时间），看着像"数据没了"。
 *    活动列表项里经常没有 classId，所以这里去课程列表兜底：
 *    `GET /courseapi/courses/students?publishStatus=1&pn=1&ps=99999&type=1`
 *    → `{total, courseList:[{id, name, classId, classIdName…}]}`
 *    （结构见 youxue-api-verified.md 4.1）
 *
 * 纯只读 GET，不写任何数据。匹配顺序：ocId 对应课程 → 只有一门就用它 → 否则第一门。
 */
export async function resolveStudentClassId(
  api: RawApiFn,
  hint: { ocId?: number } = {},
): Promise<{ classId: number; source: string }> {
  const r = await api({
    path: '/courseapi/courses/students?publishStatus=1&pn=1&ps=99999&type=1',
    method: 'GET',
  });
  if (!r.ok || r.status !== 200) return { classId: 0, source: `课程列表读取失败（HTTP ${r.status}）` };
  const j = tryJson(r.body) as Record<string, unknown> | null;
  const list = j && Array.isArray(j.courseList) ? (j.courseList as Record<string, unknown>[]) : [];
  if (!list.length) return { classId: 0, source: '课程列表为空' };
  const hit = hint.ocId ? list.find((c) => num(c.id, 0) === hint.ocId) : undefined;
  /**
   * ⚠️ 不再"猜第一门课"。
   * 2026-10-31 实测：拿课程列表第一门（马原，classId 952525）去查概率论的投票，
   * 服务端直接回 `{"success":false}` —— 班级不对等于查不到。
   * 所以只有**能确定**时才给值：
   *   · 按 ocId 命中 → 用它
   *   · 列表只有一门 → 用它
   * 否则返回 0，让调用方提示用户手填，而不是塞一个看起来像答案的错值。
   */
  if (hit) {
    return { classId: num(hit.classId, 0), source: `按 ocId 匹配到「${str(hit.name, '')}」` };
  }
  if (list.length === 1) {
    return { classId: num(list[0].classId, 0), source: `只有一门课「${str(list[0].name, '')}」` };
  }
  return {
    classId: 0,
    source: `有 ${list.length} 门课，无法确定这一条属于哪门（可手填班级 id）`,
  };
}

export async function submitAnswer(
  api: RawApiFn,
  input: { replyoptionId: number; optionIds: number[]; change?: boolean },
): Promise<{ ok: boolean; status: number; message: string }> {
  /**
   * ⚠️ optionIds 里放的是 **option.id**（数值），不是选项 value。
   *
   * 证据链（78.js getAnswerQueDtail）：
   *   · 服务端 result.myAnswer / correctAnswer / replyquestion.answer 都是**选项 value 串**
   *   · H5 先把 value 翻成 id 存进组件状态：
   *       options.forEach(t => n.forEach(e => t.value == e && a.push(t.id)))
   *       this.myAnswer = a.join(',')
   *       this.answerQueData.answer = r.join(',')   // ← 同样是 id
   *   · 提交时直接 `var e = this.myAnswer.split(',').filter(非空).sort(a-b)`
   *     → `{ replyoptionId: 路由 id, optionIds: e }`
   * 所以界面选中项只要传 id 即可；**不要**把 value 传给服务端（value 一般是
   * "A/B/C" 或数字字符串，被当成 id 会解析成不存在的选项）。
   */
  const optionIds = [...input.optionIds].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const body = { replyoptionId: input.replyoptionId, optionIds };
  /** 与详情同理：先在 application 域提交，失败再退到 lms 域的 /classroomapi */
  const paths = [
    input.change ? '/smartapi/replyquestion/stuChangeReply' : '/smartapi/replyquestion/stuReply',
    input.change ? '/classroomapi/replyquestion/stuChangeReply' : '/classroomapi/replyquestion/stuReply',
  ];
  let r = await api({ path: paths[0], method: 'POST', body });
  if (!r.ok || r.status !== 200) {
    const alt = await api({ path: paths[1], method: 'POST', body });
    if (alt.ok && alt.status === 200) r = alt;
  }
  const j = tryJson(r.body) as Record<string, unknown> | null;
  const code = j ? num(j.code, 0) : 0;
  const msg = j ? str(j.message ?? j.msg ?? j.error, '') : String(r.body ?? '').slice(0, 160);
  /** 同投票：`success:false` 也要算失败，别被"没有 code"骗过去 */
  const successFlag = j && typeof j.success === 'boolean' ? j.success : undefined;
  /** 同投票：有些部署把状态放 status 而不是 code */
  const statusField = j ? num(j.status, 0) : 0;
  const STATUS_HINT: Record<number, string> = {
    201: '活动已结束',
    202: '不接受提交（活动已结束或不允许）',
    203: '活动不存在',
  };
  const hint = STATUS_HINT[statusField] ?? '';
  /** H5 里 201 = 活动已结束；203 = 活动已删除 */
  const ok = r.status === 200 && successFlag !== false && (code === 0 || code === 200) && !/fail|失败|结束/i.test(msg);
  const codePart = statusField ? ` · status ${statusField}` : code ? ` · code ${code}` : '';
  return { ok, status: r.status, message: `${msg || hint || '(服务端没有返回消息)'}（HTTP ${r.status}${codePart}）` };
}
