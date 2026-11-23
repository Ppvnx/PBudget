#!/bin/sh
# The schema step. Setups runs it ONCE per deploy as the pbudget-migrate Job
# (`sh scripts/migrate.sh`, util/migrate_job.py), before any pod runs the new build;
# it never runs at container start. The app repo owns WHAT the migration is, Setups
# only WHEN.
#
# `db push --accept-data-loss` is required to ADD safe constraints unattended (e.g.
# Vendor @@unique([userId, priority]); without the flag prisma refuses
# non-interactively). It is GUARDED first: `migrate diff` computes the exact SQL from
# the live DB to the schema, and we REFUSE (exit 1, the Job fails, the deploy stops
# before any pod runs the build) if it would DROP a table/column. (DROP
# INDEX/CONSTRAINT is not data loss.) DIRECT url: PgBouncer's transaction mode can't
# hold the session Prisma needs.
set -e
. /vault/secrets/config
. /vault/secrets/db
DIFF="$(npx prisma migrate diff --from-url "$DIRECT_DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script)"
printf 'prisma schema diff (db -> schema):\n%s\n' "$DIFF"
if printf '%s' "$DIFF" | grep -iqE 'DROP (TABLE|COLUMN)'; then
  echo "FATAL: refusing destructive schema change (see diff above)"
  exit 1
fi
DATABASE_URL="$DIRECT_DATABASE_URL" npx prisma db push --accept-data-loss --skip-generate
# Job rows (lib/jobs.ts) go after 7 days: Setups' pg-ttl CronJob deletes by this comment.
echo "COMMENT ON COLUMN \"Job\".\"createdAt\" IS 'ttl 7 days';" | npx prisma db execute --url "$DIRECT_DATABASE_URL" --stdin
