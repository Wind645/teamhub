# Team Hub

Team Hub is a local MCP service for sharing messages and work intent between
independent Codex instances. A peer is selected by the MCP URL path:

```text
http://127.0.0.1:7878/mcp/alice
http://127.0.0.1:7878/mcp/bob
http://127.0.0.1:7878/mcp/carol
```

Peers are registered automatically when their MCP session connects. There is no
token or predeclared peer list in this MVP. The peer identity is therefore
configured in each Codex Home through its MCP URL.

## Requirements

Node.js 22 or newer is required. This project uses Node's built-in SQLite module.

## Start Team Hub

```bash
git clone https://github.com/Wind645/teamhub.git
cd teamhub
npm ci
npm run build
npm start
```

`npm start` runs `node dist/server.js`, so `npm run build` must run first after a
new clone or source change. Keep this terminal running while Codex peers use the
service.

For source development, `npm run dev` starts the TypeScript source directly:

```bash
npm run dev
```

Verify the service:

```bash
curl http://127.0.0.1:7878/health
```

The default SQLite file is `data/teamhub.sqlite`. Environment overrides:

```bash
TEAMHUB_PORT=7878 npm start
TEAMHUB_HOST=127.0.0.1 npm start
TEAMHUB_DB=/absolute/path/teamhub.sqlite npm start
```

## Configure a Codex peer

Each Codex Home needs a Team Hub entry in its `config.toml`. For example, an
Alice Home should contain:

```toml
[mcp_servers.teamhub]
url = "http://127.0.0.1:7878/mcp/alice"
```

Bob and Carol use `/mcp/bob` and `/mcp/carol` respectively. Start each Codex
with its own Home:

```bash
CODEX_HOME=/path/to/team_alice codex
CODEX_HOME=/path/to/team_bob codex
CODEX_HOME=/path/to/team_carol codex
```

For one-off configurations that must not modify `config.toml`, process-local
overrides also work:

```bash
codex -c 'mcp_servers.teamhub.url="http://127.0.0.1:7878/mcp/alice"'
```

Codex discovers the following tools dynamically from the MCP server. They are
not declared separately in `config.toml`.

## MCP tools

- `team_begin_turn`: record raw user intent before model summarization.
- `team_update_state`: merge summarized intent, paths, cwd, branch and status
  into the active turn.
- `team_get_state`: read current non-expired peer intentions and work state.
- `team_list_peers`: list known peers.
- `team_send_message`: send to one or more peers, or use `*` for everyone.
- `team_read_messages`: read and consume unread messages for the current peer.

The sender is derived from the URL and cannot be supplied as a tool argument.

## Lifecycle hooks

Hooks are Codex-side adapters and are not implemented by this repository yet.
When added, they should invoke MCP tools through an MCP client and translate the
results into `additionalContext` or a blocking decision. Hook definitions belong
in each Codex Home's `config.toml`; their implementation belongs outside the MCP
server.

## Tests

```bash
npm run build
npm test
```

## Security and limitations

This MVP trusts the peer ID in the URL and does not authenticate callers. Any
local process that connects to `/mcp/alice` is treated as Alice. Use loopback
only. Push claims, workspace locking, automatic hooks, and remote transport
authentication are not implemented.
