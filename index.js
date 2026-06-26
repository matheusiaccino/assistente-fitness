const express = require('express');
const app = express();
app.use(express.json());
const Anthropic = require('@anthropic-ai/sdk');
const PDFDocument = require('pdfkit');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const usuarios = {};
const ultimasMensagens = {};
const avaliacoes = [];

function getUsuario(phone) {
  if (!usuarios[phone]) {
    usuarios[phone] = { etapa: 'menu', plano: null, creditos: 0, contrato: {} };
  }
  return usuarios[phone];
}

function isDuplicata(phone, texto) {
  const agora = Date.now();
  const chave = phone + '|' + texto;
  if (ultimasMensagens[chave] && (agora - ultimasMensagens[chave]) < 10000) return true;
  ultimasMensagens[chave] = agora;
  return false;
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
    'Qual a data de término? (ou informe "indeterminado")',
    'O serviço será presencial ou remoto?',
    'Haverá multa por cancelamento? Se sim, qual o valor?'
  ],
  'Aluguel de Imóvel': [
    'Qual o nome completo e CPF do proprietário?',
    'Qual o nome completo e CPF do inquilino?',
    'Qual o endereço completo do imóvel?',
    'Qual o valor do aluguel mensal?',
    'Qual o dia de vencimento do aluguel?',
    'Qual a data de início do contrato? (ex: 01/07/2026)',
    'Qual a data de término do contrato? (ex: 30/06/2028)',
    'Haverá depósito caução? Se sim, qual o valor?',
    'Permite animais de estimação? Permite reformas?',
    'Haverá fiador? Se sim, qual o nome e CPF?',
    'Qual o método de reajuste?\n\n1️⃣ IGPM/FGV\n2️⃣ Salário Mínimo\n3️⃣ Outro (descreva)'
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
  const perguntasUsadas = PERGUNTAS[tipo];
  let instrucaoEspecial = '';
  if (tipo === 'Aluguel de Imóvel') {
    instrucaoEspecial = `
INSTRUÇÕES ESPECIAIS PARA ALUGUEL:
- O inquilino É RESPONSÁVEL por água, luz, condomínio e IPTU. Inclua isso nas cláusulas.
- As datas de início e término já foram fornecidas, NÃO deixe espaços em branco.
- Para o reajuste, use exatamente o método informado. Se for salário mínimo, calcule quantos salários mínimos equivale o aluguel (salário mínimo atual R$ 1.518,00) e redija a cláusula baseada nisso.`;
  }

  const prompt = `Você é um especialista em contratos jurídicos brasileiros.
Gere um contrato completo e profissional de ${tipo} com base nas seguintes informações:

${dados.map((d, i) => `${perguntasUsadas[i]}\nResposta: ${d}`).join('\n\n')}

${instrucaoEspecial}

IMPORTANTE - Formate usando estas marcações:
- Título principal: [TITULO]texto[/TITULO]
- Títulos de cláusulas: [CLAUSULA]texto[/CLAUSULA]
- Negrito importante: [NEGRITO]texto[/NEGRITO]
- Parágrafos normais: texto normal

O contrato deve:
- Estar em conformidade com a legislação brasileira vigente
- Ter linguagem formal e profissional
- Incluir todas as cláusulas necessárias
- NÃO deixar espaços em branco onde já temos informações
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
    const doc = new PDFDocument({ margin: 70, size: 'A4' });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    const larguraPagina = doc.page.width - 140;
    const linhas = textoContrato.split('\n');

    for (const linha of linhas) {
      const trimmed = linha.trim();
      if (!trimmed || trimmed === '---' || trimmed === '--') { doc.moveDown(0.4); continue; }

      if (trimmed.startsWith('[TITULO]')) {
        const texto = trimmed.replace(/\[TITULO\]/g, '').replace(/\[\/TITULO\]/g, '').trim();
        doc.moveDown(0.5);
        doc.fontSize(13).font('Helvetica-Bold').text(texto, 70, doc.y, { align: 'center', width: larguraPagina });
        doc.moveDown(0.8);
        continue;
      }

      if (trimmed.startsWith('[CLAUSULA]')) {
        const texto = trimmed.replace(/\[CLAUSULA\]/g, '').replace(/\[\/CLAUSULA\]/g, '').trim();
        doc.moveDown(0.6);
        doc.fontSize(10).font('Helvetica-Bold').text(texto, 70, doc.y, { align: 'left', width: larguraPagina });
        doc.moveDown(0.4);
        continue;
      }

      if (trimmed.includes('[NEGRITO]')) {
        const partes = trimmed.split(/(\[NEGRITO\].*?\[\/NEGRITO\])/g);
        doc.fontSize(10);
        for (let i = 0; i < partes.length; i++) {
          const parte = partes[i];
          const isUltima = i === partes.length - 1;
          if (parte.startsWith('[NEGRITO]')) {
            const texto = parte.replace(/\[NEGRITO\]/g, '').replace(/\[\/NEGRITO\]/g, '');
            doc.font('Helvetica-Bold').text(texto, { continued: !isUltima, lineGap: 2 });
          } else if (parte) {
            doc.font('Helvetica').text(parte, { continued: !isUltima, lineGap: 2 });
          }
        }
        if (doc._continued) doc.text('');
        doc.moveDown(0.3);
        continue;
      }

      doc.fontSize(10).font('Helvetica').text(trimmed, 70, doc.y, { align: 'justify', width: larguraPagina, lineGap: 2 });
      doc.moveDown(0.3);
    }

    doc.moveDown(2);
    doc.fontSize(10).font('Helvetica').text('Local e Data: _________________________, _____ de _________________ de _______', 70, doc.y, { width: larguraPagina });
    doc.moveDown(2.5);

    const yA1 = doc.y;
    doc.moveTo(70, yA1).lineTo(280, yA1).stroke();
    doc.moveDown(0.3);
    doc.fontSize(9).font('Helvetica').text('Contratante / Locador / Vendedor', 70, doc.y, { width: 210 });
    doc.moveDown(2.5);

    const yA2 = doc.y;
    doc.moveTo(70, yA2).lineTo(280, yA2).stroke();
    doc.moveDown(0.3);
    doc.fontSize(9).font('Helvetica').text('Contratado / Locatário / Comprador', 70, doc.y, { width: 210 });
    doc.moveDown(2.5);

    doc.fontSize(9).font('Helvetica-Bold').text('Testemunhas:', 70, doc.y);
    doc.moveDown(1.5);

    const yT1 = doc.y;
    doc.moveTo(70, yT1).lineTo(280, yT1).stroke();
    doc.moveDown(0.3);
    doc.fontSize(9).font('Helvetica').text('Testemunha 1: _________________________  CPF: __________________', 70, doc.y);
    doc.moveDown(2);

    const yT2 = doc.y;
    doc.moveTo(70, yT2).lineTo(280, yT2).stroke();
    doc.moveDown(0.3);
    doc.fontSize(9).font('Helvetica').text('Testemunha 2: _________________________  CPF: __________________', 70, doc.y);

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

function menuPrincipal(temAcesso) {
  if (temAcesso) {
    return `Qual tipo de contrato você precisa? ⚖️

1️⃣ Prestação de Serviços
2️⃣ Aluguel de Imóvel
3️⃣ Compra e Venda
4️⃣ Contrato de Trabalho
5️⃣ Parceria / Sociedade
6️⃣ Outro

Responda com o número da opção desejada.`;
  }

  return `Olá! 👋 Sou o *ContratoBot*, seu assistente de contratos profissionais! ⚖️

Gero contratos completos e personalizados em minutos!

⚠️ *Aviso importante:* Nossos contratos são gerados com base nas informações fornecidas e não substituem a assessoria de um advogado.

📋 *Escolha seu plano:*

*1️⃣ Contrato Avulso — R$ 14,99*
Um contrato completo com direito a modificações

*2️⃣ Plano Ilimitado — R$ 49,99/mês*
Contratos ilimitados durante 30 dias ♾️

Responda *1* ou *2* para continuar.`;
}

function pedirAvaliacao() {
  return `Obrigado por usar o *ContratoBot*! 🙏

Antes de ir, que tal avaliar nosso serviço?

⭐ 1 - Péssimo
⭐⭐ 2 - Ruim
⭐⭐⭐ 3 - Regular
⭐⭐⭐⭐ 4 - Bom
⭐⭐⭐⭐⭐ 5 - Excelente

Responda com o número de 1 a 5.`;
}

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    if (body.event !== 'messages.upsert') return res.sendStatus(200);
    const data = body.data;
    if (!data) return res.sendStatus(200);
    if (data.key && data.key.fromMe === true) return res.sendStatus(200);
    if (data.message?.protocolMessage) return res.sendStatus(200);
    if (data.message?.documentMessage) return res.sendStatus(200);
    if (data.message?.documentWithCaptionMessage) return res.sendStatus(200);
    if (data.message?.reactionMessage) return res.sendStatus(200);
    if (data.message?.stickerMessage) return res.sendStatus(200);
    if (data.messageType === 'protocolMessage') return res.sendStatus(200);
    if (data.messageType === 'senderKeyDistributionMessage') return res.sendStatus(200);

    const texto = (data.message && (data.message.conversation || (data.message.extendedTextMessage && data.message.extendedTextMessage.text))) || '';
    if (!texto.trim()) return res.sendStatus(200);

    const phone = data.key && data.key.remoteJid && data.key.remoteJid.replace('@s.whatsapp.net', '');
    if (!phone) return res.sendStatus(200);

    if (isDuplicata(phone, texto)) return res.sendStatus(200);

    const usuario = getUsuario(phone);
    const msg = texto.trim();
    console.log('Mensagem de', phone, ':', msg, '| Etapa:', usuario.etapa);

    if (usuario.etapa === 'gerando') return res.sendStatus(200);

    // Sem acesso — mostrar planos
    if (!usuario.plano && usuario.creditos === 0 && usuario.etapa !== 'avaliacao') {
      if (msg === '1') {
        await enviarMensagem(phone, `Ótimo! Acesse o link abaixo para realizar o pagamento de *R$ 14,99*:\n\n🔗 ${process.env.LINK_AVULSO}\n\nApós o pagamento seu acesso será liberado automaticamente aqui no WhatsApp! ✅`);
      } else if (msg === '2') {
        await enviarMensagem(phone, `Ótimo! Acesse o link abaixo para assinar o Plano Ilimitado por *R$ 49,99/mês*:\n\n🔗 ${process.env.LINK_ILIMITADO}\n\nApós o pagamento seu acesso será liberado automaticamente! ✅`);
      } else {
        await enviarMensagem(phone, menuPrincipal(false));
      }
      return res.sendStatus(200);
    }

    // Avaliação
    if (usuario.etapa === 'avaliacao') {
      const nota = parseInt(msg);
      if (nota >= 1 && nota <= 5) {
        usuario.etapa = 'comentario';
        const estrelas = '⭐'.repeat(nota);
        await enviarMensagem(phone, `${estrelas} Obrigado pela avaliação!\n\nTem algum elogio, crítica ou sugestão? (opcional)\n\nOu digite *PULAR* para encerrar.`);
      } else {
        await enviarMensagem(phone, pedirAvaliacao());
      }
      return res.sendStatus(200);
    }

    if (usuario.etapa === 'comentario') {
      const comentario = msg.toUpperCase() === 'PULAR' ? '' : msg;
      avaliacoes.push({ phone, nota: usuario.ultimaNota, comentario, data: new Date().toISOString() });
      console.log('Avaliação recebida:', { phone, comentario });
      usuario.etapa = 'menu';
      await enviarMensagem(phone, `Muito obrigado pelo feedback! 😊\n\nVolte sempre que precisar de um contrato. Até logo! 👋`);
      return res.sendStatus(200);
    }

    // Menu principal
    if (usuario.etapa === 'menu') {
      if (TIPOS_CONTRATO[msg]) {
        const tipo = TIPOS_CONTRATO[msg];
        usuario.contrato = { tipo, dados: [], perguntaAtual: 0 };
        usuario.etapa = 'coletando';
        await enviarMensagem(phone, `Ótimo! Vou gerar seu contrato de *${tipo}*. 📋\n\nPreciso de algumas informações rápidas!\n\n*Pergunta 1 de ${PERGUNTAS[tipo].length}:*\n${PERGUNTAS[tipo][0]}`);
      } else {
        await enviarMensagem(phone, menuPrincipal(true));
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
        await enviarMensagem(phone, `Perfeito! Tenho todas as informações. ✅\n\nGerando seu contrato em PDF, aguarde um instante... ⏳`);
        const textoContrato = await gerarContrato(tipo, dados);
        usuario.contrato.texto = textoContrato;
        const pdfBuffer = await gerarPDF(textoContrato);
        const nomeArquivo = `Contrato_${tipo.replace(/ /g, '_')}.pdf`;
        await enviarPDF(phone, pdfBuffer, nomeArquivo);
        await enviarMensagem(phone, `✅ *Contrato gerado com sucesso!*\n\nDeseja alguma *alteração*? Me diga o que mudar que refaço na hora! 😊\n\nOu digite *NOVO* para gerar outro contrato.`);
        usuario.etapa = 'revisao';

        // Desconta crédito se for avulso
        if (usuario.plano === 'avulso') {
          usuario.creditos = 0;
          usuario.plano = null;
        }
      }
      return res.sendStatus(200);
    }

    // Revisão
    if (usuario.etapa === 'revisao') {
      if (msg.toUpperCase() === 'NOVO') {
        usuario.etapa = 'avaliacao';
        await enviarMensagem(phone, pedirAvaliacao());
        return res.sendStatus(200);
      }

      if (msg.length < 5) return res.sendStatus(200);

      usuario.etapa = 'gerando';
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
      usuario.etapa = 'revisao';
      return res.sendStatus(200);
    }

  } catch (error) {
    console.error('Erro:', error);
    res.sendStatus(500);
  }
});

// Webhook do Kiwify
app.post('/kiwify', (req, res) => {
  try {
    console.log('Kiwify webhook:', JSON.stringify(req.body).substring(0, 500));
    const body = req.body;

    if (body.order_status !== 'paid') return res.sendStatus(200);

    const token = req.query.token || body.token;
    if (token !== process.env.KIWIFY_TOKEN) {
      console.log('Token inválido:', token);
      return res.status(401).json({ error: 'Token inválido' });
    }

    const phone = body.Customer?.mobile?.replace(/\D/g, '');
    if (!phone) {
      console.log('Telefone não encontrado no webhook');
      return res.sendStatus(200);
    }

    const usuario = getUsuario(phone);
    const preco = body.Product?.price || 0;

    if (preco <= 1999) {
      usuario.plano = 'avulso';
      usuario.creditos = 1;
    } else {
      usuario.plano = 'ilimitado';
      usuario.creditos = 999;
    }

    usuario.etapa = 'menu';
    console.log('Acesso liberado:', phone, '| Plano:', usuario.plano);

    enviarMensagem(phone, `🎉 *Pagamento confirmado!* Seu acesso foi liberado!\n\n${menuPrincipal(true)}`);
    res.sendStatus(200);
  } catch (error) {
    console.error('Erro kiwify:', error);
    res.sendStatus(500);
  }
});

// Ver avaliações
app.get('/avaliacoes', (req, res) => {
  const media = avaliacoes.length > 0
    ? (avaliacoes.reduce((a, b) => a + b.nota, 0) / avaliacoes.length).toFixed(1)
    : 0;
  res.json({ total: avaliacoes.length, media, avaliacoes });
});

app.get('/', (req, res) => { res.json({ status: 'ContratoBot rodando!' }); });
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log('ContratoBot rodando na porta ' + PORT); });
