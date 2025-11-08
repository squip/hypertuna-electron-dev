#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
APP_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
cd "$APP_DIR"

PG_OS_USER=postgres
DATA_DIR="${POSTGRES_DATA_DIR:-/var/lib/postgresql/data}"
RUN_DIR="${POSTGRES_RUN_DIR:-/var/run/postgresql}"
POSTGRES_USER="${POSTGRES_USER:-gateway}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-gateway}"
POSTGRES_DB="${POSTGRES_DB:-gateway_escrow}"

export ESCROW_DATABASE_URL="${ESCROW_DATABASE_URL:-postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB}}"

ensure_directories() {
  mkdir -p "$DATA_DIR" "$RUN_DIR"
  chown -R "$PG_OS_USER":"$PG_OS_USER" "$DATA_DIR" "$RUN_DIR"
}

maybe_initdb() {
  if [[ ! -s "$DATA_DIR/PG_VERSION" ]]; then
    su - "$PG_OS_USER" -c "initdb -D '$DATA_DIR' -E UTF8 --locale=C.UTF-8"
  fi
}

start_postgres() {
  su - "$PG_OS_USER" -c "pg_ctl -D '$DATA_DIR' -o \"-c listen_addresses='127.0.0.1' -c unix_socket_directories='$RUN_DIR'\" -w start"
}

stop_postgres() {
  if su - "$PG_OS_USER" -c "pg_ctl -D '$DATA_DIR' status" >/dev/null 2>&1; then
    su - "$PG_OS_USER" -c "pg_ctl -D '$DATA_DIR' -m fast stop"
  fi
}

wait_for_postgres() {
  until su - "$PG_OS_USER" -c "pg_isready -q -d 'postgres'"; do
    sleep 0.5
  done
}

ensure_database() {
  su - "$PG_OS_USER" -c "psql --dbname=postgres <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${POSTGRES_USER}') THEN
    CREATE ROLE \"${POSTGRES_USER}\" LOGIN PASSWORD '${POSTGRES_PASSWORD}';
  ELSE
    ALTER ROLE \"${POSTGRES_USER}\" WITH LOGIN PASSWORD '${POSTGRES_PASSWORD}';
  END IF;
END \$\$;
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${POSTGRES_DB}') THEN
    CREATE DATABASE \"${POSTGRES_DB}\" OWNER \"${POSTGRES_USER}\";
  END IF;
END \$\$;
GRANT ALL PRIVILEGES ON DATABASE \"${POSTGRES_DB}\" TO \"${POSTGRES_USER}\";
SQL"
}

ensure_pgcrypto() {
  su - "$PG_OS_USER" -c "psql --dbname='${POSTGRES_DB}' -c \"CREATE EXTENSION IF NOT EXISTS pgcrypto;\""
}

on_exit() {
  stop_postgres
}

forward_signal() {
  if [[ -n "${APP_PID:-}" ]]; then
    kill -"$1" "$APP_PID" 2>/dev/null || true
  fi
  on_exit
  exit 0
}

ensure_directories
maybe_initdb
start_postgres
wait_for_postgres
ensure_database
ensure_pgcrypto

trap 'forward_signal SIGINT' SIGINT
trap 'forward_signal SIGTERM' SIGTERM
trap on_exit EXIT

node src/escrow/db/run-migrations.mjs

node src/index.mjs &
APP_PID=$!
wait "$APP_PID"
EXIT_CODE=$?
on_exit
exit "$EXIT_CODE"
