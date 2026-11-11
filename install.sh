#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
	printf 'Vieploy: %s\n' "$*" >&2
	exit 1
}

[[ $# -eq 0 ]] || fail "Usage: sudo bash install.sh"
[[ "$(uname -s)" == Linux && "$EUID" -eq 0 ]] || fail "Run this installer as root on a Linux VPS."
case "$(uname -m)" in
	x86_64 | aarch64) ;;
	*) fail "Vieploy images support AMD64 and ARM64." ;;
esac

for tool in curl openssl ip ss flock; do
	command -v "$tool" >/dev/null || fail "Install $tool and run the installer again."
done

image_tag=${VIEPLOY_TAG:-vieploy}
[[ "$image_tag" == vieploy || "$image_tag" =~ ^[a-f0-9]{40}$ ]] ||
	fail "VIEPLOY_TAG must be vieploy or the full SHA of a published commit."
image_repository=ghcr.io/alexec0de/vieploy
image_ref="$image_repository:$image_tag"
panel_dir=/etc/dokploy
state_dir=/var/lib/vieploy
postgres_secret=dokploy_postgres_password
auth_secret=dokploy_auth_secret

install -d -m 0700 "$state_dir"
exec 9>"$state_dir/install.lock"
flock -n 9 || fail "Another Vieploy installation is running."

if ! command -v docker >/dev/null; then
	# shellcheck source=/dev/null
	. /etc/os-release
	case "${ID:-}" in
		ubuntu | debian) ;;
		*) fail "Install Docker Engine for this Linux distribution and retry." ;;
	esac
	codename=${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}
	[[ -n "$codename" ]] || fail "Could not determine the Linux release codename."

	apt-get update
	apt-get install -y ca-certificates
	install -d -m 0755 /etc/apt/keyrings
	curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
	chmod 0644 /etc/apt/keyrings/docker.asc
	cat > /etc/apt/sources.list.d/docker.sources <<APT
Types: deb
URIs: https://download.docker.com/linux/$ID
Suites: $codename
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
APT
	chmod 0644 /etc/apt/sources.list.d/docker.sources
	apt-get update
	apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

docker() {
	command docker --host unix:///var/run/docker.sock "$@"
}

swarm_info=$(docker info --format '{{.Swarm.LocalNodeState}} {{.Swarm.ControlAvailable}}') ||
	fail "Start the local Docker Engine and retry."
read -r swarm_state swarm_manager <<< "$swarm_info"
case "$swarm_state $swarm_manager" in
	'inactive false' | 'active true') ;;
	*) fail "Use a VPS with no Swarm membership or run on a Swarm manager." ;;
esac

if [[ ! -f "$state_dir/initialized" ]]; then
	if [[ -e "$panel_dir" || -L "$panel_dir" ]] ||
		docker service inspect dokploy >/dev/null 2>&1 ||
		docker service inspect dokploy-postgres >/dev/null 2>&1 ||
		docker container inspect dokploy >/dev/null 2>&1 ||
		docker container inspect dokploy-traefik >/dev/null 2>&1 ||
		docker network inspect dokploy-network >/dev/null 2>&1 ||
		docker volume inspect dokploy-postgres >/dev/null 2>&1 ||
		docker volume inspect dokploy >/dev/null 2>&1 ||
		docker secret inspect "$postgres_secret" >/dev/null 2>&1 ||
		docker secret inspect "$auth_secret" >/dev/null 2>&1; then
		fail "Found an existing Dokploy or Vieploy installation. Follow the existing-installation instructions in the Vieploy README."
	fi
	busy_ports=$(ss -H -lntu | awk '$5 ~ /:(80|443|3000)$/ { print $5 }')
	[[ -z "$busy_ports" ]] || fail "Free ports 80, 443 and 3000 before installing. In use: $busy_ports"
fi

if ! docker service inspect dokploy >/dev/null 2>&1; then
	printf 'Pulling %s\n' "$image_ref"
	docker pull "$image_ref" ||
		fail "Could not pull $image_ref. Verify that GitHub Actions published the image and the GHCR package is public."
	image_ref=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image_ref" |
		awk '/^ghcr[.]io\/alexec0de\/vieploy@sha256:[a-f0-9]+$/ && !found { print; found=1 }')
	[[ "$image_ref" =~ ^ghcr[.]io/alexec0de/vieploy@sha256:[a-f0-9]{64}$ ]] ||
		fail "Docker did not return a digest for the Vieploy image."
fi

route_address() {
	awk '{ for (i=1; i<NF; i++) if ($i == "src") { print $(i+1); exit } }'
}

advertise_addr=${ADVERTISE_ADDR:-}
if [[ -z "$advertise_addr" ]]; then
	advertise_addr=$(ip -4 route get 1.1.1.1 2>/dev/null | route_address) || true
	if [[ -z "$advertise_addr" ]]; then
		advertise_addr=$(ip -6 route get 2606:4700:4700::1111 2>/dev/null | route_address) || true
	fi
fi
if [[ "$swarm_state" == inactive ]]; then
	[[ -n "$advertise_addr" ]] || fail "Set ADVERTISE_ADDR to a local IP address and retry."
	docker swarm init --advertise-addr "$advertise_addr" >/dev/null
fi

node_id=$(docker info --format '{{.Swarm.NodeID}}')
[[ -n "$node_id" ]] || fail "Could not determine the local Swarm node."
if [[ -f "$state_dir/initialized" ]]; then
	[[ "$(cat "$state_dir/initialized")" == "$node_id" ]] ||
		fail "The Swarm node ID has changed. Restore the original Swarm before continuing."
else
	printf '%s\n' "$node_id" > "$state_dir/initialized"
fi

if ! docker network inspect dokploy-network >/dev/null 2>&1; then
	docker network create --driver overlay --attachable dokploy-network >/dev/null
fi
[[ ! -L "$panel_dir" ]] || fail "$panel_dir must be a directory on this VPS."
install -d -m 0750 "$panel_dir"

if ! docker secret inspect "$postgres_secret" >/dev/null 2>&1; then
	if docker volume inspect dokploy-postgres >/dev/null 2>&1 ||
		docker service inspect dokploy-postgres >/dev/null 2>&1; then
		fail "Restore the original PostgreSQL secret before continuing."
	fi
	openssl rand -hex 32 | docker secret create "$postgres_secret" - >/dev/null
fi
if ! docker secret inspect "$auth_secret" >/dev/null 2>&1; then
	if docker service inspect dokploy >/dev/null 2>&1; then
		fail "Restore the original Vieploy authentication secret before continuing."
	fi
	openssl rand -hex 32 | docker secret create "$auth_secret" - >/dev/null
fi

if ! docker service inspect dokploy-postgres >/dev/null 2>&1; then
	docker service create --detach 		--name dokploy-postgres 		--constraint "node.id==$node_id" 		--network dokploy-network 		--env POSTGRES_USER=dokploy 		--env POSTGRES_DB=dokploy 		--secret "source=$postgres_secret,target=postgres_password" 		--env POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password 		--mount type=volume,source=dokploy-postgres,target=/var/lib/postgresql/data 		postgres:16 >/dev/null
fi

if ! docker service inspect dokploy >/dev/null 2>&1; then
	docker service create --detach 		--name dokploy 		--constraint "node.id==$node_id" 		--network dokploy-network 		--mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock 		--mount "type=bind,source=$panel_dir,target=/etc/dokploy" 		--mount type=volume,source=dokploy,target=/root/.docker 		--secret "source=$postgres_secret,target=postgres_password" 		--secret "source=$auth_secret,target=dokploy_auth_secret" 		--env POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password 		--env BETTER_AUTH_SECRET_FILE=/run/secrets/dokploy_auth_secret 		--publish published=3000,target=3000,mode=host 		--update-order stop-first 		"$image_ref" >/dev/null
fi

printf 'Waiting for Vieploy to start and migrate PostgreSQL...\n'
deadline=$((SECONDS + 240))
until [[ -f "$panel_dir/traefik/traefik.yml" && -d "$panel_dir/traefik/dynamic" ]] &&
	curl -fsS --max-time 3 http://127.0.0.1:3000/api/trpc/settings.health >/dev/null 2>&1; do
	(( SECONDS < deadline )) || fail "Vieploy did not become ready. Check docker service logs dokploy."
	sleep 3
done

if ! docker container inspect dokploy-traefik >/dev/null 2>&1; then
	docker run -d --name dokploy-traefik --restart always 		--network dokploy-network 		--mount "type=bind,source=$panel_dir/traefik/traefik.yml,target=/etc/traefik/traefik.yml" 		--mount "type=bind,source=$panel_dir/traefik/dynamic,target=/etc/dokploy/traefik/dynamic" 		--mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock,readonly 		--publish 80:80/tcp --publish 443:443/tcp --publish 443:443/udp 		traefik:v3.7.16 >/dev/null
else
	docker start dokploy-traefik >/dev/null
fi

deadline=$((SECONDS + 30))
until curl -sS --max-time 3 http://127.0.0.1/ >/dev/null 2>&1; do
	(( SECONDS < deadline )) || fail "Traefik did not start listening. Check docker logs dokploy-traefik."
	sleep 2
done

if [[ "$advertise_addr" == *:* ]]; then
	advertise_addr="[$advertise_addr]"
fi
printf 'Vieploy is ready at http://%s:3000\n' "${advertise_addr:-YOUR_VPS_IP}"
