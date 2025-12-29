import fs from 'fs';

const data = JSON.parse(fs.readFileSync('./data/empreendimentos.json', 'utf8'));

function norm(s = '') {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function includesWord(haystack, term) {
  if (!term) return false;
  const safe = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(^|[^a-z0-9])' + safe + '([^a-z0-9]|$)');
  if (term.length < 4) return haystack.includes(term);
  return re.test(haystack);
}

function extractB(msg) {
  const found = new Set();
  const pad = ' ' + msg + ' ';
  data.forEach((e) => {
    const b = norm(e.bairro || '');
    if (b && includesWord(pad, b)) found.add(b);
  });
  ['icarai', 'icaria', 'niteroi'].forEach((v) => {
    if (includesWord(' ' + msg + ' ', v)) found.add(v === 'icaria' ? 'icarai' : v);
  });
  return Array.from(found);
}

function extractNames(msg) {
  const pad = ' ' + msg + ' ';
  const matched = [];
  data.forEach((e) => {
    const nome = norm(e.nome || '');
    if (!nome) return;
    const tokens = nome.split(/\s+/).filter(Boolean);
    const tokenHit = tokens.some((w) => w.length >= 4 && includesWord(pad, w));
    if (includesWord(pad, nome) || tokenHit) matched.push(e);
  });
  return matched;
}

function hasTip(e, tipKeys) {
  if (!tipKeys || tipKeys.length === 0) return false;
  const tips = Array.isArray(e.tipologia)
    ? e.tipologia
    : Array.isArray(e.tipologias)
    ? e.tipologias
    : [e.tipologia || e.tipologias || ''];
  const normTips = tips.map((t) => norm(t || ''));
  const normKeys = tipKeys.map((t) => norm(t || ''));
  return normKeys.some((t) => normTips.includes(t));
}

function extractTipKeys(msgNorm) {
  const keys = [];
  if (/\b(studio|studios)\b/.test(msgNorm)) keys.push('studio');
  if (/\bloft\b/.test(msgNorm)) keys.push('loft');
  if (/\b1\s*q(uarto)?s?\b/.test(msgNorm)) keys.push('1q');
  if (/\b2\s*q(uarto)?s?\b/.test(msgNorm)) keys.push('2q');
  if (/\b3\s*q(uarto)?s?\b/.test(msgNorm)) keys.push('3q');
  if (/\b4\s*q(uarto)?s?\b/.test(msgNorm)) keys.push('4q');
  return keys;
}

function find(msg) {
  const n = norm(msg);
  const tipKeys = extractTipKeys(n);
  const bairros = extractB(n);
  if (bairros.length) {
    const bairroMatches = data.filter((e) => bairros.includes(norm(e.bairro || '')));
    if (tipKeys.length) {
      const filtered = bairroMatches.filter((e) => hasTip(e, tipKeys));
      if (filtered.length) return { reason: 'bairro+tip', list: filtered, bairros, tipKeys };
    }
    return { reason: 'bairro', list: bairroMatches, bairros, tipKeys };
  }
  const names = extractNames(n);
  if (names.length) return { reason: 'nome', list: names };
  return { reason: 'none', list: [] };
}

function summarise(c) {
  return c.map((e) => ({ nome: e.nome, bairro: e.bairro, tipologia: e.tipologia || e.tipologias, entrega: e.entrega }));
}

['Marem', 'Pulse', 'Icaraí', 'Piratininga', 'icarai 4 quartos'].forEach((q) => {
  const r = find(q);
  console.log('\nQuery:', q, 'Reason:', r.reason, 'Count:', r.list.length);
  console.log(JSON.stringify(summarise(r.list), null, 2));
});
