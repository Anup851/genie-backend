// server.js - Genie Backend (COMPLETE FIXED)
import crypto from "crypto";
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { createChatService, fetchGdeltArticles } from "./services/chatService.js";
import { createKeyValueStore } from "./services/dataStore.js";
import { createHistoryService } from "./services/historyService.js";
import { createLongCatService } from "./services/longcatService.js";
import { cleanAssistantReply } from "./utils/messageFormatter.js";

dotenv.config({ quiet: true });

// --- Initialize ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
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
const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
const OPENROUTER_MEDIA_MODEL = String(
  process.env.OPENROUTER_MEDIA_MODEL ||
    "nvidia/nemotron-nano-12b-v2-vl:free",
).trim();
const OPENROUTER_MEDIA_TIMEOUT_MS = Math.max(
  10000,
  Number(process.env.OPENROUTER_MEDIA_TIMEOUT_MS || 60000),
);
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

const hasLongCatApiKey = !!String(process.env.LONGCAT_API_KEY || "").trim();
if (!hasLongCatApiKey) {
  console.warn(
    "[BOOT] LONGCAT_API_KEY is missing. Normal /chat will be unavailable, but media analysis can still run.",
  );
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
app.use(express.json({ limit: process.env.EXPRESS_JSON_LIMIT || "70mb" }));
app.use(express.urlencoded({ extended: true, limit: process.env.EXPRESS_JSON_LIMIT || "70mb" }));
app.use(cors());
app.use(express.static(__dirname));

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
  config: {
    maxSessions: MAX_SESSIONS,
    maxHistoryLength: MAX_HISTORY_LENGTH,
    maxMessageLength: MAX_MESSAGE_LENGTH,
    autoCleanThreshold: AUTO_CLEAN_THRESHOLD,
    cleanKeepRecent: CLEAN_KEEP_RECENT,
  },
  supabaseUrl: SUPABASE_URL,
  supabaseAnonKey: SUPABASE_ANON_KEY,
});

const longcatService = hasLongCatApiKey
  ? createLongCatService({
      apiKey: process.env.LONGCAT_API_KEY,
    })
  : {
      async sendChatMessages() {
        const err = new Error("LONGCAT_API_KEY is missing");
        err.code = "LONGCAT_NOT_CONFIGURED";
        err.status = 503;
        throw err;
      },
    };

const chatService = createChatService({
  historyService,
  longcatService,
  config: {
    maxResponseTokens: MAX_RESPONSE_TOKENS,
    sessionLimitWarning: SESSION_LIMIT_WARNING,
  },
});

console.log("[BOOT] Modular services ready: historyService, longcatService, chatService");
console.log("[BOOT] LangChain orchestration is enabled for normal /chat requests");
console.log("[BOOT] LongCat remains the final model provider for normal chat");

const {
  createSession,
  deleteAllSessions,
  deleteSession,
  ensureSession,
  forceCleanChat,
  getChatHistory,
  getChatStats,
  listMemories,
  listSessions,
  rollbackLastAssistantReply,
  saveMessage,
  touchSession,
  upsertMemory,
  updateSessionTitle,
  deleteMemories,
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

async function ensureChatSessionForRoute(userId, chatId, authToken) {
  if (!userId || !chatId || chatId === "default") return null;
  return ensureSession(userId, chatId, authToken);
}

async function persistConversationTurn({
  userId,
  authToken,
  chatId,
  userMessage,
  assistantReply,
}) {
  const activeChatId = chatId || "default";
  await ensureChatSessionForRoute(userId, activeChatId, authToken);

  await saveMessage(userId, "user", userMessage, activeChatId, authToken);
  await saveMessage(userId, "assistant", assistantReply, activeChatId, authToken);

  const history = await getChatHistory(userId, activeChatId, authToken);
  const isFirstMessage = history.length <= 2;

  if (isFirstMessage) {
    await touchSession(userId, activeChatId, userMessage, authToken);
  } else {
    await touchSession(userId, activeChatId, null, authToken);
  }

  return { history, isFirstMessage };
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
    mime.includes("rtf") ||
    mime.includes("json") ||
    mime.includes("csv") ||
    mime.includes("xml") ||
    mime.includes("javascript") ||
    mime.includes("typescript") ||
    mime.includes("x-python")
  );
}

function inferMediaMimeType({ mediaType = "", dataUrlMime = "", mediaName = "" } = {}) {
  const supplied = String(mediaType || "").toLowerCase();
  if (supplied && supplied !== "application/octet-stream") return supplied;

  const fromDataUrl = String(dataUrlMime || "").toLowerCase();
  if (fromDataUrl && fromDataUrl !== "application/octet-stream") return fromDataUrl;

  const name = String(mediaName || "").toLowerCase();
  const extensionMap = {
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".csv": "text/csv",
    ".rtf": "application/rtf",
    ".xml": "application/xml",
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".ts": "text/typescript",
    ".py": "text/x-python",
    ".java": "text/x-java-source",
    ".c": "text/x-c",
    ".cpp": "text/x-c++",
  };

  for (const [extension, mime] of Object.entries(extensionMap)) {
    if (name.endsWith(extension)) return mime;
  }

  return supplied || fromDataUrl || "";
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTemporaryGeminiError(status) {
  return [429, 500, 502, 503, 504].includes(Number(status));
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
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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

      if (response.status === 404) break;
      if (
        attempt < maxAttempts &&
        isTemporaryGeminiError(response.status)
      ) {
        await delay(350 * attempt);
        continue;
      }

      break;
    }

    if (lastError?.status !== 404) break;
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

function isGeminiSupportedMedia(mimeType) {
  const mime = String(mimeType || "").toLowerCase();
  return (
    mime.startsWith("image/") ||
    mime === "application/pdf" ||
    isTextLikeMime(mime)
  );
}

async function callGeminiMediaAnalysis({
  mediaData,
  mimeType,
  prompt,
  signal,
}) {
  const apiKey = String(process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    const err = new Error("Missing GEMINI_API_KEY");
    err.code = "MISSING_GEMINI_API_KEY";
    throw err;
  }

  const dataUrlMatch = String(mediaData || "").match(
    /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,(.+)$/,
  );
  if (!dataUrlMatch) {
    const err = new Error("Invalid media format");
    err.status = 400;
    throw err;
  }

  const base64Data = dataUrlMatch[2];
  const parts = [
    {
      text: String(prompt || "Analyze this file in detail.").trim(),
    },
  ];

  if (isTextLikeMime(mimeType)) {
    let decodedText = "";
    try {
      decodedText = Buffer.from(base64Data, "base64").toString("utf8");
    } catch {
      decodedText = "";
    }

    if (!decodedText.trim()) {
      const err = new Error("Uploaded text file could not be decoded");
      err.code = "GEMINI_TEXT_DECODE_FAILED";
      throw err;
    }

    parts.push({
      text: `Uploaded file content:\n\n${decodedText.slice(0, 120000)}`,
    });
  } else {
    parts.push({
      inline_data: {
        mime_type: mimeType,
        data: base64Data,
      },
    });
  }

  return callGeminiGenerateContent({
    systemInstruction: buildMediaSystemPrompt(mimeType),
    contents: [{ role: "user", parts }],
    temperature: Number(process.env.MEDIA_TEMPERATURE || 0.1),
    maxOutputTokens: Number(process.env.MEDIA_MAX_TOKENS || 2048),
    model: GEMINI_MEDIA_MODEL || GEMINI_MODEL,
    signal,
  });
}

function extractOpenRouterText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.content === "string") return part.content;
      return "";
    })
    .join("")
    .trim();
}

async function callOpenRouterChatCompletion({
  systemInstruction = "",
  messages = [],
  temperature = 0.1,
  maxTokens = 1200,
  model = OPENROUTER_MEDIA_MODEL,
  plugins,
  signal,
}) {
  const apiKey = String(
    process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || "",
  ).trim();
  if (!apiKey) {
    const err = new Error("Missing OpenRouter API key");
    err.code = "MISSING_OPENROUTER_API_KEY";
    throw err;
  }

  const payload = {
    model,
    messages: [],
    temperature,
    max_tokens: maxTokens,
  };

  if (systemInstruction) {
    payload.messages.push({
      role: "system",
      content: systemInstruction,
    });
  }

  payload.messages.push(...messages);

  if (Array.isArray(plugins) && plugins.length) {
    payload.plugins = plugins;
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    OPENROUTER_MEDIA_TIMEOUT_MS,
  );
  const abortHandler = () => controller.abort();

  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  let response;
  try {
    response = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      const timeoutErr = new Error("OpenRouter media request timed out");
      timeoutErr.code = "OPENROUTER_TIMEOUT";
      timeoutErr.status = 504;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    if (signal) {
      signal.removeEventListener("abort", abortHandler);
    }
  }

  if (!response.ok) {
    const errorText = await response.text();
    const err = new Error(
      `OpenRouter API error: ${response.status} model=${model}`,
    );
    err.status = response.status;
    err.body = errorText;
    err.model = model;
    throw err;
  }

  const data = await response.json();
  return extractOpenRouterText(data) || "No response.";
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

  req.auth = { sub: data.user.id, email: data.user.email || null, token };
  next();
}

// ============================================================
// ENDPOINTS
// ============================================================

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "genie-backend",
    message: "Backend API is running. Use the frontend app for chat UI.",
  });
});

app.get("/auth", (req, res) => {
  res.redirect("/");
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "genie-backend",
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
  const authToken = req.auth?.token;
  const { title } = req.body || {};
  if (!userId) return res.status(400).json({ error: "Invalid userId" });

  const session = await createSession(userId, title || "New chat", authToken);
  res.json(session);
});

// List sessions
app.get("/chats/:userId", supabaseAuthRequired, async (req, res) => {
  const userId = req.auth?.sub;
  const authToken = req.auth?.token;
  if (!userId) return res.status(400).json({ error: "Invalid userId" });

  const sessions = await listSessions(userId, authToken);
  res.json({ sessions });
});

// Get chat messages
app.get("/chat/:userId/:chatId", supabaseAuthRequired, async (req, res) => {
  const userId = req.auth?.sub;
  const authToken = req.auth?.token;
  const { chatId } = req.params;
  if (!userId) return res.status(400).json({ error: "Invalid userId" });

  const messages = await getChatHistory(userId, chatId, authToken);
  res.json({ chatId, messages });
});

app.get("/memory/:userId", supabaseAuthRequired, async (req, res) => {
  const userId = req.auth?.sub;
  const authToken = req.auth?.token;
  if (!userId) return res.status(400).json({ error: "Invalid userId" });

  try {
    const memories = await listMemories(userId, authToken);
    return res.json({ memories });
  } catch (err) {
    console.error("/memory list error:", err);
    return res.status(500).json({ error: "Failed to load memory" });
  }
});

app.post("/memory/:userId", supabaseAuthRequired, async (req, res) => {
  const userId = req.auth?.sub;
  const authToken = req.auth?.token;
  if (!userId) return res.status(400).json({ error: "Invalid userId" });

  try {
    const memory = await upsertMemory(userId, req.body || {}, authToken);
    return res.json({ memory });
  } catch (err) {
    console.error("/memory upsert error:", err);
    return res.status(500).json({ error: "Failed to save memory" });
  }
});

app.delete("/memory/:userId", supabaseAuthRequired, async (req, res) => {
  const userId = req.auth?.sub;
  const authToken = req.auth?.token;
  if (!userId) return res.status(400).json({ error: "Invalid userId" });

  try {
    await deleteMemories(userId, authToken);
    return res.json({ ok: true });
  } catch (err) {
    console.error("/memory delete error:", err);
    return res.status(500).json({ error: "Failed to clear memory" });
  }
});

async function analyzeMediaHandler(req, res) {
  const userId = req.auth?.sub;
  const authToken = req.auth?.token;
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
    const geminiKey = String(process.env.GEMINI_API_KEY || "").trim();
    const geminiKeyPreview = geminiKey
      ? `${geminiKey.slice(0, 10)}...${geminiKey.slice(-4)}`
      : "MISSING";
    console.log(
      `[KEY CHECK] route=/analyze-media provider=GEMINI key=${geminiKeyPreview} model=${GEMINI_MEDIA_MODEL} chatId=${activeChatId}`,
    );

    const dataUrlMatch = uploadData.match(
      /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,(.+)$/,
    );
    if (!dataUrlMatch) {
      return res.status(400).json({ error: "Invalid media format" });
    }

    const safeMediaName = String(mediaName || "uploaded-file").slice(0, 160);
    const mimeType = inferMediaMimeType({
      mediaType,
      dataUrlMime: dataUrlMatch[1],
      mediaName: safeMediaName,
    });

    if (!geminiKey) {
      return res.status(200).json({
        reply:
          "Media analysis is not configured on backend. Add GEMINI_API_KEY in server secrets/env and try again.",
      });
    }

    if (!isGeminiSupportedMedia(mimeType)) {
      return res.status(200).json({
        reply:
          "This file type is not supported yet for Gemini media analysis. Please upload a PDF, image, TXT, CSV, JSON, or code/text file.",
      });
    }

    const rawReply = await callGeminiMediaAnalysis({
      mediaData: uploadData,
      mimeType,
      prompt: userPrompt,
    });
    const reply = cleanAssistantReply(rawReply || "I could not analyze this file.");

    await persistConversationTurn({
      userId,
      authToken,
      chatId: activeChatId,
      userMessage: `[Media: ${mimeType}] ${userPrompt}`,
      assistantReply: reply,
    });

    return res.json({
      reply,
      isMedia: true,
    });
  } catch (err) {
    console.error("/analyze-media error:", err);
    if (err?.name === "AbortError" || err?.status === 504) {
      return res.status(200).json({
        reply:
          "Media analysis timed out on Gemini. Try a smaller file or a shorter prompt.",
      });
    }
    if (isTemporaryGeminiError(err?.status)) {
      return res.status(200).json({
        reply:
          "Gemini media analysis is temporarily busy. Please retry in a moment.",
      });
    }
    if (err?.code === "MISSING_GEMINI_API_KEY") {
      return res.status(200).json({
        reply:
          "Media analysis is not configured on backend. Add GEMINI_API_KEY in server secrets/env and try again.",
      });
    }
    if (err?.code === "GEMINI_TEXT_DECODE_FAILED") {
      return res.status(200).json({
        reply:
          "This text file could not be decoded. Try uploading UTF-8 text, or convert it to PDF.",
      });
    }
    return res.status(500).json({
      reply:
        err?.body && String(err.body).trim()
          ? `Gemini media analysis failed: ${String(err.body).slice(0, 300)}`
          : "Sorry, an error occurred while analyzing the file.",
    });
  }
}

app.post("/analyze-media", supabaseAuthRequired, analyzeMediaHandler);
app.post("/analyze-image", supabaseAuthRequired, analyzeMediaHandler);

app.post("/generate-image", supabaseAuthRequired, async (req, res) => {
  const userId = req.auth?.sub;
  const authToken = req.auth?.token;
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

    await persistConversationTurn({
      userId,
      authToken,
      chatId: activeChatId,
      userMessage: userPrompt,
      assistantReply: reply,
    });

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
  const authToken = req.auth?.token;
  const { message, reply, chatId } = req.body || {};
  const activeChatId = chatId || "default";

  if (!userId || !String(message || "").trim() || !String(reply || "").trim()) {
    return res.status(400).json({ error: "Invalid request" });
  }

  try {
    await persistConversationTurn({
      userId,
      authToken,
      chatId: activeChatId,
      userMessage: String(message).trim(),
      assistantReply: String(reply).trim(),
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ /chat/manual error:", err);
    return res.status(500).json({ error: "Failed to save manual chat" });
  }
});

// Roll back last assistant reply for a just-cancelled request.
app.post("/chat/rollback-last", supabaseAuthRequired, async (req, res) => {
  const userId = req.auth?.sub;
  const authToken = req.auth?.token;
  const { chatId, userMessage } = req.body || {};
  const activeChatId = chatId || "default";
  const expectedUser = String(userMessage || "").trim();
  if (!userId || !activeChatId || !expectedUser) {
    return res.status(400).json({ error: "Invalid request" });
  }

  try {
    const result = await rollbackLastAssistantReply(
      userId,
      activeChatId,
      expectedUser,
      authToken,
    );
    return res.json(result);
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
  const authToken = req.auth?.token;
  const { message, chatId, promptEnvelope, clientContextMeta } = req.body || {};
  const activeChatId = chatId || "default";
  const forceCodeMode = !!clientContextMeta?.forceCodeMode;
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
    console.log(`[KEY CHECK] route=/chat provider=LONGCAT chatId=${activeChatId}`);

    console.log(
      `ðŸ’¬ Chat request: ${userId.slice(0, 8)}... | ${String(message).trim().length} chars | chatId: ${activeChatId}`,
    );
    console.log("[CHAT FLOW] Starting LangChain prompt orchestration -> LongCat response flow");

    // âœ… CALL LONGCAT AI
    const controller = new AbortController();
    req.on("close", () => {
      try {
        controller.abort();
      } catch {}
    });
    const timeout = setTimeout(() => controller.abort(), 30000);

    const chatResult = await chatService.handleChat({
      userId,
      chatId: activeChatId,
      message,
      promptEnvelope,
      forceCodeMode,
      authToken,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    console.log(
      `[CHAT FLOW] Completed LangChain -> LongCat flow | replyLength=${String(chatResult?.reply || "").length} | chatId=${activeChatId}`,
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
    if (err?.code === "LONGCAT_NOT_CONFIGURED") {
      reply =
        "Normal chat is not configured yet. Add LONGCAT_API_KEY for /chat, or use media upload with OpenRouter.";
    } else if (err?.code === "LONGCAT_INVALID_API_KEY") {
      reply = "LongCat API key is invalid or unauthorized. Check LONGCAT_API_KEY.";
    } else if (err?.code === "LONGCAT_QUOTA_EXHAUSTED") {
      reply = "LongCat token quota is exhausted. Add or request quota in your LongCat account, then try again.";
    } else if (err?.code === "LONGCAT_RATE_LIMITED") {
      reply = "LongCat is rate-limiting requests. Please try again shortly.";
    } else if (err?.code === "LONGCAT_SERVER_ERROR") {
      reply = "LongCat is temporarily unavailable. Please try again shortly.";
    } else if (err?.code === "LONGCAT_INVALID_RESPONSE") {
      reply = "LongCat returned an unexpected response. Please try again.";
    } else if (err?.code === "LONGCAT_NETWORK_ERROR") {
      reply = "Unable to reach LongCat right now. Please try again.";
    } else if (err.name === "AbortError") {
      reply = "Request timeout. Try a smaller request.";
    }
    const status =
      err?.code === "LONGCAT_NOT_CONFIGURED"
        ? 503
        : err?.code === "LONGCAT_INVALID_API_KEY"
          ? 401
          : err?.code === "LONGCAT_QUOTA_EXHAUSTED"
            ? 402
            : err?.code === "LONGCAT_RATE_LIMITED"
              ? 429
              : err?.code === "LONGCAT_SERVER_ERROR" || err?.code === "LONGCAT_NETWORK_ERROR"
                ? 502
                : err?.name === "AbortError"
                  ? 504
                  : 500;
    res.status(status).json({ reply });
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
    const authToken = req.auth?.token;
    const { chatId } = req.params;
    try {
      const cleaned = await forceCleanChat(userId, chatId, authToken);
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
  const authToken = req.auth?.token;
  const { chatId } = req.params;
  if (!userId || !chatId) {
    return res.status(400).json({ error: "Invalid userId or chatId" });
  }

  try {
    console.log(`ðŸ—‘ï¸ Deleting chat ${chatId} for user ${userId}`);
    await deleteSession(userId, chatId, authToken);
    const sessions = await listSessions(userId, authToken);

    console.log(`âœ… Chat ${chatId} deleted successfully`);
    res.json({
      ok: true,
      message: "Chat deleted successfully",
      remainingSessions: sessions.length,
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
    const authToken = req.auth?.token;
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
      const session = await updateSessionTitle(userId, chatId, title, authToken);
      if (!session) {
        return res.status(404).json({ error: "Chat not found" });
      }
      return res.json({ success: true, chatId, title });
    } catch (err) {
      console.error("❌ Error updating chat title:", err);
      return res.status(500).json({ error: "Failed to update title" });
    }
  },
);

app.delete("/chats/:userId", supabaseAuthRequired, async (req, res) => {
  const userId = req.auth?.sub;
  const authToken = req.auth?.token;
  if (!userId) {
    return res.status(400).json({ error: "Invalid userId" });
  }

  try {
    console.log(`ðŸ—‘ï¸ Deleting ALL chats for user ${userId}`);
    const deleted = await deleteAllSessions(userId, authToken);
    console.log(`âœ… All ${deleted} chats deleted successfully`);
    res.json({
      ok: true,
      deleted,
      message: `Successfully deleted ${deleted} chats`,
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
    const authToken = req.auth?.token;
    const { chatId } = req.params;
    try {
      const messages = await getChatHistory(userId, chatId, authToken);
      const sessions = await listSessions(userId, authToken);
      const sessionExists = sessions.some((s) => s.chatId === chatId);
      res.json({
        chatId,
        messagesExist: Array.isArray(messages) && messages.length > 0,
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
    const authToken = req.auth?.token;
    const { chatId } = req.params;
    try {
      res.json(await getChatStats(userId, chatId, authToken));
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
ðŸ” LONGCAT_API_KEY (chat): ${process.env.LONGCAT_API_KEY ? "Loaded" : "Missing!"}
ðŸ” GEMINI_API_KEY (media): ${process.env.GEMINI_API_KEY ? "Loaded" : "Missing!"}
ðŸ” DEEPAI_API_KEY (images): ${process.env.DEEPAI_API_KEY ? "Loaded" : "Missing!"}
ðŸ§  GEMINI_MODEL: ${GEMINI_MODEL}
ðŸ§  GEMINI_MEDIA_MODEL: ${GEMINI_MEDIA_MODEL}
ðŸ§  GEMINI_API_VERSION: ${GEMINI_API_VERSION}

ðŸ“ˆ FIXED LIMITS:
  Max History: ${MAX_HISTORY_LENGTH} messages
  Max Message: ${MAX_MESSAGE_LENGTH} chars  
  Max Tokens: ${MAX_RESPONSE_TOKENS} for code ðŸ”¥
  Rate Limit: ${MAX_REQUESTS_PER_MINUTE}/min

ðŸ§¹ AUTO-CLEAN: Clean at ${AUTO_CLEAN_THRESHOLD} messages
ðŸ’¾ Database: Connected
ðŸ§¾ Sessions: Max ${MAX_SESSIONS}
ðŸ§± LangChain Orchestration: Enabled for /chat
ðŸ¤– Chat Provider: LongCat-2.0

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
