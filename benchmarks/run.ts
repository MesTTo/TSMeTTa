/**
 * Purpose: the command line benchmarks/bench.py drives, and the one a reader
 *   can drive by hand.
 * Assumes:
 *   - the caller parses the ONE JSON line this writes to standard output.
 *     Everything else goes to standard error, so a case that prints cannot
 *     corrupt the reading.
 *   - `--controlled` runs under `perf stat --control=fd:...`; see
 *     benchmarks/sampler.ts for the protocol.
 * Guarantees:
 *   - `--list` answers what each case is and which counter decides it, so the
 *     Python driver never keeps a second copy of the case table
 *     [tested: "pins exactly the cases the table declares, in both directions"]
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { CASES, NAMES } from "./cases.ts";
import { type Sample, controlled, directly, sample } from "./sampler.ts";

function usage(): never {
  process.stderr.write(
    `usage: run.js <case> [--samples N | --controlled]\n` +
      `       run.js --list\n\ncases: ${NAMES.join(" ")}\n`,
  );
  process.exit(2);
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("--list")) {
    for (const name of NAMES) {
      const one = CASES[name]!;
      process.stdout.write(
        `${JSON.stringify({
          name: one.name,
          unit: one.unit,
          operations: one.operations,
          counters: one.counters,
          decidedBecause: one.decidedBecause,
        })}\n`,
      );
    }
    return 0;
  }
  const name = argv[0];
  if (name === undefined || !(name in CASES)) usage();
  const one = CASES[name]!;

  if (argv.includes("--controlled")) {
    await sample(one, controlled);
    return 0;
  }

  const at = argv.indexOf("--samples");
  const rounds = at < 0 ? 3 : Number(argv[at + 1]);
  if (!Number.isInteger(rounds) || rounds < 1) usage();

  const samples: Sample[] = [];
  for (let round = 0; round < rounds; round += 1) samples.push(await sample(one, directly));
  process.stdout.write(
    `${JSON.stringify({
      name: one.name,
      unit: one.unit,
      operations: one.operations,
      counters: one.counters,
      inferences: samples[0]!.inferences === null ? null : samples.map((s) => s.inferences),
      crossings: samples[0]!.crossings === null ? null : samples.map((s) => s.crossings),
      seconds: samples.map((s) => s.seconds),
    })}\n`,
  );
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
