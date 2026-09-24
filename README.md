# CodeBreak

**English** · [Français](README.fr.md)

A command-line LLM router with an interface that feels like Claude Code. You describe your task; CodeBreak decides **which tool and which model** runs it, then **verifies the result** and **escalates** if it did not work.

Driven tools: **Claude Code** (Opus / Sonnet / Haiku), **OpenCode** (free models), **Ollama** (local models), **Copilot** (VS Code agent chat), **Gemini CLI**, **Mistral Vibe**, **aider**, **LM Studio** and **llama.cpp**.

```
> Rename the variable foo to bar in utils.ts
⏺ Route → Ollama ministral-3:8b · complexity 1/5 · deploy/refactor
  ⎿ complexity 1/5 → level 0 (profile balanced)
    escalation: Ollama ministral-3:8b → OpenCode Nemotron Ultra → Sonnet
    classifier: rules (confidence 0.85)

> Analyse this authentication and fix the vulnerabilities
⏺ Route → Claude Opus · complexity 4/5 · auth_security · security
  ⎿ security + hard task → Opus preferred
```

## Language

The interface and the messages are available in **English and French**. By default CodeBreak follows your system language (French if your locale starts with `fr`, English otherwise). To force it:

```bash
codebreak --lang en                # for this run
codebreak config set language fr   # persistent (auto | fr | en)
CODEBREAK_LANG=en codebreak        # environment variable (takes precedence over the config)
```

Priority: `--lang` / `CODEBREAK_LANG` › `language` in the config › system locale › English. Changing the config from inside the interface (`/config set language en`) applies immediately.

## Installation

Requirements: Node ≥ 22. None of the tools is mandatory: CodeBreak detects what is installed and routes with what it finds.

```bash
npm install
npm run build
npm link            # installs the `codebreak` and `cb` commands
```

Without `npm link`: `node dist/cli.js`, or `npm run dev` while developing.

## Usage

```bash
codebreak                        # interactive interface
codebreak "add a test"           # interactive interface, request already sent
codebreak -p "add a test"        # non-interactive: routes, runs, prints the result
codebreak route "your request"   # only prints the decision (--json available)
git diff | codebreak -p "review this diff"

codebreak detect                 # installed and enabled LLMs, hardware, MLX, quota (hides tools unchecked in /tools)
codebreak models                 # routing targets
codebreak models recommend [category]  # local models suited to THIS machine (--json, --refresh)
codebreak models installed       # every installed model (Ollama, HF, MacWhisper, LM Studio, oMLX)
codebreak models install <name> --yes · codebreak models remove <name> --yes
codebreak tools                  # lists the AI tools ([x]/[ ]) — unchecked = never called
codebreak tools off ollama gemini # disables (persisted) · `on` re-enables · `reset` enables all
codebreak models gemini          # an AI's models and current default (see below)
codebreak models gemini gemini-2.5-flash   # sets the default model
codebreak usage                  # usage of every installed AI + Claude quota
codebreak config init            # creates ~/.config/codebreak/config.yaml
codebreak config set router.model ministral-3:3b
```

Force a target: prefix `@opus`, `@sonnet`, `@haiku`, `@local`, `@free`, `@copilot` (or `--use opus`).

In the interface: `/help`, `/detect`, `/usage`, `/models`, `/discover`, `/tools`, `/context`, `/router`, `/profile`, `/use`, `/route <prompt>` (simulation), `/retry` (reruns on a more powerful target), `/verify on|off`, `/config`, `/clear`, `/exit`.
Shortcuts: **Shift+Tab** switches profile, **Esc** interrupts, **Ctrl+C** interrupts / clears / quits (twice), `\` + Enter for a new line, ↑↓ for history, Tab to complete.

### Enabling/disabling AI tools

`/tools` opens the toggle list: **Space** checks/unchecks, **Enter** confirms, **Esc** cancels, **a** enables all, **n** disables all. An unchecked tool is **never called** — neither to execute, nor as the LLM router, nor through `@alias`/`/use`/`--use` (which then say “disabled” and fall back to automatic routing) — and it disappears from `/detect` (as if it were not installed). `/tools` itself always shows everything, unchecked ones included, so you can re-enable them. The choice is persisted (`<tool>.enabled: false` in `~/.config/codebreak/config.yaml`). On the command line: `codebreak tools`, `codebreak tools off ollama`, `codebreak tools on claude`, `codebreak tools reset`. Same syntax in the interface, without the list: `/tools off ollama gemini`, `/tools reset`.

### Choosing each AI's model

`/models` shows the routing-target table then guides you in 2 steps: **1/2** pick the AI (the current default is shown for each), **2/2** pick its model (`auto` = CodeBreak decides). **Esc** at step 1 keeps only the table; **Esc** at step 2 goes back to step 1. Shortcuts: `/models <ai>` jumps to step 2, `/models <ai> <model>` applies directly — saved in the config, so persistent. Non-interactive equivalent: `codebreak models [ai] [model]`. Claude has no entry here: the router already picks opus/sonnet/haiku according to the task and the quota (`@opus` to force it once).

For **OpenCode**, the 8 current free models are offered (including `opencode/muse-spark-1.3-contributor-free`): `/models opencode` then Enter on the one you want, or directly `/models opencode opencode/muse-spark-1.3-contributor-free` — the router then picks it first at the free level. One-off: `@opencode/muse-spark-1.3-contributor-free do X` (or `--use`). A model from another provider configured in OpenCode (e.g. `anthropic/claude-sonnet-4-5` with your key) is set the same way and becomes routable; also declare it in `opencode.extra_models` to see it everywhere. If it does not exist on the OpenCode side, execution fails and escalation takes over.

### Discovery: the local AI that fits your machine

`/discover [category]` (or `codebreak models recommend`) answers: *with this machine, which modern AI can I install and use comfortably?* CodeBreak detects your hardware (chip, RAM, GPU/VRAM, Metal/CUDA/ROCm, memory bandwidth), reads the online catalogs (Ollama, Hugging Face, MLX — cached for 24 h, `r` or `--refresh` to re-read) and proposes, per category, **at most 3 models + a single “slow” one**: Code, General, Reasoning, Vision, RAG, Embeddings, Reranking, Speech→text, Text→speech, Image, Video, OCR, Agents.

- 🟢 recommended · 🟡 alternative (reduced margin) · 🐢 slow (one per category, slightly above the comfort zone) · 🔴 excluded (never shown: OOM, swap, unusable throughput).
- **Memory safety**: need = weights + KV cache + runtime overhead, and a margin (`discovery.headroom_gb`, OS/other apps) must always stay free. Adjustable thresholds: `discovery.comfort_ratio`, `alternative_ratio`, `slow_ratio`, `min_tps`, `slow_tps`.
- **One model per provider** and per category (never two Qwen), applied after scoring. The list is never padded artificially.
- **Modernity without a frozen list**: age filter (`max_age_months`), adoption signals (`min_downloads`), then score = quality (popularity + capacity) · freshness · estimated throughput · compatibility. Fine-tunes, merges, adapters and test repos are discarded. An unknown datum (size, throughput) stays “unknown” and excludes the model instead of being invented.
- Detailed sheet (why recommended, why it fits, source, command), **Install** (confirmation then progress: `ollama pull`, `hf download`) and **Delete** (`ollama rm`, purge of the model folder, confirmation, irreversible; safeguard: only under known model folders). After installation, `Use this model` sets it as the router's default Ollama model; the `model-registry.json` registry keeps category, fit and throughput for routing.
- **Inventory of every installed AI** (`/detect`, `codebreak models installed`): Ollama, Hugging Face cache (Pocket TTS, Qwen3-TTS…), MacWhisper (Parakeet, WhisperKit), LM Studio, oMLX, Osaurus, whisper.cpp, Parakeet scripts…, and Python AI packages (mlx-audio, torch…). Each category also shows what is already installed.

### Usage of every installed AI

`/usage` (or `codebreak usage`) starts with a table **per AI installed on the machine** — not only those already used: status, cost (free/included/subscription), default model, and for Claude the live quota; for the others, the number of runs, tokens consumed and the cost in $ when the backend reports it (Claude, OpenCode, Gemini, Vibe, LM Studio, llama.cpp) — or “never used” if detected but not routed yet. The per-model detail (day/week/all) follows below. Aider and Copilot report no tokens: you see runs and average duration.

### Context shared between tools (saving tokens)

When a task changes tool midway (escalation, or resuming a conversation with another backend), CodeBreak used to keep a summary of the latest exchanges to re-inject in clear into the next prompt. For tools that have access to the repository (all but LM Studio/llama.cpp and Ollama in pure chat), they now receive a **short reference** (one line) to a `.md` context file kept up to date by CodeBreak: previous requests, files already modified, summary of results. The model only reads it if it needs to, instead of paying again every turn for the whole history — and it prevents a tool from re-reading the whole repository or redoing work already done by the previous one. `/context` shows that file, `/context clear` empties it. One file per project, in CodeBreak's state (never in the repository); can be disabled with `context.enabled: false`.

### Clipboard (native selection copy, cross-platform image paste)

- **Copying a message:** selecting with the mouse / terminal highlight copies the selected text directly; no `Ctrl+Y` shortcut is needed. Wheel and “Jump to bottom” click are active: to select text, drag with **Option** (macOS) or **Shift** held. `CODEBREAK_MOUSE=0` gives the mouse back to the terminal (free selection, keyboard scrolling with PageUp/PageDown).
- **Copying code:** each block shows `⧉ Copy code`. `Ctrl+Shift+C` copies the last displayed code block and briefly shows `Text copied`.
- **Very long paste:** like Claude Code, a paste of more than **800 characters** or more than **3 lines** is folded in place into `[Pasted text #N +M lines]` to keep the input readable; the full content is kept and sent as-is on submit (line threshold lowered on a short window).
- **Images (macOS, Windows, Linux):** a copied image (screenshot, or copied from a file explorer/browser) is pasted with **Ctrl+V**: it is saved in `$TMPDIR/codebreak-attachments/` and a marker `[Image #N] <path>` appears in the input — the path stays in the prompt so the backend (e.g. Claude Code) can read it. macOS via `osascript`, Windows via PowerShell (`System.Windows.Forms.Clipboard`), Linux via `xclip`/`wl-paste` (X11/Wayland).
- **Navigating the input:** ↑↓ / Ctrl+A · Ctrl+E (or Home/End) for line ends, **Ctrl+←/→** or **Option+←/→** (macOS, depending on the terminal) to jump word by word, Ctrl+W or Option+Backspace to delete the previous word, Ctrl+Del/Option+Del to delete the next. Cmd+←/→ never reaches a terminal program (captured by macOS itself): Option acts as the word jump, as in other Mac apps. For the same reason, click-to-position-cursor is not offered: enabling it would require capturing the mouse for the whole app, which would break the native selection described above.

## How the router decides

```
request ──► rules (FR/EN, instant) ──► confident? ──yes──┐
                     │ no                                 │
                     ▼                                    ▼
        router LLM (small local model)  ─►  merge  ─►  policy  ─►  target + escalation steps
```

1. **Deterministic rules**: category (frontend, backend, auth/security, integration, legal, content, media, SEO/perf, admin, design, deploy/refactor, tests, question), complexity 1-5, security, MCP/vision, context size, need to access the repository.
2. **Router LLM**, only if the rules hesitate (confidence < 0.7): schema-constrained JSON output, temperature 0, result cached. It executes nothing and does not choose the model: it supplies *features*. The rules' critical constraints (security, MCP) cannot be lowered by the LLM.
3. **Policy**: converts those features into a required level, then picks the **cheapest target that is enough**.

| Level | Targets | Cost |
|---|---|---|
| 0 | Ollama · LM Studio · llama.cpp (local, the biggest model that fits in RAM) | free |
| 1 | OpenCode, free models (`nemotron-3-ultra-free`…) · Gemini CLI | free |
| 2 | Claude Haiku · Copilot (VS Code) · Mistral Vibe · aider | quota / included / subscription |
| 3 | Claude Sonnet | quota |
| 4 | Claude Opus | quota |

| Complexity | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| `eco` | 0 | 0 | 1 | 3 | 3 |
| `balanced` (default) | 0 | 1 | 3 | 3 | 4 |
| `quality` | 1 | 3 | 3 | 4 | 4 |

Rules that override complexity: security/auth/legal → **never below Sonnet**; security + hard task → Opus; MCP tools (Figma…) → MCP-compatible target; large context → large window; low confidence → +1 level.

### Sparing the Claude quota

Claude Code exposes the real usage of its 5 h and 7-day windows; CodeBreak reads it (a probe of ~600 Haiku tokens at most every 10 min, plus every Claude run for free) and shows it in the bottom bar.

| Usage (max of the two windows) | Effect |
|---|---|
| < 75 % | normal routing |
| ≥ 75 % *tight* | Opus reserved for critical tasks; complexity 3 → Haiku/Copilot instead of Sonnet |
| ≥ 90 % *critical* | Opus forbidden; Sonnet reserved for tasks that require it (security, MCP, complexity ≥ 4) |
| ≥ 98 % *cut off* | Claude disabled, fallback reported |

A “limit reached” refusal is remembered for 30 min only, so Claude is not cut off for good.

### Escalation and verification

After each attempt that modifies files, CodeBreak runs `typecheck`, `lint` and `test` detected in `package.json` (or your commands). It escalates to the next step (`ladder: [0, 1, 3, 4]`, 3 attempts max) when:

- the backend fails (error, quota),
- a verification fails (the failure output is passed to the next model),
- a free model **announces** a change but modified no file (seen with a 3B model that described the write without performing it).

A task is never “successful” just because the model says so.

### Privacy

A request containing a secret (private key, `sk-…`, `password=…`) is never sent to the cloud: it is processed locally or refused (`privacy.action`). The log only holds metadata, not the prompt text (`logging.content: false`).

## The router role is configurable

`/router` opens a picker; or `codebreak config set router.provider ollama` / `router.model ministral-3:3b`. In `auto`: small Ollama model → free OpenCode model → Claude Haiku → rules only. `router.mode: never` disables the LLM; `always` classifies every request.

## Automatic detection

At launch (≈ 1 s): chip, P/E cores, GPU, RAM, **Apple Silicon / MLX** (and presence of Python `mlx`/`mlx-lm`), battery and low-power mode, memory budget for local models (models that do not fit are discarded); Claude Code (login), OpenCode (free models), Ollama (models, `tools`/`vision` capabilities, server auto-start), VS Code (`code chat`), Gemini CLI, Mistral Vibe, aider, LM Studio (`lms`, models through the OpenAI API) and llama.cpp (`llama-server`/`llama-cli`, GGUF files). Other LLM CLIs found (codex, kimi…) are listed but not routed for now.

## What each backend does

- **Claude Code**: `claude -p --output-format stream-json --model <alias> --permission-mode acceptEdits --allowedTools Bash,WebFetch,WebSearch`, prompt via stdin. Sessions are resumed (`--resume`) from one turn to the next. In non-interactive mode nobody can answer confirmation requests: any tool not allowed is refused (“The user rejected permission…”). Adjust `claude.allowed_tools` (e.g. `["Bash(git *)", "Bash(npm *)"]`) or `claude.permission_mode`.
- **OpenCode**: `opencode run -m opencode/<model> --format json --thinking`, with `OPENCODE_PERMISSION={"*":"allow"}` as long as `opencode.auto_approve` is `true` (default); otherwise tools subject to permission are refused. The model's intermediate reasoning is shown greyed (💭) in the interface as in `-p`; it is neither copyable nor re-injected into the context. Turn it off with `opencode.thinking: false`.
- **Ollama**: question without repository → direct chat (fast, streamed). Repository task → agent mode via OpenCode; since OpenCode sends ~8,000 tokens of instructions, CodeBreak creates a `codebreak-<model>:ctx32k` variant of the model (metadata only, no weight copy; hidden in the interface) with a larger context. Models without the `tools` capability stay in chat.
- **Copilot**: Copilot has no command-line API. CodeBreak opens the project in VS Code then runs `code chat -m agent`. It is a **handoff**: the rest happens in the editor, with no verification or escalation. Automatically selected only when the Claude quota is tight (can be disabled: `copilot.auto_route: false`).
- **Gemini CLI**: `gemini -p … --output-format stream-json --approval-mode <mode> --skip-trust`, NDJSON output (streamed text, tools, usage). Free at low volume; quota errors trigger escalation. If the default model answers **503 / overloaded**, the CLI retries internally (Esc to interrupt): retry later or change model (`/models gemini <model>`, e.g. a `flash`).
- **Mistral Vibe**: `vibe -p … --output streaming --agent <mode> --trust`, JSON lines (messages and tool effects). Requires a paid Mistral subscription: without it, each call fails with **402** with an explicit message and triggers escalation (or `/tools off vibe` to exclude it).
- **aider**: `aider --message … --yes --no-pretty --no-auto-commits …`. Aider exposes no stream: CodeBreak shows its cleaned output and relies on verifications to escalate.
- **LM Studio**: OpenAI-compatible server (`http://localhost:1234`), started via `lms server start` if `lms.autostart`. One target per installed model.
- **llama.cpp**: running `llama-server` → OpenAI API (`http://localhost:8080`); otherwise one-shot generation with `llama-cli` on the GGUF. One target per file found in `llamacpp.models_dirs`.

## Configuration

`~/.config/codebreak/config.yaml` (created by `codebreak config init`), overridden by `.codebreak.yaml` in a project. Full commented reference: [`examples/config.yaml`](examples/config.yaml). No model name is hard-coded for Claude/Ollama: they come from detection. `CODEBREAK_HOME` variable to isolate everything in one folder.

State: `~/.local/state/codebreak/` (`ledger.jsonl` decision and result log, `claude-usage.json` quota, classifier cache, prompt history).

## Known limitations

- Copilot: handoff with no feedback (no captured output).
- aider: unstructured output (no tool stream); escalation relies on verifications.
- Vibe requires a paid Mistral subscription; a refusal (402) triggers escalation.
- LM Studio and llama.cpp only appear if models are installed/discovered.
- The Claude quota is only read through Claude Code (probe + runs); interactive Claude Code usage in parallel shows up at the next refresh.
- OpenCode's free models change over time: adjust `opencode.preferred`.
- Local agent mode is slow on the first call (model loading + ~9,000-token prefill).
- The “estimated savings” in `/usage` compares the tokens of free targets to Sonnet's API price; it is an order of magnitude, not a bill.
- Prompts sent to the router LLM and the shared context file (`/context`) are written in French; models handle both languages.

## Development

```bash
npm test            # vitest (routing, policy, escalation, parsers, config, i18n…)
npm run typecheck
npm run build       # tsup → dist/cli.js
```

Structure: `src/catalog` (Discovery: sources, compatibility, ranking, installer) · `src/commands` (CLI/TUI shared parsing) · `src/detect` (hardware, backends, inventory) · `src/router` (rules, classifier, policy, targets) · `src/backends` (adapters) · `src/exec` (runner, verification, git, shared context) · `src/usage` (quota, log) · `src/i18n` (`t()` and the English dictionary) · `src/ui` (Ink TUI).

### Translating

Every user-facing string goes through `t('French source text')` (`src/i18n/index.ts`); the English translation lives in `src/i18n/en.ts`, keyed by the French text, with `{name}` placeholders. `test/i18n.test.ts` fails if a string has no translation, if a translation has an unknown placeholder, or if an entry is unused; `test/i18n-render.test.tsx` renders the screens in English and fails on leftover French. To add a language, add its dictionary and extend `Lang` in `src/i18n/index.ts`.
