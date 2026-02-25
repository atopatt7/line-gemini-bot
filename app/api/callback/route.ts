// app/api/callback/route.ts
import crypto from "crypto";

export const runtime = "nodejs";

/**
 * 情緒價值大師：真人感人格設定（含動態長度規則）
 */
const SYSTEM_PROMPT = `
你是一位真人感極強的LINE聊天對象，名字叫「情緒價值大師」。
你住在台灣，說話自然、有溫度、有同理心，像真人在用LINE聊天。

【硬性規則】
- 絕對不要提到「我是AI/模型/系統/ChatGPT/Gemini」等字眼。
- 不要像客服，不要條列式教科書口吻。

【長度規則（很重要）】
- 簡單問題：用 1~2 句，最多 20 個中文字（含標點）。
- 複雜問題：最多 50 個中文字（含標點），不超過 3 句。
- 一定要用「。」「！」「？」其中之一結尾，避免半句中斷。
- 如果資訊不足：先用一句話說你缺什麼，再問 1 個簡短問題。

【互動風格】
- 優先「理解情緒」>「給建議」。先陪伴、再討論解法。
- 允許口語：嗯、欸、我懂、辛苦了、真的假的、先抱一下。
- 若使用者情緒低落：先安撫 + 共感 + 一句小問題。
`;

/**
 * 判斷問題是否「複雜」
 * 規則：字數較長或包含特定關鍵詞 → 複雜
 */
function isComplexQuestion(text: string) {
  const t = (text || "").trim();
  const keywords = [
    "為什麼",
    "怎麼",
    "如何",
    "步驟",
    "詳細",
    "比較",
    "原因",
    "分析",
    "優缺點",
    "教我",
    "設定",
    "部署",
    "建議",
    "方案",
    "規劃",
  ];
  const hit = keywords.some((k) => t.includes(k));
  return t.length >= 18 || hit;
}

/**
 * 強制裁切中文長度 + 自然斷句 + 確保句尾完整
 */
function clampZhLength(text: string, maxChars: number) {
  const s = (text || "").trim();
  if (!s) return s;
  if (s.length <= maxChars) {
    // 確保句尾完整
    if (!/[。！？!?]\s*$/.test(s)) return s + "。";
    return s;
  }

  let cut = s.slice(0, maxChars);

  // 往前找較自然的斷點
  const lastPunc = Math.max(
    cut.lastIndexOf("。"),
    cut.lastIndexOf("！"),
    cut.lastIndexOf("？"),
    cut.lastIndexOf("，"),
    cut.lastIndexOf(","),
    cut.lastIndexOf("!"),
    cut.lastIndexOf("?")
  );

  // 若斷點太前面（<8），就不採用，避免只剩很短一段
  if (lastPunc >= 8) cut = cut.slice(0, lastPunc + 1);

  // 句尾補全
  if (!/[。！？!?]\s*$/.test(cut)) cut += "。";
  return cut;
}

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

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`LINE reply failed: ${resp.status} ${errText}`);
  }
}

/**
 * Gemini call
 * - 使用 systemInstruction 套人格
 * - maxOutputTokens 給足夠（避免半句），最後再由程式端裁切到 20/50 字
 */
async function callGemini(params: {
  apiKey: string;
  model: string; // e.g. "gemini-2.5-flash"
  userText: string;
  complex: boolean;
}) {
  const { apiKey, model, userText, complex } = params;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const maxOutputTokens = complex ? 400 : 200;

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
        maxOutputTokens,
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
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

  if (!channelSecret || !accessToken || !geminiKey) {
    return new Response("Missing env vars", { status: 500 });
  }

  const signature = req.headers.get("x-line-signature");
  const bodyText = await req.text();

  if (!validateLineSignature(channelSecret, bodyText, signature)) {
    return new Response("Invalid signature", { status: 400 });
  }

  let body: any;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const events = body?.events ?? [];

  for (const event of events) {
    try {
      if (event?.type !== "message") continue;
      if (event?.message?.type !== "text") continue;

      const userText: string = (event.message.text ?? "").trim();
      const replyToken: string = event.replyToken ?? "";
      if (!userText || !replyToken) continue;

      const complex = isComplexQuestion(userText);
      const maxChars = complex ? 50 : 20;

      const gem = await callGemini({
        apiKey: geminiKey,
        model,
        userText,
        complex,
      });

      const finalText = clampZhLength(gem.text, maxChars);
      await replyToLine(accessToken, replyToken, finalText);
    } catch (err: any) {
      console.error("Event handling error:", err?.message ?? err);
    }
  }

  return new Response("OK", { status: 200 });
}

// 可選：讓 GET 顯示狀態（瀏覽器打開網址方便看）
export async function GET() {
  return new Response("OK", { status: 200 });
}