// server.js
// Genie Backend - Memory Engine v3 + Chat Sessions + Authentication

import Database from "@replit/database";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createChatService } from "./services/chatService.js";
import { createHistoryService } from "./services/historyService.js";
import { createSarvamService } from "./services/sarvamService.js";

dotenv.config();

// --- Initialize ---
const db = new Database();
const app = express();
const PORT = process.env.PORT || 3000;

// --- Check API Key ---
if (!process.env.SARVAM_API_KEY) {
  console.error("❌ SARVAM_API_KEY is missing in .env!");
  process.exit(1);
}

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'genie-secret-key-change-in-production';

// --- Rate Limiting ---
const chatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10,
  keyGenerator: (req) => req.user?.id || req.body?.userId || "anonymous",
  skip: (req) => req.method === "OPTIONS",
  message: { error: "Too many requests. Please wait a moment." },
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { error: "Too many authentication attempts. Please try again later." },
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
    `${new Date().toISOString()} - ${req.method} ${req.path} - IP: ${req.ip}`
  );
  next();
});

/* ============================================================
   AUTHENTICATION MIDDLEWARE & FUNCTIONS
   ============================================================ */

// Auth middleware
const authMiddleware = async (req, res, next) => {
    try {
        const token = req.header('Authorization')?.replace('Bearer ', '');
        
        if (!token) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        
        const decoded = jwt.verify(token, JWT_SECRET);
        
        // Get user from database
        const userKey = `auth_user_${decoded.userId}`;
        const user = await db.get(userKey);
        
        if (!user) {
            return res.status(401).json({ error: 'User not found' });
        }
        
        req.user = user;
        req.userId = user.id;
        next();
    } catch (error) {
        console.error('Auth middleware error:', error.message);
        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({ error: 'Invalid token' });
        }
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expired' });
        }
        res.status(401).json({ error: 'Please authenticate' });
    }
};

// User functions
async function createUser(email, password, name) {
    const emailKey = `auth_email_${email.toLowerCase()}`;
    
    // Check if user exists
    const existing = await db.get(emailKey);
    if (existing) {
        throw new Error('User already exists');
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Create user ID
    const userId = `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // User data
    const userData = {
        id: userId,
        email: email.toLowerCase(),
        password: hashedPassword,
        name,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    
    // Store user data
    await db.set(emailKey, userId); // email -> userId mapping
    await db.set(`auth_user_${userId}`, userData); // userId -> user data
    
    return userData;
}

async function findUserByEmail(email) {
    const emailKey = `auth_email_${email.toLowerCase()}`;
    const userId = await db.get(emailKey);
    if (!userId) return null;
    
    return await db.get(`auth_user_${userId}`);
}

async function findUserById(userId) {
    return await db.get(`auth_user_${userId}`);
}

/* ============================================================
   AUTHENTICATION ENDPOINTS
   ============================================================ */

// Register endpoint
app.post('/api/auth/register', authLimiter, async (req, res) => {
    try {
        const { email, password, name } = req.body;
        
        // Validate input
        if (!email || !password || !name) {
            return res.status(400).json({ error: 'All fields are required' });
        }
        
        // Email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }
        
        // Password validation
        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }
        
        // Create user
        const user = await createUser(email, password, name);
        
        // Generate JWT token
        const token = jwt.sign(
            { userId: user.id, email: user.email },
            JWT_SECRET,
            { expiresIn: '7d' }
        );
        
        // Remove password from response
        const { password: _, ...userWithoutPassword } = user;
        
        res.status(201).json({
            success: true,
            token,
            user: userWithoutPassword,
            message: 'Registration successful'
        });
    } catch (error) {
        console.error('Registration error:', error.message);
        if (error.message === 'User already exists') {
            return res.status(400).json({ error: error.message });
        }
        res.status(500).json({ error: 'Registration failed' });
    }
});

// Login endpoint
app.post('/api/auth/login', authLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;
        
        // Validate input
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }
        
        // Find user
        const user = await findUserByEmail(email);
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        // Check password
        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        // Generate JWT token
        const token = jwt.sign(
            { userId: user.id, email: user.email },
            JWT_SECRET,
            { expiresIn: '7d' }
        );
        
        // Update last login
        user.updatedAt = new Date().toISOString();
        user.lastLogin = new Date().toISOString();
        await db.set(`auth_user_${user.id}`, user);
        
        // Remove password from response
        const { password: _, ...userWithoutPassword } = user;
        
        res.json({
            success: true,
            token,
            user: userWithoutPassword,
            message: 'Login successful'
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// Get current user
app.get('/api/auth/me', authMiddleware, async (req, res) => {
    try {
        const { password: _, ...userWithoutPassword } = req.user;
        res.json({
            success: true,
            user: userWithoutPassword
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch user data' });
    }
});

// Logout (client-side only)
app.post('/api/auth/logout', authMiddleware, async (req, res) => {
    res.json({ success: true, message: 'Logged out successfully' });
});

// Check if email exists (for registration)
app.post('/api/auth/check-email', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ error: 'Email required' });
        }
        
        const user = await findUserByEmail(email);
        res.json({ exists: !!user });
    } catch (error) {
        res.status(500).json({ error: 'Failed to check email' });
    }
});

/* ============================================================
   MEMORY ENGINE v3 - Safe extraction & storage
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

const modularHistoryService = createHistoryService({
  db,
  unwrapDbData,
  config: {
    maxSessions: MAX_SESSIONS,
    maxHistoryLength: MAX_HISTORY_LENGTH,
    maxMessageLength: MAX_MESSAGE_LENGTH,
  },
});

const sarvamService = createSarvamService({
  apiKey: process.env.SARVAM_API_KEY,
});

const chatService = createChatService({
  historyService: modularHistoryService,
  sarvamService,
  retrieveRelevantMemorySnippet,
});

/* ============================================================
   PROTECTED CHAT ENDPOINTS
   ============================================================ */

// Create new session (protected)
app.post("/chat/new", authMiddleware, async (req, res) => {
  const { title } = req.body;
  const userId = req.userId;

  const session = await createSession(userId, title || "New chat");
  res.json(session);
});

// List sessions (protected)
app.get("/chats/:userId", authMiddleware, async (req, res) => {
  const { userId } = req.params;
  
  // Verify user can only access their own data
  if (userId !== req.userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  const sessions = await listSessions(userId);
  res.json({ sessions });
});

// Get one session messages (protected)
app.get("/chat/:userId/:chatId", authMiddleware, async (req, res) => {
  const { userId, chatId } = req.params;
  
  // Verify user can only access their own data
  if (userId !== req.userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  const messages = await getChatHistory(userId, chatId);
  res.json({ chatId, messages });
});

// Delete one session (protected)
app.delete("/chat/:userId/:chatId", authMiddleware, async (req, res) => {
  const { userId, chatId } = req.params;
  
  // Verify user can only access their own data
  if (userId !== req.userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  await deleteSession(userId, chatId);
  res.json({ ok: true });
});

// Delete ALL chat sessions for a user (protected)
app.delete("/chats/:userId", authMiddleware, async (req, res) => {
  const { userId } = req.params;
  
  // Verify user can only access their own data
  if (userId !== req.userId) {
    return res.status(403).json({ error: "Access denied" });
  }

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
   Memory query handler
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
   Main chat endpoint (protected)
   ============================================================ */

app.post("/chat", authMiddleware, chatLimiter, async (req, res) => {
  const { message, chatId } = req.body;
  const userId = req.userId;
  const activeChatId = chatId || "default";

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
      sanitizedMessage.slice(0, 50),
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

    // 3) Normal chat path now uses LangChain prompt orchestration + Sarvam backend
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);

    const result = await chatService.handleChat({
      userId,
      message: sanitizedMessage,
      chatId: activeChatId,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    res.json(result);
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
   Memory endpoints (protected)
   ============================================================ */

app.get("/memory/:userId", authMiddleware, async (req, res) => {
  const { userId } = req.params;
  
  // Verify user can only access their own data
  if (userId !== req.userId) {
    return res.status(403).json({ error: "Access denied" });
  }

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

app.delete("/memory/:userId", authMiddleware, async (req, res) => {
  const { userId } = req.params;
  
  // Verify user can only access their own data
  if (userId !== req.userId) {
    return res.status(403).json({ error: "Access denied" });
  }

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
   Public stats endpoint
   ============================================================ */

app.get("/stats", async (req, res) => {
  try {
    const allKeys = await db.list();
    const userKeys = allKeys.filter((k) => k.startsWith("auth_user_"));
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
    status: "✅ Genie backend (with authentication) is live!",
    timestamp: new Date().toISOString(),
    version: "4.0.0",
    features: ["Authentication", "Memory Engine v3", "Chat Sessions"],
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.listen(PORT, () => {
  console.log(`
✅ Genie backend with AUTHENTICATION running!
📍 Port: ${PORT}
🔐 SARVAM_API_KEY: ${process.env.SARVAM_API_KEY ? "Loaded" : "Missing!"}
🔑 JWT Secret: ${JWT_SECRET ? "Loaded" : "Using default"}
💾 Memory: Enabled (Safe & categorized)
🧾 Sessions: Enabled (history sidebar ready)
👤 Auth: Enabled (Register/Login/JWT)
🛡️ Rate Limit: 10 requests/minute for chat
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
