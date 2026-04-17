FROM couchdb:3.4

# CORS + LiveSync tuning. Loaded from local.d *after* the default local.ini,
# so values here override CouchDB defaults.
COPY couchdb/local.ini /opt/couchdb/etc/local.d/10-livesync.ini

# CouchDB HTTP API / web UI
EXPOSE 5984
