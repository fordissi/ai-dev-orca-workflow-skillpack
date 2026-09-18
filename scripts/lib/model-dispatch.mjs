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

// Ordered: the first matching class wins. Model-level and auth patterns come
// before generic integration ones so "model not available" or "please log in"
// is never read as the whole provider being unavailable.
const FAILURE_PATTERNS = [
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
 *   1 provider CLI/runtime exists     runtime: { present }
 *   2 provider auth usable            auth: probe for classifyAuthProbe, or a state token
 *   3 model alias / capability        registry + model + model_probe + knownCapability
 *   4 resource / quota                resource_state (PROVIDER_RESOURCE_STATES)
 *   5 CREATE_TERMINAL
 * Only CREATE_TERMINAL may be followed by creating a worker terminal. Every
 * other outcome is returned before a terminal exists, so no worker timeout is
 * ever waited through for a known startup problem. Diagnostics carry class
 * tokens only - never probe output, which may contain credentials.
 */
export function preDispatchCheck({
  registry,
  provider,
  model,
  runtime = null,
  auth = null,
  model_probe = null,
  knownCapability = {},
  resource_state = "UNKNOWN",
} = {}) {
  const label = modelLabel(provider, model);
  const base = { provider, model, cli_model: null };

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

  const resolved = resolveCliModelArgument(registry, provider, model);
  if (resolved.status !== "RESOLVED") {
    return { ...base, action: "DO_NOT_DISPATCH", failed_step: "MODEL", failure_class: resolved.status, capability: resolved.status, auth_state: authState, why: resolved.why };
  }
  const known = knownCapability[label];
  if (MODEL_FAILURE_STATES.has(known)) {
    return { ...base, action: "DO_NOT_DISPATCH", failed_step: "MODEL", failure_class: known, capability: known, auth_state: authState, why: `${label} already failed with ${known} this session` };
  }
  let capability = resolved.source === "PASS_THROUGH" ? "UNVERIFIED" : "VERIFIED";
  if (isPlainObject(model_probe) && model_probe.launched === false) {
    const cls = classifyLaunchFailure(model_probe.output) ?? "INTEGRATION_UNAVAILABLE";
    if (AUTH_FAILURE_STATES.has(cls)) {
      return { ...base, action: "HUMAN_ACTION_REQUIRED", failed_step: "AUTH", failure_class: cls, auth_state: cls, human_action: authAction(provider, cls), fallback_permitted: true };
    }
    return {
      ...base,
      action: "DO_NOT_DISPATCH",
      failed_step: MODEL_FAILURE_STATES.has(cls) ? "MODEL" : cls === "RESOURCE_EXHAUSTED" ? "RESOURCE" : "RUNTIME",
      failure_class: cls,
      capability: MODEL_FAILURE_STATES.has(cls) ? cls : "UNVERIFIED",
      auth_state: authState,
    };
  }
  if (isPlainObject(model_probe) && model_probe.launched === true) capability = "VERIFIED";

  if (resource_state === "EXHAUSTED") {
    return { ...base, cli_model: resolved.cli_model, action: "DO_NOT_DISPATCH", failed_step: "RESOURCE", failure_class: "RESOURCE_EXHAUSTED", capability, auth_state: authState };
  }

  return { ...base, cli_model: resolved.cli_model, action: "CREATE_TERMINAL", failed_step: null, failure_class: null, capability, auth_state: authState };
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
