"""Self-tests for check_docker_build_context.py.

守卫本身也要有守卫：一个永远返回 PASS 的检查比没有检查更糟——它会让下一个人以为
这件事有人看着。
"""
import unittest

import check_docker_build_context as guard


class GoPackageDirsTests(unittest.TestCase):
    def test_finds_nested_package_directories_only(self):
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as temp:
            backend = Path(temp)
            (backend / 'main.go').write_text('package main', encoding='utf-8')
            (backend / 'reviewbundle').mkdir()
            (backend / 'reviewbundle' / 'validate.go').write_text('package reviewbundle', encoding='utf-8')
            (backend / 'scheme' / 'deep').mkdir(parents=True)
            (backend / 'scheme' / 'deep' / 'x.go').write_text('package deep', encoding='utf-8')
            (backend / 'pb_hooks').mkdir()
            (backend / 'pb_hooks' / 'hook.js').write_text('// not go', encoding='utf-8')

            # backend 根目录的 package main 由 `COPY *.go ./` 覆盖，不进这份清单。
            self.assertEqual(guard.go_package_dirs(backend), ['reviewbundle', 'scheme/deep'])


class CopiedDirsTests(unittest.TestCase):
    def test_reads_copy_lines_and_ignores_comments(self):
        text = '''
COPY *.go ./
COPY reviewbundle/ ./reviewbundle/
# COPY commented/ ./commented/  <- 注释里的不算
COPY scheme/ ./scheme/   # 行尾注释
'''
        self.assertEqual(guard.copied_dirs(text), {'reviewbundle', 'scheme'})

    def test_ignores_absolute_runtime_copies(self):
        # 运行阶段的 `COPY --from=builder ...` 与绝对目标不是构建上下文，不该被算进来。
        text = 'COPY --from=builder /out/pocketbase /pb/pocketbase\nCOPY pb_hooks/     /pb/pb_hooks/'
        self.assertEqual(guard.copied_dirs(text), set())

    def test_wrong_destination_does_not_supply_the_expected_path(self):
        self.assertEqual(guard.copied_dirs('COPY pb_hooks/ ./other/'), set())


class BuilderTestAssetsTests(unittest.TestCase):
    def test_complete_hooks_before_tests_pass(self):
        copied = guard.builder_test_copies('''
FROM golang:alpine AS builder
COPY pb_hooks/ ./pb_hooks/
RUN go test ./...
FROM alpine
''')
        self.assertEqual(guard.test_asset_problems(copied), [])

    def test_lib_only_and_runtime_copy_do_not_supply_routes(self):
        copied = guard.builder_test_copies('''
FROM golang:alpine AS builder
COPY pb_hooks/lib/ ./pb_hooks/lib/
RUN go test ./...
FROM alpine
COPY pb_hooks/ ./pb_hooks/
''')
        self.assertEqual(copied, {'pb_hooks/lib'})
        self.assertIn('404', guard.test_asset_problems(copied)[0])

    def test_copy_after_tests_is_too_late(self):
        copied = guard.builder_test_copies('''
FROM golang:alpine AS builder
RUN go test ./...
COPY pb_hooks/ ./pb_hooks/
''')
        self.assertTrue(guard.test_asset_problems(copied))

    def test_other_stage_or_missing_test_does_not_count(self):
        for text in [
            'FROM golang AS other\nCOPY pb_hooks/ ./pb_hooks/\nRUN go test ./...',
            'FROM golang AS builder\nCOPY pb_hooks/ ./pb_hooks/',
        ]:
            with self.subTest(text=text):
                self.assertTrue(guard.test_asset_problems(guard.builder_test_copies(text)))


class ProblemsTests(unittest.TestCase):
    def test_reports_a_package_that_is_not_copied(self):
        found = guard.problems(['reviewbundle', 'scheme'], {'reviewbundle'})
        self.assertEqual(len(found), 1)
        self.assertIn('scheme', found[0])
        self.assertIn('not in std', found[0])

    def test_passes_when_everything_is_copied(self):
        self.assertEqual(guard.problems(['scheme'], {'scheme', 'reviewbundle'}), [])


class RepositoryIsCleanTests(unittest.TestCase):
    def test_the_repository_passes_its_own_guard(self):
        copied = guard.builder_test_copies(guard.DOCKERFILE.read_text(encoding='utf-8'))
        found = guard.problems(guard.go_package_dirs(), copied) + guard.test_asset_problems(copied)
        self.assertEqual(found, [], f'仓库当前没有通过自己的守卫：{found}')


if __name__ == '__main__':
    unittest.main()
