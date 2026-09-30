# -*- coding: utf-8 -*-
"""Render one sponsor-safe content model to accessible HTML and editable PPTX."""
import html
import math
from urllib.parse import quote


def e(value):
    return html.escape(str(value), quote=True)


def chart_geometry(chart):
    if chart['type'] == 'daily':
        rows = chart['rows']
        top = max(1, max((max(r['apiUsers'], r['coreUsers']) for r in rows), default=0))
        top = max(2, math.ceil(top / 2) * 2)
        rects, labels = [], []
        width = 620 / max(1, len(rows))
        for i, row in enumerate(rows):
            for j, (key, color) in enumerate([('apiUsers', '92ABC8'), ('coreUsers', '138C85')]):
                height = row[key] / top * 270
                rects.append((45 + i * width + j * width * .38, 310 - height, width * .34, height, color))
            if i == 0 or (i + 1) % 5 == 0 or i == len(rows) - 1:
                labels.append((45 + i * width, 337, row['date'][-2:], 12, '52677D'))
        for tick in range(0, top + 1, max(1, top // 4)):
            labels.append((7, 314 - tick / top * 270, str(tick), 12, '52677D'))
        labels += [(50, 20, '전체 API', 14, '52677D'), (180, 20, '핵심 기능', 14, '138C85'), (590, 365, '날짜 / 한국 시간', 11, '52677D')]
        return rects, labels
    rows = chart['rows']
    values = [r['coreUsers'] if chart['type'] == 'distribution' else r['users'] for r in rows]
    top = max(1, max(values, default=0))
    rects, labels = [], []
    gap = 330 / max(1, len(rows))
    for i, (row, value) in enumerate(zip(rows, values)):
        y = 42 + gap * i
        label = row['bucket'] if chart['type'] == 'distribution' else row['label']
        labels.append((12, y + 22, label, 17, '102A43'))
        rects.append((165, y, value / top * 390, 32, '138C85'))
        labels.append((575, y + 23, str(value) + '명', 18, '102A43'))
        if chart['type'] == 'features':
            labels.append((165, y + 64, f"회원 요청 {row['requests']:,}건", 14, '52677D'))
    return rects, labels


def svg_chart(chart):
    titles = {'daily': '일별 고유 회원 수: 전체 API와 핵심 기능', 'distribution': '핵심 기능 회원의 이용 일수 분포', 'features': '기능별 고유 이용 회원 수'}
    rects, labels = chart_geometry(chart)
    description = '상세값은 보고서 하단의 일별 활성 회원 표에서 확인할 수 있습니다.' if chart['type'] == 'daily' else ', '.join(str(r.get('bucket',r.get('label')))+' '+str(r.get('coreUsers',r.get('users')))+'명' for r in chart['rows'])
    body = ''.join(f'<rect x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{h:.2f}" fill="#{color}" />' for x,y,w,h,color in rects)
    body += ''.join(f'<text x="{x}" y="{y}" font-size="{size}" fill="#{color}">{e(text)}</text>' for x,y,text,size,color in labels)
    return f'<svg viewBox="0 0 700 390" role="img" aria-label="{e(titles[chart["type"]]+". "+description)}"><title>{e(titles[chart["type"]])}</title><desc>{e(description)}</desc>{body}</svg>'


def html_table(table):
    return '<table><thead><tr>'+''.join('<th scope="col">'+e(h)+'</th>' for h in table['headers'])+'</tr></thead><tbody>'+''.join('<tr>'+''.join('<td>'+e(c)+'</td>' for c in row)+'</tr>' for row in table['rows'])+'</tbody></table>'


def html_cards(cards):
    return '<div class="cards">'+''.join(f'<div class="card"><strong>{e(c["value"])}</strong><span>{e(c["label"])}</span><small>{e(c["detail"])}</small></div>' for c in cards)+'</div>'


def sidebar_html(side):
    body='<h3>'+e(side['title'])+'</h3>'
    if side.get('headers'): body+=html_table(side)
    if side.get('cards'): body+=html_cards(side['cards'])
    return '<aside class="sidebar">'+body+'<p>'+e(side.get('text',''))+'</p></aside>'


CSS = '''
*{box-sizing:border-box}body{margin:0;background:#e8eef2;color:#102a43;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif}a{color:#096e69}a:focus-visible,summary:focus-visible{outline:3px solid #d87823;outline-offset:4px}.topbar{max-width:1280px;margin:24px auto 18px;display:flex;justify-content:space-between;gap:20px;font-size:14px;color:#52677d}.brand{font-weight:800;color:#096e69;letter-spacing:.1em}.slide{position:relative;width:1280px;height:720px;margin:0 auto 28px;padding:44px 60px 95px;background:#f7fafc;box-shadow:0 8px 26px #102a4315;border-top:6px solid #138c85}.kicker{font-weight:750;font-size:14px;color:#096e69;letter-spacing:.06em}.slide h2{font-size:34px;line-height:1.3;margin:16px 0 12px;letter-spacing:-.035em}.lead{font-size:19px;line-height:1.55;color:#52677d;margin:0 0 24px;max-width:1100px}.content{min-height:330px}.slide:first-of-type .content{min-height:0}.cards{display:flex;gap:18px}.card{flex:1;min-width:0;padding:24px;background:white;border:1px solid #dce6ed;border-top:4px solid #138c85;border-radius:10px}.card strong{display:block;font-size:40px;line-height:1.15;color:#102a43}.card span{display:block;font-size:17px;margin-top:15px;font-weight:650}.card small{display:block;font-size:13px;line-height:1.5;color:#52677d;margin-top:9px}.split{display:grid;grid-template-columns:minmax(0,1.8fr) minmax(0,1fr);gap:26px}.sidebar{background:#eaf4f2;border-radius:12px;padding:25px;align-self:stretch}.sidebar h3,.table-panel h3{font-size:19px;margin:0 0 20px}.sidebar p{font-size:15px;line-height:1.65;margin:24px 0 0}.sidebar .card{padding:18px}.sidebar .card strong{font-size:32px}.sidebar .card span{font-size:15px}.chart{background:#fff;border:1px solid #dce6ed;border-radius:12px;padding:10px}.chart svg{display:block;width:100%;height:auto;max-height:370px}.chart text{font-family:inherit}table{border-collapse:collapse;width:100%;font-size:15px;line-height:1.6}th,td{text-align:left;padding:11px 7px;border-bottom:1px solid #d0dedf}th{font-weight:700;color:#096e69}.takeaway{font-size:25px;line-height:1.5;margin-top:36px;padding:24px;background:#eaf4f2;border-radius:12px;color:#096e69;font-weight:700}.hero{display:grid;grid-template-columns:1fr 260px;align-items:center;gap:26px;margin-bottom:22px}.hero img{width:260px;height:160px;object-fit:cover;border-radius:12px}.hero .lead{margin:0}.examples{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:20px}.example{background:#fff;border:1px solid #dce6ed;border-radius:10px;padding:18px}.example b{display:block;font-size:14px;color:#096e69;margin-bottom:10px}.example a{display:block;font-size:16px;line-height:1.6;overflow-wrap:anywhere}.tables{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:20px}.table-panel{background:#fff;border:1px solid #dce6ed;border-radius:10px;padding:18px}.table-panel h3{margin-bottom:8px}.panels{display:grid;grid-template-columns:repeat(3,1fr);gap:22px}.panel{background:white;border:1px solid #dce6ed;border-top:4px solid #138c85;border-radius:10px;padding:25px}.panel h3{font-size:21px;line-height:1.5;margin:0 0 24px}.panel p{font-size:18px;line-height:1.7}.panel small{display:block;font-size:14px;line-height:1.65;color:#096e69;margin-top:28px}.footnote{position:absolute;left:60px;right:60px;bottom:43px;font-size:12px;line-height:1.65;color:#52677d;margin:0}.footer{position:absolute;left:60px;right:60px;bottom:16px;display:flex;justify-content:space-between;font-size:10px;color:#52677d;border-top:1px solid #dce6ed;padding-top:8px}.appendix{max-width:1280px;margin:0 auto 32px;padding:30px;background:white;border-radius:12px;line-height:1.8}.appendix h2{font-size:23px}.appendix summary{font-weight:700;cursor:pointer;padding:10px 0}.appendix details{border-top:1px solid #dce6ed;margin-top:12px}.appendix .table-scroll{overflow-x:auto}.skip{position:absolute;left:12px;top:-80px;padding:12px;background:white;z-index:10}.skip:focus{top:10px}
@media(max-width:1300px){.topbar{padding:0 24px}.slide{width:calc(100% - 40px);height:auto;min-height:650px;padding:36px 32px 120px}.footnote,.footer{left:32px;right:32px}.appendix{margin:0 20px 24px}.hero{grid-template-columns:1fr 220px}.hero img{width:220px}}
@media(max-width:760px){.topbar{font-size:12px}.slide{width:calc(100% - 24px);padding:28px 22px 24px;min-height:0}.slide h2{font-size:27px}.lead{font-size:17px}.cards,.split,.examples,.panels,.tables,.hero{display:grid;grid-template-columns:1fr}.card strong{font-size:34px}.hero img{width:100%;height:170px}.footnote,.footer{position:static;margin-top:24px}.footer{font-size:10px}.content{min-height:0}.takeaway{font-size:21px}.chart{min-width:0;overflow-x:auto}.split>div{min-width:0}.chart svg{min-width:600px;max-height:none}.sidebar p{margin-top:15px}.appendix{margin:0 12px 24px;padding:22px}}
@media print{body{background:white}.topbar{display:none}.slide{box-shadow:none;margin:0;break-after:page;width:100%;height:auto;min-height:0}.appendix details>*{display:block}.appendix{break-before:page}}'''


def write_html(model, path):
    out=['<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">', '<title>'+e(model['title'])+'</title><style>'+CSS+'</style></head><body>', '<a class="skip" href="#slide-1">보고서 본문으로 이동</a>', '<header class="topbar"><span class="brand">VIEWRATOR · 뷰래이터</span><span>'+e(model['title'])+' · '+e(model['period'])+'</span></header><main>']
    for i,s in enumerate(model['slides'],1):
        out.append(f'<section class="slide" data-no="{i}" id="slide-{i}" tabindex="-1" aria-labelledby="title-{i}"><div class="kicker">{e(s["kicker"])}</div><h2 id="title-{i}">{e(s["title"])}</h2>')
        if i==1: out.append('<div class="hero"><p class="lead">'+e(s['lead'])+'</p><img src="frame-0070.jpg" alt="뷰래이터 서비스 소개 이미지"></div>')
        else: out.append('<p class="lead">'+e(s['lead'])+'</p>')
        body=''
        if s.get('cards'): body+=html_cards(s['cards'])
        if s.get('chart'): body+='<div class="chart" tabindex="0" aria-label="이용 통계 그래프">'+svg_chart(s['chart'])+'</div>'
        if s.get('sidebar'): body='<div class="split"><div>'+body+'</div>'+sidebar_html(s['sidebar'])+'</div>'
        if s.get('examples'): body+='<div class="examples">'+''.join('<div class="example"><b>'+e(v['category'])+'</b><a href="https://www.youtube.com/watch?v='+quote(v['videoId'],safe='')+'">'+e(v['title'])+'</a></div>' for v in s['examples'])+'</div>'
        if s.get('tables'): body+='<div class="tables">'+''.join('<div class="table-panel"><h3>'+e(t['title'])+'</h3>'+html_table(t)+'</div>' for t in s['tables'])+'</div>'
        if s.get('panels'): body+='<div class="panels">'+''.join('<div class="panel"><h3>'+e(p['title'])+'</h3><p>'+e(p['text'])+'</p><small>'+e(p['metric'])+'</small></div>' for p in s['panels'])+'</div>'
        if s.get('takeaway'): body+='<div class="takeaway">'+e(s['takeaway'])+'</div>'
        out.append('<div class="content">'+body+'</div><p class="footnote">'+e(s['note'])+'</p><div class="footer"><span>'+e(model['title'])+'</span><span>'+f'{i:02d} / 08'+'</span></div></section>')
    warning_labels={'LEGACY_COST_BREAKDOWN_UNAVAILABLE':'구형 비용 기록은 입력·출력 등 세부 비용을 분리할 수 없습니다.','PM2_UNTIMED_LINES_UNASSIGNABLE':'일부 프로세스 로그에 시각이 없어 월별 로그 건수로 사용할 수 없습니다.','CACHE_SCAN_INCOMPLETE':'일부 캐시 경로를 읽을 수 없어 관련 현황이 미확인입니다.'}
    out.append('<aside class="appendix" aria-label="집계 근거와 상세표"><h2>집계 근거와 상세표</h2><p>기간: '+e(model['period'])+' (한국 시간) · 수집 시각: '+e(model['collectedAt'])+'</p><details><summary>지표의 정의와 측정 한계</summary><ul>'+''.join('<li>'+e(s)+'</li>' for s in model['definitions'])+'</ul></details>')
    daily={'headers':['날짜','핵심 기능 DAU','전체 API DAU'],'rows':[[r['date'],r['coreUsers'],r['apiUsers']] for r in model['daily']]}
    out.append('<details><summary>일별 활성 회원 상세표</summary><div class="table-scroll">'+html_table(daily)+'</div></details><details><summary>수집 자료의 확인 사항</summary><ul>'+''.join('<li>'+e(warning_labels.get(w,w))+'</li>' for w in model['warnings'])+'</ul><p>요청 시 제공 자료: 비식별 이용 통계, 비용 원장 집계, 영상 처리 현황. 회원 식별정보와 원시 운영 로그는 본 보고서에 포함하지 않습니다.</p></details></aside></main></body></html>')
    path.write_text(''.join(out),encoding='utf-8')


def pptx_slides(model, template):
    result=[]
    for i,s in enumerate(model['slides'],1):
        shapes=[];counter=10
        def box(x,y,w,h,text,size=16,color='102A43',bold=False):
            nonlocal counter
            counter+=1;shapes.append(template.textbox(counter,x,y,w,h,[{'text':text,'size':size,'color':color,'bold':bold}],valign='top',margin=.02))
        def rect(x,y,w,h,color='FFFFFF',line='DCE6ED'):
            nonlocal counter
            counter+=1;shapes.append(template.shape(counter,x,y,w,max(.001,h),color,line))
        def cards(items,x=.65,y=2.18,w=12.0,height=1.65):
            gap=.18;cw=(w-gap*(len(items)-1))/len(items)
            for j,c in enumerate(items):
                cx=x+j*(cw+gap);rect(cx,y,cw,height);rect(cx,y,cw,.045,'138C85','138C85')
                box(cx+.18,y+.16,cw-.36,.48,c['value'],30,bold=True)
                box(cx+.18,y+.77,cw-.36,.47,c['label'],14,bold=True)
                box(cx+.18,y+1.27,cw-.36,.32,c['detail'],9,'52677D')
        def table(t,x,y,w):
            box(x,y,w,.3,t['title'],15,bold=True);yy=y+.44
            count=len(t['headers']);cw=w/count
            for j,text in enumerate(t['headers']):box(x+j*cw,yy,cw-.04,.28,text,11,'096E69',True)
            yy+=.34
            for row in t['rows']:
                rect(x,yy,w,.005,'DCE6ED','DCE6ED')
                for j,text in enumerate(row):box(x+j*cw,yy+.07,cw-.04,.36,str(text),11)
                yy+=.43
            return yy
        rect(0,0,13.333,7.5,'F7FAFC','F7FAFC');rect(0,0,13.333,.055,'138C85','138C85')
        box(.65,.38,12,.25,s['kicker'],11,'096E69',True);box(.65,.86,12,.58,s['title'],27,bold=True)
        if i!=1: box(.65,1.56,12,.53,s['lead'],14,'52677D')
        if i==1:
            box(.65,1.56,8,.5,s['lead'],14,'52677D');counter+=1;shapes.append(template.picture(counter,9.7,1.56,2.7,1.45,'rId2','뷰래이터 서비스 소개'))
            cards(s['cards'],y=3.3)
            rect(.65,5.35,12,.66,'EAF4F2','EAF4F2');box(.88,5.51,11.5,.4,s['takeaway'],18,'096E69',True)
        else:
            if s.get('cards'):cards(s['cards'],w=7.55 if s.get('sidebar') else 12)
            if s.get('chart'):
                x,y,w,h=.7,2.28,7.5,4.05
                rect(x,y,w,h);bars,labels=chart_geometry(s['chart']);sx=w/700;sy=h/390
                for bx,by,bw,bh,col in bars:
                    if bh:rect(x+bx*sx,y+by*sy,bw*sx,bh*sy,col,col)
                for lx,ly,text,size,col in labels:box(x+lx*sx,y+(ly-size)*sy,2,.3,text,size*.75,col)
            if s.get('sidebar'):
                side=s['sidebar'];rect(8.62,2.25,4.02,4.1,'EAF4F2','EAF4F2')
                box(8.85,2.48,3.57,.5,side['title'],16,bold=True)
                if side.get('headers'):end=table(side,8.85,3.1,3.57);box(8.85,end+.18,3.57,1.1,side.get('text',''),11,'52677D')
                elif side.get('cards'):cards(side['cards'],8.85,3.18,3.57,1.65);box(8.85,5.12,3.57,1.03,side.get('text',''),11,'52677D')
                else:box(8.85,3.3,3.57,2.2,side.get('text',''),13,'52677D')
            for j,v in enumerate(s.get('examples',[])):
                x=.65+j*4.07;rect(x,4.12,3.85,1.82);box(x+.18,4.28,3.48,.25,v['category'],11,'096E69',True);box(x+.18,4.73,3.48,1.05,v['title'],13)
            for j,t in enumerate(s.get('tables',[])):table(t,.8+j*6.08,4.04,5.72)
            for j,p in enumerate(s.get('panels',[])):
                x=.65+j*4.08;rect(x,2.25,3.85,3.9);box(x+.2,2.52,3.45,.7,p['title'],18,bold=True);box(x+.2,3.55,3.45,1.35,p['text'],15);box(x+.2,5.24,3.45,.75,p['metric'],12,'096E69')
        box(.65,6.67,12,.48,s['note'],9,'52677D');rect(.65,7.23,12,.006,'DCE6ED','DCE6ED');box(.65,7.3,10,.16,model['title'],7,'52677D');box(12,7.3,.64,.16,f'{i:02d}/08',7,'52677D')
        result.append((shapes,i==1))
    return result
