/**
 * 签到（原「扫码签到」页）。
 *
 * 按需求调整过两次：
 *   1. 这里的"扫码"**不是去扫二维码**，而是查询签到记录、让用户自己改状态；
 *   2. 用户要求「所有课程都可以改状态」——
 *      所以**不再写死只筛扫码方式**，改成默认「全部方式」，
 *      界面上再给「全部 / 扫码 / 位置 / 数字码 / 一键」的切换。
 *
 * 本页没有任何相机调用。
 */
import React, { useEffect, useRef } from 'react';
import { ScreenScroll } from '../components';
import { useSign } from '../state/signStore';
import { useRouter } from '../nav/router';
import { SignRecordList } from './SignRecordList';

export function SignQrScreen() {
  const sign = useSign();
  const router = useRouter();
  const autoRan = useRef(false);

  useEffect(() => {
    if (autoRan.current) return;
    autoRan.current = true;
    if (!sign.overview) void sign.actions.query();
  }, [sign.overview, sign.actions]);

  return (
    <ScreenScroll>
      <SignRecordList
        allowChange
        intro="这里列出优学院发起过的签到，可以逐条改状态（不需要真的去扫码）。默认显示全部方式，也可以按扫码 / 位置 / 数字码筛选。"
        emptyHint="点上面「查询」，会找出所有签到记录"
        /**
         * ★ 接入「设置签到位置」（2026-10）
         *
         * ⚠️ 之前那个地图选点页面在 App 里**没有任何入口** ——
         *    用户看的就是这一页，却找不到功能，直接问"为什么没有显示这个功能"。
         *    所以入口必须放在**用户实际会看的那一页**。
         *    组件内部只在筛成「位置」时才显示这个按钮（见 SignRecordList 的注释）。
         */
        onSetLocation={() => router.push('/course-location')}
      />
    </ScreenScroll>
  );
}
