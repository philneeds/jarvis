#!/usr/bin/env bash
# One-line health check for the X pull, run on the server as root:
#   bash /opt/jarvis/deploy/diag.sh [handle]
# Prints the deployed commit, service state, the last log lines about pulls and Grok, Jarvis's last chat replies, a
# timed Grok X search from this box, and HQ's direct timeline read. Paste the whole output when asking for help.
set -uo pipefail
APP_DIR=/opt/jarvis
APP_USER=jarvis
H="${1:-houseofsweeps}"

section() { printf '\n==> %s\n' "$*"; }

section "Deployed version"
sudo -u "$APP_USER" git -C "$APP_DIR" log -1 --format='%h %ci %s'
sudo -u "$APP_USER" git -C "$APP_DIR" status -sb | head -1
grep -c "pullRequest" "$APP_DIR/packages/core/dist/jarvis/orchestrator.js" 2>/dev/null | sed 's/^/built with direct pull (1 = yes): /'

section "Services"
systemctl is-active jarvis-server jarvis-hq | paste -sd' ' | sed 's/^/server hq: /'
systemctl show jarvis-server -p ActiveEnterTimestamp --value | sed 's/^/server started: /'

section "Server log: pulls, Grok, errors (last 40 matching lines)"
journalctl -u jarvis-server --since "-3h" --no-pager -o cat 2>/dev/null | grep -iE "pull|filed|grok|lucas|x search|timeline|error|429" | tail -40

section "Jarvis's last 6 chat lines"
if [[ -f "$APP_DIR/.env" ]]; then
  set -a; . "$APP_DIR/.env"; set +a
  psql "$DATABASE_URL" -tAc "select to_char(at,'HH24:MI')||' '||coalesce(agent_id,role)||': '||left(replace(text,E'\n',' '),220) from chat_messages order by at desc limit 6;" 2>/dev/null || echo "(no chat table or psql)"
  section "Last 4 agent runs"
  psql "$DATABASE_URL" -tAc "select to_char(started_at,'HH24:MI')||' '||agent_id||' '||status||' '||coalesce(provider,'')||' '||left(coalesce(error,''),160) from runs order by started_at desc limit 4;" 2>/dev/null || echo "(no runs table)"
fi

section "Grok CLI, as the app user: version and a timed X search for from:$H (up to 4 minutes)"
sudo -u "$APP_USER" -H bash -lc 'grok --version' 2>&1 | head -1
START=$(date +%s)
OUT=$(sudo -u "$APP_USER" -H timeout 240 bash -lc "cd /tmp && grok --permission-mode dontAsk --max-turns 4 --output-format json -p 'Search X (Twitter) for: from:$H. Return the 5 most recent posts: @handle, date, text, link. If X search is unavailable or finds nothing, say exactly that in one line.'" 2>&1)
echo "took $(( $(date +%s) - START ))s, exit ${PIPESTATUS[0]:-?}"
echo "$OUT" | tail -c 1500

section "HQ's direct timeline read from this box (expect 200, or 429 when X is rate-limiting this address)"
curl -s -o /dev/null -w 'syndication.twitter.com: HTTP %{http_code} in %{time_total}s\n' -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' "https://syndication.twitter.com/srv/timeline-profile/screen-name/$H?showReplies=true"
