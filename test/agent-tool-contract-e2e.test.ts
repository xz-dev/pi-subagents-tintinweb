import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentCall, type PrintModeRun, routeBySession, runPrintMode } from "./helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 30_000 });

type AgentToolResult = {
  isError?: boolean;
  content: Array<{ type?: string; text?: string }>;
};

function latestAgentToolResult(session: AgentSession): AgentToolResult {
  const message = [...session.messages].reverse().find(
    entry => entry.role === "toolResult" && (entry as { toolName?: string }).toolName === "Agent",
  );
  if (!message) throw new Error("parent session has no Agent tool result");
  return message as AgentToolResult;
}

function textOf(result: AgentToolResult): string {
  return result.content.map(block => block.text ?? "").join("");
}

describe("Agent contract through the real Pi tool boundary", () => {
  let run: PrintModeRun | undefined;

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
  });

  it("maps an invocation rejection to isError=true without spawning", async () => {
    run = await runPrintMode({
      prompt: "Delegate.",
      respond: routeBySession({
        parentInitial: agentCall({
          description: "invalid model",
          prompt: "Do work.",
          model: "missing/model",
        }),
        parentFinal: "parent done",
        subagent: "unused",
      }),
    });

    const result = latestAgentToolResult(run.parentSession);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Model not found");
    expect(run.subagents).toHaveLength(0);
  });

  it("rejects unknown input properties before Agent execution", async () => {
    run = await runPrintMode({
      prompt: "Delegate.",
      respond: routeBySession({
        parentInitial: agentCall({
          description: "strict schema",
          prompt: "Do work.",
          unexpected_capability: true,
        }),
        parentFinal: "parent done",
        subagent: "unused",
      }),
    });

    const result = latestAgentToolResult(run.parentSession);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/unexpected_capability|additional|properties/i);
    expect(run.subagents).toHaveLength(0);
  });
});
