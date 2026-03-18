function createSessionsKey(userId) {
  return `sessions_${userId}`;
}

function createSessionMessagesKey(userId, chatId) {
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

function sanitizeInput(text, maxMessageLength) {
  if (typeof text !== "string") return "";
  return text.slice(0, maxMessageLength).trim();
}

export function createHistoryService({ db, unwrapDbData, config }) {
  const {
    maxSessions,
    maxHistoryLength,
    maxMessageLength,
    autoCleanThreshold = maxHistoryLength,
    cleanKeepRecent = Math.max(10, Math.floor(maxHistoryLength / 3)),
  } = config;
  const unwrap = typeof unwrapDbData === "function" ? unwrapDbData : (value) => value;

  async function listSessions(userId) {
    const raw = await db.get(createSessionsKey(userId));
    const sessions = unwrap(raw);
    return Array.isArray(sessions) ? sessions : [];
  }

  async function saveSessions(userId, sessions) {
    await db.set(createSessionsKey(userId), sessions.slice(0, maxSessions));
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
    await db.set(createSessionMessagesKey(userId, chatId), []);

    return session;
  }

  async function ensureSession(userId, chatId) {
    if (!chatId || chatId === "default") return null;

    const sessions = await listSessions(userId);
    const existing = sessions.find((session) => session.chatId === chatId);
    if (existing) return existing;

    const session = {
      chatId,
      title: "New chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    sessions.unshift(session);
    await saveSessions(userId, sessions);
    await db.set(createSessionMessagesKey(userId, chatId), []);
    return session;
  }

  async function touchSession(userId, chatId, titleIfEmpty) {
    if (!chatId || chatId === "default") return null;
    const sessions = await listSessions(userId);
    const index = sessions.findIndex((session) => session.chatId === chatId);
    if (index === -1) return null;

    sessions[index].updatedAt = Date.now();
    if (
      titleIfEmpty &&
      (!sessions[index].title || sessions[index].title === "New chat")
    ) {
      sessions[index].title = titleIfEmpty;
    }

    const [session] = sessions.splice(index, 1);
    sessions.unshift(session);

    await saveSessions(userId, sessions);
    return session;
  }

  async function deleteSession(userId, chatId) {
    const sessions = await listSessions(userId);
    const filtered = sessions.filter((session) => session.chatId !== chatId);
    await saveSessions(userId, filtered);
    await db.delete(createSessionMessagesKey(userId, chatId));
  }

  async function saveMessage(userId, role, message, chatId = "default") {
    try {
      const sanitizedMessage = sanitizeInput(message, maxMessageLength);
      const key =
        chatId === "default"
          ? `chat_${userId}`
          : createSessionMessagesKey(userId, chatId);

      const raw = await db.get(key);
      const unwrapped = unwrap(raw);
      const history = Array.isArray(unwrapped) ? unwrapped : [];
      history.push({ role, message: sanitizedMessage, timestamp: Date.now() });

      if (history.length > maxHistoryLength) {
        history.splice(0, history.length - maxHistoryLength);
      }

      await db.set(key, history);
      return history;
    } catch (err) {
      console.error("saveMessage error:", err);
      return null;
    }
  }

  async function getChatHistory(userId, chatId = "default") {
    try {
      const key =
        chatId === "default"
          ? `chat_${userId}`
          : createSessionMessagesKey(userId, chatId);
      const raw = await db.get(key);
      const history = unwrap(raw);
      return Array.isArray(history) ? history : [];
    } catch (err) {
      console.error("getChatHistory error:", err);
      return [];
    }
  }

  async function forceCleanChat(userId, chatId = "default") {
    const key =
      chatId === "default"
        ? `chat_${userId}`
        : createSessionMessagesKey(userId, chatId);
    const history = await getChatHistory(userId, chatId);

    const deduped = [];
    for (const item of history) {
      const last = deduped[deduped.length - 1];
      if (
        last &&
        last.role === item.role &&
        last.message === item.message
      ) {
        continue;
      }
      deduped.push(item);
    }

    const cleaned =
      deduped.length > autoCleanThreshold
        ? deduped.slice(-cleanKeepRecent)
        : deduped;

    await db.set(key, cleaned);
    return cleaned;
  }

  return {
    createSession,
    deleteSession,
    ensureSession,
    forceCleanChat,
    getChatHistory,
    listSessions,
    saveMessage,
    saveSessions,
    sessionMessagesKey: createSessionMessagesKey,
    sessionsKey: createSessionsKey,
    touchSession,
    unwrapDbData: unwrap,
  };
}
