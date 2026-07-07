const KNOWN_PROXY_PREFIXES = ["/hwp"];

export function appBasePath() {
  if (typeof window === "undefined") return "";
  const pathname = window.location?.pathname || "/";
  for (const prefix of KNOWN_PROXY_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return prefix;
    }
  }
  return "";
}

export function withAppBasePath(path) {
  const value = String(path || "");
  if (!value.startsWith("/")) return value;
  return `${appBasePath()}${value}`;
}

export function appWebSocketUrl(path) {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}${withAppBasePath(path)}`;
}
