# Running the server on a VPS

The server runs as a Docker container next to other sites without touching them: its own container, its own block in the proxy config, limits for memory and CPU. A timer pulls new versions from GitHub and rebuilds the container on its own.

Tested setup: Ubuntu, Docker with the compose plugin, Caddy as a container in front of everything. Node.js and ffmpeg are inside the image, the machine itself only needs Docker and git.

## 1. Check what is already running

```bash
sudo docker ps                                                     # proxy container and its name
sudo docker inspect caddy -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}'   # its network
sudo docker inspect caddy -f '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}'   # where the Caddyfile is
```

## 2. Install

```bash
sudo git clone https://github.com/Jan1653/voicigame /opt/voicigame
sudo chown -R $USER: /opt/voicigame
cp /opt/voicigame/deploy/.env.example /opt/voicigame/deploy/.env
nano /opt/voicigame/deploy/.env          # PUBLIC_URL, PROXY_NETWORK (network from step 1), MAX_STORAGE_GB
docker compose -f /opt/voicigame/deploy/docker-compose.yml up -d --build
```

Your user needs to be allowed to use Docker (member of the `docker` group), otherwise put `sudo` in front.

## 3. Proxy

Add the block from `Caddyfile.example` to the Caddyfile (path from step 1), then:

```bash
sudo docker exec caddy caddy validate --config /etc/caddy/Caddyfile
sudo docker exec caddy caddy reload --config /etc/caddy/Caddyfile
```

`reload` keeps the other sites online. If `validate` complains, the running config stays as it is. Open `https://voicigame.duckdns.org` to check.

The domain has to point to the server first. With DuckDNS: add the subdomain in your DuckDNS account and enter the server's IP address.

## 4. Automatic updates

```bash
sed "s|YOUR_USER|$USER|" /opt/voicigame/deploy/voicigame-deploy.service | sudo tee /etc/systemd/system/voicigame-deploy.service
sudo cp /opt/voicigame/deploy/voicigame-deploy.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now voicigame-deploy.timer
```

Every 2 minutes it checks GitHub. A new commit on `main` is built and started. The build runs while the old container keeps serving, the switch itself takes a few seconds.

- While people are playing, the update waits (at most 3 hours), because a restart ends running rooms.
- If the new version does not start, it goes back to the previous one and skips that commit until a newer one arrives.
- Log: `journalctl -u voicigame-deploy`, server log: `docker logs voicigame`.
- Do not edit files in `/opt/voicigame` on the server, updates overwrite them. Settings belong in `deploy/.env`.

## Statistics

The server counts per day how many rooms, gameshows, dub rounds, players and video exports there were. Only numbers, no names or addresses. They are kept in the Docker volume `stats` and survive updates.

```bash
docker exec voicigame node src/stats.js 30      # last 30 days as a bar chart, any number of days works
```

## Settings

In `deploy/.env`. After a change: `docker compose -f /opt/voicigame/deploy/docker-compose.yml up -d`.

| Variable | Meaning | Default |
|---|---|---|
| `PUBLIC_URL` | Address players open (link and QR code) | `https://voicigame.duckdns.org` |
| `PROXY_NETWORK` | Docker network of the proxy container | `caddy` |
| `MAX_STORAGE_GB` | Disk space all rooms together may use | `3` |
| `MEM_LIMIT`, `CPUS` | Memory and CPU for the container | `800m`, `1.0` |
| `MAX_ACTIVE_ROOMS` | Rooms in use at the same time (PC or phone connected). More new rooms wait in a queue | `60` |
| `OVERLOAD_LAG_MS` | New rooms also wait when the server lags more than this | `250` |
| `MAX_ROOMS` | Open rooms at the same time, including idle ones | `150` |
| `ROOMS_PER_IP` | New rooms per address within 10 minutes | `8` |
| `MAX_PLAYERS_PER_ROOM` | Phones and browsers per room | `16` |
| `DUB_MAX_PACK_MB` | Largest dub pack a room may upload | `800` |
| `DUB_MAX_VIDEO_MIN` | Longest video that is converted for browsers and exported | `20` |
| `FFMPEG_THREADS` | Threads per ffmpeg job (only one job runs at a time) | `1` |

The server also hands out the current mod files (`/api/mod`), mods installed by hand update themselves from there. The Docker image is built from the repository root for that.

Rooms and their files are removed automatically after a while without activity, and all of them on a restart. Anyone who knows the address can create a room, so keep `MAX_STORAGE_GB` below the free space you want to leave for the other sites.

## Without Docker

Node.js 18 or newer, optionally ffmpeg:

```bash
sudo useradd --system --home /opt/voicigame --shell /usr/sbin/nologin voicigame
sudo git clone https://github.com/Jan1653/voicigame /opt/voicigame
cd /opt/voicigame/server && sudo npm ci --omit=dev
sudo chown -R voicigame:voicigame /opt/voicigame
sudo cp /opt/voicigame/deploy/voicigame.service /etc/systemd/system/
sudo nano /etc/systemd/system/voicigame.service     # PORT, PUBLIC_URL
sudo systemctl daemon-reload && sudo systemctl enable --now voicigame
```

Use the second block in `Caddyfile.example`. The server settings are the same, as `Environment=` lines in the service file; `HOST=127.0.0.1` keeps it reachable only through the proxy. Updates are manual here:

```bash
cd /opt/voicigame && sudo -u voicigame git pull
cd server && sudo -u voicigame npm ci --omit=dev
sudo systemctl restart voicigame
```
