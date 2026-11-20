import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { PeerStatus, TeamHubStore } from "./store.js";

const peerStatusSchema = z.enum([
  "received",
  "thinking",
  "working",
  "pushing",
  "idle",
  "interrupted",
  "offline",
]);

function result(data: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
    structuredContent: data,
  };
}

export function createTeamHubMcpServer(
  peerId: string,
  store: TeamHubStore,
): McpServer {
  const server = new McpServer({
    name: "teamhub",
    version: "0.1.0",
  });

  server.registerTool(
    "team_begin_turn",
    {
      title: "Begin a Team Hub turn",
      description:
        "Record the raw user intent for a new turn. This is intended for the UserPromptSubmit hook. It creates provisional peer state before the model summarizes the request.",
      inputSchema: z
        .object({
          turn_id: z.string().min(1).max(256),
          raw_intent: z.string().min(1).max(8_000),
          cwd: z.string().min(1).max(4_096).optional(),
          repository: z.string().min(1).max(1_024).optional(),
          branch: z.string().min(1).max(1_024).optional(),
          ttl_seconds: z.number().int().min(30).max(86_400).default(1_800),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ turn_id, raw_intent, cwd, repository, branch, ttl_seconds }) => {
      const state = store.beginTurn(peerId, {
        turnId: turn_id,
        rawIntent: raw_intent,
        cwd,
        repository,
        branch,
        ttlSeconds: ttl_seconds,
      });
      return result({
        state: state as unknown as Record<string, unknown>,
        peers: store.getActiveStates(peerId) as unknown as Array<
          Record<string, unknown>
        >,
      });
    },
  );

  server.registerTool(
    "team_update_state",
    {
      title: "Update Team Hub work state",
      description:
        "Merge the current model's intent summary, planned paths, workspace, branch, and status into the active turn created by team_begin_turn.",
      inputSchema: z
        .object({
          turn_id: z.string().min(1).max(256),
          intent_summary: z.string().min(1).max(4_000).optional(),
          planned_paths: z
            .array(z.string().min(1).max(4_096))
            .max(200)
            .optional(),
          cwd: z.string().min(1).max(4_096).optional(),
          repository: z.string().min(1).max(1_024).optional(),
          branch: z.string().min(1).max(1_024).optional(),
          status: peerStatusSchema.optional(),
          ttl_seconds: z.number().int().min(30).max(86_400).optional(),
        })
        .strict()
        .refine(
          (value) =>
            value.intent_summary !== undefined ||
            value.planned_paths !== undefined ||
            value.cwd !== undefined ||
            value.repository !== undefined ||
            value.branch !== undefined ||
            value.status !== undefined,
          { message: "at least one state field must be provided" },
        ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      turn_id,
      intent_summary,
      planned_paths,
      cwd,
      repository,
      branch,
      status,
      ttl_seconds,
    }) => {
      const state = store.updateState(peerId, {
        turnId: turn_id,
        intentSummary: intent_summary,
        plannedPaths: planned_paths,
        cwd,
        repository,
        branch,
        status: status as PeerStatus | undefined,
        ttlSeconds: ttl_seconds,
      });
      return result({ state: state as unknown as Record<string, unknown> });
    },
  );

  server.registerTool(
    "team_get_state",
    {
      title: "Get active Team Hub state",
      description:
        "Return current non-expired peer intents, summaries, planned paths, working directories, branches, and statuses.",
      inputSchema: z
        .object({
          include_stale: z.boolean().default(false),
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ include_stale }) =>
      result({
        peers: store.getActiveStates(peerId, include_stale) as unknown as Array<
          Record<string, unknown>
        >,
      }),
  );

  server.registerTool(
    "team_list_peers",
    {
      title: "List team peers",
      description:
        "List all peers known to this Team Hub and show which peer is the caller.",
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => result({ peers: store.listPeers(peerId) }),
  );

  server.registerTool(
    "team_send_message",
    {
      title: "Send a team message",
      description:
        "Send a message from the current peer to one or more peers. Use '*' to message all known peers. The sender is fixed by the connection URL.",
      inputSchema: z
        .object({
          recipients: z
            .array(z.string().describe("A peer id, or '*' for all peers"))
            .min(1)
            .max(100),
          message: z.string().min(1).max(64 * 1024),
          reply_to: z.string().optional().describe("Optional parent message id"),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ recipients, message, reply_to }) =>
      result(
        store.sendMessage(peerId, recipients, message, reply_to) as unknown as Record<
          string,
          unknown
        >,
      ),
  );

  server.registerTool(
    "team_read_messages",
    {
      title: "Read team messages",
      description:
        "Read and consume unread messages delivered to the current peer. Messages are returned in delivery order.",
      inputSchema: z
        .object({
          limit: z.number().int().min(1).max(100).default(20),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ limit }) => {
      const messages = store.readMessages(peerId, limit);
      return result({ messages, count: messages.length });
    },
  );

  return server;
}
