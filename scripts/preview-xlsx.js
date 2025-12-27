import xlsx from 'xlsx';
import path from 'path';
import fs from 'fs';

const args = process.argv.slice(2);
const input = args[0];
if (!input) {
  console.error('Uso: node scripts/preview-xlsx.js caminho/para/planilha.xlsx');
  process.exit(1);
}
const filePath = path.resolve(input);
if (!fs.existsSync(filePath)) {
  console.error('Arquivo não encontrado:', filePath);
  process.exit(1);
}
const wb = xlsx.readFile(filePath);
const sheet = wb.Sheets[wb.SheetNames[0]];
const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });
console.log('Total rows:', rows.length);
if (rows.length === 0) process.exit(0);
const headers = Object.keys(rows[0]);
console.log('Headers:', headers.join(' | '));
console.log('\nFirst 10 rows preview:');
rows.slice(0, 10).forEach((r, i) => {
  console.log('--- Row', i + 1);
  headers.forEach(h => console.log(h + ':', r[h]));
});
