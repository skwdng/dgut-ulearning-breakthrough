/**
 * 一键签到。
 *
 * 用途：把这个 App 最实用的操作单独做成一个入口 ——
 *      打开就能看到「现在有几个点名可以签」，点一下批量提交。
 *
 * ⚠️ 只有「点名进行中 + 我还没签」的记录会被提交。
 *    活动已结束服务端返回 202，已签过的返回 209，都改不动 ——
 *    所以界面上直接把不可操作的过滤掉，不给人无效的按钮。
 *
 * 提交是**串行 + 间隔**的，不并发：签到是有副作用的写操作，
 * 并发容易被判定为异常流量，宁慢勿错。
 */
import React, { useEffect, useRef } from 'react';
import { ScreenScroll } from '../components';
import { useSign } from '../state/signStore';
import { SignRecordList } from './SignRecordList';

export function SignOneshotScreen() {
  const sign = useSign();
  const autoRan = useRef(false);

  // 进页面自动查一次：一键签到的前提是"知道现在有什么可签"
  useEffect(() => {
    if (autoRan.current) return;
    autoRan.current = true;
    if (!sign.overview) void sign.actions.query();
  }, [sign.overview, sign.actions]);

  return (
    <ScreenScroll>
      <SignRecordList
        allowChange
        intro="这个页面把所有「进行中却还没签」的点名列出来。只能逐条点「签到」—— 批量提交已关闭（不可控）。"
        emptyHint="点下面「查询」，会找出所有点名"
      />
    </ScreenScroll>
  );
}
