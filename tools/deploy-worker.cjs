/**
 * 一键部署到 Cloudflare Workers（全自动，不用你在网页上点）。
 *
 * ══════════════ 用法 ══════════════
 * 在**仓库根目录**下执行：
 *
 *   set CLOUDFLARE_API_TOKEN=你的令牌
 *   node tools/deploy-worker.cjs
 *
 * 它会：
 *   ① 验证令牌
 *   ② 找到（或创建）KV 命名空间 lifekit
 *   ③ 生成 wrangler.toml（填上真实的 KV id）
 *   ④ 部署 Worker
 *   ⑤ 打印最终网址，并做一次自检（/api/ping）
 *
 * ══════════════ 令牌要什么权限 ══════════════
 *   · Workers Scripts        : Edit
 *   · Workers KV Storage     : Edit
 *   · Account Settings       : Read      （用来拿 Account ID）
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const API = 'https://api.cloudflare.com/client/v4';

if (!TOKEN) {
  console.log('  × 没有令牌。用法：');
  console.log('');
  console.log('    set CLOUDFLARE_API_TOKEN=你的令牌');
  console.log('    node tools/deploy-worker.cjs');
  console.log('');
  process.exit(2);
}

const ROOT = path.resolve(__dirname, '..');
const SERVER_DIR = path.join(ROOT, 'server');
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const TOML = path.join(SERVER_DIR, 'wrangler.toml');

const WORKER_NAME = 'lifekit';
const KV_TITLE = 'lifekit';

let step = 0;
const ok = (m) => console.log(`  √ ${m}`);
const info = (m) => console.log(`    ${m}`);
const bad = (m) => {
  console.log(`  × ${m}`);
  process.exit(1);
};

async function api(method, p, body) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text };
}

(async () => {
  console.log('');
  console.log('  ══════════════════════════════════════════════');
  console.log('   部署 LifeKit 到 Cloudflare Workers');
  console.log('  ══════════════════════════════════════════════');
  console.log('');

  // ── ① 验证令牌 ──
  step += 1;
  console.log(`  [${step}] 验证令牌…`);
  const verify = await api('GET', '/user/tokens/verify');
  if (!verify.json?.success) {
    bad(`令牌无效：${verify.json?.errors?.[0]?.message ?? verify.text.slice(0, 160)}`);
  }
  ok(`令牌有效（状态：${verify.json.result?.status ?? 'active'}）`);

  // ── ② 拿 Account ID ──
  step += 1;
  console.log(`\n  [${step}] 找 Account ID…`);
  let accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
  if (!accountId) {
    const accounts = await api('GET', '/accounts');
    const list = accounts.json?.result ?? [];
    if (!accounts.json?.success) {
      bad(
        `拿不到账号列表：${accounts.json?.errors?.[0]?.message ?? accounts.text.slice(0, 160)}\n` +
          `    → 令牌需要 Account Settings: Read 权限`,
      );
    }
    if (!list.length) bad('这个令牌下没有任何账号');
    accountId = list[0].id;
    info(`账号：${list[0].name}`);
  }
  ok(`Account ID：${accountId}`);

  // ── ③ 找 / 建 KV ──
  step += 1;
  console.log(`\n  [${step}] 找（或创建）KV 命名空间…`);
  let kvId = '';
  const kvList = await api('GET', `/accounts/${accountId}/storage/kv/namespaces?per_page=100`);
  if (!kvList.json?.success) {
    bad(`读 KV 列表失败：${kvList.json?.errors?.[0]?.message ?? kvList.text.slice(0, 160)}`);
  }
  const found = (kvList.json.result ?? []).find((n) => n.title === KV_TITLE);
  if (found) {
    kvId = found.id;
    ok(`已存在，复用：${KV_TITLE}（${kvId}）`);
  } else {
    const created = await api('POST', `/accounts/${accountId}/storage/kv/namespaces`, { title: KV_TITLE });
    if (!created.json?.success) {
      bad(`创建 KV 失败：${created.json?.errors?.[0]?.message ?? created.text.slice(0, 160)}`);
    }
    kvId = created.json.result.id;
    ok(`已创建：${KV_TITLE}（${kvId}）`);
  }

  // ── ④ 写 wrangler.toml ──
  step += 1;
  console.log(`\n  [${step}] 生成配置…`);
  const toml = `# 由 tools/deploy-worker.cjs 自动生成
# 令牌不写在这里 —— 部署时用环境变量传
name = "${WORKER_NAME}"
main = "worker.mjs"
compatibility_date = "2025-01-01"

[[kv_namespaces]]
binding = "LIFEKIT_KV"
id = "${kvId}"
`;
  fs.writeFileSync(TOML, toml, 'utf8');
  ok(`已写入 ${path.relative(ROOT, TOML)}`);

  // ── ⑤ 部署 ──
  step += 1;
  console.log(`\n  [${step}] 部署 Worker（可能要几十秒）…`);
  const nodeExe = process.execPath;
  let out = '';
  try {
    out = execFileSync(
      nodeExe,
      [WRANGLER, 'deploy', '--config', TOML],
      {
        cwd: SERVER_DIR,
        env: {
          ...process.env,
          CLOUDFLARE_API_TOKEN: TOKEN,
          CLOUDFLARE_ACCOUNT_ID: accountId,
          // wrangler 会想上报遥测，关掉免得卡住
          WRANGLER_SEND_METRICS: 'false',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 300000,
      },
    );
  } catch (e) {
    const stderr = e.stderr ? String(e.stderr) : '';
    const stdout = e.stdout ? String(e.stdout) : '';
    console.log(stderr.slice(-2000));
    console.log(stdout.slice(-2000));
    bad(`部署失败：${e.message}`);
  }
  console.log(out.trim().split('\n').map((l) => `    ${l}`).join('\n'));

  // ── ⑥ 找网址并自检 ──
  step += 1;
  console.log(`\n  [${step}] 自检…`);
  const urlMatch = out.match(/https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.workers\.dev/i);
  const url = urlMatch ? urlMatch[0] : '';
  if (!url) {
    console.log('    （没能从输出里认出网址，请你到 Cloudflare 后台看一眼）');
  } else {
    info(`网址：${url}`);
    try {
      const ping = await fetch(`${url}/api/ping`, { signal: AbortSignal.timeout(15000) });
      const j = await ping.json();
      if (j?.ok) {
        ok(`服务已上线（cloud=${j.cloud === true}）`);
      } else {
        console.log(`    ⚠️ ping 返回了非预期内容：${JSON.stringify(j).slice(0, 160)}`);
      }
    } catch (e) {
      console.log(`    ⚠️ 自检请求失败：${e.message}`);
      console.log('       （可能是本机网络访问 workers.dev 不稳，不影响部署结果）');
    }
  }

  console.log('');
  console.log('  ══════════════════════════════════════════════');
  console.log('   ✅ 部署完成');
  console.log('  ══════════════════════════════════════════════');
  if (url) {
    console.log('');
    console.log(`   管理页：${url}`);
    console.log('');
    console.log('   ★ 下一步（很重要）：');
    console.log('     用手机浏览器打开上面的网址');
    console.log('     → 🔒 管理口令 → 设一个（这个地址是公开的）');
  }
  console.log('');
})().catch((e) => {
  console.log('  × 异常：' + (e?.stack ?? e?.message ?? e));
  process.exit(1);
});
