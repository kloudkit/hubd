# hubd client protocol, version 1

The contract between hubd and its client, [hubridge](https://github.com/kloudkit/hubridge).
hubd owns it and hubridge conforms to it. `client.schema.json` is the machine-readable form of
the socket messages; hubd's server tests and hubridge's tests both check their messages
against it.

## Changing the contract

Each change is tagged here: `protocol/v<N>` for protocol N, and `protocol/v<N>.<rev>` for a
later revision of it that only adds optional fields. A new protocol number is for a change an
older peer cannot ignore. A change ships in this order:

1. here: edit this README and the schema, then tag it;
2. hubridge: copy `client.schema.json` from the tag into `protocol/`, put the tag in
   `protocol/TAG`, then release;
3. hubd: copy the schema the same way, then bump the bundled hubridge release
   (`HUBRIDGE_VERSION`).

Both repos' CI fails when their copy differs from the tag it names.

## Auth

Every client call sends `Authorization: Bearer <token>`. Tokens look like `hubd_<43
base64url chars>`, are made in Settings › Access and are stored by hubd as a SHA-256 hash.
States: `active` and `pending` (made by a rotation, not yet used). The first request made
with a pending token promotes it to active and removes the token it replaced: that use is
the client's confirmation that it wrote and read back the new token. Revoking a token
removes it, and its pending replacement, at once.

With no login (`HUBD_AUTH=none`) and no live token, client routes are open, for local dev.
Once any token is live, they require one.

## HTTP

| Route | Who | Returns |
|---|---|---|
| `GET /api/client/hello` | hubridge | `{ "protocol": 1 }`: the protocol hubd speaks; hubridge checks it before installing a release |
| `POST /api/client/enroll` `{ "code" }` | installer, no token | `{ "token", "name" }`; 401 for an unknown, used or expired code |
| `GET /api/client/ws` | hubridge | WebSocket upgrade, below |

## Install

hubd's image bundles one hubridge release and serves it under `/install`, so a machine that
reaches only hubd can install:

| Route | Returns |
|---|---|
| `GET /install?code=<code>` | the bundled `install.sh` with its `HUBD_URL=''` and `CODE=''` lines filled in; 400 for a malformed code, 500 when hubd's public URL holds a quote, backslash or whitespace |
| `GET /install/checksums.txt` | `<sha256>  <name>`, one line per file |
| `GET /install/manifest.json`, `GET /install/manifest.json.sig` | the release's signed manifest, below |
| `GET /install/files/hubridge-<os>-<arch>` | a binary: `<os>` is `linux` or `darwin`, `<arch>` is `amd64` or `arm64` |

`install.sh` holds exactly one `HUBD_URL=''` line and one `CODE=''` line; hubd replaces those
two lines and nothing else. The UI makes a one-time code for a named client and shows:

```sh
curl -fsSL '<origin>/install?code=<code>' | sh
curl -fsSL '<origin>/install?code=<code>' | sh -s -- --version latest
```

The code works once, within 15 minutes; the installer posts it to `/api/client/enroll` and
keeps the token it gets back, so shell history only ever holds a dead code. hubd stores the
code's hash.

### Manifest

`manifest.json` is `{ "version": "v0.1.0", "protocol": 1, "assets": { "<name>": "<sha256>" } }`.
`manifest.json.sig` is the base64 ed25519 signature of `manifest.json`'s exact bytes, made
with hubridge's release key; hubridge carries the public key. Every GitHub release of
`kloudkit/hubridge` has the same files.

## WebSocket `/api/client/ws`

JSON text frames. Every message has `type`; client messages that need an answer carry `id`
(unique per connection) and get `{ "type": "ack", "of": id }` after the server has committed
them. Unacked messages stay in the client's queue and are re-sent after a reconnect; the
server treats a repeated `id` with the same content as a no-op.

On connect: `hello`, wait for `welcome`, then a `session` message for every live session,
then one `live` message. A message that fails validation gets `{ "type": "error", "error" }`
and the socket stays open. Close codes: 4000 refused, 4001 a message before `hello`, 4002
not JSON, 4003 token revoked or machine removed, 1011 server error. hubd marks a machine's
working and waiting sessions `unknown` after 2 minutes with no ping; an `unknown` session
leaves that state only through a new `session` message.

### Client to server

- `hello`: first message. `{ machine, protocol, version, channel }`. `channel` is where the
  client takes its updates from: `bundled` (hubd's `/install`), `latest`, or a release tag
  such as `v0.1.0`. The server answers `welcome` or `refused`.
- `ping`: every 30 s. Updates the machine's last ping.
- `session`: one session summary, sent when its transcript changes.
  ```json
  { "type": "session", "id": "m1", "session": {
    "id": "<session uuid>", "folder": "/abs/start/folder", "root": "/abs/git/root", "remote": "git@github.com:org/name.git",
    "title": "", "excerpt": "", "state": "working | waiting | ended",
    "startedAt": "<iso>", "lastEventAt": "<iso>", "endedAt": "<iso> | null",
    "tokens": [{ "day": "YYYY-MM-DD", "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }],
    "todoWrites": ["<todo id>"] } }
  ```
  `tokens` is the full per-day total for the session (UTC days), not a delta. Optional `hours`
  (same shape with `hour`, a UTC hour start) holds the session's non-zero hours within the last
  48 hours, at most 48 entries; it replaces the stored hours, and leaving it out means none.
  `excerpt` is at most 200 characters, already masked. `remote` is the `origin` of `root`, or
  absent; hubd normalizes it to `host/org/name` and files the session under that repo.

  Optional, all added without a protocol bump; a hubd that does not read them drops them:
  - From Claude Code's session registry (`~/.claude/sessions/<pid>.json`, reconciled with
    `claude agents --json --all`): `status` (`busy`, `waiting`, `idle`), `waitingFor`
    (`permission prompt`, `input needed`, `sandbox request`, `worker request`, `dialog open`),
    `name`, `kind` (`interactive`, `background`), `job` (`{ id, state }` for a background
    session: `working`, `blocked`, `done`, `failed`, `stopped`) and `version`. `state` still
    carries `working`, `waiting` or `ended`: `busy` is `working`, `waiting` and `idle` are both
    `waiting`.
  - From the transcript: `customTitle` (from `/rename`), `branch`, `continuedIn` (the session
    this one moved into), `models` (per UTC day, model and `speed`: `input`, `output`,
    `cacheRead`, `cacheWrite5m`, `cacheWrite1h`, `webSearch`, `webFetch`), `ledger` (the last
    `cost-state` line: `costUSD`, lines added and removed, API and tool milliseconds, per-model
    tokens and `costUSD`), `context` (`tokens` of the last main-chain reply, or the size after a
    compaction, with `model` and `requestedModel`), `compactions`, `limitHits` (a 429's
    `quotaLimits`: `type`, `resetsAt`, `status`) and `prs` (`number`, `url`, `repo`); the last
    three hold at most 20 each.
  - From the claims it read or edited: `topics`, the `topics:` of each estate claim
    (`…/estate/claims/<slug>.md`) the session or its subagents touched, read on the machine (a
    path that is gone is looked up by slug in `$ESTATE`, else `~/.claude/estate`), those of the
    most claims first; each claim counts once whatever path reached it.
  - Each reply is counted once on the machine, by `message.id` and `requestId`: a reply copied
    into a fork or a background session counts for the session it was continued from, and a
    sidechain copy counts for the main chain's.
- `usage`: the account's latest Claude usage, with no `id` (the latest wins), sent when it
  changes. `{ "usage": { "fiveHour": { "utilization": 0.21, "resetsAt": "<iso>" }, "sevenDay": { … },
  "source": "statusline | probe", "at": "<iso>" } }`. `utilization` is a fraction (1 is the
  limit). hubd keeps the latest on the machine.
- `live`: on connect and when it changes, with no `id` (it is re-sent on every connect).
  `{ "live": [sessionId], "present": [sessionId] }`:
  `live` are sessions whose `claude` process runs, or background sessions that are `working`,
  `blocked` or `done` with their process retired; `present` are sessions whose transcript and
  folder exist on this machine. A process counts as running when its registry file is named
  after its pid, its `procStart` matches the process's start time and its `pidDomain` is this
  machine's; a crash leaves the file behind, so the file alone proves nothing. A machine whose
  Claude Code has no registry falls back to the pid the SessionStart hook hands over.
- `result`: the answer to a server `command`. `{ "of": commandId, "ok": true }` or
  `{ "of": commandId, "ok": false, "error": "…" }`.

### Server to client

- `welcome`: `{ protocol }`.
- `refused`: `{ reason, minProtocol, maxProtocol }`, the protocols hubd accepts. The client
  logs it and stops reconnecting until it is updated.
- `ack`: `{ of }`.
- `command`: `{ id, command, args }`. Version 1 commands:
  - `rotate` `{ token }`: write the new token to the client home atomically (temp file and
    rename), read it back, then reconnect with it. Answer `result` before reconnecting.
  - `restore` `{ sessionId }`: reserved.
  - `sync`: reserved.

## Folder, root and repo

`folder` is where `claude` was started: the transcript's first `cwd` (the project folder name
under `~/.claude/projects` encodes it lossily, `/` and `.` both become `-`). `root` is the git
root the session edited most, else the one it read or ran commands in most, else `folder`.
`remote` is `root`'s `origin`. A repo in hubd is a remote, never a path: two machines with the
same checkout in different folders file their sessions under one repo.
