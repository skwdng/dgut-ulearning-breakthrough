/**
 * 「签到记录页只留改状态」的回归测试（2026-10-30）。
 *
 * ══════════════ 用户原话 ══════════════
 *
 *   「在签到记录页把签到按钮关掉，只留改状态，因为签到功能不好用」
 *   「点不中功能先藏起来，以后再搞」
 *
 * ══════════════ 为什么要单独钉 ══════════════
 *
 * 这个项目的"签到"和"改状态"走的是**两套不同接口**：
 *   · 签到 → signByStu（学生真实签到，常被风控/判失败）
 *   · 改状态 → 教师侧改状态接口（稳定）
 * 用户说"签到功能不好用"，指的是前者。如果以后有人为了"方便"把
 * 「签到」快捷按钮加回来，就会又出现"点了没反应/失败"的老问题。
 *
 * 同理，「点不中」被要求"先藏起来"：入口要消失，但**页面与路由要保留**
 * （用户说的是"以后再搞"，不是"删掉"）。
 *
 * 用法: node tools/verify-sign-only-status.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

let pass = 0;
let fail = 0;
const t = (name, ok, extra = '') => {
  if (ok) {
    pass += 1;
    console.log(`  √ ${name}`);
  } else {
    fail += 1;
    console.log(`  × ${name}${extra ? '  → ' + extra : ''}`);
  }
};

const LIST = strip(read('src/screens/SignRecordList.tsx'));
const XIAOCAO = strip(read('src/screens/xiaocao.tsx'));
const SCREENS = read('src/nav/screens.tsx');
const ROUTER = read('src/nav/router.tsx');

console.log('');
console.log('=== 1) ★★★ 签到记录页：只有「改状态」，没有「签到」按钮 ===');
t(
  '★★★ 不再渲染 label="签到" 的按钮',
  !/label=\{[^}]*'签到'(?![^}]*改状态)/.test(LIST) && !/label="签到"/.test(LIST),
  'signByStu 那条路被用户明确关掉',
);
t('★★★ 「改状态」按钮仍在', /label=\{[^}]*'改状态'/.test(LIST));
t(
  '★★★ 已删除 changeToSigned 快捷签到函数',
  !/changeToSigned/.test(LIST) && !/sign\.actions\.signByMethod/.test(LIST),
  '改状态走 applyStatus，不再走 signByMethod',
);
t('★★ 改状态弹窗仍在（applyStatus）', /applyStatus/.test(LIST));
t(
  '★★ 注释写清了为什么去掉签到按钮',
  /用户要求[\s\S]{0,80}?签到按钮/.test(read('src/screens/SignRecordList.tsx')),
);
t(
  '★ 每条记录仍有「改状态」（不能只在已签到记录上给）',
  /allowChange \? \(/.test(LIST) && /onCancel/.test(LIST),
);

console.log('');
console.log('=== 2) ★★★ 点不中：入口隐藏，页面/路由保留 ===');
t('★★★ 小操作页不再显示「点不中」入口', !/label="点不中"/.test(XIAOCAO));
t('★★★ 小操作页不再跳转 /dianbuzhong', !/push\('\/dianbuzhong'\)/.test(XIAOCAO));
t('★★★ /dianbuzhong 路由仍在', /'\/dianbuzhong'/.test(ROUTER));
t('★★★ /dianbuzhong 页面注册仍在', /'\/dianbuzhong'/.test(SCREENS) && /DianBuZhongScreen/.test(SCREENS));
t(
  '★★ 注释写明了"先藏起来，以后再搞"',
  /先藏起来|以后再搞/.test(read('src/screens/xiaocao.tsx')),
);

console.log('');
console.log('  ══════════════════════════════════════════════');
console.log('  为什么钉这两条：');
console.log('  · 签到按钮走的是"学生真实签到"接口，用户实测不好用；');
console.log('    加回来就会重现"点了没反应"。');
console.log('  · 点不中被要求"暂时隐藏"，如果顺手把页面/路由也删了，');
console.log('    以后要恢复就得重写一遍。');
console.log('  ⚠️ 报 XX 就是实现确实不满足，不要改断言去迁就。');
console.log('  ══════════════════════════════════════════════');
console.log('');
console.log(`SUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
