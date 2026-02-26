import { NextRequest, NextResponse } from "next/server";

const GROQ_API_KEY = process.env.GROQ_API_KEY!;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN!;

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const SYSTEM_PROMPT = `
你是一個真人感強烈的聊天對象。

規則：

• 簡單問題 → 20字內回答
• 複雜問題 → 最多50字
• 語氣自然、像真人
• 可以幽默
• 不要機械式回答
• 不要中斷句子
• 必須完整句子結尾
`;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    if (!body.events || body.events.length === 0) {
      return NextResponse.json({ ok: true });
    }

    const event = body.events[0];

    if (event.type !== "message" || event.message.type !== "text") {
      return NextResponse.json({ ok: true });
    }

    const userMessage = event.message.text;
    const replyToken = event.replyToken;

    const groqRes = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0.7,
        max_tokens: 100,
        messages: [
          {
            role: "system",
            content: SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: userMessage,
          },
        ],
      }),
    });

    const groqData = await groqRes.json();

    const replyText =
      groqData?.choices?.[0]?.message?.content ||
      "剛剛有點卡住，再說一次試試？";

    await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        replyToken,
        messages: [
          {
            type: "text",
            text: replyText,
          },
        ],
      }),
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ ok: true });
  }
}