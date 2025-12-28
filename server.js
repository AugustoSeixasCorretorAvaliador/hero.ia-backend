import express from "express";
import fs from "fs";
import path from "path";
import OpenAI from "openai";

const app = express();
app.use(express.json());

/* =========================
   CONFIG
========================= */

const DATA_PATH = path.join(process.cwd(), "data", "empreendimentos.json");
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 3000;

const openai =
  OPENAI_KEY &&
  new OpenAI({
    apiKey: OPENAI_KEY,
  });

/* =========================
   HELPERS
========================= */

const normalize = (s = "") =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

const loadEmpreendimentos = () =>
  JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));

const extractTipologias = (text) => {
  const t = normalize(text);
  const tips = [];

  if (t.includes("1 quarto") || t.includes("1q")) tips.push("1q");
  if (t.includes("2 quartos") || t.includes("2q")) tips.push("2q");
  if (t.includes("3 quartos") || t.includes("3q")) tips.push("3q");
  if (t.includes("4 quartos") || t.includes("4q")) tips.push("4q");
  if (t.includes("studio")) tips.push("studio");
  if (t.includes("lote")) tips.push("lote");

  return tips;
};

const extractBairros = (text, empreendimentos) => {
  const t = normalize(text);
  const bairros = new Set();

  empreendimentos.forEach((e) => {
    if (t.includes(normalize(e.bairro))) {
      bairros.add(normalize(e.bairro));
    }
  });

  return [...bairros];
};

const extractNome = (text, empreendimentos) => {
  const t = normalize(text);
  return empreendimentos.filter((e) =>
    normalize(e.nome).includes(t)
  );
};

const hasTipologia = (emp, tips) =>
  emp.tipologias?.some((t) => tips.includes(normalize(t)));

/* =========================
   CORE — FILTRO DETERMINÍSTICO
========================= */

function findCandidates(message) {
  const empreendimentos = loadEmpreendimentos();
  const msg = normalize(message);

  const tips = extractTipologias(msg);
  const bairros = extractBairros(msg, empreendimentos);
  const nomeMatches = extractNome(msg, empreendimentos);

  /* 1️⃣ NOME (PRIORIDADE ABSOLUTA) */
  if (nomeMatches.length > 0) {
    return {
      list: nomeMatches,
      reason: "nome",
    };
  }

  /* 2️⃣ BAIRRO (+ TIPOLOGIA) */
  if (bairros.length > 0) {
    const bairroMatches = empreendimentos.filter((e) =>
      bairros.includes(normalize(e.bairro))
    );

    if (tips.length > 0) {
      const bairroTipMatches = bairroMatches.filter((e) =>
        hasTipologia(e, tips)
      );

      if (bairroTipMatches.length > 0) {
        return {
          list: bairroTipMatches,
          reason: "bairro+tipologia",
        };
      }

      // ⚠️ NÃO retorna bairro inteiro
      return {
        list: [],
        reason: "bairro+tipologia_sem_match",
        tips,
        bairros,
      };
    }

    return {
      list: bairroMatches,
      reason: "bairro",
    };
  }

  /* 3️⃣ SÓ TIPOLOGIA */
  if (tips.length > 0) {
    const tipMatches = empreendimentos.filter((e) =>
      hasTipologia(e, tips)
    );

    if (tipMatches.length > 0) {
      return {
        list: tipMatches.slice(0, 5),
        reason: "tipologia",
        tips,
      };
    }

    return {
      list: [],
      reason: "tipologia_sem_match",
      tips,
    };
  }

  /* 4️⃣ FALLBACK TOTAL */
  return {
    list: [],
    reason: "nenhuma_info",
  };
}

/* =========================
   ROTA PRINCIPAL
========================= */

app.post("/whatsapp/draft", async (req, res) => {
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: "Mensagem ausente" });
  }

  const result = findCandidates(message);

  /* === FALLBACKS (SEM OPENAI) === */

  if (result.list.length === 0) {
    let resposta = "";

    switch (result.reason) {
      case "bairro+tipologia_sem_match":
        resposta = `No momento não encontrei imóveis com essa tipologia nesse bairro. Quer ver outras opções em ${result.bairros.join(
          ", "
        )} ou prefere outro bairro? 😊`;
        break;

      case "tipologia_sem_match":
        resposta =
          "Tenho algumas opções disponíveis, mas preciso saber o bairro ou empreendimento específico para te orientar melhor 😊";
        break;

      default:
        resposta =
          "Posso te ajudar melhor se me disser o bairro ou o nome do empreendimento que você procura 😊";
    }

    return res.json({
      resposta,
      origem: "fallback_deterministico",
    });
  }

  /* === OPENAI SÓ PARA REDAÇÃO === */

  const listaFormatada = result.list
    .map(
      (e) =>
        `${e.nome} em ${e.bairro} — Tipologias: ${e.tipologias.join(
          ", "
        )} — Entrega: ${e.entrega}`
    )
    .join(" | ");

  const prompt = `
Você é um corretor imobiliário humano e consultivo.
Use apenas os dados abaixo. Não invente nada.

Dados:
${listaFormatada}

Mensagem do cliente:
"${message}"

Gere uma resposta clara, objetiva e profissional, convidando para aprofundar ou agendar contato.
Use no máximo 1 emoji.
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
  });

  return res.json({
    resposta: completion.choices[0].message.content,
    origem: result.reason,
  });
});

/* =========================
   START
========================= */

app.listen(PORT, () => {
  console.log(`🔥 HERO.IA backend rodando na porta ${PORT}`);
});