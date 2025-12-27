import fs from 'fs';
import path from 'path';
import { buildPrompt } from '../prompt.js';

const filePath = path.join(process.cwd(), 'data', 'empreendimentos.json');
const empreendimentos = JSON.parse(fs.readFileSync(filePath, 'utf8'));

function norm(s = '') {
  return s
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function normTipologia(t = '') {
  const x = norm(t);
  if (x.includes('studio')) return 'studio';
  if (x.match(/\b1\b/) && x.includes('quarto')) return '1q';
  if (x.match(/\b2\b/) && x.includes('quarto')) return '2q';
  if (x.match(/\b3\b/) && x.includes('quarto')) return '3q';
  if (x.match(/\b4\b/) && x.includes('quarto')) return '4q';
  if (x === '1q' || x === '2q' || x === '3q' || x === '4q') return x;
  return x;
}

function filtrarEmpreendimentos({ bairro, tipologia }) {
  const b = norm(bairro || '');
  const t = normTipologia(tipologia || '');

  const filtrados = empreendimentos.filter((e) => {
    const eb = norm(e.bairro || '');
    const tipos = (e.tipologia || []).map(normTipologia);

    const okBairro = !b || eb.includes(b);
    const okTipo = !t || tipos.includes(t);

    return okBairro && okTipo;
  });

  return filtrados.slice(0, 7);
}

async function run() {
  const payload = {
    mensagens: ['Olá estou interessado mesmo em icarai 2 quartos'],
    bairro: 'Icaraí',
    tipologia: '2q'
  };

  const filtrados = filtrarEmpreendimentos({ bairro: payload.bairro, tipologia: payload.tipologia });

  console.log('Filtro:', { bairro: payload.bairro, tipologia: payload.tipologia, total: filtrados.length });
  console.log('Top 10:', filtrados.slice(0, 10).map(e => `${e.nome} (${e.bairro}) - ${ (e.tipologia || []).join(',') }`));

  const prompt = buildPrompt({ mensagens: payload.mensagens, empreendimentos: filtrados });

  console.log('\n--- PROMPT GERADO ---\n');
  console.log(prompt);
}

run().catch(err => { console.error(err); process.exit(1); });
