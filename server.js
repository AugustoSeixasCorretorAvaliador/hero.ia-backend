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
const LICENSES_PATH = "./licenses.json";
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
  console.log("Licença recebida:", userKey);
  console.log("Total de licenças carregadas:", licenses.length);
  console.log("Licenças disponíveis:", licenses.map(l => l.userKey));
  
  const result = validateLicense(userKey);
  
  console.log("Resultado da validação:", result);
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
const _rawEmpreendimentos = JSON.parse(
  fs.readFileSync("./data/empreendimentos.json", "utf-8")
);

// Normaliza descricoes com 'Entrega: —' para 'Entrega: a confirmar'
const empreendimentos = _rawEmpreendimentos.map((e) => {
  const desc = (e.descricao || "").replace(/Entrega:\s*[—-]+/g, "Entrega: a confirmar");
  const perfil = Array.isArray(e.perfil) && e.perfil.length > 0 ? e.perfil : ["moradia", "investimento"];
  return { ...e, descricao: desc, perfil };
});

const ALL_NAMES = empreendimentos.map((e) => norm(e.nome));
const ALL_BAIRROS = empreendimentos.map((e) => norm(e.bairro));

const BAIRRO_ALIASES = {
  badu: "pendotiba",
  matapaca: "pendotiba",
  "mata paca": "pendotiba",
  "maria paula": "maria paula"
};

function matchesAlias(msgNorm, bairroNorm) {
  return Object.entries(BAIRRO_ALIASES).some(([alias, target]) => msgNorm.includes(alias) && bairroNorm.includes(target));
}

function findCandidates(msg) {
  const msgNorm = norm(msg);
  const tipologiaRegexes = [
    { rx: /(1\s*quarto[s]?|1q\b|um\s+quarto)/i, key: "1q" },
    { rx: /(2\s*quarto[s]?|2q\b|dois\s+quartos)/i, key: "2q" },
    { rx: /(3\s*quarto[s]?|3q\b|tres\s+quartos|três\s+quartos)/i, key: "3q" },
    { rx: /(4\s*quarto[s]?|4q\b|quatro\s+quartos)/i, key: "4q" },
    { rx: /(studio|st\b|estudio|estúdio)/i, key: "studio" },
    { rx: /(loft)/i, key: "loft" },
    { rx: /(cobertura)/i, key: "cobertura" },
    { rx: /(lote[s]?|terreno[s]?)/i, key: "lote" }
  ];

  const tipsMentioned = tipologiaRegexes
    .filter((t) => t.rx.test(msg))
    .map((t) => norm(t.key));

  const scored = empreendimentos
    .map((e) => {
      const bairroNorm = norm(e.bairro || "");
      const nomeNorm = norm(e.nome || "");
      const nomeTokens = nomeNorm.split(/\s+/).filter(Boolean);
      const tips = Array.isArray(e.tipologia)
        ? e.tipologia.map((t) => norm(t))
        : Array.isArray(e.tipologias)
        ? e.tipologias.map((t) => norm(t))
        : [norm(e.tipologia || e.tipologias || "")];

      const matchBairro = bairroNorm && (msgNorm.includes(bairroNorm) || matchesAlias(msgNorm, bairroNorm));
      const matchNome = nomeNorm && (msgNorm.includes(nomeNorm) || nomeTokens.some((w) => w.length >= 3 && msgNorm.includes(w)));
      const matchTip = tips.some((t) => t && (msgNorm.includes(t) || tipsMentioned.includes(t)));

      // score: prioritize name/bairro; tip alone is lowest
      let score = 0;
      if (matchNome) score += 3;
      if (matchBairro) score += 2;
      if (matchTip) score += 1;

      return { e, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.map(({ e }) => e);
}

function buildFallbackPayload() {
  return {
    resposta: "Não localizei esse recorte na minha base agora, mas posso te apresentar alternativas estratégicas em Niterói e Região Oceânica que façam sentido para você. 😊",
    followups: [
      "Posso te mostrar 2 opções rápidas alinhadas ao que você busca.",
      "Se preferir, faço uma ligação curta para alinharmos o perfil e ganhar tempo.",
      "Quer que eu envie um comparativo objetivo entre as melhores alternativas?"
    ]
  };
}

function detectForeignReference(text, candidates) {
  const t = norm(text);
  const allowedNames = candidates.map((e) => norm(e.nome));
  const allowedBairros = candidates.map((e) => norm(e.bairro));

  const foreignName = ALL_NAMES.some((name) => t.includes(name) && !allowedNames.includes(name));
  const foreignBairro = ALL_BAIRROS.some((b) => t.includes(b) && !allowedBairros.includes(b));

  return foreignName || foreignBairro;
}

function buildDeterministicPayload(candidates) {
  if (!candidates || candidates.length === 0) return null;
  const max = Math.min(candidates.length, 3);
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

// Normalização utilitária
function norm(s = "") {
  return s.toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

/* ===============================
   Rota principal (GERAR RASCUNHO)
================================ */
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/whatsapp/draft", licenseMiddleware, async (req, res) => {
  try {
    let { mensagens, message, bairro = "", tipologia = "" } = req.body || {};

    // Permite tanto 'mensagens' (array/string) quanto 'message' (string)
    if (!mensagens && message) mensagens = [message];

    if (!mensagens) {
      return res.status(400).json({ error: "Campo 'mensagens' ou 'message' é obrigatório" });
    }
    if (!Array.isArray(mensagens)) mensagens = [mensagens];

    // Normaliza e filtra vazios
    mensagens = mensagens
      .filter((m) => typeof m === "string")
      .map((m) => m.trim())
      .filter(Boolean);

    if (mensagens.length === 0) {
      return res.status(400).json({ error: "Nenhuma mensagem válida fornecida" });
    }

    // pega a última mensagem fornecida pelo cliente
    const msg = mensagens[mensagens.length - 1];
    const candidates = findCandidates(msg);

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

    function appendSignatureIfNeeded(payload) {
      if (!APPEND_SIGNATURE || !payload || typeof payload.resposta !== "string") return payload;
      const normalized = payload.resposta.trim();
      const shouldAppend = shouldAppendSignature({
        mode: APPEND_SIGNATURE_MODE,
        userText: msg,
        aiText: normalized
      });
      return {
        ...payload,
        resposta: shouldAppend ? `${normalized}\n\n${SIGNATURE}` : normalized
      };
    }

    // Se não há candidatos determinísticos, devolve fallback sem chamar IA
    if (candidates.length === 0) {
      const payload = appendSignatureIfNeeded(buildFallbackPayload());
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
          parsed.resposta = removeAISignature(parsed.resposta);
          payload = parsed;
        }
      } catch (e) {
        // continua para fallback
      }
    } catch (errCall) {
      console.error("OpenAI error:", errCall?.response?.data || errCall.message);
    }

    if (!payload || detectForeignReference(payload.resposta || "", candidates)) {
      payload = buildDeterministicPayload(candidates) || buildFallbackPayload();
    }

    payload = appendSignatureIfNeeded(payload);

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
