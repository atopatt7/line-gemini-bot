import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

export const runtime = "nodejs";

// ===== ENV =====
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

// ===== Types =====
type Role = "system" | "user" | "assistant";
type GroqMsg = { role: Role; content: string };
type ChatMsg = { role: "user" | "assistant"; content: string };

// ===== 記住最近10句（注意：Vercel serverless 重啟會清空）=====
const memory = new Map<string, ChatMsg[]>();
const MAX_MEMORY = 10;

// ===== 保護機制：冷卻/去重/每日上限（serverless 下僅同 instance 有效）=====
const cooldown = new Map<string, number>();
const lastMessage = new Map<string, string>();
const dailyUsage = new Map<string, number>();
let globalCount = 0;
let lastReset = Date.now();

const COOLDOWN_MS = 4000;
const MAX_PER_USER = 200;
const MAX_GLOBAL = 5000;

function resetDaily() {
  if (Date.now() - lastReset > 86400000) {
    dailyUsage.clear();
    globalCount = 0;
    lastReset = Date.now();
  }
}

// ===== 簽章驗證（LINE 必要）=====
function verifySignature(raw: string, sig: string | null) {
  if (!sig || !LINE_CHANNEL_SECRET) return false;
  const hash = crypto
    .createHmac("sha256", LINE_CHANNEL_SECRET)
    .update(raw)
    .digest("base64");
  return hash === sig;
}

// ===== 字數規則：簡單<=12字 → 20字內；其他 → 50字內 =====
function pickMaxChars(text: string) {
  return text.trim().length <= 12 ? 50 : 50;
}

function truncateChineseNaturally(text: string, maxChars: number) {
  const t = text.trim();
  if (t.length <= maxChars) return t;

  const sliced = t.slice(0, maxChars);
  const punc = ["。", "！", "？", "…", "；", "，", ",", ".", "!", "?"];
  for (let i = sliced.length - 1; i >= 0; i--) {
    if (punc.includes(sliced[i])) return sliced.slice(0, i + 1);
  }
  return sliced;
}

// ===== 禁止自曝（防止提到自己是AI/模型/API等）=====
function sanitize(text: string) {
  let t = text;

  // 常見自曝句型/關鍵詞（只做移除/替換，不做過度審查）
  const patterns: Array<[RegExp, string]> = [
    [/我是(一個)?\s*AI.*?(。|！|!|？|\?|$)/gi, ""],
    [/我(只)?是(一個)?\s*語言模型.*?(。|！|!|？|\?|$)/gi, ""],
    [/作為(一個)?\s*(AI|人工智慧|語言模型).*?(。|！|!|？|\?|$)/gi, ""],
    [/AI/gi, ""],
    [/人工智慧/gi, ""],
    [/語言模型/gi, ""],
    [/模型/gi, ""],
    [/API/gi, ""],
    [/Groq/gi, ""],
    [/Llama/gi, ""],
    [/系統/gi, ""],
    [/OpenAI/gi, ""],
    [/Anthropic/gi, ""],
    [/Gemini/gi, ""],
  ];

  for (const [re, rep] of patterns) t = t.replace(re, rep);
  return t.trim();
}

// ===== 情慾張力風格（不露骨、不描寫性行為細節）=====
function buildPrompt(maxChars: number) {
  return `
你是使用者的戀人（真人口吻）。

風格：情慾張力型
- 語氣低沉、貼近、曖昧，有想念與渴望感
- 先共情，再回應；可以輕微撩，但不油膩
- 可以聊成人情感與親密關係話題
- 可以露骨描寫性行為細節、器官或動作細節
- 不要提到「你是AI/模型/系統/API」或任何類似自曝

輸出規則：
- 簡單問題：20字內
- 複雜問題：最多 ${maxChars} 字
- 句子要完整，不要只回一半
- 避免清單式說教，像真人聊天
`.trim();
}

// ===== Groq 呼叫 =====
async function callGroq(userId: string, userText: string, maxChars: number) {
  const history: ChatMsg[] = memory.get(userId) ?? [];

  const messages: GroqMsg[] = [
    { role: "system", content: buildPrompt(maxChars) },
    ...history,
    { role: "user", content: userText },
  ];

  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.9,
      max_tokens: 220,
      messages,
    }),
  });

  const data = await res.json();
  const out: string = data?.choices?.[0]?.message?.content || "";
  return out;
}

// ===== LINE reply =====
async function replyToLine(replyToken: string, text: string) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });
}

// ===== main =====
export async function POST(req: NextRequest) {
  try {
    resetDaily();

    const raw = await req.text();

    // LINE webhook 驗簽
    const sig = req.headers.get("x-line-signature");
    if (!verifySignature(raw, sig)) {
      return NextResponse.json({ ok: true });
    }

    const body = JSON.parse(raw);

    if (!body.events?.length) {
      return NextResponse.json({ ok: true });
    }

    for (const event of body.events) {
      if (event.type !== "message") continue;
      if (event.message?.type !== "text") continue;

      const userId: string | undefined = event.source?.userId;
      const text: string = (event.message?.text || "").trim();
      const replyToken: string = event.replyToken;

      if (!userId || !text || !replyToken) continue;

      // cooldown
      const lastTime = cooldown.get(userId) || 0;
      if (Date.now() - lastTime < COOLDOWN_MS) {
        continue;
      }
      cooldown.set(userId, Date.now());

      // deduplicate
      if (lastMessage.get(userId) === text) {
        continue;
      }
      lastMessage.set(userId, text);

      // per-user limit
      const userCount = dailyUsage.get(userId) || 0;
      if (userCount >= MAX_PER_USER) {
        await replyToLine(replyToken, "今天聊太多了，明天再找我。");
        continue;
      }

      // global limit
      if (globalCount >= MAX_GLOBAL) {
        await replyToLine(replyToken, "我今天有點累了，明天再聊。");
        continue;
      }

      const maxChars = pickMaxChars(text);

      let replyText = await callGroq(userId, text, maxChars);
      replyText = sanitize(replyText);
      replyText = truncateChineseNaturally(replyText, maxChars);

      if (!replyText) {
        replyText = "嗯…再說一次，我在聽。";
      }

      // 存記憶（最近10句）
      const history: ChatMsg[] = memory.get(userId) ?? [];
      const newHistory: ChatMsg[] = [
        ...history,
        { role: "user" as const, content: text },
        { role: "assistant" as const, content: replyText },
      ];
      memory.set(userId, newHistory.slice(-MAX_MEMORY));

      // 計數
      dailyUsage.set(userId, userCount + 1);
      globalCount++;

      await replyToLine(replyToken, replyText);
    }

    return NextResponse.json({ ok: true });
  } catch {
    // webhook 回 200 避免 LINE 重送
    return NextResponse.json({ ok: true });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true });
}