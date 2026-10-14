#!/bin/sh
# EFMIS backup: PostgreSQL (EFMIS + Traccar databases, custom format) and private file storage, with retention.
# Run daily from cron on the database host, e.g.:  15 2 * * *  /opt/efmis/docker/backup.sh >> /var/log/efmis-backup.log 2>&1
# Restore test (do it regularly): pg_restore -d efmis_restore_test --clean --if-exists <file>.dump
set -eu

BACKUP_DIR="${BACKUP_DIR:-/var/backups/efmis}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
PG_CONTAINER="${PG_CONTAINER:-efmis-postgres}"
PG_USER="${PG_USER:-efmis}"
STORAGE_DIR="${STORAGE_DIR:-/opt/efmis/storage}"   # proof-of-delivery, driver documents, uploads (host path of the volume)
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$BACKUP_DIR"
umask 077   # backups contain personal data

for DB in efmis traccar; do
  OUT="$BACKUP_DIR/$DB-$STAMP.dump"
  docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$DB" -Fc > "$OUT.partial"
  mv "$OUT.partial" "$OUT"
  # integrity check: the archive must list its contents
  docker exec -i "$PG_CONTAINER" pg_restore --list < "$OUT" > /dev/null
  echo "$(date -u +%FT%TZ) ok $OUT ($(du -h "$OUT" | cut -f1))"
done

if [ -d "$STORAGE_DIR" ]; then
  tar -czf "$BACKUP_DIR/storage-$STAMP.tar.gz" -C "$STORAGE_DIR" .
  echo "$(date -u +%FT%TZ) ok storage-$STAMP.tar.gz"
fi

find "$BACKUP_DIR" -type f \( -name '*.dump' -o -name '*.tar.gz' \) -mtime +"$RETENTION_DAYS" -delete
echo "$(date -u +%FT%TZ) retention: kept the last $RETENTION_DAYS days"
# Copy $BACKUP_DIR off-site (another data centre / object storage) — a backup on the same host is not a backup.
