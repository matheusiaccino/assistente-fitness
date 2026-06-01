const express = require('express');
const app = express();
app.use(express.json());
const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const usuarios = {};

function getUsuario(phone) {
  if (!usuarios[phone]) {
    usuarios[phone] = { etapa: 'menu', contrato: {} };
  }
  return usuarios[phone];
}

const TIPOS_CONTRATO = {
  '1': 'Prestação de Serviços',
  '2': 'Aluguel de Imóvel',
  '3': 'Compra e Venda',
  '4': 'Contrato de Trabalho',
  '5': 'Parceria / Sociedade',
  '6': 'Outro'
};

const PERGUNTAS = {
  'Prestação de Serviços': [
    'Qual é o seu nome completo e CPF ou CNPJ?',
    'Qual é o nome completo e CPF ou CNPJ do cliente?',
    'Qual serviço será prestado? Descreva com detalhes.',
    'Qual o valor combinado pelo serviço?',
    'Como será o pagamento? (à vista, parcelado ou mensal)',
    'Qual a data de início do serviço?',
    'Tem prazo de término ou é indeterminado?',
    'O serviço será presencial ou remoto?',
    'Haverá multa por cancelamento? Se sim, qual o valor?'
  ],
  'Aluguel de Imóvel': [
    'Qual o nome completo e CPF do proprietário?',
    'Qual o nome completo e CPF do inquilino?',
    'Qual o endereço completo do imóvel?',
    'Qual o valor do aluguel mensal?',
    'Qual o dia de vencimento do aluguel?',
    'Qual a duração do contrato? (ex: 12 meses)',
    'Haverá depósito caução? Se sim, qual o valor?',
    'Quem pagará água, luz e condomínio?',
    'Permite animais de estimação? Permite reformas?',
    'Haverá fiador? Se sim, qual o nome e CPF?'
  ],
  'Compra e Venda': [
    'Qual o nome completo e CPF do vendedor?',
    'Qual o nome completo e CPF do comprador?',
    'O que está sendo vendido? (imóvel, veículo, outro)',
    'Descreva detalhadamente o bem sendo vendido.',
    'Qual o valor total da venda?',
    'Como será o pagamento? (à vista, parcelado, financiado)',
    'Qual a data de entrega ou transferência do bem?',
    'O bem possui algum defeito conhecido?',
    'Haverá multa em caso de desistência?'
  ],
  'Contrato de Trabalho': [
    'Qual o nome e CNPJ da empresa contratante?',
    'Qual o nome completo e CPF do funcionário?',
    'Qual a função ou cargo?',
    'Qual o salário combinado?',
    'Qual a carga horária semanal?',
    'Qual a data de início?',
    'É CLT, PJ ou contrato de experiência?',
    'Quais benefícios? (VT, VR, plano de saúde, etc)',
    'Haverá período de experiência? Qual a duração?'
  ],
  'Parceria / Sociedade': [
    'Quais os nomes e CPF ou CNPJ de todos os sócios?',
    'Qual o objetivo do negócio ou parceria?',
    'Qual a porcentagem de participação de cada sócio?',
    'Quanto cada sócio irá investir inicialmente?',
    'Como será feita a divisão de lucros?',
    'Quem ficará responsável pelas decisões do dia a dia?',
    'O que acontece se um sócio quiser sair?',
    'O contrato tem prazo definido ou é indeterminado?'
  ],
  'Outro': [
    'Descreva com detalhes o que você precisa no contrato.',
    'Quais são as partes envolvidas? (nomes e CPFs)',
    'Quais são as obrigações de cada parte?',
    'Qual o valor envolvido, se houver?',
    'Qual o prazo do contrato?',
    'Há alguma cláusula específica que deseja incluir?'
  ]
};

async function gerarContrato(tipo, dados) {
  const prompt = `Você é um especialista em contratos jurídicos brasileiros.
Gere um contrato completo e profissional de ${tipo} com base nas seguintes informações:

${dados.map((d, i) => `${PERGUNTAS[tipo][i]}\nResposta: ${d}`).join('\n\n')}

O contrato deve:
- Estar em conformidade com a legislação brasileira vigente
- Ter linguagem formal e profissional
- Incluir todas as cláusulas necessárias para esse tipo de contrato
- Ter data em branco para preenchimento no momento da assinatura
- Incluir espaço para assinaturas das partes e duas testemunhas

Gere o contrato completo agora.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }]
  });

  return response.content[0].text;
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

function menuPrincipal() {
  return `Olá! 👋 Sou o *ContratoBot*, seu assistente de contratos profissionais! ⚖️

Gero contratos completos e personalizados em minutos!

⚠️ *Aviso importante:* Nossos contratos são gerados com base nas informações fornecidas e não substituem a assessoria de um advogado. Para situações complexas, recomendamos consultar um profissional jurídico.

Qual tipo de contrato você precisa?

1️⃣ Prestação de Serviços
2️⃣ Aluguel de Imóvel
3️⃣ Compra e Venda
4️⃣ Contrato de Trabalho
5️⃣ Parceria / Sociedade
6️⃣ Outro

Responda com o número da opção desejada.`;
}

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    if (body.event !== 'messages.upsert') return res.sendStatus(200);
    const data = body.data;
    if (!data) return res.sendStatus(200);
    if (data.key && data.key.fromMe === true) return res.sendStatus(200);
    const texto = (data.message && (data.message.conversation || (data.message.extendedTextMessage && data.message.extendedTextMessage.text))) || '';
    if (!texto.trim()) return res.sendStatus(200);
    const phone = data.key && data.key.remoteJid && data.key.remoteJid.replace('@s.whatsapp.net', '');
    if (!phone) return res.sendStatus(200);

    const usuario = getUsuario(phone);
    const msg = texto.trim();
    console.log('Mensagem de', phone, ':', msg, '| Etapa:', usuario.etapa);

    // Menu principal
    if (usuario.etapa === 'menu') {
      if (TIPOS_CONTRATO[msg]) {
        const tipo = TIPOS_CONTRATO[msg];
        usuario.contrato = { tipo, dados: [], perguntaAtual: 0 };
        usuario.etapa = 'coletando';
        await enviarMensagem(phone, `Ótimo! Vou gerar seu contrato de *${tipo}*. 📋\n\nPreciso de algumas informações rápidas!\n\n*Pergunta 1 de ${PERGUNTAS[tipo].length}:*\n${PERGUNTAS[tipo][0]}`);
      } else {
        await enviarMensagem(phone, menuPrincipal());
      }
      return res.sendStatus(200);
    }

    // Coletando dados
    if (usuario.etapa === 'coletando') {
      const { tipo, dados, perguntaAtual } = usuario.contrato;
      dados.push(msg);
      const proxima = perguntaAtual + 1;

      if (proxima < PERGUNTAS[tipo].length) {
        usuario.contrato.perguntaAtual = proxima;
        await enviarMensagem(phone, `*Pergunta ${proxima + 1} de ${PERGUNTAS[tipo].length}:*\n${PERGUNTAS[tipo][proxima]}`);
      } else {
        usuario.etapa = 'gerando';
        await enviarMensagem(phone, `Perfeito! Tenho todas as informações. ✅\n\nGerando seu contrato de *${tipo}*, aguarde um instante... ⏳`);

        const contrato = await gerarContrato(tipo, dados);
        usuario.contrato.texto = contrato;
        usuario.etapa = 'revisao';

        await enviarMensagem(phone, `✅ *Seu contrato está pronto!*\n\n${contrato}\n\n---\n\nDeseja alguma *alteração*? Me diga o que mudar que refaço na hora! 😊\n\nOu digite *NOVO* para gerar outro contrato.`);
      }
      return res.sendStatus(200);
    }

    // Revisão
    if (usuario.etapa === 'revisao') {
      if (msg.toUpperCase() === 'NOVO') {
        usuario.etapa = 'menu';
        usuario.contrato = {};
        await enviarMensagem(phone, menuPrincipal());
        return res.sendStatus(200);
      }

      await enviarMensagem(phone, `Entendido! Aplicando as modificações... ⏳`);
      const atualizado = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [
          { role: 'user', content: `Aqui está um contrato:\n\n${usuario.contrato.texto}` },
          { role: 'assistant', content: usuario.contrato.texto },
          { role: 'user', content: `Faça as seguintes modificações no contrato: ${msg}\n\nRetorne o contrato completo com as modificações aplicadas.` }
        ]
      });

      usuario.contrato.texto = atualizado.content[0].text;
      await enviarMensagem(phone, `✅ *Contrato atualizado!*\n\n${usuario.contrato.texto}\n\n---\n\nDeseja mais alguma *alteração*? Ou digite *NOVO* para gerar outro contrato.`);
      return res.sendStatus(200);
    }

  } catch (error) {
    console.error('Erro:', error);
    res.sendStatus(500);
  }
});

app.get('/', (req, res) => { res.json({ status: 'ContratoBot rodando!' }); });
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log('ContratoBot rodando na porta ' + PORT); });
