/**
 * 回归测试：**课程签到位置（地图围圈）**功能。
 *
 * ══════════════ 用户需求（原话）══════════════
 *
 *   「给我把位置签到完善一下，要做到要在发起签到的设备围一个圈选位置」
 *   「要不就自己引用个地图，手指滑动，让标点对准位置」
 *
 * ══════════════ 这个脚本盯什么 ══════════════
 *
 *   1. 地图页 `/course-location` 真的注册了，而且**过授权码门槛**
 *      （签到类页面不过门槛 = 没授权码的人也能改签到坐标，这个漏洞踩过一次）
 *   2. MapPicker 用的是 Leaflet + OpenStreetMap 瓦片（不需要 key、不加依赖）
 *   3. 准星固定、地图动；**只在 moveend 回传坐标**
 *      （用 move 会每帧 postMessage，低端机直接卡死）
 *   4. 地图 HTML 是**内联模板字符串**，不依赖 .html 资源文件
 *      （Metro 默认不把 .html 打进包，线上会白屏）
 *   5. ★★★ `fetchCourses` 必须**保留本地字段**
 *      （`location` 签到位置 / `autoCheckin` 课程开关都是纯本地数据，
 *        服务端不返回；老实现每次拉课程都重新构造对象 → 用户圈好的范围神秘消失）
 *   6. 位置签到页优先用圈内随机点，**没圈时回退真实定位**（不能直接拒绝）
 *
 * ⚠️ 判定方式：**只读源码 + 正则**，不运行 RN 代码（跑不起来，也没必要）。
 *
 * ⚠️ 两条本项目反复踩的坑，这里都防住了：
 *   · **判据要针对代码，不要针对注释** —— 好几个文件里写着
 *     "原来硬编码 autoCheckin: true"/"用 moveend 而不是 move" 这类历史说明，
 *     直接搜文本会把注释算成命中（假绿）。所以判"有没有这段代码"前先剥注释。
 *   · **CRLF** —— 有的文件是 CRLF，行尾带 `\r`，比较行内容必然失败。
 *     这里读文件时统一归一成 LF。
 *
 * 用法: node tools/verify-course-location.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/**
 * 读源码。
 * ⚠️ 统一把 CRLF 归一成 LF —— 项目里 LF / CRLF 混着，不归一的话
 *    行尾的 `\r` 会让任何按行比较的判据假红。
 * 读不到就返回空串（让相关断言如实报 XX，而不是抛异常中断整个测试）。
 */
function read(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return '';
  }
}

/**
 * ⚠️ 剥注释 —— **判据要针对代码，不是文本**（本项目反复踩的坑）。
 *    两个方向都要防：
 *      · 注释里写了"原来叫 xxx" → 直接搜文本会算成命中（假绿）
 *      · 注释里写了正确做法，代码里其实是错的 → 会算成通过（假绿）
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * 取一段声明（函数 / 接口 / 方法）的**完整块**，用来把判据限定在它内部。
 *
 * ⚠️ 不能简单地从声明往后找第一个 `{` 就配平 —— **参数里可能有对象字面量类型**：
 *      setCourseLocation(
 *        courseId: string,
 *        location: { latitude: number; ... } | null,   ← 这个 `{}` 会先配平
 *      )
 *    那样只会截到参数就返回，方法体根本没进来 → 断言拿到不完整的签名（假红，
 *    第一版就踩了这个：明明写了 `| null` 却报"不接受 null"）。
 *    所以：**先跳过参数表的圆括号，再从后面的 `{` 开始配平**。
 */
function sliceDecl(src, declIdx) {
  if (declIdx < 0) return '';
  const paren = src.indexOf('(', declIdx);
  const brace = src.indexOf('{', declIdx);
  let start = brace;
  // 有参数表（`(` 在第一个 `{` 之前）→ 先把括号配平跳过
  if (paren >= 0 && (brace < 0 || paren < brace)) {
    let pdepth = 0;
    let close = -1;
    for (let i = paren; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === '(') pdepth += 1;
      else if (ch === ')') {
        pdepth -= 1;
        if (pdepth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close < 0) return '';
    start = src.indexOf('{', close);
  }
  if (start < 0) return '';
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(declIdx, i + 1);
    }
  }
  return src.slice(declIdx);
}

let pass = 0;
let fail = 0;
const t = (name, ok, extra = '') => {
  if (ok) {
    pass += 1;
    console.log(`  OK  ${name}`);
  } else {
    fail += 1;
    console.log(`  XX  ${name}${extra ? '  → ' + extra : ''}`);
  }
};

/* ── 被校验的文件 ── */
const ROUTER = read('src/nav/router.tsx');
const SCREENS = read('src/nav/screens.tsx');
const PAGE = read('src/screens/course-location.tsx');
const PICKER = read('src/components/MapPicker.tsx');
const STORE = read('src/state/checkinStore.tsx');
const ADAPTER = read('src/services/checkin/youxueAdapter.ts');
const TYPES = read('src/services/checkin/types.ts');
const SIGN_LOC = read('src/screens/sign-location.tsx');
const GEO = read('src/utils/geo.ts');

/** 剥注释后的"纯代码"版本 —— 所有"有没有这段代码"的判据都用它 */
const ROUTER_CODE = stripComments(ROUTER);
const SCREENS_CODE = stripComments(SCREENS);
const PAGE_CODE = stripComments(PAGE);
const PICKER_CODE = stripComments(PICKER);
const STORE_CODE = stripComments(STORE);
const ADAPTER_CODE = stripComments(ADAPTER);
const TYPES_CODE = stripComments(TYPES);
const SIGN_LOC_CODE = stripComments(SIGN_LOC);

console.log('');
console.log('  ══════════════════════════════════════════════');
console.log('   课程签到位置（地图围圈）回归测试');
console.log('  ══════════════════════════════════════════════');
console.log('');

{
  const missing = [
    ['src/nav/router.tsx', ROUTER],
    ['src/nav/screens.tsx', SCREENS],
    ['src/screens/course-location.tsx', PAGE],
    ['src/components/MapPicker.tsx', PICKER],
    ['src/state/checkinStore.tsx', STORE],
    ['src/services/checkin/youxueAdapter.ts', ADAPTER],
    ['src/services/checkin/types.ts', TYPES],
    ['src/screens/sign-location.tsx', SIGN_LOC],
    ['src/utils/geo.ts', GEO],
  ]
    .filter(([, src]) => !src)
    .map(([rel]) => rel);
  if (missing.length) {
    console.log(`  ⚠️ 读不到这些文件，相关断言会直接判失败：${missing.join('、')}`);
    console.log('');
  }
}

console.log('=== 1) ★★★ 路由已注册，而且过授权码门槛 ===');
/**
 * 为什么重要：页面写好了没注册 = 用户根本进不去（点了没反应）。
 * 只判"文件里有这个字符串"不够 —— 必须出现在**路由表**里。
 */
t(
  '★★★ router.tsx 的 RoutePath 里有 \'/course-location\'',
  /['"]\/course-location['"]/.test(ROUTER_CODE),
  '路由联合类型里没有它 → push(\'/course-location\') 过不了类型检查',
);
/**
 * ⚠️ 为什么这条是 ★★★：
 *    本项目**真实踩过一次** —— `/checkin` 删掉后，`/sign-qr`、`/sign-location`
 *    等六个签到页的下游门槛一起消失，**没有授权码的人也能用签到**。
 *    现在门槛统一在路由层用 `licensed(...)` 包 —— 新加签到页漏包就是同一个漏洞。
 *    `/course-location` 能改"位置签到提交什么坐标"，属于签到类，必须被包住。
 */
t(
  '★★★ screens.tsx 注册了 /course-location 且用 licensed(...) 包着',
  /['"]\/course-location['"]\s*:\s*\{[^}]*Component:\s*licensed\(/.test(SCREENS_CODE),
  '未过授权码门槛 = 没授权码也能改签到坐标（这个漏洞踩过）',
);
/**
 * 为什么重要：注册表 import 了组件但组件没导出（或路径写错）→ 运行时白屏。
 * 两处一起判，才说明"这个页面真的接上了"。
 */
t(
  '★★ 页面组件 CourseLocationScreen 存在且被注册表导入',
  /export\s+function\s+CourseLocationScreen\s*\(/.test(PAGE_CODE) &&
    /from\s+['"][^'"]*screens\/course-location['"]/.test(SCREENS_CODE),
  '页面没导出或注册表没 import → 运行时白屏',
);

console.log('');
console.log('=== 1b) ★★★ 这个页面必须**在 App 里能点进去**（踩过）===');
/**
 * ══════════════ ⚠️ 这条断言是补的，因为犯过一次 ══════════════
 *
 * 第一版把「设置签到位置」的入口**只放在 `/sign-location`（地点签到页）**，
 * 而那个页面**在 App 里没有任何入口**（只有路由注册，没有 router.push）——
 * 于是新功能**根本进不去**。
 *
 * 用户截图问：「为什么没有显示这个功能」。
 *
 * 这是本项目反复出现的教训：**功能做完了 ≠ 用户能找到。**
 * 所以现在专门钉一条：入口必须在**用户实际会看的那一页**上。
 *
 * ⚠️ 判据要剥注释 —— 这几处代码的注释里就写着 '/course-location' 这个词，
 *    直接搜文本会把注释算成命中（这个坑项目里踩过很多次）。
 */
const QR_CODE_NOCOMMENT = read('src/screens/sign-qr.tsx')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
t(
  '★★★ 签到记录页（用户最先看到的那页）有 push 到 /course-location 的入口',
  /router\.push\(\s*['"]\/course-location['"]/.test(QR_CODE_NOCOMMENT),
  '入口只挂在进不去的页面上 = 功能等于没做（真实踩过）',
);
/**
 * ⚠️ 同时要求"入口是**有条件显示**的"：
 *    只在筛成「位置」时出现，否则看扫码记录时冒出定位设置属于噪音。
 */
t(
  '★★ 入口只在位置筛选下显示（不打扰其它方式）',
  /onSetLocation/.test(read('src/screens/SignRecordList.tsx')) &&
    /methodFilter === 'location'/.test(read('src/screens/SignRecordList.tsx')),
  '没有条件判断 → 任何方式下都显示定位设置按钮',
);
t(
  '★★ 地点签到页也给了入口',
  /router\.push\(\s*['"]\/course-location['"]/.test(
    read('src/screens/sign-location.tsx')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, ''),
  ),
  '地点签到页里没有入口',
);

console.log('');
console.log('=== 2) ★★★ MapPicker 用 Leaflet + OSM 瓦片（不加依赖、不需要 key）===');
/**
 * 为什么重要：这是整个功能的**可行性前提**。
 *    项目里没有 react-native-maps（原生地图要 GMS + API key，国内多数手机白屏），
 *    方案全靠 WebView 里的 Leaflet + OSM 瓦片。少了任何一条，地图就是一片灰。
 */
t(
  '★★★ 引了 leaflet.css（不引 → 瓦片错位、控件乱飞）',
  /https:\/\/unpkg\.com\/leaflet@[\d.]+\/dist\/leaflet\.css/.test(PICKER_CODE),
  '没引 Leaflet 样式表',
);
t(
  '★★★ 引了 leaflet.js（不引 → L 未定义，地图出不来）',
  /https:\/\/unpkg\.com\/leaflet@[\d.]+\/dist\/leaflet\.js/.test(PICKER_CODE),
  '没引 Leaflet 脚本',
);
t(
  '★★★ 瓦片来自 tile.openstreetmap.org（免 key）',
  /https:\/\/tile\.openstreetmap\.org\//.test(PICKER_CODE),
  '瓦片地址不对 → 地图加载不出（换成高德还要注意 GCJ-02 偏移）',
);

console.log('');
console.log('=== 2b) ★★★ 瓦片必须多源降级（真机踩过：单源在国内加载不出来）===');
/**
 * ══════════════ ⚠️ 这条断言是补的，因为真机翻车了 ══════════════
 *
 * 第一版只用了 `tile.openstreetmap.org` 一个源。
 * 从开发机测它通（1279ms），**但用户手机上加载不出来** ——
 * 截图里地图一片灰，只有错误提示。国内网络对 OSM 的可达性不稳定。
 *
 * 所以改成按顺序试多个源、失败就换。这里钉住"至少两个源"，
 * 防止以后有人又把它简化回单源。
 *
 * ⚠️ 同时钉住"取到的那行里必须有 tileerror 计数 + 换源逻辑" ——
 *    只写多个源但从不切换等于没做。
 */
t(
  '★★★ 至少配了两个瓦片源（单源在国内不可靠）',
  (PICKER_CODE.match(/url:\s*'https:\/\/[^']*\{z\}/g) ?? []).length >= 2,
  '只有一个瓦片源 → 那个源在国内不通时地图就是一片灰（真机踩过）',
);
t(
  '★★★ 有失败换源逻辑（tileerror 计数 + useSource 递归切换）',
  /tileerror/.test(PICKER_CODE) &&
    /tileErrors\s*\+=\s*1/.test(PICKER_CODE) &&
    /useSource\s*\(\s*srcIndex\s*\)/.test(PICKER_CODE),
  '配了多个源但不会切换 = 等于只有第一个源',
);
t(
  '★★★ 换源时先移除旧图层（否则两个源的瓦片叠在一起）',
  /map\.removeLayer\(\s*tiles\s*\)/.test(PICKER_CODE),
  '不 removeLayer → 旧源瓦片残留，地图看着错位',
);
/**
 * ⚠️ 坐标系约束：**所有瓦片源都必须是 WGS-84**。
 *    高德/腾讯/百度是 GCJ-02，与手机 GPS 差 50~500 米 ——
 *    混进来会让用户围的圈整体偏移，签不上。
 */
t(
  '★★★ 瓦片源里没有混进 GCJ-02 的服务商（高德/腾讯/百度）',
  !/autonavi|gtimg|map\.baidu|tianditu/i.test(PICKER_CODE),
  'GCJ-02 瓦片与 WGS-84 坐标差 50~500 米 → 圈会歪到隔壁楼（要么实现转换，要么别用）',
);

console.log('');
console.log('=== 3) ★★★ 准星固定（拖动地图，不是拖图钉）===');
/**
 * 为什么重要：交互设计就是"手指拖地图、屏幕正中一个固定准星"。
 *    ⚠️ 判据用 `id="cross"`（**HTML 元素**），不是 CSS 里的 `#cross {` 选择器 ——
 *    否则把样式表留着、元素删了，断言照样绿。
 */
t(
  '★★★ HTML 里有固定准星元素 <div id="cross">',
  /<div\s+id=["']cross["']/.test(PICKER),
  '没有准星元素 → 用户不知道该对准哪里',
);

console.log('');
console.log('=== 4) ★★★ postMessage 前缀两端一致（LIFEMAP:）===');
/**
 * 为什么重要：WebView 里除了我们自己的消息，还有 Leaflet 的事件噪音。
 *    前缀就是"哪些消息是我们的"的判据；而且**两端必须用同一个常量**，
 *    两份硬编码只要改一处就会静默失联（地图还能拖，但坐标永远不回传）。
 */
t(
  '★★★ 导出 MAP_MSG_PREFIX = \'LIFEMAP:\'',
  /export\s+const\s+MAP_MSG_PREFIX\s*=\s*['"]LIFEMAP:['"]/.test(PICKER_CODE),
  '协议常量没了 → RN 侧无法识别地图消息',
);
t(
  '★★★ HTML 里的 PREFIX 由 MAP_MSG_PREFIX 注入（不是硬编码第二份）',
  /var\s+PREFIX\s*=\s*\$\{JSON\.stringify\(MAP_MSG_PREFIX\)\}/.test(PICKER) &&
    /postMessage\(\s*PREFIX\s*\+/.test(PICKER),
  'HTML 侧没有引用同一个常量 → 两端前缀可能不一致',
);
/**
 * ⚠️ 剥注释后数 `LIFEMAP:` 字面量：
 *    只应出现 1 次（常量定义本身）。出现第 2 次说明有人在 HTML 里又硬编码了一份，
 *    那样"改一处忘另一处"的静默失联就会重新出现。
 */
{
  const literalCount = (PICKER_CODE.match(/LIFEMAP:/g) ?? []).length;
  t(
    '★★★ 剥注释后 \'LIFEMAP:\' 字面量只出现 1 次（防止两份硬编码）',
    literalCount === 1,
    `出现 ${literalCount} 次`,
  );
}
t(
  '★★ RN 侧按同一常量过滤消息（raw.startsWith(MAP_MSG_PREFIX)）',
  /startsWith\(\s*MAP_MSG_PREFIX\s*\)/.test(PICKER_CODE),
  '不过滤的话 Leaflet 的噪音消息会被当成数据',
);

console.log('');
console.log('=== 5) ★★★ 只在 moveend 回传坐标（不能用 move）===');
/**
 * ⚠️ 为什么重要：`move` 在**拖动过程中每帧**都触发，一次拖动就是几百条
 *    postMessage 进 RN —— 低端机上直接卡住（用户会以为"这地图卡死"）。
 *    `moveend` 只在手指松开后触发一次，这也是这个断言存在的全部理由。
 *
 * ⚠️ 正则必须精确到引号：`map.on('move'` 是 `map.on('moveend'` 的**前缀**，
 *    写成 `/map\.on\('move/` 会把 moveend 自己判成违规（假红）。
 */
t(
  '★★★ 用了 map.on(\'moveend\'',
  /map\.on\(\s*['"]moveend['"]/.test(PICKER_CODE),
  '没有 moveend → 拖完地图不回传坐标',
);
t(
  '★★★ 不存在 map.on(\'move\'（每帧发消息会卡死低端机）',
  !/map\.on\(\s*['"]move['"]/.test(PICKER_CODE),
  '用了 move → 拖动期间每帧 postMessage，低端机卡死',
);

console.log('');
console.log('=== 6) ★★★ 地图 HTML 内联，不依赖 .html 资源文件 ===');
/**
 * ⚠️ 为什么重要：Metro 打包器默认**不把 `.html` 当资源复制进 APK**
 *    （要么配 assetExts、要么走 expo-asset）。用外部 .html 的写法
 *    在开发机上好好的，打出来的包里找不到文件 → 线上白屏。
 *    内联模板字符串**一定能进包**，所以这里必须钉死。
 */
t(
  '★★★ 地图 HTML 是内联模板字符串（return `<!DOCTYPE html>）',
  new RegExp('return\\s+`<!DOCTYPE html>').test(PICKER),
  'HTML 不是内联的 → 打包后可能拿不到 html',
);
t(
  '★★★ 没有引用外部 .html 资源（require/import/uri）',
  !/['"][^'"]*\.html['"]/.test(PICKER_CODE),
  '代码里出现了 .html 资源引用 → Metro 不会自动打包它',
);

console.log('');
console.log('=== 7) ★★★ store 里有 setCourseLocation 这个 action ===');
/**
 * 为什么重要：页面能圈圈，但**没地方保存**就等于没做。
 *    接口声明（CheckinActions）与实现（actions 对象）**缺一个都不行**：
 *    少了实现 → 运行时 `actions.setCourseLocation is not a function`；
 *    少了声明 → TS 编译不过。
 */
{
  const idx = STORE_CODE.indexOf('export interface CheckinActions');
  const iface = idx >= 0 ? sliceDecl(STORE_CODE, idx) : '';
  t(
    '★★★ CheckinActions 接口里有 setCourseLocation 声明',
    /setCourseLocation\s*\(/.test(iface),
    '接口里没有 → TS 编译不过 / 页面拿到的 actions 没有这个方法',
  );
}
t(
  '★★★ actions 实现里有 async setCourseLocation(',
  /async\s+setCourseLocation\s*\(/.test(STORE_CODE),
  '只有声明没有实现 → 运行时 actions.setCourseLocation is not a function',
);
/**
 * 为什么重要：**清除路径**。用户设错了要能撤掉，撤不掉就只能重装。
 *    而且这里必须是 `| null`（不是可选 undefined）—— 注释里写过原因：
 *    PATCH_COURSE 是浅合并，`location: undefined` 在 JSON 序列化时会被丢掉，
 *    变成"看起来清了其实没清"。
 */
t(
  '★★★ 清除路径存在：接口与实现都允许传 null',
  /\|\s*null/.test(sliceDecl(STORE_CODE, STORE_CODE.indexOf('export interface CheckinActions'))) &&
    /\|\s*null/.test(sliceDecl(STORE_CODE, STORE_CODE.indexOf('async setCourseLocation'))),
  '不接受 null → 用户设错了位置没法清除',
);

console.log('');
console.log('=== 8) ★★★ fetchCourses 必须保留本地字段（最重要的一条）===');
/**
 * ══════════════ ⚠️ 这是本次修的 bug，也是整个功能能不能用的前提 ══════════════
 *
 *   `location`（签到圈）与 `autoCheckin`（课程开关）都是**纯本地字段**，
 *   服务端根本不返回。老实现每次都用服务端数据**重新构造** Course 对象：
 *
 *       overview.courses.map((c) => ({ id, name, teacher, autoCheckin: true, ... }))
 *
 *   里面既没有 `location`，又把 `autoCheckin` 硬编码成 true，后果：
 *     · 用户刚在「设置签到位置」圈好的范围 → 下次查一次课程**就没了**，
 *       位置签到又只能用真实 GPS（而且没有任何提示，用户只会觉得"设了没用"）
 *     · 用户关掉的课 → 自己又开回来
 *
 *   所以必须：签名收 `prev`、按课程 id 合并本地字段、**不再硬编码 true**。
 */
{
  const idx = ADAPTER_CODE.indexOf('async fetchCourses(');
  const body = idx >= 0 ? sliceDecl(ADAPTER_CODE, idx) : '';
  t(
    '★★★ fetchCourses 签名带 prev?: Course[]',
    /async\s+fetchCourses\(\s*account:\s*YouxueAccount\s*,\s*prev\?:\s*Course\[\]\s*\)\s*:\s*Promise<Course\[\]>/.test(
      ADAPTER_CODE,
    ),
    '没有 prev 参数 → 实现根本拿不到上一次的本地设置',
  );
  /**
   * 为什么重要：只加参数不合并毫无意义 —— 必须**从上一份数据里把 location 取回来**。
   */
  t(
    '★★★ 函数体里合并了 old?.location（签到圈不会丢）',
    /old\?\.location/.test(body),
    '没合并 location → 用户圈好的范围每次拉课程都会消失',
  );
  /**
   * 为什么重要：同一个 bug 的另一个表现 —— 关掉的课程会自己开回来。
   */
  t(
    '★★★ 函数体里合并了 old?.autoCheckin（课程开关不会自己开回来）',
    /old\?\.autoCheckin/.test(body),
    '没合并 autoCheckin → 用户关掉的课下次拉取又变回开启',
  );
  /**
   * ⚠️ **必须先剥注释再判**：youxueAdapter 的注释里明明白白写着
   *    "（也硬编码 `autoCheckin: true`）"这句历史说明 —— 不剥注释就会把
   *    注释算成命中，把修好的代码报成失败（第一版就踩了这个）。
   */
  t(
    '★★★ 剥注释后不再有硬编码 autoCheckin: true',
    !/autoCheckin\s*:\s*true/.test(ADAPTER_CODE),
    '又出现了硬编码 → 用户关掉的课会自己开回来',
  );
  /**
   * 为什么重要：适配器接口（types.ts）与实现**两处签名必须一致**，
   *    否则调用方按接口传 prev、实现却收不到（或反过来 TS 报错）。
   */
  t(
    '★★★ types.ts 的接口签名也是 (account, prev?: Course[])',
    /fetchCourses\(\s*account:\s*YouxueAccount\s*,\s*prev\?:\s*Course\[\]\s*\)\s*:\s*Promise<Course\[\]>\s*;/.test(
      TYPES_CODE,
    ),
    '接口签名没跟上 → 别的适配器/调用方拿不到 prev',
  );
}

console.log('');
console.log('=== 9) ★★★ 调用方必须把 prev 传进去 ===');
/**
 * ⚠️ 为什么重要：`fetchCourses(account, prev?)` 只是**可选**参数 ——
 *    调用方不传的话，实现里的合并逻辑等于不存在（旧行为原样复现）。
 *    所以"每个调用都带第二个参数"才是这个修复真正落地的地方。
 *    ⚠️ 只统计**剥注释后**的调用：注释里引用的老写法
 *    （`safe(() => adapter.fetchCourses(res.account!), [])`）不算数。
 */
{
  const calls = [...STORE_CODE.matchAll(/fetchCourses\(([^)]*)\)/g)].map((m) => m[1]);
  t(
    '★★★ checkinStore 里每个 fetchCourses( 调用都传了第二个参数',
    calls.length > 0 && calls.every((args) => args.includes(',')),
    `找到 ${calls.length} 处调用，缺 prev 的：${
      calls.filter((a) => !a.includes(',')).length
    } 处`,
  );
}
/**
 * 为什么重要：**手动点「刷新课程」是最容易丢掉设置的路径** ——
 *    用户刚在上一屏圈好，回来点一下刷新就没了，最容易以为是"设了没用"。
 *    这条把"刷新那条路径必须传 prev"单独钉出来，防止以后重构时漏掉。
 */
t(
  '★★★ refreshCourses 走的那次调用显式传了 stateRef.current.courses',
  /async\s+refreshCourses\s*\(\)[\s\S]{0,600}?fetchCourses\(\s*account\s*,\s*stateRef\.current\.courses\s*\)/.test(
    STORE_CODE,
  ),
  '刷新课程不带 prev → 用户刚设好的圈会在这次刷新后消失',
);

console.log('');
console.log('=== 10) ★★★ 位置签到页优先用圈，没圈要能回退 ===');
/**
 * 为什么重要：功能的"最后一公里" —— 圈设好了，提交时必须**优先用它**，
 *    否则这个页面白做（签到还是走真实 GPS，人不在现场就是签不上）。
 */
t(
  '★★★ 位置签到页有 savedCircle（读课程已设的圈）',
  /const\s+savedCircle\s*=\s*defaultCircleFor\(\s*targetCourse\?\.location\s*\)/.test(SIGN_LOC_CODE),
  '没读 Course.location → 设了圈也用不上',
);
t(
  '★★★ 有圈时用 pickInsideWithJitter 在圈内随机取点',
  /pickInsideWithJitter\(\s*savedCircle\s*\)/.test(SIGN_LOC_CODE),
  '没用圈内取点 → 人不在现场签不上',
);
/**
 * ⚠️ 为什么重要：**回退分支不能少，也不能变成"直接拒绝"**。
 *    没有设圈的课程（老用户、第一门课）必须按老行为走真实定位 ——
 *    如果没圈就直接报错拒绝，等于这次改动**弄坏了原来能用的功能**。
 *
 * ⚠️ 2026-10 更新判据：实现从"直接调 `Location.getCurrentPositionAsync`"
 *    改成走**容错封装** `tryGetCurrentPosition`（`utils/geoRuntime`）——
 *    因为没装 Google 服务的手机（国产机基本都是）直接调 `Location.*`
 *    会抛原生异常，把英文报错糊到用户脸上。**回退行为本身没变**，
 *    所以这里跟着换成新函数名，断言要求一个字没放宽。
 */
t(
  '★★★ 没圈时回退真实定位（不是直接拒绝）',
  /if\s*\(\s*savedCircle\s*\)\s*\{[\s\S]{0,2500}?else\s*\{[\s\S]{0,2000}?tryGetCurrentPosition/.test(
    SIGN_LOC_CODE,
  ),
  '没有 else 回退 → 没设圈的课程会被直接拒绝，等于弄坏了老功能',
);
/**
 * ⚠️ 顺带钉住"不能用裸 Location 调用" ——
 *    这正是真机上暴露出来的 bug（无 GMS 手机抛原生异常）。
 */
t(
  '★★★ 位置签到页不直接调裸 Location API（无 GMS 手机会抛异常）',
  !/Location\.(requestForegroundPermissionsAsync|getCurrentPositionAsync)\s*\(/.test(SIGN_LOC_CODE),
  '直接调 Location.* → 没装 Google 服务的手机上报英文原生错误（真机踩过）',
);

console.log('');
console.log('=== 11) ★★★ 圈内取点要留余量（别贴边）===');
/**
 * ⚠️ 为什么重要：服务端会校验坐标是否在老师设的范围内，而且 GPS/换算都有误差。
 *    如果取点取到**圆的边缘**，一点点误差就会被判"不在范围内"→ 签到失败。
 *    所以半径要乘一个 < 1 的系数（留 25% 余量）。
 */
{
  const idx = GEO.indexOf('export function randomPointInCircle');
  const rawBlock = idx >= 0 ? sliceDecl(GEO, idx) : '';
  const codeBlock = stripComments(rawBlock);
  /**
   * ⚠️ 判据必须落在**代码**上（`* 0.75`），不能只看注释里的"25%" ——
   *    注释写了但代码忘了乘，是最典型的假绿。
   */
  t(
    '★★★ 半径计算乘了 0.75（面积均匀取点 + 留余量，看代码不看注释）',
    /Math\.sqrt\([^)]*\)\s*\*\s*0?\.75/.test(codeBlock),
    '半径没留余量 → 取点贴边，一点误差就签到失败',
  );
  t(
    '★★ 注释说明了留 25% 余量的原因（后人别随手删）',
    /(25\s*%|余量)/.test(rawBlock),
    '没有说明为什么留余量 → 容易被当成多余代码删掉',
  );
}

console.log('');
console.log('  ══════════════════════════════════════════════');
console.log('  这份测试盯的是"用户圈的位置不会白设"：');
console.log('    · 页面进得去（路由 + 授权码门槛）');
console.log('    · 地图出得来（Leaflet + OSM，内联 HTML 一定进包）');
console.log('    · 拖得动、不卡（moveend 而不是 move，准星固定）');
console.log('    · 存得下、丢不了（setCourseLocation + fetchCourses 保留本地字段）');
console.log('    · 用得上、退得回（优先圈内随机点，没圈回退真实定位）');
console.log('  ⚠️ 报 XX 就是**实现确实不满足**，不要改断言去迁就。');
console.log('  ══════════════════════════════════════════════');
console.log('');

console.log(`SUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
