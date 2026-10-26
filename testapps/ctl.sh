#!/usr/bin/env bash
# Start/stop the local test apps and snapshot/restore their sqlite databases.
# Usage: ctl.sh start|stop|restart|snapshot|restore <vikunja|gitea|dodam> [name]
# dodam passes DODAM_LABELS (v1|v2) and DODAM_TODAY (YYYY-MM-DD) through when set.
set -euo pipefail
cd "$(dirname "$0")"
cmd=$1; app=$2; snap=${3:-base}
pidfile="$app/$app.pid"
case $app in
  vikunja) db=vikunja/vikunja.db; port=3456 ;;
  gitea) db=gitea/data/gitea.db; port=3300 ;;
  dodam) db=dodam/data/dodam.db; port=3500 ;;
  *) echo "unknown app $app"; exit 2 ;;
esac
start() {
  if ss -ltnH "sport = :$port" | grep -q .; then return; fi
  # setsid -f fully detaches the server so callers (execFileSync) never wait on it.
  case $app in
    vikunja)
      (cd vikunja && source env.sh && export VIKUNJA_SERVICE_SECRET=$VIKUNJA_SERVICE_JWTSECRET && unset VIKUNJA_SERVICE_JWTSECRET \
        && export VIKUNJA_RATELIMIT_ENABLED=false && setsid -f ./vikunja-v2.7.1-linux-amd64 web >> vikunja.log 2>&1 < /dev/null) ;;
    gitea)
      (cd gitea && setsid -f ./gitea --config custom/conf/app.ini web >> gitea.out 2>&1 < /dev/null) ;;
    dodam)
      (cd dodam && env ${DODAM_LABELS:+DODAM_LABELS=$DODAM_LABELS} ${DODAM_TODAY:+DODAM_TODAY=$DODAM_TODAY} \
        setsid -f node --no-warnings server.mjs >> dodam.log 2>&1 < /dev/null) ;;
  esac
  for i in $(seq 1 75); do curl -s -m 1 -o /dev/null "http://127.0.0.1:$port/" && break; sleep 0.2; done
}
stop() {
  # Kill whatever listens on the app port (pid files miss processes started by hand).
  if [ -f "$pidfile" ]; then kill "$(cat "$pidfile")" 2>/dev/null || true; rm -f "$pidfile"; fi
  for pid in $(ss -ltnpH "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u); do kill "$pid" 2>/dev/null || true; done
  for i in $(seq 1 30); do ss -ltnH "sport = :$port" | grep -q . || break; sleep 0.2; done
}
# Fold the SQLite write-ahead log into the main file so a plain copy is complete.
# (dodam uses journal_mode=DELETE, so this is a no-op there.)
checkpoint() {
  python3 -c "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('PRAGMA wal_checkpoint(TRUNCATE)'); c.close()" "$db"
  rm -f "$db-wal" "$db-shm"
}
case $cmd in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  snapshot) mkdir -p snapshots; stop; checkpoint; cp "$db" "snapshots/$app-$snap.db"; [ "$app" = gitea ] && rm -rf "snapshots/gitea-$snap-repos" && cp -r gitea/repos "snapshots/gitea-$snap-repos" 2>/dev/null || true; start ;;
  restore) stop; rm -f "$db-wal" "$db-shm" "$db-journal"; cp "snapshots/$app-$snap.db" "$db"; if [ "$app" = gitea ] && [ -d "snapshots/gitea-$snap-repos" ]; then rm -rf gitea/repos; cp -r "snapshots/gitea-$snap-repos" gitea/repos; fi; start ;;
  *) echo "unknown command $cmd"; exit 2 ;;
esac
echo "$cmd $app ok"
