const express = require('express');
const app = express();
app.use(express.json());
const Anthropic = require('@anthropic-ai/sdk');
const PDFDocument = require('pdfkit');
const { Document, Packer, Paragraph, TextRun, AlignmentType } = require('docx');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const usuarios = {};
const ultimasMensagens = {};
const avaliacoes = [];

function getUsuario(phone) {
  if (!usuarios[phone]) {
    usuarios[phone] = { etapa: 'menu', plano: null, creditos: 0, contrato: {}, dataExpiracao: null };
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

function planoExpirado(usuario) {
  if (usuario.plano === 'ilimitado' && usuario.dataExpiracao) {
    return Date.now() > usuario.dataExpiracao;
  }
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
    'Qual a carga horária semanal?',
    'Qual o salário combinado?',
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

async function gerarWord(textoContrato) {
  const linhas = textoContrato.split('\n');
  const paragrafos = [];

  for (const linha of linhas) {
    const trimmed = linha.trim();
    if (!trimmed || trimmed === '---' || trimmed === '--') {
      paragrafos.push(new Paragraph({ text: '' }));
      continue;
    }

    if (trimmed.startsWith('[TITULO]')) {
      const texto = trimmed.replace(/\[TITULO\]/g, '').replace(/\[\/TITULO\]/g, '').trim();
      paragrafos.push(new Paragraph({
        children: [new TextRun({ text: texto, bold: true, size: 28 })],
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 }
      }));
      continue;
    }

    if (trimmed.startsWith('[CLAUSULA]')) {
      const texto = trimmed.replace(/\[CLAUSULA\]/g, '').replace(/\[\/CLAUSULA\]/g, '').trim();
      paragrafos.push(new Paragraph({
        children: [new TextRun({ text: texto, bold: true, size: 22 })],
        spacing: { before: 200, after: 100 }
      }));
      continue;
    }

    if (trimmed.includes('[NEGRITO]')) {
      const partes = trimmed.split(/(\[NEGRITO\].*?\[\/NEGRITO\])/g);
      const runs = partes.map(parte => {
        if (parte.startsWith('[NEGRITO]')) {
          const texto = parte.replace(/\[NEGRITO\]/g, '').replace(/\[\/NEGRITO\]/g, '');
          return new TextRun({ text: texto, bold: true, size: 20 });
        }
        return new TextRun({ text: parte, size: 20 });
      });
      paragrafos.push(new Paragraph({ children: runs, alignment: AlignmentType.JUSTIFIED, spacing: { after: 80 } }));
      continue;
    }

    paragrafos.push(new Paragraph({
      children: [new TextRun({ text: trimmed, size: 20 })],
      alignment: AlignmentType.JUSTIFIED,
      spacing: { after: 80 }
    }));
  }

  paragrafos.push(new Paragraph({ text: '', spacing: { before: 400 } }));
  paragrafos.push(new Paragraph({ children: [new TextRun({ text: 'Local e Data: _________________________, _____ de _________________ de _______', size: 20 })] }));
  paragrafos.push(new Paragraph({ text: '', spacing: { before: 400 } }));
  paragrafos.push(new Paragraph({ children: [new TextRun({ text: '________________________________________', size: 20 })] }));
  paragrafos.push(new Paragraph({ children: [new TextRun({ text: 'Contratante / Locador / Vendedor', size: 20 })] }));
  paragrafos.push(new Paragraph({ text: '', spacing: { before: 400 } }));
  paragrafos.push(new Paragraph({ children: [new TextRun({ text: '________________________________________', size: 20 })] }));
  paragrafos.push(new Paragraph({ children: [new TextRun({ text: 'Contratado / Locatário / Comprador', size: 20 })] }));
  paragrafos.push(new Paragraph({ text: '', spacing: { before: 400 } }));
  paragrafos.push(new Paragraph({ children: [new TextRun({ text: 'Testemunhas:', bold: true, size: 20 })] }));
  paragrafos.push(new Paragraph({ text: '', spacing: { before: 200 } }));
  paragrafos.push(new Paragraph({ children: [new TextRun({ text: 'Testemunha 1: _________________________  CPF: __________________', size: 20 })] }));
  paragrafos.push(new Paragraph({ text: '', spacing: { before: 200 } }));
  paragrafos.push(new Paragraph({ children: [new TextRun({ text: 'Testemunha 2: _________________________  CPF: __________________', size: 20 })] }));

  const doc = new Document({ sections: [{ properties: {}, children: paragrafos }] });
  return await Packer.toBuffer(doc);
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

async function enviarArquivo(phone, buffer, nomeArquivo, mimetype, caption) {
  try {
    const base64 = buffer.toString('base64');
    await fetch(process.env.EVOLUTION_URL + '/message/sendMedia/' + process.env.EVOLUTION_INSTANCE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': process.env.EVOLUTION_KEY },
      body: JSON.stringify({ number: phone, mediatype: 'document', mimetype, media: base64, fileName: nomeArquivo, caption })
    });
  } catch (error) {
    console.error('Erro ao enviar arquivo:', error);
  }
}

function menuPrincipal(temAcesso) {
  const dicas = `\n\n💡 *Comandos disponíveis a qualquer momento:*\n• Digite *SUPORTE* — para falar com nossa equipe\n• Digite *CANCELAR PLANO* — para cancelar sua assinatura\n• Digite *MENU* — para voltar ao menu principal`;

  if (temAcesso) {
    return `Qual tipo de contrato você precisa? ⚖️

1️⃣ Prestação de Serviços
2️⃣ Aluguel de Imóvel
3️⃣ Compra e Venda
4️⃣ Contrato de Trabalho
5️⃣ Parceria / Sociedade
6️⃣ Outro

Responda com o número da opção desejada.${dicas}`;
  }

  return `Olá! 👋 Sou o *ContratoBot*, seu assistente de contratos profissionais! ⚖️

Gero contratos completos e personalizados em minutos, por uma fração do custo de um advogado!

⚠️ *Aviso importante:* Nossos contratos são gerados com base nas informações fornecidas e não substituem a assessoria de um advogado.

📋 *Escolha seu plano:*

*1️⃣ Contrato Avulso — R$ 14,99*
Um contrato completo com direito a modificações

*2️⃣ Plano Ilimitado — R$ 49,99/mês*
Contratos ilimitados com renovação automática ♾️
Cancele quando quiser digitando *CANCELAR PLANO*${dicas}

Responda *1* ou *2* para continuar.`;
}

function pedirFormato() {
  return `Em qual formato você prefere receber o contrato?

1️⃣ PDF (recomendado para assinar)
2️⃣ Word (.docx) (para editar antes de assinar)`;
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
    const msgUpper = msg.toUpperCase();
    console.log('Mensagem de', phone, ':', msg, '| Etapa:', usuario.etapa);

    if (usuario.etapa === 'gerando') return res.sendStatus(200);

    // Verifica expiração
    if (planoExpirado(usuario)) {
      usuario.plano = null;
      usuario.creditos = 0;
      usuario.dataExpiracao = null;
      await enviarMensagem(phone, `⚠️ Seu *Plano Ilimitado* expirou!\n\nPara continuar gerando contratos escolha um novo plano:\n\n${menuPrincipal(false)}`);
      return res.sendStatus(200);
    }

    // MENU — volta ao menu em qualquer etapa
    if (msgUpper === 'MENU') {
      usuario.etapa = 'menu';
      usuario.contrato = {};
      const temAcesso = usuario.plano || usuario.creditos > 0;
      await enviarMensagem(phone, menuPrincipal(!!temAcesso));
      return res.sendStatus(200);
    }

    // SUPORTE — funciona em qualquer etapa
    if (msgUpper === 'SUPORTE') {
      await enviarMensagem(phone, `🆘 *Suporte ContratoBot*\n\nOlá! Para falar com nossa equipe de suporte:\n\n📧 E-mail: contratobotsuporte@gmail.com\n\nDescreva seu problema detalhadamente e responderemos em até 24h úteis! 😊\n\nHorário de atendimento: Segunda a Sexta, das 8h às 18h.`);
      return res.sendStatus(200);
    }

    // CANCELAR PLANO — funciona em qualquer etapa
    if (msgUpper === 'CANCELAR PLANO') {
      if (usuario.plano === 'ilimitado') {
        await enviarMensagem(phone, `😢 Que pena que deseja cancelar seu plano!\n\nSua assinatura possui *renovação automática mensal*. Para cancelar e não ser cobrado no próximo mês, acesse o link abaixo:\n\n🔗 ${process.env.LINK_ILIMITADO}\n\nVocê continuará tendo acesso até o final do período já pago.\n\nSe tiver algum problema, entre em contato com nosso suporte:\n📧 contratobotsuporte@gmail.com`);
      } else {
        await enviarMensagem(phone, `Você não possui uma assinatura ativa no momento. 😊\n\nSe precisar de ajuda digite *SUPORTE*.`);
      }
      return res.sendStatus(200);
    }

    // Sem acesso
    if (!usuario.plano && usuario.creditos === 0 && !['avaliacao', 'comentario'].includes(usuario.etapa)) {
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
        usuario.ultimaNota = nota;
        usuario.etapa = 'comentario';
        const estrelas = '⭐'.repeat(nota);
        await enviarMensagem(phone, `${estrelas} Obrigado pela avaliação!\n\nTem algum elogio, crítica ou sugestão? (opcional)\n\nOu digite *PULAR* para encerrar.`);
      } else {
        await enviarMensagem(phone, pedirAvaliacao());
      }
      return res.sendStatus(200);
    }

    if (usuario.etapa === 'comentario') {
      const comentario = msgUpper === 'PULAR' ? '' : msg;
      avaliacoes.push({ phone, nota: usuario.ultimaNota, comentario, data: new Date().toISOString() });
      usuario.etapa = 'menu';
      await enviarMensagem(phone, `Muito obrigado pelo feedback! 😊\n\nVolte sempre que precisar de um contrato. Até logo! 👋`);
      return res.sendStatus(200);
    }

    // Escolha de formato
    if (usuario.etapa === 'formato') {
      if (msg === '1' || msg === '2') {
        const formato = msg === '1' ? 'pdf' : 'word';
        usuario.etapa = 'gerando';
        await enviarMensagem(phone, `Gerando seu contrato em ${formato === 'pdf' ? 'PDF' : 'Word'}... ⏳`);

        const tipo = usuario.contrato.tipo;
        if (formato === 'pdf') {
          const pdfBuffer = await gerarPDF(usuario.contrato.texto);
          await enviarArquivo(phone, pdfBuffer, `Contrato_${tipo.replace(/ /g, '_')}.pdf`, 'application/pdf', '📄 Seu contrato em PDF está pronto!');
        } else {
          const wordBuffer = await gerarWord(usuario.contrato.texto);
          await enviarArquivo(phone, wordBuffer, `Contrato_${tipo.replace(/ /g, '_')}.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '📝 Seu contrato em Word está pronto!');
        }

        await enviarMensagem(phone, `✅ *Contrato enviado!*\n\nDeseja alguma *alteração*? Me diga o que mudar que refaço na hora! 😊\n\nOu digite *NOVO* para gerar outro contrato.`);
        usuario.etapa = 'revisao';

        if (usuario.plano === 'avulso') {
          usuario.creditos = 0;
          usuario.plano = null;
        }
      } else {
        await enviarMensagem(phone, pedirFormato());
      }
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
        await enviarMensagem(phone, `Perfeito! Tenho todas as informações. ✅\n\nGerando seu contrato, aguarde um instante... ⏳`);
        const textoContrato = await gerarContrato(tipo, dados);
        usuario.contrato.texto = textoContrato;
        usuario.etapa = 'formato';
        await enviarMensagem(phone, pedirFormato());
      }
      return res.sendStatus(200);
    }

    // Revisão
    if (usuario.etapa === 'revisao') {
      if (msgUpper === 'NOVO') {
        usuario.etapa = 'avaliacao';
        usuario.contrato = {};
        await enviarMensagem(phone, pedirAvaliacao());
        return res.sendStatus(200);
      }

      if (msg.length < 5) return res.sendStatus(200);

      // Proteção contra uso indevido
      const palavrasNovoContrato = ['quero um contrato', 'novo contrato', 'fazer contrato', 'preciso de um contrato', 'gerar contrato'];
      const parecePedidoNovo = palavrasNovoContrato.some(p => msg.toLowerCase().includes(p));

      if (parecePedidoNovo) {
        await enviarMensagem(phone, `Para gerar um *novo contrato* diferente deste, digite *NOVO*.\n\nSe quiser fazer uma alteração no contrato atual, me diga exatamente o que mudar! 😊`);
        return res.sendStatus(200);
      }

      usuario.etapa = 'gerando';
      await enviarMensagem(phone, `Entendido! Aplicando as modificações... ⏳`);
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
      usuario.etapa = 'formato';
      await enviarMensagem(phone, `✅ Modificações aplicadas!\n\n${pedirFormato()}`);
      return res.sendStatus(200);
    }

  } catch (error) {
    console.error('Erro:', error);
    res.sendStatus(500);
  }
});

// Webhook Kiwify
app.post('/kiwify', (req, res) => {
  try {
    const body = req.body;
    console.log('Kiwify webhook:', JSON.stringify(body).substring(0, 500));

   const token = req.query.token || body.token || req.headers['x-kiwify-token'] || '';
console.log('Token recebido:', token);
console.log('Headers:', JSON.stringify(req.headers));
const tokensValidos = (process.env.KIWIFY_TOKEN || '').split(',');
if (token && !tokensValidos.includes(token)) {
  console.log('Token inválido:', token);
  return res.status(401).json({ error: 'Token inválido' });
}

    const phone = body.Customer?.mobile?.replace(/\D/g, '');
    if (!phone) return res.sendStatus(200);

    const usuario = getUsuario(phone);
    const status = body.order_status || body.subscription_status;

    // Cancelamento
    if (status === 'canceled' || status === 'cancelled') {
      usuario.plano = null;
      usuario.creditos = 0;
      usuario.dataExpiracao = null;
      enviarMensagem(phone, `😢 Sua assinatura foi cancelada com sucesso.\n\nSeu acesso permanece ativo até o final do período pago.\n\nSe quiser voltar, é só escolher um novo plano:\n\n${menuPrincipal(false)}`);
      return res.sendStatus(200);
    }

    if (status !== 'paid') return res.sendStatus(200);

    const preco = body.Product?.price || 0;

    if (preco <= 1999) {
      usuario.plano = 'avulso';
      usuario.creditos = 1;
      usuario.dataExpiracao = null;
    } else {
      // Renova os 30 dias a cada pagamento
      usuario.plano = 'ilimitado';
      usuario.creditos = 999;
      usuario.dataExpiracao = Date.now() + (30 * 24 * 60 * 60 * 1000);
    }

    usuario.etapa = 'menu';
    console.log('Acesso liberado/renovado:', phone, '| Plano:', usuario.plano);
    enviarMensagem(phone, `🎉 *Pagamento confirmado!* Seu acesso foi liberado!\n\n${menuPrincipal(true)}`);
    res.sendStatus(200);
  } catch (error) {
    console.error('Erro kiwify:', error);
    res.sendStatus(500);
  }
});

app.get('/avaliacoes', (req, res) => {
  const media = avaliacoes.length > 0
    ? (avaliacoes.reduce((a, b) => a + b.nota, 0) / avaliacoes.length).toFixed(1)
    : 0;
  res.json({ total: avaliacoes.length, media, avaliacoes });
});

app.get('/', (req, res) => { res.json({ status: 'ContratoBot rodando!' }); });
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log('ContratoBot rodando na porta ' + PORT); });
