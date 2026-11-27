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
  assert.throws(() => buildSteps('restyle', { furniture: 'a' }, { finish: 'Rose gold' }), /Invalid/);
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
  const [, draw] = buildSteps('specs', { photos: ['a'] }, { factory: true });
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

test('drawing with parts: Claude then ChatGPT for each part, each prompt about that part', () => {
  const steps = buildSteps('specs', { photos: ['a'] }, { parts: 'headboard, footboard ,' });
  assert.deepEqual(steps.map((s) => s.site), ['claude', 'chatgpt', 'claude', 'chatgpt']);
  assert.match(steps[0].prompt, /ONLY the headboard/);
  assert.match(steps[3].prompt, /^\{\{text\}\}[\s\S]*draw only its footboard/);
  assert.equal(buildSteps('specs', { photos: ['a'] }, {}).length, 2); // no parts → one drawing of the whole product
});

test('furniture drawing (outline): carving line art, no factory option; old "drawing" jobs map to specs', () => {
  const [claude, gpt] = buildSteps('outline', { photos: ['a'] }, { parts: 'headboard', factory: true });
  assert.match(claude.prompt, /line drawing of this exact design for wood carving[\s\S]*ONLY the headboard/);
  assert.match(gpt.prompt, /ready to trace onto wood for carving/);
  assert.deepEqual(gpt.images, ['photos']); // factory checkbox doesn't exist here
  assert.match(buildSteps('drawing', { photos: ['a'] }, {})[0].prompt, /technical drawing/);
});

test('restyle offers gold, champagne gold and silver polish', () => {
  const [s] = buildSteps('restyle', { furniture: 'a' }, { finish: 'Champagne gold' });
  assert.match(s.prompt, /wood\/metal polish → champagne gold/);
  for (const f of ['Gold', 'Silver']) assert.doesNotThrow(() => buildSteps('restyle', { furniture: 'a' }, { finish: f }));
});

test('factory shots use real-daylight wording, never studio product lighting', () => {
  const [fac] = buildSteps('restyle', { furniture: 'a' }, { factory: true });
  assert.match(fac.prompt, /indistinguishable from a real, unedited smartphone photo/);
  assert.doesNotMatch(fac.prompt, /professional product photography/);
  const [studio] = buildSteps('restyle', { furniture: 'a' }, {});
  assert.match(studio.prompt, /professional product photography/);
  assert.match(buildSteps('wood', { product: 'a' }, {})[0].prompt, /No studio lighting/);
});

test('generate tool: user prompt + optional photos', () => {
  const [s] = buildSteps('generate', { photos: ['a', 'b'] }, { prompt: '  A red chair in a garden ' });
  assert.deepEqual(s.images, ['photos']);
  assert.match(s.prompt, /^A red chair in a garden\n/);
  assert.equal(buildSteps('generate', {}, { prompt: 'x' }).length, 1); // no photos is fine
  assert.throws(() => buildSteps('generate', { photos: ['a'] }, { prompt: ' ' }), /Prompt is required/);
});
