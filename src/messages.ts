import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

/** One recorded group message. Image / sticker / file content is NEVER downloaded: `text` is just `[<kind>]`. */
export interface MessageRecord {
  id: string;
  at: string; // ISO time of the LINE event
  userId: string | null;
  name: string | null;
  kind: string;
  text: string;
  /** Set (and `text` blanked) when the sender unsent the message. */
  unsent?: true;
}

export const MS_PER_DAY = 86_400_000;
export const MAX_RECORD_TEXT = 5000;

/** A message `type` becomes the `kind` and the placeholder `[<kind>]`; anything odd is `unknown`, so a hostile type can't forge text. */
export const safeKind = (t: unknown): string => (typeof t === "string" && /^[a-z]{1,20}$/.test(t) ? t : "unknown");

export function createMessageStore(dataDir: string, now: () => Date = () => new Date()) {
  const file = join(dataDir, "messages.jsonl");
  const membersFile = join(dataDir, "members.json");
  const ensure = () => mkdirSync(dataDir, { recursive: true });

  const readAll = (): MessageRecord[] => {
    if (!existsSync(file)) return [];
    const out: MessageRecord[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const r = JSON.parse(line) as MessageRecord;
        if (r && typeof r.id === "string") out.push(r);
      } catch {
        /* a torn line is skipped, never fatal */
      }
    }
    return out;
  };
  const writeAll = (list: MessageRecord[]): void => {
    ensure();
    const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, list.map((r) => JSON.stringify(r) + "\n").join(""));
    renameSync(tmp, file);
  };

  const readMembers = (): Record<string, string> => {
    try {
      const m = JSON.parse(readFileSync(membersFile, "utf8")) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(m).filter(([, v]) => typeof v === "string")) as Record<string, string>;
    } catch {
      return {};
    }
  };

  return {
    has: (id: string): boolean => readAll().some((r) => r.id === id),
    /**
     * Stores one record once (a redelivered webhook is a no-op) and drops anything older than `retentionDays`.
     * A plain append when nothing has expired; an atomic rewrite when something has.
     */
    add(rec: MessageRecord, retentionDays: number): boolean {
      ensure();
      const list = readAll();
      if (list.some((r) => r.id === rec.id)) return false;
      const cutoff = now().getTime() - retentionDays * MS_PER_DAY;
      const kept = list.filter((r) => new Date(r.at).getTime() >= cutoff);
      if (kept.length !== list.length) writeAll([...kept, rec]);
      else appendFileSync(file, JSON.stringify(rec) + "\n");
      return true;
    },
    /** Respect the deletion: the text is blanked ON DISK (rewrite), not just hidden. */
    markUnsent(id: string): boolean {
      const list = readAll();
      const r = list.find((x) => x.id === id);
      if (!r) return false;
      r.text = "";
      r.unsent = true;
      writeAll(list);
      return true;
    },
    /**
     * `since` is a known message id (records AFTER it) or an ISO time (records with `at` AFTER it); null = from the start.
     * Returns undefined when `since` is neither a known id nor an ISO time.
     */
    query(since: string | null, limit: number): { messages: MessageRecord[]; next: string | null } | undefined {
      const all = readAll();
      let rest = all;
      if (since !== null) {
        const idx = all.findIndex((r) => r.id === since);
        if (idx >= 0) rest = all.slice(idx + 1);
        else if (/^\d{4}-\d{2}-\d{2}/.test(since) && !Number.isNaN(Date.parse(since))) {
          const t = Date.parse(since);
          rest = all.filter((r) => new Date(r.at).getTime() > t);
        } else return undefined;
      }
      const messages = rest.slice(0, limit);
      return { messages, next: messages.length ? messages[messages.length - 1]!.id : null };
    },
    memberName: (userId: string): string | undefined => readMembers()[userId],
    setMemberName(userId: string, name: string): void {
      ensure();
      const m = readMembers();
      m[userId] = name;
      const tmp = `${membersFile}.${randomBytes(4).toString("hex")}.tmp`;
      writeFileSync(tmp, JSON.stringify(m));
      renameSync(tmp, membersFile);
    },
  };
}
export type MessageStore = ReturnType<typeof createMessageStore>;
