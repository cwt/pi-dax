import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

interface ProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  models?: { id: string }[];
}

// Bug #10: lazy cache — parse models.json once per process instead of 3× per review.
// TTL of 30s so edits to models.json are picked up mid-session.
let cachedProviderConfig: { config: ProviderConfig; timestamp: number } | null = null;
const CACHE_TTL_MS = 30_000;

function getDaxProviderConfig(): ProviderConfig {
  const now = Date.now();
  if (cachedProviderConfig && (now - cachedProviderConfig.timestamp) < CACHE_TTL_MS) {
    return cachedProviderConfig.config;
  }

  const modelsPath = join(getAgentDir(), "models.json");
  const displayPath = "~/.pi/agent/models.json";
  if (!existsSync(modelsPath)) {
    throw new Error(
      `DAX: models.json not found at ${displayPath}. ` +
      `Configure a "local-dax" provider in ${displayPath} (see README).`
    );
  }
  let root: { providers?: Record<string, ProviderConfig> } | null;
  try {
    root = JSON.parse(readFileSync(modelsPath, "utf-8"));
  } catch {
    throw new Error(`DAX: failed to parse models.json at ${displayPath}.`);
  }
  if (!root || typeof root !== "object") {
    throw new Error(`DAX: invalid JSON structure in models.json at ${displayPath}.`);
  }
  const provider = root.providers?.["local-dax"];
  if (!provider) {
    throw new Error(
      `DAX: no "local-dax" provider found in models.json. ` +
      `Add one like:\n` +
      `  "local-dax": { "baseUrl": "http://localhost:8081/v1", "api": "openai-completions", ... }`
    );
  }
  cachedProviderConfig = { config: provider, timestamp: now };
  return provider;
}

function resolveApiKey(raw: string | undefined): string | undefined {
  if (!raw) return undefined;

  // Bug #4: use two explicit patterns so that malformed variants like "$FOO}" or
  // "${FOO" are rejected rather than silently looking up a garbled env var name.
  const curly = raw.match(/^\$\{(\w+)\}$/);
  const curlyKey = curly?.[1];
  if (curlyKey) return process.env[curlyKey];

  const plain = raw.match(/^\$(\w+)$/);
  const plainKey = plain?.[1];
  if (plainKey) return process.env[plainKey];

  return raw;
}

export function getDaxApiUrl(): string {
  const provider = getDaxProviderConfig();
  const baseUrl = provider.baseUrl;
  if (!baseUrl) {
    throw new Error(
      `DAX: "local-dax" provider is missing "baseUrl" in models.json.`
    );
  }
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/chat/completions")) return normalized;
  return `${normalized}/chat/completions`;
}

export function getDaxModel(): string {
  const provider = getDaxProviderConfig();
  const modelId = provider.models?.[0]?.id;
  if (!modelId) {
    throw new Error(
      `DAX: no model defined under "local-dax" provider in models.json. ` +
      `Add at least one model entry:\n` +
      `  "local-dax": { "models": [{ "id": "qwen-4b", ... }], ... }`
    );
  }
  return modelId;
}

export function getDaxApiKey(): string {
  const provider = getDaxProviderConfig();
  if (!provider.apiKey) {
    throw new Error(
      `DAX: "local-dax" provider is missing "apiKey" in models.json. ` +
      `For local LLMs that don't require auth, use "apiKey": "placeholder". ` +
      `For OpenAI-style APIs, set "apiKey": "$OPENAI_API_KEY" for env var.`
    );
  }
  const resolved = resolveApiKey(provider.apiKey);
  if (!resolved) {
    throw new Error(
      `DAX: "local-dax" provider references env var "${provider.apiKey}" ` +
      `which is not set. Check your environment or use a literal key instead.`
    );
  }
  return resolved;
}
