# syntax=docker/dockerfile:1
#
# Caddy with every game's built web app baked in. Each named context (felt, scribble, …) is that
# game's image, passed in by compose.yaml's `additional_contexts`.

FROM caddy:2.11.4-alpine

COPY --from=felt /web /srv/felt
COPY --from=scribble /web /srv/scribble
COPY --from=telephone /web /srv/telephone
COPY --from=wild /web /srv/wild
COPY --from=bluff /web /srv/bluff
COPY --from=cinemate /web /srv/cinemate
COPY --from=zdam /web /srv/zdam
COPY Caddyfile /etc/caddy/Caddyfile
