// 验证「手势滑动切页」相关的函数是否正确。
//
// 只测**纯逻辑**（阈值判断、方向映射），不碰 RN 运行时 ——
// PanResponder 本身无法在 Node 里跑，但它的判定规则可以。
let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  √ ${name}`); }
  else { fail += 1; console.log(`  × ${name}${extra ? '  → ' + extra : ''}`); }
};

/** 与 shell.tsx 中保持一致的判定：是否接管手势 */
function shouldTake(dx, dy) {
  return Math.abs(dx) > 18 && Math.abs(dx) > Math.abs(dy) * 1.6;
}

/** 与 shell.tsx 中保持一致的判定：松手后是否够格切页 */
function enoughToSwitch(dx, vx, screenWidth) {
  return Math.abs(dx) > Math.max(60, screenWidth * 0.25) || Math.abs(vx) > 1.1;
}

/** 方向映射：dx<0（往左滑）→ 下一页(+1)；dx>0 → 上一页(-1) */
function dirOf(dx) {
  return dx < 0 ? 1 : -1;
}

console.log('=== 1) 是否接管手势（避免抢走纵向滚动）===');
t('横向小幅滑动（15px）不接管', shouldTake(15, 0) === false);
t('横向明显滑动（80px，无纵向）接管', shouldTake(80, 0) === true);
t('横向 80 / 纵向 100 → 不接管（更像纵向滚动）', shouldTake(80, 100) === false);
t('横向 100 / 纵向 30 → 接管', shouldTake(100, 30) === true);
t('純纵向滑动不接管', shouldTake(0, 120) === false);

console.log('\n=== 2) 松手后是否够格切页 ===');
const W = 400;
t('滑动 120px 够格', enoughToSwitch(120, 0, W) === true);
t('滑动 50px 且速度慢 → 不够格', enoughToSwitch(50, 0.2, W) === false);
t('滑动很小但甩得很快（vx=1.5）→ 够格', enoughToSwitch(20, 1.5, W) === true);
t('滑动 101px 刚好过 1/4 屏宽（100）→ 够格', enoughToSwitch(101, 0, W) === true);
t('滑动 99px 未过门槛 → 不够格', enoughToSwitch(99, 0, W) === false);
t('小屏（320）门槛 80：滑 85 够格', enoughToSwitch(85, 0, 320) === true);
t('小屏（320）门槛 80：滑 75 不够格', enoughToSwitch(75, 0, 320) === false);

console.log('\n=== 3) 方向映射 ===');
t('往左滑（dx=-100）→ 下一页 (+1)', dirOf(-100) === 1);
t('往右滑（dx=100）→ 上一页 (-1)', dirOf(100) === -1);

console.log('\n=== 4) 边界：第一页往右滑、最后一页往左滑 ===');
/** 与 shell.tsx 的 go() 一致：越界不动 */
function nextIndex(activeIndex, dir, total) {
  const next = activeIndex + dir;
  if (next < 0 || next >= total) return activeIndex;
  return next;
}
t('第 0 页往右滑 → 停在第 0 页', nextIndex(0, -1, 4) === 0);
t('第 3 页往左滑 → 停在第 3 页', nextIndex(3, 1, 4) === 3);
t('第 1 页往左滑 → 第 2 页', nextIndex(1, 1, 4) === 2);
t('第 2 页往右滑 → 第 1 页', nextIndex(2, -1, 4) === 1);

console.log('\n=== 5) 优学院关闭时的页数变化 ===');
t('4 页时首页往右滑不动', nextIndex(0, -1, 4) === 0);
t('3 页（优学院关闭）时最后一页是 AI', nextIndex(1, 1, 3) === 2);
t('3 页时第 2 页往左滑不动', nextIndex(2, 1, 3) === 2);

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
