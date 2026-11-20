import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createTeamHubApp } from "../src/app.js";
import { TeamHubStore } from "../src/store.js";

async function listen(app: ReturnType<typeof createTeamHubApp>["app"]) {
  return await new Promise<Server>((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

async function connectPeer(baseUrl: string, peerId: string) {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp/${peerId}`),
  );
  const client = new Client({ name: `test-${peerId}`, version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

test("messages are isolated by peer and consumed after reading", async () => {
  const store = new TeamHubStore(":memory:");
  const hub = createTeamHubApp(store);
  const server = await listen(hub.app);
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const alice = await connectPeer(baseUrl, "alice");
  const bob = await connectPeer(baseUrl, "bob");
  const carol = await connectPeer(baseUrl, "carol");

  try {
    const tools = await alice.client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      [
        "team_begin_turn",
        "team_get_state",
        "team_list_peers",
        "team_read_messages",
        "team_send_message",
        "team_update_state",
      ],
    );

    const peers = await alice.client.callTool({
      name: "team_list_peers",
      arguments: {},
    });
    assert.equal(peers.isError, undefined);
    const peerList = peers.structuredContent as {
      peers: Array<{ peer_id: string; is_self: boolean }>;
    };
    assert.deepEqual(
      peerList.peers.map((peer) => peer.peer_id),
      ["alice", "bob", "carol"],
    );
    assert.equal(
      peerList.peers.find((peer) => peer.is_self)?.peer_id,
      "alice",
    );

    const began = await alice.client.callTool({
      name: "team_begin_turn",
      arguments: {
        turn_id: "turn-1",
        raw_intent: "Fix parser error handling",
        cwd: "/work/alice",
        repository: "project",
        branch: "alice/parser",
      },
    });
    assert.equal(began.isError, undefined);
    assert.equal(
      (
        began.structuredContent as {
          state: {
            intent_summary: string | null;
            raw_intent: string;
            status: string;
          };
        }
      ).state.intent_summary,
      null,
    );
    assert.equal(
      (
        began.structuredContent as {
          state: { status: string };
        }
      ).state.status,
      "received",
    );

    const bobViewBeforeSummary = await bob.client.callTool({
      name: "team_get_state",
      arguments: {},
    });
    const aliceProvisional = (
      bobViewBeforeSummary.structuredContent as {
        peers: Array<{
          peer_id: string;
          raw_intent: string | null;
          intent_summary: string | null;
        }>;
      }
    ).peers.find((peer) => peer.peer_id === "alice");
    assert.equal(aliceProvisional?.raw_intent, "Fix parser error handling");
    assert.equal(aliceProvisional?.intent_summary, null);

    const updated = await alice.client.callTool({
      name: "team_update_state",
      arguments: {
        turn_id: "turn-1",
        intent_summary: "Improve parser error reporting and tests",
        planned_paths: ["src/parser/", "tests/parser/"],
        status: "working",
      },
    });
    assert.equal(updated.isError, undefined);
    assert.deepEqual(
      (
        updated.structuredContent as {
          state: {
            intent_summary: string;
            planned_paths: string[];
            status: string;
          };
        }
      ).state,
      {
        ...(
          updated.structuredContent as {
            state: Record<string, unknown>;
          }
        ).state,
        intent_summary: "Improve parser error reporting and tests",
        planned_paths: ["src/parser/", "tests/parser/"],
        status: "working",
      },
    );

    const bobViewAfterSummary = await bob.client.callTool({
      name: "team_get_state",
      arguments: { include_stale: false },
    });
    const aliceSummary = (
      bobViewAfterSummary.structuredContent as {
        peers: Array<{
          peer_id: string;
          intent_summary: string | null;
          planned_paths: string[];
        }>;
      }
    ).peers.find((peer) => peer.peer_id === "alice");
    assert.equal(
      aliceSummary?.intent_summary,
      "Improve parser error reporting and tests",
    );
    assert.deepEqual(aliceSummary?.planned_paths, [
      "src/parser/",
      "tests/parser/",
    ]);

    const retriedBegin = await alice.client.callTool({
      name: "team_begin_turn",
      arguments: {
        turn_id: "turn-1",
        raw_intent: "Fix parser error handling",
        cwd: "/work/alice",
      },
    });
    assert.equal(
      (
        retriedBegin.structuredContent as {
          state: { intent_summary: string | null };
        }
      ).state.intent_summary,
      "Improve parser error reporting and tests",
    );
    assert.equal(
      (
        retriedBegin.structuredContent as {
          state: { status: string };
        }
      ).state.status,
      "working",
    );

    const wrongTurn = await alice.client.callTool({
      name: "team_update_state",
      arguments: {
        turn_id: "turn-wrong",
        intent_summary: "should fail",
      },
    });
    assert.equal(wrongTurn.isError, true);

    const nextTurn = await alice.client.callTool({
      name: "team_begin_turn",
      arguments: {
        turn_id: "turn-2",
        raw_intent: "Investigate lexer crash",
        cwd: "/work/alice",
      },
    });
    assert.deepEqual(
      (
        nextTurn.structuredContent as {
          state: {
            intent_summary: string | null;
            planned_paths: string[];
            status: string;
          };
        }
      ).state,
      {
        ...(
          nextTurn.structuredContent as {
            state: Record<string, unknown>;
          }
        ).state,
        intent_summary: null,
        planned_paths: [],
        status: "received",
      },
    );

    const sent = await alice.client.callTool({
      name: "team_send_message",
      arguments: {
        recipients: ["bob"],
        message: "hello bob",
      },
    });
    assert.equal(sent.isError, undefined);
    const sentData = sent.structuredContent as {
      message_id: string;
      sender_peer_id: string;
      recipients: string[];
    };
    assert.equal(sentData.sender_peer_id, "alice");
    assert.deepEqual(sentData.recipients, ["bob"]);

    const bobMessages = await bob.client.callTool({
      name: "team_read_messages",
      arguments: { limit: 20 },
    });
    const bobData = bobMessages.structuredContent as {
      messages: Array<{ sender_peer_id: string; content: string }>;
    };
    assert.deepEqual(
      bobData.messages.map(({ sender_peer_id, content }) => ({
        sender_peer_id,
        content,
      })),
      [{ sender_peer_id: "alice", content: "hello bob" }],
    );

    const bobMessagesAgain = await bob.client.callTool({
      name: "team_read_messages",
      arguments: { limit: 20 },
    });
    assert.equal(
      (bobMessagesAgain.structuredContent as { count: number }).count,
      0,
    );

    const carolMessages = await carol.client.callTool({
      name: "team_read_messages",
      arguments: { limit: 20 },
    });
    assert.equal(
      (carolMessages.structuredContent as { count: number }).count,
      0,
    );

    const multi = await alice.client.callTool({
      name: "team_send_message",
      arguments: {
        recipients: ["bob", "carol", "bob"],
        message: "multi-recipient",
      },
    });
    assert.equal(multi.isError, undefined);
    const multiData = multi.structuredContent as {
      recipients: string[];
    };
    assert.deepEqual(multiData.recipients.sort(), ["bob", "carol"]);

    for (const peer of [bob, carol]) {
      const response = await peer.client.callTool({
        name: "team_read_messages",
        arguments: {},
      });
      const data = response.structuredContent as {
        messages: Array<{ content: string }>;
      };
      assert.deepEqual(
        data.messages.map((message) => message.content),
        ["multi-recipient"],
      );
    }

    const broadcast = await alice.client.callTool({
      name: "team_send_message",
      arguments: {
        recipients: ["*"],
        message: "broadcast",
      },
    });
    assert.equal(broadcast.isError, undefined);

    for (const peer of [bob, carol]) {
      const response = await peer.client.callTool({
        name: "team_read_messages",
        arguments: { limit: 20 },
      });
      const data = response.structuredContent as {
        messages: Array<{ content: string }>;
      };
      assert.deepEqual(
        data.messages.map((message) => message.content),
        ["broadcast"],
      );
    }

    const reply = await bob.client.callTool({
      name: "team_send_message",
      arguments: {
        recipients: ["alice"],
        message: "reply",
        reply_to: sentData.message_id,
      },
    });
    assert.equal(reply.isError, undefined);

    const aliceReplies = await alice.client.callTool({
      name: "team_read_messages",
      arguments: { limit: 20 },
    });
    const aliceReplyData = aliceReplies.structuredContent as {
      messages: Array<{
        content: string;
        reply_to: string | null;
      }>;
    };
    assert.deepEqual(aliceReplyData.messages, [
      {
        ...aliceReplyData.messages[0],
        content: "reply",
        reply_to: sentData.message_id,
      },
    ]);

    const spoof = await alice.client.callTool({
      name: "team_send_message",
      arguments: {
        recipients: ["bob"],
        message: "spoof attempt",
        sender: "carol",
      },
    });
    assert.equal(spoof.isError, true);

    const badReply = await alice.client.callTool({
      name: "team_send_message",
      arguments: {
        recipients: ["bob"],
        message: "bad reply",
        reply_to: "msg_missing",
      },
    });
    assert.equal(badReply.isError, true);
  } finally {
    await Promise.all([
      alice.transport.close(),
      bob.transport.close(),
      carol.transport.close(),
    ]);
    await hub.closeSessions();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

test("messages survive reopening a file-backed database", () => {
  const directory = mkdtempSync(join(tmpdir(), "teamhub-test-"));
  const databasePath = join(directory, "teamhub.sqlite");

  try {
    const first = new TeamHubStore(databasePath);
    first.registerPeer("alice");
    first.registerPeer("bob");
    first.sendMessage("alice", ["bob"], "persisted");
    first.close();

    const second = new TeamHubStore(databasePath);
    const messages = second.readMessages("bob", 20);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.content, "persisted");
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
