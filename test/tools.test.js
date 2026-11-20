import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSteps } from '../server/tools.js';

test('multi-angle: one step per angle, image only on first step', () => {
  const steps = buildSteps('angles', { product: 'x' }, { angles: ['Front', 'Back', 'Top-down'] });
  assert.equal(steps.length, 3);
  assert.deepEqual(steps.map((s) => s.images), [['product'], [], []]);
  assert.match(steps[1].prompt, /back view/);
  assert.match(steps[0].prompt, /white studio/); // default background
});

test('fabric + restyle prompts and validation', () => {
  const [f] = buildSteps('fabric', { furniture: 'a', fabric: 'b' }, { notes: 'keep piping' });
  assert.deepEqual(f.images, ['furniture', 'fabric']);
  assert.match(f.prompt, /keep piping/);
  const [r] = buildSteps('restyle', { furniture: 'a' }, { fabric: 'Linen', color: 'beige', finish: 'Walnut' });
  assert.match(r.prompt, /linen.*beige.*walnut/s);
  assert.throws(() => buildSteps('fabric', { furniture: 'a' }), /Fabric photo/);
  assert.throws(() => buildSteps('restyle', { furniture: 'a' }, { finish: 'Gold' }), /Invalid/);
  assert.throws(() => buildSteps('angles', { product: 'a' }, { angles: [] }), /at least one/);
});
