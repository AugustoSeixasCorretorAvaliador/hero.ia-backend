import fs from "fs";
import { randomUUID } from "crypto";

const LICENSES_PATH = "./licenses.json";

function loadLicenses() {
  try {
    if (!fs.existsSync(LICENSES_PATH)) {
      fs.writeFileSync(LICENSES_PATH, "[]", "utf-8");
    }
    const raw = fs.readFileSync(LICENSES_PATH, "utf-8");
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("Erro ao carregar licenses.json:", err.message);
    return [];
  }
}

function saveLicenses(list) {
  try {
    fs.writeFileSync(LICENSES_PATH, JSON.stringify(list, null, 2), "utf-8");
  } catch (err) {
    console.error("Erro ao salvar licenses.json:", err.message);
    process.exit(1);
  }
}

function generateLicense() {
  const userKey = randomUUID();
  const now = new Date().toISOString();

  const current = loadLicenses();
  current.push({
    userKey,
    status: "active",
    createdAt: now,
    lastUsed: null,
    notes: ""
  });

  saveLicenses(current);
  console.log("Novo userKey gerado:", userKey);
}

generateLicense();
