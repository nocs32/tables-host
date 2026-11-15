// The notes vault as plain files (~/vault on the Pi, kept in sync with Obsidian by the bridge).
// Everything that touches the disk goes through here: paths are checked to stay inside the vault and
// out of hidden folders, writes are atomic (temp file + rename), nothing is ever deleted.

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const TEXT_EXTENSIONS = new Set([".md", ".base", ".txt", ".json", ".csv", ".html", ".ino", ".yaml", ".yml"]);
export const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export class VaultError extends Error {}

/** Notes that keep the vault's folders and layout: they can be edited but never moved. */
const FIXED = new Set(["Home.md", "Inbox/Inbox.md", "Archive/Archive.md"]);

export interface NoteInfo {
  path: string;
  kind: "text" | "image" | "other";
  size: number;
  modified: string;
  properties?: Record<string, string>;
}

export class Vault {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** A vault-relative path, checked: no escaping the vault, no hidden folders, NFC like Obsidian. */
  resolve(relative: string): { rel: string; abs: string } {
    const cleaned = relative.normalize("NFC").trim().replaceAll("\\", "/").replace(/^\/+/, "");
    if (!cleaned) throw new VaultError("Empty path.");
    const rel = path.posix.normalize(cleaned);
    if (rel === "." || rel.startsWith("../") || rel === "..") throw new VaultError(`Outside the vault: ${relative}`);
    if (rel.split("/").some((part) => part.startsWith("."))) {
      throw new VaultError(`Hidden files and folders are off limits: ${relative}`);
    }
    return { rel, abs: path.join(this.root, ...rel.split("/")) };
  }

  /** Follows symlinks and makes sure the real file is still inside the vault. */
  private async checkReal(abs: string): Promise<void> {
    const [real, root] = await Promise.all([realpath(abs), realpath(this.root)]);
    if (real !== root && !real.startsWith(root + path.sep)) throw new VaultError("That path leads outside the vault.");
  }

  async exists(relative: string): Promise<boolean> {
    try {
      await stat(this.resolve(relative).abs);
      return true;
    } catch (error) {
      if (error instanceof VaultError) throw error;
      return false;
    }
  }

  async readText(relative: string): Promise<{ rel: string; text: string }> {
    const { rel, abs } = this.resolve(relative);
    if (!TEXT_EXTENSIONS.has(path.extname(rel).toLowerCase())) {
      throw new VaultError(`Not a text file: ${rel}`);
    }
    await this.mustExist(rel, abs);
    await this.checkReal(abs);
    return { rel, text: await readFile(abs, "utf8") };
  }

  async readImage(relative: string): Promise<{ rel: string; data: Buffer; mimeType: string }> {
    const { rel, abs } = this.resolve(relative);
    const mimeType = IMAGE_TYPES[path.extname(rel).toLowerCase()];
    if (!mimeType) throw new VaultError(`Not an image: ${rel}`);
    await this.mustExist(rel, abs);
    await this.checkReal(abs);
    return { rel, data: await readFile(abs), mimeType };
  }

  private async mustExist(rel: string, abs: string): Promise<void> {
    try {
      const info = await stat(abs);
      if (!info.isFile()) throw new VaultError(`Not a file: ${rel}`);
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError(`No such note: ${rel}. Use search_notes or list_notes to find the right path.`);
    }
  }

  /** Writes a text file atomically. `mode: "create"` refuses to overwrite. */
  async writeText(relative: string, text: string, mode: "create" | "update"): Promise<string> {
    const { rel, abs } = this.resolve(relative);
    if (!TEXT_EXTENSIONS.has(path.extname(rel).toLowerCase())) throw new VaultError(`Only text notes can be written: ${rel}`);
    const dir = path.dirname(abs);
    await mkdir(dir, { recursive: true });
    await this.checkReal(dir);
    const exists = await this.exists(rel);
    if (mode === "create" && exists) throw new VaultError(`Already exists: ${rel}. Use edit_note to change it.`);
    if (mode === "update" && !exists) throw new VaultError(`No such note: ${rel}.`);
    if (exists) await this.checkReal(abs);
    // The bridge ignores *.tmp, so it only ever sees the finished file.
    const tmp = path.join(dir, `${path.basename(abs)}.${randomBytes(4).toString("hex")}.tmp`);
    await writeFile(tmp, text, "utf8");
    await rename(tmp, abs);
    return rel;
  }

  /**
   * Moves or renames a file inside the vault. `to` ending in "/" (or with no extension) is a folder and the
   * name is kept. Never overwrites, never changes the file's type, never deletes anything.
   */
  async move(from: string, to: string): Promise<{ from: string; to: string }> {
    const source = this.resolve(from);
    if (FIXED.has(source.rel)) throw new VaultError(`${source.rel} stays where it is (it holds the vault's layout together).`);
    await this.mustExist(source.rel, source.abs);
    await this.checkReal(source.abs);
    const name = path.posix.basename(source.rel);
    const asFolder = /[\\/]\s*$/.test(to) || !path.posix.extname(to.trim().replaceAll("\\", "/"));
    const target = this.resolve(asFolder ? `${to.trim().replace(/[\\/]+$/, "")}/${name}` : to);
    if (target.rel === source.rel) throw new VaultError(`${source.rel} is already there.`);
    if (path.extname(target.rel).toLowerCase() !== path.extname(source.rel).toLowerCase()) {
      throw new VaultError(`Moving can't change the file type (${path.extname(source.rel)} → ${path.extname(target.rel) || "none"}).`);
    }
    if (await this.exists(target.rel)) throw new VaultError(`Already exists: ${target.rel}. Pick another name, or merge with edit_note.`);
    const dir = path.dirname(target.abs);
    await mkdir(dir, { recursive: true });
    await this.checkReal(dir);
    await rename(source.abs, target.abs);
    return { from: source.rel, to: target.rel };
  }

  /** Every file under `folder` (vault-relative, "" for all), hidden ones and temp files left out. */
  async list(folder = ""): Promise<NoteInfo[]> {
    const start = folder.trim() ? this.resolve(folder) : { rel: "", abs: this.root };
    try {
      if (!(await stat(start.abs)).isDirectory()) throw new VaultError(`Not a folder: ${folder}`);
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError(`No such folder: ${folder}`);
    }
    await this.checkReal(start.abs);
    const found: NoteInfo[] = [];
    const walk = async (absDir: string, relDir: string) => {
      for (const entry of await readdir(absDir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name.endsWith(".tmp")) continue;
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        const abs = path.join(absDir, entry.name);
        if (entry.isDirectory()) await walk(abs, rel);
        else if (entry.isFile()) {
          const info = await stat(abs);
          const ext = path.extname(entry.name).toLowerCase();
          const kind = TEXT_EXTENSIONS.has(ext) ? "text" : IMAGE_TYPES[ext] ? "image" : "other";
          const note: NoteInfo = { path: rel.normalize("NFC"), kind, size: info.size, modified: info.mtime.toISOString() };
          if (ext === ".md") {
            const properties = frontmatter(await readFile(abs, "utf8"));
            if (Object.keys(properties).length) note.properties = properties;
          }
          found.push(note);
        }
      }
    };
    await walk(start.abs, start.rel);
    return found.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Case-insensitive search over text files: every word must appear in the note or its path. */
  async search(query: string, limit = 10): Promise<SearchHit[]> {
    const terms = query.normalize("NFC").toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) throw new VaultError("Empty query.");
    const hits: SearchHit[] = [];
    for (const note of await this.list()) {
      if (note.kind !== "text") continue;
      const text = (await readFile(this.resolve(note.path).abs, "utf8")).normalize("NFC");
      const lowerText = text.toLocaleLowerCase();
      const lowerPath = note.path.toLocaleLowerCase();
      if (!terms.every((t) => lowerText.includes(t) || lowerPath.includes(t))) continue;
      let score = 0;
      for (const t of terms) {
        score += countOf(lowerText, t) + (lowerPath.includes(t) ? 10 : 0);
      }
      hits.push({ path: note.path, score, properties: note.properties, snippets: snippets(text, terms) });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

export interface SearchHit {
  path: string;
  score: number;
  properties?: Record<string, string>;
  snippets: string[];
}

function countOf(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count++;
  return count;
}

/** Up to three matching lines (with the nearest heading), shortened around the first match. */
function snippets(text: string, terms: string[]): string[] {
  const out: string[] = [];
  let heading = "";
  for (const line of text.split("\n")) {
    if (/^#{1,6}\s/.test(line)) heading = line.replace(/^#+\s*/, "");
    const lower = line.toLocaleLowerCase();
    const at = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0));
    if (!Number.isFinite(at)) continue;
    let piece = line.trim();
    if (piece.length > 240) {
      const from = Math.max(0, at - 100);
      piece = (from > 0 ? "…" : "") + line.slice(from, from + 240).trim() + "…";
    }
    out.push(heading && !line.startsWith("#") ? `[${heading}] ${piece}` : piece);
    if (out.length === 3) break;
  }
  return out;
}

/** The simple `key: value` lines of a note's YAML front matter. */
export function frontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out: Record<string, string> = {};
  if (!match) return out;
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv && kv[2]) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

// --- Edits -------------------------------------------------------------------------------------------

interface Section {
  start: number; // index of the heading line
  end: number; // index of the first line after the section
  level: number;
}

function findSection(lines: string[], heading: string): Section {
  const wanted = heading.replace(/^#+\s*/, "").trim().toLocaleLowerCase();
  const headings = lines
    .map((line, index) => ({ index, match: /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line) }))
    .filter((h) => h.match);
  const found = headings.filter((h) => h.match![2].trim().toLocaleLowerCase() === wanted);
  if (found.length === 0) {
    const all = headings.map((h) => h.match![2]).join(" | ") || "(none)";
    throw new VaultError(`No heading "${heading}". Headings in this note: ${all}`);
  }
  if (found.length > 1) throw new VaultError(`More than one heading "${heading}"; use replace_text instead.`);
  const level = found[0].match![1].length;
  const next = headings.find((h) => h.index > found[0].index && h.match![1].length <= level);
  return { start: found[0].index, end: next ? next.index : lines.length, level };
}

export type Edit =
  | { operation: "append"; text: string }
  | { operation: "append_to_section"; heading: string; text: string }
  | { operation: "replace_section"; heading: string; text: string }
  | { operation: "replace_text"; old_text: string; new_text: string };

export function applyEdit(original: string, edit: Edit): string {
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const body = (s: string) => s.replace(/\r?\n/g, eol).replace(/\s+$/, "");
  switch (edit.operation) {
    case "append": {
      const base = original.replace(/\s+$/, "");
      return (base ? base + eol : "") + body(edit.text) + eol;
    }
    case "replace_text": {
      if (!edit.old_text) throw new VaultError("old_text is empty.");
      const count = countOf(original, edit.old_text);
      if (count === 0) throw new VaultError("old_text was not found; read the note again and copy the text exactly.");
      if (count > 1) throw new VaultError(`old_text appears ${count} times; include more surrounding text so it is unique.`);
      return original.replace(edit.old_text, () => edit.new_text);
    }
    case "append_to_section":
    case "replace_section": {
      const lines = original.split(/\r?\n/);
      const section = findSection(lines, edit.heading);
      // Keep the blank lines that separate this section from the next one.
      let last = section.end;
      while (last > section.start + 1 && lines[last - 1].trim() === "") last--;
      const added = body(edit.text).split(eol);
      const replacement =
        edit.operation === "replace_section"
          ? [lines[section.start], ...added]
          : [...lines.slice(section.start, last), ...added];
      const after = lines.slice(last);
      const gap = section.end < lines.length && after[0]?.trim() !== "" ? [""] : [];
      return [...lines.slice(0, section.start), ...replacement, ...gap, ...after].join(eol);
    }
  }
}
