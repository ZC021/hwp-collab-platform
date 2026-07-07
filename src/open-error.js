// Pure mapping from raw RHWP/wasm loader errors (CFB/parse jargon) to a short,
// actionable Korean sentence shown to the user. Extracted from App.jsx so it can
// be unit-tested in isolation (the first strangler-fig step toward a tested,
// modular codebase). The raw message is preserved to the console for debugging.
//
// Glossary: "open error" = a failure surfaced while loading a local .hwp/.hwpx
// document into the editor. See docs/GLOSSARY.md.

export function friendlyOpenError(err) {
  const raw = String(err?.message || err || "").trim();
  if (raw && typeof console !== "undefined") {
    console.error("[open] 파일 열기 실패 (raw):", raw);
  }
  const text = raw.toLowerCase();
  if (/암호|복호화|복호|aes|encrypt|decrypt|password/.test(raw + text)) {
    return "암호가 설정된 문서입니다. 한컴오피스에서 암호를 해제하고 저장한 뒤 다시 열어 주세요.";
  }
  if (/지원하지 않|unsupported|hwpml|버전|version|3\.0|알 수 없는 파일 형식/.test(raw + text)) {
    return "지원하지 않는 형식입니다. 한컴오피스에서 HWP 5.0 또는 HWPX로 다시 저장한 뒤 다시 열어 주세요.";
  }
  if (/시그니처|signature|매직|magic|너무 작|too small|cfb|손상|corrupt|crc/.test(raw + text)) {
    return "파일이 손상되었거나 올바른 HWP/HWPX 문서가 아닙니다. 원본 파일을 다시 받아 열어 주세요.";
  }
  if (!raw) return "이 파일을 열 수 없습니다. 손상되었거나 지원하지 않는 형식일 수 있습니다.";
  return `이 파일을 열 수 없습니다. 손상되었거나 지원하지 않는 형식일 수 있습니다. (${raw})`;
}
