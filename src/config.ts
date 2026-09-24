/**
 * Purpose: the process-wide settings the engine and the presentation layer
 *   read, and the one place an operator sets them.
 * Assumes:
 *   - an environment variable is how an operator configures a process without
 *     editing it, so every setting has one and the code's default is the
 *     fallback rather than the authority
 * Guarantees:
 *   - browsers without process use the declared defaults
 *     [tested: npm run test:browser; commit=04fde431963bd063ef4ab5dc9b579ff2faba9fe8]
 *   - a STARTUP setting is frozen once an engine exists, and changing it then
 *     is a refusal rather than a value that quietly does nothing
 *     [tested: "freezes a startup setting once an engine exists"]
 *   - every setting is a positive integer, checked where it is set rather than
 *     where it is used, so a bad `METTA_STACK_LIMIT` is named at boot
 *   - an environment variable is read as the C seat reads METTA_STACK_LIMIT,
 *     decimal digits alone, and refused in the Python seat's words: "must be
 *     a positive integer, got '<value>'" for anything else, an empty value
 *     included, and "must be positive, got 0" for zero [source:
 *     extensions/cmetta/cmetta.c, boot_stack_bytes;
 *     extensions/python/metta/_catalog/bounds.py, Setting.initial and
 *     _positive_integer; tested: "reads a setting from the environment as the
 *     other seats do, and refuses a bad one"; commit=WORKTREE]
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
 * `stackLimit` has no default VALUE, which is a divergence from the Python
 * side and a measured one: its default is eight gigabytes, and a WebAssembly
 * SWI is 32-bit, so setting it answers `set_prolog_flag/2: Cannot represent
 * due to size_t` on stderr [measured 2026-08-28]. Unset means the ceiling boot
 * derives from the host's memory once the engine has loaded (stackCeiling in
 * wasm-memory.ts), which no constant here could know; a value set here
 * overrides it in either direction.
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

/**
 * A setting's value from its environment variable, or its default when unset.
 *
 * Decimal digits alone, as the C seat reads METTA_STACK_LIMIT, so a sign, a
 * blank, an exponent, a hex prefix or an empty value is refused rather than
 * read the way `Number` would read some of them.
 */
function fromEnvironment(
  name: Setting,
  source: Readonly<Record<string, string | undefined>>,
): number | undefined {
  const setting = SETTINGS[name];
  const raw = source[setting.environment];
  if (raw === undefined) return setting.value;
  if (!/^[0-9]+$/.test(raw)) {
    throw new MettaError(`${setting.environment} must be a positive integer, got '${raw}'`);
  }
  const value = Number(raw);
  if (value === 0) throw new MettaError(`${setting.environment} must be positive, got 0`);
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

  constructor(
    environment: Readonly<Record<string, string | undefined>> =
      typeof process === "undefined" ? {} : process.env,
  ) {
    this.#values = {
      stackLimit: fromEnvironment("stackLimit", environment),
      heartbeatInterval: fromEnvironment("heartbeatInterval", environment),
      declarationLimit: fromEnvironment("declarationLimit", environment),
      displayRows: fromEnvironment("displayRows", environment),
    };
  }

  /**
   * The engine's stack ceiling in bytes, or nothing for the one boot derives.
   *
   * Frozen once an engine exists. Unset by default, because the ceiling a
   * WebAssembly SWI can hold depends on what its memory holds once the engine
   * has loaded; `Engine.stackLimit` reads the one in force.
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
      if (!Number.isInteger(value)) {
        throw new MettaError(`${name} must be a positive integer, got ${String(value)}`);
      }
      if (value <= 0) throw new MettaError(`${name} must be positive, got ${String(value)}`);
      if (this.#started && SETTINGS[name].atStartup && value !== this.#values[name]) {
        frozen.push(name);
        continue;
      }
      updates.push([name, value]);
    }
    if (frozen.length > 0) {
      throw new MettaError(
        // sort order is not an answer: these names reach a sentence and nothing else.
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
