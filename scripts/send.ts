// The desk's send command. Run ONLY after the owner's "ส่ง" (quoted in the log):
//   bun scripts/send.ts --text note.txt [--img a.png ...] [--dry-run] [--retry-key <uuid>]
// One send = ONE retry key (printed). If the run times out or fails, re-run the SAME note with --retry-key <that uuid>: LINE then drops the duplicate.
// Reads BOT_URL + SEND_KEY from the git-ignored `.env.send` (the owner fills it). Prints the answer; never prints the key.
import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#")) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

export function parseArgs(argv: string[]): { text?: string; imgs: string[]; dryRun: boolean; retryKey?: string; error?: string } {
  const a: { text?: string; imgs: string[]; dryRun: boolean; retryKey?: string; error?: string } = { imgs: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--dry-run") a.dryRun = true;
    else if (k === "--text") a.text = argv[++i];
    else if (k === "--retry-key") {
      const v = argv[++i];
      if (v && UUID.test(v)) a.retryKey = v;
      else a.error = "--retry-key must be the UUID a previous run printed";
    }
    else if (k === "--img") {
      const v = argv[++i];
      if (v) a.imgs.push(v);
    } else a.error = `unknown argument ${k}`;
  }
  if (!a.text) a.error ??= "--text <file> is required";
  return a;
}

export async function runSend(
  argv: string[],
  env: Record<string, string>,
  fetchImpl: (u: string, i?: RequestInit) => Promise<Response> | Response = fetch,
  read: (p: string) => Uint8Array | string = (p) => readFileSync(p),
): Promise<{ code: number; out: string }> {
  const a = parseArgs(argv);
  if (a.error) return { code: 2, out: a.error };
  const url = (env.BOT_URL ?? "").replace(/\/+$/, "");
  if (!url || !env.SEND_KEY) return { code: 2, out: "BOT_URL and SEND_KEY must be set in .env.send" };
  const form = new FormData();
  const asText = (b: Uint8Array | string): string => (typeof b === "string" ? b : new TextDecoder().decode(b));
  form.set("text", asText(read(a.text!)));
  for (const p of a.imgs) form.append("image", new Blob([read(p)]), basename(p));
  const retryKey = a.retryKey ?? randomUUID(); // ONE key per send, reused by a re-run, so LINE never posts the same note twice
  const keyLine = `retry-key: ${retryKey}`;
  const again = `re-run with --retry-key ${retryKey}; do not change the text or images`;
  let res: Response;
  try {
    res = await fetchImpl(`${url}/send${a.dryRun ? "?dryRun=1" : ""}`, { method: "POST", headers: { authorization: `Bearer ${env.SEND_KEY}`, "x-line-retry-key": retryKey }, body: form });
  } catch {
    // a timeout: LINE may have the note and the desk never heard back
    return { code: 1, out: ["no answer from the bot (timeout or network); the note may or may not have been sent", keyLine, again].join("\n") };
  }
  const body = `${res.status} ${await res.text()}`;
  return { code: res.ok ? 0 : 1, out: (res.ok ? [body, keyLine] : [body, keyLine, again]).join("\n") };
}

if (import.meta.main) {
  const env = existsSync(".env.send") ? parseEnvFile(readFileSync(".env.send", "utf8")) : {};
  const r = await runSend(process.argv.slice(2), env);
  console.log(r.out);
  process.exit(r.code);
}
