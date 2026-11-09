import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, loadConfig, MAX_IMAGE_BYTES, type Config } from "./index";
import { buildPushBody, verifySignature } from "./line";
import { createStore, IMG_NAME, sniffImage } from "./store";
import { parseArgs, parseEnvFile, runSend } from "../scripts/send";

// No test touches the real LINE: pushes go to a LOCAL fake (Bun.serve on a free port) that records what it was sent.
const SECRET = "channel-secret-for-tests";
const TOKEN = "TOKEN-must-never-leak";
const KEY = "send-key-for-tests-0123456789";
const PUBLIC = "https://bot.example.test";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);

let dir: string;
let fake: ReturnType<typeof Bun.serve>;
let lineReplies: { status: number } = { status: 200 };
let seen: { path: string; headers: Record<string, string>; body: any }[] = [];

beforeAll(() => {
  fake = Bun.serve({
    port: 0,
    async fetch(req) {
      seen.push({ path: new URL(req.url).pathname, headers: Object.fromEntries(req.headers), body: await req.json().catch(() => null) });
      return new Response("{}", { status: lineReplies.status });
    },
  });
});
afterAll(() => fake.stop(true));
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bot-"));
  seen = [];
  lineReplies = { status: 200 };
});

const cfg = (o: Partial<Config> = {}): Config => ({
  channelSecret: SECRET,
  accessToken: TOKEN,
  apiBase: `http://127.0.0.1:${fake.port}`,
  sendKey: KEY,
  publicBaseUrl: PUBLIC,
  dataDir: dir,
  port: 0,
  recordMessages: false,
  retentionDays: 90,
  ...o,
});
const sign = (body: string | Uint8Array, secret = SECRET) => createHmac("sha256", secret).update(body).digest("base64");
const hook = (app: ReturnType<typeof createApp>, body: string, sig?: string | null) =>
  app.request("/line/webhook", { method: "POST", body, headers: sig === null ? {} : { "x-line-signature": sig ?? sign(body) } });
const JOIN = (gid = "Cgroup1") => JSON.stringify({ destination: "U1", events: [{ type: "join", timestamp: 1_700_000_000_000, source: { type: "group", groupId: gid }, replyToken: "r" }] });
const send = (app: ReturnType<typeof createApp>, fields: { text?: string | null; images?: { bytes: Uint8Array; name?: string; type?: string }[] } = {}, o: { key?: string | null; dry?: boolean; headers?: Record<string, string> } = {}) => {
  const f = new FormData();
  if (fields.text !== null) f.set("text", fields.text ?? "hello");
  for (const im of fields.images ?? []) f.append("image", new Blob([im.bytes], { type: im.type ?? "image/png" }), im.name ?? "a.png");
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.key !== null) headers.authorization = `Bearer ${o.key ?? KEY}`;
  return app.request(`/send${o.dry ? "?dryRun=1" : ""}`, { method: "POST", body: f, headers });
};
const withGroup = (app: ReturnType<typeof createApp>) => hook(app, JOIN());

describe("the webhook signature", () => {
  test("a valid one is accepted; wrong, missing, another secret, or one changed byte is 401 and stores nothing", async () => {
    const app = createApp(cfg());
    const body = JOIN();
    expect((await hook(app, body)).status).toBe(200);
    for (const [b, s] of [
      [body, "AAAA"],
      [body, null],
      [body, sign(body, "other-secret")],
      [body.replace("Cgroup1", "Cgroup2"), sign(body)], // the body changed by a byte after signing
      [body, ""],
    ] as [string, string | null][]) {
      const r = await hook(createApp(cfg({ dataDir: mkdtempSync(join(tmpdir(), "bot-")) })), b, s);
      expect(r.status).toBe(401);
    }
    const fresh = mkdtempSync(join(tmpdir(), "bot-"));
    await hook(createApp(cfg({ dataDir: fresh })), body.replace("Cgroup1", "Cgroup2"), sign(body));
    expect(existsSync(join(fresh, "group.json"))).toBe(false);
  });
  test("an empty channel secret never verifies (fail closed), even with a signature made with ''", async () => {
    const app = createApp(cfg({ channelSecret: "" }));
    expect((await hook(app, JOIN(), sign(JOIN(), ""))).status).toBe(401);
    expect(verifySignature("", new Uint8Array([1]), "x")).toBe(false);
  });
  test("verifySignature: raw-byte exact, constant-length compare", () => {
    const b = new TextEncoder().encode("héllo");
    expect(verifySignature(SECRET, b, sign(b))).toBe(true);
    expect(verifySignature(SECRET, b, sign(b).slice(0, -2))).toBe(false);
    expect(verifySignature(SECRET, b, null)).toBe(false);
  });
});

describe("the webhook events", () => {
  test("a join into a group stores ONLY the group id and a time; the latest join wins", async () => {
    const app = createApp(cfg());
    await hook(app, JOIN("Cfirst"));
    await hook(app, JOIN("Csecond"));
    const g = JSON.parse(readFileSync(join(dir, "group.json"), "utf8"));
    expect(Object.keys(g).sort()).toEqual(["groupId", "joinedAt"]);
    expect(g.groupId).toBe("Csecond");
    expect(g.joinedAt).toBe("2023-11-14T22:13:20.000Z");
    expect(await (await app.request("/health")).json()).toEqual({ ok: true, groupKnown: true, recording: false });
  });
  test("a message event stores nothing and answers 200; no user id or text reaches the disk", async () => {
    const app = createApp(cfg());
    const body = JSON.stringify({ events: [{ type: "message", source: { type: "group", groupId: "Cg", userId: "Uuser" }, message: { type: "text", text: "secret chat" } }] });
    expect((await hook(app, body)).status).toBe(200);
    expect(readdirSync(dir)).toEqual([]);
  });
  test("a join into a room or a 1:1 chat is ignored; the LINE 'verify' call (no events) is 200", async () => {
    const app = createApp(cfg());
    const room = JSON.stringify({ events: [{ type: "join", source: { type: "room", roomId: "R" } }] });
    expect((await hook(app, room)).status).toBe(200);
    expect((await hook(app, JSON.stringify({ events: [] }))).status).toBe(200);
    expect(existsSync(join(dir, "group.json"))).toBe(false);
    expect(await (await app.request("/health")).json()).toEqual({ ok: true, groupKnown: false, recording: false });
  });
  test("a signed body that is not JSON is 400", async () => {
    expect((await hook(createApp(cfg()), "not json")).status).toBe(400);
  });
  test("an oversize webhook body is refused", async () => {
    const big = "x".repeat(1_000_001);
    expect((await hook(createApp(cfg()), big)).status).toBe(413);
  });
});

describe("POST /send — the gate and the validation", () => {
  test("no key / a wrong key / an empty SEND_KEY: 401, and nothing is pushed", async () => {
    const app = createApp(cfg());
    await withGroup(app);
    expect((await send(app, {}, { key: null })).status).toBe(401);
    expect((await send(app, {}, { key: "wrong" })).status).toBe(401);
    expect((await send(app, {}, { key: KEY + "x" })).status).toBe(401);
    const open = createApp(cfg({ sendKey: "" }));
    expect((await send(open, {}, { key: "" })).status).toBe(401);
    expect((await send(open, {}, { key: "anything" })).status).toBe(401);
    expect(seen).toEqual([]);
  });
  test("text: required, not blank, at most 4000 characters (4000 ok, 4001 not; Thai ok)", async () => {
    const app = createApp(cfg());
    await withGroup(app);
    expect((await send(app, { text: null })).status).toBe(400);
    expect((await send(app, { text: "   " })).status).toBe(400);
    expect((await send(app, { text: "ก".repeat(4000) })).status).toBe(200);
    expect((await send(app, { text: "ก".repeat(4001) })).status).toBe(400);
  });
  test("images: 3 ok, 4 is 400; over 1 MB, a wrong type, a fake extension and an empty file are 400", async () => {
    const app = createApp(cfg());
    await withGroup(app);
    const im = { bytes: PNG };
    expect((await send(app, { images: [im, im, im] })).status).toBe(200);
    expect((await send(app, { images: [im, im, im, im] })).status).toBe(400);
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    big.set(PNG);
    expect((await send(app, { images: [{ bytes: big }] })).status).toBe(400);
    const edge = new Uint8Array(MAX_IMAGE_BYTES);
    edge.set(PNG);
    expect((await send(app, { images: [{ bytes: edge }] })).status).toBe(200); // exactly 1 MB is in
    expect((await send(app, { images: [{ bytes: new TextEncoder().encode("GIF89a....") , name: "a.png", type: "image/png" }] })).status).toBe(400);
    expect((await send(app, { images: [{ bytes: PNG, name: "a.gif", type: "image/gif" }] })).status).toBe(200); // the BYTES decide, not the name
    expect((await send(app, { images: [{ bytes: new Uint8Array(0), name: "e.png" }] })).status).toBe(400);
    const r = await send(app, { images: [{ bytes: new TextEncoder().encode("<svg/>"), name: "a.png" }] });
    expect(r.status).toBe(400);
  });
  test("sniffImage reads the real format from the first bytes", () => {
    expect(sniffImage(JPEG)).toBe("jpg");
    expect(sniffImage(PNG)).toBe("png");
    expect(sniffImage(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(sniffImage(new TextEncoder().encode("GIF89a"))).toBeNull();
  });
});

describe("POST /send — the states", () => {
  test("NO_GROUP (409) before any join; nothing pushed, no image saved", async () => {
    const app = createApp(cfg());
    const r = await send(app, { images: [{ bytes: PNG }] });
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("NO_GROUP");
    expect(seen).toEqual([]);
    expect(existsSync(join(dir, "img"))).toBe(false);
  });
  test("NOT_CONFIGURED (503) when LINE_API_BASE or the token is empty — and NO outside call is made", async () => {
    for (const o of [{ apiBase: "" }, { accessToken: "" }]) {
      const app = createApp(cfg(o));
      await withGroup(app);
      const r = await send(app);
      expect(r.status).toBe(503);
      expect((await r.json()).error.code).toBe("NOT_CONFIGURED");
    }
    const noPublic = createApp(cfg({ publicBaseUrl: "" }));
    await withGroup(noPublic);
    expect((await send(noPublic, { images: [{ bytes: PNG }] })).status).toBe(503); // images need an image URL
    expect((await send(noPublic)).status).toBe(200); // text only does not
    expect(seen.length).toBe(1);
  });
  test("an unconfigured bot (the default env) can never reach out: loadConfig({}) has an empty apiBase", async () => {
    const c = loadConfig({});
    expect(c.apiBase).toBe("");
    expect(c.port).toBe(3100);
    expect(c.dataDir).toBe("./data");
    expect(loadConfig({ LINE_API_BASE: "https://api.line.me///" }).apiBase).toBe("https://api.line.me");
  });
  test("dryRun: 200 {dryRun, body}, sends nothing and writes no image — even before configuration", async () => {
    const app = createApp(cfg({ apiBase: "", accessToken: "" }));
    const r = await send(app, { text: "สวัสดี", images: [{ bytes: PNG }] }, { dry: true });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.dryRun).toBe(true);
    expect(j.body.to).toBeNull(); // no group yet
    expect(j.body.messages[0]).toEqual({ type: "text", text: "สวัสดี" });
    expect(j.body.messages[1].type).toBe("image");
    expect(j.body.messages[1].originalContentUrl).toStartWith(`${PUBLIC}/img/`);
    expect(seen).toEqual([]);
    expect(existsSync(join(dir, "img"))).toBe(false);
    await withGroup(app);
    expect((await (await send(app, {}, { dry: true })).json()).body.to).toBe("Cgroup1");
  });
  test("dryRun still validates (a bad key is 401, a bad image 400)", async () => {
    const app = createApp(cfg());
    expect((await send(app, {}, { dry: true, key: "nope" })).status).toBe(401);
    expect((await send(app, { images: [{ bytes: new Uint8Array([1, 2, 3]) }] }, { dry: true })).status).toBe(400);
  });
});

describe("POST /send — the push", () => {
  test("0 / 1 / 3 images: the body shape LINE gets, the headers, the retry key", async () => {
    const app = createApp(cfg());
    await withGroup(app);
    for (const n of [0, 1, 3]) {
      seen = [];
      const r = await send(app, { text: "Release v1.2", images: Array.from({ length: n }, () => ({ bytes: JPEG, name: "p.jpg", type: "image/jpeg" })) });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ sent: true, messages: 1 + n });
      expect(seen.length).toBe(1);
      const s = seen[0]!;
      expect(s.path).toBe("/v2/bot/message/push");
      expect(s.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(s.headers["x-line-retry-key"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(s.body.to).toBe("Cgroup1");
      expect(s.body.messages.length).toBe(1 + n);
      expect(s.body.messages[0]).toEqual({ type: "text", text: "Release v1.2" });
      for (const m of s.body.messages.slice(1)) {
        expect(m.type).toBe("image");
        expect(m.originalContentUrl).toBe(m.previewImageUrl);
        expect(m.originalContentUrl).toMatch(new RegExp(`^${PUBLIC}/img/[0-9a-f]{32}\\.jpg$`));
      }
    }
  });
  test("each call gets a NEW retry key; a caller-supplied valid UUID is passed through (so a retried send posts once)", async () => {
    const app = createApp(cfg());
    await withGroup(app);
    await send(app);
    await send(app);
    expect(seen[0]!.headers["x-line-retry-key"]).not.toBe(seen[1]!.headers["x-line-retry-key"]);
    const K = "123e4567-e89b-42d3-a456-426614174000";
    seen = [];
    await send(app, {}, { headers: { "x-line-retry-key": K } });
    expect(seen[0]!.headers["x-line-retry-key"]).toBe(K);
    seen = [];
    await send(app, {}, { headers: { "x-line-retry-key": "not-a-uuid" } });
    expect(seen[0]!.headers["x-line-retry-key"]).not.toBe("not-a-uuid");
  });
  test("the saved images are served at the URLs sent to LINE (the right type), and only those", async () => {
    const app = createApp(cfg());
    await withGroup(app);
    await send(app, { images: [{ bytes: JPEG, name: "a.jpg", type: "image/jpeg" }, { bytes: PNG }] });
    const urls: string[] = seen[0]!.body.messages.slice(1).map((m: any) => m.originalContentUrl);
    const types = [];
    for (const u of urls) {
      const r = await app.request(new URL(u).pathname);
      expect(r.status).toBe(200);
      types.push(r.headers.get("content-type"));
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect(types).toEqual(["image/jpeg", "image/png"]);
    expect(readdirSync(join(dir, "img")).length).toBe(2);
  });
  test("a LINE error is 502 with LINE's status only — no token, no LINE body; the saved images are removed", async () => {
    const app = createApp(cfg());
    await withGroup(app);
    lineReplies = { status: 429 };
    const r = await send(app, { images: [{ bytes: PNG }] });
    expect(r.status).toBe(502);
    const t = await r.text();
    expect(JSON.parse(t).error).toEqual({ code: "LINE_ERROR", message: "LINE refused the push", lineStatus: 429 });
    expect(t).not.toContain(TOKEN);
    expect(readdirSync(join(dir, "img"))).toEqual([]);
  });
  test("an unreachable LINE is 502 with lineStatus null", async () => {
    const app = createApp(cfg({ apiBase: "http://127.0.0.1:1" }));
    await withGroup(app);
    const r = await send(app);
    expect(r.status).toBe(502);
    expect((await r.json()).error.lineStatus).toBeNull();
  });
  test("buildPushBody: text first, then the images", () => {
    expect(buildPushBody("G", "t", ["u1", "u2"]).messages.map((m) => m.type)).toEqual(["text", "image", "image"]);
  });
});

describe("GET /img/:name — only the random names, no traversal", () => {
  test("refuses ../, encoded traversal, a non-hex name, a wrong length, a wrong extension, upper case, a missing file", async () => {
    const app = createApp(cfg());
    mkdirSync(join(dir, "img"), { recursive: true });
    writeFileSync(join(dir, "group.json"), "{}");
    writeFileSync(join(dir, "secret.txt"), "top secret");
    const ok = "a".repeat(32);
    writeFileSync(join(dir, "img", `${ok}.png`), PNG);
    for (const n of ["..%2Fgroup.json", "..%2f..%2fsecret.txt", "../group.json", "%2e%2e%2fsecret.txt", `${"g".repeat(32)}.png`, `${ok}.gif`, `${ok}.png.txt`, `${"a".repeat(31)}.png`, `${"A".repeat(32)}.png`, `${ok}.PNG`, `${"b".repeat(32)}.png`, "group.json", "..%5Cgroup.json"]) {
      const r = await app.request(`/img/${n}`);
      expect(r.status).toBe(404);
      expect(await r.text()).not.toContain("top secret");
    }
    expect((await app.request(`/img/${ok}.png`)).status).toBe(200);
    expect(IMG_NAME.test(`${ok}.jpeg`)).toBe(true);
  });
});

describe("hardening pins (from the mutation run)", () => {
  test("IMG_NAME is anchored at both ends, lower-case hex only, jpg/jpeg/png only", () => {
    const h = "a".repeat(32);
    for (const bad of [`x/${h}.png`, `../${h}.png`, `..\${h}.png`, `${h}.png/x`, `${h}.png
`, ` ${h}.png`, `${"A".repeat(32)}.png`, `${h}.gif`, `${h}.PNG`, `${h}.svg`]) expect(IMG_NAME.test(bad)).toBe(false);
    for (const good of [`${h}.png`, `${h}.jpg`, `${h}.jpeg`]) expect(IMG_NAME.test(good)).toBe(true);
  });
  test("a file on disk under an upper-case or .gif name is still not served", async () => {
    const app = createApp(cfg());
    mkdirSync(join(dir, "img"), { recursive: true });
    for (const n of [`${"A".repeat(32)}.png`, `${"c".repeat(32)}.gif`]) {
      writeFileSync(join(dir, "img", n), PNG);
      expect((await app.request(`/img/${n}`)).status).toBe(404);
    }
  });
  test("sniffImage needs the WHOLE signature (JPEG FF D8 FF; PNG all 8 bytes)", () => {
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0x00]))).toBeNull();
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]))).toBeNull();
  });
  test("saved image names are random: 60 saves, 60 different names, 32 hex each (not a repeated byte)", () => {
    const st = createStore(dir);
    const names = Array.from({ length: 60 }, () => st.saveImage(PNG, "png"));
    expect(new Set(names).size).toBe(60);
    for (const n of names) {
      expect(IMG_NAME.test(n)).toBe(true);
      expect(n.slice(0, 2).repeat(16)).not.toBe(n.slice(0, 32));
    }
  });
  test("a join from a room or a user that happens to carry a groupId is not a group join", async () => {
    const app = createApp(cfg());
    for (const type of ["room", "user"]) {
      const body = JSON.stringify({ events: [{ type: "join", source: { type, groupId: "Cx" } }] });
      expect((await hook(app, body)).status).toBe(200);
    }
    expect(existsSync(join(dir, "group.json"))).toBe(false);
  });
  test("a webhook that DECLARES a body over 1 MB is refused before it is read", async () => {
    const r = await createApp(cfg()).request("/line/webhook", { method: "POST", body: "{}", headers: { "content-length": "5000000", "x-line-signature": sign("{}") } });
    expect(r.status).toBe(413);
  });
});

describe("/health, errors, secrets", () => {
  test("/health has no secret and no group id", async () => {
    const app = createApp(cfg());
    await withGroup(app);
    const t = await (await app.request("/health")).text();
    expect(JSON.parse(t)).toEqual({ ok: true, groupKnown: true, recording: false });
    for (const s of [SECRET, TOKEN, KEY, "Cgroup1"]) expect(t).not.toContain(s);
  });
  test("an unknown route is a JSON 404", async () => {
    const r = await createApp(cfg()).request("/nope");
    expect(r.status).toBe(404);
    expect((await r.json()).error.code).toBe("NOT_FOUND");
  });
  test("the source never logs a request body, a key or a token (no console.log of them)", () => {
    const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8") + readFileSync(join(import.meta.dir, "line.ts"), "utf8");
    const logs = src.split("\n").filter((l) => /console\.(log|error|warn|info)/.test(l)).map((l) => l.replace(/\s\/\/.*$/, "")); // the code part, not a trailing comment
    expect(logs.length).toBeGreaterThan(0);
    for (const l of logs) expect(l).not.toMatch(/token|key|secret|body|text|raw/i);
  });
  test("the repo ignores .env, .env.send and data/, and .env.example lists every key the code reads", () => {
    const root = join(import.meta.dir, "..");
    const gi = readFileSync(join(root, ".gitignore"), "utf8").split(/\r?\n/);
    for (const g of [".env", ".env.send", "data/"]) expect(gi).toContain(g);
    const ex = readFileSync(join(root, ".env.example"), "utf8");
    const used = [...readFileSync(join(import.meta.dir, "index.ts"), "utf8").matchAll(/env\.([A-Z_]+)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThanOrEqual(7);
    for (const k of new Set(used)) expect(ex).toMatch(new RegExp(`^${k}=`, "m"));
    // one explanatory comment line above every key
    const lines = ex.split(/\r?\n/);
    lines.forEach((l, i) => { if (/^[A-Z_]+=/.test(l)) expect(lines[i - 1]).toMatch(/^# /); });
  });
});

describe("scripts/send.ts", () => {
  const env = { BOT_URL: "http://bot.test/", SEND_KEY: KEY };
  test("parseArgs / parseEnvFile", () => {
    expect(parseArgs(["--text", "n.txt", "--img", "a.png", "--img", "b.png", "--dry-run"])).toEqual({ text: "n.txt", imgs: ["a.png", "b.png"], dryRun: true });
    expect(parseArgs([]).error).toContain("--text");
    expect(parseArgs(["--text", "n", "--bogus"]).error).toContain("--bogus");
    expect(parseEnvFile("# c\nBOT_URL=http://x\nSEND_KEY=\"k\"\n")).toEqual({ BOT_URL: "http://x", SEND_KEY: "k" });
  });
  test("it posts multipart with the key to /send (?dryRun=1 with --dry-run) and never prints the key", async () => {
    const app = createApp(cfg());
    await withGroup(app);
    const files: Record<string, Uint8Array | string> = { "n.txt": "ข่าวใหม่ v2", "a.png": PNG };
    for (const dry of [true, false]) {
      const calls: string[] = [];
      const r = await runSend(["--text", "n.txt", "--img", "a.png", ...(dry ? ["--dry-run"] : [])], env, (u, i) => (calls.push(u), app.request(new URL(u).pathname + new URL(u).search, i)), (p) => files[p]!);
      expect(r.code).toBe(0);
      expect(calls[0]).toBe(`http://bot.test/send${dry ? "?dryRun=1" : ""}`);
      expect(r.out).toContain(dry ? '"dryRun":true' : '"sent":true');
      expect(r.out).not.toContain(KEY);
      if (dry) expect(r.out).toContain("ข่าวใหม่ v2");
    }
  });
  test("ONE retry key per send: printed, sent as X-Line-Retry-Key, reused by --retry-key, and LINE sees the same key twice", async () => {
    const app = createApp(cfg());
    await withGroup(app);
    const read = (p: string) => (p === "n.txt" ? "note" : PNG);
    const f = (u: string, i?: RequestInit) => app.request(new URL(u).pathname + new URL(u).search, i);
    seen = [];
    const first = await runSend(["--text", "n.txt"], env, f, read);
    const key = /retry-key: ([0-9a-f-]{36})/.exec(first.out)?.[1];
    expect(key).toMatch(/^[0-9a-f]{8}-/);
    const second = await runSend(["--text", "n.txt", "--retry-key", key!], env, f, read);
    expect(second.out).toContain(`retry-key: ${key}`);
    expect(seen.map((s) => s.headers["x-line-retry-key"])).toEqual([key!, key!]); // the same key both times
    const third = await runSend(["--text", "n.txt"], env, f, read); // a fresh send gets a fresh key
    expect(third.out).not.toContain(key!);
    expect(seen[2]!.headers["x-line-retry-key"]).not.toBe(key);
    expect(first.out).not.toContain(KEY);
    expect(first.out).not.toContain("re-run"); // the hint is only for a failure
  });
  test("a timeout or any non-200 prints the key and the re-run hint; a bad --retry-key is refused", async () => {
    const K = "123e4567-e89b-42d3-a456-426614174000";
    const timeout = await runSend(["--text", "n.txt", "--retry-key", K], env, () => { throw new Error("timeout"); }, () => "x");
    expect(timeout.code).toBe(1);
    expect(timeout.out).toContain(`re-run with --retry-key ${K}; do not change the text or images`);
    const down = await runSend(["--text", "n.txt"], env, async () => new Response("no", { status: 502 }), () => "x");
    expect(down.code).toBe(1);
    expect(down.out.split("\n")).toEqual(["502 no", expect.stringMatching(/^retry-key: [0-9a-f-]{36}$/), expect.stringMatching(/^re-run with --retry-key [0-9a-f-]{36}; do not change the text or images$/)]);
    expect((await runSend(["--text", "n.txt", "--retry-key", "nope"], env, fetch, () => "x")).code).toBe(2);
    expect(parseArgs(["--text", "n", "--retry-key", K]).retryKey).toBe(K);
  });
  test("a missing .env.send value or a refusal is a non-zero exit with a message", async () => {
    expect((await runSend(["--text", "n.txt"], {}, fetch, () => "x")).code).toBe(2);
    const app = createApp(cfg());
    const r = await runSend(["--text", "n.txt"], { BOT_URL: "http://b", SEND_KEY: "wrong" }, (u, i) => app.request(new URL(u).pathname, i), () => "x");
    expect(r.code).toBe(1);
    expect(r.out).toStartWith("401");
  });
});

afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
});
