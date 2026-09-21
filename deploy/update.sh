#!/bin/sh
# Auto update: fetch the newest version from GitHub and rebuild the voicigame container.
# Runs every 2 minutes through voicigame-deploy.timer, as a user that may use Docker.
# It only touches this checkout and the voicigame container, never the proxy or other sites.
#
#   - no new commit: does nothing
#   - people are playing: waits (at most MAX_WAIT_MIN), so the restart does not end a running game
#   - new version does not start: goes back to the previous one and skips that commit
#
# Log: journalctl -u voicigame-deploy
# Every update overwrites the files of this checkout, so do not edit them on the server.
# Settings belong in deploy/.env, updates leave that file alone.

main() {
	set -eu
	DIR=$(cd "$(dirname "$0")/.." && pwd)
	cd "$DIR"
	BRANCH=${BRANCH:-main}
	MAX_WAIT_MIN=${MAX_WAIT_MIN:-180}
	STATE=$DIR/deploy/.state
	mkdir -p "$STATE"

	git fetch --quiet origin "$BRANCH"
	old=$(git rev-parse HEAD)
	new=$(git rev-parse "origin/$BRANCH")
	if [ "$old" = "$new" ]; then
		rm -f "$STATE/waiting_since"
		exit 0
	fi
	if [ "$new" = "$(cat "$STATE/bad" 2>/dev/null || true)" ]; then
		exit 0
	fi

	busy=$(health | sed -n 's/.*"busy":\([0-9]*\).*/\1/p')
	if [ "${busy:-0}" -gt 0 ]; then
		[ -f "$STATE/waiting_since" ] || date +%s > "$STATE/waiting_since"
		since=$(cat "$STATE/waiting_since")
		if [ $(($(date +%s) - since)) -lt $((MAX_WAIT_MIN * 60)) ]; then
			echo "Update to $(short "$new") waits: $busy room(s) in use"
			exit 0
		fi
		echo "Waited $MAX_WAIT_MIN minutes, updating anyway"
	fi
	rm -f "$STATE/waiting_since"

	echo "Updating $(short "$old") -> $(short "$new")"
	if deploy "$new" && healthy; then
		echo "Now running $(short "$new")"
		docker image prune -f --filter label=app=voicigame > /dev/null
		exit 0
	fi

	echo "Version $(short "$new") does not start, going back to $(short "$old")"
	echo "$new" > "$STATE/bad"
	deploy "$old" && healthy || echo "The previous version does not start either, check: docker logs voicigame"
	exit 1
}

# Check out a commit and rebuild the container (unchanged steps come from the Docker cache).
deploy() {
	git reset --quiet --hard "$1" || return 1
	docker compose -f deploy/docker-compose.yml up -d --build
}

# Status of the running server; the endpoint only answers requests from inside the container.
health() {
	docker exec voicigame wget -qO- -T 3 http://127.0.0.1:8080/api/health 2> /dev/null || true
}

healthy() {
	i=0
	while [ $i -lt 20 ]; do
		sleep 2
		health | grep -q '"ok":true' && return 0
		i=$((i + 1))
	done
	return 1
}

short() { echo "$1" | cut -c1-7; }

# Everything sits in functions, so the shell has read the whole file before git replaces it.
main "$@"
