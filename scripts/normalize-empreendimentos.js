import fs from "fs";
import path from "path";

const filePath = path.join(process.cwd(), "data", "empreendimentos.json");
const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));

function norm(s = "") {
  return s
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function normTipologia(t = "") {
  const x = norm(t);
  if (x.includes("studio")) return "studio";
  if (x.match(/\b1\b/) && x.includes("quarto")) return "1q";
  if (x.match(/\b2\b/) && x.includes("quarto")) return "2q";
  if (x.match(/\b3\b/) && x.includes("quarto")) return "3q";
  if (x.match(/\b4\b/) && x.includes("quarto")) return "4q";
  if (x === "1q" || x === "2q" || x === "3q" || x === "4q") return x;
  return x;
}

const allowed = new Set(["studio", "1q", "2q", "3q", "4q"]);

let changed = 0;
const samples = [];

const out = raw.map((e) => {
  const before = { ...e };

  // normalize tipologia
  const tipologias = Array.from(
    new Set(
      (e.tipologia || []).map((t) => {
        const n = normTipologia(t);
        return allowed.has(n) ? n : norm(t);
      })
    )
  );

  // normalize descricao 'Entrega: —' -> 'Entrega: a confirmar'
  const descricao = (e.descricao || "").replace(/Entrega:\s*[—-]+/g, "Entrega: a confirmar");

  const updated = { ...e, tipologia: tipologias, descricao };

  const changedNow = JSON.stringify(before) !== JSON.stringify(updated);
  if (changedNow) {
    changed++;
    if (samples.length < 10) samples.push({ nome: e.nome, before: before.tipologia, after: tipologias });
  }

  return updated;
});

fs.writeFileSync(filePath, JSON.stringify(out, null, 2), "utf8");

console.log(`Normalized ${raw.length} records, updated ${changed} entries.`);
if (samples.length) console.log("Examples:", samples);
console.log("File written:", filePath);
