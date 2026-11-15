# syntax=docker/dockerfile:1
#
# livesync-bridge (github.com/vrtmrz/livesync-bridge): mirrors the notes vault's CouchDB to plain files
# in ~/vault and back. Pinned to a commit: the vault uses NFC path identity, which only main has so far.
# start.ts writes the bridge's config from the secrets at start, so no secret is baked into the image.

FROM denoland/deno:2.9.7

ADD https://github.com/vrtmrz/livesync-bridge.git#1c252305bbddcacd200b8560d3bb786afe0906e9 /app
WORKDIR /app
RUN deno install --frozen
COPY start.ts /app/start.ts

# Run as the Pi's own user (uid 1000), so the files in ~/vault stay editable from the Pi and by the
# notes connector.
RUN mkdir -p /app/dat /deno-dir/location_data && chown -R 1000:1000 /app /deno-dir
USER 1000:1000

CMD ["deno", "run", "-A", "start.ts"]
