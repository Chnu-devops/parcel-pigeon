#!/usr/bin/env bash
# ParcelPigeon dev orchestrator (local-no-docker branch).
#
# Docker runs the datastores only; the four app services run natively on the
# host — see docs/running-locally.md for the per-service commands.
#
#   ./scripts/dev.sh up             start datastores (postgres/redis/rabbitmq/mailhog)
#   ./scripts/dev.sh down           stop datastores (keep volumes)
#   ./scripts/dev.sh reset          stop datastores + wipe volumes
#   ./scripts/dev.sh migrate        alembic upgrade head (shipments-service)
#   ./scripts/dev.sh seed [--force] load demo shipments (shipments-service)
#   ./scripts/dev.sh smoke          run the end-to-end smoke test
#   ./scripts/dev.sh load           k6 load test (BASE_URL, VUS, DURATION) — see scripts/load.js
#   ./scripts/dev.sh logs [svc]     tail datastore logs
#   ./scripts/dev.sh ps             datastore container status
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Prefer the `docker compose` plugin; fall back to standalone `docker-compose`.
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  echo "error: neither 'docker compose' nor 'docker-compose' is available" >&2
  exit 1
fi

# Native connection strings for the shipments-service Python commands below.
PG_USER="${POSTGRES_USER:-parcelpigeon}"
PG_PASS="${POSTGRES_PASSWORD:-parcelpigeon}"
PG_DB="${POSTGRES_DB:-shipments}"
export SHIPMENTS_DATABASE_URL="${SHIPMENTS_DATABASE_URL:-postgresql+psycopg://${PG_USER}:${PG_PASS}@localhost:5432/${PG_DB}}"
export SHIPMENTS_RABBITMQ_URL="${SHIPMENTS_RABBITMQ_URL:-amqp://guest:guest@localhost:5672/}"

ensure_env() {
  if [ ! -f .env ]; then
    cp .env.example .env
    echo "created .env from .env.example"
  fi
}

urls() {
  cat <<EOF

  Datastores are up:
    PostgreSQL ....... localhost:5432  (${PG_USER} / ${PG_PASS}, db ${PG_DB})
    Redis ............ localhost:6379
    RabbitMQ ......... localhost:5672   UI http://localhost:15672  (guest / guest)
    MailHog SMTP ..... localhost:1025   UI http://localhost:8025

  Now start the app services natively — see docs/running-locally.md:
    shipments-service  uvicorn app.main:app --port 8001
    tracking-service   go run ./cmd/tracking            (:8002)
    gateway            npm run dev                       (:8000)
    web                npm run dev                       (:5173)

EOF
}

cmd_up() {
  ensure_env
  $DC up -d
  echo "waiting for postgres..."
  for _ in $(seq 1 30); do
    $DC exec -T postgres pg_isready -U "${PG_USER}" >/dev/null 2>&1 && break
    sleep 1
  done
  urls
}

cmd_down() { $DC down; }

cmd_reset() { $DC down -v --remove-orphans; }

cmd_migrate() {
  echo "shipments-service: alembic upgrade head"
  ( cd services/shipments-service && alembic upgrade head )
}

cmd_seed() {
  echo "seeding demo data..."
  ( cd services/shipments-service && python -m app.seed "${1:-}" )
}

cmd_smoke() {
  GATEWAY_API_KEY="$(grep -E '^GATEWAY_API_KEY=' .env 2>/dev/null | cut -d= -f2)" \
    ./scripts/smoke.sh
}

# k6 from the host if installed, otherwise the grafana/k6 image. Inside the
# container the Mac's /etc/hosts is unknown, so the BASE_URL host is mapped
# explicitly (127.0.0.1 — e.g. with `minikube tunnel` — becomes the host itself).
cmd_load() {
  local base="${BASE_URL:-http://dev.parcelpigeon.local}"
  if command -v k6 >/dev/null 2>&1; then
    BASE_URL="$base" k6 run scripts/load.js
    return
  fi
  local host ip
  host="$(echo "$base" | sed -E 's#^[a-z]+://([^/:]+).*#\1#')"
  if [ "$host" = "localhost" ]; then
    base="${base/localhost/host.docker.internal}"
    host="host.docker.internal"
  fi
  ip="$(dscacheutil -q host -a name "$host" 2>/dev/null | awk '/^ip_address/{print $2; exit}')"
  [ -n "$ip" ] || ip="$(getent hosts "$host" 2>/dev/null | awk '{print $1; exit}')"
  case "$ip" in ""|127.*) ip="host-gateway" ;; esac
  docker run --rm -i --add-host "${host}:${ip}" \
    -e "BASE_URL=${base}" -e "VUS=${VUS:-5}" -e "DURATION=${DURATION:-5m}" \
    -e "GATEWAY_API_KEY=${GATEWAY_API_KEY:-}" \
    grafana/k6 run - < scripts/load.js
}

cmd_logs() { $DC logs -f --tail=100 "${1:-}"; }
cmd_ps() { $DC ps; }

case "${1:-}" in
  up)      cmd_up ;;
  down)    cmd_down ;;
  reset)   cmd_reset ;;
  migrate) cmd_migrate ;;
  seed)    shift; cmd_seed "${1:-}" ;;
  smoke)   cmd_smoke ;;
  load)    cmd_load ;;
  logs)    shift; cmd_logs "${1:-}" ;;
  ps)      cmd_ps ;;
  *)
    grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
