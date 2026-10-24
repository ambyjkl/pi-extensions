"""Run the package-directory TUI with a local provider and controlled PTY input.

Run from the repository root with uv run python packages/pi-starship/test/settings-chat-smoke.py.
The optional first argument selects an unpacked package directory.
"""

import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import time


repository = Path(__file__).resolve().parents[3]
package = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else repository / "packages/pi-starship"
fixture = repository / "packages/pi-starship/test/settings-chat-smoke-fixture.ts"
ansi = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")


def run(action, mode):
    with tempfile.TemporaryDirectory(prefix="starship-pty-") as temporary:
        root = Path(temporary)
        agent = root / "agent"
        agent.mkdir()
        original = "format = '$model'\n"
        active = agent / "pi-starship.toml"
        active.write_text(original)
        (agent / "settings.json").write_text(json.dumps({"enableInstallTelemetry": False, "quietStartup": True}))
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 44, 120, 0, 0))
        environment = dict(os.environ, PI_CODING_AGENT_DIR=str(agent), TERM="xterm-256color", NO_COLOR="1")
        child = subprocess.Popen([
            shutil.which("pi"), "--offline", "--no-session", "--no-context-files", "--no-extensions",
            "--no-skills", "--no-prompt-templates", "--no-themes", "--no-approve", "--tui-mode", mode,
            "-e", str(package), "-e", str(fixture), "--provider", "starship-smoke", "--model", "configuration-smoke",
        ], cwd=root, env=environment, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        output = ""
        ready = False

        def receive():
            nonlocal output
            readable, _, _ = select.select([master], [], [], 1)
            if not readable:
                if child.poll() is not None:
                    raise AssertionError(f"Pi exited early: {child.returncode}\n{output[-8000:]}")
                return
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b""
            if not data:
                raise AssertionError(f"Pi closed PTY\n{output[-8000:]}")
            # Answer terminal capability/cursor queries without a human terminal.
            if b"\x1b[6n" in data:
                os.write(master, b"\x1b[1;1R")
            output += ansi.sub("", data.decode("utf-8", errors="replace"))

        def wait_for(text):
            nonlocal output
            # Startup has no test deadline until the extension's readiness handshake.
            deadline = time.monotonic() + 20 if ready else None
            while text not in output:
                if deadline is not None and time.monotonic() > deadline:
                    raise AssertionError(f"Timed out waiting for {text!r}\n{output[-8000:]}")
                receive()
            output = output[output.index(text) + len(text):]

        def send(data):
            os.write(master, data)

        try:
            wait_for("STARSHIP_SMOKE_READY")
            ready = True
            send(b"/starship\r")
            wait_for("Configure with agent")
            send(b"\x1b[B" * 7 + b"\r")
            wait_for("─ pi-starship ")
            send(b"first\r")
            wait_for("SMOKE_FIRST_READY")
            assert active.read_text() == original
            send(b"second\r")
            wait_for("SMOKE_SECOND_READY")
            assert active.read_text() == original
            record = json.loads((root / "smoke-record.json").read_text())
            assert record["skillLoaded"] and record["tools"] == ["read", "write", "edit"]
            assert record["requests"] == 4
            assert record["executedTools"] == ["read", "write", "edit"]
            if action == "save":
                send(b"\x1b")
                wait_for("Save and apply reviewed draft")
                send(b"\x1b[B" * 3 + b"\r")
                wait_for("Review draft before saving")
                send(b"\r")
                wait_for("Save and apply settings draft?")
                send(b"\r")
            else:
                send(b"\x03")
            deadline = time.monotonic() + 20
            while Path(record["draftPath"]).exists():
                assert time.monotonic() < deadline, output[-8000:]
                receive()
            if action == "save":
                assert active.read_text() == "# smoke draft\nformat = '$model$directory'\n"
                assert len(list((agent / "pi-starship/history").glob("*.toml"))) == 1
            else:
                assert active.read_text() == original
                assert not (agent / "pi-starship/history").exists()
            send(b"/smoke-check\r")
            child.wait(timeout=20)
            assert child.returncode == 0
            record = json.loads((root / "smoke-record.json").read_text())
            assert record["mainMessages"] == 0
            print(f"PASS {mode} {action}: two draft turns, loaded skill, three tools, no parent messages, no reload, cleaned draft")
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
            os.close(master)


for mode in ("regular", "fullscreen"):
    run("discard", mode)
    run("save", mode)
