import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { writeJson } from '../src/util.mjs';
import { CONFIG_PATH, DEFAULTS, loadConfig } from '../src/config.mjs';

test('session import settings default on and are validated', async t => {
  const f = await fixture(t);
  assert.deepEqual([f.config.piAutoImport, f.config.museAutoImport, f.config.claudeAutoImport], [true, true, true]);
  for (const [key, value, message] of [
    ['piAutoImport', 'yes', /piAutoImport must be boolean/],
    ['claudeAutoImport', 1, /claudeAutoImport must be boolean/],
    ['maxPiImportChars', 0, /Invalid positive integer: maxPiImportChars/],
    ['maxClaudeImportChars', 1.5, /Invalid positive integer: maxClaudeImportChars/],
    ['claudeImport', true, /Unknown configuration key: claudeImport/]
  ]) {
    await writeJson(f.root, CONFIG_PATH, { ...DEFAULTS, [key]: value });
    await assert.rejects(loadConfig(f.root), message);
  }
  await writeJson(f.root, CONFIG_PATH, { ...DEFAULTS, claudeAutoImport: false, maxPiImportChars: 1000 });
  const { config } = await loadConfig(f.root);
  assert.deepEqual([config.claudeAutoImport, config.maxPiImportChars], [false, 1000]);
});
