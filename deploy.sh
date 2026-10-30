#!/usr/bin/env bash
# Fetch the games, build them one at a time and (re)start everything.
#
#   ./deploy.sh              every game, then Caddy and the tunnel
#   ./deploy.sh wild bluff   only these games (Caddy is rebuilt too, to pick up their web apps)
#
# Games are built one by one on purpose: six Vite builds at once would run the Pi out of memory.
set -euo pipefail
cd "$(dirname "$0")"

# service → GitHub repo (github.com/nocs32/<repo>), checked out under games/<repo>.
declare -A repos=(
  [felt]=felt-table-jigsaw
  [scribble]=scribble-table
  [telephone]=telephone-table
  [wild]=wild-table
  [bluff]=bluff-table
  [cinemate]=cinemate
  [zdam]=zdam
)
order=(felt scribble telephone wild bluff cinemate zdam)

if [[ $# -gt 0 ]]; then
  for service in "$@"; do
    [[ -n "${repos[$service]:-}" ]] || { echo "Unknown game: $service (one of: ${order[*]})" >&2; exit 1; }
  done
  services=("$@")
else
  services=("${order[@]}")
fi

fetch() {
  local repo=$1 dir="games/$1"

  if [[ -d "$dir/.git" ]]; then
    git -C "$dir" fetch --quiet --depth 1 origin main
    git -C "$dir" reset --quiet --hard origin/main
  else
    git clone --quiet --depth 1 --branch main "https://github.com/nocs32/$repo.git" "$dir"
  fi

  echo "  $repo @ $(git -C "$dir" log -1 --format='%h %s')"
}

echo "Fetching games"
mkdir -p games
# Caddy needs every game's image, so make sure every checkout exists, even when building a few.
for service in "${order[@]}"; do
  if [[ " ${services[*]} " == *" $service "* || ! -d "games/${repos[$service]}" ]]; then
    fetch "${repos[$service]}"
  fi
done

for service in "${services[@]}"; do
  echo "Building $service"
  docker compose build "$service"
done

# Any game never built before (first deploy of a subset): build it too, or Caddy can't.
for service in "${order[@]}"; do
  if ! docker image inspect "tables/$service" >/dev/null 2>&1; then
    echo "Building $service (no image yet)"
    docker compose build "$service"
  fi
done

# Only copies the games' built web apps out of their images (see compose.yaml): no game is rebuilt here.
echo "Building caddy"
docker compose build caddy

if [[ -f secrets/tunnel.json ]] && ! grep -q '^tunnel: TUNNEL_ID' cloudflared/config.yml; then
  docker compose up -d --no-build --remove-orphans
else
  echo "No tunnel yet (secrets/tunnel.json or the tunnel id in cloudflared/config.yml is missing):"
  echo "starting the games and Caddy only."
  docker compose up -d --no-build --remove-orphans "${order[@]}" caddy
fi

docker image prune -f >/dev/null
docker compose ps --format 'table {{.Service}}\t{{.Status}}'
