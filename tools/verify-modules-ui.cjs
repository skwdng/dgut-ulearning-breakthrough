/**
 * 「功能模块」页的可读性检查。
 *
 * ══════════ 真实踩过的坑 ══════════
 * 用户反馈：设置 → 功能模块里，每一项**只显示一个图标和一个开关**，
 * 完全看不出那一项是什么（截图里就是这样：一个 🎓 图标 + 开关，没有文字）。
 *
 * 根因：那一行用了 `SwitchRow`。SwitchRow 自带 `styles.settingRow`
 *      （有 padding、边框），而且它内部还有一层 `<Col flex={1}>`。
 *      嵌进模块行之后等于**套了两层带样式的行**，
 *      模块自己的名字被挤没了。
 *
 * 教训：**别把"整行组件"当"零件"用**。要在行里放控件，
 *       就用裸控件（Switch / Pressable），布局自己排。
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'screens', 'modules.tsx'), 'utf8');

/** 去掉注释后的代码（避免注释里提到的名字造成假阳性） */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

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

console.log('=== 1) ★ 模块名必须渲染出来 ===');
{
  t('渲染了 def.label', /\{def\.label\}/.test(CODE));
  t('渲染了 def.summary', /\{def\.summary\}/.test(CODE));
  // 属性顺序不固定（c 可能写在 variant 前面），所以只要求"同一个 Txt 标签里有 body 与 label"
  t('名字用 body 字号', /<Txt\b[^>]*variant="body"[^>]*>\s*\{def\.label\}/.test(CODE.replace(/\n\s*/g, '')));
  t('名字有明确文字颜色', /<Txt\b[^>]*\bc=\{/.test(CODE) && /<Txt\b[^>]*weight="semibold"/.test(CODE));
}

console.log('\n=== 2) ★ 不再嵌套 SwitchRow ===');
{
  t('代码里没有 <SwitchRow', !/<SwitchRow/.test(CODE));
  t('没有从 components 引入 SwitchRow', !/\bSwitchRow,?\s*\n/.test(CODE));
  t('改用裸 Switch', /<Switch\b/.test(CODE));
  t('Switch 配置了 trackColor', /trackColor=\{\{ true:/.test(CODE));
}

console.log('\n=== 3) 布局仍然完整 ===');
{
  t('有图标容器', /def\.glyph/.test(CODE));
  t('有开关', /onValueChange=\{onToggle\}/.test(CODE));
  t('有状态文案', /状态：/.test(CODE));
  t('有恢复默认', /恢复默认/.test(CODE));
  t('有权限标签', /PERM_LABEL\[p\]/.test(CODE));
  t('不支持时显示原因', /def\.fallbackHint/.test(CODE));
}

console.log('\n=== 4) 没有未使用的引入 ===');
{
  // Col 在重写后应完全不再出现（除了注释，注释已剥离）
  t('没有遗留未使用的 Col', !/\bCol\b/.test(CODE));
  // 用到的组件都在 import 里
  for (const name of ['Badge', 'Button', 'Card', 'Divider', 'Row', 'ScreenScroll', 'Section', 'Spacer', 'Txt']) {
    const used = new RegExp(`<${name}[\\s>]`).test(CODE);
    const imported = new RegExp(`\\b${name},`).test(CODE) || new RegExp(`\\b${name}\\b,?\\s*\\n\\}`).test(CODE);
    if (used) t(`用到的 ${name} 已引入`, imported);
  }
}

console.log('\n=== 5) 对照：其他页面有没有同样的坏用法 ===');
{
  // 全局扫一遍，看有没有别处把 SwitchRow 传空 label
  const dir = path.resolve(__dirname, '..', 'src');
  const bad = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) {
        const s = fs.readFileSync(p, 'utf8');
        if (/<SwitchRow\s+label=""/.test(s)) bad.push(p.replace(path.resolve(__dirname, '..') + path.sep, ''));
      }
    }
  };
  walk(dir);
  t('没有别处把 SwitchRow 的 label 传空', bad.length === 0, bad.join(', '));
}

console.log('\n=== 6) 首页最底下不该再显示授权码那句 ===');
{
  /**
   * 用户反馈：首页最底下有一行"万能码 · 长期有效"，要删掉。
   *
   * ⚠️ 检查方式很重要：不能去 bundle 里找这个字符串 ——
   *    它是 licenseCode.ts 生成消息用的，删掉首页那一行之后
   *    **它仍然在代码里**，只是不再被首页渲染。
   *    所以必须看**组件源码**里还有没有渲染它。
   */
  const home = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'screens', 'tab-index.tsx'), 'utf8');
  const homeCode = home.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  t('首页不再渲染 codeResult.message', !/codeResult\.message/.test(homeCode));
  t('首页不再引用 codeResult', !/codeResult/.test(homeCode));
  t('首页不再引入 useUnlock（删干净了）', !/useUnlock/.test(homeCode));
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
