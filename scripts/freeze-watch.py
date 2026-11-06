#!/usr/bin/env python3
"""Catch a protected-folder permission flood as it starts and capture the process behind it.

A dev Boundary main thread has more than once got stuck in a sandbox approval wait for a file
under ~/Documents, re-asking tccd about 50 times a second until the Mac froze. This watches
tccd's log and, when one process passes the threshold, saves within a second or two:

  sample-<pid>-<time>.txt     every thread's native stack (`sample`, 3 seconds)
  threads-<pid>-<time>.txt    the kernel thread ids stuck in approval waits, with counts;
                              sample names threads `Thread_<decimal id>`, so the busiest
                              id here marks the stuck thread in the sample
  spindump-<pid>-<time>.txt   kernel and user stacks, only when run with sudo

Run it from a terminal before starting the app, and leave it running:

  cd ~ && python3 -I ~/path/to/boundary-desktop/scripts/freeze-watch.py

The `cd ~` matters: a shell whose working folder is under ~/Documents hangs during a flood.
Python reads this whole file at start, so it keeps working once ~/Documents stops answering.
Captures go to ~/Library/Logs/Boundary/freeze-captures (FREEZE_CAPTURE_DIR to change it).
Nothing here reads file contents; tccd lines are parsed for process ids and names only.
"""

import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import threading
import time
from collections import Counter, defaultdict

ATTRIBUTION = re.compile(r'accessing=\{TCCDProcess: identifier=([^,]+), pid=(\d+)')
KERNEL_TID = re.compile(r'kernel\[0:([0-9a-f]+)\]')
TCCD_PREDICATE = 'process == "tccd" AND eventMessage CONTAINS "AUTHREQ_ATTRIBUTION"'
KERNEL_PREDICATE = 'process == "kernel" AND eventMessage CONTAINS "approval_response_wait"'


class FloodDetector:
    """Requests per accessing process per second; fires once per pid after `seconds` busy ones."""

    def __init__(self, per_second, seconds):
        self.per_second = per_second
        self.seconds = seconds
        self.current_second = None
        self.counts = Counter()
        self.names = {}
        self.busy_streak = defaultdict(int)
        self.fired = set()

    def add(self, second, identifier, pid):
        """Count one request. Returns (pid, identifier) for each process that just crossed."""
        fired = []
        if second != self.current_second:
            fired = self._close_second()
            self.current_second = second
        self.counts[pid] += 1
        self.names[pid] = identifier
        return fired

    def _close_second(self):
        fired = []
        for pid in list(self.busy_streak):
            if self.counts[pid] < self.per_second:
                del self.busy_streak[pid]
        for pid, count in self.counts.items():
            if count < self.per_second or pid in self.fired:
                continue
            self.busy_streak[pid] += 1
            if self.busy_streak[pid] >= self.seconds:
                self.fired.add(pid)
                fired.append((pid, self.names[pid]))
        self.counts = Counter()
        return fired


def parse_tccd_line(line):
    """(second, identifier, pid) from one `log stream --style ndjson` line, or None."""
    try:
        event = json.loads(line)
    except ValueError:
        return None
    match = ATTRIBUTION.search(event.get('eventMessage', ''))
    if not match:
        return None
    # "2026-11-05 15:28:09.289401-0800" -> "2026-11-05 15:28:09"
    second = event.get('timestamp', '')[:19]
    return second, match.group(1), match.group(2)


def kernel_thread_counts(log_lines):
    """Kernel thread ids in approval-wait lines, busiest first, as (hex, decimal, count)."""
    counts = Counter()
    for line in log_lines:
        match = KERNEL_TID.search(line)
        if match:
            counts[match.group(1)] += 1
    return [(tid, int(tid, 16), n) for tid, n in counts.most_common()]


def run(command, out_file, timeout):
    """Runs `command`, writing its output to `out_file`. Never raises."""
    try:
        with open(out_file, 'w') as out:
            subprocess.run(command, stdout=out, stderr=subprocess.STDOUT, timeout=timeout, cwd=os.path.expanduser('~'))
    except Exception as error:  # A capture that fails must not stop the watcher.
        with open(out_file, 'a') as out:
            out.write(f'\nfreeze-watch: {command[0]} failed: {type(error).__name__}\n')


def capture(pid, identifier, out_dir, say, runner=run):
    """Starts the captures for one process; returns the threads doing them."""
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    base = os.path.join(out_dir, f'{{kind}}-{pid}-{stamp}.txt')
    say(f'flood from {identifier} pid {pid}: capturing to {out_dir}')
    jobs = [
        (['/usr/bin/sample', pid, '3', '-mayDie', '-file', base.format(kind='sample')], os.devnull, 90),
    ]
    if os.geteuid() == 0:
        jobs.append((['/usr/sbin/spindump', pid, '3', '-o', base.format(kind='spindump')], os.devnull, 180))
    threads = [threading.Thread(target=runner, args=job, daemon=True) for job in jobs]

    def thread_counts():
        time.sleep(4)
        result = subprocess.run(
            ['/usr/bin/log', 'show', '--last', '10s', '--style', 'compact', '--predicate', KERNEL_PREDICATE],
            capture_output=True, text=True, timeout=120, cwd=os.path.expanduser('~'),
        )
        rows = kernel_thread_counts(result.stdout.splitlines())
        with open(base.format(kind='threads'), 'w') as out:
            out.write('kernel tid (hex)  thread id (decimal, as sample names it)  approval waits in 10 s\n')
            for hex_id, decimal_id, n in rows:
                out.write(f'0x{hex_id}  Thread_{decimal_id}  {n}\n')

    threads.append(threading.Thread(target=lambda: _quiet(thread_counts), daemon=True))
    for thread in threads:
        thread.start()
    return threads


def _quiet(fn):
    try:
        fn()
    except Exception:
        pass


WATCHED_NAMES = re.compile(r'electron|boundary', re.IGNORECASE)


def watch(lines, detector, on_flood, any_process=False):
    for line in lines:
        parsed = parse_tccd_line(line)
        if not parsed or not (any_process or WATCHED_NAMES.search(parsed[1])):
            continue
        for pid, identifier in detector.add(*parsed):
            on_flood(pid, identifier)


def main(argv):
    parser = argparse.ArgumentParser(description='Capture the process behind a permission flood.')
    parser.add_argument('--per-second', type=int, default=20, help='requests a second from one process (20)')
    parser.add_argument('--seconds', type=int, default=2, help='busy seconds in a row before capturing (2)')
    parser.add_argument('--any', action='store_true', help='watch every process, not only Electron and Boundary')
    parser.add_argument('--stdin', action='store_true', help='read ndjson log lines from stdin (testing)')
    parser.add_argument('--dry-run', action='store_true', help='report floods without capturing (testing)')
    args = parser.parse_args(argv)

    os.chdir(os.path.expanduser('~'))
    out_dir = os.environ.get('FREEZE_CAPTURE_DIR') or os.path.expanduser('~/Library/Logs/Boundary/freeze-captures')
    os.makedirs(out_dir, exist_ok=True)

    def say(message):
        print(f'{datetime.datetime.now():%H:%M:%S} {message}', flush=True)

    def on_flood(pid, identifier):
        if args.dry_run:
            say(f'flood from {identifier} pid {pid} (dry run, nothing captured)')
        else:
            capture(pid, identifier, out_dir, say)

    detector = FloodDetector(args.per_second, args.seconds)
    if args.stdin:
        watch(sys.stdin, detector, on_flood, args.any)
        return 0
    stream = subprocess.Popen(
        ['/usr/bin/log', 'stream', '--style', 'ndjson', '--predicate', TCCD_PREDICATE],
        stdout=subprocess.PIPE, text=True, bufsize=1,
    )
    say(f'watching tccd (pid threshold {args.per_second}/s for {args.seconds}s); captures go to {out_dir}')
    try:
        watch(stream.stdout, detector, on_flood, args.any)
    except KeyboardInterrupt:
        pass
    finally:
        stream.terminate()
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
