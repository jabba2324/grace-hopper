#!/usr/bin/env python3
"""
Interactive terminal viewer for Managed Agents sessions.
Opened by the VS Code extension's "Open Claude" button.

Shows full conversation history, streams live events, and lets you
type messages that are sent directly into the session.

Usage:
    python3 /app/scripts/attach_session.py <session_id>
"""
import sys
import threading
from pathlib import Path

from anthropic import Anthropic, BadRequestError

STATE_DIR = Path('/app/state')

# ── ANSI colours ─────────────────────────────────────────────────────────────

RESET  = '\033[0m'
BOLD   = '\033[1m'
DIM    = '\033[2m'
CYAN   = '\033[36m'
YELLOW = '\033[33m'
RED    = '\033[31m'

# ── Event rendering ───────────────────────────────────────────────────────────

def render(event) -> str | None:
    t = event.type

    if t == 'agent.message':
        parts = [b.text for b in event.content if getattr(b, 'type', None) == 'text' and b.text]
        return '\n'.join(parts) if parts else None

    if t == 'agent.tool_use':
        snippet = str(event.input)[:160].replace('\n', ' ')
        return f'{DIM}  [{event.name}] {snippet}{RESET}'

    if t == 'user.message':
        parts = [b.text for b in event.content if getattr(b, 'type', None) == 'text' and b.text]
        text  = ' '.join(parts).strip()
        return f'{CYAN}You: {text}{RESET}' if text else None

    if t == 'session.status_running':
        return f'{DIM}── working ──{RESET}'

    if t == 'session.status_idle':
        return f'{DIM}── idle ──{RESET}'

    if t == 'session.status_terminated':
        return f'{RED}── session ended ──{RESET}'

    return None

# ── Helpers ───────────────────────────────────────────────────────────────────

def _print_prompt() -> None:
    sys.stdout.write(f'{CYAN}> {RESET}')
    sys.stdout.flush()

def _print(line: str) -> None:
    sys.stdout.write(f'\r{line}\n')
    sys.stdout.flush()

# ── History ───────────────────────────────────────────────────────────────────

def show_history(client: Anthropic, session_id: str) -> None:
    print(f'{DIM}Loading history…{RESET}', flush=True)
    try:
        resp   = client.beta.sessions.events.list(session_id=session_id)
        lines  = [r for e in resp.data for r in [render(e)] if r]
        if lines:
            print('\n'.join(lines), flush=True)
        else:
            print(f'{DIM}(no history){RESET}', flush=True)
    except Exception as exc:
        print(f'{YELLOW}Could not load history: {exc}{RESET}', flush=True)
    print(f'{DIM}────────────────────────{RESET}', flush=True)

# ── Live stream (runs in a background thread) ─────────────────────────────────

def stream_thread(client: Anthropic, session_id: str,
                  stop: threading.Event, idle: threading.Event) -> None:
    try:
        with client.beta.sessions.events.stream(session_id=session_id) as stream:
            for event in stream:
                line = render(event)
                if line:
                    _print(line)
                if event.type == 'session.status_idle':
                    idle.set()
                    _print_prompt()
                if event.type == 'session.status_terminated':
                    return
    except Exception as exc:
        _print(f'{RED}Stream error: {exc}{RESET}')
    finally:
        stop.set()

# ── Send with interrupt-on-busy ───────────────────────────────────────────────

def send_message(client: Anthropic, session_id: str, text: str,
                 idle: threading.Event) -> None:
    events = [{'type': 'user.message', 'content': [{'type': 'text', 'text': text}]}]
    try:
        client.beta.sessions.events.send(session_id=session_id, events=events)
    except BadRequestError as exc:
        if 'waiting on responses' not in str(exc):
            raise
        _print(f'{YELLOW}Agent is mid-tool — interrupting so your message can be sent…{RESET}')
        client.beta.sessions.events.send(
            session_id=session_id,
            events=[{'type': 'user.interrupt'}],
        )
        idle.clear()
        idle.wait(timeout=15)
        client.beta.sessions.events.send(session_id=session_id, events=events)

# ── Main ──────────────────────────────────────────────────────────────────────

def pause_agent(issue_num: int) -> None:
    pause_file = STATE_DIR / f'pause-{issue_num}'
    pause_file.touch()
    _print(f'{YELLOW}Pause signal sent — agent will stop within ~5 seconds{RESET}')


def main(session_id: str, issue_num: int | None = None) -> None:
    pause_hint = '  ·  /pause to pause agent' if issue_num else ''
    print(f'\n{BOLD}Grace Hopper — {session_id}{RESET}')
    print(f'{DIM}Type a message and Enter to send{pause_hint}  ·  Ctrl+C to exit{RESET}\n')

    client = Anthropic()

    show_history(client, session_id)

    try:
        sess = client.beta.sessions.retrieve(session_id)
    except Exception as exc:
        print(f'{YELLOW}Could not retrieve session: {exc}{RESET}')
        return

    if sess.status == 'terminated':
        print(f'{RED}This session has ended — no further interaction possible.{RESET}')
        return

    if sess.status == 'archived':
        print(f'{YELLOW}This session is archived.{RESET}')
        return

    stop = threading.Event()
    idle = threading.Event()
    if sess.status == 'idle':
        idle.set()

    t = threading.Thread(target=stream_thread, args=(client, session_id, stop, idle), daemon=True)
    t.start()

    if sess.status == 'idle':
        _print_prompt()
    else:
        print(f'{DIM}Agent is {sess.status} — streaming live output…{RESET}')

    while not stop.is_set():
        try:
            line = sys.stdin.readline()
        except KeyboardInterrupt:
            break
        if not line:
            break
        text = line.rstrip('\n').strip()
        if not text:
            continue
        if text == '/pause':
            if issue_num:
                pause_agent(issue_num)
            else:
                _print(f'{YELLOW}Pause unavailable — issue number not known{RESET}')
            continue
        try:
            send_message(client, session_id, text, idle)
        except Exception as exc:
            _print(f'{RED}Send error: {exc}{RESET}')

    stop.set()
    print(f'\n{DIM}Disconnected.{RESET}')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: attach_session.py <session_id> [issue_num]', file=sys.stderr)
        sys.exit(1)
    _issue = int(sys.argv[2]) if len(sys.argv) > 2 else None
    try:
        main(sys.argv[1], _issue)
    except KeyboardInterrupt:
        print('\nExiting.')
