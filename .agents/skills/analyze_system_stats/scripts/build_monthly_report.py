#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build an eight-slide sponsor report from explicit, anonymized activity metrics."""
import argparse
import calendar
import hashlib
import importlib.util
import json
import re
import shutil
import tempfile
import xml.etree.ElementTree as ET
from datetime import date
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[4]
SCRIPT_DIR = Path(__file__).resolve().parent


def module_at(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


content = module_at('sponsor_deck_content', SCRIPT_DIR/'sponsor_deck_content.py')
renderer = module_at('sponsor_deck_render', SCRIPT_DIR/'sponsor_deck_render.py')


def load_report(path, start, end):
    first, last = date.fromisoformat(start), date.fromisoformat(end)
    if first.day != 1 or first.year != last.year or first.month != last.month or last.day != calendar.monthrange(first.year, first.month)[1]:
        raise ValueError('월간 후원 보고서는 같은 달의 1일부터 마지막 날까지 지정하십시오.')
    report = json.loads(path.read_text(encoding='utf-8'))
    if report.get('schemaVersion') != 2 or report['range']['startDate'] != start or report['range']['endDate'] != end:
        raise ValueError('수집 결과 버전 또는 집계 기간이 다릅니다.')
    for key in ['activity', 'videos', 'members', 'costs', 'api']:
        if report['data'].get(key) is None:
            raise ValueError('후원 보고서 필수 지표 미수집: '+key)
    a = report['data']['activity']
    for key in ['summary', 'daily', 'monthly', 'repeat', 'weeklyRetention', 'monthlyRetention', 'functions', 'topActiveMembers']:
        if a.get(key) is None:
            raise ValueError('활성 이용 통계 미수집: '+key)
    for key in ['apiActiveMembers', 'coreActiveMembers', 'averageApiDau', 'averageCoreDau', 'maxCoreDau']:
        if a['summary'].get(key) is None:
            raise ValueError('활성 이용 필수 지표 미수집: '+key)
    expected = calendar.monthrange(first.year, first.month)[1]
    dates = [row['date'] for row in a['daily']]
    if dates != [f'{first.year:04d}-{first.month:02d}-{d:02d}' for d in range(1, expected+1)]:
        raise ValueError('일별 활성 통계의 날짜가 누락되거나 중복되었습니다.')
    return report


def build(start, end, output_dir, template_path=None):
    output_dir = Path(output_dir).resolve()
    stem = f'{start.replace("-", "")}_{end.replace("-", "")}'
    raw = output_dir/f'system_stats_report_{stem}.json'
    report = load_report(raw, start, end)
    model = content.make_content(report, output_dir)
    template_path = Path(template_path or ROOT/'make_sponsor_slides.py')
    template = module_at('sponsor_pptx_primitives', template_path)
    image = output_dir/'frame-0070.jpg'
    if not image.exists():
        found = next((p for p in [ROOT/'frame-0070.jpg', template_path.parent/'frame-0070.jpg'] if p.exists()), None)
        if found:
            shutil.copyfile(found, image)
        else:
            with ZipFile(output_dir/'sponsor_report_20260701_20260731.pptx') as archive:
                image.write_bytes(archive.read('ppt/media/rId2.jpg'))
    template.ROOT = output_dir
    template.build_slides = lambda: renderer.pptx_slides(model, template)
    pptx = output_dir/f'sponsor_report_{stem}.pptx'
    preview = output_dir/f'sponsor_report_{stem}_preview.html'
    template.write_pptx(pptx)
    # Correct legacy slide relationship indices and text-body namespaces.
    with tempfile.TemporaryDirectory() as scratch:
        revised = Path(scratch)/pptx.name
        with ZipFile(pptx) as src, ZipFile(revised, 'w', ZIP_DEFLATED) as dst:
            for item in src.infolist():
                body = src.read(item.filename)
                if item.filename.startswith('ppt/slides/slide') and item.filename.endswith('.xml'):
                    body = body.replace(b'<a:txBody>', b'<p:txBody>').replace(b'</a:txBody>', b'</p:txBody>')
                if item.filename == 'ppt/presentation.xml':
                    indices = iter(range(2, 10))
                    body = re.sub(rb'(<p:sldId\b[^>]*\br:id=")rId\d+("[^>]*>)',
                                  lambda m: m[1]+b'rId'+str(next(indices)).encode()+m[2], body)
                    slide_ids = iter(range(256, 264))
                    body = re.sub(rb'(<p:sldId\b[^>]*\bid=")\d+("[^>]*>)',
                                  lambda m: m[1]+str(next(slide_ids)).encode()+m[2], body)
                if item.filename == 'docProps/core.xml':
                    body = body.decode('utf-8').replace('유튜브 화면 해설 서비스 2026년 7월 운영 성과 보고', renderer.e(model['title'])).encode('utf-8')
                dst.writestr(item, body)
        shutil.move(revised, pptx)
    renderer.write_html(model, preview)
    with ZipFile(pptx) as archive:
        if archive.testzip() is not None:
            raise ValueError('PPTX 패키지 손상')
        for name in archive.namelist():
            if name.endswith(('.xml', '.rels')):
                ET.fromstring(archive.read(name))
    sources = [raw, *model['historySources']]
    builder_hash = hashlib.sha256()
    for p in [Path(__file__), SCRIPT_DIR/'sponsor_deck_content.py', SCRIPT_DIR/'sponsor_deck_render.py', template_path]:
        builder_hash.update(p.read_bytes())
    manifest = {'formatVersion': 3, 'source': raw.name, 'sourceSha256': hashlib.sha256(raw.read_bytes()).hexdigest(),
                'collector': report['collector'], 'builderSha256': builder_hash.hexdigest(), 'range': report['range'],
                'historySources': [{'source': p.name, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in sources[1:]],
                'artifacts': [pptx.name, preview.name, image.name]}
    (output_dir/f'sponsor_report_{stem}_manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(f'생성: {preview}\n생성: {pptx}')
    return preview, pptx


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('start'); parser.add_argument('end')
    parser.add_argument('--output-dir', type=Path, default=ROOT/'prod_report')
    args = parser.parse_args()
    build(args.start, args.end, args.output_dir)
