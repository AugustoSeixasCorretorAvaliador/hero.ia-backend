import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import fs from "fs";
import { createClient } from "@supabase/supabase-js";
import { buildCopilotPrompt } from "./prompt-copilot.js";
import { buildPromptForMessage } from "./prompt-draft.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "200kb" }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PORT = Number(process.env.PORT || 3002);
const MAX_MESSAGES = 20;
const MAX_TOTAL_CHARS = 6000;
const APP_REQUIRE_LICENSE = String(process.env.APP_REQUIRE_LICENSE || "true").toLowerCase() === "true";

// ===============================
// Assinatura
// ===============================
const APPEND_SIGNATURE = String(process.env.APPEND_SIGNATURE || "true").toLowerCase() === "true";
const DEFAULT_SIGNATURE = `👨🏻‍💼 Augusto Seixas
🏠 Corretor de Imóveis
🎯 Spin Vendas
🎯 Compra • Venda • Aluguel
📋 CRECI-RJ: 105921
📲 (21) 98565-3880
📧 augusto.seixas@spinvendas.com
🌐 www.spinimoveis.com`;
const SIGNATURE = (process.env.SIGNATURE || DEFAULT_SIGNATURE).replace(/\\n/g, "\n");
const APPEND_SIGNATURE_MODE = String(process.env.APPEND_SIGNATURE_MODE || "closing").toLowerCase();

function maskKey(key = "") {
  if (typeof key !== "string" || key.length === 0) return "<empty>";
  if (key.length <= 6) return `${key[0]}***${key[key.length - 1]}`;
  return `${key.slice(0, 3)}***${key.slice(-3)}`;
}

// ===============================
// Supabase / Licenciamento
// ===============================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) : null;

// Token simples para o painel admin (substitua via env)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "heroia_app_admin";

function requireSupabaseReady() {
  if (!supabase) {
    throw new Error("Supabase não configurado. Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.");
  }
}

function normalizeLicense(row = {}) {
  // Normalize different shapes and ensure we always expose a key and keyColumn
  const licenseKey = row.license_key ?? null;
  const userKey = row.user_key ?? null;

  // Prefer license_key if present, otherwise user_key, otherwise fall back to id
  const key = licenseKey || userKey || (row.id ? String(row.id) : null);
  const keyColumn = licenseKey ? "license_key" : userKey ? "user_key" : "id";

  return {
    id: row.id ?? null,
    key,
    keyColumn,
    status: row.status ?? null,
    deviceId: row.device_id ?? row.deviceId ?? row.bound_device_id ?? null,
    email: row.email ?? row.user_email ?? null,
    expiresAt: row.expires_at ?? row.expiresAt ?? null,
    maxDevices: row.max_devices ?? row.maxDevices ?? 1,
    raw: row // keep original row for debugging if needed
  };
}

async function fetchLicense(licenseKey) {
  if (!licenseKey) return null;
  requireSupabaseReady();

  // Try license_key first
  let { data, error } = await supabase.from("licenses").select("*").eq("license_key", licenseKey).maybeSingle();
  if (error && error.code !== "PGRST116") {
    console.error("[fetchLicense] error querying license_key:", error);
    throw error;
  }
  if (data) {
    const norm = normalizeLicense(data);
    // Ensure returned object includes the exact key value used to search
    norm.key = licenseKey;
    norm.keyColumn = "license_key";
    return norm;
  }

  // Fallback to user_key
  ({ data, error } = await supabase.from("licenses").select("*").eq("user_key", licenseKey).maybeSingle());
  if (error && error.code !== "PGRST116") {
    console.error("[fetchLicense] error querying user_key:", error);
    throw error;
  }
  if (data) {
    const norm = normalizeLicense(data);
    norm.key = licenseKey;
    norm.keyColumn = "user_key";
    return norm;
  }

  // Not found
  return null;
}

function isExpired(expiresAt) {
  if (!expiresAt) return false;
  const exp = new Date(expiresAt).getTime();
  if (Number.isNaN(exp)) return false;
  return exp < Date.now();
}

async function licenseMiddleware(req, res, next) {
  if (!APP_REQUIRE_LICENSE) return next();

  const licenseKey = req.header("x-license-key");
  const deviceId = req.header("x-device-id");
  if (!licenseKey || !deviceId) {
    return res.status(400).json({ error: "Headers x-license-key e x-device-id são obrigatórios" });
  }

  try {
    const license = await fetchLicense(licenseKey);
    console.log("[license] key:", maskKey(licenseKey), "device:", maskKey(deviceId));

    if (!license) return res.status(403).json({ error: "Licença não encontrada" });
    if (license.status === "blocked") return res.status(403).json({ error: "Licença bloqueada" });
    if (isExpired(license.expiresAt)) return res.status(403).json({ error: "Licença expirada" });
    if (license.deviceId && license.deviceId !== deviceId) {
      console.warn("[licenseMiddleware] device mismatch", { key: maskKey(licenseKey), bound: maskKey(license.deviceId), incoming: maskKey(deviceId) });
      return res.status(403).json({ error: "Licença já vinculada a outro dispositivo" });
    }
    // single-device enforcement even when license.deviceId vazio: bloqueia se houver ativação prévia de outro device
    if (!license.deviceId && (license.maxDevices ?? 1) <= 1) {
      try {
        requireSupabaseReady();
        const { data: otherAct, error: otherErr } = await supabase
          .from('license_activations')
          .select('device_id')
          .eq('license_key', licenseKey)
          .neq('device_id', deviceId)
          .limit(1)
          .maybeSingle();
        if (otherErr) console.error('[licenseMiddleware] erro ao checar ativacoes prévias:', otherErr);
        if (otherAct?.device_id) {
          console.warn("[licenseMiddleware] bloqueado por histórico de outro device", { key: maskKey(licenseKey), otherDevice: maskKey(otherAct.device_id), incoming: maskKey(deviceId) });
          return res.status(403).json({ error: "Licença já vinculada a outro dispositivo" });
        }
      } catch (histErr) {
        console.error('[licenseMiddleware] falha ao verificar histórico de devices:', histErr);
      }
    }
    if (license.status !== "active") {
      return res.status(403).json({ error: "Licença não ativada. Ative antes de usar." });
    }

    req.license = {
      id: license.id,
      key: license.key,
      deviceId,
      expiresAt: license.expiresAt
    };

    // Verificar status do device na license_activations
    try {
      requireSupabaseReady();
      const { data: activation, error: actErr } = await supabase
        .from('license_activations')
        .select('user_status')
        .eq('license_key', licenseKey)
        .eq('device_id', deviceId)
        .order('activated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (actErr) {
        console.error('[licenseMiddleware] erro ao consultar activation:', actErr);
      }
      if (activation && activation.user_status === 'blocked') {
        return res.status(403).json({ error: 'Dispositivo bloqueado' });
      }
      // Atualiza last_seen_at na license_activations
      await supabase
        .from('license_activations')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('license_key', licenseKey)
        .eq('device_id', deviceId);
    } catch (e) {
      console.error('[licenseMiddleware] erro ao consultar/atualizar activation:', e?.message || e);
    }

    return next();
  } catch (err) {
    console.error("Erro ao validar licença:", err?.message || err);
    return res.status(500).json({ error: "Falha na validação da licença" });
  }
}

// ===============================
// Base de empreendimentos
// ===============================
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

const BAIRRO_ALIASES = {
  badu: "pendotiba",
  matapaca: "pendotiba",
  "mata paca": "pendotiba",
  "maria paula": "maria paula"
};

function norm(s = "") {
  return s
    .toString()
    .replace(/\u00a0/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

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
  if (/(1\s*q(uarto)?s?|1\s*qts?|1\s*dorm(itorio)?s?|1\s*d)\b/.test(msgNorm)) keys.push("1q");
  if (/(2\s*q(uarto)?s?|2\s*qts?|2\s*dorm(itorio)?s?|2\s*d)\b/.test(msgNorm)) keys.push("2q");
  if (/(3\s*q(uarto)?s?|3\s*qts?|3\s*dorm(itorio)?s?|3\s*d)\b/.test(msgNorm)) keys.push("3q");
  if (/(4\s*q(uarto)?s?|4\s*qts?|4\s*dorm(itorio)?s?|4\s*d)\b/.test(msgNorm)) keys.push("4q");
  return keys;
}

function includesWord(haystack, term) {
  if (!term) return false;
  const safe = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[^a-z0-9])${safe}([^a-z0-9]|$)`);
  if (term.length < 4) return haystack.includes(term);
  return re.test(haystack);
}

function extractMentionedBairros(msgPad, empreendimentosList) {
  const found = new Set();
  empreendimentosList.forEach((e) => {
    const b = norm(e.bairro || "");
    if (!b) return;
    if (includesWord(msgPad, b)) found.add(b);
  });
  Object.entries(BAIRRO_ALIASES).forEach(([alias, target]) => {
    if (includesWord(msgPad, alias)) found.add(target);
  });
  ["icarai", "icaria", "niteroi"].forEach((v) => {
    if (includesWord(msgPad, v)) found.add(v === "icaria" ? "icarai" : v);
  });
  return Array.from(found);
}

function extractMentionedNames(msgPad, empreendimentosList) {
  const matched = [];
  empreendimentosList.forEach((e) => {
    const nomeNorm = norm(e.nome || "");
    if (!nomeNorm) return;
    const tokens = nomeNorm.split(/\s+/).filter(Boolean);
    const tokenHit = tokens.some((w) => w.length >= 4 && includesWord(msgPad, w));
    if (includesWord(msgPad, nomeNorm) || tokenHit) matched.push(e);
  });
  return matched;
}

function findCandidates(msg) {
  const msgNorm = norm(msg);
  const msgPad = ` ${msgNorm} `;
  const tipKeys = extractTipKeys(msgNorm);

  const bairros = extractMentionedBairros(msgPad, empreendimentos);
  if (bairros.length > 0) {
    const bairroMatches = empreendimentos.filter((e) => bairros.includes(norm(e.bairro || "")));
    if (tipKeys.length > 0) {
      const filtered = bairroMatches.filter((e) => hasTipologia(e, tipKeys));
      if (filtered.length > 0) return { list: filtered, reason: "bairro+tip", bairros, tipKeys };
    }
    return { list: bairroMatches, reason: "bairro", bairros, tipKeys };
  }

  const names = extractMentionedNames(msgPad, empreendimentos);
  if (names.length > 0) return { list: names, reason: "nome" };

  return { list: [], reason: "none", tipKeys, msgNorm };
}

function isRealEstateIntent(msgNorm = "") {
  if (!msgNorm) return false;
  const hasTip = extractTipKeys(msgNorm).length > 0;
  const hints = [
    "imovel",
    "imoveis",
    "imobiliario",
    "imobiliaria",
    "empreendimento",
    "apart",
    "apto",
    "apartamento",
    "casa",
    "lote",
    "cobertura",
    "planta",
    "lançamento",
    "lancamento",
    "obra",
    "m2",
    "m quadrado",
    "aluguel",
    "venda",
    "comprar",
    "investir",
    "condominio",
    "condomínio"
  ];
  const hasHint = hints.some((k) => msgNorm.includes(k));
  return hasTip || hasHint;
}

function buildFallbackPayload({ msg = "", msgNorm = "" } = {}) {
  const normalized = msgNorm || norm(msg || "");
  const isShort = normalized.split(/\s+/).filter(Boolean).length <= 7;
  const wantsSell = normalized.includes("vender") || normalized.includes("venda") || normalized.includes("meu imovel") || normalized.includes("meu imóvel") || normalized.includes("imovel") || normalized.includes("imóvel");
  if (isShort && wantsSell) {
    return {
      resposta: "Olá! Que ótimo saber que você deseja vender seu imóvel. Pode me contar o tipo, bairro/cidade e se tem urgência? Assim já organizo a melhor estratégia para você. 😊",
      followups: [
        "Qual o tipo do imóvel (apto, casa, sala, lote) e metragem aproximada?",
        "Em que bairro/cidade ele está e qual sua expectativa de valor?",
        "Você tem alguma urgência ou prazo para a venda?"
      ]
    };
  }
  const concernTerms = ["economia", "crise", "juros", "taxa", "taxas", "inflacao", "infla", "medo", "receio", "incerteza", "dolar", "politica", "eleicao", "guerra"];
  const hasConcern = concernTerms.some((t) => normalized.includes(t));
  const concernLead = hasConcern ? "Entendi sua preocupação com a economia. " : "";

  return {
    resposta: `${concernLead}Olá 👋, Para eu te direcionar com precisão, me diga, por favor, o nome do empreendimento ou o bairro com a tipologia (ex: studio, 2q, 3q, 4q). Assim, consigo te apresentar as opções mais adequadas dos empreendimentos. Atuo apenas com os empreendimentos da base, mas posso te indicar opções nela. 😊`,
    followups: [
      "Pode me dizer agora o nome ou bairro e a tipologia (studio, 2q, 3q, 4q, Lotes)?",
      "Me passa o bairro favorito que eu puxo em segundos as opções certas.",
      "Se preferir, faço uma ligação rápida só para alinhar e enviar as opções ideais."
    ]
  };
}

async function buildSmalltalkPayload({ msg = "", msgNorm = "" } = {}) {
  const system = [
    "Você é Augusto Seixas- Corretor Spin, corretor consultivo em Niterói e Região Oceânica.",
    "Pode conversar sobre qualquer assunto com empatia e brevidade (máx 2 frases).",
    "Nunca sugira ou invente empreendimentos, bairros, tipologias, metragens ou datas.",
    "Se o usuário pedir imóveis, peça o nome do empreendimento ou o bairro e a tipologia (ex: studio, 2q, 3q, 4q, lote) e avise que só trabalha com os empreendimentos da base fornecida.",
    "Use um emoji na resposta."
  ].join(" ");

  const userContent = msg || "";

  try {
    const response = await openai.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: userContent }
      ],
      max_output_tokens: 200,
      temperature: 0.4,
      top_p: 1
    });

    const text =
      response.output_text ||
      response.output?.[0]?.content?.[0]?.text ||
      "Posso te ajudar com isso. Quando quiser falar de imóveis, me diga nome ou bairro e a tipologia (studio, 2q, 3q, 4q, lote) que eu consulto na base. 🙂";

    return {
      resposta: String(text).trim(),
      followups: [
        "Quando quiser ver opções de imóveis, me diz nome ou bairro e tipologia que eu consulto na base.",
        "Se preferir, me fala o bairro favorito que eu trago as opções certas da base."
      ]
    };
  } catch (err) {
    console.error("OpenAI smalltalk error:", err?.response?.data || err.message);
    return {
      resposta:
        "Posso te ajudar com esse assunto. Quando quiser falar de imóveis, me diga nome ou bairro e a tipologia (studio, 2q, 3q, 4q, lote) que eu consulto na base. 🙂",
      followups: [
        "Se quiser, me passa o bairro favorito que eu puxo as opções certas da base.",
        "Me fala nome ou bairro e tipologia que eu listo os empreendimentos da base."
      ]
    };
  }
}

function buildDeterministicPayload(candidates) {
  if (!candidates || candidates.length === 0) return null;
  const humanizeList = (arr) => {
    if (!Array.isArray(arr) || arr.length === 0) return "";
    if (arr.length === 1) return String(arr[0]);
    const head = arr.slice(0, -1).join(", ");
    return `${head} e ${arr[arr.length - 1]}`;
  };

  const blocks = candidates.map((e) => {
    const tiposRaw = Array.isArray(e.tipologia)
      ? e.tipologia
      : Array.isArray(e.tipologias)
      ? e.tipologias
      : String(e.tipologia || e.tipologias || "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);

    const tipos = humanizeList(tiposRaw);
    const entrega = e.entrega || "a confirmar";
    const desc = (e.descricao || "").replace(/\s+/g, " ").trim();

    return [
      "* " + e.nome,
      "* " + (e.bairro || "Bairro não informado"),
      tipos ? "* Tipologias: " + tipos : "",
      desc ? "* Descrição: " + desc : "",
      "* Previsão de entrega: " + entrega
    ]
      .filter(Boolean)
      .join("\n");
  });

  const lead = [
    "Perfeito. Seguem as informações:",
    "",
    "",
    blocks.join("\n\n"),
    "",
    "",
    "Se preferir, te envio E-Book e já podemos agendar uma ligação rápida ou por vídeo, explico melhor o projeto e combinamos uma visita para escolher a unidade mais adequada ao seu perfil. Seu interesse seria para moradia ou investimento? 🙂"
  ].join("\n");

  return {
    resposta: lead,
    followups: [
      "Posso te enviar agora o descritivo do que mais se encaixa no seu perfil.",
      "Se preferir, faço uma call de 5 minutos para tirar dúvidas e comparar opções.",
      "Quer que eu separe as plantas e condições de lançamento para você avaliar?"
    ]
  };
}

function cleanSuggestion(text = "") {
  let t = text.trim();
  t = t.replace(/^✍️\s*Rascunho sugerido:\s*/i, "");
  t = t.replace(/^✍️\s*/i, "");
  t = t.replace(/^"|"$/g, "");
  return t.trim();
}

function parseCopilotResponse(rawText = "") {
  const draft = (rawText || "").trim();
  const result = { analysis: "", suggestion: "", draft };
  if (!draft) return result;

  const markerIndex = draft.indexOf("✍️");
  if (markerIndex !== -1) {
    result.analysis = draft.slice(0, markerIndex).trim();
    result.suggestion = cleanSuggestion(draft.slice(markerIndex));
  } else {
    const lines = draft.split(/\n+/);
    const analysisLine = lines.find((l) => l.trim().startsWith("🔍"));
    const suggestionLine = lines.find((l) => l.trim().startsWith("✍️"));
    if (analysisLine) result.analysis = analysisLine.trim();
    if (suggestionLine) result.suggestion = cleanSuggestion(suggestionLine);
  }

  if (!result.suggestion) result.suggestion = draft;
  return result;
}

function normalizeCopilotMessages(raw) {
  if (!Array.isArray(raw)) return [];
  const cleaned = raw
    .map((m) => {
      const text = typeof m?.text === "string" ? m.text.trim() : "";
      const author = typeof m?.author === "string" ? m.author.trim() : "";
      return { author: author || "cliente", text };
    })
    .filter((m) => m.text);

  const slice = cleaned.slice(-MAX_MESSAGES);
  const result = [];
  let total = 0;
  for (const msg of slice) {
    if (total + msg.text.length > MAX_TOTAL_CHARS) break;
    result.push(msg);
    total += msg.text.length;
  }
  return result;
}

function normalizeDraftMessages(raw) {
  if (!Array.isArray(raw)) return [];
  const cleaned = raw
    .map((m) => (typeof m === "string" ? m : typeof m?.text === "string" ? m.text : ""))
    .map((t) => t.trim())
    .filter(Boolean);
  return cleaned.slice(-MAX_MESSAGES);
}

function isUserClosing(text = "") {
  const t = norm(text);
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
  const t = norm(text);
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

// ===============================
// Rotas
// ===============================
app.get("/health", (_req, res) => res.json({ ok: true, license: APP_REQUIRE_LICENSE }));

// ===============================
// Admin: bloquear / ativar licença (fonte de verdade = licenses.status)
// ===============================
app.post("/admin/license", async (req, res) => {
  const { license_key, user_key, action, token } = req.body || {};
  const providedKey = license_key || user_key;

  if (token !== ADMIN_TOKEN) {
    return res.status(403).json({ error: "Acesso negado" });
  }

  if (!providedKey || !["active", "blocked"].includes(action)) {
    return res.status(400).json({ error: "Dados inválidos" });
  }

  try {
    requireSupabaseReady();

    // Tenta nas duas colunas para cobrir chaves gravadas em license_key ou user_key
    const { data: updated, error: updErr } = await supabase
      .from("licenses")
      .update({ status: action })
      .or(`license_key.eq.${providedKey},user_key.eq.${providedKey}`)
      .select("id, license_key, user_key, status")
      .maybeSingle();

    if (updErr) {
      console.error("[admin] erro ao atualizar license:", updErr);
      return res.status(500).json({ error: "Falha ao atualizar licença" });
    }

    if (!updated) {
      return res.status(404).json({ error: "Licença não encontrada" });
    }

    // Registrar evento administrativo (não afeta status real, só trilha)
    const now = new Date().toISOString();
    await supabase.from("license_activations").insert({
      license_key: updated.license_key || updated.user_key || providedKey,
      device_id: "ADMIN_ACTION",
      source: "ADMIN_PANEL",
      user_status: action,
      activated_at: now,
      last_seen_at: now,
      user_agent: "admin-app"
    });

    return res.json({ ok: true, license_key: updated.license_key || providedKey, status: updated.status });
  } catch (err) {
    console.error("[admin] erro interno:", err?.message || err);
    return res.status(500).json({ error: "Erro interno" });
  }
});

app.post("/api/license/activate", async (req, res) => {
  const { license_key, user_key, email, device_id, source } = req.body || {};
  const providedKey = license_key || user_key;

  if (!providedKey || !email || !device_id) {
    return res.status(400).json({ error: "license_key (ou user_key), email e device_id são obrigatórios" });
  }

  try {
    // Fetch license by either license_key or user_key
    const license = await fetchLicense(providedKey);
    console.log("[activate] fetchLicense result:", {
      found: !!license,
      key: maskKey(providedKey),
      id: license?.id,
      status: license?.status,
      device: maskKey(license?.deviceId || "<none>"),
      maxDevices: license?.maxDevices
    });

    if (!license) return res.status(404).json({ error: "Licença não encontrada" });
    if (license.status === "blocked") return res.status(403).json({ error: "Licença bloqueada" });
    if (isExpired(license.expiresAt)) return res.status(403).json({ error: "Licença expirada" });

    const now = new Date().toISOString();
    const isTransfer = license.deviceId && license.deviceId !== device_id;

    if (isTransfer) {
      console.warn("[activate] transfer requested", { key: maskKey(providedKey), from: maskKey(license.deviceId), to: maskKey(device_id) });
    }

    const blockOtherActivations = async () => {
      try {
        requireSupabaseReady();
        const { error: blockErr } = await supabase
          .from("license_activations")
          .update({ user_status: 'blocked', last_seen_at: now })
          .eq("license_key", providedKey)
          .neq("device_id", device_id);
        if (blockErr) console.error("[activate] erro ao bloquear ativações antigas:", blockErr);
        else console.log("[activate] outras ativações bloqueadas", { key: maskKey(providedKey), keep: maskKey(device_id) });
      } catch (blockEx) {
        console.error("[activate] falha ao bloquear ativações antigas:", blockEx);
      }
    };

    const upsertActivation = async () => {
      try {
        requireSupabaseReady();
        const userAgent = req.headers["user-agent"] || null;
        const activationData = {
          license_key: providedKey,
          device_id,
          email,
          source: source || null,
          activated_at: now,
          last_seen_at: now,
          user_agent: userAgent,
          user_status: 'active'
        };
        const { error: activationError } = await supabase
          .from("license_activations")
          .upsert(activationData, { onConflict: "license_key,device_id" });
        if (activationError) console.error("Erro ao registrar ativação em license_activations:", activationError);
        else console.log("[activate] activation upserted", { key: maskKey(providedKey), device: maskKey(device_id), source: source || null });
      } catch (activationErr) {
        console.error("Falha ao registrar ativação em license_activations:", activationErr);
      }
    };

    // Se já está ativa, garante bind do primeiro device e registra ativação
    if (license.status === "active") {
      if (!license.deviceId || isTransfer) {
        try {
          requireSupabaseReady();
          const keyColumn = license.keyColumn || "license_key";
          const keyValue = license.key || providedKey;
          const { error: bindError } = await supabase
            .from("licenses")
            .update({ device_id: device_id, last_used: now })
            .eq(keyColumn, keyValue);
          if (bindError) console.error("[activate] falha ao bindar device_id em licença ativa:", bindError);
          else console.log("[activate] bound device to active license", { key: maskKey(providedKey), device: maskKey(device_id), transfer: isTransfer });
        } catch (bindErr) {
          console.error("[activate] erro ao bindar device_id em licença ativa:", bindErr);
        }
      }
      await blockOtherActivations();
      await upsertActivation();
      return res.json({ status: "active", expires_at: license.expiresAt || null });
    }

    requireSupabaseReady();

    // Use the column and value returned by the loaded license for the update
    const keyColumn = license.keyColumn || "license_key";
    const keyValue = license.key || license_key;

    console.log("[activate] preparing update:", { id: license.id, keyColumn, keyValue, incomingDeviceId: device_id });

    // Build notes (normalize source)
    let notes = req.body?.notes || "";
    const src = String(source || "").toLowerCase();
    if (!notes) {
      if (src === "pwa") notes = "ativado via PWA";
      else if (src === "ecww") notes = "ativado via Extensão Chrome WhatsApp";
    }

    // Permite device_id como string longa (mínimo 12 caracteres), não só UUID
    let deviceToSet = null;
    if (typeof device_id === "string" && device_id.length >= 12) {
      deviceToSet = device_id;
    } else {
      console.warn("[activate] device_id muito curto ou ausente, gravando NULL:", device_id);
    }

    // Perform update and request the updated row back
    const { data: updatedData, error: updateError } = await supabase
      .from("licenses")
      .update({
        status: "active",
        email,
        device_id: deviceToSet,
        notes,
        activated_at: now,
        last_used: now
      })
      .eq(keyColumn, keyValue)
      .select("*")
      .maybeSingle();

    if (updateError) {
      // Log full error object for debugging
      console.error("[activate] update failed:", updateError);
      return res.status(500).json({ error: "Erro ao ativar licença", detail: updateError.message || updateError });
    }

    if (!updatedData) {
      console.warn("[activate] update retornou sem linha (verifique keyColumn/searchKeyValue):", { keyColumn, searchKeyValue });
      return res.status(500).json({ error: "Falha ao recuperar licença atualizada" });
    }

    const updated = normalizeLicense(updatedData);
    console.log("[activate] licença atualizada com sucesso:", { id: updated.id, key: maskKey(updated.key), deviceId: maskKey(updated.deviceId) });

    await blockOtherActivations();
    await upsertActivation();

    return res.json({ status: "active", expires_at: updated.expiresAt || null });
  } catch (err) {
    console.error("/api/license/activate error", err?.message || err);
    return res.status(500).json({ error: "Erro ao processar ativação" });
  }
});

app.post("/whatsapp/copilot", licenseMiddleware, async (req, res) => {
  try {
    const normalized = normalizeCopilotMessages(req.body?.messages);
    if (!normalized.length) return res.status(400).json({ error: "Mensagens inválidas." });

    const { system, user } = buildCopilotPrompt(normalized);
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    });

    const draft = completion.choices?.[0]?.message?.content?.trim();
    if (!draft) return res.status(500).json({ error: "Não consegui gerar o rascunho." });

    const parsed = parseCopilotResponse(draft);
    return res.json({ analysis: parsed.analysis, suggestion: parsed.suggestion, draft: parsed.suggestion || draft, raw: draft });
  } catch (err) {
    console.error("/whatsapp/copilot error", err?.response?.data || err.message || err);
    return res.status(500).json({ error: "Falha ao processar." });
  }
});

const draftHandler = async (req, res) => {
  try {
    if (empreendimentosLoadError) return res.status(503).json({ error: "Base de empreendimentos indisponível." });

    let { mensagens, message } = req.body || {};
    if (!mensagens && message) mensagens = [message];
    if (!mensagens) return res.status(400).json({ error: "Campo 'mensagens' é obrigatório" });
    if (!Array.isArray(mensagens)) mensagens = [mensagens];

    const msg = mensagens[mensagens.length - 1];
    if (!msg || typeof msg !== "string") return res.status(400).json({ error: "Mensagem inválida" });

    const { list: candidates, reason, bairros, tipKeys, msgNorm } = findCandidates(msg);
    console.log("[findCandidates]", { reason, bairros, tipKeys, total: candidates?.length });

    if (!candidates || candidates.length === 0) {
      const isImobIntent = isRealEstateIntent(msgNorm);
      const payload = isImobIntent ? buildFallbackPayload({ msg, msgNorm }) : await buildSmalltalkPayload({ msg, msgNorm });
      return res.json({ draft: payload.resposta || "", followups: payload.followups || [], raw: payload });
    }

    const prompt = buildPromptForMessage({ mensagem: msg, empreendimentos: candidates });
    let payload = null;

    try {
      const response = await openai.responses.create({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        input: [
          { role: "system", content: prompt },
          { role: "user", content: msg }
        ],
        text: { format: "json" },
        max_output_tokens: 1500,
        temperature: 0,
        top_p: 1
      });

      const modelText = response.output_text || response.output?.[0]?.content?.[0]?.text || "";
      try {
        const parsed = JSON.parse(modelText);
        if (parsed && typeof parsed === "object" && typeof parsed.resposta === "string") {
          payload = parsed;
        }
      } catch (e) {
        // fallback handled below
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

    if (!payload) payload = buildDeterministicPayload(candidates) || buildFallbackPayload({ msg, msgNorm });

    payload.resposta = removeAISignature(payload.resposta || "");

    if (APPEND_SIGNATURE && typeof payload.resposta === "string") {
      const normalized = payload.resposta.trim();
      const shouldAppend = shouldAppendSignature({ mode: APPEND_SIGNATURE_MODE, userText: msg, aiText: normalized });
      payload.resposta = shouldAppend ? `${normalized}\n\n${SIGNATURE}` : normalized;
    }

    return res.json({
      draft: payload.resposta || "",
      followups: payload.followups || [],
      raw: payload
    });
  } catch (err) {
    console.error("/whatsapp/draft error", err?.response?.data || err.message || err);
    return res.status(500).json({ error: "Erro ao gerar rascunho" });
  }
};

app.post("/whatsapp/draft", licenseMiddleware, draftHandler);

app.get("/debug/match", (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "Parâmetro 'q' é obrigatório" });
  const { list, reason, bairros } = findCandidates(q);
  const items = (list || []).map((e) => ({ nome: e.nome, bairro: e.bairro, tipologia: e.tipologia || e.tipologias, entrega: e.entrega }));
  return res.json({ reason, bairros: bairros || [], total: items.length, items });
});

app.get("/", (_req, res) => res.send("HEROIA-FULL backend ok"));

const server = app.listen(PORT, () => {
  console.log(`HEROIA-FULL backend em http://localhost:${PORT}`);
});

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} já está em uso.`);
    process.exit(1);
  }
  console.error("Erro no servidor:", err);
  process.exit(1);
});
