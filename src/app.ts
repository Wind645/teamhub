import { randomUUID } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import {
  NodeStreamableHTTPServerTransport,
  type StreamableHTTPServerTransportOptions,
} from "@modelcontextprotocol/node";
import type { McpServer } from "@modelcontextprotocol/server";
import { isInitializeRequest } from "@modelcontextprotocol/server";
import type { Express, Request, Response } from "express";
import { createTeamHubMcpServer } from "./mcp.js";
import { TeamHubStore, validatePeerId } from "./store.js";

type SessionRecord = {
  peerId: string;
  server: McpServer;
  transport: NodeStreamableHTTPServerTransport;
};

export type TeamHubApp = {
  app: Express;
  sessions: Map<string, SessionRecord>;
  closeSessions: () => Promise<void>;
};

function getSessionId(req: Request): string | undefined {
  const value = req.headers["mcp-session-id"];
  return Array.isArray(value) ? value[0] : value;
}

function peerFromRequest(req: Request): string {
  return validatePeerId(String(req.params.peerId));
}

function jsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

export function createTeamHubApp(store: TeamHubStore): TeamHubApp {
  const app = createMcpExpressApp({
    host: "127.0.0.1",
    allowedHosts: ["localhost", "127.0.0.1", "[::1]"],
  });
  const sessions = new Map<string, SessionRecord>();

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "teamhub", version: "0.1.0" });
  });

  app.post("/mcp/:peerId", async (req, res) => {
    try {
      const peerId = peerFromRequest(req);
      store.registerPeer(peerId);
      const sessionId = getSessionId(req);

      let session: SessionRecord | undefined;
      if (sessionId) {
        session = sessions.get(sessionId);
        if (!session) {
          jsonRpcError(res, 404, -32001, "unknown MCP session");
          return;
        }
        if (session.peerId !== peerId) {
          jsonRpcError(res, 403, -32002, "MCP session belongs to another peer");
          return;
        }
      } else {
        if (!isInitializeRequest(req.body)) {
          jsonRpcError(
            res,
            400,
            -32000,
            "new MCP sessions must start with an initialize request",
          );
          return;
        }

        const server = createTeamHubMcpServer(peerId, store);
        let transport!: NodeStreamableHTTPServerTransport;
        const options: StreamableHTTPServerTransportOptions = {
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            sessions.set(newSessionId, { peerId, server, transport });
          },
        };
        transport = new NodeStreamableHTTPServerTransport(options);
        transport.onclose = () => {
          const closedSessionId = transport.sessionId;
          if (closedSessionId) {
            sessions.delete(closedSessionId);
          }
        };
        session = { peerId, server, transport };
        await server.connect(transport);
      }

      await session.transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        jsonRpcError(
          res,
          500,
          -32603,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  });

  const handleExistingSession = async (req: Request, res: Response) => {
    const peerId = peerFromRequest(req);
    const sessionId = getSessionId(req);
    if (!sessionId) {
      jsonRpcError(res, 400, -32000, "Mcp-Session-Id header is required");
      return;
    }
    const session = sessions.get(sessionId);
    if (!session) {
      jsonRpcError(res, 404, -32001, "unknown MCP session");
      return;
    }
    if (session.peerId !== peerId) {
      jsonRpcError(res, 403, -32002, "MCP session belongs to another peer");
      return;
    }
    await session.transport.handleRequest(req, res);
  };

  app.get("/mcp/:peerId", handleExistingSession);
  app.delete("/mcp/:peerId", async (req, res) => {
    await handleExistingSession(req, res);
    const sessionId = getSessionId(req);
    if (sessionId) {
      sessions.delete(sessionId);
    }
  });

  return {
    app,
    sessions,
    closeSessions: async () => {
      await Promise.all(
        [...sessions.values()].map(async (session) => {
          await session.transport.close();
          await session.server.close();
        }),
      );
      sessions.clear();
    },
  };
}
