function sanitizeInput(text, maxMessageLength) {
  if (typeof text !== "string") return "";
  return text.slice(0, maxMessageLength).trim();
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || ""),
  );
}

export function createHistoryService({ supabase, config }) {
  if (!supabase) {
    throw new Error("createHistoryService requires a Supabase client");
  }

  const {
    maxSessions,
    maxHistoryLength,
    maxMessageLength,
    autoCleanThreshold = maxHistoryLength,
    cleanKeepRecent = Math.max(10, Math.floor(maxHistoryLength / 3)),
  } = config;

  async function fetchSessionById(userId, chatId) {
    if (!userId || !isUuid(chatId)) return null;
    const { data, error } = await supabase
      .from("chat_sessions")
      .select("id, title, created_at, updated_at")
      .eq("user_id", userId)
      .eq("id", chatId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    return {
      chatId: data.id,
      title: data.title || "New chat",
      createdAt: data.created_at ? new Date(data.created_at).getTime() : Date.now(),
      updatedAt: data.updated_at ? new Date(data.updated_at).getTime() : Date.now(),
    };
  }

  async function fetchLatestSession(userId) {
    const { data, error } = await supabase
      .from("chat_sessions")
      .select("id, title, created_at, updated_at")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    return {
      chatId: data.id,
      title: data.title || "New chat",
      createdAt: data.created_at ? new Date(data.created_at).getTime() : Date.now(),
      updatedAt: data.updated_at ? new Date(data.updated_at).getTime() : Date.now(),
    };
  }

  async function listSessions(userId) {
    const { data, error } = await supabase
      .from("chat_sessions")
      .select("id, title, created_at, updated_at")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(maxSessions);

    if (error) throw error;

    return (data || []).map((session) => ({
      chatId: session.id,
      title: session.title || "New chat",
      createdAt: session.created_at
        ? new Date(session.created_at).getTime()
        : Date.now(),
      updatedAt: session.updated_at
        ? new Date(session.updated_at).getTime()
        : Date.now(),
    }));
  }

  async function saveSessions() {
    return null;
  }

  async function createSession(userId, title = "New chat") {
    const safeTitle = sanitizeInput(title || "New chat", 120) || "New chat";
    const { data, error } = await supabase
      .from("chat_sessions")
      .insert({
        user_id: userId,
        title: safeTitle,
      })
      .select("id, title, created_at, updated_at")
      .single();

    if (error) throw error;

    return {
      chatId: data.id,
      title: data.title || "New chat",
      createdAt: new Date(data.created_at).getTime(),
      updatedAt: new Date(data.updated_at).getTime(),
    };
  }

  async function ensureSession(userId, chatId) {
    if (!chatId || chatId === "default") {
      return fetchLatestSession(userId);
    }

    const existing = await fetchSessionById(userId, chatId);
    if (existing) return existing;

    if (!isUuid(chatId)) return null;

    const { data, error } = await supabase
      .from("chat_sessions")
      .insert({
        id: chatId,
        user_id: userId,
        title: "New chat",
      })
      .select("id, title, created_at, updated_at")
      .single();

    if (error) throw error;

    return {
      chatId: data.id,
      title: data.title || "New chat",
      createdAt: new Date(data.created_at).getTime(),
      updatedAt: new Date(data.updated_at).getTime(),
    };
  }

  async function touchSession(userId, chatId, titleIfEmpty) {
    if (!chatId || chatId === "default" || !isUuid(chatId)) return null;

    const existing = await fetchSessionById(userId, chatId);
    if (!existing) return null;

    const nextTitle =
      titleIfEmpty && (!existing.title || existing.title === "New chat")
        ? sanitizeInput(titleIfEmpty, 120) || "New chat"
        : existing.title;

    const { data, error } = await supabase
      .from("chat_sessions")
      .update({
        title: nextTitle,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .eq("id", chatId)
      .select("id, title, created_at, updated_at")
      .single();

    if (error) throw error;

    return {
      chatId: data.id,
      title: data.title || "New chat",
      createdAt: new Date(data.created_at).getTime(),
      updatedAt: new Date(data.updated_at).getTime(),
    };
  }

  async function deleteSession(userId, chatId) {
    if (!chatId || !isUuid(chatId)) return;
    const { error } = await supabase
      .from("chat_sessions")
      .delete()
      .eq("user_id", userId)
      .eq("id", chatId);

    if (error) throw error;
  }

  async function resolveWritableSessionId(userId, chatId) {
    if (chatId && chatId !== "default") {
      const ensured = await ensureSession(userId, chatId);
      return ensured?.chatId || null;
    }

    const latest = await fetchLatestSession(userId);
    if (latest?.chatId) return latest.chatId;

    const created = await createSession(userId, "New chat");
    return created.chatId;
  }

  async function trimSessionMessages(userId, sessionId) {
    const { data, error } = await supabase
      .from("chat_messages")
      .select("id")
      .eq("user_id", userId)
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false })
      .range(maxHistoryLength, maxHistoryLength + 500);

    if (error) throw error;
    const idsToDelete = (data || []).map((row) => row.id);
    if (!idsToDelete.length) return;

    const { error: deleteError } = await supabase
      .from("chat_messages")
      .delete()
      .in("id", idsToDelete);

    if (deleteError) throw deleteError;
  }

  async function saveMessage(userId, role, message, chatId = "default") {
    try {
      const sanitizedMessage = sanitizeInput(message, maxMessageLength);
      const sessionId = await resolveWritableSessionId(userId, chatId);
      if (!sessionId || !sanitizedMessage) return null;

      const { error } = await supabase.from("chat_messages").insert({
        session_id: sessionId,
        user_id: userId,
        role,
        content: sanitizedMessage,
      });

      if (error) throw error;

      await touchSession(userId, sessionId);
      await trimSessionMessages(userId, sessionId);
      return getChatHistory(userId, sessionId);
    } catch (err) {
      console.error("saveMessage error:", err);
      return null;
    }
  }

  async function getChatHistory(userId, chatId = "default") {
    try {
      let sessionId = chatId;
      if (!sessionId || sessionId === "default") {
        const latest = await fetchLatestSession(userId);
        sessionId = latest?.chatId || null;
      }

      if (!sessionId || !isUuid(sessionId)) return [];

      const { data, error } = await supabase
        .from("chat_messages")
        .select("role, content, created_at")
        .eq("user_id", userId)
        .eq("session_id", sessionId)
        .order("created_at", { ascending: true });

      if (error) throw error;

      return (data || []).map((item) => ({
        role: item.role,
        message: item.content,
        timestamp: item.created_at
          ? new Date(item.created_at).getTime()
          : Date.now(),
      }));
    } catch (err) {
      console.error("getChatHistory error:", err);
      return [];
    }
  }

  async function forceCleanChat(userId, chatId = "default") {
    const sessionId =
      chatId === "default" ? (await fetchLatestSession(userId))?.chatId : chatId;
    if (!sessionId || !isUuid(sessionId)) return [];

    const history = await getChatHistory(userId, sessionId);
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

    const { error: deleteError } = await supabase
      .from("chat_messages")
      .delete()
      .eq("user_id", userId)
      .eq("session_id", sessionId);
    if (deleteError) throw deleteError;

    if (cleaned.length) {
      const payload = cleaned.map((item) => ({
        session_id: sessionId,
        user_id: userId,
        role: item.role,
        content: sanitizeInput(item.message, maxMessageLength),
        created_at: new Date(item.timestamp || Date.now()).toISOString(),
      }));
      const { error: insertError } = await supabase
        .from("chat_messages")
        .insert(payload);
      if (insertError) throw insertError;
    }

    await touchSession(userId, sessionId);
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
    sessionMessagesKey: (_userId, chatId) => chatId,
    sessionsKey: (userId) => userId,
    touchSession,
    unwrapDbData: (value) => value,
  };
}
