// Pre-dispatch probe, launch-failure classification, re-auth recovery and
// worker health staging. Pure functions only: nothing here launches a process
// or reads a credential.
//
// Four facts stay separate (RESOURCE_AWARE_ROUTING.md, "Auth state and exact
// model capability"):
//   provider_resource_state  quota / budget / burst availability
//   orca_integration_state   whether Orca can launch / use the provider
//   provider_auth_state      whether the provider CLI session is usable
//   exact_model_capability   whether THIS model id / alias can launch
// A bad model id or an expired login never downgrades provider quota, and a
// bad model id never downgrades the provider: another verified alias on the
// same provider stays dispatchable.

import { isNonEmptyString, isPlainObject } from "./resource-routing.mjs";

export const PROVIDER_AUTH_STATES = ["AUTH_OK", "AUTH_REQUIRED", "AUTH_EXPIRED", "AUTH_INVALID", "AUTH_UNKNOWN"];
export const MODEL_CAPABILITY_STATES = ["VERIFIED", "UNVERIFIED", "MODEL_UNKNOWN", "MODEL_UNAVAILABLE"];
export const LAUNCH_FAILURE_CLASSES = [
  "RESOURCE_EXHAUSTED",
  "INTEGRATION_UNAVAILABLE",
  "AUTH_REQUIRED",
  "AUTH_EXPIRED",
  "AUTH_INVALID",
  "MODEL_UNKNOWN",
  "MODEL_UNAVAILABLE",
  "EFFORT_UNSUPPORTED",
];
export const WORKER_HEALTH_STAGES = ["TERMINAL_STARTED", "MODEL_LAUNCHED", "WORKER_ACTIVE"];

// Reviewed status / interactive login commands, verified against local
// `--help` (references/OFFICIAL_COMMANDS.md). The login action is handed to
// the human verbatim; the router never runs it and never handles a token.
// null = no reviewed command exists for that provider.
export const REVIEWED_AUTH_COMMANDS = Object.freeze({
  claude: Object.freeze({ status: "claude auth status --json", login: "claude auth login" }),
  codex: Object.freeze({ status: "codex login status", login: "codex login" }),
  antigravity: Object.freeze({ status: null, login: null }),
});

// Registry resolver key per provider that carries a CLI alias catalog.
const CATALOG_RESOLVERS = Object.freeze({ claude: "claude_models" });

const MODEL_FAILURE_STATES = new Set(["MODEL_UNKNOWN", "MODEL_UNAVAILABLE"]);
const AUTH_FAILURE_STATES = new Set(["AUTH_REQUIRED", "AUTH_EXPIRED", "AUTH_INVALID"]);

export function modelLabel(provider, model) {
  return `${provider ?? "unknown"}/${model ?? "unknown"}`;
}

function catalogFor(registry, provider) {
  const key = CATALOG_RESOLVERS[provider];
  if (key === undefined) return null;
  const resolver = registry?.resolvers?.[key];
  return isPlainObject(resolver) ? resolver : null;
}

/**
 * Maps a registry `model:` value to the exact CLI `--model` argument. Only
 * catalog aliases and reviewed `model_overrides` resolve; anything else
 * (including a versioned id derived from a display name, e.g. `sonnet-5`) is
 * MODEL_UNKNOWN and must not be dispatched. Providers without a catalog
 * resolver pass through unchanged.
 */
export function resolveCliModelArgument(registry, provider, model) {
  if (!isNonEmptyString(model)) {
    return { status: "MODEL_UNKNOWN", provider, model: model ?? null, cli_model: null, why: "no model value" };
  }
  const catalog = catalogFor(registry, provider);
  if (catalog === null) {
    return { status: "RESOLVED", provider, model, cli_model: model, source: "PASS_THROUGH" };
  }
  const alias = catalog.catalog_aliases?.[model];
  if (isPlainObject(alias) && isNonEmptyString(alias.cli_model)) {
    return { status: "RESOLVED", provider, model, cli_model: alias.cli_model, source: "CATALOG_ALIAS" };
  }
  const override = catalog.model_overrides?.[model];
  if (isPlainObject(override) && isNonEmptyString(override.cli_model)) {
    return { status: "RESOLVED", provider, model, cli_model: override.cli_model, source: "REVIEWED_OVERRIDE" };
  }
  return {
    status: "MODEL_UNKNOWN",
    provider,
    model,
    cli_model: null,
    why: `${modelLabel(provider, model)} is neither a catalog alias nor a reviewed model_override; do not derive model ids from display names`,
  };
}

/* ------------------------------------------------------------------------ *
 * Runtime adapters
 *
 * A dispatch target is runtime_adapter + provider_family + exact model +
 * effort. The registry `provider:` field names the runtime path; the adapter
 * table (MODEL_REGISTRY.yaml `runtime_adapters`) maps it to an adapter.
 * ------------------------------------------------------------------------ */

export const RUNTIME_ADAPTERS = ["codex_cli", "claude_cli", "antigravity"];
const EFFORT_SUFFIX = /^(.*)-(low|medium|high)$/;
const DISPLAY_EFFORT = /^(.*?)\s*\((low|medium|high)\)$/i;

/** Provider family from a model_family value or a concrete model id. */
export function providerFamilyOf(value) {
  if (!isNonEmptyString(value)) return null;
  const v = value.toLowerCase();
  if (v.startsWith("claude")) return "claude";
  if (v.startsWith("gemini") || v === "auto_gemini") return "gemini";
  if (v.startsWith("gpt-oss")) return "gpt-oss";
  if (v.startsWith("gpt-")) return "openai";
  return null;
}

function adapterTable(registry) {
  return isPlainObject(registry?.runtime_adapters) ? registry.runtime_adapters : {};
}

/** Adapter for a runtime_adapter name or a registry `provider:` value. */
export function runtimeAdapterFor(registry, nameOrProvider) {
  const table = adapterTable(registry);
  if (isPlainObject(table[nameOrProvider])) return { name: nameOrProvider, adapter: table[nameOrProvider] };
  for (const [name, adapter] of Object.entries(table)) {
    if (adapter?.registry_provider === nameOrProvider) return { name, adapter };
  }
  return null;
}

/** Every runtime path that can serve a provider family. */
export function runtimePathsForFamily(registry, family) {
  return Object.entries(adapterTable(registry))
    .filter(([, a]) => Array.isArray(a?.provider_families) && a.provider_families.includes(family))
    .map(([name, a]) => ({ runtime_adapter: name, registry_provider: a.registry_provider }));
}

/** Parses `agy models` output: one `<id>\t<display>` per line. */
export function parseAntigravityModels(output) {
  if (Array.isArray(output)) return output;
  if (!isNonEmptyString(output)) return [];
  return output
    .split(/\r?\n/)
    .map((line) => line.split("\t"))
    .filter((parts) => parts.length >= 2 && /^[a-z0-9][a-z0-9.-]*$/.test(parts[0].trim()))
    .map(([id, display]) => {
      const idMatch = id.trim().match(EFFORT_SUFFIX);
      const dispMatch = display.trim().match(DISPLAY_EFFORT);
      return {
        id: id.trim(),
        display: display.trim(),
        base_id: idMatch ? idMatch[1] : id.trim(),
        base_display: dispMatch ? dispMatch[1] : display.trim(),
        effort: idMatch ? idMatch[2] : null,
      };
    });
}

/**
 * Resolves an Antigravity model against the live catalog. `model` may be an
 * exact id, an exact display name, a display name without the effort suffix
 * ("Gemini 3.8 Flash"), or AUTO_GEMINI (newest Gemini Flash generation for the
 * requested effort; the catalog lists newest first).
 *
 * `unsuffixedEffort` is the registry's `unsuffixed_model_effort` for entries
 * without effort variants: "none" (agy rejects `--effort` for the model - live
 * probe 2026-09-18, agy 1.2.6, claude-sonnet-4-6) or "session_flag".
 */
export function resolveAntigravityModel(catalogInput, { model, effort, efforts = ["low", "medium", "high"], unsuffixedEffort = "none" } = {}) {
  const catalog = parseAntigravityModels(catalogInput);
  const unknown = (why) => ({ status: "MODEL_UNKNOWN", cli_model: null, why });
  if (!isNonEmptyString(model)) return unknown("no model value");
  const noEffort = !isNonEmptyString(effort) || effort === "provider_default";
  if (!noEffort && !efforts.includes(effort)) {
    return { status: "EFFORT_UNSUPPORTED", cli_model: null, supported_efforts: efforts, why: `effort ${JSON.stringify(effort)} is not one of ${efforts.join("|")}` };
  }

  let group;
  if (model === "AUTO_GEMINI") {
    if (noEffort) return { status: "EFFORT_UNSUPPORTED", cli_model: null, supported_efforts: efforts, why: "AUTO_GEMINI needs an explicit effort" };
    group = catalog.filter((e) => /^gemini-[\d.]+-flash$/.test(e.base_id));
    const pick = group.find((e) => e.effort === effort);
    if (pick !== undefined) return resolvedAgy(pick, effort, "ID_SUFFIX", efforts);
    return group.length === 0 ? unknown("no Gemini Flash entry in the live catalog") : effortUnsupported(group, effort);
  }

  const key = model.toLowerCase();
  group = catalog.filter(
    (e) => e.id === model || e.base_id === model || e.display.toLowerCase() === key || e.base_display.toLowerCase() === key,
  );
  if (group.length === 0) return unknown(`antigravity/${model} is not in the live \`agy models\` catalog`);

  const exact = group.find((e) => e.id === model);
  const suffixed = group.filter((e) => e.effort !== null);
  if (suffixed.length > 0) {
    // Effort is encoded in the id: the requested effort must be a listed variant.
    const pick = suffixed.find((e) => e.effort === effort && (exact === undefined || exact.base_id === e.base_id));
    return pick !== undefined ? resolvedAgy(pick, effort, "ID_SUFFIX", efforts) : effortUnsupported(suffixed, effort);
  }
  // Single-id entry (e.g. claude-sonnet-4-6).
  const entry = exact ?? group[0];
  if (unsuffixedEffort === "session_flag") {
    return noEffort
      ? { status: "EFFORT_UNSUPPORTED", cli_model: null, supported_efforts: efforts, why: `${entry.id} needs an explicit effort` }
      : resolvedAgy(entry, effort, "SESSION_FLAG", efforts);
  }
  // "none": the model's effort is fixed by the runtime; `--effort` is refused.
  if (!noEffort) {
    return {
      status: "EFFORT_UNSUPPORTED",
      cli_model: null,
      supported_efforts: ["provider_default"],
      why: `agy does not accept --effort for ${entry.id}; dispatch it with reasoning provider_default`,
    };
  }
  return resolvedAgy(entry, "provider_default", "NONE", ["provider_default"]);
}

function resolvedAgy(entry, effort, mode, efforts) {
  return {
    status: "RESOLVED",
    cli_model: entry.id,
    display: entry.display,
    provider_family: providerFamilyOf(entry.id),
    effort,
    effort_mode: mode,
    supported_efforts: efforts,
  };
}

function effortUnsupported(entries, effort) {
  const supported = [...new Set(entries.map((e) => e.effort).filter(Boolean))];
  return { status: "EFFORT_UNSUPPORTED", cli_model: null, supported_efforts: supported, why: `effort ${effort} is not a listed variant (listed: ${supported.join("|")})` };
}

function launchArgs(adapterName, cliModel, effort) {
  const withEffort = isNonEmptyString(effort) && effort !== "provider_default";
  if (adapterName === "codex_cli") return ["-m", cliModel, ...(withEffort ? ["-c", `model_reasoning_effort="${effort}"`] : [])];
  return ["--model", cliModel, ...(withEffort ? ["--effort", effort] : [])];
}

/**
 * Resolves runtime_adapter + provider_family + exact model + effort for one
 * dispatch. `provider` is the registry `provider:` value (or a bare family
 * name such as `gemini`, which has no direct adapter). `live_catalog` is the
 * `agy models` output for the antigravity runtime; without it the result is
 * PROBE_REQUIRED, never a guessed id.
 */
export function resolveDispatchTarget({ registry, runtime_adapter = null, provider = null, provider_family = null, model, effort = null, live_catalog = null } = {}) {
  const found = runtimeAdapterFor(registry, runtime_adapter ?? provider);
  if (found === null) {
    const family = provider_family ?? provider;
    return {
      status: "INTEGRATION_UNAVAILABLE",
      runtime_adapter: null,
      provider_family: family,
      model,
      why: `no verified runtime adapter for ${JSON.stringify(runtime_adapter ?? provider)}`,
      alternative_runtime_paths: runtimePathsForFamily(registry, family),
    };
  }
  const { name, adapter } = found;
  const efforts = Array.isArray(adapter.efforts) ? adapter.efforts : null;
  const base = { runtime_adapter: name, registry_provider: adapter.registry_provider, model, effort };

  let resolved;
  if (adapter.model_resolution === "live_catalog") {
    if (live_catalog === null) {
      return { ...base, status: "PROBE_REQUIRED", probe_command: "agy models", why: "resolve against the live catalog before dispatch" };
    }
    resolved = resolveAntigravityModel(live_catalog, {
      model,
      effort,
      efforts: efforts ?? undefined,
      unsuffixedEffort: adapter.unsuffixed_model_effort ?? "none",
    });
  } else {
    const cli = resolveCliModelArgument(registry, adapter.registry_provider, model);
    if (cli.status !== "RESOLVED") return { ...base, status: cli.status, why: cli.why };
    if (efforts !== null && isNonEmptyString(effort) && effort !== "provider_default" && !efforts.includes(effort)) {
      return { ...base, status: "EFFORT_UNSUPPORTED", supported_efforts: efforts, why: `effort ${effort} is not supported by ${name}` };
    }
    resolved = { status: "RESOLVED", cli_model: cli.cli_model, provider_family: providerFamilyOf(adapter.registry_provider === "claude" ? "claude" : model), effort_mode: "FLAG", source: cli.source };
  }
  if (resolved.status !== "RESOLVED") return { ...base, ...resolved };

  const family = resolved.provider_family;
  if (isNonEmptyString(provider_family) && family !== provider_family) {
    return { ...base, status: "CONFIG_INVALID", why: `${name}/${model} resolves to family ${family}, not the declared ${provider_family}` };
  }
  return {
    ...base,
    ...resolved,
    provider_family: family,
    resource_state_key: adapter.resource_pools?.[family] ?? null,
    launch_args: launchArgs(name, resolved.cli_model, effort),
  };
}

/**
 * Per-runtime-path dispatchability for one provider family. A failure on one
 * path (auth, integration, model) never marks the family unavailable while
 * another path is still usable.
 */
export function familyDispatchable(registry, family, { providerAuth = {}, integration = {}, capability = {}, models = {} } = {}) {
  const paths = runtimePathsForFamily(registry, family).map((p) => {
    const d = providerDispatchable({
      provider: p.registry_provider,
      models: models[p.runtime_adapter] ?? ["*"],
      capability,
      integration_state: integration[p.runtime_adapter] ?? "UNKNOWN",
      auth_state: providerAuth[p.registry_provider] ?? "AUTH_UNKNOWN",
    });
    return { ...p, dispatchable: d.dispatchable, reason: d.reason };
  });
  return { family, dispatchable: paths.some((p) => p.dispatchable), paths };
}

// Ordered: the first matching class wins. Model-level and auth patterns come
// before generic integration ones so "model not available" or "please log in"
// is never read as the whole provider being unavailable.
const FAILURE_PATTERNS = [
  // agy: `invalid model selection (...): --effort is not supported for model "<id>"`.
  // Must precede MODEL_UNKNOWN, whose "invalid model" would otherwise match.
  ["EFFORT_UNSUPPORTED", /--effort is not supported|effort[^\n]{0,30}not supported/i],
  ["MODEL_UNKNOWN", /isn'?t described by this version'?s model catalog|unknown model|model[^\n]{0,40}not found|invalid model|no such model/i],
  ["MODEL_UNAVAILABLE", /model[^\n]{0,60}(not available|unavailable|not supported|not enabled|no access)|(not available|unavailable)[^\n]{0,40}model|does not have access to (the )?model/i],
  ["AUTH_EXPIRED", /(session|token|login|credentials?)[^\n]{0,30}(has |have )?expired|expired[^\n]{0,20}(session|token|login)|refresh token/i],
  ["AUTH_INVALID", /invalid (api[- ]?key|x-api-key|credentials?|token|oauth)|(key|token|credentials?)[^\n]{0,30}(revoked|invalid)|\b401\b|unauthori[sz]ed/i],
  ["AUTH_REQUIRED", /not logged in|please (run )?\/?log ?in|log ?in required|run `?(claude auth login|codex login)|sign in to (continue|your)|authentication required|loggedIn"?\s*:\s*false/i],
  ["RESOURCE_EXHAUSTED", /usage limit|rate[- ]?limit|quota (exceeded|exhausted)|limit reached|credit balance|\b429\b/i],
  ["INTEGRATION_UNAVAILABLE", /command not found|not recognized as|ENOENT|connection refused|network error|ECONNREFUSED/i],
];

/**
 * Classifies a launch-phase / probe error text into a class token. Returns
 * null when nothing matched - an unrecognised error is not evidence against
 * the provider. The raw text is never returned.
 */
export function classifyLaunchFailure(output) {
  if (!isNonEmptyString(output)) return null;
  for (const [cls, pattern] of FAILURE_PATTERNS) {
    if (pattern.test(output)) return cls;
  }
  return null;
}

/**
 * Classifies a provider auth probe (e.g. `claude auth status --json`).
 * probe: { exit_code, logged_in, output }. Only class tokens come back.
 */
export function classifyAuthProbe(probe) {
  if (!isPlainObject(probe)) return "AUTH_UNKNOWN";
  if (probe.logged_in === true && (probe.exit_code === undefined || probe.exit_code === 0)) return "AUTH_OK";
  const cls = classifyLaunchFailure(probe.output);
  if (AUTH_FAILURE_STATES.has(cls)) return cls;
  if (probe.logged_in === false) return "AUTH_REQUIRED";
  return "AUTH_UNKNOWN";
}

function authAction(provider, authState) {
  return {
    kind: "HUMAN_INTERACTIVE_LOGIN",
    provider,
    auth_state: authState,
    // Exact reviewed command, or null when none has been reviewed. Never a
    // token, key or URL carrying one.
    command: REVIEWED_AUTH_COMMANDS[provider]?.login ?? null,
    then: "rerun the auth + model capability probe only (recheckAfterLogin); no router restart",
  };
}

/**
 * Pre-dispatch validation, in order:
 *   1 runtime adapter exists / present  registry runtime_adapters + runtime: { present }
 *   2 runtime auth usable               auth: probe for classifyAuthProbe, or a state token
 *   3 exact model + effort              resolveDispatchTarget (live_catalog for antigravity),
 *                                       model_probe, knownCapability
 *   4 resource / quota                  resource_state (PROVIDER_RESOURCE_STATES)
 *   5 CREATE_TERMINAL
 * `provider` is the registry `provider:` value (the runtime path); pass
 * `runtime_adapter` / `provider_family` / `effort` / `live_catalog` to pin the
 * full target.
 * Only CREATE_TERMINAL may be followed by creating a worker terminal. Every
 * other outcome is returned before a terminal exists, so no worker timeout is
 * ever waited through for a known startup problem. Diagnostics carry class
 * tokens only - never probe output, which may contain credentials.
 */
export function preDispatchCheck({
  registry,
  provider,
  model,
  runtime_adapter = null,
  provider_family = null,
  effort = null,
  live_catalog = null,
  runtime = null,
  auth = null,
  model_probe = null,
  knownCapability = {},
  resource_state = "UNKNOWN",
} = {}) {
  // Registries without a runtime_adapters table keep the provider-keyed path.
  const adapters = Object.keys(adapterTable(registry)).length > 0;
  const found = adapters ? runtimeAdapterFor(registry, runtime_adapter ?? provider) : null;
  if (found !== null) provider = found.adapter.registry_provider;
  const label = modelLabel(provider, model);
  const base = { provider, runtime_adapter: found?.name ?? null, model, cli_model: null };

  if (adapters && found === null) {
    const target = resolveDispatchTarget({ registry, runtime_adapter, provider, provider_family, model });
    return {
      ...base,
      action: "DO_NOT_DISPATCH",
      failed_step: "RUNTIME",
      failure_class: "INTEGRATION_UNAVAILABLE",
      auth_state: "AUTH_UNKNOWN",
      why: target.why,
      alternative_runtime_paths: target.alternative_runtime_paths,
    };
  }
  if (isPlainObject(runtime) && runtime.present === false) {
    return { ...base, action: "DO_NOT_DISPATCH", failed_step: "RUNTIME", failure_class: "INTEGRATION_UNAVAILABLE", auth_state: "AUTH_UNKNOWN" };
  }

  const authState = typeof auth === "string" && PROVIDER_AUTH_STATES.includes(auth) ? auth : classifyAuthProbe(auth);
  if (AUTH_FAILURE_STATES.has(authState)) {
    return {
      ...base,
      action: "HUMAN_ACTION_REQUIRED",
      failed_step: "AUTH",
      failure_class: authState,
      auth_state: authState,
      human_action: authAction(provider, authState),
      fallback_permitted: true,
    };
  }

  const resolved = adapters
    ? resolveDispatchTarget({ registry, runtime_adapter: found.name, provider_family, model, effort, live_catalog })
    : resolveCliModelArgument(registry, provider, model);
  if (resolved.status === "PROBE_REQUIRED") {
    return { ...base, action: "PROBE_REQUIRED", failed_step: "MODEL", failure_class: null, auth_state: authState, probe_command: resolved.probe_command };
  }
  if (resolved.status !== "RESOLVED") {
    return {
      ...base,
      action: "DO_NOT_DISPATCH",
      failed_step: resolved.status === "EFFORT_UNSUPPORTED" ? "EFFORT" : "MODEL",
      failure_class: resolved.status,
      capability: MODEL_FAILURE_STATES.has(resolved.status) ? resolved.status : "UNVERIFIED",
      supported_efforts: resolved.supported_efforts,
      auth_state: authState,
      why: resolved.why,
    };
  }
  const target = adapters
    ? {
        runtime_adapter: resolved.runtime_adapter,
        provider_family: resolved.provider_family,
        effort: resolved.effort,
        effort_mode: resolved.effort_mode,
        launch_args: resolved.launch_args,
        resource_state_key: resolved.resource_state_key,
      }
    : {};
  const known = knownCapability[label];
  if (MODEL_FAILURE_STATES.has(known)) {
    return { ...base, action: "DO_NOT_DISPATCH", failed_step: "MODEL", failure_class: known, capability: known, auth_state: authState, why: `${label} already failed with ${known} this session` };
  }
  // Catalog alias, reviewed override and live-catalog hits are verified by
  // resolution; a pass-through id stays UNVERIFIED until a probe launches it.
  let capability = resolved.source === "PASS_THROUGH" ? "UNVERIFIED" : "VERIFIED";
  if (isPlainObject(model_probe) && model_probe.launched === false) {
    const cls = classifyLaunchFailure(model_probe.output) ?? "INTEGRATION_UNAVAILABLE";
    if (AUTH_FAILURE_STATES.has(cls)) {
      return { ...base, action: "HUMAN_ACTION_REQUIRED", failed_step: "AUTH", failure_class: cls, auth_state: cls, human_action: authAction(provider, cls), fallback_permitted: true };
    }
    return {
      ...base,
      action: "DO_NOT_DISPATCH",
      failed_step: MODEL_FAILURE_STATES.has(cls)
        ? "MODEL"
        : cls === "EFFORT_UNSUPPORTED"
          ? "EFFORT"
          : cls === "RESOURCE_EXHAUSTED"
            ? "RESOURCE"
            : "RUNTIME",
      failure_class: cls,
      capability: MODEL_FAILURE_STATES.has(cls) ? cls : "UNVERIFIED",
      auth_state: authState,
    };
  }
  if (isPlainObject(model_probe) && model_probe.launched === true) capability = "VERIFIED";

  if (resource_state === "EXHAUSTED") {
    return { ...base, ...target, cli_model: resolved.cli_model, action: "DO_NOT_DISPATCH", failed_step: "RESOURCE", failure_class: "RESOURCE_EXHAUSTED", capability, auth_state: authState };
  }

  return { ...base, ...target, cli_model: resolved.cli_model, action: "CREATE_TERMINAL", failed_step: null, failure_class: null, capability, auth_state: authState };
}

/**
 * Records a model-level failure against exactly one provider/model label.
 * Non-model failures do not touch the capability map - they belong to the
 * resource, integration or auth axis.
 */
export function recordModelCapability(capability, provider, model, failureClass) {
  const next = { ...(isPlainObject(capability) ? capability : {}) };
  if (MODEL_FAILURE_STATES.has(failureClass)) next[modelLabel(provider, model)] = failureClass;
  return next;
}

/**
 * A provider stays dispatchable while its resource, integration and auth axes
 * allow it and at least one of its configured models is not known-bad. One
 * bad model id never makes the provider unavailable; an auth failure is
 * reported as such (human action), never as PROVIDER_UNAVAILABLE.
 */
export function providerDispatchable({
  provider,
  models = [],
  capability = {},
  integration_state = "UNKNOWN",
  resource_state = "UNKNOWN",
  auth_state = "AUTH_UNKNOWN",
}) {
  if (integration_state === "UNAVAILABLE") return { dispatchable: false, reason: "INTEGRATION_UNAVAILABLE" };
  if (AUTH_FAILURE_STATES.has(auth_state)) {
    return { dispatchable: false, reason: auth_state, human_action: authAction(provider, auth_state) };
  }
  if (resource_state === "EXHAUSTED") return { dispatchable: false, reason: "RESOURCE_EXHAUSTED" };
  const usable = models.filter((m) => !MODEL_FAILURE_STATES.has(capability[modelLabel(provider, m)]));
  if (usable.length === 0) return { dispatchable: false, reason: "NO_LAUNCHABLE_MODEL", usable_models: [] };
  return { dispatchable: true, reason: null, usable_models: usable };
}

/**
 * Re-auth recovery. After the human completes the interactive login, rerun
 * ONLY the auth probe and (optionally) one model capability probe; restore the
 * provider's auth state if they pass. Quota, integration and other providers'
 * state are carried over untouched, and no router restart is required.
 */
export function recheckAfterLogin({ provider, providerAuth = {}, auth_probe, model_probe = null, model = null, capability = {} }) {
  const authState = classifyAuthProbe(auth_probe);
  const nextAuth = { ...providerAuth, [provider]: authState };
  if (authState !== "AUTH_OK") {
    return { restored: false, providerAuth: nextAuth, capability, human_action: AUTH_FAILURE_STATES.has(authState) ? authAction(provider, authState) : null, router_restart_required: false };
  }
  let nextCapability = capability;
  if (isPlainObject(model_probe) && model_probe.launched === false) {
    const cls = classifyLaunchFailure(model_probe.output);
    nextCapability = recordModelCapability(capability, provider, model, cls);
    if (AUTH_FAILURE_STATES.has(cls)) {
      return { restored: false, providerAuth: { ...providerAuth, [provider]: cls }, capability, human_action: authAction(provider, cls), router_restart_required: false };
    }
  } else if (isPlainObject(model_probe) && model_probe.launched === true && isNonEmptyString(model)) {
    nextCapability = { ...capability };
    delete nextCapability[modelLabel(provider, model)];
  }
  return { restored: true, providerAuth: nextAuth, capability: nextCapability, human_action: null, router_restart_required: false };
}

/**
 * Worker health from a startup observation. A live terminal process alone is
 * TERMINAL_STARTED, not a healthy worker. A catalog / model / auth error seen
 * before MODEL_LAUNCHED fails fast - no stall wait, no repeated timeout.
 *
 * observation: { terminal_started, model_launched, activity_observed, output }
 */
export function classifyWorkerHealth(observation) {
  const o = isPlainObject(observation) ? observation : {};
  if (o.terminal_started !== true) {
    return { stage: null, healthy: false, action: "NOT_STARTED", failure_class: null };
  }
  const cls = classifyLaunchFailure(o.output);
  if (o.model_launched !== true && cls !== null) {
    return {
      stage: "TERMINAL_STARTED",
      healthy: false,
      action: AUTH_FAILURE_STATES.has(cls) ? "HUMAN_ACTION_REQUIRED" : "FAIL_FAST",
      failure_class: cls,
      // Only a resource or integration failure speaks about the provider as a
      // whole; model and auth failures do not make it PROVIDER_UNAVAILABLE.
      provider_failure: cls === "RESOURCE_EXHAUSTED" || cls === "INTEGRATION_UNAVAILABLE",
    };
  }
  if (o.model_launched !== true) {
    return { stage: "TERMINAL_STARTED", healthy: false, action: "AWAIT_MODEL_LAUNCH", failure_class: null };
  }
  if (o.activity_observed !== true) {
    return { stage: "MODEL_LAUNCHED", healthy: false, action: "AWAIT_ACTIVITY", failure_class: null };
  }
  return { stage: "WORKER_ACTIVE", healthy: true, action: "CONTINUE", failure_class: null };
}

/**
 * Failover after a pre-dispatch or fast-fail result. Records a model failure
 * against that one model, an auth failure against that provider, then asks
 * the ordinary selector for the next candidate with every already-attempted
 * label excluded, so the same model is never dispatched twice for one task.
 * `select(capability, providerAuth)` wraps selectCandidate with the caller's
 * slot/resource options - routing policy (stage, disjointness, quota) is
 * applied there unchanged.
 */
export function planFailover({ failed, failure_class, attempted = [], capability = {}, providerAuth = {}, select }) {
  const nextCapability = recordModelCapability(capability, failed?.provider, failed?.model, failure_class);
  const nextAuth = AUTH_FAILURE_STATES.has(failure_class) ? { ...providerAuth, [failed.provider]: failure_class } : { ...providerAuth };
  const tried = new Set([...attempted, modelLabel(failed?.provider, failed?.model)]);
  // Exclude attempted labels by marking them unusable for this task only.
  const selectionCapability = { ...nextCapability };
  for (const label of tried) if (!(label in selectionCapability)) selectionCapability[label] = "MODEL_UNAVAILABLE";
  const result = typeof select === "function" ? select(selectionCapability, nextAuth) : null;
  return { capability: nextCapability, providerAuth: nextAuth, attempted: [...tried], next: result };
}
