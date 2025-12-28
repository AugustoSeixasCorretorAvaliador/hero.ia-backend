// ===============================
// HERO.IA – Backend determinístico
// ===============================

import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { fileURLToPath } from "url";

// -------------------------------
// Setup básico
// -------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// -------------------------------
// OpenAI (opcional)
// -------------------------------
let openai = null;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

// -------------------------------
// Carrega base de empreendimentos
// -------------------------------
const DATA_PATH = path.join(__dirname, "data", "empreendimentos.json");

let EMPREENDIMENTOS = [];

try {
  const raw = fs.readFileSync(DATA_PATH, "utf-8");
  EMPREENDIMENTOS = JSON.parse(raw);
  console.log(`📦 Base carregada: ${EMPREENDIMENTOS.length} empreendimentos`);
} catch (err) {
  console.error("❌ Erro ao carregar empreendimentos.json", err);
  process.exit(1);
}

// -------------------------------
// Normalização
// -------------------------------
const norm = (s = "") =>
  s
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

// -------------------------------
// Extração de intenção
// -------------------------------
function extractIntent(text) {
  const t = norm(text);

  // Tipologias
  let tipologia = null;
  if (/\b4\s*q/.test(t) || t.includes("4 quartos")) tipologia = "4q";
  else if (/\b3\s*q/.test(t) || t.includes("3 quartos")) tipologia = "3q";
  else if (/\b2\s*q/.test(t) || t.includes("2 quartos")) tipologia = "2q";
  else if (t.includes("studio")) tipologia = "studio";
  else if (t.includes("lote")) tipologia = "lote";

  // Bairro (match por base)
  let bairro = null;
  for (const e of EMPREENDIMENTOS) {
    if (t.includes(norm(e.bairro))) {
      bairro = e.bairro;
      break;
    }
  }

  // Nome (match parcial forte)
  let nome = null;
  for (const e of EMPREENDIMENTOS) {
    if (t.includes(norm(e.nome))) {
      nome = e.nome;
      break;
    }
  }

  return { nome, bairro, tipologia };
}

// -------------------------------
// Seleção determinística
// -------------------------------
function selectEmpreendimentos({ nome, bairro, tipologia }) {
  // 1️⃣ PRIORIDADE ABSOLUTA: NOME
  if (nome) {
    const list = EMPREENDIMENTOS.filter(
      (e) => norm(e.nome) === norm(nome)
    );
    return { origem: "nome", list };
  }

  // 2️⃣ BAIRRO (+ tipologia se existir)
  if (bairro) {
    let list = EMPREENDIMENTOS.filter(
      (e) => norm(e.bairro) === norm(bairro)
    );

    if (tipologia) {
      const filtrados = list.filter((e) =>
        e.tipologias.map(norm).includes(norm(tipologia))
      );
      if (filtrados.length > 0) {
        return { origem: "bairro+tipologia", list: filtrados };
      }
    }

    return { origem: "bairro", list };
  }

  // 3️⃣ SOMENTE TIPOLOGIA
  if (tipologia) {
    const list = EMPREENDIMENTOS.filter((e) =>
      e.tipologias.map(norm).includes(norm(tipologia))
    );
    return { origem: "tipologia", list };
  }

  // 4️⃣ Nada identificado
  return { origem: "nenhum", list: [] };
}

// -------------------------------
// Rota principal
// -------------------------------
app.post("/whatsapp/draft", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.json({
        resposta:
          "Pode me dizer um pouco mais do que você procura? 😊",
        origem: "mensagem_vazia",
      });
    }

    const intent = extractIntent(message);
    const result = selectEmpreendimentos(intent);

    // ---------------------------
    // Fallback SEM IA
    // ---------------------------
    if (result.list.length === 0) {
      return res.json({
        resposta:
          "Para te orientar melhor, você pode informar o bairro ou o nome do empreendimento que procura? 😊",
        origem: "fallback_sem_match",
      });
    }

    // ---------------------------
    // Tipologia sem bairro/nome
    // ---------------------------
    if (result.origem === "tipologia") {
      const exemplos = result.list.slice(0, 5).map(
        (e) => `${e.nome} em ${e.bairro}`
      );

      return res.json({
        resposta:
          `Tenho algumas opções com essa tipologia, como ${exemplos.join(
            ", "
          )}. Você tem algum bairro ou empreendimento específico em mente? 😊`,
        origem: "tipologia_only",
      });
    }

    // ---------------------------
    // Monta payload seguro
    // ---------------------------
    const resumo = result.list.map((e) => ({
      nome: e.nome,
      bairro: e.bairro,
      tipologias: e.tipologias,
      entrega: e.entrega,
    }));

    // ---------------------------
    // Sem OpenAI → resposta direta
    // ---------------------------
    if (!openai) {
      const texto = resumo
        .map(
          (e) =>
            `${e.nome} em ${e.bairro} — Tipologias: ${e.tipologias.join(
              ", "
            )} — Entrega: ${e.entrega}`
        )
        .join(" | ");

      return res.json({
        resposta:
          `Encontrei opções reais na base: ${texto}. Quer que eu detalhe alguma delas ou prefere falar comigo agora? 😊`,
        origem: "sem_openai",
      });
    }

    // ---------------------------
    // OpenAI apenas para REDAÇÃO
    // ---------------------------
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "Você é um corretor imobiliário humano e profissional. Apenas redija a resposta usando exclusivamente os dados fornecidos. Não invente empreendimentos.",
        },
        {
          role: "user",
          content: `
Cliente perguntou: "${message}"

Empreendimentos disponíveis (use apenas estes):
${JSON.stringify(resumo, null, 2)}

Redija uma resposta clara, objetiva e amigável, convidando o cliente a avançar.
          `,
        },
      ],
    });

    return res.json({
      resposta: completion.choices[0].message.content,
      origem: result.origem,
    });
  } catch (err) {
    console.error("❌ Erro no /whatsapp/draft", err);
    return res.json({
      resposta:
        "Tive um problema técnico agora. Pode tentar novamente em alguns instantes? 😊",
      origem: "erro_backend",
    });
  }
});

// -------------------------------
// Health check
// -------------------------------
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "hero.ia-backend" });
});

// -------------------------------
// Start
// -------------------------------
app.listen(PORT, () => {
  console.log(`🚀 HERO.IA backend rodando na porta ${PORT}`);
});
