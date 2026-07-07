import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const apply = process.argv.includes("--apply") || process.env.PURGE_APPLY === "1";
const roots = String(process.env.SCAN_ROOTS || process.env.DATA_DIR || "data")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean)
  .map((item) => path.resolve(item));
const receiptPath = process.env.PURGE_RECEIPT ? path.resolve(process.env.PURGE_RECEIPT) : null;
const forbiddenExtensions = new Set([".hwp", ".hwpx", ".zip"]);
const forbiddenDirs = new Set(["uploads", "saves", "text-cache"]);
const now = new Date().toISOString();
const deletedFiles = [];
const deletedDirs = [];
const errors = [];

async function sha256File(file) {
  const data = await fs.readFile(file);
  return crypto.createHash("sha256").update(data).digest("hex");
}

async function collectFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return out;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await collectFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

async function recordAndDeleteFile(file, reason) {
  try {
    const stat = await fs.stat(file);
    const digest = await sha256File(file);
    deletedFiles.push({
      reason,
      extension: path.extname(file).toLowerCase() || null,
      bytes: stat.size,
      sha256: digest
    });
    if (apply) {
      await fs.unlink(file);
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      errors.push({ type: "file", reason, message: String(error.message || error) });
    }
  }
}

async function purgeDir(dir) {
  const files = await collectFiles(dir);
  for (const file of files) {
    await recordAndDeleteFile(file, "forbidden-directory");
  }
  deletedDirs.push({ name: path.basename(dir), fileCount: files.length });
  if (apply) {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function walk(root) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (forbiddenDirs.has(entry.name)) {
        await purgeDir(full);
      } else {
        await walk(full);
      }
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (forbiddenExtensions.has(ext)) {
      await recordAndDeleteFile(full, "forbidden-extension");
    }
  }
}

for (const root of roots) {
  await walk(root);
}

const totalBytes = deletedFiles.reduce((sum, item) => sum + item.bytes, 0);
const receipt = {
  ok: errors.length === 0,
  applied: apply,
  scannedRoots: roots,
  fileCount: deletedFiles.length,
  directoryCount: deletedDirs.length,
  totalBytes,
  files: deletedFiles,
  directories: deletedDirs,
  errors,
  finishedAt: now
};

if (receiptPath) {
  await fs.mkdir(path.dirname(receiptPath), { recursive: true });
  await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

console.log(JSON.stringify({
  ok: receipt.ok,
  applied: receipt.applied,
  scannedRoots: receipt.scannedRoots,
  fileCount: receipt.fileCount,
  directoryCount: receipt.directoryCount,
  totalBytes: receipt.totalBytes,
  receiptPath
}, null, 2));

if (!receipt.ok) {
  process.exit(1);
}
