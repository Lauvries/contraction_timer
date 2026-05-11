#!/usr/bin/env python3

import json
import sys


def _read_stdin_json():
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    try:
        return json.loads(raw)
    except Exception:
        return {}


def _get_prompt(payload):
    # Cursor hook payload shape can vary; be defensive.
    for k in ("prompt", "input", "text", "message", "content"):
        v = payload.get(k)
        if isinstance(v, str) and v.strip():
            return v
    # Sometimes nested
    msg = payload.get("message")
    if isinstance(msg, dict):
        for k in ("content", "text"):
            v = msg.get(k)
            if isinstance(v, str) and v.strip():
                return v
    return ""


def main():
    payload = _read_stdin_json()
    prompt = _get_prompt(payload).strip()

    normalized = prompt.lower().strip()
    if normalized in ("push.", "push"):
        rewritten = (
            "Stage all current changes, generate a good git commit message based on the diff, "
            "commit, and push to the tracked remote branch. "
            "If there is nothing to commit, say so and do nothing."
        )
        out = {
            "permission": "allow",
            "updated_input": rewritten,
            "user_message": "Running: add + AI commit message + commit + push",
        }
        sys.stdout.write(json.dumps(out))
        return

    sys.stdout.write(json.dumps({"permission": "allow"}))


if __name__ == "__main__":
    main()

