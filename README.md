# Tables Host

Runs the five table games, their catalogue page, Cinemate and Tunes on a Raspberry Pi, behind one Cloudflare Tunnel.

| Address | What |
|---|---|
| https://library.timnox.dev | The catalogue: every game as a card, in English or Ukrainian |
| https://jigsaw.timnox.dev | [Felt Table](https://github.com/nocs32/felt-table-jigsaw), the multiplayer jigsaw |
| https://scribble.timnox.dev | [Scribble Table](https://github.com/nocs32/scribble-table), draw and guess |
| https://telephone.timnox.dev | [Telephone Table](https://github.com/nocs32/telephone-table), the telephone drawing game |
| https://wild.timnox.dev | [Wild Table](https://github.com/nocs32/wild-table), the card game on a 3D table |
| https://bluff.timnox.dev | [Bluff Table](https://github.com/nocs32/bluff-table), the bluffing game in a saloon |
| https://cinemate.timnox.dev | [Cinemate](https://github.com/nocs32/cinemate), watching videos together in sync (not a table game, but built and hosted the same way) |
| https://tunes.timnox.dev | [Tunes](https://github.com/nocs32/tunes), new music from your Spotify taste, picked by Claude, for a few friends. Not on the catalogue page: only Spotify accounts on its user list can log in |
| https://notes.timnox.dev | The notes vault's sync hub: CouchDB for Obsidian's Self-hosted LiveSync plugin. Not a web page, and not on the catalogue page: only Obsidian (with the login) talks to it |
| https://notes-mcp.timnox.dev | The notes vault for claude.ai: an MCP server, added in claude.ai as a custom connector. Answers only at `/mcp` with `Authorization: Bearer <secret>` (`secrets/notes-mcp.env`); everything else is a 404 |

The game repos don't change for this: `deploy.sh` clones each one's `main` from GitHub and builds it with the same Dockerfile. Tunes is the exception: it brings its own `Dockerfile`.

## How it fits together

```
internet ─► Cloudflare ─► tunnel ─► caddy ─┬─► library page (static)
                       (container) (container)├─► felt      (core-api + live tables)
                                              ├─► scribble
                                              ├─► telephone
                                              ├─► wild
                                              ├─► bluff
                                              ├─► tunes     (API; SQLite in the tunes-data volume)
                                              ├─► couchdb   (notes vault sync; couchdb-data volume)
                                              │     ▲
                                              │   bridge ◄──► ~/vault (plain .md files on the Pi)
                                              │                 ▲
                                              ├─► notes-mcp ────┘ (claude.ai connector)
                                              └─► cinemate ◄── media (relay)
                                                                 ▲
internet ─► MikroTik, UDP/TCP 8189 ─► media (Cinemate's live-share video)
```

- **tunnel** (`cloudflare/cloudflared`): connects out to Cloudflare, so the sites need no router ports. Cloudflare does the HTTPS; every hostname arrives at Caddy.
- **caddy**: picks the game by hostname. It serves the game's built web app, sends `/api/*` to the game, and sends `/live/*` (the live tables, over WebSocket) to the game without the `/live` prefix, the same as `vite preview` did for `pnpm play`.
- **One container per game** (`game.Dockerfile`): runs the game's core-api on port 3000. The image also carries the built web app, which the Caddy image copies at build time.
- **tunes** (its repo's own `Dockerfile`): the same arrangement, Caddy serving the page and sending `/api/*` to the container. Logins, mixes and votes live in SQLite in the `tunes-data` volume, which survives rebuilds (`docker compose down -v` would delete it). A mix takes 1–2 minutes, longer than Cloudflare's 100-second limit for one request, so the page starts it as a job and checks back.

- **couchdb** (`couchdb`, `couchdb/10-livesync.ini`): the sync hub for Tim's Obsidian notes vault. Obsidian on every device syncs through it with the Self-hosted LiveSync plugin, which encrypts the notes end to end, so the database holds only ciphertext. CouchDB checks the login itself (admin from `secrets/couchdb.env`); Caddy just passes `notes.timnox.dev` through. Data lives in the `couchdb-data` volume. Its image is the official one plus that settings file (a read-only mount makes the image's entrypoint stop). `docker compose up -d --build couchdb` updates it on its own.

- **bridge** (`bridge/`, [livesync-bridge](https://github.com/vrtmrz/livesync-bridge) pinned to one commit): keeps `~/vault` on the Pi, plain Markdown files, in sync with the notes database in both directions, so tools that aren't Obsidian can use the notes. It talks to `couchdb` directly, not through Caddy, and runs as the Pi's own user so the files stay editable there. `bridge/start.ts` writes its config from `secrets/couchdb.env` and `secrets/bridge.env` when it starts. The `bridge-state` volume remembers what it has synced; losing it only means a full rescan.

- **notes-mcp** (`notes-mcp/`, TypeScript run directly by Node 24): the notes vault as an MCP server for claude.ai, over `~/vault`. Tools: search, list, read (text and images), create, edit (append, add to or replace a section, replace text). Nothing can be deleted, paths can't leave the vault or touch hidden folders, and writes are atomic. claude.ai reaches it at `/mcp` with the request header `Authorization: Bearer <NOTES_MCP_SECRET>` (the older `/<NOTES_MCP_SECRET>/mcp` also works); anything else is a 404. Tests: `npm install && npm test` in `notes-mcp/` (Node 24).

- **media** (`bluenviron/mediamtx`, `media/mediamtx.yml`): Cinemate's live-share relay. It takes a share over WHIP and copies it to every watcher over WHEP without re-encoding. The small setup requests come through the tunnel (Caddy sends `cinemate.timnox.dev/media/*` to it); the video can't, so it comes in on **UDP 8189** (TCP 8189 as the fallback), the one port the MikroTik forwards to the Pi. It runs on the host network to announce the Pi's addresses, takes the home's public IP from `secrets/media.env`, and asks Cinemate's core-api (`127.0.0.1:2573`, only on the Pi) before anyone publishes or watches.

Tables live in each game's memory, as before: restarting a game's container clears its tables, and only that game's.

## Deploy

On the Pi:

```bash
cd ~/tables-host
git pull
./deploy.sh
```

- `./deploy.sh` fetches every game's latest `main`, builds them **one at a time** (several Vite builds at once would run the Pi out of memory), rebuilds Caddy and restarts what changed.
- `./deploy.sh wild` rebuilds just Wild Table (and Caddy, to pick up its web app). Several work too: `./deploy.sh wild bluff`.
- A change to `library/index.html` needs no build: `git pull` is enough, since Caddy reads it straight from this folder.

The first full build takes a while on a Pi 4; later ones reuse the package cache.

## Check on it

```bash
docker compose ps                  # every container, and whether it's healthy
docker compose logs -f wild        # one game's log
docker compose logs -f tunnel      # the tunnel's connection to Cloudflare
docker compose restart bluff       # restart one game (clears its tables)
```

To open the games from the PC before the tunnel is up, forward Caddy's port and use the `.localhost` names:

```bash
ssh -L 8080:127.0.0.1:8080 pi
```

Then open http://wild.localhost:8080, http://library.localhost:8080 and so on.

## Secrets

Kept in `secrets/` on the Pi, never in git (see [secrets/README.md](secrets/README.md)):

- `tunnel.json`: the tunnel's credentials.
- `felt.env`: Felt Table's Unsplash key. Optional: without it the Unsplash picker is off.
- `tunes.env`: Tunes' settings: `SPOTIFY_CLIENT_ID`, `ANTHROPIC_API_KEY`, `PUBLIC_URL=https://tunes.timnox.dev`, and `TOKEN_KEY` (made on the Pi; changing it logs everyone out). Without it Tunes doesn't start.
- `couchdb.env`: the notes CouchDB's admin, `COUCHDB_USER` and `COUCHDB_PASSWORD`. Required: without it CouchDB doesn't start.
- `bridge.env`: the vault's E2E passphrase and ID key for the notes bridge. Make it on the Pi with `bridge/set-secrets.sh`, which asks for both without showing them.
- `notes-mcp.env`: `NOTES_MCP_SECRET`, the key claude.ai's connector sends as `Authorization: Bearer <secret>`. Without it the notes MCP server doesn't start.

## Setting up the tunnel

Done once, from a computer where `cloudflared tunnel login` has been run:

```bash
cloudflared tunnel create tables
cloudflared tunnel route dns --overwrite-dns tables library.timnox.dev
```

Repeat the `route dns` line for `jigsaw`, `scribble`, `telephone`, `wild`, `bluff`, `cinemate`, `tunes`, `notes` and `notes-mcp`. Then:

- copy `~/.cloudflared/<tunnel id>.json` to `secrets/tunnel.json` on the Pi;
- put the tunnel id in `cloudflared/config.yml`;
- run `./deploy.sh`.

## The Pi

Raspberry Pi 4 (4 GB) with Raspberry Pi OS (64-bit, Bookworm), Docker and the Compose plugin. Swap is 2 GB for the builds, Docker's logs are capped at 10 MB × 3 per container, and it boots to the console without a desktop.
