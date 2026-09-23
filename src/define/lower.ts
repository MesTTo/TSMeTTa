/**
 * Purpose: lower an ordinary TypeScript function body into ONE MeTTa
 *   equation, by parsing the function's own source.
 * Assumes:
 *   - types are erased before `Function.prototype.toString()` ever runs, both
 *     under `tsc` and under Node's own type stripping, so what is parsed here
 *     is always plain ECMAScript and never TypeScript
 *   - the `typescript` package is NEVER a runtime dependency: TypeScript 7
 *     ships no Strada API, so `ts.createSourceFile` and everything on it is
 *     absent there. `acorn` is the parser, it is pure JavaScript, and it needs
 *     no `eval` or `new Function`, which is what keeps the lowering
 *     CSP-clean for a browser deployment
 *     [source: acorn 8.18.0, MIT, zero dependencies]
 * Guarantees:
 *   - the whole body becomes one term, so a call costs ZERO host crossings:
 *     the arithmetic, the comparisons and the recursion are all the engine's
 *   - a construct with no MeTTa meaning refuses at DEFINITION time, naming the
 *     construct and the remedy, rather than at the first call
 *   - a free identifier resolves only against the function's own name, the
 *     names already registered with this engine, and an explicitly supplied
 *     scope; anything else refuses, which is what makes a minified build fail
 *     loudly instead of silently building the wrong term
 *   - an explicit scope contributes only its own properties
 *     [tested: "does not resolve inherited names from an explicit lowering scope";
 *     commit=f79cfa2133ee8691c8c21b8a6a59928ddbad7352]
 *   - a null literal is MeTTa's empty expression, not a symbol whose text only
 *     resembles it [tested: "lowers null to the empty expression";
 *     commit=191f969429df26e26769391d44234f20af481fff]
 *   - unary minus over a number or bigint literal remains one literal atom,
 *     so data position does not depend on a later reduction [tested: "folds
 *     unary minus over number and bigint literals into literal atoms";
 *     commit=cb81a53d7e040cea283df784b097f95f2868a866]
 *   - a body mentions atoms through the factories and words by the names the
 *     package exports them under, S, V, fn, G, float, WORD_HEADS,
 *     OPERATOR_HEADS and WORD_CONSTANTS, each lowering to the atom the same
 *     spelling builds at run time, after the engine's own heads and under any
 *     local binding of the same name; an array pattern is a pattern let and a
 *     switch is a case whose default is tried last [tested: "a lowered body
 *     mentions"; commit=a9632282fd7f0cbd697a1d2ac353b6888dd9d849]
 * Decides: the lowering is a TRANSLATION, not an interpretation. `===` becomes
 *   the engine's `==`, `%` becomes the engine's `%`, and a call becomes an
 *   expression, so what runs is MeTTa and the TypeScript was only notation.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { parse } from "acorn";
import type {
  BlockStatement,
  Expression as AcornExpression,
  Function as AcornFunction,
  Node,
  Pattern,
  Statement,
  VariableDeclaration,
} from "acorn";

import { type Atom, type Term, byCodePoint, expr, exprOf, float, sym, toAtom, variable } from "../atom.ts";
import { CompileError, MettaError, nearest } from "../errors.ts";
import { mettaName } from "../naming.ts";
import { OPERATOR_HEADS, WORD_CONSTANTS, WORD_HEADS } from "../words.ts";

/** What the lowering may reach for beside the function's own parameters. */
export interface LowerScope {
  /** The head this function installs under, so recursion resolves. */
  readonly selfName: string;
  /** The identifier the function calls itself by, when it has one. */
  readonly selfIdentifier?: string;
  /** Whether a head is already known to the engine. */
  readonly knows: (name: string) => boolean;
  /** Values a caller supplied by name, for a closure the source cannot reach. */
  readonly scope?: Readonly<Record<string, Term>>;
  /** Every head the engine knows, so a refusal can name the nearest one. */
  readonly declared?: () => Iterable<string>;
  /**
   * Where a resolved free identifier is recorded, when a caller wants them.
   *
   * `resolve` is the ONE place a name the body's own source cannot bind is
   * decided, so collecting here is the same answer the lowering acts on rather
   * than a second walk that could disagree with it.
   */
  readonly free?: Set<string>;
}

/** A lowered body: the head's parameters, the term they reduce to, and the names it reached. */
export interface Lowered {
  readonly params: readonly Atom[];
  readonly body: Atom;
  /** Every name the body reached that its own source could not bind, sorted. */
  readonly free: readonly string[];
}

function refuse(what: string, remedy: string): never {
  throw new CompileError(`${what}; ${remedy}`);
}

// The operators that ARE engine heads, so the body's arithmetic and its
// comparisons become the engine's own rather than a host crossing per step.
// `===` and `!==` map to MeTTa's `==` and `!=`: JavaScript's loose pair has no
// MeTTa meaning at all, and a body that used one would be asking for a
// coercion the engine does not have.
const BINARY: Readonly<Record<string, string>> = {
  "+": "+",
  "-": "-",
  "*": "*",
  "/": "/",
  "%": "%",
  "===": "==",
  "!==": "!=",
  "<": "<",
  "<=": "<=",
  ">": ">",
  ">=": ">=",
  "**": "pow-math",
};

const LOGICAL: Readonly<Record<string, string>> = {
  "&&": "and",
  "||": "or",
};

/**
 * The naming factories a lowered body MENTIONS atoms through, by the names this
 * package exports them under.
 *
 * `Function.prototype.toString()` answers a function's source and never its
 * bindings, so the exported NAME is the only binding the lowering can read: a
 * body that says `S.result` means the symbol `result`, `V.x` the variable `$x`
 * and `fn.carAtom(x)` the expression `(car-atom $x)`, exactly as the same
 * spellings build them at run time. A local binding of the same name shadows
 * the factory, the way every binding shadows what is outside it.
 */
const FACTORIES = new Set(["S", "V", "fn"]);

/** The one string a literal or a hole-free template spells, if that is what `node` is. */
function literalText(node: AcornExpression | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (node.type === "Literal" && typeof (node as { value: unknown }).value === "string") {
    return (node as { value: string }).value;
  }
  if (node.type === "TemplateLiteral") {
    const template = node as { expressions: readonly unknown[]; quasis: readonly { value: { cooked: string } }[] };
    if (template.expressions.length === 0) return template.quasis[0]?.value.cooked;
  }
  return undefined;
}

/** A factory named by an unshadowed identifier: `S`, `V` or `fn`. */
function factoryOf(node: AcornExpression, bindings: Bindings): string | undefined {
  if (node.type !== "Identifier") return undefined;
  const name = (node as { name: string }).name;
  return FACTORIES.has(name) && !bindings.has(name) ? name : undefined;
}

/** The atom one factory spells for one name, through the same map the factory applies. */
function spelled(factory: string, name: string, exact: boolean): Atom {
  if (factory === "V") return variable(name);
  if (exact) return sym(name);
  if (factory === "fn" && Object.hasOwn(OPERATOR_HEADS, name)) {
    return sym((OPERATOR_HEADS as Readonly<Record<string, string>>)[name] as string);
  }
  return sym(mettaName(name));
}

/**
 * The atom a factory MENTION names, or undefined when `node` is not one.
 *
 * `S.x` and `S["x"]` map the name as the attribute and bracket doors do,
 * `S("x")` is the call door and keeps it exact, and `S.x.atom` is the symbol
 * `S.x` already is.
 */
function mentioned(node: AcornExpression, bindings: Bindings): Atom | undefined {
  if (node.type === "CallExpression") {
    const call = node as { callee: AcornExpression; arguments: readonly AcornExpression[] };
    const factory = factoryOf(call.callee, bindings);
    const name = literalText(call.arguments[0]);
    return factory !== undefined && name !== undefined && call.arguments.length === 1
      ? spelled(factory, name, true)
      : undefined;
  }
  if (node.type !== "MemberExpression") return undefined;
  const member = node as { object: AcornExpression; property: AcornExpression; computed: boolean };
  const property = member.computed
    ? literalText(member.property)
    : (member.property as { name?: string }).name;
  if (property === undefined) return undefined;
  if (!member.computed && property === "atom") {
    const named = mentioned(member.object, bindings);
    if (named !== undefined) return named;
  }
  const factory = factoryOf(member.object, bindings);
  return factory === undefined ? undefined : spelled(factory, property, false);
}

/** The literal a `G(...)` or `float(...)` call grounds, as its atom. */
function grounded(name: string, argument: AcornExpression | undefined, scope: LowerScope): Atom {
  const literal = argument?.type === "UnaryExpression" &&
    (argument as { operator: string }).operator === "-" &&
    (argument as { argument: AcornExpression }).argument.type === "Literal"
    ? -((argument as { argument: { value: number } }).argument.value)
    : argument?.type === "Literal"
      ? (argument as { value: unknown }).value
      : undefined;
  if (name === "float" && typeof literal === "number") return float(literal);
  if (
    name === "G" &&
    (typeof literal === "string" || typeof literal === "number" || typeof literal === "bigint" || typeof literal === "boolean")
  ) {
    return toAtom(literal);
  }
  refuse(
    `${scope.selfName} grounds something that is not a literal with ${name}(...)`,
    "a lowered body is one term and holds no host object; ground a string, number, bigint or boolean literal, or pass a value in { scope }",
  );
}

/** The bindings in force at one point of the walk: parameters, then `const`s. */
type Bindings = ReadonlyMap<string, Atom>;

/**
 * The source of a function, as ECMAScript.
 *
 * A method shorthand (`f() {}`) and a bare `async`/generator function are not
 * complete programs on their own, so the text is wrapped before parsing. The
 * wrapper is chosen by what the source starts with, which is enough because
 * `toString()` always answers a function's own source and never a fragment of
 * something else.
 */
function parseFunction(source: string): AcornFunction {
  const attempts = [source, `(${source})`, `({${source}})`];
  for (const text of attempts) {
    let program: Node;
    try {
      program = parse(text, { ecmaVersion: "latest", sourceType: "script" }) as Node;
    } catch {
      continue;
    }
    const found = findFunction(program);
    if (found !== null) return found;
  }
  refuse(
    "this function's own source did not parse as ECMAScript",
    "define it with a generator body, which needs no parser, or hand the body to op",
  );
}

function findFunction(node: Node): AcornFunction | null {
  const kind = node.type;
  if (kind === "FunctionDeclaration" || kind === "FunctionExpression" || kind === "ArrowFunctionExpression") {
    return node as AcornFunction;
  }
  for (const value of Object.values(node as unknown as Record<string, unknown>)) {
    if (value === null || typeof value !== "object") continue;
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      if (child === null || typeof child !== "object") continue;
      if (typeof (child as Node).type !== "string") continue;
      const found = findFunction(child as Node);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * Lower a function into one equation body.
 *
 * The statement list is lowered in CONTINUATION order, which is what turns
 * imperative control flow into one expression: `const x = e` becomes a `let`
 * around everything after it, and an `if` without an `else` becomes an `if`
 * whose else branch is everything after it.
 */
export function lower(target: (...args: never[]) => unknown, given: LowerScope): Lowered {
  // The free set rides the scope so `resolve` can record into it without a
  // second parameter on every lowering function between here and there.
  const free = given.free ?? new Set<string>();
  const scope: LowerScope = { ...given, free };
  const parsed = parseFunction(Function.prototype.toString.call(target));
  const bindings = new Map<string, Atom>();
  const params: Atom[] = [];
  parsed.params.forEach((param: Pattern, index: number) => {
    if (param.type !== "Identifier") {
      refuse(
        `parameter ${String(index + 1)} of ${scope.selfName} is a ${param.type}`,
        "give the head plain parameters; a default, a rest or a destructuring has no place in a MeTTa head",
      );
    }
    const name = (param as { name: string }).name;
    const atom = variable(name);
    bindings.set(name, atom);
    params.push(atom);
  });

  const body = parsed.body;
  const term =
    body.type === "BlockStatement"
      ? lowerBlock((body as BlockStatement).body, bindings, scope)
      : lowerExpression(body as AcornExpression, bindings, scope);
  // The free names are ANSWERED, as `freeVariables` and in the order the
  // effect and unresolved lists follow, so the order is data. A JavaScript
  // identifier may hold an astral character, where the default sort's UTF-16
  // units and a code-point order part.
  return { params, body: term, free: [...free].sort(byCodePoint) };
}

function lowerBlock(statements: readonly Statement[], bindings: Bindings, scope: LowerScope): Atom {
  if (statements.length === 0) {
    refuse(
      `${scope.selfName} has an empty body`,
      "a MeTTa equation answers a term, so the body needs a return",
    );
  }
  return lowerStatements(statements, 0, bindings, scope);
}

function lowerStatements(
  statements: readonly Statement[],
  at: number,
  bindings: Bindings,
  scope: LowerScope,
): Atom {
  if (at >= statements.length) {
    refuse(
      `a branch of ${scope.selfName} runs off the end of the body`,
      "every branch of a MeTTa equation answers a term, so give it a return",
    );
  }
  const statement = statements[at] as Statement;
  switch (statement.type) {
    case "ReturnStatement": {
      const argument = (statement as { argument: AcornExpression | null | undefined }).argument;
      if (argument === null || argument === undefined) {
        refuse(
          `${scope.selfName} returns nothing on one branch`,
          "an equation answers a term; return the atom the branch means, or `Empty()` for no answer",
        );
      }
      return lowerExpression(argument, bindings, scope);
    }
    case "VariableDeclaration": {
      const declaration = statement as VariableDeclaration;
      if (declaration.kind === "var") {
        refuse(
          `${scope.selfName} declares a var`,
          "use const, which is what a MeTTa let is: one name, one value, one scope",
        );
      }
      if (declaration.declarations.length !== 1) {
        refuse(
          `${scope.selfName} declares more than one name in one statement`,
          "write one const per statement, so each one lowers to its own let",
        );
      }
      const declarator = declaration.declarations[0]!;
      if (declarator.init === null || declarator.init === undefined) {
        refuse(
          `${scope.selfName} declares a name with no value`,
          "a MeTTa let needs the value the name stands for",
        );
      }
      // A plain name is `(let $x value ...)`; an array pattern is MeTTa's own
      // pattern let, `const [a, [b, c]] = v` being `(let ($a ($b $c)) v ...)`.
      const value = lowerExpression(declarator.init, bindings, scope);
      const inner = new Map(bindings);
      const pattern = patternOf(declarator.id, inner, scope);
      return expr(sym("let"), pattern, value, lowerStatements(statements, at + 1, inner, scope));
    }
    case "SwitchStatement":
      return lowerSwitch(statement, statements.slice(at + 1), bindings, scope);
    case "IfStatement": {
      const branch = statement as {
        test: AcornExpression;
        consequent: Statement;
        alternate: Statement | null | undefined;
      };
      const test = lowerExpression(branch.test, bindings, scope);
      const then = lowerBranch(branch.consequent, statements, at + 1, bindings, scope);
      const otherwise =
        branch.alternate === null || branch.alternate === undefined
          ? lowerStatements(statements, at + 1, bindings, scope)
          : lowerBranch(branch.alternate, statements, at + 1, bindings, scope);
      return expr(sym("if"), test, then, otherwise);
    }
    case "BlockStatement":
      return lowerStatements(
        [...(statement as BlockStatement).body, ...statements.slice(at + 1)],
        0,
        bindings,
        scope,
      );
    case "ExpressionStatement":
      refuse(
        `${scope.selfName} has a statement whose value is thrown away`,
        "an equation is one expression: every statement in it has to contribute, so bind it with const or return it",
      );
      break;
    case "ThrowStatement":
      refuse(
        `${scope.selfName} throws`,
        "MeTTa signals with an (Error ...) atom rather than an exception; return one",
      );
      break;
    default:
      break;
  }
  refuse(
    `${scope.selfName} uses a ${statement.type}, which has no MeTTa meaning`,
    "write the body as a generator, where a goal is a yield*, or register it with op so it runs as host code",
  );
}

/**
 * A declaration's binding pattern, binding each name it introduces.
 *
 * An identifier is a variable and an array pattern is an expression of
 * patterns, so a MeTTa let's structural binding is TypeScript's own
 * destructuring. A hole, a rest element and an object pattern have no MeTTa
 * pattern to be, and refuse.
 */
function patternOf(node: Pattern, bound: Map<string, Atom>, scope: LowerScope): Atom {
  if (node.type === "Identifier") {
    const name = (node as { name: string }).name;
    const atom = variable(name);
    bound.set(name, atom);
    return atom;
  }
  if (node.type === "ArrayPattern") {
    const elements = (node as { elements: readonly (Pattern | null)[] }).elements;
    return exprOf(
      elements.map((element) => {
        if (element === null || element.type === "RestElement") {
          refuse(
            `${scope.selfName} destructures with a ${element === null ? "hole" : "rest element"}`,
            "a MeTTa pattern names every position of the expression it matches; name each one",
          );
        }
        return patternOf(element, bound, scope);
      }),
    );
  }
  refuse(
    `${scope.selfName} destructures an ${node.type}`,
    "a MeTTa let binds an expression pattern, which is an array pattern here: const [a, b] = pair",
  );
}

/**
 * A `switch` as MeTTa's `case`: each label a pattern, each clause its arm.
 *
 * Labels with no statements share the next clause's arm, a clause ending in
 * `break` continues with what follows the switch, and `default` becomes the
 * catch-all arm, placed last because `case` tries its arms in order where
 * `switch` consults `default` only after every label. With no `default`, what
 * follows the switch is the catch-all, which is where TypeScript goes when no
 * label matched.
 */
function lowerSwitch(
  statement: Statement,
  after: readonly Statement[],
  bindings: Bindings,
  scope: LowerScope,
): Atom {
  const written = statement as {
    discriminant: AcornExpression;
    cases: readonly { test: AcornExpression | null; consequent: readonly Statement[] }[];
  };
  const subject = lowerExpression(written.discriminant, bindings, scope);
  const arms: Atom[] = [];
  let otherwise: Atom | undefined;
  let waiting: (AcornExpression | null)[] = [];
  for (const clause of written.cases) {
    waiting.push(clause.test);
    if (clause.consequent.length === 0) continue;
    const last = clause.consequent[clause.consequent.length - 1] as Statement;
    const body =
      last.type === "BreakStatement"
        ? lowerStatements([...clause.consequent.slice(0, -1), ...after], 0, bindings, scope)
        : lowerStatements(clause.consequent, 0, bindings, scope);
    for (const test of waiting) {
      if (test === null) otherwise = body;
      else arms.push(expr(lowerExpression(test, bindings, scope), body));
    }
    waiting = [];
  }
  if (waiting.length > 0) {
    refuse(
      `the last labels of a switch in ${scope.selfName} have no statements`,
      "give the final clause the term it answers",
    );
  }
  const fallback = otherwise ?? (after.length > 0 ? lowerStatements(after, 0, bindings, scope) : undefined);
  if (fallback === undefined) {
    refuse(
      `a switch in ${scope.selfName} has no default and nothing follows it`,
      "every branch of a MeTTa equation answers a term; add `default: return Empty()` for no answer",
    );
  }
  arms.push(expr(variable("_"), fallback));
  return expr(sym("case"), subject, exprOf(arms));
}

/** A branch's own statements, with what follows the `if` appended when it falls through. */
function lowerBranch(
  branch: Statement,
  after: readonly Statement[],
  at: number,
  bindings: Bindings,
  scope: LowerScope,
): Atom {
  const inner = branch.type === "BlockStatement" ? (branch as BlockStatement).body : [branch];
  return lowerStatements([...inner, ...after.slice(at)], 0, bindings, scope);
}

function lowerExpression(node: AcornExpression, bindings: Bindings, scope: LowerScope): Atom {
  switch (node.type) {
    case "Literal": {
      const value = (node as { value: unknown }).value;
      if (value === null) return expr();
      if (typeof value === "bigint" || typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
        return toAtom(value);
      }
      refuse(
        `${scope.selfName} uses a literal this side cannot lower (${String(value)})`,
        "a regular expression or a template with a hole has no MeTTa spelling; build the atom instead",
      );
      break;
    }
    case "Identifier": {
      const name = (node as { name: string }).name;
      const bound = bindings.get(name);
      if (bound !== undefined) return bound;
      if (Object.hasOwn(WORD_CONSTANTS, name)) return WORD_CONSTANTS[name] as Atom;
      return resolve(name, scope, "a value");
    }
    case "BinaryExpression": {
      const binary = node as { operator: string; left: AcornExpression; right: AcornExpression };
      const head = BINARY[binary.operator];
      if (head === undefined) {
        refuse(
          `${scope.selfName} uses the operator ${binary.operator}`,
          `the engine has no head for it; the ones it has are ${Object.keys(BINARY).join(" ")}`,
        );
      }
      return expr(
        sym(head),
        lowerExpression(binary.left, bindings, scope),
        lowerExpression(binary.right, bindings, scope),
      );
    }
    case "LogicalExpression": {
      const logical = node as { operator: string; left: AcornExpression; right: AcornExpression };
      const head = LOGICAL[logical.operator];
      if (head === undefined) {
        refuse(
          `${scope.selfName} uses the operator ${logical.operator}`,
          "MeTTa has and and or; `??` has no MeTTa meaning because MeTTa has no null",
        );
      }
      return expr(
        sym(head),
        lowerExpression(logical.left, bindings, scope),
        lowerExpression(logical.right, bindings, scope),
      );
    }
    case "UnaryExpression": {
      const unary = node as { operator: string; argument: AcornExpression };
      // Acorn and ESTree keep a leading sign above the literal. Fold at that
      // seam, as ESLint does when it needs the signed constant's value, rather
      // than turning literal DATA into a runnable subtraction expression.
      // [source: Acorn@5bd50cd72dc9ddb1856ed13cfa8a1c4884be917a
      // acorn/src/expression.js:611-619 and
      // ESLint@2417cad57d7d1bc4cf3ecf0f0575cfb10ff2011c
      // lib/rules/radix.js:47-62; commit=cb81a53d7e040cea283df784b097f95f2868a866]
      if (unary.operator === "-" && unary.argument.type === "Literal") {
        const value = (unary.argument as { value: unknown }).value;
        if (typeof value === "number") return toAtom(-value);
        if (typeof value === "bigint") return toAtom(-value);
      }
      const inner = lowerExpression(unary.argument, bindings, scope);
      if (unary.operator === "-") return expr(sym("-"), toAtom(0), inner);
      if (unary.operator === "+") return inner;
      if (unary.operator === "!") return expr(sym("not"), inner);
      refuse(
        `${scope.selfName} uses the unary operator ${unary.operator}`,
        "MeTTa has negation as (- 0 x) and not; the rest have no meaning here",
      );
      break;
    }
    case "ConditionalExpression": {
      const conditional = node as {
        test: AcornExpression;
        consequent: AcornExpression;
        alternate: AcornExpression;
      };
      return expr(
        sym("if"),
        lowerExpression(conditional.test, bindings, scope),
        lowerExpression(conditional.consequent, bindings, scope),
        lowerExpression(conditional.alternate, bindings, scope),
      );
    }
    case "CallExpression": {
      const call = node as { callee: AcornExpression; arguments: readonly AcornExpression[] };
      const args = (): Atom[] => call.arguments.map((argument) => lowerExpression(argument, bindings, scope));
      // A mention used as a value: S("isPrime"), V("x"), fn("assertEqual").
      const exact = mentioned(node, bindings);
      if (exact !== undefined) return exact;
      // A mention APPLIED: S.pair(a, b), fn.carAtom(x), S["x"](...), S("x")(...).
      const applied = mentioned(call.callee, bindings);
      if (applied !== undefined) return expr(applied, ...args());
      if (call.callee.type !== "Identifier") {
        refuse(
          `${scope.selfName} calls something that is not a plain name`,
          "a MeTTa head is a symbol; call a defined name, a word such as If or carAtom, a mention such as S.f(x), or register the target with op",
        );
      }
      const name = (call.callee as { name: string }).name;
      if (!bindings.has(name)) {
        switch (name) {
          case "G":
          case "float":
            return grounded(name, call.arguments[0], scope);
          case "e":
            return exprOf(args());
          case "nil":
            return expr();
          case "neg":
            return expr(sym(OPERATOR_HEADS.sub), toAtom(0), ...args());
          default:
            break;
        }
      }
      const head = bindings.has(name) ? (bindings.get(name) as Atom) : resolve(name, scope, "a head");
      return expr(head, ...args());
    }
    case "ArrayExpression": {
      const array = node as { elements: readonly (AcornExpression | null)[] };
      const items = array.elements.map((element) => {
        if (element === null) {
          refuse(`${scope.selfName} has a hole in an array`, "a MeTTa expression has no holes");
        }
        return lowerExpression(element, bindings, scope);
      });
      return exprOf(items);
    }
    case "ParenthesizedExpression":
      return lowerExpression((node as { expression: AcornExpression }).expression, bindings, scope);
    case "MemberExpression": {
      const named = mentioned(node, bindings);
      if (named !== undefined) return named;
      refuse(
        `${scope.selfName} reads a property`,
        "a lowered body is MeTTa, and MeTTa has no property access; mention an atom as S.name or V.name, take a value apart with carAtom, or run the body as an op",
      );
      break;
    }
    case "AwaitExpression":
      refuse(
        `${scope.selfName} awaits`,
        "a lowered body runs entirely in the engine, where there is nothing to await; register it with op instead",
      );
      break;
    default:
      break;
  }
  refuse(
    `${scope.selfName} uses a ${node.type}, which has no MeTTa meaning`,
    "write the body as a generator, where a goal is a yield*, or register it with op so it runs as host code",
  );
}

/**
 * A free name, resolved against the three places a lowered body may reach.
 *
 * The function's own name is recursion; a head the engine already knows is an
 * ordinary call; a value the caller supplied by name is a closure this side
 * could not have read. Everything else refuses, and that refusal is what makes
 * a minified build say so at definition time rather than build a term out of
 * `t` and `n`.
 */
function resolve(name: string, scope: LowerScope, position: string): Atom {
  if (name === scope.selfIdentifier || name === scope.selfName) return sym(scope.selfName);
  scope.free?.add(name);
  if (scope.scope !== undefined && Object.hasOwn(scope.scope, name)) {
    return toAtom(scope.scope[name] as Term);
  }
  const mapped = mettaName(name);
  if (scope.knows(mapped)) return sym(mapped);
  if (scope.knows(name)) return sym(name);
  // A word of the word door, read by the name this package exports it under,
  // after the engine's own heads so a program's definition of `add` wins.
  for (const words of [OPERATOR_HEADS, WORD_HEADS] as readonly Readonly<Record<string, string>>[]) {
    if (Object.hasOwn(words, name)) return sym(words[name] as string);
  }
  // A refusal computes its remedy: an unknown head is usually a typo of one
  // that IS declared, and saying which turns a refusal into a fix.
  const near = scope.declared === undefined ? undefined : nearest(mapped, scope.declared());
  const looksLike = near === undefined ? "" : `; nearest declared: ${near}`;
  refuse(
    `${scope.selfName} reaches ${name} as ${position}, and nothing here defines it${looksLike}`,
    `define it first, register it with op, or pass it in { scope: { ${name} } }`,
  );
}
