#!/usr/bin/env node
'use strict';
/**
 * Claude runner — spawns the Claude CLI with --output-format stream-json,
 * formats the event stream to the log file, and handles pause signals.
 *
 * Env vars (set by worker.sh):
 *   CLAUDE_PROMPT       - the task prompt (required)
 *   CLAUDE_LOGFILE      - path to append formatted log lines (required)
 *   CLAUDE_MODEL        - model name (default: claude-sonnet-4-6)
 *   CLAUDE_CWD          - working directory for Claude (default: cwd)
 *   CLAUDE_PAUSE_FILE   - path watched for pause signal
 *   CLAUDE_SESSION_FILE - path where the session ID is written on exit
 *
 * Exit codes:
 *   0 - Claude completed successfully
 *   1 - Claude exited with an error
 *   2 - paused via CLAUDE_PAUSE_FILE
 */

const { spawn } = require('child_process');
const fs        = require('fs');

const LOGFILE         = process.env.CLAUDE_LOGFILE;
const MODEL           = process.env.CLAUDE_MODEL          || 'claude-sonnet-4-6';
const CWD             = process.env.CLAUDE_CWD            || process.cwd();
const PAUSE_FILE      = process.env.CLAUDE_PAUSE_FILE;
const SESSION_FILE    = process.env.CLAUDE_SESSION_FILE;
const PROMPT          = process.env.CLAUDE_PROMPT;
const RESUME_SESSION  = process.env.CLAUDE_RESUME_SESSION || '';

if (!LOGFILE || !PROMPT) {
    process.stderr.write('run_claude.js: CLAUDE_LOGFILE and CLAUDE_PROMPT required\n');
    process.exit(1);
}

const logStream = fs.createWriteStream(LOGFILE, { flags: 'a' });
const log = line => logStream.write(line + '\n');

// ── Format events ────────────────────────────────────────────────────────────

function fmtBlock(block) {
    if (block.type === 'text') {
        const t = block.text.trim();
        return t || null;
    }
    if (block.type === 'tool_use') {
        const i = block.input || {};
        switch (block.name) {
            case 'Bash':   return `[bash] ${(i.command || '').slice(0, 200)}`;
            case 'Edit':   return `[edit] ${i.file_path || ''}`;
            case 'Write':  return `[write] ${i.file_path || ''}`;
            case 'Read':   return `[read] ${i.file_path || ''}`;
            case 'Glob':   return `[glob] ${i.pattern || ''}`;
            case 'Grep':   return `[grep] ${i.pattern || ''} in ${i.path || '.'}`;
            default:       return `[${block.name.toLowerCase()}] ${JSON.stringify(i).slice(0, 120)}`;
        }
    }
    return null;
}

function fmtToolResult(block) {
    if (block.type !== 'tool_result') return null;
    let content = block.content || '';
    if (Array.isArray(content)) {
        content = content.filter(c => c.type === 'text').map(c => c.text).join('');
    }
    const trimmed = content.trim();
    if (!trimmed) return null;
    const lines = trimmed.split('\n');
    const head  = lines.slice(0, 5).join('\n');
    const tail  = lines.length > 5 ? `\n  … (+${lines.length - 5} lines)` : '';
    return `  ${head}${tail}`;
}

// ── Spawn Claude ─────────────────────────────────────────────────────────────

const args = [
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', MODEL,
];

if (RESUME_SESSION) {
    args.push('--resume', RESUME_SESSION);
}

args.push('-p', PROMPT);

const claude = spawn('claude', args, {
    cwd:   CWD,
    stdio: ['ignore', 'pipe', 'pipe'],
    env:   process.env,
});

let sessionId = '';
let paused    = false;
let success   = false;
let buf       = '';

// ── Pause watcher ────────────────────────────────────────────────────────────

const pauseTimer = PAUSE_FILE ? setInterval(() => {
    try {
        if (fs.existsSync(PAUSE_FILE)) {
            log('[paused] Pause requested — stopping Claude');
            fs.unlinkSync(PAUSE_FILE);
            paused = true;
            claude.kill('SIGTERM');
        }
    } catch { /* ignore */ }
}, 1000) : null;

// ── Parse stream-json events ─────────────────────────────────────────────────

claude.stdout.on('data', chunk => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop(); // keep incomplete last line

    for (const line of lines) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }

        if (ev.type === 'system' && ev.subtype === 'init') {
            sessionId = ev.session_id || '';
            log(`[session] ${sessionId}  model=${ev.model || MODEL}`);

        } else if (ev.type === 'assistant') {
            for (const block of (ev.message.content || [])) {
                const fmt = fmtBlock(block);
                if (fmt) log(fmt);
            }

        } else if (ev.type === 'user') {
            for (const block of (ev.message.content || [])) {
                const fmt = fmtToolResult(block);
                if (fmt) log(fmt);
            }

        } else if (ev.type === 'result') {
            success = ev.subtype === 'success' && !ev.is_error;
            const dur  = ev.duration_ms  ? `${(ev.duration_ms / 1000).toFixed(1)}s`            : '';
            const cost = ev.total_cost_usd ? ` $${ev.total_cost_usd.toFixed(4)}`               : '';
            const turns = ev.num_turns    ? ` ${ev.num_turns} turn${ev.num_turns > 1 ? 's' : ''}` : '';
            log(`[${ev.subtype}]${turns} ${dur}${cost}`);
        }
    }
});

// Suppress the oauth connector warning; surface everything else
claude.stderr.on('data', chunk => {
    const text = chunk.toString().trim();
    if (text && !text.includes('connectors are disabled') && !text.includes('claude.ai')) {
        log(`[stderr] ${text}`);
    }
});

// ── Exit ─────────────────────────────────────────────────────────────────────

claude.on('close', code => {
    if (pauseTimer) clearInterval(pauseTimer);
    // Flush any final line that had no trailing newline (e.g. the result event)
    if (buf.trim()) {
        try {
            const ev = JSON.parse(buf);
            if (ev.type === 'result') {
                success = ev.subtype === 'success' && !ev.is_error;
                const dur   = ev.duration_ms   ? `${(ev.duration_ms / 1000).toFixed(1)}s`              : '';
                const cost  = ev.total_cost_usd ? ` $${ev.total_cost_usd.toFixed(4)}`                  : '';
                const turns = ev.num_turns      ? ` ${ev.num_turns} turn${ev.num_turns > 1 ? 's' : ''}` : '';
                log(`[${ev.subtype}]${turns} ${dur}${cost}`);
            } else if (ev.type === 'system' && ev.subtype === 'init') {
                sessionId = ev.session_id || '';
            }
        } catch { /* ignore malformed final line */ }
    }
    logStream.end(() => {
        if (SESSION_FILE && sessionId) {
            try { fs.writeFileSync(SESSION_FILE, sessionId); } catch { /* ignore */ }
        }
        if (paused)   process.exit(2);
        if (success)  process.exit(0);
        process.exit(code || 1);
    });
});
