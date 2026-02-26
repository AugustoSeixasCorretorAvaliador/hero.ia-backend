import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { buildPromptForMessage } from "./prompt.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "200kb" }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const PORT = Number(process.env.PORT || 3002);
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1";
const TEMPERATURE = Number(process.env.OPENAI_TEMPERATURE || 0.2);
const TOP_P = Number(process.env.OPENAI_TOP_P || 0.9);

// ===============================
// HEALTH
// ===============================
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    mode: "rewrite-premium",
    model: MODEL,
    temperature: TEMPERATURE,
    top_p: TOP_P
  });
});

// ===============================
// WHATSAPP REFINE (LAPIDADOR)
// ===============================
app.post("/whatsapp/refine", async (req, res) => {
  try {
    let { mensagens, message } = req.body || {};

    if (!mensagens && message) {
      mensagens = [message];
    }

    if (!mensagens) {
      return res.status(400).json({
        error: "Campo 'mensagens' é obrigatório"
      });
    }

    if (!Array.isArray(mensagens)) {
      mensagens = [mensagens];
    }

    const msg = mensagens[mensagens.length - 1];

    if (!msg || typeof msg !== "string") {
      return res.status(400).json({
        error: "Mensagem inválida"
      });
    }

    const prompt = buildPromptForMessage({ mensagem: msg });

    const response = await openai.chat.completions.create({
      model: MODEL,
      temperature: TEMPERATURE,
      top_p: TOP_P,
      messages: [
        {
          role: "system",
          content: prompt
        }
      ]
    });

    const refined = response.choices?.[0]?.message?.content?.trim();

    if (!refined) {
      return res.status(500).json({
        error: "Não consegui gerar a resposta."
      });
    }

    return res.json({
      refine: refined
    });

  } catch (err) {
    console.error("/whatsapp/refine error:", err?.response?.data || err.message || err);

    return res.status(500).json({
      error: "Erro ao gerar rascunho"
    });
  }
});

// ===============================
app.get("/", (_req, res) => {
  res.send("HERO Rewrite Premium backend OK");
});

// ===============================
app.listen(PORT, () => {
  console.log(`Rewrite backend rodando em http://localhost:${PORT}`);
});

