# secrets/

Files here are ignored by git and live on the Pi only.

| File | What it is |
|---|---|
| `tunnel.json` | The Cloudflare Tunnel's credentials (`cloudflared tunnel create` writes it to `~/.cloudflared/<id>.json`). |
| `media.env` | Cinemate's relay: `MTX_WEBRTCADDITIONALHOSTS=<the home's public IP>`, the address browsers send the live-share video to. Without it only people at home can watch. |
| `felt.env` | Felt Table's core-api environment: `UNSPLASH_ACCESS_KEY` and, optionally, `UNSPLASH_COLLECTION_ID`. Without it the Unsplash picker is off. |
| `tunes.env` | Tunes' settings: `SPOTIFY_CLIENT_ID`, `ANTHROPIC_API_KEY`, `PUBLIC_URL=https://tunes.timnox.dev`, and `TOKEN_KEY` (32 random bytes, base64, made on the Pi: `head -c 32 /dev/urandom \| base64`). Changing `TOKEN_KEY` logs everyone out. Without the file Tunes stops at start and says what's missing. |
| `couchdb.env` | The notes vault's CouchDB admin: `COUCHDB_USER=tim` and `COUCHDB_PASSWORD` (made on the Pi: `head -c 24 /dev/urandom \| base64 \| tr -d '/+='`). Obsidian's LiveSync and the bridge log in with it. Required: without it CouchDB won't start. |
