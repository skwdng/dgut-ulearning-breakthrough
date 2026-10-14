/**
 * 顶层页面注册表 —— 底部滑动栏的四个页面。
 *
 * 这几个页面全部常驻挂载（用 display 控制显隐），
 * 好处：切换时各自的滚动位置不丢、不会重复发起网络请求。
 *
 * 它们通过 props 拿到 router 和 isActive：
 *   - router 用来跳到二级页面（注册表因此不必依赖 router，避免循环 import）
 *   - isActive 用来在页面变为可见时才刷新数据（可选）
 */
import React from 'react';
import type { TopTabKey, RoutePath, RouteParams } from './router';
import { HomeScreen } from '../screens/tab-index';
import { YouxueTabScreen } from '../screens/tab-youxue';
import { FoodScreen } from '../screens/tab-food';
import { AiScreen } from '../screens/tab-ai';

/** 顶层页面能拿到的 router（比 useRouter 窄一点，够用即可） */
export interface TabRouter {
  push: (t: RoutePath, p?: RouteParams) => void;
  replace: (t: RoutePath, p?: RouteParams) => void;
  back: () => void;
}

export interface TabScreenProps {
  router: TabRouter;
  isActive: boolean;
}

export const TAB_SCREENS: Record<TopTabKey, React.ComponentType<TabScreenProps>> = {
  index: HomeScreen,
  /** 优学院 —— 任务查询 + 小操作（两个二级入口，见 tab-youxue.tsx） */
  youxue: YouxueTabScreen,
  food: FoodScreen,
  ai: AiScreen,
};
