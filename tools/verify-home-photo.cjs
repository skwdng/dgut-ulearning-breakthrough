/**
 * 首页背景照片交互的回归（2026-10-30）。
 *
 * ══════════════ 用户原话 ══════════════
 *
 *   「把首页换图片的换成一个固定的按钮，不要一碰就让我换照片」
 *
 * 之前的问题：整张照片卡片外面套了一层 `<Pressable onPress={pickPhoto}>`，
 * 意思是「碰哪儿都能换照片」——放在首页上就是随时随地弹相册，非常烦。
 *
 * 现在的要求：
 *   · 照片区域**不可点**（纯展示）
 *   · 换照片只通过一个**固定按钮**
 *   · 去掉「点一下更换背景照片」这条误导文案
 *
 * 用法: node tools/verify-home-photo.cjs
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

const RAW = read('src/screens/tab-index.tsx');
const CODE = strip(RAW);

console.log('');
console.log('=== 1) ★★★ 照片区域不可点（防误触）===');
t(
  '★★★ 照片卡片外面没有 Pressable 触发选照片',
  !/<Pressable[^>]*onPress=\{\(\) => void pickPhoto\(\)\}[\s\S]{0,400}?<ImageBackground/.test(CODE),
  '原来整块可点，就是"一碰就换照片"的根源',
);
t('★★ ImageBackground 仍在（照片展示不变）', /<ImageBackground/.test(CODE));
t('★★ 没有「点一下更换背景照片」误导文案', !/点一下更换背景照片/.test(RAW));

console.log('');
console.log('=== 2) ★★★ 改为固定按钮 ===');
t(
  '★★★ 有固定的「更换背景照片 / 添加背景照片」按钮',
  /label=\{photo \? '更换背景照片' : '添加背景照片'\}/.test(CODE),
);
t('★★ 该按钮才调用 pickPhoto', /onPress=\{\(\) => void pickPhoto\(\)\}/.test(CODE));
t('★★ 按钮不在照片可点区域内（独立渲染）', CODE.indexOf("label={photo ? '更换背景照片'") > CODE.indexOf('</ImageBackground>'));

console.log('');
console.log('=== 3) ★★ 换照片能力本身没丢 ===');
t('★★ pickPhoto 仍会请求相册权限', /requestMediaLibraryPermissionsAsync/.test(CODE));
t('★★ 选完照片仍会持久化', /store\.set\(STORE_KEYS\.homePhoto/.test(CODE));
t('★ 读回已保存照片的逻辑还在', /store\.get<string \| null>\(STORE_KEYS\.homePhoto/.test(CODE));

console.log('');
console.log('  ══════════════════════════════════════════════');
console.log('  为什么钉：首页照片区曾是整块可点，稍微一碰就弹相册，');
console.log('  用户明确说"不要一碰就让我换照片"。这条断言防它被改回去。');
console.log('  ⚠️ 报 XX 就是实现确实不满足，不要改断言去迁就。');
console.log('  ══════════════════════════════════════════════');
console.log('');
console.log(`SUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
