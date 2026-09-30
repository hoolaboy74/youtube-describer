import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

spec = importlib.util.spec_from_file_location('builder', Path(__file__).with_name('build_monthly_report.py'))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def sample():
    return {
        'schemaVersion': 2, 'collector': {'version': 2, 'sha256': 'fixture'},
        'collectedAt': '2026-09-30T00:00:00Z',
        'range': {'startDate': '2026-08-01', 'endDate': '2026-08-31'},
        'limitations': ['보존 이력은 실제 재생 횟수가 아닙니다.'],
        'sources': {'backendLogs': {'readFiles': 31, 'files': 31, 'readErrors': 0, 'missingObservedDays': []}},
        'data': {
            'videos': {'completed': 542, 'registered': 224, 'completedSeconds': 187729,
                       'averageSeconds': 934, 'memberRegistered': 213, 'verifiedRegistered': 213,
                       'successRate': 89.7, 'memberRate': 95.1},
            'members': {'new': 19, 'verifiedNew': 18},
            'costs': {'total': 130, 'descriptionCost': 120, 'byType': [
                {'type': 'description', 'calls': 20, 'cost': 120}, {'type': 'qa', 'calls': 5, 'cost': 10}]},
            'engagement': {'retainedWatchRows': 147, 'retainedFavorites': 12, 'watchUsers': 39, 'comments': 0},
            'api': {'requests': 15000, 'uniqueAuthenticatedUsers': 40},
            'qaReceipts': {'requests': 0, 'periodEvidence': 'NO_RETAINED_DATA_BEFORE_FIRST_RECEIPT'},
        },
    }


class ReportTests(unittest.TestCase):
    def test_replacements_do_not_cascade_and_cost_is_separated(self):
        mapping = builder.mapping_for(sample())
        self.assertEqual(builder.replace_once('495건 / 542건', mapping), '542건 / 224건')
        self.assertEqual(mapping['0.40'], f'{120/542:.2f}')
        self.assertEqual(mapping['63명'], '18명')
        self.assertEqual(mapping['98%'], '95%')

    def test_missing_data_and_wrong_period_are_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            raw = Path(root)/'stats.json'
            report = sample()
            report['data']['api'] = None
            raw.write_text(json.dumps(report))
            with self.assertRaises(ValueError):
                builder.load_report(raw, '2026-08-01', '2026-08-31')
            with self.assertRaises(ValueError):
                builder.load_report(raw, '2026-09-01', '2026-09-30')
        report = sample()
        report['data']['engagement']['retainedFavorites'] = None
        with self.assertRaises(ValueError):
            builder.mapping_for(report)

    def test_package_html_accessibility_and_source_manifest(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            (directory/'frame-0070.jpg').write_bytes(b'fixture-jpeg')
            raw = directory/'system_stats_report_20260801_20260831.json'
            raw.write_text(json.dumps(sample()))
            preview, pptx = builder.build('2026-08-01', '2026-08-31', directory)
            content = preview.read_text()
            self.assertEqual(content.count('<section '), 8)
            self.assertNotIn('7월', content)
            self.assertNotIn('103시간', content)
            self.assertIn('alt="뷰래이터', content)
            self.assertIn('<summary>지표의 범위', content)
            self.assertIn('보관된 회원 시청 이력', content)
            self.assertIn('API 이용 회원', content)
            self.assertIn('$130.00', content)
            with ZipFile(pptx) as archive:
                self.assertIsNone(archive.testzip())
                self.assertEqual(archive.read('ppt/media/rId2.jpg'), b'fixture-jpeg')
            manifest = json.loads((directory/'sponsor_report_20260801_20260831_manifest.json').read_text())
            self.assertEqual(manifest['sourceSha256'], hashlib.sha256(raw.read_bytes()).hexdigest())


if __name__ == '__main__':
    unittest.main()
