import fs from 'fs';
import path from 'path';

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

function buildFallback({ bairro, tipologia }) {
  const filtrados = filtrarEmpreendimentos({ bairro, tipologia });
  const take = filtrados.slice(0, 3).map((e) => {
    const entregaMatch = (e.descricao || '').match(/Entrega:\s*([^|\n]+)/i);
    const entrega = entregaMatch ? entregaMatch[0].replace(/\s+/g, ' ').trim() : '';
    return {
      nome: e.nome,
      bairro: e.bairro,
      tipologias: (e.tipologia || []).join(', '),
      entrega: entrega
    };
  });

  const fallback =
    take.length === 0
      ? { resposta: 'Sem empreendimentos correspondentes ao filtro.', empreendimentos: [] }
      : { resposta: `Recomendação: Seguem algumas opções em ${bairro}.`, empreendimentos: take };

  return fallback;
}

// Example input
const input = { bairro: 'Icaraí', tipologia: '2q' };
const out = buildFallback(input);
console.log(JSON.stringify(out, null, 2));
