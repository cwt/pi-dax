import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert";
import { reviewCodeChange } from "../src/peer-review.js";

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set up a temporary directory with a mock models.json file so tests are self-contained
const tempDir = mkdtempSync(join(tmpdir(), "pi-dax-test-"));
const modelsPath = join(tempDir, "models.json");
writeFileSync(
  modelsPath,
  JSON.stringify({
    providers: {
      "local-dax": {
        baseUrl: "http://localhost:8081/v1",
        apiKey: "$OPENAI_API_KEY",
        models: [{ id: "qwen-4b" }],
      },
    },
  })
);

process.env.PI_CODING_AGENT_DIR = tempDir;
process.env.OPENAI_API_KEY = "dummy-key";

describe("peer-review", () => {
  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const originalFetch = globalThis.fetch;
  let mockFetchResponse: any = null;
  let mockFetchOk = true;

  beforeEach(() => {
    mockFetchResponse = null;
    mockFetchOk = true;

    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (!mockFetchOk) {
        return { ok: false, status: 500 } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => mockFetchResponse
      } as Response;
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should approve simple LGTM", async () => {
    mockFetchResponse = {
      choices: [{ message: { content: "LGTM" } }]
    };
    const res = await reviewCodeChange("test.js", "const x = 1;");
    assert.strictEqual(res.approved, true);
    assert.strictEqual(res.feedback, "LGTM");
  });

  it("should approve LGTM with markdown bold formatting", async () => {
    mockFetchResponse = {
      choices: [{ message: { content: "**LGTM**" } }]
    };
    const res = await reviewCodeChange("test.js", "const x = 1;");
    assert.strictEqual(res.approved, true);
    assert.strictEqual(res.feedback, "**LGTM**");
  });

  it("should approve LGTM with leading punctuation and whitespace", async () => {
    mockFetchResponse = {
      choices: [{ message: { content: "   \n- LGTM. Everything looks correct." } }]
    };
    const res = await reviewCodeChange("test.js", "const x = 1;");
    assert.strictEqual(res.approved, true);
    assert.strictEqual(res.feedback, "- LGTM. Everything looks correct.");
  });

  it("should reject with feedback if code has issues", async () => {
    mockFetchResponse = {
      choices: [{ message: { content: "There is a syntax error: missing semicolon on line 3." } }]
    };
    const res = await reviewCodeChange("test.js", "const x = 1");
    assert.strictEqual(res.approved, false);
    assert.strictEqual(res.feedback, "There is a syntax error: missing semicolon on line 3.");
  });

  it("should reject if feedback contains negative mention of LGTM not at start", async () => {
    mockFetchResponse = {
      choices: [{ message: { content: "There are syntax errors. This change is not LGTM." } }]
    };
    const res = await reviewCodeChange("test.js", "const x = 1;");
    assert.strictEqual(res.approved, false);
    assert.strictEqual(res.feedback, "There are syntax errors. This change is not LGTM.");
  });

  it("should fail-safe to approved if fetch fails", async () => {
    mockFetchOk = false;
    const res = await reviewCodeChange("test.js", "const x = 1;");
    assert.strictEqual(res.approved, true);
    assert.strictEqual(res.feedback, "LGTM");
  });

  it("should append truncation warning if code exceeds MAX_CONTENT_CHARS", async () => {
    mockFetchResponse = {
      choices: [{ message: { content: "LGTM" } }]
    };
    const longContent = "a".repeat(120001);
    const originalFetch = globalThis.fetch;
    let capturedPrompt = "";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      capturedPrompt = body.messages[0].content;
      return {
        ok: true,
        status: 200,
        json: async () => mockFetchResponse
      } as Response;
    }) as any;

    await reviewCodeChange("test.js", longContent);
    globalThis.fetch = originalFetch;

    assert.ok(capturedPrompt.includes("Note: The code content above was truncated"));
  });
});
