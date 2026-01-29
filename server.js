// server.js
// Genie Backend - Memory Engine v3 + Chat Sessions + AUTH (JWT)

import Database from "@replit/database";
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

dotenv.config();

// --- Initialize ---
const db = new Database();
const app = express();
const PORT = process.env.PORT || 3000;

// --- Check API Keys ---
if (!process.env.OPENROUTER_API_KEY) {
  console.error("❌ OPENROUTER_API_KEY is missing in .env!");
  process.exit(1);
}
if (!process.env.JWT_SECRET) {
  console.error("❌ JWT_SECRET is missing in .env!");
  process.exit(1);
}

// --- Middleware ---
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ✅ CORS (token based, no cookies needed)
app.use(
  cors({
    origin: true,
    credentials: false,
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  }),
);

// --- Rate Limiting ---
const chatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.user?.userId || req.ip,
  skip: (req) => req.method === "OPTIONS",
  message: { error: "Too many requests. Please wait a moment." },
  standardHeaders: true,
  legacyHeaders: false,
});

// --- Request logging ---
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

/* ============================================================
   AUTH (JWT) - single-file
   ============================================================ */

function normalizeUsername(u) {
  return String(u || "").trim().toLowerCase();
}

function makeUserId() {
  return (
    "u_" +
    Date.now().toString(36) +
    "_" +
    Math.random().toString(36).slice(2, 8)
  );
}

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "30d" });
}

function authKey(username) {
  return `auth_user_${username}`;
}

// Optional decode (for rate-limit key)
app.use((req, _res, next) => {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return next();
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
  } catch {}
  next();
});

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { userId, username, iat, exp }
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid/expired token" });
  }
}

// ✅ Register
app.post("/api/register", async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const password = String(req.body?.password || "");

  if (!username || !password)
    return res.status(400).json({ error: "Username and password are required" });

  if (username.length < 3 || username.length > 30)
    return res
      .status(400)
      .json({ error: "Username must be 3-30 characters" });

  if (password.length < 6)
    return res
      .status(400)
      .json({ error: "Password must be at least 6 characters" });

  const key = authKey(username);
  const existing = await db.get(key);
  if (existing) return res.status(409).json({ error: "Username already exists" });

  const userId = makeUserId();
  const passwordHash = await bcrypt.hash(password, 10);

  await db.set(key, { userId, username, passwordHash, createdAt: Date.now() });

  const token = signToken({ userId, username });
  return res.json({ token, user: { userId, username } });
});

// ✅ Login
app.post("/api/login", async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const password = String(req.body?.password || "");

  if (!username || !password)
    return res.status(400).json({ error: "Username and password are required" });

  const record = await db.get(authKey(username));
  if (!record?.passwordHash) return res.status(401).json({ error: "Invalid credentials" });

  const ok = await bcrypt.compare(password, record.passwordHash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  const token = signToken({ userId: record.userId, username });
  return res.json({ token, user: { userId: record.userId, username } });
});

// ✅ Current user
app.get("/api/me", requireAuth, (req, res) => {
  res.json({ userId: req.user.userId, username: req.user.username });
});

/* ============================================================
   Your existing code below (edited to use req.user.userId)
   ============================================================ */

/* ============================================================
   Memory Engine v3 - Safe extraction & storage
   ============================================================ */

const MEMORY_CATEGORIES = {
  personal: ["name", "age", "birthday", "city", "location", "country", "hometown"],
  relationships: ["girlfriend", "boyfriend", "wife", "husband", "partner", "friend", "best_friend"],
  preferences: ["favorite", "favourite", "fav", "like", "dislike", "hobby", "music", "movie", "food", "color", "colour"],
  work_education: ["job", "profession", "work", "company", "occupation", "school", "college", "university"],
  pets_family: ["pet", "dog", "cat", "brother", "sister", "mother", "father", "family"],
  possessions: ["car", "phone", "computer", "house"],
};

const BANNED_MEMORY_KEYS = new Set([
  "code","bot","chatbot","app","website","project","error","issue","problem","api","server","message","response","output","logs","stack",
]);

function unwrapDbData(data) {
  if (!data) return null;
  let result = data;
  while (result && typeof result === "object" && Object.prototype.hasOwnProperty.call(result, "value")) {
    result = result.value;
  }
  return result;
}

function detectCategory(key) {
  const k = key.toLowerCase();
  for (const [category, terms] of Object.entries(MEMORY_CATEGORIES)) {
    for (const t of terms) if (k.includes(t)) return category;
  }
  return null;
}

function isBadValue(value) {
  if (!value || typeof value !== "string") return true;
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  if (/(error|not working|failed|issue|problem|crash|stack trace|exception)/i.test(trimmed)) return true;
  if (trimmed.length > 120) return true;
  return false;
}

function sanitizeKey(rawKey) {
  return rawKey
    .toLowerCase()
    .replace(/[^a-z0-9\s_]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 40);
}

function extractMemory(userMessage) {
  const info = {};
  if (!userMessage || typeof userMessage !== "string") return null;
  const message = userMessage.trim();

  const pattern = /my\s+([a-zA-Z\s]{1,25})\s+(?:is|are)\s+([^.!?]{1,100})/gi;
  let match;
  while ((match = pattern.exec(message)) !== null) {
    const rawKey = match[1].trim();
    const rawValue = match[2].trim();

    const key = sanitizeKey(rawKey);
    const value = rawValue.trim();

    if (!key || BANNED_MEMORY_KEYS.has(key)) continue;
    if (isBadValue(value)) continue;

    const category = detectCategory(key);
    if (!category) continue;

    info[key] = { value, category };
  }

  return Object.keys(info).length > 0 ? info : null;
}

async function saveUserMemoryBatch(userId, memories) {
  if (!userId || !memories || Object.keys(memories).length === 0) return null;
  const memoryKey = `memory_${userId}`;

  try {
    const raw = await db.get(memoryKey);
    const existing = unwrapDbData(raw) || {};

    for (const cat of Object.keys(MEMORY_CATEGORIES)) {
      if (!existing[cat]) existing[cat] = {};
    }

    for (const [k, v] of Object.entries(memories)) {
      existing[v.category] = existing[v.category] || {};
      existing[v.category][k] = { value: v.value, savedAt: Date.now(), lastAccessed: Date.now() };
    }

    await db.set(memoryKey, existing);
    return existing;
  } catch (err) {
    console.error("❌ saveUserMemoryBatch error:", err);
    await db.set(memoryKey, memories);
    return memories;
  }
}

async function getUserMemory(userId) {
  try {
    const raw = await db.get(`memory_${userId}`);
    return unwrapDbData(raw) || {};
  } catch (err) {
    console.error("❌ getUserMemory error:", err);
    return {};
  }
}

/* ============================================================
   CHAT SESSIONS (History Sidebar)
   ============================================================ */

const MAX_SESSIONS = 50;
const MAX_HISTORY_LENGTH = 80;
const MAX_MESSAGE_LENGTH = 2000;

function sanitizeInput(text) {
  if (typeof text !== "string") return "";
  return text.slice(0, MAX_MESSAGE_LENGTH).trim();
}

function sessionsKey(userId) {
  return `sessions_${userId}`;
}
function sessionMessagesKey(userId, chatId) {
  return `chat_${userId}_${chatId}`;
}
function makeChatId() {
  return "c_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
}

async function listSessions(userId) {
  const raw = await db.get(sessionsKey(userId));
  const sessions = unwrapDbData(raw);
  return Array.isArray(sessions) ? sessions : [];
}

async function saveSessions(userId, sessions) {
  await db.set(sessionsKey(userId), sessions.slice(0, MAX_SESSIONS));
}

async function createSession(userId, title = "New chat") {
  const sessions = await listSessions(userId);
  const chatId = makeChatId();

  const session = { chatId, title, createdAt: Date.now(), updatedAt: Date.now() };
  sessions.unshift(session);

  await saveSessions(userId, sessions);
  await db.set(sessionMessagesKey(userId, chatId), []);
  return session;
}

async function ensureSession(userId, chatId) {
  if (!chatId || chatId === "default") return null;

  const sessions = await listSessions(userId);
  const existing = sessions.find((s) => s.chatId === chatId);
  if (existing) return existing;

  const session = { chatId, title: "New chat", createdAt: Date.now(), updatedAt: Date.now() };
  sessions.unshift(session);

  await saveSessions(userId, sessions);
  await db.set(sessionMessagesKey(userId, chatId), []);
  return session;
}

async function touchSession(userId, chatId, titleIfEmpty) {
  if (!chatId || chatId === "default") return null;

  const sessions = await listSessions(userId);
  const idx = sessions.findIndex((s) => s.chatId === chatId);
  if (idx === -1) return null;

  sessions[idx].updatedAt = Date.now();
  if (titleIfEmpty && (!sessions[idx].title || sessions[idx].title === "New chat")) {
    sessions[idx].title = titleIfEmpty;
  }

  const [s] = sessions.splice(idx, 1);
  sessions.unshift(s);

  await saveSessions(userId, sessions);
  return s;
}

async function deleteSession(userId, chatId) {
  const sessions = await listSessions(userId);
  const filtered = sessions.filter((s) => s.chatId !== chatId);
  await saveSessions(userId, filtered);
  await db.delete(sessionMessagesKey(userId, chatId));
}

async function saveMessage(userId, role, message, chatId = "default") {
  try {
    const sanitizedMessage = sanitizeInput(message);
    const key = chatId === "default" ? `chat_${userId}` : sessionMessagesKey(userId, chatId);

    const raw = await db.get(key);
    const history = Array.isArray(unwrapDbData(raw)) ? unwrapDbData(raw) : [];

    history.push({ role, message: sanitizedMessage, timestamp: Date.now() });
    if (history.length > MAX_HISTORY_LENGTH) history.splice(0, history.length - MAX_HISTORY_LENGTH);

    await db.set(key, history);
    return history;
  } catch (err) {
    console.error("❌ saveMessage error:", err);
    return null;
  }
}

async function getChatHistory(userId, chatId = "default") {
  try {
    const key = chatId === "default" ? `chat_${userId}` : sessionMessagesKey(userId, chatId);
    const raw = await db.get(key);
    const history = unwrapDbData(raw);
    return Array.isArray(history) ? history : [];
  } catch (err) {
    console.error("❌ getChatHistory error:", err);
    return [];
  }
}

/* ============================================================
   🔐 Session endpoints (NOW protected) - uses token userId
   ============================================================ */

// Create new session
app.post("/chat/new", requireAuth, async (req, res) => {
  const userId = req.user.userId;
  const { title } = req.body || {};
  const session = await createSession(userId, title || "New chat");
  res.json(session);
});

// List sessions
app.get("/chats", requireAuth, async (req, res) => {
  const userId = req.user.userId;
  const sessions = await listSessions(userId);
  res.json({ sessions });
});

// Get one session messages
app.get("/chat/:chatId", requireAuth, async (req, res) => {
  const userId = req.user.userId;
  const { chatId } = req.params;
  const messages = await getChatHistory(userId, chatId);
  res.json({ chatId, messages });
});

// Delete one session
app.delete("/chat/:chatId", requireAuth, async (req, res) => {
  const userId = req.user.userId;
  const { chatId } = req.params;
  await deleteSession(userId, chatId);
  res.json({ ok: true });
});

// Delete ALL sessions
app.delete("/chats", requireAuth, async (req, res) => {
  const userId = req.user.userId;
  try {
    const sessions = await listSessions(userId);
    for (const s of sessions) {
      try {
        await db.delete(sessionMessagesKey(userId, s.chatId));
      } catch {}
    }
    await db.set(sessionsKey(userId), []);
    res.json({ ok: true, deleted: sessions.length });
  } catch (err) {
    console.error("❌ delete all chats error:", err);
    res.status(500).json({ error: "Failed to delete all chats" });
  }
});

/* ============================================================
   Chat endpoint (protected) - userId from token
   ============================================================ */

app.post("/chat", requireAuth, chatLimiter, async (req, res) => {
  const userId = req.user.userId;
  const { message, chatId } = req.body || {};
  const activeChatId = chatId || "default";

  if (!message || typeof message !== "string" || message.trim().length === 0) {
    return res.status(400).json({ error: "Message cannot be empty" });
  }

  try {
    const sanitizedMessage = message.trim();

    await ensureSession(userId, activeChatId);
    const titleCandidate = sanitizedMessage.slice(0, 28);

    // Memory extraction
    const extracted = extractMemory(sanitizedMessage);
    if (extracted) {
      await saveUserMemoryBatch(userId, extracted);

      const keys = Object.keys(extracted);
      let reply;
      if (keys.length === 1) {
        const k = keys[0];
        reply = `Thanks — I'll remember that your ${k.replace(/_/g, " ")} is ${extracted[k].value}.`;
      } else {
        reply = "Thanks — I'll remember that:\n";
        for (const k of keys) reply += `• ${k.replace(/_/g, " ")}: ${extracted[k].value}\n`;
      }

      await saveMessage(userId, "user", sanitizedMessage, activeChatId);
      await saveMessage(userId, "assistant", reply, activeChatId);
      await touchSession(userId, activeChatId, titleCandidate);

      return res.json({ reply });
    }

    // Memory context
    const memory = await getUserMemory(userId);
    const memoryContext = (() => {
      const flat = [];
      const lower = sanitizedMessage.toLowerCase();
      for (const [category, items] of Object.entries(memory || {})) {
        if (!items || typeof items !== "object") continue;
        for (const [key, obj] of Object.entries(items)) {
          if (!obj || !obj.value) continue;
          const readableKey = key.replace(/_/g, " ");
          if (lower.includes(readableKey) || category === "personal" || category === "relationships") {
            flat.push(`${readableKey}: ${obj.value}`);
          }
        }
      }
      if (flat.length === 0) return "No saved personal facts yet.";
      return flat.slice(0, 12).join("\n");
    })();

    const systemPrompt = {
      role: "system",
      content: `You are Genie, a friendly assistant. Use the memory below to personalize replies when helpful.

Memory snippet:
${memoryContext}

Guidelines:
1. Be natural, conversational and helpful.
2. Use the memory above to personalize if appropriate.
3. Keep responses concise (under 500 tokens).
Current time: ${new Date().toLocaleString()}
      `,
    };

    const history = await getChatHistory(userId, activeChatId);
    const messagesForAI = [
      systemPrompt,
      ...history.slice(-8).map((h) => ({ role: h.role, content: h.message })),
      { role: "user", content: sanitizedMessage },
    ];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": process.env.SITE_URL || "https://yourdomain.com",
        "X-Title": "Genie Chatbot",
      },
      body: JSON.stringify({
        model: "openai/gpt-3.5-turbo-16k",
        messages: messagesForAI,
        max_tokens: 500,
        temperature: 0.7,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("OpenRouter error:", response.status, errorText);
      return res.status(response.status).json({
        error: "AI service error",
        status: response.status,
        details: errorText,
      });
    }

    const data = await response.json();
    const reply =
      data.choices?.[0]?.message?.content ??
      "Sorry, I couldn't generate a reply. Try rephrasing.";

    await saveMessage(userId, "user", sanitizedMessage, activeChatId);
    await saveMessage(userId, "assistant", reply, activeChatId);
    await touchSession(userId, activeChatId, titleCandidate);

    res.json({ reply, usage: data.usage ?? null });
  } catch (err) {
    console.error("❌ /chat error:", err);
    if (err.name === "AbortError") {
      return res.status(408).json({
        error: "Request timeout",
        reply: "I'm taking too long to respond. Please try again.",
      });
    }
    res.status(500).json({ error: "Internal server error", details: err.message });
  }
});

/* ============================================================
   Memory endpoints (protected)
   ============================================================ */

app.get("/memory", requireAuth, async (req, res) => {
  const userId = req.user.userId;

  try {
    const [memory, defaultChatHistory, sessions] = await Promise.all([
      getUserMemory(userId),
      getChatHistory(userId, "default"),
      listSessions(userId),
    ]);

    const categories = Object.keys(memory || {});
    const memoryItems = Object.values(memory || {}).reduce(
      (acc, cat) => acc + (cat ? Object.keys(cat).length : 0),
      0,
    );

    res.json({
      memory,
      chatHistory: defaultChatHistory.slice(-5),
      sessionsCount: sessions.length,
      stats: { chatCount: defaultChatHistory.length, memoryItems, categories },
    });
  } catch (err) {
    console.error("❌ /memory error:", err);
    res.status(500).json({ error: "Failed to fetch memory", details: err.message });
  }
});

app.delete("/memory", requireAuth, async (req, res) => {
  const userId = req.user.userId;

  try {
    const sessions = await listSessions(userId);

    await Promise.all([
      db.set(`memory_${userId}`, {}),
      db.set(`chat_${userId}`, []),
      db.set(sessionsKey(userId), []),
    ]);

    for (const s of sessions) {
      try {
        await db.delete(sessionMessagesKey(userId, s.chatId));
      } catch {}
    }

    res.json({ message: "User data cleared successfully" });
  } catch (err) {
    console.error("❌ delete memory error:", err);
    res.status(500).json({ error: "Failed to clear memory", details: err.message });
  }
});

/* ============================================================
   Health & start
   ============================================================ */

app.get("/", (req, res) => {
  res.json({
    status: "✅ Genie backend (memory v3 + sessions + auth) is live!",
    timestamp: new Date().toISOString(),
    version: "4.0.0",
  });
});

app.listen(PORT, () => {
  console.log(`
✅ Genie backend running with AUTH + SMART MEMORY ENGINE v3 + SESSIONS!
📍 Port: ${PORT}
🔐 OpenRouter: ${process.env.OPENROUTER_API_KEY ? "Loaded" : "Missing!"}
🔑 JWT_SECRET: ${process.env.JWT_SECRET ? "Loaded" : "Missing!"}
🛡️ Rate Limit: 10 requests/minute
  `);
});

// graceful shutdown
process.on("SIGINT", () => {
  console.log("\n🛑 Shutting down...");
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("\n🛑 Terminated");
  process.exit(0);
});
