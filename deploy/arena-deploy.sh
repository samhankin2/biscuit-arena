#!/bin/bash
#
# Deploy the Arnott's Biscuit Arena API to the Oracle VPS.
#
# Pulls the latest main branch, restarts the systemd service, health-checks it,
# and rolls back to the previous commit if the new one does not come up.
#
# Installed on the VPS as /usr/local/bin/arena-deploy, run as root by CI:
#   ssh -i deploy_key ubuntu@<host> "sudo /usr/local/bin/arena-deploy"
#
set -euo pipefail

APP_DIR="/opt/biscuit-arena"
SERVICE="arena"
HEALTH_URL="http://127.0.0.1:3000/api/health"
BRANCH="main"

log() { echo "[deploy $(date -u '+%H:%M:%S')] $*"; }

cd "$APP_DIR"

PREV_SHA="$(git rev-parse HEAD)"
log "current commit: $PREV_SHA"

log "fetching origin/$BRANCH"
git fetch --quiet origin "$BRANCH"

REMOTE_SHA="$(git rev-parse "origin/$BRANCH")"
if [ "$REMOTE_SHA" != "$PREV_SHA" ]; then
  log "updating to origin/$BRANCH ($REMOTE_SHA)"
  git checkout --quiet "$BRANCH"
  git merge --ff-only --quiet "origin/$BRANCH"
  NEW_SHA="$(git rev-parse HEAD)"
  log "deployed commit: $NEW_SHA"

  # Install dependencies only when the manifest actually changed.
  if ! git diff --quiet "$PREV_SHA" "$NEW_SHA" -- package.json; then
    log "package.json changed -> npm ci"
    npm ci --omit=dev --no-audit --no-fund
  fi

  # Keep the deployed copy of this script in step with the repository.
  if [ -f "$APP_DIR/deploy/arena-deploy.sh" ]; then
    install -m 0755 "$APP_DIR/deploy/arena-deploy.sh" /usr/local/bin/arena-deploy
    log "refreshed /usr/local/bin/arena-deploy"
  fi
else
  log "already up to date, restarting anyway"
  NEW_SHA="$PREV_SHA"
fi

rollback() {
  log "health check failed -> rolling back to $PREV_SHA"
  git reset --hard --quiet "$PREV_SHA"
  systemctl restart "$SERVICE" || true
  sleep 3
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    log "rollback succeeded, service is healthy on $PREV_SHA"
  else
    log "ROLLBACK FAILED - service is not healthy on $PREV_SHA"
  fi
  exit 1
}

log "restarting $SERVICE"
systemctl restart "$SERVICE"

log "health checking"
for attempt in $(seq 1 15); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    log "healthy after ${attempt}s"
    log "done: $(curl -fsS "$HEALTH_URL")"
    exit 0
  fi
  sleep 1
done

rollback
