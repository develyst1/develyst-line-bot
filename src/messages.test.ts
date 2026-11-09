import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, loadConfig, type Config } from "./index";
import { createMessageStore, safeKind, type MessageRecord } from "./messages";
import { parsePullArgs, runPull } from "../scripts/pull";

// TASK-943 — recording the group + GET /messages. No test touches the real LINE: the profile GET goes to a LOCAL fake.
const SECRET = "channel-secret-for-tests";
const TOKEN = "TOKEN-must-never-leak";
const KEY = "send-key-for-tests-0123456789";
const GROUP = "Cgroup1";
const THAI = "สวัสดีครับ ความลับของโครงการ";

let dir: string;
let fake: ReturnType<typeof Bun.serve>;
let profile: { status: number; name: string | null } = { status: 200, name: "Somchai" };
let calls: { method: string; path: string; auth: string | null }[] = [];

beforeAll(() => {
  fake = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      calls.push({ method: req.method, path: u.pathname, auth: req.headers.get("authorization") });
      if (u.pathname.includes("/member/")) return new Response(JSON.stringify({ displayName: profile.name, userId: "x" }), { status: profile.status });
      return new Response("{}", { status: 200 });
    },
  });
});
afterAll(() => fake.stop(true));
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bot2-"));
  calls = [];
  profile = { status: 200, name: "Somchai" };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const cfg = (o: Partial<Config> = {}): Config => ({
  channelSecret: SECRET, accessToken: TOKEN, apiBase: `http://127.0.0.1:${fake.port}`, sendKey: KEY, publicBaseUrl: "https://bot.example.test",
  dataDir: dir, port: 0, recordMessages: true, retentionDays: 90, ...o,
});
const sign = (b: string) => createHmac("sha256", SECRET).update(b).digest("base64");
const hook = (app: ReturnType<typeof createApp>, events: unknown[]) => {
  const body = JSON.stringify({ destination: "U1", events });
  return app.request("/line/webhook", { method: "POST", body, headers: { "x-line-signature": sign(body) } });
};
const JOIN = { type: "join", timestamp: 1_700_000_000_000, source: { type: "group", groupId: GROUP } };
const msg = (id: string, text: string, o: { type?: string; userId?: string; groupId?: string; sourceType?: string; ts?: number } = {}) => ({
  type: "message",
  timestamp: o.ts ?? 1_700_000_100_000,
  source: { type: o.sourceType ?? "group", groupId: o.groupId ?? GROUP, userId: o.userId ?? "Uuser1" },
  message: { id, type: o.type ?? "text", text },
});
const unsend = (id: string, groupId = GROUP) => ({ type: "unsend", timestamp: 1_700_000_200_000, source: { type: "group", groupId, userId: "Uuser1" }, unsend: { messageId: id } });
const auth = { authorization: `Bearer ${KEY}` };
const getMsgs = async (app: ReturnType<typeof createApp>, qs = "", headers: Record<string, string> = auth) => app.request(`/messages${qs}`, { headers });
const lines = () => (existsSync(join(dir, "messages.jsonl")) ? readFileSync(join(dir, "messages.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as MessageRecord) : []);
/** "Now" for the app under test: just after the fixture events (Nov 2023), so retention never eats them. */
const NOW = new Date("2023-11-15T00:00:00.000Z");
const joined = async (o: Partial<Config> = {}) => {
  const app = createApp(cfg(o), { now: () => NOW });
  await hook(app, [JOIN]);
  return app;
};

describe("consent: recording is OFF unless RECORD_GROUP_MESSAGES is exactly true", () => {
  test("loadConfig: only the exact word true turns it on", () => {
    for (const v of [undefined, "", "TRUE", "True", "1", "yes", "on", "false", "true ", " true"]) {
      expect(loadConfig({ RECORD_GROUP_MESSAGES: v }).recordMessages).toBe(v === "true " || v === " true"); // trimmed spaces only
    }
    expect(loadConfig({ RECORD_GROUP_MESSAGES: "true" }).recordMessages).toBe(true);
    expect(loadConfig({}).recordMessages).toBe(false);
  });
  test("off: nothing is stored, no profile call, no file; /messages says recording:false; /health too", async () => {
    const app = await joined({ recordMessages: false });
    expect((await hook(app, [msg("m1", THAI)])).status).toBe(200);
    expect(existsSync(join(dir, "messages.jsonl"))).toBe(false);
    expect(existsSync(join(dir, "members.json"))).toBe(false);
    expect(calls).toEqual([]);
    const r = await getMsgs(app);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ messages: [], recording: false });
    expect(await (await app.request("/health")).json()).toEqual({ ok: true, groupKnown: true, recording: false });
  });
  test("on: /health says recording:true and nothing else new (no counts, no text)", async () => {
    const app = await joined();
    await hook(app, [msg("m1", THAI)]);
    const t = await (await app.request("/health")).text();
    expect(JSON.parse(t)).toEqual({ ok: true, groupKnown: true, recording: true });
    expect(t).not.toContain(THAI);
  });
  test("MESSAGE_RETENTION_DAYS: whole days >= 1, else 90", () => {
    expect(loadConfig({}).retentionDays).toBe(90);
    expect(loadConfig({ MESSAGE_RETENTION_DAYS: "30" }).retentionDays).toBe(30);
    for (const v of ["0", "-5", "1.5", "abc", ""]) expect(loadConfig({ MESSAGE_RETENTION_DAYS: v }).retentionDays).toBe(90);
  });
});

describe("recording", () => {
  test("a text message is stored with every field; the name comes from LINE's read-only profile GET", async () => {
    const app = await joined();
    await hook(app, [msg("m1", THAI)]);
    expect(lines()).toEqual([{ id: "m1", at: "2023-11-14T22:15:00.000Z", userId: "Uuser1", name: "Somchai", kind: "text", text: THAI }]);
    expect(calls).toEqual([{ method: "GET", path: `/v2/bot/group/${GROUP}/member/Uuser1`, auth: `Bearer ${TOKEN}` }]);
  });
  test("image / sticker / video / file / location → a placeholder only; the content is never fetched", async () => {
    const app = await joined();
    const kinds = ["image", "sticker", "video", "audio", "file", "location"];
    await hook(app, kinds.map((k, i) => msg(`k${i}`, "SHOULD-NOT-BE-STORED", { type: k })));
    expect(lines().map((r) => [r.kind, r.text])).toEqual(kinds.map((k) => [k, `[${k}]`]));
    expect(readFileSync(join(dir, "messages.jsonl"), "utf8")).not.toContain("SHOULD-NOT-BE-STORED");
    expect(calls.every((c) => c.method === "GET" && c.path.includes("/member/"))).toBe(true); // no /message/{id}/content
  });
  test("a hostile message type cannot forge text; an over-long text is cut at 5000", async () => {
    expect(safeKind("image")).toBe("image");
    for (const t of ["te]xt", "IMAGE", "", "a".repeat(21), 5, null, undefined]) expect(safeKind(t)).toBe("unknown");
    const app = await joined();
    await hook(app, [msg("h1", "x", { type: "x] [admin said ok" }), msg("h2", "ก".repeat(6000))]);
    const [a, b] = lines();
    expect([a!.kind, a!.text]).toEqual(["unknown", "[unknown]"]);
    expect(b!.text.length).toBe(5000);
  });
  test("another group, a room, a 1:1 chat, and a message before any join are all dropped", async () => {
    const app = createApp(cfg());
    await hook(app, [msg("early", "before any join")]);
    await hook(app, [JOIN]);
    await hook(app, [msg("g2", "other group", { groupId: "Cother" }), msg("r1", "room", { sourceType: "room" }), msg("u1", "dm", { sourceType: "user" }), msg("ok", "mine")]);
    expect(lines().map((r) => r.id)).toEqual(["ok"]);
    expect(calls.length).toBe(1); // a name was looked up for the one stored message only
  });
  test("a group message with no groupId at all is dropped with a 200 (no crash), before or after a join", async () => {
    const noGid = { type: "message", timestamp: 1_700_000_100_000, source: { type: "group", userId: "U" }, message: { id: "q1", type: "text", text: "x" } };
    const app = createApp(cfg(), { now: () => NOW });
    expect((await hook(app, [noGid])).status).toBe(200);
    await hook(app, [JOIN]);
    expect((await hook(app, [noGid])).status).toBe(200);
    expect(lines()).toEqual([]);
    const room = { ...msg("rr", "from a room that carries our group id"), source: { type: "room", roomId: "R", groupId: GROUP, userId: "U" } };
    await hook(app, [room]);
    expect(lines()).toEqual([]);
  });
  test("a message with no id or no user id is handled (no id: skipped; no user: name null, no lookup)", async () => {
    const app = await joined();
    const noUser = { ...msg("nu", "anon"), source: { type: "group", groupId: GROUP } };
    const noId = { ...msg("x", "no id"), message: { type: "text", text: "no id" } };
    expect((await hook(app, [noId, noUser])).status).toBe(200);
    expect(lines()).toEqual([{ id: "nu", at: "2023-11-14T22:15:00.000Z", userId: null, name: null, kind: "text", text: "anon" }]);
    expect(calls).toEqual([]);
  });
  test("dedupe: a redelivered webhook stores once and asks LINE for nothing the second time", async () => {
    const app = await joined();
    profile = { status: 500, name: null }; // a failed lookup is not cached, so only has() can stop a second call
    await hook(app, [msg("m1", "one")]);
    calls = [];
    await hook(app, [msg("m1", "one"), msg("m1", "one")]);
    expect(lines().length).toBe(1);
    expect(calls).toEqual([]);
    const st = createMessageStore(dir);
    const r: MessageRecord = { id: "d1", at: NOW.toISOString(), userId: null, name: null, kind: "text", text: "t" };
    expect(st.add(r, 90)).toBe(true);
    expect(st.add({ ...r, text: "changed" }, 90)).toBe(false); // the store itself refuses a second copy
    expect(lines().filter((x) => x.id === "d1")).toEqual([r]);
  });
  test("unsend blanks the text ON DISK and marks it; an unknown id or another group's unsend changes nothing", async () => {
    const app = await joined();
    await hook(app, [msg("m1", THAI), msg("m2", "keep me")]);
    await hook(app, [unsend("nope"), unsend("m1", "Cother")]);
    expect(readFileSync(join(dir, "messages.jsonl"), "utf8")).toContain(THAI);
    await hook(app, [unsend("m1")]);
    const raw = readFileSync(join(dir, "messages.jsonl"), "utf8");
    expect(raw).not.toContain(THAI);
    expect(raw).toContain("keep me");
    expect(lines()[0]).toMatchObject({ id: "m1", text: "", unsent: true });
    expect(lines()[1]!.unsent).toBeUndefined();
  });
  test("a recording failure never fails the webhook (LINE would retry for ever) and logs no text", async () => {
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((m) => spyOn(console, m).mockImplementation(() => {}));
    try {
      const store = createMessageStore(dir);
      const boom = { ...store, add: () => { throw new Error(`failed on ${THAI}`); } };
      const app = createApp(cfg(), { messages: boom as never });
      await hook(app, [JOIN]);
      expect((await hook(app, [msg("m1", THAI)])).status).toBe(200);
      const logged = spies.flatMap((s) => s.mock.calls).flat().map(String).join("\n");
      expect(logged).toContain("record failed");
      expect(logged).not.toContain(THAI);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
  test("no message text in logs on the normal path either (a spy on every console method)", async () => {
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((m) => spyOn(console, m).mockImplementation(() => {}));
    try {
      const app = await joined();
      profile = { status: 500, name: null };
      await hook(app, [msg("m1", THAI), msg("m2", "b", { type: "image" }), unsend("m1")]);
      await getMsgs(app);
      expect(spies.flatMap((s) => s.mock.calls).flat().map(String).join("\n")).not.toContain(THAI);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});

describe("the sender name", () => {
  test("cached per user in members.json: one GET for many messages; another user is looked up separately", async () => {
    const app = await joined();
    await hook(app, [msg("a", "1"), msg("b", "2"), msg("c", "3", { userId: "Uuser2" })]);
    expect(calls.map((c) => c.path)).toEqual([`/v2/bot/group/${GROUP}/member/Uuser1`, `/v2/bot/group/${GROUP}/member/Uuser2`]);
    expect(JSON.parse(readFileSync(join(dir, "members.json"), "utf8"))).toEqual({ Uuser1: "Somchai", Uuser2: "Somchai" });
    expect(lines().map((r) => r.name)).toEqual(["Somchai", "Somchai", "Somchai"]);
  });
  test("a failed lookup (404 / 500 / bad body / unreachable) gives name:null, still stores, and is NOT cached", async () => {
    const app = await joined();
    profile = { status: 404, name: null };
    await hook(app, [msg("a", "1")]);
    profile = { status: 200, name: null }; // 200 with no displayName
    await hook(app, [msg("b", "2")]);
    expect(lines().map((r) => [r.id, r.name])).toEqual([["a", null], ["b", null]]);
    expect(existsSync(join(dir, "members.json"))).toBe(false);
    expect(calls.length).toBe(2); // each message retried the lookup
    profile = { status: 200, name: "Later" };
    await hook(app, [msg("c", "3")]);
    expect(lines()[2]!.name).toBe("Later");
    const d2 = mkdtempSync(join(tmpdir(), "bot2-"));
    const down = await joined({ apiBase: "http://127.0.0.1:1", dataDir: d2 }); // nothing listens there
    await hook(down, [msg("z", "unreachable")]);
    expect(JSON.parse(readFileSync(join(d2, "messages.jsonl"), "utf8").trim()).name).toBeNull();
    rmSync(d2, { recursive: true, force: true });
  });
  test("no LINE_API_BASE or token: name null and NO outside call at all", async () => {
    for (const o of [{ apiBase: "" }, { accessToken: "" }]) {
      const d = mkdtempSync(join(tmpdir(), "bot2-"));
      calls = [];
      const app = await joined({ ...o, dataDir: d });
      await hook(app, [msg("a", "1")]);
      const rec = JSON.parse(readFileSync(join(d, "messages.jsonl"), "utf8").trim());
      expect(rec.name).toBeNull();
      expect(calls).toEqual([]);
      rmSync(d, { recursive: true, force: true });
    }
  });
  test("a 404 / 500 that happens to carry a displayName is still null; the call has a timeout signal; an abort gives null", async () => {
    const app = await joined();
    profile = { status: 404, name: "Leaked" };
    await hook(app, [msg("a", "1")]);
    expect(lines()[0]!.name).toBeNull();
    const { getGroupMemberName } = await import("./line");
    let seenInit: RequestInit | undefined;
    const ok = await getGroupMemberName({ apiBase: "http://x", accessToken: "t" }, "G", "U", async (_u, i) => ((seenInit = i), new Response(JSON.stringify({ displayName: "N" }))));
    expect(ok).toBe("N");
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);
    expect(seenInit?.method).toBe("GET");
    expect(await getGroupMemberName({ apiBase: "http://x", accessToken: "t" }, "G", "U", async () => { throw new DOMException("aborted", "TimeoutError"); })).toBeNull();
  });
  test("the group id is URL-encoded into the path too", async () => {
    const { getGroupMemberName } = await import("./line");
    let url = "";
    await getGroupMemberName({ apiBase: "http://x", accessToken: "t" }, "C/../evil?x=1", "U", async (u) => ((url = u), new Response("{}")));
    expect(url).toBe("http://x/v2/bot/group/C%2F..%2Fevil%3Fx%3D1/member/U");
  });
  test("a user id is URL-encoded into the path (no path injection)", async () => {
    const app = await joined();
    await hook(app, [msg("a", "1", { userId: "U/../../x?y=1" })]);
    expect(calls[0]!.path).toBe(`/v2/bot/group/${GROUP}/member/U%2F..%2F..%2Fx%3Fy%3D1`);
  });
});

describe("the file", () => {
  test("a torn line, garbage and a JSON line with no id are skipped, never fatal; the valid records still read", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    const good = { id: "g1", at: NOW.toISOString(), userId: null, name: null, kind: "text", text: "ok" };
    writeFileSync(join(dir, "messages.jsonl"), ['{"torn":', "not json", '{"x":1}', JSON.stringify(good), ""].join("\n"));
    const app = createApp(cfg(), { now: () => NOW });
    const j = await (await getMsgs(app)).json();
    expect(j.messages).toEqual([good]);
  });
});

describe("retention", () => {
  const rec = (id: string, at: string): MessageRecord => ({ id, at, userId: null, name: null, kind: "text", text: id });
  test("on each write, records older than the window are dropped; the boundary day is kept", () => {
    const now = new Date("2026-11-10T00:00:00.000Z");
    const st = createMessageStore(dir, () => now);
    const cutoff = new Date(now.getTime() - 90 * 86_400_000).toISOString();
    st.add(rec("old", "2026-08-01T00:00:00.000Z"), 365); // kept for now: a wide window
    st.add(rec("edge", cutoff), 365);
    expect(lines().map((r) => r.id)).toEqual(["old", "edge"]);
    st.add(rec("new", "2026-11-09T00:00:00.000Z"), 90);
    expect(lines().map((r) => r.id)).toEqual(["edge", "new"]); // "old" pruned; "edge" is exactly at the cutoff and stays
    st.add(rec("newer", "2026-11-09T01:00:00.000Z"), 1); // 1 day: the cutoff is exactly "new"'s time, so it stays
    expect(lines().map((r) => r.id)).toEqual(["new", "newer"]);
    st.add(rec("last", "2026-11-09T12:00:00.000Z"), 0.5); // half a day: both earlier ones are now older than the cutoff
    expect(lines().map((r) => r.id)).toEqual(["last"]);
  });
  test("end to end: an old record goes when the next message is stored (configured days)", async () => {
    const now = new Date("2026-11-10T00:00:00.000Z");
    const seed = createMessageStore(dir, () => now);
    seed.add(rec("ancient", "2026-01-01T00:00:00.000Z"), 10_000);
    const app = await joined({ retentionDays: 30 });
    const fresh = msg("fresh", "hi", { ts: now.getTime() });
    const app2 = createApp(cfg({ retentionDays: 30 }), { now: () => now });
    await hook(app2, [fresh]);
    void app;
    expect(lines().map((r) => r.id)).toEqual(["fresh"]);
  });
  test("a plain append when nothing expired (the file only grows by one line)", () => {
    const st = createMessageStore(dir, () => new Date("2026-11-10T00:00:00.000Z"));
    st.add(rec("a", "2026-11-09T00:00:00.000Z"), 90);
    const before = readFileSync(join(dir, "messages.jsonl"), "utf8");
    st.add(rec("b", "2026-11-09T00:00:01.000Z"), 90);
    expect(readFileSync(join(dir, "messages.jsonl"), "utf8").startsWith(before)).toBe(true);
  });
});

describe("GET /messages", () => {
  test("401 for no key / a wrong key / an empty SEND_KEY — nothing is read", async () => {
    const app = await joined();
    await hook(app, [msg("m1", THAI)]);
    for (const h of [{} as Record<string, string>, { authorization: "Bearer wrong" }, { authorization: `Bearer ${KEY}x` }, { authorization: KEY }]) {
      const r = await getMsgs(app, "", h);
      expect(r.status).toBe(401);
      expect(await r.text()).not.toContain(THAI);
    }
    const open = await joined({ sendKey: "", dataDir: mkdtempSync(join(tmpdir(), "bot2-")) });
    expect((await getMsgs(open, "", { authorization: "Bearer anything" })).status).toBe(401);
  });
  test("oldest first with `next`; since by ISO time and by message id; empty page → next null", async () => {
    const app = await joined();
    await hook(app, [msg("m1", "one", { ts: 1_700_000_100_000 }), msg("m2", "two", { ts: 1_700_000_200_000 }), msg("m3", "three", { ts: 1_700_000_300_000 })]);
    let j = await (await getMsgs(app)).json();
    expect(j.messages.map((m: MessageRecord) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(j.next).toBe("m3");
    j = await (await getMsgs(app, "?since=m1")).json();
    expect(j.messages.map((m: MessageRecord) => m.id)).toEqual(["m2", "m3"]);
    j = await (await getMsgs(app, `?since=${encodeURIComponent("2023-11-14T22:16:40.000Z")}`)).json(); // exactly m2's time: strictly after
    expect(j.messages.map((m: MessageRecord) => m.id)).toEqual(["m3"]);
    j = await (await getMsgs(app, "?since=2023-11-14")).json();
    expect(j.messages.length).toBe(3);
    j = await (await getMsgs(app, "?since=m3")).json();
    expect(j).toEqual({ messages: [], next: null });
  });
  test("since that is neither a known id nor an ISO time is 400 (a bare number is not a year)", async () => {
    const app = await joined();
    await hook(app, [msg("m1", "one")]);
    for (const s of ["nope", "2026", "123456", "99999-99-99x"]) expect((await getMsgs(app, `?since=${s}`)).status).toBe(400);
  });
  test("limit: default 200, 1..500 accepted, 0 / 501 / abc / 1.5 / -1 are 400", async () => {
    const st = createMessageStore(dir);
    const base = Date.now();
    for (let i = 0; i < 250; i++) st.add({ id: `id${String(i).padStart(3, "0")}`, at: new Date(base + i).toISOString(), userId: null, name: null, kind: "text", text: `t${i}` }, 90);
    const app = createApp(cfg(), { messages: st });
    let j = await (await getMsgs(app)).json();
    expect(j.messages.length).toBe(200);
    expect(j.next).toBe("id199");
    j = await (await getMsgs(app, "?limit=5&since=id199")).json();
    expect(j.messages.map((m: MessageRecord) => m.id)).toEqual(["id200", "id201", "id202", "id203", "id204"]);
    expect((await (await getMsgs(app, "?limit=500")).json()).messages.length).toBe(250);
    expect((await (await getMsgs(app, "?limit=1")).json()).messages.length).toBe(1);
    for (const l of ["0", "501", "abc", "1.5", "-1", ""]) expect((await getMsgs(app, `?limit=${l}`)).status).toBe(400);
  });
  test("an unsent message is listed with its text blank; the fields are exactly the contract", async () => {
    const app = await joined();
    await hook(app, [msg("m1", THAI), unsend("m1")]);
    const j = await (await getMsgs(app)).json();
    expect(j.messages).toEqual([{ id: "m1", at: "2023-11-14T22:15:00.000Z", userId: "Uuser1", name: "Somchai", kind: "text", text: "", unsent: true }]);
  });
  test("recording off: an authenticated call gets recording:false (and a bad limit is still 400, a bad key still 401)", async () => {
    const app = await joined({ recordMessages: false });
    expect(await (await getMsgs(app)).json()).toEqual({ messages: [], recording: false });
    expect((await getMsgs(app, "", {})).status).toBe(401);
    expect((await getMsgs(app, "?limit=0")).status).toBe(400);
  });
});

describe("scripts/pull.ts", () => {
  const env = { BOT_URL: "http://bot.test/", SEND_KEY: KEY };
  test("parsePullArgs", () => {
    expect(parsePullArgs(["--since", "m1", "--out", ".private/x.json"])).toEqual({ since: "m1", out: ".private/x.json" });
    expect(parsePullArgs(["--out", "x"]).error).toContain("--since");
    expect(parsePullArgs(["--since", "m1"]).error).toContain("--out");
    expect(parsePullArgs(["--since", "m", "--out", "x", "--bogus"]).error).toContain("--bogus");
  });
  test("pulls every page (1,200 messages = 3 pages), writes them to --out, and PRINTS ONLY the count and the next id", async () => {
    const st = createMessageStore(dir);
    const base = Date.now() - 1000 * 60;
    for (let i = 0; i < 1200; i++) st.add({ id: `id${String(i).padStart(4, "0")}`, at: new Date(base + i).toISOString(), userId: "U", name: "N", kind: "text", text: `SECRET-${i}` }, 90);
    const app = createApp(cfg(), { messages: st });
    const urls: string[] = [];
    let written: { path: string; data: string } | null = null;
    const r = await runPull(["--since", "2020-01-01", "--out", ".private/pull.json"], env, (u, i) => (urls.push(u), app.request(new URL(u).pathname + new URL(u).search, i)), (path, data) => { written = { path, data }; });
    expect(r).toEqual({ code: 0, out: "count: 1200\nnext: id1199" });
    expect(r.out).not.toContain("SECRET");
    expect(r.out).not.toContain(KEY);
    expect(urls.length).toBe(3);
    expect(urls[1]).toContain("since=id0499");
    expect(written!.path).toBe(".private/pull.json");
    const parsed = JSON.parse(written!.data);
    expect(parsed.messages.length).toBe(1200);
    expect(parsed.messages[0].text).toBe("SECRET-0");
  });
  test("recording off / a refusal / a timeout: a clear line, a non-zero exit where it failed, and no file written", async () => {
    let wrote = false;
    const w = () => { wrote = true; };
    const off = createApp(cfg({ recordMessages: false }));
    const a = await runPull(["--since", "m1", "--out", "o"], env, (u, i) => off.request(new URL(u).pathname + new URL(u).search, i), w);
    expect(a.code).toBe(0);
    expect(a.out).toContain("recording is OFF");
    const on = createApp(cfg());
    const b = await runPull(["--since", "m1", "--out", "o"], { ...env, SEND_KEY: "wrong" }, (u, i) => on.request(new URL(u).pathname + new URL(u).search, i), w);
    expect(b.code).toBe(1);
    expect(b.out).toStartWith("401");
    const c = await runPull(["--since", "m1", "--out", "o"], env, () => { throw new Error("timeout"); }, w);
    expect(c.code).toBe(1);
    expect((await runPull(["--since", "m1", "--out", "o"], {}, fetch, w)).code).toBe(2);
    expect(wrote).toBe(false);
  });
});

describe("the repo hygiene for phase 2", () => {
  test("data/ (messages.jsonl, members.json) is git-ignored and .env.example documents both new keys", () => {
    const root = join(import.meta.dir, "..");
    expect(readFileSync(join(root, ".gitignore"), "utf8").split(/\r?\n/)).toContain("data/");
    const ex = readFileSync(join(root, ".env.example"), "utf8");
    expect(ex).toMatch(/^RECORD_GROUP_MESSAGES=$/m);
    expect(ex).toMatch(/^MESSAGE_RETENTION_DAYS=90$/m);
    expect(ex).toContain("ONLY after the owner has told the group");
  });
  test("phase 2 adds no outbound message: the only fetches in the source are the push, the profile GET, and the injected fetch", () => {
    const src = readFileSync(join(import.meta.dir, "line.ts"), "utf8");
    const posts = src.match(/method: "POST"/g) ?? [];
    expect(posts.length).toBe(1); // the owner-approved push
    expect(src).toContain('method: "GET"');
    expect(readFileSync(join(import.meta.dir, "messages.ts"), "utf8")).not.toMatch(/fetch\(/);
    expect(readFileSync(join(import.meta.dir, "index.ts"), "utf8")).not.toContain("/v2/bot/message/reply");
  });
});
