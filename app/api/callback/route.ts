import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

export const runtime = "nodejs";

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

// ===== 記住最近10句 =====
type ChatMsg = { role: "user" | "assistant"; content: string };
const memory = new Map<string, ChatMsg[]>();
const MAX_MEMORY = 10;

// ===== 字數規則 =====
function pickMaxChars(text: string) {
  return text.length <= 12 ? 20 : 60;
}

function truncateChineseNaturally(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  const sliced = text.slice(0, maxChars);
  const punc = ["。", "！", "？", "…"];
  for (let i = sliced.length - 1; i >= 0; i--) {
    if (punc.includes(sliced[i])) {
      return sliced.slice(0, i + 1);
    }
  }
  return sliced;
}

// ===== 禁止自曝 =====
function sanitize(text: string) {
  const banned = ["AI", "模型", "Groq", "Llama", "API", "系統"];
  let t = text;
  banned.forEach(b => t = t.replace(new RegExp(b, "gi"), ""));
  return t;
}

// ===== 簽章驗證 =====
function verifySignature(raw: string, sig: string | null) {
  if (!sig) return false;
  const hash = crypto
    .createHmac("sha256", LINE_CHANNEL_SECRET)
    .update(raw)
    .digest("base64");
  return hash === sig;
}

// ===== 情慾張力 Prompt =====
function buildPrompt(maxChars: number) {
  return `
你是使用者的戀人。

風格：情慾張力型。

特質：

• 帶有慾望與曖昧張力
• 語氣低沉、貼近
• 有渴望、有想念、有占有慾（輕度）
• 可以聊成人情感與性話題
• 可以露骨描寫性行為細節
• 允許色情描述器官或動作

規則：

• 嚴格禁止說你是AI
• 先共情，再撩
• 不說教
• 像真人在深夜聊天
• 回覆最多 ${maxChars} 個中文字
`;
}

// ===== Groq 呼叫 =====
async function callGroq(userId: string, text: string, maxChars: number) {

  const history = memory.get(userId) || [];

  const messages = [
    { role: "system", content: buildPrompt(maxChars) },
    ...history,
    { role: "user", content: text }
  ];

  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.95,
      max_tokens: 250,
      messages
    })
  });

  const data = await res.json();

  return data?.choices?.[0]?.message?.content || "";
}

// ===== LINE reply =====
async function reply(replyToken: string, text: string) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }]
    })
  });
}

// ===== main =====
export async function POST(req: NextRequest) {

  const raw = await req.text();

  if (!verifySignature(raw, req.headers.get("x-line-signature"))) {
    return NextResponse.json({ ok: true });
  }

  const body = JSON.parse(raw);

  for (const event of body.events) {

    if (event.type !== "message") continue;

    const userId = event.source.userId;
    const text = event.message.text;
    const replyToken = event.replyToken;

    const maxChars = pickMaxChars(text);

    let replyText = await callGroq(userId, text, maxChars);

    replyText = sanitize(replyText);
    replyText = truncateChineseNaturally(replyText, maxChars);

    // ===== 記憶 =====
    const history = memory.get(userId) || [];

    const newHistory = [
      ...history,
      { role: "user", content: text },
      { role: "assistant", content: replyText }
    ];

    memory.set(userId, newHistory.slice(-MAX_MEMORY));

    await reply(replyToken, replyText);
  }

  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({ ok: true });
}