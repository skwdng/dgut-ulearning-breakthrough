// 管理页静态自检 —— 语法与关键逻辑是否齐全（不打开浏览器也能查）。
const fs = require('fs');
const path = require('path');

const FILE = process.argv[2] ?? path.resolve(__dirname, '..', 'web', 'manage.html');
const s = fs.readFileSync(FILE, 'utf8');

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

console.log(`  文件: ${path.basename(FILE)}  ${s.length} 字节  ${s.split('\n').length} 行`);
console.log('');

console.log('=== 结构 ===');
t('有 DOCTYPE', s.trimStart().toLowerCase().startsWith('<!doctype html'));
t('有 charset=utf-8', /charset=["']?utf-8/i.test(s));
t('有 <script> 段', s.includes('<script>') && s.includes('</script>'));
t('标题正确', s.includes('LifeKit 用户管理'));

console.log('\n=== 打开方式防护（这次踩的坑）===');
t('检测 file:// 协议', s.includes("location.protocol === 'file:'"));
t('有"打开方式不对"提示块', s.includes('打开方式不对'));
t('提示里说明了要用 .cmd', s.includes('打开管理后台.cmd'));
t('提示里给了正确网址', s.includes('127.0.0.1:8787/admin'));

console.log('\n=== 错误处理（不能沉默失败）===');
t('api() 捕获网络错误', s.includes('连不上后台服务'));
t('loadMaster 有 try/catch', /async function loadMaster\(\)\s*\{\s*try\s*\{/.test(s));
t('loadUsers 有 try/catch', /async function loadUsers\(\)\s*\{\s*try\s*\{/.test(s));
t('loadAddr 有 try/catch', /async function loadAddr\(\)\s*\{\s*try\s*\{/.test(s));

console.log('\n=== 功能点 ===');
t('概览：登记用户', s.includes('stat-total'));
t('概览：已授权', s.includes('stat-auth'));
t('概览：当前万能码', s.includes('stat-code'));
t('★ 生成授权码：输入学号', s.includes('id="issue-sid"'));
t('★ 生成授权码：调用 /api/issue', s.includes("api('/api/issue'"));
t('★ 生成授权码：可复制结果', s.includes('function copyCode'));
t('★ 管理口令：状态显示', s.includes('id="pw-state"'));
t('★ 管理口令：设置在无口令时给出警告', s.includes('现在没有口令') && s.includes('任何人都能打开这个页面'));
t('★ 管理口令：有启用/修改按钮', s.includes('function savePassword'));
t('★ 管理口令：有关闭按钮', s.includes('function clearPassword'));
t('★ 管理口令：说明只保护管理页（不影响 App）', s.includes('只有管理页需要口令'));
t('★ 管理口令：说明用户名是 admin', s.includes('用户名固定为'));

/* ══════════ 配额（截止时间 + 次数）界面 ══════════ */
t('★ 生成区有截止时间输入', s.includes('id="issue-exp"') && s.includes('type="datetime-local"'));
t('★ 生成区有次数输入', s.includes('id="issue-max"') && s.includes('type="number"'));
t('★ 说明留空 = 永久 + 不限次', s.includes('都留空 = 永久 + 不限次'));
t('★ 说明截止时间编进码里（断网也能判）', s.includes('会编进授权码本身'));
t('★ 说明次数由服务器记（本地清不掉）', s.includes('由服务器记录'));
t('★ 说明不能设成过去', s.includes('不能设成过去'));
t('★ 有截止时间校验函数', s.includes('function readExpiryInput'));
t('★ 有次数校验函数', s.includes('function readMaxUsesInput'));
t('★ 有配额展示函数', s.includes('function fmtQuota'));
t('★ 用户列表能改截止时间', s.includes('class="tiny-exp"'));
t('★ 用户列表能改次数', s.includes('class="tiny-max"'));
t('★ 用户列表显示已用次数', s.includes('已用 ${u.usedCount'));
t('★ 有"次数清零"按钮', s.includes('function resetUsed') && s.includes('次数清零'));
t('★ 有本地时间格式化函数', s.includes('function toLocalInputValue'));
/**
 * ⚠️ 时区陷阱：回填 datetime 值**必须用本地时间**。
 *    用 `toISOString().slice(0,10)` 会得到 UTC 日期，在中国差 8 小时 ——
 *    "选 10 号却存成 9 号"，而且极难发现。
 */
t('★★ 回填日期不再用 toISOString（UTC 会差 8 小时）', !/value="\$\{[^}]*toISOString/.test(s));
t('★ 解析本地时间有独立函数', s.includes('function parseLocalInputValue'));
t('★ 保存前先挡"过去的时间"', /截止时间不能是过去的时间/.test(s));
t('复制有兜底（http 下 clipboard 不可用）', s.includes('function fallbackCopy'));
t('生成结果显示学号与姓名', s.includes('issued-code'));
t('用户列表显示码来源（签发/万能码）', s.includes('issuedByAdmin') && s.includes('grantedByMaster'));
t('万能码：保存', s.includes('saveMaster'));
t('用户：搜索', s.includes('id="search"'));
t('用户：授权切换', s.includes('toggleAuth'));
t('用户：保存行', s.includes('saveRow'));
t('用户：删除', s.includes('delUser'));
t('用户：导出备份', s.includes('exportJson'));
t('自动刷新', s.includes('setInterval(loadUsers'));
t('地址按网卡类型展示', s.includes('addressesDetail'));
t('热点地址高亮', s.includes("startsWith('★')"));

console.log('\n=== 括号平衡（script 段）===');
const a = s.indexOf('<script>');
const b = s.indexOf('</script>');
const script = s.slice(a, b);
let d = 0;
let p = 0;
let br = 0;
for (const c of script) {
  if (c === '{') d += 1;
  else if (c === '}') d -= 1;
  if (c === '(') p += 1;
  else if (c === ')') p -= 1;
  if (c === '[') br += 1;
  else if (c === ']') br -= 1;
}
t(`花括号平衡（差 ${d}）`, d === 0);
t(`圆括号平衡（差 ${p}）`, p === 0);
t(`方括号平衡（差 ${br}）`, br === 0);

/**
 * App 设置页的「授权码」不能因为存了无效码就卡死。
 * ⚠️ 真实踩过的坑：原先写成「只要存过码就只显示状态」，
 *    于是存进一个无效码后既看不到输入框也没法清除 —— 只能卸载重装。
 */
console.log('\n=== App 设置页：无效授权码不能卡死 ===');
{
  const settingsPath = path.resolve(__dirname, '..', 'src', 'screens', 'settings.tsx');
  if (fs.existsSync(settingsPath)) {
    const st = fs.readFileSync(settingsPath, 'utf8');
    // 输入框的显示条件必须包含「未生效」
    t('输入框在"未生效"时也显示', /\{!code \|\| !unlocked \? \(/.test(st));
    t('提供清除已保存授权码的入口', st.includes('清除当前保存的授权码'));
    t('清除按钮有对应样式', st.includes('clearBtn'));
  } else {
    t('找到 settings.tsx', false, settingsPath);
  }
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
