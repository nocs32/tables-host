# secrets/

Files here are ignored by git and live on the Pi only.

| File | What it is |
|---|---|
| `tunnel.json` | The Cloudflare Tunnel's credentials (`cloudflared tunnel create` writes it to `~/.cloudflared/<id>.json`). |
| `felt.env` | Felt Table's core-api environment: `UNSPLASH_ACCESS_KEY` and, optionally, `UNSPLASH_COLLECTION_ID`. Without it the Unsplash picker is off. |
