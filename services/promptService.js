import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";

export function buildChatParams(message, maxResponseTokens = 4000, options = {}) {
  const isCodeHeavy = options.forceCodeMode || isCodeHeavyMessage(message);
  return {
    isCodeHeavy,
    maxTokens: isCodeHeavy ? maxResponseTokens : 1600,
    timeout: isCodeHeavy ? 75000 : 40000,
    historyLimit: isCodeHeavy ? 8 : 12,
    temperature: isCodeHeavy ? 0.25 : 0.6,
  };
}

export async function buildStructuredChatPrompt({
  history = [],
  userMessage,
  nowIST,
  newsContextBlock = "",
  optimizedParams,
}) {
  const recentHistory = history
    .slice(-optimizedParams.historyLimit)
    .map(toLangChainMessage)
    .filter(Boolean);

  const systemText = buildSystemInstruction({
    isCodeHeavy: optimizedParams.isCodeHeavy,
    nowIST,
  });

  const userText = buildUserPrompt(userMessage, newsContextBlock);

  // LangChain stays in the orchestration layer for prompt/history preparation,
  // while the final Sarvam call still receives plain provider-native messages.
  const prompt = ChatPromptTemplate.fromMessages([
    ["system", "{systemInstruction}"],
    new MessagesPlaceholder("recentChat"),
    ["human", "{userQuestion}"],
  ]);

  const langChainMessages = await prompt.formatMessages({
    systemInstruction: systemText,
    recentChat: recentHistory,
    userQuestion: userText,
  });

  return {
    systemText,
    userText,
    historyMessages: recentHistory.map((message) => ({
      role: message instanceof AIMessage ? "assistant" : "user",
      content: getMessageContent(message.content),
    })),
    langChainMessages,
  };
}

function buildSystemInstruction({ isCodeHeavy = false, nowIST = "" }) {
  const codingMode = isCodeHeavy
    ? "When coding is requested, provide complete runnable code with exact file names and minimal required steps."
    : "When coding is requested, provide practical snippets and avoid unnecessary verbosity.";

  return [
    "You are Genie, a reliable AI assistant for practical help.",
    "If the user asks who you are, your name, or what assistant this is, say you are Genie, an AI assistant.",
    "Do not identify yourself as Sarvam, Sarvam Chat, or the model/provider. Sarvam is only the backend provider.",
    "Reply in the same language as the user's latest message unless the user asks for another language.",
    "Be clear, direct, and helpful. Avoid filler and repetition.",
    codingMode,
    "For any multi-line code, always use fenced markdown code blocks with triple backticks and a language tag when known.",
    "Do not leave code fences unclosed.",
    "Never output placeholder tokens like @@INLINECODE0@@ or @@INLINE_CODE_0@@.",
    "Always format inline code with backticks.",
    "If information is uncertain, state assumptions briefly instead of guessing facts.",
    nowIST
      ? `Current date/time is: ${nowIST}. If the user asks for time, date, or day, use this exact server time.`
      : "",
    "If NEWS_RESULTS is present, use only NEWS_RESULTS for current events. If it is empty, say you do not have live news results.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildUserPrompt(userMessage, newsContextBlock) {
  if (!newsContextBlock) return String(userMessage || "").trim();
  return `${newsContextBlock}\n\nUSER_MESSAGE:\n${String(userMessage || "").trim()}`;
}

function toLangChainMessage(message) {
  if (!message?.role || !message?.message) return null;
  const content = String(message.message).trim();
  if (!content) return null;
  if (message.role === "assistant") return new AIMessage(content);
  if (message.role === "user") return new HumanMessage(content);
  return null;
}

function getMessageContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return "";
}

function isCodeHeavyMessage(message) {
  if (!message || typeof message !== "string") return false;
  const trimmed = message.trim();
  if (trimmed.includes("```")) return true;

  const normalized = trimmed.toLowerCase();
  const codePatterns = [
    /(function|def|class|import|export|const|let|var)\b/,
    /(if|else|for|while|return|try|catch|finally)\b/,
    /\b(html|css|javascript|js|jsx|typescript|ts|python|java|c\+\+|cpp|react|node|express)\b/,
    /\b(code|coding|script|snippet|program|algorithm|app|project|component|function)\b/,
    /\b(index\.html|styles?\.css|script\.js|app\.js|main\.js|main\.py)\b/,
    /\b(full|complete|entire|again|rewrite|regenerate|continue|rest of)\b.*\b(code|html|css|js|javascript|file|files)\b/,
    /\b(split|separate)\b.*\b(file|files)\b/,
  ];

  if (codePatterns.some((pattern) => pattern.test(trimmed))) return true;

  const requestPhrases = [
    "give code",
    "send code",
    "write code",
    "give html",
    "give css",
    "give js",
    "send html",
    "send css",
    "send js",
    "complete code",
    "full code",
    "code again",
  ];

  return requestPhrases.some((phrase) => normalized.includes(phrase));
}
