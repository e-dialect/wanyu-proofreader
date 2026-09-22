#!/usr/bin/env python3
"""Fail when a committed text blob still holds CR, which `git diff --check` cannot see.

`* text=auto eol=lf` normalises line endings while `git add` runs, so nothing
reaches the index with CR under normal use. Two paths still do, and both have to
stay visible: content that entered the index before that rule landed, and
content that skipped the clean filter entirely (`git am`, `git apply --cached`,
a hand-edited index). The first column of `git ls-files --eol` is what the
stored blob actually holds, so it reports both. That column is judged from the
bytes rather than from the attributes, so marking a file `-text` or `binary`
does not exempt it: a CR-carrying file with no NUL byte is text by content, and
naming it binary is exactly the mistake worth surfacing.

The index is read rather than the working tree, so a contributor whose checkout
predates the attributes — CRLF on disk, LF in the blob — is not blamed for it,
and nobody's core.autocrlf changes the verdict.

verify-static and CI's static-analysis job both call this file, so the accepted
set of index values lives in exactly one place.
"""
import re
import subprocess
import sys

# `i/lf` normalised text, `i/none` a blob with no line endings at all,
# `i/-text` binary content. Anything else (`i/crlf`, `i/mixed`) holds CR.
ALLOWED = re.compile(r'i/(?:lf|none|-text)')


def violations(lines):
    """Return the `git ls-files --eol` rows whose index column still holds CR."""
    found = []
    for line in lines:
        if not line.strip():
            continue
        if not ALLOWED.fullmatch(line.split(maxsplit=1)[0]):
            found.append(line)
    return found


def main():
    listing = subprocess.run(['git', 'ls-files', '--eol'], capture_output=True, text=True)
    if listing.returncode:
        print(listing.stderr.strip() or 'git ls-files --eol failed', file=sys.stderr)
        return 1
    found = violations(listing.stdout.splitlines())
    if found:
        print('committed text still holds CR:', file=sys.stderr)
        for line in found:
            print(f'  {line}', file=sys.stderr)
        return 1
    print('PASS: index holds LF or binary only')
    return 0


if __name__ == '__main__':
    sys.exit(main())
