# HEROIA-FULL-Nuven
Node.js Express backend com integração OpenAI para endpoints do WhatsApp.
## Requisitos
- Node.js 16+
- OpenAI API Key
## Instalação
```bash
npm install
```
## Configuração
1. Copie `.env.example` para `.env`:
```bash
cp .env.example .env
```
2. Configure as variáveis de ambiente no arquivo `.env`:
- `OPENAI_API_KEY`: Sua chave da API OpenAI
- `OPENAI_MODEL`: Modelo OpenAI a usar (padrão: gpt-4o-mini)
- `SUPABASE_URL`: URL do projeto Supabase
- `SUPABASE_SERVICE_ROLE_KEY`: Service role key do Supabase (usada apenas no backend)
- `APP_REQUIRE_LICENSE`: Define se validação de licença é obrigatória (padrão: true)
- `APPEND_SIGNATURE`: Define se deve adicionar assinatura às respostas (true/false)
- `SIGNATURE`: Texto da assinatura a ser adicionado
3. Licenciamento agora é centralizado no Supabase. Nenhum arquivo JSON local é usado para licenças.
## Execução
```bash
node backend/server.js
```
O servidor inicia na porta 3002 por padrão (ou `PORT` no `.env`).
## Endpoints

### POST /api/license/activate
Ativa ou valida uma licença centralizada no Supabase.
- Body (PWA): `{ "license_key": "...", "email": "...", "device_id": "...", "notes": "PWA", "source": "PWA" }`
- Body (Extensão Chrome): `{ "license_key": "...", "email": "...", "device_id": "...", "notes": "ECWW", "source": "ECWW" }`
- O backend salva o campo notes (e utiliza source para diferenciar a origem). Outros campos como email, device_id, activated_at e last_used também são atualizados.
- Respostas possíveis:
  - 200 `{ "status": "active", "expires_at": "2026-01-04T00:00:00.000Z" }`
  - 403/404 com `{ error: "motivo" }`

### POST /whatsapp/draft
Gera um rascunho de resposta para mensagem do WhatsApp.
- Headers obrigatórios (se `APP_REQUIRE_LICENSE=true`):
  - `x-license-key`: chave de licença
  - `x-device-id`: device_id vinculado
- Body: `{ "message": "Mensagem do cliente" }` ou `{ "mensagens": ["msg1", "msg2"] }`
- Resposta: `{ "draft": "...", "followups": ["..."], "raw": {} }`

### POST /whatsapp/copilot
Analisa mensagem e fornece análise, sugestão e rascunho.
- Headers obrigatórios (se `APP_REQUIRE_LICENSE=true`): `x-license-key`, `x-device-id`
- Body: `{ "messages": [{ "author": "cliente", "text": "..." }] }`
- Resposta: `{ "analysis": "...", "suggestion": "...", "draft": "..." }`

### GET /health
Verifica status do servidor.
- Resposta: `{ "ok": true, "license": true }`

### POST /admin/license
Administra status da licença (fonte de verdade: coluna `status` em `licenses`).
- Body: `{ "license_key": "...", "action": "active" | "blocked", "token": "..." }`
- Header: `Content-Type: application/json`
- Proteção simples por token: `ADMIN_TOKEN` (default `heroia_app_admin`). Defina no `.env`.
- Atualiza `licenses.status` e registra evento em `license_activations`.
- Resposta: `{ ok: true, license_key: "...", status: "active" | "blocked" }`

## 🌐 Deploy no Render

1. Conecte seu repositório ao Render
2. Configure as variáveis de ambiente:
   - `PORT` (Render define automaticamente)
   - `NODE_ENV=production`
3. O Render executará automaticamente `npm install` e `npm start`

### Configurações do Render:
- **Build Command:** `npm install`
- **Start Command:** `npm start`
- **Environment:** Node
- **Node Version:** 14 ou superior

## 🔧 Integração com Extensão

A extensão de navegador deve fazer requisições POST para os endpoints:

```javascript
const headers = {
  'Content-Type': 'application/json',
  'x-license-key': activation.license_key,
  'x-device-id': activation.device_id
};

fetch('https://seu-app.render.com/whatsapp/draft', {
  method: 'POST',
  headers,
  body: JSON.stringify({ message })
});

fetch('https://seu-app.render.com/whatsapp/copilot', {
  method: 'POST',
  headers,
  body: JSON.stringify({ messages })
});
```

## 📦 Dependências

- **express**: Framework web para Node.js
- **dotenv**: Carregamento de variáveis de ambiente
- **cors**: Habilitação de CORS para requisições cross-origin
- **openai**: Cliente OpenAI v4

## 🖥️ Painel Admin (HTML)

- Arquivo: `heroia_app_admin/index.html`
- Aponta por padrão para `http://localhost:3002/admin/license`.
- Preencha License Key e o `ADMIN_TOKEN` (mesmo valor definido no backend). Botões “Ativar” e “Bloquear” enviam para o endpoint e exibem o status retornado.

## 🛡️ Segurança

- Tratamento de erros não capturados
- Validação básica de entrada
- CORS configurado
- Logs de requisições para debug

## Estrutura de Arquivos

- `backend/server.js`: Servidor Express principal
- `backend/data/empreendimentos.json`: Dados dos empreendimentos
- `.env`: Variáveis de ambiente (não versionado)
- `.env.example`: Exemplo de configuração
