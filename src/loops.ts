export const SIMILARITY_THRESHOLD = 0.95;

export function calculateJaccardSimilarity(a: string, b: string): number {
  const cleanA = a.toLowerCase().replace(/[^\w\s]/g, "");
  const cleanB = b.toLowerCase().replace(/[^\w\s]/g, "");
  const setA = new Set(cleanA.split(/\s+/).filter(Boolean));
  const setB = new Set(cleanB.split(/\s+/).filter(Boolean));
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (!part) return "";
        if (typeof part === "string") return part;
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
  return "";
}

interface Turn {
  assistantIndex: number;
  assistantMsg: any;
  toolResults: any[];
}

// Recursively sort keys so identical data with different key order produces the same string.
// Avoids double-serialization by only stringifying at the top level.
export function canonicalize(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (obj instanceof Date) return obj.toISOString();
  if (obj instanceof Set) return Array.from(obj.values()).sort().map(canonicalize);
  if (obj instanceof Map) {
    const entries = Array.from(obj.entries()).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    return entries.map(([k, v]) => [k, canonicalize(v)]);
  }
  if (Array.isArray(obj)) return obj.map(canonicalize);

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = canonicalize((obj as any)[key]);
  }
  return sorted;
}

export function canonicalJson(obj: unknown): string {
  return JSON.stringify(canonicalize(obj));
}

function getTurnSignature(turn: Turn): string {
  const toolCalls = Array.isArray(turn.assistantMsg.toolCalls)
    ? turn.assistantMsg.toolCalls
    : turn.assistantMsg.functionCalls || [];

  if (toolCalls.length > 0) {
    return toolCalls.map((tc: any) => {
      const name = tc.name || tc.function?.name || "";
      const rawArgs = tc.arguments || tc.function?.arguments || "";
      let parsedArgs = rawArgs;
      if (typeof rawArgs === "string") {
        try {
          parsedArgs = JSON.parse(rawArgs);
        } catch {
          // Bug 1.4: fallback to raw string if JSON parsing fails to avoid crashes
          parsedArgs = rawArgs;
        }
      }
      const argsStr = canonicalJson(parsedArgs);
      return `${name}:${argsStr}`;
    }).join("|");
  }

  const text = extractText(turn.assistantMsg.content);
  // Bug #9: do not truncate — two long messages differing only beyond char 100
  // would produce identical signatures and falsely look like a loop.
  return text;
}

function buildTurns(messages: any[]): Turn[] {
  const turns: Turn[] = [];
  let currentTurn: Turn | null = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      if (currentTurn) turns.push(currentTurn);
      currentTurn = { assistantIndex: i, assistantMsg: msg, toolResults: [] };
    } else if (msg.role === "toolResult" || msg.role === "tool_result" || msg.role === "tool" || msg.role === "tool_call") {
      if (currentTurn) currentTurn.toolResults.push(msg);
    }
  }
  if (currentTurn) turns.push(currentTurn);
  return turns;
}

function areTurnsSimilar(a: Turn, b: Turn): boolean {
  const hasToolsA =
    (Array.isArray(a.assistantMsg.toolCalls) && a.assistantMsg.toolCalls.length > 0) ||
    (Array.isArray(a.assistantMsg.functionCalls) && a.assistantMsg.functionCalls.length > 0);
  const hasToolsB =
    (Array.isArray(b.assistantMsg.toolCalls) && b.assistantMsg.toolCalls.length > 0) ||
    (Array.isArray(b.assistantMsg.functionCalls) && b.assistantMsg.functionCalls.length > 0);

  // Bug 2.1: if one has tools and the other doesn't, they are not similar
  if (hasToolsA !== hasToolsB) {
    return false;
  }

  if (hasToolsA && hasToolsB) {
    return getTurnSignature(a) === getTurnSignature(b);
  }

  const textA = extractText(a.assistantMsg.content);
  const textB = extractText(b.assistantMsg.content);

  // Bug #12: empty/falsy content on both sides should NOT be treated as a loop.
  // Delegate to calculateJaccardSimilarity which returns 0 for empty unions.
  if (!textA && !textB) return false;
  return calculateJaccardSimilarity(textA, textB) >= SIMILARITY_THRESHOLD;
}

export function pruneLoopingTurns(messages: any[]): any[] {
  const turns = buildTurns(messages);
  if (turns.length < 2) return messages;

  const messagesToRemove = new Set<any>();

  // Check EVERY turn pattern for duplicates (not just the last turn).
  // This catches multi-turn cycles like A → B → A → B.
  for (let i = 0; i < turns.length; i++) {
    const turnI = turns[i]!;
    // Bug 3.1: Do not skip comparison if turnI is already in messagesToRemove.
    // This allows similarity to propagate transitively through chains.
    for (let j = i + 1; j < turns.length; j++) {
      const turnJ = turns[j]!;
      if (areTurnsSimilar(turnJ, turnI)) {
        messagesToRemove.add(turnJ.assistantMsg);
        for (const tr of turnJ.toolResults) {
          messagesToRemove.add(tr);
        }
      }
    }
  }

  if (messagesToRemove.size === 0) return messages;
  return messages.filter(m => !messagesToRemove.has(m));
}

