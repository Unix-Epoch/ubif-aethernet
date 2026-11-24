// Aethernet client tests: the shared core (AE.api, ApiError, AE.shape, AE.health), the background loops' gates and breakers,
// Retrace's collector (what each sweep / history / PO call SENDS), the tracker, Waymark, and the shards' Portal readers.
//
//   node test-client/run.mjs              (or: npm test --prefix test-client)
//   node test-client/mutate.mjs           (each listed source mutation must make this suite fail)
//
// The src files load into a Node vm with stubbed browser globals (test-client/harness.mjs); `fetch` is stubbed per test and every
// request is recorded as sent (env.requests), so tests assert the bodies that would reach Portal or the Worker. Loops run on the
// harness's virtual clock (timers: 'fake') where timing matters.
// Responses come from the captured fixtures (tracker-worker/test/fixtures/retrace/*.json, test-client/fixtures/wo-template.json:
// sandbox/capture.py's scrubbed work order with its ids renumbered, kept in the repo so the suite runs on any clone).
// Anything built here by hand is marked SYNTHETIC: a bad shape a real Portal is not known to send, or a stand-in for an answer
// no capture covers yet. Nothing here is evidence of a Portal shape beyond what the fixture it is copied from proves.
// Exit code 0 = all passed. Needs Node 18+ and nothing from npm. No Portal, no Worker, no browser is touched.
//
// The tests live in suite/*.mjs, one file per area, loaded here in this order (each runs its tests as it loads);
// suite/common.mjs holds t(), the fixtures and the stubs they share.
import { results } from './suite/common.mjs';

for (const part of ['core', 'return', 'waymark', 'tracker', 'gates', 'retrace', 'readers', 'spread', 'safety']) await import('./suite/' + part + '.mjs');

// ================================================================== summary
const failed = results.filter(([, p]) => !p);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
