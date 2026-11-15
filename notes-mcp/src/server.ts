// Tim's notes vault as an MCP server for claude.ai (a custom connector). Streamable HTTP, stateless.
// The way in is https://notes-mcp.timnox.dev/mcp with the header `Authorization: Bearer <NOTES_MCP_SECRET>`
// (or the older /<NOTES_MCP_SECRET>/mcp); anything else is a 404.
// Tools: search, list, read (text and images), create, edit. Nothing can be deleted.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { applyEdit, IMAGE_TYPES, Vault, VaultError, type Edit } from "./vault.ts";

const VAULT_DIR = process.env.VAULT_DIR ?? "/vault";
const PORT = Number(process.env.PORT ?? 3000);
const SECRET = process.env.NOTES_MCP_SECRET ?? "";
if (SECRET.length < 32) {
  console.error("NOTES_MCP_SECRET is missing or shorter than 32 characters (see secrets/README.md). Not starting.");
  process.exit(1);
}

const vault = new Vault(VAULT_DIR);
const MAX_TEXT = 200_000;
const MAX_IMAGE = 4_000_000;

const INSTRUCTIONS = `This is Tim's notes vault (an Obsidian vault of Markdown files): his hobby projects, ideas, shopping lists and research.
Search it before answering anything about his projects, plans, purchases, printer, robots, home network or ideas, and say which note an answer came from.
Layout: Home.md explains the vault. Projects/<Name>/<Name>.md is each project's main note (front matter: type: project, status: idea | active | parked | binned); other files in that folder belong to the project (type: doc). Inbox/ holds quick captures. Research/ holds reports. Archive/ holds binned ideas.
When Tim asks to note or remember something new that has no obvious home, create it in Inbox/. Add to existing notes with edit_note rather than rewriting them, and keep their front matter and wording. Notes can be in English or Ukrainian; answer in the language Tim uses.
Never put passwords, keys or other secrets into notes.`;

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function failure(error: unknown) {
  const message = error instanceof VaultError ? error.message : "Something went wrong on the server; try again.";
  if (!(error instanceof VaultError)) console.error(error);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function log(tool: string, detail: string) {
  console.log(`${new Date().toISOString()} ${tool} ${detail}`);
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "tims-notes", version: "1.0.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "search_notes",
    {
      title: "Search notes",
      description:
        "Full-text search over the vault. Every word must appear in the note or its path (case-insensitive). Returns the best matches with their properties and matching lines. Use short, distinctive words; try synonyms or the other language if nothing comes back.",
      inputSchema: {
        query: z.string().min(1).describe("Words to look for, e.g. 'print queue' or 'servo'"),
        limit: z.number().int().min(1).max(30).optional().describe("How many notes to return (default 10)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      try {
        log("search_notes", JSON.stringify(query));
        const hits = await vault.search(query, limit ?? 10);
        if (!hits.length) return text(`No notes contain all of: ${query}`);
        return text(
          hits
            .map((h) => {
              const props = h.properties ? ` (${Object.entries(h.properties).map(([k, v]) => `${k}: ${v}`).join(", ")})` : "";
              return `## ${h.path}${props}\n${h.snippets.map((s) => `- ${s}`).join("\n")}`;
            })
            .join("\n\n"),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "list_notes",
    {
      title: "List notes",
      description:
        "Lists the files in the vault or in one folder (recursively), with each Markdown note's properties (type, status, project). Good for overviews like 'which projects are active?'.",
      inputSchema: {
        folder: z.string().optional().describe("Vault-relative folder, e.g. 'Projects' or 'Projects/Desk robot'; omit for the whole vault"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ folder }) => {
      try {
        log("list_notes", folder ?? "(all)");
        const notes = await vault.list(folder ?? "");
        if (!notes.length) return text("No files there.");
        return text(
          notes
            .map((n) => {
              const props = n.properties ? ` — ${Object.entries(n.properties).map(([k, v]) => `${k}: ${v}`).join(", ")}` : "";
              const kind = n.kind === "text" ? "" : ` [${n.kind}]`;
              return `${n.path}${kind} (${n.modified.slice(0, 10)})${props}`;
            })
            .join("\n"),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "read_note",
    {
      title: "Read a note",
      description: "Returns a note's full text (Markdown with front matter), or the picture itself for an image file (png, jpg, webp, gif).",
      inputSchema: { path: z.string().min(1).describe("Vault-relative path, e.g. 'Projects/Desk robot/Print queue.md'") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path: notePath }) => {
      try {
        log("read_note", notePath);
        if (IMAGE_TYPES[path.extname(notePath).toLowerCase()]) {
          const image = await vault.readImage(notePath);
          if (image.data.length > MAX_IMAGE) return text(`${image.rel} is too large to send (${image.data.length} bytes).`);
          return { content: [{ type: "image" as const, data: image.data.toString("base64"), mimeType: image.mimeType }] };
        }
        const note = await vault.readText(notePath);
        const body = note.text.length > MAX_TEXT ? `${note.text.slice(0, MAX_TEXT)}\n\n[… cut at ${MAX_TEXT} characters]` : note.text;
        return text(`# ${note.rel}\n\n${body}`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "create_note",
    {
      title: "Create a note",
      description:
        "Creates a new Markdown note; it reaches Obsidian on Tim's phone and PC within seconds. Fails if the note exists (use edit_note then). A bare name goes into Inbox/. Start project notes with front matter (type, status).",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path, e.g. 'Inbox/Lamp idea.md'; '.md' is added if missing"),
        content: z.string().describe("The note's Markdown"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ path: notePath, content }) => {
      try {
        let target = notePath.trim();
        if (!/\.[A-Za-z0-9]+$/.test(target)) target += ".md";
        if (!target.includes("/")) target = `Inbox/${target}`;
        log("create_note", target);
        const rel = await vault.writeText(target, content.endsWith("\n") ? content : `${content}\n`, "create");
        return text(`Created ${rel}.`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "edit_note",
    {
      title: "Edit a note",
      description:
        "Changes an existing note without rewriting it. Operations: 'append' (text at the end), 'append_to_section' (text at the end of the section under `heading`), 'replace_section' (new body for the section under `heading`, heading kept), 'replace_text' (swap `old_text`, which must appear exactly once, for `new_text`). Read the note first so headings and text match.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path of the note"),
        operation: z.enum(["append", "append_to_section", "replace_section", "replace_text"]),
        text: z.string().optional().describe("For append, append_to_section and replace_section"),
        heading: z.string().optional().describe("For the section operations: the heading's text, without the #"),
        old_text: z.string().optional().describe("For replace_text: the exact current text"),
        new_text: z.string().optional().describe("For replace_text: the text to put in its place"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ path: notePath, operation, text: body, heading, old_text, new_text }) => {
      try {
        log("edit_note", `${operation} ${notePath}${heading ? ` [${heading}]` : ""}`);
        let edit: Edit;
        if (operation === "replace_text") {
          if (old_text === undefined || new_text === undefined) throw new VaultError("replace_text needs old_text and new_text.");
          edit = { operation, old_text, new_text };
        } else {
          if (body === undefined) throw new VaultError(`${operation} needs text.`);
          if (operation === "append") edit = { operation, text: body };
          else {
            if (!heading) throw new VaultError(`${operation} needs heading.`);
            edit = { operation, heading, text: body };
          }
        }
        const note = await vault.readText(notePath);
        const updated = applyEdit(note.text, edit);
        if (updated === note.text) return text(`Nothing changed in ${note.rel}.`);
        await vault.writeText(note.rel, updated, "update");
        return text(`Updated ${note.rel} (${operation}).`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}

// --- HTTP ------------------------------------------------------------------------------------------------

const secretPath = Buffer.from(`/${SECRET}/mcp`);
const bearer = Buffer.from(`Bearer ${SECRET}`);

function same(given: string, expected: Buffer): boolean {
  const value = Buffer.from(given);
  return value.length === expected.length && timingSafeEqual(value, expected);
}

/** The way in: `/mcp` with `Authorization: Bearer <secret>` (claude.ai's request header), or the older `/<secret>/mcp`. */
function isAllowed(req: IncomingMessage): boolean {
  const pathname = (req.url ?? "").split("?")[0];
  if (pathname === "/mcp") return same(req.headers.authorization ?? "", bearer);
  return same(pathname, secretPath);
}

function plain(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "content-type": "text/plain" }).end(body);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 5_000_000) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

createServer(async (req, res) => {
  if (req.url === "/healthz") return plain(res, 200, "ok");
  if (!isAllowed(req)) return plain(res, 404, "Not found");
  if (req.method !== "POST") {
    // Stateless server: no standalone SSE stream and no sessions to end.
    res.writeHead(405, { allow: "POST", "content-type": "application/json" });
    return res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
  }
  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
  }
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
    }
  }
}).listen(PORT, () => console.log(`Notes MCP server on :${PORT}, vault ${VAULT_DIR}`));
