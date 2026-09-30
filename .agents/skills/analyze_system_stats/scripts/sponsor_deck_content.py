# -*- coding: utf-8 -*-
"""Explicit sponsor-safe projection: never pass an entire internal member record to a renderer."""
import calendar
import json
import re
from datetime import date


def number(value, digits=0):
    return '자료 없음' if value is None else f'{value:,.{digits}f}'


def percent(value):
    return '자료 없음' if value is None else f'{value:.1f}%'


def card(value, label, detail=''):
    return {'value': str(value), 'label': label, 'detail': detail}


def safe_title(title, members):
    text = str(title)
    for member in members:
        for key in ['name', 'email']:
            value = member.get(key)
            if value and len(value) >= 2:
                text = text.replace(value, '익명')
    text = re.sub(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', '비공개', text)
    return re.sub(r'\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b', '비공개', text, flags=re.I)


def month_offset(month, offset):
    year, mon = map(int, month.split('-'))
    index = year * 12 + mon - 1 + offset
    return f'{index//12:04d}-{index%12+1:02d}'


def monthly_history(report, directory):
    """Only complete, compatible calendar-month observations are comparable."""
    month = report['range']['startDate'][:7]
    rows, sources = [], []
    for offset in [-2, -1, 0]:
        key = month_offset(month, offset)
        year, mon = map(int, key.split('-'))
        start, end = key+'-01', f'{key}-{calendar.monthrange(year,mon)[1]:02d}'
        candidate = directory / f'system_stats_report_{start.replace("-", "")}_{end.replace("-", "")}.json'
        source = report if offset == 0 else None
        if source is None and candidate.exists():
            try:
                loaded = json.loads(candidate.read_text(encoding='utf-8'))
                if loaded.get('schemaVersion') == 2 and loaded.get('range', {}).get('startDate') == start and loaded['range'].get('endDate') == end:
                    old_routes = (loaded.get('data', {}).get('activity') or {}).get('definitions', {}).get('coreRoutes')
                    current_routes = report['data']['activity']['definitions']['coreRoutes']
                    if old_routes == current_routes:
                        source = loaded
            except (ValueError, OSError):
                pass
        observation = next((r for r in (source or {}).get('data', {}).get('activity', {}).get('monthly', []) if r['month'] == key and r['completeCalendarMonth']), None) if (source or {}).get('data', {}).get('activity') else None
        label = f'{mon}월' if year == int(month[:4]) else f'{year}.{mon:02d}'
        rows.append([label, number(observation['coreMau']) if observation else '—', number(observation['apiMau']) if observation else '—'])
        if observation and offset != 0:
            sources.append(candidate)
    return rows, sources


def make_content(report, directory):
    data = report['data']
    a, v, c = data['activity'], data['videos'], data['costs']
    s, repeat, onboarding = a['summary'], a['repeat'], a['onboarding']
    month = int(report['range']['startDate'][5:7])
    title = f"{report['range']['startDate'][:4]}년 {month}월 후원 보고서"
    period = f"{report['range']['startDate']} ~ {report['range']['endDate']}"
    history, history_sources = monthly_history(report, directory)
    daily = [{key: row[key] for key in ['date', 'apiUsers', 'coreUsers']} for row in a['daily']]
    core_mau, api_mau = s['coreActiveMembers'], s['apiActiveMembers']
    common_note = '핵심 기능: 해설 생성·대본 조회·음성·Q&A 요청. 로그인 회원 기준이며 요청 성공·실제 청취를 뜻하지 않습니다.'
    slides = []
    slides.append(dict(kicker='01 / 이달의 핵심 성과', title=f'{month}월, {number(core_mau)}명이 핵심 기능을 이용했습니다', lead='유튜브 화면의 정보를 음성 해설로 접할 수 있도록 서비스를 제공합니다.', cards=[card(number(core_mau)+'명','핵심 기능 MAU','한 달의 고유 이용 회원'), card(number(repeat['coreRepeatUsers'])+'명','서로 다른 날에 다시 이용','핵심 이용 회원 중 '+percent(repeat['coreRepeatRate'])), card(number(v['completed'])+'개','등록 영상 중 현재 완료','이달 등록 '+number(v['registered'])+'개 기준')], takeaway='이용 규모와 함께, 서비스를 다시 찾는 회원을 살펴봅니다.', note=common_note+' 영상 완료 상태는 수집 시점 기준입니다.'))
    slides.append(dict(kicker='02 / 이용 규모와 추이', title='매일의 이용을 확인합니다', lead=f"핵심 기능 일평균 DAU {number(s['averageCoreDau'],2)}명 · 최대 {number(s['maxCoreDau'])}명. 전체 API 일평균 DAU {number(s['averageApiDau'],2)}명.", chart={'type':'daily','rows':daily}, sidebar={'title':'최근 월별 MAU','headers':['월','핵심 기능','전체 API'],'rows':history,'text':'—는 비교 가능한 월 전체 자료가 없다는 뜻입니다. 증가·감소율을 계산하지 않습니다.'}, note='날짜는 한국 시간 기준이며 요청 없는 날도 포함합니다. 전체 API에는 로그인·조회·관리 요청도 포함됩니다.'))
    weekly = [[r['weekStart'][5:]+' → '+r['nextWeekStart'][5:], f"{r['coreReturned']}/{r['coreCohort']}명",percent(r['coreReturnRate'])] for r in a['weeklyRetention'] if r['completeWindows']]
    monthly_incomplete = any(not r['completeWindows'] for r in a['monthlyRetention'])
    slides.append(dict(kicker='03 / 지속적인 이용', title=f"핵심 이용 회원 {number(repeat['coreRepeatUsers'])}명이 다시 찾아왔습니다", lead=f"{number(core_mau)}명 중 {number(repeat['coreRepeatUsers'])}명({percent(repeat['coreRepeatRate'])})이 서로 다른 날짜에 핵심 기능을 이용했습니다.", chart={'type':'distribution','rows':repeat['activeDayDistribution']}, sidebar={'title':'다음 주 핵심 기능 재이용','headers':['주 시작일 비교','재이용/기준','비율'],'rows':weekly,'text':'두 주 전체가 관측된 구간만 표시합니다.'+(' 직전 월 전체 자료가 부족해 월간 재이용률은 확인할 수 없습니다.' if monthly_incomplete else '')}, note='반복 이용률은 같은 달의 2일 이상 이용 비율입니다. 다음 주 재이용률은 기준 주 회원 중 다음 주에도 이용한 비율입니다.'))
    route_map = {r['route']:r for r in a['functions']}
    features = [{'label':label,'users':route_map.get(route,{}).get('apiUsers',0),'requests':route_map.get(route,{}).get('memberRequests',0)} for route,label in [('description.request','해설 생성'),('description.script','대본 조회'),('tts.description','해설 음성')]]
    qa_count = sum(r['apiRequests'] for r in a['functions'] if r['route'] in ['qa.request','qa.question.legacy'])
    qa_evidence = data.get('qaReceipts') or {}
    qa_text = '이달의 보존된 Q&A 영수증이 없어 이용 완료 규모는 확인하기 어렵습니다.' if qa_evidence.get('periodEvidence') == 'NO_RETAINED_DATA_BEFORE_FIRST_RECEIPT' else 'API 질문 요청 수이며 답변 성공·음성 청취 완료와 다릅니다.'
    slides.append(dict(kicker='04 / 실제 기능 이용', title='해설 생성·대본·음성 이용으로 이어졌습니다', lead='기능별 고유 회원 수로 서비스의 이용 목적을 살펴봅니다.', chart={'type':'features','rows':features}, sidebar={'title':'Q&A 기록','cards':[card(number(qa_count)+'건','질문 API 요청')],'text':qa_text}, note='같은 회원이 여러 기능을 이용하므로 회원 수를 합산하지 않습니다. 음성 요청은 문장 단위로 여러 번 발생할 수 있습니다.'))
    if onboarding:
        stages=[card(number(onboarding['newMembers'])+'명','신규 가입'),card(number(onboarding['coreUsedMembers'])+'명','가입 후 핵심 기능 이용'),card(number(onboarding['coreRepeatMembers'])+'명','다른 날 다시 이용')]
        delay=onboarding['firstCoreDelayMedianSeconds']
        delay_text='자료 없음' if delay is None else f'{round(delay)//60}분 {round(delay)%60}초'
        side={'title':'관측 기간을 맞춘 재이용','cards':[card(percent(onboarding['returnWithin7DayRate']),'첫 핵심 이용 후 7일 내 재이용',f"7일을 관측한 {onboarding['eligible7DayMembers']}명 중 {onboarding['returnedWithin7DayMembers']}명")],'text':f'가입부터 첫 핵심 이용까지 중앙값 {delay_text}. 지연 표본 {onboarding["firstCoreDelaySamples"]}명 기준.'}
        lead=f"신규 회원의 {percent(onboarding['coreActivationRate'])}가 같은 기간 안에 핵심 기능을 이용했습니다." if onboarding['coreActivationRate'] is not None else '신규 회원의 핵심 기능 이용률은 관측 자료가 부족해 확인하기 어렵습니다.'
    else:
        stages=[card('자료 없음','신규 회원 이용 연결')];side={'title':'관측 자료','text':'가입 기록을 수집하지 못해 정착률을 계산하지 않았습니다.'};lead='가입 기록과 실제 기능 이용을 함께 확인합니다.'
    slides.append(dict(kicker='05 / 신규 회원 정착',title='가입이 실제 이용으로 연결되는지 봅니다',lead=lead,cards=stages,sidebar=side,note='세 단계는 조회 기간 안의 활동입니다. 7일 재이용률은 첫 핵심 이용 후 7일을 끝까지 관측한 회원만 분모에 포함합니다.'))
    top = a['topActiveMembers'][0] if a['topActiveMembers'] else None
    case_cards=[card(number(top['coreActiveDays'])+'일','핵심 기능 이용 일수'),card(number(top['registeredVideos'])+'개','이달 등록 영상'),card(number(top['completedVideos'])+'개','등록 영상 중 현재 완료')] if top else [card('자료 없음','반복 이용 회원 사례')]
    examples=[]
    if top:
        videos=[r for r in top.get('registeredVideoList') or [] if r['status']=='completed']
        for label,pattern in [('미술·교양','마티스|모네|미술|샤갈'),('영화·문화','오디세이|영화|인터뷰'),('스마트 기기','스마트|글래스|갤럭시|AI')]:
            found=next((r for r in videos if re.search(pattern,r['title'],re.I) and r['videoId'] not in [e['videoId'] for e in examples]),None)
            if found:examples.append({'category':label,'title':safe_title(found['title'],a['topActiveMembers']),'videoId':found['videoId']})
        if not examples:
            examples=[{'category':'등록 영상 예시','title':safe_title(r['title'],a['topActiveMembers']),'videoId':r['videoId']} for r in videos[:3]]
    slides.append(dict(kicker='06 / 이용 사례',title='다양한 영상을 반복해서 요청한 회원이 있습니다' if top else '이용 사례를 보완할 자료가 필요합니다',lead='핵심 기능 요청이 가장 많은 회원의 익명 이용 사례입니다.' if top else '이 기간에 기록된 핵심 기능 이용 회원이 없습니다.',cards=case_cards,examples=examples,note='영상 분류는 제목 기준 예시이며 대표 표본은 아닙니다. 만족도·실제 청취 시간은 미측정입니다. 동의받은 사용자 의견은 별도로 보완할 자료입니다.'))
    fail_names={'other_or_unknown':'기타·원인 불명','model':'AI 모델 처리','download':'다운로드'}
    fails=[[fail_names.get(k,k),number(n)+'개'] for k,n in v['failureCategories'].items()]
    cost_detail=[['설명 API', '$'+number(c['descriptionCost'],2)],['Q&A API','$'+number(c['qaCost'],2)],['총 기록 비용','$'+number(c['total'],2)]]
    slides.append(dict(kicker='07 / 서비스 품질과 비용',title='처리 상태와 기록 비용을 함께 공개합니다',lead=f"이달 등록 {number(v['registered'])}개 중 현재 완료 {number(v['completed'])}개, 실패 {number(v['failed'])}개. 현재 완료 비율 {percent(v['successRate'])}입니다.",cards=[card(number(v['completed'])+'개','등록 영상 중 현재 완료'),card(number(v['failed'])+'개','등록 영상 중 현재 실패'),card('$'+number(c['total'],2),'기록된 AI API 비용')],tables=[{'title':'실패 유형','headers':['유형','영상'],'rows':fails},{'title':'기능별 API 비용','headers':['기능','기록 비용'],'rows':cost_detail}],note='영상 상태는 수집 시점 기준입니다. 비용은 기간 내 기록된 API 원장이며 서버·TTS·인력 등 전체 운영비를 뜻하지 않습니다. 구형 원장의 세부 비용은 확인 불가입니다.'))
    slides.append(dict(kicker='08 / 다음 달 계획',title='반복 이용과 안정성을 높이는 개선 방향',lead='이번 달 기록을 기준으로 다음 달의 개선 결과를 확인하겠습니다.',panels=[{'title':'01. 신규 회원의 재이용','text':'가입 후 첫 이용 안내와 이용 흐름을 점검합니다.','metric':'확인할 지표: 핵심 기능 이용률·7일 재이용률'},{'title':'02. 영상 처리 안정성','text':f"현재 실패 {number(v['failed'])}개의 원인을 검토하고 재시도 흐름을 개선합니다.",'metric':'확인할 지표: 등록 영상 처리 상태·실패 유형'},{'title':'03. 실제 이용 경험 확인','text':'청취 이벤트 계측을 보완하고 동의받은 사용자 의견을 수집합니다.','metric':'확인할 지표: 기록 범위·실제 청취·사용자 의견'}],note='개선 방향과 확인 지표입니다. 실측하지 않은 청취 시간·만족도나 확인되지 않은 개선 성과를 주장하지 않습니다.'))
    definitions=[common_note,'DAU는 하루, WAU는 한 주, MAU는 한 달의 고유 회원 수입니다. 월·일별 회원 수를 더해 고유 회원 수를 만들지 않습니다.','API 로그에는 응답 상태·실제 재생 시간이 없습니다. 비회원 전체 사람 수와 청취 시간은 확인할 수 없습니다.','완료 영상 총 길이는 콘텐츠 길이이며 실제 청취 시간이 아닙니다. 월별 상태는 현재 보존된 자료 기준입니다.']
    if not s['averageDauCompleteWindow']:
        definitions.append('이 달의 로그 관측 범위가 불완전합니다. 표시된 이용 규모·일평균은 보존된 요청 기록 기준이며 월 전체 실측으로 해석할 수 없습니다.')
        for slide in slides[:3]:
            slide['note']+=' ※ 월 전체 관측 자료 미확보: 보존된 기록 기준입니다.'
    return {'title':title,'period':period,'slides':slides,'definitions':definitions,'collectedAt':report['collectedAt'],'warnings':[w['code'] for w in report.get('warnings',[])],'daily':daily,'historySources':history_sources}
