/**
 * The injectable producer boundary.
 *
 *   getResourceEvidence(): ResourceEvidence | Promise<ResourceEvidence>
 *
 * Today the Operational Router adapter is fed by `FixtureResourceEvidenceProvider`
 * (or any object with a `getResourceEvidence` method). Later,
 * `OrcaCliResourceEvidenceProvider` will run `orca resource status --json` and
 * parse stdout - WITHOUT the adapter changing. That command does not exist in
 * the installed Orca version yet, so the CLI provider requires an injected
 * `exec` and is never exercised by tests that need the command present.
 *
 * Pure boundary: no shell execution is hard-coded here.
 */

import { parseResourceEvidence, ResourceEvidenceError } from "./resource-evidence.mjs";

export class ResourceEvidenceProvider {
  // eslint-disable-next-line no-unused-vars
  async getResourceEvidence() {
    throw new Error("ResourceEvidenceProvider.getResourceEvidence() is abstract");
  }
}

/**
 * Serves pre-built ResourceEvidence objects. Pass one object, or an array to
 * walk across successive `getResourceEvidence()` calls (the last one repeats
 * once the list is exhausted, unless `cycle: true`).
 */
export class FixtureResourceEvidenceProvider extends ResourceEvidenceProvider {
  #fixtures;
  #cursor = 0;
  #cycle;

  constructor(fixtureOrFixtures, options = {}) {
    super();
    this.#fixtures = Array.isArray(fixtureOrFixtures) ? [...fixtureOrFixtures] : [fixtureOrFixtures];
    if (this.#fixtures.length === 0) throw new Error("FixtureResourceEvidenceProvider needs at least one fixture");
    this.#cycle = options.cycle === true;
  }

  async getResourceEvidence() {
    const i = this.#cycle ? this.#cursor % this.#fixtures.length : Math.min(this.#cursor, this.#fixtures.length - 1);
    this.#cursor += 1;
    // Return a structured clone so a caller mutation cannot corrupt the fixture.
    return structuredClone(this.#fixtures[i]);
  }

  reset() {
    this.#cursor = 0;
  }
}

/**
 * Future live producer. Runs `orca resource status --json` through an injected
 * `exec` (so nothing is hard-coded to child_process here) and parses the JSON
 * object out of stdout, ignoring any decorative lines around it.
 *
 * `exec` contract: (argv: string[]) => { stdout: string } | Promise<...>.
 * Absent `exec` -> PRODUCER_UNAVAILABLE (the command is not wired yet).
 */
export class OrcaCliResourceEvidenceProvider extends ResourceEvidenceProvider {
  #exec;
  #argv;
  #strict;

  constructor(options = {}) {
    super();
    this.#exec = typeof options.exec === "function" ? options.exec : null;
    this.#argv = Array.isArray(options.argv) ? options.argv : ["orca", "resource", "status", "--json"];
    this.#strict = options.strict !== false; // strict by default for untrusted stdout
  }

  async getResourceEvidence() {
    if (this.#exec === null) {
      throw new ResourceEvidenceError(
        "PRODUCER_UNAVAILABLE",
        "orca resource status --json is not available; inject an exec to use the live producer",
      );
    }
    const result = await this.#exec(this.#argv);
    const stdout = typeof result?.stdout === "string" ? result.stdout : String(result ?? "");
    const json = extractJsonObject(stdout);
    if (json === null) {
      throw new ResourceEvidenceError("MALFORMED_JSON", "no JSON object found in producer stdout");
    }
    return parseResourceEvidence(json, { strict: this.#strict });
  }
}

/**
 * Pulls the first balanced top-level `{...}` out of a stdout blob so decorative
 * banner / log lines around the JSON are ignored. Returns the substring, or
 * null when no balanced object is present. String-aware so braces inside JSON
 * string values do not miscount.
 */
export function extractJsonObject(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
