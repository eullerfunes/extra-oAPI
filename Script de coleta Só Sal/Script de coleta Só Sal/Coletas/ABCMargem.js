const axios = require('axios');
const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();

// --- CONFIGURAÇÕES MANUAIS ---
const DATA_INICIAL_PADRAO = '20241226'; 
const ARQUIVO_LOG = 'erros_sincronizacao.txt'; // Nome do arquivo de erros

// --- CREDENCIAIS POSTGRESQL ---
const db = new Pool({
    host: process.env.host,       
    port: parseInt(process.env.port || '5432', 10),          
    user: process.env.user,         
    password: process.env.password, 
    database: process.env.dataBase
});


const FILIAIS = [
    { 
        nome: 'Bandeirantes', 
        ip: process.env.FILIAL_BDS_IP, 
        token: process.env.FILIAL_BDS_TOKEN 
    },
    { 
        nome: 'Campo Grande', 
        ip: process.env.FILIAL_CG_IP, 
        token: process.env.FILIAL_CG_TOKEN 
    },
    { 
        nome: 'Rio Verde', 
        ip: process.env.FILIAL_RIO_IP, 
        token: process.env.FILIAL_RIO_TOKEN 
    },
    { 
        nome: 'Coxim', 
        ip: process.env.FILIAL_CX_IP, 
        token: process.env.FILIAL_CX_TOKEN 
    },
    { 
        nome: 'Pedro Gomes', 
        ip: process.env.FILIAL_PG_IP, 
        token: process.env.FILIAL_PG_TOKEN 
    },
    { 
        nome: 'Anastácio', 
        ip: process.env.FILIAL_AN_IP, 
        token: process.env.FILIAL_AN_TOKEN 
    }

];

// --- FUNÇÃO PARA REGISTRAR ERROS NO TXT ---
function registrarErroNoArquivo(filial, erro, linhaOriginal) {
    const timestamp = new Date().toLocaleString();
    const logMessage = `
[${timestamp}] FILIAL: ${filial}
ERRO: ${erro}
LINHA: ${linhaOriginal}
--------------------------------------------------------------------------------
`;
    fs.appendFileSync(ARQUIVO_LOG, logMessage, 'utf8');
}

async function registrarErroNoBanco(filial, erro, linhaOriginal) {
    try {
        const query = `
            INSERT INTO "Só Sal".LOG_ERROS_SINC (filial, mensagem, linha_original)
            VALUES ($1, $2, $3)
        `;
        await db.query(query, [filial, erro, linhaOriginal]);
    } catch (dbErr) {
        console.error(`❌ Falha ao salvar log no banco: ${dbErr.message}`);
        registrarErroNoArquivo(filial, erro, linhaOriginal); // Plano B salva no TXT
    }
}

// --- FUNÇÕES AUXILIARES DE DATA ---
function formatarDataAPI(date) {
    const d = new Date(date);
    const ano = d.getFullYear();
    const mes = String(d.getMonth() + 1).padStart(2, '0');
    const dia = String(d.getDate()).padStart(2, '0');
    return `${ano}${mes}${dia}`;
}

function formatarDataBanco(dataCsv) {
    if (!dataCsv || !dataCsv.includes('/')) return null; 
    const partes = dataCsv.split('/');
    if (partes.length !== 3) return null;
    const [dia, mes, ano] = partes;
    return `${ano}-${mes}-${dia}`;
}

async function buscarUltimaDataFilial(nomeFilial) {
    try {
        const res = await db.query(
            'SELECT MAX(data_venda) as ultima_data FROM "Só Sal".ABCMARGEM WHERE filial = $1', 
            [nomeFilial]
        );
        return res.rows[0].ultima_data;
    } catch (err) {
        return null;
    }
}

async function inicializarBanco() {
    console.log('Verificando estrutura do banco...');
    await db.query('CREATE SCHEMA IF NOT EXISTS "Só Sal";');
    await db.query(`
        CREATE TABLE IF NOT EXISTS "Só Sal".ABCMARGEM (
            filial VARCHAR(50), nf VARCHAR(50), operacao VARCHAR(100), cliente VARCHAR(255),
            cod_cliente VARCHAR(50), vendedor VARCHAR(255), cod_vendedor VARCHAR(50),
            produto_desc VARCHAR(255), produto_cod VARCHAR(50), marca VARCHAR(100),
            fornecedor VARCHAR(255), grupo_subgrupo VARCHAR(255), data_venda DATE,
            cond_pagto VARCHAR(100), forma_pagto VARCHAR(100), qtde NUMERIC(15,2),
            descto NUMERIC(15,2), vda_bruta NUMERIC(15,2), media_un NUMERIC(15,2),
            icms NUMERIC(15,2), pis_cofins NUMERIC(15,2), outros NUMERIC(15,2),
            custo NUMERIC(15,2), frete NUMERIC(15,2), desp_aces NUMERIC(15,2),
            comissao NUMERIC(15,2), lucro_bruto NUMERIC(15,2), perc_lucro NUMERIC(15,2),
            perc_venda NUMERIC(15,2), data_atualizacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (filial, nf, produto_cod, data_venda)
        );
    `);
    await db.query(`
    CREATE TABLE IF NOT EXISTS "Só Sal".LOG_ERROS_SINC (
        id SERIAL PRIMARY KEY,
        data_hora TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        filial VARCHAR(50),
        mensagem TEXT,
        linha_original TEXT
    );
`);
}

async function processarTodasFiliais() {
    // Inicia o arquivo de log limpo a cada execução (opcional)
    fs.writeFileSync(ARQUIVO_LOG, `Início da Sincronização: ${new Date().toLocaleString()}\n\n`, 'utf8');

    try {
        await inicializarBanco();
        const dataFimAPI = formatarDataAPI(new Date());

        for (const filial of FILIAIS) {
            console.log(`\n--- Processando ${filial.nome} ---`);

            try {

            const ultimaDataNoBanco = await buscarUltimaDataFilial(filial.nome);
            let dataIniAPI;

            if (ultimaDataNoBanco) {
                let dataSeguranca = new Date(ultimaDataNoBanco);
                dataSeguranca.setDate(dataSeguranca.getDate() - 15); 
                dataIniAPI = formatarDataAPI(dataSeguranca);
            } else {
                dataIniAPI = DATA_INICIAL_PADRAO;
            }

            const url = `http://${filial.ip}/siscom/consulta/ABCMargem`;
            const params = { Empresa: 1, DataIni: dataIniAPI, DataFim: dataFimAPI, TipoABC: 1, TipoCusto: 0, InterCia: 1 };

            const response = await axios.get(url, { params, headers: { 'Authorization': filial.token }, responseType: 'text' });

            if (!response.data || response.data.trim() === "") {
                console.log(`⚠️ Sem novos dados para ${filial.nome}.`);
                continue;
            }

            const linhas = response.data.trim().split('\n').slice(1);
            console.log(`📦 Sincronizando ${linhas.length} registros...`);

            for (let linha of linhas) {
                if (linha.trim().length === 0) continue; 

                try {
                    // Regex para lidar com aspas e ponto-e-vírgula internos
                    const valores = linha.split(/;(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(v => {
                        if (!v) return null;
                        let limpo = v.trim().replace(/^"|"$/g, '').trim();
                        return limpo.replace(/""/g, '"') === "" ? null : limpo.replace(/""/g, '"');
                    });

                    // Validação de colunas
                    if (valores.length < 28) {
                        await registrarErroNoBanco(filial.nome, `Número de colunas insuficiente (${valores.length})`, linha);
                        continue;
                    }

                    const parseNum = (val) => val ? parseFloat(val.replace(',', '.')) || 0 : 0;

                    const valoresQuery = [
                        filial.nome, valores[0], valores[1], valores[2], valores[3], 
                        valores[4], valores[5], valores[6], valores[7], valores[8], 
                        valores[9], valores[10], formatarDataBanco(valores[11]), valores[12], 
                        valores[13], parseNum(valores[14]), parseNum(valores[15]), parseNum(valores[16]), 
                        parseNum(valores[17]), parseNum(valores[18]), parseNum(valores[19]), 
                        parseNum(valores[20]), parseNum(valores[21]), parseNum(valores[22]), 
                        parseNum(valores[23]), parseNum(valores[24]), parseNum(valores[25]), 
                        parseNum(valores[26]), parseNum(valores[27])
                    ];

                    const upsertQuery = `
                        INSERT INTO "Só Sal".ABCMARGEM (
                            filial, nf, operacao, cliente, cod_cliente, vendedor, cod_vendedor, 
                            produto_desc, produto_cod, marca, fornecedor, grupo_subgrupo, data_venda, 
                            cond_pagto, forma_pagto, qtde, descto, vda_bruta, media_un, icms, 
                            pis_cofins, outros, custo, frete, desp_aces, comissao, lucro_bruto, 
                            perc_lucro, perc_venda, data_atualizacao
                        ) VALUES (
                            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 
                            $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, CURRENT_TIMESTAMP
                        )
                        ON CONFLICT (filial, nf, produto_cod, data_venda) 
                        DO UPDATE SET
                            operacao = EXCLUDED.operacao, vendedor = EXCLUDED.vendedor, 
                            cod_vendedor = EXCLUDED.cod_vendedor, vda_bruta = EXCLUDED.vda_bruta, 
                            frete = EXCLUDED.frete, data_atualizacao = CURRENT_TIMESTAMP;
                    `;

                    await db.query(upsertQuery, valoresQuery);

                } catch (erroLinha) {
                    // Salva erros de banco de dados ou conversão de tipo no arquivo
                    await registrarErroNoBanco(filial.nome, erroLinha.message, linha);
                }
            }
            console.log(`✅ ${filial.nome} concluída.`);
            
            } catch (erroFilial) {
                console.error(`❌ Erro geral na filial ${filial.nome}:`, erroFilial.message);
                await registrarErroNoBanco(filial.nome, `Erro de Comunicação/API: ${erroFilial.message}`, 'Falha de Conexão/Timeout');
            }
        }
    } catch (err) {
        console.error('Erro Fatal:', err.message);
        fs.appendFileSync(ARQUIVO_LOG, `\n[ERRO FATAL NO SCRIPT]: ${err.message}\n`, 'utf8');
    } finally {
        await db.end();
        console.log(`\nSincronização Finalizada. Verifique o arquivo "${ARQUIVO_LOG}" para detalhes de eventuais erros.`);
    }
}

processarTodasFiliais();