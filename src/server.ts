import { resolve } from "node:path";
import { createTeamHubApp } from "./app.js";
import { TeamHubStore } from "./store.js";

const port = Number.parseInt(process.env.TEAMHUB_PORT ?? "7878", 10);
const host = process.env.TEAMHUB_HOST ?? "127.0.0.1";
const databasePath = resolve(
  process.env.TEAMHUB_DB ?? "data/teamhub.sqlite",
);

const store = new TeamHubStore(databasePath);
const { app, closeSessions } = createTeamHubApp(store);

const server = app.listen(port, host, (error) => {
  if (error) {
    console.error("failed to start Team Hub:", error);
    process.exitCode = 1;
    return;
  }
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  process.send?.({ type: "listening", port: boundPort });
  console.log(
    JSON.stringify({
      service: "teamhub",
      mcp_url: `http://${host}:${boundPort}/mcp/<peer_id>`,
      health_url: `http://${host}:${boundPort}/health`,
      database: databasePath,
    }),
  );
});

async function shutdown(signal: string): Promise<void> {
  console.log(`received ${signal}, shutting down`);
  server.close();
  await closeSessions();
  store.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
if (process.send) process.on("disconnect", () => void shutdown("IPC disconnect"));
