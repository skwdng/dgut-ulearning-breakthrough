/**
 * 确认 APK 里真的有这次要交付的东西（避免"改了但没进包"）。
 *
 * ══════════ 为什么要专门验 ══════════
 * 之前踩过一次：万能码换了个新值，测试全绿、包也构建成功，
 * 但**那个常量根本没进包**，装到手机上毫无变化，查了很久。
 * 从那以后，每次交付前都直接在 APK 里找关键词。
 *
 * 用法: node tools/verify-apk-content.cjs <apk路径>
 */
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const APK = process.argv[2] ?? path.resolve(__dirname, '..', 'LifeKit-v0.9.6-universal.apk');

if (!fs.existsSync(APK)) {
  console.error(`  × 找不到 APK: ${APK}`);
  process.exit(1);
}

const buf = fs.readFileSync(APK);

/** 读 zip 中央目录 */
function readCentralDirectory(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('找不到 zip 结尾记录');
  const count = buf.readUInt16LE(eocd + 10);
  let o = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(o) !== 0x02014b50) break;
    const method = buf.readUInt16LE(o + 10);
    const csize = buf.readUInt32LE(o + 20);
    const nameLen = buf.readUInt16LE(o + 28);
    const extraLen = buf.readUInt16LE(o + 30);
    const commentLen = buf.readUInt16LE(o + 32);
    const lo = buf.readUInt32LE(o + 42);
    const name = buf.subarray(o + 46, o + 46 + nameLen).toString('utf8');
    o += 46 + nameLen + extraLen + commentLen;
    entries.push({ name, method, csize, lo });
  }
  return entries;
}

function readEntry(buf, e) {
  const l1 = buf.readUInt16LE(e.lo + 26);
  const l2 = buf.readUInt16LE(e.lo + 28);
  const start = e.lo + 30 + l1 + l2;
  const raw = buf.subarray(start, start + e.csize);
  return e.method === 0 ? raw : zlib.inflateRawSync(raw);
}

const entries = readCentralDirectory(buf);
console.log(`  APK: ${path.basename(APK)}  ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
console.log(`  zip 条目: ${entries.length}`);
console.log('');

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

// ── 1) JS bundle ──
console.log('=== 1) JS bundle（业务逻辑）===');
{
  const e = entries.find((x) => x.name.includes('index.android.bundle'));
  if (!e) {
    t('找到 index.android.bundle', false);
  } else {
    const js = readEntry(buf, e);
    // bundle 是 Hermes 字节码，中文以 UTF-16LE 存
    const u16 = js.toString('utf16le');
    const utf8 = js.toString('utf8');

    const has = (s) => u16.includes(s) || utf8.includes(s);

    for (const [label, key] of [
      ['账号隔离：切换提示', '已切换到账号'],
      ['账号隔离：清空说明', '已清空上一个账号的缓存数据'],
      ['授权码：无效时可重填', '当前保存的授权码没有通过校验，可以重新填写'],
      ['授权码：清除入口', '清除当前保存的授权码'],
      ['权限范围：万能码', '万能码权限 · 可改任何人的状态'],
      ['权限范围：个人码', '个人授权码权限 · 只能改自己的'],
      ['服务器：标题', '管理服务器（选填）'],
      ['服务器：用途', '不填也能用：万能码退回 App 内置的那个'],
      ['签到未授权拦截', '签到未授权'],
      ['换账号失效提示', '授权码不属于当前登录的学号'],
      // ★ 适配器单例会话语义修复（换账号后仍查旧数据的真正根因）
      ['账号不匹配报错', '查询结果属于另一个账号'],
      ['丢弃错误结果', '已丢弃这次结果'],
      ['要求重新绑定', '请到「优学院 → 换账号」重新绑定后再查'],
      // ★ 功能模块页：必须能看到模块名字（原先只有一个图标）
      ['模块名：优学院', '优学院'],
      ['模块说明（已改成讲作业与课件）', '查看没做完的作业与没看完的课件'],
      ['任务入口说明（已纠正）', '列出没做完的作业与没看完的课件'],
      ['模块状态标签：待授权', '待授权'],
      ['模块状态标签：此设备不支持', '此设备不支持'],
      ['模块状态文案', '状态：'],
      /*
       * ⚠️ 不要在这里断言"万能码 · 长期有效"不存在 ——
       *    那个字符串是 licenseCode.ts 生成消息用的，删掉首页那一行之后
       *    **它仍然在代码里**（只是不再被首页显示）。
       *    这类"UI 移除了"的检查必须看组件源码，不能看字符串是否存在，
       *    否则会得到假阳性。见下面 check-tab-index 那一段。
       */
    ]) {
      t(label, has(key), key);
    }
  }
}
console.log('');

// ── 2) 原生 dex ──
console.log('=== 2) classes*.dex（原生模块）===');
{
  /**
   * ⚠️ 必须搜**所有** dex，不能只看 classes.dex。
   *    实测 WebCookieModule 被分到了 classes3.dex ——
   *    只搜第一个会误报"改了但没进包"（第一版就这么错了）。
   */
  const dexes = entries.filter((x) => x.name.endsWith('.dex'));
  t(`找到 dex 文件（${dexes.length} 个）`, dexes.length > 0);

  const all = dexes.map((d) => readEntry(buf, d).toString('utf8')).join('\n');

  for (const [label, key] of [
    ['WebCookieModule 类', 'WebCookieModule'],
    ['CAS 提示前缀', 'CAS 提示'],
    ['错误容器 showErrorTipSpan', 'showErrorTipSpan'],
    ['错误容器 formErrorTip', 'formErrorTip'],
    ['兜底话术：密码错误', '用户名或密码错误'],
    ['兜底话术：账号锁定', '账号被锁定'],
    ['不自动跟重定向（方法名）', 'setInstanceFollowRedirects'],
    ['AES/CBC 加密', 'AES/CBC/PKCS5Padding'],
  ]) {
    t(label, all.includes(key), key);
  }
}
console.log('');

// ── 3) 清单与版本 ──
console.log('=== 3) 清单 ===');
{
  t('有 AndroidManifest.xml', entries.some((x) => x.name === 'AndroidManifest.xml'));
  t('有多架构 so', entries.filter((x) => x.name.endsWith('.so')).length >= 4);
}

console.log('');
console.log(`  SUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
