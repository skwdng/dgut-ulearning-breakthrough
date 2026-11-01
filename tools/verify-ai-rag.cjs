/**
 * 「小c」AI 功能回归测试（Ollama + RAG）。
 *
 * ══════════════ 用户需求（原话）══════════════
 *
 *   「试试完善下 ai 功能，部署个 Ollama，然后用 RAG 做向量检索，查以前的数据，
 *     然后智能体名字就是小c，小c 可以调用外卖数据包括优学院开放好的功能的数据」
 *
 * ══════════════ 这份测试盯什么 ══════════════
 *
 *  1. 名字叫「小c」，且 AI 页真的接了模型（不是占位回复）
 *  2. RAG 是真的：切句 → 算向量 → 余弦检索 → 把资料塞进上下文
 *  3. 数据来源包含 外卖 + 优学院（课程/签到/作业/课件）
 *  4. **隐私**：原文与向量只存手机本地，服务器不落盘
 *  5. 服务器地址从已有配置推导（8787 → 8789），不新增硬编码 IP
 *
 * ⚠️ 只读源码 + 正则；判据前剥注释（注释里就写着接口名）。
 *
 * 用法: node tools/verify-ai-rag.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

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

const CLIENT = read('src/services/aiClient.ts');
const CLIENT_CODE = strip(CLIENT);
const SCREEN = read('src/screens/tab-ai.tsx');
const SCREEN_CODE = strip(SCREEN);
const SERVER = read('server/ai-server.cjs');
const SERVER_CODE = strip(SERVER);
const STORAGE = read('src/services/storage.ts');

console.log('');
console.log('=== 1) ★★★ 智能体叫「小c」且真的接了模型 ===');
t('★★★ AI 页名字是「小c」', /小c/.test(SCREEN));
t(
  '★★★ 不再是占位回复（没有"还没有接入模型"这类话）',
  !/还没有接入模型|暂时没法真的回答/.test(SCREEN),
  '旧版是占位聊天框',
);
t('★★★ 页面真的调用了 AI 接口', /syncAndRetrieve\(/.test(SCREEN_CODE) && /aiChat\(/.test(SCREEN_CODE));

console.log('');
console.log('=== 2) ★★★ RAG 是真的（切句→向量→余弦→上下文）===');
t('★★★ 有文档切句（RagDoc + buildDocs 逻辑）', /interface RagDoc|RagDoc\[\]/.test(CLIENT));
t('★★★ 调服务器算向量', /\/ai\/embed/.test(CLIENT_CODE));
t('★★★ 本地余弦相似度检索', /function cosine/.test(CLIENT_CODE) && /sort\(/.test(CLIENT_CODE));
t('★★★ 只把"新数据"送去算向量（缓存命中）', /missing/.test(CLIENT_CODE) && /oldMap/.test(CLIENT_CODE));
t('★★ 有清空索引的能力（重建缓存）', /clearRagIndex/.test(CLIENT_CODE));

console.log('');
console.log('=== 3) ★★★ 数据来源：外卖 + 优学院 ===');
t('★★★ 接了外卖数据', /useDelivery/.test(SCREEN_CODE) && /orders/.test(SCREEN_CODE));
t('★★★ 接了签到记录', /useSign/.test(SCREEN_CODE) && /allRecords/.test(SCREEN_CODE));
t('★★ 接了课程', /courses/.test(SCREEN_CODE));
t('★★ 接了作业与课件', /useTask/.test(SCREEN_CODE) && /homeworks/.test(SCREEN_CODE) && /coursewares/.test(SCREEN_CODE));
t(
  '★★ 资料里带中文语义（外卖/签到/作业/课程 字样）',
  /外卖订单：/.test(SCREEN) && /签到记录：/.test(SCREEN) && /作业（未提交）/.test(SCREEN),
  '资料里只有字段名的话，模型检索不到中文问法',
);

console.log('');
console.log('=== 4) ★★★ 隐私：原文与向量只在手机本地 ===');
t('★★★ 向量缓存在本地存储键 aiRagIndex', /aiRagIndex/.test(STORAGE));
t(
  '★★★ 服务器**不保存**用户数据（只有计算逻辑）',
  !/fs\.writeFileSync/.test(SERVER_CODE),
  '服务器一旦落盘就等于把用户记录交出去了',
);

console.log('');
console.log('=== 5) ★★★ 服务器地址复用 + 反向代理 + 鉴权 ===');
const MGMT = read('server/server.cjs');
const MGMT_CODE = strip(MGMT);
t(
  '★★★ App 复用管理服务器地址（不新增配置项、不硬编码 8789）',
  /function aiBaseFrom/.test(CLIENT_CODE) && !/8789/.test(CLIENT_CODE),
  'App 只填一个服务器地址，小c 走同一地址的 /ai/*',
);
t(
  '★★★ 服务器把 /ai/* 反向代理到本机 8789（云安全组只放行 8787）',
  /function proxyToAi/.test(MGMT_CODE) && /startsWith\(\s*['"]\/ai\/['"]\s*\)/.test(MGMT_CODE),
  '不开代理的话外网连 8789 会超时',
);
t(
  '★★★ /ai 在管理口令**之前**被拦下（App 调用，不能要口令）',
  MGMT_CODE.indexOf("startsWith('/ai/')") < MGMT_CODE.indexOf('isProtected(p, req.method)'),
);
t('★★★ 服务端有 /ai/health /ai/embed /ai/chat', /\/ai\/health/.test(SERVER_CODE) && /\/ai\/embed/.test(SERVER_CODE) && /\/ai\/chat/.test(SERVER_CODE));
t('★★★ 服务端校验学号授权（auth-state）', /auth-state\?studentId=/.test(SERVER_CODE));
t('★★★ 推理串行化（小服务器：2 核，不能并发）', /function serialize/.test(SERVER_CODE));
t('★★ 模型可配置（默认 qwen2.5:0.5b / all-minilm）', /qwen2\.5:0\.5b/.test(SERVER_CODE) && /all-minilm/.test(SERVER_CODE));

console.log('');
console.log('=== 6) ★★★ 真机问题修复（卡住 / 记录消失 / 数字算错）===');
const TOOLS = read('src/services/aiTools.ts');
const TOOLS_CODE = strip(TOOLS);
const CLIENT_NOW = read('src/services/aiClient.ts');
const CLIENT_NOW_CODE = strip(CLIENT_NOW);
const SCREEN_NOW = read('src/screens/tab-ai.tsx');
const SCREEN_NOW_CODE = strip(SCREEN_NOW);

t(
  '★★★ 问候语本地秒回（SMALL_TALK 快路径，不联网）',
  /SMALL_TALK/.test(SCREEN_NOW_CODE) && /SMALL_TALK\.test\(text\)/.test(SCREEN_NOW_CODE),
  '旧版"你好"也要走完整检索 → 卡很久',
);
t(
  '★★★ 对话记录持久化（切 tab 回来还在）',
  /aiChatHistory/.test(read('src/services/storage.ts')) &&
    /STORE_KEYS\.aiChatHistory/.test(SCREEN_NOW_CODE) &&
    /store\.set\(STORE_KEYS\.aiChatHistory/.test(SCREEN_NOW_CODE),
  '旧版 useState 卸载即丢',
);
t(
  '★★★ 支持「停止」（AbortController）',
  /AbortController/.test(SCREEN_NOW_CODE) && /abortRef/.test(SCREEN_NOW_CODE) && /signal/.test(CLIENT_NOW_CODE),
  '旧版只能干等 90~180 秒',
);
t('★★ 忙碌时显示已等秒数', /elapsed/.test(SCREEN_NOW_CODE) && /已等/.test(SCREEN_NOW));
t(
  '★★★ 统计类问题走本地工具（数字不交给模型算）',
  /buildToolContext/.test(SCREEN_NOW_CODE) && /deliverySummary/.test(TOOLS_CODE) && /signSummary/.test(TOOLS_CODE),
  '0.5B 模型不会算数，给多了就编',
);
t(
  '★★★ 有工具的意图就跳过 RAG（不再为几百条逐条算向量）',
  /!tool\.intents\.length/.test(SCREEN_NOW_CODE),
);
t('★★ 向量压缩成 Int8（索引体积 ≈1/4）', /quantize\(/.test(CLIENT_NOW_CODE) && /v: 2/.test(CLIENT_NOW_CODE));
t('★★ 索引条数上限（处理不过来的数据不硬算）', /MAX_INDEX_DOCS/.test(CLIENT_NOW_CODE));

console.log('');
console.log('=== 7) ★★★ 乱码事故修复：统计类问题不交给小模型 ===');
{
  /**
   * 2026-10-30 真机事故（用户截图）：
   *   问「哪门课缺勤最多」，小c 回了 8 遍
   *   「课程「数字逻辑」，缺勤 1 次，但签到 19 次，所以没签到。」
   *
   * 根因：把统计资料塞给 0.5B 模型，它揉资料 + 复读。
   * 修法：数字类问题**本地直接拼答案**，不走模型；模型回答做复读检测。
   */
  t(
    '★★★ 有 composeLocalAnswer（本地拼答案，不经过模型）',
    /export function composeLocalAnswer/.test(TOOLS_CODE),
  );
  t(
    '★★★ 统计类问题在调用模型**之前**就返回本地答案',
    SCREEN_NOW_CODE.indexOf('composeLocalAnswer(') > 0 &&
      SCREEN_NOW_CODE.indexOf('composeLocalAnswer(') < SCREEN_NOW_CODE.indexOf('aiChat('),
    '顺序反了还是会先让模型编',
  );
  t('★★★ 模型回答有复读检测（looksRepetitive）', /export function looksRepetitive/.test(TOOLS_CODE) && /looksRepetitive\(chat\.reply\)/.test(SCREEN_NOW_CODE));
  t('★★ 本地答案覆盖四类数据（外卖/签到/作业/课件）', ['delivery', 'sign', 'homework', 'courseware'].every((k) => new RegExp(`intent === '${k}'`).test(TOOLS_CODE)));
  t(
    '★★ 本地答案写明"按本机记录算的"（不冒充模型推理）',
    /按你手机里的记录直接算的/.test(TOOLS),
  );
  /**
   * ══════════════ 真机事故（2026-10-30 第二起）══════════════
   *
   * 用户问「现在几点了」，模型拿 RAG 里的一条签到时间（16:27）当"现在"，
   * 编出「现在是 2026-10-28 16:27…所以现在是 10:27」。
   *
   * 0.5B 模型**不知道当前时间**，资料里但凡有时间戳就会被它当"现在"。
   * 所以时间/日期这类问题必须本地答（用手机时钟），且不经过模型。
   */
  t('★★★ 时间问题本地答（用手机时钟，不让模型猜）', /现在.*几点|几点\(了\|钟\)\?|当前时间/.test(TOOLS_CODE) && /fmtDateTime\(now\)/.test(TOOLS_CODE));
  t('★★★ 日期/星期问题本地答', /今天.*几号/.test(TOOLS_CODE) && /星期\$?\{?week|week\}/.test(TOOLS_CODE));
  t('★★ 自我介绍也本地答（不浪费一次模型调用）', /你能做什么/.test(TOOLS_CODE));
}

console.log('');
console.log('  ══════════════════════════════════════════════');
console.log('  为什么值得留着：RAG 最容易"假实现"——');
console.log('  只把问题转发给模型、不检索，看起来也能答，但一问历史就露馅。');
console.log('  这份测试钉住"切句/向量/余弦/资料注入"四步都存在。');
console.log('  ⚠️ 报 XX 就是实现确实不满足，不要改断言去迁就。');
console.log('  ══════════════════════════════════════════════');
console.log('');
console.log(`SUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
