import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import { createNestedSubagentTools, type NestedAgentManager } from "../src/nested-tools.js";

function makePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => handlers.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, handlers };
}

function context(cwd: string) {
  const model = { provider: "faux", id: "faux-1", name: "Faux" };
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd,
    model,
    modelRegistry: {
      find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
      getAll: () => [model],
      getAvailable: () => [model],
    },
    sessionManager: { getSessionId: vi.fn(() => "session-1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

let cwd: string;
let previousCwd: string;
let previousAgentDir: string | undefined;
let previousHome: string | undefined;
let shutdowns: Array<() => Promise<void>>;

function writeWorktreeAgent(name: string, nested = false, model?: string) {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    `---\ndescription: Worktree agent\ntools: read\nisolation: worktree\n${model ? `model: ${model}\n` : ""}${nested ? "allowed_subagents: all\n" : ""}---\nAgent.\n`,
  );
}

beforeEach(() => {
  previousCwd = process.cwd();
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  previousHome = process.env.HOME;
  cwd = mkdtempSync(join(tmpdir(), "isolation-off-wiring-"));
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
  process.env.HOME = cwd;
  process.chdir(cwd);
  shutdowns = [];
  vi.mocked(runAgent).mockReset();
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "done",
    session: { dispose: vi.fn() } as any,
    aborted: false,
    steered: false,
  });
});

afterEach(async () => {
  for (const shutdown of shutdowns) await shutdown();
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  registerAgents(new Map());
  process.chdir(previousCwd);
  if (previousAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousHome == null) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(cwd, { recursive: true, force: true });
});

describe("explicit Agent isolation opt-out", () => {
  it("lets a top-level tool call override a custom worktree default", async () => {
    writeWorktreeAgent("worktree-agent");
    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    shutdowns.push(async () => handlers.get("session_shutdown")?.({}, context(cwd)));

    await tools.get("Agent").execute(
      "call-1",
      {
        prompt: "Do work",
        description: "override isolation",
        subagent_type: "worktree-agent",
        isolation: "off",
      },
      undefined,
      undefined,
      context(cwd),
    );

    expect(runAgent).toHaveBeenCalledWith(
      expect.anything(),
      "worktree-agent",
      "Do work",
      expect.objectContaining({ cwd: undefined }),
    );
  });

  it("normalizes off before persisting a scheduled Agent call", async () => {
    writeWorktreeAgent("scheduled-worktree");
    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    shutdowns.push(async () => handlers.get("session_shutdown")?.({}, context(cwd)));
    await handlers.get("session_start")({}, context(cwd));

    await tools.get("Agent").execute(
      "call-scheduled",
      {
        prompt: "Do work later",
        description: "schedule without isolation",
        subagent_type: "scheduled-worktree",
        isolation: "off",
        schedule: "+1h",
      },
      undefined,
      undefined,
      context(cwd),
    );

    const storeDir = join(cwd, ".pi", "subagent-schedules");
    const jobs = readdirSync(storeDir).flatMap((file) =>
      JSON.parse(readFileSync(join(storeDir, file), "utf-8")).jobs ?? [],
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).not.toHaveProperty("isolation");
  });

  it("persists a frontmatter-only model for a scheduled call", async () => {
    writeWorktreeAgent("scheduled-model", false, "faux/faux-1");
    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    shutdowns.push(async () => handlers.get("session_shutdown")?.({}, context(cwd)));
    await handlers.get("session_start")({}, context(cwd));

    await tools.get("Agent").execute(
      "call-scheduled-model",
      {
        prompt: "Do model work later",
        description: "schedule frontmatter model",
        subagent_type: "scheduled-model",
        schedule: "+1h",
      },
      undefined,
      undefined,
      context(cwd),
    );

    const storeDir = join(cwd, ".pi", "subagent-schedules");
    const jobs = readdirSync(storeDir).flatMap((file) =>
      JSON.parse(readFileSync(join(storeDir, file), "utf-8")).jobs ?? [],
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].model).toBe("faux/faux-1");
  });

  it("lets a nested tool call override a custom worktree default", async () => {
    writeWorktreeAgent("nested-worktree");
    const spawnAndWait = vi.fn(async (_pi, _ctx, type, _prompt, options) => ({
      id: "child-1",
      record: { id: "child-1", type, status: "completed", result: "done", parentAgentId: options.parentAgentId },
    }));
    const manager = {
      spawn: vi.fn(),
      spawnAndWait,
      getRecord: vi.fn(() => undefined),
      resume: vi.fn(),
    } as unknown as NestedAgentManager;
    const [agent] = createNestedSubagentTools({
      manager,
      pi: {} as any,
      parentAgentId: "parent-1",
      depth: 1,
      maxSubagentDepth: 2,
      allowedSubagents: "all",
      configCwd: cwd,
    });

    await agent.execute(
      "call-2",
      {
        prompt: "Do nested work",
        description: "override nested isolation",
        subagent_type: "nested-worktree",
        isolation: "off",
      },
      undefined,
      undefined,
      context(cwd),
    );

    expect(spawnAndWait).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "nested-worktree",
      "Do nested work",
      expect.objectContaining({ isolation: undefined }),
      expect.any(Function),
    );
  });
});
