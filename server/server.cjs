/**
 * LifeKit 管理服务端 —— 零依赖，只用 Node 内置模块。
 *
 * 用途：
 *   ① 记录所有填过优学院学号的用户（谁、什么学号、什么时候登的、有没有授权）
 *   ② 提供「万能码」的读取与修改 —— **改了立刻生效，不用重新打包 App**
 *   ③ 提供网页管理界面（/admin）
 *
 * 为什么放服务端：万能码写死在 App 里的话，每改一次都要重新打包+重装。
 * 放到这里，在网页上改一下，App 下次校验就用新码。
 *
 * ⚠️ 数据存在 server/data.json（明文 JSON）。这是**宿舍局域网自用**的规模，
 *    没有做用户体系/加密。真要放公网必须先加登录鉴权。
 *
 * 启动：双击 start.cmd，或在 server/ 下 `node server.cjs`
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { generateLicenseCode } = require('./licenseCode.cjs');

// ---------------------------------------------------------------- 配置

const PORT = Number(process.env.LIFEKIT_PORT || 8787);

/**
 * ══════════════ 数据文件位置 ══════════════
 *
 * 默认就是同目录下的 `data.json`（部署到云端时就是 `/opt/lifekit/data.json`）。
 *
 * `LIFEKIT_DATA_FILE` 是给**测试**用的：让测试起一个隔离实例，
 * 打到临时文件上，**绝不碰真实数据**。
 *
 * ⚠️⚠️ 但这个变量必须带防护 —— 它是"改变数据落盘位置"的东西，
 *      万一被设成真实文件（或某个不该写的路径），一次测试就能把
 *      用户记录覆盖掉。而云端那份 data.json **没有别的备份**。
 *
 * 防护规则（三条都满足才接受）：
 *   ① 文件名必须以 `_` 开头 或 含 `test` —— 明确是测试用的命名
 *   ② 解析后的绝对路径必须在 server/ 目录内
 *   ③ 不能就是 data.json 本身
 *
 * 不满足就**忽略这个变量并打印警告**，退回默认 —— 宁可测试失败，
 * 也不能赌"这次设对了"。
 */
function resolveDataFile() {
  const fallback = path.join(__dirname, 'data.json');
  const raw = process.env.LIFEKIT_DATA_FILE;
  if (!raw) return fallback;

  const abs = path.resolve(raw);
  const base = path.basename(abs);
  const reasons = [];
  if (!/^_/.test(base) && !/test/i.test(base)) {
    reasons.push('文件名既不以 _ 开头也不含 test');
  }
  const serverDir = path.resolve(__dirname);
  if (!abs.startsWith(serverDir + path.sep)) reasons.push('不在 server/ 目录内');
  if (abs === path.resolve(fallback)) reasons.push('就是真实的 data.json');

  if (reasons.length) {
    console.warn(
      `\n  ⚠️ 忽略 LIFEKIT_DATA_FILE=${raw}\n` +
        `     原因：${reasons.join('；')}\n` +
        `     这是防止测试误改真实数据的防护，已退回 ${fallback}\n`,
    );
    return fallback;
  }
  console.log(`  （测试模式）数据文件：${abs}`);
  return abs;
}

const DATA_FILE = resolveDataFile();

/**
 * 管理页的位置。
 *
 * 找两个地方，按顺序：
 *   ① 服务端同目录的 manage.html  —— 拷到桌面/U 盘后能独立运行
 *   ② ../web/manage.html          —— 在工程目录里跑时用这个
 */
const ADMIN_HTML_CANDIDATES = [
  path.join(__dirname, 'manage.html'),
  path.join(__dirname, '..', 'web', 'manage.html'),
];

function findAdminHtml() {
  for (const p of ADMIN_HTML_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* 忽略 */
    }
  }
  return null;
}

/**
 * 默认万能码。
 *
 * ⚠️ 公开仓库版（2026-10）：原先硬编码，现在从环境变量取 ——
 *    仓库是公开的，写死在源码里等于把"能改任何人签到"的能力公开。
 *
 *    自建时用环境变量指定自己的码：
 *        LIFEKIT_MASTER_CODE=你的码 node server/server.cjs
 *    或者启动后在管理后台里改（那会写进 data.json 的 masterCodeHash）。
 *
 *    不设 → `CHANGE_ME`。这是个**故意不能用**的占位符：
 *    忘了设就登录不进去，而不是用一个全世界都知道的码。
 */
const DEFAULT_MASTER_CODE = process.env.LIFEKIT_MASTER_CODE || 'CHANGE_ME';

// ---------------------------------------------------------------- 存储

/**
 * ══════════════ ★ 万能码为什么改成"只存哈希" ══════════════
 *
 * 原先服务端**存明文**、App 通过 `GET /api/master` **把明文取回去**自己比对。
 * 那有个后果：**抓包就能看到万能码** —— 而万能码能改所有人的签到状态。
 *
 * 现在改成：
 *   ① 服务端只存 `masterCodeHash`（FNV-1a 双种子，16 位 hex）
 *   ② App 不再取回明文，改成把**用户输入**发到 `/api/verify-master`
 *   ③ 服务端回 `{valid/ok}` —— 整个过程里**网络上不出现万能码本身**
 *
 * ⚠️ 为什么不加盐 / 不用强哈希：
 *    这是个**很短的码**（2-32 位字母数字），攻击者可以暴力枚举 ——
 *    任何快速哈希都挡不住离线暴力。加盐只挡彩虹表，对短码意义有限。
 *    这里的目标是**"别让它在网络上裸奔"**，不是抗暴力破解。
 *    真要抗暴力，得改成服务端随机发放的长令牌 + 限流，那是另一套设计。
 *    （限流以后可以加：这个接口本该是最该限流的那个。）
 */
const MASTER_HASH_TAG = 'fnv1a2:';

function normMasterCode(s) {
  return String(s ?? '').replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
}

function hashMasterCode(code) {
  const s = normMasterCode(code);
  const fnv = (seed) => {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  };
  return (
    MASTER_HASH_TAG +
    fnv(0x811c9dc5).toString(16).padStart(8, '0') +
    fnv(0x9e3779b9).toString(16).padStart(8, '0')
  );
}

/**
 * 校验一个候选万能码。
 *
 * 兼容旧数据：如果 db 里还是明文（`masterCode`），就比对明文；
 * 比对成功后顺手迁移成哈希 —— 这样老服务器不用手动改数据。
 */
function verifyMasterCode(db, candidate) {
  const cand = normMasterCode(candidate);
  if (!cand) return false;

  if (typeof db.masterCodeHash === 'string' && db.masterCodeHash) {
    return hashMasterCode(cand) === db.masterCodeHash;
  }
  // ── 旧数据：明文 ──
  if (typeof db.masterCode === 'string' && db.masterCode) {
    const ok = normMasterCode(db.masterCode) === cand;
    if (ok) {
      // 迁移：立刻换成哈希，并把明文删掉
      db.masterCodeHash = hashMasterCode(cand);
      delete db.masterCode;
    }
    return ok;
  }
  // 两个都没有 → 用默认码
  return normMasterCode(DEFAULT_MASTER_CODE) === cand;
}

const EMPTY_DB = {
  /** 万能码的哈希（**不再是明文**） */
  masterCodeHash: hashMasterCode(DEFAULT_MASTER_CODE),
  /** 修改记录，便于回溯谁什么时候改的 */
  masterCodeHistory: [],
  /** 用户：key = 学号 */
  users: {},
  /**
   * 管理口令（HTTP Basic）。
   *
   * ══════════ 为什么必须要有 ══════════
   * 服务是监听 0.0.0.0 的 —— 同一个 WiFi 下**任何人都能打开管理页**，
   * 看到所有人的学号、改万能码、把人踢下线。
   * 十几到几十个人用的时候，这不可能接受。
   *
   * 留空 = 不启用（仍然可用，但启动时会明确警告"局域网内谁都能进"）。
   */
  adminPassword: '',
};

function loadDb() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const j = JSON.parse(raw);
    return {
      /**
       * ⚠️ 优先读哈希。但**保留明文字段**以兼容旧数据文件 ——
       *    老服务器上 data.json 里存的是明文的 `masterCode` 字段，
       *    如果这里直接丢掉，用户原来的万能码就"失效"了。
       *    首次校验成功后会自动迁移成哈希（见 verifyMasterCode）。
       */
      masterCodeHash:
        typeof j.masterCodeHash === 'string' && j.masterCodeHash ? j.masterCodeHash : '',
      ...(typeof j.masterCode === 'string' && j.masterCode ? { masterCode: j.masterCode } : {}),
      masterCodeHistory: Array.isArray(j.masterCodeHistory) ? j.masterCodeHistory : [],
      users: j.users && typeof j.users === 'object' ? j.users : {},
      adminPassword: typeof j.adminPassword === 'string' ? j.adminPassword : '',
    };
  } catch {
    return JSON.parse(JSON.stringify(EMPTY_DB));
  }
}

let db = loadDb();

function saveDb() {
  // 先写临时文件再改名 —— 避免写一半断电把数据弄坏
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

/** 简单的输入清洗 */
function clean(s, max = 64) {
  return String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
}

// ---------------------------------------------------------------- 管理口令

/**
 * 哪些路径需要管理口令。
 *
 * ⚠️ 只保护**管理面**，不保护 App 用的接口 ——
 *    否则 App 每个请求都要带凭据，而凭据放进 APK 就等于公开。
 *
 *   受保护（管理页与它的接口）：
 *     /admin  /api/users  /api/user/*  /api/master(POST)  /api/issue  /api/export
 *     /api/admin/*  （口令自身的读写）
 *   不保护（App 用，本身就是给终端用户调用的）：
 *     /api/ping  /api/master(GET)  /api/register  /api/grant
 */
const PROTECTED_PREFIXES = ['/admin', '/manage', '/api/users', '/api/user/', '/api/issue', '/api/export', '/api/admin/'];
function isProtected(p, method) {
  // 读万能码是 App 要用的，放行；只有**修改**才需要口令
  if (p === '/api/master' && method === 'GET') return false;
  if (p === '/api/master' && method === 'POST') return true;
  // 口令自身的查询与**首次**设置不需要口令（否则永远启用不了）；
  // 修改已有口令的校验在路由里单独做。
  if (p === '/api/admin/password') return false;
  /**
   * ★ 配额校验接口（新增）—— 必须是 App 调的，**不能**要口令。
   *   App 每次写操作前都会来问一次"还能不能用"。
   */
  if (p === '/api/consume') return false;
  /**
   * ★ 应用内更新：检查版本 + 下载安装包 —— 也必须是 App 调的。
   *   它只暴露"有新版本吗、多大"，不含任何用户数据。
   */
  if (p === '/api/version') return false;
  /**
   * ⚠️ 两条通道的安装包都**免鉴权**（App 要能直接下载，不该弹密码框）。
   *
   * ⚠️ 2026-10：`/apk/lifekit-self.apk` 已从白名单删除 ——
   *    自用通道连同那个含明文万能码的 APK 一起下架了。
   *    它现在既不在下载路由里、也不在免鉴权白名单里，
   *    所以任何请求都会先被鉴权拦住（然后 404）。
   */
  if (p === '/apk/lifekit-latest.apk' || p === '/apk/latest.apk' || p === '/apk/lifekit-test.apk')
    return false;
  if (p === '/') return true; // 根路径就是管理页
  return PROTECTED_PREFIXES.some((x) => p.startsWith(x));
}

// ---------------------------------------------------------------- 应用内更新

/**
 * 读安装包信息。
 *
 * 约定：管理页上传的新 APK 放在 `server/apk/lifekit-latest.apk`，
 * 旁边放一个 `version.json` 描述版本号。
 *
 * ⚠️ 为什么不从 APK 里解析版本：Node 没有内置解析 APK 的能力，
 *    引一个库不值当。**由上传脚本顺手写一个 version.json 更简单可靠**。
 *    见 tools/publish-apk.cjs。
 */
/**
 * ══════════════ ★★★ 版本通道（正式 / 测试 / 自用）══════════════
 *
 * 需求（用户 2026-10）：
 *   「帮我新开一个测试版，用于测试，完成后再向正式版更新，
 *     上面的安装包我已经发出去了，不要动那个」
 *
 * ⚠️ 两条通道必须有**各自独立的文件**：
 *
 *     ch=release（默认）→  apk/lifekit-latest.apk   + version.json
 *     ch=test           →  apk/lifekit-test.apk      + version-test.json
 *
 * ⚠️ 默认**必须是 release** —— 老客户端不带 `?ch=` 参数，
 *    它们必须继续看到正式版（否则已发出的包会被测试版更新掉）。
 *
 * ══════════════ ★★★ 2026-10：自用通道已删除（安全改进）══════════════
 *
 * 用户要求「把自用版删除吧」（三个版太麻烦，只留正式版和测试版）。
 *
 * ⚠️ 这不只是"少维护一条通道"，还是**一次安全收紧**：
 *    自用版的 APK **内含明文万能码**，而它的权限是"能改任何人的签到状态"。
 *    它之前被上传到云端、**可通过 `/apk/lifekit-self.apk` 下载** ——
 *    也就是说任何人只要猜到文件名就能拿到万能码。
 *
 *    现在这个通道没了，**服务器上不再有任何含万能码的安装包**。
 *
 * ⚠️ 传 `ch=self` 会怎样：落到 `release`（见 channelOf）——
 *    已装的自用版会看到正式版的版本信息。这是预期行为：
 *    自用版已停止维护，它要么升到正式版，要么就不再更新。
 */
function channelOf(ch) {
  if (ch === 'test') return 'test';
  return 'release';
}

/** 各通道对应的文件名 */
const CHANNEL_FILES = {
  release: { apk: 'lifekit-latest.apk', meta: 'version.json' },
  test: { apk: 'lifekit-test.apk', meta: 'version-test.json' },
};

function readApkMeta(channel = 'release') {
  const ch = channelOf(channel);
  const files = CHANNEL_FILES[ch];
  const dir = path.join(__dirname, 'apk');
  const apk = path.join(dir, files.apk);
  const metaFile = path.join(dir, files.meta);
  if (!fs.existsSync(apk)) return null;

  let version = '';
  let versionCode = 0;
  let note = '';
  /**
   * ══════════════ ★★★ 强制更新标记 ══════════════
   *
   * 用户需求（原话）：
   *   「这次更新要设置为强制更新，有人要用我的诊断工具」
   *
   * 背景：1.1.1 之前的包里带着「接口测试器」（能对任意 /apps/... 发
   * POST/DELETE），属于开发期工具。如果不强制，装了旧包的人可以一直
   * 不更新、继续用那些工具。
   *
   * ⚠️ 所以 `version.json` 里加一个 `force` 字段，由发布脚本写
   *    （tools/publish-apk.cjs 的 `--force`）。
   * ⚠️ 默认 **false** —— 不能让"忘了设"变成"把所有人锁死"。
   */
  let force = false;
  try {
    const j = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    version = String(j.version ?? '');
    versionCode = Number(j.versionCode ?? 0);
    note = String(j.note ?? '');
    force = j.force === true;
  } catch {
    /* 没有 version.json 也让它能下载，只是版本号未知 */
  }

  const stat = fs.statSync(apk);
  return {
    version,
    versionCode,
    note,
    force,
    sizeBytes: stat.size,
    updatedAt: stat.mtimeMs,
    channel: ch,
    /** App 拿这个去下载（见 /api/version 里拼的绝对地址） */
    apkPath: `/apk/${files.apk}`,
  };
}

// ---------------------------------------------------------------- 配额

/**
 * ══════════════ 配额（截止时间 + 次数）══════════════
 *
 * 需求原话：
 *   「所有人默认的授权码生效时间是永久，然后生效次数是无限次，
 *     次数根据改了几次状态来算，我可以在管理端自由设定生效时间和次数，
 *     生效时间要设置截止时间，注意不能设定当时之前的时间」
 *
 * 两个维度：
 *   · `codeExpiresAt` —— 截止时间（null = 永久）
 *     ⚠️ 这个**也编进了授权码本身**（2 字节天数），所以 App 断网时
 *        本地就能判到期 —— 不需要服务器参与。
 *   · `maxUses` / `usedCount` —— 次数上限与已用次数（null = 不限）
 *     ⚠️ 次数**只能靠服务器记**：本地计数一清数据就归零，等于没限。
 *        所以写操作前要调 `/api/consume` 问服务器。
 *
 * 默认：永久 + 不限（也就是"什么都不用设"）。
 */

/**
 * 校验某个学号现在还能不能执行写操作；**通过就记一次**。
 *
 * 返回 `{ allow, reason, used, maxUses, expiresAt, permanent }`
 *
 * ⚠️ 顺序很重要：先判能不能用，**通过之后**才 usedCount + 1。
 *    失败时绝不计数 —— 否则"被拒绝也扣次数"会把用户逼疯。
 *
 * ℹ️ 这里**不解析授权码里的到期日**：数据库里的 `codeExpiresAt`
 *    就是权威值，签发时两者用的是同一个时间戳。
 *    （码里那份是给 App 断网时本地兜底用的，见 licensesCode.ts。）
 */
function consumeQuota(studentId) {
  const u = db.users[studentId];
  if (!u) {
    // 没登记在服务器上 → 不拦（宽松策略，与 entitlement 一致）
    return { allow: true, reason: 'not_registered', used: 0, maxUses: null, expiresAt: null, permanent: true };
  }

  // ── ① 截止时间 ──
  const exp = typeof u.codeExpiresAt === 'number' ? u.codeExpiresAt : null;
  if (exp && Date.now() > exp) {
    return {
      allow: false,
      reason: 'expired',
      used: u.usedCount ?? 0,
      maxUses: u.maxUses ?? null,
      expiresAt: exp,
      permanent: false,
    };
  }

  // ── ② 次数 ──
  const max = typeof u.maxUses === 'number' && u.maxUses > 0 ? u.maxUses : null;
  const used = typeof u.usedCount === 'number' && u.usedCount >= 0 ? u.usedCount : 0;
  if (max !== null && used >= max) {
    return { allow: false, reason: 'quota_exhausted', used, maxUses: max, expiresAt: exp, permanent: false };
  }

  // ── ③ 通过 → 计数 ──
  u.usedCount = used + 1;
  u.lastUsedAt = Date.now();
  saveDb();
  return {
    allow: true,
    reason: 'ok',
    used: u.usedCount,
    maxUses: max,
    expiresAt: exp,
    permanent: exp === null && max === null,
  };
}

/** 定长比较，避免用响应时间试探口令 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length !== bb.length) return false;
  try {
    return require('node:crypto').timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/**
 * 校验 HTTP Basic 凭据。返回 true 表示放行。
 *
 * ⚠️ 没设口令时**一律放行**（保持原来的用法不变），
 *    但启动时会明确警告 —— 局域网内谁都能进管理页。
 */
function checkAdminAuth(req) {
  if (!db.adminPassword) return true; // 未启用口令
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  let decoded = '';
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  const user = decoded.slice(0, i);
  const pass = decoded.slice(i + 1);
  // 用户名固定为 admin（够用；重点是那个口令）
  return safeEqual(user, 'admin') && safeEqual(pass, db.adminPassword);
}

/** 要求浏览器弹出口令输入框 */
function askAuth(res) {
  /**
   * ⚠️ HTTP 头的值**只能是 ASCII** —— 这里踩过一次：
   *    原先写了 `realm="LifeKit 管理后台"`，中文直接让 Node 抛
   *    `ERR_INVALID_CHAR: Invalid character in header content`，
   *    **服务当场崩掉**（不是返回 401）。
   *    realm 用英文，中文提示放在**响应体**里（响应体可以是 UTF-8）。
   */
  const body = '需要管理口令（请在弹出的输入框里填 admin + 口令）';
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="LifeKit Admin", charset="UTF-8"',
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ---------------------------------------------------------------- 工具

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    // 让管理页（file:// 或别的端口）也能调
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(text);
}

function html(res, code, text) {
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      // 防超大数据：管理接口不会有大 body
      if (size > 256 * 1024) {
        req.destroy();
        resolve({});
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/**
 * 取本机 IPv4 地址，并**按网段给出类型提示**。
 *
 * 为什么需要类型提示：电脑常常同时有几个网卡
 * （有线 / WiFi / 手机热点 / 虚拟网卡），用户不知道该把哪个填进手机。
 * 实测网段特征：
 *   192.168.43.x / 192.168.137.x → 手机热点最常见
 *   192.168.0-42.x / 192.168.44-255.x → 家用路由器
 *   10.x / 172.16-31.x → 校园网或虚拟网卡（VPN、WSL、虚拟机）
 */
function localAddressEntries() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;

      const ip = ni.address;
      let kind = '局域网';
      if (/^192\.168\.(43|137)\./.test(ip)) kind = '★ 手机热点（多半就是它）';
      else if (/^192\.168\./.test(ip)) kind = '家用路由器';
      else if (/^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) kind = '校园网 / 虚拟网卡';
      else if (/^169\.254\./.test(ip)) kind = '无效地址（没连上网）';

      out.push({ name, address: ip, kind });
    }
  }
  // 热点排最前 —— 用户最可能需要它
  out.sort((a, b) => (a.kind.startsWith('★') ? -1 : 0) - (b.kind.startsWith('★') ? -1 : 0));
  return out;
}

/** 兼容旧调用：只要地址数组 */
function localAddresses() {
  return localAddressEntries().map((x) => x.address);
}

// ---------------------------------------------------------------- 路由

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  // 预检
  if (req.method === 'OPTIONS') return json(res, 204, {});

  /**
   * ── 管理口令 ──
   * 保护管理页与它的接口。App 用的那几个接口不受影响
   *（见 isProtected 的说明：把凭据放进 APK 等于公开）。
   */
  if (isProtected(p, req.method) && !checkAdminAuth(req)) {
    return askAuth(res);
  }

  // ── 管理页 ──
  if (p === '/' || p === '/admin' || p === '/manage') {
    const file = findAdminHtml();
    if (!file) {
      return html(
        res,
        500,
        '<meta charset="utf-8"><h3>找不到管理页 manage.html</h3>' +
          '<p>请把它和 server.cjs 放在同一个目录里。</p>',
      );
    }
    try {
      return html(res, 200, fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return html(res, 500, `管理页读取失败：${e.message}`);
    }
  }

  /**
   * ══════════ App 用：查某个学号有没有被授权 ══════════
   *
   * ⚠️ 这个接口**故意不要求管理口令**，原因：
   *    口令是给"管理面"（管理页）用的；App 里的凭据会被打进 APK，
   *    那等于公开，加了也没意义。
   *
   * 踩过的坑：起先 App 是直接调 `/api/users`（完整用户列表）来判断授权的，
   * 后来给管理面加了口令 → `/api/users` 变成 401 →
   * **App 永远查不到授权状态** → "管理员远程关掉某人"这个功能悄悄失效了
   * （表面上不报错，只是永远走"未知、不拦"的分支）。
   * 所以拆出这个接口：**只回答一个学号的是/否**，不泄露任何列表。
   */
  /**
   * ══════════════ ★★★ "算不算已授权" 的唯一判据 ══════════════
   *
   * 用户需求原话：「我希望别人不能从我的 app 里得到这些功能的完成」
   *
   * ══════════════ 原先的漏洞（两个叠在一起）══════════════
   *
   * ① `/api/auth-state` 对**未知学号**回 `authorized: true`
   *    注释写着"服务器里没这个学号 → 当作不拦（宽松策略）"。
   * ② `/api/register`（App 每次登录都会调）对**新学号**默认
   *    `authorized: prev?.authorized ?? true` —— 自动标记成已授权。
   *
   * 后果：别人装上 App → 用自己的优学院账号登录 → App 上报 register
   *      → 服务端**自动给他建记录并标记已授权**。
   *      **完全不需要管理员发授权码。**
   *
   * ══════════════ 现在的判据 ══════════════
   *
   * "被授权" = 有记录 **且** authorized **且 有管理员签发的授权码**。
   *   授权码（LK1- 开头，由 /api/issue 生成）才是"被授权"的**唯一凭据** ——
   *   因为它是由管理员针对某个学号签发的，别人造不出来（码里带签名）。
   *
   * ⚠️ 为什么还要看 `authorized` 而不是只看有没有码：
   *    管理页可以把某个人的授权**关掉**（authorized=false）而不删码。
   *    那种情况下必须拦住，所以两个条件都要满足。
   */
  const isGranted = (u) => Boolean(u && u.authorized && u.code && /^LK1-/.test(u.code));

  /**
   * 下载安装包与版本查询**不需要授权**（公开）。
   * 见 requireAuth 里对 /api/version 与 /apk/ 的放行。
   */

  if (p === '/api/auth-state') {
    const sid = clean(url.searchParams.get('studentId'), 32);
    if (!sid) return json(res, 400, { ok: false, error: '缺少 studentId' });
    const u = db.users[sid];
    /**
     * ⚠️ 未知学号现在回 **false**（改之前是 true）。
     *    App 那边 `entitled = unlocked && serverAuth !== 'denied'`，
     *    所以 false 会让它判成 denied → 拦住没被签发过的人。
     *
     * ★ 仍然保留"服务器连不上就不拦"的降级策略 ——
     *   那在 **App 端**（serverAuth==='unknown' 时放行），不在这里。
     *   这里只回答"服务器知不知道这个人被授权了"。
     */
    return json(res, 200, {
      ok: true,
      studentId: sid,
      known: Boolean(u),
      /** 有管理员签发的授权码才算被授权 */
      authorized: isGranted(u),
    });
  }

  /**
   * ══════════ ★ 配额校验（App 用，写操作前调用）══════════
   *
   * 需求：「次数根据改了几次状态来算」——
   * 次数**只有服务器记得住**（本地计数一清数据就归零），
   * 所以 App 在每次写操作（签到 / 改状态）**之前**来这里问一次：
   *   · 能 → 服务端顺手 usedCount + 1，App 继续写
   *   · 不能 → 返回原因（到期 / 次数用完），App 拦住并不写
   *
   * ⚠️ 请求体里带 `code`：这个接口是公开的（App 要调），
   *    带上码可以顺便确认"问的人和码是对应的"，避免别人拿学号乱刷计数。
   *
   * ⚠️ 这个接口配合"授权码本身"，构成了双层防线：
   *    码里编了到期日 → 断网也能挡到期
   *    服务器记次数   → 次数无法被本地清除绕过
   */
  if (p === '/api/consume' && req.method === 'POST') {
    const body = await readBody(req);
    const studentId = clean(body.studentId, 32);
    const code = clean(body.code, 64);
    if (!studentId) return json(res, 400, { ok: false, error: '缺少 studentId' });

    /**
     * 如果带了码，就确认它确实是发给这个学号的 ——
     * 防止有人用别人的学号来蹭计数（虽然这只会浪费他自己的次数）。
     *
     * ══════════════ ★★★ 这里修过一个真实的 bug（2026-10）══════════════
     *
     * 用户反馈：用**万能码**改签到状态，报「这个授权码不属于当前学号」，
     * 而设置页明明显示「万能码 · 长期有效 · 可用」。
     *
     * 根因：原来的判断是
     *     `if (u?.code && u.code !== code) → code_mismatch`
     * 它要求"传上来的码必须等于**服务器给这个学号发的那份个人码**"。
     * 于是：
     *     · 用户传万能码（内置码 / LKM- 签名码）
     *     · 服务器记录里该学号的码是 `LK1-XXXXX-…`（个人码）
     *     · 两者不等 → **判定"码与学号不符" → 把万能码拦死了**
     *
     * ⚠️ 也就是说：只要服务器上存着该学号的个人码，万能码就永远过不去。
     *    这个校验**完全没考虑万能码**，是漏写的分支。
     *
     * 修法：**先认万能码** —— 是万能码就放行（它本来就不属于任何学号），
     *      只有个人码才需要跟该学号登记的码比对。
     */
    if (code) {
      const isMaster = verifyMasterCode(db, code);
      if (!isMaster) {
        const u = db.users[studentId];
        if (u?.code && u.code !== code) {
          /**
           * ══════════════ ★★★ 报错信息改清楚（2026-10，真实排查教训）══════════════
           *
           * 原来只说「这个授权码不属于当前学号」。
           * 用户截图报这个错，我查了很久才定位 —— 真正原因是：
           *   App 里存着一份**早就作废的旧个人码**（服务器换过码），
           *   而"万能码被改 → 降级用个人码"那条路把它送了上来。
           *
           * ⚠️ 报错信息必须让用户**知道下一步做什么**，否则他只会以为功能坏了。
           */
          return json(res, 200, {
            ok: true,
            allow: false,
            reason: 'code_mismatch',
            message:
              '这个授权码不是服务器上登记的那份（多半是旧的、已作废的码）。\n' +
              '解决：到「小操作 → 授权码」点**清除**，然后重新填一次码。\n' +
              '推荐直接填**万能码**（它不绑学号、不会过期）。',
          });
        }
      }
    }

    const r = consumeQuota(studentId);
    const MESSAGES = {
      ok: '可以使用',
      expired: '授权已过期，请联系管理员',
      quota_exhausted: `授权次数已用完（${r.used}/${r.maxUses} 次），请联系管理员`,
      not_registered: '服务器上没有这个学号，按不限次处理',
      code_mismatch: '授权码与学号不符',
    };
    return json(res, 200, { ok: true, ...r, message: MESSAGES[r.reason] ?? '' });
  }

  /**
   * ══════════ ★ 应用内更新：版本信息 + APK 下载 ══════════
   *
   * 需求：「可不可以让他们在应用内部更新」——
   * 每次改点东西都要手动传 APK 太累，App 自己检查并下载安装。
   *
   * ⚠️ 这个接口**故意不要口令**：App 要能匿名检查更新。
   *    它只暴露"有新版本吗、多大、改了什么"，不含任何用户数据。
   */
  if (p === '/api/version') {
    /**
     * ★ 版本通道：`?ch=test` 走测试通道，不带（或 ch=release）走正式通道。
     * ⚠️ 默认 release —— 已发出的老客户端不带参数，必须继续看到正式版。
     */
    const ch = channelOf(url.searchParams.get('ch'));
    const meta = readApkMeta(ch);
    /**
     * ★ 服务器身份 —— 让 App 那边能**看出自己连的是哪台**。
     *
     * ══════════════ 为什么需要这个 ══════════════
     * 有两台服务器在跑同一套代码：
     *   · 宿舍局域网那台（桌面管理后台）
     *   · 自建者自己那台（公网地址由部署时的 LIFEKIT_HOST 决定）
     * 而 App 的服务器地址**默认就指向阿里云**，也可以手动改成局域网。
     *
     * 于是出现一个很难自查的问题：
     *   「我检查更新是好的，但到底连的是哪台？」
     *   `版本号一样` 就分不出来 —— 两台的版本号当然一样。
     *
     * 把这个值回给 App，界面上就能直接显示主机名，一眼分辨。
     */
    const serverName = `${os.hostname()}`;
    if (!meta) {
      return json(res, 200, {
        ok: true,
        available: false,
        channel: ch,
        server: serverName,
        message: ch === 'test' ? '测试通道上还没有安装包' : '服务器上还没有放安装包',
      });
    }
    return json(res, 200, {
      ok: true,
      available: true,
      channel: ch,
      version: meta.version,
      versionCode: meta.versionCode,
      sizeBytes: meta.sizeBytes,
      note: meta.note ?? '',
      /**
       * ★ 强制更新标记 —— App 收到 true 时**不让用户关掉更新弹窗**。
       *   见 server.cjs 顶部 readApkMeta 里的说明，以及
       *   src/components/UpdatePromptDialog.tsx。
       */
      force: meta.force === true,
      server: serverName,
      /**
       * ⚠️ 给的是**绝对地址**：App 那边可能配的是局域网 IP 或公网 IP，
       *    这里用请求里的 Host 拼出来，保证与实际访问方式一致。
       *    路径按通道取（测试通道给 /apk/lifekit-test.apk）。
       */
      url: `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}${meta.apkPath}`,
      updatedAt: meta.updatedAt,
    });
  }

  /**
   * ── 下载安装包 ──
   *
   * ⚠️ 用流式返回，不要整个读进内存（APK 有 30+ MB，
   *    两台手机同时下就可能把 2G 内存的机器压出问题）。
   */
  /**
   * ⚠️ 2026-10：`/apk/lifekit-self.apk` 这个路径**已删除**。
   *
   * 那个 APK 含明文万能码（能改任何人的签到状态），而它可以被直接下载 ——
   * 只要猜到文件名就能拿到。自用版删除后它不该再存在，
   * 所以这里**连路径判断一起去掉** —— 任何人请求它都会落到 404。
   *
   * ⚠️ 如果服务器磁盘上还留着 `server/apk/lifekit-self.apk`，
   *    它已经**无法通过 HTTP 取到**了，但建议手工删掉（见部署说明）。
   */
  if (
    p === '/apk/lifekit-latest.apk' ||
    p === '/apk/latest.apk' ||
    p === '/apk/lifekit-test.apk'
  ) {
    /**
     * ★ 按路径取对应通道的文件。
     *   /apk/lifekit-latest.apk（或 latest.apk）→ 正式通道
     *   /apk/lifekit-test.apk                  → 测试通道
     * ⚠️ 两条通道**文件独立** —— 互不覆盖。
     */
    const fileName = p === '/apk/lifekit-test.apk' ? 'lifekit-test.apk' : 'lifekit-latest.apk';
    const file = path.join(__dirname, 'apk', fileName);
    if (!fs.existsSync(file)) {
      return json(res, 404, {
        ok: false,
        error:
          fileName === 'lifekit-test.apk' ? '测试通道上还没有安装包' : '服务器上还没有安装包',
      });
    }
    const stat = fs.statSync(file);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': stat.size,
      // 让手机浏览器/下载器知道这是个要存下来的文件
      'Content-Disposition': `attachment; filename="${
        fileName === 'lifekit-test.apk' ? 'LifeKit-test.apk' : 'LifeKit.apk'
      }"`,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
    return;
  }

  // ── 健康检查 ──
  if (p === '/api/ping') {
    const entries = localAddressEntries();
    return json(res, 200, {
      ok: true,
      at: Date.now(),
      /**
       * ⚠️ 明确标记"不是云端"。
       *    管理页靠这个字段决定显示什么：
       *      云端 → 显示浏览器正在用的那个公网地址
       *      本地 → 列出各网卡的局域网地址
       *    不标的话管理页会去列 172.17.x.x 那种私有 IP，
       *    用户照填必然连不上（云端版踩过这个坑）。
       */
      cloud: false,
      addresses: entries.map((x) => x.address),
      /** 带网卡名与类型提示，方便用户判断该填哪个 */
      addressesDetail: entries,
      port: PORT,
      /** 是否已启用管理口令（App 不用它，只作信息展示） */
      hasAdminPassword: Boolean(db.adminPassword),
    });
  }

  /**
   * ── 管理口令的设置 / 查询 ──
   *
   * GET  ：只返回"有没有设"，**不需要口令**（管理页靠它决定提示文案）
   * POST ：设置新口令
   *        · 首次设置（当前为空）→ 放行，否则就没法启用了
   *        · 修改（当前非空）    → 必须带旧口令（由上面的 isProtected 拦）
   */
  if (p === '/api/admin/password') {
    if (req.method === 'GET') {
      return json(res, 200, { ok: true, enabled: Boolean(db.adminPassword) });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const next = clean(body.password, 64);

      // 修改时必须先通过旧口令校验
      if (db.adminPassword && !checkAdminAuth(req)) return askAuth(res);

      if (next && next.length < 4) {
        return json(res, 400, { ok: false, error: '口令至少 4 位' });
      }
      db.adminPassword = next;
      saveDb();
      console.log(next ? '[口令] 已启用管理口令' : '[口令] 已关闭管理口令（局域网内任何人可访问）');
      return json(res, 200, { ok: true, enabled: Boolean(next) });
    }
    return json(res, 405, { ok: false, error: '不支持的方法' });
  }

  /**
   * ══════════ ★ 校验万能码（App 用，**不回传万能码本身**）══════════
   *
   * 这是把"网络上不出现万能码"落地的那个接口。
   *
   * 以前的做法：App 调 `GET /api/master` **把明文取回去**自己比对 ——
   * 抓包就能看到万能码。现在改成：App 把**用户输入的**发过来，
   * 服务端只回"对不对"。
   *
   * 返回里**不含任何关于正确答案的信息**（不返回长度、不返回前缀、
   * 不做"接近了"之类的提示）—— 否则又能被逐步逼近。
   *
   * ⚠️ 这个接口故意不加管理口令：它是给**普通用户**在 App 里填码用的。
   * ⚠️ 它也是最该限流的接口（短码可暴力枚举）。当前规模未加；
   *    如果以后放开到很多人用，第一件事就是给它加限流。
   */
  if (p === '/api/verify-master' && req.method === 'POST') {
    const body = await readBody(req);
    const candidate = clean(body.code, 64);
    const valid = verifyMasterCode(db, candidate);
    if (valid && db.masterCodeHash) {
      // 兼容旧数据时可能刚完成迁移，落盘一次
      saveDb();
    }
    return json(res, 200, { ok: true, valid });
  }

  /**
   * ── 读万能码状态 ──
   *
   * ⚠️ **不再返回万能码本身**。
   *    App 现在走 `/api/verify-master`，不需要明文了。
   *    这里只说明"有没有设置"，供管理页显示。
   *    （管理页要"看"码是看不到了 —— 因为服务端也不再存明文。
   *      想知道当前码是什么，只能靠你自己记；忘了就在管理页重设一个。）
   */
  if (p === '/api/master' && req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      /** 仅供信息展示，不含码 */
      hasMasterCode: true,
      /** 兼容：老 App 会读 masterCode。给了空串，让它走降级而不是把错码当好码 */
      masterCode: '',
      deprecated: '请改用 POST /api/verify-master（不再回传万能码明文）',
    });
  }

  /**
   * ── 签发授权码（管理页用）──
   *
   * 需求：「我自己输入学号生成码，然后发给他，码和学号对应上才能用签到」。
   *
   * 与 /api/grant 的区别：
   *   · grant  ：App 用万能码解锁时顺带领码（会累加登录次数）
   *   · issue  ：管理员**主动**为某个学号签发（不累加登录次数）
   *
   * 生成的码是**个人授权码**（LK1- 开头，内嵌学号哈希），
   * 所以：
   *   · 只能给这个学号用，转给别人填会被 App 拒（哈希对不上）
   *   · 与万能码完全独立，改万能码不影响它
   */
  if (p === '/api/issue' && req.method === 'POST') {
    const body = await readBody(req);
    const studentId = clean(body.studentId, 32);
    if (!studentId) return json(res, 400, { ok: false, error: '缺少学号' });
    if (!/^[0-9A-Za-z]{4,32}$/.test(studentId)) {
      return json(res, 400, { ok: false, error: '学号只能是 4-32 位字母或数字' });
    }

    const now = Date.now();
    const prev = db.users[studentId] ?? null;

    /**
     * ★ 截止时间（选填）。
     *   ⚠️ **不能设成过去** —— 需求原话：「注意不能设定当时之前的时间」。
     *      设成过去等于发出去就是废码，而且从界面上看不出来。
     *      这里留 60 秒容差，避免"刚好点到现在"被误拒。
     */
    let expiresAt = prev?.codeExpiresAt ?? null;
    if (body.expiresAt !== undefined) {
      if (body.expiresAt === null || body.expiresAt === '') {
        expiresAt = null; // 永久
      } else {
        const t = Number(body.expiresAt);
        if (!Number.isFinite(t)) return json(res, 400, { ok: false, error: '截止时间格式不对' });
        if (t < now - 60_000) {
          return json(res, 400, { ok: false, error: '截止时间不能是过去的时间' });
        }
        expiresAt = t;
      }
    }

    // ★ 次数上限（选填，null = 不限）
    let maxUses = prev?.maxUses ?? null;
    if (body.maxUses !== undefined) {
      if (body.maxUses === null || body.maxUses === '' || body.maxUses === 0) {
        maxUses = null; // 不限次数
      } else {
        const n = Number(body.maxUses);
        if (!Number.isInteger(n) || n <= 0) {
          return json(res, 400, { ok: false, error: '次数上限必须是正整数' });
        }
        if (n > 100000) return json(res, 400, { ok: false, error: '次数上限太大（最多 100000）' });
        maxUses = n;
      }
    }

    /*
     * 复用已有码的前提是**有效期没变** —— 因为到期日编在码里。
     * 改了截止时间就必须重新生成，否则码里的日期还是旧的，
     * App 断网时会按旧日期判到期（两边不一致）。
     */
    const prevCodeExpiry = prev?.codeExpiresAt ?? null;
    const expiryChanged = prevCodeExpiry !== expiresAt;

    let code = !expiryChanged && prev?.code && /^LK1-/.test(prev.code) ? prev.code : '';
    let reused = Boolean(code);
    if (!code) {
      try {
        code = expiresAt ? generateLicenseCode(studentId, { expiresAt }) : generateLicenseCode(studentId);
      } catch (e) {
        return json(res, 500, { ok: false, error: `生成授权码失败：${e.message}` });
      }
    }

    db.users[studentId] = {
      studentId,
      studentName: clean(body.studentName, 32) || prev?.studentName || '',
      school: clean(body.school, 48) || prev?.school || '',
      tenant: prev?.tenant || 'dgut',
      boundAt: prev?.boundAt ?? now,
      // 管理员签发不等于"他登录过"，所以不累加登录次数
      lastLoginAt: prev?.lastLoginAt ?? null,
      loginCount: prev?.loginCount ?? 0,
      authorized: true,
      code,
      /** null = 永久有效 */
      codeExpiresAt: expiresAt,
      /** null = 不限次数 */
      maxUses,
      /** 已用次数：改了截止时间或次数上限**不重置**（避免靠改设置刷次数） */
      usedCount: prev?.usedCount ?? 0,
      lastUsedAt: prev?.lastUsedAt ?? null,
      note: clean(body.note, 200) || prev?.note || '',
      /** 标记来源：管理员签发 */
      issuedByAdmin: true,
      issuedAt: prev?.issuedAt ?? now,
    };
    saveDb();

    console.log(
      `[签发] ${studentId} → ${code}${reused ? '（复用已有）' : ''}` +
        `　有效期=${expiresAt ? new Date(expiresAt).toISOString().slice(0, 10) : '永久'}` +
        `　次数=${maxUses ?? '不限'}`,
    );
    return json(res, 200, {
      ok: true,
      studentId,
      code,
      reused,
      user: db.users[studentId],
    });
  }

  /**
   * ── 用万能码解锁：自动下发这个学号的**个人授权码** ──
   *
   * 需求：
   *   填了万能码的人可以改**任何人**的状态；
   *   同时自动记录该学号对应的个人授权码；
   *   万能码一改，他们降级为个人码权限（只能改自己）。
   *
   * 所以这里做两件事：
   *   ① 生成（或复用）该学号的个人码，记进用户档案
   *   ② 把码返回给 App，App 存下来 —— 以后万能码变了还能用这份
   *
   * ⚠️ 调用方必须先自己校验万能码对不对（App 那边已经比过了）。
   *    这里只负责"发码 + 记账"。
   */
  if (p === '/api/grant' && req.method === 'POST') {
    const body = await readBody(req);
    const studentId = clean(body.studentId, 32);
    if (!studentId) return json(res, 400, { ok: false, error: '缺少学号' });

    const now = Date.now();
    const prev = db.users[studentId] ?? null;

    // 已有个人码就复用（保证同一个学号永远是同一份码，方便管理员核对）
    let code = prev?.code && /^LK1-/.test(prev.code) ? prev.code : '';
    if (!code) {
      try {
        code = generateLicenseCode(studentId);
      } catch (e) {
        return json(res, 500, { ok: false, error: `生成授权码失败：${e.message}` });
      }
    }

    db.users[studentId] = {
      studentId,
      studentName: clean(body.studentName, 32) || prev?.studentName || '',
      school: clean(body.school, 48) || prev?.school || '',
      tenant: clean(body.tenant, 16) || prev?.tenant || 'dgut',
      boundAt: prev?.boundAt ?? now,
      lastLoginAt: now,
      loginCount: (prev?.loginCount ?? 0) + 1,
      authorized: prev?.authorized ?? true,
      /** ★ 个人授权码 —— 万能码用完后的降级凭据 */
      code,
      /**
       * ⚠️ 配额字段必须**继承**而不是重置 ——
       *    重建用户对象时漏掉/写死就等于把管理员的设置悄悄清空。
       *    踩过的坑：这里原先写 `codeExpiresAt: null`，
       *    于是"领一次个人码"就把管理员设的截止时间抹掉了。
       */
      codeExpiresAt: prev?.codeExpiresAt ?? null,
      maxUses: prev?.maxUses ?? null,
      usedCount: prev?.usedCount ?? 0,
      lastUsedAt: prev?.lastUsedAt ?? null,
      note: prev?.note ?? '',
      /** 记录他是通过万能码获得这份码的 */
      grantedByMaster: true,
      grantedAt: prev?.grantedAt ?? now,
    };
    saveDb();

    console.log(`[授权] 万能码解锁 ${studentId} → 个人码 ${code}`);
    return json(res, 200, {
      ok: true,
      studentId,
      /** 该学号的个人授权码（App 存下来，万能码失效后用它） */
      personalCode: code,
      user: db.users[studentId],
    });
  }

  /**
   * ── 改万能码（管理页用）──
   *
   * ⚠️ 只存哈希，**不回显新码**。
   *    改完只有管理员自己知道新码是什么（他刚输入的）。
   *    忘了就在这个页面重设一个 —— 服务端也拿不回旧的。
   */
  if (p === '/api/master' && req.method === 'POST') {
    const body = await readBody(req);
    const next = clean(body.masterCode, 32);
    if (!next) return json(res, 400, { ok: false, error: '万能码不能为空' });
    if (!/^[0-9A-Za-z]{2,32}$/.test(next)) {
      return json(res, 400, { ok: false, error: '只能是 2-32 位字母或数字' });
    }
    /**
     * 历史记录里**也不存明文** —— 只存长度。
     * 原先存的是 from/to 明文，等于把所有用过的万能码都留在磁盘上，
     * 一旦 data.json 泄漏，历史码全暴露（而很多人会复用旧码）。
     */
    const prevLen = db.masterCodeHash ? null : normMasterCode(db.masterCode ?? '').length;
    db.masterCodeHash = hashMasterCode(next);
    delete db.masterCode;
    db.masterCodeHistory.unshift({
      at: Date.now(),
      /** 只记长度，不记内容 */
      fromLen: prevLen,
      toLen: normMasterCode(next).length,
    });
    db.masterCodeHistory = db.masterCodeHistory.slice(0, 100);
    saveDb();
    console.log('[万能码] 已更新（只存哈希，日志不记录内容）');
    // ⚠️ 响应里**不含** masterCode
    return json(res, 200, { ok: true, updated: true });
  }

  // ── 注册/更新用户（App 登录成功后上报）──
  if (p === '/api/register' && req.method === 'POST') {
    const body = await readBody(req);
    const studentId = clean(body.studentId, 32);
    if (!studentId) return json(res, 400, { ok: false, error: '缺少学号' });

    const now = Date.now();
    const prev = db.users[studentId] ?? null;
    const name = clean(body.studentName, 32);

    db.users[studentId] = {
      studentId,
      // 姓名以"最后一次填的"为准，但空值不覆盖已有的
      studentName: name || prev?.studentName || '',
      school: clean(body.school, 48) || prev?.school || '',
      tenant: clean(body.tenant, 16) || prev?.tenant || 'dgut',
      boundAt: prev?.boundAt ?? now,
      lastLoginAt: now,
      loginCount: (prev?.loginCount ?? 0) + 1,
      /**
       * ══════════════ ★★★ 这里原来是漏洞 ══════════════
       *
       * 原来是 `authorized: prev?.authorized ?? true` ——
       * **新学号默认已授权**。而这个接口是 App 每次登录都会调的，
       * 于是"别人装上 App 用自己的账号登录"就等于自动获得授权，
       * 完全绕过了管理员的授权码。
       *
       * 现在：**只有已经被签发过授权码的人才算授权**，
       * 新来的默认 false（要管理员在管理页签发才放行）。
       *
       * ⚠️ 已有记录不受影响（它们本来就有码）；
       *    本轮**已经开始使用**的人不会因为这次收紧而突然被拦。
       */
      authorized: isGranted(prev) || Boolean(prev?.authorized && prev?.code),
      code: prev?.code ?? '',
      /**
       * ⚠️ 配额字段必须继承 —— 这是"重建用户对象"最容易漏的地方。
       *    "他登录了一次，管理员设的截止时间和次数就没了" 会非常难查：
       *    界面上看不出，只在用户被莫名拦住时才暴露。
       */
      codeExpiresAt: prev?.codeExpiresAt ?? null,
      maxUses: prev?.maxUses ?? null,
      usedCount: prev?.usedCount ?? 0,
      lastUsedAt: prev?.lastUsedAt ?? null,
      note: prev?.note ?? '',
    };
    saveDb();
    const rec = db.users[studentId];
    console.log(
      `[用户] 登录 ${studentId} ${name || '(无姓名)'} 第 ${rec.loginCount} 次` +
        `　授权=${isGranted(rec) ? '有' : '无（需管理员签发授权码）'}`,
    );
    return json(res, 200, { ok: true, user: rec });
  }

  // ── 用户列表（管理页用）──
  if (p === '/api/users' && req.method === 'GET') {
    const users = Object.values(db.users).sort((a, b) => (b.lastLoginAt ?? 0) - (a.lastLoginAt ?? 0));
    return json(res, 200, {
      ok: true,
      count: users.length,
      authorizedCount: users.filter((u) => u.authorized).length,
      users,
    });
  }

  // ── 改用户（授权 / 备注 / 姓名 / 授权码）──
  if (p === '/api/user/update' && req.method === 'POST') {
    const body = await readBody(req);
    const studentId = clean(body.studentId, 32);
    const u = db.users[studentId];
    if (!u) return json(res, 404, { ok: false, error: '没有这个学号' });

    if (typeof body.authorized === 'boolean') u.authorized = body.authorized;
    if (body.studentName !== undefined) u.studentName = clean(body.studentName, 32);
    if (body.note !== undefined) u.note = clean(body.note, 200);

    /**
     * ★ 截止时间与次数上限在这里也能改（管理页用户列表里直接编辑）。
     *
     * ⚠️ 两个关键点：
     *   ① **不能设成过去** —— 与 /api/issue 同一条规则（需求明确要求）。
     *      留 60 秒容差，避免"刚好点到现在"被误拒。
     *   ② 改了截止时间必须**重新生成授权码** ——
     *      到期日编在码里，不重生成就会出现"服务器说 X 日到期、
     *      码里写 Y 日"的不一致，App 断网时会按码里那份判断。
     */
    const prevExpiry = typeof u.codeExpiresAt === 'number' ? u.codeExpiresAt : null;
    let nextExpiry = prevExpiry;
    let expiryChanged = false;

    if (body.codeExpiresAt !== undefined) {
      if (body.codeExpiresAt === null || body.codeExpiresAt === '') {
        nextExpiry = null;
      } else {
        const t = Number(body.codeExpiresAt);
        if (!Number.isFinite(t)) return json(res, 400, { ok: false, error: '截止时间格式不对' });
        if (t < Date.now() - 60_000) {
          return json(res, 400, { ok: false, error: '截止时间不能是过去的时间' });
        }
        nextExpiry = t;
      }
      expiryChanged = nextExpiry !== prevExpiry;
      u.codeExpiresAt = nextExpiry;
    }

    // ── 次数上限（null = 不限）──
    if (body.maxUses !== undefined) {
      if (body.maxUses === null || body.maxUses === '' || body.maxUses === 0) {
        u.maxUses = null;
      } else {
        const n = Number(body.maxUses);
        if (!Number.isInteger(n) || n <= 0) {
          return json(res, 400, { ok: false, error: '次数上限必须是正整数' });
        }
        if (n > 100000) return json(res, 400, { ok: false, error: '次数上限太大（最多 100000）' });
        u.maxUses = n;
      }
    }

    /**
     * ── 已用次数 ──
     * 只允许"清零"（重新给额度），**不提供任意改数值** ——
     * 那容易手滑改错别人，而且没有实际用途。
     */
    if (body.resetUsed === true) {
      u.usedCount = 0;
      u.lastUsedAt = null;
    }

    // 截止时间变了 → 码要重生成（保证码里那份日期与数据库一致）
    if (expiryChanged) {
      try {
        u.code = nextExpiry
          ? generateLicenseCode(studentId, { expiresAt: nextExpiry })
          : generateLicenseCode(studentId);
        // ⚠️ 已用次数**不重置** —— 否则"改一下有效期"就能刷回次数
      } catch (e) {
        return json(res, 500, { ok: false, error: `重新生成授权码失败：${e.message}` });
      }
    } else if (body.code !== undefined) {
      u.code = clean(body.code, 64);
    }

    saveDb();
    return json(res, 200, { ok: true, user: u });
  }

  // ── 删用户 ──
  if (p === '/api/user/delete' && req.method === 'POST') {
    const body = await readBody(req);
    const studentId = clean(body.studentId, 32);
    if (!db.users[studentId]) return json(res, 404, { ok: false, error: '没有这个学号' });
    delete db.users[studentId];
    saveDb();
    return json(res, 200, { ok: true });
  }

  // ── 导出 / 备份 ──
  if (p === '/api/export' && req.method === 'GET') {
    return json(res, 200, { ok: true, db });
  }

  return json(res, 404, { ok: false, error: '没有这个接口', path: p });
});

/**
 * 只在 `node server.cjs` 直接运行时才监听端口。
 *
 * 被 require 时（自测脚本）不自动监听，由调用方自己调 `start()`。
 * 这样自测不用 spawn 子进程 —— 某些受限环境里 spawn 会被拦。
 */
function start(port = PORT) {
  return new Promise((resolve, reject) => {
    server.listen(port, '0.0.0.0', () => {
      const entries = localAddressEntries();
      const addrs = entries.map((x) => x.address);
      console.log('');
      console.log('  LifeKit 管理服务已启动');
      console.log('  ────────────────────────────────────────────');
      console.log(`  本机管理页：  http://127.0.0.1:${port}/admin`);
      console.log('');
      if (entries.length === 0) {
        console.log('  ⚠️ 没检测到任何局域网地址 —— 电脑似乎没连网络。');
        console.log('     手机要连上就必须先让电脑入网（连 WiFi 或连手机热点）。');
      } else {
        console.log('  手机里「服务器地址」可以填这些（选你正在用的那个网络）：');
        for (const e of entries) {
          console.log(`    http://${e.address}:${port}     ${e.kind}`);
        }
        const hot = entries.find((x) => x.kind.startsWith('★'));
        console.log('');
        console.log(
          hot
            ? `  ★ 检测到手机热点网段，多半填这个：http://${hot.address}:${port}`
            : `  提示：如果手机连的是电脑自己开的热点，请填那个热点网卡的地址。`,
        );
      }
      console.log('');
      // ⚠️ 不再打印万能码本身 —— 启动日志可能被截图、被翻看
      console.log(`  万能码：      已设置为哈希（服务端不再保存明文）`);
      console.log(`  已登记用户：  ${Object.keys(db.users).length} 个`);
      console.log('');
      /**
       * ⚠️ 没设口令时必须明确警告。
       * 服务监听 0.0.0.0，同一个 WiFi 下**任何人都能打开管理页** ——
       * 看到所有人的学号、改万能码、把人踢下线。
       */
      if (db.adminPassword) {
        console.log('  🔒 管理页已加口令保护');
      } else {
        console.log('  ⚠️ 管理页**没有口令**：同一 WiFi 下任何人都能打开，');
        console.log('     看到所有学号、改万能码。建议在管理页里设一个口令。');
      }
      console.log('  ────────────────────────────────────────────');
      console.log('  关闭这个窗口即停止服务（Ctrl+C 也可以）');
      console.log('');
      resolve({ port, addresses: addrs, addressesDetail: entries });
    });
    server.once('error', reject);
  });
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  端口 ${PORT} 已被占用。改一个端口：set LIFEKIT_PORT=8899 && node server.cjs\n`);
  } else {
    console.error('\n  启动失败：', e.message, '\n');
  }
  process.exit(1);
});

// 直接运行才自动启动
if (require.main === module) {
  start(PORT).catch(() => process.exit(1));
}

module.exports = { server, start, loadDb, saveDb, DATA_FILE };

