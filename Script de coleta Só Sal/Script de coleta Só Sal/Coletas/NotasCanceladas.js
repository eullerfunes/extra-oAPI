const axios = require('axios');
const { Pool } = require('pg');
require('dotenv').config();

// --- CONFIGURAÇÕES MANUAIS ---
const DATA_INICIAL_PADRAO = '20241226'; // Formato YYYYMMDD

// --- CREDENCIAIS POSTGRESQL ---
const db = new Pool({
    host: process.env.host || 'db.othgmlgiivguzvtultkz.supabase.co',       
    port: parseInt(process.env.port || '5432', 10),          
    user: process.env.user || 'postgres',         
    password: process.env.password, 
    database: process.env.dataBase || 'postgres'
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

// --- FUNÇÃO PARA BUSCAR A ÚLTIMA DATA NO BANCO ---
async function buscarUltimaDataFilial(nomeFilial) {
    try {
        const res = await db.query(
            'SELECT MAX(data_cancelamento) as ultima_data FROM "Só Sal".NOTAS_CANCELADAS WHERE filial = $1', 
            [nomeFilial]
        );
        return res.rows[0].ultima_data;
    } catch (err) {
        return null;
    }
}

async function inicializarBanco() {
    console.log('Verificando estrutura do banco (Schema e Tabela de Canceladas)...');
    
    await db.query('CREATE SCHEMA IF NOT EXISTS "Só Sal";');

    // Tabela ajustada para comportar TODOS os campos do novo CSV
    await db.query(`
        CREATE TABLE IF NOT EXISTS "Só Sal".NOTAS_CANCELADAS (
            filial VARCHAR(50),
            nf VARCHAR(50),
            modelo VARCHAR(50),
            data_emissao DATE,
            data_cancelamento DATE,
            cod_cliente VARCHAR(50),
            cliente VARCHAR(255),
            operacao VARCHAR(100),
            motivo TEXT,
            usuario VARCHAR(100),
            valor NUMERIC(15,2),
            data_atualizacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (filial, nf, data_cancelamento) -- Chave única
        );
    `);
}

async function processarTodasFiliais() {
    try {
        await inicializarBanco();
        const dataFimAPI = formatarDataAPI(new Date());

        for (const filial of FILIAIS) {
            console.log(`\n--- Processando Notas Canceladas: ${filial.nome} ---`);

            try {

            const ultimaDataNoBanco = await buscarUltimaDataFilial(filial.nome);
            let dataIniAPI;

            if (ultimaDataNoBanco) {
                let dataSeguranca = new Date(ultimaDataNoBanco);
                dataSeguranca.setDate(dataSeguranca.getDate() - 15); 
                dataIniAPI = formatarDataAPI(dataSeguranca);
                console.log(`🔎 Última data: ${ultimaDataNoBanco.toISOString().split('T')[0]}. Iniciando em ${dataIniAPI} (-1 dia para auditoria).`);
            } else {
                dataIniAPI = DATA_INICIAL_PADRAO;
                console.log(`🆕 Filial sem dados de cancelamento. Iniciando em: ${dataIniAPI}`);
            }

            const url = `http://${filial.ip}/siscom/consulta/NotasCanceladas`;
            const params = {
                Empresa: 1,
                DataIni: dataIniAPI,
                DataFim: dataFimAPI
            };

            const response = await axios.get(url, {
                params,
                headers: { 'Authorization': filial.token },
                responseType: 'text'
            });

            if (!response.data || response.data.trim() === "") {
                console.log(`⚠️ Sem notas canceladas para ${filial.nome}.`);
                continue;
            }

            const linhas = response.data.trim().split('\n').slice(1);
            console.log(`📦 Sincronizando ${linhas.length} notas canceladas...`);

            for (let linha of linhas) {
                // Separa as colunas e remove aspas duplas de eventuais textos
                const valores = linha.split(';').map(v => v ? v.replace(/"/g, '').trim() : null);
                const parseNum = (val) => val ? parseFloat(val.replace(',', '.')) || 0 : 0;

                // Mapeamento EXATO baseado no cabeçalho: 
                // Data Canc[0]; Documento[1]; Modelo[2]; Data Emissão[3]; Valor[4]; Cod Cliente[5]; Nome Cliente[6]; Operação[7]; Motivo[8]; Usuário[9]
                const valoresQuery = [
                    filial.nome,
                    valores[1], // Documento (NF)
                    valores[2], // Modelo
                    formatarDataBanco(valores[3]), // Data Emissão
                    formatarDataBanco(valores[0]), // Data Canc
                    valores[5], // Cod Cliente
                    valores[6], // Nome Cliente
                    valores[7], // Operação
                    valores[8], // Motivo
                    valores[9], // Usuário
                    parseNum(valores[4]) // Valor
                ];

                const upsertQuery = `
                    INSERT INTO "Só Sal".NOTAS_CANCELADAS (
                        filial, nf, modelo, data_emissao, data_cancelamento, 
                        cod_cliente, cliente, operacao, motivo, usuario, valor, data_atualizacao
                    ) VALUES (
                        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP
                    )
                    ON CONFLICT (filial, nf, data_cancelamento) 
                    DO UPDATE SET
                        modelo = EXCLUDED.modelo,
                        data_emissao = EXCLUDED.data_emissao,
                        cod_cliente = EXCLUDED.cod_cliente,
                        cliente = EXCLUDED.cliente,
                        operacao = EXCLUDED.operacao,
                        motivo = EXCLUDED.motivo,
                        usuario = EXCLUDED.usuario,
                        valor = EXCLUDED.valor,
                        data_atualizacao = CURRENT_TIMESTAMP;
                `;

                await db.query(upsertQuery, valoresQuery);
            }
            console.log(`✅ Notas Canceladas de ${filial.nome} concluídas.`);
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