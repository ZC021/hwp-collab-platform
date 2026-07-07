const baseUrl = (process.env.STRESS_BASE_URL || process.env.SMOKE_BASE_URL || "http://127.0.0.1:8170").replace(/\/+$/, "");

function valueArg(name, fallback) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const clients = Math.max(1, Number(valueArg("clients", "12")) || 12);
const rounds = Math.max(1, Number(valueArg("messages", "8")) || 8);
const concurrency = Math.max(1, Number(valueArg("concurrency", "6")) || 6);
const profile = valueArg("profile", "local-no-share-smoke");

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(options.body && !options.headers?.["content-type"] ? { "content-type": "application/json" } : {})
    },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
  });
  const text = await response.text();
  const body = text && (response.headers.get("content-type") || "").includes("application/json") ? JSON.parse(text) : text ? { message: text } : null;
  return { response, body };
}

function sessionCookie(response) {
  return (response.headers.get("set-cookie") || "").split(";")[0];
}

async function createSession(index) {
  const { response, body } = await request("/api/me", {
    headers: {
      "x-hwp-collab-user-email": `stress-${index}@example.local`,
      "x-hwp-collab-user-name": `Stress ${index}`
    }
  });
  const cookie = sessionCookie(response);
  assert(response.status === 200 && body?.user?.id && cookie, `session_${index}_failed_${response.status}`);
  return { index, cookie, headers: { cookie }, user: body.user };
}

async function runLimited(items, worker) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(workers);
}

const health = await request("/api/health");
assert(health.response.status === 200 && health.body?.ok, `health_failed_${health.response.status}`);
const config = await request("/api/config");
assert(config.response.status === 200, `config_failed_${config.response.status}`);
assert(config.body?.authMode === "local-only", `auth_mode_${config.body?.authMode}`);
assert(config.body?.sharingEnabled === false, "sharing_not_disabled");

const sessions = await Promise.all(Array.from({ length: clients }, (_, index) => createSession(index)));
let disabledShareChecks = 0;
let legacyChecks = 0;

await runLimited(
  Array.from({ length: rounds * sessions.length }, (_, index) => ({
    round: Math.floor(index / sessions.length),
    session: sessions[index % sessions.length]
  })),
  async ({ round, session }) => {
    const me = await request("/api/me", { headers: session.headers });
    assert(me.response.status === 200 && me.body?.user?.id === session.user.id, `me_failed_${session.index}_${round}_${me.response.status}`);
    const relay = await request("/api/relay/rooms", {
      method: "POST",
      headers: session.headers,
      body: { title: `blocked-${session.index}-${round}` }
    });
    assert(relay.response.status === 410 && relay.body?.error === "sharing_disabled", `relay_not_disabled_${relay.response.status}`);
    disabledShareChecks += 1;
    const legacy = await request("/api/documents", { headers: session.headers });
    assert(legacy.response.status === 410, `legacy_not_disabled_${legacy.response.status}`);
    legacyChecks += 1;
  }
);

console.log(JSON.stringify({
  ok: true,
  profile,
  baseUrl,
  clients,
  rounds,
  concurrency,
  disabledShareChecks,
  legacyChecks,
  buildId: health.body.buildId
}, null, 2));
