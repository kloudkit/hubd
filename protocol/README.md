# hubd client protocol

The contract between hubd and [hubridge](https://github.com/kloudkit/hubridge). hubd owns it
and hubridge conforms to it. `client.schema.json` defines every socket message. This folder is
the Go module `github.com/kloudkit/hubd/protocol`, which exports the schema (`Schema`) and the
protocol number (`Version`).

## Versions

Protocol N is module version `vN.x.y`, tagged `protocol/vN.x.y`; from 2 on, the module path
ends in `/vN`. A minor version only adds optional fields. A change ships here first, then in a
hubridge release that requires it, then in hubd's bundled hubridge (`HUBRIDGE_VERSION`).

## Auth

Client calls send `Authorization: Bearer <token>`, a `hubd_…` token made in Settings › Access.
A rotated token stays `pending` until its first use, which retires the old one. With no login
and no live token, client routes are open.

## HTTP

| Route | Returns |
|---|---|
| `GET /api/client/hello` | `{ "protocol": N }` |
| `POST /api/client/enroll` `{ "code" }` | `{ "token", "name" }`, with no token; 401 for an unknown, used or expired code |
| `GET /api/client/ws` | the WebSocket, below |
| `GET /api/client/rules?machine=<name>` | this machine's instructions, with an `ETag`; `304` for a matching `If-None-Match` |
| `GET /install?code=<code>` | the bundled `install.sh`, its `HUBD_URL=''` and `CODE=''` lines filled in |
| `GET /install/checksums.txt` | `<sha256>  <name>`, one line per binary |
| `GET /install/manifest.json`, `GET /install/manifest.json.sig` | the bundled release's manifest and signature |
| `GET /install/files/hubridge-<os>-<arch>` | a binary: `linux` or `darwin`, `amd64` or `arm64` |

An install code works once, within 15 minutes. `manifest.json` is
`{ "version", "protocol", "assets": { "<name>": "<sha256>" } }`, and `manifest.json.sig` is
the base64 ed25519 signature of its exact bytes. Every hubridge GitHub release has both.

## WebSocket

The client sends `hello`, then waits for `welcome` or `refused` (with `minProtocol` and
`maxProtocol`). It then sends a `session` for each live session and one `live`. A message with
an `id` is acked once hubd commits it; unacked messages are re-sent after a reconnect, and a
repeated `id` is a no-op. A message that fails validation gets `error`, and the socket stays
open. The client pings every 30 s; after 2 minutes without one, hubd marks the machine's
working and waiting sessions `unknown`.

Close codes: 4000 refused, 4001 a message before `hello`, 4002 not JSON, 4003 token revoked or
machine removed, 1011 server error.

Commands: `rotate { token }` writes the token atomically, reads it back, answers `result`,
then reconnects with it. `sync {}` fetches the instructions again, writes them, then answers
`result`. `restore` is reserved.

## Instructions

`GET /api/client/rules?machine=<name>` answers `{ "files": [{ "name", "body" }] }`: the operator's
instructions for that machine, each Markdown file named `^[a-z0-9][a-z0-9-]*\.md$`, with an `ETag`.
The client writes them to `<Claude config dir>/rules/hubd/`, removes only files it wrote, keeps
each body in its own state so it can write them back offline on start, and retries a failed fetch
with backoff. It fetches after every `welcome` and on `sync`; hubd sends `sync` when an
instruction, its switch, machines or order, or a claim one loads changes. A `404` is an error:
the files stay. A `builtins` key, if present, is ignored.
