import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export interface Group {
  groupId: string;
  joinedAt: string;
}
export type ImageExt = "jpg" | "png";

/** The ONLY names /img serves: 32 lowercase hex + a jpg/jpeg/png extension. Nothing else reaches the disk path. */
export const IMG_NAME = /^[0-9a-f]{32}\.(jpg|jpeg|png)$/;
export const IMG_TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png" };

/** What the file really is, from its first bytes (the declared type is not trusted). */
export function sniffImage(b: Uint8Array): ImageExt | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  return null;
}

export function createStore(dataDir: string) {
  const groupFile = join(dataDir, "group.json");
  const imgDir = join(dataDir, "img");
  const ensure = () => mkdirSync(imgDir, { recursive: true });
  return {
    imgDir,
    /** The latest join wins. Written atomically (tmp + rename). Only the group id and the time are kept. */
    saveGroup(g: Group): void {
      ensure();
      const tmp = `${groupFile}.${randomBytes(4).toString("hex")}.tmp`;
      writeFileSync(tmp, JSON.stringify({ groupId: g.groupId, joinedAt: g.joinedAt }));
      renameSync(tmp, groupFile);
    },
    readGroup(): Group | null {
      if (!existsSync(groupFile)) return null;
      try {
        const g = JSON.parse(readFileSync(groupFile, "utf8")) as Partial<Group>;
        return typeof g.groupId === "string" && g.groupId ? { groupId: g.groupId, joinedAt: String(g.joinedAt ?? "") } : null;
      } catch {
        return null;
      }
    },
    /** Saves under a fresh random name and returns it. */
    saveImage(bytes: Uint8Array, ext: ImageExt): string {
      ensure();
      const name = `${randomBytes(16).toString("hex")}.${ext}`;
      writeFileSync(join(imgDir, name), bytes);
      return name;
    },
    removeImage(name: string): void {
      if (IMG_NAME.test(name)) {
        try {
          unlinkSync(join(imgDir, name));
        } catch {
          /* already gone */
        }
      }
    },
    /** A path only for a name that passes IMG_NAME; anything else is null (no traversal is possible). */
    imagePath(name: string): string | null {
      if (!IMG_NAME.test(name)) return null;
      const p = join(imgDir, name);
      return existsSync(p) ? p : null;
    },
  };
}
export type Store = ReturnType<typeof createStore>;
