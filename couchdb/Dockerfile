# syntax=docker/dockerfile:1
#
# CouchDB with the LiveSync settings baked in. Not a bind mount: the image's entrypoint chowns and
# chmods everything under etc/ and stops if it can't, which a read-only mount makes it do.

FROM couchdb:3.5.0

COPY --chown=couchdb:couchdb --chmod=0640 10-livesync.ini /opt/couchdb/etc/local.d/10-livesync.ini
