#!/usr/bin/env bash
# Jarvis one-shot server setup for a fresh Ubuntu 22.04/24.04 box. Run as root:
#   curl -fsSL https://raw.githubusercontent.com/philneeds/jarvis/<branch>/deploy/setup.sh | \
#     DOMAIN=hq.example.com HQ_PASSWORD='choose-a-long-one' BRANCH=<branch> bash
# Private repo: create a fine-grained GitHub token with read-only Contents on the repo, then
#   curl -fsSL -H "Authorization: token <TOKEN>" https://raw.githubusercontent.com/philneeds/jarvis/<branch>/deploy/setup.sh | \
#     DOMAIN=... HQ_PASSWORD='...' BRANCH=<branch> GITHUB_TOKEN=<TOKEN> bash
# Installs Node 22, pnpm, Postgres, Caddy; clones the repo to /opt/jarvis; builds; migrates; starts two
# systemd services behind Caddy with TLS. Re-running updates the checkout and restarts.
set -euo pipefail
rand() { head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-"${1:-32}"; }

DOMAIN="${DOMAIN:-}"
if [[ -z "$DOMAIN" ]]; then
  # No domain given: use a free sslip.io name built from this server's public IP.
  IP="$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')"
  DOMAIN="hq.${IP//./-}.sslip.io"
fi
HQ_PASSWORD="${HQ_PASSWORD:-}"
if [[ -z "$HQ_PASSWORD" && -f /opt/jarvis/.env ]]; then HQ_PASSWORD="$(grep -oP '(?<=^HQ_PASSWORD=).*' /opt/jarvis/.env || true)"; fi
if [[ -z "$HQ_PASSWORD" ]]; then
  if [[ -r /dev/tty ]]; then
    while [[ ${#HQ_PASSWORD} -lt 8 ]]; do
      read -r -s -p "Choose the HQ login password (8+ characters, nothing shows while you type): " HQ_PASSWORD </dev/tty; echo
    done
  else
    HQ_PASSWORD="$(rand 20)"
    GENERATED_PW=1
  fi
fi
BRANCH="${BRANCH:-main}"
TZ_NAME="${TZ_NAME:-America/New_York}"   # schedules (daily brief, scouts) run on this clock
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  REPO="${REPO:-https://x-access-token:${GITHUB_TOKEN}@github.com/philneeds/jarvis.git}"
else
  REPO="${REPO:-https://github.com/philneeds/jarvis.git}"
fi
APP_DIR=/opt/jarvis
APP_USER=jarvis

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

log "Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https postgresql postgresql-contrib ufw >/dev/null

if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  log "Node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
command -v pnpm >/dev/null || npm install -g pnpm@10 >/dev/null
command -v claude >/dev/null || { log "Claude Code"; npm install -g @anthropic-ai/claude-code >/dev/null; }
command -v grok >/dev/null || { log "Grok Build CLI"; npm install -g @xai-official/grok >/dev/null; }

if ! command -v caddy >/dev/null; then
  log "Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

log "User and checkout"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$APP_USER"
if [[ -d "$APP_DIR/.git" ]]; then
  [[ -n "${GITHUB_TOKEN:-}" ]] && sudo -u "$APP_USER" git -C "$APP_DIR" remote set-url origin "$REPO"
  sudo -u "$APP_USER" git -C "$APP_DIR" fetch -q origin "$BRANCH"
  sudo -u "$APP_USER" git -C "$APP_DIR" checkout -q "$BRANCH"
  sudo -u "$APP_USER" git -C "$APP_DIR" reset -q --hard "origin/$BRANCH"
else
  git clone -q --branch "$BRANCH" "$REPO" "$APP_DIR"
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
fi

log "Postgres"
systemctl enable --now postgresql >/dev/null
if ! sudo -u postgres psql -tAc "select 1 from pg_roles where rolname='jarvis'" | grep -q 1; then
  DB_PASS="$(rand 32)"
  sudo -u postgres psql -qc "create role jarvis login password '$DB_PASS'"
  sudo -u postgres psql -qc "create database jarvis owner jarvis"
else
  DB_PASS="$(grep -oP '(?<=^DATABASE_URL=postgres://jarvis:)[^@]+' "$APP_DIR/.env" 2>/dev/null || true)"
  if [[ -z "$DB_PASS" ]]; then DB_PASS="$(rand 32)"; sudo -u postgres psql -qc "alter role jarvis password '$DB_PASS'"; fi
fi

log "Environment"
if [[ ! -f "$APP_DIR/.env" ]]; then
  SESSION_SECRET="$(rand 48)"
  cat > "$APP_DIR/.env" <<EOF
NODE_ENV=production
HQ_PASSWORD=$HQ_PASSWORD
HQ_SESSION_SECRET=$SESSION_SECRET
HQ_ORIGIN=https://$DOMAIN
HQ_RP_ID=$DOMAIN
NEXT_PUBLIC_WS_URL=wss://$DOMAIN/ws
NEXT_PUBLIC_CITY="Rochester, NY"
NEXT_PUBLIC_LAT=43.16
NEXT_PUBLIC_LON=-77.61
DATABASE_URL=postgres://jarvis:$DB_PASS@localhost:5432/jarvis
PORT=4000
API_URL=http://localhost:4000
CLAUDE_MODE=agent-sdk
GROK_MODE=cli
BRIEF_AT=07:00
# Fill in as they arrive (see .env.example): GOOGLE_CLIENT_ID/SECRET, X_CLIENT_ID/SECRET, TELEGRAM_BOT_TOKEN/CHAT_ID, NOTIFY_WEBHOOK_URL
EOF
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"; chmod 600 "$APP_DIR/.env"
fi

log "Build"
sudo -u "$APP_USER" -H bash -lc "cd $APP_DIR && pnpm install --frozen-lockfile --prod=false >/dev/null && pnpm --filter @jarvis/core build >/dev/null && set -a && . ./.env && set +a && pnpm --filter @jarvis/core db:migrate && pnpm --filter @jarvis/server build >/dev/null && pnpm --filter @jarvis/hq build >/dev/null"

log "Services"
cat > /etc/systemd/system/jarvis-server.service <<EOF
[Unit]
Description=Jarvis server (API, websocket, scheduler)
After=network.target postgresql.service

[Service]
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
Environment=HOME=/home/$APP_USER
Environment=TZ=${TZ_NAME}
ExecStart=/usr/bin/node apps/server/dist/index.js
Restart=always
RestartSec=3
User=$APP_USER

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/jarvis-hq.service <<EOF
[Unit]
Description=Jarvis HQ (Next.js)
After=network.target jarvis-server.service

[Service]
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
Environment=HOME=/home/$APP_USER
Environment=TZ=${TZ_NAME}
ExecStart=$(command -v pnpm) --filter @jarvis/hq start
Restart=always
RestartSec=3
User=$APP_USER

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	@api path /api/* /ws
	reverse_proxy @api localhost:4000
	reverse_proxy localhost:3000
}
EOF
systemctl daemon-reload
systemctl enable --now jarvis-server jarvis-hq >/dev/null
systemctl restart jarvis-server jarvis-hq caddy

log "Firewall"
ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw --force enable >/dev/null

sleep 3
if curl -fsS http://localhost:4000/api/health >/dev/null; then
  log "Jarvis is up at https://$DOMAIN (TLS arrives within a minute once DNS points here)."
  [[ -n "${GENERATED_PW:-}" ]] && log "HQ login password (generated, change it in $APP_DIR/.env): $HQ_PASSWORD"
else
  log "Server did not answer yet; check: journalctl -u jarvis-server -n 50"
fi
cat <<EOF

Next, sign the plans in as the app user (once):
  sudo -iu $APP_USER
  claude login                 # Claude Code on your plan
  grok login --device-auth     # Grok Build CLI on SuperGrok (device code: no browser needed on the server)
  exit
  systemctl restart jarvis-server
Secrets go in $APP_DIR/.env, then: systemctl restart jarvis-server jarvis-hq
EOF
