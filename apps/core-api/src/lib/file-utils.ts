import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "crypto";
import { slugify } from "../slugify";

export const TYPE_DIRS: Record<string, string> = {
  place: "places",
  media: "media",
  note: "notes",
  person: "people",
  insight: "insights",
};

export async function ensureDataDirectories(dataPath: string): Promise<void> {
  for (const dir of Object.values(TYPE_DIRS)) {
    await mkdir(join(dataPath, dir), { recursive: true });
  }
}

export async function resolveFilePath(
  dataPath: string,
  type: string,
  title: string
): Promise<string> {
  const dir = join(dataPath, TYPE_DIRS[type] || "notes");
  const slug = slugify(title);
  let filePath = join(dir, `${slug}.md`);

  const file = Bun.file(filePath);
  if (await file.exists()) {
    const hash = randomUUID().replace(/-/g, "").slice(0, 4);
    filePath = join(dir, `${slug}_${hash}.md`);
  }

  return filePath;
}
