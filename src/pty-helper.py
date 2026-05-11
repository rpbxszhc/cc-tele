#!/usr/bin/env python3
import argparse
import base64
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios


def emit(message):
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def set_nonblocking(fd):
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)


def resize(fd, rows, cols):
    packed = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, packed)


def write_all(fd, data):
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        view = view[written:]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--rows", type=int, default=30)
    parser.add_argument("--cols", type=int, default=100)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()

    command = args.command
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        emit({"type": "error", "message": "missing command"})
        return 2

    pid, master_fd = pty.fork()
    if pid == 0:
        os.chdir(args.cwd)
        os.execvpe(command[0], command, os.environ)

    resize(master_fd, args.rows, args.cols)
    set_nonblocking(master_fd)
    set_nonblocking(sys.stdin.fileno())
    emit({"type": "ready", "pid": pid})

    input_buffer = b""
    exit_sent = False

    while True:
        readable, _, _ = select.select([master_fd, sys.stdin.fileno()], [], [], 0.2)

        if master_fd in readable:
            try:
                data = os.read(master_fd, 4096)
            except OSError as error:
                if error.errno != errno.EIO:
                    emit({"type": "error", "message": str(error)})
                data = b""
            if data:
                emit({
                    "type": "output",
                    "data": base64.b64encode(data).decode("ascii"),
                })
            else:
                break

        if sys.stdin.fileno() in readable:
            try:
                chunk = os.read(sys.stdin.fileno(), 4096)
            except BlockingIOError:
                chunk = b""
            if not chunk:
                try:
                    os.kill(pid, signal.SIGHUP)
                except ProcessLookupError:
                    pass
            else:
                input_buffer += chunk
                while b"\n" in input_buffer:
                    line, input_buffer = input_buffer.split(b"\n", 1)
                    if not line:
                        continue
                    try:
                        message = json.loads(line.decode("utf-8"))
                    except json.JSONDecodeError as error:
                        emit({"type": "error", "message": f"invalid json: {error}"})
                        continue

                    message_type = message.get("type")
                    if message_type == "write":
                        write_all(master_fd, message.get("data", "").encode("utf-8"))
                    elif message_type == "resize":
                        resize(master_fd, int(message.get("rows", args.rows)), int(message.get("cols", args.cols)))
                    elif message_type == "terminate":
                        try:
                            os.kill(pid, signal.SIGTERM)
                        except ProcessLookupError:
                            pass
                    elif message_type == "kill":
                        try:
                            os.kill(pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass

        try:
            waited_pid, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            waited_pid = pid
            status = 0
        if waited_pid == pid:
            exit_sent = True
            if os.WIFEXITED(status):
                emit({"type": "exit", "code": os.WEXITSTATUS(status), "signal": None})
            elif os.WIFSIGNALED(status):
                emit({"type": "exit", "code": None, "signal": os.WTERMSIG(status)})
            else:
                emit({"type": "exit", "code": None, "signal": None})
            break

    if not exit_sent:
        try:
            _, status = os.waitpid(pid, 0)
        except ChildProcessError:
            status = 0
        if os.WIFEXITED(status):
            emit({"type": "exit", "code": os.WEXITSTATUS(status), "signal": None})
        elif os.WIFSIGNALED(status):
            emit({"type": "exit", "code": None, "signal": os.WTERMSIG(status)})
        else:
            emit({"type": "exit", "code": None, "signal": None})

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
