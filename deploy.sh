#!/data/data/com.termux/files/usr/bin/sh
# Auto-deploy do jarvis-server-box no Termux.
#
# Compara o HEAD local com origin/production. Se mudou, atualiza e reinicia.
# Se nao mudou mas o processo caiu, sobe de novo (watchdog).
#
# Cron sugerido:
#   */5 * * * * sh ~/server-box/deploy.sh >> ~/servidor/deploy.log 2>&1

set -u

REPO="${SERVERBOX_DIR:-$HOME/server-box}"
BRANCH="${SERVERBOX_BRANCH:-production}"
RUNDIR="$HOME/servidor"
APPLOG="$RUNDIR/server.log"

log() { echo "$(date '+%F %T') $*"; }

mkdir -p "$RUNDIR"

cd "$REPO" 2>/dev/null || { log "repo nao encontrado em $REPO"; exit 1; }

start_app() {
  cd "$REPO" || exit 1
  nohup node server.js >> "$APPLOG" 2>&1 &
  log "server-box iniciado (pid $!)"
}

if ! git fetch origin "$BRANCH" --quiet 2>/dev/null; then
  log "git fetch falhou (rede fora do ar ou deploy key sem acesso)"
  # Mesmo sem rede, o painel nao pode ficar fora do ar.
  pgrep -f "node server.js" >/dev/null 2>&1 || { log "processo caido, reiniciando"; start_app; }
  exit 1
fi

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

if [ "$LOCAL" = "$REMOTE" ]; then
  pgrep -f "node server.js" >/dev/null 2>&1 || { log "processo caido, reiniciando"; start_app; }
  exit 0
fi

log "atualizando $(echo "$LOCAL" | cut -c1-7) -> $(echo "$REMOTE" | cut -c1-7)"

if ! git checkout -B "$BRANCH" "origin/$BRANCH" --quiet; then
  log "checkout falhou; mantendo a versao atual no ar"
  exit 1
fi

pkill -f "node server.js" 2>/dev/null
sleep 2
start_app
