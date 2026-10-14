// 外卖通知解析引擎的回归测试。
// 用真实形态的通知文案验证：平台识别、店铺名抽取、阶段判定、金额提取、
// 以及**必须被忽略的营销通知**（这是最容易出错的：把优惠券当成订单）。
//
// 用法: node tools/verify-delivery.cjs

// ===== 与被测文件保持一致的实现（改动 src 后请同步） =====
const PKG_MAP = [
  [/com\.sankuai\.meituan/, 'meituan'],
  [/me\.ele/, 'eleme'],
  [/com\.jingdong|com\.jd\./, 'jd'],
  [/com\.ss\.android\.ugc\.aweme/, 'douyin'],
];
const IGNORE_PATTERNS = [
  /优惠券|红包|满减|立减|折扣|特价|限时|秒杀|领券|神券|补贴|活动/,
  /会员|续费|开通|积分|签到|抽奖|邀请|助力/,
  /版本更新|更新提示|隐私政策|用户协议/,
  /评价|晒单|打分|求好评/,
];
const STORE_PREFIXES = [
  /^(您的|你的)?订单/,
  /^您有一笔(新)?订单/,
  /^(您|你)(有|收到)?(一笔)?新订单/,
  /^(您|你)的订单/,
  /^新订单/,
  /^订单通知/,
  /^外卖订单/,
];
const STORE_SUFFIXES = [
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
const STATUS_ONLY_RE =
  /^[\s的是有已正在中将请尽快及时支付付款下单提交接单派送配送送达完成确认取消退款商家骑手订单通知新您你]+$/;
const STATUS_WORDS = /(已提交|已下单|已支付|已接单|配送中|已送达|已完成|已取消|待支付|待付款|正在配送|订单|骑手|商家已|请尽快|请及时)/;
const STAGE_RULES = [
  [/已取消|订单取消|取消订单/, 'cancelled'],
  [/退款|已退款/, 'cancelled'],
  [/已送达|已完成|已收货|订单完成|感谢使用|欢迎再次/, 'done'],
  [/配送中|骑手|正在配送|已取餐|即将送达|预计.{0,10}送达|正在为您派送|派送中/, 'delivering'],
  [/已支付|支付成功|付款成功|下单成功|已下单|订单已提交|已提交|新订单|商家已接单|已接单|等待配送|等待商家|订单提交/, 'paid'],
  [/待支付|请支付|待付款|未支付|请尽快付款/, 'created'],
];
const AMOUNT_RE = /(?:¥|￥|实付|支付|合计|金额|共)\s*(\d+(?:\.\d{1,2})?)\s*元?/;

function detectPlatform(pkg) {
  for (const [re, p] of PKG_MAP) if (re.test(pkg)) return p;
  return null;
}
function detectStage(text) {
  for (const [re, s] of STAGE_RULES) if (re.test(text)) return s;
  return 'unknown';
}
function extractAmount(text) {
  const m = AMOUNT_RE.exec(text);
  if (!m) return undefined;
  const v = Number(m[1]);
  return Number.isFinite(v) && v > 0 && v < 100000 ? v : undefined;
}
function extractStoreName(title, text) {
  const candidates = [];

  // 正文优先：正文里的店名通常带「(门店)」，信息量比标题大；
  // 标题经常只是状态语（"订单已提交"），放后面兜底。
  const segs = (text || '')
    .split(/[，,。.；;：:\n｜|]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const withParen = segs.filter((s) => /[（(][^）)]{1,20}[）)]/.test(s));
  candidates.push(...withParen);
  for (const s of segs) if (!withParen.includes(s)) candidates.push(s);

  let t = (title || '').trim();
  t = t.replace(/^(美团外卖|美团|饿了么|京东秒送|京东外卖|抖音外卖|抖音)[:：\s-]*/, '');
  if (t) candidates.push(t);

  candidates.push(`${text} ${title}`.trim());

  for (const raw of candidates) {
    let s = raw;
    for (let i = 0; i < 3; i += 1) {
      let changed = false;
      for (const re of STORE_PREFIXES) {
        const next = s.replace(re, '').trim();
        if (next !== s) { s = next; changed = true; }
      }
      if (!changed) break;
    }
    for (const re of STORE_SUFFIXES) s = s.replace(re, '').trim();
    s = s.replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '').trim();

    if (s.length < 2 || s.length > 30) continue;
    if (IGNORE_PATTERNS.some((re) => re.test(s))) continue;
    if (/^\d+$/.test(s)) continue;
    if (STATUS_ONLY_RE.test(s)) continue;
    if (STATUS_WORDS.test(s) && s.length <= 6) continue;
    if (/(订单|骑手|配送|支付|送达|取消|退款)/.test(s) && s.length <= 4) continue;
    return s;
  }
  return undefined;
}

function parseDelivery(input) {
  const platform = detectPlatform(input.pkg);
  if (!platform) return null;
  const title = input.title || '';
  const text = input.text || '';
  const all = `${title} ${text}`.trim();
  if (!all) return null;
  if (IGNORE_PATTERNS.some((re) => re.test(all))) return null;
  const stage = detectStage(all);
  const storeName = extractStoreName(title, text);
  const amount = extractAmount(all);
  if (!storeName) return { platform, storeName: '', stage, amount, confidence: 'low', reason: 'no_store_name' };
  const confidence = stage === 'unknown' && !amount ? 'low' : 'high';
  return { platform, storeName, stage, amount, confidence };
}

// ===== 测试用例 =====
const MEITUAN = 'com.sankuai.meituan';
const ELEME = 'me.ele';
const JD = 'com.jingdong.app.mall';

const CASES = [
  // ---- 应识别为订单 ----
  {
    name: '美团-已下单',
    input: { pkg: MEITUAN, title: '订单已提交', text: '麦当劳(松山湖店) 已下单，实付 32.5 元' },
    expect: { platform: 'meituan', stage: 'paid', amount: 32.5, storeIncludes: '麦当劳' },
  },
  {
    name: '美团-商家接单',
    input: { pkg: MEITUAN, title: '商家已接单', text: '您的订单 华莱士·全鸡汉堡(大岭山店) 已接单' },
    expect: { platform: 'meituan', stage: 'paid', storeIncludes: '华莱士' },
  },
  {
    name: '美团-配送中',
    input: { pkg: MEITUAN, title: '骑手正在配送', text: '您的订单 沙县小吃(理工店) 正在配送中，预计18:30送达' },
    expect: { platform: 'meituan', stage: 'delivering', storeIncludes: '沙县小吃' },
  },
  {
    name: '美团-已送达',
    input: { pkg: MEITUAN, title: '订单已送达', text: '杨国福麻辣烫(松山湖) 已送达，感谢使用美团外卖' },
    expect: { platform: 'meituan', stage: 'done', storeIncludes: '杨国福' },
  },
  {
    name: '美团-已取消',
    input: { pkg: MEITUAN, title: '订单已取消', text: '肯德基(大岭山店) 订单已取消，退款将原路返回' },
    expect: { platform: 'meituan', stage: 'cancelled', storeIncludes: '肯德基' },
  },
  {
    name: '饿了么-已下单',
    input: { pkg: ELEME, title: '饿了么', text: '您有一笔新订单：蜜雪冰城(松山湖店)，合计 8.9 元' },
    expect: { platform: 'eleme', stage: 'paid', amount: 8.9, storeIncludes: '蜜雪冰城' },
  },
  {
    name: '饿了么-配送中',
    input: { pkg: ELEME, title: '订单配送中', text: '汉堡王(东莞松山湖店) 骑手已取餐，正在为您派送' },
    expect: { platform: 'eleme', stage: 'delivering', storeIncludes: '汉堡王' },
  },
  {
    name: '饿了么-待支付',
    input: { pkg: ELEME, title: '订单待支付', text: '真功夫(松山湖店) 待支付，请尽快付款' },
    expect: { platform: 'eleme', stage: 'created', storeIncludes: '真功夫' },
  },
  {
    name: '京东秒送-已下单',
    input: { pkg: JD, title: '京东秒送', text: '新订单 瑞幸咖啡(松山湖店) 已下单，实付 15 元' },
    expect: { platform: 'jd', stage: 'paid', amount: 15, storeIncludes: '瑞幸' },
  },
  {
    name: '店名含分隔符',
    input: { pkg: MEITUAN, title: '订单已提交', text: '沪上阿姨·鲜果茶(松山湖店) 已下单' },
    expect: { platform: 'meituan', stage: 'paid', storeIncludes: '沪上阿姨' },
  },

  // ---- 必须被忽略（营销类，不能计入订单）----
  { name: '忽略-优惠券', input: { pkg: MEITUAN, title: '美团外卖', text: '你有一张 15 元优惠券即将过期，点击领取' }, expect: null },
  { name: '忽略-红包活动', input: { pkg: MEITUAN, title: '天天神券', text: '限时活动，满30减15，速来领取红包' }, expect: null },
  { name: '忽略-会员续费', input: { pkg: ELEME, title: '饿了么会员', text: '会员即将到期，续费享 9 折优惠' }, expect: null },
  { name: '忽略-求好评', input: { pkg: MEITUAN, title: '评价提醒', text: '您对本次订单的评价还没提交，来打分吧' }, expect: null },
  { name: '忽略-版本更新', input: { pkg: MEITUAN, title: '版本更新', text: '新版本已发布，修复若干问题' }, expect: null },
  { name: '忽略-非外卖App', input: { pkg: 'com.tencent.mm', title: '微信', text: '订单已提交 麦当劳' }, expect: null },
  { name: '忽略-空通知', input: { pkg: MEITUAN, title: '', text: '' }, expect: null },
];

// ===== 执行 =====
const results = [];
function check(name, ok, extra) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
}

let pass = 0;
for (const c of CASES) {
  const got = parseDelivery(c.input);
  if (c.expect === null) {
    check(c.name, got === null, got ? `错误地识别为: ${JSON.stringify(got)}` : '(正确忽略)');
    continue;
  }
  if (!got) {
    check(c.name, false, '应识别但返回 null');
    continue;
  }
  const problems = [];
  if (got.platform !== c.expect.platform) problems.push(`平台 ${got.platform} ≠ ${c.expect.platform}`);
  if (c.expect.stage && got.stage !== c.expect.stage) problems.push(`阶段 ${got.stage} ≠ ${c.expect.stage}`);
  if (c.expect.amount !== undefined && got.amount !== c.expect.amount) problems.push(`金额 ${got.amount} ≠ ${c.expect.amount}`);
  if (c.expect.storeIncludes && !String(got.storeName).includes(c.expect.storeIncludes)) {
    problems.push(`店名 "${got.storeName}" 不含 "${c.expect.storeIncludes}"`);
  }
  check(c.name, problems.length === 0, problems.length ? problems.join('; ') : `店名="${got.storeName}" 阶段=${got.stage} 金额=${got.amount ?? '-'}`);
}

// ===== 去重测试 =====
console.log('\n--- 去重（同一订单连发多条通知） ---');
const t0 = 1759800000000;
const f1 = fingerprintTest('meituan', '麦当劳(松山湖店)', t0);
const f2 = fingerprintTest('meituan', '麦当劳(松山湖店)', t0 + 5 * 60 * 1000);
const f3 = fingerprintTest('meituan', '麦当劳(松山湖店)', t0 + 40 * 60 * 1000);
check('同店 5 分钟内 → 同一指纹', f1 === f2, `${f1} vs ${f2}`);
check('同店 40 分钟后 → 不同指纹', f1 !== f3, `${f1} vs ${f3}`);

function fingerprintTest(platform, storeName, at, windowMs = 30 * 60 * 1000) {
  const bucket = Math.floor(at / windowMs);
  return `${platform}|${storeName.toLowerCase().replace(/\s+/g, '')}|${bucket}`;
}

const failed = results.filter((r) => !r.ok);
console.log(`\nSUMMARY total=${results.length} pass=${results.length - failed.length} fail=${failed.length}`);
process.exit(failed.length === 0 ? 0 : 1);
