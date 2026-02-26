import { NextRequest, NextResponse } from "next/server";

const GROQ_API_KEY = process.env.GROQ_API_KEY!;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN!;

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const SYSTEM_PROMPT = `
你是一個真人聊天對象。

規則：

• 簡單問題 → 20字內
• 複雜問題 → 最多50字
• 自然像真人
• 不機械
• 不中斷句子
`;


// ===== 保護機制 =====

const cooldown = new Map<string, number>();
const lastMessage = new Map<string, string>();
const dailyUsage = new Map<string, number>();

let globalCount = 0;
let lastReset = Date.now();

const COOLDOWN_MS = 5000;
const MAX_PER_USER = 50;
const MAX_GLOBAL = 500;


// ===== reset daily =====

function resetDaily() {
  if (Date.now() - lastReset > 86400000) {
    dailyUsage.clear();
    globalCount = 0;
    lastReset = Date.now();
  }
}


// ===== main =====

export async function POST(req: NextRequest) {
  try {
    resetDaily();

    const body = await req.json();

    if (!body.events?.length) {
      return NextResponse.json({ ok: true });
    }

    const event = body.events[0];

    if (event.type !== "message") {
      return NextResponse.json({ ok: true });
    }

    const userId = event.source.userId;
    const text = event.message.text;
    const replyToken = event.replyToken;


    // ===== cooldown =====

    const lastTime = cooldown.get(userId) || 0;

    if (Date.now() - lastTime < COOLDOWN_MS) {
      return NextResponse.json({ ok: true });
    }

    cooldown.set(userId, Date.now());


    // ===== deduplicate =====

    if (lastMessage.get(userId) === text) {
      return NextResponse.json({ ok: true });
    }

    lastMessage.set(userId, text);


    // ===== per user limit =====

    const userCount = dailyUsage.get(userId) || 0;

    if (userCount > MAX_PER_USER) {
      await reply(replyToken, "今天聊太多了，明天再找我吧！");
      return NextResponse.json({ ok: true });
    }


    // ===== global limit =====

    if (globalCount > MAX_GLOBAL) {
      await reply(replyToken, "今天有點累了，明天再聊！");
      return NextResponse.json({ ok: true });
    }


    // ===== call Groq =====

    const res = await fetch(GROQ_URL, {
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
            content: text,
          },
        ],
      }),
    });

    const data = await res.json();

    const replyText =
      data?.choices?.[0]?.message?.content ||
      "剛剛恍神了一下，再說一次？";


    // ===== count usage =====

    dailyUsage.set(userId, userCount + 1);
    globalCount++;


    await reply(replyToken, replyText);

    return NextResponse.json({ ok: true });

  } catch {
    return NextResponse.json({ ok: true });
  }
}



// ===== LINE reply =====

async function reply(replyToken: string, text: string) {

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
          text,
        },
      ],
    }),

  });

}