/**
 * Purpose: trace a generator body ONCE with symbolic arguments and assemble
 *   the clauses it names, so a body written as TypeScript becomes equations
 *   the engine holds.
 * Assumes:
 *   - an ask is LAZY, so tracing never runs one: the tracer reads its plan and
 *     lowers it
 *   - a JavaScript generator is single-shot, so the walk is linear: goals only
 *     accumulate, and an emission's clause is everything asked above it
 * Guarantees:
 *   - `yield v` EMITS and `yield* g` ASKS, and each spelling has exactly one
 *     meaning wherever it appears, with no rule about position
 *   - a body that branches on a symbolic binding refuses at definition time,
 *     naming the lowering door and the op door as the two remedies, because
 *     an atom refuses to coerce and that refusal is caught here and explained
 *   - a body with several emissions becomes several clauses, each under the
 *     goals asked above it, which is MeTTa's own reading of coexisting
 *     equations
 * Decides: `yield*` asks and binds; it never emits. The design ledger sketched
 *   `yield* descendants(c)` as the recursive emission; here that is
 *   `yield descendants(c)`, which emits the call TERM, and MeTTa's own
 *   evaluation of a clause body produces its answers. One character, and in
 *   exchange every form has one meaning instead of a rule about tail position.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { type Atom, type Term, expr, fresh, space, sym, toAtom } from "../atom.ts";
import { type Plan, type Row, isGoalRequest } from "../answers.ts";
import { PettaError } from "../errors.ts";

/** One goal the body asked, and the name its answer was bound to. */
export interface TracedGoal {
  readonly plan: Plan;
  /** For a reduction, the variable its answer binds; a match binds by pattern. */
  readonly bound?: Atom;
}

/** One equation the body named: the goals asked above it, and what it answers. */
export interface Clause {
  readonly goals: readonly TracedGoal[];
  readonly emission: Atom;
}

/** A body written as a generator: `yield` emits, `yield*` asks. */
export type Body = (...args: never[]) => Generator<unknown, unknown, unknown>;

/**
 * Walk the body once and collect its clauses.
 *
 * The arguments are the head's own variables, so every goal and every emission
 * is written in terms of them and the whole body lowers to equations over the
 * head.
 */
export function trace(body: Body, params: readonly Atom[], name: string): Clause[] {
  const generator = body(...(params as never[]));
  const goals: TracedGoal[] = [];
  const clauses: Clause[] = [];
  let sent: unknown = undefined;
  for (;;) {
    let step: IteratorResult<unknown, unknown>;
    try {
      step = generator.next(sent);
    } catch (error) {
      throw explain(error, name);
    }
    if (step.done === true) {
      if (step.value !== undefined) {
        clauses.push({ goals: [...goals], emission: toAtom(step.value as Term) });
      }
      break;
    }
    const yielded = step.value;
    if (isGoalRequest(yielded)) {
      const plan = yielded.answers.plan;
      if (plan === undefined) {
        throw new PettaError(
          `${name} asked a goal that has no MeTTa spelling (${yielded.answers.description}); ` +
            `a host-side map or filter cannot be lowered into an equation, so ask the ` +
            `plain pattern and transform its answers outside the body`,
          { code: "ERR_METTA_TRACE" },
        );
      }
      if (plan.kind === "match") {
        const row: Row = {};
        for (const variable of plan.vars) row[variable.name] = variable;
        goals.push({ plan });
        sent = row;
      } else {
        // A reduction's answer has no name of its own, so the trace mints one
        // and the goal becomes the `let` that binds it.
        const bound = fresh("ask");
        goals.push({ plan, bound });
        sent = bound;
      }
      continue;
    }
    clauses.push({ goals: [...goals], emission: toAtom(yielded as Term) });
    sent = undefined;
  }
  if (clauses.length === 0) {
    throw new PettaError(
      `${name} emits nothing: a body answers with yield or with return`,
      { code: "ERR_METTA_TRACE" },
    );
  }
  return clauses;
}

/**
 * A clause as one equation body: the goals nest, the emission sits innermost.
 *
 * That is continuation-passing read backwards. A conjunction of matches IS a
 * nest of matches in MeTTa, because each one's template is the rest of the
 * body, so the notation the host wrote as a sequence lowers to the shape the
 * engine already had.
 */
export function nest(clause: Clause): Atom {
  let body = clause.emission;
  for (let index = clause.goals.length - 1; index >= 0; index -= 1) {
    const goal = clause.goals[index] as TracedGoal;
    if (goal.plan.kind === "match") {
      body = expr(sym("match"), space(goal.plan.space), goal.plan.pattern, body);
    } else {
      body = expr(sym("let"), goal.bound ?? fresh("ask"), goal.plan.term, body);
    }
  }
  return body;
}

/**
 * The one refusal worth translating.
 *
 * Branching on a symbolic binding asks JavaScript what an atom means as a
 * number, and an atom refuses to coerce. That refusal is correct and its
 * message is about coercion, so here it becomes the message the author needs:
 * which door does understand a real `if`.
 */
function explain(error: unknown, name: string): unknown {
  const coded = error as { code?: string };
  if (coded.code !== "ERR_METTA_UNSUPPORTED") return error;
  return new PettaError(
    `${name} branched on a binding while it was being traced: a traced body ` +
      `builds one equation, so the values in it are variables and not numbers. ` +
      `Write the comparison as a term (If(gt(x, 0), ...)), or define the body as ` +
      `a plain function so its own source is lowered, where a real if works.`,
    { code: "ERR_METTA_TRACE", cause: error },
  );
}
