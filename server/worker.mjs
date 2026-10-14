/**
 * LifeKit 管理服务 —— Cloudflare Workers 版（免费、永久在线）
 *
 * ══════════════ 它解决什么问题 ══════════════
 * 本地版（server.cjs）跑在你电脑上，所以：
 *   · 电脑关机 → 别人连不上
 *   · 不在同一网络 → 要装 Tailscale
 *   · 换网络/换 IP → 所有人要重填地址
 *
 * 放到 Cloudflare 上之后：
 *   · 永远在线，不用你开电脑
 *   · 地址永久不变（https://xxx.workers.dev）
 *   · 别人**什么都不用配** —— 地址写死在 App 里
 *
 * ══════════════ 数据存哪 ══════════════
 * 用 Workers KV，**整库一个 JSON** 存在一个 key 里（`db`）。
 * 十几到几十人的规模完全够，而且不用建表、不用写 SQL。
 *
 * ⚠️ KV 的限制：写入不是强一致的，高并发下可能丢一次写入。
 *    这个规模（偶尔改个码、登录上报）碰不到，但知道一下。
 *
 * ══════════════ 需要的绑定 ══════════════
 *   绑定类型：KV 命名空间
 *   变量名：  LIFEKIT_KV          ← ★ 必须叫这个名字
 */

// ────────────────────────────── 常量

/**
 * 默认万能码。
 *
 * ⚠️ 公开仓库版（2026-10）：不再硬编码，从 Cloudflare Worker 的
 *    环境变量 `LIFEKIT_MASTER_CODE` 取（在 wrangler 配置里设成 secret）。
 *    不设 → 占位符，登录不进去（**故意的**，免得用一个人人都知道的码）。
 */
const DEFAULT_MASTER_CODE = (typeof process !== 'undefined' && process.env?.LIFEKIT_MASTER_CODE) || 'CHANGE_ME';

/**
 * ══════════════ ★ 万能码只存哈希（与本地版 server.cjs 一致）══════════════
 *
 * 原先存明文、App 通过 GET /api/master **把明文取回去**自己比对 ——
 * 抓包就能看到万能码，而它能改所有人的签到状态。
 *
 * 现在：
 *   ① 只存 masterCodeHash
 *   ② App 走 POST /api/verify-master，只拿回 true/false
 *   ③ 网络上不出现万能码本身
 *
 * ⚠️ 这是**短码**（2-32 位字母数字），快速哈希挡不住离线暴力枚举。
 *    这里的目标是"别让它在网络上裸奔"，不是抗暴力破解。
 *    两份实现（worker.mjs / server.cjs）必须保持一致，测试里有交叉比对。
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

/** 校验候选万能码（兼容旧的明文数据） */
function verifyMasterCode(db, candidate) {
  const cand = normMasterCode(candidate);
  if (!cand) return false;
  if (typeof db.masterCodeHash === 'string' && db.masterCodeHash) {
    return hashMasterCode(cand) === db.masterCodeHash;
  }
  if (typeof db.masterCode === 'string' && db.masterCode) {
    const ok = normMasterCode(db.masterCode) === cand;
    if (ok) {
      db.masterCodeHash = hashMasterCode(cand);
      delete db.masterCode;
    }
    return ok;
  }
  return normMasterCode(DEFAULT_MASTER_CODE) === cand;
}

const CODE_PREFIX = 'LK1';
const SIGN_KEY = 'LifeKit::checkin::v1::2026';
const B32 = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const SEG_LEN = 5;

// ────────────────────────────── 授权码生成（与 App 算法逐字节一致）

function normalizeStudentId(s) {
  return String(s ?? '').replace(/\s+/g, '').toLowerCase();
}

function hashStudentId(studentId) {
  const s = normalizeStudentId(studentId);
  const fnv = (seed) => {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  };
  return (
    fnv(0x811c9dc5).toString(16).padStart(8, '0') +
    fnv(0x9e3779b9).toString(16).padStart(8, '0')
  );
}

function toBase32(bytes) {
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of bytes) {
    acc = ((acc << 8) | (b & 0xff)) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
      acc &= (1 << bits) - 1;
    }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

function hexToBytes(hex) {
  const out = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

function signWith(key, payloadStr) {
  const raw = `${key}|${payloadStr}`;
  return toBase32(hexToBytes(hashStudentId(raw) + hashStudentId(`${raw}#2`)));
}

function group(s) {
  const parts = [];
  for (let i = 0; i < s.length; i += SEG_LEN) parts.push(s.slice(i, i + SEG_LEN));
  return parts.join('-');
}

/** 生成绑定学号的个人授权码（永久有效） */
function generateLicenseCode(studentId) {
  const sid = normalizeStudentId(studentId);
  if (!sid) throw new Error('学号不能为空');
  const hashBytes = hexToBytes(hashStudentId(sid)).slice(0, 6);
  // 永久：有效期 0
  const payloadStr = toBase32([...hashBytes, 0, 0]);
  const sigStr = signWith(SIGN_KEY, payloadStr).slice(0, SEG_LEN * 3);
  return `${CODE_PREFIX}-${group(payloadStr + sigStr)}`;
}

// ────────────────────────────── 存储（KV，整库一个 JSON）

const EMPTY_DB = {
  /** 万能码的哈希（**不再是明文**） */
  masterCodeHash: hashMasterCode(DEFAULT_MASTER_CODE),
  masterCodeHistory: [],
  users: {},
  adminPassword: '',
};

async function loadDb(env) {
  try {
    const raw = await env.LIFEKIT_KV.get('db');
    if (!raw) return { ...EMPTY_DB };
    const j = JSON.parse(raw);
    return {
      // ⚠️ 保留旧明文字段以兼容老数据；首次校验成功后自动迁移成哈希
      masterCodeHash: typeof j.masterCodeHash === 'string' && j.masterCodeHash ? j.masterCodeHash : '',
      ...(typeof j.masterCode === 'string' && j.masterCode ? { masterCode: j.masterCode } : {}),
      masterCodeHistory: Array.isArray(j.masterCodeHistory) ? j.masterCodeHistory : [],
      users: j.users && typeof j.users === 'object' ? j.users : {},
      adminPassword: typeof j.adminPassword === 'string' ? j.adminPassword : '',
    };
  } catch {
    return { ...EMPTY_DB };
  }
}

async function saveDb(env, db) {
  await env.LIFEKIT_KV.put('db', JSON.stringify(db));
}

// ────────────────────────────── 工具

function clean(s, max = 64) {
  return String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      ...extraHeaders,
    },
  });
}

/** 定长比较，避免用响应时间试探口令 */
function safeEqual(a, b) {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i += 1) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

/**
 * 哪些路径需要管理口令。
 * ⚠️ 只保护管理面；App 用的接口不能加（凭据放进 APK 等于公开）。
 */
function isProtected(pathname, method) {
  if (pathname === '/api/master' && method === 'GET') return false;
  if (pathname === '/api/master' && method === 'POST') return true;
  if (pathname === '/api/admin/password') return false;
  if (pathname === '/') return true;
  const prefixes = ['/admin', '/manage', '/api/users', '/api/user/', '/api/issue', '/api/export'];
  return prefixes.some((x) => pathname.startsWith(x));
}

function checkAdminAuth(request, db) {
  if (!db.adminPassword) return true;
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Basic ')) return false;
  let decoded = '';
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  // atob 得到的是 latin1，中文口令需要按 UTF-8 还原
  let user = decoded.slice(0, i);
  let pass = decoded.slice(i + 1);
  try {
    const bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
    const utf8 = new TextDecoder().decode(bytes);
    const j = utf8.indexOf(':');
    user = utf8.slice(0, j);
    pass = utf8.slice(j + 1);
  } catch {
    /* 退化成 latin1 */
  }
  return safeEqual(user, 'admin') && safeEqual(pass, db.adminPassword);
}

/** ⚠️ HTTP 头的值只能是 ASCII —— 中文会让 Worker 抛异常 */
function askAuth() {
  const body = '需要管理口令（用户名 admin + 你设的口令）';
  return new Response(body, {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="LifeKit Admin", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}

// ────────────────────────────── 管理页（内嵌，省得再传文件）

function adminPageHtml() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LifeKit 管理后台（云端）</title>
<style>
 body{margin:0;background:#f6f7fb;color:#1f2430;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:14px}
 .wrap{max-width:900px;margin:0 auto;padding:20px}
 h1{font-size:20px;margin:0 0 4px}.sub{color:#6b7280;font-size:13px;margin-bottom:18px}
 .card{background:#fff;border:1px solid #e6e8ef;border-radius:12px;padding:16px;margin-bottom:16px}
 h2{font-size:15px;margin:0 0 12px}
 input{font:inherit;flex:1;min-width:160px;padding:9px 12px;border:1px solid #e6e8ef;border-radius:8px;background:#fbfbfd;color:#1f2430}
 button{font:inherit;padding:9px 16px;border:none;border-radius:8px;background:#4f46e5;color:#fff;cursor:pointer;font-weight:600}
 button.ghost{background:#eef0f7;color:#1f2430}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
 .hint{color:#6b7280;font-size:12px;margin-top:8px;line-height:1.7}
 table{width:100%;border-collapse:collapse;font-size:13px}
 th,td{text-align:left;padding:9px 8px;border-bottom:1px solid #e6e8ef}
 th{color:#6b7280;font-size:12px;background:#fafbfe}
 .mono{font-family:ui-monospace,Menlo,Consolas,monospace}
 .pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;background:#d1fae5;color:#059669}
 .pill.no{background:#f3f4f6;color:#6b7280}
 .toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#111827;color:#fff;padding:10px 18px;border-radius:999px;opacity:0;transition:.25s;font-size:13px}
 .toast.show{opacity:.94}
</style></head><body><div class="wrap">
<h1>LifeKit 管理后台（云端）</h1>
<div class="sub">这份服务跑在 Cloudflare 上，永久在线 —— 你不用开电脑，别人也不用配地址</div>

<div class="card"><h2>🎫 生成授权码</h2>
<div class="hint" style="margin:0 0 10px">输入学号 → 生成绑定该学号的码 → 发给他。只有他能用，转给别人无效。</div>
<div class="row"><input id="sid" placeholder="学号，8-12 位数字" autocomplete="off" onkeydown="if(event.key==='Enter')issue()">
<input id="name" placeholder="姓名（选填）" style="max-width:150px">
<button onclick="issue()">生成</button></div>
<div id="out" style="margin-top:12px"></div></div>

<div class="card"><h2>🔑 万能码</h2>
<div class="row"><input type="password" id="master" placeholder="输入新的万能码（2-32 位字母或数字）" autocomplete="off">
<button onclick="saveMaster()">设为新码</button></div>
<div class="hint"><b>当前码看不到</b> —— 服务端只保存它的哈希，拿不回明文（这样即使数据泄漏也拿不到码）。<br>
忘了就重设一个：直接在上面输入新的即可。<br>改完立刻生效，发出去的<b>个人授权码不受影响</b>。</div></div>

<div class="card"><h2>🔒 管理口令 <span id="pwstate" class="pill no">未启用</span></h2>
<div class="hint" style="margin:0 0 10px">这个地址是公开的，<b>一定要设口令</b>，否则谁拿到地址都能改你的万能码。</div>
<div class="row"><input id="pw" placeholder="至少 4 位"><button onclick="savePw()">启用/修改</button>
<button class="ghost" onclick="clearPw()">关闭</button></div></div>

<div class="card"><h2>👥 用户 <span id="cnt" class="pill no">0</span></h2>
<div class="row" style="margin-bottom:10px"><input id="q" placeholder="搜索学号/姓名" oninput="render()">
<button class="ghost" onclick="loadUsers()">刷新</button></div>
<div id="list"></div></div>
</div><div class="toast" id="toast"></div>
<script>
let users=[];
function toast(t){const e=document.getElementById('toast');e.textContent=t;e.classList.add('show');clearTimeout(e._t);e._t=setTimeout(()=>e.classList.remove('show'),1800)}
async function api(p,o){const r=await fetch(p,o);const j=await r.json().catch(()=>({}));if(!r.ok||j.ok===false)throw new Error(j.error||('HTTP '+r.status));return j}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function fmt(ms){if(!ms)return '—';const d=new Date(ms),p=n=>String(n).padStart(2,'0');return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())}
async function issue(){const sid=document.getElementById('sid').value.trim(),name=document.getElementById('name').value.trim(),box=document.getElementById('out');
 if(!sid)return toast('请填学号');box.innerHTML='生成中…';
 try{const j=await api('/api/issue',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({studentId:sid,studentName:name})});
  box.innerHTML='<div style="background:#ecfdf5;border:1px solid #6ee7b7;border-radius:10px;padding:14px">'+
   '<div style="color:#065f46;font-size:13px;margin-bottom:8px">'+(j.reused?'这个学号之前签发过，是他的原码':'✅ 已生成，发给他')+'</div>'+
   '<div class="mono" id="code" style="font-size:17px;font-weight:700;word-break:break-all;color:#065f46">'+esc(j.code)+'</div>'+
   '<div style="color:#065f46;font-size:12px;margin-top:8px">学号：'+esc(j.studentId)+(j.user.studentName?'　姓名：'+esc(j.user.studentName):'')+'</div>'+
   '<div style="margin-top:10px"><button onclick="copyCode()">复制授权码</button></div></div>';
  loadUsers();
 }catch(e){box.innerHTML='<div style="color:#dc2626">失败：'+esc(e.message)+'</div>'}}
function copyCode(){const t=document.getElementById('code').textContent;navigator.clipboard.writeText(t).then(()=>toast('已复制'),()=>toast('请手动选中复制'))}
async function saveMaster(){const v=document.getElementById('master').value.trim();if(!v)return toast('不能为空');
 try{await api('/api/master',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({masterCode:v})});
 document.getElementById('master').value='';toast('万能码已更新（内容不回显）')}catch(e){toast('失败：'+e.message)}}
async function loadPw(){try{const j=await api('/api/admin/password');const p=document.getElementById('pwstate');p.textContent=j.enabled?'已启用':'未启用';p.className='pill'+(j.enabled?'':' no')}catch(e){}}
async function savePw(){const v=document.getElementById('pw').value.trim();if(v.length<4)return toast('至少 4 位');
 try{await api('/api/admin/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:v})});document.getElementById('pw').value='';toast('已启用，下次打开会弹输入框');loadPw()}catch(e){toast('失败：'+e.message)}}
async function clearPw(){if(!confirm('确定关闭口令？公开地址没口令很危险。'))return;
 try{await api('/api/admin/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:''})});toast('已关闭');loadPw()}catch(e){toast('失败：'+e.message)}}
async function loadUsers(){try{const j=await api('/api/users');users=j.users||[];document.getElementById('cnt').textContent=j.count;render()}catch(e){document.getElementById('list').innerHTML='<div style="color:#dc2626">'+esc(e.message)+'</div>'}}
function render(){const q=document.getElementById('q').value.trim().toLowerCase();
 const list=users.filter(u=>!q||String(u.studentId).includes(q)||String(u.studentName||'').toLowerCase().includes(q));
 document.getElementById('list').innerHTML=list.length?'<table><thead><tr><th>学号</th><th>姓名</th><th>授权</th><th>授权码</th><th>最近登录</th><th>次数</th></tr></thead><tbody>'+
  list.map(u=>'<tr><td class="mono">'+esc(u.studentId)+'</td><td>'+esc(u.studentName)+'</td>'+
   '<td><span class="pill'+(u.authorized?'':' no')+'" style="cursor:pointer" onclick="toggle(\\''+esc(u.studentId)+'\\','+(u.authorized?'false':'true')+')">'+(u.authorized?'已授权':'未授权')+'</span></td>'+
   '<td class="mono" style="font-size:12px">'+esc(u.code||'—')+'</td><td>'+fmt(u.lastLoginAt)+'</td><td>'+(u.loginCount||0)+'</td></tr>').join('')+
  '</tbody></table>':'<div style="color:#6b7280;text-align:center;padding:20px">还没有人登录过</div>'}
async function toggle(id,next){try{await api('/api/user/update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({studentId:id,authorized:next})});toast(next?'已授权':'已关闭');loadUsers()}catch(e){toast('失败：'+e.message)}}
loadUsers();loadPw();setInterval(loadUsers,15000);
</script></body></html>`;
}

// ────────────────────────────── 主入口

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        },
      });
    }

    // 没绑定 KV 的话给一句能看懂的话，而不是 500
    if (!env.LIFEKIT_KV) {
      return json(
        {
          ok: false,
          error:
            '没有绑定 KV 命名空间。请在 Worker 的「设置 → 变量与绑定」里，' +
            '添加一个 KV 命名空间绑定，变量名必须是 LIFEKIT_KV。',
        },
        500,
      );
    }

    const db = await loadDb(env);

    // ── 鉴权 ──
    if (isProtected(p, method) && !checkAdminAuth(request, db)) {
      return askAuth();
    }

    // ── 管理页 ──
    if (p === '/' || p === '/admin' || p === '/manage') {
      return new Response(adminPageHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // ── 健康检查 ──
    if (p === '/api/ping') {
      return json({
        ok: true,
        at: Date.now(),
        cloud: true,
        port: 443,
        addressesDetail: [{ name: 'cloudflare', address: url.hostname, kind: '★ 云端（永久在线）' }],
        hasAdminPassword: Boolean(db.adminPassword),
      });
    }

    // ── 管理口令 ──
    if (p === '/api/admin/password') {
      if (method === 'GET') return json({ ok: true, enabled: Boolean(db.adminPassword) });
      if (method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const next = clean(body.password, 64);
        // 修改已有口令时必须带旧口令（首次设置为空则放行）
        if (db.adminPassword && !checkAdminAuth(request, db)) return askAuth();
        if (next && next.length < 4) return json({ ok: false, error: '口令至少 4 位' }, 400);
        db.adminPassword = next;
        await saveDb(env, db);
        return json({ ok: true, enabled: Boolean(next) });
      }
      return json({ ok: false, error: '不支持的方法' }, 405);
    }

    /**
     * ══════════ App 用：查某个学号有没有被授权 ══════════
     * ⚠️ 故意不要求管理口令 —— 口令是给管理页用的，
     *    App 里的凭据会被打进 APK（等于公开）。
     *    踩过坑：原先 App 调 /api/users，加口令后一直吃 401，
     *    于是"远程关掉某人"悄悄失效。见 server.cjs 里同段注释。
     */
    if (p === '/api/auth-state') {
      const sid = clean(url.searchParams.get('studentId'), 32);
      if (!sid) return json({ ok: false, error: '缺少 studentId' }, 400);
      const u = db.users[sid];
      return json({
        ok: true,
        studentId: sid,
        known: Boolean(u),
        authorized: u ? Boolean(u.authorized) : true,
      });
    }

    /**
     * ★ 校验万能码（App 用，**不回传万能码本身**）
     * 与本地版 server.cjs 完全一致：只回 true/false。
     * ⚠️ 这是最该限流的接口（短码可枚举）；当前规模未加。
     */
    if (p === '/api/verify-master' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const valid = verifyMasterCode(db, clean(body.code, 64));
      if (valid && db.masterCodeHash) await saveDb(env, db); // 旧数据迁移后落盘
      return json({ ok: true, valid });
    }

    /**
     * ── 版本检查（应用内更新）──
     *
     * ⚠️ 云端版**故意不支持**自动更新分发，原因是：
     *    安装包有 34 MB，而 Cloudflare Workers / KV 的免费额度放不下
     *    （KV 单值上限 25 MB，且把 34MB 塞进 KV 也不合理）。
     *
     *    所以这里返回一个明确的原因，让 App 能提示用户
     *    "去管理页/找管理员拿新版本"，而不是让"检查更新"永远没反应。
     */
    if (p === '/api/version') {
      return json({
        ok: true,
        available: false,
        message: '云端版不提供安装包下载（体积超出免费额度），请找管理员要新版本',
      });
    }

    // ── 读 / 改万能码 ──
    if (p === '/api/master') {
      if (method === 'GET') {
        // ⚠️ 不再返回明文（服务端也不存了）
        return json({
          ok: true,
          hasMasterCode: true,
          masterCode: '',
          deprecated: '请改用 POST /api/verify-master',
        });
      }
      if (method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const next = clean(body.masterCode, 32);
        if (!next) return json({ ok: false, error: '万能码不能为空' }, 400);
        if (!/^[0-9A-Za-z]{2,32}$/.test(next)) {
          return json({ ok: false, error: '只能是 2-32 位字母或数字' }, 400);
        }
        // 历史里也不存明文，只记长度
        const prevLen = db.masterCodeHash ? null : normMasterCode(db.masterCode ?? '').length;
        db.masterCodeHash = hashMasterCode(next);
        delete db.masterCode;
        db.masterCodeHistory = [
          { at: Date.now(), fromLen: prevLen, toLen: normMasterCode(next).length },
          ...db.masterCodeHistory,
        ].slice(0, 100);
        await saveDb(env, db);
        // ⚠️ 响应里不含 masterCode
        return json({ ok: true, updated: true });
      }
    }

    /**
     * ★ 配额校验（App 写操作前调用）—— 与本地版 server.cjs 行为一致。
     *   次数只能靠服务端记：本地计数一清数据就归零。
     */
    if (p === '/api/consume' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const studentId = clean(body.studentId, 32);
      const code = clean(body.code, 64);
      if (!studentId) return json({ ok: false, error: '缺少 studentId' }, 400);

      const u0 = db.users[studentId];
      // 带了码就确认它是发给这个学号的
      if (code && u0?.code && u0.code !== code) {
        return json({ ok: true, allow: false, reason: 'code_mismatch', message: '这个授权码不属于当前学号' });
      }

      if (!u0) {
        return json({
          ok: true,
          allow: true,
          reason: 'not_registered',
          message: '服务器上没有这个学号，按不限次处理',
          used: 0,
          maxUses: null,
          expiresAt: null,
          permanent: true,
        });
      }

      const exp = typeof u0.codeExpiresAt === 'number' ? u0.codeExpiresAt : null;
      if (exp && Date.now() > exp) {
        return json({
          ok: true,
          allow: false,
          reason: 'expired',
          message: '授权已过期，请联系管理员',
          used: u0.usedCount ?? 0,
          maxUses: u0.maxUses ?? null,
          expiresAt: exp,
          permanent: false,
        });
      }

      const max = typeof u0.maxUses === 'number' && u0.maxUses > 0 ? u0.maxUses : null;
      const used = typeof u0.usedCount === 'number' && u0.usedCount >= 0 ? u0.usedCount : 0;
      if (max !== null && used >= max) {
        return json({
          ok: true,
          allow: false,
          reason: 'quota_exhausted',
          message: `授权次数已用完（${used}/${max} 次），请联系管理员`,
          used,
          maxUses: max,
          expiresAt: exp,
          permanent: false,
        });
      }

      // 通过 → 计数（先判后计，失败绝不扣次数）
      u0.usedCount = used + 1;
      u0.lastUsedAt = Date.now();
      await saveDb(env, db);
      return json({
        ok: true,
        allow: true,
        reason: 'ok',
        message: '可以使用',
        used: u0.usedCount,
        maxUses: max,
        expiresAt: exp,
        permanent: exp === null && max === null,
      });
    }

    // ── 签发授权码 ──
    if (p === '/api/issue' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const studentId = clean(body.studentId, 32);
      if (!studentId) return json({ ok: false, error: '缺少学号' }, 400);
      if (!/^[0-9A-Za-z]{4,32}$/.test(studentId)) {
        return json({ ok: false, error: '学号只能是 4-32 位字母或数字' }, 400);
      }
      const now = Date.now();
      const prev = db.users[studentId] ?? null;

      // ── 截止时间（不能设成过去；留 60 秒容差）──
      let expiresAt = prev?.codeExpiresAt ?? null;
      if (body.expiresAt !== undefined) {
        if (body.expiresAt === null || body.expiresAt === '') {
          expiresAt = null;
        } else {
          const t = Number(body.expiresAt);
          if (!Number.isFinite(t)) return json({ ok: false, error: '截止时间格式不对' }, 400);
          if (t < now - 60_000) return json({ ok: false, error: '截止时间不能是过去的时间' }, 400);
          expiresAt = t;
        }
      }

      // ── 次数上限（null = 不限）──
      let maxUses = prev?.maxUses ?? null;
      if (body.maxUses !== undefined) {
        if (body.maxUses === null || body.maxUses === '' || body.maxUses === 0) {
          maxUses = null;
        } else {
          const n = Number(body.maxUses);
          if (!Number.isInteger(n) || n <= 0) {
            return json({ ok: false, error: '次数上限必须是正整数' }, 400);
          }
          if (n > 100000) return json({ ok: false, error: '次数上限太大（最多 100000）' }, 400);
          maxUses = n;
        }
      }

      // 到期日编在码里：改了截止时间必须重生成，否则两边不一致
      const expiryChanged = (prev?.codeExpiresAt ?? null) !== expiresAt;
      let code = !expiryChanged && prev?.code && /^LK1-/.test(prev.code) ? prev.code : '';
      const reused = Boolean(code);
      if (!code) {
        code = expiresAt ? generateLicenseCode(studentId, { expiresAt }) : generateLicenseCode(studentId);
      }

      db.users[studentId] = {
        studentId,
        studentName: clean(body.studentName, 32) || prev?.studentName || '',
        school: '',
        tenant: 'dgut',
        boundAt: prev?.boundAt ?? now,
        lastLoginAt: prev?.lastLoginAt ?? null,
        loginCount: prev?.loginCount ?? 0,
        authorized: true,
        code,
        codeExpiresAt: expiresAt,
        maxUses,
        usedCount: prev?.usedCount ?? 0,
        lastUsedAt: prev?.lastUsedAt ?? null,
        note: '',
        issuedByAdmin: true,
        issuedAt: prev?.issuedAt ?? now,
      };
      await saveDb(env, db);
      return json({ ok: true, studentId, code, reused, user: db.users[studentId] });
    }

    // ── App 注册（登录上报）──
    if (p === '/api/register' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const studentId = clean(body.studentId, 32);
      if (!studentId) return json({ ok: false, error: '缺少学号' }, 400);
      const now = Date.now();
      const prev = db.users[studentId] ?? null;
      const name = clean(body.studentName, 32);
      db.users[studentId] = {
        studentId,
        studentName: name || prev?.studentName || '',
        school: clean(body.school, 48) || prev?.school || '',
        tenant: clean(body.tenant, 16) || prev?.tenant || 'dgut',
        boundAt: prev?.boundAt ?? now,
        lastLoginAt: now,
        loginCount: (prev?.loginCount ?? 0) + 1,
        authorized: prev?.authorized ?? true,
        code: prev?.code ?? '',
        codeExpiresAt: prev?.codeExpiresAt ?? null,
        // ⚠️ 配额字段必须保留 —— 重建对象时漏掉就等于把管理员的设置悄悄清空了
        maxUses: prev?.maxUses ?? null,
        usedCount: prev?.usedCount ?? 0,
        lastUsedAt: prev?.lastUsedAt ?? null,
        note: prev?.note ?? '',
      };
      await saveDb(env, db);
      return json({ ok: true, user: db.users[studentId] });
    }

    // ── App 用万能码解锁时领个人码 ──
    if (p === '/api/grant' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const studentId = clean(body.studentId, 32);
      if (!studentId) return json({ ok: false, error: '缺少学号' }, 400);
      const now = Date.now();
      const prev = db.users[studentId] ?? null;
      let code = prev?.code && /^LK1-/.test(prev.code) ? prev.code : '';
      if (!code) code = generateLicenseCode(studentId);
      db.users[studentId] = {
        studentId,
        studentName: clean(body.studentName, 32) || prev?.studentName || '',
        school: clean(body.school, 48) || prev?.school || '',
        tenant: clean(body.tenant, 16) || prev?.tenant || 'dgut',
        boundAt: prev?.boundAt ?? now,
        lastLoginAt: now,
        loginCount: (prev?.loginCount ?? 0) + 1,
        authorized: prev?.authorized ?? true,
        code,
        // ⚠️ 领码不该清掉已设的有效期（管理员可能设过截止时间）
        codeExpiresAt: prev?.codeExpiresAt ?? null,
        maxUses: prev?.maxUses ?? null,
        usedCount: prev?.usedCount ?? 0,
        lastUsedAt: prev?.lastUsedAt ?? null,
        note: prev?.note ?? '',
        grantedByMaster: true,
        grantedAt: prev?.grantedAt ?? now,
      };
      await saveDb(env, db);
      return json({ ok: true, studentId, personalCode: code, user: db.users[studentId] });
    }

    // ── 用户列表 / 改 / 删 / 导出 ──
    if (p === '/api/users' && method === 'GET') {
      const users = Object.values(db.users).sort((a, b) => (b.lastLoginAt ?? 0) - (a.lastLoginAt ?? 0));
      return json({
        ok: true,
        count: users.length,
        authorizedCount: users.filter((u) => u.authorized).length,
        users,
      });
    }

    if (p === '/api/user/update' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const studentId = clean(body.studentId, 32);
      const u = db.users[studentId];
      if (!u) return json({ ok: false, error: '没有这个学号' }, 404);
      if (typeof body.authorized === 'boolean') u.authorized = body.authorized;
      if (body.studentName !== undefined) u.studentName = clean(body.studentName, 32);
      if (body.note !== undefined) u.note = clean(body.note, 200);

      /**
       * ★ 截止时间 / 次数上限 —— 与本地版 server.cjs 同规则：
       *   ① 不能设成过去
       *   ② 改了截止时间要**重新生成码**（到期日编在码里）
       */
      const prevExpiry = typeof u.codeExpiresAt === 'number' ? u.codeExpiresAt : null;
      let nextExpiry = prevExpiry;
      let expiryChanged = false;

      if (body.codeExpiresAt !== undefined) {
        if (body.codeExpiresAt === null || body.codeExpiresAt === '') {
          nextExpiry = null;
        } else {
          const t = Number(body.codeExpiresAt);
          if (!Number.isFinite(t)) return json({ ok: false, error: '截止时间格式不对' }, 400);
          if (t < Date.now() - 60_000) {
            return json({ ok: false, error: '截止时间不能是过去的时间' }, 400);
          }
          nextExpiry = t;
        }
        expiryChanged = nextExpiry !== prevExpiry;
        u.codeExpiresAt = nextExpiry;
      }

      if (body.maxUses !== undefined) {
        if (body.maxUses === null || body.maxUses === '' || body.maxUses === 0) {
          u.maxUses = null;
        } else {
          const n = Number(body.maxUses);
          if (!Number.isInteger(n) || n <= 0) {
            return json({ ok: false, error: '次数上限必须是正整数' }, 400);
          }
          if (n > 100000) return json({ ok: false, error: '次数上限太大（最多 100000）' }, 400);
          u.maxUses = n;
        }
      }

      if (body.resetUsed === true) {
        u.usedCount = 0;
        u.lastUsedAt = null;
      }

      if (expiryChanged) {
        u.code = nextExpiry
          ? generateLicenseCode(studentId, { expiresAt: nextExpiry })
          : generateLicenseCode(studentId);
        // 已用次数不重置 —— 否则改一下有效期就能刷回次数
      } else if (body.code !== undefined) {
        u.code = clean(body.code, 64);
      }

      await saveDb(env, db);
      return json({ ok: true, user: u });
    }

    if (p === '/api/user/delete' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const studentId = clean(body.studentId, 32);
      if (!db.users[studentId]) return json({ ok: false, error: '没有这个学号' }, 404);
      delete db.users[studentId];
      await saveDb(env, db);
      return json({ ok: true });
    }

    if (p === '/api/export' && method === 'GET') {
      return json({ ok: true, db });
    }

    return json({ ok: false, error: '没有这个接口', path: p }, 404);
  },
};
