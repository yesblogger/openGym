# openGym MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) bridge that lets an external LLM
application (Codex Desktop, Claude Desktop, Cursor, etc.) access your openGym profile —
routines, workouts, body-weight log, estimated 1RMs, and muscle balance — through a local
stdio process. Read a self-hosted `./data` directory, or use a profile token over HTTPS.

Filesystem mode is read-only and requires no extra authentication. Remote mode supports
read/write access with owner-managed tokens. Neither mode adds a container or exposes
passkeys, VAPID keys or session secrets to the LLM.

The numbers it answers with are computed by the **same pure functions the React UI uses**
(`frontend/src/lib/*.js`) — `estimate1RM`, `loadOfWorkouts`, `effectiveRoutine`, etc. — so a
"what's my bench 1RM?" answer matches the Stats screen exactly.

> Filesystem access remains read-only. Token-authenticated remote read/write access is available
> for Railway and other HTTPS instances; see below.

## Quick start

### 1. Install

```bash
cd mcp
npm ci
```

### 2. Point it at your data

The MCP server reads the same `./data` directory `docker compose up` creates. Pick the profile
to answer for — its user id is in `./data/db.json` under `users[].id`:

```bash
# single-user instance (the common self-hosted case) — auto-detected:
node src/index.js

# multi-user instance, or just to be explicit:
OPENGYM_UID=<your-uid> OPENGYM_DATA=/path/to/openGym/data node src/index.js
```

### 3. Register with your LLM client

Add the server to your LLM client's MCP config. For Claude Desktop, edit
`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```jsonc
{
  "mcpServers": {
    "opengym": {
      "command": "node",
      "args": ["/absolute/path/to/openGym/mcp/src/index.js"],
      "env": {
        "OPENGYM_DATA": "/absolute/path/to/openGym/data",
        "OPENGYM_UID": "<your-uid>"   // optional — auto-detected if you have one profile
      }
    }
  }
}
```

For Cursor and other MCP-compatible clients, see the client's MCP docs — the same `command` +
`args` + `env` shape is what every stdio MCP server expects.

Restart the client; you should see the openGym tools appear with "serving profile \<name\>" on
the server's stderr.

## Railway and other remote instances (read/write)

The local stdio bridge can now call your existing OpenGym web origin over HTTPS. The API is
still the only writer of your profile; no extra container, MCP HTTP endpoint or OAuth service
is needed. The filesystem mode above stays read-only.

1. Set `MCP_ENABLED=1` on the API service and redeploy API + web with this version. Keep the API
   private and its persistent `/data` volume mounted. The existing `/api/` proxy is sufficient.
2. Sign in to OpenGym, open **Settings → Account → MCP access tokens**, and create a named token.
   Choose **Read and write** for all 15 tools, or **Read only** for the ten reading tools.
3. Copy the secret while it is shown. Tokens expire after 90 days and can be revoked immediately.
   “Sign out everywhere”, disabling the account or deleting it also ends token access.
4. Run `npm ci` in `mcp/` on the computer that runs your AI client.
5. Set `OPENGYM_TOKEN` in the environment inherited by your client. Do not put its value in
   source control, command arguments, screenshots or chat. Configure `OPENGYM_URL` as the app's
   public URL, including its path prefix when using a subpath deployment.

For **Codex Desktop on Windows**, the setup helper validates your token, saves it in your user
environment, backs up the existing Codex config and registers the server. Run from the repository:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File mcp/scripts/setup-codex.ps1 -Url https://your-opengym-web-domain
```

Paste the token at its secure prompt, then restart Codex Desktop. The secret is never a command
argument or stored in the repository. To configure manually, add this to `%USERPROFILE%/.codex/config.toml` (substitute your
actual absolute paths and public web URL):

```toml
[mcp_servers.opengym]
command = "C:/Program Files/nodejs/node.exe"
args = ["C:/Users/Amartya Gupta/Desktop/OpenGym/openGym/mcp/src/index.js"]
cwd = "C:/Users/Amartya Gupta/Desktop/OpenGym/openGym"
env_vars = ["OPENGYM_TOKEN"]
default_tools_approval_mode = "writes"
startup_timeout_sec = 30
tool_timeout_sec = 90

[mcp_servers.opengym.env]
OPENGYM_URL = "https://your-opengym-web-domain"
```

Restart the client after setting its environment. Verify the entry using `codex mcp list`,
then check `/mcp` in a new chat and call `list_routines`. Tokens bind the profile: do not set
`OPENGYM_UID` or `OPENGYM_DATA` with remote mode. Mixed configuration is refused.
HTTPS is required except for localhost development. Redirects are refused to keep credentials
at the configured origin. A fresh profile snapshot is fetched for every tool call. No raw
account database, passkey material, session secrets or VAPID keys are fetched.

Remote writes add:

| Tool | Inputs and behavior |
|---|---|
| `search_exercises` (read) | `query`, optional `limit`: catalogue/custom IDs and metadata, without media URLs. |
| `log_workout` | `request_id`, `date`, `started_at` (RFC3339 with offset), `duration_minutes`, `unit`, actual `entries`; optional `name`, `note`, `bodyweight`, `routine_ids`. Logs history like “Log a past workout”, rebuilding PRs without changing confirmed weights. |
| `add_bodyweight` | `date`, `weight`, `unit`. Replaces the weigh-in for that date. |
| `edit_routine` | `mode: create/update`, `changes`; create requires `request_id`, `changes.name`, `changes.ex`; update requires `routine_id`. Optional fields: name, emoji, prog, excludeFromProgression, ex. `ex` replaces the exercise list and requires `unit`. |
| `assign_weekday` | `weekday` (0 Sunday–6 Saturday), ordered `routine_ids`; `[]` clears it. |
| `override_day` | `date`, `action: set/rest/clear`; `set` also needs `routine_id`. |

Exercise configurations use the same keys as saved routines: `id`, `sets`, `reps`, `weight`,
`restSec`, `prog`, timed/cardio settings, supersets and planned intensifiers. Logged entries
use `id`, `sets`, optional `mode`, `rid`, `noProg`, `sg` and notes. Each actual set states `done`
and uses `w/r`, `sec` or `min`; unilateral rows carry `sides.L/R`, drop sets carry `drops`, and
rest-pause sets carry `clusters`. The server derives volume, top weights and PRs. Explicit `kg`
or `lb` values are converted into the profile unit. Use `search_exercises` before choosing IDs,
and `preview_session` before recommending loads.

Reuse a stable `request_id` for workout logging or routine creation: it becomes the entity ID,
and repeating it returns the existing entity. Profile writes use revision and write-ID checks;
unrelated concurrent changes are rebased at most twice. A change to the same target returns
`CONFLICT`. Lost responses are reconciled before retrying, so do not change request IDs after
an uncertain result. Read the profile before retrying a conflict. A new profile without a saved
document starts with the app's empty kg defaults on its first write; corrupt files are refused.

Tokens are stored only as hashes in `/data/tokens.json`. Back up the complete `/data` directory
as usual. Token management uses ordinary sessions and CSRF protection; MCP tokens grant access
only to `/api/mcp/data`, never account or admin endpoints. No new runtime dependencies are added.

Troubleshooting: `AUTH` means the token is expired/revoked or the account was disabled;
`DISABLED` means enable MCP on the API; `NETWORK` means check the public app URL/connection;
`CONFIG` means remove mixed local/remote variables or supply both remote settings. A corrupt
state or token file is refused rather than replaced with an empty document. Disable
`MCP_ENABLED` or revoke the token to stop access.

## Tools

Nine read-only tools in v1:

| Tool | What it answers |
|---|---|
| `list_routines` | What routines are saved in my profile? (names + exercise counts) |
| `get_routine` | What does the Push Day routine prescribe? (sets/reps/weight and rest per exercise) |
| `preview_session` | What will the app actually put on screen when I start this routine — after the progression policy and my history have overridden the plan? |
| `get_week_plan` | What's planned when: the next seven days with their routines and how each was decided (coach week, a pinned session, an override, the weekday plan), the current coach week when one is running, and the weekday table. |
| `list_workouts` | Recent sessions — newest first, with dates, sets done/planned, volume, duration, PRs. |
| `get_workout` | Full set-by-set breakdown of one session, by `workout_id` or by date. On a day with two sessions the date alone returns both ids to pick from rather than guessing at one. |
| `get_bodyweight` | Weigh-ins with the latest weight, the goal line, and deltas vs goal. |
| `estimate_1rm` | All-time best 1RM for an exercise + the trend, or a PR table across all exercises. |
| `muscle_balance` | Which muscles I've trained this week/month/all-time, ranked + which I've neglected. |

`get_routine` and `preview_session` answer two different questions, and confusing them is the
easiest way for a coach to give wrong advice. `get_routine` reports what the routine *stores*.
`preview_session` reports what the athlete will actually *see*: a routine holding "squat 3×8 @
60 kg" opens at 75 kg if the policy progressed or deloaded from that routine's last logged
session. The routine's own weight is the last fallback the session builder consults, not the
first; its reps hold unless a policy that moves reps moved them, or the profile starts planned
sessions from the last session (`starts_from`). Ask `preview_session` before naming a weight.

Each tool returns JSON the LLM can format as it likes; structured fields (sets, dates, levels)
are pre-formatted into human-readable labels in `src/labels.js` so the LLM doesn't need to
re-interpret them.

## How it reuses the training logic

The MCP server imports the training helpers under `frontend/src/lib/` directly as Node ESM
and calls the same functions the React UI does (`history.js`, `onerm.js`, `muscles.js`,
`exercises.js`). The numbers it returns match what the Stats screen shows, because they are
the same code.

The one lib file that wasn't Node-safe was `i18n.js` (Vite's `import.meta.glob` at module
top level) — split into `i18n-core.js` (pure, Node-safe) + `i18n.js` (Vite/React bits,
re-exports from core). `exercises.js` got a one-line `import.meta.env || {}` guard. No new
dependencies landed in `frontend/`, no public exports changed.

## Design constraints honoured

- **One runtime dependency beyond the MCP SDK:** none. No database driver, no HTTP framework.
- **No new container.** stdio transport is spawned by the LLM client; nothing to add to
  `docker-compose.yml`.
- **Profile-scoped access.** Filesystem mode uses the local file boundary; remote mode uses
  hashed, revocable tokens. No passkey material, VAPID keys or session secrets cross either.
- **No telemetry.** Filesystem mode has no network calls; remote mode calls only the configured
  OpenGym API over HTTPS. The process exits when the LLM client disconnects.

## Tests

```bash
cd mcp && npm test
```

The suite seeds state from `frontend/src/lib/demoSeed.js` (the same deterministic fixture
the public demo runs on), pins read response shapes, exercises remote conflict/replay handling,
and calls all 15 tools through a real stdio client and API against a disposable local profile.
Coverage includes rest-day overrides, missing routines, zero-workout history, no synced state,
superset links and three 1RM formulas.
"Today" is pinned via `vi.useFakeTimers({ now: ..., toFake: ['Date'] })` so date-dependent
tools see consistent values regardless of when the suite runs. Pure mutations have adjacent
tests in `frontend/src/lib/mcp-mutations.test.js`; token and endpoint tests live in `api/test/`.

## Roadmap

- **Done (Phase 1):** read-only stdio, 8 tools, direct `./data` access.
- **Done (Phase 1.5):** `preview_session` — the policy's next prescription, the opening set
  rows it produces, and which of plan / confirmed weight / history each number came from.
- **Done (Phase 2):** profile-scoped remote read/write over local stdio, owner-managed tokens,
  five write tools and exercise search. Writes use API revisions rather than direct file locks.
- **Phase 3:** Streamable HTTP transport, opt-in 4th container in `docker-compose.yml`. Same
  tool implementations, second transport — the MCP SDK supports both behind one tool registration.

## License

AGPL-3.0-or-later, same as openGym.
