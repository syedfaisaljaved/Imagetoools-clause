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

test('factory checkbox attaches the factory photo last and swaps the background', () => {
  const [plain] = buildSteps('restyle', { furniture: 'a' }, {});
  const [fac] = buildSteps('restyle', { furniture: 'a' }, { factory: true });
  assert.deepEqual(plain.images, ['furniture']);
  assert.deepEqual(fac.images, ['furniture', 'factory']);
  assert.match(fac.prompt, /factory photo \(the last attached image\)/);
  const angles = buildSteps('angles', { product: 'a' }, { angles: ['Front', 'Back'], factory: 'on' });
  assert.deepEqual(angles.map((s) => s.images), [['product', 'factory'], []]);
  const [, draw] = buildSteps('drawing', { photos: ['a'] }, { factory: true });
  assert.deepEqual(draw.images, ['photos', 'factory']);
});

test('raw wood tool: product + factory, unpolished frame prompt', () => {
  const [s] = buildSteps('wood', { product: 'a' }, { wood: 'Sheesham' });
  assert.deepEqual(s.images, ['product', 'factory']);
  assert.match(s.prompt, /unpolished, unfinished sheesham wood/);
  assert.match(s.prompt, /no upholstery/);
  assert.throws(() => buildSteps('wood', { product: 'a' }, { wood: 'Oak' }), /Invalid Wood/);
});

test('factory showcase: one phone-style shot per pose, factory attached on the first', () => {
  const steps = buildSteps('showcase', { product: 'a' }, { shots: ['Front', 'Top-down'], light: 'Overcast' });
  assert.deepEqual(steps.map((s) => s.images), [['product', 'factory'], []]);
  assert.match(steps[0].prompt, /smartphone photo: vertical portrait frame/);
  assert.match(steps[1].prompt, /directly above.*overcast/s);
  assert.throws(() => buildSteps('showcase', { product: 'a' }, { shots: [] }), /at least one/);
});
