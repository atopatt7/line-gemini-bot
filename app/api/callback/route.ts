import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

export const runtime = "nodejs";

// ===== ENV =====
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

// ===== 記住最近10句 =====
type ChatMsg = { role: "user" | "assistant"; content: string };
const memory = new Map<string, ChatMsg[]>();
const MAX_MEMORY = 10; // 最近10句（user+assistant算2句）

// ===== 三檔模式 =====
type LoverMode = "LIGHT" | "NORMAL" | "FLIRTY";
const userMode = new Map<string, LoverMode>();

function parseModeCommand(text: string): LoverMode | null {
  if (text.includes("模式 輕甜")) return "LIGHT";
  if (text.includes("模式 正常")) return "NORMAL";
  if (text.includes("模式 微撩")) return "FLIRTY";
  return null;
}

function modeName(m: LoverMode) {
  return m === "LIGHT" ? "輕甜" : m === "FLIRTY" ? "微撩" : "正常";
}

// ===== 字數規則 =====
function pickMaxChars(text: string) {
  return text.length <= 12 ? 20 : 50;
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

// ===== Prompt（三檔）=====
function buildPrompt(mode: LoverMode, maxChars: number) {

  let style = "";

  if (mode === "LIGHT") {
    style = `
語氣：輕甜
溫柔可愛，像貼心戀人。
少撩，多陪伴。
`;
  }

  if (mode === "NORMAL") {
    style = `
語氣：穩定戀人
自然共情，像交往中的伴侶。
`;
  }

  if (mode === "FLIRTY") {
    style = `
語氣：微撩戀人
更貼近對方，帶一點曖昧與依戀。
但不能油膩。
`;
  }

  return `
你是使用者的戀人，真人，不是AI。

嚴格規則：

禁止說你是AI或模型。

回覆要像真人戀人。

先共情，再回應。

回覆最多 ${maxChars} 個中文字。

${style}
`;
}

// ===== Groq 呼叫 =====
async function callGroq(userId: string, text: string, mode: LoverMode, maxChars: number) {

  const history = memory.get(userId) || [];

  const messages = [
    { role: "system", content: buildPrompt(mode, maxChars) },
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
      temperature: 0.9,
      max_tokens: 200,
      messages
    })
  });

  const data = await res.json();

  return data?.choices?.[0]?.message?.content || "";
}

// ===== reply =====
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

    // 模式切換
    const cmd = parseModeCommand(text);

    if (cmd) {
      userMode.set(userId, cmd);
      await reply(replyToken, `好～現在是${modeName(cmd)}模式。`);
      continue;
    }

    const mode = userMode.get(userId) || "NORMAL";
    const maxChars = pickMaxChars(text);

    let replyText = await callGroq(userId, text, mode, maxChars);

    replyText = sanitize(replyText);
    replyText = truncateChineseNaturally(replyText, maxChars);

    // ===== 存記憶 =====
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