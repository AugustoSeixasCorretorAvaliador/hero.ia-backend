## Purpose
This file gives concise, repository-specific instructions for AI coding agents working on the WhatsApp draft backend.

## High-level overview
- **What:** Node.js Express service that builds an LLM prompt and returns a WhatsApp-ready draft message.
- **Run:** `npm start` runs `node server.js` (see [package.json](package.json)).
- **Persona & Language:** The system/UX is Portuguese. Prompts enforce the persona "Augusto Seixas" and a consultative, objective tone (see [prompt.js](prompt.js)).

## Key files to inspect
- `server.js` — Express routes, OpenAI client usage, synchronous data load ([server.js](server.js)).
- `prompt.js` — Prompt builder that composes system rules + conversation + filtered listings ([prompt.js](prompt.js)).
- `data/empreendimentos.json` — canonical source of empreendimento records; fields: `nome`, `bairro`, `tipologia` (array), `perfil`, `descricao` ([data/empreendimentos.json](data/empreendimentos.json)).

## Runtime & env
- Requires `OPENAI_API_KEY` in environment (dotenv used in [server.js](server.js)).
- Server listens on port `3001` by default.
- Data is loaded at startup via `fs.readFileSync` — edits to `data/empreendimentos.json` require a server restart.

## API contract
- POST `/draft` with JSON body: `{ mensagens: string[], bairro?: string, tipologia?: string }`.
- Response: `{ draft: string }` containing the LLM-generated WhatsApp draft (see [server.js](server.js)).

## Prompt & content rules (critical)
- The prompt enforces strict rules (no generic answers, cite real empreendimento names, avoid vague closing questions). Agent must preserve these rules when editing `prompt.js` or generating examples.
- Do NOT invent empreendimento names. Use entries from [data/empreendimentos.json](data/empreendimentos.json).

## Known issues & gotchas
- `prompt.js` currently contains a template bug in its `.map(...)` usage. Fix example:

  .map(e => `${e.nome} (${e.bairro}) | ${e.tipologia.join(", ")}`)

  Without the inner template backticks the generated prompt will throw or produce incorrect text.
- OpenAI usage uses `openai.chat.completions.create({ model: "gpt-4o-mini", messages: [...] })` and returns `completion.choices[0].message.content`. Keep that shape when testing.

## Editing guidance
- When changing prompt rules, keep statements concise and Portuguese; tests or manual checks should confirm the generated draft respects the rules.
- Small data edits are fine, but remember to restart the server after changes to `data/empreendimentos.json`.
- Follow existing naming and Portuguese conventions: variable names and comments are Portuguese; mirror that when adding code.

## Suggested quick checks for pull requests
- Run `npm start` and POST a small `/draft` payload to validate end-to-end behavior.
- Verify prompt string builds without syntax errors (lint or run the server).
- Confirm generated drafts cite only names present in `data/empreendimentos.json`.

## References
- [server.js](server.js) — route and OpenAI usage
- [prompt.js](prompt.js) — prompt template and constraints
- [data/empreendimentos.json](data/empreendimentos.json) — source of truth for listings

If anything above is unclear or you'd like a different level of detail (examples, tests, or a fix PR), tell me which part to expand.
