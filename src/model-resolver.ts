/**
 * Model resolution: strict provider-qualified lookup with unique fuzzy matching.
 */

export interface ModelEntry {
  id: string;
  name: string;
  provider: string;
}

export interface ModelRegistry {
  find(provider: string, modelId: string): any;
  getAll(): any[];
  getAvailable?(): any[];
}

const normalize = (value: string) => value.toLowerCase().replace(/\./g, "-");

function scoreModel(input: string, model: ModelEntry, includeProvider: boolean): number {
  const query = normalize(input);
  const id = normalize(model.id);
  const name = normalize(model.name);
  const full = normalize(`${model.provider}/${model.id}`);

  if (id === query || (includeProvider && full === query)) return 100;
  if (id.includes(query) || (includeProvider && full.includes(query))) {
    return 60 + (query.length / id.length) * 30;
  }
  if (name.includes(query)) return 40 + (query.length / name.length) * 20;

  const parts = query.split(/[\s/_-]+/).filter(Boolean);
  if (parts.length > 1 && parts.every(part => id.includes(part) || name.includes(part) || (includeProvider && full.includes(part)))) {
    return 30 + parts.length;
  }

  const dateSuffix = /[-.]?\d{8}$/;
  if (dateSuffix.test(id) || dateSuffix.test(query)) {
    const idBase = id.replace(dateSuffix, "");
    const queryBase = query.replace(dateSuffix, "");
    if (idBase === queryBase) return 95;
    if (idBase.includes(queryBase) || queryBase.includes(idBase)) {
      return 55 + (Math.min(idBase.length, queryBase.length) / Math.max(idBase.length, queryBase.length)) * 30;
    }
  }

  return 0;
}

/**
 * Resolve a model string to an available Model instance.
 *
 * Provider-qualified inputs stay inside that provider. Bare/fuzzy inputs are
 * accepted only when the best match is unique across providers.
 */
export function resolveModel(input: string, registry: ModelRegistry): any | string {
  const available = (registry.getAvailable?.() ?? registry.getAll()) as ModelEntry[];
  if (!input.trim()) {
    const list = available.map(model => `  ${model.provider}/${model.id}`).join("\n");
    return `Model not found: "${input}".\n\nAvailable models:\n${list}`;
  }
  const slashIdx = input.indexOf("/");
  const provider = slashIdx === -1 ? undefined : input.slice(0, slashIdx);
  const query = slashIdx === -1 ? input : input.slice(slashIdx + 1);
  const candidates = provider
    ? available.filter(model => model.provider.toLowerCase() === provider.toLowerCase())
    : available;

  if (provider) {
    const exact = candidates.find(model => normalize(model.id) === normalize(query));
    if (exact) return registry.find(exact.provider, exact.id) ?? exact;
  }

  let bestScore = 0;
  let bestMatches: ModelEntry[] = [];
  for (const model of candidates) {
    const score = scoreModel(query, model, provider === undefined);
    if (score > bestScore) {
      bestScore = score;
      bestMatches = [model];
    } else if (score > 0 && score === bestScore) {
      bestMatches.push(model);
    }
  }

  const providers = new Set(bestMatches.map(model => model.provider.toLowerCase()));
  if (bestMatches.length > 1 && providers.size > 1) {
    const matches = bestMatches.map(model => `${model.provider}/${model.id}`).sort().join(", ");
    return `Model "${input}" is ambiguous: ${matches}. Use an explicit provider/model.`;
  }
  if (bestMatches.length > 0) {
    const best = bestMatches[0];
    return registry.find(best.provider, best.id) ?? best;
  }

  const list = available.map(model => `  ${model.provider}/${model.id}`).join("\n");
  return `Model not found: "${input}".\n\nAvailable models:\n${list}`;
}
