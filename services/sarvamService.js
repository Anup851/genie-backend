import fetch from "node-fetch";

const SARVAM_STARTER_MAX_TOKENS = 2048;

function getMessageText(content) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        return "";
      })
      .join("")
      .trim();
  }
  return "";
}

function isSarvamTurnOrderError(errorText = "") {
  const text = String(errorText || "").toLowerCase();
  return (
    text.includes("first message must be from user") ||
    (text.includes("starting with a user message") &&
      text.includes("must alternate"))
  );
}

function normalizeSarvamMessages(messages = [], opts = {}) {
  const includeSystem = opts.includeSystem !== false;
  const systemText = String(opts.systemText || "");
  const normalized = [];

  if (includeSystem && systemText) {
    normalized.push({ role: "system", content: systemText });
  }

  const turns = [];
  for (const message of messages) {
    if (message?.role !== "user" && message?.role !== "assistant") continue;
    const content = getMessageText(message.content);
    if (!content) continue;

    if (!turns.length) {
      if (message.role !== "user") continue;
      turns.push({ role: "user", content });
      continue;
    }

    const previous = turns[turns.length - 1];
    if (previous.role === message.role) {
      previous.content = `${previous.content}\n\n${content}`;
    } else {
      turns.push({ role: message.role, content });
    }
  }

  if (!turns.length) {
    turns.push({ role: "user", content: "Hello" });
  }

  if (turns[turns.length - 1].role !== "user") {
    turns.push({ role: "user", content: "Please continue." });
  }

  if (!includeSystem && systemText && turns[0]?.role === "user") {
    turns[0].content = `[INSTRUCTION]\n${systemText}\n\n${turns[0].content}`;
  }

  return normalized.concat(turns);
}

export function createSarvamService({
  apiKey,
  model = process.env.SARVAM_MODEL || "sarvam-m",
  endpoint = "https://api.sarvam.ai/v1/chat/completions",
}) {
  function resolveMaxTokens(requestedMaxTokens) {
    const configuredCap = Number(
      process.env.SARVAM_MAX_TOKENS || SARVAM_STARTER_MAX_TOKENS,
    );
    const safeCap =
      Number.isFinite(configuredCap) && configuredCap > 0
        ? Math.floor(configuredCap)
        : SARVAM_STARTER_MAX_TOKENS;
    const requested = Number(requestedMaxTokens);
    if (!Number.isFinite(requested) || requested <= 0) return safeCap;
    return Math.min(Math.floor(requested), safeCap);
  }

  async function sendChatMessages({ messages, optimizedParams, signal }) {
    const systemText = messages
      .filter((message) => message?.role === "system")
      .map((message) => getMessageText(message.content))
      .join("\n\n")
      .trim();

    const headers = {
      "Content-Type": "application/json",
      "api-subscription-key": apiKey,
    };

    const payload = {
      model,
      max_tokens: resolveMaxTokens(optimizedParams.maxTokens),
      temperature: optimizedParams.temperature,
    };

    let response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...payload,
        messages: normalizeSarvamMessages(messages, {
          includeSystem: true,
          systemText,
        }),
      }),
      signal,
    });

    if (!response.ok) {
      let errorText = await response.text();
      console.error("Sarvam error:", response.status, errorText.substring(0, 200));

      if (response.status === 400 && isSarvamTurnOrderError(errorText)) {
        response = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({
            ...payload,
            messages: normalizeSarvamMessages(messages, {
              includeSystem: false,
              systemText,
            }),
          }),
          signal,
        });

        if (!response.ok) {
          errorText = await response.text();
          console.error(
            "Sarvam retry error:",
            response.status,
            errorText.substring(0, 200),
          );
        }
      }
    }

    if (!response.ok) {
      const err = new Error("Sarvam chat request failed");
      err.status = response.status;
      throw err;
    }

    const data = await response.json();
    return {
      reply: data?.choices?.[0]?.message?.content || "No response.",
      usage: data?.usage || null,
    };
  }

  return {
    sendChatMessages,
  };
}
