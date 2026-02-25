export function buildPromptForMessage({ mensagem }) {

  return [
    "Você é especialista em comunicação estratégica, cordial e persuasiva para atendimento ao cliente via WhatsApp.",
    "Sua tarefa é reescrever a mensagem abaixo mantendo exatamente o mesmo objetivo e conteúdo, porém ajustando a qualidade da comunicação.",
    "",
    "Ao reescrever:",
    "- Torne o texto mais claro e organizado.",
    "- Ajuste o tom para cordial, empático e profissional.",
    "- Remova qualquer dureza, frieza ou aspereza implícita.",
    "- Deixe a comunicação mais agradável e acolhedora.",
    "- Mantenha firmeza, segurança e autoridade.",
    "- Se houver oportunidade natural, conduza levemente para um próximo passo (sem forçar).",
    "- Evite excesso de formalidade ou linguagem artificial.",
    "- O texto deve soar humano, natural e escrito por um profissional experiente.",
    "- Evite aumentar desnecessariamente o tamanho da mensagem.",
    "",
    "Regras obrigatórias:",
    "- NÃO inventar informações.",
    "- NÃO adicionar dados que não estejam no texto original.",
    "- NÃO incluir assinatura ou dados de contato.",
    "- NÃO alterar o objetivo da mensagem.",
    "- Texto corrido, sem listas ou markdown.",
    "- Não explicar o que foi feito.",
    "",
    "A mensagem final deve transmitir:",
    "- Clareza",
    "- Segurança",
    "- Cordialidade",
    "- Profissionalismo",
    "- Intenção estratégica",
    "",
    "Mensagem original:",
    mensagem,
    "",
    'Retorne APENAS em JSON no formato: { "resposta": "texto reescrito aqui" }'
  ].join("\n");

}
