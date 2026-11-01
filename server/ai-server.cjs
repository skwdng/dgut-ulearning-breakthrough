/**
 * LifeKit「小c」AI 服务 —— Ollama + RAG 的网关。
 *
 * ══════════════ 架构 ══════════════
 *
 *   手机 App（小c 聊天页）
 *     ├─ ① 把本地数据（外卖订单 / 优学院课程签到作业）切成短句
 *     ├─ ② 调本服务 /ai/embed 拿向量 → 存在手机本地（不外泄）
 *     ├─ ③ 用户提问 → 本地算相似度，取最相关的几条
 *     └─ ④ 把「问题 + 相关数据」发 /ai/chat → 这里转发给 Ollama
 *
 * ⚠️ 为什么向量存在**手机**上而不是服务器：
 *    外卖/签到是私人数据。服务器只做"算向量/生成回答"，
 *    **不落盘任何用户记录** —— 这样即使服务器被看，也拿不到谁吃过什么。
 *
 * ══════════════ 鉴权 ══════════════
 *
 * 请求必须带 `studentId`，本服务会去问**同机的管理服务**（127.0.0.1:8787）
 * `/api/auth-state?studentId=…`：
 *   · 管理服务明确回 authorized:true → 放行
 *   · 明确回 false → 403（没授权的人不能用小c，避免被白嫖算力）
 *   · 管理服务连不上 → **放行**（与 App 一致的策略：服务器故障不该把人卡死）
 *
 * ══════════════ 资源约束（实测 VPS：2 核 / 1.6GB）══════════════
 *
 *   · 对话模型 qwen2.5:0.5b（小、能跑；回答质量一般但够用）
 *   · 向量模型 all-minilm（46MB，快）
 *   · 并发请求串行化 —— 2 核机器上并行只会互相拖慢
 *
 * 端口：8789（LifeKit 管理服务是 8787，kill switch 是 8788）
 *
 * 启动：node ai-server.cjs   或  systemctl start lifekit-ai
 */
const http = require('node:http');

const PORT = Number(process.env.AI_PORT || 8789);
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const MGMT = process.env.MGMT_URL || 'http://127.0.0.1:8787';
const CHAT_MODEL = process.env.AI_CHAT_MODEL || 'qwen2.5:0.5b';
const EMBED_MODEL = process.env.AI_EMBED_MODEL || 'all-minilm';

/** 请求体上限（防止有人拿它当文件上传） */
const MAX_BODY = 256 * 1024;

/** 串行队列 —— 2 核机器上同时跑两个推理只会都变慢 */
let chain = Promise.resolve();
function serialize(fn) {
  const next = chain.then(fn, fn);
  // 保证链不因单次失败断掉
  chain = next.catch(() => {});
  return next;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX_BODY) {
        reject(new Error('请求体太大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      if (!s) return resolve({});
      try {
        resolve(JSON.parse(s));
      } catch {
        reject(new Error('请求体不是 JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function httpJson(url, init, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 200) };
    }
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 校验 studentId 是否被授权。
 * 返回 'ok' | 'denied' | 'unknown'
 */
async function checkStudent(studentId) {
  if (!studentId || !/^[A-Za-z0-9_-]{3,32}$/.test(String(studentId))) return 'denied';
  try {
    const r = await httpJson(
      `${MGMT}/api/auth-state?studentId=${encodeURIComponent(studentId)}`,
      { method: 'GET' },
      4000,
    );
    if (r.status !== 200) return 'unknown';
    if (r.data && r.data.authorized === true) return 'ok';
    if (r.data && r.data.authorized === false) return 'denied';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 调 Ollama 生成回答（非流式，简单可靠） */
async function chatOnce(system, messages) {
  const payload = {
    model: CHAT_MODEL,
    stream: false,
    options: {
      temperature: 0.3,
      num_predict: 512,
      /** 上下文别开太大：0.5b 模型 + 1.6G 内存，8k 就够 */
      num_ctx: 4096,
    },
    messages: [{ role: 'system', content: system }, ...messages],
  };
  const r = await httpJson(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, 180000);
  if (r.status !== 200) {
    throw new Error(`Ollama HTTP ${r.status}：${JSON.stringify(r.data).slice(0, 160)}`);
  }
  const content = r.data?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('Ollama 返回空回答');
  return content.trim();
}

/** 调 Ollama 算向量（一次一条，all-minilm 很快） */
async function embedOne(text) {
  const r = await httpJson(`${OLLAMA}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: String(text).slice(0, 2000) }),
  }, 30000);
  if (r.status !== 200 || !Array.isArray(r.data?.embedding)) {
    throw new Error(`向量失败 HTTP ${r.status}`);
  }
  return r.data.embedding;
}

/** 小c 的人设与规矩 */
function systemPrompt() {
  return [
    '你是「小c」，LifeKit App 里的私人生活助手。',
    '你的用户是一名大学生。你能看到两类数据（通过下面提供的资料片段）：',
    '  1) 外卖订单记录：店名、金额、时间；',
    '  2) 优学院数据：课程、课堂签到/点名记录、作业与课件任务。',
    '',
    '回答规矩：',
    '· 只根据【资料】回答；资料里没有的，就说"我这儿没有这条记录"，不要编。',
    '· 数字要准确：金额、次数、日期按资料原文来。',
    '· 中文回答，简洁口语化，像朋友聊天；超过 3 条数据时用短列表。',
    '· 涉及时间时先说明是哪段时间（例如"最近 7 天"）。',
    '· 不提供代考、代跑、作弊类建议。',
  ].join('\n');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'OPTIONS') return json(res, 204, {});

  if (p === '/ai/health') {
    let models = [];
    try {
      const r = await httpJson(`${OLLAMA}/api/tags`, { method: 'GET' }, 4000);
      models = (r.data?.models ?? []).map((m) => m.name);
    } catch {
      /* 忽略 */
    }
    return json(res, 200, {
      ok: true,
      chatModel: CHAT_MODEL,
      embedModel: EMBED_MODEL,
      ollamaUp: models.length > 0,
      models,
    });
  }

  if (p === '/ai/embed' && req.method === 'POST') {
    return serialize(async () => {
      try {
        const body = await readBody(req);
        const gate = await checkStudent(body.studentId);
        if (gate === 'denied') return json(res, 403, { ok: false, error: '这个学号没有授权，不能用小c' });
        const texts = Array.isArray(body.texts) ? body.texts.slice(0, 64) : [];
        if (!texts.length) return json(res, 400, { ok: false, error: 'texts 为空' });
        const vectors = [];
        for (const t of texts) vectors.push(await embedOne(t));
        return json(res, 200, { ok: true, model: EMBED_MODEL, vectors });
      } catch (e) {
        return json(res, 500, { ok: false, error: String(e.message || e) });
      }
    });
  }

  if (p === '/ai/chat' && req.method === 'POST') {
    return serialize(async () => {
      try {
        const body = await readBody(req);
        const gate = await checkStudent(body.studentId);
        if (gate === 'denied') return json(res, 403, { ok: false, error: '这个学号没有授权，不能用小c' });

        const history = Array.isArray(body.messages) ? body.messages : [];
        const context = Array.isArray(body.context) ? body.context : [];
        const msgs = history
          .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
          .slice(-8)
          .map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) }));
        if (!msgs.length) return json(res, 400, { ok: false, error: 'messages 为空' });

        const ctx =
          context.length === 0
            ? '（本次没有检索到相关资料。请说明你没有相关记录。）'
            : context
                .slice(0, 8)
                .map((c, i) => `${i + 1}. ${String(c).slice(0, 300)}`)
                .join('\n');

        /** 把资料拼进最后一条用户消息，避免弱模型"忽略 system" */
        const last = msgs[msgs.length - 1];
        const augmented = {
          role: 'user',
          content: `【资料】\n${ctx}\n\n【问题】\n${last.content}`,
        };

        const reply = await chatOnce(systemPrompt(), [...msgs.slice(0, -1), augmented]);
        return json(res, 200, { ok: true, reply, model: CHAT_MODEL, usedContext: context.length });
      } catch (e) {
        return json(res, 500, { ok: false, error: String(e.message || e) });
      }
    });
  }

  return json(res, 404, { ok: false, error: '没有这个接口' });
});

/**
 * ⚠️ 只监听 **127.0.0.1**（不对外）：
 *    外网入口统一走 8787 的 `/ai/*` 反向代理（server.cjs），
 *    这样只暴露一个端口、只开一个安全组规则，也少一个攻击面。
 */
server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  LifeKit 小c AI 服务已启动');
  console.log('  ─────────────────────────────');
  console.log(`  端口      : ${PORT}`);
  console.log(`  对话模型  : ${CHAT_MODEL}`);
  console.log(`  向量模型  : ${EMBED_MODEL}`);
  console.log(`  Ollama    : ${OLLAMA}`);
  console.log(`  管理服务  : ${MGMT}（用来校验学生授权）`);
  console.log('');
});
