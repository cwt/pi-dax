/**
 * π-DAX — Dual Active eXtension
 *
 * A symbiont (like Dax from Star Trek DS9) that joins with the main Pi LLM
 * to provide real-time peer code review, loop prevention, and oversight.
 * DAX is not a watchdog — it is an active partner that reviews every edit,
 * detects unproductive loops, and steers the host toward better outcomes.
 *
 * Architecture:
 *   - tool_call:    Tracks tool repetition; intercepts write/edit for peer review
 *   - message_end:  Detects repetitive text generation via Jaccard similarity
 *   - context:      Queries DAX LLM for loop detection; prunes loops + injects steering
 *
 * Commands:
 *   /dax           — Show current DAX status
 *   /dax review    — Toggle peer code review on/off
 *
 * Install:
 *   pi install npm:pi-dax
 *   pi -e /path/to/pi-dax/src/index.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { reviewCodeChange, escapeForPrompt } from "./peer-review.js";
import {
  calculateJaccardSimilarity,
  pruneLoopingTurns,
  SIMILARITY_THRESHOLD,
  canonicalJson,
} from "./loops.js";
import { getDaxApiUrl, getDaxModel, getDaxApiKey } from "./config.js";

const MAX_REPEATED_TOOLS = 3;

interface ToolCallRecord {
  name: string;
  args: string;
}

interface SessionState {
  toolCallHistory: ToolCallRecord[];
  lastAssistantResponse: string;
  loopDetected: boolean;
  reviewsEnabled: boolean;
  daxQueryInFlight: boolean;
  heuristicWarning: boolean;
}

const sessionStates = new Map<string, SessionState>();

function getSessionState(ctx: any): SessionState {
  const sessionName = ctx.getSessionName?.() || "default";
  let state = sessionStates.get(sessionName);
  if (!state) {
    state = {
      toolCallHistory: [],
      lastAssistantResponse: "",
      loopDetected: false,
      reviewsEnabled: true,
      daxQueryInFlight: false,
      heuristicWarning: false,
    };
    sessionStates.set(sessionName, state);
  }
  return state;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(
      "DAX symbiont active — peer review & loop prevention enabled",
      "info",
    );
    const state = getSessionState(ctx);
    state.toolCallHistory = [];
    state.lastAssistantResponse = "";
    state.loopDetected = false;
    state.reviewsEnabled = true;
    state.daxQueryInFlight = false;
    state.heuristicWarning = false;
  });

  pi.registerCommand("dax", {
    description:
      "Show DAX status. Usage: /dax review on|off (toggle peer review)",
    handler: async (args, ctx) => {
      const state = getSessionState(ctx);
      const cmd = args.trim().toLowerCase();
      if (cmd.startsWith("review")) {
        const val = cmd.split(/\s+/)[1];
        if (val === "on") state.reviewsEnabled = true;
        else if (val === "off") state.reviewsEnabled = false;
        else state.reviewsEnabled = !state.reviewsEnabled;
        ctx.ui.notify(
          `DAX peer review ${state.reviewsEnabled ? "enabled" : "disabled"}`,
          "info",
        );
      } else {
        ctx.ui.notify(
          `DAX: peer review ${state.reviewsEnabled ? "ON" : "OFF"} | ` +
          `${state.toolCallHistory.length} tool calls tracked | ` +
          `loop flag: ${state.loopDetected}`,
          "info",
        );
      }
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    const state = getSessionState(ctx);
    const input = event.input as Record<string, unknown>;

    const record: ToolCallRecord = {
      name: event.toolName,
      args: canonicalJson(input),
    };

    state.toolCallHistory.push(record);
    if (state.toolCallHistory.length > 10) {
      state.toolCallHistory.shift();
    }

    const identicalCount = state.toolCallHistory.filter(
      (h) => h.name === record.name && h.args === record.args,
    ).length;

    // Trigger heuristic warning when a tool call repeats (suspicious)
    if (identicalCount >= 2) {
      state.heuristicWarning = true;
    }

    if (identicalCount >= MAX_REPEATED_TOOLS) {
      ctx.ui.notify(`DAX: Repeated tool call detected (${record.name})`, "warning");
      state.loopDetected = true;
    }

    if (!state.reviewsEnabled) return;

    const isWrite = isToolCallEventType("write", event);
    const isEdit = isToolCallEventType("edit", event);

    if (!isWrite && !isEdit) return;

    ctx.ui.setStatus("dax", "DAX is reviewing the proposed edit...");

    const file = typeof input.path === "string" ? input.path : "file";
    let proposedContent = "";
    let targetContent = "";

    if (isWrite) {
      proposedContent = (input.content as string) || "";
    } else {
      const edits = input.edits as Array<{ oldText: string; newText: string }> | undefined;
      if (edits) {
        targetContent = edits.map((e) => e.oldText).join("\n---\n");
        proposedContent = edits.map((e) => e.newText).join("\n---\n");
      }
    }

    const { approved, feedback } = await reviewCodeChange(file, proposedContent, targetContent);
    ctx.ui.setStatus("dax", "");

    if (!approved) {
      ctx.ui.notify(`DAX: Peer rejected edit to ${file}!`, "warning");
      return {
        block: true,
        reason: `[DAX PEER REVIEW] The symbiont reviewed your proposed change to "${file}" and found issues:\n\n${feedback}\n\nPlease correct these issues in your next attempt.`,
      };
    } else if (feedback && feedback.startsWith("Review skipped")) {
      ctx.ui.notify(`DAX: ${feedback}`, "info");
    }
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const state = getSessionState(ctx);

    const content = event.message.content;
    let text = "";

    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .map((part: any) => {
          if (part.type === "text") return part.text || "";
          if (part.type === "refusal") return part.refusal || "";
          if (part.type === "code_interpreter") {
            return typeof part.code_interpreter === "string"
              ? part.code_interpreter
              : String(part.code_interpreter?.input ?? "");
          }
          return "";
        })
        .join(" ");
    }

    if (text && state.lastAssistantResponse) {
      const similarity = calculateJaccardSimilarity(text, state.lastAssistantResponse);
      if (similarity > 0.85) {
        state.heuristicWarning = true;
      }
      if (similarity > SIMILARITY_THRESHOLD) {
        state.loopDetected = true;
      }
    }

    if (text) {
      state.lastAssistantResponse = text;
    }
  });

  pi.on("context", async (event, ctx) => {
    const state = getSessionState(ctx);
    const messages = [...event.messages];

    // Bug #11 & 2.2: Only query if heuristic warning indicates loop suspicion
    if (!state.loopDetected && state.heuristicWarning && messages.length > 4 && !state.daxQueryInFlight) {
      state.daxQueryInFlight = true;
      try {
        state.loopDetected = await queryDaxLLM(messages.slice(-6));
      } finally {
        state.daxQueryInFlight = false;
        state.heuristicWarning = false;
      }
    }

    if (state.loopDetected) {
      const cleanedMessages = pruneLoopingTurns(messages);
      if (cleanedMessages.length < messages.length) {
        state.loopDetected = false;
        state.toolCallHistory = [];
        state.lastAssistantResponse = "";

        ctx.ui.notify("DAX: Interrupting loop! Pruning context memory...", "error");
        cleanedMessages.push({
          role: "user",
          content: `[DAX INTERVENTION] You were stuck in a loop repeating actions or text. The repeating turns have been removed from your memory. Do NOT repeat the commands or reasoning you just tried. Break the pattern, change your tactics, and try a completely different approach.`,
          timestamp: Date.now(),
        });
        return { messages: cleanedMessages };
      } else {
        // Bug 2.3: If pruning was skipped, retain history but inject steering warning
        state.loopDetected = false;

        ctx.ui.notify("DAX: Loop suspected! Injecting steering warning...", "warning");
        const warnedMessages = [...messages];
        warnedMessages.push({
          role: "user",
          content: `[DAX INTERVENTION] You are suspected of being stuck in a loop repeating actions or text. Please break the pattern, change your tactics, and try a completely different approach. Do NOT repeat the exact commands or reasoning you just tried.`,
          timestamp: Date.now(),
        });
        return { messages: warnedMessages };
      }
    }

    return { messages };
  });
}

async function queryDaxLLM(recentMessages: any[]): Promise<boolean> {
  try {
    const formattedHistory = recentMessages
      .map((m) => {
        let content = typeof m.content === "string"
          ? m.content
          : JSON.stringify(m.content || "");

        // Bug 1.2: format tool/function calls so the reviewer sees them
        if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
          const calls = m.toolCalls.map((tc: any) => {
            const name = tc.name || tc.function?.name || "";
            const args = tc.arguments || tc.function?.arguments || "";
            return `${name}(${typeof args === "string" ? args : JSON.stringify(args)})`;
          }).join(", ");
          content = `[Calls tools: ${calls}] ${content}`.trim();
        } else if (Array.isArray(m.functionCalls) && m.functionCalls.length > 0) {
          const calls = m.functionCalls.map((fc: any) => {
            const name = fc.name || "";
            const args = fc.arguments || "";
            return `${name}(${typeof args === "string" ? args : JSON.stringify(args)})`;
          }).join(", ");
          content = `[Calls functions: ${calls}] ${content}`.trim();
        }

        // Include tool results/outputs
        if (m.role === "toolResult" || m.role === "tool_result" || m.role === "tool") {
          const toolName = m.toolName || m.name || "tool";
          content = `[Result of ${toolName}]: ${content}`;
        }

        return `[${(m.role as string).toUpperCase()}]: ${content}`;
      })
      .join("\n---\n");

    const prompt = `Analyze the following recent conversation history of a coding assistant. Determine if the assistant is stuck in an unproductive loop (repeating similar commands, outputting repetitive text, trying the same failing actions repeatedly, or not making forward progress).

Conversation History:
${escapeForPrompt(formattedHistory)}

Note: In the conversation above, angle brackets are escaped as \\u003C and \\u003E (JSON Unicode escapes). Interpret them as their standard HTML angle bracket equivalents.

Is the assistant stuck in a loop? Respond with exactly one word: YES or NO.`;

    const apiUrl = getDaxApiUrl();
    const apiKey = getDaxApiKey();
    const model = getDaxModel();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    let res: Response;
    try {
      res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
          max_tokens: 5,
        }),
        signal: controller.signal,
      });
    } finally {
      // Bug #8: clear the timeout even when fetch() rejects (DNS failure, etc.).
      clearTimeout(timeoutId);
    }

    if (!res.ok) return false;

    const data = (await res.json()) as any;
    const answer = (data.choices?.[0]?.message?.content as string)?.trim().toUpperCase();
    return typeof answer === "string" && /^\s*(?:\*\*|__)?\s*YES\b/i.test(answer);
  } catch (error) {
    console.error("Failed to query DAX:", error);
    return false;
  }
}
