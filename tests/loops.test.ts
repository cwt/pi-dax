import { describe, it } from "node:test";
import assert from "node:assert";
import { pruneLoopingTurns, calculateJaccardSimilarity } from "../src/loops.js";

describe("loops", () => {
  describe("calculateJaccardSimilarity", () => {
    it("should return 1 for identical strings", () => {
      assert.strictEqual(calculateJaccardSimilarity("hello world", "hello world"), 1);
    });

    it("should return 0 for disjoint strings", () => {
      assert.strictEqual(calculateJaccardSimilarity("hello", "world"), 0);
    });

    it("should be case-insensitive", () => {
      assert.strictEqual(calculateJaccardSimilarity("Hello World", "hello world"), 1);
    });

    it("should handle minor differences", () => {
      const sim = calculateJaccardSimilarity(
        "the quick brown fox jumps",
        "the quick brown fox leaps"
      );
      assert.ok(sim > 0.6 && sim < 1);
    });

    // Bug #12 coverage: empty strings should return 0, not 1
    it("should return 0 for two empty strings", () => {
      assert.strictEqual(calculateJaccardSimilarity("", ""), 0);
    });

    it("should return 0 when one string is empty", () => {
      assert.strictEqual(calculateJaccardSimilarity("hello", ""), 0);
      assert.strictEqual(calculateJaccardSimilarity("", "world"), 0);
    });
  });

  describe("pruneLoopingTurns", () => {
    it("should do nothing if less than 2 turns", () => {
      const messages = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" }
      ];
      const result = pruneLoopingTurns(messages);
      assert.deepStrictEqual(result, messages);
    });

    it("should return messages unchanged for empty array", () => {
      const result = pruneLoopingTurns([]);
      assert.deepStrictEqual(result, []);
    });

    it("should prune duplicate tool calls but preserve user messages", () => {
      const messages = [
        { role: "user", content: "do something" },
        { role: "assistant", toolCalls: [{ name: "write", arguments: { path: "file.txt" } }] },
        { role: "toolResult", content: "error" },
        { role: "user", content: "please retry" },
        { role: "assistant", toolCalls: [{ name: "write", arguments: { path: "file.txt" } }] },
        { role: "toolResult", content: "error" },
        { role: "user", content: "this is a trailing user message" }
      ];

      const expected = [
        { role: "user", content: "do something" },
        { role: "assistant", toolCalls: [{ name: "write", arguments: { path: "file.txt" } }] },
        { role: "toolResult", content: "error" },
        { role: "user", content: "please retry" },
        { role: "user", content: "this is a trailing user message" }
      ];

      const result = pruneLoopingTurns(messages);
      assert.deepStrictEqual(result, expected);
    });

    it("should prune duplicate text responses with minor changes", () => {
      const messages = [
        { role: "user", content: "greet me" },
        { role: "assistant", content: "Hello! How can I help you today?" },
        { role: "user", content: "greet me again" },
        { role: "assistant", content: "Hello! How can I help you today?!" },
        { role: "user", content: "some final prompt" }
      ];

      const expected = [
        { role: "user", content: "greet me" },
        { role: "assistant", content: "Hello! How can I help you today?" },
        { role: "user", content: "greet me again" },
        { role: "user", content: "some final prompt" }
      ];

      const result = pruneLoopingTurns(messages);
      assert.deepStrictEqual(result, expected);
    });

    // Bug #13: tool calls with DIFFERENT arguments should NOT be pruned
    it("should NOT prune tool calls with different arguments", () => {
      const messages = [
        { role: "user", content: "do something" },
        { role: "assistant", toolCalls: [{ name: "write", arguments: { path: "a.txt" } }] },
        { role: "toolResult", content: "ok" },
        { role: "user", content: "do another thing" },
        { role: "assistant", toolCalls: [{ name: "write", arguments: { path: "b.txt" } }] },
        { role: "toolResult", content: "ok" },
      ];

      // Nothing should be pruned — the two writes target different files
      const result = pruneLoopingTurns(messages);
      assert.deepStrictEqual(result, messages);
    });

    // Bug #13: mixed turns (one text, one tool) should NOT be treated as similar
    it("should NOT prune a text turn and a tool-call turn as similar", () => {
      const messages = [
        { role: "user", content: "start" },
        { role: "assistant", content: "I will write the file now." },
        { role: "user", content: "go" },
        { role: "assistant", toolCalls: [{ name: "write", arguments: { path: "out.txt" } }] },
        { role: "toolResult", content: "done" },
      ];

      const result = pruneLoopingTurns(messages);
      assert.deepStrictEqual(result, messages);
    });

    // Bug #12 coverage: two assistant turns with empty content should NOT trigger pruning
    it("should NOT prune turns with empty content (bug #12)", () => {
      const messages = [
        { role: "user", content: "do something" },
        { role: "assistant", content: "" },
        { role: "user", content: "do it again" },
        { role: "assistant", content: "" },
      ];

      // Both assistant messages have empty content — must not be treated as a loop
      const result = pruneLoopingTurns(messages);
      assert.deepStrictEqual(result, messages);
    });

    // Bug #13: turns with zero tool results still prune correctly
    it("should prune duplicate tool-call turns that have no tool results", () => {
      const messages = [
        { role: "user", content: "go" },
        { role: "assistant", toolCalls: [{ name: "read", arguments: { path: "x.txt" } }] },
        { role: "user", content: "again" },
        { role: "assistant", toolCalls: [{ name: "read", arguments: { path: "x.txt" } }] },
      ];

      const expected = [
        { role: "user", content: "go" },
        { role: "assistant", toolCalls: [{ name: "read", arguments: { path: "x.txt" } }] },
        { role: "user", content: "again" },
      ];

      const result = pruneLoopingTurns(messages);
      assert.deepStrictEqual(result, expected);
    });

    // Bug #13: multiple duplicate turns (more than two) should all be pruned
    it("should prune multiple consecutive identical tool-call turns", () => {
      const toolMsg = { name: "search", arguments: { query: "foo" } };
      const messages = [
        { role: "user", content: "search" },
        { role: "assistant", toolCalls: [toolMsg] },
        { role: "toolResult", content: "no results" },
        { role: "user", content: "retry" },
        { role: "assistant", toolCalls: [toolMsg] },
        { role: "toolResult", content: "no results" },
        { role: "user", content: "retry again" },
        { role: "assistant", toolCalls: [toolMsg] },
        { role: "toolResult", content: "no results" },
      ];

      const result = pruneLoopingTurns(messages);

      // Only the first occurrence of the tool-call turn is kept
      const assistantCount = result.filter(m => m.role === "assistant").length;
      assert.strictEqual(assistantCount, 1);

      // All user messages are preserved
      const userCount = result.filter(m => m.role === "user").length;
      assert.strictEqual(userCount, 3);
    });

    // Bug #9 coverage: long text that differs only after 100 chars should NOT be pruned
    it("should NOT prune long text turns differing only after 100 chars (bug #9)", () => {
      const sharedPrefix = "a ".repeat(50); // 100 chars
      const messages = [
        { role: "user", content: "go" },
        { role: "assistant", content: sharedPrefix + "UNIQUE_ENDING_ONE" },
        { role: "user", content: "go again" },
        { role: "assistant", content: sharedPrefix + "TOTALLY_DIFFERENT_ENDING_TWO" },
      ];

      // The two assistant messages share the same 100-char prefix but differ beyond
      // it, so they should NOT be considered a loop and nothing should be pruned.
      const result = pruneLoopingTurns(messages);
      assert.deepStrictEqual(result, messages);
    });

    // Bug 1.4: should handle malformed JSON arguments in tool calls and not crash
    it("should handle malformed JSON arguments in tool calls and not crash (bug 1.4)", () => {
      const messages = [
        { role: "user", content: "go" },
        { role: "assistant", toolCalls: [{ name: "search", arguments: "{malformed json" }] },
        { role: "toolResult", content: "no results" },
        { role: "user", content: "retry" },
        { role: "assistant", toolCalls: [{ name: "search", arguments: "{malformed json" }] },
        { role: "toolResult", content: "no results" },
      ];

      const expected = [
        { role: "user", content: "go" },
        { role: "assistant", toolCalls: [{ name: "search", arguments: "{malformed json" }] },
        { role: "toolResult", content: "no results" },
        { role: "user", content: "retry" },
      ];

      const result = pruneLoopingTurns(messages);
      assert.deepStrictEqual(result, expected);
    });

    // Bug 2.1: should NOT prune mixed turns even if their text content is identical
    it("should NOT prune mixed turns even if their text content is identical (bug 2.1)", () => {
      const messages = [
        { role: "user", content: "go" },
        { role: "assistant", content: "I will write now." }, // purely text
        { role: "user", content: "do it" },
        { role: "assistant", content: "I will write now.", toolCalls: [{ name: "write", arguments: { path: "x.txt" } }] },
        { role: "toolResult", content: "ok" },
      ];

      const result = pruneLoopingTurns(messages);
      assert.deepStrictEqual(result, messages);
    });

    // Bug 3.1: should prune transitively similar turns (C similar to B, B similar to A, C pruned)
    it("should prune transitively similar turns (bug 3.1)", () => {
      const baseWords = Array.from({ length: 20 }, (_, idx) => `word${idx}`).join(" ");
      const msgA = baseWords;
      const msgB = `${baseWords} extra1`;
      const msgC = `${baseWords} extra1 extra2`;

      const messages = [
        { role: "user", content: "run" },
        { role: "assistant", content: msgA },
        { role: "user", content: "next" },
        { role: "assistant", content: msgB },
        { role: "user", content: "next" },
        { role: "assistant", content: msgC },
      ];

      const expected = [
        { role: "user", content: "run" },
        { role: "assistant", content: msgA },
        { role: "user", content: "next" },
        { role: "user", content: "next" },
      ];

      const result = pruneLoopingTurns(messages);
      assert.deepStrictEqual(result, expected);
    });

    it("should prune duplicate turns even if one has string content and the other has array content blocks", () => {
      const messages = [
        { role: "user", content: "greet" },
        { role: "assistant", content: "Hello! How can I help you today?" },
        { role: "user", content: "greet again" },
        { role: "assistant", content: [{ type: "text", text: "Hello! How can I help you today?" }] },
        { role: "user", content: "final" }
      ];

      const expected = [
        { role: "user", content: "greet" },
        { role: "assistant", content: "Hello! How can I help you today?" },
        { role: "user", content: "greet again" },
        { role: "user", content: "final" }
      ];

      const result = pruneLoopingTurns(messages);
      assert.deepStrictEqual(result, expected);
    });
  });
});
