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
import { createSarvamService } from "./services/sarvamService.js";
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
const PARSEKIT_API_BASE = String(
  process.env.PARSEKIT_API_BASE || "https://api.parsekit.dev",
).replace(/\/+$/, "");
const PARSEKIT_AUTHORIZE_ENDPOINT =
  process.env.PARSEKIT_AUTHORIZE_ENDPOINT || "/authorize";
const PARSEKIT_UPLOAD_ENDPOINT = process.env.PARSEKIT_UPLOAD_ENDPOINT || "/upload";
const PARSEKIT_EXTRACT_ENDPOINT = process.env.PARSEKIT_EXTRACT_ENDPOINT || "/extract";
const PARSEKIT_JOB_ENDPOINT = process.env.PARSEKIT_JOB_ENDPOINT || "/job";
const PARSEKIT_EXTRACT_FORMAT = process.env.PARSEKIT_EXTRACT_FORMAT || "structured";
const PARSEKIT_POLL_INTERVAL_MS = Math.max(
  500,
  Number(process.env.PARSEKIT_POLL_INTERVAL_MS || 1200),
);
const PARSEKIT_MEDIA_TIMEOUT_MS = Math.max(
  10000,
  Number(process.env.PARSEKIT_MEDIA_TIMEOUT_MS || 120000),
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

const hasSarvamApiKey = !!String(process.env.SARVAM_API_KEY || "").trim();
if (!hasSarvamApiKey) {
  console.warn(
    "[BOOT] SARVAM_API_KEY is missing. Normal /chat will be unavailable, but media analysis can still run.",
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

const sarvamService = hasSarvamApiKey
  ? createSarvamService({
      apiKey: process.env.SARVAM_API_KEY,
    })
  : {
      async sendChatMessages() {
        const err = new Error("SARVAM_API_KEY is missing");
        err.code = "SARVAM_NOT_CONFIGURED";
        err.status = 503;
        throw err;
      },
    };

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
  deleteAllSessions,
  deleteSession,
  ensureSession,
  forceCleanChat,
  getChatHistory,
  getChatStats,
  listSessions,
  rollbackLastAssistantReply,
  saveMessage,
  touchSession,
  updateSessionTitle,
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

  await Promise.all([
    saveMessage(userId, "user", userMessage, activeChatId, authToken),
    saveMessage(userId, "assistant", assistantReply, activeChatId, authToken),
  ]);

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

function appendIfPresent(lines, label, value) {
  if (value == null) return;
  if (Array.isArray(value)) {
    const items = value
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (item && typeof item === "object") return JSON.stringify(item);
        return "";
      })
      .filter(Boolean);
    if (!items.length) return;
    lines.push(`**${label}**`);
    lines.push(items.map((item) => `- ${item}`).join("\n"));
    return;
  }

  if (typeof value === "object") {
    const json = JSON.stringify(value, null, 2);
    if (json && json !== "{}") {
      lines.push(`**${label}**`);
      lines.push("```json\n" + json + "\n```");
    }
    return;
  }

  const text = String(value || "").trim();
  if (!text) return;
  lines.push(`**${label}**`);
  lines.push(text);
}

function getNestedValue(source, path) {
  return String(path || "")
    .split(".")
    .filter(Boolean)
    .reduce((value, key) => (value == null ? undefined : value[key]), source);
}

function firstStringAtPaths(source, paths = []) {
  for (const path of paths) {
    const value = getNestedValue(source, path);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function collectParseKitText(source, depth = 0, seen = new Set()) {
  if (source == null || depth > 5) return [];
  if (typeof source === "string") {
    const text = source.trim();
    return text ? [text] : [];
  }
  if (typeof source !== "object") return [];
  if (seen.has(source)) return [];
  seen.add(source);

  const preferredKeys = [
    "answer",
    "analysis",
    "summary",
    "markdown",
    "text",
    "content",
    "result",
    "data",
    "output",
    "document",
    "extraction",
    "insights",
    "keyDetails",
    "key_details",
    "redFlags",
    "red_flags",
    "questions",
    "qa",
  ];
  const entries = Object.entries(source).sort(([a], [b]) => {
    const ai = preferredKeys.indexOf(a);
    const bi = preferredKeys.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  const chunks = [];
  for (const [, value] of entries) {
    chunks.push(...collectParseKitText(value, depth + 1, seen));
  }
  return chunks;
}

function formatParseKitAnalysisReply(data, userPrompt = "") {
  if (typeof data === "string") return data.trim();

  const directText = firstStringAtPaths(data, [
    "reply",
    "answer",
    "analysis",
    "summary",
    "content",
    "text",
    "markdown",
    "result.reply",
    "result.answer",
    "result.analysis",
    "result.summary",
    "result.content",
    "result.text",
    "result.markdown",
    "data.reply",
    "data.answer",
    "data.analysis",
    "data.summary",
    "data.content",
    "data.text",
    "data.markdown",
    "output.reply",
    "output.answer",
    "output.analysis",
    "output.summary",
    "output.content",
    "output.text",
    "output.markdown",
    "document.text",
    "document.markdown",
  ]);

  const lines = [];
  if (directText) {
    lines.push(directText.trim());
  }

  const result = data?.result && typeof data.result === "object" ? data.result : {};
  const body = data?.data && typeof data.data === "object" ? data.data : {};

  appendIfPresent(lines, "Key details", data?.key_details || data?.keyDetails || result?.key_details || result?.keyDetails || body?.key_details || body?.keyDetails);
  appendIfPresent(lines, "Entities", data?.entities || result?.entities || body?.entities);
  appendIfPresent(lines, "Red flags", data?.red_flags || data?.redFlags || result?.red_flags || result?.redFlags || body?.red_flags || body?.redFlags);
  appendIfPresent(lines, "Questions and answers", data?.qa || data?.questions || result?.qa || result?.questions || body?.qa || body?.questions);

  if (!lines.length) {
    const collected = Array.from(new Set(collectParseKitText(data)))
      .filter((text) => text.length > 2 && !/^true|false|null$/i.test(text))
      .slice(0, 8);
    if (collected.length) {
      lines.push(collected.join("\n\n"));
    }
  }

  if (!lines.length) {
    const json = JSON.stringify(data, null, 2);
    return json && json !== "{}"
      ? "ParseKit returned this analysis:\n```json\n" + json + "\n```"
      : "ParseKit analyzed the file, but returned no readable content.";
  }

  const prompt = String(userPrompt || "").trim();
  if (prompt && !/^analy[sz]e this file/i.test(prompt)) {
    lines.unshift(`Here is the ParseKit analysis for: "${prompt}"`);
  }

  return lines.join("\n\n").trim();
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error("Request aborted");
      err.name = "AbortError";
      reject(err);
      return;
    }

    const timer = setTimeout(resolve, ms);
    const abortHandler = () => {
      clearTimeout(timer);
      const err = new Error("Request aborted");
      err.name = "AbortError";
      reject(err);
    };
    signal?.addEventListener("abort", abortHandler, { once: true });
  });
}

async function parseKitFetch(pathOrUrl, options = {}) {
  const url = /^https?:\/\//i.test(String(pathOrUrl))
    ? String(pathOrUrl)
    : `${PARSEKIT_API_BASE}${pathOrUrl}`;
  const response = await globalThis.fetch(url, options);
  const raw = await response.text();
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = raw;
  }

  if (!response.ok) {
    const err = new Error(`ParseKit API error: ${response.status}`);
    err.status = response.status;
    err.body = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
    throw err;
  }

  return parsed;
}

function extractParseKitBearerToken(data) {
  const token = [
    data?.token,
    data?.access_token,
    data?.accessToken,
    data?.bearer_token,
    data?.bearerToken,
    data?.data?.token,
    data?.data?.access_token,
    data?.data?.accessToken,
  ].find((value) => typeof value === "string" && value.trim());

  if (!token) return "";
  return token.replace(/^Bearer\s+/i, "").trim();
}

async function authorizeParseKit(apiKey, signal) {
  const attempts = [
    {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({ api_key: apiKey, apiKey }),
    },
    {
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ api_key: apiKey, apiKey }),
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    },
  ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const result = await parseKitFetch(PARSEKIT_AUTHORIZE_ENDPOINT, {
        method: "POST",
        headers: attempt.headers,
        body: attempt.body,
        signal,
      });
      const token = extractParseKitBearerToken(result);
      if (token) return token;

      const err = new Error("ParseKit authorize returned no bearer token");
      err.status = 502;
      err.body = JSON.stringify(result);
      throw err;
    } catch (err) {
      lastError = err;
      const body = String(err?.body || "");
      if (
        body.includes("Tenant or user not found") ||
        body.includes("apiKey.findUnique") ||
        body.includes("Invalid or expired bearer token")
      ) {
        const keyErr = new Error(
          "ParseKit API key was not accepted by the configured ParseKit API",
        );
        keyErr.code = "PARSEKIT_INVALID_API_KEY";
        keyErr.status = 401;
        keyErr.body = body;
        throw keyErr;
      }
      if (![400, 401, 403, 404, 415].includes(Number(err?.status))) {
        throw err;
      }
    }
  }

  throw lastError || new Error("ParseKit authorization failed");
}

async function resolveParseKitOutput(result, authHeaders, signal) {
  let current = result;
  const startedAt = Date.now();

  while (
    current?.job_id &&
    ["queued", "processing", "pending", "running"].includes(
      String(current?.status || "").toLowerCase(),
    ) &&
    Date.now() - startedAt < PARSEKIT_MEDIA_TIMEOUT_MS
  ) {
    await sleep(PARSEKIT_POLL_INTERVAL_MS, signal);
    current = await parseKitFetch(
      `${PARSEKIT_JOB_ENDPOINT}/${encodeURIComponent(current.job_id)}`,
      { headers: authHeaders, signal },
    );
  }

  if (current?.output_url) {
    try {
      const output = await parseKitFetch(current.output_url, { signal });
      return { ...current, output };
    } catch {
      return current;
    }
  }

  return current;
}

async function callParseKitAnalyze({
  mediaData,
  mediaName = "uploaded-file",
  mimeType = "application/octet-stream",
  prompt = "",
  signal,
}) {
  const apiKey = String(process.env.PARSEKIT_API_KEY || "").trim();
  if (!apiKey) {
    const err = new Error("Missing PARSEKIT_API_KEY");
    err.code = "MISSING_PARSEKIT_API_KEY";
    throw err;
  }

  if (
    typeof globalThis.fetch !== "function" ||
    typeof globalThis.FormData !== "function" ||
    typeof globalThis.Blob !== "function"
  ) {
    const err = new Error("Native fetch/FormData/Blob are required for ParseKit uploads");
    err.code = "MISSING_NATIVE_MULTIPART";
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
  const buffer = Buffer.from(base64Data, "base64");
  const form = new globalThis.FormData();
  form.append("file", new globalThis.Blob([buffer], { type: mimeType }), mediaName);

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    PARSEKIT_MEDIA_TIMEOUT_MS,
  );
  const abortHandler = () => controller.abort();

  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  try {
    const bearerToken = await authorizeParseKit(apiKey, controller.signal);
    const authHeaders = { Authorization: `Bearer ${bearerToken}` };
    const uploadResult = await parseKitFetch(PARSEKIT_UPLOAD_ENDPOINT, {
      method: "POST",
      headers: authHeaders,
      body: form,
      signal: controller.signal,
    });

    const fileId = uploadResult?.file_id || uploadResult?.fileId || uploadResult?.id;
    const fileUrl = uploadResult?.file_url || uploadResult?.fileUrl || uploadResult?.url;

    if (!fileId && !fileUrl) {
      return uploadResult;
    }

    const extractBody = {
      format: PARSEKIT_EXTRACT_FORMAT,
      ...(fileId ? { file_id: fileId } : { file_url: fileUrl }),
    };
    const trimmedPrompt = String(prompt || "").trim();
    if (trimmedPrompt) {
      extractBody.instructions = trimmedPrompt;
      extractBody.question = trimmedPrompt;
    }

    const extractResult = await parseKitFetch(PARSEKIT_EXTRACT_ENDPOINT, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(extractBody),
      signal: controller.signal,
    });

    return resolveParseKitOutput(extractResult, authHeaders, controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      const timeoutErr = new Error("ParseKit media request timed out");
      timeoutErr.code = "PARSEKIT_TIMEOUT";
      timeoutErr.status = 504;
      throw timeoutErr;
    }
    if (err?.cause?.code === "ENOTFOUND" || err?.code === "ENOTFOUND") {
      const dnsErr = new Error(`ParseKit API host could not be resolved: ${PARSEKIT_API_BASE}`);
      dnsErr.code = "PARSEKIT_DNS_ERROR";
      dnsErr.status = 502;
      throw dnsErr;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    if (signal) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
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
    const parseKitKey = String(process.env.PARSEKIT_API_KEY || "").trim();
    const parseKitKeyPreview = parseKitKey
      ? `${parseKitKey.slice(0, 10)}...${parseKitKey.slice(-4)}`
      : "MISSING";
    console.log(
      `[KEY CHECK] route=/analyze-media provider=PARSEKIT key=${parseKitKeyPreview} chatId=${activeChatId}`,
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

    if (!parseKitKey) {
      return res.status(200).json({
        reply:
          "Media analysis is not configured on backend. Add PARSEKIT_API_KEY in server secrets/env and try again.",
      });
    }

    const supportedByParseKit =
      mimeType.startsWith("image/") ||
      mimeType === "application/pdf" ||
      mimeType.includes("word") ||
      mimeType.includes("officedocument.wordprocessingml") ||
      isTextLikeMime(mimeType);

    if (!supportedByParseKit) {
      return res.status(200).json({
        reply:
          "This file type is not supported yet for ParseKit analysis. Please upload a PDF, DOCX, TXT, CSV, code/text file, or image.",
      });
    }

    const parseKitResult = await callParseKitAnalyze({
      mediaData: uploadData,
      mediaName: safeMediaName,
      mimeType,
      prompt: userPrompt,
    });
    const reply = cleanAssistantReply(
      formatParseKitAnalysisReply(parseKitResult, userPrompt) ||
        "I could not analyze this file.",
    );

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
    if (err?.code === "PARSEKIT_TIMEOUT" || err?.status === 504) {
      return res.status(200).json({
        reply:
          "Media analysis timed out on ParseKit. Try a smaller file or a shorter prompt.",
      });
    }
    if (err?.code === "PARSEKIT_DNS_ERROR") {
      return res.status(200).json({
        reply:
          "ParseKit media analysis could not reach the API host. The backend is now configured for api.parsekit.dev; redeploy and try again.",
      });
    }
    if (err?.code === "PARSEKIT_INVALID_API_KEY") {
      return res.status(200).json({
        reply:
          "ParseKit rejected the API key. Get a fresh key from the same ParseKit dashboard used for api.parsekit.dev, update PARSEKIT_API_KEY on Render, then redeploy. Keys from a different ParseKit product/account will not work with this API.",
      });
    }
    return res.status(500).json({
      reply:
        err?.body && String(err.body).trim()
          ? `ParseKit media analysis failed: ${String(err.body).slice(0, 300)}`
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
      forceCodeMode,
      authToken,
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
    if (err?.code === "SARVAM_NOT_CONFIGURED" || err?.status === 503) {
      reply =
        "Normal chat is not configured yet. Add SARVAM_API_KEY for /chat, or use media upload with OpenRouter.";
    } else if (err.name === "AbortError") {
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
ðŸ” SARVAM_API_KEY (chat): ${process.env.SARVAM_API_KEY ? "Loaded" : "Missing!"}
ðŸ” PARSEKIT_API_KEY (media): ${process.env.PARSEKIT_API_KEY ? "Loaded" : "Missing!"}
ðŸ” DEEPAI_API_KEY (images): ${process.env.DEEPAI_API_KEY ? "Loaded" : "Missing!"}
ðŸ§  GEMINI_MODEL: ${GEMINI_MODEL}
ðŸ§  PARSEKIT_API_BASE: ${PARSEKIT_API_BASE}
ðŸ§  PARSEKIT_AUTHORIZE_ENDPOINT: ${PARSEKIT_AUTHORIZE_ENDPOINT}
ðŸ§  PARSEKIT_UPLOAD_ENDPOINT: ${PARSEKIT_UPLOAD_ENDPOINT}
ðŸ§  PARSEKIT_EXTRACT_ENDPOINT: ${PARSEKIT_EXTRACT_ENDPOINT}
ðŸ§  PARSEKIT_MEDIA_TIMEOUT_MS: ${PARSEKIT_MEDIA_TIMEOUT_MS}

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
