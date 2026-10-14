/**
 * 把服务端数据文件重置回"干净可用"的状态。
 *
 * ══════════ 为什么需要 ══════════
 * 自测脚本会往 data.json 里写测试值（万能码 e2etest99、测试用户等）。
 * 正常情况下它会自己备份还原，但**如果中途崩了**（踩过一次：
 * HTTP 头里写了中文导致 Node 抛异常），还原就跳过了 ——
 * 数据文件被留在"万能码是测试值 + 管理页要口令"的状态，
 * 用户打开管理页会莫名其妙被拦，看起来像功能坏了。
 *
 * 这个脚本把可预期的污染项清掉，保留真实用户数据。
 *
 * 用法: node tools/reset-server-data.cjs [data.json 路径]
 *
 * ══════════════ ⚠️ 踩过的坑：不要拿它去清用户的真实数据 ══════════════
 *
 * 这个脚本是给**开发目录**（`server/data.json`）用的。
 * 有一次误以为它会破坏用户数据，差点把桌面管理后台那份也清了 ——
 * 那份是**用户真正在用的数据**。
 *
 * 所以现在：
 *   ① 默认只处理开发目录
 *   ② **动之前先自动备份**（万一判断错了还能救回来）
 *   ③ 不碰 adminPassword —— 清口令会让用户"管理页打不开"，
 *      这本身就是他抱怨过的症状之一，不能再制造一遍
 *
 * ⚠️⚠️ 还有一件更重要的事（这条是给以后的自己看的）：
 *    **如果服务正在运行，改磁盘上的 data.json 是没用的** ——
 *    服务把数据放在内存里，下次保存会把内存里的写回文件，
 *    等于把你改的覆盖掉。改完必须重启服务。
 *    用户就遇到过这个："新加的记录没了"，其实是**服务在跑旧代码 + 旧内存**。
 */
const fs = require('node:fs');
const path = require('node:path');

const FILE = process.argv[2] ?? path.resolve(__dirname, '..', 'server', 'data.json');
/** 传 --force 才允许动非开发目录的文件 */
const FORCE = process.argv.includes('--force');

if (!fs.existsSync(FILE)) {
  console.log(`  · ${FILE} 不存在，无需重置`);
  process.exit(0);
}

/**
 * ⚠️ 安全检查：默认只允许处理开发目录下的 server/data.json。
 *    要处理别的文件必须显式加 --force，
 *    避免"本来想清测试数据、结果清了用户真数据"。
 */
const DEV_FILE = path.resolve(__dirname, '..', 'server', 'data.json');
if (path.resolve(FILE) !== DEV_FILE && !FORCE) {
  console.log(`  ⛔ 拒绝操作：${FILE}`);
  console.log(`     这个脚本默认只处理开发目录：${DEV_FILE}`);
  console.log('     如果确实要处理那个文件，加 --force（会先自动备份）。');
  process.exit(2);
}

/** 动之前先备份 —— 判断错了还能救回来 */
const backup = `${FILE}.before-reset-${Date.now()}`;
fs.copyFileSync(FILE, backup);

const before = JSON.parse(fs.readFileSync(FILE, 'utf8'));

/** 测试脚本用过的万能码（这些都不是真实值） */
const TEST_MASTER_CODES = ['e2etest99', 'hacked', 'testcode123'];

const after = {
  ...before,
  /** 测试万能码 → 恢复（公开仓库版：从环境变量取，没设就保留原值） */
  masterCode: TEST_MASTER_CODES.includes(before.masterCode)
    ? process.env.LIFEKIT_MASTER_CODE || before.masterCode
    : before.masterCode,
  /**
   * ⚠️ **不再清空 adminPassword**。
   *    以前会清掉，理由是想让管理页"能直接打开"。
   *    但那是在**用户自己的数据**上动手 —— 
   *    口令是他设的，清掉等于替他改了安全设置，
   *    而且他下次会看到"管理页打不开"（正是他抱怨过的症状）。
   *    测试污染的问题应该在测试那边解决，不该拿用户数据开刀。
   */
  masterCodeHistory: Array.isArray(before.masterCodeHistory)
    ? before.masterCodeHistory.filter((h) => !TEST_MASTER_CODES.includes(h?.to))
    : [],
};

const changes = [];
if (before.masterCode !== after.masterCode) {
  changes.push(`万能码是测试值 ${before.masterCode} → 恢复默认 ${after.masterCode}`);
}
if ((before.masterCodeHistory?.length ?? 0) !== after.masterCodeHistory.length) {
  changes.push(`修改历史 ${before.masterCodeHistory.length} → ${after.masterCodeHistory.length} 条`);
}

/**
 * 测试学号的特征。
 *
 * ⚠️ 原先写的是 `/^[89]0{4,}/`（8 或 9 后面紧跟 4 个以上 0），
 *    但**漏掉了 `9900000000001` 这种** —— 它是 `9` 后面又跟 `9`，
 *    匹配不上，于是测试记录清不掉，会一直留在用户看到的管理页里。
 *    （这个是测试抓出来的，不是想当然改的。）
 *
 * 真实学号是 13 位、以年份开头（如 2099000000116 / 2099000000109），
 * 所以：
 *   · 以 9 开头 → 测试（真实学号不会 9 开头）
 *   · 以 8 开头且后面是 0 的连串 → 测试
 */
const TEST_ID_RE = /^(?:9|80{4,})/;

// 测试学号（我们自己编的）
const users = after.users ?? {};
const testIds = Object.keys(users).filter((id) => TEST_ID_RE.test(id));
for (const id of testIds) delete users[id];
if (testIds.length) changes.push(`删除 ${testIds.length} 个测试用户（${testIds.slice(0, 5).join(', ')}）`);

if (!changes.length) {
  fs.unlinkSync(backup); // 没改动就不留备份垃圾
  console.log('  ✅ 数据文件本来就是干净的，无需改动');
  console.log(`     真实用户：${Object.keys(users).length} 个`);
  console.log(`     管理口令：${after.adminPassword ? '已设置（保留）' : '(空)'}`);
  process.exit(0);
}

fs.writeFileSync(FILE, `${JSON.stringify(after, null, 2)}\n`, 'utf8');
console.log('  √ 已重置：');
for (const c of changes) console.log(`     · ${c}`);
console.log('');
console.log(`     万能码：${after.masterCode}`);
console.log(`     管理口令：${after.adminPassword ? '已设置（保留）' : '(空)'}`);
console.log(`     保留用户：${Object.keys(users).length} 个`);
console.log(`     备份：${path.basename(backup)}`);
console.log('');
console.log('  ⚠️ 如果服务正在运行，记得重启它 —— 否则它会把内存里的旧数据写回来。');
