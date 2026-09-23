#!/usr/bin/env python3
"""Tests for the line-endings guard's row parsing.

The gate is only as good as its column choice: `git ls-files --eol` reports the
stored blob first and the developer's checkout second, so reading CR from the
wrong column would either miss the defect the guard exists for, or fail every
Windows contributor whose working tree still holds CRLF. Those three behaviours
are what this pins down; without them a regex edit turns the gate into a no-op
or into a lie about someone else's checkout.
"""
import contextlib
import importlib.util
import io
import unittest
from pathlib import Path
from unittest import mock

SPEC = importlib.util.spec_from_file_location(
    'line_endings_guard', Path(__file__).resolve().parents[1] / 'scripts' / 'check_line_endings.py')
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)

ALLOWED_ROWS = [
    'i/lf    w/lf    attr/text=auto eol=lf \tMakefile',
    'i/none  w/none  attr/text=auto eol=lf \tfrontend/public/favicon.svg',
    'i/-text w/-text attr/-text           \tdocs/profile-desktop.png',
]


class IndexColumnOnly(unittest.TestCase):
    def test_allowed_index_columns_pass(self):
        self.assertEqual(guard.violations(ALLOWED_ROWS), [])

    def test_index_columns_holding_cr_are_reported_verbatim(self):
        rows = [
            'i/crlf  w/crlf  attr/-text           \texperiment.bin',
            'i/mixed w/lf    attr/text=auto eol=lf \tservices/api/mix.js',
        ]
        self.assertEqual(guard.violations(rows), rows)

    def test_worktree_column_is_not_judged(self):
        # A checkout created before the attributes landed keeps CRLF on disk
        # while the blob stays LF; blaming it would fail `make check` for
        # contributors who have not run the documented refresh yet.
        rows = [
            'i/lf    w/crlf  attr/text=auto eol=lf \tbackend/main.go',
            'i/lf    w/mixed attr/text=auto eol=lf \tfrontend/src/app.js',
        ]
        self.assertEqual(guard.violations(rows), [])

    def test_attribute_column_is_not_judged(self):
        # `attr/-text` is the property, not the content: a `-text` row whose
        # blob holds CR is still the case this guard must catch.
        self.assertEqual(guard.violations(['i/crlf  w/crlf  attr/-text \tprobe.txt']),
                         ['i/crlf  w/crlf  attr/-text \tprobe.txt'])

    def test_path_text_cannot_decide_the_verdict(self):
        self.assertEqual(guard.violations(['i/lf    w/lf    attr/\ti/crlf/i/crlf.bin']), [])
        self.assertEqual(len(guard.violations(['i/crlf  w/lf    attr/\ti/lf/i/lf.bin'])), 1)

    def test_blank_output_is_clean(self):
        self.assertEqual(guard.violations(['', '  \t', '\n']), [])


class RunsFromRepositoryRoot(unittest.TestCase):
    """`git ls-files` is scoped to the current directory, so a guard that does not
    pin the root judges a subdirectory and calls the repository clean: invoked
    from backend/ it listed only that subtree and still reported PASS."""

    def capture(self, rows):
        calls = []

        class Completed:
            returncode, stdout, stderr = 0, ''.join(rows), ''

        def fake_run(argv, **kwargs):
            calls.append((argv, kwargs))
            return Completed()

        with mock.patch.object(guard.subprocess, 'run', fake_run), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(guard.main(), 0)
        return calls

    def test_git_is_invoked_at_the_root_with_an_empty_pathspec(self):
        (argv, kwargs), = self.capture(['i/lf    w/lf    attr/\tMakefile\n'])
        self.assertEqual(argv, ['git', 'ls-files', '--eol'])
        # ROOT is the repository, not scripts/: the guard lives one level down,
        # so a pathspec-free listing here spans the whole index.
        self.assertEqual(kwargs['cwd'], guard.ROOT)
        self.assertTrue((guard.ROOT / '.gitattributes').is_file())


class CheckoutPolicy(unittest.TestCase):
    """The gate reads only the index, so dropping `eol=lf` from `.gitattributes`
    would keep every blob LF, keep this gate green, and put CRLF back in every
    Windows checkout. Pin the effective attribute instead: it decides the
    checkout and no contributor's core.autocrlf can override it.
    """

    def test_tracked_text_files_are_checked_out_with_lf(self):
        out = guard.subprocess.run(
            ['git', 'check-attr', 'text', 'eol', '--', '.gitattributes'],
            capture_output=True, text=True, cwd=guard.ROOT).stdout
        self.assertIn('text: auto', out)
        self.assertIn('eol: lf', out)


if __name__ == '__main__':
    unittest.main()
