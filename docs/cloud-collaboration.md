# Cloud collaboration

Codex Taskboard can run as a small shared Cloudflare deployment for two trusted collaborators:

- one Worker serves the built UI and the JSON API;
- D1 is the authoritative business database;
- a private R2 bucket stores attachments;
- UI, API, and attachment routes use HTTPS Basic Authentication; `/health` is public;
- open boards poll a global revision every two seconds and refresh after a change.

There is one cloud frontend deployment. Collaborator devices never build or deploy a second frontend copy.

The production resource names are:

| Resource | Name |
| --- | --- |
| Worker | `codex-taskboard` |
| D1 database | `codex-taskboard-db` |
| R2 bucket | `codex-taskboard-attachments` |

This is intentionally a shared-password trust model. The Basic username is only the actor name displayed in task and comment attribution, not a verified identity. Anyone who knows the shared password has full read and write access and can choose any actor name. Use it only with the other trusted collaborator.

## What stays local

The cloud stores project, issue, comment, relation, workflow, and attachment data. It does not store a device's absolute project or worktree paths.

Each collaborator runs the local companion for Codex, Git/worktree scanning, installed Skill/MCP discovery, and project path mapping. The companion keeps the cloud URL, actor name, shared password, and device-specific project mappings in `.data/cloud-companion.json` with mode `0600`. It runs in bridge-only mode for the UI: frontend assets and iframe `/api/*` business traffic go directly to Cloudflare; `taskctl` continues to use the companion as an authenticated CLI gateway.

The launcher exchanges the stored Basic credential for a seven-day signed browser session, installs it as a Secure, HttpOnly cookie for the exact Worker origin through CDP, and refreshes it every six hours while resident. The shared password is never placed in the iframe URL, renderer JavaScript, `localStorage`, or iframe messages. Rotating `TASKBOARD_SHARED_SECRET` invalidates both Basic credentials and all existing signed sessions.

When cloud mode is active, the cloud is the only business-data source. A failed cloud request fails visibly. The companion does not fall back to the local SQLite database and does not write to both databases. `taskctl cloud logout` returns that device to its separate local mode; it does not merge local and cloud data.

## Owner: validate locally

Install dependencies and build the frontend:

```bash
npm ci
npm run build:web
```

Create an ignored `.dev.vars` file containing a local-only value for `TASKBOARD_SHARED_SECRET`, apply the D1 migration to Wrangler's local state, and start the Worker:

```bash
npm run cloud:migrate:local
npm run dev:cloud
```

Open the printed loopback URL. The browser shows its native Basic Authentication prompt. Enter any local actor name as the username and the value from `.dev.vars` as the password.

Local Wrangler state lives under `.wrangler/` and is not committed.

## Owner: deploy

Authenticate Wrangler first:

```bash
npx wrangler login
npx wrangler whoami
```

Provision the production D1 database and private R2 bucket using the exact names above.

```bash
npx wrangler d1 create codex-taskboard-db
npx wrangler r2 bucket create codex-taskboard-attachments
```

`wrangler.jsonc` contains one production configuration and identifies the D1 binding by its resource name and `database_id`. A D1 database ID is public metadata and does not grant access, so it can be committed. Wrangler local development creates persistent local equivalents under `.wrangler/`; those are local simulations, not additional Cloudflare environments.

Apply the remote D1 migration and validate the deployment bundle:

```bash
npm run cloud:migrate
npm run cloud:deploy:dry-run
```

Set the shared password through Wrangler's private interactive prompt after the database schema is ready. Do not put the value in `wrangler.jsonc`, a shell command, a log, or a committed file. Then deploy the production Worker:

```bash
npx wrangler secret put TASKBOARD_SHARED_SECRET
npm run cloud:deploy
```

These commands create or update Cloudflare resources. This repository contains the production D1 database ID for the binding, but it does not contain the shared password or any API or OAuth token. Keep those credentials out of Git; cloning the repository does not grant access or mean the Worker has already been deployed.

Give the other collaborator the deployed Worker HTTPS origin and shared password through a trusted channel. Never publish the password in the repository, an issue, or logs.

Current Cloudflare references:

- [Workers Static Assets binding](https://developers.cloudflare.com/workers/static-assets/binding/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Create an R2 bucket](https://developers.cloudflare.com/r2/buckets/create-buckets/)
- [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

## Friend: connect an existing device bridge

The owner follows this device setup too, using the owner's own actor name and checkout path. The friend does not need your local database or your filesystem paths. A device needs the repository only for the small bridge/injector package; it does not build or deploy the cloud frontend during normal product updates. For the initial bridge install (or a later bridge-protocol update):

```bash
git pull --ff-only
npm ci
```

Configure cloud mode before the first managed launch. Use the deployed HTTPS Worker origin, choose the actor name that should appear on actions, and enter the shared password only at the private `Shared key:` prompt:

```bash
npm run taskctl -- cloud login \
  --url https://YOUR-WORKER-ORIGIN \
  --actor-name "FRIEND-DISPLAY-NAME"

npm run taskctl -- cloud status
npm run taskctl -- project list
```

The shared password is not part of the command and is not echoed by the prompt.

For every cloud project used with Codex, map its project ID to that friend's own absolute checkout path:

```bash
npm run taskctl -- project map PROJECT_ID \
  --workspace-path /absolute/path/on/their/device
```

The owner runs the same mapping command with the owner's own path. Mappings are intentionally different on each device and are never synchronized to D1.

For a first manual check, start the managed Codex instance:

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 npm run codex
```

After the manual check, quit Codex and install the macOS login helper once:

```bash
npm run device-helper:install
```

The helper starts Codex at login with a loopback-only CDP port and keeps the bridge resident while Codex is open. It does not continuously reopen Codex after the user deliberately quits; use `npm run device-helper:start` when a managed restart is needed in the same login session.

The Codex iframe points directly at the deployed Worker. The companion supplies only local Codex/Git/Skill/MCP capabilities and a signed browser session; it does not proxy board data, serve a frontend build, write the shared password to D1/R2, return that password to renderer code, or print it in logs. Device paths also stay off Cloudflare.

Do not point `CODEX_TASKBOARD_URL` directly at the cloud origin for CLI work. `taskctl` talks to the loopback companion, which applies Basic Authentication and the device's local project mapping. If the companion uses a non-default loopback port, set `CODEX_TASKBOARD_COMPANION_URL` to that loopback origin.

## Trigger Codex from a comment

Keep the local companion running. In an issue comment, type `@` and choose a Codex target from the suggestion list. The editor adds a device-specific assignment block instead of inserting the device name into the shared comment body. One comment can contain a shared note and one assignment per device:

```text
Please handle the API and UI updates in this round.

[@Codex · Mac mini | Update the Worker API.]
[@Codex · MacBook Pro | Refine the comment interaction.]
```

The bracketed form describes what the UI renders; assignments are stored as structured target IDs and instructions, not parsed back out of Markdown. The target shows whether that device is online:

- an online target claims the comment within a few seconds and starts immediately;
- an offline target keeps the request pending until that device reconnects;
- every assignment in the comment runs on its named device; targets are not a first-success candidate pool;
- one issue has one active execution lease, so assignments for the same issue run in order and cannot write the same development context concurrently;
- each assignment card shows `等待设备`, `处理中`, `已完成`, or `执行失败` independently.

The device receives only the shared comment text, its own instruction, and up to three recent compact handoff checkpoints. It does not receive the other devices' instructions. A local conversation is resumed only when that device already has an idle conversation for the same issue; a conversation ID from another device is never resumed locally.

Each completed or failed assignment writes a structured D1 checkpoint before its delivery is finished. The checkpoint contains a concise result summary, changed-file list, branch, and base/result commit metadata. The next device uses that checkpoint instead of replaying the whole conversation. Its execution prompt still requires reading the latest issue and all comments, safely fetching and fast-forwarding Git before edits, and committing and pushing the verified result before reporting completion. Local automation `memory.md` remains a device cache; D1 is the cross-device handoff source of truth.

The target ID is generated once and stored in the device's private `.data/cloud-companion.json`. Its visible name uses the Taskboard cloud login name (`Codex · LOGIN-NAME`); changing that login name updates the label without changing the target identity. Each device must map the cloud project to its own checkout before it advertises itself for that project.

## Browser-only access

Either collaborator can open the deployed HTTPS Worker URL directly. The browser's native Basic Authentication prompt asks for:

- username: the actor display name for that browser;
- password: the shared password.

The browser view supports the shared board and attachments. Device-only Codex, Git/worktree, Skill, and MCP capabilities still require the local companion.

## Rotate or revoke the shared password

The owner rotates the Worker secret using Wrangler's interactive prompt:

```bash
npx wrangler secret put TASKBOARD_SHARED_SECRET
```

After rotation, both devices rerun `taskctl cloud login` and enter the new password. Browser-only users must authenticate again; closing the authenticated browser session or clearing site authentication may be necessary because browsers cache Basic credentials.

Because both collaborators share one password, rotation affects both at once. There is no individual-user revocation in this two-person trust model.

## Advanced: one-time import of existing local data

The migration tool takes a consistent SQLite snapshot with `VACUUM INTO`, removes structured device-only paths, exports attachment hashes, and writes a private bundle. The default local paths are:

```bash
npm run cloud:data -- export \
  --database .data/taskboard.sqlite \
  --attachments .data/attachments \
  --output cloud-migration-exports/initial
```

The output directory contains issue content and attachment bytes. It is mode-restricted and ignored by Git, but it must still be handled as private data. This export is optional when starting with an empty cloud board.

Before importing, authenticate Wrangler, provision the named D1 and R2 resources, and run `npm run cloud:migrate` so the remote D1 schema exists. The target D1 must contain no projects, and none of the bundle's attachment keys may already exist in R2. Import refuses a non-empty target instead of merging or overwriting it.

Run the one-time Wrangler adapter with an explicit remote-operation acknowledgement:

```bash
TASKBOARD_MIGRATION_REMOTE=1 npm run cloud:data -- import \
  --bundle cloud-migration-exports/initial \
  --adapter ./scripts/wrangler-cloud-adapter.mjs

TASKBOARD_MIGRATION_REMOTE=1 npm run cloud:data -- verify \
  --bundle cloud-migration-exports/initial \
  --adapter ./scripts/wrangler-cloud-adapter.mjs
```

`TASKBOARD_MIGRATION_REMOTE=1` is a deliberate safety gate for these two commands. The adapter uses the current Wrangler login and the production resource names from `wrangler.jsonc`; it does not add a migration HTTP endpoint or store Cloudflare credentials. The commands are not run automatically by deployment, so having the repository does not mean data has already been imported.

The adapter has a local-persistence integration test that does not access remote Cloudflare resources:

```bash
node --test test/cloud-migration.test.mjs
```
