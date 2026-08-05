/**
 * Cross-extension RPC handlers for the subagents extension.
 *
 * Exposes ping, spawn, and stop RPCs over the pi.events event bus,
 * using per-request scoped reply channels.
 *
 * Reply envelope follows pi-mono convention:
 *   success → { success: true, data?: T }
 *   error   → { success: false, error: string }
 */

import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { type ModelRegistry, resolveModel } from "./model-resolver.js";
import type { IsolationMode } from "./types.js";

/** Minimal event bus interface needed by the RPC handlers. */
export interface EventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}

/** RPC reply envelope — matches pi-mono's RpcResponse shape. */
export type RpcReply<T = void> =
  | { success: true; data?: T }
  | { success: false; error: string };

/** RPC protocol version — bumped when the envelope or method contracts change. */
export const PROTOCOL_VERSION = 3;

/** Minimal AgentManager interface needed by the spawn/stop RPCs. */
export interface SpawnCapable {
  spawn(pi: unknown, ctx: unknown, type: string, prompt: string, options: any): string;
  abort(id: string): boolean;
}

export interface RpcDeps {
  events: EventBus;
  pi: unknown;                    // passed through to manager.spawn
  getCtx: () => unknown | undefined;  // returns current ExtensionContext
  manager: SpawnCapable;
}

export interface RpcHandle {
  unsubPing: () => void;
  unsubSpawn: () => void;
  unsubStop: () => void;
}

interface PublicSpawnOptions {
  description?: string;
  model?: string | Model<any>;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ModelThinkingLevel;
  isBackground?: boolean;
  isolation?: IsolationMode;
  cwd?: string | null;
}

const THINKING_LEVELS = new Set<ModelThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const PUBLIC_SPAWN_OPTION_KEYS = new Set<keyof PublicSpawnOptions>([
  "description",
  "model",
  "maxTurns",
  "isolated",
  "inheritContext",
  "thinkingLevel",
  "isBackground",
  "isolation",
  "cwd",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function validateSpawnOptions(value: unknown): PublicSpawnOptions {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("options must be an object");
  for (const key of Object.keys(value)) {
    if (!PUBLIC_SPAWN_OPTION_KEYS.has(key as keyof PublicSpawnOptions)) {
      throw new Error(`Unsupported spawn option: "${key}"`);
    }
  }
  const options = value as Record<string, unknown>;
  if (options.description !== undefined) requireNonEmptyString(options.description, "options.description");
  if (options.maxTurns !== undefined &&
      (typeof options.maxTurns !== "number" || !Number.isInteger(options.maxTurns) || options.maxTurns < 1)) {
    throw new Error("options.maxTurns must be an integer greater than or equal to 1");
  }
  for (const key of ["isolated", "inheritContext", "isBackground"] as const) {
    if (options[key] !== undefined && typeof options[key] !== "boolean") {
      throw new Error(`options.${key} must be a boolean`);
    }
  }
  if (
    options.thinkingLevel !== undefined &&
    (typeof options.thinkingLevel !== "string" || !THINKING_LEVELS.has(options.thinkingLevel as ModelThinkingLevel))
  ) {
    throw new Error(`options.thinkingLevel must be one of: ${[...THINKING_LEVELS].join(", ")}`);
  }
  if (options.isolation !== undefined && options.isolation !== "worktree") {
    throw new Error('options.isolation must be "worktree"');
  }
  if (options.cwd !== undefined && options.cwd !== null && typeof options.cwd !== "string") {
    throw new Error("options.cwd must be a string or null");
  }
  if (options.model !== undefined && typeof options.model !== "string" && !isRecord(options.model)) {
    throw new Error("options.model must be a provider/model string or Model object");
  }
  return { ...options } as PublicSpawnOptions;
}

/**
 * Wire a single RPC handler: listen on `channel`, run `fn(params)`,
 * emit the reply envelope on `channel:reply:${requestId}`.
 */
function handleRpc<P extends { requestId: string }>(
  events: EventBus,
  channel: string,
  fn: (params: P) => unknown | Promise<unknown>,
): () => void {
  return events.on(channel, async (raw: unknown) => {
    if (!isRecord(raw) || typeof raw.requestId !== "string" || raw.requestId.trim() === "") return;
    const requestId = raw.requestId;
    try {
      const data = await fn(raw as unknown as P);
      const reply: { success: true; data?: unknown } = { success: true };
      if (data !== undefined) reply.data = data;
      events.emit(`${channel}:reply:${requestId}`, reply);
    } catch (err) {
      events.emit(`${channel}:reply:${requestId}`, {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/**
 * Register ping, spawn, and stop RPC handlers on the event bus.
 * Returns unsub functions for cleanup.
 */
export function registerRpcHandlers(deps: RpcDeps): RpcHandle {
  const { events, pi, getCtx, manager } = deps;

  const unsubPing = handleRpc(events, "subagents:rpc:ping", () => {
    return { version: PROTOCOL_VERSION };
  });

  const unsubSpawn = handleRpc<{
    requestId: string;
    type: string;
    prompt: string;
    options?: PublicSpawnOptions;
  }>(
    events, "subagents:rpc:spawn", ({ type, prompt, options }) => {
      requireNonEmptyString(type, "type");
      requireNonEmptyString(prompt, "prompt");
      const ctx = getCtx();
      if (!ctx) throw new Error("No active session");

      // Cross-extension RPC callers (e.g. pi-tasks TaskExecute) naturally
      // forward serializable values, so options.model can be a string like
      // "openai-codex/gpt-5.5". Resolve it to a real Model instance here
      // — same pattern the scheduler path already uses — so the spawned
      // agent's auth lookup doesn't crash with "No API key found for
      // undefined".
      let normalizedOptions = validateSpawnOptions(options);
      if (typeof normalizedOptions.model === "string") {
        const registry = (ctx as { modelRegistry?: ModelRegistry }).modelRegistry;
        if (!registry) {
          throw new Error(
            `Model override "${normalizedOptions.model}" provided but ctx.modelRegistry is unavailable`,
          );
        }
        const resolved = resolveModel(normalizedOptions.model, registry);
        if (typeof resolved === "string") {
          // resolveModel returns a human-readable error string when the
          // input doesn't match any available model. Surface it instead of
          // silently falling back so the caller sees the auth/typo issue.
          throw new Error(resolved);
        }
        normalizedOptions = { ...normalizedOptions, model: resolved };
      }

      return { id: manager.spawn(pi, ctx, type, prompt, normalizedOptions) };
    },
  );

  const unsubStop = handleRpc<{ requestId: string; agentId: string }>(
    events, "subagents:rpc:stop", ({ agentId }) => {
      requireNonEmptyString(agentId, "agentId");
      if (!manager.abort(agentId)) throw new Error("Agent not found");
    },
  );

  return { unsubPing, unsubSpawn, unsubStop };
}
