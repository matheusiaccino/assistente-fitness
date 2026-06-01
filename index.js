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
    'Qual É O Seu Nome Completo E CPF Ou CNPJ?',
    'Qual É O Nome Completo E CPF Ou CNPJ Do Cliente?',
    'Qual Serviço Será Prestado? Descreva Com Detalhes.',
    'Qual O Valor Combinado Pelo Serviço?',
    'Como Será O Pagamento? (À Vista, Parcelado Ou Mensal)',
    'Qual A Data De Início Do Serviço?',
    'Tem Prazo De Término Ou É Indeterminado?',
    'O Serviço Será Presencial Ou Remoto?',
    'Haverá Multa Por Cancelamento? Se Sim, Qual O Valor?'
  ],
  'Aluguel de Imóvel': [
    'Qual O Nome Completo E CPF Do Proprietário?',
    'Qual O Nome Completo E CPF Do Inquilino?',
    'Qual O Endereço Completo Do Imóvel?',
    'Qual O Valor Do Aluguel Mensal?',
    'Qual O Dia De Vencimento Do Aluguel?',
    'Qual A Data De Início Do Contrato? (ex: 01/07/2026)',
    'Qual A Data De Término Do Contrato? (ex: 30/06/2028)',
    'Haverá Depósito Caução? Se Sim, Qual O Valor?',
    'Permite Animais De Estimação? Permite Reformas?',
    'Haverá Fiador? Se Sim, Qual O Nome E CPF?',
    'Qual O Método De Reajuste Do Aluguel?\n\n1️⃣ IGPM/FGV (índice de mercado)\n2️⃣ Salário Mínimo (o aluguel equivale a X salários mínimos e reajusta conforme o salário mínimo aumenta)\n3️⃣ Outro método (descreva)'
  ],
  'Compra e Venda': [
    'Qual O Nome Completo E CPF Do Vendedor?',
    'Qual O Nome Completo E CPF Do Comprador?',
    'O Que Está Sendo Vendido? (Imóvel, Veículo, Outro)',
    'Descreva Detalhadamente O Bem Sendo Vendido.',
    'Qual O Valor Total Da Venda?',
    'Como Será O Pagamento? (À Vista, Parcelado, Financiado)',
    'Qual A Data De Entrega Ou Transferência Do Bem?',
    'O Bem Possui Algum Defeito Conhecido?',
    'Haverá Multa Em Caso De Desistência?'
  ],
  'Contrato de Trabalho': [
    'Qual O Nome E CNPJ Da Empresa Contratante?',
    'Qual O Nome Completo E CPF Do Funcionário?',
    'Qual A Função Ou Cargo?',
    'Qual O Salário Combinado?',
    'Qual A Carga Horária Semanal?',
    'Qual A Data De Início?',
    'É CLT, PJ Ou Contrato De Experiência?',
    'Quais Benefícios? (VT, VR, Plano De Saúde, Etc)',
    'Haverá Período De Experiência? Qual A Duração?'
  ],
  'Parceria / Sociedade': [
    'Quais Os Nomes E CPF Ou CNPJ De Todos Os Sócios?',
    'Qual O Objetivo Do Negócio Ou Parceria?',
    'Qual A Porcentagem De Participação De Cada Sócio?',
    'Quanto Cada Sócio Irá Investir Inicialmente?',
    'Como Será Feita A Divisão De Lucros?',
    'Quem Ficará Responsável Pelas Decisões Do Dia A Dia?',
    'O Que Acontece Se Um Sócio Quiser Sair?',
    'O Contrato Tem Prazo Definido Ou É Indeterminado?'
  ],
  'Outro': [
    'Descreva Com Detalhes O Que Você Precisa No Contrato.',
    'Quais São As Partes Envolvidas? (Nomes E CPFs)',
    'Quais São As Obrigações De Cada Parte?',
    'Qual O Valor Envolvido, Se Houver?',
    'Qual O Prazo Do Contrato?',
    'Há Alguma Cláusula Específica Que Deseja Incluir?'
  ]
};

async function gerarContrato(tipo, dados) {
  const perguntasUsadas = PERGUNTAS[tipo];
  
  let instrucaoEspecial = '';
  if (tipo === 'Aluguel de Imóvel') {
    instrucaoEspecial = `
INSTRUÇÕES ESPECIAIS PARA ALUGUEL:
- O inquilino É RESPONSÁVEL por água, luz, condomínio e IPTU. Inclua isso nas cláusulas sem perguntar.
- As datas de início e término já foram fornecidas, NÃO deixe espaços em branco para datas do contrato.
- Para o reajuste, use exatamente o método informado pelo cliente. Se for salário mínimo, calcule quantos salários mínimos equivale o aluguel (salário mínimo atual R$ 1.518,00) e redija a cláusula de reajuste baseada nisso.`;
  }

  const prompt = `Você É Um Especialista Em Contratos Jurídicos Brasileiros.
Gere Um Contrato Completo E Profissional De ${tipo} Com Base Nas Seguintes Informações:

${dados.map((d, i) => `${perguntasUsadas[i]}\nResposta: ${d}`).join('\n\n')}

${instrucaoEspecial}

REGRA OBRIGATÓRIA DE FORMATAÇÃO DO TEXTO:
- TODAS as palavras do contrato devem ter a Primeira Letra Em Maiúsculo (Title Case)
- Isso inclui parágrafos, cláusulas, nomes, endereços, tudo
- Exceções apenas para artigos e preposições no meio da frase (de, da, do, em, e, ou, a, o)

IMPORTANTE - Formate usando estas marcações:
- Título principal: [TITULO]texto[/TITULO]
- Títulos de cláusulas: [CLAUSULA]texto[/CLAUSULA]
- Negrito importante: [NEGRITO]texto[/NEGRITO]
- Parágrafos normais: texto normal

O Contrato Deve:
- Estar Em Conformidade Com A Legislação Brasileira Vigente
- Ter Linguagem Formal E Profissional
- Incluir Todas As Cláusulas Necessárias
- NÃO deixar espaços em branco onde já temos as informações
- Incluir Espaço Para Assinaturas Das Partes E Duas Testemunhas

Gere O Contrato Completo Agora.`;

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
      if (!trimmed) { doc.moveDown(0.4); continue; }

      // Pula marcações soltas
      if (trimmed === '---' || trimmed === '--') { doc.moveDown(0.3); continue; }

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

      doc.fontSize(10).font('Helvetica').text(trimmed, 70, doc.y, {
        align: 'justify',
        width: larguraPagina,
        lineGap: 2
      });
      doc.moveDown(0.3);
    }

    // Assinaturas
    doc.moveDown(2);
    doc.fontSize(10).font('Helvetica').text(
      'Local E Data: _________________________, _____ De _________________ De _______',
      70, doc.y, { width: larguraPagina }
    );
    doc.moveDown(2.5);

    const yAssinatura = doc.y;
    doc.moveTo(70, yAssinatura).lineTo(280, yAssinatura).stroke();
    doc.fontSize(9).font('Helvetica').text('Contratante / Locador / Vendedor', 70, yAssinatura + 5, { width: 210 });
    doc.moveDown(2.5);

    const yAssinatura2 = doc.y;
    doc.moveTo(70, yAssinatura2).lineTo(280, yAssinatura2).stroke();
    doc.fontSize(9).font('Helvetica').text('Contratado / Locatário / Comprador', 70, yAssinatura2 + 5, { width: 210 });
    doc.moveDown(2.5);

    doc.fontSize(9).font('Helvetica-Bold').text('Testemunhas:', 70, doc.y);
    doc.moveDown(1.5);

    const yT1 = doc.y;
    doc.moveTo(70, yT1).lineTo(280, yT1).stroke();
    doc.fontSize(9).font('Helvetica').text('Testemunha 1: _________________________  CPF: __________________', 70, yT1 + 5);
    doc.moveDown(2);

    const yT2 = doc.y;
    doc.moveTo(70, yT2).lineTo(280, yT2).stroke();
    doc.fontSize(9).font('Helvetica').text('Testemunha 2: _________________________  CPF: __________________', 70, yT2 + 5);

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
        caption: '📄 Seu Contrato Está Pronto! Abra O PDF Para Visualizar.'
      })
    });
  } catch (error) {
    console.error('Erro ao enviar PDF:', error);
  }
}

function menuPrincipal() {
  return `Olá! 👋 Sou O *ContratoBot*, Seu Assistente De Contratos Profissionais! ⚖️

Gero Contratos Completos E Personalizados Em Minutos!

⚠️ *Aviso Importante:* Nossos Contratos São Gerados Com Base Nas Informações Fornecidas E Não Substituem A Assessoria De Um Advogado. Para Situações Complexas, Recomendamos Consultar Um Profissional Jurídico.

Qual Tipo De Contrato Você Precisa?

1️⃣ Prestação De Serviços
2️⃣ Aluguel De Imóvel
3️⃣ Compra E Venda
4️⃣ Contrato De Trabalho
5️⃣ Parceria / Sociedade
6️⃣ Outro

Responda Com O Número Da Opção Desejada.`;
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
    if (data.messageType === 'protocolMessage') return res.sendStatus(200);
    if (data.messageType === 'senderKeyDistributionMessage') return res.sendStatus(200);

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
        await enviarMensagem(phone, `Ótimo! Vou Gerar Seu Contrato De *${tipo}*. 📋\n\nPreciso De Algumas Informações Rápidas!\n\n*Pergunta 1 De ${PERGUNTAS[tipo].length}:*\n${PERGUNTAS[tipo][0]}`);
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
        await enviarMensagem(phone, `*Pergunta ${proxima + 1} De ${PERGUNTAS[tipo].length}:*\n${PERGUNTAS[tipo][proxima]}`);
      } else {
        usuario.etapa = 'gerando';
        await enviarMensagem(phone, `Perfeito! Tenho Todas As Informações. ✅\n\nGerando Seu Contrato Em PDF, Aguarde Um Instante... ⏳`);
        const textoContrato = await gerarContrato(tipo, dados);
        usuario.contrato.texto = textoContrato;
        const pdfBuffer = await gerarPDF(textoContrato);
        const nomeArquivo = `Contrato_${tipo.replace(/ /g, '_')}.pdf`;
        await enviarPDF(phone, pdfBuffer, nomeArquivo);
        await enviarMensagem(phone, `✅ *Contrato Gerado Com Sucesso!*\n\nDeseja Alguma *Alteração*? Me Diga O Que Mudar Que Refaço Na Hora! 😊\n\nOu Digite *NOVO* Para Gerar Outro Contrato.`);
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

      if (msg.length < 3) return res.sendStatus(200);

      await enviarMensagem(phone, `Entendido! Aplicando As Modificações E Gerando Novo PDF... ⏳`);
      const atualizado = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [
          { role: 'user', content: `Aqui Está Um Contrato:\n\n${usuario.contrato.texto}` },
          { role: 'assistant', content: usuario.contrato.texto },
          { role: 'user', content: `Faça As Seguintes Modificações: ${msg}\n\nRetorne O Contrato Completo Com As Modificações, Usando As Mesmas Marcações [TITULO], [CLAUSULA] E [NEGRITO]. Mantenha Todas As Palavras Com Primeira Letra Em Maiúsculo.` }
        ]
      });

      usuario.contrato.texto = atualizado.content[0].text;
      const pdfBuffer = await gerarPDF(usuario.contrato.texto);
      const nomeArquivo = `Contrato_${usuario.contrato.tipo.replace(/ /g, '_')}_atualizado.pdf`;
      await enviarPDF(phone, pdfBuffer, nomeArquivo);
      await enviarMensagem(phone, `✅ *Contrato Atualizado!*\n\nDeseja Mais Alguma *Alteração*? Ou Digite *NOVO* Para Gerar Outro Contrato.`);
      return res.sendStatus(200);
    }

  } catch (error) {
    console.error('Erro:', error);
    res.sendStatus(500);
  }
});

app.get('/', (req, res) => { res.json({ status: 'ContratoBot Rodando!' }); });
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log('ContratoBot Rodando Na Porta ' + PORT); });
