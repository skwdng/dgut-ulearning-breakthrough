/**
 * 外卖通知解析引擎。
 *
 * 现实：各家外卖 App 的通知文案不统一、经常改版，所以这里采用"**尽力解析 + 允许纠错**"策略：
 * - 只从通知里抽 4 件事：平台（包名给）、店铺名、金额、订单阶段
 * - 店铺名用"去前缀 + 去尾部状态"的启发式，而不是硬匹配模板
 * - 解析不确定时宁可不记（避免污染统计），交给用户手动补录
 *
 * 所有规则都有对应测试用例（tools/verify-delivery.cjs）。
 */

import { STAGE_RANK, type DeliveryPlatform, type DeliveryStage } from '../../domain/delivery';

export interface ParsedNotification {
  platform: DeliveryPlatform;
  pkg: string;
  storeName: string;
  amount?: number;
  stage: DeliveryStage;
  /** 置信度：high 才自动入库，low 交给用户确认 */
  confidence: 'high' | 'low';
  reason?: string;
}

/** 包名 → 平台 */
const PKG_MAP: Array<[RegExp, DeliveryPlatform]> = [
  [/com\.sankuai\.meituan/, 'meituan'],
  [/me\.ele/, 'eleme'],
  [/com\.jingdong|com\.jd\./, 'jd'],
  [/com\.ss\.android\.ugc\.aweme/, 'douyin'],
];

/** 明确要忽略的通知（营销/优惠券/会员，不是订单） */
const IGNORE_PATTERNS: RegExp[] = [
  /优惠券|红包|满减|立减|折扣|特价|限时|秒杀|领券|神券|补贴|活动/,
  /会员|续费|开通|积分|签到|抽奖|邀请|助力/,
  /版本更新|更新提示|隐私政策|用户协议/,
  /评价|晒单|打分|求好评/,
];

/** 店铺名前后要剥掉的前缀 */
const STORE_PREFIXES: RegExp[] = [
  /^(您的|你的)?订单/,
  /^您有一笔(新)?订单/,
  /^(您|你)(有|收到)?(一笔)?新订单/,
  /^(您|你)的订单/,
  /^新订单/,
  /^订单通知/,
  /^外卖订单/,
];

/** 店铺名尾部要剥掉的状态词 */
const STORE_SUFFIXES: RegExp[] = [
  /(已|正在)?(接单|派送|配送|送达|完成|确认|出餐|备餐|取餐|打包|发货|取消|退款)/,
  /(商家|骑手|店铺|门店)(已|正在)?/,
  /待(支付|付款|接单|配送|收货)/,
  /请(尽快|及时)?(支付|付款|查看|评价|确认)/,
  /预计.{0,12}(送达|到达|分钟)/,
  /距离.{0,10}(公里|km|米|m)/,
  /点击.{0,10}(查看|详情|了解)/,
  /[·•|｜\-—]{1,}.*$/,
  /[，,。.！!；;：:].*$/,
  /\s+(?:正在|已|预计|距离|中|订单).*$/,
  /\s+\d+\s*(?:元|分钟|km|公里|米|m)?.*$/,
];

/**
 * 纯状态词/功能词 —— 如果剥离后剩下的"店名"全是这些，说明这个候选不是店名。
 * 这是防止"订单已提交"这类标题污染店铺统计的关键校验。
 */
const STATUS_ONLY_RE =
  /^[\s的是有已正在中将请尽快及时支付付款下单提交接单派送配送送达完成确认取消退款商家骑手订单通知新您你]+$/;

/** 状态词黑名单（用于最终校验：店名里不能只包含这些） */
const STATUS_WORDS = /(已提交|已下单|已支付|已接单|配送中|已送达|已完成|已取消|待支付|待付款|正在配送|订单|骑手|商家已|请尽快|请及时)/;

/** 订单阶段识别（按优先级） */
const STAGE_RULES: Array<[RegExp, DeliveryStage]> = [
  [/已取消|订单取消|取消订单/, 'cancelled'],
  [/退款|已退款/, 'cancelled'],
  [/已送达|已完成|已收货|订单完成|感谢使用|欢迎再次/, 'done'],
  [/配送中|骑手|正在配送|已取餐|即将送达|预计.{0,10}送达|正在为您派送|派送中/, 'delivering'],
  [
    /已支付|支付成功|付款成功|下单成功|已下单|订单已提交|已提交|新订单|商家已接单|已接单|等待配送|等待商家|订单提交/,
    'paid',
  ],
  [/待支付|请支付|待付款|未支付|请尽快付款/, 'created'],
];

/** 金额 */
const AMOUNT_RE = /(?:¥|￥|实付|支付|合计|金额|共)\s*(\d+(?:\.\d{1,2})?)\s*元?/;

function detectPlatform(pkg: string): DeliveryPlatform | null {
  for (const [re, p] of PKG_MAP) {
    if (re.test(pkg)) return p;
  }
  return null;
}

function detectStage(text: string): DeliveryStage {
  for (const [re, stage] of STAGE_RULES) {
    if (re.test(text)) return stage;
  }
  return 'unknown';
}

function extractAmount(text: string): number | undefined {
  const m = AMOUNT_RE.exec(text);
  if (!m) return undefined;
  const v = Number(m[1]);
  return Number.isFinite(v) && v > 0 && v < 100000 ? v : undefined;
}

/**
 * 从"标题 + 正文"里抽出店铺名。
 * 策略：优先取标题（外卖 App 通常标题就是店铺名或含店铺名），
 *       用前缀/后缀规则剥离状态描述，剩下最短且不含状态词的那段作为店名。
 */
function extractStoreName(title: string, text: string, platform: DeliveryPlatform): string | undefined {
  const candidates: string[] = [];

  // 正文优先：正文里的店名通常带「(门店)」或更长，信息量比标题大；
  // 标题经常只是状态语（"订单已提交"），放后面兜底。
  const segs = (text || '')
    .split(/[，,。.；;：:\n｜|]/)
    .map((s) => s.trim())
    .filter(Boolean);
  // 优先选带括号的段（"麦当劳(松山湖店)"），其次按原顺序
  const withParen = segs.filter((s) => /[（(][^）)]{1,20}[）)]/.test(s));
  candidates.push(...withParen);
  for (const s of segs) if (!withParen.includes(s)) candidates.push(s);

  // 标题兜底（去掉平台自报名）
  let t = (title || '').trim();
  t = t.replace(/^(美团外卖|美团|饿了么|京东秒送|京东外卖|抖音外卖|抖音)[:：\s-]*/, '');
  if (t) candidates.push(t);

  // 正文与标题拼整体，也试一次
  candidates.push(`${text} ${title}`.trim());

  for (const raw of candidates) {
    let s = raw;
    // 剥前缀（可能叠加，循环几次）
    for (let i = 0; i < 3; i += 1) {
      let changed = false;
      for (const re of STORE_PREFIXES) {
        const next = s.replace(re, '').trim();
        if (next !== s) {
          s = next;
          changed = true;
        }
      }
      if (!changed) break;
    }
    // 剥后缀
    for (const re of STORE_SUFFIXES) {
      s = s.replace(re, '').trim();
    }
    s = s.replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '').trim();

    // ---------- 有效性校验（这里是防"状态词污染"的关键） ----------
    if (s.length < 2 || s.length > 30) continue;
    if (IGNORE_PATTERNS.some((re) => re.test(s))) continue;
    if (/^\d+$/.test(s)) continue; // 纯数字
    if (STATUS_ONLY_RE.test(s)) continue; // 全是状态/功能词
    if (STATUS_WORDS.test(s) && s.length <= 6) continue; // 短且含状态词
    if (/(订单|骑手|配送|支付|送达|取消|退款)/.test(s) && s.length <= 4) continue;

    return s;
  }
  return undefined;
}

/**
 * 主入口：解析一条通知。
 * 返回 null 表示"这不是一条外卖订单通知"，应当忽略。
 */
export function parseDeliveryNotification(input: {
  pkg: string;
  title: string;
  text: string;
}): ParsedNotification | null {
  const platform = detectPlatform(input.pkg);
  if (!platform) return null;

  const title = input.title ?? '';
  const text = input.text ?? '';
  const all = `${title} ${text}`.trim();
  if (!all) return null;

  // 营销类直接忽略
  if (IGNORE_PATTERNS.some((re) => re.test(all))) {
    return null;
  }

  const stage = detectStage(all);
  const storeName = extractStoreName(title, text, platform);
  const amount = extractAmount(all);

  // 没有店名 → 无法用于统计
  if (!storeName) {
    return { platform, pkg: input.pkg, storeName: '', stage, amount, confidence: 'low', reason: 'no_store_name' };
  }

  // 取消的订单不计数（但保留 stage 供 UI 展示）
  const confidence: 'high' | 'low' = stage === 'unknown' && !amount ? 'low' : 'high';

  return { platform, pkg: input.pkg, storeName, amount, stage, confidence, reason: confidence === 'low' ? 'no_stage_no_amount' : undefined };
}

/**
 * 去重指纹。
 * 同一订单常会连发多条通知（已下单 → 已接单 → 配送中），必须归并成一条记录。
 * 策略：平台 + 店铺 + 时间窗（默认 30 分钟）视为同一订单。
 */
export function fingerprint(platform: DeliveryPlatform, storeName: string, at: number, windowMs = 30 * 60 * 1000): string {
  const bucket = Math.floor(at / windowMs);
  return `${platform}|${storeName.toLowerCase().replace(/\s+/g, '')}|${bucket}`;
}

// ══════════════════ 剪贴板识别 ══════════════════

/** 文字线索 → 平台（剪贴板里没有包名，只能靠内容判断） */
const TEXT_PLATFORM_HINTS: Array<[RegExp, DeliveryPlatform]> = [
  [/美团|meituan|小美|袋鼠/iu, 'meituan'],
  [/饿了么|eleme|饿了吗|蓝骑士|蜂鸟/iu, 'eleme'],
  [/京东|京东外卖|达达|秒送/iu, 'jd'],
  [/抖音|字节|抖音外卖|DOUYIN/iu, 'douyin'],
];

const TEXT_PKG: Record<DeliveryPlatform, string> = {
  meituan: 'com.sankuai.meituan',
  eleme: 'me.me.ele',
  jd: 'com.jingdong.app.mall',
  douyin: 'com.ss.android.ugc.aweme',
  other: 'unknown.clipboard',
};

/** 从一段文字里猜平台；猜不到返回 'other' */
export function detectPlatformFromText(text: string): DeliveryPlatform {
  const s = text ?? '';
  for (const [re, p] of TEXT_PLATFORM_HINTS) {
    if (re.test(s)) return p;
  }
  return 'other';
}

/**
 * 解析**从外卖 App 复制出来的订单文本**。
 *
 * ══════════ 为什么需要这条路径 ══════════
 * ① iOS 上**永远做不到**读通知（苹果不允许第三方 App 读别的 App 的通知），
 *    所以 iOS 只能靠"复制订单文本 → 粘贴识别"。
 * ② Android 上也有用：通知没抓到、或用户事后才想记一笔时，
 *    手动一个个填店名和金额很烦，粘贴一下自动带出来。
 *
 * ⚠️ 与通知解析的区别：这里**没有包名**，平台只能从文字里猜；
 *    而且"复制出来的文本"格式比通知更杂（可能整屏订单详情）。
 *    所以：
 *      · 猜不到平台 → 用 'other'，但**仍然尝试抽店名和金额**（不与通知路径不同）
 *      · 营销词过滤**不适用**（订单详情页里常有"优惠券"字样，那是正常订单）
 *      · 结果一律交界面**让用户确认/修改**，不直接入库
 */
export function parseClipboardOrder(raw: string): ParsedNotification {
  const text = (raw ?? '').replace(/\r/g, '').trim();
  const platform = detectPlatformFromText(text);
  const pkg = TEXT_PKG[platform];

  // ⚠️ 这里**不做** IGNORE_PATTERNS 过滤 ——
  //    订单详情页里出现"优惠券/满减"是正常的，过滤掉会把真订单也丢掉。
  const stage = detectStage(text);
  // extractStoreName 可能返回 undefined（抽不到店名），统一成空串
  const storeName = extractStoreName(text, '', platform) ?? '';
  const amount = extractAmount(text);

  const confidence: 'high' | 'low' = storeName && (stage !== 'unknown' || amount) ? 'high' : 'low';

  return {
    platform,
    pkg,
    storeName,
    amount,
    stage,
    confidence,
    reason: storeName ? undefined : 'no_store_name',
  };
}


/** 合并同一订单的多条通知（保留最靠后的阶段，金额取有值的那个） */
export function mergeNotification(
  prev: { stage: DeliveryStage; amount?: number; at: number },
  next: { stage: DeliveryStage; amount?: number; at: number },
): { stage: DeliveryStage; amount?: number; at: number } {
  return {
    stage: STAGE_RANK[next.stage] >= STAGE_RANK[prev.stage] ? next.stage : prev.stage,
    amount: next.amount ?? prev.amount,
    at: Math.min(prev.at, next.at),
  };
}
