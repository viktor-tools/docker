'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { describe, test, expect, beforeAll, afterAll } = require('bun:test');

// The tools sandbox everything under VIKTOR_REPO_DIR, so tests point it at a throwaway
// fixture repo instead of the real /repo used in production containers.
const REPO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'viktor-entrypoint-test-'));
process.env.VIKTOR_REPO_DIR = REPO_DIR;

const {
  safePath,
  toolReadFile,
  toolListDirectory,
  toolSearchInFiles,
  toolGetFileTree,
  toolFindFiles,
  toolReadFileLines,
  toolGitLog,
  executeTool,
  parseAgentResult,
} = require('./entrypoint.js');

function write(relPath, content) {
  const abs = path.join(REPO_DIR, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeAll(() => {
  write('apps/back/src/auth.service.ts', "export function login(password: string) {\n  return authenticate(password);\n}\n");
  write('apps/front/src/login.component.ts', "export class LoginComponent {\n  // renders the login form\n}\n");
  write('apps/back/src/unrelated.service.ts', 'export function noop() {}\n');
  write('README.md', '# Fixture repo\n');
  write('src/nested/deep/file.txt', 'deep content\n');
  write('multiline.txt', Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'));

  execSync('git init -q', { cwd: REPO_DIR });
  execSync('git config user.email test@example.com', { cwd: REPO_DIR });
  execSync('git config user.name Test', { cwd: REPO_DIR });
  execSync('git add -A', { cwd: REPO_DIR });
  execSync('git commit -q -m "initial commit"', { cwd: REPO_DIR });
});

afterAll(() => {
  fs.rmSync(REPO_DIR, { recursive: true, force: true });
});

describe('safePath', () => {
  test('resolves a relative path inside the repo', () => {
    expect(safePath('README.md')).toBe(path.join(REPO_DIR, 'README.md'));
  });

  test('rejects a path that escapes the repo via ..', () => {
    expect(() => safePath('../outside.txt')).toThrow(/outside the repository/);
  });

  // Leading slashes are stripped before resolving, so an absolute-looking path is treated as
  // relative to the repo root rather than escaping it (e.g. "/etc/passwd" -> "<repo>/etc/passwd").
  test('treats a leading-slash path as relative to the repo root', () => {
    expect(safePath('/etc/passwd')).toBe(path.join(REPO_DIR, 'etc/passwd'));
  });
});

describe('toolReadFile', () => {
  test('reads file content', () => {
    expect(toolReadFile({ path: 'README.md' })).toBe('# Fixture repo\n');
  });

  test('reports a missing file', () => {
    expect(toolReadFile({ path: 'does-not-exist.txt' })).toBe('File not found: does-not-exist.txt');
  });

  test('refuses to read a directory', () => {
    expect(toolReadFile({ path: 'src' })).toContain('is a directory, not a file');
  });
});

describe('toolListDirectory', () => {
  test('lists files and directories, directories suffixed with /', () => {
    const result = toolListDirectory({ path: 'apps' });
    expect(result.split('\n').sort()).toEqual(['back/', 'front/']);
  });

  test('defaults to repo root', () => {
    expect(toolListDirectory({})).toContain('README.md');
  });
});

describe('toolSearchInFiles', () => {
  test('finds a plain (non-regex) literal match', () => {
    const result = toolSearchInFiles({ query: 'LoginComponent', path: 'apps/front' });
    expect(result).toContain('login.component.ts');
  });

  // Regression test: search_in_files with regex=true previously ran the file-listing grep
  // without -E, so alternation patterns like "a|b" were treated as a literal string containing
  // a pipe character and never matched anything.
  test('finds matches for an alternation pattern when regex=true', () => {
    const result = toolSearchInFiles({ query: 'login|password|authenticate', path: 'apps', regex: true });
    expect(result).not.toBe('No matches found.');
    expect(result).toContain('auth.service.ts');
    expect(result).toContain('login.component.ts');
  });

  test('treats a pipe character as literal text when regex=false', () => {
    const result = toolSearchInFiles({ query: 'login|password|authenticate', path: 'apps', regex: false });
    expect(result).toBe('No matches found.');
  });

  test('returns "No matches found." when nothing matches', () => {
    expect(toolSearchInFiles({ query: 'nonexistent_token_xyz', path: '.' })).toBe('No matches found.');
  });
});

describe('toolGetFileTree', () => {
  test('renders a tree with nested directories', () => {
    const result = toolGetFileTree({ path: 'src', depth: 5 });
    expect(result).toContain('nested/');
    expect(result).toContain('deep/');
    expect(result).toContain('file.txt');
  });
});

describe('toolFindFiles', () => {
  test('finds files by glob pattern', () => {
    const result = toolFindFiles({ pattern: '*.component.ts' });
    expect(result).toContain('apps/front/src/login.component.ts');
  });

  test('returns "No files found." when pattern matches nothing', () => {
    expect(toolFindFiles({ pattern: '*.nonexistent' })).toBe('No files found.');
  });
});

describe('toolReadFileLines', () => {
  test('reads a specific line range', () => {
    const result = toolReadFileLines({ path: 'multiline.txt', from: 2, to: 4 });
    expect(result).toBe('2: line 2\n3: line 3\n4: line 4');
  });

  test('reports when the requested range is beyond the file', () => {
    const result = toolReadFileLines({ path: 'multiline.txt', from: 999, to: 1000 });
    expect(result).toContain('is beyond end of file');
  });
});

describe('toolGitLog', () => {
  test('returns the commit history', () => {
    const result = toolGitLog({});
    expect(result).toContain('initial commit');
  });

  test('scopes the log to a specific file', () => {
    const result = toolGitLog({ path: 'README.md' });
    expect(result).toContain('initial commit');
  });
});

describe('executeTool', () => {
  test('dispatches to the named tool', () => {
    expect(executeTool('read_file', { path: 'README.md' })).toBe('# Fixture repo\n');
  });

  test('reports an unknown tool name', () => {
    expect(executeTool('does_not_exist', {})).toBe('Unknown tool: does_not_exist');
  });
});

describe('parseAgentResult', () => {
  test('parses raw JSON', () => {
    expect(parseAgentResult('{"completionScore": 80}')).toEqual({ completionScore: 80 });
  });

  test('strips a ```json fenced code block', () => {
    expect(parseAgentResult('```json\n{"completionScore": 80}\n```')).toEqual({ completionScore: 80 });
  });

  test('throws on invalid JSON', () => {
    expect(() => parseAgentResult('not json')).toThrow(/did not return valid JSON/);
  });
});
