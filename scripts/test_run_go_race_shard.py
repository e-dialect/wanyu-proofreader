"""Fail-closed tests for the CI race partition and its execution receipt."""
from contextlib import redirect_stderr, redirect_stdout
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import yaml

import run_go_race_shard as runner


def output(name, package="example/backend"):
    return {"Action": "output", "Package": package, "Output": name + "\n"}


class InventoryTests(unittest.TestCase):
    def test_go_tests_examples_and_fuzz_seeds_are_included(self):
        events = [output(name) for name in ["TestOne", "Example", "ExampleThing", "FuzzInput",
                                           "BenchmarkSpeed", "ok example/backend", "TestOne/sub"]]
        self.assertEqual(runner.inventory(events), {
            ("example/backend", name) for name in ["TestOne", "Example", "ExampleThing", "FuzzInput"]})

    def test_empty_inventory_fails(self):
        with self.assertRaises(ValueError):
            runner.inventory([output("? example/backend [no test files]")])

    def test_all_tests_belong_to_exactly_one_group(self):
        tests = {(package, f"TestCase{i}") for package in ["a", "b"] for i in range(100)}
        groups = runner.partition(tests, 4)
        self.assertEqual(set.union(*groups), tests)
        self.assertEqual(sum(map(len, groups)), len(tests))
        self.assertEqual(groups, runner.partition(set(reversed(sorted(tests))), 4))
        for group in groups:
            for _, name in group:
                self.assertIn(("a", name), group)
                self.assertIn(("b", name), group)
        extended = runner.partition(tests | {("a", "TestNew")}, 4)
        self.assertEqual(sum(("a", "TestNew") in group for group in extended), 1)

    def test_invalid_or_empty_shard_fails(self):
        for count in [0, -1, 4]:
            with self.subTest(count=count), self.assertRaises(ValueError):
                runner.partition({("a", "TestOne")}, count)

    def test_run_filter_is_anchored_and_deduplicated(self):
        self.assertEqual(runner.run_pattern({("a", "TestOne"), ("b", "TestOne"), ("a", "FuzzData")}),
                         "^(FuzzData|TestOne)$")


class ExecutionTests(unittest.TestCase):
    def test_requires_each_top_level_result_and_preserves_skips(self):
        selected = {("a", "TestOne"), ("a", "TestOptional")}
        events = [{"Action": action, "Package": "a", "Test": name} for action, name in [
            ("run", "TestOne"), ("pass", "TestOne/sub"), ("pass", "TestOne"), ("skip", "TestOptional")]]
        runner.verify_results(selected, events)
        with self.assertRaises(ValueError):
            runner.verify_results(selected, events[:-1])
        with self.assertRaises(ValueError):
            runner.verify_results(selected, events + [{"Action": "pass", "Package": "a", "Test": "TestExtra"}])

    def test_go_error_is_not_replaced_by_partial_passing_events(self):
        result = subprocess.CompletedProcess([], 1, json.dumps(output("TestOne")) + "\n", "build failed\n")
        with tempfile.TemporaryDirectory() as temp, patch.object(runner.subprocess, "run", return_value=result):
            with self.assertRaises(subprocess.CalledProcessError), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                runner.go_json(["-list", ".", "./..."], Path(temp) / "inventory.jsonl")

    def test_inflight_output_survives_an_interrupted_command(self):
        def interrupted(*args, **kwargs):
            kwargs["stdout"].write(json.dumps(output("TestOne")) + "\n")
            raise subprocess.TimeoutExpired(args[0], 1)
        with tempfile.TemporaryDirectory() as temp, patch.object(runner.subprocess, "run", side_effect=interrupted):
            path = Path(temp) / "results.jsonl"
            with self.assertRaises(subprocess.TimeoutExpired):
                runner.go_json(["./..."], path)
            self.assertIn("TestOne", path.read_text())


class WorkflowTests(unittest.TestCase):
    def test_all_shards_feed_existing_race_contexts_and_release_gate(self):
        workflow = yaml.safe_load((runner.ROOT / ".github/workflows/ci.yml").read_text())
        jobs = workflow["jobs"]
        race = jobs["race-unit"]
        self.assertFalse(race["strategy"]["fail-fast"])
        self.assertEqual(race["strategy"]["matrix"]["shard"], [0, 1, 2, 3])
        command = next(step["run"] for step in race["steps"] if "run_go_race_shard.py" in step.get("run", ""))
        self.assertIn('--count 4', command)
        self.assertIn('--index "$SHARD"', command)
        self.assertIn("race-unit", jobs["race-integration"]["needs"])
        self.assertEqual(jobs["race-integration"]["if"], "always()")
        guard = jobs["race-integration"]["steps"][0]
        self.assertEqual(guard["env"]["RACE_RESULT"], "${{ needs.race-unit.result }}")
        for result in ["success", "failure", "cancelled", "skipped", ""]:
            with self.subTest(result=result):
                code = subprocess.run(["sh", "-c", guard["run"]], env={"RACE_RESULT": result},
                                      capture_output=True).returncode
                self.assertEqual(code == 0, result == "success")
        self.assertEqual(jobs["race-integration"]["name"], "Concurrency under the race detector (${{ matrix.suite }})")
        self.assertIn("race-unit", jobs["ci-gate"]["needs"])
        self.assertIn("race-integration", jobs["ci-gate"]["needs"])
        self.assertIn("job['result'] != 'success'", jobs["ci-gate"]["steps"][0]["run"])
        integration_commands = "\n".join(step.get("run", "") for step in jobs["race-integration"]["steps"])
        self.assertIn("-race -tags capacityprobe -run '^TestCapacityProbe' ./...", integration_commands)
        self.assertIn('--race --env IMPORT_WAIT_TIMEOUT_MS=120000', integration_commands)


if __name__ == "__main__":
    unittest.main()
