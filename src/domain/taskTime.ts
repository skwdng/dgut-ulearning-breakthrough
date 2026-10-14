/**
 * 任务的时间口径 —— 供「最近 / 全部」筛选用。
 *
 * ══════════════ 需求原话 ══════════════
 * 「任务板块未完成任务分为最近和全部，最近包括近三个月来的任务，
 *   全部就是所有的，只需要给未完成任务加」
 *
 * 所以：**只对未完成的任务分类**，已提交那份不加筛选。
 *
 * ══════════════ 每种任务用哪个时间 ══════════════
 *
 * 作业：优先用**截止时间**（`endTime`）—— 那才是"这事跟我还有没有关系"的判据。
 *       没有截止时间就用开始时间（`startTime`）。
 *
 * 课件：用**创建/发布时间**（`createTime`）。
 *       ⚠️ 这个字段原先归一化时被漏掉了（原始响应里是有的），
 *          所以这里特意标注：如果某条课件取不到时间，
 *          我们**不能**据此说它"旧" —— 只能当作"不确定"。
 *
 * ══════════════ 取不到时间怎么办 ══════════════
 * 当作"算在最近里"（**宽松**），不能当作旧的排除掉。
 * 理由：这个筛选是为了"别让我漏掉该做的事"，
 *       误排除会让用户以为没事，误纳入只是多显示一条 —— 后者安全得多。
 */

/** 近三个月的毫秒数（按 92 天算，比自然月宽松一点，宁可多显示） */
export const RECENT_WINDOW_MS = 92 * 24 * 60 * 60 * 1000;

/** 作业的时间口径：截止优先，其次开始 */
export function homeworkTime(h: { endTime?: number; startTime?: number }): number | undefined {
  const t = h.endTime ?? h.startTime;
  return typeof t === 'number' && t > 0 ? t : undefined;
}

/** 课件的时间口径：创建/发布时间 */
export function coursewareTime(c: { createTime?: number }): number | undefined {
  const t = c.createTime;
  return typeof t === 'number' && t > 0 ? t : undefined;
}

/**
 * 这条任务算不算"最近的"。
 *
 * ⚠️ 两个方向都要照顾到：
 *   · **未来**的截止时间（还没到期）→ 一定算最近（显然还要做）
 *   · 取不到时间 → 算最近（宽松，见文件头注释）
 *   · 超过三个月 → 不算最近（它会出现在「全部」里，不会丢）
 */
export function isRecentTask(ts: number | undefined, now = Date.now()): boolean {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return true; // 取不到时间 → 宽松
  if (ts > now) return true; // 还没到期 → 当然要做
  return now - ts <= RECENT_WINDOW_MS;
}

/** 便于界面显示：把窗口讲成人话 */
export const RECENT_WINDOW_LABEL = '近三个月';
