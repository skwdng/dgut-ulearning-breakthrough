/**
 * 「小c」AI 客户端 —— 向量检索（RAG）+ 对话。
 *
 * ══════════════ 架构（客户端做检索，服务器只做计算）══════════════
 *
 *   ① 把本地数据切成一堆短句（"文档"）
 *   ② 调服务器 /ai/embed 把每个短句变成**向量**，缓存在手机本地
 *   ③ 用户提问 → 把问题也变向量 → 本地算余弦相似度 → 取最像的几条
 *   ④ 把「问题 + 这几条资料」发给 /ai/chat → 服务器转发给 Ollama 生成回答
 *
 * ⚠️ 为什么向量和原文都存**手机**上：
 *    外卖订单、签到记录都是私人数据。
 *    服务器只"算一下向量/生成回答"，**不保存任何记录** ——
 *    这样即使服务器被人看，也拿不到谁吃过什么、谁逃了哪节课。
 *
 * ⚠️ 为什么要缓存向量：
 *    一条记录一个向量，几百条就要几百次请求。
 *    缓存后只有**新数据**才会重新算；第二次提问几乎是瞬时的。
 *
 * ══════════════ 服务器地址怎么来 ══════════════
 *
 * 小c 服务和 LifeKit 管理服务在**同一台机器**：小c 监听 8789、管理服务 8787。
 * 但云安全组只放行 8787 —— 所以服务器上做了 `/ai/*` 反向代理。
 * App **不新增配置项**：直接用设置里已经填过的服务器地址即可。
 */
import { store, STORE_KEYS } from './storage';
/* 注：不在这里读 getServerBase —— 由调用方（tab-ai）取好后传 base 进来，
   这样这个模块保持"纯函数 + 存储"，便于测试与复用。 */

/* ══════════════════ 基础请求 ══════════════════ */

/**
 * 小c 的请求地址 = **管理服务器地址本身**（不是另开端口）。
 *
 * ⚠️ 为什么不直接连 8789：
 *    小c 服务确实监听 8789，但**云服务器的安全组只放行了 8787/8788** ——
 *    外网连 8789 会直接超时。
 *    所以 `server.cjs` 里加了 `/ai/*` 反向代理：8787 收到后转发给本机 8789。
 *    App 只需要用**已经填过的服务器地址**，不用多配一项。
 */
export function aiBaseFrom(serverBase: string): string {
  const s = String(serverBase ?? '').trim();
  if (!s) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `http://${s}`);
    u.pathname = '';
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

/**
 * 带超时的 JSON 请求。
 *
 * ⚠️ `signal` 用来支持「停止」按钮：用户等不及了可以中断，
 *    否则只能干等 90~180 秒（真机反馈"一直在查询"就是这么来的）。
 */
async function postJson<T>(
  base: string,
  path: string,
  body: unknown,
  timeoutMs = 60000,
  signal?: AbortSignal,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  /** 外部中断 → 一起 abort */
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      return { ok: false, error: '已停止' };
    }
    signal.addEventListener('abort', onAbort);
  }
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let j: unknown;
    try {
      j = JSON.parse(text);
    } catch {
      return { ok: false, error: `小c 服务返回的不是 JSON（HTTP ${res.status}）` };
    }
    const obj = j as { ok?: boolean; error?: string };
    if (!res.ok || obj.ok === false) return { ok: false, error: obj.error ?? `HTTP ${res.status}` };
    return { ok: true, data: j as T };
  } catch (e) {
    const msg = (e as Error).message;
    if (signal?.aborted) return { ok: false, error: '已停止' };
    if (/abort/i.test(msg)) return { ok: false, error: `小c 服务超时（${Math.round(timeoutMs / 1000)} 秒）` };
    return { ok: false, error: `连不上小c 服务：${msg}` };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** 健康检查（设置页/诊断用） */
export async function aiHealth(base: string): Promise<{ ok: boolean; models?: string[]; error?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(`${base}/ai/health`, { signal: ctrl.signal });
    const j = (await res.json()) as { ok?: boolean; models?: string[] };
    return { ok: Boolean(j.ok), models: j.models };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/** 把一组文本变成向量（服务器一次最多 64 条） */
export async function aiEmbed(
  base: string,
  studentId: string,
  texts: string[],
  signal?: AbortSignal,
): Promise<{ ok: true; vectors: number[][] } | { ok: false; error: string }> {
  const r = await postJson<{ vectors?: number[][] }>(
    base,
    '/ai/embed',
    { studentId, texts },
    // ⚠️ 一批最多 16 条，实测服务器 1 秒内返回；90 秒是给"冷启动"留的余量
    45000,
    signal,
  );
  if (!r.ok) return r;
  const vectors = r.data.vectors;
  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    return { ok: false, error: '小c 服务返回的向量数量不对' };
  }
  return { ok: true, vectors };
}

/** 对话（把检索到的资料一起带过去） */
export async function aiChat(
  base: string,
  studentId: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  context: string[],
  signal?: AbortSignal,
): Promise<{ ok: true; reply: string } | { ok: false; error: string }> {
  const r = await postJson<{ reply?: string }>(
    base,
    '/ai/chat',
    { studentId, messages, context },
    // 冷启动实测 6.6 秒、热 1.5 秒；120 秒足够，超了就是真卡住
    120000,
    signal,
  );
  if (!r.ok) return r;
  if (typeof r.data.reply !== 'string' || !r.data.reply.trim()) {
    return { ok: false, error: '小c 没有给出回答（模型可能没加载）' };
  }
  return { ok: true, reply: r.data.reply.trim() };
}

/* ══════════════════ 本地向量索引 ══════════════════ */

export interface RagDoc {
  /** 稳定 id（同一份数据重复构建时不变，用于缓存命中） */
  id: string;
  /** 原始短句（会随上下文发给模型） */
  text: string;
}

/**
 * 索引里的一条：向量**压成 Int8** 存。
 *
 * ══════════════ 为什么要压（真机踩坑）══════════════
 * 第一版存 number[] 原样：400 条 × 384 维 ≈ 3MB JSON。
 * 每次发消息都要 JSON.parse 3MB、还要写入本地存储，
 * 在老设备上这一下就能卡好几秒；而 AsyncStorage 单条上限本来就有限。
 *
 * Int8 量化：每个数只存 -127~127 的整数 + 一个统一的 scale，
 * 体积缩到 ≈1/4，检索精度几乎不变（余弦相似度对浮点误差不敏感）。
 */
interface QItem extends RagDoc {
  /** 量化后的向量（整数） */
  q: number[];
  /** 反量化倍数：真实值 = q[i] * s */
  s: number;
}

interface StoredIndex {
  v: 2;
  model: string;
  items: QItem[];
}

/** 每次最多送多少条去算向量（服务器 1.6G 内存，别一次塞太多） */
const EMBED_BATCH = 16;

/** 索引条数上限：超过就不再算（工具层的统计已经覆盖"按天/按店"这类问题） */
const MAX_INDEX_DOCS = 200;

function quantize(vec: number[]): { q: number[]; s: number } {
  let maxAbs = 0;
  for (const v of vec) maxAbs = Math.max(maxAbs, Math.abs(v));
  if (!maxAbs) return { q: new Array(vec.length).fill(0), s: 1 };
  const s = maxAbs / 127;
  const q = new Array<number>(vec.length);
  for (let i = 0; i < vec.length; i += 1) {
    const x = Math.round(vec[i] / s);
    q[i] = x > 127 ? 127 : x < -127 ? -127 : x;
  }
  return { q, s };
}

function cosine(a: number[], bQ: number[], bS: number): number {
  const n = Math.min(a.length, bQ.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    const b = bQ[i] * bS;
    dot += a[i] * b;
    na += a[i] * a[i];
    nb += b * b;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function loadIndex(): Promise<StoredIndex | null> {
  try {
    const v = await store.get<StoredIndex | null>(STORE_KEYS.aiRagIndex, null);
    if (!v || v.v !== 2 || !Array.isArray(v.items)) return null;
    return v;
  } catch {
    return null;
  }
}

async function saveIndex(idx: StoredIndex): Promise<void> {
  try {
    await store.set(STORE_KEYS.aiRagIndex, idx);
  } catch {
    /* 缓存写不进去不影响本次回答 */
  }
}

/** 清空向量缓存（设置里「重建数据索引」用） */
export async function clearRagIndex(): Promise<void> {
  try {
    await store.remove(STORE_KEYS.aiRagIndex);
  } catch {
    /* 忽略 */
  }
}

/**
 * 同步索引并检索。
 *
 * @param docs     当前本地数据切出来的短句
 * @param question 用户问题
 * @param signal   用户点「停止」时中断（避免干等）
 * @param onStatus 进度回调（"正在整理 12/40"）
 */
export async function syncAndRetrieve(input: {
  base: string;
  studentId: string;
  docs: RagDoc[];
  question: string;
  topK?: number;
  signal?: AbortSignal;
  onStatus?: (s: string) => void;
}): Promise<
  | { ok: true; context: string[]; used: number; total: number; cached: number }
  | { ok: false; error: string }
> {
  const { base, studentId, docs, question, signal } = input;
  const topK = input.topK ?? 5;
  const usable = docs.slice(0, MAX_INDEX_DOCS);

  const old = await loadIndex();
  const oldMap = new Map((old?.items ?? []).map((it) => [it.id, it]));

  /** 只算"新出现或文本变过"的 */
  const missing = usable.filter((d) => {
    const hit = oldMap.get(d.id);
    return !hit || hit.text !== d.text;
  });

  const items: QItem[] = [];
  for (const d of usable) {
    const hit = oldMap.get(d.id);
    if (hit && hit.text === d.text) items.push(hit);
  }

  if (missing.length) {
    for (let i = 0; i < missing.length; i += EMBED_BATCH) {
      if (signal?.aborted) return { ok: false, error: '已停止' };
      const chunk = missing.slice(i, i + EMBED_BATCH);
      input.onStatus?.(`正在准备数据 ${Math.min(i + chunk.length, missing.length)}/${missing.length}`);
      const r = await aiEmbed(
        base,
        studentId,
        chunk.map((d) => d.text),
        signal,
      );
      if (!r.ok) {
        if (r.error === '已停止') return { ok: false, error: '已停止' };
        /* ⚠️ 向量算不出来不该让整个提问失败：先跳过，用工具层的结果回答 */
        input.onStatus?.('部分数据没索引成功，改用统计结果回答');
        break;
      }
      chunk.forEach((d, k) => items.push({ ...d, ...quantize(r.vectors[k]) }));
    }
  }

  /** 索引 = 当前数据（旧数据顺手清掉） */
  await saveIndex({ v: 2, model: 'all-minilm', items });

  if (!items.length) return { ok: true, context: [], used: 0, total: 0, cached: 0 };

  /** 问题向量 */
  if (signal?.aborted) return { ok: false, error: '已停止' };
  input.onStatus?.('正在检索…');
  const qr = await aiEmbed(base, studentId, [question], signal);
  if (!qr.ok) {
    if (qr.error === '已停止') return { ok: false, error: '已停止' };
    return { ok: true, context: [], used: 0, total: items.length, cached: items.length };
  }

  const scored = items
    .map((it) => ({ it, score: cosine(qr.vectors[0], it.q, it.s) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return {
    ok: true,
    context: scored.map((s) => s.it.text),
    used: scored.length,
    total: items.length,
    cached: items.length - missing.length,
  };
}
