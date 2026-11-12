#!/usr/bin/env python3
"""Run a complete, deterministic slice of Go's discovered race tests.

Partition top-level names, not subtests: fixtures and crash/restart helpers stay
inside their original test. Equal names in different packages share a shard so
one anchored -run expression can safely cover ./... without duplicate runs.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
TEST_NAME = re.compile(r"(?:Test|Example|Fuzz)\w*\Z")


def inventory(events):
    tests = set()
    for event in events:
        name = event.get("Output", "").rstrip("\n")
        if event.get("Action") == "output" and TEST_NAME.fullmatch(name):
            tests.add((event["Package"], name))
    if not tests:
        raise ValueError("Go discovered no runnable tests")
    return tests


def partition(tests, count):
    if count < 1:
        raise ValueError("shard count must be positive")
    groups = [set() for _ in range(count)]
    for package, name in tests:
        index = int.from_bytes(hashlib.sha256(name.encode()).digest(), "big") % count
        groups[index].add((package, name))
    if any(not group for group in groups):
        raise ValueError("empty race shard; reduce the shard count")
    if set.union(*groups) != tests or sum(map(len, groups)) != len(tests):
        raise ValueError("race partition lost or duplicated tests")
    return groups


def run_pattern(tests):
    return "^(" + "|".join(sorted({name for _, name in tests})) + ")$"


def verify_results(selected, events):
    completed = set()
    for event in events:
        name = event.get("Test", "")
        if name and "/" not in name and event.get("Action") in {"pass", "skip"}:
            completed.add((event["Package"], name))
    if completed != selected:
        raise ValueError(f"race execution mismatch: missing={sorted(selected - completed)}, "
                         f"unexpected={sorted(completed - selected)}")


def go_json(arguments, output):
    # Write directly to the artifact, including when Go is killed by a runner
    # timeout. Do not hold a full verbose test log in memory while it is running.
    with output.open("w", encoding="utf-8") as stream:
        result = subprocess.run(["go", "test", "-C", "backend", "-race", "-json", *arguments],
                                cwd=ROOT, text=True, stdout=stream, stderr=subprocess.PIPE)
    if result.stderr:
        print(result.stderr, file=sys.stderr, end="")
    if result.returncode:
        print(output.read_text(encoding="utf-8"), end="")
        raise subprocess.CalledProcessError(result.returncode, result.args)
    with output.open(encoding="utf-8") as stream:
        return [json.loads(line) for line in stream if line.strip()]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index", type=int, required=True, help="zero-based shard index")
    parser.add_argument("--count", type=int, required=True)
    parser.add_argument("--timeout", default="20m")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not 0 <= args.index < args.count:
        parser.error("index must be in [0, count)")
    args.output.mkdir(parents=True, exist_ok=True)
    discovered = inventory(go_json(["-list", ".", "./..."], args.output / "inventory.jsonl"))
    groups = partition(discovered, args.count)
    selected = groups[args.index]
    plan = {"index": args.index, "count": args.count, "total": len(discovered),
            "sizes": list(map(len, groups)), "selected": sorted(selected)}
    (args.output / "plan.json").write_text(json.dumps(plan, indent=2) + "\n", encoding="utf-8")
    print(f"Race shard {args.index + 1}/{args.count}: {len(selected)}/{len(discovered)} "
          f"top-level tests; group sizes {plan['sizes']}", flush=True)
    events = go_json(["-count=1", f"-timeout={args.timeout}", "-run", run_pattern(selected), "./..."],
                     args.output / "results.jsonl")
    verify_results(selected, events)
    slowest = sorted((event for event in events if event.get("Action") == "pass"
                      and event.get("Test") and "/" not in event["Test"]),
                     key=lambda event: event.get("Elapsed", 0), reverse=True)[:10]
    for event in slowest:
        print(f"{event.get('Elapsed', 0):8.2f}s {event['Package']} {event['Test']}")
    print(f"PASS: all {len(selected)} selected tests completed (existing skips preserved)")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error)) from error
