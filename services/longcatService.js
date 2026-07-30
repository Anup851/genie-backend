import fetch from "node-fetch";

const LONGCAT_DEFAULT_MAX_TOKENS = 2048;
const LONGCAT_MAX_OUTPUT_TOKENS = 131072;
const DEFAULT_LONGCAT_MODEL = "LongCat-2.0";
const DEFAULT_LONGCAT_ENDPOINT =
  "https://api.longcat.chat/openai/v1/chat/completions";

function getMessageText(content) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      return "";
    }).join("").trim();
  }
  return "";
}

function resolveLongCatModel(requestedModel) {
  return String(requestedModel || process.env.LONGCAT_MODEL || DEFAULT_LONGCAT_MODEL)
    .trim().replace(/^models\//i, "") || DEFAULT_LONGCAT_MODEL;
}

function normalizeLongCatMessages(messages = []) {
  return messages.filter((message) => ["system", "user", "assistant"].includes(message?.role))
    .map((message) => ({ role: message.role, content: getMessageText(message.content) }))
    .filter((message) => message.content);
}

function createLongCatError(status, errorText) {
  let message = "LongCat chat request failed";
  let code = "LONGCAT_REQUEST_FAILED";
  if (status === 401 || status === 403) {
    message = "LongCat API key is invalid or unauthorized";
    code = "LONGCAT_INVALID_API_KEY";
  } else if (status === 429) {
    message = "LongCat API rate limit exceeded";
    code = "LONGCAT_RATE_LIMITED";
  } else if (status >= 500) {
    message = "LongCat API server error";
    code = "LONGCAT_SERVER_ERROR";
  }
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = String(errorText || "").slice(0, 500);
  return error;
}

export function createLongCatService({ apiKey, model = DEFAULT_LONGCAT_MODEL, endpoint = DEFAULT_LONGCAT_ENDPOINT }) {
  function resolveMaxTokens(requestedMaxTokens) {
    const configuredCap = Number(process.env.LONGCAT_MAX_TOKENS || LONGCAT_DEFAULT_MAX_TOKENS);
    const safeCap = Number.isFinite(configuredCap) && configuredCap > 0
      ? Math.min(Math.floor(configuredCap), LONGCAT_MAX_OUTPUT_TOKENS) : LONGCAT_DEFAULT_MAX_TOKENS;
    const requested = Number(requestedMaxTokens);
    return !Number.isFinite(requested) || requested <= 0 ? safeCap : Math.min(Math.floor(requested), safeCap);
  }

  async function sendChatMessages({ messages, optimizedParams, signal }) {
    const normalizedMessages = normalizeLongCatMessages(messages);
    if (!normalizedMessages.length) {
      const error = new Error("LongCat received no valid chat messages");
      error.code = "LONGCAT_INVALID_REQUEST";
      error.status = 400;
      throw error;
    }
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: resolveLongCatModel(model), messages: normalizedMessages, max_tokens: resolveMaxTokens(optimizedParams?.maxTokens), temperature: optimizedParams?.temperature }),
        signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      const requestError = new Error("LongCat API request failed");
      requestError.code = "LONGCAT_NETWORK_ERROR";
      requestError.status = 502;
      throw requestError;
    }
    if (!response.ok) {
      const errorText = await response.text();
      console.error("LongCat error:", response.status, errorText.slice(0, 200));
      throw createLongCatError(response.status, errorText);
    }
    let data;
    try { data = await response.json(); } catch {
      const error = new Error("LongCat API returned an invalid response");
      error.code = "LONGCAT_INVALID_RESPONSE";
      error.status = 502;
      throw error;
    }
    const reply = data?.choices?.[0]?.message?.content;
    if (typeof reply !== "string" || !reply.trim()) {
      const error = new Error("LongCat API returned an unexpected response");
      error.code = "LONGCAT_INVALID_RESPONSE";
      error.status = 502;
      throw error;
    }
    return { reply, usage: data?.usage || null };
  }
  return { sendChatMessages };
}
