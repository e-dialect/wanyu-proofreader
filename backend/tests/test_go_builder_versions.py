"""Minimum security patch applies to both independently shipped Go binaries."""
import unittest
from unittest.mock import patch
import check_runtime_versions as guard


class BuilderPatch(unittest.TestCase):
    def test_a_minor_tag_does_not_prove_the_required_security_patch(self):
        with patch.object(guard, 'read', return_value='FROM golang:1.27-alpine AS builder'):
            self.assertEqual(len(guard.go_builder_problems('go 1.27.3\n')), 2)

    def test_both_explicit_builders_may_meet_or_exceed_the_patch(self):
        with patch.object(guard, 'read', return_value='FROM golang:1.27.3-alpine AS builder'):
            self.assertEqual(guard.go_builder_problems('go 1.27.3\n'), [])

    def test_a_stale_worker_builder_cannot_hide_behind_the_main_image(self):
        with patch.object(guard, 'read', side_effect=lambda source: 'FROM golang:' + ('1.27.3' if source == 'backend/Dockerfile' else '1.27.2') + '-alpine'):
            problems = guard.go_builder_problems('go 1.27.3\n')
        self.assertEqual(len(problems), 1)
        self.assertIn('ocr-worker.Dockerfile', problems[0])
