import { describe, expect, it, vi } from "vitest";
import { resolveAgentInvocationConfig } from "../src/invocation-config.js";
import { resolveModelCandidates } from "../src/model-fallback.js";
import type { AgentConfig } from "../src/types.js";

const models = [
  { provider: "anthropic", id: "primary", name: "Primary" },
  { provider: "openai", id: "backup", name: "Backup" },
];

const registry = {
  find: vi.fn((provider: string, id: string) => models.find(model => model.provider === provider && model.id === id)),
  getAll: vi.fn(() => models),
  getAvailable: vi.fn(() => models),
};

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "worker",
    description: "worker",
    extensions: false,
    skills: false,
    systemPrompt: "work",
    promptMode: "replace",
    ...overrides,
  };
}

describe("model fallback invocation wiring", () => {
  it("a frontmatter model uses per-agent fallbacks", () => {
    const invocation = resolveAgentInvocationConfig(config({
      model: "anthropic/primary",
      fallbackModels: ["openai/backup"],
    }), {});
    const resolved = resolveModelCandidates({
      primaryInput: invocation.modelInput,
      callerSupplied: invocation.modelFromParams,
      fallbackModels: invocation.fallbackModels,
      defaultFallbackModels: ["openai/backup"],
      registry,
    });

    expect(resolved.models).toEqual(models);
  });

  it("an explicit caller model overrides frontmatter and suppresses all fallbacks", () => {
    const invocation = resolveAgentInvocationConfig(config({
      model: "openai/backup",
      fallbackModels: ["openai/backup"],
    }), { model: "  anthropic/primary  " });
    expect(invocation).toMatchObject({
      modelInput: "anthropic/primary",
      modelFromParams: true,
    });
    const resolved = resolveModelCandidates({
      primaryInput: invocation.modelInput,
      callerSupplied: invocation.modelFromParams,
      defaultFallbackModels: ["openai/backup"],
      registry,
    });

    expect(resolved.models).toEqual([models[0]]);
    expect(resolved.candidates).toEqual([{ input: "anthropic/primary", model: models[0] }]);
  });

  it("a blank caller model remains omitted and preserves the configured chain", () => {
    const invocation = resolveAgentInvocationConfig(config({
      model: "anthropic/primary",
      fallbackModels: ["openai/backup"],
    }), { model: "  " });
    const resolved = resolveModelCandidates({
      primaryInput: invocation.modelInput,
      callerSupplied: invocation.modelFromParams,
      fallbackModels: invocation.fallbackModels,
      defaultFallbackModels: ["openai/backup"],
      registry,
    });

    expect(invocation.modelFromParams).toBe(false);
    expect(resolved.models).toEqual(models);
  });
});
