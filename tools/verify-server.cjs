/**
 * 端到端自测：起服务 → 打几个接口 → 校验 → 关闭。
 *
 * ⚠️ 刻意**不 spawn 子进程** —— 某些受限环境里 spawn + 管道会被拦（EPERM）。
 *    改成直接在**同一进程里 require** 服务端，再调它的 start()。
 */
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const PORT = 8793;
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * 发请求。`auth` 传 `{user, pass}` 时会带 HTTP Basic 头。
 */
function req(method, p, body, auth) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = data
      ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
      : {};
    if (auth) {
      headers.Authorization = `Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString('base64')}`;
    }
    const r = http.request(`${BASE}${p}`, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          text: Buffer.concat(chunks).toString('utf8'),
          wwwAuth: res.headers['www-authenticate'] ?? null,
        }),
      );
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function t(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  √ ${name}`);
  } else {
    fail += 1;
    console.log(`  × ${name}${extra ? '  → ' + extra : ''}`);
  }
}

(async () => {
  const dataFile = path.resolve(__dirname, '..', 'server', 'data.json');
  const backup = fs.existsSync(dataFile) ? fs.readFileSync(dataFile) : null;

  // 静音服务端的启动日志（自测时不需要刷屏）
  const origLog = console.log;
  const quiet = (...a) => {
    const s = a.join(' ');
    if (s.includes('LifeKit 管理服务已启动')) return;
    origLog(...a);
  };
  console.log = quiet;

  process.env.LIFEKIT_PORT = String(PORT);
  const mod = require(path.resolve(__dirname, '..', 'server', 'server.cjs'));
  await mod.start(PORT);
  console.log = origLog;

  try {
    console.log('=== 1) 健康检查 ===');
    {
      const r = await req('GET', '/api/ping');
      const j = JSON.parse(r.text);
      t('status 200', r.status === 200);
      t('返回 ok=true', j.ok === true);
      t('带局域网地址', Array.isArray(j.addresses) && j.addresses.length > 0, JSON.stringify(j.addresses));
    }

    console.log('\n=== 2) 管理页可访问 ===');
    {
      const r = await req('GET', '/admin');
      t('status 200', r.status === 200);
      t('是管理页（含标题）', r.text.includes('LifeKit 用户管理'));
      t('含"万能码"字样', r.text.includes('万能码'));
      t('含"用户列表"字样', r.text.includes('用户列表'));
    }

    /**
     * ══════════ 3) 万能码：只校验，不回传 ══════════
     *
     * ★ 行为变更（安全性改造）：
     *   原先 `GET /api/master` 回传**明文**，App 取回去自己比对 ——
     *   后果是抓包就能看到万能码，而它能改所有人的签到状态。
     *   现在服务端只存哈希，App 走 `POST /api/verify-master` 只拿 true/false。
     *
     * 所以这一节的断言从"能读到明文"改成"**读不到明文**且校验正确"。
     */
    console.log('\n=== 3) 万能码：只校验，不回传明文 ===');
    {
      const before = JSON.parse((await req('GET', '/api/master')).text);
      t('★★ GET /api/master 不回传明文', !before.masterCode, `拿到了 ${JSON.stringify(before.masterCode)}`);
      t('只回"有没有设置"', before.hasMasterCode === true);
      t('标记为已弃用（引导改用新接口）', typeof before.deprecated === 'string');

      /**
       * ⚠️ 公开仓库版（2026-10）：默认码不再写死。
       *
       * 这里的坑：测试**复用真实的 server/data.json**（它会备份后还原），
       * 所以库里可能已经有一个已生效的万能码哈希 —— 那时"默认码"并不是
       * `DEFAULT_MASTER_CODE`，断言会误报失败（踩过）。
       *
       * 正确做法：用**当前真正生效**的那个码。
       *   ① 环境变量 LIFEKIT_MASTER_CODE（服务端默认码的来源）
       *   ② data.json 里的明文 masterCode（旧格式）
       *   ③ 都没有 → 服务端的 CHANGE_ME 占位符
       */
      const dataFile = path.resolve(__dirname, '..', 'server', 'data.json');
      let storedPlain = '';
      try {
        storedPlain = JSON.parse(fs.readFileSync(dataFile, 'utf8')).masterCode || '';
      } catch {
        storedPlain = '';
      }
      const DEFAULT_CODE = process.env.LIFEKIT_MASTER_CODE || storedPlain || 'CHANGE_ME';

      // 默认码应当校验通过
      const vDefault = JSON.parse((await req('POST', '/api/verify-master', { code: DEFAULT_CODE })).text);
      t('★ 默认万能码校验通过', vDefault.valid === true);

      // 错误码校验失败，且**响应里不含任何提示**
      const vWrong = JSON.parse((await req('POST', '/api/verify-master', { code: 'wrongcode' })).text);
      t('★ 错误码校验失败', vWrong.valid === false);
      t('★★ 失败响应里不含万能码', !JSON.stringify(vWrong).includes(DEFAULT_CODE));
      t('失败响应里也不含长度等线索', vWrong.length === undefined && vWrong.hint === undefined);

      // 改成新码
      const changed = JSON.parse((await req('POST', '/api/master', { masterCode: 'e2etest99' })).text);
      t('★ 改码的响应不回显新码', changed.masterCode === undefined && changed.updated === true);

      const after = JSON.parse((await req('GET', '/api/master')).text);
      t('★ 改完仍然读不到明文', !after.masterCode);

      // 但校验必须认得新码、不认旧码
      const vNew = JSON.parse((await req('POST', '/api/verify-master', { code: 'e2etest99' })).text);
      t('★★ 改完立刻生效：新码校验通过', vNew.valid === true);
      const vOld = JSON.parse((await req('POST', '/api/verify-master', { code: DEFAULT_CODE })).text);
      t('★★ 旧码立刻失效', vOld.valid === false);

      // 大小写 / 分隔符不敏感（保持原有宽松）
      const vLoose = JSON.parse((await req('POST', '/api/verify-master', { code: 'E2E-TEST-99' })).text);
      t('大小写与分隔符不敏感', vLoose.valid === true);

      const bad = await req('POST', '/api/master', { masterCode: '' });
      t('空值被拒（400）', bad.status === 400);

      const bad2 = await req('POST', '/api/master', { masterCode: '有中文' });
      t('非字母数字被拒（400）', bad2.status === 400);

      // 还原
      await req('POST', '/api/master', { masterCode: DEFAULT_CODE });
      t(
        '能还原回去',
        JSON.parse((await req('POST', '/api/verify-master', { code: DEFAULT_CODE })).text).valid === true,
      );
    }

    console.log('\n=== 4) 用户注册 / 列表 / 改 / 删 ===');
    {
      const reg = JSON.parse(
        (await req('POST', '/api/register', {
          studentId: '9000000000001',
          studentName: '测试甲',
          school: '测试大学',
        })).text,
      );
      t('注册成功', reg.ok === true);
      t('学号正确', reg.user.studentId === '9000000000001');
      t('姓名正确', reg.user.studentName === '测试甲');
      /**
       * ══════════════ ★★★ 断言反过来了（2026-10 安全收紧）══════════════
       *
       * 原来是 `默认已授权 === true`。
       * 但用户要求「别人不能从我的 app 里得到这些功能的完成」，
       * 而"登录上报就自动授权"正是那时的漏洞：
       * 别人装 App、用自己账号登录，服务端就给他建记录并标记已授权，
       * **完全不需要管理员发码**。
       *
       * 现在：**只有被管理员签发过授权码的人才算授权**。
       * 详见 server.cjs 里的 isGranted 与 verify-auth-tightening.cjs。
       */
      t('★★★ 新学号登录上报**不会**自动获得授权', reg.user.authorized === false);
      t('★★★ 且没有授权码（要管理员签发才有）', !reg.user.code, String(reg.user.code));
      t('登录次数 1', reg.user.loginCount === 1);

      const reg2 = JSON.parse((await req('POST', '/api/register', { studentId: '9000000000001' })).text);
      t('重复登录次数累加', reg2.user.loginCount === 2);
      t('空姓名不覆盖原姓名', reg2.user.studentName === '测试甲');

      const list = JSON.parse((await req('GET', '/api/users')).text);
      t('列表里有它', list.users.some((u) => u.studentId === '9000000000001'));

      const upd = JSON.parse(
        (await req('POST', '/api/user/update', { studentId: '9000000000001', authorized: false })).text,
      );
      t('★ 能关掉授权', upd.user.authorized === false);

      const list2 = JSON.parse((await req('GET', '/api/users')).text);
      const u = list2.users.find((x) => x.studentId === '9000000000001');
      t('★ 列表反映已关闭', u.authorized === false);

      const del = JSON.parse((await req('POST', '/api/user/delete', { studentId: '9000000000001' })).text);
      t('能删除', del.ok === true);

      const list3 = JSON.parse((await req('GET', '/api/users')).text);
      t('删除后不在列表', !list3.users.some((x) => x.studentId === '9000000000001'));
    }

    console.log('\n=== 5) 万能码解锁 → 自动下发个人授权码 ===');
    {
      const g = JSON.parse(
        (await req('POST', '/api/grant', {
          studentId: '9000000000002',
          studentName: '领码人',
        })).text,
      );
      t('领码成功', g.ok === true);
      t('返回了个人授权码', typeof g.personalCode === 'string' && g.personalCode.startsWith('LK1-'), g.personalCode);
      t('记进了用户档案', g.user.code === g.personalCode);
      t('标记为"由万能码授予"', g.user.grantedByMaster === true);
      t('默认已授权', g.user.authorized === true);

      // 再领一次 → 应该是同一份码（便于管理员核对）
      const g2 = JSON.parse((await req('POST', '/api/grant', { studentId: '9000000000002' })).text);
      t('★ 重复领取返回同一份码', g2.personalCode === g.personalCode);

      // 不同学号 → 不同码
      const g3 = JSON.parse((await req('POST', '/api/grant', { studentId: '9000000000003' })).text);
      t('★ 不同学号拿到不同的码', g3.personalCode !== g.personalCode);

      // 缺学号
      const bad = await req('POST', '/api/grant', {});
      t('缺学号 400', bad.status === 400);

      // 清理
      await req('POST', '/api/user/delete', { studentId: '9000000000002' });
      await req('POST', '/api/user/delete', { studentId: '9000000000003' });
    }

    console.log('\n=== 6) 管理员签发授权码（输入学号 → 返回绑该学号的码）===');
    {
      const a = JSON.parse(
        (await req('POST', '/api/issue', { studentId: '9000000000011', studentName: '签发测试' })).text,
      );
      t('签发成功', a.ok === true);
      t('返回 LK1- 开头的个人码', typeof a.code === 'string' && a.code.startsWith('LK1-'), a.code);
      t('标记来源为管理员签发', a.user.issuedByAdmin === true);
      t('默认已授权', a.user.authorized === true);
      t('★ 签发不累加登录次数', a.user.loginCount === 0, String(a.user.loginCount));
      t('未登录时 lastLoginAt 为空', a.user.lastLoginAt === null);

      // 再次签发同一学号 → 复用同一份码（便于核对）
      const again = JSON.parse((await req('POST', '/api/issue', { studentId: '9000000000011' })).text);
      t('★ 重复签发复用同一份码', again.code === a.code && again.reused === true);

      // 不同学号 → 不同码
      const other = JSON.parse((await req('POST', '/api/issue', { studentId: '9000000000012' })).text);
      t('★ 不同学号拿到不同的码', other.code !== a.code);

      // 参数校验
      const badChars = await req('POST', '/api/issue', { studentId: '中文' });
      t('非法学号 400', badChars.status === 400);
      const missing = await req('POST', '/api/issue', {});
      t('缺学号 400', missing.status === 400);

      // 清理
      await req('POST', '/api/user/delete', { studentId: '9000000000011' });
      await req('POST', '/api/user/delete', { studentId: '9000000000012' });
    }

    console.log('\n=== 7) ★ 签发出来的码必须能被 App 算法校验通过 ===');
    {
      /**
       * 这是整条链路最容易出问题、也最难发现的地方：
       * 管理页生成的码 → 发给用户 → 用户在 App 里填 → App 本地校验。
       * 如果服务端算法与 App 有半点差异，用户看到的只是"授权码无效"，
       * 根本对不上因果。所以这里直接拿接口产出的码做完整校验。
       */
      // 复刻 App 的校验逻辑（与 licenseCode.ts 同算法）
      const B32 = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
      const norm = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();
      const fnvHash = (sid) => {
        const s = norm(sid);
        const fnv = (seed) => {
          let h = seed >>> 0;
          for (let i = 0; i < s.length; i += 1) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
          }
          return h >>> 0;
        };
        return fnv(0x811c9dc5).toString(16).padStart(8, '0') + fnv(0x9e3779b9).toString(16).padStart(8, '0');
      };
      const toB32 = (bytes) => {
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
      };
      const hexBytes = (hex) => {
        const o = [];
        for (let i = 0; i + 1 < hex.length; i += 2) o.push(parseInt(hex.slice(i, i + 2), 16));
        return o;
      };
      const canon = (s) => String(s ?? '').replace(/[^0-9a-zA-Z]/g, '').toUpperCase();

      /** 返回 null 表示通过，否则是失败原因 */
      function verifyLikeApp(code, studentId) {
        const raw = canon(code);
        if (!raw.startsWith('LK1')) return 'prefix';
        const body = raw.slice(3);
        if (body.length !== 28) return 'length';
        const payload = body.slice(0, 13);
        // 学号哈希前 6 字节 → Base32 前 10 字符
        const head = toB32([...hexBytes(fnvHash(studentId)).slice(0, 6), 0, 0]).slice(0, 10);
        if (!payload.startsWith(head)) return 'studentIdHash';
        return null;
      }

      const SIDS = ['9000000000021', '2099000000114', '2099000000116'];
      for (const sid of SIDS) {
        const r = JSON.parse((await req('POST', '/api/issue', { studentId: sid })).text);
        const why = verifyLikeApp(r.code, sid);
        t(`学号 ${sid} 的签发码能被 App 算法通过`, why === null, why ?? '');
      }

      // ★ 换学号必须失败（防转借）
      const a = JSON.parse((await req('POST', '/api/issue', { studentId: '9000000000021' })).text);
      const why2 = verifyLikeApp(a.code, '9000000000022');
      t('★ 签发的码换学号后校验失败（不能转借）', why2 === 'studentIdHash', why2 ?? '（竟然通过了！）');

      // 清理
      for (const sid of SIDS) await req('POST', '/api/user/delete', { studentId: sid });
    }

    console.log('\n=== 8) 边界 ===');
    {
      const r404 = await req('GET', '/api/nope');
      t('未知接口 404', r404.status === 404);

      const regBad = await req('POST', '/api/register', {});
      t('缺学号 400', regBad.status === 400);

      const updMissing = await req('POST', '/api/user/update', { studentId: '不存在' });
      t('改不存在的用户 404', updMissing.status === 404);
    }

    /**
     * ══════════ 9) 管理口令 ══════════
     *
     * ⚠️ 这一节**必须放最后**，而且测完要把口令清掉 ——
     *    一旦启用，后面的管理接口都需要带凭据，会把其他用例全部挡掉。
     *
     * 为什么要这个功能：服务监听 0.0.0.0，同一个 WiFi 下任何人都能打开
     * 管理页 —— 看到所有人的学号、改万能码、把人踢下线。
     * 十几到几十个人用时这不可接受。
     */
    console.log('\n=== 9) 管理口令（保护管理面）===');
    {
      const AUTH = { user: 'admin', pass: 'testpw123' };

      /**
       * ⚠️ 整节用 try/finally 包住。
       *
       * 踩过的坑：这一节崩了一次（HTTP 头不能含中文，直接抛异常），
       * 结果**口令没被清掉**，留在了 data.json 里 ——
       * 而崩在 finally 之前，连外层的备份还原都跑不到，
       * 下一次测试一上来就被 401 挡住，看起来像"功能坏了"。
       *
       * 所以：口令相关的清理必须**自己的 finally 管自己**。
       */
      let passwordChanged = false;
      try {
      // 未启用口令时，管理页可直接访问（保持原有用法不变）
      const before = await req('GET', '/admin');
      t('未启用口令时管理页可访问', before.status === 200);

      const pwState = JSON.parse((await req('GET', '/api/admin/password')).text);
      t('能查到口令未启用', pwState.enabled === false);

      // 首次设置不需要旧口令（否则永远启用不了）
      const set = await req('POST', '/api/admin/password', { password: AUTH.pass });
      t('★ 首次设置口令成功', JSON.parse(set.text).enabled === true);
      passwordChanged = true;

      // 启用后：无凭据 → 401 且带 WWW-Authenticate
      const noAuth = await req('GET', '/admin');
      t('★ 启用后无凭据访问管理页 → 401', noAuth.status === 401);
      t('★ 401 带 WWW-Authenticate（浏览器会弹输入框）', /Basic/.test(noAuth.wwwAuth ?? ''));
      // 头里不能有非 ASCII —— 否则 Node 会抛 ERR_INVALID_CHAR 让服务崩掉
      t('★ WWW-Authenticate 只含 ASCII（中文会让服务崩）', !/[^\x00-\x7F]/.test(noAuth.wwwAuth ?? ''));

      // 错误的凭据也要被拒
      const badAuth = await req('GET', '/admin', undefined, { user: 'admin', pass: 'wrong' });
      t('★ 口令错误 → 401', badAuth.status === 401);
      const badUser = await req('GET', '/admin', undefined, { user: 'root', pass: AUTH.pass });
      t('★ 用户名错误 → 401', badUser.status === 401);

      // 正确凭据 → 放行
      const okAuth = await req('GET', '/admin', undefined, AUTH);
      t('★ 凭据正确 → 200', okAuth.status === 200);

      // 各类管理接口都要被保护
      const protectedCalls = [
        ['GET', '/api/users', undefined],
        ['POST', '/api/user/update', { studentId: 'x', authorized: false }],
        ['POST', '/api/master', { masterCode: 'hacked' }],
        ['POST', '/api/issue', { studentId: '9000000000099' }],
        ['GET', '/api/export', undefined],
      ];
      for (const [m, p, b] of protectedCalls) {
        const r = await req(m, p, b);
        t(`★ ${m} ${p} 无凭据被拒`, r.status === 401);
      }

      // ★ App 用的接口**不能**被保护 —— 凭据放进 APK 等于公开
      const appCalls = [
        ['GET', '/api/ping', undefined],
        ['GET', '/api/master', undefined],
        ['POST', '/api/register', { studentId: '9000000000098' }],
        ['POST', '/api/grant', { studentId: '9000000000098' }],
        ['GET', '/api/auth-state?studentId=9000000000098', undefined],
      ];
      for (const [m, p, b] of appCalls) {
        const r = await req(m, p, b);
        t(`√ App 接口 ${m} ${p.split('?')[0]} 不受影响`, r.status === 200);
      }

      /**
       * ★★ 最关键的一组：启用口令后，App 必须仍能查到授权状态。
       *
       * 踩过的坑：App 原先调 `/api/users`（要口令的接口）来判断授权 →
       * 加口令后一直吃 401 → "管理员远程关掉某人"**静默失效**：
       * 表面上不报错，只是永远走"未知、不拦"的分支，谁也发现不了。
       * 所以这里专门验完整链路：带口令时仍可查、关掉后能查到 false。
       */
      {
        const st = await req('GET', '/api/auth-state?studentId=9000000000098');
        t('★★ 口令启用后 /api/auth-state 不带凭据仍可访问', st.status === 200);
        const j = JSON.parse(st.text);
        t('★★ 能拿到该学号的授权状态', j.ok === true && j.studentId === '9000000000098');
        /**
         * ══════════════ ★★★ 语义变了（2026-10 安全收紧）══════════════
         *
         * 上面只对这个学号调过 `/api/register`（登录上报）和 `/api/grant`。
         * 而收紧之后"被授权"的判据是 **有管理员签发的授权码**，
         * 光登录上报**不再**算授权（那正是之前的漏洞）。
         *
         * 所以这里现在应该是 **false** —— 要签发了才是 true。
         * 完整行为见 verify-auth-tightening.cjs。
         */
        t('★★★ 只登录上报过 → authorized=false（收紧后的正确行为）', j.authorized === false,
          JSON.stringify(j));

        // 关掉授权 → 再查仍是 false（"远程关人"链路仍然有效）
        await req('POST', '/api/user/update', { studentId: '9000000000098', authorized: false }, AUTH);
        const st2 = await req('GET', '/api/auth-state?studentId=9000000000098');
        t('★★ 关掉授权后 App 立刻能查到 authorized=false', JSON.parse(st2.text).authorized === false);

        /**
         * ★ 未登记的学号 → **false**（不再是宽松的 true）。
         *   这是本次收紧的核心：谁都能编个学号就过，等于门没锁。
         */
        const st3 = await req('GET', '/api/auth-state?studentId=1111111111111');
        t('★★★ 未登记的学号也返回 authorized=false（不再宽松放行）',
          JSON.parse(st3.text).authorized === false, st3.text.slice(0, 120));
        t('未登记时 known=false', JSON.parse(st3.text).known === false);

        const st4 = await req('GET', '/api/auth-state');
        t('缺 studentId → 400', st4.status === 400);

        // 恢复授权，免得影响后续断言
        await req('POST', '/api/user/update', { studentId: '9000000000098', authorized: true }, AUTH);
      }

      // 万能码没被改掉（因为上一步的篡改被 401 挡住了）
      const mc = JSON.parse((await req('GET', '/api/master')).text);
      t('★ 未授权者没能改掉万能码', mc.masterCode !== 'hacked');

      // 修改口令必须带旧口令
      const changeNoAuth = await req('POST', '/api/admin/password', { password: 'newpass' });
      t('★ 改已有口令但没带旧口令 → 401', changeNoAuth.status === 401);
      const changeOk = await req('POST', '/api/admin/password', { password: 'newpass456' }, AUTH);
      t('带旧口令可以改', JSON.parse(changeOk.text).enabled === true);
      const oldNowBad = await req('GET', '/admin', undefined, AUTH);
      t('★ 改完旧口令失效', oldNowBad.status === 401);
      const newOk = await req('GET', '/admin', undefined, { user: 'admin', pass: 'newpass456' });
      t('新口令可用', newOk.status === 200);

      // 太短的口令要被拒
      const tooShort = await req(
        'POST',
        '/api/admin/password',
        { password: 'ab' },
        { user: 'admin', pass: 'newpass456' },
      );
      t('口令太短 → 400', tooShort.status === 400);
      } finally {
        /**
         * ⚠️ 无论如何都要把口令清掉。
         *    留着它会把 data.json 变成"需要口令"的状态，
         *    下次测试或用户自己打开管理页就会莫名其妙被拦。
         */
        if (passwordChanged) {
          for (const pw of ['testpw123', 'newpass456', 'newpass']) {
            try {
              const r = await req('POST', '/api/admin/password', { password: '' }, { user: 'admin', pass: pw });
              if (r.status === 200) break;
            } catch {
              /* 试下一个 */
            }
          }
        }
      }

      // 确认已经关掉（这一条放在 finally 之后，若没关掉会失败）
      const cleared = JSON.parse((await req('GET', '/api/admin/password')).text);
      t('★ 测试结束口令已清空（不污染 data.json）', cleared.enabled === false);
      const afterClear = await req('GET', '/admin');
      t('关闭后管理页恢复可访问', afterClear.status === 200);

      // 清理测试用户
      await req('POST', '/api/user/delete', { studentId: '9000000000098' });
    }
  } finally {
    mod.server.close();
    await sleep(200);
    if (backup) fs.writeFileSync(dataFile, backup);
    else if (fs.existsSync(dataFile)) fs.unlinkSync(dataFile);
  }

  console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('  异常：' + e.message);
  process.exit(1);
});

