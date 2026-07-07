import { describe, it, expect, vi, beforeEach } from "vitest";
import { friendlyOpenError } from "./open-error.js";

describe("friendlyOpenError", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("maps password/encryption errors to an unlock-and-resave hint", () => {
    expect(friendlyOpenError(new Error("암호화된 문서는 지원하지 않습니다"))).toMatch(/암호가 설정된 문서/);
    expect(friendlyOpenError("AES 키 추출 실패")).toMatch(/암호가 설정된 문서/);
    expect(friendlyOpenError("decryption failed")).toMatch(/암호가 설정된 문서/);
  });

  it("maps unsupported-format/version errors to a resave-as-5.0/HWPX hint", () => {
    expect(friendlyOpenError("지원하지 않는 HWP 버전: 3.0")).toMatch(/HWP 5\.0 또는 HWPX로 다시 저장/);
    expect(friendlyOpenError("UNSUPPORTED_HWPML")).toMatch(/HWP 5\.0 또는 HWPX로 다시 저장/);
    expect(friendlyOpenError("알 수 없는 파일 형식")).toMatch(/HWP 5\.0 또는 HWPX로 다시 저장/);
  });

  it("maps signature/magic/corruption errors to a corrupt-file message", () => {
    expect(friendlyOpenError("잘못된 파일 시그니처입니다.")).toMatch(/손상되었거나 올바른 HWP\/HWPX 문서가 아닙니다/);
    expect(friendlyOpenError("CFB 매직 넘버 불일치")).toMatch(/손상되었거나 올바른 HWP\/HWPX 문서가 아닙니다/);
    expect(friendlyOpenError("파일이 너무 작음")).toMatch(/손상되었거나 올바른 HWP\/HWPX 문서가 아닙니다/);
  });

  it("returns a generic actionable message when there is no raw text", () => {
    expect(friendlyOpenError(undefined)).toBe("이 파일을 열 수 없습니다. 손상되었거나 지원하지 않는 형식일 수 있습니다.");
    expect(friendlyOpenError("")).toBe("이 파일을 열 수 없습니다. 손상되었거나 지원하지 않는 형식일 수 있습니다.");
  });

  it("passes through an unknown raw message in parentheses", () => {
    expect(friendlyOpenError("some_unknown_error")).toBe(
      "이 파일을 열 수 없습니다. 손상되었거나 지원하지 않는 형식일 수 있습니다. (some_unknown_error)"
    );
  });

  it("precedence: password match wins over corruption keywords", () => {
    // contains both 암호 and 손상 → password branch is checked first
    expect(friendlyOpenError("암호 오류 및 손상")).toMatch(/암호가 설정된 문서/);
  });

  it("accepts Error objects and bare strings equivalently", () => {
    expect(friendlyOpenError(new Error("signature mismatch"))).toBe(friendlyOpenError("signature mismatch"));
  });
});
