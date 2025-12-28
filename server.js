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
  // closing: só quando usuario encerra OU resposta tem tom de encerramento
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

/* ===============================
   Licenciamento simples (arquivo JSON)
================================ */
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

  // Normaliza descrições com 'Entrega: —' para 'Entrega: a confirmar' e garante perfil default
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

// Cache para heurísticas de matching
const ALL_NAMES = () => empreendimentos.map((e) => norm(e.nome));
const ALL_BAIRROS = () => empreendimentos.map((e) => norm(e.bairro));

const BAIRRO_ALIASES = {
  badu: "pendotiba",
  matapaca: "pendotiba",
  "mata paca": "pendotiba",
  "maria paula": "maria paula"
};

function matchesAlias(msgNorm, bairroNorm) {
  return Object.entries(BAIRRO_ALIASES).some(
    ([alias, target]) => msgNorm.includes(alias) && bairroNorm.includes(target)
  );
}

function findCandidates(msg) {
  const msgNorm = norm(msg);
  const msgNormClean = ` ${msgNorm} `; // padding para regex de borda

  function includesWord(haystack, term) {
    if (!term) return false;
    const safe = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|[^a-z0-9])${safe}([^a-z0-9]|$)`);
    // tokens muito curtos sofrem em regex de borda; usa includes para evitar perder recall
    if (term.length < 4) return haystack.includes(term);
    return re.test(haystack);
  }

  const mentionedBairro =
    ALL_BAIRROS().some((b) => includesWord(msgNormClean, b)) ||
    Object.keys(BAIRRO_ALIASES).some((alias) => includesWord(msgNormClean, alias));

  const mentionedNome = ALL_NAMES().some((n) => includesWord(msgNormClean, n));

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

  const tipsMentioned = tipologiaRegexes
    .filter((t) => t.rx.test(msg))
    .map((t) => norm(t.key));

  const mapped = empreendimentos.map((e) => {
    const bairroNorm = norm(e.bairro || "");
    const nomeNorm = norm(e.nome || "");
    const nomeTokens = nomeNorm.split(/\s+/).filter(Boolean);
    const tips = Array.isArray(e.tipologia)
      ? e.tipologia.map((t) => norm(t))
      : Array.isArray(e.tipologias)
      ? e.tipologias.map((t) => norm(t))
      : [norm(e.tipologia || e.tipologias || "")];

    const entregaNorm = norm(e.entrega || "");

    const matchBairro =
      bairroNorm &&
      (includesWord(msgNormClean, bairroNorm) || matchesAlias(msgNormClean, bairroNorm));
    const matchNome =
      nomeNorm &&
      (includesWord(msgNormClean, nomeNorm) ||
        nomeTokens.some((w) => w && includesWord(msgNormClean, w)));
    const matchTip = tips.some((t) => t && (msgNorm.includes(t) || tipsMentioned.includes(t)));

    const matchEntrega =
      entregaNorm &&
      (includesWord(msgNormClean, entregaNorm) ||
        (/20\d{2}/.test(msgNorm) && entregaNorm === msgNorm.match(/20\d{2}/)?.[0]));

    return { e, matchNome, matchBairro, matchTip, matchEntrega };
  });

  const byNomeMatches = mapped.filter((m) => m.matchNome);
  if (byNomeMatches.length > 0) return { list: byNomeMatches.map((m) => m.e), usedFullBase: false };
  if (mentionedNome && byNomeMatches.length === 0) return { list: empreendimentos, usedFullBase: true };

  const byBairroMatches = mapped.filter((m) => m.matchBairro);
  if (byBairroMatches.length > 0) {
    const withTip = byBairroMatches.filter((m) => m.matchTip);
    const pool = withTip.length > 0 ? withTip : byBairroMatches;
    pool.sort((a, b) => Number(b.matchTip) - Number(a.matchTip) || Number(b.matchEntrega) - Number(a.matchEntrega));
    return { list: pool.map((m) => m.e), usedFullBase: false };
  }
  if (mentionedBairro && byBairroMatches.length === 0) return { list: empreendimentos, usedFullBase: true };

  const byTip = mapped.filter((m) => m.matchTip).map((m) => m.e);
  if (byTip.length > 0) return { list: byTip, usedFullBase: false };

  const byEntrega = mapped.filter((m) => m.matchEntrega).map((m) => m.e);
  if (byEntrega.length > 0) return { list: byEntrega, usedFullBase: false };

  // fallback: usa a base completa para manter recall (evita derrubar acerto)
  return { list: empreendimentos, usedFullBase: true };
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

function buildDeterministicPayload(candidates) {
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
      return `${e.nome} em ${e.bairro} — Tipologias: ${tipos} — Entrega: ${e.entrega || "a confirmar"}`;
    })
    .join(" | ");

  return {
    resposta: `Encontrei opções reais na base: ${resumo}. Quer que eu detalhe a que mais combina com você ou agendamos uma ligação rápida? 🙂`,
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

    // pega a última mensagem fornecida pelo cliente
    const msg = mensagens[mensagens.length - 1];
    if (!msg || typeof msg !== "string") {
      return res.status(400).json({ error: "Mensagem inválida" });
    }

    const { list: candidates } = findCandidates(msg);
    const prompt = buildPromptForMessage({ mensagem: msg, empreendimentos: candidates });

    let payload = null;

    try {
      const response = await openai.responses.create({
        model: "gpt-4o-mini",
        input: [
          { role: "system", content: prompt },
          { role: "user", content: msg }
        ],
        response_format: { type: "json_object" },
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
        // segue para fallback
      }
    } catch (errCall) {
      console.error("OpenAI error:", errCall?.response?.data || errCall.message);
    }

    // Função para remover qualquer assinatura que a IA tenha incluído indevidamente
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

/* ===============================
   Health check (opcional)
================================ */
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