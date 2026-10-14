/**
 * 「应用内更新」测试。
 *
 * ══════════════ 需求 ══════════════
 * 「可不可以让他们在应用内部更新」——
 * 以前每次改点东西都要手动传 APK、对方手动装，太累。
 *
 * ══════════════ 为什么不用 OTA 热更新 ══════════════
 * `expo-updates` 只对 **JS 变更**有效；一旦动了原生（加 FileProvider、
 * 装新依赖），必须走 APK 重装 —— 而我们改动经常涉及原生。
 * 所以做的是 **APK 自更新**。
 *
 * ══════════════ Android 的三个硬性要求（缺一不可）══════════════
 *   ① `REQUEST_INSTALL_PACKAGES` 权限（Android 8+）
 *   ② FileProvider（Android 7+ 禁止把 file:// 交给别的 App）
 *      authority 必须是 `<包名>.fileprovider`（expo-file-system 期望的值）
 *   ③ APK 必须下到 `documentDirectory`（= FileProvider 的 <files-path>）
 *
 * 这三条任何一条错了，现象都是"下载成功、点安装没反应 / 报错"，
 * 而且错误信息对用户毫无意义 —— 所以必须有断言盯着。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const UPDATER = fs.readFileSync(path.join(ROOT, 'src', 'services', 'updater.ts'), 'utf8');
const UPD_STORE = fs.readFileSync(path.join(ROOT, 'src', 'state', 'updateStore.tsx'), 'utf8');
/**
 * ★ 启动更新弹窗 —— 强制更新的界面改动在这里（见下面"强制更新"那组断言）。
 */
const DIALOG = fs.readFileSync(
  path.join(ROOT, 'src', 'components', 'UpdatePromptDialog.tsx'),
  'utf8',
);
const WIRE = fs.readFileSync(path.join(ROOT, 'tools', 'android', 'wire-native.cjs'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server', 'server.cjs'), 'utf8');
const WORKER = fs.readFileSync(path.join(ROOT, 'server', 'worker.mjs'), 'utf8');
const HOME = fs.readFileSync(path.join(ROOT, 'src', 'screens', 'tab-index.tsx'), 'utf8');
const SETTINGS = fs.readFileSync(path.join(ROOT, 'src', 'screens', 'settings.tsx'), 'utf8');

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

console.log('=== 1) ★★ Android 侧的两个硬性要求 ===');
{
  t('★ wire-native 加了安装权限', /REQUEST_INSTALL_PACKAGES/.test(WIRE));

  /**
   * ══════════ ★ FileProvider：查下来发现**不需要自己加** ══════════
   *
   * 我一开始自己配了一个 provider + paths，后来读 expo-file-system 的源码才发现：
   *   `getContentUriAsync()` 内部**写死了**用它自己那个 authority：
   *       `${packageName}.FileSystemFileProvider`
   *   而它的 paths 资源已经覆盖了私有 files/cache 目录。
   *
   * ⚠️ 所以自己再加一个是**多余且有害**的：
   *    万一我的 paths 配窄了，content:// URI 反而拿不到文件，
   *    表现为"下载成功、点安装报错"，极难排查。
   *
   * 现在改成**校验上游**：确认 expo-file-system 那个 provider 与 paths 存在。
   */
  const FS_PATHS = path.join(
    ROOT,
    'node_modules',
    'expo-file-system',
    'android',
    'src',
    'main',
    'res',
    'xml',
    'file_system_provider_paths.xml',
  );
  t('★ expo-file-system 自带 FileProvider 的 paths 存在', fs.existsSync(FS_PATHS));
  if (fs.existsSync(FS_PATHS)) {
    const x = fs.readFileSync(FS_PATHS, 'utf8');
    t('★★ 它覆盖了 files-path（documentDirectory 就在这）', /<files-path/.test(x));
    t('★ 也覆盖了 cache-path', /<cache-path/.test(x));
  }
  /**
   * ⚠️ 断言不能写成"源码里不出现 com.lifekit.app.fileprovider" ——
   *    因为我**故意**在清理逻辑里引用了这个字符串（用来识别早期插入的
   *    provider 并删掉它）。要验的是"**不再往里插**"，而不是"不出现这个词"。
   */
  t(
    '★★ 不再插入自定义 provider（但有清理历史遗留的逻辑）',
    !/manifest\.replace\('<\/application>',\s*`\$\{PROVIDER\}/.test(WIRE) && !/const PROVIDER = `/.test(WIRE),
  );
  t('★ 保留了清理遗留的逻辑（否则改了主意会卡死）', /已清理早期插入的多余 provider/.test(WIRE));
  t(
    '★ 注释记录了这个坑（"会插入的东西必须能撤掉"）',
    /会插入的东西.*必须.*撤掉|必须同时能被.*撤掉/.test(WIRE),
  );
  t(
    '★ 注释说明了为什么不需要自己加（避免以后有人又加回去）',
    /expo-file-system \*\*自带\*\*|自带.*FileSystemFileProvider|不需要我们加/.test(WIRE),
  );

  /**
   * ★ 关键：manifest 是 prebuild **生成**的，手改会被覆盖。
   *   必须在这个脚本里自动补 —— 否则下次 prebuild 就悄悄失效了。
   */
  t('★ 安装权限由 wire-native.cjs 自动写入（不是手改 manifest）', /已加安装权限|REQUEST_INSTALL_PACKAGES/.test(WIRE));
  t('★ 校验清单里有这一条（缺了能当场发现）', /Manifest 已加安装权限/.test(WIRE));
}

console.log('\n=== 2) ★ APK 必须下到 documentDirectory ===');
{
  t(
    '★★ 用的是 FileSystem.documentDirectory',
    /FileSystem\.documentDirectory/.test(UPDATER),
  );
  t(
    '★ 注释解释了为什么必须是这个目录（对应 files-path）',
    /files-path|FileProvider 的/.test(UPDATER),
  );
  t('★ 用 content:// 而不是 file://（Android 7+ 硬要求）', /getContentUriAsync/.test(UPDATER));
  t('★ 传给安装器时带了 FLAG_GRANT_READ_URI_PERMISSION', /flags:\s*1/.test(UPDATER));
  t('★ 注释说明了不带 flags 会读不到文件', /FLAG_GRANT_READ_URI_PERMISSION/.test(UPDATER));
}

console.log('\n=== 3) ★ 下载要能看进度、能查完整性 ===');
{
  t('★ 用 createDownloadResumable（能报进度）', /createDownloadResumable/.test(UPDATER));
  t('★ 下载前先删旧文件（防残包被当完整包）', /deleteAsync\(target/.test(UPDATER));
  t('★ 下载后校验大小（下到一半就断能认出来）', /下载不完整/.test(UPDATER));
  t('★ 说明了大文件没进度会让人以为卡死', /三十|30\+ MB|要下几十秒/.test(UPDATER));
}

console.log('\n=== 4) ★★ 版本比较必须用 versionCode，不能比字符串 ===');
{
  t('★★ 用 versionCode 比较', /remoteCode > cur\.versionCode/.test(UPDATER));
  /**
   * ⚠️ 字符串比较会让 "0.9.0" > "0.15.0"（'9' > '1'），
   *    于是新版本反而被判成"不需要更新"。这个坑很隐蔽。
   */
  t('★ 注释点出了这个坑', /0\.9\.0.*0\.15\.0|字符串比较会让/.test(UPDATER));

  // 复刻比较逻辑验证
  function isNewer(remoteCode, remoteVersion, curCode, curVersion) {
    if (Number.isFinite(remoteCode) && remoteCode > 0) return remoteCode > curCode;
    return remoteVersion !== curVersion && remoteVersion > curVersion;
  }
  t('★ 83 → 84 判定为新', isNewer(84, '0.16.0', 83, '0.15.0') === true);
  t('★ 83 → 83 判定为不是新', isNewer(83, '0.15.0', 83, '0.15.0') === false);
  t('★ 83 → 82（降级）判定为不是新', isNewer(82, '0.14.0', 83, '0.15.0') === false);
  // 反面对照：字符串比较会错
  t('★ （对照）字符串比较确实会判错 "0.9.0" vs "0.15.0"', '0.9.0' > '0.15.0' === true);
}

console.log('\n=== 5) ★ 失败要静默 / 提示要能照做 ===');
{
  t('★★ 连不上服务器时静默失败（不能弹错打扰用户）', /静默失败/.test(UPD_STORE));
  t('★ 只有手动检查才报错', /manual \? 'error' : 'idle'/.test(UPD_STORE));
  /**
   * ⚠️ "没开安装未知应用"是最常见的失败，
   *    原始错误（ActivityNotFound）对用户毫无意义，必须翻译。
   */
  t('★★ 把安装失败翻译成"去设置里打开开关"的指引', /安装未知应用/.test(UPD_STORE));
  t('★ 同时保留原始错误（便于排查）', /原始错误/.test(UPD_STORE));
  t('★ 有防并发检查（用户狂点/启动与手动撞上）', /busyRef/.test(UPD_STORE));
}

console.log('\n=== 6) 启动静默检查 + 手动入口 ===');
{
  t('★ 启动后延时检查（不拖慢冷启动）', /setTimeout\([\s\S]{0,120}?6000/.test(UPD_STORE));
  t('★ 注释说明了为什么延后', /拖慢冷启动/.test(UPD_STORE));
  t('★ App.tsx 挂上了 UpdateProvider', fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8').includes('UpdateProvider'));
  t('★ 首页有新版本提示', /有新版本/.test(HOME));
  t('★ 首页显示下载进度', /正在下载新版本/.test(HOME));
  t('★ 首页有"更新失败"提示', /更新失败/.test(HOME));
  t('★ 设置页有版本与更新模块', /版本与更新/.test(SETTINGS));
  t('★ 设置页能手动检查', /upd\.actions\.check\(true\)/.test(SETTINGS));
  t('★ 手动检查会显示"已是最新"（否则点了没反应像坏了）', /已是最新版本/.test(SETTINGS));
}

console.log('\n=== 7) ★ 服务端接口（端到端实测）===');
{
  t('★ /api/version 存在', /'\/api\/version'/.test(SERVER));
  t('★ APK 下载路由存在', /\/apk\/lifekit-latest\.apk/.test(SERVER));
  t('★★ 用流式返回（30+MB 不能整个读进内存）', /createReadStream\(file\)\.pipe\(res\)/.test(SERVER));
  t('★ Content-Type 正确', /application\/vnd\.android\.package-archive/.test(SERVER));
  t('★ 这两个接口都不要管理口令（App 要能匿名检查）', /p === '\/api\/version'\) return false/.test(SERVER));
  t('★ URL 用请求里的 Host 拼（保证与实际访问方式一致）', /req\.headers\.host/.test(SERVER));
  t('★ 没有安装包时明确说不available', /服务器上还没有放安装包/.test(SERVER));
  t('★ Worker 版也回了明确原因（云端放不下）', /云端版不提供安装包下载/.test(WORKER));

  // ── 真的起服务打一遍 ──
  (async () => {
    const PORT = 8794;
    const dataFile = path.join(ROOT, 'server', 'data.json');
    const backup = fs.existsSync(dataFile) ? fs.readFileSync(dataFile, 'utf8') : null;
    process.env.LIFEKIT_PORT = String(PORT);
    const origLog = console.log;
    const mod = require(path.join(ROOT, 'server', 'server.cjs'));
    await mod.start(PORT);
    console.log = origLog;

    const get = (p) =>
      new Promise((res, rej) => {
        http
          .get(`http://127.0.0.1:${PORT}${p}`, (r) => {
            const c = [];
            r.on('data', (d) => c.push(d));
            r.on('end', () => res({ s: r.statusCode, h: r.headers, b: Buffer.concat(c) }));
          })
          .on('error', rej);
      });

    try {
      const v = await get('/api/version');
      t('★★ GET /api/version 返回 200', v.s === 200);
      const j = JSON.parse(v.b.toString());
      t('★ available=true（已发布安装包）', j.available === true);
      t('★ 版本号与服务端 version.json 一致', j.versionCode > 0 && typeof j.version === 'string');
      t('★ 给了绝对下载地址', /^http:\/\/.+\/apk\/lifekit-latest\.apk$/.test(j.url ?? ''));
      t('★ 给了体积（App 要显示给用户）', typeof j.sizeBytes === 'number' && j.sizeBytes > 1000000);

      const a = await get('/apk/lifekit-latest.apk');
      t('★★ GET 安装包返回 200', a.s === 200);
      t('★★ 返回的体积与 version 里声明的一致', a.b.length === j.sizeBytes, `${a.b.length} vs ${j.sizeBytes}`);
      t('★ Content-Type 是 Android 安装包', /vnd\.android\.package-archive/.test(a.h['content-type'] ?? ''));
      t('★ 带 attachment（浏览器会存下来）', /attachment/.test(a.h['content-disposition'] ?? ''));
      /** ★ APK 的魔数：必须是 PK（zip），否则文件是坏的 */
      t('★★ 下载回来的确实是 APK（PK 魔数）', a.b[0] === 0x50 && a.b[1] === 0x4b);

      const nf = await get('/apk/nonexistent.apk');
      t('★ 不存在的路径 404', nf.s === 404);
    } catch (e) {
      t('端到端测试', false, e.message);
    } finally {
      mod.server.close();
      await new Promise((r) => setTimeout(r, 200));
      if (backup !== null) fs.writeFileSync(dataFile, backup, 'utf8');
    }

    section89();
    console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
    process.exit(fail === 0 ? 0 : 1);
  })().catch((e) => {
    console.log('  异常：' + (e?.stack ?? e));
    process.exit(1);
  });
}

/** 第 8、9、10 节 —— 弹窗、首页板块、连发多版本 */
function section89() {
console.log('\n=== 8) ★★ 启动弹窗（可关闭、关了不丢、换版本会重弹）===');
{
  const DIALOG = fs.readFileSync(path.join(ROOT, 'src', 'components', 'UpdatePromptDialog.tsx'), 'utf8');
  const APP = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8');

  t('★ 弹窗组件存在', /export function UpdatePromptDialog/.test(DIALOG));
  t('★★ 挂在 App 里（不是某个页面里）—— 切 tab 也不会丢', /<UpdatePromptDialog \/>/.test(APP));
  t('★ 弹窗在 RouterProvider 之内（能盖在任何页面之上）', /<NavigationShell \/>[\s\S]{0,400}?<UpdatePromptDialog \/>/.test(APP));
  t('★ 有「以后再说」按钮', /label="以后再说"/.test(DIALOG));
  t('★ 有「现在更新」按钮', /label="现在更新"/.test(DIALOG));
  t('★★ 明确写了"关闭后去首页检查更新"（需求要求）', /关闭后可在「首页 → 检查更新」里继续/.test(DIALOG));
  t('★ 显示了新旧版本对比', /当前 \$\{upd\.current\.version\}/.test(DIALOG) && /最新 \$\{info\.version\}/.test(DIALOG));
  t('★ 显示了本次更新说明', /本次更新：/.test(DIALOG));
  /**
   * ⚠️ 点背景**不该**关闭这个弹窗（与"改签到状态"那个不同）：
   *    这是"要不要现在更新"的决定，误触关掉会让人以为没提示过。
   */
  t('★ 点背景不关闭（避免误触）', !/backdrop[\s\S]{0,200}?onPress=\{\(\) => upd\.actions\.dismissPrompt/.test(DIALOG));

  // ── store 侧的行为 ──
  t('★ store 暴露 dismissPrompt', /dismissPrompt\(\): void/.test(UPD_STORE));
  t('★ 有 promptVisible 状态', /promptVisible: boolean/.test(UPD_STORE));
  /**
   * ⚠️ 这条断言**改过一次**：原先钉的是
   *      `const shouldPrompt = !manual && dismissedRef.current !== r.info.versionCode`
   *
   *    2026-10 加了强制更新（用户：「这次更新要设置为强制更新，
   *    有人要用我的诊断工具」）→ 表达式变成
   *      `const forced = r.info.force === true;`
   *      `const shouldPrompt = forced || (!manual && dismissedRef.current !== ...)`
   *
   *    所以现在钉三件事：
   *      ① 自动检查才弹（手动不弹）这条**旧规则仍在**
   *      ② 强制时**无视**旧规则（否则关一次就绕过去了）
   *      ③ 强制标记只在服务端明确 true 时才认
   */
  t(
    '★★ 只有自动检查才弹（手动检查不弹）',
    /!manual && dismissedRef\.current !== r\.info\.versionCode/.test(UPD_STORE),
  );
  t(
    '★★★ 强制更新时无视"手动不弹"与"关过不弹"',
    /const forced = r\.info\.force === true/.test(UPD_STORE) &&
      /shouldPrompt = forced \|\|/.test(UPD_STORE),
  );
  t(
    '★★★ 强制标记只在服务端明确 true 时才认（缺字段按不强制）',
    /force: j\.force === true/.test(UPDATER),
  );
  t(
    '★★★ 强制模式下 dismiss / dismissPrompt 都直接返回（关不掉）',
    /if \(state\.forceUpdate\) return;/.test(UPD_STORE),
  );
  t(
    '★★★ 强制时弹窗无条件渲染（不受 6 秒延迟窗口影响）',
    /if \(!forced && !upd\.promptVisible\) return null;/.test(DIALOG),
  );
  /**
   * ★★ 最关键的一条：关掉记的是**版本号**，不是布尔。
   *    只记布尔的话，关掉 0.17 后发 0.18 就再也看不到弹窗了。
   */
  t('★★ 记住的是"关掉的版本号"而不是一个布尔', /dismissedRef\.current !== r\.info\.versionCode/.test(UPD_STORE));
  t('★★ 关掉的版本号会持久化', /STORE_KEYS\.updatePromptDismissed/.test(UPD_STORE));
  t('★ 存储键已登记', /updatePromptDismissed: 'updatePromptDismissed'/.test(
    fs.readFileSync(path.join(ROOT, 'src', 'services', 'storage.ts'), 'utf8'),
  ));
  t('★ 注释解释了为什么不能用布尔', /只记布尔的话[\s\S]{0,90}?漏掉更新|只记"关过了"（布尔）/.test(UPD_STORE));
  t('★ 注释说明了"关弹窗 ≠ 不想更新"（首页板块必须留着）', /不是"我不想更新了"/.test(UPD_STORE));
  t('★ 开始下载时收起弹窗（别挡着看进度）', /phase: 'downloading'[\s\S]{0,90}?promptVisible: false/.test(UPD_STORE));
  t('★ 检查到没有新版本时也收起弹窗', /phase: 'uptodate'[\s\S]{0,120}?promptVisible: false/.test(UPD_STORE));
}

console.log('\n=== 9) ★「检查更新」板块常驻首页 ===');
{
  t('★ 首页有「检查更新」板块', /<Section title="检查更新"/.test(HOME));
  t('★ 平时显示当前版本', /当前版本 \$\{upd\.current\.version\}/.test(HOME));
  t('★ 平时有「检查更新」按钮（手动查）', /label=\{upd\.phase === 'checking' \? '检查中…' : '检查更新'\}/.test(HOME));
  t('★ 点了走手动检查（check(true)）', /upd\.actions\.check\(true\)/.test(HOME));
  t('★ 有新版本时显示「去更新」', /actionLabel="去更新"/.test(HOME));
  t('★ 下载中显示进度', /正在下载新版本…/.test(HOME));
  /**
   * ⚠️ 板块必须**常驻**（而不是"有更新才出现"）——
   *    否则弹窗被关掉之后就再也找不到入口了。
   *
   * 验法：源码里那个 `) : (` 的 else 分支必须存在且带着「检查更新」按钮。
   * 用 indexOf 而不是正则 —— 正则里的括号要转义，容易写错。
   */
  const idx = HOME.indexOf('<Section title="检查更新"');
  const tail = idx >= 0 ? HOME.slice(idx, idx + 3000) : '';
  t('★★ 板块常驻：有 else 分支显示「检查更新」按钮', tail.includes(') : (') && tail.includes("'检查更新'"));
}

console.log('\n=== 10) ★★ 连发多个版本时只提示最新的 ===');
{
  /**
   * 服务器上**只有一份** APK（每次发布覆盖），所以 App 拿到的
   * 永远是"当前最新那个"，不存在"要先装 0.17 再装 0.18"。
   *
   * 这里验两件事：
   *   ① publish 脚本确实是覆盖而不是追加
   *   ② 版本比较是"只比大小"，所以跳版本也能一步到位
   */
  const PUB = fs.readFileSync(path.join(ROOT, 'tools', 'publish-apk.cjs'), 'utf8');
  t('★★ 发布脚本是覆盖同一个文件（服务器上只有一份）', /lifekit-latest\.apk'\).*|const LATEST = path\.join\(SERVER_APK_DIR, 'lifekit-latest\.apk'\)/.test(PUB));
  t('★ 发布脚本 copyFileSync 覆盖（不是改名保存多个）', /fs\.copyFileSync\(apk, LATEST\)/.test(PUB));
  t('★ 版本信息也是覆盖', /fs\.writeFileSync\(\s*META/.test(PUB));

  /**
   * ⚠️ 写 version.json 必须**显式指定 utf8**。
   *    Node 默认也是 utf8，但这条依赖太隐晦 ——
   *    万一以后有人换了写法，"更新说明里的中文"就会变成乱码，
   *    而乱码是在用户手机上才看到的，这边很难发现。
   *
   *    （我自己验过一次：用 PowerShell 5.1 读这个文件会显示乱码，
   *      那是"读"的问题不是"写"的问题，差点误判成 bug。）
   */
  /**
   * ⚠️ 这条断言**放宽过一次**：原先窗口是 300 字符。
   *    后来在写 version.json 的对象里加了 `force` 字段（带一段注释说明），
   *    把末尾的 `'utf8'` 挤到 300 字符之外 → 报假红。
   *
   *    窗口放宽到 1200 —— 要钉的是"**确实传了 utf8**"，
   *    而不是"它在第几个字符"。
   */
  t(
    '★★ version.json 显式按 utf8 写（防止中文说明乱码）',
    /fs\.writeFileSync\(\s*META[\s\S]{0,1200}?'utf8'/.test(PUB),
  );

  // 真的读回来验一遍中文
  const realMeta = path.join(ROOT, 'server', 'apk', 'version.json');
  if (fs.existsSync(realMeta)) {
    const rawBuf = fs.readFileSync(realMeta);
    let text = '';
    let ok = true;
    try {
      // fatal:true → 不是合法 UTF-8 会抛错
      text = new TextDecoder('utf-8', { fatal: true }).decode(rawBuf);
    } catch {
      ok = false;
    }
    t('★ 实际写出来的 version.json 是合法 UTF-8', ok);
    if (ok) {
      const j = JSON.parse(text);
      console.log(`  实际 note = ${JSON.stringify(j.note ?? '')}`);
      t('★★ 里面的中文没有乱码（无替换字符）', !text.includes('\uFFFD'));
      t('★ 版本号读得出来', Boolean(j.version) && Number(j.versionCode) > 0);
    }
  }

  // 复刻"跳过多个版本"的判定
  function needsUpdate(remoteCode, curCode) {
    return remoteCode > curCode;
  }
  const CASES = [
    ['用户 0.16(84)，服务器 0.19(87) → 一步到位提示 0.19', needsUpdate(87, 84), true],
    ['用户 0.18(86)，服务器 0.19(87) → 提示', needsUpdate(87, 86), true],
    ['用户已是最新 0.19(87) → 不提示', needsUpdate(87, 87), false],
    ['服务器版本比本机旧（回滚）→ 不提示', needsUpdate(85, 87), false],
  ];
  for (const [label, got, expect] of CASES) {
    const ok = got === expect;
    console.log(`  ${ok ? '√' : '×'} ${label}`);
    if (ok) pass += 1;
    else fail += 1;
  }

  // 关掉旧版本弹窗后，新版本仍要弹
  const dismissed = 86; // 用户关掉了 0.18 的弹窗
  for (const [remote, shouldPrompt] of [
    [86, false],
    [87, true],
    [88, true],
  ]) {
    const got = dismissed !== remote;
    const ok = got === shouldPrompt;
    console.log(`  ${ok ? '√' : '×'} 关掉 ${dismissed} 的弹窗后，服务器出 ${remote} → ${got ? '重新弹' : '不弹'}`);
    if (ok) pass += 1;
    else fail += 1;
  }
}
}
