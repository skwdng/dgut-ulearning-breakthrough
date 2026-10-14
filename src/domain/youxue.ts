/** 优学院业务数据的领域模型：课件、作业、课程概况 */

/** 课件 / 资源项 */
export interface CoursewareItem {
  id: number;
  title: string;
  /** 服务端原始 type（0 可能是目录，1 文档，2 链接，14 微课…） */
  type?: number;
  /** 服务端给的可读类型名，如 document / image / video */
  resourceTypeName?: string;
  parentId?: number;
  /** 是否为目录（可展开） */
  isFolder?: boolean;
  size?: number;
  duration?: number;
  /** 学习进度 0~100 */
  studyProgress?: number;
  finished?: boolean;
  /** 禁止下载（服务端 remark3 = 1） */
  cantDownload?: boolean;
  /** 浏览（打开）次数 */
  viewTimes?: number;
  /** 下载次数 */
  downloadTimes?: number;
  /**
   * ★ 课件创建/发布时间（毫秒时间戳）。
   *
   * ⚠️ 这个字段本来是**有**的（实测原始响应里字段名就是 `createTime`），
   *    只是归一化时被漏掉了 —— 于是"最近三个月"这种按时间的筛选
   *    对课件根本没法做。
   *
   * 用途：任务页的「最近 / 全部」筛选（近三个月）。
   */
  createTime?: number;
  /** 所属课程名（遍历多门课时补全） */
  courseName?: string;
  /** 所属课程 id（遍历多门课时补全） */
  ocId?: number;
}

/** 课件详情 */
export interface CoursewareDetail {
  id: number;
  title: string;
  type?: number;
  url?: string;
  size?: number;
  duration?: number;
  remark3?: string;
  cantDownload?: boolean;
  raw: Record<string, unknown>;
}

/**
 * 作业项。
 *
 * 字段映射来自实测（`/courseapi/homeworks/student`，25 门课共 90+ 条样本）：
 *   state      0 未开始 · 2 进行中 · 3 已结束 · 4 已批改 · 9 特殊
 *   status     2 未提交 · 3 已提交/已批改
 *   timeStatus state 的字符串版本
 *   type       9 作业 · 3 测验 · 8 视频类
 */
export interface HomeworkItem {
  id: number;
  title: string;
  /** 所属课程 */
  courseName?: string;
  ocId?: number;
  classId?: number;
  /** 开始时间 */
  startTime?: number;
  /** 截止时间 */
  endTime?: number;
  /** 互评截止（有互评环节时存在） */
  peerReviewTime?: number;
  /** 服务端原始 type：9 作业 / 3 测验 / 8 视频 */
  type?: number;
  /** 服务端原始 state */
  rawState?: number;
  /** 服务端原始 status（2=已提交 3=已批改） */
  rawStatus?: number;
  /** 服务端原始 personStatus（1=未提交 2=已提交）—— 与 rawStatus 互为印证 */
  rawPersonStatus?: number;
  /** 时间状态：未开始 / 进行中 / 已结束 */
  timeState: 'notStarted' | 'ongoing' | 'ended' | 'unknown';
  /** 提交状态 */
  submitState: 'unsubmitted' | 'submitted' | 'graded' | 'unknown';
  /** 得分 */
  score?: number;
  /** 发布教师 */
  publisher?: string;
  /** 是否互评 */
  hasPeerReview?: boolean;
}

/** 作业/测验类型 */
export const HOMEWORK_TYPE_LABEL: Record<number, string> = {
  3: '测验',
  8: '视频',
  9: '作业',
};

/** 一门课的课件概况（用于列表展示） */
export interface CourseOverview {
  ocId: number;
  name: string;
  teacher?: string;
  className?: string;
  courseCode?: string;
  /** 学习进度 0~100 */
  learnProgress?: number;
  /** 累计学习时长（秒） */
  totalDuration?: number;
  /** 课件数（加载后填充） */
  coursewareCount?: number;
}
