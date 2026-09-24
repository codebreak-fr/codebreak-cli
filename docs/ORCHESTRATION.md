# Orchestration roadmap: audit and plan

Status: phase 1 (audit) — the baseline was 195 passing tests, `tsc` clean.

## 1. What exists (audit)

| Concern | Where | State |
|---|---|---|
| Agents / processes | `src/backends/*` (`runTarget` switch, `Adapter` = async generator of `RunEvent`) | One function per tool; no `detect/health/usage/capabilities/stop`; capabilities live in `Target.caps` (`router/targets.ts`) |
| Routing | `src/router/{heuristics,classifier,policy,targets,index}.ts` | Solid: rules → optional LLM → policy (levels 0-4, profiles, quota, privacy). Outputs `Decision.chain` |
| Quotas | `src/usage/claude.ts`, `types.ts` (`ClaudeUsage`) | **Claude only.** Reads the official `rate_limit_event` of `claude -p --output-format stream-json` (mirror of the `anthropic-ratelimit-unified-*` headers) with a Haiku probe. No source / timestamp / confidence; other tools only surface a generic `error.kind = 'quota'` |
| Markdown memory | `src/exec/context.ts` | One shared recap per project, stored **outside** the repo (state dir), appended per turn, referenced by one line. No structure, no selection, no redaction |
| Verification | `src/exec/verify.ts` | typecheck/lint/test from `package.json`; keeps a merged, truncated output; no exit code/stderr split |
| Git | `src/exec/git.ts` | `snapshot()` = hash of status+diff; **`changedFiles()` returns every dirty file after the attempt, so pre-existing user edits are attributed to the agent**; no rollback |
| Escalation | `src/exec/runner.ts` | Any failure → next target of a fixed ladder. No failure diagnosis, no same-agent retry, no repeated-failure detection, no time/cost budget, no per-attempt timeout |
| Model discovery | `src/catalog/*` | Compatibility from estimates only (no measurement); recommendations = "compatible" |
| UI | `src/ui/*` | Ink TUI, shared kit; no per-task view, no timeline |
| Tests | `test/*` | Router policy, runner (with an injectable `runner`), parsers, catalog, i18n, UI |

Duplications / fragile spots worth fixing (without rewriting): the ad-hoc `quota` regexes in `backends/claude.ts`; the `changedFiles` approximation; the fixed ladder in `runner.ts`; the legacy state-dir context that cannot be edited by hand.

## 2. Decisions

- **Keep** the router, the backends, the legacy shared context file and every existing command. New behaviour is additive and configurable.
- **Memory** becomes `.codebreak/` **inside the project** (human-readable Markdown, YAML frontmatter for tasks). The legacy recap keeps working as the per-turn log. `.codebreak/.gitignore` keeps volatile files out of commits.
- **Every number about a limit carries `source` (observed / estimated / unknown), `observedAt`, `confidence`.** Nothing is guessed; unknown stays `unknown`.
- **Official surfaces only.** Claude: the `rate_limit_event` stream (and, for API-key users who opt in, `anthropic-ratelimit-*` response headers). CodeBreak never reads Claude Code's OAuth credentials and never scrapes authenticated web pages.
- Every automatic decision produces a list of human-readable reasons.

## 3. Plan (one commit per phase, tests first-class)

1. Audit + plan (this file).
2. Markdown memory layout, redaction, task manifest, failures/sessions writers.
3. Context Builder (relevance selection with an explain mode: `/context why`).
4. Git snapshots (temp-index tree snapshots), correct per-attempt diffs, rollback.
5. Failure diagnosis + retry/escalate strategy + runner integration + budgets.
6. `UsageMonitor` (observed/estimated/unknown) with Claude first: unified windows, rate-limit headers, rejected/429.
7. Providers for the other agents (OpenCode, Gemini, Copilot/VS Code, Codex if present, API keys, local runtimes).
8. Multi-criteria scheduler with explainable decisions.
9. Discovery: measured throughput/load time/tool-calling/coding smoke tests, cached; "compatible" vs "benchmarked".
10. Observability: per-task timeline, `/task` panel, debug mode, docs, end-to-end tests.
