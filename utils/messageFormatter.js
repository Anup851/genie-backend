export function normalizeInlineCodeArtifacts(text) {
  return String(text || "")
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?think\b[^>]*>/gi, "")
    .replace(/(@{1,2}\s*INL\w*\s*_?\s*CODE\s*_?\s*\d+\s*@{1,2})/gi, "`$1`")
    .replace(/(@{1,2}\s*INL\w*\s*_?\s*CODE\s*@{1,2})/gi, "`$1`")
    .trim();
}

export function repairMarkdownCodeFences(text) {
  const input = String(text || "");
  if (!input) return "";

  const fenceCount = (input.match(/```/g) || []).length;
  if (fenceCount % 2 === 0) return input;
  return `${input}\n\`\`\``;
}

export function cleanAssistantReply(text) {
  return repairMarkdownCodeFences(
    normalizeInlineCodeArtifacts(text || "No response."),
  );
}
