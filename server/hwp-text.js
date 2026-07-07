import fs from "node:fs/promises";
import { parse as parseHwp } from "hwp.js";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";

const HWP_HEADER = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const HWPX_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const HWPX_MAX_ARCHIVE_BYTES = positiveIntegerEnv("HWPX_MAX_ARCHIVE_BYTES", positiveIntegerEnv("MAX_DOCUMENT_BYTES", 80 * 1024 * 1024));
const HWPX_MAX_ENTRIES = positiveIntegerEnv("HWPX_MAX_ENTRIES", 500);
const HWPX_MAX_XML_BYTES = positiveIntegerEnv("HWPX_MAX_XML_BYTES", 12 * 1024 * 1024);
const HWPX_MAX_TOTAL_UNCOMPRESSED_BYTES = positiveIntegerEnv("HWPX_MAX_TOTAL_UNCOMPRESSED_BYTES", 160 * 1024 * 1024);
const HWPX_PARSE_TIMEOUT_MS = positiveIntegerEnv("HWPX_PARSE_TIMEOUT_MS", 5000);
const HWPX_TEXT_XML_PATTERN = /^Contents\/(?:section\d+|header|footer|footnote|endnote|bodytext\/section\d+)[^/]*\.xml$/i;
const HWPX_PRIMARY_TEXT_TAGS = new Set(["p", "fnContent", "enContent", "headerContent", "footerContent"]);
const HWPX_FALLBACK_TEXT_TAGS = new Set(["t"]);
const HWPX_XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  htmlEntities: true,
  allowBooleanAttributes: true
});

function positiveIntegerEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function detectFormatByHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer.slice(0, 8).equals(HWP_HEADER)) return "hwp";
  if (buffer.slice(0, 4).equals(HWPX_HEADER)) return "hwpx";
  return null;
}

function extractFromHwp(buffer) {
  const doc = parseHwp(buffer, { type: "buffer" });
  const paragraphs = [];
  for (const section of doc.sections || []) {
    for (const para of section.content || []) {
      const chars = [];
      for (const c of para.content || []) {
        if (c.type !== 0) continue;
        if (typeof c.value === "string") chars.push(c.value);
        else if (typeof c.value === "number") {
          if (c.value === 13 || c.value === 10) continue;
          if (c.value >= 0x20 || c.value === 0x09) chars.push(String.fromCodePoint(c.value));
        }
      }
      const line = chars.join("").trim();
      if (line) paragraphs.push(line);
    }
  }
  const meta = {
    sectionCount: doc.sections?.length || 0,
    paragraphCount: paragraphs.length,
    engine: "hwp.js"
  };
  return { paragraphs, text: paragraphs.join("\n"), meta };
}

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const cp = parseInt(hex, 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : "";
    })
    .replace(/&#(\d+);/g, (_, code) => {
      const cp = Number(code);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : "";
    })
    .replace(/&amp;/g, "&");
}

function normalizeExtractedText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function localXmlName(name) {
  return String(name || "").split(":").pop();
}

function newHwpxParseBudget() {
  return { startedAt: Date.now(), timeoutMs: HWPX_PARSE_TIMEOUT_MS };
}

function guardHwpxParseBudget(budget, label = "step") {
  if (!budget) return;
  if (Date.now() - budget.startedAt > budget.timeoutMs) {
    throw new Error(`hwpx_parse_timeout:${label}`);
  }
}

function zipEntryUncompressedSize(entry) {
  if (!entry || entry.dir) return 0;
  const size = entry._data?.uncompressedSize;
  if (!Number.isFinite(size) || size < 0) {
    throw new Error(`hwpx_entry_size_unavailable:${entry.name || "unknown"}`);
  }
  return size;
}

function validateHwpxZipEntries(zip) {
  const entries = Object.values(zip.files || {});
  if (entries.length > HWPX_MAX_ENTRIES) {
    throw new Error(`hwpx_too_many_entries:${entries.length}/${HWPX_MAX_ENTRIES}`);
  }
  let totalUncompressedBytes = 0;
  const textXmlFiles = [];
  for (const entry of entries) {
    if (!entry || entry.dir) continue;
    const normalizedName = String(entry.name || "").replace(/\\/g, "/");
    if (normalizedName.startsWith("/") || normalizedName.includes("../") || normalizedName.includes("/../")) {
      throw new Error(`hwpx_unsafe_entry_path:${normalizedName}`);
    }
    const size = zipEntryUncompressedSize(entry);
    totalUncompressedBytes += size;
    if (totalUncompressedBytes > HWPX_MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error(`hwpx_uncompressed_bytes_limit:${totalUncompressedBytes}/${HWPX_MAX_TOTAL_UNCOMPRESSED_BYTES}`);
    }
    if (/\.xml$/i.test(normalizedName) && size > HWPX_MAX_XML_BYTES) {
      throw new Error(`hwpx_xml_bytes_limit:${normalizedName}:${size}/${HWPX_MAX_XML_BYTES}`);
    }
    if (HWPX_TEXT_XML_PATTERN.test(normalizedName)) {
      textXmlFiles.push(normalizedName);
    }
  }
  textXmlFiles.sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
  if (textXmlFiles.length === 0) {
    throw new Error("hwpx_missing_text_xml");
  }
  return { textXmlFiles, totalUncompressedBytes, entryCount: entries.length };
}

async function loadBoundedHwpxZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > HWPX_MAX_ARCHIVE_BYTES) {
    throw new Error(`hwpx_archive_bytes_limit:${buffer?.length || 0}/${HWPX_MAX_ARCHIVE_BYTES}`);
  }
  const zip = await JSZip.loadAsync(buffer);
  const manifest = validateHwpxZipEntries(zip);
  return { zip, manifest };
}

async function readBoundedHwpxXml(zip, name, budget) {
  guardHwpxParseBudget(budget, `read:${name}`);
  const entry = zip.files[name];
  if (!entry || entry.dir) throw new Error(`hwpx_missing_xml:${name}`);
  const size = zipEntryUncompressedSize(entry);
  if (size > HWPX_MAX_XML_BYTES) {
    throw new Error(`hwpx_xml_bytes_limit:${name}:${size}/${HWPX_MAX_XML_BYTES}`);
  }
  const xml = await entry.async("string");
  if (Buffer.byteLength(xml, "utf8") > HWPX_MAX_XML_BYTES) {
    throw new Error(`hwpx_xml_decoded_bytes_limit:${name}`);
  }
  guardHwpxParseBudget(budget, `read_done:${name}`);
  return xml;
}

function collectXmlText(node, budget) {
  guardHwpxParseBudget(budget, "collect_text");
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((item) => collectXmlText(item, budget)).join("");
  }
  if (typeof node !== "object") return "";
  let out = "";
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_")) continue;
    out += collectXmlText(value, budget);
  }
  return out;
}

function walkParsedHwpxXml(node, paragraphs, fallbackTexts, budget) {
  guardHwpxParseBudget(budget, "walk_xml");
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const item of node) walkParsedHwpxXml(item, paragraphs, fallbackTexts, budget);
    return;
  }
  if (typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_")) continue;
    const tag = localXmlName(key);
    if (HWPX_PRIMARY_TEXT_TAGS.has(tag)) {
      const text = normalizeExtractedText(collectXmlText(value, budget));
      if (text) paragraphs.push(text);
      continue;
    }
    if (HWPX_FALLBACK_TEXT_TAGS.has(tag)) {
      const text = normalizeExtractedText(collectXmlText(value, budget));
      if (text) fallbackTexts.push(text);
      continue;
    }
    walkParsedHwpxXml(value, paragraphs, fallbackTexts, budget);
  }
}

function walkHwpxXml(xml, paragraphs, fallbackTexts, budget) {
  guardHwpxParseBudget(budget, "parse_xml");
  let parsed;
  try {
    parsed = HWPX_XML_PARSER.parse(xml);
  } catch (err) {
    throw new Error(`hwpx_xml_parse_failed:${err?.message || "unknown"}`);
  }
  walkParsedHwpxXml(parsed, paragraphs, fallbackTexts, budget);
}

async function extractFromHwpx(buffer) {
  const budget = newHwpxParseBudget();
  const { zip, manifest } = await loadBoundedHwpxZip(buffer);
  const sectionFiles = manifest.textXmlFiles;
  const paragraphs = [];
  const fallbackTexts = [];
  for (const name of sectionFiles) {
    const xml = await readBoundedHwpxXml(zip, name, budget);
    walkHwpxXml(xml, paragraphs, fallbackTexts, budget);
  }
  if (paragraphs.length === 0) {
    paragraphs.push(...fallbackTexts);
  }
  return {
    paragraphs,
    text: paragraphs.join("\n"),
    meta: {
      sectionCount: sectionFiles.length,
      paragraphCount: paragraphs.length,
      engine: "jszip+fast-xml-parser",
      hwpxEntryCount: manifest.entryCount,
      hwpxTotalUncompressedBytes: manifest.totalUncompressedBytes
    }
  };
}

export async function extractDocumentText(filePath, format) {
  const buffer = await fs.readFile(filePath);
  const detected = detectFormatByHeader(buffer);
  const fmt = (format || detected || "").toLowerCase();
  if (fmt === "hwp" || (!fmt && detected === "hwp")) return extractFromHwp(buffer);
  if (fmt === "hwpx" || detected === "hwpx") return extractFromHwpx(buffer);
  throw new Error(`unsupported_format:${fmt || "unknown"}`);
}

export function renderTextAsHtml(paragraphs, options = {}) {
  const title = String(options.title || "").slice(0, 200);
  const escape = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const body = (paragraphs || [])
    .map((p) => `  <p>${escape(p) || "&nbsp;"}</p>`)
    .join("\n");
  return `<!doctype html>
<html lang="ko"><head><meta charset="UTF-8"/>
<title>${escape(title || "오픈소스 뷰어")}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: "Pretendard", "Noto Sans KR", "Apple SD Gothic Neo", sans-serif; max-width: 780px; margin: 32px auto; padding: 0 24px; line-height: 1.7; color: #1f2937; }
  h1.oss-title { font-size: 18px; color: #475569; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; margin: 0 0 24px; }
  p { margin: 0 0 12px; white-space: pre-wrap; word-break: break-word; }
  .oss-empty { color: #94a3b8; font-style: italic; }
</style></head>
<body>
<h1 class="oss-title">오픈소스 뷰어 (hwp.js) — ${escape(title || "문서")}</h1>
${body || '  <p class="oss-empty">추출된 본문이 없습니다.</p>'}
</body></html>`;
}

function escapeXmlText(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function rewriteHwpxParagraphs(buffer, beforeParagraphs, newParagraphs) {
  if (!Array.isArray(beforeParagraphs) || !Array.isArray(newParagraphs)) {
    throw new Error("paragraphs_must_be_arrays");
  }
  if (beforeParagraphs.length !== newParagraphs.length) {
    throw new Error("paragraph_count_mismatch");
  }
  const budget = newHwpxParseBudget();
  const { zip, manifest } = await loadBoundedHwpxZip(buffer);
  const sectionFiles = manifest.textXmlFiles;
  let cursor = 0;
  const tagOrder = ["hp:p", "hp:tc", "hp:fnContent", "hp:enContent", "hp:headerContent", "hp:footerContent"];
  for (const fileName of sectionFiles) {
    const xml = await readBoundedHwpxXml(zip, fileName, budget);
    let nextXml = xml;
    for (const tagName of tagOrder) {
      guardHwpxParseBudget(budget, `rewrite:${fileName}:${tagName}`);
      const open = new RegExp(`<${tagName}(?:\\s[^>]*)?>`, "g");
      const closeStr = `</${tagName}>`;
      let rebuilt = "";
      let lastEnd = 0;
      let match;
      while ((match = open.exec(nextXml)) !== null) {
        const start = match.index + match[0].length;
        const end = nextXml.indexOf(closeStr, start);
        if (end < 0) break;
        const inner = nextXml.slice(start, end);
        const innerText = inner.replace(/<[^>]*>/g, "");
        const decoded = innerText
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
          .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
          .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
          .replace(/&amp;/g, "&")
          .replace(/\s+/g, " ")
          .trim();
        if (!decoded) {
          rebuilt += nextXml.slice(lastEnd, end + closeStr.length);
          lastEnd = end + closeStr.length;
          open.lastIndex = end + closeStr.length;
          continue;
        }
        if (cursor >= beforeParagraphs.length) {
          rebuilt += nextXml.slice(lastEnd, end + closeStr.length);
          lastEnd = end + closeStr.length;
          open.lastIndex = end + closeStr.length;
          continue;
        }
        const expected = beforeParagraphs[cursor];
        const replacement = newParagraphs[cursor];
        cursor += 1;
        if (decoded !== expected) {
          rebuilt += nextXml.slice(lastEnd, end + closeStr.length);
          lastEnd = end + closeStr.length;
          open.lastIndex = end + closeStr.length;
          continue;
        }
        if (replacement === expected) {
          rebuilt += nextXml.slice(lastEnd, end + closeStr.length);
          lastEnd = end + closeStr.length;
          open.lastIndex = end + closeStr.length;
          continue;
        }
        rebuilt += nextXml.slice(lastEnd, match.index + match[0].length);
        rebuilt += `<hp:run charPrIDRef="0"><hp:t>${escapeXmlText(replacement)}</hp:t></hp:run>`;
        rebuilt += nextXml.slice(end, end + closeStr.length);
        lastEnd = end + closeStr.length;
        open.lastIndex = end + closeStr.length;
      }
      rebuilt += nextXml.slice(lastEnd);
      nextXml = rebuilt;
    }
    zip.file(fileName, nextXml);
  }
  if (cursor !== beforeParagraphs.length) {
    throw new Error(`paragraph_walk_mismatch:${cursor}/${beforeParagraphs.length}`);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

export function buildSnippet(text, query, radius = 60) {
  if (!text || !query) return "";
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx < 0) return "";
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + query.length + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return prefix + text.slice(start, end).replace(/\s+/g, " ").trim() + suffix;
}
