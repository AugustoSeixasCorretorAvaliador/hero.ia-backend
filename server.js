import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "fs";
import { buildPromptForMessage } from "./prompt.js";

dotenv.config();

// Aliases de bairro (mapeia menções para o bairro base)
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
  if (term.length < 4) return haystack.includes(term); // tokens curtos: relaxa borda
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

function extractMentionedBairros(msgPad) {
  const found = new Set();
  // bairros da base
  empreendimentos.forEach((e) => {
    const b = norm(e.bairro || "");
    if (b && includesWord(msgPad, b)) found.add(b);
  });
  // aliases
  Object.entries(BAIRRO_ALIASES).forEach(([alias, target]) => {
    if (includesWord(msgPad, alias)) found.add(target);
  });
  return Array.from(found);
}

function extractMentionedNames(msgPad) {
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

function findCandidates(msg) {
  const msgNorm = norm(msg);
  const msgPad = ` ${msgNorm} `;

  const tipsRequested = extractTips(msg);
  const names = extractMentionedNames(msgPad);
  if (names.length > 0) {
    return { list: names, reason: "nome" };
  }

  const bairros = extractMentionedBairros(msgPad);
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
      return `${e.nome} em ${e.bairro} — Tipologias: ${tipos} — Entrega: ${e.entrega || "a confirmar"}`;
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

    // pega a última mensagem fornecida pelo cliente
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