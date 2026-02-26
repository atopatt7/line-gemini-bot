import crypto from "crypto";

export const runtime = "nodejs";

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";

const GROQ_MODEL = "llama-3.3-70b-versatile";
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

// ---- 去重：記錄已處理的 message.id（避免 webhook 重送反覆扣 tokens） ----
const processed = new Map<string, number>(); // id -> timestamp(ms)
const DEDUP_TTL_MS = 5 * 60 * 1000; // 5分鐘

function isDuplicate(messageId?: string) {
  if (!messageId) return false;
  const now = Date.now();

  // 清理過期
  for (const [k, ts] of processed.entries()) {
    if (now - ts > DEDUP_TTL_MS) processed.delete(k);
  }

  if (processed.has(messageId)) return true;
  processed.set(messageId, now);
  return false;
}

function badRequest(msg: string, status = 400) {
  return new Response(msg, { status });
}

async function verifyLineSignature(rawBody: string, signature: string) {
  const hash = crypto
    .createHmac("sha256", LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest("base64");
  return hash === signature;
}

function isComplexQuestion(text: string) {
  const t = text.trim();
  const complexHints = ["為什麼", "怎麼", "如何", "可以嗎", "教我", "步驟", "比較", "分析", "建議", "規劃"];
  if (complexHints.some((k) => t.includes(k))) return true;
  return t.length > 20;
}

function finalizeText(text: string, maxChars: number) {
  let out = (text || "").trim();
  out = out.replace(/\s+/g, " ");
  if (!out) out = "嗯…你再說一次我聽聽？";

  if (out.length > maxChars) out = out.slice(0, maxChars);
  if (!/[。！？…]$/.test(out)) out += "。";
  if (out.length > maxChars) {
    out = out.slice(0, maxChars);
    if (!/[。！？…]$/.test(out)) out = out.slice(0, maxChars - 1) + "。";
  }
  return out;
}

async function callGroq(userText: string, maxChars: number) {
  const maxTokens = maxChars <= 20 ? 120 : 220;

  const system = [
    "你是「情緒價值大師」，用真人口吻在 LINE 聊天。",
    "規則：",
    `1) 回覆不超過 ${maxChars} 個中文字（含標點），用 1~3 句完整句子。`,
    "2) 不要像客服、不要條列、不要說你是 AI。",
    "3) 回覆要自然、溫暖、有點幽默但不油。",
    "4) 結尾要是完整句，避免半句中斷。",
  ].join("\n");

  const resp = await fetch(GROQ_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL, // <-- 這行就保證是 Llama 3.3
      messages: [
        { role: "system", content: system },
        { role: "user", content: userText },
      ],
      temperature: 0.9,
      max_tokens: maxTokens,
    }),
  });

  const data: any = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    const msg = data?.error?.message || `Groq HTTP ${resp.status}`;
    return `（AI 暫時卡住：${msg}）`;
  }

  const text = (data?.choices?.[0]?.message?.content || "").trim();
  return text;
}

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

export async function POST(req: Request) {
  if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_CHANNEL_SECRET || !GROQ_API_KEY) {
    return badRequest(
      "Missing env vars: LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET / GROQ_API_KEY",
      500
    );
  }

  const signature = req.headers.get("x-line-signature") || "";
  const rawBody = await req.text();

  const ok = await verifyLineSignature(rawBody, signature);
  if (!ok) return badRequest("Invalid signature", 401);

  const body = JSON.parse(rawBody);
  const events = body?.events || [];

  for (const event of events) {
    if (event?.type !== "message") continue;
    if (event?.message?.type !== "text") continue;

    const messageId: string | undefined = event?.message?.id;
    if (isDuplicate(messageId)) {
      // 重送就直接不打 AI、不扣 tokens
      continue;
    }

    const userText: string = (event.message.text || "").trim();
    const replyToken: string = event.replyToken;

    const complex = isComplexQuestion(userText);
    const maxChars = complex ? 50 : 20;

    const aiText = await callGroq(userText, maxChars);
    const finalText = finalizeText(aiText, maxChars);

    await replyToLine(replyToken, finalText);
  }

  return new Response("ok");
}