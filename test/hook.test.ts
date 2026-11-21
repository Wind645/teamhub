import assert from "node:assert/strict";
import type { Server } from "node:http";
import test from "node:test";
import { createTeamHubApp } from "../src/app.js";
import {
  gitPushTargetBranch,
  patchPaths,
  runHook,
} from "../src/hook.js";
import { TeamHubStore } from "../src/store.js";

async function listen(app: ReturnType<typeof createTeamHubApp>["app"]) {
  return await new Promise<Server>((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

test("extracts patch paths and Git push targets", () => {
  assert.deepEqual(
    patchPaths(
      {
        input: [
          "*** Begin Patch",
          "*** Update File: src/parser/error.rs",
          "*** Add File: tests/parser/error.rs",
          "*** End Patch",
        ].join("\n"),
      },
      "/tmp/project",
    ),
    ["src/parser/error.rs", "tests/parser/error.rs"],
  );
  assert.equal(
    gitPushTargetBranch("git push -u origin alice/parser", "working"),
    "alice/parser",
  );
  assert.equal(
    gitPushTargetBranch("git push origin HEAD:main", "working"),
    "main",
  );
  assert.equal(gitPushTargetBranch("git status", "working"), undefined);
});

test("hook publishes raw intent, enforces summary, and detects path conflicts", async () => {
  const store = new TeamHubStore(":memory:");
  const hub = createTeamHubApp(store);
  const server = await listen(hub.app);
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/mcp`;
  const previousUrl = process.env.TEAMHUB_MCP_URL;

  try {
    process.env.TEAMHUB_MCP_URL = `${baseUrl}/alice`;
    const promptResult = (await runHook(
      {
        hook_event_name: "UserPromptSubmit",
        turn_id: "turn-hook-1",
        cwd: "/tmp",
        prompt: "Fix parser error handling",
      },
      "alice",
    )) as {
      hookSpecificOutput: {
        hookEventName: string;
        additionalContext: string;
      };
    };
    assert.equal(
      promptResult.hookSpecificOutput.hookEventName,
      "UserPromptSubmit",
    );
    assert.match(
      promptResult.hookSpecificOutput.additionalContext,
      /turn-hook-1/,
    );
    assert.match(
      promptResult.hookSpecificOutput.additionalContext,
      /Fix parser error handling/,
    );

    const beforeSummary = (await runHook(
      {
        hook_event_name: "PreToolUse",
        turn_id: "turn-hook-1",
        cwd: "/tmp",
        tool_name: "apply_patch",
        tool_input: {
          input:
            "*** Begin Patch\n*** Update File: src/parser/error.rs\n*** End Patch",
        },
      },
      "alice",
    )) as { decision?: string; reason?: string };
    assert.equal(beforeSummary.decision, "block");
    assert.match(beforeSummary.reason ?? "", /team_update_state/);

    store.updateState("alice", {
      turnId: "turn-hook-1",
      intentSummary: "Fix parser error handling",
      plannedPaths: ["src/parser/error.rs"],
      status: "working",
    });

    const allowed = await runHook(
      {
        hook_event_name: "PreToolUse",
        turn_id: "turn-hook-1",
        cwd: "/tmp",
        tool_name: "apply_patch",
        tool_input: {
          input:
            "*** Begin Patch\n*** Update File: src/parser/error.rs\n*** End Patch",
        },
      },
      "alice",
    );
    assert.deepEqual(allowed, {});

    store.beginTurn("bob", {
      turnId: "turn-bob-1",
      rawIntent: "Update parser errors",
      cwd: "/tmp",
      branch: "bob/parser",
      ttlSeconds: 1_800,
    });
    store.updateState("bob", {
      turnId: "turn-bob-1",
      intentSummary: "Update parser errors",
      plannedPaths: ["src/parser/error.rs"],
      status: "working",
    });

    const conflict = (await runHook(
      {
        hook_event_name: "PreToolUse",
        turn_id: "turn-hook-1",
        cwd: "/tmp",
        tool_name: "apply_patch",
        tool_input: {
          input:
            "*** Begin Patch\n*** Update File: src/parser/error.rs\n*** End Patch",
        },
      },
      "alice",
    )) as { decision?: string; reason?: string };
    assert.equal(conflict.decision, "block");
    assert.match(conflict.reason ?? "", /bob/);
  } finally {
    if (previousUrl === undefined) {
      delete process.env.TEAMHUB_MCP_URL;
    } else {
      process.env.TEAMHUB_MCP_URL = previousUrl;
    }
    await hub.closeSessions();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
