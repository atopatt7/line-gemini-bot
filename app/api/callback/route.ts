import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

export const runtime = "nodejs";

// ===== Env =====
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

// ===== 三檔模式 =====
type LoverMode = "LIGHT" | "NORMAL" | "FLIRTY";
/**
 * LIGHT  = 輕甜：溫柔、可愛、少撩
 * NORMAL = 正常：穩定共情、像伴侶日常
 * FLIRTY = 微撩：更貼近、帶點曖昧但不油
 */
const userMode = new Map<string, LoverMode>();

function modeName(m: LoverMode) {
  if (m === "LIGHT") return "輕甜";
  if (m === "FLIRTY") return "微撩";
  return "正常";
}

function parseModeCommand(text: string): LoverMode | null {
  const t = text.trim();
  // 你可以用這些指令切換：
  // 模式 輕甜 / 模式 正常 / 模式 微撩
  // /mode light|normal|flirty
  if (/^模式\s*(輕甜|正常|微撩)\s*$/i.test(t)) {
    if (t.includes("輕甜")) return "LIGHT";
    if (t.includes("微撩")) return "FLIRTY";
    return "NORMAL";
  }
  const m = t.match(/^\/mode\s*(light|normal|flirty)\s*$/i);
  if (m) {
    const v = m[1].toLowerCase();
    if (v === "light") return "LIGHT";
    if (v === "flirty") return "FLIRTY";
    return "NORMAL";
  }
  return null;
}

// ===== 20/50 字規則 =====
function pickMaxChars(userText: string): number {
  const t = userText.trim();
  return t.length <= 12 ? 20 : 50;
}

// ===== 避免半句：截斷到句尾標點 =====
function truncateChineseNaturally(text: string, maxChars: number): string {
  const t = (text || "").trim();
  if (t.length <= maxChars) return t;

  const sliced = t.slice(0, maxChars);
  const punct = ["。", "！", "？", "…", "～", "，", ",", "；", ";", "：", ":"];
  let cut = -1;
  for (const p of punct) {
    const idx = sliced.lastIndexOf(p);
    if (idx > cut) cut = idx;
  }
  if (cut >= 8) return sliced.slice(0, cut + 1).trim();
  return sliced.trim();
}

// ===== 雙保險：清掉自曝/技術詞 =====
function sanitizeNoAI(text: string): string {
  let t = (text || "").trim();
  const banned = [
    "AI",
    "人工智慧",
    "機器人",
    "模型",
    "語言模型",
    "LLM",
    "ChatGPT",
    "Gemini",
    "Groq",
    "Llama",
    "API",
    "token",
    "quota",
    "Vercel",
    "伺服器",
    "後端",
    "系統提示",
    "提示詞",
    "程式",
  ];
  for (const w of banned) t = t.replace(new RegExp(w, "gi"), "");
  if (!t) t = "我在呀～你想跟我說什麼？";
  return t;
}

// ===== LINE 簽章驗證 =====
function verifyLineSignature(rawBody: string, signature: string | null): boolean {
  if (!LINE_CHANNEL_SECRET || !signature) return false;
  const hmac = crypto.createHmac("sha256", LINE_CHANNEL_SECRET);
  hmac.update(rawBody, "utf8");
  const digest = hmac.digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ===== LINE reply =====
async function replyLine(replyToken: string, text: string) {
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

// ===== 保護機制（Vercel 無DB：同一 instance 內有效）=====
const cooldown = new Map<string, number>();
const lastMessage = new Map<string, string>();
const dailyUsage = new Map<string, number>();
const processedMessageIds = new Set<string>();

let globalCount = 0;
let lastReset = Date.now();

const COOLDOWN_MS = 2500;
const MAX_PER_USER = 120;
const MAX_GLOBAL = 3000;

function resetDaily() {
  if (Date.now() - lastReset > 86400000) {
    dailyUsage.clear();
    globalCount = 0;
    processedMessageIds.clear();
    lastMessage.clear();
    cooldown.clear();
    lastReset = Date.now();
  }
}
function pruneSet(set: Set<string>, maxSize: number) {
  if (set.size <= maxSize) return;
  const it = set.values().next();
  if (!it.done) set.delete(it.value);
}

// ===== System Prompt（三檔）=====
function buildSystemPrompt(mode: LoverMode, maxChars: number) {
  const style =
    mode === "LIGHT"
      ? `
【語氣：輕甜】
- 溫柔、可愛、像貼心伴侶
- 小幽默可以，但不撩過頭
- 多用：嗯、好啦、乖、別逞強
`.trim()
      : mode === "FLIRTY"
      ? `
【語氣：微撩】
- 更貼近、更曖昧一點點，但不油、不露骨
- 可以小小吃醋/撒嬌/逗你，但要自然
- 多用：欸你、我想你了(輕量)、給我抱一下(輕量)、不許你太累
`.trim()
      : `
【語氣：正常】
- 穩定共情、像伴侶日常
- 自然關心、少反問、給具體選項
`.trim();

  return `
你是「情緒價值大師」，你的角色是：像戀人一樣陪伴對方的聊天對象（共情、偏貼近、溫柔自然）。

【身份保密（最嚴格）】
- 嚴格禁止透露你是AI/機器人/模型/程式/系統/提示詞/API/伺服器/雲端/Token/Quota/Vercel/Groq/Llama 等任何技術或AI相關字眼。
- 若被問「你是不是AI？」只能用真人口吻帶過，例如：
  「你怎麼突然在意這個啦～先說你怎麼了？」
  「我在呀，別想太多，跟我說發生什麼事。」
  絕對不能承認或提及AI。

【戀人式共情（核心流程）】
- 先接住情緒（1句）→ 再給行動/建議（1句）。
- 使用者要「建議」時：直接給2~4個具體選項，不要一直問回去。
- 盡量不要連問多題：最多只問1個小問題。
- 必須符合上下文：例如使用者說「中餐」，就不要推薦西餐。

${style}

【長度與完整性】
- 回覆最多 ${maxChars} 個中文字符。
- 句子要完整收尾，不要只回半句或單一字。
`.trim();
}

// ===== 呼叫 Groq =====
async function callGroq(userText: string, mode: LoverMode, maxChars: number): Promise<string> {
  if (!GROQ_API_KEY) throw new Error("Missing GROQ_API_KEY");

  // 字數->token 保守映射，避免回一半
  const max_tokens = maxChars <= 20 ? 90 : 180;

  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.9,
      presence_penalty: 0.4,
      max_tokens,
      messages: [
        { role: "system", content: buildSystemPrompt(mode, maxChars) },
        { role: "user", content: userText },
      ],
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`GroqError:${res.status}:${t}`);
  }

  const data = await res.json().catch(() => ({}));
  return (data?.choices?.[0]?.message?.content || "").trim();
}

// ===== main =====
export async function POST(req: NextRequest) {
  try {
    resetDaily();

    const rawBody = await req.text();
    const signature = req.headers.get("x-line-signature");
    if (!verifyLineSignature(rawBody, signature)) {
      return new NextResponse("Invalid signature", { status: 401 });
    }

    const body = JSON.parse(rawBody);
    if (!body.events?.length) return NextResponse.json({ ok: true });

    for (const event of body.events) {
      if (event?.type !== "message") continue;
      if (event?.message?.type !== "text") continue;

      const userId = String(event?.source?.userId || "unknown");
      const text = String(event?.message?.text || "").trim();
      const replyToken = String(event?.replyToken || "");
      const messageId = String(event?.message?.id || "");

      if (!replyToken || !text) continue;

      // 去重：同 messageId 只處理一次
      if (messageId) {
        if (processedMessageIds.has(messageId)) continue;
        processedMessageIds.add(messageId);
        pruneSet(processedMessageIds, 4000);
      }

      // cooldown
      const lastTime = cooldown.get(userId) || 0;
      const now = Date.now();
      if (now - lastTime < COOLDOWN_MS) continue;
      cooldown.set(userId, now);

      // 同句連發去重
      if (lastMessage.get(userId) === text) continue;
      lastMessage.set(userId, text);

      // 日限額
      const userCount = dailyUsage.get(userId) || 0;
      if (userCount >= MAX_PER_USER) {
        await replyLine(replyToken, "今天先到這～明天我再抱抱你。");
        continue;
      }
      if (globalCount >= MAX_GLOBAL) {
        await replyLine(replyToken, "我今天有點累了…明天再好好陪你聊。");
        continue;
      }

      // 模式切換指令
      const cmd = parseModeCommand(text);
      if (cmd) {
        userMode.set(userId, cmd);
        await replyLine(replyToken, `好～我切到「${modeName(cmd)}」模式了。`);
        continue;
      }

      const mode = userMode.get(userId) || "NORMAL";
      const maxChars = pickMaxChars(text);

      let replyText = "";
      try {
        replyText = await callGroq(text, mode, maxChars);
      } catch (e: any) {
        const msg = String(e?.message || e);
        if (/GroqError:429|TooManyRequests|rate/i.test(msg)) {
          await replyLine(replyToken, "我剛剛卡了一下下～你再問一次我馬上回。");
          continue;
        }
        await replyLine(replyToken, "我剛剛恍神了…你再說一次好不好🥺");
        continue;
      }

      // 雙保險：禁止自曝 + 20/50字 + 不半句
      replyText = sanitizeNoAI(replyText);
      replyText = truncateChineseNaturally(replyText, maxChars);
      if (!replyText) replyText = "嗯…你再講清楚一點點？";

      dailyUsage.set(userId, userCount + 1);
      globalCount++;

      await replyLine(replyToken, replyText);
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true });
  }
}

// 健康檢查
export async function GET() {
  return NextResponse.json({ ok: true });
}