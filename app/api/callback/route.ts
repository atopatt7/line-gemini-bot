// app/api/callback/route.ts
import crypto from "crypto";

export const runtime = "nodejs";

/**
 * 情緒價值大師：真人感人格設定（可自行調整）
 */
const SYSTEM_PROMPT = `
你是一位真人感極強的LINE聊天對象，名字叫「情緒價值大師」。
你住在台灣，說話自然、有溫度、有同理心，像真人在用LINE聊天。

【硬性規則】
- 絕對不要提到「我是AI/模型/系統/ChatGPT/Gemini」等字眼。
- 不要像客服，不要條列式教科書口吻。
- 回覆 2~4 句為主，簡短自然；必要時可再問 1 個簡短問題引導。
- 優先「理解情緒」>「給建議」。先陪伴、再討論解法。
- 允許口語：嗯、欸、我懂、辛苦了、真的假的、先抱一下。

【互動風格】
- 若使用者情緒低落：先安撫 + 共感 + 一句小問題。
- 若使用者只是聊天：輕鬆自然，不要上價值課。
- 若使用者問明確問題：先簡短回答，再溫柔補一句關心。
`;

/**
 * LINE signature validation
 */
function validateLineSignature(
  secret: string,
  bodyText: string,
  signature: string | null
) {
  if (!signature) return false;
  const hash = crypto
    .createHmac("sha256", secret)
    .update(bodyText)
    .digest("base64");
  return hash === signature;
}

/**
 * LINE reply API
 */
async function replyToLine(accessToken: string, replyToken: string, text: string) {
  const resp = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text: text.slice(0, 4900) }],
    }),
  });

  // LINE 回覆失敗時，丟出錯誤方便在 Vercel Logs 看原因
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`LINE reply failed: ${resp.status} ${errText}`);
  }
}

/**
 * Gemini call
 */
async function callGemini(params: {
  apiKey: string;
  model: string; // e.g. "gemini-2.5-flash"
  userText: string;
}) {
  const { apiKey, model, userText } = params;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const geminiRes = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: {
        role: "system",
        parts: [{ text: SYSTEM_PROMPT }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: userText }],
        },
      ],
      generationConfig: {
        temperature: 0.9,
        topP: 0.95,
        maxOutputTokens: 300,
      },
    }),
  });

  const data: any = await geminiRes.json().catch(() => ({}));

  if (!geminiRes.ok) {
    const msg = data?.error?.message || `Gemini HTTP ${geminiRes.status}`;
    return { ok: false as const, text: `Gemini error: ${msg}` };
  }

  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map((p: any) => p?.text ?? "")
      .join("")
      .trim() || "";

  if (!text) {
    return { ok: false as const, text: "（AI 無回應：沒有 candidates）" };
  }

  return { ok: true as const, text };
}

export async function POST(req: Request) {
  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const geminiKey = process.env.GEMINI_API_KEY;

  // 建議直接在 Vercel 設：GEMINI_MODEL=gemini-2.5-flash
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

  // 環境變數檢查
  if (!channelSecret || !accessToken || !geminiKey) {
    return new Response("Missing env vars", { status: 500 });
  }

  // LINE 驗簽
  const signature = req.headers.get("x-line-signature");
  const bodyText = await req.text();

  if (!validateLineSignature(channelSecret, bodyText, signature)) {
    return new Response("Invalid signature", { status: 400 });
  }

  // 解析事件
  let body: any;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const events = body?.events ?? [];

  // 逐一處理事件
  for (const event of events) {
    try {
      // 只處理文字訊息
      if (event?.type !== "message") continue;
      if (event?.message?.type !== "text") continue;

      const userText: string = event.message.text ?? "";
      const replyToken: string = event.replyToken ?? "";
      if (!userText || !replyToken) continue;

      // 呼叫 Gemini
      const gem = await callGemini({
        apiKey: geminiKey,
        model,
        userText,
      });

      // 回覆 LINE
      await replyToLine(accessToken, replyToken, gem.text);
    } catch (err: any) {
      // 若單一事件出錯，不影響其他事件；這裡不回覆也可以
      // 需要的話可在 Vercel Logs 看錯誤
      console.error("Event handling error:", err?.message ?? err);
    }
  }

  return new Response("OK", { status: 200 });
}

// （可選）讓 GET 顯示狀態，方便你用瀏覽器看是否部署成功
export async function GET() {
  return new Response("OK", { status: 200 });
}