# Tables Host

Runs the five table games and their catalogue page on a Raspberry Pi, behind one Cloudflare Tunnel.

| Address | What |
|---|---|
| https://library.timnox.dev | The catalogue: every game as a card, in English or Ukrainian |
| https://jigsaw.timnox.dev | [Felt Table](https://github.com/nocs32/felt-table-jigsaw), the multiplayer jigsaw |
| https://scribble.timnox.dev | [Scribble Table](https://github.com/nocs32/scribble-table), draw and guess |
| https://telephone.timnox.dev | [Telephone Table](https://github.com/nocs32/telephone-table), the telephone drawing game |
| https://wild.timnox.dev | [Wild Table](https://github.com/nocs32/wild-table), the card game on a 3D table |
| https://bluff.timnox.dev | [Bluff Table](https://github.com/nocs32/bluff-table), the bluffing game in a saloon |

The game repos don't change for this: `deploy.sh` clones each one's `main` from GitHub and builds it with the same Dockerfile.

## How it fits together

```
internet ─► Cloudflare ─► tunnel ─► caddy ─┬─► library page (static)
                       (container) (container)├─► felt      (core-api + live tables)
                                              ├─► scribble
                                              ├─► telephone
                                              ├─► wild
                                              └─► bluff
```

- **tunnel** (`cloudflare/cloudflared`): connects out to Cloudflare, so no router ports are opened. Cloudflare does the HTTPS; every hostname arrives at Caddy.
- **caddy**: picks the game by hostname. It serves the game's built web app, sends `/api/*` to the game, and sends `/live/*` (the live tables, over WebSocket) to the game without the `/live` prefix, the same as `vite preview` did for `pnpm play`.
- **One container per game** (`game.Dockerfile`): runs the game's core-api on port 3000. The image also carries the built web app, which the Caddy image copies at build time.

Tables live in each game's memory, as before: restarting a game's container clears its tables, and only that game's.

## Deploy

On the Pi:

```bash
cd ~/tables-host
git pull
./deploy.sh
```

- `./deploy.sh` fetches every game's latest `main`, builds them **one at a time** (five Vite builds at once would run the Pi out of memory), rebuilds Caddy and restarts what changed.
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

## Setting up the tunnel

Done once, from a computer where `cloudflared tunnel login` has been run:

```bash
cloudflared tunnel create tables
cloudflared tunnel route dns --overwrite-dns tables library.timnox.dev
```

Repeat the `route dns` line for `jigsaw`, `scribble`, `telephone`, `wild` and `bluff`. Then:

- copy `~/.cloudflared/<tunnel id>.json` to `secrets/tunnel.json` on the Pi;
- put the tunnel id in `cloudflared/config.yml`;
- run `./deploy.sh`.

## The Pi

Raspberry Pi 4 (4 GB) with Raspberry Pi OS (64-bit, Bookworm), Docker and the Compose plugin. Swap is 2 GB for the builds, Docker's logs are capped at 10 MB × 3 per container, and it boots to the console without a desktop.
