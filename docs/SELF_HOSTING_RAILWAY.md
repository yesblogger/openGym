# Deploying openGym on Railway

Run two services from this repository: **web** (nginx plus the built React app) and **api**
(Node plus a persistent `/data` volume). Only web gets a public HTTPS domain. It proxies
`/api/` over Railway's private network, so passkeys, sessions and sync share the app's origin.

Built-in exercise images and GIFs are fetched from the pinned dataset CDN through web. Their
URLs stay under `/img/` and `/gif/`, so the installed PWA can cache previously viewed media
offline. Custom exercise uploads are stored by the API under `/data/uploads/`.

This guide uses the default API image. The optional AI provider runtimes, native mobile builds
and local stdio MCP server are separate from this deployment.

## 1. Create the services

Use a GitHub repository containing these Railway compatibility changes. Create a Railway
project, then connect that repository to two services named **api** and **web** in the same
environment. Railway does not run `docker compose up`; use these service settings instead.

| Setting | api | web |
|---|---|---|
| Root directory | `/api` | Repository root (leave unset) |
| Dockerfile | `Dockerfile` (automatically detected) | `web/Dockerfile` (variable below) |
| Start command | Leave unset | Leave unset |
| Public domain | None | Generate an HTTPS domain; target port `3000` |
| Healthcheck path | `/api/health` | `/api/health` |
| Volume mount | `/data` | None |
| Replicas | One | One initially |
| Serverless sleeping | Disabled | Disabled |

**Keep web's root at the repository root.** Its build needs both `frontend/` and shared code
under `api/coach/core/`. Using `/frontend` or `/web` as its root breaks the Docker build.

Leave the start commands empty so Railway uses the Docker images' own entrypoint and CMD.
In particular, the default API image runs `node server.js` and does not contain npm.

Attach the API volume **before its first deployment**, with at least **1 GB** available. The
API's default upload free-space floor is 512 MiB, so a smaller volume can refuse every upload.
The volume contains accounts, credentials, workouts, the session secret, push keys and uploads.
No database service is needed. Do not deploy the Compose `media` downloader on Railway.

## 2. Configure web

Paste these values into web's Variables tab:

```dotenv
RAILWAY_DOCKERFILE_PATH=web/Dockerfile
PORT=3000
NGINX_PORT=3000
BACKEND=${{api.RAILWAY_PRIVATE_DOMAIN}}
RESOLVER=auto
RESOLVER_IPV6=on
TRUST_RAILWAY_PROXY=1
MEDIA_CDN_BASE=https://cdn.jsdelivr.net/gh/hasaneyldrm/exercises-dataset@7455efae41b330c265e7cd4b78dfa848e7ce5ebd
```

If you named the API service differently, replace `api` in the reference variable with that
name. `BACKEND` is a hostname, without a scheme or port. The API and nginx both listen on
`3000` in their separate containers; nginx also uses that port for its API upstream. Setting
web's `PORT` and `NGINX_PORT` to the same value makes Railway's healthcheck use nginx's port.

`RESOLVER=auto` reads the runtime nameservers from `/etc/resolv.conf` before rendering nginx's
configuration. IPv6 resolution supports Railway's older IPv6-only private environments as
well as newer dual-stack environments. The backend hostname is resolved again after API
replacements, rather than keeping its old IP until web restarts.

`TRUST_RAILWAY_PROXY=1` trusts Railway's overwritten `X-Real-IP` and `X-Forwarded-Proto`
headers. nginx replaces the API's forwarding headers with those values; it does not forward a
client-supplied `X-Forwarded-For` chain. Enable this only behind Railway's trusted edge, and
keep the API private. Leave `CF_CONNECTING_IP` unset for this deployment.

The CDN base must be an HTTPS hostname and optional path, without a query, fragment or login
credentials. nginx maps `/img/<file>` to `<base>/images/<file>` and `/gif/<file>` to
`<base>/videos/<file>`, verifies the CDN certificate and sends its hostname as SNI. Session
cookies and Authorization headers are removed from these CDN requests. The proxy adds the
same cache and security headers as local media; image traffic uses Railway's bandwidth.
See [NOTICE.md](../NOTICE.md) for the existing dataset and exercise-media terms.

Leave `BASE_PATH` empty to serve the app at the root. No `VITE_IMG_BASE`, `VITE_GIF_BASE`, or
frontend API URL setting is needed, and no separate web volume is needed.

## 3. Configure the API and final hostname

Generate web's Railway HTTPS domain, or connect your final custom domain. Do this before
anyone registers a passkey. Set the following on **api**, replacing the hostname in both:

```dotenv
PORT=3000
DATA_DIR=/data
RP_ID=your-web-hostname.up.railway.app
ORIGIN=https://your-web-hostname.up.railway.app
TRUST_PROXY=1
```

For a custom domain use, for example, `RP_ID=gym.example.com` and
`ORIGIN=https://gym.example.com`. `RP_ID` has no scheme, port, path or trailing slash;
`ORIGIN` has the scheme but no path or trailing slash. Passkeys created for an old hostname
do not sign in on a new one. Railway terminates HTTPS; the internal API connection uses HTTP.

Other existing settings, such as `ALLOW_GUEST`, `FIRST_USER_ADMIN`, `INVITE_ONLY` and
`SESSION_DAYS`, remain optional. See [.env.example](../.env.example) and
[Self-hosting](SELF_HOSTING.md) for their defaults. Guest mode is browser-local and does not
save workouts into the server volume.

Deploy api first, then web. The web healthcheck goes through nginx to the running API.

## 4. Verify and back up

- Open `https://<your-web-hostname>/api/health` and confirm `ok: true`. Check `/api/config`,
  the app, `/manifest.json` and `/sw.js` load. Check nginx and API logs for startup errors.
- Create a profile with a passkey, sign out and sign back in on the same HTTPS hostname.
- Save a workout while signed in. Restart or redeploy api and confirm the account and workout
  remain. Check a custom exercise photo/video upload as well.
- Browse exercise images and GIFs, install the PWA, and reopen it offline. Previously cached
  media should still display; media that has never been cached needs a connection.
- If testing client-IP logging, temporarily choose the existing `AUDIT_IP=full` setting on
  api, inspect an authentication event, then restore your preferred logging setting.

Configure Railway volume backups and include the entire `/data` directory. The `secret` file
keeps sessions valid and `vapid.json` keeps push subscriptions usable. If migrating existing
data, stop the API while copying the complete directory into the volume, and keep the old
hostname if you need its passkeys to work.

Keep api at one instance: it maintains state in memory and JSON files, and Railway volumes
cannot be used with replicas. Volume-backed API redeployments have brief downtime even with
a healthcheck. Keep Serverless sleeping off so the API's in-process reminders run while the
app is idle. Healthchecks gate deployment; they do not continuously monitor the app.

## Existing Docker Compose installations

All new settings are opt-in. With nothing changed, web still uses Docker's `127.0.0.11`
resolver, IPv6 DNS is off, forwarded IPs come from the direct peer, and built-in media is
served from the mounted folders. The existing media downloader and custom upload routes
continue to work. The new runtime settings can also be set in Compose's `.env`.

## Troubleshooting

| Symptom | Check |
|---|---|
| Build cannot find frontend or coach files | web's root must be the repository root |
| Railway healthcheck fails | web has both `PORT=3000` and `NGINX_PORT=3000`; api is running and `/api/health` returns 200 |
| `/api/` hangs or returns 502 | `RESOLVER=auto`, `RESOLVER_IPV6=on`, and the private `BACKEND` reference; both services are in the same environment |
| Passkey verification fails | `RP_ID` and `ORIGIN` match the final browser hostname exactly |
| Accounts disappear after redeployment | api has its volume mounted at `/data` and `DATA_DIR=/data` |
| Built-in media is missing | `MEDIA_CDN_BASE` is set on web, CDN access works, and nginx logs show no DNS or certificate errors |
| Every custom upload is refused for disk space | volume free space exceeds `MEDIA_MIN_FREE_MB` (512 MiB by default) |

Railway references: [Docker services](https://docs.railway.com/guides/docker-compose),
[Dockerfiles](https://docs.railway.com/guides/dockerfiles),
[private networking](https://docs.railway.com/networking/private-networking/how-it-works),
[edge headers](https://docs.railway.com/networking/public-networking/specs-and-limits),
[healthchecks](https://docs.railway.com/deployments/healthchecks),
[volumes](https://docs.railway.com/volumes/reference), and
[Serverless](https://docs.railway.com/deployments/serverless).
