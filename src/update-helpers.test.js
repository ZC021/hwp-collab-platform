import { describe, it, expect } from "vitest";
import helpers from "../desktop/update-helpers.cjs";

const { sanitizeReleaseNotes, computeBackoffDelay } = helpers;

describe("sanitizeReleaseNotes", () => {
  it("returns '' for null/undefined/empty", () => {
    expect(sanitizeReleaseNotes(null)).toBe("");
    expect(sanitizeReleaseNotes(undefined)).toBe("");
    expect(sanitizeReleaseNotes("")).toBe("");
  });
  it("coalesces an array of {version, note}", () => {
    const out = sanitizeReleaseNotes([
      { version: "0.1.19", note: "첫 줄" },
      { version: "0.1.18", note: "둘째 줄" }
    ]);
    expect(out).toContain("첫 줄");
    expect(out).toContain("둘째 줄");
  });
  it("reads {note} / {body} objects", () => {
    expect(sanitizeReleaseNotes({ note: "노트" })).toBe("노트");
    expect(sanitizeReleaseNotes({ body: "바디" })).toBe("바디");
  });
  it("strips HTML tags + decodes entities and is angle-bracket-free", () => {
    const out = sanitizeReleaseNotes("<b>bold</b> &amp; <i>x</i>&lt;y&gt;");
    expect(out).toContain("bold");
    expect(out).toContain("&");
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
  });
  it("neutralizes double-encoded HTML — no real angle brackets survive", () => {
    const out = sanitizeReleaseNotes("&amp;lt;script&amp;gt;evil&amp;lt;/script&amp;gt;");
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
  });
  it("removes lone/unbalanced angle brackets", () => {
    expect(sanitizeReleaseNotes("a < b > c")).not.toMatch(/[<>]/);
  });
  it("caps length at 600 chars", () => {
    const long = "a".repeat(2000);
    expect(sanitizeReleaseNotes(long).length).toBe(600);
  });
  it("collapses whitespace", () => {
    expect(sanitizeReleaseNotes("a   \n\t  b")).toBe("a b");
  });
});

describe("computeBackoffDelay", () => {
  it("produces 1/2/4/8/16-min sequence", () => {
    const m = 60 * 1000;
    expect(computeBackoffDelay(0)).toBe(1 * m);
    expect(computeBackoffDelay(1)).toBe(2 * m);
    expect(computeBackoffDelay(2)).toBe(4 * m);
    expect(computeBackoffDelay(3)).toBe(8 * m);
    expect(computeBackoffDelay(4)).toBe(16 * m);
  });
  it("caps at 30 min", () => {
    expect(computeBackoffDelay(5)).toBe(30 * 60 * 1000);
    expect(computeBackoffDelay(50)).toBe(30 * 60 * 1000);
  });
  it("clamps invalid retryCount to 0 → base", () => {
    expect(computeBackoffDelay(-3)).toBe(60 * 1000);
    expect(computeBackoffDelay(NaN)).toBe(60 * 1000);
  });
  it("honors custom base/max", () => {
    expect(computeBackoffDelay(2, 1000, 10000)).toBe(4000);
    expect(computeBackoffDelay(10, 1000, 10000)).toBe(10000);
  });
});
