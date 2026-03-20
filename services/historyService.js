import { createClient } from "@supabase/supabase-js";

function sanitizeInput(text, maxMessageLength) {
  if (typeof text !== "string") return "";
  return text.slice(0, maxMessageLength).trim();
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "").trim(),
  );
}

function mapSession(row) {
  if (!row) return null;
  return {
    chatId: row.id,
    title: row.title || "New chat",
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : Date.now(),
  };
}

function mapMessage(row) {
  if (!row) return null;
  return {
    role: row.role,
    message: row.message,
    timestamp: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
  };
}

export function createHistoryService({ config, supabaseUrl, supabaseAnonKey }) {
  const {
    maxSessions,
    maxHistoryLength,
    maxMessageLength,
    autoCleanThreshold = maxHistoryLength,
    cleanKeepRecent = Math.max(10, Math.floor(maxHistoryLength / 3)),
  } = config;

  function getAuthedClient(authToken) {
    const token = String(authToken || "").trim();
    if (!token) {
      throw new Error("Missing auth token for history service");
    }

    return createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    });
  }

  function logDbError(context, error, meta = {}) {
    if (!error) return;
    console.error(`[historyService] ${context} failed`, {
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code,
      ...meta,
    });
  }

  async function listSessions(userId, authToken) {
    const client = getAuthedClient(authToken);
    const { data, error } = await client
      .from("chat_sessions")
      .select("id, title, created_at, updated_at")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(maxSessions);

    if (error) throw error;
    return Array.isArray(data) ? data.map(mapSession).filter(Boolean) : [];
  }

  async function createSession(userId, title = "New chat", authToken, chatId = null) {
    const client = getAuthedClient(authToken);
    const payload = {
      user_id: userId,
      title: String(title || "New chat").trim().slice(0, 120) || "New chat",
    };

    if (chatId && isUuid(chatId)) payload.id = chatId;

    const { data, error } = await client
      .from("chat_sessions")
      .insert(payload)
      .select("id, title, created_at, updated_at")
      .single();

    if (error) throw error;
    return mapSession(data);
  }

  async function ensureSession(userId, chatId, authToken) {
    if (!chatId || chatId === "default") return null;
    if (!isUuid(chatId)) {
      throw new Error(`Invalid chatId for SQL session store: ${chatId}`);
    }

    const client = getAuthedClient(authToken);
    const { data, error } = await client
      .from("chat_sessions")
      .select("id, title, created_at, updated_at")
      .eq("id", chatId)
      .eq("user_id", userId)
      .maybeSingle();

    if (error) throw error;
    if (data) return mapSession(data);
    return createSession(userId, "New chat", authToken, chatId);
  }

  async function touchSession(userId, chatId, titleIfEmpty, authToken) {
    if (!chatId || chatId === "default") return null;

    const client = getAuthedClient(authToken);
    let session = await ensureSession(userId, chatId, authToken);
    if (!session) return null;

    const nextTitle = String(titleIfEmpty || "").trim();
    const updates = {};
    if (nextTitle && (!session.title || session.title === "New chat")) {
      updates.title = nextTitle.slice(0, 120);
    }
    updates.updated_at = new Date().toISOString();

    const { data, error } = await client
      .from("chat_sessions")
      .update(updates)
      .eq("id", chatId)
      .eq("user_id", userId)
      .select("id, title, created_at, updated_at")
      .single();

    if (error) throw error;
    session = mapSession(data);
    return session;
  }

  async function deleteSession(userId, chatId, authToken) {
    if (!chatId || chatId === "default") return;

    const client = getAuthedClient(authToken);
    const { error } = await client
      .from("chat_sessions")
      .delete()
      .eq("id", chatId)
      .eq("user_id", userId);

    if (error) throw error;
  }

  async function deleteAllSessions(userId, authToken) {
    const client = getAuthedClient(authToken);
    const { data, error } = await client
      .from("chat_sessions")
      .delete()
      .eq("user_id", userId)
      .select("id");

    if (error) throw error;
    return Array.isArray(data) ? data.length : 0;
  }

  async function saveMessage(userId, role, message, chatId = "default", authToken) {
    const sanitizedMessage = sanitizeInput(message, maxMessageLength);
    if (!sanitizedMessage || !chatId || chatId === "default") return [];

    await ensureSession(userId, chatId, authToken);
    const client = getAuthedClient(authToken);
    const { data, error } = await client
      .from("chat_messages")
      .insert({
        session_id: chatId,
        user_id: userId,
        role,
        message: sanitizedMessage,
      })
      .select("id, role, message, created_at")
      .single();

    if (error) {
      logDbError("saveMessage.insert", error, {
        userId,
        chatId,
        role,
      });
      throw error;
    }

    const history = await getChatHistory(userId, chatId, authToken);
    if (history.length > maxHistoryLength) {
      const rowsToDelete = history.slice(0, history.length - maxHistoryLength);
      const ids = rowsToDelete.map((item) => item.id).filter(Boolean);
      if (ids.length) {
        const { error: deleteError } = await client
          .from("chat_messages")
          .delete()
          .in("id", ids)
          .eq("user_id", userId)
          .eq("session_id", chatId);
        if (deleteError) {
          logDbError("saveMessage.trimHistory", deleteError, {
            userId,
            chatId,
            deleteCount: ids.length,
          });
          throw deleteError;
        }
      }
    }

    return [
      ...history.filter((item) => item.id !== data.id),
      {
        ...mapMessage(data),
        id: data.id,
      },
    ];
  }

  async function getChatHistory(userId, chatId = "default", authToken) {
    try {
      if (!chatId || chatId === "default") return [];

      const client = getAuthedClient(authToken);
      const { data, error } = await client
        .from("chat_messages")
        .select("id, role, message, created_at")
        .eq("user_id", userId)
        .eq("session_id", chatId)
        .order("created_at", { ascending: true });

      if (error) throw error;
      return Array.isArray(data)
        ? data.map((row) => ({
            ...mapMessage(row),
            id: row.id,
          }))
        : [];
    } catch (err) {
      console.error("getChatHistory error:", err);
      return [];
    }
  }

  async function forceCleanChat(userId, chatId = "default", authToken) {
    const client = getAuthedClient(authToken);
    const history = await getChatHistory(userId, chatId, authToken);

    const deduped = [];
    for (const item of history) {
      const last = deduped[deduped.length - 1];
      if (last && last.role === item.role && last.message === item.message) {
        continue;
      }
      deduped.push(item);
    }

    const cleaned =
      deduped.length > autoCleanThreshold
        ? deduped.slice(-cleanKeepRecent)
        : deduped;

    const keepIds = new Set(cleaned.map((item) => item.id).filter(Boolean));
    const deleteIds = history
      .filter((item) => item.id && !keepIds.has(item.id))
      .map((item) => item.id);

    if (deleteIds.length) {
      const { error } = await client
        .from("chat_messages")
        .delete()
        .in("id", deleteIds)
        .eq("user_id", userId)
        .eq("session_id", chatId);
      if (error) throw error;
    }

    return cleaned.map(({ id, ...item }) => item);
  }

  async function rollbackLastAssistantReply(userId, chatId, userMessage, authToken) {
    const trimmed = String(userMessage || "").trim();
    if (!chatId || chatId === "default" || !trimmed) {
      return { ok: true, removed: false };
    }

    const history = await getChatHistory(userId, chatId, authToken);
    if (history.length < 2) return { ok: true, removed: false };

    const last = history[history.length - 1];
    const prev = history[history.length - 2];
    if (
      last?.role === "assistant" &&
      prev?.role === "user" &&
      String(prev?.message || "").trim() === trimmed &&
      last?.id
    ) {
      const client = getAuthedClient(authToken);
      const { error } = await client
        .from("chat_messages")
        .delete()
        .eq("id", last.id)
        .eq("user_id", userId)
        .eq("session_id", chatId);

      if (error) throw error;
      return { ok: true, removed: true };
    }

    return { ok: true, removed: false };
  }

  async function updateSessionTitle(userId, chatId, title, authToken) {
    const client = getAuthedClient(authToken);
    const sanitized = String(title || "").trim().slice(0, 60);
    if (!sanitized) {
      throw new Error("Invalid title");
    }

    const { data, error } = await client
      .from("chat_sessions")
      .update({
        title: sanitized,
        updated_at: new Date().toISOString(),
      })
      .eq("id", chatId)
      .eq("user_id", userId)
      .select("id, title, created_at, updated_at")
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;
    return mapSession(data);
  }

  async function getChatStats(userId, chatId, authToken) {
    const history = await getChatHistory(userId, chatId, authToken);
    let duplicateCount = 0;
    for (let i = 1; i < history.length; i += 1) {
      if (
        history[i].role === history[i - 1].role &&
        history[i].message === history[i - 1].message
      ) {
        duplicateCount += 1;
      }
    }

    return {
      totalMessages: history.length,
      duplicateCount,
      needsCleaning: history.length > autoCleanThreshold || duplicateCount > 0,
      autoCleanThreshold,
      maxLimit: maxHistoryLength,
    };
  }

  return {
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
  };
}
