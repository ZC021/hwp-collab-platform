import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import { WebSocketServer } from "ws";
import { extractDocumentText, renderTextAsHtml, buildSnippet, rewriteHwpxParagraphs } from "./hwp-text.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const dataDir = path.resolve(process.env.DATA_DIR || path.join(appRoot, "data"));
const uploadDir = path.join(dataDir, "uploads");
const saveDir = path.join(dataDir, "saves");
const distDir = path.join(appRoot, "dist");
const port = Number(process.env.PORT || 8170);
const maxDocumentBytes = positiveInteger(process.env.MAX_DOCUMENT_BYTES, 80 * 1024 * 1024);
const maxDocumentBase64Chars = Math.ceil(maxDocumentBytes * 4 / 3) + 256;
const shareTtlMs = Number(process.env.SHARE_TTL_DAYS || 30) * 24 * 60 * 60 * 1000;
const relayOnlyMode = !/^(0|false|no)$/i.test(String(process.env.RELAY_ONLY_MODE || "true"));
const sharingEnabled = false;
const relayRoomTtlMs = positiveInteger(process.env.RELAY_ROOM_TTL_HOURS, 24) * 60 * 60 * 1000;
let runtimePort = port;
const buildId = process.env.BUILD_ID || crypto.randomBytes(6).toString("hex");
const isProduction = detectProductionRuntime();
const internalNoLoginMode = detectInternalNoLoginMode();
const app = express();
let activeServer = null;
let activeWss = null;
const rooms = new Map();
const relayPeers = new Map();
const relayLocks = new Map();
const relayTextStates = new Map();
const writeQueues = new Map();
const roomBroadcastTimers = new Map();
const relayBroadcastTimers = new Map();
const docUpdateQueues = new Map();

if (isProduction && !relayOnlyMode) {
  throw new Error("RELAY_ONLY_MODE=false is not allowed in production");
}
const publicOrigins = parsePublicOrigins(
  [process.env.PUBLIC_ORIGINS, process.env.PUBLIC_ORIGIN, process.env.PUBLIC_BASE_URL].filter(Boolean).join(",")
);
const primaryPublicOrigin = process.env.PUBLIC_ORIGIN
  ? normalizeOrigin(process.env.PUBLIC_ORIGIN)
  : publicOrigins[0] || null;
const allowedOrigins = new Set(publicOrigins);

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS || 12) * 60 * 60 * 1000;
const JSON_LIMIT_MB = positiveInteger(process.env.JSON_LIMIT_MB, 5);
const SAVE_EXPORT_JSON_LIMIT_MB = positiveInteger(
  process.env.SAVE_EXPORT_JSON_LIMIT_MB,
  Math.ceil((maxDocumentBase64Chars + 4096) / 1024 / 1024) + 4
);
const STATE_JSON_SPACES = /^(1|true|yes)$/i.test(String(process.env.STATE_JSON_PRETTY || "")) ? 2 : 0;
const WS_DOC_UPDATE_LIMIT_BYTES = positiveInteger(process.env.WS_DOC_UPDATE_LIMIT_BYTES, 2 * 1024 * 1024);
const WS_MSG_RATE_PER_SEC = positiveInteger(process.env.WS_MSG_RATE_PER_SEC, 24);
const WS_MAX_CLIENTS = positiveInteger(process.env.WS_MAX_CLIENTS, 250);
const WS_MAX_ROOM_CLIENTS = positiveInteger(process.env.WS_MAX_ROOM_CLIENTS, 150);
const WS_PRESENCE_BROADCAST_MS = positiveInteger(process.env.WS_PRESENCE_BROADCAST_MS, 100);
const WS_DOC_BROADCAST_MS = positiveInteger(process.env.WS_DOC_BROADCAST_MS, 1000);
const WS_MAX_BUFFERED_BYTES = positiveInteger(process.env.WS_MAX_BUFFERED_BYTES, 4 * 1024 * 1024);
const WS_TEXT_STATE_MAX_CHARS = positiveInteger(process.env.WS_TEXT_STATE_MAX_CHARS, 200000);
const LOCAL_USER_EMAIL = "local-user@localhost";
const LOCAL_USER_DISPLAY_NAME = "로컬 사용자";

const SESSION_COOKIE_NAME = String(process.env.SESSION_COOKIE_NAME || "rhwp_collab_session").trim() || "rhwp_collab_session";
const OIDC_STATE_TTL_MS = positiveInteger(process.env.MS_OIDC_STATE_TTL_MS, 10 * 60 * 1000);
const msOidcConfig = buildMsOidcConfig();
if (isProduction && !internalNoLoginMode && !msOidcConfig.enabled) {
  throw new Error("oidc_required_in_production: configure Microsoft OIDC before starting a production or packaged runtime");
}
const oidcStates = new Map();
let msOidcDiscoveryCache = null;
let msOidcJwksCache = null;

const state = {
  users: [],
  documents: [],
  revisions: [],
  comments: [],
  shares: [],
  grants: [],
  relayRooms: [],
  relayShares: [],
  relayGrants: [],
  sessions: new Map()
};

const files = {
  users: path.join(dataDir, "users.json"),
  documents: path.join(dataDir, "documents.json"),
  revisions: path.join(dataDir, "revisions.json"),
  comments: path.join(dataDir, "comments.json"),
  shares: path.join(dataDir, "shares.json"),
  grants: path.join(dataDir, "grants.json"),
  textCache: path.join(dataDir, "text-cache"),
  relayRooms: path.join(dataDir, "relay-rooms.json"),
  relayShares: path.join(dataDir, "relay-shares.json"),
  relayGrants: path.join(dataDir, "relay-grants.json"),
  relayAudit: path.join(dataDir, "relay-audit.ndjson")
};

const indexes = {
  usersById: new Map(),
  usersByEmail: new Map(),
  documentsById: new Map(),
  grantsByDocumentUser: new Map(),
  revisionsByDocument: new Map(),
  commentsByDocument: new Map(),
  sharesByDocument: new Map(),
  sharesByHash: new Map(),
  relayRoomsById: new Map(),
  relayGrantsByRoomUser: new Map(),
  relaySharesByRoom: new Map(),
  relaySharesByHash: new Map()
};

const allowedExtensions = new Set([".hwp", ".hwpx"]);
const hwpOleHeader = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const zipHeaders = [
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  Buffer.from([0x50, 0x4b, 0x07, 0x08])
];

function now() {
  return new Date().toISOString();
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function detectProductionRuntime() {
  const appEnv = String(process.env.APP_ENV || "").trim().toLowerCase();
  if (["development", "dev", "test", "pilot", "demo"].includes(appEnv)) {
    return false;
  }
  return (
    appEnv === "production" ||
    process.env.ELECTRON_IS_PACKAGED === "true" ||
    (!appEnv && process.env.NODE_ENV === "production")
  );
}

function detectInternalNoLoginMode() {
  const explicit = optionalBoolEnv(firstEnv(process.env.INTERNAL_NO_LOGIN, process.env.HWP_COLLAB_NO_LOGIN));
  return explicit ?? true;
}

function normalizeOrigin(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) {
    return null;
  }
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function normalizeBasePath(value) {
  let raw = String(value || "").trim();
  if (!raw || raw === "/") return "";
  if (!raw.startsWith("/")) raw = `/${raw}`;
  raw = raw.replace(/\/+$/, "");
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]*$/.test(raw) || raw.includes("//")) {
    return "";
  }
  return raw;
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    parsed.search = "";
    parsed.hash = "";
    return `${parsed.origin}${normalizeBasePath(parsed.pathname)}`;
  } catch {
    return null;
  }
}

function boolEnv(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function optionalBoolEnv(value) {
  if (value === undefined || value === null || value === "") return null;
  return boolEnv(value, false);
}

function firstEnv(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function normalizeTenantId(value) {
  const raw = String(value || "organizations").trim();
  return /^[A-Za-z0-9._-]+$/.test(raw) ? raw : "organizations";
}

function normalizeOidcAuthority(value, tenantId) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (raw) {
    try {
      const parsed = new URL(raw);
      return parsed.protocol === "https:" ? raw : null;
    } catch {
      return null;
    }
  }
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/v2.0`;
}

function parseCsvSet(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  );
}

function buildMsOidcConfig() {
  const tenantId = normalizeTenantId(process.env.MS_OIDC_TENANT_ID || process.env.AZURE_TENANT_ID || process.env.OIDC_TENANT_ID);
  const clientId = String(process.env.MS_OIDC_CLIENT_ID || process.env.AZURE_CLIENT_ID || process.env.OIDC_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.MS_OIDC_CLIENT_SECRET || process.env.AZURE_CLIENT_SECRET || process.env.OIDC_CLIENT_SECRET || "").trim();
  const authority = normalizeOidcAuthority(process.env.MS_OIDC_AUTHORITY || process.env.OIDC_AUTHORITY, tenantId);
  const enabledOverride = optionalBoolEnv(firstEnv(process.env.MS_OIDC_ENABLED, process.env.OIDC_ENABLED));
  const allowedDomains = parseCsvSet(process.env.MS_OIDC_ALLOWED_DOMAINS || process.env.OIDC_ALLOWED_DOMAINS);
  const allowAnyDomain = boolEnv(firstEnv(process.env.MS_OIDC_ALLOW_ANY_DOMAIN, process.env.OIDC_ALLOW_ANY_DOMAIN), false);
  const domainGuardRequired = ["common", "organizations", "consumers"].includes(tenantId.toLowerCase());
  const missingAllowedDomain = domainGuardRequired && !allowAnyDomain && allowedDomains.size === 0;
  const hasBasicConfig = Boolean(clientId && authority);
  const configured = hasBasicConfig && !missingAllowedDomain;
  const enabled = configured && (enabledOverride ?? configured);
  const disableDevLoginOverride = optionalBoolEnv(firstEnv(process.env.MS_OIDC_DISABLE_DEV_LOGIN, process.env.OIDC_DISABLE_DEV_LOGIN));
  const allowDevLoginWithOidc = boolEnv(
    firstEnv(process.env.MS_OIDC_ALLOW_DEV_LOGIN_WITH_OIDC, process.env.OIDC_ALLOW_DEV_LOGIN_WITH_OIDC),
    false
  );
  const scopes = String(process.env.MS_OIDC_SCOPES || "openid profile email")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .join(" ");
  const configError = !hasBasicConfig
    ? "missing_client_or_authority"
    : missingAllowedDomain
      ? "missing_allowed_domain_for_common_tenant"
      : null;
  return {
    provider: "microsoft",
    tenantId,
    clientId,
    clientSecret,
    authority,
    discoveryUrl: authority ? `${authority}/.well-known/openid-configuration` : null,
    redirectUri: normalizeBaseUrl(process.env.MS_OIDC_REDIRECT_URI || process.env.OIDC_REDIRECT_URI),
    scopes: scopes.includes("openid") ? scopes : `openid ${scopes}`.trim(),
    allowedDomains,
    allowAnyDomain,
    domainGuardRequired,
    configured,
    enabled,
    configError,
    devLoginEnabled:
      !internalNoLoginMode &&
      !isProduction &&
      (enabled
        ? allowDevLoginWithOidc && disableDevLoginOverride !== true
        : disableDevLoginOverride !== true)
  };
}

function parsePublicOrigins(value) {
  return [
    ...new Set(
      String(value || "")
        .split(",")
        .map(normalizeOrigin)
        .filter(Boolean)
    )
  ];
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function addMs(date, ms) {
  return new Date(date.getTime() + ms).toISOString();
}

function safeEqualString(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function hashShareToken(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

function newShareToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function tokenHashMatches(storedHash, token) {
  if (!storedHash || !token) {
    return false;
  }
  return safeEqualString(storedHash, hashShareToken(token));
}

function isExpired(value) {
  if (!value) {
    return true;
  }
  const time = new Date(value).getTime();
  return !Number.isFinite(time) || time <= Date.now();
}

function isSessionActive(session) {
  return Boolean(session) && !isExpired(session.expiresAt);
}

function isShareActive(share) {
  return Boolean(share?.enabled && share.tokenHash && !isExpired(share.expiresAt));
}

function resolveDataPath(relativePath) {
  const targetPath = path.resolve(dataDir, String(relativePath || ""));
  if (targetPath !== dataDir && !targetPath.startsWith(`${dataDir}${path.sep}`)) {
    return null;
  }
  return targetPath;
}

function isHwpHeader(header) {
  return header.length >= hwpOleHeader.length && header.subarray(0, hwpOleHeader.length).equals(hwpOleHeader);
}

function isHwpxHeader(header) {
  return zipHeaders.some((candidate) => header.length >= candidate.length && header.subarray(0, candidate.length).equals(candidate));
}

function isValidDocumentHeader(header, format) {
  return format === "hwpx" ? isHwpxHeader(header) : isHwpHeader(header);
}

function isValidDocumentBytes(bytes, format) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maxDocumentBytes) {
    return false;
  }
  return isValidDocumentHeader(bytes.subarray(0, 8), format);
}

async function readFileHeader(file, length = 8) {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function decodeBase64(value) {
  const text = String(value || "").trim();
  if (!text || text.length > maxDocumentBase64Chars || !/^[A-Za-z0-9+/=_-]+$/.test(text)) {
    return null;
  }
  return Buffer.from(text, "base64");
}

function decodeBase64Url(value) {
  const text = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = text.padEnd(text.length + ((4 - (text.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64");
}

function encodeBase64Url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function parseJwt(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) {
    throw new Error("invalid_jwt");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  return {
    encodedHeader,
    encodedPayload,
    encodedSignature,
    header: JSON.parse(decodeBase64Url(encodedHeader).toString("utf8")),
    claims: JSON.parse(decodeBase64Url(encodedPayload).toString("utf8")),
    signingInput: `${encodedHeader}.${encodedPayload}`,
    signature: decodeBase64Url(encodedSignature)
  };
}

function decodeBase64Header(value) {
  const text = String(value || "").trim();
  if (!text || text.length > maxDocumentBase64Chars || !/^[A-Za-z0-9+/=_-]+$/.test(text)) {
    return null;
  }
  return Buffer.from(text.slice(0, 16), "base64").subarray(0, 8);
}

async function normalizeStoredShares() {
  let changed = false;
  const migratedAt = now();
  for (const share of state.shares) {
    if (share.token) {
      delete share.token;
      share.tokenHash = null;
      share.tokenPreview = null;
      share.enabled = false;
      share.revokedAt = migratedAt;
      share.revokedReason = "legacy_plaintext_token_rotated";
      changed = true;
    }
    if (share.enabled && (!share.tokenHash || isExpired(share.expiresAt))) {
      share.enabled = false;
      share.revokedAt = migratedAt;
      share.revokedReason = "expired_or_missing_share_expiry";
      changed = true;
    }
  }
  if (changed) {
    await writeJson(files.shares, state.shares);
  }
}

async function ensureDataFiles() {
  await fs.mkdir(dataDir, { recursive: true });
  await readJson(files.users, [
    localUserTemplate()
  ]).then((value) => {
    state.users = value;
  });
  if (relayOnlyMode) {
    state.documents = [];
    state.revisions = [];
    state.comments = [];
    state.shares = [];
    state.grants = [];
    await readJson(files.relayRooms, []).then((value) => {
      state.relayRooms = value.filter(isRelayRoomActive);
    });
    await readJson(files.relayShares, []).then((value) => {
      state.relayShares = value.filter(isRelayShareActive);
    });
    await readJson(files.relayGrants, []).then((value) => {
      state.relayGrants = value;
    });
    await Promise.all([
      writeJson(files.relayRooms, state.relayRooms),
      writeJson(files.relayShares, state.relayShares),
      writeJson(files.relayGrants, state.relayGrants)
    ]);
    rebuildIndexes();
    return;
  }
  await fs.mkdir(uploadDir, { recursive: true });
  await fs.mkdir(saveDir, { recursive: true });
  await readJson(files.documents, [
    {
      id: "doc_demo",
      title: "샘플 HWP 협업 문서",
      status: "draft",
      ownerUserId: "user_demo_1",
      originalFileName: null,
      filePath: null,
      createdAt: now(),
      updatedAt: now()
    }
  ]).then((value) => {
    state.documents = value;
  });
  await readJson(files.revisions, []).then((value) => {
    state.revisions = value;
  });
  await readJson(files.comments, []).then((value) => {
    state.comments = value;
  });
  await readJson(files.shares, []).then((value) => {
    state.shares = value;
  });
  await normalizeStoredShares();
  await readJson(files.grants, []).then((value) => {
    state.grants = value;
  });
  await fs.mkdir(files.textCache, { recursive: true });
  rebuildIndexes();
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    await writeJson(file, fallback);
    return fallback;
  }
}

async function writeJson(file, value) {
  let entry = writeQueues.get(file);
  if (!entry) {
    entry = { latest: value, waiters: [], flushing: false };
    writeQueues.set(file, entry);
  }

  entry.latest = value;
  const promise = new Promise((resolve, reject) => {
    entry.waiters.push({ resolve, reject });
  });

  if (!entry.flushing) {
    entry.flushing = true;
    flushJsonWrites(file, entry);
  }

  return promise;
}

async function flushJsonWrites(file, entry) {
  while (entry.waiters.length) {
    const waiters = entry.waiters.splice(0);
    const value = entry.latest;
    try {
      await writeJsonFile(file, value);
      for (const waiter of waiters) {
        waiter.resolve();
      }
    } catch (error) {
      for (const waiter of waiters) {
        waiter.reject(error);
      }
    }
  }
  entry.flushing = false;
  if (writeQueues.get(file) === entry) {
    writeQueues.delete(file);
  }
}

async function writeJsonFile(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, STATE_JSON_SPACES), "utf8");
  await fs.rename(temp, file);
}

function mapPush(map, key, value, direction = "push") {
  const list = map.get(key);
  if (list) {
    if (direction === "unshift") {
      list.unshift(value);
    } else {
      list.push(value);
    }
  } else {
    map.set(key, [value]);
  }
}

function grantKey(documentId, userId) {
  return `${documentId}\0${userId}`;
}

function relayGrantKey(roomId, userId) {
  return `${roomId}\0${userId}`;
}

function indexUser(user) {
  if (!user) return;
  indexes.usersById.set(user.id, user);
  indexes.usersByEmail.set(String(user.email || "").toLowerCase(), user);
}

function indexDocument(document) {
  if (!document) return;
  indexes.documentsById.set(document.id, document);
}

function indexGrant(grant) {
  if (!grant) return;
  indexes.grantsByDocumentUser.set(grantKey(grant.documentId, grant.userId), grant);
}

function indexRevision(revision, direction = "push") {
  if (!revision) return;
  mapPush(indexes.revisionsByDocument, revision.documentId, revision, direction);
}

function indexComment(comment, direction = "push") {
  if (!comment) return;
  mapPush(indexes.commentsByDocument, comment.documentId, comment, direction);
}

function indexShare(share) {
  if (!share) return;
  indexes.sharesByDocument.set(share.documentId, share);
  if (isShareActive(share)) {
    indexes.sharesByHash.set(share.tokenHash, share);
  }
}

function isRelayRoomActive(room) {
  return Boolean(room?.active !== false && !isExpired(room?.expiresAt));
}

function isRelayShareActive(share) {
  return Boolean(share?.enabled && share.tokenHash && !isExpired(share.expiresAt));
}

function indexRelayRoom(room) {
  if (!room) return;
  indexes.relayRoomsById.set(room.id, room);
}

function indexRelayGrant(grant) {
  if (!grant) return;
  indexes.relayGrantsByRoomUser.set(relayGrantKey(grant.roomId, grant.userId), grant);
}

function indexRelayShare(share) {
  if (!share) return;
  indexes.relaySharesByRoom.set(share.roomId, share);
  if (isRelayShareActive(share)) {
    indexes.relaySharesByHash.set(share.tokenHash, share);
  }
}

function rebuildIndexes() {
  for (const index of Object.values(indexes)) {
    index.clear();
  }
  for (const user of state.users) indexUser(user);
  for (const document of state.documents) indexDocument(document);
  for (const grant of state.grants) indexGrant(grant);
  for (const revision of state.revisions) indexRevision(revision);
  for (const comment of state.comments) indexComment(comment);
  for (const share of state.shares) indexShare(share);
  for (const room of state.relayRooms) indexRelayRoom(room);
  for (const grant of state.relayGrants) indexRelayGrant(grant);
  for (const share of state.relayShares) indexRelayShare(share);
}

function getUserById(userId) {
  return indexes.usersById.get(userId) || null;
}

function getDocumentById(documentId) {
  return indexes.documentsById.get(documentId) || null;
}

function getDocumentRevisions(documentId) {
  return indexes.revisionsByDocument.get(documentId) || [];
}

function getDocumentComments(documentId) {
  return indexes.commentsByDocument.get(documentId) || [];
}

function getDocumentShare(documentId) {
  return indexes.sharesByDocument.get(documentId) || null;
}

function getRelayRoomById(roomId) {
  return indexes.relayRoomsById.get(roomId) || null;
}

function getRelayRoomShare(roomId) {
  return indexes.relaySharesByRoom.get(roomId) || null;
}

function getRelayRoomPermission(user, room) {
  if (!user || !room || !isRelayRoomActive(room)) {
    return null;
  }
  if (room.ownerUserId === user.id) {
    return "owner";
  }
  const grant = indexes.relayGrantsByRoomUser.get(relayGrantKey(room.id, user.id));
  return grant?.permission || null;
}

function canOpenRelayRoom(user, room) {
  return Boolean(getRelayRoomPermission(user, room));
}

function canEditRelayRoom(user, room) {
  const permission = getRelayRoomPermission(user, room);
  return permission === "owner" || permission === "edit";
}

function canManageRelayRoom(user, room) {
  return getRelayRoomPermission(user, room) === "owner";
}

function nextRevisionNo(documentId) {
  return getDocumentRevisions(documentId).length + 1;
}

function publicUser(user) {
  if (!user) {
    return null;
  }
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    department: user.department,
    color: user.color,
    authProvider: user.authProvider
  };
}

function localUserTemplate() {
  return {
    id: "user_local",
    email: LOCAL_USER_EMAIL,
    displayName: localDisplayName(),
    department: "로컬",
    color: "#2563eb",
    authProvider: "internal-no-login"
  };
}

function localDisplayName() {
  const raw = String(process.env.LOCAL_USER_DISPLAY_NAME || process.env.INTERNAL_USER_DISPLAY_NAME || LOCAL_USER_DISPLAY_NAME).trim();
  return raw.slice(0, 80) || LOCAL_USER_DISPLAY_NAME;
}

function internalDisplayNameFromRequest(_req) {
  return localDisplayName();
}

function internalEmailFromRequest(_req) {
  return LOCAL_USER_EMAIL;
}

async function createInternalUser(req) {
  const email = internalEmailFromRequest(req);
  const displayName = internalDisplayNameFromRequest(req);
  let user = indexes.usersByEmail.get(email);
  if (!user) {
    user = {
      id: id("user"),
      email,
      displayName,
      department: "로컬",
      color: pickColor(state.users.length),
      authProvider: "internal-no-login",
      createdAt: now()
    };
    state.users.push(user);
    indexUser(user);
    await writeJson(files.users, state.users);
  } else if (user.authProvider === "internal-no-login") {
    user.displayName = displayName;
    user.department = "로컬";
    user.lastLoginAt = now();
    await writeJson(files.users, state.users);
  }
  return user;
}

async function ensureInternalSession(req, res) {
  const current = resolveRequestSession(req);
  const currentUser = current.session ? getUserById(current.session.userId) : null;
  if (current.session && currentUser) {
    return { token: current.token, session: current.session, user: currentUser };
  }
  const user = await createInternalUser(req);
  const token = makeToken(user.id);
  setSessionCookie(req, res, token);
  return { token, session: resolveSession(token), user };
}

function makeToken(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const ts = now();
  state.sessions.set(token, {
    token,
    userId,
    createdAt: ts,
    lastSeenAt: ts,
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return token;
}

function sweepSessions() {
  const cutoff = Date.now();
  for (const [token, entry] of state.sessions) {
    if (entry.expiresAt <= cutoff) {
      state.sessions.delete(token);
    }
  }
}

function resolveSession(token) {
  if (!token || typeof token !== "string") {
    return null;
  }
  const entry = state.sessions.get(token);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    state.sessions.delete(token);
    return null;
  }
  return entry;
}

function parseCookieHeader(header) {
  const cookies = new Map();
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) continue;
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      cookies.set(name, value);
    }
  }
  return cookies;
}

function tokenFromCookieHeader(header) {
  return parseCookieHeader(header).get(SESSION_COOKIE_NAME) || null;
}

function resolveRequestSession(req) {
  const token = tokenFromCookieHeader(req.get ? req.get("cookie") : req.headers?.cookie);
  const session = resolveSession(token);
  return { token, session };
}

function sessionCookiePath(req) {
  return requestBasePath(req) || "/";
}

function isSecureRequest(req) {
  const forwardedProto = String(req.get("x-forwarded-proto") || "").split(",")[0].trim().toLowerCase();
  return forwardedProto === "https" || req.protocol === "https";
}

function setSessionCookie(req, res, token) {
  const maxAgeSeconds = Math.max(1, Math.floor(SESSION_TTL_MS / 1000));
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Max-Age=${maxAgeSeconds}`,
    `Path=${sessionCookiePath(req)}`,
    "HttpOnly",
    "SameSite=Lax"
  ];
  if (isSecureRequest(req)) {
    parts.push("Secure");
  }
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(req, res) {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "Max-Age=0",
    `Path=${sessionCookiePath(req)}`,
    "HttpOnly",
    "SameSite=Lax"
  ];
  if (isSecureRequest(req)) {
    parts.push("Secure");
  }
  res.setHeader("Set-Cookie", parts.join("; "));
}

async function auth(req, res, next) {
  try {
    let { session } = resolveRequestSession(req);
    let user = session ? getUserById(session.userId) : null;
    if ((!session || !user) && internalNoLoginMode) {
      ({ session, user } = await ensureInternalSession(req, res));
    }
    if (!session || !user) {
      return res.status(401).json({ error: "unauthorized" });
    }
    session.lastSeenAt = now();
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    req.session = session;
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

function getDocumentPermission(user, document) {
  if (!user || !document) {
    return null;
  }
  if (document.ownerUserId === user.id) {
    return "owner";
  }
  const grant = indexes.grantsByDocumentUser.get(grantKey(document.id, user.id));
  return grant?.permission || null;
}

function canOpenDocument(user, document) {
  return Boolean(getDocumentPermission(user, document));
}

function canEditDocument(user, document) {
  const permission = getDocumentPermission(user, document);
  return permission === "owner" || permission === "edit";
}

function canManageShare(user, document) {
  return getDocumentPermission(user, document) === "owner";
}

function sanitizeSharePermission(value) {
  return value === "view" ? "view" : "edit";
}

function publicDocument(document, user) {
  return {
    ...document,
    permission: getDocumentPermission(user, document)
  };
}

function publicRelayRoom(room, user) {
  const participants = relayPeers.get(room?.id);
  return {
    id: room.id,
    title: room.title,
    ownerUserId: room.ownerUserId,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    expiresAt: room.expiresAt,
    active: isRelayRoomActive(room),
    permission: getRelayRoomPermission(user, room),
    participantCount: participants?.size || 0
  };
}

function publicRelayShare(req, share, rawToken = null) {
  if (!share || !isRelayShareActive(share)) {
    return {
      enabled: false,
      permission: "edit",
      link: null,
      appLink: null,
      browserLink: null,
      appBridgeLink: null,
      expiresAt: null,
      linkAvailable: false
    };
  }
  return {
    enabled: true,
    roomId: share.roomId,
    permission: share.permission,
    createdAt: share.createdAt,
    updatedAt: share.updatedAt,
    expiresAt: share.expiresAt,
    linkAvailable: false,
    link: null,
    appLink: null,
    browserLink: null,
    appBridgeLink: null
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// The relay audit directory only needs to be created once. Doing it on every
// op/event (a per-keystroke hot path under multi-user editing) is a wasted
// syscall — create it lazily on first write, then skip.
let relayAuditDirReady = false;
async function ensureRelayAuditDir() {
  if (relayAuditDirReady) return;
  await fs.mkdir(path.dirname(files.relayAudit), { recursive: true });
  relayAuditDirReady = true;
}

async function appendRelayAudit(event) {
  try {
    const entry = {
      ts: now(),
      ...event
    };
    const safeEntry = {
      ts: entry.ts,
      type: String(entry.type || "event").slice(0, 80),
      roomId: entry.roomId ? String(entry.roomId).slice(0, 120) : null,
      userId: entry.userId ? String(entry.userId).slice(0, 120) : null,
      displayName: entry.displayName ? String(entry.displayName).slice(0, 120) : null,
      permission: entry.permission ? String(entry.permission).slice(0, 20) : null,
      detail: entry.detail ? String(entry.detail).slice(0, 240) : null,
      bytes: Number.isFinite(Number(entry.bytes)) ? Number(entry.bytes) : undefined
    };
    await ensureRelayAuditDir();
    await fs.appendFile(files.relayAudit, `${JSON.stringify(safeEntry)}\n`, "utf8");
  } catch {
    // Audit failure should not persist document payloads or crash active relay rooms.
  }
}

// Host header is attacker-controllable behind any proxy/ATS; validate or fall
// back to a safe default to prevent share-link host injection.
function safePublicOrigin(req) {
  const forwardedHost = String(req.get("x-forwarded-host") || "").split(",")[0].trim();
  const host = String(forwardedHost || req.get("host") || "").trim();
  if (!host || !/^[a-z0-9.\-:_[\]]+$/i.test(host)) {
    return primaryPublicOrigin || `http://127.0.0.1:${runtimePort}`;
  }
  const forwardedProto = String(req.get("x-forwarded-proto") || "").split(",")[0].trim().toLowerCase();
  const proto = forwardedProto === "https" || req.protocol === "https" ? "https" : "http";
  const requestOrigin = `${proto}://${host}`;
  // Loopback hosts are only reachable from the local machine, so honor them
  // unconditionally. Without this, share links generated while developing on
  // 127.0.0.1 silently point at the LAN demo host (PUBLIC_ORIGIN), breaking
  // the app/web round-trip the user just initiated.
  const hostnameOnly = host.replace(/:\d+$/, "").toLowerCase();
  if (
    hostnameOnly === "127.0.0.1" ||
    hostnameOnly === "localhost" ||
    hostnameOnly === "::1" ||
    hostnameOnly === "[::1]"
  ) {
    return requestOrigin;
  }
  if (!allowedOrigins.size || allowedOrigins.has(requestOrigin)) {
    return requestOrigin;
  }
  return primaryPublicOrigin || requestOrigin;
}

function requestBasePath(req) {
  const forwardedPrefix = normalizeBasePath(req.get("x-forwarded-prefix"));
  if (forwardedPrefix) return forwardedPrefix;
  return normalizeBasePath(process.env.PUBLIC_BASE_PATH);
}

function safePublicBaseUrl(req) {
  const configured = normalizeBaseUrl(process.env.PUBLIC_BASE_URL);
  if (configured) return configured;
  return `${safePublicOrigin(req)}${requestBasePath(req)}`;
}

function prefixedPublicPath(req, publicPath) {
  const normalizedPath = String(publicPath || "").startsWith("/") ? String(publicPath || "") : `/${publicPath || ""}`;
  return `${requestBasePath(req)}${normalizedPath}`;
}

function appendQueryParam(pathOrUrl, key, value) {
  const raw = String(pathOrUrl || "");
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}

function oidcRedirectUri(req) {
  return msOidcConfig.redirectUri || `${safePublicBaseUrl(req)}/api/auth/ms/callback`;
}

function safeReturnPath(req, value) {
  const basePath = requestBasePath(req);
  const fallback = `${basePath || ""}/`;
  const raw = String(value || "").trim();
  if (!raw || raw.includes("\\")) return fallback;
  try {
    const isAbsolute = /^https?:\/\//i.test(raw);
    const parsed = isAbsolute ? new URL(raw) : new URL(raw, "http://rhwp.local");
    if (isAbsolute && parsed.origin !== safePublicOrigin(req)) return fallback;
    const relative = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    if (relative.startsWith("//")) return fallback;
    if (basePath && relative !== basePath && !relative.startsWith(`${basePath}/`)) return fallback;
    return relative || fallback;
  } catch {
    return fallback;
  }
}

function publicOidcConfig(req) {
  const enabled = !internalNoLoginMode && msOidcConfig.enabled;
  const configured = !internalNoLoginMode && msOidcConfig.configured;
  return {
    provider: "microsoft",
    enabled,
    configured,
    status: enabled ? "enabled" : internalNoLoginMode ? "disabled_internal_no_login" : configured ? "disabled" : "not_configured",
    tenantId: msOidcConfig.tenantId,
    loginPath: prefixedPublicPath(req, "/api/auth/ms/login"),
    callbackUrl: oidcRedirectUri(req),
    allowedDomains: msOidcConfig.allowedDomains.size ? [...msOidcConfig.allowedDomains] : null,
    error: enabled || internalNoLoginMode ? null : msOidcConfig.configError
  };
}

function sweepOidcStates() {
  const cutoff = Date.now();
  for (const [stateKey, entry] of oidcStates) {
    if (!entry || entry.expiresAt <= cutoff) {
      oidcStates.delete(stateKey);
    }
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const error = new Error(data?.error || data?.error_description || `http_${response.status}`);
    error.status = response.status;
    error.data = data || { message: text.slice(0, 500) };
    throw error;
  }
  return data;
}

function oidcErrorSummary(error) {
  const data = error?.data || {};
  return {
    error: String(data.error || error?.message || "oidc_error").slice(0, 120),
    errorCodes: Array.isArray(data.error_codes) ? data.error_codes.slice(0, 5) : [],
    traceId: data.trace_id ? String(data.trace_id).slice(0, 120) : null,
    correlationId: data.correlation_id ? String(data.correlation_id).slice(0, 120) : null,
    description: String(data.error_description || "").replace(/client_secret[^.]+/gi, "client_secret <redacted>").slice(0, 500)
  };
}

function oidcUserFacingError(error) {
  const data = error?.data || {};
  const codes = Array.isArray(data.error_codes) ? data.error_codes.map(Number) : [];
  if (data.error === "invalid_client" && codes.includes(7000215)) {
    return "Microsoft login validation failed: invalid_client_secret_value_required. Azure client secret의 Secret ID가 아니라 생성 직후 표시되는 Value를 서버 환경변수에 넣어야 합니다.";
  }
  return `Microsoft login validation failed: ${String(error?.message || error).slice(0, 160)}`;
}

function logOidcFailure(stage, error, extra = {}) {
  console.warn(JSON.stringify({
    level: "warn",
    event: "ms_oidc_failure",
    stage,
    ...extra,
    ...oidcErrorSummary(error)
  }));
}

async function getMsOidcDiscovery() {
  if (!msOidcConfig.enabled) {
    throw new Error("oidc_not_configured");
  }
  const nowMs = Date.now();
  if (msOidcDiscoveryCache && msOidcDiscoveryCache.expiresAt > nowMs) {
    return msOidcDiscoveryCache.value;
  }
  const discovery = await fetchJson(msOidcConfig.discoveryUrl, { headers: { accept: "application/json" } });
  for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri", "issuer"]) {
    if (!discovery?.[key]) {
      throw new Error("oidc_discovery_invalid");
    }
  }
  msOidcDiscoveryCache = {
    value: discovery,
    expiresAt: nowMs + 24 * 60 * 60 * 1000
  };
  return discovery;
}

async function getMsOidcJwks(jwksUri) {
  const nowMs = Date.now();
  if (msOidcJwksCache && msOidcJwksCache.uri === jwksUri && msOidcJwksCache.expiresAt > nowMs) {
    return msOidcJwksCache.value;
  }
  const jwks = await fetchJson(jwksUri, { headers: { accept: "application/json" } });
  if (!Array.isArray(jwks?.keys)) {
    throw new Error("oidc_jwks_invalid");
  }
  msOidcJwksCache = {
    uri: jwksUri,
    value: jwks,
    expiresAt: nowMs + 24 * 60 * 60 * 1000
  };
  return jwks;
}

function codeChallengeForVerifier(verifier) {
  return encodeBase64Url(crypto.createHash("sha256").update(verifier).digest());
}

async function redeemMsOidcCode(discovery, code, entry) {
  const body = new URLSearchParams({
    client_id: msOidcConfig.clientId,
    scope: msOidcConfig.scopes,
    code,
    redirect_uri: entry.redirectUri,
    grant_type: "authorization_code",
    code_verifier: entry.codeVerifier
  });
  if (msOidcConfig.clientSecret) {
    body.set("client_secret", msOidcConfig.clientSecret);
  }
  let tokenSet;
  try {
    tokenSet = await fetchJson(discovery.token_endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded"
      },
      body
    });
  } catch (error) {
    const shouldRetryWithBasic = msOidcConfig.clientSecret && error?.data?.error === "invalid_client";
    if (!shouldRetryWithBasic) {
      throw error;
    }
    logOidcFailure("token_client_secret_post", error, { retry: "client_secret_basic" });
    const retryBody = new URLSearchParams({
      scope: msOidcConfig.scopes,
      code,
      redirect_uri: entry.redirectUri,
      grant_type: "authorization_code",
      code_verifier: entry.codeVerifier
    });
    const basic = Buffer.from(`${msOidcConfig.clientId}:${msOidcConfig.clientSecret}`).toString("base64");
    tokenSet = await fetchJson(discovery.token_endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${basic}`
      },
      body: retryBody
    });
  }
  if (!tokenSet?.id_token) {
    throw new Error("oidc_id_token_missing");
  }
  return tokenSet;
}

function issuerMatches(actualIssuer, tenantId, expectedIssuer) {
  const actual = String(actualIssuer || "");
  const expected = String(expectedIssuer || "");
  if (!actual || !expected) return false;
  if (expected.includes("{tenantid}")) {
    return actual === expected.replace("{tenantid}", String(tenantId || ""));
  }
  return actual === expected;
}

function jwkForJwt(jwks, jwtHeader, claims) {
  const candidates = jwks.keys.filter((key) => key.kid === jwtHeader.kid && (!key.alg || key.alg === jwtHeader.alg));
  for (const key of candidates) {
    if (!key.issuer || issuerMatches(claims.iss, claims.tid, key.issuer)) {
      return key;
    }
  }
  return candidates[0] || null;
}

function verifyJwtSignature(jwt, jwk) {
  const publicJwk = {
    kty: jwk.kty,
    n: jwk.n,
    e: jwk.e,
    alg: jwk.alg || "RS256",
    use: jwk.use || "sig",
    key_ops: jwk.key_ops,
    ext: jwk.ext
  };
  const key = crypto.createPublicKey({ key: publicJwk, format: "jwk" });
  return crypto.verify("RSA-SHA256", Buffer.from(jwt.signingInput), key, jwt.signature);
}

async function verifyMsIdToken(idToken, expectedNonce, discovery) {
  const jwt = parseJwt(idToken);
  if (jwt.header.alg !== "RS256") {
    throw new Error("oidc_alg_rejected");
  }
  const claims = jwt.claims;
  const jwks = await getMsOidcJwks(discovery.jwks_uri);
  const jwk = jwkForJwt(jwks, jwt.header, claims);
  if (!jwk || !verifyJwtSignature(jwt, jwk)) {
    throw new Error("oidc_signature_invalid");
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (claims.exp && Number(claims.exp) <= nowSeconds) {
    throw new Error("oidc_token_expired");
  }
  if (claims.nbf && Number(claims.nbf) > nowSeconds + 60) {
    throw new Error("oidc_token_not_yet_valid");
  }
  if (claims.aud !== msOidcConfig.clientId) {
    throw new Error("oidc_audience_invalid");
  }
  if (!issuerMatches(claims.iss, claims.tid, discovery.issuer)) {
    throw new Error("oidc_issuer_invalid");
  }
  if (!safeEqualString(claims.nonce, expectedNonce)) {
    throw new Error("oidc_nonce_invalid");
  }
  return claims;
}

function emailFromOidcClaims(claims) {
  const rawEmail = String(claims.email || claims.preferred_username || claims.upn || "").trim().toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
    return rawEmail;
  }
  const stableId = String(claims.oid || claims.sub || "user")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 120);
  return `${stableId}@ms-oidc.local`;
}

function assertAllowedOidcDomain(email) {
  if (!msOidcConfig.allowedDomains.size) return;
  const domain = String(email || "").split("@").pop()?.toLowerCase();
  if (!domain || !msOidcConfig.allowedDomains.has(domain)) {
    throw new Error("oidc_domain_not_allowed");
  }
}

async function upsertMsOidcUser(claims) {
  const email = emailFromOidcClaims(claims);
  assertAllowedOidcDomain(email);
  const displayName = String(claims.name || claims.preferred_username || email.split("@")[0]).trim().slice(0, 80) || email;
  let user = indexes.usersByEmail.get(email);
  if (!user) {
    user = {
      id: id("user"),
      email,
      displayName,
      department: "Microsoft Entra ID",
      color: pickColor(state.users.length),
      authProvider: "ms-oidc",
      oidcProvider: "microsoft",
      oidcSubject: String(claims.sub || ""),
      oidcObjectId: String(claims.oid || ""),
      oidcTenantId: String(claims.tid || ""),
      createdAt: now()
    };
    state.users.push(user);
    indexUser(user);
  } else {
    user.displayName = displayName;
    user.department = user.department || "Microsoft Entra ID";
    user.authProvider = "ms-oidc";
    user.oidcProvider = "microsoft";
    user.oidcSubject = String(claims.sub || user.oidcSubject || "");
    user.oidcObjectId = String(claims.oid || user.oidcObjectId || "");
    user.oidcTenantId = String(claims.tid || user.oidcTenantId || "");
  }
  user.lastLoginAt = now();
  await writeJson(files.users, state.users);
  return user;
}

function publicShare(req, share, rawToken = null) {
  const baseUrl = safePublicBaseUrl(req);
  if (!share) {
    return {
      enabled: false,
      permission: "edit",
      link: null,
      expiresAt: null,
      linkAvailable: false
    };
  }
  const active = isShareActive(share);
  return {
    enabled: active,
    permission: share.permission,
    createdAt: share.createdAt,
    updatedAt: share.updatedAt,
    expiresAt: share.expiresAt || null,
    linkAvailable: Boolean(active && rawToken),
    link: active && rawToken ? `${baseUrl}/#share=${rawToken}` : null
  };
}

function isAbsoluteHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isPrivateIp(ip) {
  if (!ip || typeof ip !== "string") return false;
  const norm = ip.replace(/^::ffff:/, "");
  if (norm === "127.0.0.1" || norm === "::1" || norm === "localhost") return true;
  if (/^10\./.test(norm)) return true;
  if (/^192\.168\./.test(norm)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(norm)) return true;
  if (/^fc00:/i.test(norm) || /^fd[0-9a-f]{2}:/i.test(norm)) return true;
  return false;
}

function getServerHost(req) {
  const host = String(req?.headers?.host || "").trim().toLowerCase();
  return host.split(":")[0] || null;
}

function isIntranetRequest(req) {
  const host = getServerHost(req);
  if (host && isPrivateIp(host)) return true;
  const ip = req?.socket?.remoteAddress || "";
  if (isPrivateIp(ip)) return true;
  const xff = String(req?.headers?.["x-forwarded-for"] || "").split(",")[0]?.trim();
  if (xff && isPrivateIp(xff)) return true;
  return false;
}



// ---------------------------------------------------------------------------
// Security middleware: headers, simple per-IP rate limit, origin guard
// ---------------------------------------------------------------------------

const BASE_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join("; ");

function contentSecurityPolicyForRequest(req) {
  const frameAncestors = req.path.startsWith("/rhwp-studio/") ? "'self'" : "'none'";
  return `${BASE_CONTENT_SECURITY_POLICY}; frame-ancestors ${frameAncestors}`;
}

function securityHeaders(req, res, next) {
  res.setHeader("Content-Security-Policy", contentSecurityPolicyForRequest(req));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), usb=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  next();
}

function createRateLimiter({ windowMs, max, key = (req) => req.ip || req.socket?.remoteAddress || "anon" }) {
  const hits = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, list] of hits) {
      const filtered = list.filter((t) => t > cutoff);
      if (filtered.length === 0) hits.delete(k);
      else hits.set(k, filtered);
    }
  }, windowMs).unref?.();
  return function rateLimit(req, res, next) {
    const k = key(req);
    const now = Date.now();
    const list = (hits.get(k) || []).filter((t) => t > now - windowMs);
    if (list.length >= max) {
      res.setHeader("Retry-After", Math.ceil(windowMs / 1000));
      return res.status(429).json({ error: "rate_limited" });
    }
    list.push(now);
    hits.set(k, list);
    next();
  };
}

// Reject cross-origin write requests outright. Session auth uses HttpOnly
// cookies, so state-changing browser requests must stay same-origin.
function enforceSameOrigin(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return next();
  }
  const origin = req.get("origin");
  if (!origin) {
    // Non-browser clients (curl, desktop) skip this header.
    return next();
  }
  const host = req.get("host");
  try {
    const parsed = new URL(origin);
    if (parsed.host === host) {
      return next();
    }
    if (allowedOrigins.has(normalizeOrigin(origin))) {
      return next();
    }
  } catch {
    // fall through to reject
  }
  return res.status(403).json({ error: "cross_origin_denied" });
}

app.disable("x-powered-by");
app.set("trust proxy", false);
app.use(securityHeaders);
app.use(enforceSameOrigin);

const globalLimiter = createRateLimiter({
  windowMs: 60_000,
  max: Number(process.env.API_RATE_LIMIT_PER_MIN || 600)
});
const authLimiter = createRateLimiter({
  windowMs: 60_000,
  max: Number(process.env.AUTH_RATE_LIMIT_PER_MIN || 20)
});
const writeLimiter = createRateLimiter({
  windowMs: 60_000,
  max: Number(process.env.WRITE_RATE_LIMIT_PER_MIN || 120)
});
const uploadLimiter = createRateLimiter({
  windowMs: 60_000,
  max: Number(process.env.UPLOAD_RATE_LIMIT_PER_MIN || 30)
});

app.use("/api", globalLimiter);

// Smaller JSON limit for ordinary endpoints. save-export attaches its own
// larger limit only where it is actually required.
const jsonStandard = express.json({ limit: `${JSON_LIMIT_MB}mb` });
const jsonExport = express.json({ limit: `${SAVE_EXPORT_JSON_LIMIT_MB}mb` });

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    app: "rhwp-collab",
    buildId,
    port: runtimePort,
    mode: relayOnlyMode ? "relay-only" : "legacy-document",
    documents: relayOnlyMode ? 0 : state.documents.length,
    revisions: relayOnlyMode ? 0 : state.revisions.length,
    relayRooms: state.relayRooms.length,
    rooms: relayOnlyMode ? relayPeers.size : rooms.size,
    wsClients: activeWss?.clients?.size || 0,
    maxWsClients: WS_MAX_CLIENTS,
    maxWsRoomClients: WS_MAX_ROOM_CLIENTS,
    oidc: msOidcConfig.enabled ? "enabled" : msOidcConfig.configured ? "disabled" : "not_configured"
  });
});

app.get("/api/config", (req, res) => {
  const oidc = publicOidcConfig(req);
  const defaultStudioUrl = appendQueryParam(prefixedPublicPath(req, "/rhwp-studio/"), "v", buildId);
  res.json({
    rhwpStudioUrl: process.env.RHWP_STUDIO_URL || defaultStudioUrl,
    buildId,
    authMode: internalNoLoginMode ? "local-only" : oidc.enabled ? "ms-oidc" : msOidcConfig.devLoginEnabled ? "dev-login" : "auth-required",
    loginRequired: !internalNoLoginMode,
    sharingEnabled: false,
    oidcStatus: internalNoLoginMode ? "disabled_local_only" : oidc.status,
    oidc: internalNoLoginMode ? null : oidc,
    devLoginEnabled: false,
    relayOnly: relayOnlyMode,
    relayOrigin: null,
    publicBaseUrl: safePublicBaseUrl(req),
    production: isProduction,
    publicOrigins: publicOrigins.length ? publicOrigins : null,
    intranet: isIntranetRequest(req),
    serverHost: getServerHost(req),
    collaborationCapacity: null,
    openSource: {
      engine: "hwp.js",
      version: "0.0.3",
      capabilities: relayOnlyMode ? ["local-client-render"] : ["text-extract", "preview-html", "search", "hwpx-text-extract"],
      rhwpEditor: {
        engine: "@rhwp/editor",
        version: "0.7.13",
        core: "@rhwp/core",
        coreVersion: "0.7.13",
        studio: "self-hosted"
      }
    }
  });
});


app.get("/api/auth/ms/status", (req, res) => {
  if (internalNoLoginMode) {
    return res.json({ oidc: null, devLoginEnabled: false, loginRequired: false, status: "local-only" });
  }
  res.json({ oidc: publicOidcConfig(req), devLoginEnabled: false, loginRequired: !internalNoLoginMode });
});

app.get("/api/auth/ms/login", authLimiter, async (req, res) => {
  if (internalNoLoginMode) {
    return res.status(404).json({ error: "login_disabled" });
  }
  if (!msOidcConfig.enabled) {
    return res.status(503).json({ error: "oidc_not_configured", oidc: publicOidcConfig(req) });
  }
  try {
    sweepOidcStates();
    const discovery = await getMsOidcDiscovery();
    const stateKey = crypto.randomBytes(24).toString("base64url");
    const nonce = crypto.randomBytes(24).toString("base64url");
    const codeVerifier = crypto.randomBytes(48).toString("base64url");
    const redirectUri = oidcRedirectUri(req);
    const returnTo = safeReturnPath(req, req.query?.returnTo);
    oidcStates.set(stateKey, {
      nonce,
      codeVerifier,
      redirectUri,
      returnTo,
      createdAt: Date.now(),
      expiresAt: Date.now() + OIDC_STATE_TTL_MS
    });
    const loginUrl = new URL(discovery.authorization_endpoint);
    loginUrl.searchParams.set("client_id", msOidcConfig.clientId);
    loginUrl.searchParams.set("response_type", "code");
    loginUrl.searchParams.set("redirect_uri", redirectUri);
    loginUrl.searchParams.set("response_mode", "query");
    loginUrl.searchParams.set("scope", msOidcConfig.scopes);
    loginUrl.searchParams.set("state", stateKey);
    loginUrl.searchParams.set("nonce", nonce);
    loginUrl.searchParams.set("code_challenge", codeChallengeForVerifier(codeVerifier));
    loginUrl.searchParams.set("code_challenge_method", "S256");
    if (req.query?.login_hint) {
      loginUrl.searchParams.set("login_hint", String(req.query.login_hint).slice(0, 254));
    }
    if (String(req.query?.prompt || "") === "select_account") {
      loginUrl.searchParams.set("prompt", "select_account");
    }
    res.redirect(loginUrl.toString());
  } catch (error) {
    res.status(502).json({ error: "oidc_login_failed", detail: error.message });
  }
});

app.get("/api/auth/ms/callback", authLimiter, async (req, res) => {
  if (internalNoLoginMode) {
    return res.status(404).send("Login is disabled for this internal build.");
  }
  if (!msOidcConfig.enabled) {
    return res.status(503).send("Microsoft OIDC is not configured.");
  }
  const stateKey = String(req.query?.state || "");
  const entry = oidcStates.get(stateKey);
  oidcStates.delete(stateKey);
  if (req.query?.error) {
    return res.status(401).send(`Microsoft login failed: ${String(req.query.error).slice(0, 120)}`);
  }
  if (!entry || entry.expiresAt <= Date.now()) {
    return res.status(400).send("Microsoft login state expired. Please try again.");
  }
  const code = String(req.query?.code || "");
  if (!code) {
    return res.status(400).send("Microsoft login code missing.");
  }
  try {
    const discovery = await getMsOidcDiscovery();
    const tokenSet = await redeemMsOidcCode(discovery, code, entry);
    const claims = await verifyMsIdToken(tokenSet.id_token, entry.nonce, discovery);
    const user = await upsertMsOidcUser(claims);
    const token = makeToken(user.id);
    setSessionCookie(req, res, token);
    res.redirect(entry.returnTo || prefixedPublicPath(req, "/"));
  } catch (error) {
    logOidcFailure("callback_validation", error);
    res.status(401).send(oidcUserFacingError(error));
  }
});

app.post("/api/auth/logout", authLimiter, (req, res) => {
  const { token } = resolveRequestSession(req);
  if (token) {
    state.sessions.delete(token);
  }
  clearSessionCookie(req, res);
  res.setHeader("Clear-Site-Data", '"cache"');
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true });
});

app.get("/api/auth/dev-users", (_req, res) => {
  if (internalNoLoginMode) {
    return res.status(404).json({ error: "dev_login_disabled" });
  }
  if (!msOidcConfig.devLoginEnabled) {
    return res.status(404).json({ error: "dev_login_disabled" });
  }
  res.json({ users: state.users.map(publicUser) });
});

app.post("/api/auth/dev-login", authLimiter, jsonStandard, async (req, res) => {
  if (internalNoLoginMode) {
    return res.status(404).json({ error: "dev_login_disabled" });
  }
  if (!msOidcConfig.devLoginEnabled) {
    return res.status(404).json({ error: "dev_login_disabled" });
  }
  const { email, displayName } = req.body || {};
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail || normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return res.status(400).json({ error: "email_required" });
  }

  const existing = indexes.usersByEmail.get(normalizedEmail);

  let user = existing;
  if (!user) {
    const safeName = String(displayName || normalizedEmail.split("@")[0]).trim().slice(0, 80);
    user = {
      id: id("user"),
      email: normalizedEmail,
      displayName: safeName,
      department: "OIDC 예정",
      color: pickColor(state.users.length),
      authProvider: "dev"
    };
    state.users.push(user);
    indexUser(user);
    await writeJson(files.users, state.users);
  }

  const token = makeToken(user.id);
  setSessionCookie(req, res, token);
  res.json({ user: publicUser(user), cookieSession: true });
});

app.get("/api/me", auth, (req, res) => {
  res.json({
    user: publicUser(req.user),
  });
});

function sharingRemoved(_req, res) {
  res.status(410).json({
    error: "sharing_disabled",
    detail: "sharing_and_collaboration_removed_from_this_internal_build"
  });
}

app.use("/api/relay", sharingRemoved);
app.get("/open", sharingRemoved);

app.post("/api/relay/rooms", auth, writeLimiter, jsonStandard, async (req, res) => {
  const title = String(req.body?.title || "로컬 문서").trim().slice(0, 160) || "로컬 문서";
  const room = {
    id: id("room"),
    title,
    ownerUserId: req.user.id,
    active: true,
    createdAt: now(),
    updatedAt: now(),
    expiresAt: addMs(new Date(), relayRoomTtlMs)
  };
  const grant = {
    id: id("relay_grant"),
    roomId: room.id,
    userId: req.user.id,
    permission: "owner",
    source: "owner",
    createdAt: now(),
    updatedAt: now()
  };
  state.relayRooms.unshift(room);
  state.relayGrants.unshift(grant);
  indexRelayRoom(room);
  indexRelayGrant(grant);
  await Promise.all([writeJson(files.relayRooms, state.relayRooms), writeJson(files.relayGrants, state.relayGrants)]);
  await appendRelayAudit({
    type: "room.create",
    roomId: room.id,
    userId: req.user.id,
    displayName: req.user.displayName,
    permission: "owner"
  });
  res.status(201).json({ room: publicRelayRoom(room, req.user) });
});

app.get("/api/relay/rooms/:roomId", auth, (req, res) => {
  const room = getRelayRoomById(req.params.roomId);
  if (!canOpenRelayRoom(req.user, room)) {
    return res.status(404).json({ error: "room_not_found" });
  }
  res.json({
    room: publicRelayRoom(room, req.user),
    participants: relayParticipants(room.id)
  });
});

app.post("/api/relay/rooms/:roomId/leave", auth, writeLimiter, jsonStandard, async (req, res) => {
  const room = getRelayRoomById(req.params.roomId);
  if (!canOpenRelayRoom(req.user, room)) {
    return res.status(404).json({ error: "room_not_found" });
  }
  await appendRelayAudit({
    type: "room.leave",
    roomId: room.id,
    userId: req.user.id,
    displayName: req.user.displayName,
    permission: getRelayRoomPermission(req.user, room)
  });
  res.json({ ok: true });
});

app.get("/api/relay/rooms/:roomId/share", auth, (req, res) => {
  const room = getRelayRoomById(req.params.roomId);
  if (!canManageRelayRoom(req.user, room)) {
    return res.status(403).json({ error: "room_owner_required" });
  }
  res.json({ share: publicRelayShare(req, getRelayRoomShare(room.id)) });
});

app.post("/api/relay/shares", auth, writeLimiter, jsonStandard, async (req, res) => {
  const room = getRelayRoomById(req.body?.roomId);
  if (!canManageRelayRoom(req.user, room)) {
    return res.status(403).json({ error: "room_owner_required" });
  }
  const permission = sanitizeSharePermission(req.body?.permission);
  const enabled = req.body?.enabled !== false;
  let rawToken = null;
  let share = getRelayRoomShare(room.id);
  if (!share) {
    rawToken = enabled ? newShareToken() : null;
    share = {
      id: id("relay_share"),
      roomId: room.id,
      tokenHash: rawToken ? hashShareToken(rawToken) : null,
      tokenPreview: rawToken ? rawToken.slice(0, 8) : null,
      enabled,
      permission,
      createdBy: req.user.id,
      createdAt: now(),
      updatedAt: now(),
      expiresAt: enabled ? addMs(new Date(), shareTtlMs) : null
    };
    state.relayShares.unshift(share);
  } else {
    if (share.tokenHash) {
      indexes.relaySharesByHash.delete(share.tokenHash);
    }
    share.enabled = enabled;
    share.permission = permission;
    share.updatedAt = now();
    if (enabled) {
      rawToken = newShareToken();
      share.tokenHash = hashShareToken(rawToken);
      share.tokenPreview = rawToken.slice(0, 8);
      share.expiresAt = addMs(new Date(), shareTtlMs);
      delete share.revokedAt;
      delete share.revokedReason;
    } else {
      share.tokenHash = null;
      share.tokenPreview = null;
      share.expiresAt = null;
      share.revokedAt = now();
      share.revokedReason = "disabled_by_owner";
    }
  }
  indexRelayShare(share);
  room.updatedAt = now();
  await Promise.all([writeJson(files.relayShares, state.relayShares), writeJson(files.relayRooms, state.relayRooms)]);
  await appendRelayAudit({
    type: enabled ? "share.issue" : "share.disable",
    roomId: room.id,
    userId: req.user.id,
    displayName: req.user.displayName,
    permission
  });
  res.json({ share: publicRelayShare(req, share, rawToken), room: publicRelayRoom(room, req.user) });
});

app.post("/api/relay/shares/:token/claim", auth, writeLimiter, jsonStandard, async (req, res) => {
  const token = String(req.params.token || "").trim();
  if (!token || token.length > 200 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    return res.status(404).json({ error: "share_not_found" });
  }
  const share = indexes.relaySharesByHash.get(hashShareToken(token));
  if (!share || !isRelayShareActive(share) || !tokenHashMatches(share.tokenHash, token)) {
    return res.status(404).json({ error: "share_not_found" });
  }
  const room = getRelayRoomById(share.roomId);
  if (!isRelayRoomActive(room)) {
    return res.status(404).json({ error: "room_not_found" });
  }
  if (room.ownerUserId !== req.user.id) {
    let grant = indexes.relayGrantsByRoomUser.get(relayGrantKey(room.id, req.user.id));
    if (!grant) {
      grant = {
        id: id("relay_grant"),
        roomId: room.id,
        userId: req.user.id,
        permission: share.permission,
        source: "relay-share-link",
        createdAt: now(),
        updatedAt: now()
      };
      state.relayGrants.unshift(grant);
      indexRelayGrant(grant);
    } else {
      grant.permission = share.permission === "edit" || grant.permission === "edit" ? "edit" : "view";
      grant.updatedAt = now();
    }
    await writeJson(files.relayGrants, state.relayGrants);
  }
  await appendRelayAudit({
    type: "share.claim",
    roomId: room.id,
    userId: req.user.id,
    displayName: req.user.displayName,
    permission: getRelayRoomPermission(req.user, room)
  });
  res.json({
    room: publicRelayRoom(room, req.user),
    permission: getRelayRoomPermission(req.user, room)
  });
});

app.use(["/api/documents", "/api/share", "/api/search"], (req, res, next) => {
  if (!relayOnlyMode) {
    return next();
  }
  return res.status(410).json({
    error: "relay_only_mode",
    detail: "server_document_storage_disabled"
  });
});

app.get("/api/documents", auth, (req, res) => {
  const documents = state.documents.filter((document) => canOpenDocument(req.user, document));
  res.json({
    documents: documents.map((document) => ({
      ...publicDocument(document, req.user),
      revisionCount: getDocumentRevisions(document.id).length
    }))
  });
});

app.post("/api/documents", auth, writeLimiter, jsonStandard, async (req, res) => {
  const title = String(req.body?.title || "").trim().slice(0, 200);
  if (!title) {
    return res.status(400).json({ error: "title_required" });
  }

  const document = {
    id: id("doc"),
    title,
    status: "draft",
    ownerUserId: req.user.id,
    originalFileName: null,
    filePath: null,
    createdAt: now(),
    updatedAt: now()
  };
  state.documents.unshift(document);
  indexDocument(document);
  await writeJson(files.documents, state.documents);
  res.status(201).json({ document: publicDocument(document, req.user) });
});

app.get("/api/documents/:documentId", auth, (req, res) => {
  const document = getDocumentById(req.params.documentId);
  if (!canOpenDocument(req.user, document)) {
    return res.status(404).json({ error: "not_found" });
  }
  res.json({
    document: publicDocument(document, req.user),
    permission: getDocumentPermission(req.user, document),
    revisions: getDocumentRevisions(document.id),
    commentCount: getDocumentComments(document.id).length
  });
});

app.get("/api/documents/:documentId/share", auth, (req, res) => {
  const document = getDocumentById(req.params.documentId);
  if (!canManageShare(req.user, document)) {
    return res.status(403).json({ error: "share_owner_required" });
  }
  const share = getDocumentShare(document.id);
  res.json({ share: publicShare(req, share) });
});

app.post("/api/documents/:documentId/share", auth, writeLimiter, jsonStandard, async (req, res) => {
  const document = getDocumentById(req.params.documentId);
  if (!canManageShare(req.user, document)) {
    return res.status(403).json({ error: "share_owner_required" });
  }

  const permission = sanitizeSharePermission(req.body?.permission);
  const enabled = req.body?.enabled !== false;
  let rawToken = null;
  let share = getDocumentShare(document.id);
  if (!share) {
    rawToken = enabled ? newShareToken() : null;
    share = {
      id: id("share"),
      documentId: document.id,
      tokenHash: rawToken ? hashShareToken(rawToken) : null,
      tokenPreview: rawToken ? rawToken.slice(0, 8) : null,
      enabled,
      permission,
      createdBy: req.user.id,
      createdAt: now(),
      updatedAt: now(),
      expiresAt: enabled ? addMs(new Date(), shareTtlMs) : null
    };
    state.shares.unshift(share);
    indexShare(share);
  } else {
    if (share.tokenHash) {
      indexes.sharesByHash.delete(share.tokenHash);
    }
    share.enabled = enabled;
    share.permission = permission;
    share.updatedAt = now();
    if (enabled) {
      rawToken = newShareToken();
      share.tokenHash = hashShareToken(rawToken);
      share.tokenPreview = rawToken.slice(0, 8);
      share.expiresAt = addMs(new Date(), shareTtlMs);
      delete share.revokedAt;
      delete share.revokedReason;
    } else {
      share.tokenHash = null;
      share.tokenPreview = null;
      share.expiresAt = null;
      share.revokedAt = now();
      share.revokedReason = "disabled_by_owner";
    }
    indexShare(share);
  }
  await writeJson(files.shares, state.shares);
  res.json({ share: publicShare(req, share, rawToken) });
});

app.post("/api/share/:token/claim", auth, writeLimiter, jsonStandard, async (req, res) => {
  const token = String(req.params.token || "").trim();
  if (!token || token.length > 200 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    return res.status(404).json({ error: "share_not_found" });
  }
  const share = indexes.sharesByHash.get(hashShareToken(token));
  if (!share || !isShareActive(share) || !tokenHashMatches(share.tokenHash, token)) {
    return res.status(404).json({ error: "share_not_found" });
  }
  const document = getDocumentById(share.documentId);
  if (!document) {
    return res.status(404).json({ error: "share_not_found" });
  }

  if (document.ownerUserId !== req.user.id) {
    let grant = indexes.grantsByDocumentUser.get(grantKey(document.id, req.user.id));
    if (!grant) {
      grant = {
        id: id("grant"),
        documentId: document.id,
        userId: req.user.id,
        permission: share.permission,
        source: "share-link",
        createdAt: now(),
        updatedAt: now()
      };
      state.grants.unshift(grant);
      indexGrant(grant);
    } else {
      grant.permission = share.permission === "edit" || grant.permission === "edit" ? "edit" : "view";
      grant.updatedAt = now();
    }
    await writeJson(files.grants, state.grants);
  }

  res.json({
    document: publicDocument(document, req.user),
    permission: getDocumentPermission(req.user, document)
  });
});

app.get("/api/documents/:documentId/comments", auth, (req, res) => {
  const document = getDocumentById(req.params.documentId);
  if (!canOpenDocument(req.user, document)) {
    return res.status(404).json({ error: "not_found" });
  }
  res.json({
    comments: [...getDocumentComments(document.id)]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  });
});

app.post(
  "/api/documents/:documentId/comments",
  auth,
  writeLimiter,
  jsonStandard,
  async (req, res) => {
    const document = getDocumentById(req.params.documentId);
    if (!canOpenDocument(req.user, document)) {
      return res.status(404).json({ error: "not_found" });
    }
    const body = String(req.body?.body || "").trim();
    if (!body) {
      return res.status(400).json({ error: "comment_required" });
    }
    const comment = {
      id: id("comment"),
      documentId: document.id,
      body: body.slice(0, 1200),
      createdBy: req.user.id,
      createdByName: req.user.displayName,
      createdAt: now()
    };
    state.comments.unshift(comment);
    indexComment(comment, "unshift");
    document.updatedAt = now();
    await Promise.all([writeJson(files.comments, state.comments), writeJson(files.documents, state.documents)]);
    res.status(201).json({ comment });
  }
);

function validateUploadMagic(buffer) {
  if (!buffer || buffer.length < 8) return false;
  // HWP (legacy) = OLE Compound Document: D0 CF 11 E0 A1 B1 1A E1
  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  // HWPX = ZIP: PK\x03\x04
  const zip = [0x50, 0x4b, 0x03, 0x04];
  const head = buffer.slice(0, 8);
  let oleMatch = true;
  for (let i = 0; i < ole.length; i++) {
    if (head[i] !== ole[i]) { oleMatch = false; break; }
  }
  let zipMatch = true;
  for (let i = 0; i < zip.length; i++) {
    if (head[i] !== zip[i]) { zipMatch = false; break; }
  }
  return oleMatch || zipMatch;
}

const storage = multer.diskStorage({
  destination: async (_req, _file, callback) => {
    await fs.mkdir(uploadDir, { recursive: true });
    callback(null, uploadDir);
  },
  filename: (_req, file, callback) => {
    const ext = path.extname(file.originalname).toLowerCase();
    callback(null, `${Date.now()}-${crypto.randomUUID()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: maxDocumentBytes, files: 1, fields: 10 },
  fileFilter: (_req, file, callback) => {
    const ext = path.extname(file.originalname).toLowerCase();
    callback(null, allowedExtensions.has(ext));
  }
});

function sanitizeDisplayFilename(name) {
  const raw = String(name || "document");
  // Strip anything that could break the Content-Disposition header or let a
  // client drop the download into a surprising path — control chars, CR/LF,
  // path separators, and quotes.
  const cleaned = raw.replace(/[\r\n\x00-\x1f\x7f"\\/]/g, "_").slice(0, 255);
  return cleaned || "document";
}

function encodeRfc5987(value) {
  return encodeURIComponent(value)
    .replace(/['()]/g, escape)
    .replace(/\*/g, "%2A");
}

// Ensure a relative filePath stored on a document cannot escape dataDir via
// poisoned JSON state (../../etc/passwd). We do this at read time so future
// state corruption doesn't turn into an arbitrary-file-read pivot.
function resolveInsideDataDir(relative) {
  if (!relative) return null;
  const candidate = path.resolve(dataDir, relative);
  const rel = path.relative(dataDir, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return candidate;
}

app.post(
  "/api/documents/:documentId/upload",
  auth,
  uploadLimiter,
  upload.single("file"),
  async (req, res) => {
    const document = getDocumentById(req.params.documentId);
    if (!canEditDocument(req.user, document)) {
      if (req.file) {
        fs.unlink(req.file.path).catch(() => {});
      }
      return res.status(404).json({ error: "not_found" });
    }
    if (!req.file) {
      return res.status(400).json({ error: "hwp_or_hwpx_file_required" });
    }

    // Validate HWP/HWPX magic bytes so polyglot or disguised files don't
    // make it into a format the renderer later misinterprets.
    try {
      const ext = path.extname(req.file.originalname).toLowerCase();
      const format = ext === ".hwpx" ? "hwpx" : "hwp";
      const header = await readFileHeader(req.file.path, 8);
      if (!isValidDocumentHeader(header, format)) {
        await fs.unlink(req.file.path).catch(() => {});
        return res.status(400).json({ error: "invalid_file_format" });
      }
    } catch (err) {
      await fs.unlink(req.file.path).catch(() => {});
      return res.status(500).json({ error: "upload_validation_failed" });
    }

    document.originalFileName = sanitizeDisplayFilename(req.file.originalname);
    document.filePath = path.relative(dataDir, req.file.path);
    document.updatedAt = now();
    await writeJson(files.documents, state.documents);
    invalidateTextCache(document.id);
    res.json({ document: publicDocument(document, req.user) });
  }
);

app.get("/api/documents/:documentId/file", auth, (req, res) => {
  const document = getDocumentById(req.params.documentId);
  if (!canOpenDocument(req.user, document) || !document.filePath) {
    return res.status(404).json({ error: "file_not_found" });
  }
  const absolute = resolveInsideDataDir(document.filePath);
  if (!absolute) {
    return res.status(404).json({ error: "file_not_found" });
  }
  const safeName = sanitizeDisplayFilename(document.originalFileName || "document");
  const encoded = encodeRfc5987(safeName);
  res.sendFile(absolute, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${safeName}"; filename*=UTF-8''${encoded}`,
      "X-Content-Type-Options": "nosniff"
    }
  });
});

function invalidateTextCache(documentId) {
  if (!documentId) return;
  const cachePath = path.join(files.textCache, `${documentId}.json`);
  fs.unlink(cachePath).catch(() => {});
}

const TEXT_CACHE_MAX_ENTRIES = positiveInteger(process.env.TEXT_CACHE_MAX_ENTRIES, 500);
let textCacheSweepRunning = false;
async function sweepTextCacheLru() {
  if (textCacheSweepRunning) return;
  textCacheSweepRunning = true;
  try {
    const entries = await fs.readdir(files.textCache).catch(() => []);
    if (entries.length <= TEXT_CACHE_MAX_ENTRIES) return;
    const stats = [];
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const full = path.join(files.textCache, name);
      try {
        const stat = await fs.stat(full);
        stats.push({ full, atimeMs: stat.atimeMs || stat.mtimeMs });
      } catch {}
    }
    if (stats.length <= TEXT_CACHE_MAX_ENTRIES) return;
    stats.sort((a, b) => a.atimeMs - b.atimeMs);
    const toDelete = stats.length - TEXT_CACHE_MAX_ENTRIES;
    for (let i = 0; i < toDelete; i += 1) {
      await fs.unlink(stats[i].full).catch(() => {});
    }
  } finally {
    textCacheSweepRunning = false;
  }
}

async function getDocumentTextCached(document) {
  if (!document?.filePath) return null;
  const absolute = resolveInsideDataDir(document.filePath);
  if (!absolute) return null;
  const cachePath = path.join(files.textCache, `${document.id}.json`);
  try {
    const stat = await fs.stat(absolute);
    const cached = await fs.readFile(cachePath, "utf8").catch(() => null);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed && parsed.fileMtimeMs === stat.mtimeMs) return parsed;
    }
    const ext = path.extname(document.originalFileName || document.filePath).toLowerCase();
    const fmt = ext === ".hwpx" ? "hwpx" : "hwp";
    const result = await extractDocumentText(absolute, fmt);
    const payload = {
      documentId: document.id,
      format: fmt,
      paragraphs: result.paragraphs,
      text: result.text,
      meta: result.meta,
      fileMtimeMs: stat.mtimeMs,
      extractedAt: now()
    };
    await fs.writeFile(cachePath, JSON.stringify(payload), "utf8").catch(() => {});
    sweepTextCacheLru().catch(() => {});
    return payload;
  } catch (err) {
    return { documentId: document.id, error: String(err?.message || err).slice(0, 240) };
  }
}

app.get("/api/documents/:documentId/text", auth, async (req, res) => {
  const document = getDocumentById(req.params.documentId);
  if (!canOpenDocument(req.user, document)) {
    return res.status(404).json({ error: "not_found" });
  }
  if (!document.filePath) {
    return res.json({ documentId: document.id, text: "", paragraphs: [], meta: { engine: "none" } });
  }
  const result = await getDocumentTextCached(document);
  if (!result || result.error) {
    return res.status(415).json({ error: "extract_failed", detail: result?.error || "no_file" });
  }
  res.json({
    documentId: document.id,
    title: document.title,
    format: result.format,
    paragraphs: result.paragraphs,
    text: result.text,
    meta: result.meta,
    extractedAt: result.extractedAt
  });
});

app.get("/api/documents/:documentId/preview-html", auth, async (req, res) => {
  const document = getDocumentById(req.params.documentId);
  if (!canOpenDocument(req.user, document)) {
    return res.status(404).type("html").send("<!doctype html><meta charset=\"UTF-8\"><body>not_found</body>");
  }
  if (!document.filePath) {
    return res.type("html").send(renderTextAsHtml([], { title: document.title }));
  }
  const result = await getDocumentTextCached(document);
  if (!result || result.error) {
    return res
      .status(415)
      .type("html")
      .send(renderTextAsHtml([`(추출 실패: ${result?.error || "no_file"})`], { title: document.title }));
  }
  res.type("html").send(renderTextAsHtml(result.paragraphs, { title: document.title }));
});

app.get("/api/search", auth, async (req, res) => {
  const q = String(req.query?.q || "").trim().slice(0, 200);
  if (!q) return res.json({ query: "", results: [] });
  const limit = Math.max(1, Math.min(50, Number(req.query?.limit || 20)));
  const results = [];
  for (const document of state.documents) {
    if (!canOpenDocument(req.user, document)) continue;
    if (results.length >= limit) break;
    const titleHit = document.title?.toLowerCase().includes(q.toLowerCase());
    let snippet = "";
    let textHit = false;
    if (document.filePath) {
      const cached = await getDocumentTextCached(document);
      if (cached && !cached.error && cached.text) {
        if (cached.text.toLowerCase().includes(q.toLowerCase())) {
          textHit = true;
          snippet = buildSnippet(cached.text, q);
        }
      }
    }
    if (titleHit || textHit) {
      results.push({
        documentId: document.id,
        title: document.title,
        ownerUserId: document.ownerUserId,
        updatedAt: document.updatedAt,
        match: titleHit && textHit ? "title+text" : titleHit ? "title" : "text",
        snippet
      });
    }
  }
  res.json({ query: q, results });
});

app.get("/api/documents/:documentId/collab-status", auth, (req, res) => {
  const document = getDocumentById(req.params.documentId);
  if (!canOpenDocument(req.user, document)) {
    return res.status(404).json({ error: "not_found" });
  }
  const room = rooms.get(`doc:${document.id}`);
  const participants = [];
  if (room) {
    for (const [, item] of room) {
      if (!item?.user) continue;
      participants.push({
        clientId: item.clientId,
        user: { id: item.user.id, displayName: item.user.displayName, color: item.user.color },
        typing: Boolean(item.presence?.typing),
        updatedAt: item.presence?.updatedAt || null
      });
    }
  }
  res.json({
    documentId: document.id,
    intranet: isIntranetRequest(req),
    coEditEnabled: true,
    participantCount: participants.length,
    participants
  });
});

app.post(
  "/api/documents/:documentId/revisions",
  auth,
  writeLimiter,
  jsonStandard,
  async (req, res) => {
    const document = getDocumentById(req.params.documentId);
    if (!canEditDocument(req.user, document)) {
      return res.status(404).json({ error: "not_found" });
    }

    const revision = {
      id: id("rev"),
      documentId: document.id,
      revisionNo: nextRevisionNo(document.id),
      label: String(req.body?.label || "manual checkpoint").slice(0, 120),
      pageCount: Number(req.body?.pageCount || 0),
      editorSource: "rhwp",
      savedBy: req.user.id,
      savedByName: req.user.displayName,
      createdAt: now()
    };
    state.revisions.unshift(revision);
    indexRevision(revision, "unshift");
    document.updatedAt = now();
    await Promise.all([writeJson(files.revisions, state.revisions), writeJson(files.documents, state.documents)]);
    res.status(201).json({ revision });
  }
);

app.post(
  "/api/documents/:documentId/save-export",
  auth,
  writeLimiter,
  jsonExport,
  async (req, res) => {
    const document = getDocumentById(req.params.documentId);
    if (!canEditDocument(req.user, document)) {
      return res.status(404).json({ error: "not_found" });
    }

    const format = String(req.body?.format || "hwp").toLowerCase();
    if (!["hwp", "hwpx"].includes(format)) {
      return res.status(400).json({ error: "unsupported_format" });
    }
    const dataBase64 = String(req.body?.dataBase64 || "");
    if (!dataBase64 || dataBase64.length > maxDocumentBase64Chars) {
      return res.status(400).json({ error: "data_required" });
    }

    const safeTitle = document.title.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "document";
    const fileName = `${Date.now()}-${safeTitle}.${format}`;
    const targetPath = path.join(saveDir, fileName);
    const bytes = decodeBase64(dataBase64);
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maxDocumentBytes) {
      return res.status(400).json({ error: "invalid_export_size" });
    }
    if (!isValidDocumentHeader(bytes.subarray(0, 8), format)) {
      return res.status(400).json({ error: "invalid_file_format" });
    }
    await fs.writeFile(targetPath, bytes);

    document.originalFileName = sanitizeDisplayFilename(req.body?.fileName || `${document.title}.${format}`);
    document.filePath = path.relative(dataDir, targetPath);
    document.updatedAt = now();

    const revision = {
      id: id("rev"),
      documentId: document.id,
      revisionNo: nextRevisionNo(document.id),
      label: String(req.body?.label || `rhwp export ${format}`).slice(0, 120),
      pageCount: Number(req.body?.pageCount || 0),
      editorSource: "rhwp-self-hosted-studio",
      format,
      filePath: document.filePath,
      savedBy: req.user.id,
      savedByName: req.user.displayName,
      createdAt: now()
    };
    state.revisions.unshift(revision);
    indexRevision(revision, "unshift");
    await Promise.all([writeJson(files.revisions, state.revisions), writeJson(files.documents, state.documents)]);
    invalidateTextCache(document.id);
    res.status(201).json({ document: publicDocument(document, req.user), revision });
  }
);

app.use(
  express.static(distDir, {
    fallthrough: true,
    setHeaders(res, filePath) {
      if (filePath.endsWith(".map")) {
        res.status(404).end();
      }
      const normalizedPath = filePath.split(path.sep).join("/");
      if (
        normalizedPath.includes("/rhwp-studio/") &&
        (normalizedPath.endsWith("/index.html") ||
          normalizedPath.endsWith("/rhwp-collab-bridge.js") ||
          normalizedPath.endsWith("/rhwp.js") ||
          // Bridge feature modules (clipboard, table-nav, zoom, …) are split out
          // of the main bridge over time; serve them no-store too so a split
          // never causes stale-cache flakiness in the editor or the CDP gate.
          normalizedPath.includes("/rhwp-studio/bridge/"))
      ) {
        res.setHeader("Cache-Control", "no-store");
      }
    }
  })
);
app.use((_req, res) => {
  res.sendFile(path.join(distDir, "index.html"));
});

export async function startServer(options = {}) {
  if (activeServer) {
    return {
      app,
      server: activeServer,
      wss: activeWss,
      host: options.host || process.env.HOST || "127.0.0.1",
      port: runtimePort,
      url: `http://127.0.0.1:${runtimePort}`,
      buildId
    };
  }

  await ensureDataFiles();

  // Default bind to loopback. Only bind to all interfaces when explicitly
  // requested (e.g. Docker `HOST=0.0.0.0`). Previously it was 0.0.0.0 by
  // default, which exposed the dev-login endpoint to the local network.
  const host = options.host || process.env.HOST || "127.0.0.1";
  const listenPort = Number(options.port ?? options.listenPort ?? port);
  activeServer = app.listen(listenPort, host);
  await new Promise((resolve, reject) => {
    activeServer.once("listening", resolve);
    activeServer.once("error", reject);
  });
  runtimePort = activeServer.address().port;
  activeWss = attachWebSocket(activeServer);
  setInterval(sweepSessions, 10 * 60 * 1000).unref?.();
  console.log(`rhwp-collab listening on ${host}:${runtimePort}`);

  return {
    app,
    server: activeServer,
    wss: activeWss,
    host,
    port: runtimePort,
    url: `http://127.0.0.1:${runtimePort}`,
    buildId
  };
}

function wsOriginAllowed(originHeader, hostHeader) {
  if (!originHeader) {
    // Non-browser clients (desktop app loopback loads, curl) won't send Origin.
    // Accept only when the request came in on loopback.
    return true;
  }
  try {
    const parsed = new URL(originHeader);
    if (allowedOrigins.has(parsed.origin)) {
      return true;
    }
    return hostHeader && parsed.host === hostHeader;
  } catch {
    return false;
  }
}

function extractTokenFromReq(req) {
  return tokenFromCookieHeader(req.headers.cookie) || null;
}

function attachWebSocket(server) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: WS_DOC_UPDATE_LIMIT_BYTES + 1024
  });

  server.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
      if (url.pathname !== "/ws" && url.pathname !== "/relay") {
        socket.destroy();
        return;
      }
      if (url.pathname === "/relay") {
        socket.write("HTTP/1.1 410 Gone\r\n\r\n");
        socket.destroy();
        return;
      }
      if (relayOnlyMode && url.pathname === "/ws") {
        socket.write("HTTP/1.1 410 Gone\r\n\r\n");
        socket.destroy();
        return;
      }
      if (!wsOriginAllowed(req.headers.origin, req.headers.host)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } catch {
      socket.destroy();
    }
  });

  wss.on("connection", (socket, req) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    } catch {
      socket.close(1008, "invalid_request");
      return;
    }
    if (url.pathname === "/relay") {
      socket.close(1008, "sharing_disabled");
      return;
    }
    const documentId = url.searchParams.get("documentId");
    const token = extractTokenFromReq(req);
    const session = resolveSession(token);
    const user = session ? getUserById(session.userId) : null;
    const document = getDocumentById(documentId);
    if (!session || !user || !canOpenDocument(user, document)) {
      socket.close(1008, "unauthorized");
      return;
    }
    if (wss.clients.size > WS_MAX_CLIENTS) {
      socket.close(1013, "server_full");
      return;
    }

    session.expiresAt = Date.now() + SESSION_TTL_MS;

    const clientId = id("client");
    const roomKey = document.id;
    const room = rooms.get(roomKey) || new Map();
    if (room.size >= WS_MAX_ROOM_CLIENTS) {
      socket.close(1013, "room_full");
      return;
    }
    rooms.set(roomKey, room);
    const presence = {
      clientId,
      user: publicUser(user),
      focus: "문서 입장",
      cursor: null,
      cursorSource: null,
      selection: null,
      typing: false,
      updatedAt: now()
    };
    room.set(clientId, { socket, presence });
    socket.send(JSON.stringify({ type: "presence:self", clientId }));
    scheduleRoomBroadcast(roomKey);

    let rateWindowStart = Date.now();
    let rateCount = 0;

    socket.on("message", (raw) => {
      // Per-connection message rate limit. Blocks an authenticated peer from
      // pumping the room with high-frequency presence or doc updates.
      const ts = Date.now();
      if (ts - rateWindowStart > 1000) {
        rateWindowStart = ts;
        rateCount = 0;
      }
      rateCount += 1;
      if (rateCount > WS_MSG_RATE_PER_SEC) {
        socket.close(1008, "rate_limited");
        return;
      }
      if (raw.length > WS_DOC_UPDATE_LIMIT_BYTES + 1024) {
        socket.close(1009, "message_too_large");
        return;
      }

      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!message || typeof message !== "object") {
        return;
      }
      if (message.type === "presence:update") {
        const item = room.get(clientId);
        if (!item) {
          return;
        }
        item.presence = {
          ...item.presence,
          focus: String(message.focus || item.presence.focus || "").slice(0, 100),
          cursor: message.cursor !== undefined ? sanitizePoint(message.cursor) : item.presence.cursor,
          cursorSource: message.cursor !== undefined ? sanitizeCursorSource(message.cursorSource) : item.presence.cursorSource,
          selection: message.selection !== undefined ? sanitizeSelection(message.selection) : item.presence.selection,
          typing: message.typing !== undefined ? Boolean(message.typing) : item.presence.typing,
          updatedAt: now()
        };
        scheduleRoomBroadcast(roomKey);
        return;
      }
      if (message.type === "doc:update") {
        if (!canEditDocument(user, document)) {
          return;
        }
        const format = message.format === "hwpx" ? "hwpx" : "hwp";
        const dataBase64 = typeof message.dataBase64 === "string" ? message.dataBase64 : "";
        if (!dataBase64 || dataBase64.length > WS_DOC_UPDATE_LIMIT_BYTES) {
          return;
        }
        const header = decodeBase64Header(dataBase64);
        if (!header || !isValidDocumentHeader(header, format)) {
          return;
        }
        const payload = JSON.stringify({
          type: "doc:update",
          fromClientId: clientId,
          fromDisplayName: publicUser(user)?.displayName || "peer",
          format,
          dataBase64,
          revision: Number(message.revision || 0) || 0,
          updatedAt: now()
        });
        scheduleDocUpdate(roomKey, payload, socket);
      }
    });

    socket.on("close", () => {
      room.delete(clientId);
      if (room.size === 0) {
        rooms.delete(roomKey);
        clearRoomTimers(roomKey);
      } else {
        scheduleRoomBroadcast(roomKey);
      }
    });
  });

  return wss;
}

function handleRelaySocket(socket, req, url, wss) {
  const roomId = url.searchParams.get("roomId");
  const token = extractTokenFromReq(req);
  const session = resolveSession(token);
  const user = session ? getUserById(session.userId) : null;
  const roomRecord = getRelayRoomById(roomId);
  const permission = getRelayRoomPermission(user, roomRecord);
  if (!session || !user || !permission) {
    socket.close(1008, "unauthorized");
    return;
  }
  if (wss.clients.size > WS_MAX_CLIENTS) {
    socket.close(1013, "server_full");
    return;
  }

  session.expiresAt = Date.now() + SESSION_TTL_MS;

  const activeRoom = relayPeers.get(roomRecord.id) || new Map();
  if (activeRoom.size >= WS_MAX_ROOM_CLIENTS) {
    socket.close(1013, "room_full");
    return;
  }
  relayPeers.set(roomRecord.id, activeRoom);
  const clientId = id("client");
    const presence = {
      clientId,
      user: publicUser(user),
      permission,
      role: permission === "owner" ? "owner" : permission,
      focus: "문서 입장",
      viewing: "문서",
      cursor: null,
      cursorDoc: null,
      cursorSource: null,
      cursorViewport: null,
      selection: null,
    typing: false,
    updatedAt: now()
  };
  activeRoom.set(clientId, { socket, user, permission, presence });
  socket.send(JSON.stringify({
    type: "relay:self",
    clientId,
    room: publicRelayRoom(roomRecord, user),
    permission
  }));
  sendRelayTextState(socket, roomRecord.id);
  appendRelayAudit({
    type: "ws.join",
    roomId: roomRecord.id,
    userId: user.id,
    displayName: user.displayName,
    permission
  });
  scheduleRelayBroadcast(roomRecord.id);

  let rateWindowStart = Date.now();
  let rateCount = 0;

  socket.on("message", (raw) => {
    const ts = Date.now();
    if (ts - rateWindowStart > 1000) {
      rateWindowStart = ts;
      rateCount = 0;
    }
    rateCount += 1;
    if (rateCount > WS_MSG_RATE_PER_SEC) {
      socket.close(1008, "rate_limited");
      return;
    }
    if (raw.length > WS_DOC_UPDATE_LIMIT_BYTES + 1024) {
      socket.close(1009, "message_too_large");
      return;
    }

    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.type === "presence:update") {
      const item = activeRoom.get(clientId);
      if (!item) return;
      item.presence = {
        ...item.presence,
        focus: String(message.focus || item.presence.focus || "").slice(0, 100),
        viewing: String(message.viewing || item.presence.viewing || "문서").slice(0, 120),
        cursor: message.cursor !== undefined ? sanitizePoint(message.cursor) : item.presence.cursor,
        cursorDoc: message.cursorDoc !== undefined ? sanitizePoint(message.cursorDoc) : item.presence.cursorDoc,
        cursorSource: message.cursor !== undefined ? sanitizeCursorSource(message.cursorSource) : item.presence.cursorSource,
        cursorViewport: message.cursorViewport !== undefined ? sanitizeViewport(message.cursorViewport) : item.presence.cursorViewport,
        selection: message.selection !== undefined ? sanitizeSelection(message.selection) : item.presence.selection,
        typing: message.typing !== undefined ? Boolean(message.typing) : item.presence.typing,
        updatedAt: now()
      };
      scheduleRelayBroadcast(roomRecord.id);
      return;
    }

    if (message.type === "lock:request") {
      if (!canEditRelayRoom(user, roomRecord)) {
        sendSocket(socket, JSON.stringify({ type: "relay:error", error: "edit_permission_required" }));
        return;
      }
      const target = sanitizeLockTarget(message.target);
      const roomLocks = relayLocks.get(roomRecord.id) || new Map();
      const existing = roomLocks.get(target);
      if (existing && existing.clientId !== clientId) {
        sendSocket(socket, JSON.stringify({ type: "relay:error", error: "lock_held", target }));
        return;
      }
      roomLocks.set(target, {
        target,
        clientId,
        user: publicUser(user),
        permission,
        updatedAt: now()
      });
      relayLocks.set(roomRecord.id, roomLocks);
      appendRelayAudit({
        type: "lock.request",
        roomId: roomRecord.id,
        userId: user.id,
        displayName: user.displayName,
        permission,
        detail: target
      });
      scheduleRelayBroadcast(roomRecord.id);
      return;
    }

    if (message.type === "lock:release") {
      const target = sanitizeLockTarget(message.target);
      const roomLocks = relayLocks.get(roomRecord.id);
      const existing = roomLocks?.get(target);
      if (existing?.clientId === clientId) {
        roomLocks.delete(target);
        appendRelayAudit({
          type: "lock.release",
          roomId: roomRecord.id,
          userId: user.id,
          displayName: user.displayName,
          permission,
          detail: target
        });
        scheduleRelayBroadcast(roomRecord.id);
      }
      return;
    }

    if (message.type === "doc:snapshot-request") {
      relayFrame(roomRecord.id, socket, {
        type: "relay:frame",
        frameType: "snapshot-request",
        fromClientId: clientId,
        fromDisplayName: user.displayName,
        fromPermission: permission,
        updatedAt: now()
      });
      appendRelayAudit({
        type: "frame.snapshot_request",
        roomId: roomRecord.id,
        userId: user.id,
        displayName: user.displayName,
        permission
      });
      return;
    }

    if (message.type === "doc:op") {
      if (!canEditRelayRoom(user, roomRecord)) {
        sendSocket(socket, JSON.stringify({ type: "relay:error", error: "edit_permission_required" }));
        return;
      }
      const op = sanitizeRelayOperation(message.op || message);
      if (!op) {
        sendSocket(socket, JSON.stringify({ type: "relay:error", error: "invalid_operation" }));
        return;
      }
      applyRelayOperationToTextState(roomRecord.id, op, {
        fromClientId: clientId,
        fromDisplayName: user.displayName,
        fromPermission: permission
      });
      relayFrame(roomRecord.id, socket, {
        type: "relay:op",
        fromClientId: clientId,
        fromDisplayName: user.displayName,
        fromPermission: permission,
        op,
        updatedAt: now()
      });
      appendRelayAudit({
        type: `op.${op.kind}`,
        roomId: roomRecord.id,
        userId: user.id,
        displayName: user.displayName,
        permission,
        bytes: raw.length
      });
      return;
    }

    if (message.type === "doc:text-state") {
      if (!canEditRelayRoom(user, roomRecord)) {
        sendSocket(socket, JSON.stringify({ type: "relay:error", error: "edit_permission_required" }));
        return;
      }
      const state = updateRelayTextState(roomRecord.id, sanitizeRelayText(message.text), {
        fromClientId: clientId,
        fromDisplayName: user.displayName,
        fromPermission: permission
      });
      relayTextState(roomRecord.id, socket, state);
      appendRelayAudit({
        type: "text_state.update",
        roomId: roomRecord.id,
        userId: user.id,
        displayName: user.displayName,
        permission,
        bytes: raw.length
      });
      return;
    }

    if (message.type === "doc:snapshot-frame") {
      if (!canEditRelayRoom(user, roomRecord)) {
        sendSocket(socket, JSON.stringify({ type: "relay:error", error: "edit_permission_required" }));
        return;
      }
      const frame = sanitizeRelayFrame(message.frame || message);
      if (!frame) {
        sendSocket(socket, JSON.stringify({ type: "relay:error", error: "invalid_frame" }));
        return;
      }
      relayFrame(roomRecord.id, socket, {
        type: "relay:frame",
        frameType: "snapshot",
        fromClientId: clientId,
        fromDisplayName: user.displayName,
        fromPermission: permission,
        frame,
        updatedAt: now()
      });
      appendRelayAudit({
        type: "frame.snapshot",
        roomId: roomRecord.id,
        userId: user.id,
        displayName: user.displayName,
        permission,
        bytes: raw.length
      });
    }
  });

  socket.on("close", () => {
    activeRoom.delete(clientId);
    const roomLocks = relayLocks.get(roomRecord.id);
    if (roomLocks) {
      for (const [target, lock] of roomLocks) {
        if (lock.clientId === clientId) {
          roomLocks.delete(target);
        }
      }
      if (roomLocks.size === 0) {
        relayLocks.delete(roomRecord.id);
      }
    }
    appendRelayAudit({
      type: "ws.leave",
      roomId: roomRecord.id,
      userId: user.id,
      displayName: user.displayName,
      permission
    });
    if (activeRoom.size === 0) {
      relayPeers.delete(roomRecord.id);
      clearRelayTimers(roomRecord.id);
    } else {
      scheduleRelayBroadcast(roomRecord.id);
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startServer();
}

function relayParticipants(roomId) {
  const room = relayPeers.get(roomId);
  return room ? [...room.values()].map((entry) => entry.presence) : [];
}

function relayRoomLocks(roomId) {
  const locks = relayLocks.get(roomId);
  return locks ? [...locks.values()] : [];
}

function broadcastRelayRoom(roomId) {
  relayBroadcastTimers.delete(roomId);
  const room = relayPeers.get(roomId);
  if (!room) {
    return;
  }
  const payload = JSON.stringify({
    type: "relay:state",
    users: relayParticipants(roomId),
    locks: relayRoomLocks(roomId)
  });
  for (const entry of room.values()) {
    sendSocket(entry.socket, payload);
  }
}

function scheduleRelayBroadcast(roomId) {
  if (relayBroadcastTimers.has(roomId)) {
    return;
  }
  const timer = setTimeout(() => broadcastRelayRoom(roomId), WS_PRESENCE_BROADCAST_MS);
  timer.unref?.();
  relayBroadcastTimers.set(roomId, timer);
}

function relayFrame(roomId, sourceSocket, payload) {
  const room = relayPeers.get(roomId);
  if (!room) {
    return;
  }
  const text = JSON.stringify(payload);
  for (const entry of room.values()) {
    if (entry.socket === sourceSocket) continue;
    sendSocket(entry.socket, text);
  }
}

function relayTextState(roomId, sourceSocket, state) {
  const room = relayPeers.get(roomId);
  if (!room || !state) {
    return;
  }
  const payload = JSON.stringify({
    type: "relay:text-state",
    fromClientId: state.fromClientId || null,
    fromDisplayName: state.fromDisplayName || "peer",
    fromPermission: state.fromPermission || null,
    text: state.text,
    updatedAt: state.updatedAt
  });
  for (const entry of room.values()) {
    if (entry.socket === sourceSocket) continue;
    sendSocket(entry.socket, payload);
  }
}

function sendRelayTextState(socket, roomId) {
  const state = relayTextStates.get(roomId);
  if (!state) {
    return false;
  }
  return sendSocket(socket, JSON.stringify({
    type: "relay:text-state",
    fromClientId: state.fromClientId || null,
    fromDisplayName: state.fromDisplayName || "peer",
    fromPermission: state.fromPermission || null,
    text: state.text,
    updatedAt: state.updatedAt
  }));
}

function sanitizeRelayText(value) {
  return String(value || "").slice(0, WS_TEXT_STATE_MAX_CHARS);
}

function updateRelayTextState(roomId, text, meta = {}) {
  const cleanText = sanitizeRelayText(text);
  const state = {
    text: cleanText,
    fromClientId: meta.fromClientId || null,
    fromDisplayName: String(meta.fromDisplayName || "peer").slice(0, 120),
    fromPermission: meta.fromPermission || null,
    updatedAt: now()
  };
  if (cleanText) {
    relayTextStates.set(roomId, state);
  } else {
    relayTextStates.delete(roomId);
  }
  return state;
}

function applyRelayOperationToTextState(roomId, op, meta = {}) {
  const current = relayTextStates.get(roomId)?.text || "";
  const offset = Math.max(0, Math.min(current.length, Number(op?.position?.charOffset || 0)));
  if (op?.kind === "text.insert") {
    return updateRelayTextState(roomId, `${current.slice(0, offset)}${op.text}${current.slice(offset)}`, meta);
  }
  if (op?.kind === "text.delete") {
    const count = Math.max(1, Math.min(current.length - offset, Number(op.count || 1) || 1));
    return updateRelayTextState(roomId, `${current.slice(0, offset)}${current.slice(offset + count)}`, meta);
  }
  return relayTextStates.get(roomId) || null;
}

function clearRelayTimers(roomId) {
  const timer = relayBroadcastTimers.get(roomId);
  if (timer) {
    clearTimeout(timer);
    relayBroadcastTimers.delete(roomId);
  }
}

function broadcastRoom(roomKey) {
  roomBroadcastTimers.delete(roomKey);
  const room = rooms.get(roomKey);
  if (!room) {
    return;
  }
  const payload = JSON.stringify({
    type: "presence:state",
    users: [...room.values()].map((entry) => entry.presence)
  });
  for (const entry of room.values()) {
    sendSocket(entry.socket, payload);
  }
}

function scheduleRoomBroadcast(roomKey) {
  if (roomBroadcastTimers.has(roomKey)) {
    return;
  }
  const timer = setTimeout(() => broadcastRoom(roomKey), WS_PRESENCE_BROADCAST_MS);
  timer.unref?.();
  roomBroadcastTimers.set(roomKey, timer);
}

function scheduleDocUpdate(roomKey, payload, sourceSocket) {
  const existing = docUpdateQueues.get(roomKey);
  if (existing) {
    existing.payload = payload;
    existing.sourceSocket = sourceSocket;
    return;
  }
  const entry = {
    payload,
    sourceSocket,
    timer: setTimeout(() => flushDocUpdate(roomKey), WS_DOC_BROADCAST_MS)
  };
  entry.timer.unref?.();
  docUpdateQueues.set(roomKey, entry);
}

function flushDocUpdate(roomKey) {
  const pending = docUpdateQueues.get(roomKey);
  docUpdateQueues.delete(roomKey);
  const room = rooms.get(roomKey);
  if (!room || !pending) {
    return;
  }
  for (const entry of room.values()) {
    if (entry.socket === pending.sourceSocket) continue;
    sendSocket(entry.socket, pending.payload);
  }
}

function clearRoomTimers(roomKey) {
  const presenceTimer = roomBroadcastTimers.get(roomKey);
  if (presenceTimer) {
    clearTimeout(presenceTimer);
    roomBroadcastTimers.delete(roomKey);
  }
  const docTimer = docUpdateQueues.get(roomKey)?.timer;
  if (docTimer) {
    clearTimeout(docTimer);
    docUpdateQueues.delete(roomKey);
  }
}

function sendSocket(socket, payload) {
  if (socket.readyState !== 1) {
    return false;
  }
  if (socket.bufferedAmount > WS_MAX_BUFFERED_BYTES) {
    socket.close(1013, "backpressure");
    return false;
  }
  socket.send(payload);
  return true;
}

function sanitizePoint(value) {
  if (!value) {
    return null;
  }
  const rawX = Number(value.x);
  const rawY = Number(value.y);
  if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) {
    return null;
  }
  const x = Math.max(0, Math.min(100, rawX));
  const y = Math.max(0, Math.min(100, rawY));
  return { x, y };
}

function sanitizeSelection(value) {
  if (!value) {
    return null;
  }
  const rawX = Number(value.x);
  const rawY = Number(value.y);
  const rawW = Number(value.w);
  const rawH = Number(value.h);
  if (![rawX, rawY, rawW, rawH].every(Number.isFinite)) {
    return null;
  }
  return {
    x: Math.max(0, Math.min(100, rawX)),
    y: Math.max(0, Math.min(100, rawY)),
    w: Math.max(1, Math.min(100, rawW)),
    h: Math.max(1, Math.min(100, rawH))
  };
}

function sanitizeViewport(value) {
  if (!value) {
    return null;
  }
  const width = Number(value.width);
  const height = Number(value.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return {
    width: Math.max(1, Math.min(10000, width)),
    height: Math.max(1, Math.min(10000, height))
  };
}

function sanitizeCursorSource(value) {
  return value === "caret" ? "caret" : null;
}

function sanitizeLockTarget(value) {
  const text = String(value || "document").trim().slice(0, 120);
  return text || "document";
}

function sanitizeRelayFrame(value) {
  const format = value?.format === "hwpx" ? "hwpx" : "hwp";
  const dataBase64 = typeof value?.dataBase64 === "string" ? value.dataBase64 : "";
  if (!dataBase64 || dataBase64.length > WS_DOC_UPDATE_LIMIT_BYTES) {
    return null;
  }
  if (!/^[A-Za-z0-9+/=_-]+$/.test(dataBase64)) {
    return null;
  }
  return {
    format,
    dataBase64,
    revision: Number(value?.revision || 0) || 0
  };
}

function sanitizeRelayOperation(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const position = sanitizeOpPosition(value.position);
  if (!position) {
    return null;
  }
  const opId = sanitizeOpId(value.opId);
  const revision = Math.max(0, Math.floor(Number(value.revision || 0) || 0));
  if (value.kind === "text.insert") {
    const text = String(value.text || "").slice(0, 2048);
    if (!text) {
      return null;
    }
    return { kind: "text.insert", position, text, opId, revision };
  }
  if (value.kind === "text.delete") {
    const count = Math.max(1, Math.min(2048, Number(value.count || 1) || 1));
    return { kind: "text.delete", position, count, opId, revision };
  }
  return null;
}

function sanitizeOpPosition(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const sectionIdx = Number(value.sectionIdx ?? value.section ?? value.sectionIndex ?? 0);
  const paraIdx = Number(value.paraIdx ?? value.para ?? value.paraIndex ?? 0);
  const charOffset = Number(value.charOffset ?? value.offset ?? 0);
  if (![sectionIdx, paraIdx, charOffset].every(Number.isFinite)) {
    return null;
  }
  return {
    sectionIdx: Math.max(0, Math.min(10000, Math.floor(sectionIdx))),
    paraIdx: Math.max(0, Math.min(100000, Math.floor(paraIdx))),
    charOffset: Math.max(0, Math.min(1000000, Math.floor(charOffset)))
  };
}

function sanitizeOpId(value) {
  const text = String(value || "").trim().slice(0, 100);
  return text || `op_${Date.now().toString(36)}`;
}

function pickColor(index) {
  const colors = ["#2563eb", "#dc2626", "#059669", "#d97706", "#7c3aed", "#0891b2"];
  return colors[index % colors.length];
}
