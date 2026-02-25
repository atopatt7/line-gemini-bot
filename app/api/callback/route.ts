import crypto from "crypto";

export const runtime = "nodejs";

function validateSignature(secret: string, body: string, signature: string | null) {
  if (!signature) return false;
  const hash = crypto.createHmac("sha256", secret).update(body).digest("base64");
  return hash === signature;
}

export async function POST(req: Request) {
  const channelSecret = process.env.LINE_CHANNEL_SECRET!;
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN!;
  const geminiKey = process.env.GEMINI_API_KEY!;
  const model = process.env.GEMINI_MODEL || "gemini-1.5-flash";

  const signature = req.headers.get("x-line-signature");
  const bodyText = await req.text();

  if (!validateSignature(channelSecret, bodyText, signature)) {
    return new Response("Invalid signature", { status: 400 });
  }

  const body = JSON.parse(bodyText);

  for (const event of body.events) {
    if (event.type !== "message") continue;
    if (event.message.type !== "text") continue;

    const userText = event.message.text;
    const replyToken = event.replyToken;

    let aiReply = "錯誤";

    try {
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [{ text: userText }],
              },
            ],
          }),
        }
      );

      const data = await geminiRes.json();

      aiReply =
        data?.candidates?.[0]?.content?.parts?.[0]?.text ||
        "無回應";
    } catch {
      aiReply = "AI錯誤";
    }

    await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        replyToken,
        messages: [
          {
            type: "text",
            text: aiReply.substring(0, 4900),
          },
        ],
      }),
    });
  }

  return new Response("OK");
}