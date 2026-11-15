// node --test test/  (Node 24 runs the TypeScript directly)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyEdit, frontmatter, Vault, VaultError } from "../src/vault.ts";

async function fixture(): Promise<Vault> {
  const root = await mkdtemp(path.join(tmpdir(), "vault-"));
  await mkdir(path.join(root, "Projects", "Desk robot"), { recursive: true });
  await mkdir(path.join(root, ".obsidian"));
  await writeFile(path.join(root, ".obsidian", "app.json"), "{}");
  await writeFile(path.join(root, "Home.md"), "# Home\nStart here.\n");
  await writeFile(
    path.join(root, "Projects", "Desk robot", "Print queue.md"),
    "---\ntype: doc\nproject: \"[[Desk robot]]\"\n---\n# Print queue\n\n## Next\n- Benchy\n- Spool holder\n\n## Done\n- nothing yet\n",
  );
  await writeFile(path.join(root, "Projects", "Desk robot", "Desk robot.md"), "---\ntype: project\nstatus: active\n---\nServos: MG90S ×4. Сервоприводи.\n");
  await writeFile(path.join(root, "Projects", "Desk robot", "photo.webp"), Buffer.from([1, 2, 3]));
  return new Vault(root);
}

test("paths stay inside the vault and out of hidden folders", async () => {
  const vault = await fixture();
  for (const bad of ["../etc/passwd", "/../x.md", ".obsidian/app.json", "Projects/.git/config", "..", ""]) {
    assert.throws(() => vault.resolve(bad), VaultError, bad);
  }
  assert.equal(vault.resolve("/Projects\\Desk robot/Print queue.md").rel, "Projects/Desk robot/Print queue.md");
});

test("symlinks out of the vault are refused", async (t) => {
  const vault = await fixture();
  const outside = await mkdtemp(path.join(tmpdir(), "outside-"));
  await writeFile(path.join(outside, "secret.md"), "secret");
  try {
    await symlink(path.join(outside, "secret.md"), path.join(vault.root, "link.md"));
  } catch {
    t.skip("cannot create symlinks here");
    return;
  }
  await assert.rejects(vault.readText("link.md"), VaultError);
});

test("list skips hidden files and reads properties", async () => {
  const vault = await fixture();
  const notes = await vault.list();
  assert.deepEqual(
    notes.map((n) => n.path),
    ["Home.md", "Projects/Desk robot/Desk robot.md", "Projects/Desk robot/photo.webp", "Projects/Desk robot/Print queue.md"],
  );
  assert.equal(notes.find((n) => n.path.endsWith("Desk robot.md"))?.properties?.status, "active");
  assert.equal(notes.find((n) => n.path.endsWith(".webp"))?.kind, "image");
});

test("search needs every word, ranks, handles Ukrainian, gives snippets", async () => {
  const vault = await fixture();
  const hits = await vault.search("print benchy");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, "Projects/Desk robot/Print queue.md");
  assert.ok(hits[0].snippets.some((s) => s.includes("Benchy") && s.startsWith("[Next]")));
  assert.equal((await vault.search("сервоприводи")).length, 1);
  assert.equal((await vault.search("benchy zeppelin")).length, 0);
});

test("create refuses to overwrite; writes leave no temp files", async () => {
  const vault = await fixture();
  await vault.writeText("Inbox/Lamp idea.md", "A lamp.\n", "create");
  await assert.rejects(vault.writeText("Inbox/Lamp idea.md", "again", "create"), VaultError);
  assert.equal(await readFile(path.join(vault.root, "Inbox", "Lamp idea.md"), "utf8"), "A lamp.\n");
  assert.deepEqual(await readdir(path.join(vault.root, "Inbox")), ["Lamp idea.md"]);
  await assert.rejects(vault.writeText("Inbox/x.exe", "no", "create"), VaultError);
});

const queue = "# Print queue\n\n## Next\n- Benchy\n- Spool holder\n\n## Done\n- nothing yet\n";

test("append_to_section adds at the end of the section, keeping the gap", () => {
  assert.equal(
    applyEdit(queue, { operation: "append_to_section", heading: "next", text: "- Lamp shade" }),
    "# Print queue\n\n## Next\n- Benchy\n- Spool holder\n- Lamp shade\n\n## Done\n- nothing yet\n",
  );
  // Last section in the file.
  assert.equal(
    applyEdit(queue, { operation: "append_to_section", heading: "## Done", text: "- Benchy" }),
    "# Print queue\n\n## Next\n- Benchy\n- Spool holder\n\n## Done\n- nothing yet\n- Benchy\n",
  );
});

test("replace_section keeps the heading and the next section", () => {
  assert.equal(
    applyEdit(queue, { operation: "replace_section", heading: "Next", text: "- Calipers case" }),
    "# Print queue\n\n## Next\n- Calipers case\n\n## Done\n- nothing yet\n",
  );
});

test("a top-level section includes its subsections", () => {
  assert.equal(
    applyEdit(queue, { operation: "append_to_section", heading: "Print queue", text: "Footer" }),
    queue + "Footer\n",
  );
});

test("unknown heading lists the real ones", () => {
  assert.throws(() => applyEdit(queue, { operation: "append_to_section", heading: "Later", text: "x" }), /Next \| Done/);
});

test("replace_text needs exactly one match", () => {
  assert.equal(applyEdit(queue, { operation: "replace_text", old_text: "- nothing yet", new_text: "- Benchy ✓" }).includes("- Benchy ✓"), true);
  assert.throws(() => applyEdit("a a", { operation: "replace_text", old_text: "a", new_text: "b" }), /2 times/);
  assert.throws(() => applyEdit("a", { operation: "replace_text", old_text: "z", new_text: "b" }), /not found/);
  // `$&` in the new text is taken literally.
  assert.equal(applyEdit("price: X", { operation: "replace_text", old_text: "X", new_text: "$&5" }), "price: $&5");
});

test("append keeps one line break and CRLF notes stay CRLF", () => {
  assert.equal(applyEdit("a\n\n\n", { operation: "append", text: "b" }), "a\nb\n");
  assert.equal(applyEdit("a\r\nb\r\n", { operation: "append", text: "c\nd" }), "a\r\nb\r\nc\r\nd\r\n");
});

test("frontmatter reads simple key: value lines", () => {
  assert.deepEqual(frontmatter("---\ntype: project\nstatus: \"idea\"\nlist:\n  - x\n---\nbody"), { type: "project", status: "idea" });
  assert.deepEqual(frontmatter("no front matter"), {});
});
