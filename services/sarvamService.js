import fetch from "node-fetch";

const SARVAM_STARTER_MAX_TOKENS = 2048;
const DEFAULT_SARVAM_MODEL = "sarvam-30b";

function getMessageText(content) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.map((part) => typeof part === "string" ? part : part?.text || "").join("").trim();
  return "";
}

function normalizeSarvamMessages(messages = [], systemText = "") {
  const turns = [];
  for (const message of messages) {
    if (!["user", "assistant"].includes(message?.role)) continue;
    const content = getMessageText(message.content);
    if (!content) continue;
    if (!turns.length && message.role !== "user") continue;
    const previous = turns.at(-1);
    if (previous?.role === message.role) previous.content += `\n\n${content}`;
    else turns.push({ role: message.role, content });
  }
  if (!turns.length) turns.push({ role: "user", content: "Hello" });
  if (turns.at(-1).role !== "user") turns.push({ role: "user", content: "Please continue." });
  if (systemText) turns[0].content = `[INSTRUCTION]\n${systemText}\n\n${turns[0].content}`;
  return turns;
}

function createSarvamError(status, errorText) {
  const error = new Error("Sarvam chat request failed");
  error.status = status;
  if (status === 401 || status === 403) error.code = "SARVAM_INVALID_API_KEY";
  else if (status === 402) error.code = "SARVAM_QUOTA_EXHAUSTED";
  else if (status === 429) error.code = "SARVAM_RATE_LIMITED";
  else if (status >= 500) error.code = "SARVAM_SERVER_ERROR";
  else error.code = "SARVAM_REQUEST_FAILED";
  error.details = String(errorText || "").slice(0, 500);
  return error;
}

export function createSarvamService({ apiKey, model = DEFAULT_SARVAM_MODEL, endpoint = "https://api.sarvam.ai/v1/chat/completions" }) {
  function resolveMaxTokens(requestedMaxTokens) {
    const cap = Number(process.env.SARVAM_MAX_TOKENS || SARVAM_STARTER_MAX_TOKENS);
    const safeCap = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : SARVAM_STARTER_MAX_TOKENS;
    const requested = Number(requestedMaxTokens);
    return !Number.isFinite(requested) || requested <= 0 ? safeCap : Math.min(Math.floor(requested), safeCap);
  }
  async function sendChatMessages({ messages, optimizedParams, signal }) {
    const systemText = messages.filter((message) => message?.role === "system").map((message) => getMessageText(message.content)).join("\n\n").trim();
    const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", "api-subscription-key": apiKey }, body: JSON.stringify({ model: String(model || process.env.SARVAM_MODEL || DEFAULT_SARVAM_MODEL).trim().replace(/^models\//i, ""), max_tokens: resolveMaxTokens(optimizedParams?.maxTokens), temperature: optimizedParams?.temperature, messages: normalizeSarvamMessages(messages, systemText) }), signal });
    if (!response.ok) { const errorText = await response.text(); console.error("Sarvam error:", response.status, errorText.slice(0, 200)); throw createSarvamError(response.status, errorText); }
    let data;
    try { data = await response.json(); } catch { const error = new Error("Sarvam API returned an invalid response"); error.code = "SARVAM_INVALID_RESPONSE"; error.status = 502; throw error; }
    const reply = data?.choices?.[0]?.message?.content;
    if (typeof reply !== "string" || !reply.trim()) { const error = new Error("Sarvam API returned an unexpected response"); error.code = "SARVAM_INVALID_RESPONSE"; error.status = 502; throw error; }
    return { reply, usage: data?.usage || null };
  }
  return { sendChatMessages };
}
