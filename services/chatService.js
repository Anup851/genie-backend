import { cleanAssistantReply } from "../utils/messageFormatter.js";
import { buildChatParams, buildPromptMessages } from "./promptService.js";

export function createChatService({
  historyService,
  sarvamService,
  retrieveRelevantMemorySnippet,
}) {
  const { ensureSession, getChatHistory, saveMessage, touchSession } =
    historyService;

  async function handleChat({ userId, message, chatId = "default", signal }) {
    const sanitizedMessage = String(message || "").trim();
    await ensureSession(userId, chatId);

    const titleCandidate = sanitizedMessage.slice(0, 28);
    const optimizedParams = buildChatParams(sanitizedMessage);
    const memoryContext = await retrieveRelevantMemorySnippet(
      userId,
      sanitizedMessage,
    );
    const history = await getChatHistory(userId, chatId);

    const promptMessages = await buildPromptMessages({
      history,
      userMessage: sanitizedMessage,
      memoryContext,
      extraSystemContext: `Current time: ${new Date().toLocaleString()}`,
      optimizedParams,
    });

    const { reply: rawReply, usage } = await sarvamService.sendChatMessages({
      messages: promptMessages,
      optimizedParams,
      signal,
    });

    const reply = cleanAssistantReply(rawReply);

    await saveMessage(userId, "user", sanitizedMessage, chatId);
    await saveMessage(userId, "assistant", reply, chatId);
    await touchSession(userId, chatId, titleCandidate);

    return { reply, usage };
  }

  return {
    handleChat,
  };
}
