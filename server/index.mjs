#!/usr/bin/env node
// Zero-dependency MCP (stdio) server exposing the Google Cloud CLIs (gcloud, bq, gsutil).
// Auth reuses the user's local gcloud credentials; login is done through Google's own browser flow.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const MAX_OUT = 100_000;
const ALLOW_SECRETS = process.env.GCP_ALLOW_SECRET_OUTPUT === '1';
const READ_ONLY_MODE = process.env.GCP_READ_ONLY === '1';

// ---- command classification ----
const READ_VERBS = new Set(['list', 'describe', 'get', 'show', 'read', 'tail', 'info', 'search', 'check', 'explain',
  'version', 'ls', 'head', 'cat', 'query-dry', 'get-iam-policy', 'get-value', 'get-credentials-info', 'analyze',
  'lookup', 'estimate', 'validate', 'print-settings', 'list-grantable-roles', 'test-iam-permissions', 'logs',
  'list-tags', 'list-url-maps', 'help', 'topic', 'components']);
const DANGER_WORDS = ['delete', 'remove', 'destroy', 'reset', 'wipe', 'purge', 'disable', 'revoke', 'rm', 'rb',
  'set-iam-policy', 'remove-iam-policy-binding', 'add-iam-policy-binding', 'undelete', 'detach', 'drop', 'truncate'];
const WRITE_WORDS = new Set(['create', 'update', 'deploy', 'set', 'add', 'import', 'export', 'start', 'stop', 'resume', 'suspend',
  'restart', 'enable', 'patch', 'apply', 'submit', 'run', 'ssh', 'scp', 'cp', 'mv', 'rsync', 'attach', 'resize', 'upload',
  'copy', 'move', 'reserve', 'release', 'rollback', 'cancel', 'login', 'activate', 'revoke', 'call', 'invoke', 'build', 'push', 'tag', 'untag', 'sign', 'encrypt', 'decrypt']);
const SECRET_PATTERNS = [
  /auth\b.*\bprint-access-token/, /auth\b.*\bprint-identity-token/, /secrets\b.*\bversions\b.*\baccess/,
  /\bconfig-helper\b/, /\bkeys\b.*\bcreate\b/, /\bapplication-default\b.*\bprint-access-token/,
];

function classify(tool, args) {
  const words = args.filter((a) => !a.startsWith('-'));
  const joined = words.join(' ');
  const flat = args.join(' ');
  if (!ALLOW_SECRETS && SECRET_PATTERNS.some((r) => r.test(flat)))
    return { level: 'blocked', reason: 'This command can print or create credentials/secrets. Set GCP_ALLOW_SECRET_OUTPUT=1 in the environment to allow, or run it yourself in a terminal.' };
  if (args.includes('--help') || args.includes('-h') || words[0] === 'help') return { level: 'read' };
  if (tool === 'bq') {
    const sub = words[0];
    if (['ls', 'show', 'head', 'version', 'info', 'help'].includes(sub)) return { level: 'read' };
    if (sub === 'query' && args.includes('--dry_run')) return { level: 'read' };
    if (['rm', 'rb', 'truncate', 'cancel'].includes(sub)) return { level: 'danger' };
    return { level: 'write' };
  }
  if (tool === 'gsutil') {
    const sub = words[0];
    if (['ls', 'cat', 'stat', 'du', 'hash', 'version', 'help'].includes(sub)) return { level: 'read' };
    if (['rm', 'rb', 'rsync'].includes(sub) || flat.includes(' -d')) return { level: 'danger' };
    return { level: 'write' };
  }
  if (words[0] === 'config') return { level: ['set', 'unset'].includes(words[1]) ? 'write' : 'read' };
  if (words.some((w) => WRITE_WORDS.has(w))) return { level: 'write' };
  if (words.slice(0, 6).some((w) => READ_VERBS.has(w))) return { level: 'read' };
  return { level: 'write' };
}

// ---- process runner ----
function run(bin, args, { timeoutSec = 300, input, quiet = false, stdinNull = true } = {}) {
  return new Promise((resolve) => {
    const finalArgs = quiet ? [...args, '--quiet'] : args;
    const env = { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: quiet ? '1' : process.env.CLOUDSDK_CORE_DISABLE_PROMPTS || '' };
    const p = spawn(bin, finalArgs, { env, stdio: [stdinNull ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    const cut = (s) => (s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n…[truncated ${s.length - MAX_OUT} chars; add --filter/--limit/--format]` : s);
    p.stdout.on('data', (d) => { out += d; if (out.length > MAX_OUT * 3) out = out.slice(0, MAX_OUT * 3); });
    p.stderr.on('data', (d) => { err += d; if (err.length > MAX_OUT) err = err.slice(0, MAX_OUT); });
    const t = setTimeout(() => { if (!done) { p.kill('SIGKILL'); resolve({ code: -1, out: cut(out), err: cut(err) + `\n[timed out after ${timeoutSec}s]` }); done = true; } }, timeoutSec * 1000);
    p.on('error', (e) => { if (!done) { clearTimeout(t); done = true; resolve({ code: -1, out: '', err: e.code === 'ENOENT' ? `${bin} not found on PATH. Install the Google Cloud SDK: https://cloud.google.com/sdk/docs/install` : String(e) }); } });
    p.on('close', (code) => { if (!done) { clearTimeout(t); done = true; resolve({ code, out: cut(out), err: cut(err) }); } });
    if (input && !stdinNull) p.stdin.end(input);
  });
}
const fmt = (r) => `exit code: ${r.code}\n${r.out}${r.err ? `\n--- stderr ---\n${r.err}` : ''}`.trim();
const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], isError });

// ---- tools ----
const cliTool = (name, bin, description) => ({
  def: {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: {
        args: { type: 'array', items: { type: 'string' }, description: `Arguments after \`${bin}\`, one element per token. Example: ["compute","instances","list","--project","my-proj"]. No shell is used, so no quoting or pipes.` },
        confirm: { type: 'boolean', description: 'Must be true to run commands that modify or delete resources. Only set after the user has explicitly approved this exact command.' },
        timeoutSec: { type: 'number', description: 'Timeout in seconds (default 300, max 1800).' },
      },
      required: ['args'],
    },
    annotations: { openWorldHint: true, destructiveHint: true },
  },
  async handler({ args, confirm, timeoutSec }) {
    if (!Array.isArray(args) || !args.length || args.some((a) => typeof a !== 'string')) return textResult('args must be a non-empty array of strings', true);
    if (args[0] === bin || args[0] === 'gcloud') args = args.slice(1);
    const c = classify(bin, args);
    if (c.level === 'blocked') return textResult(`BLOCKED: ${c.reason}`, true);
    if (c.level !== 'read') {
      if (READ_ONLY_MODE) return textResult('BLOCKED: GCP_READ_ONLY=1 is set; only read-only commands are allowed.', true);
      if (!confirm) return textResult(`CONFIRMATION REQUIRED (${c.level === 'danger' ? 'DESTRUCTIVE' : 'modifies state / may cost money'}): \`${bin} ${args.join(' ')}\`\nNothing was executed. Show this command to the user, and only re-call with confirm=true after they approve.`, true);
    }
    let a = args;
    const hasFmt = a.some((x) => x === '--format' || x.startsWith('--format='));
    const skipFmt = ['ssh', 'scp', 'help', 'topic'].some((w) => a.includes(w)) || a.includes('--help') || bin !== 'gcloud';
    if (!hasFmt && !skipFmt && c.level === 'read') a = [...a, '--format=json'];
    const r = await run(bin, a, { timeoutSec: Math.min(Math.max(timeoutSec || 300, 5), 1800), quiet: c.level !== 'read' && bin === 'gcloud' });
    return textResult(fmt(r), r.code !== 0);
  },
});

const tools = new Map();
const add = (t) => tools.set(t.def.name, t);

add(cliTool('gcloud', 'gcloud', 'Run any gcloud CLI command (compute, run, storage, iam, container, functions, sql, projects, services, logging, ...). Read-only commands (list/describe/get...) run immediately; anything that modifies state needs confirm=true after user approval; credential-printing commands are blocked. JSON output is added automatically for reads.'));
add(cliTool('bq', 'bq', 'Run a BigQuery CLI command (bq ls, bq show, bq query --use_legacy_sql=false "SELECT ..."). Queries bill per byte scanned: use --dry_run first to estimate cost. Queries are treated as writes and need confirm=true.'));
add(cliTool('gsutil', 'gsutil', 'Run a gsutil command (ls, cp, rsync, rm...). Prefer `gcloud storage` for new work. Non-read commands need confirm=true.'));

add({
  def: {
    name: 'gcloud_auth_status',
    description: 'Show who is logged in to gcloud (accounts, active account, active project/region/zone) and whether Application Default Credentials exist. Call this first to check login state.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  async handler() {
    const [acc, cfg] = await Promise.all([
      run('gcloud', ['auth', 'list', '--format=json']),
      run('gcloud', ['config', 'list', '--format=json']),
    ]);
    const adc = await run('gcloud', ['auth', 'application-default', 'print-access-token', '--quiet'], { timeoutSec: 30 });
    return textResult(JSON.stringify({
      accounts: safeJson(acc.out) ?? acc.err,
      config: safeJson(cfg.out) ?? cfg.err,
      applicationDefaultCredentials: adc.code === 0 ? 'present' : 'missing (run gcloud_login with adc=true)',
    }, null, 2));
  },
});

add({
  def: {
    name: 'gcloud_login',
    description: 'Log in with a Google account. Opens the Google sign-in page in the browser on the user\'s machine and waits (up to 5 min) for them to finish. Set adc=true to also create Application Default Credentials (needed by client libraries/Terraform). Only call when the user asked to log in.',
    inputSchema: {
      type: 'object',
      properties: {
        adc: { type: 'boolean', description: 'Login for Application Default Credentials (gcloud auth application-default login) instead of CLI credentials.' },
        noLaunchBrowser: { type: 'boolean', description: 'Remote/headless machine: print a URL and read the verification code from `code`. Prefer false on a local desktop.' },
        code: { type: 'string', description: 'Verification code, only for the second step of noLaunchBrowser flow.' },
      },
    },
    annotations: { openWorldHint: true },
  },
  async handler({ adc, noLaunchBrowser }) {
    const base = adc ? ['auth', 'application-default', 'login'] : ['auth', 'login', '--brief'];
    if (noLaunchBrowser) {
      return textResult('Headless login needs an interactive terminal. Ask the user to run this in their own terminal:\n\n  ' + (adc ? 'gcloud auth application-default login --no-launch-browser' : 'gcloud auth login --no-launch-browser') + '\n\nThen call gcloud_auth_status.');
    }
    const r = await run('gcloud', base, { timeoutSec: 300 });
    return textResult(fmt(r) + '\n\nRun gcloud_auth_status to confirm.', r.code !== 0);
  },
});

add({
  def: {
    name: 'gcloud_set_project',
    description: 'Set the active gcloud project (gcloud config set project). Changes local CLI config only, not cloud resources.',
    inputSchema: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'] },
  },
  async handler({ project }) {
    if (!/^[a-z][a-z0-9-]{4,29}$/.test(project || '')) return textResult('Invalid project id', true);
    const r = await run('gcloud', ['config', 'set', 'project', project]);
    return textResult(fmt(r), r.code !== 0);
  },
});

add({
  def: {
    name: 'gcloud_list_projects',
    description: 'List projects the logged-in account can access (id, name, number).',
    inputSchema: { type: 'object', properties: { filter: { type: 'string', description: 'Optional gcloud --filter expression.' } } },
    annotations: { readOnlyHint: true },
  },
  async handler({ filter }) {
    const a = ['projects', 'list', '--format=json(projectId,name,projectNumber,lifecycleState)'];
    if (filter) a.push('--filter', filter);
    const r = await run('gcloud', a);
    return textResult(fmt(r), r.code !== 0);
  },
});

add({
  def: {
    name: 'gcloud_help',
    description: 'Show gcloud help for a command group to discover commands/flags, e.g. ["run","deploy"]. Output truncated.',
    inputSchema: { type: 'object', properties: { command: { type: 'array', items: { type: 'string' } } }, required: ['command'] },
    annotations: { readOnlyHint: true },
  },
  async handler({ command }) {
    const r = await run('gcloud', [...(command || []), '--help'], { timeoutSec: 60 });
    return textResult(fmt(r), r.code !== 0);
  },
});

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

// ---- MCP stdio loop ----
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  const reply = (result) => id !== undefined && send({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });
  try {
    if (method === 'initialize') reply({ protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'gcp', version: '0.1.0' } });
    else if (method === 'ping') reply({});
    else if (method === 'tools/list') reply({ tools: [...tools.values()].map((t) => t.def) });
    else if (method === 'tools/call') {
      const t = tools.get(params?.name);
      if (!t) return fail(-32602, `Unknown tool: ${params?.name}`);
      try { reply(await t.handler(params.arguments || {})); } catch (e) { reply(textResult(String(e.message || e), true)); }
    } else if (id !== undefined) fail(-32601, `Method not found: ${method}`);
  } catch (e) { fail(-32603, String(e.message || e)); }
});
