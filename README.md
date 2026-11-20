# Team Hub

Team Hub is a small local MCP service that routes messages between independent
Codex instances. A peer is selected by the MCP URL:

```text
http://127.0.0.1:7878/mcp/alice
http://127.0.0.1:7878/mcp/bob
http://127.0.0.1:7878/mcp/carol
```

Peers are registered automatically when their MCP session connects. There is no
token or predeclared peer list in this MVP.

## Build and run

```bash
npm install
npm run build
npm start
```

The default SQLite file is `data/teamhub.sqlite`. Environment overrides:

```bash
TEAMHUB_PORT=7878
TEAMHUB_HOST=127.0.0.1
TEAMHUB_DB=/absolute/path/teamhub.sqlite
```

## Connect Codex

Each Codex instance connects to the URL containing its peer id:

```bash
codex -c 'mcp_servers.teamhub.url="http://127.0.0.1:7878/mcp/alice"'
codex -c 'mcp_servers.teamhub.url="http://127.0.0.1:7878/mcp/bob"'
codex -c 'mcp_servers.teamhub.url="http://127.0.0.1:7878/mcp/carol"'
```

The `-c` options are process-local, so they do not overwrite one another.

## Tools

- `team_begin_turn`: record raw user intent before model summarization.
- `team_update_state`: merge summarized intent, paths, cwd, branch and status
  into the active turn.
- `team_get_state`: read current non-expired peer intentions and work state.
- `team_list_peers`: list known peers.
- `team_send_message`: send to one or more peers, or use `*` for everyone.
- `team_read_messages`: read and consume unread messages for the current peer.

The sender is derived from the URL and cannot be supplied as a tool argument.

## Test

```bash
npm test
```

This MVP trusts the local peer id in the URL. Use it only on loopback.
