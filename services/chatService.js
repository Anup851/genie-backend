import fetch from "node-fetch";

import { cleanAssistantReply } from "../utils/messageFormatter.js";
import { buildChatParams, buildStructuredChatPrompt } from "./promptService.js";

function getISTString() {
  const now = new Date();
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value || "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} IST`;
}

function isNewsQuery(message) {
  const text = String(message || "").toLowerCase();
  return /\b(news|latest|today|current events?|breaking|headlines?|what happened)\b/.test(
    text,
  );
}

function simplifyNewsQuery(raw) {
  const input = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ");
  const stopWords = new Set([
    "the",
    "a",
    "an",
    "of",
    "in",
    "on",
    "at",
    "for",
    "to",
    "and",
    "or",
    "is",
    "are",
    "was",
    "were",
    "what",
    "happened",
    "today",
    "latest",
    "news",
    "current",
    "events",
    "breaking",
    "headlines",
    "new",
    "about",
  ]);

  const terms = input
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word && !stopWords.has(word));

  if (!terms.length) return "current world news";
  return terms.slice(0, 6).join(" ");
}

function inferNewsTimespan(rawQuery) {
  const text = String(rawQuery || "").toLowerCase();
  if (
    /\b(last\s*24\s*hours?|24\s*hours?|today|current|latest|now)\b/.test(text)
  ) {
    return "24h";
  }
  return "";
}

function buildNewsQueryCandidates(rawQuery) {
  const raw = String(rawQuery || "").trim();
  const simple = simplifyNewsQuery(raw);
  const candidates = [];

  if (raw) candidates.push(raw);
  if (simple && simple !== raw) candidates.push(simple);
  if (simple) candidates.push(`${simple} sourcelang:english`);

  if (/\bindia\b/i.test(raw) && !/\bindia\b/i.test(simple)) {
    candidates.push("india sourcelang:english");
  } else if (/\bindia\b/i.test(raw)) {
    candidates.push(`india ${simple} sourcelang:english`);
  }

  return Array.from(new Set(candidates.map((item) => item.trim()).filter(Boolean)));
}

async function fetchGdeltDocJson(query, maxRecords, timespan = "") {
  const params = new URLSearchParams({
    query,
    mode: "ArtList",
    maxrecords: String(maxRecords),
    format: "json",
    sort: "hybridrel",
  });
  if (timespan) params.set("timespan", timespan);

  const response = await fetch(
    `https://api.gdeltproject.org/api/v2/doc/doc?${params.toString()}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "GenieChatbot/1.0 (+gdelt-doc2.1)",
      },
    },
  );

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(
      `GDELT request failed: ${response.status} ${rawText.slice(0, 160)}`,
    );
  }

  try {
    return JSON.parse(rawText);
  } catch {
    throw new Error(`GDELT non-JSON response: ${rawText.slice(0, 220)}`);
  }
}

export async function fetchGdeltArticles(query, maxRecords = 10) {
  const safeQuery = String(query || "").trim();
  const safeMax = Math.max(1, Math.min(Number(maxRecords) || 10, 20));
  if (!safeQuery) return [];

  const timespan = inferNewsTimespan(safeQuery);
  const candidates = buildNewsQueryCandidates(safeQuery);
  let lastError = null;

  for (const candidate of candidates) {
    try {
      const data = await fetchGdeltDocJson(candidate, safeMax, timespan);
      const articles = Array.isArray(data?.articles) ? data.articles : [];
      if (!articles.length) continue;

      return articles.map((article) => ({
        title: String(article?.title || "").trim() || null,
        source:
          String(
            article?.sourceCommonName || article?.domain || article?.source || "",
          ).trim() || null,
        url: String(article?.url || "").trim() || null,
        published:
          String(
            article?.seendate || article?.date || article?.publishDateTime || "",
          ).trim() || null,
      }));
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError) throw lastError;
  return [];
}

function buildNewsContextBlock(articles = [], fetchFailed = false) {
  if (Array.isArray(articles) && articles.length > 0) {
    const lines = articles.slice(0, 10).map((article, index) => {
      const title = article.title || "[No title]";
      const source = article.source || "[Unknown source]";
      const published = article.published || "[Unknown time]";
      const url = article.url || "[No URL]";
      return `${index + 1}) ${title} - ${source} - ${published} - ${url}`;
    });
    return `NEWS_RESULTS:\n${lines.join("\n")}`;
  }

  if (fetchFailed) return "NEWS_RESULTS: EMPTY (live news fetch failed)";
  return "NEWS_RESULTS: EMPTY";
}

async function getLiveNewsContext(message) {
  const sanitizedMessage = String(message || "").trim();
  const wantsNews = isNewsQuery(sanitizedMessage);
  if (!wantsNews) {
    return {
      wantsNews: false,
      newsContextBlock: "",
    };
  }

  try {
    const articles = await fetchGdeltArticles(simplifyNewsQuery(sanitizedMessage), 10);
    return {
      wantsNews: true,
      newsContextBlock: buildNewsContextBlock(articles, false),
    };
  } catch (err) {
    console.error("/chat news fetch error:", err);
    return {
      wantsNews: true,
      newsContextBlock: buildNewsContextBlock([], true),
    };
  }
}

function prepareChatHistory(history = []) {
  const cleanedHistory = Array.isArray(history) ? history : [];
  if (cleanedHistory.length <= 100) {
    return { hasDuplicates: false };
  }

  for (let index = 1; index < cleanedHistory.length; index += 1) {
    if (
      cleanedHistory[index].role === cleanedHistory[index - 1].role &&
      cleanedHistory[index].message === cleanedHistory[index - 1].message
    ) {
      return { hasDuplicates: true };
    }
  }

  return { hasDuplicates: false };
}

function buildSessionWarning(historyLength, sessionLimitWarning) {
  if (historyLength < sessionLimitWarning - 20) return null;
  if (historyLength >= sessionLimitWarning) {
    return {
      limitReached: true,
      reply:
        "⚠️ **Chat session limit reached!** ⚠️\n\nThis conversation has too many messages. Please **start a new chat** to continue smoothly.\n\n👉 Click **New Chat** button to create a fresh session.",
      payload: {
        sessionLimitExceeded: true,
        forceNewChat: true,
        messageCount: historyLength,
      },
    };
  }

  const remaining = sessionLimitWarning - historyLength;
  return {
    limitReached: false,
    warning: `\n\n---\n⚠️ **Warning:** This chat has ${historyLength} messages. You have **${remaining} messages** left before session limit. Consider starting a new chat.`,
    payload: {
      messageCount: historyLength,
      remaining,
      limit: sessionLimitWarning,
    },
  };
}

export function createChatService({
  historyService,
  sarvamService,
  config,
}) {
  const { maxResponseTokens, sessionLimitWarning } = config;
  const {
    forceCleanChat,
    getChatHistory,
    saveMessage,
    touchSession,
  } = historyService;

  async function handleChat({
    userId,
    chatId = "default",
    message,
    promptEnvelope,
    forceCodeMode = false,
    authToken,
    signal,
  }) {
    const sanitizedMessage = String(message || "").trim();
    const promptMessage =
      typeof promptEnvelope === "string" && promptEnvelope.trim()
        ? promptEnvelope.trim().slice(0, 40000)
        : sanitizedMessage;

    const optimizedParams = buildChatParams(sanitizedMessage, maxResponseTokens, {
      forceCodeMode,
    });
    const nowIST = getISTString();
    const newsContext = await getLiveNewsContext(sanitizedMessage);

    let history = await getChatHistory(userId, chatId, authToken);
    const sessionWarning = buildSessionWarning(history.length, sessionLimitWarning);
    if (sessionWarning?.limitReached) {
      return {
        reply: sessionWarning.reply,
        ...sessionWarning.payload,
      };
    }

    const isFirstMessage = history.length === 0;
    if (prepareChatHistory(history).hasDuplicates) {
      history = await forceCleanChat(userId, chatId, authToken);
    }

    const promptContext = await buildStructuredChatPrompt({
      history,
      userMessage: promptMessage,
      nowIST,
      newsContextBlock: newsContext.wantsNews ? newsContext.newsContextBlock : "",
      optimizedParams,
    });

    const messages = [
      { role: "system", content: promptContext.systemText },
      ...promptContext.historyMessages,
      { role: "user", content: promptContext.userText },
    ];

    const { reply: rawReply, usage } = await sarvamService.sendChatMessages({
      messages,
      optimizedParams,
      signal,
    });

    const reply = cleanAssistantReply(rawReply);

    if (chatId && chatId !== "default") {
      await historyService.ensureSession(userId, chatId, authToken);
    }

    await saveMessage(userId, "user", sanitizedMessage, chatId, authToken);
    await saveMessage(userId, "assistant", reply, chatId, authToken);

    if (isFirstMessage) {
      await touchSession(userId, chatId, sanitizedMessage, authToken);
    } else {
      await touchSession(userId, chatId, null, authToken);
    }

    let finalReply = reply;
    let warning = null;
    if (sessionWarning && !sessionWarning.limitReached) {
      warning = sessionWarning.warning;
      finalReply = `${reply}${warning}`;
    }

    return {
      reply: finalReply,
      usage,
      isLarge: reply.length > 5000,
      historyCount: history.length + 2,
      isFirstMessage,
      sessionWarning: warning ? sessionWarning.payload : null,
      sessionLimitExceeded: false,
      orchestration: "langchain-history-only",
      provider: "sarvam",
    };
  }

  return {
    handleChat,
  };
}
