/**
 * Purpose: a whole table-backed space from `(bridge ...)` declarations, so the
 *   contract between an atom shape and a row shape is REWRITE RULES and both
 *   directions of the boundary fall out of matching them.
 * Assumes:
 *   - one declaration relates one atom shape to one row shape:
 *     `(bridge (edge $a $b) (row edges (a $a) (b $b)))`. Read left to right a
 *     query becomes a filter and an add becomes an insert; read right to left
 *     a row becomes the atom
 * Guarantees:
 *   - a schema is a SET of declarations the way a function is a set of
 *     equations, so a query answers the union of every shape that admits it,
 *     exactly as overlapping equations answer together
 *     [tested: "answers the union of every shape a schema admits"]
 *   - the bound parts of a pattern become column constraints, so a source that
 *     can filter does; a source that cannot is still correct, because the
 *     engine unifies what comes back
 *   - an add whose atom TWO shapes admit is refused naming both, because
 *     storing it twice would invent an occurrence and a multiset must not
 *     [tested: "refuses an add two shapes admit"]
 * Decides: the row store is an interface rather than a driver. This module
 *   knows nothing about SQL, CSV or a dataframe; it knows rows, and whatever
 *   holds them says how to read and write them.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import {
  Atom,
  Expression,
  Sym,
  type Term,
  Var,
  expr,
  substitute,
  sym,
  toAtom,
} from "./atom.ts";
import { MettaError } from "./errors.ts";
import { matchTerms } from "./matching.ts";
import type { SpaceProvider } from "./provider.ts";
import { hostValue } from "./space.ts";

/** One row, as ordinary named values. */
export type Row = Readonly<Record<string, unknown>>;

/** Where the rows are, and what may be done to them. */
export interface TableSource {
  /**
   * Every row of one table, optionally narrowed by equality constraints.
   *
   * The constraints are what the query's bound positions came to; honouring
   * them is the performance lever and ignoring them stays correct, because the
   * caller filters again.
   */
  rows(table: string, where?: Row): Iterable<Row> | AsyncIterable<Row>;
  /** Add one row to a table. */
  insert?(table: string, row: Row): void | Promise<void>;
  /** Remove rows matching one row's values; answer whether any went. */
  remove?(table: string, row: Row): boolean | Promise<boolean>;
  /** Empty one table. */
  clear?(table: string): void | Promise<void>;
}

/** One declaration: the atom shape, the table, and the columns. */
interface Declaration {
  readonly outer: Atom;
  readonly table: string;
  /** Each column name, and the term in the atom shape it corresponds to. */
  readonly columns: readonly (readonly [string, Atom])[];
}

function headed(atom: Atom, name: string): atom is Expression {
  return (
    atom instanceof Expression &&
    atom.items.length > 0 &&
    atom.items[0] instanceof Sym &&
    (atom.items[0] as Sym).name === name
  );
}

/** Read one `(bridge <outer> (row <table> (<column> <term>)...))` declaration. */
function declarationOf(term: Term): Declaration {
  const atom = toAtom(term);
  if (!headed(atom, "bridge") || atom.items.length !== 3) {
    throw new MettaError(
      `a table declaration is (bridge <shape> (row <table> (<column> <term>)...)), ` +
        `got ${atom.text}`,
    );
  }
  const inner = atom.items[2] as Atom;
  if (!headed(inner, "row") || inner.items.length < 2 || !(inner.items[1] instanceof Sym)) {
    throw new MettaError(
      `a table declaration's row side is (row <table> (<column> <term>)...), got ${inner.text}`,
    );
  }
  const columns: [string, Atom][] = [];
  for (const field of inner.items.slice(2)) {
    if (!(field instanceof Expression) || field.items.length !== 2 || !(field.items[0] instanceof Sym)) {
      throw new MettaError(`a column is (<name> <term>), got ${field.text}`);
    }
    columns.push([(field.items[0] as Sym).name, field.items[1] as Atom]);
  }
  return { outer: atom.items[1] as Atom, table: (inner.items[1] as Sym).name, columns };
}

/** The constraints a pattern's bound positions place on the columns. */
function constraintsFor(declaration: Declaration, pattern: Atom): Row | undefined {
  const bindings = matchTerms(declaration.outer, pattern);
  if (bindings === undefined) return undefined;
  const where: Record<string, unknown> = {};
  for (const [column, term] of declaration.columns) {
    const filled = substitute(term, bindings);
    // A position still carrying a variable is a HOLE, not a constraint.
    if (filled.text.includes("$")) continue;
    where[column] = hostValue(filled);
  }
  return where;
}

/** The atom one row reads as, under one declaration. */
function atomOf(declaration: Declaration, row: Row): Atom | undefined {
  const bindings: Record<string, Term> = {};
  for (const [column, term] of declaration.columns) {
    if (!(column in row)) return undefined;
    // A column bound to a VARIABLE in the shape fills that variable; one bound
    // to a literal has to agree with the row.
    if (term instanceof Var) bindings[term.name] = row[column] as Term;
    else if (hostValue(term) !== row[column]) return undefined;
  }
  return substitute(declaration.outer, bindings);
}

/** The row one atom writes as, under one declaration. */
function rowOf(declaration: Declaration, atom: Atom): Row | undefined {
  const bindings = matchTerms(declaration.outer, atom);
  if (bindings === undefined) return undefined;
  const row: Record<string, unknown> = {};
  for (const [column, term] of declaration.columns) {
    row[column] = hostValue(substitute(term, bindings));
  }
  return row;
}

async function* walk(rows: Iterable<Row> | AsyncIterable<Row>): AsyncGenerator<Row> {
  if (Symbol.asyncIterator in rows) {
    yield* rows as AsyncIterable<Row>;
    return;
  }
  yield* rows as Iterable<Row>;
}

/**
 * A space whose atoms are rows.
 *
 * ```ts
 * const rows = [{ a: "x", b: "y" }];
 * const edges = m.attach("&edges", tableSpace(
 *   { rows: () => rows, insert: (_t, row) => void rows.push(row) },
 *   [[S.bridge, S.edge(V.a, V.b), [S.row, S.edges, [S.a, V.a], [S.b, V.b]]]],
 * ));
 * await edges.match(S.edge(V.from, V.to));     // (edge x y)
 * ```
 *
 * A schema of several declarations answers the union of every shape it admits,
 * which is the equation reading applied one level up.
 */
export function tableSpace(
  source: TableSource,
  schema: Iterable<Term>,
): SpaceProvider {
  const declarations = [...schema].map(declarationOf);
  if (declarations.length === 0) throw new MettaError("a table space needs a declaration");
  return {
    async *atoms(): AsyncGenerator<Atom> {
      for (const declaration of declarations) {
        for await (const row of walk(source.rows(declaration.table))) {
          const atom = atomOf(declaration, row);
          if (atom !== undefined) yield atom;
        }
      }
    },
    async *match(pattern: Atom): AsyncGenerator<Atom> {
      for (const declaration of declarations) {
        const where = constraintsFor(declaration, pattern);
        // A pattern this shape does not admit contributes nothing, which is
        // what makes a schema of several shapes cost only the ones that apply.
        if (where === undefined) continue;
        for await (const row of walk(source.rows(declaration.table, where))) {
          const atom = atomOf(declaration, row);
          if (atom !== undefined) yield atom;
        }
      }
    },
    ...(source.insert === undefined
      ? {}
      : {
          async add(atom: Atom): Promise<void> {
            const admitting = declarations.filter((each) => rowOf(each, atom) !== undefined);
            if (admitting.length === 0) {
              throw new MettaError(`no declaration in this schema admits ${atom.text}`);
            }
            if (admitting.length > 1) {
              throw new MettaError(
                `${atom.text} is admitted by ${admitting.length} shapes ` +
                  `(${admitting.map((each) => each.outer.text).join(", ")}); storing it ` +
                  `once per shape would invent an occurrence, so this refuses`,
              );
            }
            const only = admitting[0] as Declaration;
            await source.insert?.(only.table, rowOf(only, atom) as Row);
          },
        }),
    ...(source.remove === undefined
      ? {}
      : {
          async remove(atom: Atom): Promise<boolean> {
            for (const declaration of declarations) {
              const row = rowOf(declaration, atom);
              if (row === undefined) continue;
              if (await source.remove?.(declaration.table, row)) return true;
            }
            return false;
          },
        }),
    ...(source.clear === undefined
      ? {}
      : {
          async clear(): Promise<void> {
            for (const declaration of declarations) await source.clear?.(declaration.table);
          },
        }),
  };
}

/**
 * A table source over plain arrays of rows, one array per table.
 *
 * The simplest source there is, and the one a test wants: it holds the rows in
 * memory and honours the constraints by filtering.
 */
export function arrayTables(tables: Record<string, Row[]>): Required<TableSource> {
  const held = (table: string): Row[] => {
    const rows = tables[table];
    if (rows === undefined) throw new MettaError(`no table named ${table}`);
    return rows;
  };
  const agrees = (row: Row, where: Row | undefined): boolean =>
    where === undefined || Object.entries(where).every(([name, value]) => row[name] === value);
  return {
    rows: (table: string, where?: Row): Row[] => held(table).filter((row) => agrees(row, where)),
    insert: (table: string, row: Row): void => {
      held(table).push(row);
    },
    remove: (table: string, row: Row): boolean => {
      const rows = held(table);
      const at = rows.findIndex((each) => agrees(each, row) && agrees(row, each));
      if (at < 0) return false;
      rows.splice(at, 1);
      return true;
    },
    clear: (table: string): void => {
      held(table).length = 0;
    },
  };
}

/** Build one declaration without writing the atom by hand. */
export function bridge(outer: Term, table: string, columns: Record<string, Term>): Atom {
  return expr(
    sym("bridge"),
    toAtom(outer),
    expr(
      sym("row"),
      sym(table),
      ...Object.entries(columns).map(([name, term]) => expr(sym(name), toAtom(term))),
    ),
  );
}
