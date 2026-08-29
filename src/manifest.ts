/**
 * Purpose: deployment as knowledge. A manifest of `(boot ...)` forms assembles
 *   an app, and every form performed lands in the booted space, so what was
 *   deployed is queryable rather than dead configuration.
 * Assumes:
 *   - `m.forms(source)` answers every form without compiling, storing or
 *     running any of them, which is what lets a manifest be VALIDATED whole
 *     before anything happens
 * Guarantees:
 *   - the vocabulary is CLOSED — `load`, `attach`, `bridge`, `serve` — and
 *     every form is validated before ANY form performs, so a bad manifest
 *     changes nothing [tested: "reports every problem before anything
 *     performs"]
 *   - forms perform in source order, and each performed form lands as its own
 *     `(boot ...)` atom in the booted space
 *     [tested: "records every form it performed"]
 *   - a manifest DECLARES; a `!` directive in one is a refusal naming the
 *     remedy, because a deployment that runs arbitrary code is not a
 *     deployment description
 * Owns: the gateways its `serve` forms started. `close()` stops them; loaded
 *   knowledge and registered providers stay, because those are space state.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { readFileSync } from "node:fs";

import { Atom, Expression, Grounded, Sym, expr, sym } from "./atom.ts";
import { MettaError } from "./errors.ts";
import type { MeTTa } from "./metta.ts";
import { showsAs } from "./present.ts";
import { type Gateway, connect, serve } from "./remote.ts";
import type { Space } from "./space.ts";
import { mapped } from "./spaces.ts";

/** The four forms a manifest may carry. Nothing else is a boot form. */
export const VOCABULARY: readonly string[] = Object.freeze(["load", "attach", "bridge", "serve"]);

/** The assembled app: the engine, the gateways it started, what it performed. */
export class Boot implements AsyncDisposable {
  /** The surface the manifest assembled into. */
  readonly metta: MeTTa;
  /** Every gateway a `serve` form started. */
  readonly gateways: readonly Gateway[];
  /** Every form performed, in source order, as it was recorded. */
  readonly performed: readonly Atom[];

  /** @internal Use {@link boot}. */
  constructor(surface: MeTTa, gateways: readonly Gateway[], performed: readonly Atom[]) {
    this.metta = surface;
    this.gateways = gateways;
    this.performed = performed;
  }

  /** Stop every gateway this boot started. */
  async close(): Promise<void> {
    await Promise.all(this.gateways.map((gateway) => gateway.close()));
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  toString(): string {
    return `Boot(${String(this.performed.length)} forms, ${String(this.gateways.length)} gateways)`;
  }
}

showsAs(Boot.prototype, (assembled: Boot) => assembled.toString());

function headOf(atom: Atom): string | undefined {
  if (!(atom instanceof Expression) || atom.items.length === 0) return undefined;
  const head = atom.items[0];
  return head instanceof Sym ? head.name : undefined;
}

function spaceName(atom: Atom | undefined): string | undefined {
  if (atom === undefined) return undefined;
  const text = atom.text;
  return text.startsWith("&") ? text : undefined;
}

function textOf(atom: Atom | undefined): string | undefined {
  if (!(atom instanceof Grounded) || typeof atom.value !== "string") return undefined;
  return atom.value;
}

function portOf(atom: Atom | undefined): number | undefined {
  if (!(atom instanceof Grounded)) return undefined;
  const value = atom.value;
  if (typeof value !== "number" && typeof value !== "bigint") return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : undefined;
}

/** Everything wrong with one directive's shape; empty when it is sound. */
function complaints(directive: Expression): string[] {
  const head = headOf(directive);
  const args = directive.items.slice(1);
  switch (head) {
    case "load":
      return args.length === 1 && textOf(args[0]) !== undefined
        ? []
        : ['load takes one string path: (load "rules.metta")'];
    case "attach":
      return (args.length === 2 || args.length === 3) &&
        spaceName(args[0]) !== undefined &&
        textOf(args[1]) !== undefined &&
        (args.length === 2 || spaceName(args[2]) !== undefined)
        ? []
        : [
            "attach takes a space symbol, a URL string, and optionally the " +
              'remote-side space symbol: (attach &crm "http://crm:8700")',
          ];
    case "bridge":
      return args.length === 3 &&
        spaceName(args[0]) !== undefined &&
        args[1] instanceof Expression &&
        args[2] instanceof Expression
        ? []
        : ["bridge takes a space symbol and two shapes: (bridge &edges (edge $a $b) (kv $a $b))"];
    case "serve": {
      const found: string[] = [];
      const spaces = args[0];
      if (
        !(spaces instanceof Expression) ||
        spaces.items.length === 0 ||
        spaces.items.some((each) => spaceName(each) === undefined)
      ) {
        found.push("serve's first argument is a nonempty list of space symbols");
      }
      if (args.length !== 2 || portOf(args[1]) === undefined) {
        found.push("serve's second argument is a port number, 0 picks a free one");
      }
      return found;
    }
    default:
      return [`unknown boot form ${String(head)}; the vocabulary is ${VOCABULARY.join(", ")}`];
  }
}

/** What `boot` accepts beside the manifest. */
export interface BootManifestOptions {
  /** The surface to assemble into. */
  readonly metta: MeTTa;
  /** A bearer token every gateway requires and every attachment sends. */
  readonly token?: string;
  /** The interface a gateway listens on. Loopback by default. */
  readonly host?: string;
}

/**
 * Assemble an app from a manifest of `(boot ...)` forms.
 *
 * ```metta
 * (boot (load "rules.metta"))
 * (boot (attach &crm "http://crm:8700"))
 * (boot (bridge &edges (edge $a $b) (kv $a $b)))
 * (boot (serve (&self &edges) 8700))
 * ```
 *
 * Each form is sugar for exactly one call this package already has, performed
 * in source order. Everything is validated first: a manifest with a problem
 * anywhere performs nothing, and the refusal lists every problem rather than
 * the first.
 */
export async function boot(
  manifest: string,
  options: BootManifestOptions,
): Promise<Boot> {
  const surface = options.metta;
  const source = manifest.includes("\n") || !manifest.endsWith(".metta")
    ? manifest
    : readFileSync(manifest, "utf8");
  const forms = surface.forms(source);
  if (forms.length === 0) throw new MettaError("this manifest declares nothing");

  const directives: [Atom, Expression][] = [];
  const problems: string[] = [];
  forms.forEach((form, at) => {
    const position = at + 1;
    if (form.kind === "runnable") {
      problems.push(`form ${String(position)}: a manifest declares, it does not run (drop the !)`);
      return;
    }
    const atom = form.atom;
    const directive = atom instanceof Expression ? atom.items[1] : undefined;
    if (
      !(atom instanceof Expression) ||
      atom.items.length !== 2 ||
      headOf(atom) !== "boot" ||
      !(directive instanceof Expression) ||
      directive.items.length === 0
    ) {
      problems.push(`form ${String(position)}: ${atom.text} is not a (boot (...)) form`);
      return;
    }
    for (const complaint of complaints(directive)) {
      problems.push(`form ${String(position)}: ${complaint}`);
    }
    directives.push([atom, directive]);
  });
  // Every problem, before ANY form performs: a manifest that is wrong
  // somewhere changes nothing anywhere.
  if (problems.length > 0) {
    throw new MettaError(`this manifest cannot be booted:\n  ${problems.join("\n  ")}`);
  }

  const gateways: Gateway[] = [];
  const performed: Atom[] = [];
  // A bridge name gathers every declaration the manifest holds for it, so a
  // later `serve` can name a space several bridge forms built together.
  const bridges = new Map<string, Atom[]>();
  for (const [, directive] of directives) {
    if (headOf(directive) !== "bridge") continue;
    const name = spaceName(directive.items[1]) as string;
    const held = bridges.get(name) ?? [];
    held.push(expr(sym("bridge"), directive.items[2] as Atom, directive.items[3] as Atom));
    bridges.set(name, held);
  }
  const materialised = new Set<string>();

  for (const [form, directive] of directives) {
    const args = directive.items.slice(1);
    switch (headOf(directive)) {
      case "load":
        surface.loadFile(textOf(args[0]) as string);
        break;
      case "attach": {
        const name = spaceName(args[0]) as string;
        const url = textOf(args[1]) as string;
        const remote = args.length === 3 ? (spaceName(args[2]) as string) : "&self";
        surface.attach(
          name,
          connect(
            url,
            options.token === undefined ? { space: remote } : { space: remote, token: options.token },
          ),
        );
        break;
      }
      case "bridge": {
        const name = spaceName(args[0]) as string;
        // The FIRST bridge form for a name materialises it, carrying every
        // declaration the manifest holds for that name; the rest are already
        // in it.
        if (materialised.has(name)) break;
        materialised.add(name);
        const declared = bridges.get(name) as Atom[];
        surface.attach(name, mapped(surface.self, declared[0] as Atom));
        break;
      }
      case "serve": {
        const listed = (args[0] as Expression).items.map((each) =>
          surface.space(spaceName(each) as string),
        );
        gateways.push(
          await serve({
            spaces: listed,
            port: portOf(args[1]) as number,
            ...(options.host === undefined ? {} : { host: options.host }),
            ...(options.token === undefined ? {} : { token: options.token }),
          }),
        );
        break;
      }
    }
    // Each performed form is recorded as itself, so the deployment is
    // queryable knowledge rather than something that only happened.
    surface.self.add(form);
    performed.push(form);
  }
  return new Boot(surface, gateways, performed);
}
