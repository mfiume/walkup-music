#!/usr/bin/env python3
"""Probe Audacity scripting pipe with side-effect commands."""
import os, sys, time, select

UID = os.getuid()
TO = f"/tmp/audacity_script_pipe.to.{UID}"
FROM = f"/tmp/audacity_script_pipe.from.{UID}"

tof = open(TO, "w")
fd = os.open(FROM, os.O_RDONLY | os.O_NONBLOCK)

def drain(timeout_total=4.0, idle_timeout=0.6):
    start = time.time()
    last_data = time.time()
    buf = b""
    while True:
        if time.time() - start > timeout_total:
            break
        if time.time() - last_data > idle_timeout and buf:
            break
        rlist, _, _ = select.select([fd], [], [], 0.2)
        if rlist:
            try:
                chunk = os.read(fd, 65536)
            except BlockingIOError:
                continue
            if chunk:
                buf += chunk
                last_data = time.time()
    return buf.decode("utf-8", errors="replace")

def send(cmd, wait=2.0):
    print(f">>> {cmd!r}")
    tof.write(cmd + "\n")
    tof.flush()
    resp = drain(timeout_total=wait + 4.0, idle_timeout=0.6)
    print(f"<<< {len(resp)}B: {resp!r}")
    print("---")
    return resp

drain(timeout_total=0.3, idle_timeout=0.2)

# Side-effect: should open a Message dialog
send('Message: Text="Hello from script"', wait=2.0)
# Test a path with no spaces:
send('OpenProject2: Filename="/tmp/aup3_test/adrian.aup3"', wait=4.0)
time.sleep(2.0)
send("GetInfo: Type=Tracks Format=JSON", wait=2.0)
send("GetInfo: Type=Tracks Format=LISP", wait=2.0)
send("GetInfo: Type=Tracks", wait=2.0)
