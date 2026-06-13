# π-DAX — Dual Active eXtension

**DAX** is a *symbiont* for the [Pi coding agent](https://pi.dev).

In *Star Trek: Deep Space Nine*, the Dax symbiont joins with a host, carrying the memories and wisdom of past lifetimes. **π-DAX** brings that same spirit to LLM-assisted development: a lightweight secondary model joins with the primary worker model, offering real-time peer review, loop detection, and oversight — not as a command-and-control watchdog, but as an **active partner** that helps the host produce better code.

---

## How It Works

Example: Two local models communicate via `llama.cpp` (or any OpenAI-compatible server):

| Role | Model | Port | Responsibility |
|------|-------|------|---------------|
| **Host** (Worker) | Gemma 4 12B | `:8080` | Drives the conversation, writes code, executes tools |
| **DAX** (Symbiont) | Qwen 3.5 4B | `:8081` | Reviews every edit, detects loops, prunes repeating context |

DAX hooks into three Pi lifecycle events:

- **`tool_call`** — Tracks tool repetition for loop detection; intercepts `write`/`edit` and sends the proposed change to DAX for peer review. If DAX finds bugs, the edit is blocked and feedback is returned to the host.
- **`message_end`** — Heuristic loop detection via Jaccard similarity of consecutive assistant messages.
- **`context`** — Queries the DAX LLM for semantic loop verification; prunes looping turns and injects a steering warning when a loop is confirmed.

---

## Project Structure

```
pi-dax/
├── src/
│   ├── index.ts          # Extension entry point (default export, event handlers)
│   ├── config.ts         # DAX provider configuration (models.json, API keys)
│   ├── peer-review.ts    # Code review logic (reviewCodeChange)
│   └── loops.ts          # Loop detection & pruning utilities
├── tests/                # Test files
├── package.json          # Package manifest with pi.extensions registration
├── tsconfig.json         # TypeScript configuration
├── README.md             # You are here
└── LICENSE               # MIT
```

---

## Setup

### Prerequisites

- [Pi coding agent](https://github.com/anomalyco/pi-coding-agent) installed
- Two `llama.cpp` server instances (or any OpenAI-compatible API)

### Step 1: Start the llama.cpp Servers

**Host (Worker, port 8080):**
```bash
./llama-server -m models/gemma-4-12b.gguf --port 8080
```

**DAX (Symbiont / Reviewer, port 8081):**
```bash
./llama-server -m models/qwen-4b.gguf --port 8081
```

### Step 2: Configure Pi Models (`models.json`)

Edit `~/.pi/agent/models.json` to register the models. You can either run both models locally (Option A), or route the DAX symbiont to a remote API provider like OpenRouter or OpenAI (Option B). 

> [!IMPORTANT]
> The provider key in the `providers` object **must** be exactly named `"local-dax"`, as the extension explicitly looks up this identifier under the hood—even when it resolves to a remote endpoint.

#### Option A: Fully Local Setup (Gemma + Qwen)
For a fully offline setup using two local `llama.cpp` servers:

```json
{
  "providers": {
    "local-worker": {
      "baseUrl": "http://localhost:8080/v1",
      "api": "openai-completions",
      "apiKey": "local",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "gemma-4-12b",
          "name": "Gemma 4 12B (Host)",
          "contextWindow": 262144
        }
      ]
    },
    "local-dax": {
      "baseUrl": "http://localhost:8081/v1",
      "api": "openai-completions",
      "apiKey": "local",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "qwen-4b",
          "name": "Qwen 3.5 4B (DAX)",
          "contextWindow": 262144
        }
      ]
    }
  }
}
```

*Note: For local llama-servers, the `apiKey` can be any placeholder string.*

#### Option B: Remote Setup (e.g., OpenRouter / any OpenAI-compatible API)
If you prefer not to run a local server for the symbiont, configure the `"local-dax"` provider to point to a remote endpoint by supplying their base URL, model ID, and API key environment variable (which the extension will resolve in real time):

```json
{
  "providers": {
    "local-dax": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "api": "openai-completions",
      "apiKey": "$OPENROUTER_API_KEY",
      "models": [
        {
          "id": "qwen/qwen-2.5-7b-instruct",
          "name": "Qwen 2.5 7B (DAX)",
          "contextWindow": 32768
        }
      ]
    }
  }
}
```

### Step 3: Configure Default Session Model

Create a project-local `.pi/settings.json`:

```json
{
  "defaultModel": "local-worker/gemma-4-12b",
  "defaultProjectTrust": "trust"
}
```

### Step 4: Load DAX

**Option A — Install from npm (once):**
```bash
pi install npm:pi-dax
```

**Option B — Load from path (for local development):**
```bash
pi -e /path/to/pi-dax/src/index.ts
```

Look for the startup notification:

> `DAX symbiont active — peer review & loop prevention on port 8081`

### Commands

- `/dax` — Show current DAX status
- `/dax review on` / `/dax review off` — Toggle peer code review

---

## Development

```bash
npm install
npm run typecheck   # TypeScript type checking
npm test            # Run tests
```

---

## The Symbiont Philosophy

DAX is not a supervisor. It is a **symbiont** — a partner that enhances the host without replacing it. The host makes the decisions and drives the work; DAX offers its accumulated wisdom in two critical moments:

- **Before a file is written** — reviewing code with fresh eyes
- **When the host stalls** — recognizing the loop and clearing the path forward

This symbiotic relationship gives the host the benefit of a second model's perspective without the overhead of explicit hand-offs, context switching, or multi-agent orchestration.

---

## License

MIT
