# Contributing to CodeBreak

Thanks for your interest! CodeBreak is MIT-licensed and welcomes issues and pull requests.

## Setup

```bash
npm install
npm run typecheck && npm test   # must pass before you open a PR
npm run dev                     # run the TUI from source
```

Node ≥ 22 is required. None of the AI tools CodeBreak drives is needed to run the tests.

## Guidelines

- **Keep the router honest.** Routing, escalation and verification rules live in `src/router` and `src/exec`; changes there need tests in `test/`.
- **Discovery never invents data.** `src/catalog` must keep unknown values as unknown (and exclude the model) rather than guess. No hard-coded list of "modern" models: recommendations come from catalog data and scores.
- **Every user-facing string goes through `t()`** (`src/i18n`). Add the English translation to `src/i18n/en.ts`; `test/i18n.test.ts` and `test/i18n-render.test.tsx` fail otherwise. New language? Add a dictionary and extend `Lang`.
- **Business logic stays out of Ink components.** Put it in `src/catalog`, `src/commands` or `src/router` and keep `src/ui` presentational; reuse `src/ui/kit` for panels and lists.
- Prefer small, focused commits using [Conventional Commits](https://www.conventionalcommits.org/) (`feat(router): …`, `fix(ui): …`).

## Reporting bugs

Please include your OS, Node version, the output of `codebreak detect`, and (if relevant) `CODEBREAK_DEBUG=1` output. Never paste secrets: CodeBreak's log stores metadata only.
