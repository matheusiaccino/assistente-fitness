const express = require('express');
const app = express();
app.use(express.json());
const Anthropic = require('@anthropic-ai/sdk');
const PDFDocument = require('pdfkit');
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

IMPORTANTE - Formate o contrato usando estas marcações exatas:
- Títulos principais (ex: CONTRATO DE...): use [TITULO]texto[/TITULO]
- Títulos de cláusulas (ex: CLÁUSULA PRIMEIRA): use [CLAUSULA]texto[/CLAUSULA]
- Texto em negrito importante: use [NEGRITO]texto[/NEGRITO]
- Parágrafos normais: texto normal sem marcação

O contrato deve:
- Estar em conformidade com a legislação brasileira vigente
- Ter linguagem formal e profissional
- Incluir todas as cláusulas necessárias
- Ter data em branco para preenchimento
- Incluir espaço para assinaturas das partes e duas testemunhas

Gere o contrato completo agora.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }]
  });

  return response.content[0].text;
}

function gerarPDF(textoContrato) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 60, size: 'A4' });
    const chunks = [];

    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    // Divide o texto em linhas
    const linhas = textoContrato.split('\n');

    for (const linha of linhas) {
      const trimmed = linha.trim();
      if (!trimmed) {
        doc.moveDown(0.5);
        continue;
      }

      // Título principal
      if (trimmed.startsWith('[TITULO]')) {
        const texto = trimmed.replace('[TITULO]', '').replace('[/TITULO]', '');
        doc.moveDown(0.5);
        doc.fontSize(14).font('Helvetica-Bold').text(texto, { align: 'center' });
        doc.moveDown(0.5);
        continue;
      }

      // Título de cláusula
      if (trimmed.startsWith('[CLAUSULA]')) {
        const texto = trimmed.replace('[CLAUSULA]', '').replace('[/CLAUSULA]', '');
        doc.moveDown(0.5);
        doc.fontSize(11).font('Helvetica-Bold').text(texto, { align: 'left' });
        doc.moveDown(0.3);
        continue;
      }

      // Linha com negrito inline
      if (trimmed.includes('[NEGRITO]')) {
        doc.fontSize(10).font('Helvetica');
        const partes = trimmed.split(/(\[NEGRITO\].*?\[\/NEGRITO\])/g);
        let x = doc.x;
        let primeiraLinha = true;

        for (const parte of partes) {
          if (parte.startsWith('[NEGRITO]')) {
            const texto = parte.replace('[NEGRITO]', '').replace('[/NEGRITO]', '');
            if (primeiraLinha) {
              doc.font('Helvetica-Bold').text(texto, { continued: true });
              primeiraLinha = false;
            } else {
              doc.font('Helvetica-Bold').text(texto, { continued: true });
            }
          } else if (parte) {
            doc.font('Helvetica').text(parte, { continued: true });
          }
        }
        doc.text(''); // Finaliza a linha
        doc.moveDown(0.3);
        continue;
      }

      // Texto normal
      doc.fontSize(10).font('Helvetica').text(trimmed, {
        align: 'justify',
        lineGap: 3
      });
      doc.moveDown(0.3);
    }

    // Espaço para assinaturas
    doc.moveDown(2);
    doc.fontSize(10).font('Helvetica');
    doc.text('Local e Data: _________________________, _____ de _________________ de _______', { align: 'left' });
    doc.moveDown(2);

    // Linha assinatura parte 1
    doc.moveTo(60, doc.y).lineTo(270, doc.y).stroke();
    doc.text('Contratante', 60, doc.y + 5);
    doc.moveDown(2);

    // Linha assinatura parte 2
    doc.moveTo(60, doc.y).lineTo(270, doc.y).stroke();
    doc.text('Contratado', 60, doc.y + 5);
    doc.moveDown(2);

    // Testemunhas
    doc.fontSize(9).font('Helvetica-Bold').text('TESTEMUNHAS:', { align: 'left' });
    doc.moveDown(1);
    doc.moveTo(60, doc.y).lineTo(250, doc.y).stroke();
    doc.fontSize(9).font('Helvetica').text('Testemunha 1: _____________________ CPF: _____________', 60, doc.y + 5);
    doc.moveDown(1.5);
    doc.moveTo(60, doc.y).lineTo(250, doc.y).stroke();
    doc.fontSize(9).font('Helvetica').text('Testemunha 2: _____________________ CPF: _____________', 60, doc.y + 5);

    doc.end();
  });
}

async function enviarMensagem(phone, mensagem) {
  try {
    await fetch(process.env.EVOLUTION_URL + '/message/sendText/' + process.env.EVOLUTION_INSTANCE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': process.env.EVOLUTION_KEY },
      body: JSON.stringify({ number: phone, text: mensagem })
    });
  } catch (error) {
    console.error('Erro ao enviar mensagem:', error);
  }
}

async function enviarPDF(phone, pdfBuffer, nomeArquivo) {
  try {
    const base64 = pdfBuffer.toString('base64');
    await fetch(process.env.EVOLUTION_URL + '/message/sendMedia/' + process.env.EVOLUTION_INSTANCE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': process.env.EVOLUTION_KEY },
      body: JSON.stringify({
        number: phone,
        mediatype: 'document',
        mimetype: 'application/pdf',
        media: base64,
        fileName: nomeArquivo,
        caption: '📄 Seu contrato está pronto! Abra o PDF para visualizar.'
      })
    });
  } catch (error) {
    console.error('Erro ao enviar PDF:', error);
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

    if (usuario.etapa === 'coletando') {
      const { tipo, dados, perguntaAtual } = usuario.contrato;
      dados.push(msg);
      const proxima = perguntaAtual + 1;

      if (proxima < PERGUNTAS[tipo].length) {
        usuario.contrato.perguntaAtual = proxima;
        await enviarMensagem(phone, `*Pergunta ${proxima + 1} de ${PERGUNTAS[tipo].length}:*\n${PERGUNTAS[tipo][proxima]}`);
      } else {
        usuario.etapa = 'gerando';
        await enviarMensagem(phone, `Perfeito! Tenho todas as informações. ✅\n\nGerando seu contrato em PDF, aguarde um instante... ⏳`);

        const textoContrato = await gerarContrato(tipo, dados);
        usuario.contrato.texto = textoContrato;

        const pdfBuffer = await gerarPDF(textoContrato);
        const nomeArquivo = `Contrato_${tipo.replace(/ /g, '_')}.pdf`;

        await enviarPDF(phone, pdfBuffer, nomeArquivo);
        await enviarMensagem(phone, `✅ *Contrato gerado com sucesso!*\n\nDeseja alguma *alteração*? Me diga o que mudar que refaço na hora! 😊\n\nOu digite *NOVO* para gerar outro contrato.`);

        usuario.etapa = 'revisao';
      }
      return res.sendStatus(200);
    }

    if (usuario.etapa === 'revisao') {
      if (msg.toUpperCase() === 'NOVO') {
        usuario.etapa = 'menu';
        usuario.contrato = {};
        await enviarMensagem(phone, menuPrincipal());
        return res.sendStatus(200);
      }

      await enviarMensagem(phone, `Entendido! Aplicando as modificações e gerando novo PDF... ⏳`);

      const atualizado = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [
          { role: 'user', content: `Aqui está um contrato:\n\n${usuario.contrato.texto}` },
          { role: 'assistant', content: usuario.contrato.texto },
          { role: 'user', content: `Faça as seguintes modificações: ${msg}\n\nRetorne o contrato completo com as modificações, usando as mesmas marcações [TITULO], [CLAUSULA] e [NEGRITO].` }
        ]
      });

      usuario.contrato.texto = atualizado.content[0].text;
      const pdfBuffer = await gerarPDF(usuario.contrato.texto);
      const nomeArquivo = `Contrato_${usuario.contrato.tipo.replace(/ /g, '_')}_atualizado.pdf`;

      await enviarPDF(phone, pdfBuffer, nomeArquivo);
      await enviarMensagem(phone, `✅ *Contrato atualizado!*\n\nDeseja mais alguma *alteração*? Ou digite *NOVO* para gerar outro contrato.`);
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
