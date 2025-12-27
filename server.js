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
  return { ...e, descricao: desc };
});

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

    const prompt = buildPromptForMessage({ mensagem: msg, empreendimentos });

    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: prompt },
        { role: "user", content: msg }
      ],
      max_output_tokens: 2000,
      temperature: 0.3
    });

    const modelText = response.output_text || "";

    // Função para remover qualquer assinatura que a IA tenha incluído indevidamente
    function removeAISignature(text) {
      // Remove emojis e dados de contato que a IA possa ter incluído
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
      signaturePatterns.forEach(pattern => {
        cleaned = cleaned.replace(pattern, '');
      });
      
      return cleaned.trim();
    }

    // Tenta interpretar como JSON no formato { resposta, followups, ... }
    let draftOut = modelText;
    try {
      const parsed = JSON.parse(modelText);
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.resposta === "string") {
          // Remove qualquer assinatura que a IA tenha incluído
          parsed.resposta = removeAISignature(parsed.resposta);
          
          if (APPEND_SIGNATURE) {
            const normalized = parsed.resposta.trim();
            const shouldAppend = shouldAppendSignature({
              mode: APPEND_SIGNATURE_MODE,
              userText: msg,
              aiText: normalized
            });
            parsed.resposta = shouldAppend ? `${normalized}\n\n${SIGNATURE}` : normalized;
          }
        }
        // Preserva as quebras de linha ao serializar o JSON
        draftOut = JSON.stringify(parsed, null, 0);
      }
    } catch (e) {
      // Não é JSON; apenas adiciona a assinatura ao texto bruto conforme modo
      if (typeof draftOut === "string") {
        draftOut = removeAISignature(draftOut);
        
        if (APPEND_SIGNATURE) {
          const normalized = draftOut.trim();
          const shouldAppend = shouldAppendSignature({
            mode: APPEND_SIGNATURE_MODE,
            userText: msg,
            aiText: normalized
          });
          draftOut = shouldAppend ? `${normalized}\n\n${SIGNATURE}` : normalized;
        }
      }
    }

    return res.json({ draft: draftOut });
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