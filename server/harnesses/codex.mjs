/**
 * Codex CLI (OpenAI) — the harness the upstream README lists as "not yet".
 *
 * Sessions are JSONL rollouts under ~/.codex/sessions/YYYY/MM/DD/. The first
 * line is a `session_meta` record carrying everything worth drawing — cwd, git
 * branch, model provider, CLI version, and for subagents a nickname and the
 * parent thread. Later lines are the turns.
 *
 * Only the head of each file is read. A working machine accumulates hundreds
 * of rollouts and the scan runs on every poll, so parsing whole transcripts
 * would make the colony crawl for two numbers the filesystem already knows:
 * size and last activity come from stat() instead, which is free.
 *
 * Read-only. Codex has no archive flag of its own and no deep link to hand the
 * OS, so both are declined honestly rather than pretending the click worked.
 */
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = process.env.CODEX_HOME
  ? path.join(process.env.CODEX_HOME, 'sessions')
  : path.join(os.homedir(), '.codex', 'sessions');

/** Touched this recently and it still looks like somebody is working in it. */
const ACTIVE_WINDOW_MS = 10 * 60 * 1000;
/** Enough of the head to reach the meta line and the first real prompt. */
const HEAD_BYTES = 64 * 1024;

async function detect() {
  try {
    const s = await fs.stat(ROOT);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/** Every rollout-*.jsonl under the date tree, without walking it twice. */
async function findRollouts(dir, out = [], depth = 0) {
  if (depth > 4) return out;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await findRollouts(full, out, depth + 1);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

function readHead(file, bytes = HEAD_BYTES) {
  return new Promise((resolve) => {
    let data = '';
    const stream = createReadStream(file, { encoding: 'utf8', start: 0, end: bytes });
    stream.on('data', (c) => { data += c; });
    stream.on('error', () => resolve(''));
    stream.on('end', () => resolve(data));
  });
}

/** Text out of Codex's content array, which mixes input_text and output_text. */
function textOf(payload) {
  const content = payload?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => c?.text || '').join(' ').trim();
}

/**
 * The first thing a human actually asked. Codex front-loads developer messages
 * — model-switch notices, team instructions, the base prompt — and using one
 * of those as the title makes every card read the same.
 */
function firstUserPrompt(lines) {
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const p = rec?.payload;
    if (rec?.type !== 'response_item' || p?.type !== 'message') continue;
    if (p.role !== 'user') continue;
    const text = textOf(p);
    if (!text) continue;
    // Harness scaffolding is not the user's words. Codex injects the repo's
    // AGENTS.md and several tagged blocks as 'user' turns, and using one as
    // the title made every card in a repo read identically.
    if (/^<(model_switch|environment_context|user_instructions)/.test(text)) continue;
    if (/^#+\s*AGENTS\.md/i.test(text)) continue;
    if (/<(INSTRUCTIONS|user_instructions|environment_context)>/i.test(text.slice(0, 400))) continue;
    return text.replace(/\s+/g, ' ').trim();
  }
  return '';
}

async function scanThreads() {
  const files = await findRollouts(ROOT);
  const now = Date.now();

  const threads = await Promise.all(files.map(async (file) => {
    let stat;
    try { stat = await fs.stat(file); } catch { return null; }

    const head = await readHead(file);
    if (!head) return null;
    const lines = head.split('\n').filter(Boolean);

    let meta;
    try { meta = JSON.parse(lines[0]); } catch { return null; }
    if (meta?.type !== 'session_meta') return null;
    const m = meta.payload || {};

    const cwd = m.cwd || '';
    const prompt = firstUserPrompt(lines);
    const modified = stat.mtimeMs;
    const created = m.timestamp ? Date.parse(m.timestamp) : modified;

    // A subagent is somebody else's helper, not a thread you opened. Naming it
    // after its nickname keeps the colony readable when one task spawns six.
    const sub = m.thread_source === 'subagent';
    const nickname = m.agent_nickname || '';

    return {
      id: `codex:${m.id || m.session_id || path.basename(file)}`,
      title: prompt ? prompt.slice(0, 80) : (nickname ? `${nickname} (subagent)` : 'Untitled Codex thread'),
      preview: prompt.slice(0, 240),
      project: cwd ? path.basename(cwd.replace(/[\\/]+$/, '')) : 'codex',
      projectPath: cwd,
      worktree: '',
      cwd,
      gitBranch: m.git?.branch || m.git?.current_branch || '',
      model: m.model_provider || m.model || '',
      effort: sub ? `subagent${nickname ? ' · ' + nickname : ''}` : (m.originator || ''),
      createdAt: created,
      lastActivityAt: modified,
      lastFocusedAt: 0,
      running: now - modified < ACTIVE_WINDOW_MS,
      // Codex records no read state, so nothing may claim to know it.
      unread: false,
      hasError: false,
      archived: false,
      // The transcript really is the building: bigger file, more built.
      sizeBytes: stat.size,
      source: m.originator || 'codex',
      canOpen: false,
      canArchive: false,
      ref: { file, id: m.id || m.session_id || '' },
    };
  }));

  return threads.filter(Boolean);
}

function openThread() {
  return { ok: false, error: 'Codex has no deep link — resume it with `codex --resume` in that folder.' };
}

function newSession(dir) {
  return { ok: false, error: `No Codex URL scheme. Run \`codex\` in ${dir || 'the folder'}.` };
}

async function setArchived() {
  return { ok: false, error: 'Codex has no archive flag of its own.' };
}

export default {
  id: 'codex',
  name: 'Codex CLI',
  detect,
  scanThreads,
  openThread,
  newSession,
  setArchived,
};
