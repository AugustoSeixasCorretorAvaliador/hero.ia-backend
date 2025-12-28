app.post("/whatsapp/draft", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.json({
        resposta: "Pode me dizer um pouco mais do que você procura? 😊",
        origem: "mensagem_vazia",
      });
    }

    const result = findCandidates(message);

    /* ===== FALLBACKS SEM OPENAI ===== */

    if (result.list.length === 0) {
      let resposta;

      switch (result.reason) {
        case "bairro+tipologia_sem_match":
          resposta = `Não encontrei imóveis com essa tipologia nesse bairro no momento. Quer ver outras opções em ${result.bairros.join(
            ", "
          )} ou prefere outro bairro? 😊`;
          break;

        case "tipologia_sem_match":
          resposta =
            "Tenho opções disponíveis, mas preciso saber o bairro ou empreendimento específico para te orientar melhor 😊";
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

    /* ===== SE NÃO TIVER OPENAI, RESPONDE SEM IA ===== */

    if (!openai) {
      const lista = result.list
        .map(
          (e) =>
            `${e.nome} em ${e.bairro} — Tipologias: ${e.tipologias.join(", ")}`
        )
        .join(" | ");

      return res.json({
        resposta: `Encontrei estas opções reais na base: ${lista}. Quer que eu detalhe alguma delas? 😊`,
        origem: "sem_openai",
      });
    }

    /* ===== OPENAI SÓ PARA REDAÇÃO ===== */

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

Gere uma resposta clara, objetiva e profissional.
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
  } catch (err) {
    console.error("❌ ERRO HERO.IA:", err);

    return res.json({
      resposta:
        "Tive um pequeno problema técnico agora. Pode tentar novamente em alguns segundos? 😊",
      origem: "erro_backend",
    });
  }
});
