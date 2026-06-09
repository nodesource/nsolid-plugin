import { describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import {
  resolveHome,
  normalizePath,
  getAgentsDir,
  getSkillsDir,
  getAuthFilePath,
  getTrackingFilePath
} from '../../src/utils/path.js';

describe('resolveHome', () => {
  it('expands ~ with os.homedir()', () => {
    const result = resolveHome('~/test/path');
    strictEqual(result, path.join(os.homedir(), 'test/path'));
  });

  it('expands ~/ with home dir', () => {
    const result = resolveHome('~/');
    strictEqual(result, os.homedir() + path.sep);
  });

  it('returns non-tilde path unchanged', () => {
    strictEqual(resolveHome('/absolute/path'), '/absolute/path');
    strictEqual(resolveHome('relative/path'), 'relative/path');
  });

  it('uses path.join not string concatenation', () => {
    const result = resolveHome('~/.agents/skills');
    strictEqual(result, path.join(os.homedir(), '.agents', 'skills'));
  });

  it('does not expand ~user paths', () => {
    strictEqual(resolveHome('~other/path'), '~other/path');
  });

  it('expands ~\\ on Windows-style inputs', () => {
    strictEqual(resolveHome('~\\test\\path'), path.join(os.homedir(), '\\test\\path'));
  });

  it('expands ~\\ to home dir', () => {
    strictEqual(resolveHome('~\\'), path.join(os.homedir(), '\\'));
  });
});

describe('normalizePath', () => {
  it('resolves relative paths to absolute', () => {
    const result = normalizePath('./foo/../bar');
    ok(path.isAbsolute(result));
    ok(result.endsWith('bar'));
  });

  it('normalizes already absolute paths', () => {
    const result = normalizePath('/foo/bar/../baz');
    strictEqual(result, path.resolve('/foo/baz'));
  });
});

describe('path getters', () => {
  it('getAgentsDir returns ~/.agents', () => {
    strictEqual(getAgentsDir(), path.join(os.homedir(), '.agents'));
  });

  it('getSkillsDir returns ~/.agents/skills', () => {
    strictEqual(getSkillsDir(), path.join(os.homedir(), '.agents', 'skills'));
  });

  it('getAuthFilePath returns ~/.agents/.nodesource-auth.json', () => {
    strictEqual(getAuthFilePath(), path.join(os.homedir(), '.agents', '.nodesource-auth.json'));
  });

  it('getTrackingFilePath returns ~/.agents/.nodesource-installed.json', () => {
    strictEqual(getTrackingFilePath(), path.join(os.homedir(), '.agents', '.nodesource-installed.json'));
  });

  it('all paths use path.join not string concatenation', () => {
    ok(getAgentsDir().includes(path.sep));
    ok(getSkillsDir().endsWith(path.join('.agents', 'skills')));
  });
});