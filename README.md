# PeTTa in Node

The PeTTa engine runs inside a Node process here, in that process rather than
behind a socket, over [swipl-wasm](https://github.com/SWI-Prolog/npm-swipl-wasm)
8.0.6, which is the SWI-Prolog organisation's own WebAssembly build of SWI
10.1.13. There is nothing to install besides npm packages: no SWI on the
machine, no compiler, no shared library.

It exists to prove the engine's seams carry a second language. The Python
library in `python/` was the only consumer of the host contract, and a contract
with one consumer is a description of that consumer. This binding rides the same
published surface and answers the same conformance corpus.

## Getting started

```sh
cd bindings/node
npm ci
npm test
```

Then, from anywhere in the checkout:

```js
import { boot } from "./bindings/node/index.mjs";

const petta = await boot();

// One group of answers per `!` directive, in source order.
const [answers] = petta.run("(= (double $x) (* $x 2))\n!(double 21)");
console.log(answers.map(String)); // [ '42' ]
```

`load()` takes a path instead of source. It mounts the file's directory into
the engine's virtual filesystem at the same absolute path first, so a relative
`import!` beside it resolves exactly as it does on disk, and it goes through
the engine's own loader, so a second `load()` of the same file replaces that
file's definitions rather than doubling them:

```js
const [collapsed] = petta.load("./bindings/node/example/streaming.metta");
console.log(collapsed.map(String)); // [ '(1 2 3)' ]
```

## Answers arrive one at a time

`stream()` hands back a JavaScript async iterator, so `for await` and `break`
are what you write, and the engine computes an answer only when you ask for the
next one. That is why an unbounded generator is usable:

```js
petta.run("(= (from $n) (superpose ($n (from (+ $n 1)))))");

for await (const answer of petta.stream("(from 1)")) {
  console.log(answer.text);
  if (Number(answer.wire[1]) === 5) break;   // the sixth is never computed
}
```

Behind it is an SWI engine, a goal suspended between answers. Tarau states the
rule the shape follows: an engine "can, if asked, resume" after yielding an
answer, and a binding wraps that ask-and-resume pair in the host's own stream
abstraction so answers compose with the host's own machinery (*A Hitchhiker's
Guide to Reinventing a Prolog Machine*, ICLP 2017, section 4.5, which wraps it
in a Java Spliterator). JavaScript's abstraction is the async iterator.

Leaving the loop early closes the cursor: `for await` calls the iterator's
`return()` on `break`, and that destroys the engine. Two streams may be open at
once and stepped in any order, which is the reason an SWI engine holds the
query rather than swipl-wasm's own query object: the raw one refuses a pull
that is not the innermost, with `Attempt to access not innermost query`.

## Nothing reaches your console

An embedded engine that prints is printing over whatever the host was saying,
so this one does not. A program's own `println!` is buffered and
`petta.drainOutput()` hands it over; an engine error is raised as a
`PettaError` carrying the engine's own message, never written out. Pass
`boot({ verbose: true })` when you want the engine's trace, and both streams
go to the console as well as into the buffers.

That took work rather than being free: swipl-wasm writes every Prolog
exception to the console before handing it back, and offers no switch, so
`bridge.pl` catches inside the engine and the outcome crosses as data.

## Numbers

A MeTTa integer arrives as a JavaScript `BigInt` and a MeTTa float as a
`number`. That looks heavier than it needs to be until you notice the engine
answers `False` to `(== 2 2.0)`: MeTTa has two numeric types and JavaScript's
`number` is one of them, so `2` and `2.0` would be the same value on this side
and the binding would corrupt one of them silently. `BigInt` and `number` are
the pair JavaScript does have, and they line up exactly with Prolog's integer
and float.

The one thing this host has no type for is a rational, and it says so:

```
the number 1r3 has no JavaScript type; a rational crosses as its Prolog
spelling and this host has nothing to hold it in
```

## What this build does not carry

Four platform libraries are absent from a WebAssembly SWI and there is no
substitute for any of them, so the capabilities that rest on them are absent
too. `boot()` reports them on `petta.refusals`, each with what it costs, and
**raises on any refusal it does not name**, so an absence cannot creep in
quietly:

| missing | in | costs |
|---|---|---|
| `library(thread)` | `src/metta.pl` | `concurrent_maplist`, so `jobs/2`. The build is single-threaded. |
| `library(time)` | `src/metta.pl` | `alarm/4`, so `metta_timeout/2`. Bound the pull from the host instead. |
| `library(process)` | `src/metta.pl` | subprocess operations; a WebAssembly instance has none to start. |
| `library(process)` | `lib/lib_gitimport.pl` | `import!` from git, which shells out. |

Everything else loads. Tabling is present, `library(sha)` is present, and the
engine parses, translates and evaluates end to end.

## What the binding calls

Only published surface. `bindings/node/bridge.pl` is this binding's Prolog half
and every engine predicate it calls carries an `ext_point_kind/2` in
`src/ext_points.pl` as a `service` or a `host_service`, or is a MeTTa builtin
that `builtin_fun/1` enumerates. That is checked rather than promised:
`tests/prolog/static_checks.pl`'s
`a_host_binding_calls_only_published_surface` walks every host transport with
SWI's own `prolog_walk_code/1`, so a call that reaches an internal fails the
gate naming the pair. What it calls:

- `parse_metta_source/2`, `prepare_parsed_forms/1`, `process_form/3` to run a
  program, in the order the engine's own loader runs them
- `import_when/4`, `replacing_previous_load/4`,
  `load_imported_metta_file_impl/3`, `with_source_load/3`,
  `read_metta_source/2` for a file, so both doors record the load under the
  same canonical path and a reload replaces rather than doubles
- `space_module/2` and `with_metta_module/2` to run in a named space
- `swrite/2` for an answer's text, because the engine's writer is the only
  authority on how an atom spells
- `eval/2`, the MeTTa builtin, as the answer enumerator a cursor resumes
- `catch_recover/2` for the working-directory probe

## The conformance kit

`kit/corpus.json` lists MeTTa programs and wire atoms and records no expected
answers, because `python/tests/test_node_binding.py` runs the same cases
through the shipped Python host in the same moment and compares the two. That
test is
`test_a_second_language_binding_passes_the_same_conformance_kit`, and it is
what says the seam has two consumers rather than one.

`kit/run.mjs` is the runner; it prints the whole report as JSON, so:

```sh
node kit/run.mjs | head -40
```

## Layout

| file | what it is |
|---|---|
| `index.mjs` | the binding: boot, run, load, stream, and the codec |
| `bridge.pl` | its Prolog half: the codec, the program pipeline, the cursor |
| `kit/corpus.json` | the conformance cases |
| `kit/run.mjs` | the runner that answers them |
| `test/binding.test.mjs` | `node --test` |
| `example/streaming.metta` | the program the README and the tests run |
