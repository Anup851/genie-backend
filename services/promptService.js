import { AIMessage, HumanMessage } from "@langchain/core/messages";
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from "@langchain/core/prompts";

export function buildChatParams(message) {
  const isCodeHeavy = isCodeHeavyMessage(message);
  return {
    isCodeHeavy,
    maxTokens: isCodeHeavy ? 1800 : 700,
    timeout: isCodeHeavy ? 45000 : 30000,
    historyLimit: isCodeHeavy ? 8 : 10,
    temperature: isCodeHeavy ? 0.25 : 0.7,
  };
}

export async function buildPromptMessages({
  history = [],
  userMessage,
  memoryContext = "",
  extraSystemContext = "",
  optimizedParams,
}) {
  const prompt = ChatPromptTemplate.fromMessages([
    ["system", "{systemInstruction}"],
    new MessagesPlaceholder("recentChat"),
    [
      "human",
      [
        "USER QUESTION:",
        "{userQuestion}",
        "",
        "INSTRUCTIONS:",
        "- Answer clearly and directly",
        "- Preserve code formatting when useful",
        "- Be concise unless the user asks for detail",
      ].join("\n"),
    ],
  ]);

  const recentChat = history
    .slice(-optimizedParams.historyLimit)
    .map(toLangChainMessage)
    .filter(Boolean);

  return prompt.formatMessages({
    systemInstruction: buildSystemInstruction({
      isCodeHeavy: optimizedParams.isCodeHeavy,
      memoryContext,
      extraSystemContext,
    }),
    recentChat,
    userQuestion: String(userMessage || "").trim(),
  });
}

function buildSystemInstruction({
  isCodeHeavy = false,
  memoryContext = "",
  extraSystemContext = "",
}) {
  const codingMode = isCodeHeavy
    ? "When coding is requested, provide complete runnable code with exact file names and minimal required steps."
    : "When coding is requested, provide practical snippets and avoid unnecessary verbosity.";

  return [
    "You are Genie, a friendly assistant.",
    "Use remembered user details only when they are relevant and helpful.",
    "Be natural, accurate, and easy to understand.",
    codingMode,
    "For any multi-line code, always use fenced markdown code blocks with a language tag when known.",
    "Do not leave code fences unclosed.",
    "Always format inline code with backticks when useful.",
    memoryContext ? `Memory snippet:\n${memoryContext}` : "",
    extraSystemContext || "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function toLangChainMessage(message) {
  if (!message?.role || !message?.message) return null;
  const content = String(message.message).trim();
  if (!content) return null;
  if (message.role === "assistant") return new AIMessage(content);
  if (message.role === "user") return new HumanMessage(content);
  return null;
}

function isCodeHeavyMessage(message) {
  if (!message || typeof message !== "string") return false;
  const trimmed = message.trim();
  if (trimmed.includes("```")) return true;
  const codePatterns = [
    /(function|def|class|import|export|const|let|var)\b/,
    /(if|else|for|while|return|try|catch|finally)\b/,
  ];
  return codePatterns.some((pattern) => pattern.test(trimmed));
}
