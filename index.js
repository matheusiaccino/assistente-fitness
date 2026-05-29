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
Monte tr
