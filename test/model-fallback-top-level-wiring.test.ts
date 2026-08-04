import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";

const explicit = { provider: "test", id: "explicit", name: "Explicit" };
const backup = { provider: "test", id: "backup", name: "Backup" };
const models = [explicit, backup];

function makePi() {
  const tools = new Map<string, any>();
  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
      registerCommand: vi.fn(),
      on: vi.fn(),
      events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
    } as any,
    tools,
  };
}

function context(cwd: string) {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd,
    model: backup,
    modelRegistry: {
      find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
      getAll: () => models,
      getAvailable: () => models,
    },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

function writeAgent(cwd: string) {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "worker.md"), [
    "---",
    "description: worker",
    "model: test/backup",
    "fallback_models:",
    "  - test/backup",
    "---",
    "work",
  ].join("\n"));
}

describe("top-level fallback model provenance wiring", () => {
  let cwd: string;
  let originalCwd: string;
  let originalAgentDir: string | undefined;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), "fallback-top-level-"));
    writeAgent(cwd);
    process.chdir(cwd);
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    originalHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
    process.env.HOME = cwd;
    vi.mocked(runAgent).mockReset();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });
  });

  afterEach(() => {
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    process.chdir(originalCwd);
    if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    registerAgents(new Map());
    rmSync(cwd, { recursive: true, force: true });
  });

  it.each([
    ["foreground", false],
    ["background", true],
  ])("passes the explicit one-model chain to a %s run", async (_mode, runInBackground) => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    await tools.get("Agent").execute(
      "tc-model",
      {
        prompt: "work",
        description: "explicit model",
        subagent_type: "worker",
        model: "  test/explicit  ",
        run_in_background: runInBackground,
      },
      undefined,
      undefined,
      context(cwd),
    );

    expect(runAgent).toHaveBeenCalledWith(
      expect.anything(),
      "worker",
      "work",
      expect.objectContaining({
        model: explicit,
        modelCandidates: [{ input: "test/explicit", model: explicit }],
        callerSuppliedModel: true,
      }),
    );
  });
});
