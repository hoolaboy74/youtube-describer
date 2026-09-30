#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build the established sponsor deck directly from the collector v2 JSON."""
import argparse
import hashlib
import html
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


def replace_once(text, mapping):
    pattern = '|'.join(re.escape(key) for key in sorted(mapping, key=len, reverse=True))
    return re.sub(pattern, lambda match: str(mapping[match.group()]), text)


def load_report(path, start, end):
    report = json.loads(path.read_text(encoding='utf-8'))
    if report.get('schemaVersion') != 2 or report['range']['startDate'] != start or report['range']['endDate'] != end:
        raise ValueError('수집 결과 버전 또는 집계 기간이 다릅니다.')
    for section in ['videos', 'members', 'costs', 'engagement', 'api']:
        if report['data'].get(section) is None:
            raise ValueError(f'후원 리포트 필수 지표가 수집되지 않았습니다: {section}')
    return report


def mapping_for(report):
    data = report['data']
    v, m, c, e, api = [data[key] for key in ['videos', 'members', 'costs', 'engagement', 'api']]
    # Missing values must never be silently presented as actual zero.
    for key in ['retainedWatchRows', 'retainedFavorites', 'watchUsers', 'comments']:
        if e[key] is None:
            raise ValueError('후원 리포트 필수 이용 지표 수집 실패: ' + key)
    month = int(report['range']['startDate'][5:7])
    year = int(report['range']['startDate'][:4])
    hours = v['completedSeconds'] // 3600
    average = int((v['averageSeconds'] or 0) + .5)
    verified_rate = m['verifiedNew'] / m['new'] * 100 if m['new'] else None
    description_cost = c['descriptionCost']
    if description_cost is None:
        raise ValueError('설명 비용을 Q&A 비용과 분리할 수 없습니다.')
    unit_video = description_cost / v['completed'] if v['completed'] else None
    unit_hour = description_cost / (v['completedSeconds'] / 3600) if v['completedSeconds'] else None
    fmt = lambda n, precision=1: f'{n:.{precision}f}' if n is not None else 'N/A'
    return {
        '2026년 7월': f'{year}년 {month}월', '7월': f'{month}월',
        '2026.07.01 – 2026.07.31': f"{report['range']['startDate'].replace('-', '.')} – {report['range']['endDate'].replace('-', '.')}",
        '7월 한 달, 495건의 영상 해설을 제공했습니다': f"{month}월 등록 영상 중 {v['completed']}건의 해설이 완료되었습니다",
        '495건의 영상이 소리로 연결되었습니다': f"{v['completed']}건의 완료 영상이 해설 콘텐츠로 남았습니다",
        '495건': f"{v['completed']}건", '103시간+': f'{hours}시간+', '103시간 이상의': f'{hours}시간 이상의',
        '64명': f"{m['new']}명", '63명': f"{m['verifiedNew']}명", '504건': f"{v['verifiedRegistered']}건",
        '542건': f"{v['registered']}건", '507건': f"{v['memberRegistered']}건",
        '91.3%': fmt(v['successRate'])+'%', '93.5%': fmt(v['memberRate'])+'%',
        '98%': fmt(verified_rate,0)+'%' if verified_rate is not None else 'N/A',
        '1,574명': f"{api['uniqueAuthenticatedUsers']:,}명", '295회': f"{e['retainedWatchRows']:,}건",
        '40회': f"{e['retainedFavorites']:,}건", '6.0회': f"{(e['retainedWatchRows'] / e['watchUsers'] if e['watchUsers'] else 0):.1f}건",
        '$199.57': f"${c['total']:.2f}", '약 200달러': f"약 {c['total']:.0f}달러",
        '0.40': fmt(unit_video,2), '1.93': fmt(unit_hour,2),
        '12분 31초': f'{average//60}분 {average%60}초', '영상 댓글 3건': f"보존된 영상 댓글 {e['comments']}건",
        '영상의 대사뿐 아니라 화면의 상황과 맥락까지 해설': '영상 속 화면의 상황과 맥락을 음성으로 해설',
        '생성된 해설 영상': '등록 영상 중 해설 완료', '누적 해설 콘텐츠': '완료 영상의 총 길이',
        'AI 운영비': '기록된 AI API 비용', '운영비로': 'API 비용으로',
        '영상 페이지 도달 이용자': 'API 이용 회원', '회원·비회원 포함, 접속 기준 추정': '인증된 API 요청의 고유 회원 기준',
        '로그인 회원 영상 시청': '보관된 회원 시청 이력', '활성 회원 1인당 평균': '이력 보유 회원당 평균',
        '좋아요 클릭': '보관된 즐겨찾기', '새로운 이용과 반복 이용이 함께 이어졌습니다': '회원 API 이용과 시청 이력을 확인했습니다',
        '서비스를 처음 찾은 이용자뿐 아니라, 다시 영상을 시청하고 반응을 남긴 이용자도 확인되었습니다.': 'API 이용은 요청 기록을, 시청·즐겨찾기는 현재 보존된 이력을 기준으로 집계했습니다.',
        '가 시각장애인 인증을 완료했고,': '가 현재 시각장애인 인증 상태이며,',
        '해설 영상 1건당': '완료 영상 대비 설명 API 비용', '해설 콘텐츠 1시간당': '콘텐츠 시간 대비 설명 API 비용',
    }


def build(start, end, output_dir, template_path=None):
    if date.fromisoformat(start) > date.fromisoformat(end):
        raise ValueError('시작일이 종료일보다 늦습니다.')
    output_dir = Path(output_dir).resolve()
    stem = f'{start.replace("-", "")}_{end.replace("-", "")}'
    raw = output_dir / f'system_stats_report_{stem}.json'
    report = load_report(raw, start, end)
    template_path = Path(template_path or ROOT / 'make_sponsor_slides.py')
    spec = importlib.util.spec_from_file_location('sponsor_template', template_path)
    template = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(template)
    image = output_dir / 'frame-0070.jpg'
    if not image.exists():
        candidates = [ROOT / 'frame-0070.jpg', template_path.parent / 'frame-0070.jpg']
        found = next((p for p in candidates if p.exists()), None)
        if found:
            shutil.copyfile(found, image)
        else:
            july = output_dir / 'sponsor_report_20260701_20260731.pptx'
            with ZipFile(july) as archive:
                image.write_bytes(archive.read('ppt/media/rId2.jpg'))
    template.ROOT = output_dir
    original = template.build_slides
    def slides():
        value = original()
        value[4][0].append(template.textbox(199, .75, 6.45, 11.7, .30, [{'text': '※ 시청은 최근 20개 제한의 보존 이력, 즐겨찾기는 남아 있는 항목입니다. 실제 재생·클릭 횟수가 아닙니다.', 'size': 8, 'color': '52677D'}]))
        return value
    template.build_slides = slides
    replacements = mapping_for(report)
    pptx = output_dir / f'sponsor_report_{stem}.pptx'
    preview = output_dir / f'sponsor_report_{stem}_preview.html'
    template.write_pptx(pptx)
    template.write_html(preview)
    with tempfile.TemporaryDirectory() as scratch:
        rewritten = Path(scratch) / pptx.name
        with ZipFile(pptx) as src, ZipFile(rewritten, 'w', ZIP_DEFLATED) as dst:
            for item in src.infolist():
                body = src.read(item.filename)
                if item.filename.endswith(('.xml', '.rels')):
                    body = replace_once(body.decode('utf-8'), replacements).encode('utf-8')
                dst.writestr(item, body)
        shutil.move(rewritten, pptx)
    content = replace_once(preview.read_text(encoding='utf-8'), replacements)
    content = content.replace('<img src="frame-0070.jpg">', '<img src="frame-0070.jpg" alt="뷰래이터 서비스 소개 표지 이미지">')
    content = content.replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">')
    content = content.replace('</style>', '@media(max-width:1300px){.deck{overflow-x:auto}.slide{margin-left:0}} .collection-details{max-width:1280px;margin:0 auto 30px;padding:28px;background:white;line-height:1.8}.collection-details summary{cursor:pointer;font-weight:700}.collection-details table{border-collapse:collapse;width:100%}.collection-details th,.collection-details td{text-align:left;border-bottom:1px solid #ddd;padding:8px}</style>')
    data = report['data']
    cost_rows = ''.join(f'<tr><td>{html.escape(row["type"])}</td><td>{row["calls"]:,}</td><td>${row["cost"]:.6f}</td></tr>' for row in data['costs']['byType'])
    qa = data['qaReceipts']
    qa_text = f"요청 영수증 {qa['requests']}개" if qa is not None else '요청 영수증 수집 불가'
    if qa and qa.get('periodEvidence') == 'NO_RETAINED_DATA_BEFORE_FIRST_RECEIPT':
        qa_text += ' (이 기간의 보존된 영수증 없음. 최초 영수증은 이후 기간에 관측됨)'
    notes = ''.join('<li>'+html.escape(note)+'</li>' for note in report['limitations'])
    sources = ''.join(f'<tr><td>{html.escape(key)}</td><td>{source["readFiles"]}/{source["files"]}</td><td>{source["readErrors"]}</td><td>{len(source["missingObservedDays"])}</td></tr>' for key,source in report['sources'].items())
    extra = f'''<aside class="collection-details" aria-label="통계 집계 근거와 해석">
<h2>집계 근거와 해석</h2><p>수집 시각: {html.escape(report['collectedAt'])}. 기간은 한국 시간 기준입니다.</p>
<p>{html.escape(qa_text)}. 원자료: {html.escape(raw.name)}.</p>
<p>API 요청 {data['api']['requests']:,}건, 고유 인증 회원 {data['api']['uniqueAuthenticatedUsers']:,}명. 실제 청취 완료 수와 다릅니다.</p>
<details><summary>기능별 API 비용</summary><table><thead><tr><th scope="col">기능</th><th scope="col">원장 호출 수</th><th scope="col">기록 비용</th></tr></thead><tbody>{cost_rows}</tbody></table></details>
<details><summary>출처별 로그 관측 상태</summary><table><thead><tr><th scope="col">출처</th><th scope="col">읽은/발견 파일</th><th scope="col">읽기 실패</th><th scope="col">기간 내 관측 없는 날짜</th></tr></thead><tbody>{sources}</tbody></table><p>관측 없는 날짜는 이용 0 또는 자료 없음일 수 있습니다. 원자료에서 파일·기간 보존 상태를 확인할 수 있습니다.</p></details>
<details><summary>지표의 범위와 측정 한계</summary><ul>{notes}</ul></details></aside>'''
    content = content.replace('</div></body>', extra+'</div></body>')
    preview.write_text(content, encoding='utf-8')
    with ZipFile(pptx) as archive:
        if archive.testzip() is not None:
            raise ValueError('PPTX 패키지 손상')
        for name in archive.namelist():
            if name.endswith(('.xml', '.rels')):
                ET.fromstring(archive.read(name))
    source_hash = hashlib.sha256(raw.read_bytes()).hexdigest()
    manifest = {'source':raw.name, 'sourceSha256':source_hash,'collector':report['collector'],'range':report['range'],'artifacts':[pptx.name,preview.name,image.name]}
    (output_dir / f'sponsor_report_{stem}_manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(f'생성: {preview}\n생성: {pptx}')
    return preview, pptx


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('start');parser.add_argument('end');parser.add_argument('--output-dir',type=Path,default=ROOT/'prod_report')
    args=parser.parse_args()
    build(args.start,args.end,args.output_dir)
