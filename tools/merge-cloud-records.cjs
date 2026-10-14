/**
 * 云端记录合并 —— 把本地有、云端缺的记录补上去。
 *
 * ══════════════ 问题 ══════════════
 *
 * 两台服务器的记录不一致：
 *
 *   云端（手机实际连的）      本地桌面（管理页改的）
 *   ─────────────────────    ─────────────────────
 *   同学A  ✅                  同学A  ✅
 *   L     ✅                  同学B ✅（同一个学号，名字不同）
 *   ❌ 缺「乐」               乐    ✅
 *
 * ⚠️「乐」的学号是 2099000000109。
 *    用户明确说过「乐也是我朋友，这个不要删」—— 所以本地一直留着它，
 *    云端是**同步遗漏**，不是被删。
 *
 * ══════════════ 为什么走接口而不是直接改 data.json ══════════════
 *
 * `data.json` 是服务端**内存**的落盘副本 —— 运行时改文件**不生效**，
 * 服务端一写就把内存状态覆盖回去（这个坑踩过：手改文件后记录"没了"）。
 *
 * 而且 `/api/issue` 是**合并式**写入（保留 boundAt / loginCount /
 * usedCount 等既有字段），比手拼 JSON 安全得多。
 *
 * ══════════════ ★ 两个刻意的克制 ★ ══════════════
 *
 * ① **不动同学A的授权码**。
 *    两边的码不同（前缀相同、后半段不同），但**云端那个是用户手上在用的**。
 *    我不知道哪个是"正确的"，就**不擅自覆盖** —— 只在报告里列出来让用户决定。
 *
 * ② **不改「乐」的有效期**。
 *    本地那条有 codeExpiresAt；不传 expiresAt 就沿用云端既有值（新记录为永久）。
 *    凭空改别人的到期时间不是我该做的决定。
 *
 * 用法：
 *   node tools/merge-cloud-records.cjs --check    # 只看差异，不写
 *   node tools/merge-cloud-records.cjs            # 执行合并
 */
const https = require('node:https');
const http = require('node:http');

/**
 * ⚠️ 公开仓库版（2026-10）：服务器地址与管理口令都改成**必须由环境变量提供**。
 *    原来这里带着真实 IP 和真实口令的兜底值 —— 公开仓库不能有。
 *
 *    用法：
 *      LIFEKIT_HOST=你的服务器IP LIFEKIT_ADMIN_PASSWORD=你的口令 \
 *        node tools/merge-cloud-records.cjs
 */
const HOST = process.env.LIFEKIT_HOST || '';
const PORT = 8787;
const USER = 'admin';
const PASS = process.env.LIFEKIT_ADMIN_PASSWORD || '';
if (!HOST || !PASS) {
  console.error('  × 需要 LIFEKIT_HOST 和 LIFEKIT_ADMIN_PASSWORD 两个环境变量');
  process.exit(1);
}

const CHECK_ONLY = process.argv.includes('--check');

/**
 * 要补到云端的记录。
 *
 * ⚠️ 只列**云端缺的**。已有的不去动（尤其是授权码 —— 那是用户在用的）。
 */
const TO_ADD = [
  {
    studentId: '2099000000109',
    studentName: '乐',
    note: '本地补录（用户：乐也是我朋友，不要删）',
    /**
     * ⚠️ 刻意**不传 expiresAt / maxUses** ——
     *    让服务端沿用既有值，不去替用户决定别人的有效期。
     */
  },
];

/** 已知的两边不一致（只报告，不自动改） */
const KNOWN_DIFFS = [
  {
    studentId: '2099000000116',
    name: '同学A',
    issue: '授权码两边不同（云端 …222MY-LT6PR-QLWUL-PNW / 本地 …2MLVF-C22NX-V5VJL-HE6）',
    action: '★ 不自动改 —— 云端那个是你手上在用的码，我不知道哪个"对"',
  },
];

let pass = 0;
let fail = 0;
const ok = (m) => {
  pass += 1;
  console.log(`  √ ${m}`);
};
const bad = (m) => {
  fail += 1;
  console.log(`  × ${m}`);
};

function request(method, path, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const mod = PORT === 443 ? https : http;
    const req = mod.request(
      {
        host: HOST,
        port: PORT,
        path,
        method,
        timeout: 20000,
        headers: {
          Authorization: `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`,
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () => {
          const text = Buffer.concat(c).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* 非 JSON（例如 HTML 错误页） */
          }
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on('error', (e) => resolve({ status: 0, json: null, text: '', error: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, json: null, text: '', error: 'timeout' });
    });
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  console.log('');
  console.log('═'.repeat(72));
  console.log('  云端记录合并');
  console.log('═'.repeat(72));
  console.log(`  目标： http://${HOST}:${PORT}`);
  console.log(`  模式： ${CHECK_ONLY ? '只检查（不写）' : '执行合并'}`);

  // ── 1) 读现状 ──
  console.log('\n[1/4] 读取云端现有记录');
  const before = await request('GET', '/api/users');
  if (before.status !== 200 || !before.json?.users) {
    bad(`读不到云端用户列表（HTTP ${before.status} ${before.error ?? ''}）`);
    process.exit(1);
  }
  const users = before.json.users;
  console.log(`  √ 读到 ${users.length} 条`);
  for (const u of users) {
    console.log(`      ${u.studentId}  ${u.studentName || '(无名)'}  code=${u.code || '(空)'}`);
  }
  const have = new Set(users.map((u) => u.studentId));

  // ── 2) 差异 ──
  console.log('\n[2/4] 计算差异');
  const missing = TO_ADD.filter((r) => !have.has(r.studentId));
  if (missing.length === 0) {
    ok('云端没有缺失的记录（已经合并过了）');
  } else {
    for (const r of missing) {
      console.log(`  · 缺： ${r.studentId}  ${r.studentName}`);
    }
  }
  const extra = users.filter((u) => !u.code).map((u) => u.studentId);
  if (extra.length) {
    console.log(`  · 云端有 ${extra.length} 条**没有授权码**的记录：${extra.join(', ')}`);
    console.log('      （通常是登录时自动登记的，不是管理员签发的）');
  }

  console.log('\n  已知的不一致（只报告，不自动改）：');
  for (const d of KNOWN_DIFFS) {
    console.log(`  · ${d.studentId} ${d.name}：${d.issue}`);
    console.log(`      ${d.action}`);
  }

  if (CHECK_ONLY) {
    console.log(`\n  ✅ 检查完成（未做任何修改）`);
    console.log(`     要执行合并，去掉 --check 重跑。`);
    process.exit(0);
  }

  if (missing.length === 0) {
    console.log(`\n  ✅ 无需合并。`);
    process.exit(0);
  }

  // ── 3) 逐条补录 ──
  console.log('\n[3/4] 补录缺失记录');
  for (const r of missing) {
    const res = await request('POST', '/api/issue', {
      studentId: r.studentId,
      studentName: r.studentName,
      note: r.note,
    });
    if (res.status === 200 && res.json?.ok) {
      ok(`${r.studentId} ${r.studentName} 已补录 → ${res.json.code}${res.json.reused ? '（复用）' : ''}`);
    } else {
      bad(`${r.studentId} 补录失败：HTTP ${res.status} ${res.json?.error ?? res.text.slice(0, 120)}`);
    }
  }

  // ── 4) 复核 ──
  console.log('\n[4/4] 复核');
  const after = await request('GET', '/api/users');
  if (after.status !== 200 || !after.json?.users) {
    bad('复核时读不到列表');
    process.exit(1);
  }
  const afterUsers = after.json.users;
  console.log(`  用户数： ${users.length} → ${afterUsers.length}`);
  for (const u of afterUsers) {
    console.log(`      ${u.studentId}  ${u.studentName || '(无名)'}  authorized=${u.authorized}  code=${u.code || '(空)'}`);
  }

  /** ★ 确认原有记录**没被改动**（这是合并最怕的事） */
  for (const u of users) {
    const now = afterUsers.find((x) => x.studentId === u.studentId);
    if (!now) {
      bad(`原有记录 ${u.studentId} 不见了！`);
      continue;
    }
    const same =
      now.code === u.code &&
      now.loginCount === u.loginCount &&
      now.authorized === u.authorized &&
      now.boundAt === u.boundAt;
    if (same) ok(`原有记录 ${u.studentId} 未被改动（码/登录次数/授权/绑定时间一致）`);
    else bad(`原有记录 ${u.studentId} 被改动了 —— 需要检查`);
  }

  console.log('');
  console.log('═'.repeat(72));
  console.log(`  结果：通过 ${pass}，失败 ${fail}`);
  console.log('═'.repeat(72));
  console.log('');
  process.exit(fail === 0 ? 0 : 1);
})();
