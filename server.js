// server.js
// Genie Backend - Memory Engine v3 + Chat Sessions (History Sidebar Ready)
import { createClient } from "@supabase/supabase-js";

const supaPublic = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const supaAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
async function requireAuth(req,res,next){
  const header = req.headers.authorization || "";
  const token = header.replace("Bearer ","");

  const { data } = await supaPublic.auth.getUser(token);
  if(!data?.user) return res.status(401).json({error:"login required"});

  req.user = data.user;
  next();
}

import Database from "@replit/database";
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";

dotenv.config();

// --- Initialize ---
const db = new Database();
const app = express();
const PORT = process.env.PORT || 3000;

// --- Check API Key ---
if (!process.env.OPENROUTER_API_KEY) {
  console.error("❌ OPENROUTER_API_KEY is missing in .env!");
  process.exit(1);
}

// --- Rate Limiting ---
const chatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10,
  keyGenerator: (req) => req.body?.userId || "anonymous",
  skip: (req) => req.method === "OPTIONS",
  message: { error: "Too many requests. Please wait a moment." },
  standardHeaders: true,
  legacyHeaders: false,
});

// --- Middleware ---
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// --- Manual CORS for safety (keeps preflight) ---
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With",
  );
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

// --- Request logging ---
app.use((req, res, next) => {
  console.log(
    `${new Date().toISOString()} - ${req.method} ${req.path} - User: ${
      req.body?.userId || req.params?.userId || "unknown"
    }`,
  );
  next();
});

/* ============================================================
   Memory Engine v3 - Safe extraction & storage
   ============================================================ */

const MEMORY_CATEGORIES = {
  personal: [
    "name",
    "age",
    "birthday",
    "city",
    "location",
    "country",
    "hometown",
  ],
  relationships: [
    "girlfriend",
    "boyfriend",
    "wife",
    "husband",
    "partner",
    "friend",
    "best_friend",
  ],
  preferences: [
    "favorite",
    "favourite",
    "fav",
    "like",
    "dislike",
    "hobby",
    "music",
    "movie",
    "food",
    "color",
    "colour",
  ],
  work_education: [
    "job",
    "profession",
    "work",
    "company",
    "occupation",
    "school",
    "college",
    "university",
  ],
  pets_family: [
    "pet",
    "dog",
    "cat",
    "brother",
    "sister",
    "mother",
    "father",
    "family",
  ],
  possessions: ["car", "phone", "computer", "house"],
};

const BANNED_MEMORY_KEYS = new Set([
  "code",
  "bot",
  "chatbot",
  "app",
  "website",
  "project",
  "error",
  "issue",
  "problem",
  "api",
  "server",
  "message",
  "response",
  "output",
  "logs",
  "stack",
]);

function unwrapDbData(data) {
  if (!data) return null;
  let result = data;
  while (
    result &&
    typeof result === "object" &&
    Object.prototype.hasOwnProperty.call(result, "value")
  ) {
    result = result.value;
  }
  return result;
}

function detectCategory(key) {
  const k = key.toLowerCase();
  for (const [category, terms] of Object.entries(MEMORY_CATEGORIES)) {
    for (const t of terms) {
      if (k.includes(t)) return category;
    }
  }
  return null;
}

function isBadValue(value) {
  if (!value || typeof value !== "string") return true;
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  if (
    /(error|not working|failed|issue|problem|crash|stack trace|exception)/i.test(
      trimmed,
    )
  )
    return true;
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

  const havePattern =
    /i have (?:a|an)?\s*([a-zA-Z\s]{1,20})\s+(?:named|called|is)\s+([a-zA-Z0-9\s]{1,60})/gi;
  let hm;
  while ((hm = havePattern.exec(message)) !== null) {
    const rawItem = sanitizeKey(hm[1]);
    const rawName = hm[2].trim();

    if (!rawItem || BANNED_MEMORY_KEYS.has(rawItem)) continue;
    if (isBadValue(rawName)) continue;

    let key = rawItem;
    let category = detectCategory(key);
    if (!category) {
      if (/(dog|cat|pet)/i.test(rawItem)) {
        category = "pets_family";
        key = "pet";
      } else {
        category = "personal";
      }
    }

    info[key] = { value: rawName, category };
  }

  const jobPattern = /(?:i am|i'm)\s+(?:a|an)?\s*([a-zA-Z\s]{2,40})(?:\.|$)/i;
  const jobMatch = message.match(jobPattern);
  if (jobMatch && jobMatch[1]) {
    const candidate = jobMatch[1].trim();
    if (!isBadValue(candidate)) {
      if (
        /(engineer|developer|teacher|student|designer|manager|doctor|nurse|lawyer|professor|consultant)/i.test(
          candidate,
        )
      ) {
        info["job"] = { value: candidate, category: "work_education" };
      } else if (
        /^[A-Z][a-z]+(\s[A-Z][a-z]+)?$/.test(candidate) ||
        candidate.split(" ").length <= 2
      ) {
        info["name"] = { value: candidate, category: "personal" };
      }
    }
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
      existing[v.category][k] = {
        value: v.value,
        savedAt: Date.now(),
        lastAccessed: Date.now(),
      };
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
    const memory = unwrapDbData(raw) || {};
    return memory;
  } catch (err) {
    console.error("❌ getUserMemory error:", err);
    return {};
  }
}

async function updateLastAccessed(userId, category, key) {
  try {
    const memoryKey = `memory_${userId}`;
    const raw = await db.get(memoryKey);
    const memory = unwrapDbData(raw) || {};
    if (memory[category] && memory[category][key]) {
      memory[category][key].lastAccessed = Date.now();
      await db.set(memoryKey, memory);
    }
  } catch (err) {
    console.error("❌ updateLastAccessed error:", err);
  }
}

async function retrieveRelevantMemorySnippet(userId, message) {
  const memory = await getUserMemory(userId);
  const flat = [];

  const lower = (message || "").toLowerCase();
  for (const [category, items] of Object.entries(memory || {})) {
    if (!items || typeof items !== "object") continue;
    for (const [key, obj] of Object.entries(items)) {
      if (!obj || !obj.value) continue;
      const readableKey = key.replace(/_/g, " ");
      if (
        lower.includes(readableKey) ||
        category === "personal" ||
        category === "relationships"
      ) {
        flat.push(`${readableKey}: ${obj.value}`);
      }
    }
  }
  if (flat.length === 0) return "No saved personal facts yet.";
  return flat.slice(0, 12).join("\n");
}

/* ============================================================
   CHAT SESSIONS (History Sidebar)
   ============================================================ */

const MAX_SESSIONS = 50;
const MAX_HISTORY_LENGTH = 80; // per chat session
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
  return (
    "c_" +
    Date.now().toString(36) +
    "_" +
    Math.random().toString(36).slice(2, 7)
  );
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

  const session = {
    chatId,
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  sessions.unshift(session);
  await saveSessions(userId, sessions);
  await db.set(sessionMessagesKey(userId, chatId), []);

  return session;
}

// If chatId comes from client, ensure it exists; if not, create it with that id.
async function ensureSession(userId, chatId) {
  if (!chatId || chatId === "default") return null;

  const sessions = await listSessions(userId);
  const existing = sessions.find((s) => s.chatId === chatId);
  if (existing) return existing;

  const session = {
    chatId,
    title: "New chat",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
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
  if (
    titleIfEmpty &&
    (!sessions[idx].title || sessions[idx].title === "New chat")
  ) {
    sessions[idx].title = titleIfEmpty;
  }

  // move to top
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
    const key =
      chatId === "default"
        ? `chat_${userId}`
        : sessionMessagesKey(userId, chatId);

    const raw = await db.get(key);
    const history = Array.isArray(unwrapDbData(raw)) ? unwrapDbData(raw) : [];

    history.push({ role, message: sanitizedMessage, timestamp: Date.now() });

    if (history.length > MAX_HISTORY_LENGTH) {
      history.splice(0, history.length - MAX_HISTORY_LENGTH);
    }

    await db.set(key, history);
    return history;
  } catch (err) {
    console.error("❌ saveMessage error:", err);
    return null;
  }
}

async function getChatHistory(userId, chatId = "default") {
  try {
    const key =
      chatId === "default"
        ? `chat_${userId}`
        : sessionMessagesKey(userId, chatId);
    const raw = await db.get(key);
    const history = unwrapDbData(raw);
    return Array.isArray(history) ? history : [];
  } catch (err) {
    console.error("❌ getChatHistory error:", err);
    return [];
  }
}

/* ============================================================
   Session endpoints for sidebar
   ============================================================ */

// Create new session
app.post("/chat/new", async (req, res) => {
  const { userId, title } = req.body;
  if (!userId || typeof userId !== "string" || userId.length > 200) {
    return res.status(400).json({ error: "Invalid userId" });
  }

  const session = await createSession(userId, title || "New chat");
  res.json(session);
});

// List sessions
app.get("/chats/:userId", async (req, res) => {
  const { userId } = req.params;
  if (!userId || userId.length > 200)
    return res.status(400).json({ error: "Invalid userId" });

  const sessions = await listSessions(userId);
  res.json({ sessions });
});

// Get one session messages
app.get("/chat/:userId/:chatId", async (req, res) => {
  const { userId, chatId } = req.params;
  if (!userId || userId.length > 200)
    return res.status(400).json({ error: "Invalid userId" });

  const messages = await getChatHistory(userId, chatId);
  res.json({ chatId, messages });
});

// Delete one session
app.delete("/chat/:userId/:chatId", async (req, res) => {
  const { userId, chatId } = req.params;
  if (!userId || userId.length > 200)
    return res.status(400).json({ error: "Invalid userId" });

  await deleteSession(userId, chatId);
  res.json({ ok: true });
});
// Delete ALL chat sessions for a user
app.delete("/chats/:userId", async (req, res) => {
  const { userId } = req.params;
  if (!userId || userId.length > 200)
    return res.status(400).json({ error: "Invalid userId" });

  try {
    const sessions = await listSessions(userId);

    // delete all session message keys
    for (const s of sessions) {
      try {
        await db.delete(sessionMessagesKey(userId, s.chatId));
      } catch {}
    }

    // clear sessions list
    await db.set(sessionsKey(userId), []);

    res.json({ ok: true, deleted: sessions.length });
  } catch (err) {
    console.error("❌ delete all chats error:", err);
    res.status(500).json({ error: "Failed to delete all chats" });
  }
});

/* ============================================================
   Memory query handler (same as your original)
   ============================================================ */

function handleMemoryQuery(message, memory, userId) {
  if (!message || !memory) return null;
  const lower = message.toLowerCase();

  const queries = [
    {
      regex:
        /(what do you know about me|what information do you have|what do you remember about me|tell me everything you know)/i,
      handler: comprehensiveMemory,
    },
    {
      regex: /(what is my|what's my|tell me my) (job|profession|work)/i,
      handler: () => findInMemory("job", memory, userId),
    },
    {
      regex: /(how old am i|what is my age)/i,
      handler: () => findInMemory("age", memory, userId),
    },
    {
      regex: /(what is my|what's my) favorite (color|colour)/i,
      handler: () => findInMemory("favorite_color", memory, userId),
    },
    {
      regex: /(where do i live|where am i from|my city)/i,
      handler: () => findInMemory("location", memory, userId),
    },
    {
      regex: /(who is my best friend|tell me about my best friend)/i,
      handler: () => findInMemory("best_friend", memory, userId),
    },
    {
      regex: /(what is my|what's my|tell me about my) (pet|dog|cat)/i,
      handler: () => findInMemory("pet", memory, userId),
    },
  ];

  for (const q of queries) {
    const match = message.match(q.regex);
    if (match) return q.handler(match);
  }

  const words = lower.split(/\s+/).filter((w) => w.length > 3);
  for (const w of words) {
    for (const [category, items] of Object.entries(memory || {})) {
      if (!items || typeof items !== "object") continue;
      for (const [k, v] of Object.entries(items)) {
        if (!v || !v.value) continue;
        const keyStr = k.replace(/_/g, " ");
        if (keyStr.includes(w) || v.value.toLowerCase().includes(w)) {
          updateLastAccessed(userId, category, k);
          return `You told me your ${keyStr} is ${v.value}.`;
        }
      }
    }
  }

  return null;

  function findInMemory(keyName, memoryObj, userIdLocal) {
    for (const [category, items] of Object.entries(memoryObj || {})) {
      if (!items || typeof items !== "object") continue;
      if (items[keyName] && items[keyName].value) {
        updateLastAccessed(userIdLocal, category, keyName);
        return keyName === "job"
          ? `You work as a ${items[keyName].value}.`
          : `Your ${keyName.replace(/_/g, " ")} is ${items[keyName].value}.`;
      }
    }
    for (const [category, items] of Object.entries(memoryObj || {})) {
      if (!items || typeof items !== "object") continue;
      for (const [k, v] of Object.entries(items)) {
        if (k.includes(keyName) && v && v.value) {
          updateLastAccessed(userIdLocal, category, k);
          return `Your ${k.replace(/_/g, " ")} is ${v.value}.`;
        }
      }
    }
    return `I don't know your ${keyName.replace(/_/g, " ")} yet.`;
  }

  function comprehensiveMemory() {
    let total = 0;
    let response = "Here's what I know about you:\n\n";
    for (const [category, items] of Object.entries(memory || {})) {
      if (!items || typeof items !== "object") continue;
      let chunk = "";
      for (const [k, v] of Object.entries(items)) {
        if (
          v &&
          v.value &&
          typeof v.value === "string" &&
          v.value.trim().length > 0
        ) {
          chunk += `  • ${k.replace(/_/g, " ")}: ${v.value}\n`;
          total++;
        }
      }
      if (chunk.length > 0) {
        response += `**${category.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}:**\n`;
        response += chunk + "\n";
      }
    }
    if (total === 0)
      return "I don't have any information about you yet. Tell me something about yourself!";
    return response;
  }
}

/* ============================================================
   Chat endpoint (uses memory engine + sessions)
   ============================================================ */

app.post("/chat", chatLimiter, async (req, res) => {
  const { userId, message, chatId } = req.body;
  const activeChatId = chatId || "default";

  if (!userId || typeof userId !== "string" || userId.length > 200) {
    return res.status(400).json({ error: "Invalid userId" });
  }
  if (!message || typeof message !== "string" || message.trim().length === 0) {
    return res.status(400).json({ error: "Message cannot be empty" });
  }

  try {
    const sanitizedMessage = message.trim();
    console.log(
      "🔍 New message from",
      userId,
      "chatId:",
      activeChatId,
      ":",
      sanitizedMessage,
    );

    // Ensure session exists if chatId is provided
    await ensureSession(userId, activeChatId);

    // If first user message, use it as title (touch later)
    const titleCandidate = sanitizedMessage.slice(0, 28);

    // 1) Memory extraction
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
        for (const k of keys)
          reply += `• ${k.replace(/_/g, " ")}: ${extracted[k].value}\n`;
      }

      await saveMessage(userId, "user", sanitizedMessage, activeChatId);
      await saveMessage(userId, "assistant", reply, activeChatId);
      await touchSession(userId, activeChatId, titleCandidate);

      return res.json({ reply });
    }

    // 2) Memory query
    const memory = await getUserMemory(userId);
    const memoryQueryReply = handleMemoryQuery(
      sanitizedMessage,
      memory,
      userId,
    );
    if (memoryQueryReply) {
      await saveMessage(userId, "user", sanitizedMessage, activeChatId);
      await saveMessage(userId, "assistant", memoryQueryReply, activeChatId);
      await touchSession(userId, activeChatId, titleCandidate);

      return res.json({ reply: memoryQueryReply });
    }

    // 3) Use relevant memory snippet + history per chatId
    const memoryContext = await retrieveRelevantMemorySnippet(
      userId,
      sanitizedMessage,
    );

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

    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
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
      },
    );

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
    res
      .status(500)
      .json({ error: "Internal server error", details: err.message });
  }
});

/* ============================================================
   Memory endpoints
   ============================================================ */

app.get("/memory/:userId", async (req, res) => {
  const { userId } = req.params;
  if (!userId || userId.length > 200)
    return res.status(400).json({ error: "Invalid userId" });

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
    res
      .status(500)
      .json({ error: "Failed to fetch memory", details: err.message });
  }
});

app.delete("/memory/:userId", async (req, res) => {
  const { userId } = req.params;
  if (!userId || userId.length > 200)
    return res.status(400).json({ error: "Invalid userId" });

  try {
    await Promise.all([
      db.set(`memory_${userId}`, {}),
      db.set(`chat_${userId}`, []), // default
      db.set(sessionsKey(userId), []), // sessions list
    ]);

    // Also delete each session messages key (best effort)
    const sessions = await listSessions(userId);
    for (const s of sessions) {
      try {
        await db.delete(sessionMessagesKey(userId, s.chatId));
      } catch {}
    }

    res.json({ message: "User data cleared successfully" });
  } catch (err) {
    console.error("❌ delete memory error:", err);
    res
      .status(500)
      .json({ error: "Failed to clear memory", details: err.message });
  }
});

/* ============================================================
   /stats endpoint
   ============================================================ */

app.get("/stats", async (req, res) => {
  try {
    const allKeys = await db.list();
    const userKeys = allKeys.filter((k) => k.startsWith("memory_"));
    res.json({
      totalUsers: userKeys.length,
      serverUptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("❌ /stats error:", err);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

/* ============================================================
   Health & start
   ============================================================ */

app.get("/", (req, res) => {
  res.json({
    status: "✅ Genie backend (memory v3 + sessions) is live!",
    timestamp: new Date().toISOString(),
    version: "3.1.0",
  });
});

app.listen(PORT, () => {
  console.log(`
✅ Genie backend running with SMART MEMORY ENGINE v3 + SESSIONS!
📍 Port: ${PORT}
🔐 API Key: ${process.env.OPENROUTER_API_KEY ? "Loaded" : "Missing!"}
💾 Memory: Enabled (Safe & categorized)
🧾 Sessions: Enabled (history sidebar ready)
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
