/**
 * 外卖订单记录 —— 数据模型
 *
 * 记录来源（source）：
 * - notify: Android 通知监听自动抓取（主力）
 * - manual: 手动补录（纠错与查漏）
 * - clipboard: 剪贴板解析（备选）
 */

export type DeliveryPlatform = 'meituan' | 'eleme' | 'jd' | 'douyin' | 'other';

export const PLATFORM_META: Record<DeliveryPlatform, { label: string; pkg: string[]; color: string }> = {
  meituan: {
    label: '美团',
    pkg: ['com.sankuai.meituan', 'com.sankuai.meituan.takeoutnew', 'com.sankuai.meituan.merchant'],
    color: '#FFC300',
  },
  eleme: {
    label: '饿了么',
    pkg: ['me.ele', 'me.ele.customer', 'com.taobao.taobao'],
    color: '#0095FF',
  },
  jd: {
    label: '京东',
    pkg: ['com.jingdong.app.mall', 'com.jd.jdlite'],
    color: '#E1251B',
  },
  douyin: {
    label: '抖音',
    pkg: ['com.ss.android.ugc.aweme', 'com.ss.android.ugc.aweme.lite'],
    color: '#161823',
  },
  other: { label: '其他', pkg: [], color: '#6B7280' },
};

/** 订单状态：只关心"已下单"与"已完成"，未支付的不该计入统计 */
export type DeliveryStage = 'created' | 'paid' | 'delivering' | 'done' | 'cancelled' | 'unknown';

export const STAGE_LABEL: Record<DeliveryStage, string> = {
  created: '已下单',
  paid: '已支付',
  delivering: '配送中',
  done: '已完成',
  cancelled: '已取消',
  unknown: '未知',
};

export interface DeliveryOrder {
  id: string;
  platform: DeliveryPlatform;
  /** 原始包名，便于排查解析问题 */
  pkg: string;
  /** 店铺名 —— 统计的核心维度 */
  storeName: string;
  /** 从通知里抠出来的金额（可能为空） */
  amount?: number;
  stage: DeliveryStage;
  /** 通知发布时间 */
  at: number;
  source: 'notify' | 'manual' | 'clipboard';
  /** 去重指纹 */
  fingerprint: string;
  /** 原始通知文本，供纠错与调试（脱敏后） */
  rawTitle?: string;
  rawText?: string;
}

/** 按店铺聚合的统计结果 */
export interface StoreStat {
  storeName: string;
  count: number;
  platforms: DeliveryPlatform[];
  lastAt: number;
  totalAmount: number;
}

/** 整体统计 */
export interface DeliveryStats {
  total: number;
  storeCount: number;
  byPlatform: Array<{ platform: DeliveryPlatform; count: number }>;
  topStores: StoreStat[];
  monthCount: number;
  lastOrderAt?: number;
}

/** 阶段排序，用于合并同一订单的多次通知（后到的更靠后阶段覆盖） */
export const STAGE_RANK: Record<DeliveryStage, number> = {
  unknown: 0,
  created: 1,
  paid: 2,
  delivering: 3,
  done: 4,
  cancelled: 5,
};
