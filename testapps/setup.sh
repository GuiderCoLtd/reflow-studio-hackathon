#!/usr/bin/env bash
# One-time setup for a fresh clone: test app binaries, config paths, the demo account,
# sample data and the database snapshots the site configs restore before each run.
set -euo pipefail
cd "$(dirname "$0")"
here=$(pwd)
# The committed configs carry the path of the checkout they were written on.
old=$(grep -oP '^WORK_PATH = \K.*' gitea/custom/conf/app.ini)
if [ "$old" != "$here/gitea" ]; then
  sed -i "s#${old%/gitea}#$here#g" gitea/custom/conf/app.ini vikunja/env.sh
fi
if [ ! -x vikunja/vikunja-v2.7.1-linux-amd64 ]; then
  curl -sL -o /tmp/vikunja-v2.7.1.zip https://github.com/go-vikunja/vikunja/releases/download/v2.7.1/vikunja-v2.7.1-linux-amd64-full.zip
  unzip -oq /tmp/vikunja-v2.7.1.zip -d vikunja
fi
if [ ! -x gitea/gitea ]; then
  curl -sL -o gitea/gitea https://dl.gitea.com/gitea/28.2.0/gitea-28.2.0-linux-amd64 && chmod +x gitea/gitea
fi
(cd vikunja && source env.sh && export VIKUNJA_SERVICE_SECRET=$VIKUNJA_SERVICE_JWTSECRET && ./vikunja-v2.7.1-linux-amd64 migrate >/dev/null \
  && (./vikunja-v2.7.1-linux-amd64 user create -u demo -e demo@example.com -p 'DemoPass!2026' >/dev/null 2>&1 || true))
(cd gitea && ./gitea --config custom/conf/app.ini migrate >/dev/null \
  && (./gitea --config custom/conf/app.ini admin user create --admin --username demo --password 'DemoPass!2026' --email demo@example.com --must-change-password=false >/dev/null 2>&1 || true))
./ctl.sh start vikunja
./ctl.sh start gitea
node seed.mjs all
./ctl.sh snapshot vikunja base
./ctl.sh snapshot gitea base
./ctl.sh snapshot gitea base-demo
./ctl.sh start vikunja
./ctl.sh start gitea
echo "Test apps ready: Gitea http://127.0.0.1:3300  Vikunja http://127.0.0.1:3456  (demo / DemoPass!2026)"
