const express = require('express');
const app = express();
app.use(express.json());
const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const historicos = {};
const assinantes = {};
function getSystemPrompt(plano) {
  const base = 'Voce e o FitBot, assistente de saude e bem-estar via WhatsApp. Seja motivador, direto e amigavel. Use emojis com moderacao. Responda sempre em portugues brasileiro.';
  if (plano === 'treino') return base + ' Voce e especialista em TREINOS. Monte treinos personalizados, sugira exercicios, series e repeticoes. Pergunte sobre objetivo, nivel e equipamentos. NAO de dicas de dieta.';
  if (plano === 'dieta') return base + ' Voce e especialista em NUTRICAO. Monte cardapios, calcule calorias, sugira substituicoes. Pergunte sobre objetivo e restricoes. NAO de dicas de treino.';
  if (plano === 'completo') return base + ' Voce e especialista em TREINO e NUTRICAO. Monte treinos E cardapios completos.';
  return base + ' O usuario ainda nao tem plano ativo. Apresente-se e informe os planos: Plano Treino R$29/mes, Plano Dieta R$29/mes, Plano Completo R$39/mes. Diga para assinar acessar: [seu link aqui]';
}
async function enviarMensagem(phone, mensagem) {
  try {
    await fetch(process.env.EVOLUTION_URL + '/message/sendText/' + process.env.EVOLUTION_INSTANCE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': process.env.EVOLUTION_KEY },
      body: JSON.stringify({ number: phone, text: mensagem })
    });
  } catch (error) {
    console.error('Erro ao enviar:', error);
  }
}
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    console.log('Recebido:', JSON.stringify(body).substring(0, 300));
    if (body.event !== 'messages.upsert') return res.sendStatus(200);
    const data = body.data;
    if (!data) return res.sendStatus(200);
    if (data.key && data.key.fromMe === true) return res.sendStatus(200);
    const texto = (data.message && (data.message.conversation || (data.message.extendedTextMessage && data.message.extendedTextMessage.text))) || '';
    if (!texto.trim()) return res.sendStatus(200);
    const phone = data.key && data.key.remoteJid && data.key.remoteJid.replace('@s.whatsapp.net', '');
    if (!phone) return res.sendStatus(200);
    console.log('Mensagem de', phone, ':', texto);
    if (!historicos[phone]) historicos[phone] = [];
    historicos[phone].push({ role: 'user', content: texto });
    if (historicos[phone].length > 20) historicos[phone] = historicos[phone].slice(-20);
    const plano = assinantes[phone] || 'completo';
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: getSystemPrompt(plano),
      messages: historicos[phone]
    });
    const resposta = response.content[0].text;
    console.log('Resposta:', resposta.substring(0, 100));
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
  if (secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Nao autorizado' });
  assinantes[phone] = plano;
  res.json({ success: true, phone, plano });
});
app.get('/', (req, res) => { res.json({ status: 'FitBot rodando!' }); });
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log('FitBot rodando na porta ' + PORT); });
