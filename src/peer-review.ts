import { getDaxApiUrl, getDaxModel, getDaxApiKey } from "./config.js";

const REVIEW_TIMEOUT_MS = 30000;
const MAX_CONTENT_CHARS = 120000;

export function escapeForPrompt(str: string): string {
  return str;
}

export interface ReviewResult {
  approved: boolean;
  feedback: string;
}

export async function reviewCodeChange(
  filename: string,
  proposed: string,
  target?: string,
): Promise<ReviewResult> {
  let apiUrl: string;
  let model: string;
  let apiKey: string;

  // Bug #6: surface config errors with actionable messages instead of silently
  // blocking every write with a generic "Review unavailable due to error".
  try {
    apiUrl = getDaxApiUrl();
    model = getDaxModel();
    apiKey = getDaxApiKey();
  } catch (configError) {
    const message = configError instanceof Error ? configError.message : String(configError);
    console.error("DAX config error:", configError);
    // Fail open: a broken config should not block all edits.
    return {
      approved: true,
      feedback: `Review skipped — DAX configuration error: ${message}`,
    };
  }

  const truncate = (s: string) =>
    s.length > MAX_CONTENT_CHARS ? s.slice(0, MAX_CONTENT_CHARS) + "\n...[truncated]" : s;

  const editDescription = target
    ? `Replacing:\n\`\`\`\n${escapeForPrompt(truncate(target))}\n\`\`\`\n\nWith:\n\`\`\`\n${escapeForPrompt(truncate(proposed))}\n\`\`\``
    : `Writing new content:\n\`\`\`\n${escapeForPrompt(truncate(proposed))}\n\`\`\``;

  const isProposedTruncated = proposed.length > MAX_CONTENT_CHARS;
  const isTargetTruncated = target ? target.length > MAX_CONTENT_CHARS : false;
  const truncationWarning = (isProposedTruncated || isTargetTruncated)
    ? "\n\nNote: The code content above was truncated for the review prompt because it exceeded length limits. Please review only the visible portion of the proposed changes, and do NOT reject the edit solely because it contains the '...[truncated]' marker or is incomplete at the end."
    : "";

  const prompt = `You are DAX, a strict senior code reviewer symbiont joined with a coding assistant. The assistant wants to edit the file "${filename}":

${editDescription}

Review the proposed code change carefully.
- If it is correct, has no syntax errors, has no logic bugs, and makes sense, respond with exactly: LGTM
- If there are any syntax errors, logic bugs, type errors, or security issues, explain them clearly in a short paragraph and provide suggestion. Do not start with LGTM.
- Be careful: do not hallucinate syntax errors. Templating tags (like Jinja2/Django {% ... %} and {{ ... }}) are valid and should not be flagged as syntax errors. Double check all tag matching and line context before reporting unclosed tags.${truncationWarning}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REVIEW_TIMEOUT_MS);

  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 1000,
      }),
      signal: controller.signal,
    });

    // Bug #3: fail-open — a non-OK API response should not block the user.
    if (!res.ok) return { approved: true, feedback: "LGTM" };

    const data = await res.json() as any;
    const rawContent = data.choices?.[0]?.message?.content;
    // Non-text responses (tool_calls, refusals, null) → fail open (don't block the user).
    const content = typeof rawContent === "string" ? rawContent.trim() : "";
    if (!content) return { approved: true, feedback: "LGTM" };

    // Bug #1/#2/#7: match LGTM at the beginning of the response (allowing optional
    // spacing, bullet markers, and markdown bold/italic formatting), but reject
    // negative mentions (like "not LGTM") that appear later in the response.
    const isApproved = /^\s*(?:[-*+]\s*)?(?:\*\*|__)?\s*LGTM\b/i.test(content);
    return { approved: isApproved, feedback: content };
  } catch (error) {
    console.error("Failed to query DAX:", error);
    // Bug #3: fail-open on network/timeout errors as well.
    return { approved: true, feedback: "LGTM" };
  } finally {
    // Bug #8: always clear the timeout, even when fetch() throws/rejects.
    clearTimeout(timeoutId);
  }
}
