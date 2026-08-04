import { describe, expect, it } from "vitest";
import {
  formatModelAttempts,
  type ModelAttempt,
  resolveModelCandidates,
  resolveResumeModelCandidates,
} from "../src/model-fallback.js";
import type { ModelRegistry } from "../src/model-resolver.js";

const MODELS = [
  { id: "primary", name: "Primary", provider: "anthropic" },
  { id: "backup", name: "Backup", provider: "openai" },
  { id: "last", name: "Last", provider: "google" },
];

function registry(available = MODELS): ModelRegistry {
  return {
    find(provider: string, modelId: string) {
      return MODELS.find(model => model.provider === provider && model.id === modelId);
    },
    getAll() {
      return MODELS;
    },
    getAvailable() {
      return available;
    },
  };
}

describe("resolveModelCandidates", () => {
  it("uses the per-agent list instead of defaults and deduplicates resolved models", () => {
    const result = resolveModelCandidates({
      primary: MODELS[0],
      fallbackModels: ["openai/backup", "openai/backup", "google/last"],
      defaultFallbackModels: ["google/last"],
      registry: registry(),
    });

    expect(result.models).toEqual(MODELS);
    expect(result.candidates.map(candidate => candidate.input)).toEqual([
      "anthropic/primary", "openai/backup", "google/last",
    ]);
  });

  it("inherits defaults when the agent omits fallback_models", () => {
    const result = resolveModelCandidates({
      primary: MODELS[0],
      defaultFallbackModels: ["openai/backup"],
      registry: registry(),
    });

    expect(result.models).toEqual([MODELS[0], MODELS[1]]);
  });

  it("uses only the primary when fallback_models is false", () => {
    const result = resolveModelCandidates({
      primary: MODELS[0],
      fallbackModels: false,
      defaultFallbackModels: ["openai/backup"],
      registry: registry(),
    });

    expect(result.models).toEqual([MODELS[0]]);
  });

  it("records unavailable candidates and never silently inherits another model", () => {
    const result = resolveModelCandidates({
      primaryInput: "anthropic/missing",
      fallbackModels: ["openai/backup", "google/missing"],
      registry: registry(),
    });

    expect(result.models).toEqual([MODELS[1]]);
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[0]).toMatchObject({ input: "anthropic/missing", error: expect.any(String) });
    expect(result.candidates[2]).toMatchObject({ input: "google/missing", error: expect.any(String) });
  });

  it("disables the entire fallback chain for an explicit caller model", () => {
    const result = resolveModelCandidates({
      primary: MODELS[0],
      callerSupplied: true,
      fallbackModels: ["openai/backup"],
      defaultFallbackModels: ["google/last"],
      registry: registry(),
    });

    expect(result.models).toEqual([MODELS[0]]);
  });
});

describe("resolveResumeModelCandidates", () => {
  it("tries the current model, then original primary, then remaining fallbacks", () => {
    const result = resolveResumeModelCandidates(
      MODELS[1],
      ["anthropic/primary", "openai/backup", "google/last"],
      registry(),
    );
    expect(result.models).toEqual([MODELS[1], MODELS[0], MODELS[2]]);
  });
});

describe("formatModelAttempts", () => {
  it("formats bounded fail-closed diagnostics", () => {
    const attempts: ModelAttempt[] = [
      { model: "anthropic/primary", status: "failed", error: "quota exhausted" },
      { model: "openai/backup", status: "unavailable", error: "not configured" },
    ];

    expect(formatModelAttempts(attempts)).toBe(
      "Model attempts:\n" +
      "  1. anthropic/primary — quota exhausted\n" +
      "  2. openai/backup — not configured\n" +
      "All model candidates failed.",
    );
  });
});
