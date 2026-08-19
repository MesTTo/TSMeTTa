/**
 * Purpose: embed the PeTTa engine in a Node process over swipl-wasm, run a
 *   MeTTa program, and surface its answers as a JavaScript async iterator.
 * Assumes:
 *   - swipl-wasm 8.0.6 is installed beside this file; it is the SWI-Prolog
 *     organisation's own WebAssembly build of SWI 100113
 *     [source: https://github.com/SWI-Prolog/npm-swipl-wasm]
 *   - boot() sees exactly the refusals REFUSALS names; a seventh one is a new
 *     finding and throws rather than being absorbed
 *     [tested: the node --test suite, "boot refuses only what it names"]
 *   - swipl.prolog.query(goal).next() holds a real choice point, so a query
 *     left open is a suspended goal and not a computed list
 *     [measured 2026-08-20: between(1, inf, X) pulled twice and the process
 *     continued, which an eager drain cannot do]
 * Guarantees:
 *   - stream() computes one answer per pull, and abandoning the loop closes
 *     the cursor through the iterator's own return()
 *     [tested: "an abandoned stream leaves the rest uncomputed"]
 *   - every number crosses exactly: a MeTTa integer arrives as a BigInt and a
 *     MeTTa float as a number, which is the only pair of JavaScript types
 *     that tells 2 from 2.0 apart, and the engine does tell them apart
 *     [measured 2026-08-20: (== 2 2.0) answers False]
 *   - a value JavaScript has no type for (a rational) is refused by name
 *   - nothing reaches the host's console unless boot() was asked for verbose;
 *     an engine error is raised here and a program's output is buffered
 *     [tested: "an error is raised rather than printed"]
 * Owns: one WebAssembly instance per boot(), and one Prolog engine per open
 *   stream, released by close() on the iterator or on exhaustion.
 * Decides: cursors are addressed by integer, because the WebAssembly value
 *   conversion renders every Prolog blob as the same opaque {"$t":"b"} and a
 *   host cannot hold a handle it cannot tell apart.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { createRequire } from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const VIRTUAL_ROOT = "/petta";

// The directories src/metta.pl reaches for while it loads: its own, the
// standard library, the host deciders it globs, and the backend deciders.
const ENGINE_DIRS = ["src", "lib", "hosts", "backends"];

/**
 * What the WebAssembly build does not carry, and what each absence costs.
 * Measured 2026-08-20 against swipl-wasm 8.0.6. Every line is a platform
 * library the build genuinely has no substitute for, so each one is a
 * capability this host does without and not something to route around; the
 * engine loads and evaluates without all four.
 *
 * A refusal the table does not name raises out of boot(). An unnamed one is a
 * finding, and absorbing it is how a capability goes missing quietly.
 *
 * The entry is the FILE and the missing name rather than the line, because a
 * line moves whenever the file above it is edited and a capability does not:
 * two refusals here name library(process) and only the file tells them apart.
 * The line comes back with each observed refusal, which is where it is worth
 * having.
 */
export const REFUSALS = [
  {
    file: "src/metta.pl",
    missing: "library(thread)",
    costs: "concurrent_maplist and so jobs/2. The WebAssembly build is " +
      "single-threaded; SWI engines are present and are what this binding " +
      "streams answers with.",
  },
  {
    file: "src/metta.pl",
    missing: "library(time)",
    costs: "alarm/4 and so metta_timeout/2. A host-side timeout has to " +
      "bound the pull instead.",
  },
  {
    file: "src/metta.pl",
    missing: "library(process)",
    costs: "subprocess operations. A WebAssembly instance has no processes " +
      "to start.",
  },
  {
    file: "lib/lib_gitimport.pl",
    missing: "library(process)",
    costs: "git import!, which shells out to git.",
  },
];

class PettaError extends Error {}

// SWI writes a failed directive over two lines, the site and then the reason,
// so both are read: two refusals in this build name library(process) and only
// the site tells them apart.
const REFUSAL_SITE = /^ERROR:\s+(?<file>\S+?):(?<line>\d+):$/;
const REFUSAL_REASON =
  /^ERROR:\s+(?:source_sink `(?<sink>[^']+)' does not exist|catch\/3: Unknown procedure: (?<procedure>\S+))$/;

/**
 * The refusals in a boot's standard error, each matched against the table
 * above. One the table does not name raises: an unnamed refusal is a finding
 * and absorbing it is how a capability goes missing quietly.
 */
function readRefusals(lines, virtualPrefix) {
  const seen = [];
  let file = null;
  let line = null;
  for (const written of lines) {
    const location = REFUSAL_SITE.exec(written);
    if (location !== null) {
      file = location.groups.file.startsWith(virtualPrefix)
        ? location.groups.file.slice(virtualPrefix.length)
        : location.groups.file;
      line = Number(location.groups.line);
      continue;
    }
    const reason = REFUSAL_REASON.exec(written);
    if (reason === null) continue;
    const missing = reason.groups.sink ?? reason.groups.procedure;
    const known = REFUSALS.find((refusal) => refusal.missing === missing && refusal.file === file);
    if (known === undefined) {
      throw new PettaError(
        `the engine refused ${missing} at ${file}:${line} while booting, which ` +
          `bindings/node/index.mjs does not name; add it to REFUSALS with what ` +
          `it costs, or fix it`,
      );
    }
    seen.push({ ...known, line });
  }
  return seen;
}

/** One MeTTa answer: its wire form and the engine's own rendering of it. */
class Answer {
  constructor(wire, text) {
    this.wire = wire;
    this.text = text;
  }
  toString() {
    return this.text;
  }
}

/** bridge.pl's petta_node_answer/2 pair, as this side holds it. */
function answerFrom(pair) {
  return new Answer(fromTransport(pair[0]), hostText(pair[1]));
}

// ---------------------------------------------------------------------------
// The seven-tag codec, JavaScript side.
//
// The tags are python/petta/shim.pl's: s symbol, v variable, n number,
// g string, b boolean, e expression. bridge.pl carries a number as its
// canonical Prolog text because the WebAssembly value conversion renders the
// float 2.0 and the integer 2 as the same JavaScript number; here that text
// becomes a BigInt or a number, which is the split JavaScript does have.

// The spellings SWI's ~q writes and its reader takes back, measured
// 2026-08-20: an integer is bare digits, a float carries a point or an
// exponent, positive infinity is 1.0Inf, and a NaN is a float glued to NaN,
// whose mantissa is the payload's own and varies.
const INTEGER_TEXT = /^-?\d+$/;
const FLOAT_TEXT = /^-?(?:\d+\.\d+(?:[eE][-+]?\d+)?|\d+[eE][-+]?\d+)$/;
const INFINITY_TEXT = /^(?<sign>-?)1\.0Inf$/;
const NAN_TEXT = /^-?\d+\.\d+NaN$/;
const NAN_SPELLING = "1.5NaN";

/**
 * Text as it arrives from the WebAssembly conversion. A Prolog atom crosses
 * as a JavaScript string and a Prolog STRING crosses as a wrapper object
 * carrying `$t: "s"`, which has neither toString nor valueOf, so String() on
 * one throws "Cannot convert object to primitive value" rather than giving
 * the text [measured 2026-08-20]. Both spellings mean the same thing on this
 * side of the boundary and this is where they become one.
 */
function hostText(value) {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && value.$t === "s" && typeof value.v === "string") {
    return value.v;
  }
  throw new PettaError(`expected text from the engine, got ${JSON.stringify(value)}`);
}

function numberFromText(text) {
  if (INTEGER_TEXT.test(text)) return BigInt(text);
  if (FLOAT_TEXT.test(text)) return Number(text);
  const infinite = INFINITY_TEXT.exec(text);
  if (infinite !== null) return infinite.groups.sign === "-" ? -Infinity : Infinity;
  if (NAN_TEXT.test(text)) return NaN;
  throw new PettaError(
    `the number ${text} has no JavaScript type; a rational crosses as its ` +
      `Prolog spelling and this host has nothing to hold it in`,
  );
}

function numberToText(value) {
  if (typeof value === "bigint") return value.toString();
  if (Number.isNaN(value)) return NAN_SPELLING;
  if (value === Infinity) return "1.0Inf";
  if (value === -Infinity) return "-1.0Inf";
  // A MeTTa float must go back as one, so a spelling the Prolog reader would
  // take as an integer gets its point back, and an exponent gets a mantissa.
  // String(-0) is "0", which loses the sign a double carries, so negative zero
  // is spelled here rather than left to it.
  const text = Object.is(value, -0) ? "-0" : String(value);
  if (text.includes(".")) return text;
  const exponent = text.indexOf("e");
  if (exponent >= 0) return `${text.slice(0, exponent)}.0${text.slice(exponent)}`;
  return `${text}.0`;
}

/** bridge.pl's transport form to the wire atom a conformance kit compares. */
export function fromTransport(term) {
  if (!Array.isArray(term) || term.length !== 2) {
    throw new PettaError(`not a transport atom: ${JSON.stringify(term)}`);
  }
  const [tag, payload] = term;
  switch (tag) {
    case "s":
    case "v":
    case "g":
      return [tag, hostText(payload)];
    case "n":
      return ["n", numberFromText(hostText(payload))];
    case "b":
      return ["b", hostText(payload) === "true"];
    case "e":
      return ["e", items(payload).map(fromTransport)];
    default:
      throw new PettaError(`unknown wire tag ${JSON.stringify(tag)}`);
  }
}

/** The reverse, for handing an atom back to the engine. */
export function toTransport(wire) {
  if (!Array.isArray(wire) || wire.length !== 2) {
    throw new PettaError(`not a wire atom: ${JSON.stringify(wire)}`);
  }
  const [tag, payload] = wire;
  switch (tag) {
    case "s":
    case "v":
    case "g":
      if (typeof payload !== "string") {
        throw new PettaError(`the ${tag} tag carries text, not ${JSON.stringify(payload)}`);
      }
      return [tag, payload];
    case "n":
      if (typeof payload !== "number" && typeof payload !== "bigint") {
        throw new PettaError(`the n tag carries a number, not ${JSON.stringify(payload)}`);
      }
      return ["n", numberToText(payload)];
    case "b":
      if (typeof payload !== "boolean") {
        throw new PettaError(`the b tag carries a boolean, not ${JSON.stringify(payload)}`);
      }
      return ["b", payload ? "true" : "false"];
    case "e":
      return ["e", items(payload).map(toTransport)];
    default:
      throw new PettaError(`unknown wire tag ${JSON.stringify(tag)}`);
  }
}

function items(payload) {
  if (!Array.isArray(payload)) {
    throw new PettaError(`the e tag carries a list, not ${JSON.stringify(payload)}`);
  }
  return payload;
}

// ---------------------------------------------------------------------------

function mountInto(fs, hostDir, virtualDir, keep) {
  fs.mkdirTree(virtualDir);
  for (const name of readdirSync(hostDir)) {
    const hostPath = join(hostDir, name);
    const virtualPath = `${virtualDir}/${name}`;
    if (statSync(hostPath).isDirectory()) {
      mountInto(fs, hostPath, virtualPath, keep);
    } else if (keep === undefined || keep(name)) {
      fs.writeFile(virtualPath, readFileSync(hostPath));
    }
  }
}

export class Petta {
  #swipl;
  #output;
  #stderr;

  /**
   * @param {object} swipl @param {string[]} output @param {string[]} stderr
   * @param {object[]} refusals
   */
  constructor(swipl, output, stderr, refusals) {
    this.#swipl = swipl;
    this.#output = output;
    this.#stderr = stderr;
    this.refusals = refusals;
  }

  /**
   * Run a goal that must succeed exactly once, and return its bindings.
   *
   * Through bridge.pl's petta_node_do/2, so a Prolog exception never reaches
   * the WebAssembly boundary: swipl-wasm prints one on the host's console
   * before handing it back and has no switch for it, so the outcome crosses
   * as data and the raising happens here instead.
   */
  #once(goal, input) {
    const result = this.#swipl.prolog.query(`petta_node_do((${goal}), Outcome).`, input).once();
    if (result && result.error === true) {
      throw new PettaError(`${result.message} (running ${goal})`);
    }
    if (!result || result.success === false) {
      throw new PettaError(`the engine could not run ${goal}`);
    }
    const [outcome, text] = result.Outcome;
    if (outcome === "error") throw new PettaError(`${hostText(text)}(running ${goal})`);
    if (outcome !== "ok") throw new PettaError(`the engine goal failed: ${goal}`);
    return result;
  }

  /** Mount a host directory into the engine's virtual filesystem. */
  mount(hostDir, virtualDir, keep) {
    mountInto(this.#swipl.FS, hostDir, virtualDir, keep);
  }

  /** Run MeTTa source. One group of answers per `!` directive, in order. */
  run(source) {
    const { Groups } = this.#once("petta_node_run(Src, Groups)", { Src: source });
    return Groups.map((group) => group.map(answerFrom));
  }

  /**
   * Load a `.metta` file. Its directory is mounted at the same absolute path
   * first, so a relative `import!` beside it resolves exactly as on disk.
   */
  load(path) {
    const full = resolve(path);
    const directory = dirname(full);
    this.mount(directory, directory, (name) => name.endsWith(".metta") || name.endsWith(".pl"));
    const { Groups } = this.#once("petta_node_load(File, Groups)", { File: full });
    return Groups.map((group) => group.map(answerFrom));
  }

  /**
   * The answers of one MeTTa expression, as this language's own stream.
   *
   * Tarau states the discipline the shape follows: an engine "can, if asked,
   * resume" after yielding an answer, and a binding wraps that ask/resume
   * pair in the HOST's native stream abstraction so answers compose with the
   * host's own machinery (A Hitchhiker's Guide to Reinventing a Prolog
   * Machine, ICLP 2017, section 4.5, which wraps it in a Java Spliterator).
   * JavaScript's is the async iterator, so that is what this returns, and
   * `for await` and early `break` are what a caller writes.
   *
   * Async although the pull is synchronous today: it is the surface a
   * transport that is not in-process would need, and a caller written against
   * it does not change when one arrives.
   */
  stream(expression, { space = "&self" } = {}) {
    const engine = this;
    let cursor = null;
    let finished = false;

    const release = () => {
      finished = true;
      if (cursor !== null) {
        const id = cursor;
        cursor = null;
        engine.#once("petta_node_close(Id)", { Id: id });
      }
    };

    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        if (finished) return { done: true, value: undefined };
        if (cursor === null) {
          const { Id } = engine.#once("petta_node_open(Src, Space, Id)", {
            Src: expression,
            Space: space,
          });
          cursor = Number(Id);
        }
        let answer;
        try {
          ({ Answer: answer } = engine.#once("petta_node_next(Id, Answer)", { Id: cursor }));
        } catch (error) {
          release();
          throw error;
        }
        if (answer.length === 0) {
          release();
          return { done: true, value: undefined };
        }
        return { done: false, value: answerFrom(answer[0]) };
      },
      async return(value) {
        release();
        return { done: true, value };
      },
      async throw(error) {
        release();
        throw error;
      },
    };
  }

  /** An atom's round trip through the engine: decode it, then encode it back. */
  roundTrip(wire) {
    const { Out } = this.#once("petta_node_decode(W, T), petta_node_encode(T, Out)", {
      W: toTransport(wire),
    });
    return fromTransport(Out);
  }

  /** The engine's own rendering of an atom, through the published writer. */
  text(wire) {
    const { S } = this.#once("petta_node_decode(W, T), swrite(T, S)", { W: toTransport(wire) });
    return hostText(S);
  }

  /**
   * Everything the engine printed since the last read, and forgets it.
   *
   * A program's own `println!` lands here rather than on the host's console,
   * because an embedded engine writing to that console is writing over
   * whatever the host was saying. Both streams are captured and neither is
   * printed unless boot() was asked for verbose, which is the switch for
   * wanting the engine's own trace.
   */
  drainOutput() {
    return this.#output.splice(0, this.#output.length);
  }

  /** Everything the engine wrote to standard error since the last read. */
  drainStderr() {
    return this.#stderr.splice(0, this.#stderr.length);
  }
}

/**
 * Boot the engine in this process.
 *
 * `root` is the PeTTa checkout; the default is the one this file lives in.
 * The engine's own `silent` flag goes in argv rather than being retracted
 * afterwards, because argv is where src/filereader.pl reads it and
 * src/main.pl already lists it as an engine flag.
 */
export async function boot({ root = REPO_ROOT, verbose = false } = {}) {
  const initSWIPL = require("swipl-wasm/dist/swipl-node");
  const output = [];
  const stderr = [];
  const swipl = await initSWIPL({
    arguments: ["-q"],
    print: (line) => {
      output.push(line);
      if (verbose) console.log(line);
    },
    printErr: (line) => {
      stderr.push(line);
      if (verbose) console.error(line);
    },
  });

  for (const directory of ENGINE_DIRS) {
    mountInto(swipl.FS, join(root, directory), `${VIRTUAL_ROOT}/${directory}`);
  }
  swipl.FS.writeFile(`${VIRTUAL_ROOT}/bridge.pl`, readFileSync(join(HERE, "bridge.pl")));

  const flags = verbose ? "['backends']" : "['backends', silent]";
  swipl.prolog.query(`set_prolog_flag(argv, ${flags}).`).once();
  const consulted = swipl.prolog.query(`consult('${VIRTUAL_ROOT}/src/metta.pl').`).once();
  if (consulted && consulted.error === true) {
    throw new PettaError(`the engine did not load: ${consulted.message}`);
  }

  const seen = readRefusals(stderr, `${VIRTUAL_ROOT}/`);
  stderr.length = 0;
  output.length = 0;

  const bridged = swipl.prolog.query(`consult('${VIRTUAL_ROOT}/bridge.pl').`).once();
  if (bridged && bridged.error === true) {
    throw new PettaError(`the Node bridge did not load: ${bridged.message}`);
  }

  return new Petta(swipl, output, stderr, seen);
}

export { Answer, PettaError };
