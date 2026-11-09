import { Hono } from "hono";
import { randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { buildPushBody, getGroupMemberName, pushToLine, verifySignature, type FetchLike } from "./line";
import { createStore, IMG_TYPES, sniffImage, type Store } from "./store";
import { createMessageStore, MAX_RECORD_TEXT, safeKind, type MessageStore } from "./messages";

export interface Config {
  channelSecret: string;
  accessToken: string;
  /** Empty = no outside call at all: /send answers 503 NOT_CONFIGURED. */
  apiBase: string;
  sendKey: string;
  publicBaseUrl: string;
  dataDir: string;
  port: number;
  /** TRUE ONLY when RECORD_GROUP_MESSAGES is exactly "true" (the owner's step, after he told the group). Anything else = nothing is stored. */
  recordMessages: boolean;
  /** Recorded messages older than this are dropped on every write. */
  retentionDays: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const trim = (s: string | undefined) => (s ?? "").trim().replace(/\/+$/, "");
  return {
    channelSecret: (env.LINE_CHANNEL_SECRET ?? "").trim(),
    accessToken: (env.LINE_CHANNEL_ACCESS_TOKEN ?? "").trim(),
    apiBase: trim(env.LINE_API_BASE),
    sendKey: (env.SEND_KEY ?? "").trim(),
    publicBaseUrl: trim(env.PUBLIC_BASE_URL),
    dataDir: env.DATA_DIR?.trim() || "./data",
    port: Number(env.PORT) || 3100,
    recordMessages: (env.RECORD_GROUP_MESSAGES ?? "").trim() === "true",
    retentionDays: Number.isInteger(Number(env.MESSAGE_RETENTION_DAYS)) && Number(env.MESSAGE_RETENTION_DAYS) >= 1 ? Number(env.MESSAGE_RETENTION_DAYS) : 90,
  };
}

export const MAX_MESSAGES_LIMIT = 500;
export const DEFAULT_MESSAGES_LIMIT = 200;

export const MAX_TEXT = 4000;
export const MAX_IMAGES = 3;
/** 1 MB: LINE's preview-image limit, and we reuse one URL for both the original and the preview. */
export const MAX_IMAGE_BYTES = 1_000_000;
const MAX_WEBHOOK_BYTES = 1_000_000;
const MAX_SEND_BYTES = MAX_IMAGES * MAX_IMAGE_BYTES + 200_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const sha = (s: string) => createHash("sha256").update(s).digest();
/** Constant-time string compare (equal-length digests, so no length leak). An empty expected value never matches. */
const sameSecret = (given: string, expected: string): boolean => expected !== "" && timingSafeEqual(sha(given), sha(expected));

const err = (code: string, message: string) => ({ error: { code, message } });

interface LineEvent {
  type?: string;
  timestamp?: number;
  source?: { type?: string; groupId?: string; userId?: string };
  message?: { id?: string; type?: string; text?: string };
  unsend?: { messageId?: string };
}

export function createApp(cfg: Config, deps: { fetch?: FetchLike; store?: Store; messages?: MessageStore; now?: () => Date } = {}) {
  const now = deps.now ?? (() => new Date());
  const store = deps.store ?? createStore(cfg.dataDir);
  const messages = deps.messages ?? createMessageStore(cfg.dataDir, now);
  const fetchImpl: FetchLike = deps.fetch ?? ((u, i) => fetch(u, i));
  const app = new Hono();

  const keyOk = (c: { req: { header: (n: string) => string | undefined } }): boolean => {
    const m = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "");
    return !!m && sameSecret(m[1]!, cfg.sendKey);
  };

  /** The sender's display name: cached per user in members.json, else LINE's read-only profile GET; any failure is null and never blocks storing. */
  const nameOf = async (groupId: string, userId: string): Promise<string | null> => {
    const cached = messages.memberName(userId);
    if (cached) return cached;
    const n = await getGroupMemberName({ apiBase: cfg.apiBase, accessToken: cfg.accessToken }, groupId, userId, fetchImpl);
    if (n) messages.setMemberName(userId, n);
    return n;
  };

  /** Recording (REQ-5012 phase 2). Only called when RECORD_GROUP_MESSAGES=true, and only for the stored group. */
  const record = async (e: LineEvent, groupId: string): Promise<void> => {
    if (e.type === "message" && typeof e.message?.id === "string" && e.message.id) {
      const id = e.message.id;
      if (messages.has(id)) return; // a redelivered webhook stores once (and asks LINE for nothing)
      const kind = safeKind(e.message.type);
      const userId = typeof e.source?.userId === "string" && e.source.userId ? e.source.userId : null;
      const at = typeof e.timestamp === "number" && !Number.isNaN(new Date(e.timestamp).getTime()) ? new Date(e.timestamp) : now();
      messages.add(
        {
          id,
          at: at.toISOString(),
          userId,
          name: userId ? await nameOf(groupId, userId) : null,
          kind,
          // content other than text is never downloaded or stored: a placeholder only
          text: kind === "text" ? String(e.message.text ?? "").slice(0, MAX_RECORD_TEXT) : `[${kind}]`,
        },
        cfg.retentionDays,
      );
    } else if (e.type === "unsend" && typeof e.unsend?.messageId === "string") {
      messages.markUnsent(e.unsend.messageId);
    }
  };

  app.get("/health", (c) => c.json({ ok: true, groupKnown: store.readGroup() !== null, recording: cfg.recordMessages }));

  // ── LINE → us. Stored: the group id of a `join`; and, ONLY when RECORD_GROUP_MESSAGES=true, that group's messages. ──
  app.post("/line/webhook", async (c) => {
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > MAX_WEBHOOK_BYTES) return c.json(err("TOO_LARGE", "Body too large"), 413);
    const raw = new Uint8Array(await c.req.arrayBuffer());
    if (raw.length > MAX_WEBHOOK_BYTES) return c.json(err("TOO_LARGE", "Body too large"), 413);
    if (!verifySignature(cfg.channelSecret, raw, c.req.header("x-line-signature"))) return c.json(err("UNAUTHORIZED", "Bad signature"), 401);
    let events: unknown[] = [];
    try {
      const parsed = JSON.parse(new TextDecoder().decode(raw)) as { events?: unknown };
      if (Array.isArray(parsed.events)) events = parsed.events;
    } catch {
      return c.json(err("VALIDATION", "Body is not JSON"), 400);
    }
    for (const e of events as LineEvent[]) {
      if (e?.type === "join" && e.source?.type === "group" && typeof e.source.groupId === "string" && e.source.groupId) {
        const at = typeof e.timestamp === "number" ? new Date(e.timestamp) : new Date();
        store.saveGroup({ groupId: e.source.groupId, joinedAt: (Number.isNaN(at.getTime()) ? new Date() : at).toISOString() });
        continue;
      }
      // recording is OFF unless the owner turned it on; any other group, a room or a 1:1 chat is dropped
      if (!cfg.recordMessages || e?.source?.type !== "group") continue;
      const g = store.readGroup();
      if (!g || e.source.groupId !== g.groupId) continue;
      try {
        await record(e, g.groupId);
      } catch (err) {
        console.error("record failed", err instanceof Error ? err.name : "error"); // the name only: never message text
      }
      // every other event is answered 200 and dropped
    }
    return c.json({ ok: true });
  });

  // ── the desk → us → LINE ──
  // ── the desk reads what the bot recorded (same key as /send) ──
  app.get("/messages", (c) => {
    if (!keyOk(c)) return c.json(err("UNAUTHORIZED", "Bad key"), 401);
    const rawLimit = c.req.query("limit");
    let limit = DEFAULT_MESSAGES_LIMIT;
    if (rawLimit !== undefined) {
      if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > MAX_MESSAGES_LIMIT) return c.json(err("VALIDATION", `limit is 1–${MAX_MESSAGES_LIMIT}`), 400);
      limit = Number(rawLimit);
    }
    if (!cfg.recordMessages) return c.json({ messages: [], recording: false }); // so the desk knows WHY it is empty
    const r = messages.query(c.req.query("since") || null, limit);
    if (!r) return c.json(err("VALIDATION", "since must be an ISO time or a known message id"), 400);
    return c.json(r);
  });

  app.post("/send", async (c) => {
    if (!keyOk(c)) return c.json(err("UNAUTHORIZED", "Bad key"), 401);

    if (Number(c.req.header("content-length") ?? 0) > MAX_SEND_BYTES) return c.json(err("VALIDATION", "Request too large"), 400);
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json(err("VALIDATION", "Expected multipart/form-data"), 400);
    }
    const text = form.get("text");
    if (typeof text !== "string" || text.trim().length === 0) return c.json(err("VALIDATION", "text is required"), 400);
    if (text.length > MAX_TEXT) return c.json(err("VALIDATION", `text is at most ${MAX_TEXT} characters`), 400);
    const files = form.getAll("image").filter((f): f is File => typeof f !== "string" && (f.size > 0 || f.name !== ""));
    if (files.length > MAX_IMAGES) return c.json(err("VALIDATION", `at most ${MAX_IMAGES} images`), 400);
    const images: { bytes: Uint8Array; ext: "jpg" | "png" }[] = [];
    for (const f of files) {
      if (f.size === 0) return c.json(err("VALIDATION", "an image is empty"), 400);
      if (f.size > MAX_IMAGE_BYTES) return c.json(err("VALIDATION", "each image is at most 1 MB"), 400);
      const bytes = new Uint8Array(await f.arrayBuffer());
      const ext = sniffImage(bytes);
      if (!ext) return c.json(err("VALIDATION", "images must be JPEG or PNG"), 400);
      images.push({ bytes, ext });
    }

    const group = store.readGroup();
    // the preview the owner reads before he says "send": nothing is written, nothing is sent
    if (c.req.query("dryRun") === "1") {
      const urls = images.map((im, i) => `${cfg.publicBaseUrl || "<PUBLIC_BASE_URL>"}/img/<random-${i + 1}>.${im.ext}`);
      return c.json({ dryRun: true, body: buildPushBody(group?.groupId ?? null, text, urls) });
    }

    if (!group) return c.json(err("NO_GROUP", "The bot has not been added to a group yet"), 409);
    if (!cfg.apiBase || !cfg.accessToken || (images.length > 0 && !cfg.publicBaseUrl)) return c.json(err("NOT_CONFIGURED", "The bot is not configured to send"), 503);

    const names = images.map((im) => store.saveImage(im.bytes, im.ext));
    const body = buildPushBody(group.groupId, text, names.map((n) => `${cfg.publicBaseUrl}/img/${n}`));
    const given = c.req.header("x-line-retry-key");
    const retryKey = given && UUID.test(given) ? given : randomUUID();
    const res = await pushToLine({ apiBase: cfg.apiBase, accessToken: cfg.accessToken }, body, retryKey, fetchImpl);
    if (!res.ok) {
      for (const n of names) store.removeImage(n);
      return c.json({ error: { code: "LINE_ERROR", message: "LINE refused the push", lineStatus: res.status } }, 502);
    }
    return c.json({ sent: true, messages: body.messages.length });
  });

  // ── LINE fetches the images from here (no key: the 128-bit random name is the capability) ──
  app.get("/img/:name", async (c) => {
    const path = store.imagePath(c.req.param("name"));
    if (!path) return c.json(err("NOT_FOUND", "Not found"), 404);
    const ext = path.slice(path.lastIndexOf(".") + 1);
    return new Response(Bun.file(path), {
      headers: { "content-type": IMG_TYPES[ext] ?? "application/octet-stream", "x-content-type-options": "nosniff", "cache-control": "public, max-age=86400" },
    });
  });

  app.notFound((c) => c.json(err("NOT_FOUND", "Not found"), 404));
  app.onError((e, c) => {
    console.error("unhandled", e instanceof Error ? e.name : "error"); // the name only: never a body, a key or a token
    return c.json(err("INTERNAL", "Something went wrong"), 500);
  });
  return app;
}

if (import.meta.main) {
  const cfg = loadConfig();
  const app = createApp(cfg);
  console.log(`develyst-line-bot on :${cfg.port} (push ${cfg.apiBase ? "ON" : "OFF — LINE_API_BASE is empty"})`);
  Bun.serve({ port: cfg.port, fetch: app.fetch });
}
