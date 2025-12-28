import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "fs";
import { buildPromptForMessage } from "./prompt.js";

dotenv.config();

// ===============================
// Assinatura e configuração
// ===============================
const APPEND_SIGNATURE = String(process.env.APPEND_SIGNATURE || "true").toLowerCase() === "true";
const DEFAULT_SIGNATURE = `👨🏻‍💼 Augusto Seixas
🏠 Corretor de Imóveis
🎯 Spin Vendas
🎯 Compra • Venda • Aluguel
📋 CRECI-RJ: 105921
📲 (21) 98565-3880
📧 augusto.seixas@spinvendas.com
🌐 www.spinimoveis.com

🔗 Confira mais "Ótimas Oportunidades" na minha Landing Page e redes sociais:

👉 augustoseixascorretor.com.br`;

// Permite configurar via .env com \n para quebras de linha
const SIGNATURE = (process.env.SIGNATURE || DEFAULT_SIGNATURE).replace(/\\n/g, "\n");

// Modo de anexação: 'closing' (padrão), 'always' ou 'never'
const APPEND_SIGNATURE_MODE = String(process.env.APPEND_SIGNATURE_MODE || "closing").toLowerCase();

function maskKey(key = "") {
  if (typeof key !== "string" || key.length === 0) return "<empty>";
  if (key.length <= 6) return `${key[0]}***${key[key.length - 1]}`;
  return `${key.slice(0, 3)}***${key.slice(-3)}`;
}

function sanitize(text = "") {
  return text
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function isUserClosing(text = "") {
  const t = sanitize(text);
  const patterns = [
    "obrigado",
    "obrigada",
    "valeu",
    "vou pensar",
    "vou avaliar",
    "vou considerar",
    "depois te falo",
    "te retorno",
    "mais tarde",
    "te chamo",
    "te aviso",
    "por enquanto nao",
    "agora nao",
    "ate mais",
    "ate breve",
    "boa noite",
    "bom dia",
    "boa tarde"
  ];
  return patterns.some((p) => t.includes(p));
}

function isResponseClosing(text = "") {
  const t = sanitize(text);
  const patterns = [
    "de nada",
    "estou aqui para ajudar",
    "se precisar",
    "e so me avisar",
    "se precisar de mais informacoes",
    "qualquer duvida",
    "fico a disposicao",
    "fico a sua disposicao",
    "ate breve",
    "ate logo"
  ];
  return patterns.some((p) => t.includes(p));
}

function shouldAppendSignature({ mode, userText, aiText }) {
  if (mode === "always") return true;
  if (mode === "never") return false;
  return isUserClosing(userText) || isResponseClosing(aiText);
}

/* ===============================
   App & Middlewares
================================ */
const app = express();
app.use(cors());
app.use(express.json());

/* ===============================
   OpenAI Client
================================ */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ===============================
// Aliases e utilidades de matching
// ===============================
const BAIRRO_ALIASES = {
  badu: "pendotiba",
  matapaca: "pendotiba",
  "mata paca": "pendotiba",
  "maria paula": "maria paula"
};

function includesWord(haystack, term) {
  if (!term) return false;
  const safe = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[^a-z0-9])${safe}([^a-z0-9]|$)`);
  if (term.length < 4) return haystack.includes(term);
  return re.test(haystack);
}

function hasTipologia(e, tipKeys) {
  if (!tipKeys || tipKeys.length === 0) return false;
  const tips = Array.isArray(e.tipologia)
    ? e.tipologia
    : Array.isArray(e.tipologias)
    ? e.tipologias
    : [e.tipologia || e.tipologias || ""];
  const normTips = tips.map((t) => norm(t));
  return tipKeys.some((t) => normTips.includes(t));
}

function extractTips(msg) {
  const tipologiaRegexes = [
    { rx: /(1\s*quarto[s]?|1q\b|1\s*qtos?|1\s*qts?|um\s+quarto)/i, key: "1q" },
    { rx: /(2\s*quarto[s]?|2q\b|2\s*qtos?|2\s*qts?|dois\s+quartos)/i, key: "2q" },
    { rx: /(3\s*quarto[s]?|3q\b|3\s*qtos?|3\s*qts?|tres\s+quartos|três\s+quartos)/i, key: "3q" },
    { rx: /(4\s*quarto[s]?|4q\b|4\s*qtos?|4\s*qts?|4\s*qto|quatro\s+quartos)/i, key: "4q" },
    { rx: /(studio|st\b|estudio|estúdio)/i, key: "studio" },
    { rx: /(loft)/i, key: "loft" },
    { rx: /(cobertura|\bcob\.?\b)/i, key: "cobertura" },
    { rx: /(lote[s]?|terreno[s]?)/i, key: "lote" }
  ];

  return tipologiaRegexes
    .filter((t) => t.rx.test(msg))
    .map((t) => norm(t.key));
}

function extractMentionedBairros(msgPad, empreendimentos) {
  const found = new Set();
  empreendimentos.forEach((e) => {
    const b = norm(e.bairro || "");
    if (b && includesWord(msgPad, b)) found.add(b);
  });
  Object.entries(BAIRRO_ALIASES).forEach(([alias, target]) => {
    if (includesWord(msgPad, alias)) found.add(target);
  });
  return Array.from(found);
}

function extractMentionedNames(msgPad, empreendimentos) {
  const matched = [];
  empreendimentos.forEach((e) => {
    const nomeNorm = norm(e.nome || "");
    if (!nomeNorm) return;
    const tokens = nomeNorm.split(/\s+/).filter(Boolean);
    const tokenHit = tokens.some((w) => w.length >= 3 && includesWord(msgPad, w));
    if (includesWord(msgPad, nomeNorm) || tokenHit) {
      matched.push(e);
    }
  });
  return matched;
}

// ===============================
// Licenciamento
// ===============================
const LICENSES_PATH = "./data/licenses.json";
let licenses = [];

function loadLicenses() {
  try {
    if (!fs.existsSync(LICENSES_PATH)) {
      fs.writeFileSync(LICENSES_PATH, "[]", "utf-8");
    }
    const raw = fs.readFileSync(LICENSES_PATH, "utf-8");
    const parsed = JSON.parse(raw || "[]");
    licenses = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("Erro ao carregar licenses.json:", err.message);
    licenses = [];
  }
}

function persistLicenses() {
  try {
    fs.writeFileSync(LICENSES_PATH, JSON.stringify(licenses, null, 2), "utf-8");
  } catch (err) {
    console.error("Erro ao salvar licenses.json:", err.message);
  }
}

export function validateLicense(userKey) {
  if (!userKey || typeof userKey !== "string") {
    return { ok: false, message: "Licença não informada." };
  }

  const license = licenses.find((l) => l.userKey === userKey);
  if (!license) {
    return { ok: false, message: "Licença não encontrada." };
  }

  if (license.status !== "active") {
    return { ok: false, message: "Licença inativa. Entre em contato com o suporte." };
  }

  license.lastUsed = new Date().toISOString();
  persistLicenses();

  return { ok: true, license };
}

function licenseMiddleware(req, res, next) {
  const userKey = req.header("x-user-key");

  console.log("====== VALIDAÇÃO DE LICENÇA ======");
  console.log("Licença recebida (masked):", maskKey(userKey));
  console.log("Total de licenças carregadas:", licenses.length);

  const result = validateLicense(userKey);

  console.log("Resultado da validação (ok/status):", { ok: result.ok, status: result.license?.status });
  console.log("===================================");

  if (!result.ok) {
    console.log("❌ LICENÇA BLOQUEADA:", result.message);
    return res.status(403).json({ error: result.message });
  }

  console.log("✅ LICENÇA VÁLIDA - Prosseguindo");
  next();
}

loadLicenses();

/* ===============================
   Carregar base de dados (com limpeza)
================================ */
let empreendimentos = [];
let empreendimentosLoadError = null;

try {
  const raw = fs.readFileSync("./data/empreendimentos.json", "utf-8");
  const parsed = JSON.parse(raw);

  empreendimentos = parsed.map((e) => {
    const desc = (e.descricao || "").replace(/Entrega:\s*[—-]+/g, "Entrega: a confirmar");
    const perfil = Array.isArray(e.perfil) && e.perfil.length > 0 ? e.perfil : ["moradia", "investimento"];
    return { ...e, descricao: desc, perfil };
  });
} catch (err) {
  empreendimentosLoadError = err;
  console.error("Erro ao carregar data/empreendimentos.json:", err.message);
  empreendimentos = [];
}

// Normalização utilitária
function norm(s = "") {
  return s.toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

// Motor determinístico: nome > bairro > tipologia
function findCandidates(msg) {
  const msgNorm = norm(msg);
  const msgPad = ` ${msgNorm} `;

  const tipsRequested = extractTips(msg);
  const names = extractMentionedNames(msgPad, empreendimentos);
  if (names.length > 0) {
    return { list: names, reason: "nome" };
  }

  const bairros = extractMentionedBairros(msgPad, empreendimentos);
  if (bairros.length > 0) {
    const bairroMatches = empreendimentos.filter((e) => bairros.includes(norm(e.bairro || "")));
    if (tipsRequested.length > 0) {
      const tipFiltered = bairroMatches.filter((e) => hasTipologia(e, tipsRequested));
      if (tipFiltered.length > 0) {
        return { list: tipFiltered, reason: "bairro+tip", requestedTips: tipsRequested };
      }
    }
    return { list: bairroMatches, reason: tipsRequested.length > 0 ? "bairro+tip-empty" : "bairro" };
  }

  if (tipsRequested.length > 0) {
    const tipMatches = empreendimentos.filter((e) => hasTipologia(e, tipsRequested));
    return { list: tipMatches, reason: "tip-only", tipOnly: true, requestedTips: tipsRequested };
  }

  return { list: [], reason: "none" };
}

function buildFallbackPayload() {
  return {
    resposta:
      "Não localizei esse recorte na minha base agora, mas posso te apresentar alternativas estratégicas em Niterói e Região Oceânica que façam sentido para você. 😊",
    followups: [
      "Posso te mostrar 2 opções rápidas alinhadas ao que você busca.",
      "Se preferir, faço uma ligação curta para alinharmos o perfil e ganhar tempo.",
      "Quer que eu envie um comparativo objetivo entre as melhores alternativas?"
    ]
  };
}

function buildDeterministicPayload(candidates, { tipOnly = false } = {}) {
  if (!candidates || candidates.length === 0) return null;
  const max = Math.min(candidates.length, 8);
  const picks = candidates.slice(0, max);
  const resumo = picks
    .map((e) => {
      const tipos = Array.isArray(e.tipologia)
        ? e.tipologia.join(", ")
        : Array.isArray(e.tipologias)
        ? e.tipologias.join(", ")
        : String(e.tipologia || e.tipologias || "");
      const entrega = e.entrega || "a confirmar";
      const desc = (e.descricao || "").replace(/\s+/g, " ").trim();
      return `${e.nome} — Bairro: ${e.bairro} — Tipologias: ${tipos} — Entrega: ${entrega} — Descrição: ${desc}`;
    })
    .join(" | ");

  const lead = tipOnly
    ? `Separei exemplos com essa tipologia: ${resumo}. Me diz o bairro ou um nome que você queira priorizar? 🙂`
    : `Encontrei opções reais na base: ${resumo}. Quer que eu detalhe a que mais combina com você ou agendamos uma ligação rápida? 🙂`;

  return {
    resposta: lead,
    followups: [
      "Posso te enviar agora o descritivo do que mais se encaixa no seu perfil.",
      "Se preferir, faço uma call de 5 minutos para tirar dúvidas e comparar opções.",
      "Quer que eu separe as plantas e condições de lançamento para você avaliar?"
    ]
  };
}

/* ===============================
   Rota principal (GERAR RASCUNHO)
================================ */
app.post("/whatsapp/draft", licenseMiddleware, async (req, res) => {
  try {
    if (empreendimentosLoadError) {
      return res.status(503).json({ error: "Base de empreendimentos indisponível no momento" });
    }

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

    const { list: candidates, tipOnly } = findCandidates(msg);

    if (!candidates || candidates.length === 0) {
      const payload = buildFallbackPayload();
      return res.json({ draft: JSON.stringify(payload, null, 0) });
    }

    const prompt = buildPromptForMessage({ mensagem: msg, empreendimentos: candidates });

    let payload = null;

    try {
      const response = await openai.responses.create({
        model: "gpt-4o-mini",
        input: [
          { role: "system", content: prompt },
          { role: "user", content: msg }
        ],
        text: { format: "json" },
        max_output_tokens: 1500,
        temperature: 0,
        top_p: 1
      });

      const modelText =
        response.output_text ||
        response.output?.[0]?.content?.[0]?.text ||
        "";

      try {
        const parsed = JSON.parse(modelText);
        if (parsed && typeof parsed === "object" && typeof parsed.resposta === "string") {
          payload = parsed;
        }
      } catch (e) {
        // continua para fallback
      }
    } catch (errCall) {
      console.error("OpenAI error:", errCall?.response?.data || errCall.message);
    }

    function removeAISignature(text) {
      const signaturePatterns = [
        /👨🏻‍💼\s*Augusto Seixas/g,
        /🏠\s*Corretor de Imóveis/g,
        /🎯\s*Spin Vendas/g,
        /🎯\s*Compra.*?Aluguel/g,
        /📋\s*CRECI-RJ:\s*\d+/g,
        /📲\s*\(\d+\)\s*\d+-\d+/g,
        /📧\s*[\w.-]+@[\w.-]+/g,
        /🌐\s*www\.[\w.-]+/g,
        /🔗\s*Confira.*?sociais:/g,
        /👉\s*[\w.-]+\.com\.br/g
      ];

      let cleaned = text;
      signaturePatterns.forEach((pattern) => {
        cleaned = cleaned.replace(pattern, "");
      });

      return cleaned.trim();
    }

    if (!payload) {
      payload = buildDeterministicPayload(candidates, { tipOnly }) || buildFallbackPayload();
    }

    payload.resposta = removeAISignature(payload.resposta || "");

    if (APPEND_SIGNATURE && typeof payload.resposta === "string") {
      const normalized = payload.resposta.trim();
      const shouldAppend = shouldAppendSignature({
        mode: APPEND_SIGNATURE_MODE,
        userText: msg,
        aiText: normalized
      });
      payload.resposta = shouldAppend ? `${normalized}\n\n${SIGNATURE}` : normalized;
    }

    return res.json({ draft: JSON.stringify(payload, null, 0) });
  } catch (err) {
    console.error("ERROR /whatsapp/draft:", err?.response?.data || err.message);
    return res.status(500).json({ error: "Erro ao gerar rascunho" });
  }
});

/* ===============================
   Health check (opcional)
================================ */
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/", (req, res) => {
  res.send("API WhatsApp Draft rodando 🚀");
});

/* ===============================
   Start do servidor
================================ */
const PORT = Number(process.env.PORT || 3001);

const server = app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} já está em uso. Verifique processos que ocupam a porta ou altere a variável PORT.`);
    console.error("No Windows: use `Get-NetTCPConnection -LocalPort 3001 | Select-Object -ExpandProperty OwningProcess` e depois `Stop-Process -Id <PID> -Force` ou use `npx kill-port 3001`.");
    process.exit(1);
  }
  console.error("Erro no servidor:", err);
  process.exit(1);
});
