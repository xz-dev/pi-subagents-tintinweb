import type { Model } from "@earendil-works/pi-ai";
import { type ModelRegistry, resolveModel } from "./model-resolver.js";
import type { ModelAttempt, ModelCandidate } from "./types.js";

export type { ModelAttempt } from "./types.js";

export interface ResolvedModelCandidates {
  candidates: ModelCandidate[];
  models: Model<any>[];
}

function modelKey(model: Model<any>): string {
  return `${model.provider}/${model.id}`.toLowerCase();
}

export function resolveModelCandidates(args: {
  primary?: Model<any>;
  primaryInput?: string;
  callerSupplied?: boolean;
  fallbackModels?: string[] | false;
  defaultFallbackModels?: string[];
  registry: ModelRegistry;
}): ResolvedModelCandidates {
  const candidates: ModelCandidate[] = [];
  const seenModels = new Set<string>();
  const seenUnavailable = new Set<string>();
  const addModel = (input: string, model: Model<any>) => {
    const key = modelKey(model);
    if (seenModels.has(key)) return;
    seenModels.add(key);
    candidates.push({ input, model });
  };
  const addInput = (input: string) => {
    const resolved = resolveModel(input, args.registry);
    if (typeof resolved === "string") {
      const key = input.toLowerCase();
      if (seenUnavailable.has(key)) return;
      seenUnavailable.add(key);
      candidates.push({ input, error: resolved.split("\n", 1)[0] });
      return;
    }
    addModel(input, resolved as Model<any>);
  };

  if (args.primary) addModel(`${args.primary.provider}/${args.primary.id}`, args.primary);
  else if (args.primaryInput) addInput(args.primaryInput);

  if (!args.callerSupplied) {
    const fallbackInputs = args.fallbackModels === false
      ? []
      : args.fallbackModels ?? args.defaultFallbackModels ?? [];
    for (const input of fallbackInputs) addInput(input);
  }

  return {
    candidates,
    models: candidates.flatMap(candidate => candidate.model ? [candidate.model] : []),
  };
}

export function resolveResumeModelCandidates(
  current: Model<any>,
  configuredInputs: string[],
  registry: ModelRegistry,
): ResolvedModelCandidates {
  return resolveModelCandidates({
    primary: current,
    fallbackModels: configuredInputs,
    registry,
  });
}

export function formatModelAttempts(attempts: ModelAttempt[]): string {
  const lines = attempts.map((attempt, index) => {
    const detail = attempt.error?.trim() || attempt.status;
    return `  ${index + 1}. ${attempt.model} — ${detail}`;
  });
  return ["Model attempts:", ...lines, "All model candidates failed."].join("\n");
}
