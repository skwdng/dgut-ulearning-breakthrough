/**
 * 小c 的「本地工具」—— **先在手机上把数据算准，再让模型组织语言**。
 *
 * ══════════════ 为什么需要这一层（踩过的坑）══════════════
 *
 * 第一版是纯 RAG：把每条记录切句、算向量、检索几条丢给模型。
 * 实测问题：
 *   · 数据一多（几百条）→ 要发几十批 embed 请求，用户看到"正在整理数据"很久
 *   · 0.5B 小模型**不会算数**：给它 6 条订单它能算总和，给 40 条就会算错/编
 *   · "你好"这种问候也走完整检索 → 慢得离谱
 *
 * ══════════════ 现在的做法（参考 agent 课里的 "tools + loop"）══════════════
 *
 * 把"能用代码算准的东西"做成**确定性工具**（就是普通函数）：
 *   · 外卖：次数、总金额、日均、常点店铺
 *   · 签到：总次数、各状态、缺勤/迟到按课程统计
 *   · 作业：未交清单（含截止时间）
 *   · 课件：未看完清单（含进度）
 *
 * 用户提问 → 用关键词判断**该用哪些工具** → 本地算出结果 →
 * 把「结构化结果」作为**最高优先级资料**塞给模型 → 模型只负责说人话。
 *
 * ⚠️ 这样即使模型很笨，数字也不会错 —— 数字是我们算的，不是它算的。
 * ⚠️ 问候/闲聊**不调用任何工具**，直接本地回复（见 tab-ai 的快路径）。
 */
import type { SignDetail } from '../domain/checkin';
import type { DeliveryOrder } from '../domain/delivery';
import type { TaskHomework, TaskCourseware } from '../state/taskStore';

/* ══════════════════ 工具结果类型 ══════════════════ */

export interface DeliverySummary {
  /** 统计窗口天数（0 = 全部） */
  days: number;
  count: number;
  totalAmount: number;
  /** 有价格的订单里，平均每单 */
  avgAmount: number;
  /** 金额最高的店铺 top3 */
  topStores: Array<{ name: string; count: number; amount: number }>;
  /** 已取消的订单数（不计入金额/次数） */
  cancelled: number;
}

export interface SignSummary {
  total: number;
  signed: number;
  absent: number;
  late: number;
  /** 缺勤/迟到 按课程聚合 */
  problemByCourse: Array<{ course: string; absent: number; late: number }>;
}

export interface HomeworkTodo {
  title: string;
  course?: string;
  dueAt?: number;
  overdue: boolean;
}

/* ══════════════════ 时间工具 ══════════════════ */

function dayKey(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtDate(t?: number): string {
  if (!t || !Number.isFinite(t)) return '无截止时间';
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 只有日期（"今天几号"用） */
function fmtDateOnly(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/** 日期 + 时间（"现在几点"用）—— 必须用**手机本地时间**，不能让模型猜 */
function fmtDateTime(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ══════════════════ ① 外卖统计 ══════════════════ */

/** 已取消的不算"点过" */
const COUNTABLE = new Set(['created', 'paid', 'delivering', 'done', 'unknown']);

export function deliverySummary(orders: DeliveryOrder[], days = 0, now = Date.now()): DeliverySummary {
  const since = days > 0 ? now - days * 24 * 3600 * 1000 : 0;
  const inWindow = orders.filter((o) => o.at >= since);

  const valid = inWindow.filter((o) => COUNTABLE.has(o.stage));
  const cancelled = inWindow.length - valid.length;

  const withAmount = valid.filter((o) => typeof o.amount === 'number' && o.amount > 0);
  const totalAmount = withAmount.reduce((s, o) => s + (o.amount as number), 0);

  const byStore = new Map<string, { count: number; amount: number }>();
  for (const o of valid) {
    const k = o.storeName || '未知店铺';
    const cur = byStore.get(k) ?? { count: 0, amount: 0 };
    cur.count += 1;
    if (typeof o.amount === 'number' && o.amount > 0) cur.amount += o.amount;
    byStore.set(k, cur);
  }
  const topStores = [...byStore.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.amount - a.amount || b.count - a.count)
    .slice(0, 3);

  return {
    days,
    count: valid.length,
    totalAmount: Math.round(totalAmount * 100) / 100,
    avgAmount: withAmount.length ? Math.round((totalAmount / withAmount.length) * 100) / 100 : 0,
    topStores,
    cancelled,
  };
}

/* ══════════════════ ② 签到统计 ══════════════════ */

export function signSummary(records: SignDetail[]): SignSummary {
  let signed = 0;
  let absent = 0;
  let late = 0;
  const byCourse = new Map<string, { absent: number; late: number }>();

  for (const r of records) {
    if (r.state === 'signed') signed += 1;
    if (r.state === 'absent') absent += 1;
    if (r.state === 'late') late += 1;

    if (r.state === 'absent' || r.state === 'late') {
      const course = r.courseName?.trim() || '未知课程';
      const cur = byCourse.get(course) ?? { absent: 0, late: 0 };
      if (r.state === 'absent') cur.absent += 1;
      if (r.state === 'late') cur.late += 1;
      byCourse.set(course, cur);
    }
  }

  const problemByCourse = [...byCourse.entries()]
    .map(([course, v]) => ({ course, ...v }))
    .sort((a, b) => b.absent - a.absent || b.late - a.late)
    .slice(0, 5);

  return { total: records.length, signed, absent, late, problemByCourse };
}

/* ══════════════════ ③ 作业 / 课件待办 ══════════════════ */

export function homeworkTodo(homeworks: TaskHomework[], now = Date.now()): HomeworkTodo[] {
  return homeworks
    .map((h) => ({
      title: h.title,
      course: h.courseName,
      dueAt: h.endTime,
      overdue: typeof h.endTime === 'number' && h.endTime < now,
    }))
    .sort((a, b) => (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER))
    .slice(0, 12);
}

export function coursewareTodo(coursewares: TaskCourseware[]): Array<{ title: string; course?: string; progress: number }> {
  return coursewares
    .map((c) => ({ title: c.title, course: c.courseName, progress: c.studyProgress ?? 0 }))
    .sort((a, b) => a.progress - b.progress)
    .slice(0, 12);
}

/* ══════════════════ ④ 意图识别 → 选工具 ══════════════════ */

export type ToolIntent = 'delivery' | 'sign' | 'homework' | 'courseware';

/** 从问题里猜要查什么（关键词，不依赖模型） */
export function detectIntents(question: string): ToolIntent[] {
  const q = question.toLowerCase();
  const out: ToolIntent[] = [];
  if (/外卖|点餐|吃饭|美团|饿了么|花了|花费|开销|金额|多少钱|省钱/.test(q)) out.push('delivery');
  if (/签到|点名|考勤|缺勤|旷课|迟到|早退|请假|到课/.test(q)) out.push('sign');
  if (/作业|交作业|补交|截止|ddl|未交/.test(q)) out.push('homework');
  if (/课件|没看完|进度|视频|学习进度/.test(q)) out.push('courseware');
  return out;
}

/** 从问题里猜"最近几天"（没写就默认 7 天；"全部/总共"→ 0） */
export function detectDays(question: string): number {
  if (/全部|总共|一直以来|所有记录|开学/.test(question)) return 0;
  if (/今天|今日/.test(question)) return 1;
  if (/这周|本周|一周|最近一周|7\s*天/.test(question)) return 7;
  if (/这个月|本月|一个月|30\s*天/.test(question)) return 30;
  const m = /最近\s*(\d+)\s*天/.exec(question);
  if (m) return Number(m[1]);
  return 7;
}

/**
 * 把工具结果拼成给模型的**结构化资料**。
 * ⚠️ 这段会排在 RAG 结果**前面**（数字以它为准）。
 */
export function buildToolContext(input: {
  question: string;
  orders: DeliveryOrder[];
  records: SignDetail[];
  homeworks: TaskHomework[];
  coursewares: TaskCourseware[];
  now?: number;
}): { intents: ToolIntent[]; lines: string[] } {
  const intents = detectIntents(input.question);
  const days = detectDays(input.question);
  const now = input.now ?? Date.now();
  const lines: string[] = [];

  for (const intent of intents) {
    if (intent === 'delivery') {
      const s = deliverySummary(input.orders, days, now);
      const win = days > 0 ? `最近 ${days} 天` : '全部记录';
      lines.push(
        `【统计·外卖】${win}：下单 ${s.count} 次，合计 ${s.totalAmount} 元，平均每单 ${s.avgAmount} 元` +
          (s.cancelled ? `，另有 ${s.cancelled} 单已取消（未计入）` : ''),
      );
      if (s.topStores.length) {
        lines.push(
          `【统计·外卖】花得最多的店：` +
            s.topStores.map((t) => `${t.name}（${t.count} 次 ${t.amount} 元）`).join('、'),
        );
      }
    }

    if (intent === 'sign') {
      const s = signSummary(input.records);
      lines.push(
        `【统计·签到】共 ${s.total} 条记录：已签到 ${s.signed} 次，缺勤 ${s.absent} 次，迟到 ${s.late} 次`,
      );
      if (s.problemByCourse.length) {
        lines.push(
          `【统计·签到】有问题的课程：` +
            s.problemByCourse
              .map((c) => `${c.course}（缺勤 ${c.absent}、迟到 ${c.late}）`)
              .join('；'),
        );
      }
    }

    if (intent === 'homework') {
      const list = homeworkTodo(input.homeworks, now);
      if (!list.length) {
        lines.push('【统计·作业】当前没有未提交的作业。');
      } else {
        lines.push(`【统计·作业】还有 ${list.length} 项未提交：`);
        lines.push(
          list
            .map(
              (h) =>
                `· ${h.title}${h.course ? `（${h.course}）` : ''} 截止 ${fmtDate(h.dueAt)}${
                  h.overdue ? ' ⚠️已逾期' : ''
                }`,
            )
            .join('\n'),
        );
      }
    }

    if (intent === 'courseware') {
      const list = coursewareTodo(input.coursewares);
      if (!list.length) {
        lines.push('【统计·课件】没有未看完的课件。');
      } else {
        lines.push(`【统计·课件】还有 ${list.length} 个没看完：`);
        lines.push(
          list
            .map((c) => `· ${c.title}${c.course ? `（${c.course}）` : ''} 进度 ${c.progress}%`)
            .join('\n'),
        );
      }
    }
  }

  return { intents, lines };
}

/** 给 tab-ai 的"数据概况"用：按天汇总外卖（最近 N 天） */
export function recentDeliveryByDay(orders: DeliveryOrder[], days = 7, now = Date.now()): Array<{ day: string; count: number; amount: number }> {
  const since = now - days * 24 * 3600 * 1000;
  const map = new Map<string, { count: number; amount: number }>();
  for (const o of orders) {
    if (o.at < since) continue;
    if (!COUNTABLE.has(o.stage)) continue;
    const k = dayKey(o.at);
    const cur = map.get(k) ?? { count: 0, amount: 0 };
    cur.count += 1;
    if (typeof o.amount === 'number' && o.amount > 0) cur.amount += o.amount;
    map.set(k, cur);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, v]) => ({ day, ...v }));
}

/* ══════════════════ ⑤ 直接生成答案（不经过模型） ══════════════════ */

/**
 * 用本地统计**直接拼出回答** —— 这类问题不该交给 0.5B 小模型。
 *
 * ══════════════ 为什么（2026-10-30 真机事故）══════════════
 *
 * 用户截图：问「哪门课缺勤最多」，小c 回了 8 遍
 *   「课程「数字逻辑」，缺勤 1 次，但签到 19 次，所以没签到。」
 *
 * 根因：我们把统计资料（含"课程：数字逻辑 已签到 19/20 次"）一起塞给
 * 0.5B 模型，它把两段资料**揉在一起编**，还复读机式重复。
 * 这不是提示词能救的 —— 模型太小。
 *
 * 正确分工：
 *   · 数字类问题 → **本地拼答案**（准确、即时、不依赖网络/模型）
 *   · 模糊类问题（"上周三我在干嘛"）→ 才走 RAG + 模型
 *
 * 返回 `null` 表示"这不是统计类问题，交给模型"。
 */
export function composeLocalAnswer(input: {
  question: string;
  orders: DeliveryOrder[];
  records: SignDetail[];
  homeworks: TaskHomework[];
  coursewares: TaskCourseware[];
  now?: number;
}): string | null {
  const now = input.now ?? Date.now();

  /**
   * ══════════════ ★ 纯工具类问题：本地答，绝不用模型（2026-10-30）══════════════
   *
   * 真机事故：问「现在几点了」，模型拿 RAG 里的一条签到记录（16:27）当"现在"，
   * 还编出「现在应该是 10:27」。
   *
   * 原因很直接：0.5B 模型**不知道当前时间**，我们又没告诉它真正的时钟；
   * 它只能从资料里捡一个时间戳瞎推。
   * 正确做法：时间/日期/星期/能力介绍这类问题，代码直接答。
   */
  const q = input.question;
  if (/现在.*(几点|什么时间|时间)|几点(了|钟)?|当前时间|现在时间/.test(q)) {
    return `现在是 ${fmtDateTime(now)}（手机本地时间）。`;
  }
  if (/(今天|今日).*(星期|周几|礼拜几)|(星期|周几|礼拜几).*(今天|今日)|今天几号|今天.*日期|今天是什么日子/.test(q)) {
    const week = ['日', '一', '二', '三', '四', '五', '六'][new Date(now).getDay()];
    return `今天是 ${fmtDateOnly(now)}，星期${week}。`;
  }
  if (/^(你是谁|你叫什么|你能做什么|你会什么|你能干什么|介绍一下你自己)/.test(q.trim())) {
    return (
      '我是小c，LifeKit 里的私人助手。\n' +
      '能帮你查：外卖花了多少、哪门课缺勤最多、还有哪些作业没交、哪些课件没看完。\n' +
      '这些都是按你手机里的记录直接算的，不编数字。'
    );
  }

  const intents = detectIntents(input.question);
  if (!intents.length) return null;

  const days = detectDays(input.question);
  const parts: string[] = [];

  for (const intent of intents) {
    if (intent === 'delivery') {
      const s = deliverySummary(input.orders, days, now);
      const win = days > 0 ? `最近 ${days} 天` : '全部记录';
      if (!s.count) {
        parts.push(`外卖：${win}没有找到订单记录。`);
        continue;
      }
      parts.push(
        `外卖：${win}下单 ${s.count} 次，合计 ${s.totalAmount} 元，平均每单 ${s.avgAmount} 元。` +
          (s.cancelled ? `另有 ${s.cancelled} 单已取消，未计入。` : ''),
      );
      if (s.topStores.length) {
        parts.push(
          `点得最多的是：` +
            s.topStores.map((t) => `${t.name}（${t.count} 次，${t.amount} 元）`).join('、') +
            '。',
        );
      }
    }

    if (intent === 'sign') {
      const s = signSummary(input.records);
      if (!s.total) {
        parts.push('签到：还没有签到记录（先在优学院页查询一次签到记录）。');
        continue;
      }
      const head = `签到：共 ${s.total} 条记录，已签到 ${s.signed} 次，缺勤 ${s.absent} 次，迟到 ${s.late} 次。`;
      if (s.absent === 0 && s.late === 0) {
        parts.push(`${head} 没有缺勤或迟到记录。`);
      } else if (s.problemByCourse.length) {
        const rows = s.problemByCourse
          .map((c) => {
            const bits: string[] = [];
            if (c.absent) bits.push(`缺勤 ${c.absent} 次`);
            if (c.late) bits.push(`迟到 ${c.late} 次`);
            return `${c.course}（${bits.join('、')}）`;
          })
          .join('；');
        parts.push(`${head} 有问题的课程：${rows}。`);
      } else {
        parts.push(head);
      }
    }

    if (intent === 'homework') {
      const list = homeworkTodo(input.homeworks, now);
      if (!list.length) {
        parts.push('作业：现在没有未提交的作业。');
      } else {
        parts.push(
          `作业：还有 ${list.length} 项没交 —— ` +
            list
              .map(
                (h) =>
                  `${h.title}${h.course ? `（${h.course}）` : ''}，截止 ${fmtDate(h.dueAt)}${
                    h.overdue ? '，已逾期' : ''
                  }`,
              )
              .join('；') +
            '。',
        );
      }
    }

    if (intent === 'courseware') {
      const list = coursewareTodo(input.coursewares);
      if (!list.length) {
        parts.push('课件：没有未看完的课件。');
      } else {
        parts.push(
          `课件：还有 ${list.length} 个没看完 —— ` +
            list.map((c) => `${c.title}（进度 ${c.progress}%）`).join('；') +
            '。',
        );
      }
    }
  }

  if (!parts.length) return null;
  return parts.join('\n\n') + '\n\n（以上是小c 按你手机里的记录直接算的）';
}

/**
 * 判断模型回答是否"复读机"（同一句重复多次）。
 *
 * ══════════════ 为什么需要兜底 ══════════════
 *
 * 0.5B 模型在长资料下会退化成重复输出（用户截图里同一句 8 遍）。
 * 检出后改用本地答案，而不是把这段乱码直接给用户看。
 */
export function looksRepetitive(text: string): boolean {
  const lines = text
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);
  if (lines.length < 3) return false;
  const counts = new Map<string, number>();
  for (const l of lines) counts.set(l, (counts.get(l) ?? 0) + 1);
  for (const n of counts.values()) {
    if (n >= 3) return true;
  }
  return false;
}
