/**
 * 接口探测：为「加减分」和「点不中」找真实接口。
 *
 * ══════════════ 背景 ══════════════
 * 用户要两个新功能：
 *   · 加减分 —— 在选人活动里被点到时，改自己的分数
 *   · 点不中 —— 老师发起选人时必定选不到自己
 *
 * ══════════════ ★★ 2026-10 实测突破（用户从网页 DevTools 抓到的）★★ ══════════════
 *
 * 拿到了 `classroomActivity2` 的完整响应，一次解决三个问题：
 *
 * ① **选人活动与积分就在同一个列表里**：
 *      { "relationType": 4,            ← 4 = 选人活动
 *        "relationId": 148394,
 *        "title": "2026-10-12 11:17 选人",
 *        "joinUserDtos": [ { "name": "刘浩然", "score": 2,
 *                            "userId": 13959853,
 *                            "selectable": true,      ← ★★★ 这就是"点不中"的抓手
 *                            "selectId": null } ] }
 *
 *    → `score` 就是界面上的 "+2"，**加减分就是改它**
 *    → `selectable` 是"可被选中"标志，**点不中就是让它变 false**
 *
 * ② **活动类型码**（`relationType`）：
 *      1=点名  2=投票  4=选人  14=拍照上传
 *    而且点名的 `relationId` **就是 `attendanceID`** ——
 *    和已验证可用的 `signByTea` 是同一套 id 体系，
 *    说明选人/投票/点名共用同一张活动表 → 改分数的接口很可能也在同一命名空间。
 *
 * ③ **响应里没有操作人/修改时间字段** ——
 *    侧面说明这个系统不怎么做操作审计（但这是列表接口，不等于详情接口）。
 *
 * ══════════════ ★★★ 关键教训：主机与前缀都对才行 ★★★ ══════════════
 *
 * 第一版探测**全部 404**，两个错叠在一起：
 *
 *   错 ① **主机用错了**
 *        `signApi` 默认 host 是 `lms.dgut.edu.cn`（`/apps`、`/courseapi` 都在那），
 *        但 `classroomActivity2` 在 **`application.dgut.edu.cn`** 上。
 *   错 ② **少了 `/appapi` 前缀**
 *        从网页 JS 里挖到东软理工专用基址表：
 *          API_HOST     = https://application.dgut.edu.cn/appapi
 *          COURSE_WEB_HOST = https://application.dgut.edu.cn
 *          LMS_HOST     = https://lms.dgut.edu.cn
 *
 *   本机实测确认（不带登录凭据）：
 *      lms.dgut.edu.cn/apps/newAttendance                                     → 401 存在
 *      lms.dgut.edu.cn/courseapi/homeworks/student                            → 401 存在
 *      application.dgut.edu.cn/appapi/classroomapi/classroomActivity2?...     → 401 存在 ★
 *      lms.dgut.edu.cn/classroomapi/classroomActivity2?...                    → 404 不存在
 *      application.dgut.edu.cn/classroomapi/classroomActivity2?...            → 404 不存在
 *
 *   ⚠️ 所以**每个候选都要写清主机 + 前缀**，不能只拼路径。
 *
 * ══════════════ ⚠️⚠️ 安全原则：只探测，不改数据 ══════════════
 *
 * **只用 GET。** POST 探测会**真的加分、真的改 selectable** ——
 * 那是不可逆的副作用，绝不能为了"试试看"去动用户的真实数据。
 *
 * 判断接口存不存在，看 HTTP 状态就够了（405/5xx/带 JSON 的 200 = 存在）。
 * （有测试专门钉这条底线：整个模块里不允许出现任何写请求调用。）
 *
 * ⚠️ 注意上面这个安全原则要**同时**写在注释和测试里 ——
 *    但注释里不能出现那个方法名的字面量，否则会被测试的
 *    `!/\.post\(/` 正则误判成"真的调用了"（这个坑踩过一次）。
 *
 * ══════════════ 已经排除的路（别再走一遍）══════════════
 *
 * ① **从网页版的静态 chunk 里找手机 App 的接口** —— 找不到。
 *    下了 27 个分块共 2.5 MB，搜 `signByTea`（已知能用的接口）
 *    与 `newAttendance`（已知命名空间）都是 **0 次** ——
 *    说明手机 App 的 `/apps/...` 根本不在网页 JS 里。
 *    ⚠️ 但**基址表**很有价值 —— 正是靠它找到 `/appapi` 前缀的。
 * ② **优学院官方帮助文档** —— 只讲功能怎么用，**没有接口**。
 * ③ 只试 `/apps/` 前缀 —— 漏掉了 `/classroomapi/`。
 * ④ 只试 lms 主机 —— 漏掉了 application 主机。
 * ⑤ 只写路径、用一个固定主机去拼 —— 见下面"主机与前缀都对才行"。
 */

/** HttpClient 的最小接口（避免 import 具体类引起循环依赖） */
export interface ProbeHttp {
  get(url: string, opts?: { headers?: Record<string, string> }): Promise<{ status: number; body: string }>;
}

export interface ProbeResult {
  group: string;
  label: string;
  path: string;
  status: number;
  detail: string;
  guess: '看起来存在' | '看起来不存在' | '不确定';
  note?: string;
  /**
   * ★ 小响应的**完整正文**。
   *
   * ══════════════ ⚠️ 这是被上一版坑过的地方 ══════════════
   * 第一版只留 130 字符摘要，结果最要紧的信息被截掉了 ——
   * 比如 classroomActivity2 返回 427 字节，我只看到前 130 个字符，
   * 看不出服务端到底在抱怨什么（缺 token？参数不对？还是别的）。
   *
   * 「显示真实数字而不是散文」是这个项目一贯的做法：
   * 拿不到原始返回，就只能反复猜。
   *
   * 所以：**小于 2KB 的响应存全文**（错误信息都在这个量级），
   * 大响应仍然只留摘要（避免报告太长没法复制）。
   */
  full?: string;
}

/**
 * 分类：HTTP 状态能告诉我们什么。
 *
 * ⚠️ 经验性规则，不是文档规定的 —— 所以措辞用"看起来"，
 *    并且始终带上原始返回，让看的人能推翻我的判断。
 */
/**
 * 判断一个响应"看起来接口存不存在"。
 *
 * ══════════════ ★★★ 这里修过一个会让整个探测失效的 bug ★★★ ══════════════
 *
 * 用户实测报回来的矛盾结果：
 *     ② 目标接口（带 ?classroomId=）  → [看起来存在] HTTP 200
 *     温度计（同一路径不带参数）      → [看起来不存在] HTTP 404
 *     而且两者的**正文都是同一个 427 字节的 404 页面**
 *
 * 根因是原来的判断：
 *     if (status === 200) {
 *       if (/^\s*<(!doctype|html)/i.test(body)) return '不确定';
 *       return '看起来存在';
 *     }
 * 而服务端返回的 HTML 前面带 **BOM（U+FEFF）**：
 *     ï»¿<!doctype html><html lang="en">...HTTP Status 404 – Not Found...
 * `^\s*` **匹配不到 BOM**（BOM 不算空白），于是正则不匹配 →
 * 掉到 `'看起来存在'`。
 *
 * 后果：**凡是带 BOM 的 HTML 错误页，全被判成"接口存在"** ——
 * 那正好是最需要判准的情况。
 *
 * 修法两条：
 *   ① 剥掉 BOM 与一切前导空白/零宽字符再判断
 *   ② 正文里**明写 404** 的，直接算"不存在"（不信状态码，信正文）
 */
function classify(status: number, body: string): ProbeResult['guess'] {
  /**
   * 归一化正文：去掉 BOM、零宽字符、前导空白。
   * ⚠️ `\uFEFF` 要显式写出来 —— `\s` 不包含它（这正是 bug 的根源）。
   */
  const b = String(body ?? '')
    .replace(/^[\uFEFF\u200B-\u200D\s]+/, '')
    .trim();

  /**
   * ★ 正文自述 404 的，一律算不存在。
   *   有些网关把 404 包成 200 返回（用户实测就是这样），
   *    所以**不能只看状态码**。
   */
  if (/HTTP\s*Status\s*404|404\s*[-–]\s*Not\s*Found|status=404/i.test(b)) return '看起来不存在';
  /** 同理：正文自述"没这个接口"（本项目的服务端就这么回） */
  if (/没有这个接口/.test(b)) return '看起来不存在';

  if (status === 0) return '不确定';
  if (status === 404) return '看起来不存在';
  /** 405 = 方法不对（说明路径存在，只是不接受 GET）—— 最强的存在证据 */
  if (status === 405) return '看起来存在';
  if (status === 403 || status === 401) return '看起来存在';
  if (status >= 500) return '看起来存在';
  if (status === 200) {
    /**
     * ⚠️ 很多网关对任意路径都返回 200 + 首页 HTML。
     *    看到 HTML 一律当"不确定"，不要误判成存在。
     *    （BOM 已在上面的归一化里剥掉，这里才判得准）
     */
    if (/^<(!doctype|html|head|body|\?xml)/i.test(b)) return '不确定';
    return '看起来存在';
  }
  return '不确定';
}

/** 从活动列表响应里抠出探测需要的真实 id */
interface Discovered {
  classroomId?: number;
  /** 选人活动的 relationId */
  callActivityId?: number;
  /** 选人活动里某个参与者的 userId */
  callUserId?: number;
  /** 点名活动的 relationId（= attendanceID） */
  attendanceId?: number;
  raw: string;
}

/**
 * 先拉活动列表，把真实 id 抠出来。
 *
 * ⚠️ 为什么非要这一步：拿假 id 去探测，服务端会返回
 *    "参数错误"（500/400），我们就分不清"接口不存在"还是"参数不对"。
 *    用真 id 才能得到干净的结果。
 */
/**
 * ★ 东软理工的接口基址（从网页 JS 里的专用配置段挖出来的）。
 *
 * ⚠️ **两个主机上跑着两套后端**，路径不能混用：
 *    lms.dgut.edu.cn         → /apps/...  /courseapi/...
 *    application.dgut.edu.cn → /appapi/classroomapi/...  （★ 选人与积分在这）
 *
 * 实测证据（不带登录凭据）：
 *    lms/apps/newAttendance                                  → 401 存在
 *    application/appapi/classroomapi/classroomActivity2?...  → 401 存在 ★
 *    lms/classroomapi/classroomActivity2?...                 → 404 不存在
 */
/**
 * ⚠️ `app` 主机现在**不再使用** —— 保留它只为留档。
 *
 * 曾经以为智慧课堂接口在 `application.dgut.edu.cn/appapi` 下，
 * 实测（2026-10）证明那是**错的**：
 *   · `smartclassroom.dgut.edu.cn` / `appapi.dgut.edu.cn` 等子域
 *     返回的都是前端页面（SPA catch-all），不是接口
 *   · 真实接口在 **`lms.dgut.edu.cn/apps/...`**（和签到同一个网关）
 *
 * 所以候选清单现在只用 `lms`。这个字段留着是为了让后来者知道
 * "我们试过 application 主机，那条路是死的"，不必再走一遍。
 */
/**
 * ★ 优学院的接口主机（2026-10 由 Reqable 抓包**实测确认**）。
 *
 * ══════════════ 真实请求原文（用户 Reqable 抓到）══════════════
 *
 *   Host: **aijx.dgut.edu.cn**
 *   GET  https://aijx.dgut.edu.cn/apps/selectperson/getDetail
 *          ?userId=90990001&id=148394&**roleId=9**
 *   SNI:  **lms.dgut.edu.cn**        ← 注意 SNI 与 Host 不同
 *   响应: 200 · 服务器 27.39.220.17
 *
 * ══════════════ 三条结论 ══════════════
 *
 *   ① **`/apps/...` 前缀是对的**（这条我后来验证对了）
 *      SNI 是 `lms` 而 Host 是 `aijx`，两者**指向同一个 IP** ——
 *      说明前端把请求发到 lms 那套后端，只是 Host 头写了 aijx。
 *      本机实测 `lms.dgut.edu.cn/apps/selectperson/giveMark` 返回 **405**（存在），
 *      所以用 `lms` + `/apps` 打是可行的。
 *
 *   ② ★★★ **`roleId=9` 是学生角色**
 *      我模板里先用的是 `1` —— **猜错了**。角色不对会拿到偏差的数据
 *      （比如 `students` 里出现别人、`selectPersonCount` 为 0）。
 *
 *   ③ 这些子域解析到**同一个 IP**，靠 **Host 头**分流到不同后端。
 *      所以"同一条路径挂不同主机"是有意义的对照。
 */
export const YX_HOSTS = {
  /** ★ 实测可用的接口主机（`/apps/selectperson/*`、`/apps/classscore/*`） */
  lms: 'https://lms.dgut.edu.cn',
  /** Reqable 抓到的 Host（同 IP，前端也用它）—— 留档对照 */
  aijx: 'https://aijx.dgut.edu.cn',
  /** ⚠️ 已证伪（SPA 页面主机，不是接口）—— 仅留档 */
  app: 'https://application.dgut.edu.cn',
} as const;

/**
 * ★ 学生角色 id（Reqable 实测：`roleId=9`）。
 *
 * ⚠️ 猜成 1 会拿到偏差数据 —— 这个值必须用实测的。
 */
export const ROLE_ID_STUDENT = 9;

/**
 * 先拉活动列表，把真实 id 抠出来。
 *
 * ⚠️ 用的路径是**从优学院前端代码里挖出来的真实路径**：
 *    `/wisdomClassroom/student/classroomActivitys?classroomId=…`
 *  之前写的 `/appapi/classroomapi/classroomActivity2` **是我猜的，不存在**。
 *
 * 为什么非要先拉列表：拿假 id 去探测，服务端回"参数错误"（500/400），
 * 就分不清"接口不存在"还是"参数不对"。用真 id 才能得到干净的结果。
 */
async function discover(
  http: ProbeHttp,
  headers: Record<string, string>,
  classroomId: number,
): Promise<Discovered> {
  const out: Discovered = { raw: '' };
  const url =
    `${YX_HOSTS.lms}/apps/wisdomClassroom/student/classroomActivitys` +
    `?classroomId=${classroomId}&pageSize=999&pageNum=1&type=1&_t=${Date.now()}`;
  try {
    const res = await http.get(url, { headers });
    out.raw = String(res.body ?? '');
    const j = JSON.parse(out.raw) as {
      result?: {
        list?: Array<{
          relationType?: number;
          relationId?: number;
          joinUserDtos?: Array<{ userId?: number; score?: number; selectable?: boolean }>;
        }>;
      };
    };
    out.classroomId = classroomId;
    for (const it of j.result?.list ?? []) {
      if (it.relationType === 4 && it.relationId) {
        out.callActivityId = it.relationId;
        const u = it.joinUserDtos?.[0];
        if (u?.userId) out.callUserId = u.userId;
      }
      if (it.relationType === 1 && it.relationId) out.attendanceId = it.relationId;
    }
  } catch {
    /* 解析失败就把 raw 留着，调用方能看到 */
  }
  return out;
}

export async function probeYouxueActivityApi(
  http: ProbeHttp,
  headers: Record<string, string>,
  ctx: {
    /** 不传就默认拿一个已知的课堂（用户实测的那个） */
    classroomId?: number;
    classID?: number;
    userId: number;
  },
): Promise<ProbeResult[]> {
  /** ★ 用户抓包时用的课堂（概率论与数理统计，2026-10-12） */
  const DEFAULT_CLASSROOM = 443969;
  const classroomId = ctx.classroomId ?? DEFAULT_CLASSROOM;

  const out: ProbeResult[] = [];

  /**
   * ★★ 第 1 步：打一个**确定能用**的接口当"绝对基准"。
   *
   * ══════════════ 为什么它必须排在最前 ══════════════
   * 上一版的两个"温度计"（/apps/newAttendance、/courseapi/...）都返回了
   * 意外状态码，我就没法判断"到底是探测工具错了，还是会话/主机错了"。
   *
   * 这个接口是从本机实测确认过的：
   *   lms.dgut.edu.cn/apps/user/getUserByUserID/<真实userId>  → 200 + 真实用户 JSON
   * 它用**真实 userId**，而且本来就是 GET —— 所以：
   *   · 它返回 200 → 会话/主机/前缀这一整套都对，后面任何反常都能归因到路径
   *   · 它不是 200 → 问题在会话或主机，别管后面的路径了，先解决这个
   */
  const baselineUrl = `${YX_HOSTS.lms}/apps/user/getUserByUserID/${ctx.userId}`;
  try {
    const res = await http.get(baselineUrl, { headers });
    const body = String(res.body ?? '');
    out.push({
      group: '① 绝对基准（必看）',
      label: 'lms /apps/user/getUserByUserID/<你的 userId>',
      path: `/apps/user/getUserByUserID/${ctx.userId}`,
      status: res.status,
      detail: body.replace(/\s+/g, ' ').slice(0, 130) || '(空)',
      guess: classify(res.status, body),
      note:
        '★★ 这个接口本该返回 200 + 你的用户信息（本机实测过）。' +
        '如果它**不是 200**，说明问题在会话或主机，不在接口路径 —— 先解决它。',
      full: body && body.length <= 2048 ? body.replace(/\s+/g, ' ').trim() : undefined,
    });
  } catch (e) {
    out.push({
      group: '① 绝对基准（必看）',
      label: 'lms /apps/user/getUserByUserID/<你的 userId>',
      path: `/apps/user/getUserByUserID/${ctx.userId}`,
      status: 0,
      detail: `请求异常：${(e as Error).message}`,
      guess: '不确定',
      note: '连请求都发不出去 —— 网络或主机解析问题',
    });
  }

  const d = await discover(http, headers, classroomId);
  const callId = d.callActivityId ?? 0;
  const targetUser = d.callUserId ?? ctx.userId;
  const attId = d.attendanceId ?? 0;

  /**
   * 把"发现到的 id"报出来 —— 一眼看出探测有没有拿到真数据。
   *
   * ⚠️ 路径与标签都用**真实路径**（`/wisdomClassroom/student/classroomActivitys`）。
   *    这里原来还写着 `/appapi/classroomapi/classroomActivity2` ——
   *    那是我猜的路径，实测不存在，留着会误导。
   */
  out.push({
    group: '② 活动列表（真实路径）',
    label: 'student/classroomActivitys 响应',
    path: `/wisdomClassroom/student/classroomActivitys?classroomId=${classroomId}`,
    status: d.raw ? 200 : 0,
    detail: d.raw
      ? `classroomId=${classroomId} 选人活动id=${callId || '未找到'} 点名id=${attId || '未找到'} ` +
        `被选中的人userId=${d.callUserId ?? '未找到'} · 响应${d.raw.length}字节`
      : '(取不到活动列表 —— 可能是 classroomId 不对、未登录、或路径又变了)',
    /**
     * ⚠️ 用**正文**判断（`classify` 已经会识别"正文自述 404"），
     *    不能只看长度 —— 427 字节的 404 页面也可能很长。
     */
    guess: d.raw ? classify(200, d.raw) : '不确定',
    note:
      '★ 温度计：这个接口已确认可用（application 主机 + /appapi 前缀）。' +
      '如果它拿不到真数据，后面的结果都不可信 —— 先解决它。',
    /** ★ 完整正文：427 字节那种正好是错误信息，摘要会把它截掉（踩过） */
    full: d.raw && d.raw.length <= 2048 ? d.raw.replace(/\s+/g, ' ').trim() : undefined,
  });

  /**
   * 参数：真 id 优先，没有就退化成 0。
   * ⚠️ 用 0 的结果只能参考 —— 分不清"接口不存在"和"参数不对"。
   */
  const q = (extra: Record<string, unknown> = {}) =>
    new URLSearchParams(
      Object.entries({
        classroomId,
        ocId: ctx.classID ?? '',
        classId: ctx.classID ?? '',
        id: callId,
        activityId: callId,
        relationId: callId,
        attendanceID: attId,
        attanceID: attId,
        userID: targetUser,
        userId: targetUser,
        pn: 1,
        ps: 20,
        ...extra,
      }).map(([k, v]) => [k, String(v)]),
    ).toString();

  /**
   * ══════════════ ★★★ 真实接口已确认（2026-10 本机实测）══════════════
   *
   * 之前猜了 3 轮（32 个 + 20 个候选路径）**全 404**。根因有两个：
   *
   *   ① 少了 `/apps` 前缀
   *      真实基址是 `lms.dgut.edu.cn` 下的 `apps` 段（和签到用的
   *      `/apps/newAttendance` 同一个网关），
   *      而我一直往 `/selectperson/...`（无前缀）打 → nginx 404。
   *
   *      ⚠️ 写这段注释时踩了一次坑：本来想强调 apps 这一段，
   *         写成了带星号的写法，结果里面的「星号+斜杠」**提前结束了块注释**，
   *         导致后面几十行普通文字被当成代码，报 44 个语法错误。
   *         块注释里**绝不能出现「星号紧跟斜杠」**。
   *
   *   ② 主机也猜错过
   *      `smartclassroom.dgut.edu.cn` / `appapi.dgut.edu.cn` 等子域
   *      返回的都是前端页面（SPA catch-all），**不是接口**。
   *
   * 本机实测（不带登录凭据，只看 HTTP 码就能判断存在与否）：
   *
   *   HTTP 401  /apps/selectperson/getRandomPersons      ← 401=缺 token，路径存在
   *   HTTP 401  /apps/selectperson/getDetail
   *   HTTP 401  /apps/selectperson/randomChoosePerson
   *   HTTP 401  /apps/selectperson/appointChoosePerson
   *   HTTP 405  /apps/selectperson/giveMark              ← ★★★ 加减分（405=要 POST）
   *   HTTP 405  /apps/selectperson/saveSelectedPerson    ← ★★ 点不中
   *   HTTP 405  /apps/selectperson/deleteSelectedPerson  ← ★★ 点不中
   *   HTTP 405  /apps/selectperson/updateSelectRange     ← ★★ 改抽选范围
   *   HTTP 401  /apps/classscore/markByStudent
   *   HTTP 405  /apps/classscore/markByTeacher
   *   HTTP 401  /apps/wisdomClassroom/student/classroomActivitys
   *
   * ⚠️ **401 = GET 接口（缺 token）**，**405 = POST 接口（GET 不被接受）** ——
   *    这个区分本身就告诉我们该用什么方法，非常有价值。
   *
   * ⚠️ 而探测工具**只用 GET**（安全原则：POST 会真的加分/真的改选中）。
   *    所以对 POST 接口，看到 **405 就是"找到了"** —— 这已经足够了。
   *
   * 前端代码里的参数结构（从 src-async chunk 挖出来的）：
   *   GET    /selectperson/getDetail?userId=&id=&roleId=
   *   GET    /selectperson/getRandomPersons?userId=&id=[&selectType=]&randomCount=
   *   GET    /selectperson/randomChoosePerson?userId=&id=[&selectType=]
   *   GET    /selectperson/appointChoosePerson?pn=&ps=&order=&keyword=&classId=&userId=&id=
   *   POST   /selectperson/giveMark                     body = 对象
   *   POST   /selectperson/saveSelectedPerson?userIds=&id=
   *   DELETE /selectperson/deleteSelectedPerson?userId=&id=      ← 注意是 DELETE
   *   DELETE /selectperson/deleteSelectedPersonActivity?userId=&id=&roleId=
   *   POST   /selectperson/updateSelectRange?id=&selectType=
   */
  type Cand = { group: string; label: string; url: string; path: string; note?: string };

  /** lms 主机（`/apps`、`/courseapi` 都在这台 —— 真实接口在 /apps 下） */
  const L = (group: string, label: string, path: string, note?: string): Cand => ({
    group,
    label,
    url: `${YX_HOSTS.lms}${path}`,
    path,
    note,
  });

  const candidates: Cand[] = [
    // ── 温度计：已知可用的接口（验证探测本身有效）──
    L('温度计', 'lms /apps/newAttendance', '/apps/newAttendance', '★★ 应 401（缺 token）—— 签到 signByTea 就在这'),
    L('温度计', 'lms /apps/user/getUserByUserID/<我>', `/apps/user/getUserByUserID`, '★★ 应 200 + 用户信息'),
    L('温度计', 'lms /courseapi 作业接口', '/courseapi/homeworks/student', '★ 应 401'),

    // ── ① 加减分：giveMark ──
    L('① 加减分', 'selectperson 给分 giveMark', '/apps/selectperson/giveMark', '★★★ 405 = 存在（要 POST）'),
    L('① 加减分', 'classscore 学生打分 markByStudent', '/apps/classscore/markByStudent', '★★ 401 = 存在（GET）'),
    L('① 加减分', 'classscore 教师打分 markByTeacher', '/apps/classscore/markByTeacher', '★★ 405 = 存在'),
    L('① 加减分', 'classscore 保存打分结果', '/apps/classscore/saveMarkResult', '★ 405 = 存在'),
    L('① 加减分', 'classphoto 给分（另一处）', '/apps/classphoto/giveMark', '★ 405 = 存在'),
    L('① 加减分', '选人详情（含 score 字段）', '/apps/selectperson/getDetail', '★★ 401 = 存在；要 userId/id/roleId'),

    // ── ② 点不中 ──
    L('② 点不中', '改抽选范围 updateSelectRange', '/apps/selectperson/updateSelectRange', '★★★ 405 = 存在（要 POST）'),
    L('② 点不中', '删掉已选中的人 deleteSelectedPerson', '/apps/selectperson/deleteSelectedPerson', '★★★ 405 = 存在（注意是 DELETE）'),
    L('② 点不中', '删掉整个选人活动', '/apps/selectperson/deleteSelectedPersonActivity', '★ 405 = 存在'),
    L('② 点不中', '保存被选中的人 saveSelectedPerson', '/apps/selectperson/saveSelectedPerson', '★★ 405 = 存在'),
    L('② 点不中', '随机抽人 getRandomPersons', '/apps/selectperson/getRandomPersons', '★★ 401 = 存在（GET）'),
    L('② 点不中', '随机抽人(旧) randomChoosePerson', '/apps/selectperson/randomChoosePerson', '★ 401 = 存在'),
    L('② 点不中', '指定抽人 appointChoosePerson', '/apps/selectperson/appointChoosePerson', '★ 401 = 存在'),
    L('② 点不中', '重新开放活动 openAgainActivity', '/apps/selectperson/openAgainActivity', '★ 401 = 存在'),

    // ── ③ 活动列表（读接口，用来拿 activityId）──
    L('③ 活动列表', '学生端活动列表', '/apps/wisdomClassroom/student/classroomActivitys', '★★ 401 = 存在；classroomId=443969'),
    L('③ 活动列表', '教师端活动列表', '/apps/wisdomClassroom/getClassroomActivitys', '★ 401 = 存在'),
    L('③ 活动列表', '学生分数', '/apps/wisdomClassroom/getStudentScoreForClassroom', '★ 401 = 存在'),

    // ── ④ 反面对照（判断规则本身的对照物）──
    L('④ 反面对照', '少 /apps 前缀（已知 404）', '/selectperson/getRandomPersons', '★ 必须是"不存在"'),
    L('④ 反面对照', '完全不存在的路径', '/this-path-should-not-exist-404', '★ 必须是"不存在"'),
  ];

  for (const c of candidates) {
    let status = 0;
    let detail = '';
    let full: string | undefined;
    try {
      /**
       * ⚠️ 用 `c.url` 而不是 `host + c.path` ——
       *    每个候选自带主机（lms 或 application），
       *    这是这一版最重要的修正：第一版用单一主机，结果全 404。
       */
      const res = await http.get(`${c.url}?${q()}`, { headers });
      status = res.status;
      const body = String(res.body ?? '');
      detail = body.replace(/\s+/g, ' ').slice(0, 130);
      /**
       * ★ 小于 2KB 的响应存**全文** ——
       *   错误信息（"缺少访问token"、"参数错误"、Tomcat/Spring 错误页）
       *   都在这个量级，摘要会把关键内容截掉（踩过）。
       */
      if (body && body.length <= 2048) full = body.replace(/\s+/g, ' ').trim();
    } catch (e) {
      detail = `请求异常：${(e as Error).message}`;
    }
    out.push({
      group: c.group,
      label: c.label,
      path: c.path,
      status,
      detail: detail || '(空)',
      guess: classify(status, detail),
      note: c.note,
      full,
    });
  }

  return out;
}

/**
 * 把探测结果整理成可复制的文本。
 *
 * ⚠️ 必须"可复制"：这个结果要发给我，手机上转述三十行不现实。
 *
 * ══════════════ ★ compact 模式（用户反馈"不能全部复制，太多了"）══════════════
 *
 * 完整报告有几十条，每条还带正文，手机上根本选不全、也发不动。
 * 所以加两种模式：
 *
 *   compact = true（默认，界面上的「复制结果」用这个）
 *     · **只留有用的**：「看起来存在」「不确定」、以及**反面对照**那两条
 *     · 404 的候选**折叠成一行汇总**（"另有 N 条 404 已省略"）
 *     · 不附完整正文
 *     → 从几十条压到几条，能一键复制
 *
 *   compact = false（「复制全部（详细）」用这个）
 *     · 全部条目 + 完整正文（排查细节时才需要）
 *
 * ⚠️ 反面对照**必须保留**，哪怕它是不存在 ——
 *    它是"判断规则有没有坏"的对照物（BOM bug 就是靠它发现的）。
 */
export function formatProbeReport(results: ProbeResult[], compact = true): string {
  const lines: string[] = ['LifeKit 接口探测结果', new Date().toLocaleString('zh-CN'), ''];
  /** 被折叠的 404 条目（紧凑模式下汇总成一行） */
  const skipped: ProbeResult[] = [];

  let lastGroup = '';
  for (const r of results) {
    const isControl = r.group.includes('反面对照');
    const interesting = r.guess !== '看起来不存在' || isControl;

    if (compact && !interesting) {
      skipped.push(r);
      continue;
    }

    if (r.group !== lastGroup) {
      lines.push(`── ${r.group} ──`);
      lastGroup = r.group;
    }
    lines.push(`[${r.guess}] HTTP ${r.status}  ${r.path}`);
    if (r.note) lines.push(`        ${r.note}`);
    lines.push(`        ${r.detail}`);
    /**
     * ★ 小响应的完整正文 —— 上一版截断到 130 字符，
     *   结果最要紧的错误内容看不见（踩过）。
     *   有 full 时把它整段打出来。
     * ⚠️ 紧凑模式不打正文（那正是"太长"的来源）。
     */
    if (!compact && r.full && r.full !== r.detail) {
      lines.push(`        ── 完整返回（${r.full.length} 字节）──`);
      lines.push(`        ${r.full}`);
    }
  }

  if (compact && skipped.length) {
    lines.push('');
    lines.push(`（另有 ${skipped.length} 条 404 已省略：${skipped.map((s) => s.path).slice(0, 12).join('、')}${skipped.length > 12 ? '…' : ''}）`);
  }
  if (compact) {
    lines.push('');
    lines.push('提示：这条是精简版。要看每条完整正文，用「复制全部（详细）」。');
  }
  return lines.join('\n');
}
