/**
 * Purpose: exercise the emitted browser package in Chromium over HTTP.
 * Guarantees: boot, wire answers, host callbacks, matching and evaluation status
 *   run in a page, with worker boot checked separately. [tested: npm run test:browser; commit=04fde431963bd063ef4ab5dc9b579ff2faba9fe8]
 * Owns resources: closes Chromium and the HTTP server. It leaves `_runtime/`
 *   where the build put it: that directory is what an installed package mounts
 *   and what `prepare` makes, so removing it after a run left the checkout in
 *   the state a consumer install fails from.
 */
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const partialSource = await readFile(join(root, "../../examples/ch05-equations-and-evaluation/05-01-an-equation-is-a-rewrite/04-partialdef.metta"), "utf8");
let browser;
let server;
let origin;
let consumer;
let atomConsumer;
const workerSource = `
import { metta } from '/browser/index.js';
try {
  const m = await metta({ root: new URL('/_runtime/', location.href).href });
  const result = m.run('!(+ 20 22)')[0].texts;
  m.dispose();
  postMessage({ result });
} catch (error) { postMessage({ error: String(error) }); }
`;

before(async () => {
  const bundled = await build({
    stdin: {
      contents: `import { metta, variable } from 'metta-node';
        import { alphaEqual } from 'metta-node/matching';
        export async function probe(root) {
          const m = await metta({root});
          try { return {same: alphaEqual(variable('x'), variable('y')), answer: m.run('!(+ 1 2)')[0].texts}; }
          finally { m.dispose(); }
        }`,
      resolveDir: root,
    },
    bundle: true, platform: 'browser', format: 'esm', write: false,
  });
  consumer = bundled.outputFiles[0].text;
  const atomsOnly = await build({
    stdin: {
      contents: `import { expr, sym, G, float } from 'metta-node/atom';
        import { MettaError } from 'metta-node/errors';
        export function probeAtoms() {
          const term = expr(sym('user'), G(42), float(1), G('ada'));
          const refusal = new MettaError('refused');
          return { text: term.text, code: refusal.code, caught: refusal instanceof Error };
        }`,
      resolveDir: root,
    },
    bundle: true, platform: 'browser', format: 'esm', write: false,
  });
  atomConsumer = atomsOnly.outputFiles[0].text;
  server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/' || path === '/empty/') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>Browser engine verification</title><body>Browser engine verification</body>');
      return;
    }
    if (path === '/consumer.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(consumer);
      return;
    }
    if (path === '/atom-consumer.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(atomConsumer);
      return;
    }
    if (path === '/worker.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(workerSource);
      return;
    }
    const file = resolve(root, '.' + path);
    if (!file.startsWith(root + '/')) { response.writeHead(403).end(); return; }
    try {
      const bytes = await readFile(file);
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
      response.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
      response.end(bytes);
    } catch { response.writeHead(404).end('missing test asset'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  try { await browser?.close(); }
  finally {
    if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('boots the shared surface in a browser and preserves the stronger APIs', async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  try {
    await page.goto(origin);
    const result = await page.evaluate(async (partialSource) => {
      const api = await import('/browser/index.js');
      const satellite = await import('/browser/matching.js');
      const wireSatellite = await import('/browser/wire.js');
      const { metta, S, V, G, alphaEqual, alphaCanonical, alphaKey, isGround,
        matchTerms, renameVariables, substitute, unifyTerms, version } = api;
      const m = await metta();
      try {
        m.op(function doubleBrowser(n) { return Number(n) * 2; });
        const x = V.x;
        const y = V.y;
        const pattern = S.pair(x, x);
        const renamed = renameVariables(pattern, () => 'y');
        const bindings = unifyTerms(pattern, S.pair(7, 7));
        const statuses = [S.superpose(api.expr(G(1), G(2))), S.empty(), S.unknownBrowser(1)]
          .map(term => m.evalStatus(term).map(row => [row.status, row.text]));
        const partial = m.run('!(* 2)')[0].answers[0];
        let hostPathError;
        try { m.loadFile('example.metta'); } catch (error) { hostPathError = error.code; }
        return {
          answer: m.run('!(+ 2 3)')[0].texts,
          callback: m.run('!(double-browser 21)')[0].texts,
          partial: partial.text,
          roundTrip: m.engine.roundTrip(partial) === partial,
          trace: m.trace(partialSource).some(event => event.term.text.includes('(partial * (2))')),
          statuses,
          matching: [alphaEqual(pattern, S.pair(y, y)), alphaKey(pattern) === alphaKey(renamed),
            alphaCanonical(pattern) === alphaCanonical(renamed), isGround(S.pair(7, 7)),
            matchTerms(pattern, S.pair(7, 7)) !== undefined,
            bindings !== undefined && substitute(pattern, bindings) === S.pair(7, 7)],
          version: version(),
          satelliteIdentity: satellite.alphaEqual(V.x, V.y) &&
            wireSatellite.atomFromWire(wireSatellite.wireFromAtom(partial)) === partial,
          hostPathError,
          nodeGlobal: typeof process,
          stderr: m.drainStderr(),
        };
      } finally { m.dispose(); }
    }, partialSource);
    assert.deepEqual(result.answer, ['5']);
    assert.deepEqual(result.callback, ['42']);
    assert.equal(result.partial, '(partial * (2))');
    assert.equal(result.roundTrip, true);
    assert.equal(result.trace, true);
    assert.deepEqual(result.statuses, [[['value', '1'], ['value', '2']], [['empty', 'none']], [['not-reducible', '(unknown-browser 1)']]]);
    assert.deepEqual(result.matching, [true, true, true, true, true, true]);
    assert.equal(result.version, manifest.version);
    assert.equal(result.satelliteIdentity, true);
    assert.equal(result.hostPathError, 'ERR_METTA_UNSUPPORTED');
    assert.equal(result.nodeGlobal, 'undefined');
    assert.deepEqual(result.stderr, []);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('boots in a module worker without window or Node globals', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(origin);
    const result = await page.evaluate(() => new Promise((resolve, reject) => {
      const worker = new Worker('/worker.js', { type: 'module' });
      worker.onmessage = event => { worker.terminate(); resolve(event.data); };
      worker.onerror = event => { worker.terminate(); reject(new Error(event.message)); };
    }));
    assert.deepEqual(result, { result: ['42'] });
  } finally { await page.close(); }
});


test('builds atoms in a browser with no engine behind them', async () => {
  // The consumer bundled above imports `metta-node/atom` and
  // `metta-node/errors` by NAME, so what is exercised is the exports map's
  // `browser` key rather than a path this file happens to know. A page that
  // only builds terms must not pay for the engine, and the two ways it could
  // are both checked: the bundle cannot mention swipl-wasm or a node builtin,
  // and the page must fetch no engine asset while running it.
  assert.doesNotMatch(atomConsumer, /swipl-wasm/);
  assert.doesNotMatch(atomConsumer, /\bnode:[a-z]/);
  const page = await browser.newPage();
  const errors = [];
  const fetched = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('request', request => fetched.push(new URL(request.url()).pathname));
  try {
    await page.goto(origin);
    const result = await page.evaluate(async () => {
      const { probeAtoms } = await import('/atom-consumer.js');
      return { ...probeAtoms(), booted: typeof globalThis.SWIPL };
    });
    // `code` rather than `name`: the class sets its name from `new.target.name`
    // deliberately, so a bundler that renames the class renames that too, and
    // the code is what src/errors.ts pins as the stable identity.
    assert.deepEqual(result, {
      text: '(user 42 1.0 "ada")',
      code: 'ERR_METTA_ENGINE',
      caught: true,
      booted: 'undefined',
    });
    assert.deepEqual(errors, []);
    const engineAssets = fetched.filter(path => /wasm|_runtime|runtime\.json|swipl/.test(path));
    assert.deepEqual(engineAssets, [], 'the page fetched an engine asset');
  } finally { await page.close(); }
});

test('names a missing browser runtime before instantiating wasm', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(origin);
    const result = await page.evaluate(async () => {
      const { metta } = await import('/browser/index.js');
      try { await metta({ root: new URL('/empty/', location.href).href }); }
      catch (error) { return { code: error.code, message: error.message }; }
    });
    assert.equal(result.code, 'ERR_METTA_SOURCE');
    assert.match(result.message, /runtime\.json/);
  } finally { await page.close(); }
});

for (const asset of ['swipl-web.wasm', 'swipl-web.data']) {
  test(`names a missing ${asset} before instantiating wasm`, async () => {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    try {
      await page.route(`**/wasm/${asset}`, route => route.fulfill({ status: 404, body: 'missing asset' }));
      await page.goto(origin);
      const result = await page.evaluate(async () => {
        const { metta } = await import('/browser/index.js');
        try { await metta(); }
        catch (error) { return { code: error.code, message: error.message }; }
      });
      assert.equal(result.code, 'ERR_METTA_SOURCE');
      assert.ok(result.message.includes(asset), result.message);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

test('rejects a successful HTTP response carrying the wrong data asset', async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  try {
    await page.goto(origin);
    await page.route('**/wasm/swipl-web.data', route => route.fulfill({
      status: 200, contentType: 'text/html', body: '<html>wrong asset</html>',
    }));
    const result = await page.evaluate(async () => {
      const { metta } = await import('/browser/index.js');
      try { await metta(); }
      catch (error) { return { code: error.code, message: error.message }; }
    });
    assert.equal(result.code, 'ERR_METTA_ENGINE', JSON.stringify(result));
    assert.match(result.message, /swipl-web.data.*bytes.*expects/);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('rejects malformed runtime paths before mounting any source', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(origin);
    for (const files of [
      [{path: '../outside.pl', text: ''}],
      [{path: 'bridge.pl', text: ''}, {path: 'bridge.pl', text: ''}],
      [{path: 'engine/a.pl', text: ''}, {path: 'engine/a.pl/b.pl', text: ''}],
      [{path: 'engine/a.pl/b.pl', text: ''}, {path: 'engine/a.pl', text: ''}],
      [],
    ]) {
      await page.route('**/runtime.json', route => route.fulfill({ json: {version: 1, files} }));
      const result = await page.evaluate(async () => {
        const { metta } = await import('/browser/index.js');
        try { await metta(); }
        catch (error) { return { code: error.code, message: error.message }; }
      });
      assert.equal(result.code, 'ERR_METTA_ENGINE', JSON.stringify(result));
      assert.match(result.message, /manifest/);
      await page.unroute('**/runtime.json');
    }
  } finally { await page.close(); }
});

/** Every request a page made for the runtime manifest or a wasm asset. */
const engineRequests = (fetched) => ({
  manifest: fetched.filter(path => path.endsWith('/runtime.json')).length,
  wasm: fetched.filter(path => path.endsWith('.wasm')).length,
  data: fetched.filter(path => path.endsWith('.data')).length,
});

test('prepares one root once however many engines boot on it', async () => {
  // Twelve boots were twelve fetches and twelve validations of a 3.3 MB
  // manifest, which a workspace booting per document pays every time.
  const page = await browser.newPage();
  const fetched = [];
  page.on('request', request => fetched.push(new URL(request.url()).pathname));
  try {
    await page.goto(origin);
    const answers = await page.evaluate(async () => {
      const { metta } = await import('/browser/index.js');
      const said = [];
      for (let boots = 0; boots < 12; boots += 1) {
        const m = await metta();
        try { said.push(m.run('!(+ 20 22)')[0].texts[0]); } finally { m.dispose(); }
      }
      return said;
    });
    assert.deepEqual(answers, Array.from({ length: 12 }, () => '42'));
    assert.deepEqual(engineRequests(fetched), { manifest: 1, wasm: 1, data: 1 });
  } finally { await page.close(); }
});

test('shares one preparation between concurrent boots', async () => {
  // The memo holds the PROMISE, so boots that start together wait on one
  // preparation. Holding the result instead would let twelve concurrent boots
  // miss and fetch twelve times, which is the case a worker pool hits first.
  const page = await browser.newPage();
  const fetched = [];
  page.on('request', request => fetched.push(new URL(request.url()).pathname));
  try {
    await page.goto(origin);
    const answers = await page.evaluate(async () => {
      const { metta } = await import('/browser/index.js');
      const engines = await Promise.all([metta(), metta(), metta(), metta()]);
      try { return engines.map(m => m.run('!(+ 20 22)')[0].texts[0]); }
      finally { for (const m of engines) m.dispose(); }
    });
    assert.deepEqual(answers, ['42', '42', '42', '42']);
    assert.deepEqual(engineRequests(fetched), { manifest: 1, wasm: 1, data: 1 });
  } finally { await page.close(); }
});

test('asks again after a runtime it refused', async () => {
  // A refusal is not an answer. Remembering one would make the boot after a
  // transient failure repeat the failure with no request behind it.
  const page = await browser.newPage();
  try {
    await page.goto(origin);
    await page.route('**/runtime.json', route => route.fulfill({ json: { version: 1, files: [] } }));
    const refused = await page.evaluate(async () => {
      const { metta } = await import('/browser/index.js');
      try { await metta(); return null; } catch (error) { return error.code; }
    });
    assert.equal(refused, 'ERR_METTA_ENGINE');
    await page.unroute('**/runtime.json');
    const answer = await page.evaluate(async () => {
      const { metta } = await import('/browser/index.js');
      const m = await metta();
      try { return m.run('!(+ 20 22)')[0].texts[0]; } finally { m.dispose(); }
    });
    assert.equal(answer, '42');
  } finally { await page.close(); }
});

test('forgets a prepared root when asked to', async () => {
  const page = await browser.newPage();
  const fetched = [];
  page.on('request', request => fetched.push(new URL(request.url()).pathname));
  try {
    await page.goto(origin);
    const answers = await page.evaluate(async () => {
      const { metta, forgetRuntime } = await import('/browser/index.js');
      const said = [];
      for (const forget of [false, true]) {
        const m = await metta();
        try { said.push(m.run('!(+ 20 22)')[0].texts[0]); } finally { m.dispose(); }
        if (forget) forgetRuntime();
      }
      const m = await metta();
      try { said.push(m.run('!(+ 20 22)')[0].texts[0]); } finally { m.dispose(); }
      return said;
    });
    assert.deepEqual(answers, ['42', '42', '42']);
    assert.deepEqual(engineRequests(fetched), { manifest: 2, wasm: 2, data: 2 });
  } finally { await page.close(); }
});

test('compiles the engine from its URL so the browser can cache the compiled code', async () => {
  // Chrome's WebAssembly code cache keys on the resource URL and is populated
  // by the streaming calls alone, so bytes handed to the loader in memory are
  // recompiled on every page load [source: https://v8.dev/blog/wasm-code-caching].
  const page = await browser.newPage();
  try {
    await page.goto(origin);
    const seen = await page.evaluate(async () => {
      const counted = { compileStreaming: 0, compile: 0, instantiate: 0 };
      for (const name of Object.keys(counted)) {
        const original = WebAssembly[name].bind(WebAssembly);
        WebAssembly[name] = (...args) => { counted[name] += 1; return original(...args); };
      }
      const { metta } = await import('/browser/index.js');
      const m = await metta();
      try { return { ...counted, answer: m.run('!(+ 20 22)')[0].texts[0] }; }
      finally { m.dispose(); }
    });
    assert.deepEqual(seen, { compileStreaming: 1, compile: 0, instantiate: 0, answer: '42' });
  } finally { await page.close(); }
});

test('compiles the fetched bytes when the response cannot be streamed', async () => {
  // A server that answers the `.wasm` with any other Content-Type makes the
  // browser refuse to stream it. That costs the code cache and must not cost
  // the boot, so the fallback is a real path rather than a comment.
  const page = await browser.newPage();
  const bytes = await readFile(join(root, '_runtime', 'wasm', 'swipl-web.wasm'));
  try {
    await page.goto(origin);
    await page.route('**/wasm/swipl-web.wasm', route => route.fulfill({
      status: 200, contentType: 'application/octet-stream', body: bytes,
    }));
    const seen = await page.evaluate(async () => {
      const counted = { compileStreaming: 0, compile: 0 };
      for (const name of Object.keys(counted)) {
        const original = WebAssembly[name].bind(WebAssembly);
        WebAssembly[name] = (...args) => { counted[name] += 1; return original(...args); };
      }
      const { metta } = await import('/browser/index.js');
      const m = await metta();
      try { return { ...counted, answer: m.run('!(+ 20 22)')[0].texts[0] }; }
      finally { m.dispose(); }
    });
    assert.deepEqual(seen, { compileStreaming: 1, compile: 1, answer: '42' });
  } finally { await page.close(); }
});

test('names a wasm asset it cannot compile rather than aborting inside the loader', async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  try {
    await page.goto(origin);
    await page.route('**/wasm/swipl-web.wasm', route => route.fulfill({
      status: 200, contentType: 'application/wasm', body: Buffer.from('not a module'),
    }));
    const result = await page.evaluate(async () => {
      const { metta } = await import('/browser/index.js');
      try { await metta(); } catch (error) { return { code: error.code, message: error.message }; }
    });
    assert.equal(result.code, 'ERR_METTA_ENGINE', JSON.stringify(result));
    assert.match(result.message, /swipl-web\.wasm is not a WebAssembly module/);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('runs the documented browser example', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}/examples/browser.html`);
    await page.waitForFunction(() => document.querySelector('#result').textContent === '42');
    await page.fill('#source', '!(* 2)');
    await page.click('#run');
    assert.equal(await page.textContent('#result'), '(partial * (2))');
  } finally { await page.close(); }
});


test('a consumer bundler selects browser exports with shared satellite atoms', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(origin);
    const result = await page.evaluate(async () => {
      const { probe } = await import('/consumer.js');
      return probe(new URL('/_runtime/', location.href).href);
    });
    assert.deepEqual(result, { same: true, answer: ['3'] });
  } finally { await page.close(); }
});
