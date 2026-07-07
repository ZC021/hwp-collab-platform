import fs from "node:fs/promises";
import path from "node:path";

const roots = String(process.env.SCAN_ROOTS || process.env.DATA_DIR || "data")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean)
  .map((item) => path.resolve(item));

const forbiddenExtensions = new Set([".hwp", ".hwpx", ".zip"]);
const forbiddenNames = new Set(["uploads", "saves", "text-cache"]);
const base64DocumentPattern = /[A-Za-z0-9+/=_-]{200,}/;
const findings = [];

async function walk(target) {
  let entries;
  try {
    entries = await fs.readdir(target, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      if (forbiddenNames.has(entry.name)) {
        findings.push({ type: "forbidden-directory", path: full });
      }
      await walk(full);
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (forbiddenExtensions.has(ext)) {
      findings.push({ type: "forbidden-file-extension", path: full });
      continue;
    }
    if (entry.name.endsWith(".json") || entry.name.endsWith(".ndjson") || entry.name.endsWith(".txt")) {
      const text = await fs.readFile(full, "utf8").catch(() => "");
      if (base64DocumentPattern.test(text) && /(hwp|hwpx|document|dataBase64)/i.test(text)) {
        findings.push({ type: "possible-document-payload", path: full });
      }
    }
  }
}

for (const root of roots) {
  await walk(root);
}

if (findings.length) {
  console.error(JSON.stringify({ ok: false, roots, findings }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, roots, findings: [] }, null, 2));
