const express = require('express');
const app = express();
app.use(express.json());
const Anthropic = require('@anthropic-ai/sdk');
const PDFDocument = require('pdfkit');
const { Document, Packer, Paragraph, TextRun, AlignmentType } = require('docx');
const { Pool } = require('pg');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function inicializarBanco() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        phone VARCHAR(20) PRIMARY KEY,
        plano VARCHAR(20),
        creditos INTEGER DEFAULT 0,
        data_expiracao BIGINT,
        etapa VARCHAR(30) DEFAULT 'menu',
        contrato_tipo VARCHAR(50),
        contrato_dados TEXT,
        contrato_pergunta INTEGER DEFAULT 0,
        contrato_texto TEXT,
        ultima_nota INTEGER,
        ultima_atividade BIGINT,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS avaliacoes (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(20),
        nota INTEGER,
        comentario TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('Banco de dados inicializado!');
  } catch (error) {
    console.error('Erro ao inicializar banco:', error);
  }
}

async function getUsuario(phone) {
  try {
    const result = await pool.query('SELECT * FROM usuarios WHERE phone = $1', [phone]);
    if (result.rows.length === 0) {
      return { phone, plano: null, creditos: 0, etapa: 'menu', contrato: {}, dataExpiracao: null, ultimaAtividade: null };
    }
    const row = result.rows[0];
    return {
      phone: row.phone,
      plano: row.plano,
      creditos: row.creditos,
      etapa: row.etapa,
      dataExpiracao: row.data_expiracao ? parseInt(row.data_expiracao) : null,
      ultimaNota: row.ultima_nota,
      ultimaAtividade: row.ultima_atividade ? parseInt(row.ultima_atividade) : null,
      contrato: {
        tipo: row.contrato_tipo,
        dados: row.contrato_dados ? JSON.parse(row.contrato_dados) : [],
        perguntaAtual: row.contrato_pergunta || 0,
        texto: row.contrato_texto
      }
    };
  } catch (error) {
    console.error('Erro ao buscar usuario:', error);
    return { phone, plano: null, creditos: 0, etapa: 'menu', contrato: {}, dataExpiracao: null };
  }
}

async function salvarUsuario(usuario) {
  try {
    await pool.query(`
      INSERT INTO usuarios (phone, plano, creditos, data_expiracao, etapa, contrato_tipo, contrato_dados, contrato_pergunta, contrato_texto, ultima_nota, ultima_atividade, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
      ON CONFLICT (phone) DO UPDATE SET
        plano = $2, creditos = $3, data_expiracao = $4, etapa = $5,
        contrato_tipo = $6, contrato_dados = $7, contrato_pergunta = $8,
        contrato_texto = $9, ultima_nota = $10, ultima_atividade = $11, updated_at = NOW()
    `, [
      usuario.phone,
      usuario.plano,
      usuario.creditos,
      usuario.dataExpiracao,
      usuario.etapa,
      usuario.contrato?.tipo || null,
      usuario.contrato?.dados ? JSON.stringify(usuario.contrato.dados) : null,
      usuario.contrato?.perguntaAtual || 0,
      usuario.contrato?.texto || null,
      usuario.ultimaNota || null,
      Date.now()
    ]);
  } catch (error) {
    console.error('Erro ao salvar usuario:', error);
  }
}

const ultimasMensagens = {};

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

function dataAtual() {
  const hoje = new Date();
  return hoje.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
}

function dataExpiracaoFormatada(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
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
    'Qual é o seu nome completo, CPF e profissão?\n_(Ex: João Silva, CPF 123.456.789-00, Designer Gráfico)_',
    'Qual é o nome completo e CPF do cliente?\n_(Ex: Maria Souza, CPF 987.654.321-00)_',
    'Qual serviço será prestado? Descreva com detalhes o que será feito.\n_(Ex: Criação de logotipo e identidade visual completa)_',
    'Qual o valor total cobrado pelo serviço?\n_(Ex: R$ 1.500,00)_',
    'Como será o pagamento?\n_(Ex: 50% na assinatura e 50% na entrega / à vista / 3x de R$ 500)_',
    'Qual a data de início do serviço?\n_(Ex: 01/07/2026)_',
    'Qual a data de término ou prazo de entrega?\n_(Ex: 30/07/2026 ou "indeterminado")_',
    'O serviço será presencial, remoto ou híbrido?\n_(Ex: remoto / presencial em São Paulo/SP)_',
    'Haverá multa por cancelamento ou descumprimento?\n_(Ex: multa de 20% do valor total / não haverá multa)_'
  ],
  'Aluguel de Imóvel': [
    'Nome completo, CPF e estado civil do proprietário (locador)?\n_(Ex: João Silva, CPF 123.456.789-00, casado)_',
    'Nome completo, CPF e estado civil do inquilino (locatário)?\n_(Ex: Maria Souza, CPF 987.654.321-00, solteira)_',
    'Endereço completo do imóvel alugado?\n_(Ex: Rua das Flores, 100, Apto 201, Bairro Centro, Ji-Paraná/RO, CEP 76900-000)_',
    'Qual o valor do aluguel mensal?\n_(Ex: R$ 1.200,00)_',
    'Qual o dia de vencimento do aluguel?\n_(Ex: todo dia 5 de cada mês)_',
    'Data de início do contrato?\n_(Ex: 01/07/2026)_',
    'Data de término do contrato?\n_(Ex: 30/06/2028)_',
    'Haverá depósito caução?\n_(Ex: R$ 2.400,00 equivalente a 2 meses / não haverá)_',
    'Permite animais de estimação? Permite reformas?\n_(Ex: não permite animais / permite pequenas reformas com autorização)_',
    'Haverá fiador?\n_(Ex: sim — Pedro Oliveira, CPF 111.222.333-44 / não haverá fiador)_',
    'Qual o índice de reajuste anual do aluguel?\n_(1 = IGPM/FGV / 2 = Salário Mínimo / 3 = IPCA / 4 = Outro — descreva)_'
  ],
  'Compra e Venda': [
    'Nome completo, CPF e estado civil do vendedor?\n_(Ex: João Silva, CPF 123.456.789-00, casado)_',
    'Nome completo, CPF e estado civil do comprador?\n_(Ex: Maria Souza, CPF 987.654.321-00, solteira)_',
    'O que está sendo vendido?\n_(Ex: imóvel / veículo / equipamento / outro)_',
    'Descrição detalhada do bem:\n_Para imóvel: endereço completo, matrícula, metragem_\n_Para veículo: marca, modelo, ano, cor, placa, chassi, RENAVAM_\n_Para outros: descreva com detalhes_',
    'Qual o valor total da venda?\n_(Ex: R$ 250.000,00)_',
    'Como será o pagamento?\n_(Ex: à vista no ato / 50% de entrada e saldo em 12x / financiamento bancário)_',
    'Qual a data de entrega ou transferência do bem?\n_(Ex: 15/07/2026 ou "na assinatura do contrato")_',
    'O bem possui algum débito, ônus ou defeito conhecido?\n_(Ex: sem débitos / IPTU em aberto de R$ 500 / pequeno amassado na porta)_',
    'Haverá multa em caso de desistência?\n_(Ex: 10% do valor total / não haverá multa)_'
  ],
  'Contrato de Trabalho': [
    'Nome completo e CNPJ da empresa contratante?\n_(Ex: Empresa ABC Ltda, CNPJ 12.345.678/0001-99)_',
    'Nome completo, CPF e função do funcionário?\n_(Ex: Ana Lima, CPF 111.222.333-44, Assistente Administrativo)_',
    'Qual o salário mensal combinado?\n_(Ex: R$ 2.000,00)_',
    'Qual a carga horária semanal?\n_(Ex: 44 horas semanais, segunda a sexta das 8h às 18h)_',
    'Qual a data de início?\n_(Ex: 01/07/2026)_',
    'Qual o tipo de contratação?\n_(1 = CLT / 2 = PJ / 3 = Contrato de Experiência)_',
    'Quais benefícios serão oferecidos?\n_(Ex: VT, VR de R$ 25/dia, plano de saúde / apenas salário)_',
    'Haverá período de experiência?\n_(Ex: 45 dias prorrogável por mais 45 / não haverá)_',
    'Endereço do local de trabalho?\n_(Ex: Rua X, 100, Centro, São Paulo/SP / trabalho remoto)_'
  ],
  'Parceria / Sociedade': [
    'Nome completo, CPF e profissão de todos os sócios?\n_(Ex: João Silva, CPF 123.456.789-00, empresário / Maria Souza, CPF 987.654.321-00, médica)_',
    'Qual o objetivo do negócio ou parceria? Descreva com detalhes.\n_(Ex: abertura de clínica odontológica especializada em ortodontia)_',
    'Qual a porcentagem de participação de cada sócio?\n_(Ex: João 60% / Maria 40%)_',
    'Quanto cada sócio irá investir inicialmente?\n_(Ex: João R$ 30.000 / Maria R$ 20.000)_',
    'Como será feita a divisão dos lucros?\n_(Ex: proporcional à participação / 50% para cada independente da cota)_',
    'Quem ficará responsável pelas decisões do dia a dia?\n_(Ex: João como sócio administrador / decisões conjuntas)_',
    'O que acontece se um sócio quiser sair?\n_(Ex: deve oferecer a cota ao outro sócio primeiro / pode vender livremente)_',
    'O contrato tem prazo definido?\n_(Ex: indeterminado / válido por 2 anos com renovação automática)_'
  ],
  'Outro': [
    'Descreva com detalhes o que você precisa no contrato.\n_(Seja o mais específico possível sobre o objetivo)_',
    'Quais são as partes envolvidas?\n_(Nome completo, CPF e papel de cada pessoa no contrato)_',
    'Quais são as obrigações da primeira parte?\n_(O que ela deve fazer, entregar ou pagar)_',
    'Quais são as obrigações da segunda parte?\n_(O que ela deve fazer, entregar ou pagar)_',
    'Qual o valor financeiro envolvido, se houver?\n_(Ex: R$ 5.000,00 / não há valor financeiro)_',
    'Qual o prazo do contrato?\n_(Ex: 12 meses a partir da assinatura / indeterminado)_',
    'Há alguma cláusula específica que deseja incluir?\n_(Ex: cláusula de confidencialidade / exclusividade / não há)_'
  ]
};

const PERGUNTAS_MINIMAS = {
  'Prestação de Serviços': 10,
  'Aluguel de Imóvel': 15,
  'Compra e Venda': 10,
  'Contrato de Trabalho': 10,
  'Parceria / Sociedade': 10,
  'Outro': 5
};

async function validarResposta(pergunta, resposta) {
  if (resposta.trim().length < 3) return false;
  const respostasVazias = ['não sei', 'nao sei', 'talvez', 'depende', '?', '-', '.', 'ok', 'sim', 'nao', 'não'];
  if (respostasVazias.includes(resposta.toLowerCase().trim())) return false;
  return true;
}

async function gerarContrato(tipo, dados, perguntas) {
  let instrucaoEspecial = '';

  if (tipo === 'Aluguel de Imóvel') {
    instrucaoEspecial = `
INSTRUÇÕES ESPECIAIS PARA ALUGUEL:
- O inquilino É RESPONSÁVEL por água, luz, condomínio e IPTU. Inclua isso nas cláusulas.
- As datas de início e término já foram fornecidas, NÃO deixe espaços em branco.
- Para reajuste IGPM/FGV ou IPCA, mencione o índice pelo nome.
- Para salário mínimo, calcule quantos salários mínimos equivale o aluguel (SM atual R$ 1.518,00).`;
  }

  const dataHoje = dataAtual();

  const prompt = `Você é um especialista em contratos jurídicos brasileiros.
Gere um contrato completo e profissional de ${tipo} com base nas seguintes informações coletadas:

${dados.map((d, i) => `PERGUNTA: ${perguntas[i]}\nRESPOSTA: ${d}`).join('\n\n')}

DATA DE HOJE: ${dataHoje}

${instrucaoEspecial}

REGRAS IMPORTANTES:
1. Use a data de hoje (${dataHoje}) como data de geração do contrato
2. Onde faltar informação essencial que o cliente não forneceu, insira [PREENCHER: descrição do dado] em negrito — NUNCA invente dados
3. Os dados das partes (nome, CPF, endereço) devem estar EXATAMENTE como informados
4. Verifique inconsistências antes de gerar (ex: data de término antes do início)
5. Inclua todas as cláusulas necessárias conforme a legislação brasileira

FORMATO - use estas marcações:
- Título principal: [TITULO]texto[/TITULO]
- Títulos de cláusulas: [CLAUSULA]texto[/CLAUSULA]
- Negrito importante: [NEGRITO]texto[/NEGRITO]
- Parágrafos normais: texto normal

O contrato deve incluir espaço para assinaturas das partes e duas testemunhas.

Gere o contrato completo agora.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }]
  });
  return response.content[0].text;
}

async function verificarContrato(textoContrato) {
  const prompt = `Analise este contrato jurídico e identifique:
1. Dados essenciais que estão faltando ou com [PREENCHER]
2. Inconsistências (datas erradas, valores conflitantes, etc)
3. Cláusulas importantes ausentes

Contrato:
${textoContrato}

Responda em formato simples, em português, listando apenas os problemas encontrados. Se o contrato estiver completo e consistente, responda apenas: "OK"`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
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
    doc.fontSize(10).font('Helvetica').text(`Local e Data: _________________________, ${dataAtual()}`, 70, doc.y, { width: larguraPagina });
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
  paragrafos.push(new Paragraph({ children: [new TextRun({ text: `Local e Data: _________________________, ${dataAtual()}`, size: 20 })] }));
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

function menuPrincipal(usuario) {
  const temAcesso = usuario && (usuario.plano || usuario.creditos > 0);
  const dicas = `\n\n💡 *Comandos disponíveis a qualquer momento:*\n• *SUPORTE* — falar com nossa equipe\n• *CANCELAR PLANO* — cancelar sua assinatura\n• *MENU* — voltar ao menu principal\n• *PDF* ou *WORD* — receber o contrato no formato desejado`;

  let infoplano = '';
  if (usuario?.plano === 'ilimitado' && usuario?.dataExpiracao) {
    infoplano = `\n\n♾️ *Plano Ilimitado* — válido até ${dataExpiracaoFormatada(usuario.dataExpiracao)}`;
  } else if (usuario?.plano === 'avulso' && usuario?.creditos > 0) {
    infoplano = `\n\n⚠️ Você tem *1 contrato disponível*. Após gerar não será possível gerar outro sem adquirir um novo acesso.`;
  }

  if (temAcesso) {
    return `Qual tipo de contrato você precisa? ⚖️${infoplano}

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

🔒 *Garantia:* não ficou satisfeito? Reembolso garantido em até 7 dias via SUPORTE.

Responda *1* ou *2* para continuar.`;
}

function pedirFormato() {
  return `Em qual formato você prefere receber o contrato?

1️⃣ PDF (recomendado para assinar)
2️⃣ Word (.docx) (para editar antes de assinar)

💡 Você também pode digitar *PDF* ou *WORD* a qualquer momento para receber o contrato no formato desejado.`;
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

async function enviarContrato(phone, usuario, formato) {
  const tipo = usuario.contrato.tipo;
  if (formato === 'pdf') {
    const pdfBuffer = await gerarPDF(usuario.contrato.texto);
    await enviarArquivo(phone, pdfBuffer, `Contrato_${tipo.replace(/ /g, '_')}.pdf`, 'application/pdf', '📄 Seu contrato em PDF está pronto!');
  } else {
    const wordBuffer = await gerarWord(usuario.contrato.texto);
    await enviarArquivo(phone, wordBuffer, `Contrato_${tipo.replace(/ /g, '_')}.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '📝 Seu contrato em Word está pronto!');
  }
  await enviarMensagem(phone, `✅ *Contrato enviado!*\n\nRecebeu o arquivo? Se não abriu, tente salvar no seu dispositivo.\n\nDeseja alguma *alteração*? Me diga o que mudar!\n\nOu use os comandos:\n• Digite *PDF* para receber em PDF\n• Digite *WORD* para receber em Word\n• Digite *NOVO* para gerar outro contrato\n\n🔒 Não ficou satisfeito? Reembolso garantido em até 7 dias — digite *SUPORTE*.`);

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

    const usuario = await getUsuario(phone);
    const msg = texto.trim();
    const msgUpper = msg.toUpperCase();
    console.log('Mensagem de', phone, ':', msg, '| Etapa:', usuario.etapa);

    if (usuario.etapa === 'gerando') return res.sendStatus(200);

    // Verifica timeout de 24h para conversa em andamento
    if (usuario.etapa === 'coletando' && usuario.ultimaAtividade) {
      const horasInativo = (Date.now() - usuario.ultimaAtividade) / (1000 * 60 * 60);
      if (horasInativo > 24) {
        await enviarMensagem(phone, `Olá! 👋 Você deixou um contrato de *${usuario.contrato.tipo}* em andamento.\n\nDeseja continuar de onde parou ou começar um novo?\n\n1️⃣ Continuar de onde parei\n2️⃣ Começar um novo contrato`);
        usuario.etapa = 'retomada';
        await salvarUsuario(usuario);
        return res.sendStatus(200);
      }
    }

    // Verifica expiração
    if (planoExpirado(usuario)) {
      usuario.plano = null;
      usuario.creditos = 0;
      usuario.dataExpiracao = null;
      await salvarUsuario(usuario);
      await enviarMensagem(phone, `⚠️ Seu *Plano Ilimitado* expirou!\n\nPara continuar gerando contratos escolha um novo plano:\n\n${menuPrincipal(null)}`);
      return res.sendStatus(200);
    }

    // Retomada de conversa
    if (usuario.etapa === 'retomada') {
      if (msg === '1') {
        usuario.etapa = 'coletando';
        await salvarUsuario(usuario);
        const perguntas = PERGUNTAS[usuario.contrato.tipo];
        const perguntaAtual = usuario.contrato.perguntaAtual;
        await enviarMensagem(phone, `Continuando seu contrato de *${usuario.contrato.tipo}*! 📋\n\n*Pergunta ${perguntaAtual + 1} de ${perguntas.length}:*\n${perguntas[perguntaAtual]}`);
      } else {
        usuario.etapa = 'menu';
        usuario.contrato = {};
        await salvarUsuario(usuario);
        await enviarMensagem(phone, menuPrincipal(usuario));
      }
      return res.sendStatus(200);
    }

    // PDF ou WORD a qualquer momento
    if (msgUpper === 'PDF' && usuario.contrato?.texto) {
      usuario.etapa = 'gerando';
      await salvarUsuario(usuario);
      await enviarMensagem(phone, `Gerando seu contrato em PDF... ⏳`);
      await enviarContrato(phone, usuario, 'pdf');
      usuario.etapa = 'revisao';
      await salvarUsuario(usuario);
      return res.sendStatus(200);
    }

    if (msgUpper === 'WORD' && usuario.contrato?.texto) {
      usuario.etapa = 'gerando';
      await salvarUsuario(usuario);
      await enviarMensagem(phone, `Gerando seu contrato em Word... ⏳`);
      await enviarContrato(phone, usuario, 'word');
      usuario.etapa = 'revisao';
      await salvarUsuario(usuario);
      return res.sendStatus(200);
    }

    // MENU
    if (msgUpper === 'MENU') {
      usuario.etapa = 'menu';
      usuario.contrato = {};
      await salvarUsuario(usuario);
      await enviarMensagem(phone, menuPrincipal(usuario));
      return res.sendStatus(200);
    }

    // SUPORTE
    if (msgUpper === 'SUPORTE') {
      await enviarMensagem(phone, `🆘 *Suporte ContratoBot*\n\nOlá! Para falar com nossa equipe:\n\n📧 E-mail: contratobotsuporte@gmail.com\n\nDescreva seu problema detalhadamente e responderemos em até 24h úteis! 😊\n\nHorário de atendimento: Segunda a Sexta, das 8h às 18h.`);
      return res.sendStatus(200);
    }

    // CANCELAR PLANO
    if (msgUpper === 'CANCELAR PLANO') {
      if (usuario.plano === 'ilimitado') {
        await enviarMensagem(phone, `😢 Que pena que deseja cancelar seu plano!\n\nSua assinatura possui *renovação automática mensal*. Para cancelar e não ser cobrado no próximo mês, entre em contato:\n\n📧 contratobotsuporte@gmail.com\n\nVocê continuará tendo acesso até o final do período já pago.`);
      } else {
        await enviarMensagem(phone, `Você não possui uma assinatura ativa. 😊\n\nSe precisar de ajuda digite *SUPORTE*.`);
      }
      return res.sendStatus(200);
    }

    // Sem acesso
    if (!usuario.plano && usuario.creditos === 0 && !['avaliacao', 'comentario'].includes(usuario.etapa)) {
      if (msg === '1') {
        await enviarMensagem(phone, `Ótimo! Acesse o link para pagar *R$ 14,99*:\n\n🔗 ${process.env.LINK_AVULSO}\n\nApós o pagamento seu acesso será liberado automaticamente! ✅`);
      } else if (msg === '2') {
        await enviarMensagem(phone, `Ótimo! Acesse o link para assinar por *R$ 49,99/mês*:\n\n🔗 ${process.env.LINK_ILIMITADO}\n\nApós o pagamento seu acesso será liberado automaticamente! ✅`);
      } else {
        await enviarMensagem(phone, menuPrincipal(null));
      }
      return res.sendStatus(200);
    }

    // Avaliação
    if (usuario.etapa === 'avaliacao') {
      const nota = parseInt(msg);
      if (nota >= 1 && nota <= 5) {
        usuario.ultimaNota = nota;
        usuario.etapa = 'comentario';
        await salvarUsuario(usuario);
        const estrelas = '⭐'.repeat(nota);
        await enviarMensagem(phone, `${estrelas} Obrigado pela avaliação!\n\nTem algum elogio, crítica ou sugestão? (opcional)\n\nOu digite *PULAR* para encerrar.`);
      } else {
        await enviarMensagem(phone, pedirAvaliacao());
      }
      return res.sendStatus(200);
    }

    if (usuario.etapa === 'comentario') {
      const comentario = msgUpper === 'PULAR' ? '' : msg;
      await pool.query('INSERT INTO avaliacoes (phone, nota, comentario) VALUES ($1, $2, $3)', [phone, usuario.ultimaNota, comentario]);
      usuario.etapa = 'menu';
      usuario.contrato = {};
      await salvarUsuario(usuario);
      await enviarMensagem(phone, `Muito obrigado pelo feedback! 😊\n\nVolte sempre que precisar. Até logo! 👋`);
      return res.sendStatus(200);
    }

    // Escolha de formato
    if (usuario.etapa === 'formato') {
      if (msg === '1' || msgUpper === 'PDF') {
        usuario.etapa = 'gerando';
        await salvarUsuario(usuario);
        await enviarMensagem(phone, `Gerando seu contrato em PDF... ⏳`);
        await enviarContrato(phone, usuario, 'pdf');
        usuario.etapa = 'revisao';
        if (usuario.plano === 'avulso') { usuario.creditos = 0; usuario.plano = null; }
        await salvarUsuario(usuario);
      } else if (msg === '2' || msgUpper === 'WORD') {
        usuario.etapa = 'gerando';
        await salvarUsuario(usuario);
        await enviarMensagem(phone, `Gerando seu contrato em Word... ⏳`);
        await enviarContrato(phone, usuario, 'word');
        usuario.etapa = 'revisao';
        if (usuario.plano === 'avulso') { usuario.creditos = 0; usuario.plano = null; }
        await salvarUsuario(usuario);
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
        await salvarUsuario(usuario);
        await enviarMensagem(phone, `Ótimo! Vou gerar seu contrato de *${tipo}*. 📋\n\nVou fazer algumas perguntas. Responda com o máximo de detalhes possível para gerar um contrato completo!\n\n*Pergunta 1 de ${PERGUNTAS[tipo].length}:*\n${PERGUNTAS[tipo][0]}`);
      } else {
        await enviarMensagem(phone, menuPrincipal(usuario));
      }
      return res.sendStatus(200);
    }

    // Coletando dados
    if (usuario.etapa === 'coletando') {
      const { tipo, dados, perguntaAtual } = usuario.contrato;
      const perguntas = PERGUNTAS[tipo];

      // Valida resposta
      const respostaValida = await validarResposta(perguntas[perguntaAtual], msg);
      if (!respostaValida) {
        await enviarMensagem(phone, `Por favor, responda com mais detalhes! 😊\n\n*Pergunta ${perguntaAtual + 1} de ${perguntas.length}:*\n${perguntas[perguntaAtual]}\n\nSe não quiser informar este dado, responda *"não informado"*.`);
        return res.sendStatus(200);
      }

      dados.push(msg);
      const proxima = perguntaAtual + 1;

      if (proxima < perguntas.length) {
        usuario.contrato.perguntaAtual = proxima;
        await salvarUsuario(usuario);
        await enviarMensagem(phone, `*Pergunta ${proxima + 1} de ${perguntas.length}:*\n${perguntas[proxima]}`);
      } else {
        // Mostra resumo antes de gerar
        const resumo = dados.map((d, i) => `• ${perguntas[i].split('\n')[0].replace(/[*_]/g, '')}\n  _${d}_`).join('\n\n');
        usuario.contrato.dados = dados;
        usuario.etapa = 'confirmando';
        await salvarUsuario(usuario);
        await enviarMensagem(phone, `Perfeito! Aqui está um resumo das informações:\n\n${resumo}\n\n✅ Digite *SIM* para gerar o contrato\n✏️ Digite o número da pergunta para corrigir (ex: *3* para corrigir a pergunta 3)`);
      }
      return res.sendStatus(200);
    }

    // Confirmação antes de gerar
    if (usuario.etapa === 'confirmando') {
      const { tipo, dados } = usuario.contrato;
      const perguntas = PERGUNTAS[tipo];

      if (msgUpper === 'SIM') {
        usuario.etapa = 'gerando';
        await salvarUsuario(usuario);
        await enviarMensagem(phone, `Gerando seu contrato... ⏳\n\nIsso pode levar alguns segundos!`);
        const textoContrato = await gerarContrato(tipo, dados, perguntas);

        // Verifica inconsistências
        const verificacao = await verificarContrato(textoContrato);
        usuario.contrato.texto = textoContrato;

        if (verificacao.trim() !== 'OK') {
          await enviarMensagem(phone, `⚠️ *Atenção — encontrei alguns pontos no contrato:*\n\n${verificacao}\n\nO contrato foi gerado assim mesmo. Você pode pedir alterações depois de receber.`);
        }

        usuario.etapa = 'formato';
        await salvarUsuario(usuario);
        await enviarMensagem(phone, pedirFormato());
      } else {
        // Tenta corrigir uma pergunta específica
        const num = parseInt(msg);
        if (num >= 1 && num <= perguntas.length) {
          usuario.contrato.corrigindo = num - 1;
          usuario.etapa = 'corrigindo';
          await salvarUsuario(usuario);
          await enviarMensagem(phone, `Tudo bem! Vamos corrigir a pergunta ${num}:\n\n${perguntas[num - 1]}\n\nQual é a resposta correta?`);
        } else {
          await enviarMensagem(phone, `Digite *SIM* para gerar o contrato ou o número da pergunta que deseja corrigir (1 a ${perguntas.length}).`);
        }
      }
      return res.sendStatus(200);
    }

    // Corrigindo uma resposta específica
    if (usuario.etapa === 'corrigindo') {
      const { tipo, dados, corrigindo } = usuario.contrato;
      const perguntas = PERGUNTAS[tipo];
      dados[corrigindo] = msg;
      usuario.contrato.dados = dados;
      usuario.etapa = 'confirmando';
      await salvarUsuario(usuario);
      const resumo = dados.map((d, i) => `• ${perguntas[i].split('\n')[0].replace(/[*_]/g, '')}\n  _${d}_`).join('\n\n');
      await enviarMensagem(phone, `✅ Corrigido!\n\nResumo atualizado:\n\n${resumo}\n\nDigite *SIM* para gerar o contrato ou o número de outra pergunta para corrigir.`);
      return res.sendStatus(200);
    }

    // Revisão
    if (usuario.etapa === 'revisao') {
      if (msgUpper === 'NOVO') {
        usuario.etapa = 'avaliacao';
        usuario.contrato = {};
        await salvarUsuario(usuario);
        await enviarMensagem(phone, pedirAvaliacao());
        return res.sendStatus(200);
      }

      if (msg.length < 5) return res.sendStatus(200);

      const palavrasNovoContrato = ['quero um contrato', 'novo contrato', 'fazer contrato', 'preciso de um contrato', 'gerar contrato'];
      const parecePedidoNovo = palavrasNovoContrato.some(p => msg.toLowerCase().includes(p));
      if (parecePedidoNovo) {
        await enviarMensagem(phone, `Para gerar um *novo contrato*, digite *NOVO*.\n\nSe quiser alterar o contrato atual, me diga o que mudar! 😊`);
        return res.sendStatus(200);
      }

      usuario.etapa = 'gerando';
      await salvarUsuario(usuario);
      await enviarMensagem(phone, `Aplicando as modificações... ⏳`);
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
      await salvarUsuario(usuario);
      await enviarMensagem(phone, `✅ Modificações aplicadas!\n\n${pedirFormato()}`);
      return res.sendStatus(200);
    }

  } catch (error) {
    console.error('Erro:', error);
    res.sendStatus(500);
  }
});

app.post('/kiwify', async (req, res) => {
  try {
    const body = req.body;
    const token = req.query.token || body.token || req.headers['x-kiwify-token'] || '';
    console.log('Kiwify webhook | Token:', token);

    const tokensAvulso = (process.env.KIWIFY_TOKEN || '').split(',').map(t => t.trim());
    const tokensIlimitado = (process.env.KIWIFY_TOKEN_ILIMITADO || '').split(',').map(t => t.trim());
    const todosTokens = [...tokensAvulso, ...tokensIlimitado];

    if (token && todosTokens.length > 0 && !todosTokens.includes(token)) {
      return res.status(401).json({ error: 'Token inválido' });
    }

    const phone = body.Customer?.mobile?.replace(/\D/g, '');
    if (!phone) return res.sendStatus(200);

    const usuario = await getUsuario(phone);
    const status = body.order_status || body.subscription_status;

    if (status === 'canceled' || status === 'cancelled') {
      usuario.plano = null;
      usuario.creditos = 0;
      usuario.dataExpiracao = null;
      await salvarUsuario(usuario);
      enviarMensagem(phone, `😢 Sua assinatura foi cancelada.\n\nSeu acesso permanece ativo até o final do período pago.\n\nSe quiser voltar:\n\n${menuPrincipal(null)}`);
      return res.sendStatus(200);
    }

    if (status !== 'paid') return res.sendStatus(200);

    if (tokensIlimitado.includes(token)) {
      usuario.plano = 'ilimitado';
      usuario.creditos = 999;
      usuario.dataExpiracao = Date.now() + (30 * 24 * 60 * 60 * 1000);
    } else {
      usuario.plano = 'avulso';
      usuario.creditos = 1;
      usuario.dataExpiracao = null;
    }

    usuario.etapa = 'menu';
    await salvarUsuario(usuario);
    enviarMensagem(phone, `🎉 *Pagamento confirmado!* Seu acesso foi liberado!\n\n${menuPrincipal(usuario)}`);
    res.sendStatus(200);
  } catch (error) {
    console.error('Erro kiwify:', error);
    res.sendStatus(500);
  }
});

app.get('/teste', async (req, res) => {
  const { phone, plano, senha } = req.query;
  if (senha !== 'matheus123') return res.status(401).json({ error: 'Senha inválida' });
  if (!phone) return res.status(400).json({ error: 'Phone obrigatório' });
  const usuario = await getUsuario(phone);
  if (plano === 'ilimitado') {
    usuario.plano = 'ilimitado';
    usuario.creditos = 999;
    usuario.dataExpiracao = Date.now() + (30 * 24 * 60 * 60 * 1000);
  } else {
    usuario.plano = 'avulso';
    usuario.creditos = 1;
    usuario.dataExpiracao = null;
  }
  usuario.etapa = 'menu';
  await salvarUsuario(usuario);
  enviarMensagem(phone, `🎉 *Acesso de teste liberado!*\n\n${menuPrincipal(usuario)}`);
  res.json({ success: true, phone, plano: usuario.plano });
});

app.get('/avaliacoes', async (req, res) => {
  const result = await pool.query('SELECT * FROM avaliacoes ORDER BY created_at DESC');
  const media = result.rows.length > 0
    ? (result.rows.reduce((a, b) => a + b.nota, 0) / result.rows.length).toFixed(1)
    : 0;
  res.json({ total: result.rows.length, media, avaliacoes: result.rows });
});

app.get('/', (req, res) => { res.json({ status: 'ContratoBot rodando!' }); });

const PORT = process.env.PORT || 3000;
inicializarBanco().then(() => {
  app.listen(PORT, () => { console.log('ContratoBot rodando na porta ' + PORT); });
});
