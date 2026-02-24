export function buildPromptForMessage({ mensagem, empreendimentos }) {

  return [
    "Você é especialista em comunicação estratégica e persuasiva.",
    "Sua tarefa é reescrever a mensagem abaixo de forma mais fluida, organizada, clara e estratégica.",
    "Regras obrigatórias:",
    "- Não inventar informações.",
    "- Não adicionar dados que não estejam no texto original.",
    "- Não incluir assinatura ou dados de contato.",
    "- Manter exatamente o mesmo objetivo e sentido da mensagem.",
    "- Texto corrido, sem listas ou markdown.",
    "- Não explicar o que fez.",
    "Mensagem original:",
    mensagem,
    'Retorne APENAS em JSON no formato: { "resposta": "texto reescrito aqui" }'
  ].join("\n");

}
