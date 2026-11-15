// Starts the real server on a temporary vault and talks to it with the MCP SDK's own client.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
const PORT = 3917;
const BASE = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let vaultDir: string;

before(async () => {
  vaultDir = await mkdtemp(path.join(tmpdir(), "vault-e2e-"));
  await mkdir(path.join(vaultDir, "Projects", "Desk robot"), { recursive: true });
  await writeFile(path.join(vaultDir, "Projects", "Desk robot", "Print queue.md"), "# Print queue\n\n## Next\n- Benchy\n\n## Done\n");
  server = spawn(process.execPath, [path.join(import.meta.dirname, "..", "src", "server.ts")], {
    env: { ...process.env, VAULT_DIR: vaultDir, PORT: String(PORT), NOTES_MCP_SECRET: SECRET },
    stdio: "pipe",
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
});

after(() => server.kill());

async function connect(): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/${SECRET}/mcp`)));
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
}

test("wrong paths and wrong keys get a plain 404", async () => {
  for (const p of ["/", "/mcp", `/${SECRET.slice(0, -1)}x/mcp`, `/${SECRET}/mcp/extra`]) {
    const res = await fetch(`${BASE}${p}`, { method: "POST", body: "{}" });
    assert.equal(res.status, 404, p);
  }
  for (const auth of [`Bearer ${SECRET}x`, SECRET, `bearer ${SECRET}`, "Bearer "]) {
    const res = await fetch(`${BASE}/mcp`, { method: "POST", body: "{}", headers: { authorization: auth } });
    assert.equal(res.status, 404, auth);
  }
  // The key belongs in the header, not both: the secret path with a header is still just the secret path.
  const res = await fetch(`${BASE}/${SECRET}/mcp`, { method: "GET" });
  assert.equal(res.status, 405);
});

test("the Authorization header opens /mcp", async () => {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${SECRET}` } } }),
  );
  const { tools } = await client.listTools();
  assert.equal(tools.length, 5);
  await client.close();
});

test("tools are listed with instructions", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["create_note", "edit_note", "list_notes", "read_note", "search_notes"]);
  assert.match(client.getInstructions() ?? "", /Tim's notes vault/);
  await client.close();
});

test("search, read, edit and create round trip", async () => {
  const client = await connect();
  assert.match(textOf(await client.callTool({ name: "search_notes", arguments: { query: "benchy" } })), /Print queue\.md/);

  const edit = await client.callTool({
    name: "edit_note",
    arguments: { path: "Projects/Desk robot/Print queue.md", operation: "append_to_section", heading: "Next", text: "- Lamp shade" },
  });
  assert.equal(edit.isError, undefined, textOf(edit));
  assert.equal(
    await readFile(path.join(vaultDir, "Projects", "Desk robot", "Print queue.md"), "utf8"),
    "# Print queue\n\n## Next\n- Benchy\n- Lamp shade\n\n## Done\n",
  );

  const created = await client.callTool({ name: "create_note", arguments: { path: "Lamp idea", content: "Spiral shade." } });
  assert.match(textOf(created), /Created Inbox\/Lamp idea\.md/);
  assert.equal(await readFile(path.join(vaultDir, "Inbox", "Lamp idea.md"), "utf8"), "Spiral shade.\n");

  const again = await client.callTool({ name: "create_note", arguments: { path: "Inbox/Lamp idea.md", content: "x" } });
  assert.equal(again.isError, true);

  const escape = await client.callTool({ name: "read_note", arguments: { path: "../../etc/passwd" } });
  assert.equal(escape.isError, true);

  assert.match(textOf(await client.callTool({ name: "list_notes", arguments: {} })), /Inbox\/Lamp idea\.md/);
  await client.close();
});
