/**
 * Purpose: the README's subpath examples, kept runnable, so the page cannot
 *   show a call the package does not have.
 * Guarantees: every line the README quotes from here prints what the README
 *   says it prints [tested: test/gallery.test.ts "keeps the README's subpath
 *   examples running"].
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { S, V } from "../src/index.ts";
import { alphaEqual, alphaKey, matchTerms, unifies } from "../src/matching.ts";
import { CastError, CompileError } from "../src/errors.ts";
import { Atomicity, EffectClass } from "../src/vocabularies.ts";

// matching: structure without an engine.
console.log(unifies(S.parent(V.a, S.bob), S.parent(S.tom, V.b)));
const bound = matchTerms(S.parent(V.child, S.bob), S.parent(S.tom, S.bob));
console.log(String(bound?.["child"]));
console.log(alphaEqual(S.f(V.x), S.f(V.y)));
console.log(alphaKey(S.f(V.x)) === alphaKey(S.f(V.y)));

// vocabularies: the engine's closed sets, as unions a typo cannot pass.
console.log(Atomicity.atomicSingle);
console.log(EffectClass.pureStructural);

// errors: one base class, and a code a caller matches instead of prose.
console.log(new CastError("planted").code);
console.log(CompileError.defaultCode);
