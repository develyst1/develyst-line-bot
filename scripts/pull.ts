// The desk's read command: pull what the bot recorded in the SOM SYSTEM group.
//   bun scripts/pull.ts --since <iso-time|message-id> --out <path>
// The desk points --out into its git-ignored `.private/` folder (pulled text may hold personal data: raw text never goes
// into a shared file). Reads BOT_URL + SEND_KEY from `.env.send`. PRINTS ONLY the count and the `next` id: never a message, never the key.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseEnvFile } from "./send";

export function parsePullArgs(argv: string[]): { since?: string; out?: string; error?: string } {
  const a: { since?: string; out?: string; error?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--since") a.since = argv[++i];
    else if (k === "--out") a.out = argv[++i];
    else a.error = `unknown argument ${k}`;
  }
  if (!a.since) a.error ??= "--since <iso-time|message-id> is required";
  if (!a.out) a.error ??= "--out <path> is required (point it into the desk's .private/ folder)";
  return a;
}

const PAGE = 500;
const MAX_PAGES = 200;

export async function runPull(
  argv: string[],
  env: Record<string, string>,
  fetchImpl: (u: string, i?: RequestInit) => Promise<Response> | Response = fetch,
  write: (path: string, data: string) => void = (p, d) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, d);
  },
): Promise<{ code: number; out: string }> {
  const a = parsePullArgs(argv);
  if (a.error) return { code: 2, out: a.error };
  const url = (env.BOT_URL ?? "").replace(/\/+$/, "");
  if (!url || !env.SEND_KEY) return { code: 2, out: "BOT_URL and SEND_KEY must be set in .env.send" };
  const all: unknown[] = [];
  let since = a.since!;
  for (let page = 0; page < MAX_PAGES; page++) {
    let res: Response;
    try {
      res = await fetchImpl(`${url}/messages?since=${encodeURIComponent(since)}&limit=${PAGE}`, { headers: { authorization: `Bearer ${env.SEND_KEY}` } });
    } catch {
      return { code: 1, out: "no answer from the bot (timeout or network); nothing was written" };
    }
    if (!res.ok) return { code: 1, out: `${res.status} ${(await res.text()).slice(0, 200)}` }; // an error body has no message text
    const j = (await res.json()) as { messages?: unknown[]; next?: string | null; recording?: boolean };
    if (j.recording === false) return { code: 0, out: "recording is OFF on the bot (RECORD_GROUP_MESSAGES is not true): nothing to pull" };
    const got = j.messages ?? [];
    all.push(...got);
    if (got.length < PAGE || !j.next) break;
    since = j.next;
  }
  write(a.out!, JSON.stringify({ pulledAt: new Date().toISOString(), messages: all }));
  const last = (all[all.length - 1] as { id?: string } | undefined)?.id ?? null;
  return { code: 0, out: `count: ${all.length}\nnext: ${last ?? "none"}` };
}

if (import.meta.main) {
  const env = existsSync(".env.send") ? parseEnvFile(readFileSync(".env.send", "utf8")) : {};
  const r = await runPull(process.argv.slice(2), env);
  console.log(r.out);
  process.exit(r.code);
}
