/**
 * Purpose: the process-wide settings the engine and the presentation layer
 *   read, and the one place an operator sets them.
 * Assumes:
 *   - an environment variable is how an operator configures a process without
 *     editing it, so every setting has one and the code's default is the
 *     fallback rather than the authority
 * Guarantees:
 *   - a STARTUP setting is frozen once an engine exists, and changing it then
 *     is a refusal rather than a value that quietly does nothing
 *     [tested: "freezes a startup setting once an engine exists"]
 *   - every setting is a positive integer, checked where it is set rather than
 *     where it is used, so a bad `METTA_STACK_LIMIT` is named at boot
 * Decides: the settings are a small closed set rather than an open bag. An
 *   open one cannot say which are frozen at startup, cannot validate, and
 *   turns a typo into silence.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { MettaError } from "./errors.ts";
import { showsAs } from "./present.ts";

/**
 * Every setting, with the environment variable that supplies it.
 *
 * `stackLimit` has NO default, which is a divergence from the Python side and
 * a measured one: its default is eight gigabytes, and a WebAssembly SWI is
 * 32-bit, so setting it answers `set_prolog_flag/2: Cannot represent due to
 * size_t` on stderr [measured 2026-08-28]. Unset means the BUILD's own
 * ceiling, which is the honest default for a build whose address space is not
 * the caller's to guess.
 */
const SETTINGS = {
  stackLimit: { environment: "METTA_STACK_LIMIT", value: undefined, atStartup: true },
  heartbeatInterval: { environment: "METTA_HEARTBEAT_INTERVAL", value: 100_000, atStartup: true },
  declarationLimit: { environment: "METTA_DECLARATION_LIMIT", value: 512, atStartup: false },
  displayRows: { environment: "METTA_DISPLAY_ROWS", value: 100, atStartup: false },
} as const;

/** The name of one setting. */
export type Setting = keyof typeof SETTINGS;

/** What `configure` accepts. */
export type Settings = { readonly [K in Setting]?: number };

function fromEnvironment(
  name: Setting,
  source: Readonly<Record<string, string | undefined>>,
): number | undefined {
  const setting = SETTINGS[name];
  const raw = source[setting.environment];
  if (raw === undefined || raw === "") return setting.value;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new MettaError(
      `${setting.environment} must be a positive integer, not ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

/**
 * The settings this process runs under.
 *
 * ```ts
 * config.configure({ stackLimit: 2_000_000_000 });   // before the first engine
 * config.displayRows;                                 // read at every use
 * ```
 *
 * `stackLimit` and `heartbeatInterval` take effect when the first engine
 * starts and are frozen after; `declarationLimit` and `displayRows` are read
 * at each use and may change at any time.
 */
export class Config {
  readonly #values: Record<Setting, number | undefined>;
  #started = false;

  constructor(environment: Readonly<Record<string, string | undefined>> = process.env) {
    this.#values = {
      stackLimit: fromEnvironment("stackLimit", environment),
      heartbeatInterval: fromEnvironment("heartbeatInterval", environment),
      declarationLimit: fromEnvironment("declarationLimit", environment),
      displayRows: fromEnvironment("displayRows", environment),
    };
  }

  /**
   * The engine's stack ceiling in bytes, or nothing for the build's own.
   *
   * Frozen once an engine exists. Unset by default, because a WebAssembly SWI
   * is 32-bit and a ceiling this package chose could not be represented.
   */
  get stackLimit(): number | undefined {
    return this.#values.stackLimit;
  }

  /** How often a long reduction checks in, in inferences. Frozen at startup. */
  get heartbeatInterval(): number {
    return this.#values.heartbeatInterval as number;
  }

  /** How many declarations one definition may carry. Read at each use. */
  get declarationLimit(): number {
    return this.#values.declarationLimit as number;
  }

  /** How many rows a rendering shows before it elides. Read at each use. */
  get displayRows(): number {
    return this.#values.displayRows as number;
  }

  /** Whether an engine has started, after which the startup settings are fixed. */
  get started(): boolean {
    return this.#started;
  }

  /** Validate and apply settings, atomically. */
  configure(settings: Settings): void {
    const frozen: Setting[] = [];
    const updates: [Setting, number][] = [];
    for (const [name, value] of Object.entries(settings) as [Setting, number | undefined][]) {
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value <= 0) {
        throw new MettaError(`${name} must be a positive integer, not ${String(value)}`);
      }
      if (this.#started && SETTINGS[name].atStartup && value !== this.#values[name]) {
        frozen.push(name);
        continue;
      }
      updates.push([name, value]);
    }
    if (frozen.length > 0) {
      throw new MettaError(
        `${frozen.sort().join(" and ")} take effect when the first engine starts and ` +
          `cannot change after; one is already running`,
      );
    }
    // Applied only once every one of them is accepted, so a refusal leaves the
    // settings exactly as they were.
    for (const [name, value] of updates) this.#values[name] = value;
  }

  /** @internal Called by the first engine to boot. */
  markStarted(): void {
    this.#started = true;
  }

  /** Every setting, as plain data. An unset one is absent. */
  toJSON(): Partial<Record<Setting, number>> {
    const held: Partial<Record<Setting, number>> = {};
    for (const [name, value] of Object.entries(this.#values) as [Setting, number | undefined][]) {
      if (value !== undefined) held[name] = value;
    }
    return held;
  }

  toString(): string {
    return `Config(${Object.entries(this.toJSON())
      .map(([name, value]) => `${name}=${String(value)}`)
      .join(", ")})`;
  }
}

showsAs(Config.prototype, (value: Config) => value.toString());

/** The settings this process runs under. */
export const config: Config = new Config();
