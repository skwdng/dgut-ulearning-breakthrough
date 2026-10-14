/**
 * 签到领域模型 —— 按实测接口重新定义。
 *
 * 全部字段名都来自实测响应（见 youxue-api-verified.md），不是猜的。
 */

/**
 * 签到方式。
 * 映射来自学生端源码（chunk 45/detailOfStu 的 btnStatus）：
 *   case 0 → attendance.signNow        "立即签到"
 *   case 1 → attendance.scanCodeSign   "扫码签到"
 *   case 2 → attendance.numCodeSign    "数字码签到"
 *   case 3 → attendance.oneClickCheckIn "一键签到"
 * 已验证：Java 09-08 在 App 显示"二维码签到"，接口 type=1 ✅
 * 注意：type=0 是"立即签到"（位置签到），不是二维码。
 */
export type SignMethod = 'location' | 'qrcode' | 'numcode' | 'oneclick' | 'unknown';

export const SIGN_METHOD_META: Record<SignMethod, { label: string; type: number; hint: string }> = {
  location: {
    label: '位置签到',
    type: 0,
    hint: '提交一个落在教师设定范围内的坐标（格式：经度,纬度，6 位小数）',
  },
  qrcode: {
    label: '二维码签到',
    type: 1,
    hint: '需要拿到教师投屏二维码的内容（每 15 秒刷新一次）',
  },
  numcode: {
    label: '数字码签到',
    type: 2,
    hint: '需要教师口播的 4 位数字码',
  },
  oneclick: {
    label: '一键签到',
    type: 3,
    hint: '点击即可完成，不需要额外凭证',
  },
  unknown: { label: '未知方式', type: -1, hint: '未能识别签到方式' },
};

/**
 * 学生的签到状态。
 * 映射来自学生端源码（formatStatus / showAttendSuc）：
 *   showAttendSuc = (status===1 || status===2)   → 显示"签到成功"
 *   formatStatus: 0=缺勤 1/2=已签到 3=迟到 4=早退 5=病假 6=事假
 *
 * ⚠️ 千万不要用 `state` 判断签到状态：
 *    state 表示"活动是否已结束"（0=已结束 1=进行中），
 *    英语课 39 条已签到但 state="0"，用 state 会全部误判为未签到。
 */
export type SignState = 'signed' | 'absent' | 'late' | 'early' | 'sick' | 'personal' | 'unknown';

export const SIGN_STATE_META: Record<SignState, { label: string; fg: string; bg: string }> = {
  signed: { label: '已签到', fg: '#10B981', bg: '#ECFDF5' },
  absent: { label: '缺勤', fg: '#EF4444', bg: '#FEF2F2' },
  late: { label: '迟到', fg: '#F59E0B', bg: '#FFFBEB' },
  early: { label: '早退', fg: '#F59E0B', bg: '#FFFBEB' },
  sick: { label: '病假', fg: '#6366F1', bg: '#EEF2FF' },
  personal: { label: '事假', fg: '#6366F1', bg: '#EEF2FF' },
  unknown: { label: '未知', fg: '#6B7280', bg: '#F3F4F6' },
};

/**
 * 是否算作"已签到"。
 * 源码 showAttendSuc 就是判 status===1 || status===2，映射到状态即 'signed'。
 * 迟到/早退/请假都**不算**已签到。
 */
export function isSignedState(s: SignState): boolean {
  return s === 'signed';
}

/**
 * 判断一个点名**此刻是否真的能签到**。
 *
 * ⚠️ 不能只看服务端的 `activityState`。
 *    实测：2022 年的历史记录，`getAttendanceForStu` 返回的 `state` 仍是 `"1"`，
 *    于是界面上把三年前的记录显示成"进行中"，还给出「签到」按钮 ——
 *    点下去必然失败（"缺少考勤码" / "点名已结束"）。
 *
 * 但也不能把门槛设太死：**学生端到底能不能改，最终由服务端说了算**。
 * 所以这里只做"明显不可能"的排除：
 *    点名创建时间超过 24 小时 → 一定结束了，不再当作进行中
 *    24 小时以内            → 允许尝试（点下去由服务端回答）
 *
 * 24 小时这个阈值刻意宽松：宁可让人试一次拿到真实报错，
 * 也不要因为本地规则太严而把**本来能签的**记录藏起来。
 *
 * ⚠️ 这个函数放在 domain 层（而不是列表页里）：
 *    store 也要用它统计"进行中的点名有几个"，
 *    如果留在页面组件里，store 就得反向 import 页面 —— 循环依赖。
 */
export const ONGOING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function isReallyOngoing(
  r: { activityState?: string; beginTime?: number; createDate?: number },
  now = Date.now(),
): boolean {
  if (r.activityState !== '1') return false;
  const created = r.beginTime ?? r.createDate;
  // 拿不到时间就保守地不认为可签到（避免把历史记录当进行中）
  if (!created) return false;
  return now - created <= ONGOING_MAX_AGE_MS;
}

/**
 * 记录行上那个状态徽标该显示什么。
 *
 * ══════════ 为什么要单独抽出来 ══════════
 * 踩过的坑：服务端对「还没操作的进行中点名」返回 `status=0`，
 * 而 `SIGN_STATE_META.absent` 的文案是**「缺勤」**。
 * 于是老师刚发起点名、你还没来得及签时，界面上已经写着「缺勤」——
 * 明明还有时间，却先被告知缺勤。
 *
 * 规则：
 *   · 进行中 + 未签到 → 「待签到」（主色调，传达"还能做"）
 *   · 已签到          → 用真实状态（已签到 / 迟到 / 早退…）
 *   · 其余            → 用真实状态（缺勤 等）
 *
 * 抽成纯函数是为了**能被测试**：这类"文案与状态时机"的问题
 * 只在真机上肉眼可见，靠读代码很容易漏。
 */
export function signBadge(
  r: { state: SignState; activityState?: string; beginTime?: number; createDate?: number },
  now = Date.now(),
): { text: string; tone: 'pending' | 'signed' | 'plain' } {
  const signed = isSignedState(r.state);
  const pending = !signed && isReallyOngoing(r, now);
  if (pending) return { text: '待签到', tone: 'pending' };
  return { text: SIGN_STATE_META[r.state].label, tone: signed ? 'signed' : 'plain' };
}

/** 相对时间：用于让用户一眼看出"这条是刚发起的" */
export function relativeTime(ts: number | undefined, now = Date.now()): string {
  if (!ts) return '时间未知';
  const diff = now - ts;
  if (diff < 0) return '刚刚';
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return `${Math.floor(d / 30)} 个月前`;
}

/** 业务错误码翻译结果 */
export interface SignErrorInfo {
  code?: number;
  text: string;
  detail?: string;
  retryable: boolean;
}

/** 课程列表原始项（实测字段） */
export interface RawCourse {
  id: number;
  name: string;
  courseCode?: string;
  classId?: number;
  className?: string;
  teacherName?: string;
  learnProgress?: number;
  publishStatus?: number;
  creatorOrgName?: string;
}

/** 课堂原始项（实测字段） */
export interface RawClassroom {
  id: number;
  title: string;
  status?: number;
  beginTime?: number;
  /** 该课堂的活动数量 */
  activityNum?: number;
  ocName?: string;
  teacherName?: string;
  isCreateLive?: number;
}

/**
 * 签到详情 —— 对应 `GET /apps/newAttendance/getAttendanceForStu/{attendanceID}/{userId}`
 *
 * 实测响应示例：
 * {
 *   "sex":"1", "currentDate":1791444213857,
 *   "classez":[{"classID":949597,"className":"2025软件1-2班"}],
 *   "userName":"曾志峰",            // ⚠️ 教师姓名
 *   "type":1, "title":"2026-09-30 09:16 点名",
 *   "userID":5298184,               // ⚠️ 教师 userId
 *   "attendanceID":919695, "location":"", "state":"1",
 *   "time":"-1", "createDate":1790731017000, "status":1
 * }
 */
export interface SignDetail {
  /** 签到活动 id —— 提交时必填 */
  attendanceID: number;
  /** 标题，如 "2026-09-30 09:16 点名" */
  title: string;
  /**
   * 签到方式（对应服务端 `type`）。
   * 源码映射：0=位置 1=二维码 2=数字码 3=一键签到
   */
  method: SignMethod;
  /** 服务端原始 type 值（0~3） */
  rawType?: number;
  /**
   * 学生签到状态（对应服务端 `status`）。
   * 源码映射：0=缺勤 1/2=已签到 3=迟到 4=早退 5=病假 6=事假
   * ⚠️ 不是 `state`（state 表示活动是否结束）
   */
  state: SignState;
  /** 服务端原始 status 值（0~6） */
  rawStatus?: number;
  /**
   * 活动状态（对应服务端 `state`）。
   * "0"=已结束 "1"=进行中
   * ⚠️ 与签到状态无关，只是活动窗口是否开着。
   */
  activityState?: string;
  /** 班级（可多个） */
  classes: Array<{ classID: number; className: string }>;
  /** ⚠️ 教师姓名（字段名叫 userName，容易误读成学生） */
  teacherName?: string;
  /** ⚠️ 教师 userId */
  teacherUserId?: number;
  /** 地点（位置签到时有值） */
  location?: string;
  /** 地址（位置签到时有值） */
  address?: string;
  /** 创建时间（毫秒） */
  createDate?: number;
  /** 剩余时间（"-1" 表示无限制） */
  time?: string;
  /** 服务端认为的当前时间 */
  serverNow?: number;
  // ---- 以下由"课程→课堂→活动"遍历补全 ----
  /** 课程 id */
  ocId?: number;
  /** 课程名 */
  courseName?: string;
  /** 课程所属班级名 */
  className?: string;
  /** 课堂 id */
  classroomId?: number;
  /** 课堂标题，如 "09-30 星期三 09:16 课堂" */
  classroomTitle?: string;
  /** 点名开始时间（来自活动列表，比 createDate 更贴近实际点名时刻） */
  beginTime?: number;
}

/** 一门课 / 一次课堂 */
export interface SignCourse {
  /** 课程 id */
  ocId: number;
  name: string;
  teacher?: string;
  /** 班级名 */
  className?: string;
  /** 该课程的签到记录 */
  records: SignDetail[];
  /** 已签到数 */
  signedCount: number;
  /** 缺勤数 */
  absentCount: number;
}

/** 总览数据 */
export interface SignOverview {
  /** 用户信息 */
  user: {
    userId: number;
    loginName: string;
    name?: string;
    classNum?: number;
    avatar?: string;
    orgId?: number;
  } | null;
  /** 所有课程（含其签到记录） */
  courses: SignCourse[];
  /** 全部签到记录（不分组） */
  allRecords: SignDetail[];
  /** 汇总 */
  summary: {
    total: number;
    /** 已签到数（status 为 1 或 2） */
    signed: number;
    /** 缺勤数（status 为 0） */
    absent: number;
    /** 签到率（0~1） */
    signedRate: number;
  };
  /** 本次查询时间 */
  fetchedAt: number;
  /** 数据来源是否可信（离线/部分失败时为 false） */
  complete: boolean;
  /** 失败说明 */
  warnings: string[];
}

/** 提交签到的参数 —— 字段名与类型均来自实测 */
export interface SignSubmitInput {
  attendanceID: number;
  /** ⚠️ 必须是数字 userId，传学号字符串会被服务端 400 拒绝 */
  userID: number;
  classID?: number;
  method: SignMethod;
  /** 位置签到：经纬度字符串（实测格式 "113.8182,22.9015"） */
  location?: string;
  address?: string;
  /** 扫码签到：二维码内容 */
  attendanceCode?: string;
}

export interface SignSubmitResult {
  ok: boolean;
  /** 服务端返回（可能为空体） */
  raw?: string;
  /** 解析出的错误信息 */
  message?: string;
  /** 错误码（如 1201 = 参数类型错误） */
  code?: number;
}

/** 用户资料 —— 对应 `GET /apps/user/getUserByUserID/{userId}` */
export interface YouxueUser {
  userId: number;
  loginName: string;
  name?: string;
  role?: number;
  sex?: number;
  avatar?: string;
  classNum?: number;
  orgId?: number;
}
