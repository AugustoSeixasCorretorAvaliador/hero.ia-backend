# Backend – WhatsApp Draft API

## Fluxo de seleção (determinístico)
- Critério: **bairro primeiro, depois nome**. Tipologia não filtra; só descreve.
- Sem nome/bairro claro: não consulta base/LLM; responde fallback pedindo nome ou bairro e tipologia.

## Endpoint principal
- `POST /whatsapp/draft` (requer header `x-user-key` de licença) — gera rascunho via motor determinístico + LLM.

## Endpoint interno de debug (sem licença, sem LLM)
- `GET /debug/match?q=<texto>` — retorna razão do match, bairros detectados e lista de itens com nome/bairro/tipologia/entrega.
- Exemplos rápidos:
  - `/debug/match?q=Pulse` → deve trazer apenas Pulse by Soter.
  - `/debug/match?q=Icarai` → retorna todos os empreendimentos de Icaraí.
  - `/debug/match?q=Piratininga` → retorna todos de Piratininga.
  - `/debug/match?q=quero%203q` → razão `none`, lista vazia (cai no fallback no fluxo normal).

### Comandos de teste (localhost:3001)
- `curl "http://localhost:3001/debug/match?q=Pulse"`
- `curl "http://localhost:3001/debug/match?q=Icarai"`
- `curl "http://localhost:3001/debug/match?q=Piratininga"`
- `curl "http://localhost:3001/debug/match?q=quero%203q"`

## Execução local
- `npm install`
- `npm start` (ou `node server.js`) — porta padrão `3001`.
- Variáveis principais: `OPENAI_API_KEY`, `PORT`, `APPEND_SIGNATURE`, `APPEND_SIGNATURE_MODE`, `SIGNATURE`.

## Notas de comportamento
- Fallback padrão: "Perfeito. Para eu te direcionar com precisão, me diga, por favor, o nome do empreendimento ou o bairro com a tipologia (ex: studio, 2q, 3q, 4q). Assim, consigo te apresentar as opções mais adequadas dos empreendimentos. 😊" pedindo nome/bairro + tipologia antes de listar opções.
- Assinatura só é anexada conforme heurística de fechamento (configurável via `.env`).
