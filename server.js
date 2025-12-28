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

function hasTipologia(e, tipKeys) {
  if (!tipKeys || tipKeys.length === 0) return false;
  const tips = Array.isArray(e.tipologia)
    ? e.tipologia
    : Array.isArray(e.tipologias)
    ? e.tipologias
    : [e.tipologia || e.tipologias || ""];
  const normTips = tips.map((t) => norm(t || ""));
  const normKeys = tipKeys.map((t) => norm(t || ""));
  return normKeys.some((t) => normTips.includes(t));
}

function extractTipKeys(msgNorm) {
  const keys = [];
  if (/\b(studio|studios)\b/.test(msgNorm)) keys.push("studio");
  if (/\bloft\b/.test(msgNorm)) keys.push("loft");
  if (/\b1\s*q(uarto)?s?\b/.test(msgNorm)) keys.push("1q");
  if (/\b2\s*q(uarto)?s?\b/.test(msgNorm)) keys.push("2q");
  if (/\b3\s*q(uarto)?s?\b/.test(msgNorm)) keys.push("3q");
  if (/\b4\s*q(uarto)?s?\b/.test(msgNorm)) keys.push("4q");
  return keys;
}

function includesWord(haystack, term) {
  if (!term) return false;
  const safe = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[^a-z0-9])${safe}([^a-z0-9]|$)`);
  if (term.length < 4) return haystack.includes(term);
  return re.test(haystack);
}

function extractMentionedBairros(msgPad, empreendimentos) {
  const found = new Set();
  empreendimentos.forEach((e) => {
    const b = norm(e.bairro || "");
    if (!b) return;
    if (includesWord(msgPad, b)) {
      found.add(b);
    }
  });
  Object.entries(BAIRRO_ALIASES).forEach(([alias, target]) => {
    if (includesWord(msgPad, alias)) found.add(target);
  });
  ["icarai", "icaria", "niteroi"].forEach((v) => {
    if (includesWord(msgPad, v)) found.add(v === "icaria" ? "icarai" : v);
  });
  return Array.from(found);
}

function extractMentionedNames(msgPad, empreendimentos) {
  const matched = [];
  empreendimentos.forEach((e) => {
    const nomeNorm = norm(e.nome || "");
    if (!nomeNorm) return;
    const tokens = nomeNorm.split(/\s+/).filter(Boolean);
    const tokenHit = tokens.some((w) => w.length >= 4 && includesWord(msgPad, w));
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
  const tipKeys = extractTipKeys(msgNorm);

  const bairros = extractMentionedBairros(msgPad, empreendimentos);
  if (bairros.length > 0) {
    const bairroMatches = empreendimentos.filter((e) => bairros.includes(norm(e.bairro || "")));
    if (tipKeys.length > 0) {
      const filtered = bairroMatches.filter((e) => hasTipologia(e, tipKeys));
      if (filtered.length > 0) {
        return { list: filtered, reason: "bairro+tip", bairros, tipKeys };
      }
    }
    return { list: bairroMatches, reason: "bairro", bairros, tipKeys };
  }

  const names = extractMentionedNames(msgPad, empreendimentos);
  if (names.length > 0) {
    return { list: names, reason: "nome" };
  }

  return { list: [], reason: "none" };
}

function buildFallbackPayload() {
  return {
    resposta:
      "Não entendi o nome do empreendimento ou o bairro para listar as disponibilidades. Me diz o nome ou o bairro que prefere e a tipologia (ex: studio, 2q, 3q, 4q) para eu puxar as opções certas. 😊",
    followups: [
      "Pode me dizer agora o nome ou bairro e a tipologia (studio, 2q, 3q, 4q)?",
      "Me passa o bairro favorito que eu puxo em segundos as opções certas.",
      "Se preferir, faço uma ligação rápida só para alinhar e enviar as opções ideais."
    ]
  };
}

function buildDeterministicPayload(candidates) {
  if (!candidates || candidates.length === 0) return null;
  const resumo = candidates
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

  const lead = `Encontrei opções reais na base: ${resumo}. Quer que eu detalhe a que mais combina com você ou agendamos uma ligação rápida? 🙂`;

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

    const { list: candidates, reason, bairros } = findCandidates(msg);
    console.log("[findCandidates]", {
      reason,
      bairros,
      total: candidates?.length,
      sample: (candidates || []).slice(0, 5).map((e) => ({ nome: e.nome, bairro: e.bairro, tipologia: e.tipologia || e.tipologias }))
    });

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
      payload = buildDeterministicPayload(candidates) || buildFallbackPayload();
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

// ===============================
// Endpoint interno de verificação (determinístico, sem LLM)
// ===============================
app.get("/debug/match", (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) {
    return res.status(400).json({ error: "Parâmetro 'q' é obrigatório" });
  }

  const { list, reason, bairros } = findCandidates(q);
  const items = (list || []).map((e) => ({
    nome: e.nome,
    bairro: e.bairro,
    tipologia: e.tipologia || e.tipologias,
    entrega: e.entrega
  }));

  return res.json({
    reason,
    bairros: bairros || [],
    total: items.length,
    items
  });
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
