# CodeBreak (`cb`) — specification for LLMs

**English** · [Français](SPEC.fr.md)

> This document describes the `cb` command-line tool (alias of `codebreak`) so that an LLM can explain it, use it or call it correctly. Everything written here comes from the repository's code.

## 1. Summary

`cb` is a **CLI LLM router** (Node ≥ 22, TypeScript, Ink TUI). The user describes a development task. `cb`:

1. **Classifies** the task (category, complexity 1–5, security, MCP/vision need, context size, repository access);
2. **Picks** the AI tool and the model, **the cheapest one that is enough**;
3. **Runs** the task through that tool's CLI or API;
4. **Verifies** the result (typecheck, lint, tests);
5. **Escalates** to a more powerful target if it fails.

`cb` is **not** a model: it drives existing tools. None is mandatory; it detects what is installed. The interface exists in English and French (`--lang en|fr|auto`, `language` in the config, `CODEBREAK_LANG`).

## 2. Driven tools

| Backend | Role | Level | Cost |
|---|---|---|---|
| Ollama, LM Studio, llama.cpp | local models | 0 | free |
| OpenCode (free models), Gemini CLI | free cloud | 1 | free |
| Claude Haiku, Copilot (VS Code), Mistral Vibe, aider | intermediate | 2 | quota / subscription |
| Claude Sonnet | strong | 3 | quota |
| Claude Opus | strongest | 4 | quota |

Copilot is a **handoff**: `code chat -m agent` opens VS Code, with no captured output, no verification and no escalation. Vibe requires a paid Mistral subscription (otherwise error 402 then escalation).

## 3. Installation

```bash
npm install && npm run build && npm link   # installs `codebreak` and `cb`
node dist/cli.js                           # without npm link
npm run dev                                # development (tsx)
```

## 4. Command-line interface

### General usage

```
cb                          interactive TUI
cb "request"                TUI, request already sent
cb -p "request"             non-interactive: routes, runs, prints the result
cb route "request" [--json] only prints the routing decision
git diff | cb -p "review this diff"     # stdin accepted
```

### Options

| Option | Effect |
|---|---|
| `-p`, `--print` | non-interactive mode |
| `--use <target>` | forces the target: `opus sonnet haiku local free copilot gemini vibe aider lms llama` |
| `--profile <p>` | `eco` \| `balanced` \| `quality` |
| `--lang <l>` | `fr` \| `en` \| `auto`: interface language |
| `--router <provider[:model]>` | who classifies the task: `ollama:ministral-3:3b`, `opencode`, `claude:haiku`, `rules` |
| `--dry-run` | with `-p`: decision without execution |
| `--json` | JSON output |
| `--cwd <folder>` | working directory |
| `-q`, `--quiet` | fewer messages |
| `--refresh` | (`models recommend\|install`) re-reads the online catalog |
| `-y`, `--yes` | confirms `models install\|remove` without asking |
| `-v`, `--version` · `-h`, `--help` | |

Prefixes in the request to force a target: `@opus`, `@sonnet`, `@haiku`, `@local`, `@free`, `@copilot`, `@opencode/<model>`.
Example: `cb -p "@sonnet refactor src/auth.ts"`.

### Subcommands

| Command | Effect |
|---|---|
| `cb detect` | installed/enabled LLMs, hardware (chip, RAM, GPU/VRAM, MLX), inventory of local AI (MacWhisper, HF, LM Studio, oMLX…), Claude quota |
| `cb models` | routing targets |
| `cb models recommend [category] [--json] [--refresh]` | local models suited to the machine (max 3 + 1 slow per category, 1 per provider) |
| `cb models installed` | every installed model (Ollama, HF, MacWhisper, LM Studio, oMLX) |
| `cb models install <name> --yes` / `cb models remove <name> --yes` | installs / deletes |
| `cb tools` | list of tools `[x]`/`[ ]` |
| `cb tools off <tool…>` / `on <tool…>` / `reset` | enables/disables (persisted). An unchecked tool is **never called** |
| `cb models <ai>` / `cb models <ai> <model>` | an AI's models / sets its default model (persisted) |
| `cb usage` | usage of every installed AI + Claude quota |
| `cb config init` | creates `~/.config/codebreak/config.yaml` |
| `cb config set <key> <value>` | e.g. `router.model ministral-3:3b`, `language en` |

### Exit codes
`2` = unknown or disabled target (`--use`). Other cases follow the run result (0 = success).

## 5. TUI commands

`/help /detect /usage /models /discover [category] /tools /context /router /profile /use /route <prompt> /retry /verify on|off /config /clear /exit`

- `/route <prompt>` simulates without running; `/retry` reruns on a more powerful target.
- `/models`: step 1/2 pick the AI, step 2/2 pick the model (`auto` = cb decides). `/models <ai> <model>` applies directly.
- `/discover [category]`: local models suited to the machine; install and delete from the panel.
- `/context` shows the shared context file; `/context clear` empties it.

Shortcuts: Shift+Tab (switch profile), Esc (interrupt), Ctrl+C (interrupt / clear / quit), `\`+Enter (new line), ↑↓ history, Tab completion, Ctrl+V pastes an image, Ctrl+Shift+C copies the last code block.

## 6. Routing algorithm

```
request → deterministic rules (FR/EN) → confidence ≥ 0.7 ? ─yes─┐
                    │ no                                         │
                    ▼                                            ▼
     router LLM (small model, constrained JSON) → merge → policy → target + escalation ladder
```

1. **Rules**: category (frontend, backend, auth_security, integration, legal, content, media, SEO/perf, admin, design, deploy/refactor, tests, question), complexity 1–5, security, MCP/vision, context size, repository access.
2. **Router LLM** only if confidence < 0.7: temperature 0, JSON output, result cached. It supplies *features*, never the model choice. It cannot lower the rules' critical constraints (security, MCP). Order in `auto`: small Ollama model → free OpenCode model → Claude Haiku → rules only. `router.mode`: `never` (no LLM), `always`.
3. **Policy**: features → required level → cheapest suitable target.

### Profile × complexity → level

| Complexity | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| `eco` | 0 | 0 | 1 | 3 | 3 |
| `balanced` (default) | 0 | 1 | 3 | 3 | 4 |
| `quality` | 1 | 3 | 3 | 4 | 4 |

### Overriding rules
- security / auth / legal → never below Sonnet;
- security + hard task → Opus;
- MCP tools (e.g. Figma) → MCP-compatible target;
- large context → large window;
- low confidence → +1 level.

### Claude quota
Read from Claude Code (5 h and 7 d windows; ~600-token Haiku probe at most every 10 min).

| Usage (max of the 2 windows) | Effect |
|---|---|
| < 75 % | normal |
| ≥ 75 % | Opus reserved for critical tasks; complexity 3 → Haiku/Copilot |
| ≥ 90 % | Opus forbidden; Sonnet reserved (security, MCP, complexity ≥ 4) |
| ≥ 98 % | Claude disabled |

A “limit reached” refusal is only remembered for 30 min.

## 7. Execution, verification, escalation

- After each attempt that modifies files: `typecheck`, `lint`, `test` (detected in `package.json` or configured commands).
- Default ladder `ladder: [0, 1, 3, 4]`, **3 attempts max**.
- Escalation if: the backend fails (error/quota); a verification fails (the output is passed to the next model); a free model announces a change without having modified any file.
- Principle: a task is never “successful” because the model says so.

## 8. Context shared between tools

When the tool changes (escalation or resume), backends with repository access receive a **one-line reference** to a `.md` kept by cb (previous requests, modified files, summary), instead of the full history. One file per project, stored in cb's state, never in the repository. Can be disabled: `context.enabled: false`. LM Studio, llama.cpp and Ollama in pure chat receive a summary in clear.

## 9. Privacy

A request containing a secret (private key, `sk-…`, `password=…`) is **never sent to the cloud**: processed locally or refused (`privacy.action`). The log only holds metadata (`logging.content: false`).

## 10. Commands run per backend

- **Claude Code**: `claude -p --output-format stream-json --model <alias> --permission-mode acceptEdits --allowedTools Bash,WebFetch,WebSearch`, prompt on stdin, `--resume` between turns. Settings: `claude.allowed_tools`, `claude.permission_mode`.
- **OpenCode**: `opencode run -m opencode/<model> --format json --thinking`, `OPENCODE_PERMISSION={"*":"allow"}` if `opencode.auto_approve` (default true). Reasoning shown greyed; `opencode.thinking: false` turns it off.
- **Ollama**: question without repository → direct chat; repository task → agent via OpenCode with a `codebreak-<model>:ctx32k` variant (metadata only). Models without the `tools` capability → chat.
- **Gemini CLI**: `gemini -p … --output-format stream-json --approval-mode <mode> --skip-trust`.
- **Mistral Vibe**: `vibe -p … --output streaming --agent <mode> --trust`.
- **aider**: `aider --message … --yes --no-pretty --no-auto-commits` (no stream; escalation through verifications).
- **LM Studio**: OpenAI-compatible API `http://localhost:1234` (`lms server start` if `lms.autostart`).
- **llama.cpp**: `llama-server` (API `http://localhost:8080`) otherwise `llama-cli` on a GGUF (`llamacpp.models_dirs`).

## 11. Configuration and files

- Global: `~/.config/codebreak/config.yaml`; project: `.codebreak.yaml` (override). Commented reference: `examples/config.yaml`.
- State: `~/.local/state/codebreak/` — `ledger.jsonl` (decisions/results), `claude-usage.json`, classifier cache, prompt history, `catalog-cache.json` (Discovery), `model-registry.json` (installed models and their fit).
- `CODEBREAK_HOME` isolates everything in one folder; `CODEBREAK_MOUSE=0` gives the mouse back to the terminal; `CODEBREAK_LANG=fr|en` forces the language.
- No Claude/Ollama model name is hard-coded: they come from detection.
- Useful keys: `<tool>.enabled`, `language`, `router.provider`, `router.model`, `router.mode`, `opencode.preferred`, `opencode.extra_models`, `copilot.auto_route`, `privacy.action`, `context.enabled`, `logging.content`, `discovery.*`.

## 12. Discovery (local AI suited to the machine)

`/discover` and `cb models recommend` detect the hardware, read the catalogs (Ollama, Hugging Face, MLX; cache 24 h) and score models per category (Code, General, Reasoning, Vision, RAG, Embeddings, Reranking, STT, TTS, Image, Video, OCR, Agents). Verdicts: 🟢 recommended · 🟡 alternative · 🐢 slow (max 1 per category) · 🔴 excluded (never shown). Need = weights + KV cache + runtime overhead + a safety margin. One model per provider per category, max 3 + 1 slow, never padded. Unknown data (size, throughput) excludes the model instead of being guessed. Install (`ollama pull`, `hf download`) and delete (`ollama rm`, model-folder purge) from the panel or `cb models install|remove <name> --yes`.

## 13. Known limitations

- Copilot: handoff without feedback; aider: unstructured output.
- LM Studio / llama.cpp only appear if models exist.
- Claude quota only read through Claude Code (refreshed with a delay).
- OpenCode's free models vary: adjust `opencode.preferred`.
- Local agent mode slow on the first call (~9,000-token prefill).
- The “estimated savings” of `/usage` is an order of magnitude (Sonnet API price), not a bill.
- Other detected CLIs (codex, kimi…): listed, not routed.
- Only Ollama models are driven by the router; MLX/Hugging Face models from Discovery are download-only for now.

## 14. Code structure

`src/catalog` (Discovery) · `src/commands` (CLI/TUI shared parsing) · `src/detect` (hardware, backends, inventory) · `src/router` (rules, classifier, policy, targets) · `src/backends` (adapters) · `src/exec` (runner, verification, git, context) · `src/usage` (quota, log) · `src/i18n` (`t()`, English dictionary) · `src/ui` (Ink TUI) · `src/cli.tsx` (entry, args) · `src/oneshot.ts` (`-p` mode). Tests: `npm test` (vitest), `npm run typecheck`, `npm run build` (tsup → `dist/cli.js`).

## 15. Examples

```bash
cb route "Rename foo to bar in utils.ts" --json
# → primary: ollama, complexity 1, escalation chain: ollama → opencode → sonnet

cb -p --profile quality "Analyse the auth and fix the vulnerabilities"
# → Claude Opus (security + hard task)

cb -p --use free "Explain this code" < src/router/policy.ts
cb tools off vibe gemini
cb models opencode opencode/muse-spark-1.3-contributor-free
cb models recommend stt --json
```

## 16. Tips for an LLM calling `cb`

- To know the choice at no cost: `cb route "<prompt>" --json` or `cb -p --dry-run --json`.
- Non-interactively, always `-p`; confirmations for non-allowed tools are refused automatically.
- To force a model: `--use` or an `@alias` prefix, otherwise let the router decide.
- Do not assume a tool is available: check with `cb detect` / `cb tools`.
- Never put secrets in the prompt.
