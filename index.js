const express = require('express');
const app = express();
app.use(express.json());

const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const historicos = {};
const assinantes = {};

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

async function enviarMensagem(phone, mensagem) {
  try {
    const EVOLUTION_URL = process.env.EVOLUTION_URL;
    const EVOLUTION_KEY = process.env.EVOLUTION_KEY;
    const INSTANCE = process.env.EVOLUTION_INSTANCE;

    await fetch(`${EVOLUTION_URL}/message/sendText/${INSTANCE}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': EVOLUTION_KEY
      },
      body: JSON.stringify({
        number: phone,
        text: mensagem
      })
    });
  } catch (error) {
    console.error('Erro ao enviar mensagem:', error);
  }
}

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    // Ignora se não for mensagem
    if (body.event !== 'messages.upsert') return res.sendStatus(200);

    const msg = body.data?.message;
    if (!msg) return res.sendStatus(200);

    // Pega o texto da mensagem
    const texto = msg.message?.conversation || 
                  msg.message?.extendedTextMessage?.text || '';
    
    if (!texto) return res.sendStatus(200);

    // Ignora mensagens do próprio bot
    if (msg.key?.fromMe) return res.sendStatus(200);

    const phone = msg.key?.remoteJid?.replace('@s.whatsapp.net', '');
    if (!phone) return res.sendStatus(200);

    const plano = assinantes[phone] || null;

    if (!historicos[phone]) historicos[phone] = [];

    historicos[phone].push({ role: 'user', content: texto });

    if (historicos[phone].length > 20) {
      historicos[phone] = historicos[phone].slice(-20);
    }

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: getSystemPrompt(plano),
      messages: historicos[phone]
    });

    const resposta = response.content[0].text;

    historicos[phone].push({ role: 'assistant', content: resposta });

    await enviarMensagem(phone, resposta);

    res.sendStatus(200);
  } catch (error) {
    console.error('Erro:', error);
    res.sendStatus(500);
  }
});

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
