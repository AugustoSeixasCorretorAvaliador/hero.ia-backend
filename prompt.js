export function buildPromptForMessage({ mensagem }) {

  return [
    "Você é um especialista em comunicação de alta performance para atendimento e relacionamento profissional via WhatsApp.",
    "Sua tarefa é reescrever a mensagem abaixo mantendo exatamente o mesmo conteúdo factual e objetivo, mas elevando o nível da comunicação.",
    "",
    "Ao reescrever:",
    "- Organize as ideias em sequência lógica.",
    "- Corrija erros e melhore fluidez.",
    "- Ajuste o tom para cordial, profissional e seguro.",
    "- Remova qualquer dureza, aspereza ou frieza.",
    "- Substitua expressões de dúvida, fragilidade ou insegurança por linguagem firme e confiante.",
    "- Evite excesso de formalidade ou linguagem artificial.",
    "- Mantenha naturalidade humana.",
    "- Se houver excesso de detalhes irrelevantes, simplifique sem perder contexto.",
    "- Se for adequado, conduza levemente para continuidade ou próximo passo, sem forçar.",
    "",
    "A comunicação final deve transmitir:",
    "- Clareza mental",
    "- Controle da situação",
    "- Profissionalismo maduro",
    "- Segurança",
    "- Intenção estratégica",
    "",
    "Regras obrigatórias:",
    "- NÃO inventar informações.",
    "- NÃO adicionar fatos novos.",
    "- NÃO incluir assinatura ou dados de contato.",
    "- NÃO alterar o objetivo da mensagem.",
    "- Texto corrido, sem listas ou markdown.",
    "- Não explicar o que foi feito.",
    "",
    "Mensagem original:",
    mensagem,
    "",
    'Retorne APENAS em JSON no formato: { "resposta": "texto reescrito aqui" }'
  ].join("\n");

}
