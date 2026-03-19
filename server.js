// server.js - Genie Backend (COMPLETE FIXED)
import crypto from "crypto";
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { createChatService, fetchGdeltArticles } from "./services/chatService.js";
import { createKeyValueStore } from "./services/dataStore.js";
import { createHistoryService } from "./services/historyService.js";
import { createSarvamService } from "./services/sarvamService.js";
import { cleanAssistantReply } from "./utils/messageFormatter.js";

dotenv.config({ quiet: true });

// --- Initialize ---
const db = createKeyValueStore();
const app = express();
const GEMINI_MODEL = String(process.env.GEMINI_MODEL || "gemini-2.5-flash")
  .trim()
  .replace(/^models\//i, "");
const GEMINI_MEDIA_MODEL = String(
  process.env.GEMINI_MEDIA_MODEL || GEMINI_MODEL,
)
  .trim()
  .replace(/^models\//i, "");
const GEMINI_API_VERSION = String(
  process.env.GEMINI_API_VERSION || "v1beta",
).trim();
const DEEPAI_API_BASE = "https://api.deepai.org/api";
const PORT = process.env.PORT || 3000;
const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://nikzyppkwedmzldghrgh.supabase.co";
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5pa3p5cHBrd2VkbXpsZGdocmdoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk0OTU1NzQsImV4cCI6MjA4NTA3MTU3NH0.ssb4-8V0wkkxyfDQSzfzgTrTbjxDu1OWyjogzJlupYM";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// --- Check API Key ---
if (!process.env.SARVAM_API_KEY) {
  console.error("âŒ SARVAM_API_KEY is missing in .env!");
  process.exit(1);
}

// --- Simple Rate Limiting ---
const requestCounts = new Map();
const MAX_REQUESTS_PER_MINUTE = 40;

function checkRateLimit(userId) {
  const now = Date.now();
  const userRequests = requestCounts.get(userId) || [];
  const recentRequests = userRequests.filter((time) => now - time < 60000);

  if (recentRequests.length >= MAX_REQUESTS_PER_MINUTE) {
    return { allowed: false, remaining: 0 };
  }

  recentRequests.push(now);
  requestCounts.set(userId, recentRequests);
  return {
    allowed: true,
    remaining: MAX_REQUESTS_PER_MINUTE - recentRequests.length,
  };
}

// --- Middleware ---
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// --- CORS Headers ---
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With",
  );
  res.header("Permissions-Policy", "microphone=(self)");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

// ============================================================
// CONSTANTS - INCREASED LIMITS
// ============================================================

const MAX_SESSIONS = 100;
const MAX_HISTORY_LENGTH = 150;
const MAX_MESSAGE_LENGTH = 12000;
const MAX_RESPONSE_TOKENS = 4000; // ðŸ”¥ INCREASED for full code
const AUTO_CLEAN_THRESHOLD = 120;
const CLEAN_KEEP_RECENT = 40;
const SESSION_LIMIT_WARNING = 100;

const historyService = createHistoryService({
  db,
  unwrapDbData: (value) => value,
  config: {
    maxSessions: MAX_SESSIONS,
    maxHistoryLength: MAX_HISTORY_LENGTH,
    maxMessageLength: MAX_MESSAGE_LENGTH,
    autoCleanThreshold: AUTO_CLEAN_THRESHOLD,
    cleanKeepRecent: CLEAN_KEEP_RECENT,
  },
});

const sarvamService = createSarvamService({
  apiKey: process.env.SARVAM_API_KEY,
});

const chatService = createChatService({
  historyService,
  sarvamService,
  config: {
    maxResponseTokens: MAX_RESPONSE_TOKENS,
    sessionLimitWarning: SESSION_LIMIT_WARNING,
  },
});

console.log("[BOOT] Modular services ready: historyService, sarvamService, chatService");
console.log("[BOOT] LangChain orchestration is enabled for normal /chat requests");
console.log("[BOOT] Sarvam remains the final model provider for normal chat");

const {
  createSession,
  ensureSession,
  forceCleanChat,
  getChatHistory,
  listSessions,
  saveMessage,
  saveSessions,
  sessionsKey,
  sessionMessagesKey,
  touchSession,
  unwrapDbData,
} = historyService;

// ============================================================
// HELPER FUNCTIONS
// ============================================================

// Current server time in IST for deterministic date/time answers.
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
  const get = (type) => parts.find((p) => p.type === type)?.value || "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} IST`;
}
function buildMediaSystemPrompt(mimeType = "") {
  const mime = String(mimeType || "").toLowerCase();
  const extractionMode =
    mime.startsWith("image/") || mime === "application/pdf"
      ? "For images and PDFs, prioritize accurate extraction over paraphrasing."
      : "For text files, preserve key structure and summarize only when useful.";

  return [
    "You analyze uploaded media and answer clearly and accurately.",
    extractionMode,
    "Do not invent details. If content is unreadable, mark it as [unclear].",
    "If the user asks for actions on the file, provide step-by-step output.",
    "For any multi-line code, always use fenced markdown code blocks with triple backticks and a language tag when known.",
    "Do not leave code fences unclosed.",
    "Always format inline code with backticks and never output placeholder tokens like @@INLINECODE0@@ or @@INLINE_CODE_0@@.",
  ].join(" ");
}

function isTextLikeMime(mimeType) {
  const mime = String(mimeType || "").toLowerCase();
  return (
    mime.startsWith("text/") ||
    mime.includes("json") ||
    mime.includes("csv") ||
    mime.includes("xml") ||
    mime.includes("javascript")
  );
}

function mapRoleForGemini(role) {
  if (role === "assistant") return "model";
  return "user";
}

function extractGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((p) => p?.text || "")
    .join("")
    .trim();
}

async function callGeminiGenerateContent({
  systemInstruction = "",
  contents = [],
  temperature = 0.7,
  maxOutputTokens = 1024,
  model = GEMINI_MODEL,
  signal,
}) {
  const normalizedModel = String(model || GEMINI_MODEL)
    .trim()
    .replace(/^models\//i, "");
  const versions = Array.from(
    new Set([
      GEMINI_API_VERSION,
      GEMINI_API_VERSION === "v1beta" ? "v1" : "v1beta",
    ]),
  );
  let lastError = null;

  for (const version of versions) {
    const endpoint = `https://generativelanguage.googleapis.com/${version}/models/${encodeURIComponent(normalizedModel)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents,
        generationConfig: {
          temperature,
          maxOutputTokens,
        },
      }),
      signal,
    });

    if (response.ok) {
      const data = await response.json();
      const text = extractGeminiText(data);
      return text || "No response.";
    }

    const errorText = await response.text();
    lastError = {
      status: response.status,
      body: errorText,
      version,
      model: normalizedModel,
    };
    if (response.status !== 404) {
      break;
    }
  }

  const err = new Error(
    `Gemini API error: ${lastError?.status || 500} model=${lastError?.model || normalizedModel}`,
  );
  err.status = lastError?.status || 500;
  err.body = lastError?.body || "";
  err.version = lastError?.version || GEMINI_API_VERSION;
  err.model = lastError?.model || normalizedModel;
  throw err;
}

async function callDeepAiTextToImage(prompt, signal) {
  const apiKey = String(process.env.DEEPAI_API_KEY || "").trim();
  if (!apiKey) {
    const err = new Error("Missing DEEPAI_API_KEY");
    err.code = "MISSING_DEEPAI_KEY";
    throw err;
  }

  const response = await fetch(`${DEEPAI_API_BASE}/text2img`, {
    method: "POST",
    headers: {
      "Api-Key": apiKey,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ text: String(prompt || "") }).toString(),
    signal,
  });

  const raw = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const err = new Error(
      `DeepAI API error: ${response.status} ${raw.slice(0, 240)}`,
    );
    err.status = response.status;
    throw err;
  }

  const imageUrl = String(
    parsed?.output_url || parsed?.outputUrl || parsed?.image || "",
  ).trim();

  if (!imageUrl) {
    const err = new Error(`DeepAI API returned no image URL: ${raw.slice(0, 240)}`);
    err.status = 502;
    throw err;
  }

  return {
    imageUrl,
    id: parsed?.id || "",
  };
}

async function supabaseAuthRequired(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user?.id) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  req.auth = { sub: data.user.id, email: data.user.email || null };
  next();
}

// ============================================================
// ENDPOINTS
// ============================================================

app.get("/", (req, res) => {
  res.json({
    status: "âœ… Genie Backend (COMPLETE FIXED)",
    timestamp: new Date().toISOString(),
    limits: {
      maxHistory: MAX_HISTORY_LENGTH,
      maxMessage: MAX_MESSAGE_LENGTH,
      maxTokens: MAX_RESPONSE_TOKENS,
      autoCleanAt: AUTO_CLEAN_THRESHOLD,
      keepAfterClean: CLEAN_KEEP_RECENT,
      rateLimit: `${MAX_REQUESTS_PER_MINUTE}/min`,
    },
  });
});

// Debug time endpoint (server clock in IST + ISO)
app.get("/api/time", (req, res) => {
  res.json({
    now_ist: getISTString(),
    now_iso: new Date().toISOString(),
  });
});

// Live news endpoint via GDELT
app.get("/api/news", async (req, res) => {
  try {
    const query = String(req.query.q || "").trim();
    const max = Math.max(1, Math.min(Number(req.query.max) || 10, 20));
    if (!query) {
      return res.json({ query, articles: [] });
    }

    const articles = await fetchGdeltArticles(query, max);
    return res.json({ query, articles });
  } catch (err) {
    console.error("/api/news error:", err);
    return res.status(500).json({ error: "Failed to fetch live news" });
  }
});

// Create new session
app.post("/chat/new", supabaseAuthRequired, async (req, res) => {
  const userId = req.auth?.sub;
  const { title } = req.body || {};
  if (!userId) return res.status(400).json({ error: "Invalid userId" });

  const session = await createSession(userId, title || "New chat");
  res.json(session);
});

// List sessions
app.get("/chats/:userId", supabaseAuthRequired, async (req, res) => {
  const userId = req.auth?.sub;
  if (!userId) return res.status(400).json({ error: "Invalid userId" });

  const sessions = await listSessions(userId);
  res.json({ sessions });
});

// Get chat messages
app.get("/chat/:userId/:chatId", supabaseAuthRequired, async (req, res) => {
  const userId = req.auth?.sub;
  const { chatId } = req.params;
  if (!userId) return res.status(400).json({ error: "Invalid userId" });

  const messages = await getChatHistory(userId, chatId);
  res.json({ chatId, messages });
});

async function analyzeMediaHandler(req, res) {
  const userId = req.auth?.sub;
  const { prompt, mediaData, imageData, mediaName, mediaType, chatId } =
    req.body || {};
  const activeChatId = chatId || "default";
  const uploadData = mediaData || imageData;

  if (!userId || !uploadData || typeof uploadData !== "string") {
    return res.status(400).json({ error: "Invalid request" });
  }

  const defaultPrompt = "Analyze this file in detail.";
  const userPrompt = String(prompt || defaultPrompt).trim() || defaultPrompt;

  try {
    const geminiKeyPreview = process.env.GEMINI_API_KEY
      ? `${process.env.GEMINI_API_KEY.slice(0, 10)}...${process.env.GEMINI_API_KEY.slice(-4)}`
      : "MISSING";
    console.log(
      `[KEY CHECK] route=/analyze-media provider=GEMINI key=${geminiKeyPreview} chatId=${activeChatId}`,
    );

    const dataUrlMatch = uploadData.match(
      /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,(.+)$/,
    );
    if (!dataUrlMatch) {
      return res.status(400).json({ error: "Invalid media format" });
    }

    const mimeType = String(mediaType || dataUrlMatch[1] || "").toLowerCase();
    const base64Data = dataUrlMatch[2];
    const safeMediaName = String(mediaName || "uploaded-file").slice(0, 160);

    if (!process.env.GEMINI_API_KEY) {
      return res.status(200).json({
        reply:
          "Media analysis is not configured on backend. Add GEMINI_API_KEY in server secrets/env and try again.",
      });
    }

    const userParts = [{ text: userPrompt }];
    if (mimeType.startsWith("image/")) {
      userParts.push({
        inlineData: { mimeType, data: base64Data },
      });
    } else if (mimeType === "application/pdf") {
      userParts.push({
        inlineData: { mimeType, data: base64Data },
      });
    } else if (isTextLikeMime(mimeType)) {
      // For text-like uploads, inline text is more reliable than binary upload.
      let decodedText = "";
      try {
        decodedText = Buffer.from(base64Data, "base64").toString("utf8");
      } catch (err) {
        decodedText = "";
      }

      if (!decodedText.trim()) {
        return res.status(200).json({
          reply:
            "This text file could not be decoded. Try uploading UTF-8 text, or convert it to PDF.",
        });
      }

      const clipped = decodedText.slice(0, 80000);
      userParts.push({
        text: `File: ${safeMediaName}\n\n${clipped}`,
      });
    } else {
      return res.status(200).json({
        reply:
          "This file type is not supported yet for direct analysis. Please convert it to PDF, TXT, CSV, or image and upload again.",
      });
    }

    const mediaMaxTokens = Number(process.env.MEDIA_MAX_TOKENS || 4096);
    const mediaTemperature = Number(process.env.MEDIA_TEMPERATURE || 0.1);
    const rawReply = await callGeminiGenerateContent({
      systemInstruction: buildMediaSystemPrompt(mimeType),
      contents: [{ role: "user", parts: userParts }],
      temperature: mediaTemperature,
      maxOutputTokens: mediaMaxTokens,
      model: GEMINI_MEDIA_MODEL,
    });

    const reply = cleanAssistantReply(rawReply || "I could not analyze this file.");

    await saveMessage(
      userId,
      "user",
      `[Media: ${mimeType}] ${userPrompt}`,
      activeChatId,
    );
    await saveMessage(userId, "assistant", reply, activeChatId);

    const history = await getChatHistory(userId, activeChatId);
    const isFirstMessage = history.length <= 2;

    if (isFirstMessage) {
      await touchSession(userId, activeChatId, userPrompt);
    } else {
      await touchSession(userId, activeChatId);
    }

    return res.json({
      reply,
      isMedia: true,
    });
  } catch (err) {
    console.error("/analyze-media error:", err);
    if (err?.status === 404) {
      return res.status(200).json({
        reply:
          `Media analysis model not found: \`${err.model || GEMINI_MODEL}\` for API \`${err.version || GEMINI_API_VERSION}\`. ` +
          "Set GEMINI_MODEL to a valid model (for example `gemini-2.5-flash`) and retry.",
      });
    }
    return res.status(500).json({
      reply: "Sorry, an error occurred while analyzing the file.",
    });
  }
}

app.post("/analyze-media", supabaseAuthRequired, analyzeMediaHandler);
app.post("/analyze-image", supabaseAuthRequired, analyzeMediaHandler);

app.post("/generate-image", supabaseAuthRequired, async (req, res) => {
  const userId = req.auth?.sub;
  const { prompt, chatId } = req.body || {};
  const activeChatId = chatId || "default";
  const userPrompt = String(prompt || "").trim();

  if (!userId || !userPrompt) {
    return res.status(400).json({ error: "Prompt is required" });
  }

  const rateLimit = checkRateLimit(userId);
  if (!rateLimit.allowed) {
    return res.status(429).json({
      reply: "Too many requests. Please wait a minute.",
      isRateLimited: true,
    });
  }

  try {
    const result = await callDeepAiTextToImage(userPrompt);
    const reply = `Generated image for: "${userPrompt}"\n${result.imageUrl}`;

    await saveMessage(userId, "user", userPrompt, activeChatId);
    await saveMessage(userId, "assistant", reply, activeChatId);

    const history = await getChatHistory(userId, activeChatId);
    const isFirstMessage = history.length <= 2;
    if (isFirstMessage) {
      await touchSession(userId, activeChatId, userPrompt);
    } else {
      await touchSession(userId, activeChatId);
    }

    return res.json({
      reply,
      imageUrl: result.imageUrl,
      provider: "deepai",
    });
  } catch (err) {
    if (err?.code === "MISSING_DEEPAI_KEY") {
      return res.status(200).json({
        reply:
          "Image generation is not configured on backend. Add DEEPAI_API_KEY in .env and restart server.",
      });
    }
    console.error("/generate-image error:", err);
    if (Number(err?.status) >= 400 && Number(err?.status) < 500) {
      return res.status(Number(err.status)).json({
        reply: `Image provider error (${err.status}): ${err.message}`,
      });
    }
    return res.status(500).json({
      reply: `Image generation failed: ${err?.message || "Unknown error"}`,
    });
  }
});

// Save client-side/manual replies (e.g., weather special command) into chat history.
app.post("/chat/manual", supabaseAuthRequired, async (req, res) => {
  const userId = req.auth?.sub;
  const { message, reply, chatId } = req.body || {};
  const activeChatId = chatId || "default";

  if (!userId || !String(message || "").trim() || !String(reply || "").trim()) {
    return res.status(400).json({ error: "Invalid request" });
  }

  try {
    await saveMessage(userId, "user", String(message).trim(), activeChatId);
    await saveMessage(userId, "assistant", String(reply).trim(), activeChatId);

    const history = await getChatHistory(userId, activeChatId);
    const isFirstMessage = history.length <= 2;
    if (isFirstMessage) {
      await touchSession(userId, activeChatId, String(message).trim());
    } else {
      await touchSession(userId, activeChatId);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ /chat/manual error:", err);
    return res.status(500).json({ error: "Failed to save manual chat" });
  }
});

// Roll back last assistant reply for a just-cancelled request.
app.post("/chat/rollback-last", supabaseAuthRequired, async (req, res) => {
  const userId = req.auth?.sub;
  const { chatId, userMessage } = req.body || {};
  const activeChatId = chatId || "default";
  const expectedUser = String(userMessage || "").trim();
  if (!userId || !activeChatId || !expectedUser) {
    return res.status(400).json({ error: "Invalid request" });
  }

  try {
    const key =
      activeChatId === "default"
        ? `chat_${userId}`
        : sessionMessagesKey(userId, activeChatId);
    const raw = await db.get(key);
    const history = Array.isArray(unwrapDbData(raw)) ? unwrapDbData(raw) : [];
    if (history.length < 2) return res.json({ ok: true, removed: false });

    const last = history[history.length - 1];
    const prev = history[history.length - 2];
    if (
      last?.role === "assistant" &&
      prev?.role === "user" &&
      String(prev?.message || "").trim() === expectedUser
    ) {
      history.pop(); // remove only assistant reply, keep user prompt
      await db.set(key, history);
      return res.json({ ok: true, removed: true });
    }

    return res.json({ ok: true, removed: false });
  } catch (err) {
    console.error("❌ /chat/rollback-last error:", err);
    return res.status(500).json({ error: "Failed to rollback message" });
  }
});
// ============================================================
// MAIN CHAT ENDPOINT - WITH SESSION LIMIT WARNING
// ============================================================

app.post("/chat", supabaseAuthRequired, async (req, res) => {
  const userId = req.auth?.sub;
  const { message, chatId, promptEnvelope } = req.body || {};
  const activeChatId = chatId || "default";
  let clientDisconnected = false;
  req.on("close", () => {
    clientDisconnected = true;
  });

  if (!userId || !message || message.trim().length === 0) {
    return res.status(400).json({ error: "Invalid request" });
  }

  const rateLimit = checkRateLimit(userId);
  if (!rateLimit.allowed) {
    return res.status(429).json({
      reply: `â³ Too many requests. Please wait a minute.`,
      isRateLimited: true,
    });
  }

  try {
    const sarvamKeyPreview = process.env.SARVAM_API_KEY
      ? `${process.env.SARVAM_API_KEY.slice(0, 10)}...${process.env.SARVAM_API_KEY.slice(-4)}`
      : "MISSING";
    console.log(
      `[KEY CHECK] route=/chat provider=SARVAM key=${sarvamKeyPreview} chatId=${activeChatId}`,
    );

    console.log(
      `ðŸ’¬ Chat request: ${userId.slice(0, 8)}... | ${String(message).trim().length} chars | chatId: ${activeChatId}`,
    );
    console.log("[CHAT FLOW] Starting LangChain prompt orchestration -> Sarvam response flow");

    // âœ… CALL SARVAM AI
    const controller = new AbortController();
    req.on("close", () => {
      try {
        controller.abort();
      } catch {}
    });
    const timeout = setTimeout(() => controller.abort(), 60000);

    const chatResult = await chatService.handleChat({
      userId,
      chatId: activeChatId,
      message,
      promptEnvelope,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    console.log(
      `[CHAT FLOW] Completed LangChain -> Sarvam flow | replyLength=${String(chatResult?.reply || "").length} | chatId=${activeChatId}`,
    );

    // If client stopped/disconnected, do not persist or send cancelled response.
    if (clientDisconnected || req.aborted) {
      console.log(`[CHAT FLOW] Client disconnected before response send | chatId=${activeChatId}`);
      return;
    }
    res.json(chatResult);
  } catch (err) {
    console.error("âŒ /chat error:", err);
    let reply = "Sorry, an error occurred.";
    if (err.name === "AbortError") {
      reply = "Request timeout. Try a smaller request.";
    }
    res.status(500).json({ reply });
  }
});

// ============================================================
// CLEANUP ENDPOINTS
// ============================================================

app.post(
  "/clean-chat/:userId/:chatId",
  supabaseAuthRequired,
  async (req, res) => {
    const userId = req.auth?.sub;
    const { chatId } = req.params;
    try {
      const cleaned = await forceCleanChat(userId, chatId);
      res.json({
        success: true,
        message: `Chat cleaned to ${cleaned.length} messages`,
        cleanedCount: cleaned.length,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ============================================================
// DELETE ENDPOINTS
// ============================================================

app.delete("/chat/:userId/:chatId", supabaseAuthRequired, async (req, res) => {
  const userId = req.auth?.sub;
  const { chatId } = req.params;
  if (!userId || !chatId) {
    return res.status(400).json({ error: "Invalid userId or chatId" });
  }

  try {
    console.log(`ðŸ—‘ï¸ Deleting chat ${chatId} for user ${userId}`);
    const messagesKey = sessionMessagesKey(userId, chatId);
    await db.delete(messagesKey);

    const sessions = await listSessions(userId);
    const filteredSessions = sessions.filter((s) => s.chatId !== chatId);
    await saveSessions(userId, filteredSessions);

    console.log(`âœ… Chat ${chatId} deleted successfully`);
    res.json({
      ok: true,
      message: "Chat deleted successfully",
      remainingSessions: filteredSessions.length,
    });
  } catch (err) {
    console.error("âŒ Delete session error:", err);
    res
      .status(500)
      .json({ error: "Failed to delete chat", details: err.message });
  }
});

app.put(
  "/chat/:userId/:chatId/title",
  supabaseAuthRequired,
  async (req, res) => {
    const userId = req.auth?.sub;
    const { chatId } = req.params;
    const title = String(req.body?.title || "")
      .trim()
      .slice(0, 60);
    if (!userId || !chatId) {
      return res.status(400).json({ error: "Invalid userId or chatId" });
    }
    if (!title) {
      return res.status(400).json({ error: "Invalid title" });
    }
    try {
      const sessions = await listSessions(userId);
      const idx = sessions.findIndex((s) => s.chatId === chatId);
      if (idx === -1) {
        return res.status(404).json({ error: "Chat not found" });
      }
      sessions[idx].title = title;
      sessions[idx].updatedAt = Date.now();
      const [session] = sessions.splice(idx, 1);
      sessions.unshift(session);
      await saveSessions(userId, sessions);
      return res.json({ success: true, chatId, title });
    } catch (err) {
      console.error("❌ Error updating chat title:", err);
      return res.status(500).json({ error: "Failed to update title" });
    }
  },
);

app.delete("/chats/:userId", supabaseAuthRequired, async (req, res) => {
  const userId = req.auth?.sub;
  if (!userId) {
    return res.status(400).json({ error: "Invalid userId" });
  }

  try {
    console.log(`ðŸ—‘ï¸ Deleting ALL chats for user ${userId}`);
    const sessions = await listSessions(userId);
    console.log(`Found ${sessions.length} sessions to delete`);

    for (const s of sessions) {
      try {
        const key = sessionMessagesKey(userId, s.chatId);
        await db.delete(key);
        console.log(`  âœ… Deleted messages: ${s.chatId}`);
      } catch (err) {
        console.error(`  âŒ Failed to delete ${s.chatId}:`, err.message);
      }
    }

    await db.set(sessionsKey(userId), []);
    try {
      await db.delete(`chat_${userId}`);
    } catch (err) {}

    console.log(`âœ… All ${sessions.length} chats deleted successfully`);
    res.json({
      ok: true,
      deleted: sessions.length,
      message: `Successfully deleted ${sessions.length} chats`,
    });
  } catch (err) {
    console.error("âŒ Delete all chats error:", err);
    res
      .status(500)
      .json({ error: "Failed to delete all chats", details: err.message });
  }
});

app.get(
  "/check-delete/:userId/:chatId",
  supabaseAuthRequired,
  async (req, res) => {
    const userId = req.auth?.sub;
    const { chatId } = req.params;
    try {
      const messagesKey = sessionMessagesKey(userId, chatId);
      const messages = await db.get(messagesKey);
      const sessions = await listSessions(userId);
      const sessionExists = sessions.some((s) => s.chatId === chatId);
      res.json({
        chatId,
        messagesExist: messages !== null,
        sessionExists,
        sessionsCount: sessions.length,
      });
    } catch (err) {
      res.json({ error: err.message });
    }
  },
);

app.get(
  "/chat-stats/:userId/:chatId",
  supabaseAuthRequired,
  async (req, res) => {
    const userId = req.auth?.sub;
    const { chatId } = req.params;
    try {
      const key = sessionMessagesKey(userId, chatId);
      const raw = await db.get(key);
      const history = Array.isArray(unwrapDbData(raw)) ? unwrapDbData(raw) : [];

      let duplicateCount = 0;
      for (let i = 1; i < history.length; i++) {
        if (
          history[i].role === history[i - 1].role &&
          history[i].message === history[i - 1].message
        ) {
          duplicateCount++;
        }
      }

      res.json({
        totalMessages: history.length,
        duplicateCount,
        needsCleaning:
          history.length > AUTO_CLEAN_THRESHOLD || duplicateCount > 0,
        autoCleanThreshold: AUTO_CLEAN_THRESHOLD,
        maxLimit: MAX_HISTORY_LENGTH,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// auth

const JWT_SECRET = process.env.JWT_SECRET || "change-this-in-replit-secrets";
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;

const usersKey = (username) => `user_${username.toLowerCase()}`;

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signToken(payload) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + TOKEN_TTL_SECONDS };
  const h = base64url(JSON.stringify(header));
  const p = base64url(JSON.stringify(body));
  const data = `${h}.${p}`;
  const sig = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(data)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${data}.${sig}`;
}

function verifyToken(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const data = `${h}.${p}`;
  const expected = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(data)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000))
      return null;
    return payload;
  } catch {
    return null;
  }
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function authRequired(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: "Unauthorized" });
  req.auth = payload;
  next();
}

app.post("/api/register", async (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  if (!username || !password)
    return res
      .status(400)
      .json({ error: "Username and password are required" });
  if (username.length < 3)
    return res
      .status(400)
      .json({ error: "Username must be at least 3 characters" });
  if (password.length < 6)
    return res
      .status(400)
      .json({ error: "Password must be at least 6 characters" });

  const existing = await db.get(usersKey(username));
  if (existing)
    return res.status(409).json({ error: "Username already exists" });

  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = hashPassword(password, salt);
  const user = {
    id: crypto.randomUUID(),
    username,
    salt,
    passwordHash,
    createdAt: Date.now(),
  };
  await db.set(usersKey(username), user);

  const token = signToken({ sub: user.id, username: user.username });
  res
    .status(201)
    .json({ token, user: { id: user.id, username: user.username } });
});

app.post("/api/login", async (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  if (!username || !password)
    return res
      .status(400)
      .json({ error: "Username and password are required" });

  const user = await db.get(usersKey(username));
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const hash = hashPassword(password, user.salt);
  if (hash !== user.passwordHash)
    return res.status(401).json({ error: "Invalid credentials" });

  const token = signToken({ sub: user.id, username: user.username });
  res.json({ token, user: { id: user.id, username: user.username } });
});

app.get("/api/me", authRequired, async (req, res) => {
  const user = await db.get(usersKey(req.auth.username));
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  res.json({ user: { id: user.id, username: user.username } });
});

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
  console.log(`
âœ… Genie Backend (COMPLETE FIXED) Running!
ðŸ“ Port: ${PORT}
ðŸ” SARVAM_API_KEY (chat): ${process.env.SARVAM_API_KEY ? "Loaded" : "Missing!"}
ðŸ” GEMINI_API_KEY (media): ${process.env.GEMINI_API_KEY ? "Loaded" : "Missing!"}
ðŸ” DEEPAI_API_KEY (images): ${process.env.DEEPAI_API_KEY ? "Loaded" : "Missing!"}
ðŸ§  GEMINI_MODEL: ${GEMINI_MODEL}
ðŸ§  GEMINI_MEDIA_MODEL: ${GEMINI_MEDIA_MODEL}
ðŸ§  GEMINI_API_VERSION: ${GEMINI_API_VERSION}
ðŸ§  MEDIA_MAX_TOKENS: ${Number(process.env.MEDIA_MAX_TOKENS || 4096)}
ðŸ§  MEDIA_TEMPERATURE: ${Number(process.env.MEDIA_TEMPERATURE || 0.1)}

ðŸ“ˆ FIXED LIMITS:
  Max History: ${MAX_HISTORY_LENGTH} messages
  Max Message: ${MAX_MESSAGE_LENGTH} chars  
  Max Tokens: ${MAX_RESPONSE_TOKENS} for code ðŸ”¥
  Rate Limit: ${MAX_REQUESTS_PER_MINUTE}/min

ðŸ§¹ AUTO-CLEAN: Clean at ${AUTO_CLEAN_THRESHOLD} messages
ðŸ’¾ Database: Connected
ðŸ§¾ Sessions: Max ${MAX_SESSIONS}
ðŸ§± LangChain Orchestration: Enabled for /chat
ðŸ¤– Chat Provider: Sarvam (unchanged)

âœ… CHAT TITLE FIXED - First message will appear as title!
âœ… DUPLICATE CHAT ENDPOINT REMOVED
âœ… TOKENS INCREASED to 4000 for complete code
  `);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nðŸ›‘ Shutting down...");
  process.exit(0);
});
