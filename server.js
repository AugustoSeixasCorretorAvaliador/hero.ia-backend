import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(express.json({ limit: "200kb" }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const PORT = Number(process.env.PORT || 3002);
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1";

// ===============================
// HEALTH
// ===============================
app.get("/health", (_req, res) => {
  res.json({ ok: true, mode: "rewrite-only" });
});

// ===============================
// ROTA COMPATÍVEL COM PWA
// ===============================
app.post("/whatsapp/draft", async (req, res) => {
  try {
    let { mensagens, message } = req.body || {};

    if (!mensagens && message) mensagens = [message];
    if (!mensagens) {
      return res.status(400).json({ error: "Campo 'mensagens' é obrigatório" });
    }

    if (!Array.isArray(mensagens)) mensagens = [mensagens];

    const msg = mensagens[mensagens.length - 1];
    if (!msg || typeof msg !== "string") {
      return res.status(400).json({ error: "Mensagem inválida" });
    }

    const prompt = `
Você é um especialista em comunicação estratégica no contexto de vendas consultivas.

Refine a mensagem abaixo mantendo exatamente a intenção original, mas tornando-a:

- Mais clara
- Mais organizada
- Mais fluida
- Mais profissional
- Mais estratégica

Regras obrigatórias:
- Não inventar informações.
- Não adicionar dados novos.
- Não incluir assinatura ou dados de contato.
- Não usar listas ou markdown.
- Não explicar o que fez.
- Entregar apenas a mensagem final reescrita.

Mensagem original:
"${msg}"
`;

    const response = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.4,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: msg }
      ]
    });

    const refined = response.choices?.[0]?.message?.content?.trim();

    if (!refined) {
      return res.status(500).json({ error: "Não consegui gerar o rascunho." });
    }

    return res.json({
      draft: refined
    });

  } catch (err) {
    console.error("/whatsapp/draft error", err?.response?.data || err.message || err);
    return res.status(500).json({ error: "Erro ao gerar rascunho" });
  }
});

// ===============================
app.get("/", (_req, res) => res.send("HERO Rewrite backend OK"));

app.listen(PORT, () => {
  console.log(`Rewrite backend rodando em http://localhost:${PORT}`);
});

