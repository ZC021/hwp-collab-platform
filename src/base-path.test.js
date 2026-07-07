import { describe, it, expect, afterEach } from "vitest";
import { appBasePath, withAppBasePath, appWebSocketUrl } from "./base-path.js";

const realLocation = window.location;

function setLocation(loc) {
  Object.defineProperty(window, "location", { configurable: true, value: loc });
}

afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: realLocation });
});

describe("appBasePath", () => {
  it("returns '' at the root", () => {
    setLocation({ pathname: "/" });
    expect(appBasePath()).toBe("");
  });

  it("detects the /hwp reverse-proxy prefix", () => {
    setLocation({ pathname: "/hwp" });
    expect(appBasePath()).toBe("/hwp");
    setLocation({ pathname: "/hwp/editor" });
    expect(appBasePath()).toBe("/hwp");
  });

  it("does not match a lookalike prefix", () => {
    setLocation({ pathname: "/hwpother" });
    expect(appBasePath()).toBe("");
  });
});

describe("withAppBasePath", () => {
  it("prepends the base path to absolute paths only", () => {
    setLocation({ pathname: "/hwp/x" });
    expect(withAppBasePath("/api/config")).toBe("/hwp/api/config");
  });

  it("leaves relative paths untouched", () => {
    setLocation({ pathname: "/hwp/x" });
    expect(withAppBasePath("templates/blank.hwp")).toBe("templates/blank.hwp");
  });

  it("is a no-op at the root", () => {
    setLocation({ pathname: "/" });
    expect(withAppBasePath("/ws")).toBe("/ws");
  });
});

describe("appWebSocketUrl", () => {
  it("uses ws:// for http and includes host + base path", () => {
    setLocation({ pathname: "/hwp/x", host: "127.0.0.1:8170", protocol: "http:" });
    expect(appWebSocketUrl("/ws")).toBe("ws://127.0.0.1:8170/hwp/ws");
  });

  it("uses wss:// for https", () => {
    setLocation({ pathname: "/", host: "example.com", protocol: "https:" });
    expect(appWebSocketUrl("/relay")).toBe("wss://example.com/relay");
  });
});
