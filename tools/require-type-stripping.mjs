// Purpose: refuse a script that runs .ts directly when this Node cannot strip
//   types, naming the cause and the remedy.
//
// Assumes: nothing but `process.features.typescript`, which Node sets to false
//   when it was built without amaro.
// Guarantees: exit 1 with the remedy when stripping is absent, exit 0
//   otherwise. It never runs the caller's command; it is a preflight.
// Fails when: a future Node drops the feature flag. Then this reports absent
//   on a runtime that can strip, which is a loud false refusal rather than a
//   silent wrong answer, and the flag is one line to update.
//
// Why this exists. `node --test "test/*.test.ts"` on a Node without stripping
// dies with ERR_UNKNOWN_FILE_EXTENSION pointing at the first test file, which
// names neither the cause nor the fix and reads like a broken test. Debian and
// Ubuntu ship exactly such a build: /usr/bin/node 22.22.1 here reports
// process.features.typescript === false, so `npm run test:source` cannot run
// on a stock distribution Node however correct the package is
// [measured: 2026-09-22].
//
// This does NOT mean the package needs types at run time. src/define/lower.ts
// assumes the opposite and says so: types are erased before
// Function.prototype.toString() ever runs, under tsc and under stripping
// alike, so what `define` parses is always plain ECMAScript. Stripping is a
// convenience for running the sources in place, and `npm test`, which builds
// with tsc first, is the path that works everywhere.

if (process.features.typescript) process.exit(0);

process.stderr.write(
  `this Node cannot strip TypeScript types, so test/*.ts cannot run directly.\n` +
  `  node            ${process.version} at ${process.execPath}\n` +
  `  features.typescript  false (built without amaro; Debian and Ubuntu do this)\n` +
  `\n` +
  `  run the built suite instead, which needs no stripping:\n` +
  `      npm test\n` +
  `  or install a Node built with type stripping, 22.18 or newer, e.g. from\n` +
  `  nodejs.org or nvm, and re-run:\n` +
  `      npm run test:source\n`,
);
process.exit(1);
