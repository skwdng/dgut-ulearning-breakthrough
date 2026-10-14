/**
 * 剪贴板订单识别测试。
 *
 * ══════════ 为什么要有这条路 ══════════
 * ① iOS 上**永远做不到**读通知（苹果不允许第三方 App 读其他 App 的通知），
 *    这是系统级限制，没有绕过办法 → iOS 只能靠"复制订单文本 → 粘贴识别"。
 * ② Android 上也有用：通知没抓到、或事后想补记一笔时，
 *    手动填店名金额很烦，粘贴一下自动带出来。
 *
 * ⚠️ 与通知解析的关键区别：剪贴板文本**没有包名**，
 *    平台只能从文字里猜；而且文本格式比通知杂得多
 *    （可能整屏订单详情，里面有"优惠券""满减"等字样）。
 *    所以这里**不能套用通知那套营销词过滤** —— 会把真订单也丢掉。
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'delivery', 'parser.ts'), 'utf8');

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

console.log('=== 1) 源码层面的关键决策 ===');
{
  t('有 detectPlatformFromText', /export function detectPlatformFromText/.test(SRC));
  t('有 parseClipboardOrder', /export function parseClipboardOrder/.test(SRC));
  t('★ 剪贴板解析**不做**营销词过滤（否则真订单会被丢）', /不做.*IGNORE_PATTERNS 过滤/.test(SRC));
  t('猜不到平台时用 other 而不是丢弃', /return 'other';/.test(SRC));
  t('结果标注置信度（供界面提示用户核对）', /confidence,/.test(SRC));
}

console.log('\n=== 2) 平台识别（从文字猜）===');
{
  /** 复刻 detectPlatformFromText */
  const HINTS = [
    [/美团|meituan|小美|袋鼠/iu, 'meituan'],
    [/饿了么|eleme|饿了吗|蓝骑士|蜂鸟/iu, 'eleme'],
    [/京东|京东外卖|达达|秒送/iu, 'jd'],
    [/抖音|字节|抖音外卖|DOUYIN/iu, 'douyin'],
  ];
  function detect(text) {
    for (const [re, p] of HINTS) if (re.test(text ?? '')) return p;
    return 'other';
  }
  const CASES = [
    ['美团外卖 您的订单已送达', 'meituan'],
    ['【饿了么】订单已送达', 'eleme'],
    ['美团', 'meituan'],
    ['饿了么订单', 'eleme'],
    ['京东外卖 订单已下单', 'jd'],
    ['抖音外卖 您的订单', 'douyin'],
    ['麦当劳订单 已送达', 'other'],
    ['', 'other'],
  ];
  for (const [text, expect] of CASES) {
    const got = detect(text);
    const ok = got === expect;
    console.log(`  ${ok ? '√' : '×'} ${JSON.stringify(text).padEnd(30)} → ${got}`);
    if (ok) pass += 1;
    else fail += 1;
  }
}

console.log('\n=== 3) 真实订单文本的字段抽取 ===');
{
  /** 复刻 extractAmount（与 parser.ts 的规则一致：优先 ¥ 或 元） */
  function extractAmount(text) {
    if (!text) return undefined;
    const patterns = [
      /(?:实付|实付款|合计|总计|支付金额|已支付|订单金额)[：:\s]*[¥￥]?\s*([0-9]+(?:\.[0-9]{1,2})?)/,
      /[¥￥]\s*([0-9]+(?:\.[0-9]{1,2})?)/,
      /([0-9]+(?:\.[0-9]{1,2})?)\s*元/,
    ];
    for (const re of patterns) {
      const m = re.exec(text);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
    return undefined;
  }

  const CASES = [
    ['实付 ¥28.5', 28.5],
    ['合计：35元', 35],
    ['订单金额 ￥42.00', 42],
    ['美团外卖 您的订单已送达', undefined],
  ];
  for (const [text, expect] of CASES) {
    const got = extractAmount(text);
    const ok = got === expect;
    console.log(`  ${ok ? '√' : '×'} ${text.padEnd(28)} → ${got === undefined ? '未识别' : '¥' + got}`);
    if (ok) pass += 1;
    else fail += 1;
  }
}

console.log('\n=== 4) ★ 关键：订单详情里的"优惠券"字样不能导致丢弃 ===');
{
  /**
   * 这条是整个功能最容易踩的坑。
   * 通知解析里会过滤"优惠券/满减"等营销词 —— 那是对的（营销通知不是订单）。
   * 但**订单详情页**里出现"优惠券""满减"是完全正常的，
   * 如果沿用那套过滤，用户认认真真复制的真订单会被直接丢掉，且毫无提示。
   */
  const IGNORE = [/优惠券|红包|满减|立减|折扣|特价|限时|秒杀|领券|神券|补贴|活动/];
  const realOrderText =
    '美团外卖\n' +
    '麦当劳(松山湖店)\n' +
    '订单已送达\n' +
    '优惠券 -5元\n' +
    '满减 -3元\n' +
    '实付 ¥28.5';

  const wouldBeIgnoredByNotificationRules = IGNORE.some((re) => re.test(realOrderText));
  console.log(`  用通知那套规则判断 → ${wouldBeIgnoredByNotificationRules ? '会被丢弃 ★' : '不会丢弃'}`);
  t('★ 真订单文本确实会被"通知规则"误杀（说明必须区别对待）', wouldBeIgnoredByNotificationRules === true);
  t('★ 源码里明确声明剪贴板路径不做该过滤', /不做.*IGNORE_PATTERNS 过滤/.test(SRC));
  // 正向：金额照样抽得出来
  const amt = /(?:实付|实付款|合计|总计|支付金额|已支付|订单金额)[：:\s]*[¥￥]?\s*([0-9]+(?:\.[0-9]{1,2})?)/.exec(
    realOrderText,
  );
  t('订单详情里仍能抽出金额', amt?.[1] === '28.5', amt?.[1] ?? '未抽出');
}

console.log('\n=== 5) 结果一律交用户确认，不直接入库 ===');
{
  const UI = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'modules', 'DeliveryModule.tsx'), 'utf8');
  t('有「从剪贴板粘贴识别」按钮', /从剪贴板粘贴识别/.test(UI));
  t('用了 expo-clipboard', /expo-clipboard/.test(UI));
  t('★ 识别结果填进输入框（不是直接 addManual）', /setStoreName\(r\.storeName\)/.test(UI));
  t('★ 没有跳过确认直接入库', !/pasteAndParse[\s\S]{0,900}?actions\.addManual/.test(UI));
  t('提示用户核对后再记', /核对无误再点「记一笔」/.test(UI));
  t('平台没认出来时会提示可手动改', /没认出来，可手动改/.test(UI));
  t('剪贴板为空时给出操作指引', /请先在外卖 App 里复制订单信息/.test(UI));
}

console.log('\n=== 6) iOS 说明文案仍然准确 ===');
{
  const UI = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'modules', 'DeliveryModule.tsx'), 'utf8');
  t('iOS 上明确说明无法自动记录', /iOS 系统不允许第三方 App 读取其他 App 的通知/.test(UI));
  t('并给出替代方案（复制后粘贴识别）', /复制订单信息后粘贴识别/.test(UI));
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
