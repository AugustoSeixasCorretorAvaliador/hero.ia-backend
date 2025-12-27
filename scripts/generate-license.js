import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, "..");
const LICENSES_PATH = path.join(ROOT, "licenses.json");
const DIST_ROOT = path.join(ROOT, "dist", "licenses");

const SOURCES = [
  { src: path.resolve(ROOT, "..", "heroia_webpwa", "Index.html"), dest: "Index.html" },
  { src: path.resolve(ROOT, "..", "whatsapp-ai-draft", "content.js"), dest: "content.js" }
];

function loadLicenses() {
  try {
    if (!fs.existsSync(LICENSES_PATH)) {
      fs.mkdirSync(path.dirname(LICENSES_PATH), { recursive: true });
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

function ensureSourcesExist() {
  const missing = SOURCES.filter(item => !fs.existsSync(item.src));
  if (missing.length) {
    const files = missing.map(item => item.src).join("\n- ");
    console.error("Arquivos de origem não encontrados:\n- " + files);
    process.exit(1);
  }
}

function ensureOutputDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyWithUserKey(srcPath, destPath, userKey) {
  const raw = fs.readFileSync(srcPath, "utf-8");
  const replaced = raw.replace(/const\s+USER_KEY\s*=\s*["'][^"']*["']/g, `const USER_KEY = "${userKey}"`);
  fs.writeFileSync(destPath, replaced, "utf-8");
}

function generateLicense() {
  ensureSourcesExist();

  const userKey = randomUUID();
  const now = new Date().toISOString();

  const licenses = loadLicenses();
  licenses.push({
    userKey,
    status: "active",
    createdAt: now,
    lastUsed: null,
    notes: ""
  });
  saveLicenses(licenses);

  const outDir = path.join(DIST_ROOT, userKey);
  ensureOutputDir(outDir);

  SOURCES.forEach(({ src, dest }) => {
    const targetPath = path.join(outDir, dest);
    copyWithUserKey(src, targetPath, userKey);
  });

  console.log("USER_KEY gerada:", userKey);
  console.log("Arquivos licenciados em:", outDir);
}

generateLicense();
