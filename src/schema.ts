/**
 * Purpose: the schema door. Declare vocabulary once, and both realms fall out:
 *   the engine holds the type atoms, and TypeScript types the factories from
 *   the same declaration.
 * Assumes:
 *   - a declaration's value is MeTTa's own arrow text, which is the
 *     interchange itself, and it is PARSED at the type level as well as at run
 *     time, so the string ban's tooling ground does not apply to it
 *     [source: ai-typescript-design.md move 4, the ArkType isomorphism law]
 * Guarantees:
 *   - one writing, three realms: the TypeScript type, the runtime term, and
 *     the engine-side declaration all derive from the same object literal
 *   - a declared name is typed exactly on the schema's own factory, and an
 *     undeclared one still spells, because a vocabulary that refuses new words
 *     is not a vocabulary
 * Decides: the runtime answer for a type is always the ATOM. TypeScript types
 *   are not runtime values, so a type here is data (`S["%Undefined%"]`), which
 *   is what makes the one-way-table friction the Python side records not exist
 *   at all on this surface.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { type Atom, type Term, expr, exprOf, sym, toAtom } from "./atom.ts";
import { PettaError } from "./errors.ts";
import { type SymFactory, type VarFactory, S, V } from "./factories.ts";
import { mettaName } from "./naming.ts";
import type { ArrowResult, SchemaVars, SourceRow } from "./types/sexpr.ts";

/** A vocabulary: each name mapped to the MeTTa type text that declares it. */
export type SchemaDeclarations = Readonly<Record<string, string>>;

/** What a Standard Schema validator looks like, vendored rather than depended on. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

/** A Standard Schema validation outcome. */
export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly { readonly message: string }[] };

/** Thrown when an answer does not satisfy the validator it was decoded with. */
export class SchemaError extends PettaError {
  readonly issues: readonly { readonly message: string }[];

  constructor(issues: readonly { readonly message: string }[], vendor: string) {
    super(
      `an answer did not match the ${vendor} schema: ${issues
        .map((issue) => issue.message)
        .join("; ")}`,
      { code: "ERR_METTA_WIRE" },
    );
    this.name = "SchemaError";
    this.issues = issues;
  }
}

/** What the schema needs of the surface, structurally, so there is no cycle. */
interface Declarer {
  add(...atoms: readonly Term[]): unknown;
}

/**
 * A declared vocabulary.
 *
 * ```ts
 * const kb = m.schema({
 *   parent: "(-> Symbol Symbol %Undefined%)",
 *   age: "(-> Symbol Number)",
 * });
 * kb.S.parent(S.tom, S.bob);   // typed: two arguments, and the head is known
 * kb.S.whatever;               // still spells anything
 * ```
 *
 * The declaration is MeTTa text, so the engine holds exactly what was written,
 * and the SAME text is read at the type level, so the two realms cannot drift.
 */
export class Schema<D extends SchemaDeclarations> {
  /** The declarations as written. */
  readonly declarations: D;

  /** The symbol factory, with the declared names typed and any other spellable. */
  readonly S: SymFactory & { readonly [K in keyof D & string]: SymFactory[string] };

  /** The variable factory. Declared names are typed the same way. */
  readonly V: VarFactory;

  /** @internal Use `m.schema(...)`. */
  constructor(surface: Declarer, declarations: D) {
    this.declarations = declarations;
    this.S = S as Schema<D>["S"];
    this.V = V;
    const atoms: Atom[] = [];
    for (const [name, text] of Object.entries(declarations)) {
      // A declared name is VOCABULARY, so it reaches the meaning layer through
      // TypeScript's own casing exactly as `S.ageOf` and `fn.ageOf` do. A
      // schema that declared `ageOf` verbatim would type a head no door spells.
      atoms.push(expr(sym(":"), sym(mettaName(name)), parseType(text, name)));
    }
    if (atoms.length > 0) surface.add(...atoms);
  }

  /** The engine head a declared name installs under. */
  headOf<K extends keyof D & string>(name: K): string {
    return mettaName(name);
  }

  /** The type declared for a name, as the atom the engine holds. */
  typeOf<K extends keyof D & string>(name: K): Atom {
    const text = this.declarations[name];
    if (text === undefined) {
      throw new PettaError(`this schema declares no ${name}`, { code: "ERR_METTA_NAME" });
    }
    return parseType(text, name);
  }

  /** Every declared name. */
  get names(): readonly (keyof D & string)[] {
    return Object.keys(this.declarations) as (keyof D & string)[];
  }
}

/**
 * The atom a type declaration's text names.
 *
 * A tiny reader rather than the engine's, because a schema is declared before
 * anything is asked and this must not need a booted engine. It reads exactly
 * what a type declaration is: symbols, nested parentheses, and `$`-variables.
 */
export function parseType(text: string, name: string): Atom {
  const tokens = text.match(/\(|\)|[^\s()]+/g);
  if (tokens === null) {
    throw new PettaError(`the declaration for ${name} is empty`, { code: "ERR_METTA_NAME" });
  }
  let at = 0;
  const read = (): Atom => {
    const token = tokens[at];
    at += 1;
    if (token === undefined) {
      throw new PettaError(`the declaration for ${name} ends early: ${text}`, {
        code: "ERR_METTA_NAME",
      });
    }
    if (token === "(") {
      const items: Atom[] = [];
      while (tokens[at] !== ")") {
        if (at >= tokens.length) {
          throw new PettaError(`the declaration for ${name} is missing a )`, {
            code: "ERR_METTA_NAME",
          });
        }
        items.push(read());
      }
      at += 1;
      return exprOf(items);
    }
    if (token === ")") {
      throw new PettaError(`the declaration for ${name} has an extra )`, {
        code: "ERR_METTA_NAME",
      });
    }
    return toAtom(sym(token));
  };
  const built = read();
  if (at !== tokens.length) {
    throw new PettaError(`the declaration for ${name} has more than one term: ${text}`, {
      code: "ERR_METTA_NAME",
    });
  }
  return built;
}

/**
 * Validate one answer with any Standard Schema validator.
 *
 * Zod, Valibot, ArkType, TypeBox, Yup and Joi all expose the same `~standard`
 * property, so one interface reaches every one of them and this package gains
 * no runtime dependency for any of them.
 */
export function decodeWith<Output>(
  schema: StandardSchemaV1<unknown, Output>,
  value: unknown,
): Output {
  const props = schema["~standard"];
  const result = props.validate(value);
  if (result instanceof Promise) {
    throw new PettaError(
      `the ${props.vendor} schema validates asynchronously; use decodeWithAsync`,
      { code: "ERR_METTA_UNSUPPORTED" },
    );
  }
  if (result.issues !== undefined) throw new SchemaError(result.issues, props.vendor);
  return result.value;
}

/** The awaiting twin, for a validator that answers asynchronously. */
export async function decodeWithAsync<Output>(
  schema: StandardSchemaV1<unknown, Output>,
  value: unknown,
): Promise<Output> {
  const props = schema["~standard"];
  const result = await props.validate(value);
  if (result.issues !== undefined) throw new SchemaError(result.issues, props.vendor);
  return result.value;
}

export type { ArrowResult, SchemaVars, SourceRow };
