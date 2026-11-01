/**
 * 「小c」—— LifeKit 里的私人 AI 助手。
 *
 * ══════════════ 用户需求（原话）══════════════
 *
 *   「试试完善下 ai 功能，部署个 Ollama，然后用 RAG 做向量检索，查以前的数据，
 *     然后智能体名字就是小c，小c 可以调用外卖数据包括优学院开放好的功能的数据」
 *
 * 之后真机反馈（2026-10）：
 *   「发个你好，过了很久也没回我一直在查询；到别的功能再回来记录还消失了」
 *
 * ══════════════ 这一版针对那两个问题的改法 ══════════════
 *
 * ① **问候语不再走网络**：说"你好/在吗/谢谢"直接本地秒回，不检索、不调模型。
 * ② **统计类问题不再靠模型算**：先在手机本地算准（services/aiTools.ts），
 *    模型只负责把结果说成人话 —— 也不再需要给几百条数据逐条算向量。
 * ③ **只有"模糊问题"才做 RAG**（比如"上周三发生了什么"）。
 * ④ **可以停止**：等太久点「停止」，立刻中断请求，不再干等。
 * ⑤ **对话落盘**：切到别的 tab 再回来，记录还在（最近的 40 条）。
 * ⑥ **状态显示秒数**：能看出是"在动"还是"卡住"。
 *
 * ══════════════ 它能看到什么 ══════════════
 *
 *   · 外卖订单（店名 / 金额 / 时间 / 状态）
 *   · 优学院：课程、签到/点名记录、作业、课件进度
 *
 * ⚠️ 数据不出手机：原文与向量只存本地，服务器只算向量/生成回答（不保存记录）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import { Txt } from '../components';
import { color, radius, spacing } from '../theme/tokens';
import type { TabScreenProps } from '../nav/tabs';
import { useCheckin } from '../state/checkinStore';
import { useDelivery } from '../state/deliveryStore';
import { useSign } from '../state/signStore';
import { useTask } from '../state/taskStore';
import { getServerBase } from '../services/serverClient';
import { aiBaseFrom, aiChat, syncAndRetrieve, type RagDoc } from '../services/aiClient';
import { buildToolContext, composeLocalAnswer, looksRepetitive } from '../services/aiTools';
import { store, STORE_KEYS } from '../services/storage';
import { SIGN_METHOD_META, SIGN_STATE_META } from '../domain/checkin';
import { PLATFORM_META, STAGE_LABEL } from '../domain/delivery';

interface Msg {
  id: string;
  role: 'user' | 'ai';
  text: string;
}

const WELCOME: Msg = {
  id: 'welcome',
  role: 'ai',
  text:
    '你好，我是小c，你的私人助手。\n\n' +
    '我能查你以前的记录：外卖点了什么、花了多少，优学院签到了哪些课、还有哪些作业没交。\n\n' +
    '试试问我：「我最近外卖花了多少钱？」「哪门课缺勤最多？」「还有哪些作业没交？」',
};

/**
 * 问候/闲聊的"快路径"。
 *
 * ⚠️ 用户反馈的"发个你好卡很久"就是这个场景：
 *    旧实现不管问什么都先给几百条数据算向量、再调模型 —— 白白让他等。
 *    纯问候不需要任何数据，也不该花 10 秒。
 */
const SMALL_TALK =
  /^(你好|您好|hi|hello|嗨|哈喽|在吗|在不|谢谢|多谢|感谢|早上好|中午好|晚上好|早安|晚安)[啊呀哈呢么啦]*[!！。.~～?？\s]*$/i;

/** 对话最多留多少条（避免存储无限膨胀） */
const MAX_MSGS = 40;

/** 送去做 RAG 的资料条数上限 */
const MAX_DOCS = 200;

function fmtTime(t?: number): string {
  if (!t || !Number.isFinite(t)) return '时间未知';
  try {
    const d = new Date(t);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch {
    return '时间未知';
  }
}

export function AiScreen(_props: TabScreenProps) {
  const { account, courses } = useCheckin();
  const { orders } = useDelivery();
  const { overview } = useSign();
  const { homeworks, submittedHomeworks, coursewares } = useTask();

  const [msgs, setMsgs] = useState<Msg[]>([WELCOME]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [elapsed, setElapsed] = useState(0);

  const scrollRef = useRef<ScrollView>(null);
  /** 当前请求的取消句柄 */
  const abortRef = useRef<AbortController | null>(null);
  /** 历史是否已经从存储读出来了（没读出来之前不要回写，否则会覆盖） */
  const hydratedRef = useRef(false);

  /* ── 历史：读出来 / 写回去 ── */
  useEffect(() => {
    void (async () => {
      try {
        const saved = await store.get<Msg[]>(STORE_KEYS.aiChatHistory, []);
        if (Array.isArray(saved) && saved.length) {
          setMsgs(saved);
        }
      } catch {
        /* 读不出来就用欢迎语 */
      } finally {
        hydratedRef.current = true;
      }
    })();
  }, []);

  useEffect(() => {
    if (!hydratedRef.current) return;
    if (msgs.length <= 1) return;
    void store.set(STORE_KEYS.aiChatHistory, msgs.slice(-MAX_MSGS)).catch(() => {});
  }, [msgs]);

  /* ── 忙碌计时：让用户看到"在动"而不是"卡死" ── */
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const timer = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  /** 把本地数据切成 RAG 用的短句（只给"模糊问题"用） */
  const docs = useMemo<RagDoc[]>(() => {
    const out: RagDoc[] = [];

    for (const o of orders.slice(0, 120)) {
      const plat = PLATFORM_META[o.platform]?.label ?? '外卖';
      const amt = typeof o.amount === 'number' ? ` ${o.amount} 元` : ' 金额未知';
      out.push({
        id: `order:${o.id}`,
        text: `外卖订单：${fmtTime(o.at)} ${plat}「${o.storeName}」${amt} 状态${
          STAGE_LABEL[o.stage] ?? o.stage
        }`,
      });
    }

    const records = overview?.allRecords ?? [];
    for (const r of records.slice(0, 120)) {
      const m = SIGN_METHOD_META[r.method]?.label ?? r.method;
      const st = SIGN_STATE_META[r.state]?.label ?? r.state;
      out.push({
        id: `sign:${r.attendanceID}`,
        text: `签到记录：${fmtTime(r.beginTime ?? r.createDate)} 课程「${
          r.courseName ?? '未知课程'
        }」 ${m} ${st} 课堂「${r.classroomTitle ?? ''}」`,
      });
    }

    for (const c of courses.slice(0, 40)) {
      out.push({
        id: `course:${c.id}`,
        text: `课程：${c.name} 教师${c.teacher || '未知'} 已签到 ${c.completedCheckins}/${c.totalCheckins} 次`,
      });
    }

    for (const h of homeworks.slice(0, 40)) {
      out.push({
        id: `hw:${h.id}`,
        text: `作业（未提交）：${h.title} 课程「${h.courseName ?? ''}」 截止 ${fmtTime(h.endTime)}`,
      });
    }

    for (const h of submittedHomeworks.slice(0, 30)) {
      out.push({
        id: `hw-done:${h.id}`,
        text: `作业（已提交）：${h.title} 课程「${h.courseName ?? ''}」 截止 ${fmtTime(h.endTime)}`,
      });
    }

    for (const c of coursewares.slice(0, 30)) {
      out.push({
        id: `cw:${c.id}`,
        text: `课件（未看完 ${c.studyProgress ?? 0}%）：${c.title} 课程「${c.courseName ?? ''}」`,
      });
    }

    return out.slice(0, MAX_DOCS);
  }, [orders, overview, courses, homeworks, submittedHomeworks, coursewares]);

  const historyForApi = useCallback(
    (list: Msg[]) =>
      list.map((m) => ({
        role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
        content: m.text,
      })),
    [],
  );

  const pushAi = useCallback((text: string) => {
    setMsgs((prev) => [...prev, { id: `a${Date.now()}`, role: 'ai', text }]);
  }, []);

  /** 停止当前请求 */
  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus('已停止');
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');

    const userMsg: Msg = { id: `u${Date.now()}`, role: 'user', text };
    const history = [...msgs, userMsg];
    setMsgs(history);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 60);

    /* ── ① 问候/闲聊：本地秒回，不联网 ── */
    if (SMALL_TALK.test(text)) {
      const reply = /谢谢|感谢/.test(text)
        ? '不客气～有需要随时叫我。'
        : /晚安|早上好|中午好|晚上好|早安/.test(text)
          ? '在的，有什么要查的随时说。'
          : '你好，我是小c。可以问我外卖花了多少钱、哪门课缺勤多、还有哪些作业没交。';
      pushAi(reply);
      return;
    }

    setBusy(true);
    setStatus('正在准备…');
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      /* ── ② 先跑本地工具：数字在手机里算准 ── */
      const localAnswer = composeLocalAnswer({
        question: text,
        orders,
        records: overview?.allRecords ?? [],
        homeworks,
        coursewares,
      });

      /**
       * ★★★ 统计类问题：**直接用本地答案，不调用模型**（2026-10-30）
       *
       * 真机事故：问「哪门课缺勤最多」，0.5B 模型把统计资料揉成
       * 「缺勤 1 次，但签到 19 次，所以没签到」并重复 8 遍。
       * 这不是提示词问题 —— 模型太小，给资料就会编/复读。
       *
       * 所以：数字类问题交给代码回答（准确、即时、不依赖网络/模型）；
       * 只有"没法用代码算"的模糊问题才走 RAG + 模型。
       */
      if (localAnswer) {
        pushAi(localAnswer);
        return;
      }

      const base = aiBaseFrom(await getServerBase());
      if (!base) {
        pushAi('还没填服务器地址 —— 去「设置 → 管理服务器」填上，我才能连上大脑（模型跑在服务器上）。');
        return;
      }
      const studentId = account?.studentId;
      if (!studentId) {
        pushAi('还没绑定优学院账号。先在「优学院」页绑定一次，我才能用你的学号去查数据。');
        return;
      }

      const tool = buildToolContext({
        question: text,
        orders,
        records: overview?.allRecords ?? [],
        homeworks,
        coursewares,
      });

      /* ── ③ 只有"工具判断不了"的模糊问题才做 RAG ── */
      let ragCtx: string[] = [];
      if (!tool.intents.length && docs.length) {
        setStatus('正在检索你的记录…');
        const r = await syncAndRetrieve({
          base,
          studentId,
          docs,
          question: text,
          topK: 5,
          signal: ctrl.signal,
          onStatus: setStatus,
        });
        if (!r.ok) {
          if (r.error === '已停止') {
            pushAi('好的，已停止。');
            return;
          }
          /* 检索失败不影响用统计结果回答 */
          ragCtx = [];
        } else {
          ragCtx = r.context;
        }
      }

      if (ctrl.signal.aborted) {
        pushAi('好的，已停止。');
        return;
      }

      /* ── ④ 让模型组织语言（资料 = 工具统计 + 检索片段） ── */
      setStatus('小c 正在想…');
      const chat = await aiChat(
        base,
        studentId,
        historyForApi(history),
        [...tool.lines, ...ragCtx],
        ctrl.signal,
      );

      if (!chat.ok) {
        pushAi(chat.error === '已停止' ? '好的，已停止。' : `我这边出错了：${chat.error}`);
        return;
      }

      /**
       * ★ 复读机兜底：0.5B 模型在长资料下会退化成重复输出。
       *   检出重复就换成"没查到/换个问法"的简短说明，不把乱码给用户看。
       */
      if (looksRepetitive(chat.reply)) {
        pushAi(
          '我刚才的回答重复了，可能是问题太宽泛。\n' +
            '可以问得具体一点，例如：「我最近 7 天外卖花了多少」「哪门课缺勤最多」「还有哪些作业没交」。',
        );
        return;
      }
      pushAi(chat.reply);
    } catch (e) {
      pushAi(`出错了：${(e as Error).message}`);
    } finally {
      abortRef.current = null;
      setBusy(false);
      setStatus('');
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
    }
  }, [input, busy, msgs, docs, orders, overview, homeworks, coursewares, account?.studentId, pushAi, historyForApi]);

  /** 顶部数据统计 */
  const dataLine = useMemo(() => {
    const parts = [
      orders.length ? `外卖 ${orders.length} 条` : '',
      overview?.allRecords?.length ? `签到 ${overview.allRecords.length} 条` : '',
      courses.length ? `课程 ${courses.length} 门` : '',
      homeworks.length ? `待交作业 ${homeworks.length} 项` : '',
    ].filter(Boolean);
    return parts.length ? `小c 能看到：${parts.join(' · ')}` : '小c 还没拿到数据（先查一次签到/外卖）';
  }, [orders.length, overview, courses.length, homeworks.length]);

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {/* 顶部：名字 + 数据范围 */}
      <View
        style={{
          paddingHorizontal: spacing.base,
          paddingVertical: spacing.sm,
          backgroundColor: color.background.primary,
          borderBottomWidth: 1,
          borderBottomColor: color.neutral[100],
        }}
      >
        <Txt variant="body2" weight="semibold">
          小c
        </Txt>
        <Txt variant="caption" c={color.text.tertiary} numberOfLines={2}>
          {dataLine}
        </Txt>
      </View>

      {/* 对话区 */}
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: spacing.base, gap: spacing.md }}
        keyboardShouldPersistTaps="handled"
      >
        {msgs.map((m) => (
          <View
            key={m.id}
            style={{
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '86%',
              backgroundColor: m.role === 'user' ? color.primary[500] : color.background.primary,
              borderRadius: radius.lg,
              paddingHorizontal: spacing.base,
              paddingVertical: spacing.md,
              borderWidth: m.role === 'user' ? 0 : 1,
              borderColor: color.neutral[200],
            }}
          >
            <Txt
              variant="body2"
              c={m.role === 'user' ? color.text.inverse : color.text.primary}
              style={{ lineHeight: 21 }}
            >
              {m.text}
            </Txt>
          </View>
        ))}

        {busy ? (
          <View
            style={{
              alignSelf: 'flex-start',
              maxWidth: '90%',
              backgroundColor: color.background.primary,
              borderRadius: radius.lg,
              paddingHorizontal: spacing.base,
              paddingVertical: spacing.md,
              borderWidth: 1,
              borderColor: color.neutral[200],
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing.sm,
            }}
          >
            <Txt variant="body2" c={color.text.secondary} style={{ flexShrink: 1 }}>
              {`${status || '小c 正在想…'}${elapsed > 0 ? `（已等 ${elapsed}s）` : ''}`}
            </Txt>
            <Pressable onPress={stop} hitSlop={8}>
              <Txt variant="caption" c={color.error[600]} weight="medium">
                停止
              </Txt>
            </Pressable>
          </View>
        ) : null}
      </ScrollView>

      {/* 输入区 */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-end',
          gap: spacing.sm,
          padding: spacing.md,
          borderTopWidth: 1,
          borderTopColor: color.neutral[100],
          backgroundColor: color.background.primary,
        }}
      >
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="问小c：我最近外卖花了多少？"
          placeholderTextColor={color.neutral[400]}
          multiline
          style={{
            flex: 1,
            maxHeight: 110,
            minHeight: 42,
            borderWidth: 1,
            borderColor: color.neutral[200],
            borderRadius: radius.lg,
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.sm,
            fontSize: 15,
            color: color.text.primary,
            backgroundColor: color.neutral[50],
          }}
        />
        <Pressable
          onPress={() => void send()}
          disabled={busy || !input.trim()}
          style={{
            paddingHorizontal: spacing.base,
            height: 42,
            borderRadius: radius.lg,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: busy || !input.trim() ? color.neutral[300] : color.primary[500],
          }}
        >
          <Txt variant="body2" weight="semibold" c={color.text.inverse}>
            发送
          </Txt>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
