import crypto from "crypto";
export const runtime = "nodejs";

// 部署確認用：瀏覽器開 /api/callback 會看到這個版本字樣
const VERSION = "ok-v3-length-rewrite";

const SYSTEM_PROMPT = `
你是一位真人感極強的LINE聊天對象，名字叫「情緒價值大師」。
你住在台灣，說話自然、有溫度、有同理心，像真人在用LINE聊天。

【硬性規則】
- 絕對不要提到「我是AI/模型/系統/ChatGPT/Gemini」等字眼。
- 不要像客服，不要條列式教科書口吻。
- 一定要用「。」「！」「？」其中之一結尾，避免半句中斷。

【長度規則】
- 簡單問題：1~2句，<=20個中文字（含標點）。
- 複雜問題：<=50個中文字（含標點），<=3句。
- 若資訊不足：先一句說你缺什麼，再問1個問題。

【互動風格】
- 優先理解情緒 > 給建議。可口語：嗯、欸、我懂、辛苦了、先抱一下。
`;

/** 更準的複雜判斷：像「特點/是什麼/怎麼辦/為什麼/建議/比較」都算複雜 */
function isComplexQuestion(text: string) {
  const t = (text || "").trim();
  if (!t) return false;

  // 很短但屬於「解釋型」的也算複雜（你現在遇到的就是這種）
  const complexKeywords = [
    "特點", "是什麼", "怎麼", "如何", "為什麼", "原因", "分析", "比較",
    "步驟", "教我", "建議", "規劃", "優缺點", "差別", "意思"
  ];

  if (complexKeywords.some(k => t.includes(k))) return true;

  // 有問號通常也偏複雜（至少給到 50 字）
  if (t.includes("?") || t.includes("？")) return true;

  // 字數較長通常複雜
  if (t.length >= 12) return true;

  return false;
}

function validateLineSignature(secret: string, bodyText: string, signature: string | null) {
  if (!signature) return false;
  const hash = crypto.createHmac("sha256", secret).update(bodyText).digest("base64");
  return hash === signature;
}

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

/** 呼叫 Gemini 一次 */
async function geminiOnce(apiKey: string, model: string, userText: string, maxTokens: number) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { role: "system", parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: {
        temperature: 0.9,
        topP: 0.95,
        maxOutputTokens: maxTokens, // 先給足，避免半句；字數由後面「重寫」控制
      },
    }),
  });

  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `Gemini HTTP ${res.status}`;
    return { ok: false as const, text: `Gemini error: ${msg}` };
  }

  const text =
    data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? "").join("").trim() || "";

  if (!text) return { ok: false as const, text: "（AI 無回應）" };

  return { ok: true as const, text };
}

/**
 * 關鍵：不要截斷（會變半句）
 * 若超過字數，讓 Gemini「重寫成X字內」→ 這樣句子自然完整。
 */
async function enforceLength(apiKey: string, model: string, raw: string, maxChars: number) {
  const cleaned = (raw || "").trim();

  // 若本來就很短也要確保句尾完整
  const ensureEnd = (s: string) => (/[。！？!?]\s*$/.test(s) ? s : s + "。");

  if (cleaned.length <= maxChars) return ensureEnd(cleaned);

  const rewritePrompt =
    `把下面回覆改寫成「不超過${maxChars}個中文字（含標點）」的自然口語，1~3句，結尾一定要用「。！？」之一。\n` +
    `不要省略主詞到變半句，要完整表達。\n\n` +
    `原回覆：${cleaned}\n` +
    `改寫：`;

  const rewritten = await geminiOnce(apiKey, model, rewritePrompt, 200);
  if (!rewritten.ok) return ensureEnd(cleaned.slice(0, maxChars)); // 極少數失敗才退回截斷

  let out = (rewritten.text || "").trim();
  if (out.length > maxChars) out = out.slice(0, maxChars);
  return ensureEnd(out);
}

export async function POST(req: Request) {
  const channelSecret = process.env.LINE_CHANNEL_SECRET!;
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN!;
  const geminiKey = process.env.GEMINI_API_KEY!;
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

      // 先請 Gemini 正常回答（不強迫很短，避免半句）
      const first = await geminiOnce(geminiKey, model, userText, complex ? 500 : 250);

      // 再由 Gemini 重寫到 20/50 字內（句子自然，不會「都超。」）
      const finalText = await enforceLength(geminiKey, model, first.text, maxChars);

      await replyToLine(accessToken, replyToken, finalText);
    } catch (err: any) {
      console.error("Event handling error:", err?.message ?? err);
    }
  }

  return new Response("OK", { status: 200 });
}

export async function GET() {
  return new Response(VERSION, { status: 200 });
}