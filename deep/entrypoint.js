#!/usr/bin/env bun

'use strict';

const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// --- Configuration ---

const API_URL = process.env.VIKTOR_API_URL || 'https://api.viktor.tools';
const BASE_BRANCH = process.env.BASE_BRANCH || 'main';
const APP_ID = process.env.VIKTOR_APP_ID;
const APP_SECRET = process.env.VIKTOR_APP_SECRET;
const REPO_URL = process.env.REPO_URL;
const BRANCH = process.env.BRANCH;
const VCS_TOKEN = process.env.VCS_TOKEN;
const MERGE_REQUEST_ID = process.env.PR_NUMBER || process.env.MR_IID;
const REPO_DIR = '/repo';
const DEFAULT_MODE = (process.env.VIKTOR_DEFAULT_MODE || 'deep').toUpperCase();

const MAX_FILE_SIZE = 100 * 1024; // 100KB cap per file read
const MAX_SEARCH_RESULTS = 50;

// --- Validation ---

for (const [name, val] of [
  ['VIKTOR_APP_ID', APP_ID],
  ['VIKTOR_APP_SECRET', APP_SECRET],
  ['REPO_URL', REPO_URL],
  ['BRANCH', BRANCH],
  ['VCS_TOKEN', VCS_TOKEN],
]) {
  if (!val) {
    console.error(`ERROR: The ${name} environment variable must be defined.`);
    process.exit(1);
  }
}

if (DEFAULT_MODE === 'DEEP' && !MERGE_REQUEST_ID) {
  console.error('ERROR: The PR_NUMBER (GitHub) or MR_IID (GitLab) environment variable must be defined for DEEP analysis.');
  process.exit(1);
}

// --- Helpers ---

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-APP-ID': APP_ID,
    'X-APP-SECRET': APP_SECRET,
  };
}

async function apiPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} from ${url}: ${text}`);
  }

  return res.json();
}

// The finalize endpoint deliberately responds with HTTP 400 when the analysis completed but
// scored below the acceptance threshold — that is a valid outcome (to be posted on the PR), not
// a request/server error. Only treat the response as fatal when it doesn't carry a result.
async function apiPostFinalize(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => null);

  if (res.ok || (res.status === 400 && data?.result)) {
    return data;
  }

  throw new Error(`HTTP ${res.status} from ${url}: ${JSON.stringify(data)}`);
}

function exec(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: 'pipe', ...opts }).trim();
}

// --- Sandbox: all paths must be inside REPO_DIR ---

function safePath(relative) {
  const abs = path.resolve(REPO_DIR, relative.replace(/^\/+/, ''));
  if (!abs.startsWith(REPO_DIR + path.sep) && abs !== REPO_DIR) {
    throw new Error(`Path "${relative}" is outside the repository.`);
  }
  return abs;
}

// --- Agent tools ---

function toolReadFile({ path: filePath }) {
  try {
    const abs = safePath(filePath);
    if (!fs.existsSync(abs)) return `File not found: ${filePath}`;
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) return `"${filePath}" is a directory, not a file.`;
    if (stat.size > MAX_FILE_SIZE) {
      const content = fs.readFileSync(abs, 'utf8').slice(0, MAX_FILE_SIZE);
      return content + `\n\n[File truncated at ${MAX_FILE_SIZE} bytes]`;
    }
    return fs.readFileSync(abs, 'utf8');
  } catch (err) {
    return `Error reading file: ${err.message}`;
  }
}

function toolListDirectory({ path: dirPath = '.' }) {
  try {
    const abs = safePath(dirPath);
    if (!fs.existsSync(abs)) return `Directory not found: ${dirPath}`;
    if (!fs.statSync(abs).isDirectory()) return `"${dirPath}" is not a directory.`;
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    return entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .join('\n');
  } catch (err) {
    return `Error listing directory: ${err.message}`;
  }
}

function toolSearchInFiles({ query, path: searchPath = '.', regex = false }) {
  try {
    const abs = safePath(searchPath);
    const flags = ['-r', '-l', '--include=*'];
    if (!regex) flags.push('-F'); // fixed string (no regex) unless regex=true
    const result = spawnSync('grep', [...flags, query, abs], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    if (result.error) return `Search error: ${result.error.message}`;
    const files = (result.stdout || '').trim();
    if (!files) return 'No matches found.';
    const lines = files.split('\n').slice(0, MAX_SEARCH_RESULTS);
    const snippetFlags = regex ? ['-n', '-E'] : ['-n', '-F'];
    const snippets = lines.map((f) => {
      const grep = spawnSync('grep', [...snippetFlags, query, f], { encoding: 'utf8', maxBuffer: 64 * 1024 });
      const matches = (grep.stdout || '').trim().split('\n').slice(0, 5).join('\n');
      const rel = path.relative(REPO_DIR, f);
      return `--- ${rel} ---\n${matches}`;
    });
    return snippets.join('\n\n');
  } catch (err) {
    return `Error searching: ${err.message}`;
  }
}

function toolGetFileTree({ path: dirPath = '.', depth = 3 }) {
  const maxDepth = Math.min(Math.max(1, depth), 8);
  try {
    const abs = safePath(dirPath);
    if (!fs.existsSync(abs)) return `Directory not found: ${dirPath}`;

    function walk(dir, currentDepth, prefix) {
      if (currentDepth > maxDepth) return '';
      const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      const lines = [];
      entries.forEach((entry, i) => {
        const isLast = i === entries.length - 1;
        const connector = isLast ? '└── ' : '├── ';
        const childPrefix = isLast ? '    ' : '│   ';
        lines.push(prefix + connector + (entry.isDirectory() ? entry.name + '/' : entry.name));
        if (entry.isDirectory() && currentDepth < maxDepth) {
          lines.push(walk(path.join(dir, entry.name), currentDepth + 1, prefix + childPrefix));
        }
      });
      return lines.filter(Boolean).join('\n');
    }

    const rel = path.relative(REPO_DIR, abs) || '.';
    return rel + '/\n' + walk(abs, 1, '');
  } catch (err) {
    return `Error building file tree: ${err.message}`;
  }
}

function toolFindFiles({ pattern, path: searchPath = '.' }) {
  try {
    const abs = safePath(searchPath);
    const result = spawnSync('find', [abs, '-name', pattern, '-not', '-path', '*/.git/*', '-type', 'f'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    if (result.error) return `Find error: ${result.error.message}`;
    const files = (result.stdout || '').trim();
    if (!files) return 'No files found.';
    return files
      .split('\n')
      .map((f) => path.relative(REPO_DIR, f))
      .slice(0, MAX_SEARCH_RESULTS)
      .join('\n');
  } catch (err) {
    return `Error finding files: ${err.message}`;
  }
}

function toolReadFileLines({ path: filePath, from, to }) {
  try {
    const abs = safePath(filePath);
    if (!fs.existsSync(abs)) return `File not found: ${filePath}`;
    if (fs.statSync(abs).isDirectory()) return `"${filePath}" is a directory, not a file.`;
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    const start = Math.max(1, from) - 1;
    const end = Math.min(lines.length, to);
    if (start >= lines.length) return `Line ${from} is beyond end of file (${lines.length} lines).`;
    return lines
      .slice(start, end)
      .map((line, i) => `${start + i + 1}: ${line}`)
      .join('\n');
  } catch (err) {
    return `Error reading file lines: ${err.message}`;
  }
}

function toolGitLog({ path: filePath, limit = 10 }) {
  try {
    const maxLimit = Math.min(Math.max(1, limit), 50);
    const args = ['-C', REPO_DIR, 'log', `--max-count=${maxLimit}`, '--oneline', '--no-color'];
    if (filePath) {
      safePath(filePath); // validate path is inside repo
      args.push('--', filePath);
    }
    const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 });
    if (result.error) return `Git error: ${result.error.message}`;
    const output = (result.stdout || '').trim();
    return output || 'No commits found.';
  } catch (err) {
    return `Error getting git log: ${err.message}`;
  }
}

const TOOLS = {
  read_file: toolReadFile,
  list_directory: toolListDirectory,
  search_in_files: toolSearchInFiles,
  get_file_tree: toolGetFileTree,
  find_files: toolFindFiles,
  read_file_lines: toolReadFileLines,
  git_log: toolGitLog,
};

function executeTool(name, input) {
  const fn = TOOLS[name];
  if (!fn) return `Unknown tool: ${name}`;
  try {
    return fn(input);
  } catch (err) {
    return `Tool error: ${err.message}`;
  }
}

// --- Parse the final JSON result from the agent's text output ---

function parseAgentResult(text) {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error(`Agent did not return valid JSON. Response was:\n${text.slice(0, 500)}`);
  }
}

// --- Main ---

async function main() {
  // 1. Clone the repository
  console.log(`Cloning repository on branch "${BRANCH}"...`);
  const gitUsername = REPO_URL.includes('github.com') ? 'x-access-token' : 'gitlab-ci-token';
  const repoWithToken = REPO_URL.replace('://', `://${gitUsername}:${VCS_TOKEN}@`);
  try {
    exec(`git clone --depth=50 --branch ${BRANCH} ${repoWithToken} ${REPO_DIR}`);
  } catch (err) {
    console.error(`ERROR: Failed to clone repository: ${err.message}`);
    await fetch(`${API_URL}/semantic-analyze/mcp/error`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ error: 'CLONE_FAILED', branch: BRANCH }),
    }).catch(() => {});
    process.exit(1);
  }
  console.log('Clone successful.');

  // 2. Generate diff
  exec(`git -C ${REPO_DIR} fetch origin ${BASE_BRANCH}:refs/remotes/origin/${BASE_BRANCH}`);
  const codeDiff = exec(`git -C ${REPO_DIR} diff origin/${BASE_BRANCH}...HEAD`);

  if (!codeDiff) {
    console.error(`ERROR: No diff found between "${BASE_BRANCH}" and "${BRANCH}".`);
    process.exit(1);
  }
  console.log(`Diff size: ${codeDiff.length} characters`);

  // 3. Init review session
  console.log(`Initiating Deep analysis for branch "${BRANCH}"...`);
  const initData = await apiPost(`${API_URL}/semantic-analyze/mcp/init`, {
    branch: BRANCH,
    mode: DEFAULT_MODE,
    mergeRequestId: MERGE_REQUEST_ID,
  });

  const { reviewId, issueData, completeUrl, cancelUrl, finalizeUrl } = initData;

  if (!reviewId) {
    console.error(`ERROR: Failed to initiate review. Response: ${JSON.stringify(initData)}`);
    process.exit(1);
  }

  console.log(`Review session started: ${reviewId}`);

  // 4. Build initial message for the agent
  const initialUserMessage = {
    role: 'user',
    content: `## Issue / Ticket Description\n\`\`\`\n${issueData}\n\`\`\`\n\n## Code Diff (branch: ${BRANCH} vs ${BASE_BRANCH})\n\`\`\`diff\n${codeDiff}\n\`\`\`\n\nAnalyze the above. Use tools to explore the repository if needed, then return your analysis as a single JSON object.`,
  };

  const messages = [initialUserMessage];

  // 5. Agent loop
  console.log('Starting agent loop...');
  let stepCount = 0;
  const MAX_STEPS = 20;

  while (stepCount < MAX_STEPS) {
    stepCount++;
    console.log(`Agent step ${stepCount}...`);

    let turnResult;
    try {
      turnResult = await apiPost(completeUrl, { messages });
    } catch (err) {
      console.error(`ERROR: Agent turn failed: ${err.message}`);
      await fetch(cancelUrl, { method: 'POST', headers: authHeaders() }).catch(() => {});
      process.exit(1);
    }

    const { text, toolCalls, finishReason } = turnResult;

    // Add assistant message to history
    const assistantMsg = { role: 'assistant', text: text || '' };
    if (toolCalls && toolCalls.length > 0) {
      assistantMsg.toolCalls = toolCalls;
    }
    messages.push(assistantMsg);

    if (finishReason === 'stop' || !toolCalls || toolCalls.length === 0) {
      // Agent is done — parse the result
      console.log('Agent finished.');
      let result;
      try {
        result = parseAgentResult(text);
      } catch (err) {
        console.error(`ERROR: ${err.message}`);
        await fetch(cancelUrl, { method: 'POST', headers: authHeaders() }).catch(() => {});
        process.exit(1);
      }

      // 6. Finalize
      console.log('Finalizing analysis...');
      let finalizeResult;
      try {
        finalizeResult = await apiPostFinalize(finalizeUrl, { result });
      } catch (err) {
        console.error(`ERROR: Finalize failed: ${err.message}`);
        process.exit(1);
      }

      const score = finalizeResult?.result?.completionScore ?? 'N/A';
      console.log(`Analysis complete. Completion score: ${score}`);
      process.exit(0);
    }

    // Execute tool calls and add results
    const toolResultContents = [];
    for (const tc of toolCalls) {
      console.log(`  Tool call: ${tc.name}(${JSON.stringify(tc.input)})`);
      const result = executeTool(tc.name, tc.input);
      toolResultContents.push({ toolCallId: tc.id, toolName: tc.name, result });
    }
    messages.push({ role: 'tool', results: toolResultContents });
  }

  console.error(`ERROR: Agent exceeded maximum steps (${MAX_STEPS}).`);
  await fetch(cancelUrl, { method: 'POST', headers: authHeaders() }).catch(() => {});
  process.exit(1);
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
