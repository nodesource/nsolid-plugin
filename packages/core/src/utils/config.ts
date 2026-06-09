import { readFileSync, existsSync } from 'node:fs';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { atomicWriteSync } from './fs.js';

export function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null;
    const data = readFileSync(filePath, 'utf-8');
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

export function readTomlFile<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null;
    const data = readFileSync(filePath, 'utf-8');
    return parseToml(data) as T;
  } catch {
    return null;
  }
}

export function writeTomlFileSync(filePath: string, data: Record<string, unknown>): void {
  atomicWriteSync(filePath, stringifyToml(data as Record<string, unknown>));
}

export function parseJsonc(content: string): unknown {
  let out = '';
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        out += ch;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (!inString && ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }

    if (!inString && ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }

    if (ch === '"' && !escaped) {
      inString = !inString;
    }

    if (!inString && ch === ',') {
      let j = i + 1;
      while (j < content.length && /\s/.test(content[j])) j++;
      if (content[j] === '}' || content[j] === ']') continue;
    }

    out += ch;
    escaped = ch === '\\' && !escaped;
    if (ch !== '\\') escaped = false;
  }

  return JSON.parse(out);
}

export function readJsoncFile<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, 'utf-8');
    return parseJsonc(content) as T;
  } catch {
    return null;
  }
}