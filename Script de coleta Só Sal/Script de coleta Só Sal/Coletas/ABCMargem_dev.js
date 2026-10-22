const axios = require('axios');
const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();

// --- CONFIGURAÇÕES MANUAIS ---
const DATA_INICIAL_PADRAO = '20241226'; // Formato YYYYMMDD

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

// --- FUNÇÕES AUXILIARES DE DATA ---
function formatarDataAPI(date) {
    const d = new Date(date);
    const ano = d.getFullYear();
    const mes = String(d.getMonth() + 1).padStart(2, '0');
    const dia = String(d.getDate()).padStart(2, '0');
    return `${ano}${mes}${dia}`;
}

function formatarDataBanco(dataCsv) {
    if (!dataCsv) return null;
    const [dia, mes, ano] = dataCsv.split('/');
    return `${ano}-${mes}-${dia}`;
}

// --- FUNÇÃO PARA BUSCAR A ÚLTIMA DATA NO BANCO (TABELA DE DEVOLUÇÕES) ---
async function buscarUltimaDataFilial(nomeFilial) {
    try {
        const res = await db.query(
            'SELECT MAX(data_venda) as ultima_data FROM "Só Sal".ABCMARGEM_DEV WHERE filial = $1', 
            [nomeFilial]
        );
        return res.rows[0].ultima_data;
    } catch (err) {
        return null;
    }
}

async function inicializarBanco() {
    console.log('Verificando estrutura do banco (Schema e Tabela de Devoluções)...');
    
    await db.query('CREATE SCHEMA IF NOT EXISTS "Só Sal";');

    // Tabela nova específica para DEVOLUÇÕES
    await db.query(`
        CREATE TABLE IF NOT EXISTS "Só Sal".ABCMARGEM_DEV (
            filial VARCHAR(50),
            nf VARCHAR(50),
            operacao VARCHAR(100),
            cliente VARCHAR(255),
            cod_cliente VARCHAR(50),
            vendedor VARCHAR(255),
            cod_vendedor VARCHAR(50),
            produto_desc VARCHAR(255),
            produto_cod VARCHAR(50),
            marca VARCHAR(100),
            fornecedor VARCHAR(255),
            grupo_subgrupo VARCHAR(255),
            data_venda DATE,
            cond_pagto VARCHAR(100),
            forma_pagto VARCHAR(100),
            qtde NUMERIC(15,2),
            descto NUMERIC(15,2),
            vda_bruta NUMERIC(15,2),
            media_un NUMERIC(15,2),
            icms NUMERIC(15,2),
            pis_cofins NUMERIC(15,2),
            outros NUMERIC(15,2),
            custo NUMERIC(15,2),
            frete NUMERIC(15,2),
            desp_aces NUMERIC(15,2),
            comissao NUMERIC(15,2),
            lucro_bruto NUMERIC(15,2),
            perc_lucro NUMERIC(15,2),
            perc_venda NUMERIC(15,2),
            data_atualizacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (filial, nf, produto_cod, data_venda)
        );
    `);
}

async function processarTodasFiliais() {
    try {
        await inicializarBanco();
        const dataFimAPI = formatarDataAPI(new Date());

        for (const filial of FILIAIS) {
            console.log(`\n--- Processando Devoluções: ${filial.nome} ---`);

            try {

            const ultimaDataNoBanco = await buscarUltimaDataFilial(filial.nome);
            let dataIniAPI;

            if (ultimaDataNoBanco) {
                let dataSeguranca = new Date(ultimaDataNoBanco);
                dataSeguranca.setDate(dataSeguranca.getDate() - 30); 
                dataIniAPI = formatarDataAPI(dataSeguranca);
                console.log(`🔎 Última data: ${ultimaDataNoBanco.toISOString().split('T')[0]}. Iniciando em ${dataIniAPI} (-1 dia para auditoria).`);
            } else {
                dataIniAPI = DATA_INICIAL_PADRAO;
                console.log(`🆕 Filial sem dados de devolução. Iniciando em: ${dataIniAPI}`);
            }

            const url = `http://${filial.ip}/siscom/consulta/ABCMargem`;
            
            // --- PARÂMETROS ATUALIZADOS PARA DEVOLUÇÃO ---
            const params = {
                Empresa: 1,
                DataIni: dataIniAPI,
                DataFim: dataFimAPI,
                TipoABC: 1,
                TipoCusto: 0,
                ApenasDevo: 1, // <- Parâmetro novo adicionado
                InterCia: 1
            };

            const response = await axios.get(url, {
                params,
                headers: { 'Authorization': filial.token },
                responseType: 'text'
            });

            if (!response.data || response.data.trim() === "") {
                console.log(`⚠️ Sem novas devoluções para ${filial.nome}.`);
                continue;
            }

            const linhas = response.data.trim().split('\n').slice(1);
            console.log(`📦 Sincronizando ${linhas.length} devoluções...`);

            for (let linha of linhas) {
                const valores = linha.split(';').map(v => v ? v.replace(/"/g, '').trim() : null);
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

                // --- INSERINDO NA NOVA TABELA DE DEVOLUÇÕES ---
                const upsertQuery = `
                    INSERT INTO "Só Sal".ABCMARGEM_DEV (
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
                        operacao = EXCLUDED.operacao,
                        vendedor = EXCLUDED.vendedor,
                        cod_vendedor = EXCLUDED.cod_vendedor,
                        vda_bruta = EXCLUDED.vda_bruta,
                        frete = EXCLUDED.frete,
                        data_atualizacao = CURRENT_TIMESTAMP;
                `;

                await db.query(upsertQuery, valoresQuery);
            }
            console.log(`✅ Devoluções de ${filial.nome} concluídas.`);
            
            } catch (erroFilial) {
                console.error(`❌ Erro geral na filial ${filial.nome}:`, erroFilial.message);
                registrarErroNoArquivo(filial.nome, `Erro na comunicação/banco: ${erroFilial.message}`, 'N/A - Falha na filial inteira');
            }
        }
    } catch (err) {
        console.error('Erro:', err.message);
    } finally {
        await db.end();
    }
}

processarTodasFiliais();