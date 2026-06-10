import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  resolveHome,
  normalizePath,
  getAgentsDir,
  getSkillsDir,
  getAuthFilePath,
  getTrackingFilePath
} from '../../../src/utils/path.js';

describe('resolveHome', () => {
  it('expands ~ with os.homedir()', () => {
    const result = resolveHome('~/test/path');
    expect(result).toBe(path.join(os.homedir(), 'test/path'));
  });

  it('expands ~/ with home dir', () => {
    const result = resolveHome('~/');
    expect(result).toBe(os.homedir() + path.sep);
  });

  it('returns non-tilde path unchanged', () => {
    expect(resolveHome('/absolute/path')).toBe('/absolute/path');
    expect(resolveHome('relative/path')).toBe('relative/path');
  });

  it('uses path.join not string concatenation', () => {
    const result = resolveHome('~/.agents/skills');
    expect(result).toBe(path.join(os.homedir(), '.agents', 'skills'));
  });

  it('does not expand ~user paths', () => {
    expect(resolveHome('~other/path')).toBe('~other/path');
  });

  it('expands ~\\ on Windows-style inputs', () => {
    expect(resolveHome('~\\test\\path')).toBe(path.join(os.homedir(), '\\test\\path'));
  });

  it('expands ~\\ to home dir', () => {
    expect(resolveHome('~\\')).toBe(path.join(os.homedir(), '\\'));
  });
});

describe('normalizePath', () => {
  it('resolves relative paths to absolute', () => {
    const result = normalizePath('./foo/../bar');
    expect(path.isAbsolute(result)).toBeTruthy();
    expect(result.endsWith('bar')).toBeTruthy();
  });

  it('normalizes already absolute paths', () => {
    const result = normalizePath('/foo/bar/../baz');
    expect(result).toBe(path.resolve('/foo/baz'));
  });
});

describe('path getters', () => {
  it('getAgentsDir returns ~/.agents', () => {
    expect(getAgentsDir()).toBe(path.join(os.homedir(), '.agents'));
  });

  it('getSkillsDir returns ~/.agents/skills', () => {
    expect(getSkillsDir()).toBe(path.join(os.homedir(), '.agents', 'skills'));
  });

  it('getAuthFilePath returns ~/.agents/.nodesource-auth.json', () => {
    expect(getAuthFilePath()).toBe(path.join(os.homedir(), '.agents', '.nodesource-auth.json'));
  });

  it('getTrackingFilePath returns ~/.agents/.nodesource-installed.json', () => {
    expect(getTrackingFilePath()).toBe(path.join(os.homedir(), '.agents', '.nodesource-installed.json'));
  });

  it('all paths use path.join not string concatenation', () => {
    expect(getAgentsDir().includes(path.sep)).toBeTruthy();
    expect(getSkillsDir().endsWith(path.join('.agents', 'skills'))).toBeTruthy();
  });
});
