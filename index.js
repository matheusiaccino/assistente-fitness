const express = require('express');
const app = express();
app.use(express.json());

const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Histórico de conversas por usuário
const historicos = {};

// Sistema de planos (simulado - depois integra com Hotmart)
const assinantes = {
  // Formato: "5569999999999": "completo" | "treino" | "dieta"
};

function getSystemPrompt(plano) {
  const base = `Você é o FitBot, assistente de saúde e bem-estar via WhatsApp.
Seja sempre motivador, direto e amigável. Use emojis com moderação.
Responda sempre em português brasileiro.`;

  if (plano === 'treino') {
    return base + `\nVocê é especialista em TREINOS. Monte treinos personalizados, 
sugira exercícios, séries e repetições. Pergunte sobre objetivo, nível e equipamentos disponíveis.
NÃO dê dicas de dieta (isso é plano separado).`;
  }

  if (plano === 'dieta') {
    return base + `\nVocê é especialista em NUTRIÇÃO. Monte cardápios, calcule calorias, 
sugira substituições saudáveis e receitas práticas. Pergunte sobre objetivo, restrições e rotina.
NÃO dê dicas de treino (isso é plano separado).`;
  }

  if (plano === 'completo') {
    return base + `\nVocê é especialista em TREINO e NUTRIÇÃO. 
Monte treinos personalizados E cardápios completos. 
Pergunte sobre objetivo, nível de condicionamento, restrições alimentares e equipamentos disponíveis.`;
  }

  return base + `\nO usuário ainda não tem plano ativo. 
Apresente-se brevemente e informe os planos disponíveis:
🏋️ Plano Treino - R$ 29/mês
🥗 Plano Dieta - R$ 29/mês  
🔥 Plano Completo (Treino + Dieta) - R$ 39/mês
Diga que para assinar é só acessar: [seu link aqui]`;
}

app.post('/webhook', async (req, res) => {
  try {
    const { phone, message } = req.body;

    if (!phone || !message) {
      return res.status(400).json({ error: 'phone e message são obrigatórios' });
    }

    // Verifica plano do usuário
    const plano = assinantes[phone] || null;

    // Inicializa histórico se não existir
    if (!historicos[phone]) {
      historicos[phone] = [];
    }

    // Adiciona mensagem do usuário ao histórico
    historicos[phone].push({
      role: 'user',
      content: message
    });

    // Limita histórico a 20 mensagens (para não gastar muitos créditos)
    if (historicos[phone].length > 20) {
      historicos[phone] = historicos[phone].slice(-20);
    }

    // Chama a API do Claude
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: getSystemPrompt(plano),
      messages: historicos[phone]
    });

    const resposta = response.content[0].text;

    // Adiciona resposta ao histórico
    historicos[phone].push({
      role: 'assistant',
      content: resposta
    });

    res.json({ reply: resposta });

  } catch (error) {
    console.error('Erro:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Rota para adicionar/atualizar assinante (chamada pelo Hotmart)
app.post('/assinante', (req, res) => {
  const { phone, plano, secret } = req.body;
  
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Não autorizado' });
  }

  assinantes[phone] = plano;
  res.json({ success: true, phone, plano });
});

app.get('/', (req, res) => {
  res.json({ status: 'FitBot rodando!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FitBot rodando na porta ${PORT}`);
});
