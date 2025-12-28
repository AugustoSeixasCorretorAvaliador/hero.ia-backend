// ===============================
// WhatsApp AI Draft - content.js
// ===============================

const BACKEND_URL = "http://localhost:3001/whatsapp/draft";
const BUTTON_ID = "ai-draft-btn";

/* ===============================
   Utilidades
================================ */

// Retorna as últimas N mensagens do chat (entrada e saída)
function getLastMessages(limit = 3) {
  const messages = document.querySelectorAll(
    "div.message-in span.selectable-text, div.message-out span.selectable-text"
  );

  if (!messages.length) return [];

  return Array.from(messages)
    .slice(-limit)
    .map(el => el.innerText.trim())
    .filter(Boolean);
}

// Insere texto no campo de digitação
function insertTextInComposer(text) {
  const editor = document.querySelector("[contenteditable='true']");
  if (!editor) return;

  editor.focus();
  editor.innerHTML = "";
  document.execCommand("insertText", false, text);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

/* ===============================
   Função principal (GLOBAL)
================================ */

window.gerarRascunho = async function gerarRascunho() {
  const mensagens = getLastMessages(3);

  if (!mensagens.length) {
    alert("Não foi possível ler mensagens do chat.");
    return;
  }

  try {
    const response = await fetch(BACKEND_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        mensagens
      })
    });

    if (!response.ok) {
      throw new Error("Erro ao chamar backend");
    }

    const data = await response.json();

    if (data.draft) {
      insertTextInComposer(data.draft);
    } else {
      alert("Backend não retornou rascunho.");
    }

  } catch (err) {
    console.error("ERRO FRONTEND:", err);
    alert("Erro ao gerar rascunho. Verifique o backend.");
  }
};

/* ===============================
   Botão
================================ */

function injectButton() {
  const footer = document.querySelector("footer");
  if (!footer) return;

  if (document.getElementById(BUTTON_ID)) return;

  const btn = document.createElement("button");
  btn.id = BUTTON_ID;
  btn.innerText = "✍️ Gerar rascunho";

  btn.style.marginLeft = "8px";
  btn.style.padding = "6px 12px";
  btn.style.borderRadius = "6px";
  btn.style.border = "none";
  btn.style.cursor = "pointer";
  btn.style.background = "#25D366";
  btn.style.color = "#fff";
  btn.style.fontSize = "13px";
  btn.style.fontWeight = "600";

  btn.onclick = window.gerarRascunho;

  footer.appendChild(btn);
}

/* ===============================
   Observador (SPA WhatsApp)
================================ */

const observer = new MutationObserver(() => {
  injectButton();
});

observer.observe(document.body, {
  childList: true,
  subtree: true
});

// Primeira tentativa imediata
setTimeout(injectButton, 1000);
