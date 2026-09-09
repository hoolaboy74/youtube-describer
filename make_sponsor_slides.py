from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from xml.sax.saxutils import escape
import base64

ROOT = Path('/Users/chacha/src/youtube-describer')
OUT = ROOT / 'prod_report'
OUT.mkdir(exist_ok=True)

W, H = 12192000, 6858000
NS = {
    'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
    'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
}

def emu(inches):
    return int(inches * 914400)

def tag(prefix, name):
    return f'{{{NS[prefix]}}}{name}'

def esc(value):
    return escape(str(value))

def tx_body(lines, size=18, color='102A43', bold=False, align='l', font='Apple SD Gothic Neo', valign='mid', margin=0.08, spacing=100, bullet=False):
    """Return an a:txBody fragment; lines may be strings or dicts."""
    out = [f'<a:bodyPr wrap="square" rtlCol="0" anchor="{valign}" lIns="{emu(margin)}" rIns="{emu(margin)}" tIns="{emu(margin)}" bIns="{emu(margin)}"/>', '<a:lstStyle/>']
    for line in lines:
        if isinstance(line, dict):
            text = line.get('text', '')
            lsize = line.get('size', size)
            lcolor = line.get('color', color)
            lbold = line.get('bold', bold)
            lfont = line.get('font', font)
            lbullet = line.get('bullet', bullet)
            lalign = line.get('align', align)
        else:
            text, lsize, lcolor, lbold, lfont, lbullet, lalign = line, size, color, bold, font, bullet, align
        ppr = f'<a:pPr algn="{lalign}" marL="{emu(0.18) if lbullet else 0}" indent="{emu(-0.12) if lbullet else 0}"/>'
        if lbullet:
            ppr = f'<a:pPr algn="{lalign}" marL="{emu(0.20)}" indent="{emu(-0.15)}"><a:buChar char="•"/></a:pPr>'
        run = f'<a:r><a:rPr lang="ko-KR" sz="{int(lsize*100)}" b="{str(bool(lbold)).lower()}" dirty="0"><a:solidFill><a:srgbClr val="{lcolor}"/></a:solidFill><a:latin typeface="{lfont}"/><a:ea typeface="{lfont}"/></a:rPr><a:t>{esc(text)}</a:t></a:r>'
        out.append(f'<a:p>{ppr}{run}<a:endParaRPr lang="ko-KR" sz="{int(lsize*100)}"/></a:p>')
    return '<a:txBody>' + ''.join(out) + '</a:txBody>'

def shape(spid, x, y, w, h, fill='FFFFFF', line='FFFFFF', radius=False, text=None, size=18, color='102A43', bold=False, align='l', valign='mid', margin=0.08):
    geom = 'roundRect' if radius else 'rect'
    fill_xml = '<a:noFill/>' if fill is None else f'<a:solidFill><a:srgbClr val="{fill}"/></a:solidFill>'
    line_xml = '<a:ln><a:noFill/></a:ln>' if line is None else f'<a:ln w="{emu(0.008)}"><a:solidFill><a:srgbClr val="{line}"/></a:solidFill></a:ln>'
    body = '' if text is None else tx_body(text if isinstance(text, list) else [text], size, color, bold, align, valign=valign, margin=margin)
    return f'<p:sp><p:nvSpPr><p:cNvPr id="{spid}" name="Shape {spid}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="{emu(x)}" y="{emu(y)}"/><a:ext cx="{emu(w)}" cy="{emu(h)}"/></a:xfrm><a:prstGeom prst="{geom}"><a:avLst/></a:prstGeom>{fill_xml}{line_xml}</p:spPr>{body}</p:sp>'

def textbox(spid, x, y, w, h, lines, size=18, color='102A43', bold=False, align='l', valign='mid', margin=0.08):
    return shape(spid, x, y, w, h, None, None, False, lines, size, color, bold, align, valign, margin)

def picture(spid, x, y, w, h, rid, name='image.jpg'):
    return f'''<p:pic><p:nvPicPr><p:cNvPr id="{spid}" name="{esc(name)}"/><p:cNvPicPr preferRelativeResize="0"/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="{emu(x)}" y="{emu(y)}"/><a:ext cx="{emu(w)}" cy="{emu(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'''

def slide_xml(shapes):
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="{NS['a']}" xmlns:r="{NS['r']}" xmlns:p="{NS['p']}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="p14"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>{''.join(shapes)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'''

def slide_rels(image_rid=None):
    base = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
    if image_rid:
        base += f'<Relationship Id="{image_rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/{image_rid}.jpg"/>'
    return base + '</Relationships>'

def slide_footer(n):
    return [shape(200, 0.65, 7.18, 12.0, 0.01, 'D6E4EC', 'D6E4EC'), textbox(201, 0.65, 7.23, 5.5, 0.18, [{'text':'운영 성과 보고 · 2026년 7월', 'size':7, 'color':'6B7C93'}], valign='mid'), textbox(202, 12.15, 7.23, 0.55, 0.18, [{'text':str(n), 'size':7, 'color':'6B7C93', 'align':'r'}], align='r')]

def title_block(title, kicker, n):
    return [textbox(10, 0.72, 0.48, 11.7, 0.22, [{'text':kicker.upper(), 'size':8, 'color':'13A6A6', 'bold':True}], valign='mid'), textbox(11, 0.70, 0.78, 11.7, 0.62, [{'text':title, 'size':25, 'color':'102A43', 'bold':True}], valign='mid')] + slide_footer(n)

def card(spid, x, y, w, h, number, label, accent='13A6A6', note=None):
    items = [shape(spid, x, y, w, h, 'FFFFFF', 'E0E9EF', True), shape(spid+1, x, y, 0.08, h, accent, accent, True), textbox(spid+2, x+0.25, y+0.25, w-0.5, 0.55, [{'text':number, 'size':27, 'color':'102A43', 'bold':True}], valign='mid'), textbox(spid+3, x+0.25, y+0.88, w-0.5, 0.38, [{'text':label, 'size':11, 'color':'52677D'}], valign='mid')]
    if note:
        items.append(textbox(spid+4, x+0.25, y+h-0.36, w-0.5, 0.20, [{'text':note, 'size':7.5, 'color':'7A8B9C'}], valign='mid'))
    return items

def build_slides():
    slides = []
    # 1 Cover
    s = [shape(2, 0, 0, 13.333, 7.5, 'F4F9FB', 'F4F9FB'), shape(3, 8.00, 0, 5.34, 7.5, 'DDF4F1', 'DDF4F1'), picture(4, 7.2, 0.65, 6.13, 6.2, 'rId2', 'frame-0070.jpg'), shape(5, 6.82, 0, 1.1, 7.5, 'F4F9FB', 'F4F9FB'), textbox(6, 0.83, 0.88, 6.0, 0.45, [{'text':'VIEWRATOR', 'size':13, 'color':'13A6A6', 'bold':True}], valign='mid'), textbox(7, 0.83, 2.03, 6.2, 1.4, [{'text':'유튜브 화면 해설 서비스', 'size':31, 'color':'102A43', 'bold':True},{'text':'2026년 7월 운영 성과 보고', 'size':21, 'color':'13A6A6', 'bold':True}], valign='mid'), textbox(8, 0.86, 4.06, 5.5, 0.74, [{'text':'후원기관 보고용', 'size':13, 'color':'52677D'},{'text':'시각장애인 이용자의 콘텐츠 접근성을 넓혀갑니다.', 'size':12, 'color':'52677D'}], valign='mid'), textbox(9, 0.84, 6.82, 5.0, 0.20, [{'text':'집계 기간 2026.07.01 – 2026.07.31', 'size':8, 'color':'7A8B9C'}], valign='mid')]
    slides.append((s, True))
    # 2 Summary
    s = title_block('7월 한 달, 495건의 영상 해설을 제공했습니다', '한눈에 보는 성과', 2)
    s += [textbox(20, 0.75, 1.60, 7.0, 0.72, [{'text':'후원금은 시각장애인 이용자가 유튜브 콘텐츠를 더 넓게 접할 수 있도록 하는 실제 서비스 제공으로 이어졌습니다.', 'size':18, 'color':'102A43', 'bold':True}], valign='mid')]
    s += card(30, 0.75, 2.72, 2.75, 1.68, '495건', '생성된 해설 영상', '13A6A6')
    s += card(40, 3.72, 2.72, 2.75, 1.68, '103시간+', '누적 해설 콘텐츠', '4F7CAC')
    s += card(50, 6.69, 2.72, 2.75, 1.68, '64명', '신규 가입 회원', 'F0A35B')
    s += card(60, 9.66, 2.72, 2.75, 1.68, '$199.57', '7월 AI 운영비', '8F7AEA')
    s += [shape(70, 0.75, 5.00, 11.66, 0.92, 'EAF7F5', 'EAF7F5', True), textbox(71, 1.05, 5.23, 11.0, 0.42, [{'text':'“약 200달러의 운영비로 103시간 이상의 접근 가능한 영상 콘텐츠를 만들었습니다.”', 'size':15, 'color':'0C7778', 'bold':True, 'align':'c'}], align='c', valign='mid')]
    s += [textbox(72, 0.75, 6.25, 11.7, 0.28, [{'text':'성공률 91.3% · 회원 요청 93.5% · 시각장애인 인증 회원 63명', 'size':10, 'color':'52677D', 'align':'c'}], align='c', valign='mid')]
    slides.append((s, False))
    # 3 Beneficiaries
    s = title_block('서비스는 시각장애인 이용자 중심으로 작동했습니다', '누가 이용했는가', 3)
    s += [textbox(20, 0.75, 1.55, 11.7, 0.5, [{'text':'신규 가입자의 98%가 시각장애인 인증을 완료했고, 영상 생성 요청의 대부분이 회원으로부터 발생했습니다.', 'size':16, 'color':'52677D'}], valign='mid')]
    s += card(30, 0.75, 2.45, 3.55, 2.05, '63명', '시각장애인 인증 회원', '13A6A6', '신규 가입자 64명 중')
    s += card(40, 4.90, 2.45, 3.55, 2.05, '504건', '인증 회원의 생성 요청', '4F7CAC', '전체 542건 중')
    s += card(50, 9.05, 2.45, 3.37, 2.05, '93.5%', '회원 생성 요청 비중', 'F0A35B', '회원 요청 507건')
    s += [shape(60, 0.75, 5.13, 11.67, 0.72, 'F4F9FB', 'E0E9EF', True), textbox(61, 1.05, 5.31, 11.0, 0.30, [{'text':'필요한 이용자에게 집중된 서비스 운영', 'size':15, 'color':'102A43', 'bold':True, 'align':'c'}], align='c', valign='mid')]
    slides.append((s, False))
    # 4 Content
    s = title_block('495건의 영상이 소리로 연결되었습니다', '제공한 가치', 4)
    s += [shape(20, 0.75, 1.65, 4.05, 4.55, '102A43', '102A43', True), textbox(21, 1.08, 2.20, 3.4, 0.88, [{'text':'103시간+', 'size':34, 'color':'FFFFFF', 'bold':True},{'text':'누적 해설 콘텐츠', 'size':14, 'color':'DDF4F1'}], valign='mid'), textbox(22, 1.08, 4.15, 3.2, 0.85, [{'text':'평균 영상 길이\n약 12분 31초', 'size':15, 'color':'DDE7EE'}], valign='mid'), shape(23, 1.08, 5.55, 2.4, 0.06, '13A6A6', '13A6A6')]
    s += [textbox(30, 5.35, 1.75, 6.8, 0.58, [{'text':'방송·뉴스·학습·취미 등 다양한 유튜브 콘텐츠를 더 많은 사람이 즐길 수 있게 했습니다.', 'size':18, 'color':'102A43', 'bold':True}], valign='mid')]
    s += [shape(31, 5.35, 2.75, 6.95, 0.90, 'EAF7F5', 'EAF7F5', True), textbox(32, 5.65, 3.02, 6.4, 0.30, [{'text':'영상의 대사뿐 아니라 화면의 상황과 맥락까지 해설', 'size':13, 'color':'0C7778', 'bold':True}], valign='mid')]
    s += [shape(33, 5.35, 4.03, 6.95, 0.90, 'F4F6FA', 'E0E9EF', True), textbox(34, 5.65, 4.30, 6.4, 0.30, [{'text':'필요한 콘텐츠를 이용자가 직접 선택하고 요청', 'size':13, 'color':'4F7CAC', 'bold':True}], valign='mid')]
    s += [shape(35, 5.35, 5.31, 6.95, 0.90, 'FFF5E9', 'F4DDC5', True), textbox(36, 5.65, 5.58, 6.4, 0.30, [{'text':'한 번 만들어진 해설은 다시 활용되어 기다림과 비용을 줄임', 'size':12, 'color':'A36522', 'bold':True}], valign='mid')]
    slides.append((s, False))
    # 5 Engagement
    s = title_block('새로운 이용과 반복 이용이 함께 이어졌습니다', '이용자 반응', 5)
    s += [textbox(20, 0.75, 1.55, 11.7, 0.5, [{'text':'서비스를 처음 찾은 이용자뿐 아니라, 다시 영상을 시청하고 반응을 남긴 이용자도 확인되었습니다.', 'size':16, 'color':'52677D'}], valign='mid')]
    s += card(30, 0.75, 2.42, 3.55, 2.10, '1,574명', '영상 페이지 도달 이용자', '13A6A6', '회원·비회원 포함, 접속 기준 추정')
    s += card(40, 4.90, 2.42, 3.55, 2.10, '295회', '로그인 회원 영상 시청', '4F7CAC', '활성 회원 1인당 평균 6.0회')
    s += card(50, 9.05, 2.42, 3.37, 2.10, '40회', '좋아요 클릭', 'F0A35B', '영상 댓글 3건')
    s += [shape(60, 0.75, 5.20, 11.67, 0.82, 'F4F9FB', 'E0E9EF', True), textbox(61, 1.05, 5.47, 11.0, 0.28, [{'text':'서비스가 일회성 제공을 넘어 실제 시청과 소통으로 이어지고 있습니다.', 'size':14, 'color':'102A43', 'bold':True, 'align':'c'}], align='c', valign='mid')]
    slides.append((s, False))
    # 6 Cost
    s = title_block('후원금은 접근 가능한 콘텐츠 생산으로 전환되었습니다', '후원금 활용', 6)
    s += [shape(20, 0.75, 1.67, 5.00, 4.65, '102A43', '102A43', True), textbox(21, 1.12, 2.08, 4.25, 0.62, [{'text':'$199.57', 'size':33, 'color':'FFFFFF', 'bold':True}], valign='mid'), textbox(22, 1.12, 2.92, 4.0, 0.42, [{'text':'7월 AI 운영비', 'size':15, 'color':'DDF4F1'}], valign='mid'), textbox(23, 1.12, 4.20, 4.0, 0.76, [{'text':'495건의 해설 영상\n103시간+의 콘텐츠', 'size':16, 'color':'FFFFFF', 'bold':True}], valign='mid'), shape(24, 1.12, 5.50, 2.2, 0.06, '13A6A6', '13A6A6')]
    s += [textbox(30, 6.25, 1.90, 5.7, 0.42, [{'text':'단위 비용으로 보면', 'size':14, 'color':'52677D'}], valign='mid'), textbox(31, 6.25, 2.48, 5.7, 0.58, [{'text':'해설 영상 1건당\n약 $0.40', 'size':23, 'color':'102A43', 'bold':True}], valign='mid'), textbox(32, 6.25, 3.63, 5.7, 0.58, [{'text':'해설 콘텐츠 1시간당\n약 $1.93', 'size':23, 'color':'13A6A6', 'bold':True}], valign='mid'), shape(33, 6.25, 5.07, 5.6, 0.9, 'EAF7F5', 'EAF7F5', True), textbox(34, 6.55, 5.34, 5.0, 0.30, [{'text':'지속 가능한 접근성 서비스의 기반', 'size':13, 'color':'0C7778', 'bold':True}], valign='mid')]
    slides.append((s, False))
    # 7 Next steps
    s = title_block('성과를 이어가기 위한 다음 과제', '지속 가능한 운영', 7)
    s += [textbox(20, 0.75, 1.58, 11.7, 0.48, [{'text':'현재의 이용 성과를 유지하면서, 더 많은 이용자에게 더 안정적으로 서비스를 제공하겠습니다.', 'size':16, 'color':'52677D'}], valign='mid')]
    s += [shape(30, 0.75, 2.35, 5.55, 3.55, 'EAF7F5', 'D4ECE9', True), textbox(31, 1.10, 2.68, 4.8, 0.34, [{'text':'다음 달 개선 방향', 'size':15, 'color':'0C7778', 'bold':True}], valign='mid'), textbox(32, 1.10, 3.20, 4.75, 2.15, [{'text':'더 많은 영상 해설 제공', 'size':14, 'color':'102A43', 'bullet':True},{'text':'긴 영상 처리와 이용 편의성 개선', 'size':14, 'color':'102A43', 'bullet':True},{'text':'해설 품질과 자연스러움 향상', 'size':14, 'color':'102A43', 'bullet':True},{'text':'이용자 의견을 반영한 기능 개선', 'size':14, 'color':'102A43', 'bullet':True}], valign='mid')]
    s += [shape(40, 6.80, 2.35, 5.62, 3.55, '102A43', '102A43', True), textbox(41, 7.15, 2.68, 4.8, 0.34, [{'text':'후원금이 만드는 변화', 'size':15, 'color':'DDF4F1', 'bold':True}], valign='mid'), textbox(42, 7.15, 3.20, 4.75, 2.15, [{'text':'시각 정보의 장벽 완화', 'size':14, 'color':'FFFFFF', 'bullet':True},{'text':'정보·문화 콘텐츠 접근성 확대', 'size':14, 'color':'FFFFFF', 'bullet':True},{'text':'반복 이용 가능한 해설 자산 축적', 'size':14, 'color':'FFFFFF', 'bullet':True},{'text':'누구나 즐길 수 있는 유튜브 경험', 'size':14, 'color':'FFFFFF', 'bullet':True}], valign='mid')]
    slides.append((s, False))
    # 8 Appendix list
    s = title_block('요청 시 제공 가능한 별도 자료', '부록 안내', 8)
    s += [textbox(20, 0.75, 1.55, 11.7, 0.42, [{'text':'본문 슬라이드에는 핵심 성과만 담고, 다음 자료는 요청 시 별도로 제공할 수 있습니다.', 'size':16, 'color':'52677D'}], valign='mid')]
    left = ['월간 운영 종합 보고서 원문', '일별 영상 생성 요청·성공 현황', '회원·비회원 이용 현황 상세표', '콘텐츠 생성 비용 상세 내역']
    right = ['영상 생성 실패 사유 및 개선 현황', '일별·요일별 이용 추이', '서비스 접속 환경 및 이용 통계', '운영 로그·인프라 점검 자료']
    s += [shape(30, 0.75, 2.33, 5.56, 3.85, 'F4F9FB', 'E0E9EF', True), textbox(31, 1.10, 2.70, 4.8, 2.75, [{'text':x, 'size':14, 'color':'102A43', 'bullet':True} for x in left], valign='mid')]
    s += [shape(40, 6.80, 2.33, 5.62, 3.85, 'F4F9FB', 'E0E9EF', True), textbox(41, 7.15, 2.70, 4.85, 2.75, [{'text':x, 'size':14, 'color':'102A43', 'bullet':True} for x in right], valign='mid')]
    s += [shape(50, 0.75, 6.48, 11.67, 0.36, 'EAF7F5', 'EAF7F5', True), textbox(51, 1.05, 6.55, 11.0, 0.18, [{'text':'※ 개인정보가 포함될 수 있는 자료는 비식별화 후 제공됩니다.', 'size':8, 'color':'0C7778', 'align':'c'}], align='c', valign='mid')]
    slides.append((s, False))
    return slides

THEME = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="SponsorTheme"><a:themeElements><a:clrScheme name="Sponsor"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="102A43"/></a:dk2><a:lt2><a:srgbClr val="F4F9FB"/></a:lt2><a:accent1><a:srgbClr val="13A6A6"/></a:accent1><a:accent2><a:srgbClr val="4F7CAC"/></a:accent2><a:accent3><a:srgbClr val="F0A35B"/></a:accent3><a:accent4><a:srgbClr val="8F7AEA"/></a:accent4><a:accent5><a:srgbClr val="DDF4F1"/></a:accent5><a:accent6><a:srgbClr val="E0E9EF"/></a:accent6><a:hlink><a:srgbClr val="13A6A6"/></a:hlink><a:folHlink><a:srgbClr val="4F7CAC"/></a:folHlink></a:clrScheme><a:fontScheme name="Sponsor"><a:majorFont><a:latin typeface="Apple SD Gothic Neo"/><a:ea typeface="Apple SD Gothic Neo"/><a:cs typeface="Apple SD Gothic Neo"/></a:majorFont><a:minorFont><a:latin typeface="Apple SD Gothic Neo"/><a:ea typeface="Apple SD Gothic Neo"/><a:cs typeface="Apple SD Gothic Neo"/></a:minorFont></a:fontScheme><a:fmtScheme name="Sponsor"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme></a:themeElements></a:theme>'''

def write_pptx(path):
    slides = build_slides()
    files = {}
    files['[Content_Types].xml'] = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'''
    for i in range(1, len(slides)+1):
        files['[Content_Types].xml'] += f'<Override PartName="/ppt/slides/slide{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
    files['[Content_Types].xml'] += '</Types>'
    files['_rels/.rels'] = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>'''
    files['docProps/core.xml'] = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>유튜브 화면 해설 서비스 2026년 7월 운영 성과 보고</dc:title><dc:creator>Viewrator</dc:creator><cp:lastModifiedBy>Viewrator</cp:lastModifiedBy></cp:coreProperties>'''
    files['ppt/theme/theme1.xml'] = THEME
    files['ppt/slideLayouts/slideLayout1.xml'] = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="{NS['a']}" xmlns:r="{NS['r']}" xmlns:p="{NS['p']}" type="blank"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>'''
    files['ppt/slideLayouts/_rels/slideLayout1.xml.rels'] = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>'''
    files['ppt/slideMasters/slideMaster1.xml'] = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="{NS['a']}" xmlns:r="{NS['r']}" xmlns:p="{NS['p']}"><p:cSld name="Master"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles/><p:hf/></p:sldMaster>'''
    files['ppt/slideMasters/_rels/slideMaster1.xml.rels'] = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>'''
    sids = ''.join(f'<p:sldId id="{255+i}" r:id="rId{i+1}"/>' for i in range(len(slides)))
    files['ppt/presentation.xml'] = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="{NS['a']}" xmlns:r="{NS['r']}" xmlns:p="{NS['p']}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" mc:Ignorable="p14"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>{sids}</p:sldIdLst><p:sldSz cx="{W}" cy="{H}" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr/><a:lvl1pPr marL="0" algn="l"><a:defRPr sz="1800"/></a:lvl1pPr></p:defaultTextStyle></p:presentation>'''
    pres_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>'''
    for i in range(len(slides)):
        pres_rels += f'<Relationship Id="rId{i+2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{i+1}.xml"/>'
    files['ppt/_rels/presentation.xml.rels'] = pres_rels + '</Relationships>'
    for i, (shapes, has_img) in enumerate(slides, 1):
        files[f'ppt/slides/slide{i}.xml'] = slide_xml(shapes)
        files[f'ppt/slides/_rels/slide{i}.xml.rels'] = slide_rels('rId2' if has_img else None)
    with ZipFile(path, 'w', ZIP_DEFLATED) as z:
        for name, data in files.items():
            z.writestr(name, data.encode('utf-8'))
        image_path = ROOT / 'frame-0070.jpg'
        z.write(image_path, 'ppt/media/rId2.jpg')

def write_html(path):
    # A browser-friendly preview matching the PPTX content.
    slides = [
        ('cover', '<div class="brand">VIEWRATOR</div><h1>유튜브 화면 해설 서비스</h1><h2>2026년 7월 운영 성과 보고</h2><p class="sub">후원기관 보고용<br>시각장애인 이용자의 콘텐츠 접근성을 넓혀갑니다.</p><small>집계 기간 2026.07.01 – 2026.07.31</small>', '<img src="frame-0070.jpg">'),
        ('', '<div class="kicker">한눈에 보는 성과</div><h3>7월 한 달, 495건의 영상 해설을 제공했습니다</h3><p class="lead">후원금은 시각장애인 이용자가 유튜브 콘텐츠를 더 넓게 접할 수 있도록 하는 실제 서비스 제공으로 이어졌습니다.</p><div class="cards"><div><b>495건</b><span>생성된 해설 영상</span></div><div><b>103시간+</b><span>누적 해설 콘텐츠</span></div><div><b>64명</b><span>신규 가입 회원</span></div><div><b>$199.57</b><span>7월 AI 운영비</span></div></div><blockquote>“약 200달러의 운영비로 103시간 이상의 접근 가능한 영상 콘텐츠를 만들었습니다.”</blockquote>', ''),
        ('', '<div class="kicker">누가 이용했는가</div><h3>서비스는 시각장애인 이용자 중심으로 작동했습니다</h3><p class="lead">신규 가입자의 98%가 시각장애인 인증을 완료했고, 영상 생성 요청의 대부분이 회원으로부터 발생했습니다.</p><div class="cards three"><div><b>63명</b><span>시각장애인 인증 회원</span><small>신규 가입자 64명 중</small></div><div><b>504건</b><span>인증 회원의 생성 요청</span><small>전체 542건 중</small></div><div><b>93.5%</b><span>회원 생성 요청 비중</span><small>회원 요청 507건</small></div></div><div class="band">필요한 이용자에게 집중된 서비스 운영</div>', ''),
        ('', '<div class="kicker">제공한 가치</div><h3>495건의 영상이 소리로 연결되었습니다</h3><div class="two"><div class="dark"><b>103시간+</b><span>누적 해설 콘텐츠</span><em>평균 영상 길이<br>약 12분 31초</em></div><div><p class="lead">방송·뉴스·학습·취미 등 다양한 유튜브 콘텐츠를 더 많은 사람이 즐길 수 있게 했습니다.</p><div class="pill teal">영상의 대사뿐 아니라 화면의 상황과 맥락까지 해설</div><div class="pill blue">필요한 콘텐츠를 이용자가 직접 선택하고 요청</div><div class="pill orange">한 번 만들어진 해설은 다시 활용</div></div></div>', ''),
        ('', '<div class="kicker">이용자 반응</div><h3>새로운 이용과 반복 이용이 함께 이어졌습니다</h3><p class="lead">서비스를 처음 찾은 이용자뿐 아니라, 다시 영상을 시청하고 반응을 남긴 이용자도 확인되었습니다.</p><div class="cards three"><div><b>1,574명</b><span>영상 페이지 도달 이용자</span><small>회원·비회원 포함, 접속 기준 추정</small></div><div><b>295회</b><span>로그인 회원 영상 시청</span><small>활성 회원 1인당 평균 6.0회</small></div><div><b>40회</b><span>좋아요 클릭</span><small>영상 댓글 3건</small></div></div><div class="band">서비스가 일회성 제공을 넘어 실제 시청과 소통으로 이어지고 있습니다.</div>', ''),
        ('', '<div class="kicker">후원금 활용</div><h3>후원금은 접근 가능한 콘텐츠 생산으로 전환되었습니다</h3><div class="two"><div class="dark"><b>$199.57</b><span>7월 AI 운영비</span><em>495건의 해설 영상<br>103시간+의 콘텐츠</em></div><div><p class="muted">단위 비용으로 보면</p><h4>해설 영상 1건당<br>약 $0.40</h4><h4 class="teal-text">해설 콘텐츠 1시간당<br>약 $1.93</h4><div class="pill teal">지속 가능한 접근성 서비스의 기반</div></div></div>', ''),
        ('', '<div class="kicker">지속 가능한 운영</div><h3>성과를 이어가기 위한 다음 과제</h3><p class="lead">현재의 이용 성과를 유지하면서, 더 많은 이용자에게 더 안정적으로 서비스를 제공하겠습니다.</p><div class="two"><div class="panel teal-panel"><h4>다음 달 개선 방향</h4><ul><li>더 많은 영상 해설 제공</li><li>긴 영상 처리와 이용 편의성 개선</li><li>해설 품질과 자연스러움 향상</li><li>이용자 의견을 반영한 기능 개선</li></ul></div><div class="panel dark"><h4>후원금이 만드는 변화</h4><ul><li>시각 정보의 장벽 완화</li><li>정보·문화 콘텐츠 접근성 확대</li><li>반복 이용 가능한 해설 자산 축적</li><li>누구나 즐길 수 있는 유튜브 경험</li></ul></div></div>', ''),
        ('', '<div class="kicker">부록 안내</div><h3>요청 시 제공 가능한 별도 자료</h3><p class="lead">본문 슬라이드에는 핵심 성과만 담고, 다음 자료는 요청 시 별도로 제공할 수 있습니다.</p><div class="two"><div class="panel list"><ul><li>월간 운영 종합 보고서 원문</li><li>일별 영상 생성 요청·성공 현황</li><li>회원·비회원 이용 현황 상세표</li><li>콘텐츠 생성 비용 상세 내역</li></ul></div><div class="panel list"><ul><li>영상 생성 실패 사유 및 개선 현황</li><li>일별·요일별 이용 추이</li><li>서비스 접속 환경 및 이용 통계</li><li>운영 로그·인프라 점검 자료</li></ul></div></div><div class="note">※ 개인정보가 포함될 수 있는 자료는 비식별화 후 제공됩니다.</div>', '')
    ]
    html = '''<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>유튜브 화면 해설 서비스 7월 운영 성과 보고</title><style>
    *{box-sizing:border-box}body{margin:0;background:#dfe9ee;color:#102a43;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif}.deck{padding:30px}.slide{position:relative;width:1280px;height:720px;margin:0 auto 28px;padding:48px 68px;background:#f4f9fb;overflow:hidden;box-shadow:0 10px 32px #8aa0ad55}.slide.cover{padding:80px 80px}.slide.cover:after{content:"";position:absolute;right:0;top:0;width:40%;height:100%;background:#ddf4f1}.slide.cover img{position:absolute;right:40px;top:62px;width:46%;height:596px;object-fit:cover;z-index:1}.brand,.kicker{color:#13a6a6;font-weight:800;letter-spacing:.08em;font-size:16px}.cover h1{font-size:44px;line-height:1.25;margin:115px 0 8px;max-width:600px}.cover h2{font-size:28px;color:#13a6a6;margin:0}.sub{font-size:18px;line-height:1.7;color:#52677d;margin-top:48px}.cover small{position:absolute;bottom:42px;color:#7a8b9c}h3{font-size:34px;margin:18px 0 28px}.lead{font-size:21px;font-weight:600;line-height:1.6;max-width:1030px}.cards{display:flex;gap:22px;margin-top:52px}.cards>div{background:#fff;border:1px solid #e0e9ef;border-left:7px solid #13a6a6;border-radius:14px;padding:25px 24px;width:25%;height:166px}.cards.three>div{width:33.33%}.cards b{display:block;font-size:35px;line-height:1.15}.cards span{display:block;color:#52677d;font-size:16px;margin-top:15px}.cards small{display:block;color:#7a8b9c;font-size:11px;margin-top:10px}.cards>div:nth-child(2){border-left-color:#4f7cac}.cards>div:nth-child(3){border-left-color:#f0a35b}.cards>div:nth-child(4){border-left-color:#8f7aea}blockquote,.band{margin-top:50px;background:#eaf7f5;border-radius:12px;padding:22px;color:#0c7778;font-weight:800;text-align:center;font-size:20px}.two{display:grid;grid-template-columns:42% 1fr;gap:60px;margin-top:44px}.dark{background:#102a43;color:#fff;border-radius:16px;padding:52px 45px;height:380px}.dark b{display:block;font-size:48px}.dark span{display:block;color:#ddf4f1;font-size:20px;margin-top:16px}.dark em{display:block;font-style:normal;font-size:20px;line-height:1.5;margin-top:72px}.pill{border-radius:12px;padding:22px;margin:18px 0;font-weight:700;font-size:16px}.pill.teal{background:#eaf7f5;color:#0c7778}.pill.blue{background:#f4f6fa;color:#4f7cac}.pill.orange{background:#fff5e9;color:#a36522}.muted{color:#52677d;font-size:18px}.teal-text{color:#13a6a6}h4{font-size:27px;line-height:1.35;margin:28px 0}.panel{border-radius:15px;padding:30px 34px;min-height:300px}.teal-panel{background:#eaf7f5;border:1px solid #d4ece9}.panel.dark{height:auto;min-height:300px;padding:30px 34px}.panel h4{font-size:20px;margin:0 0 22px;color:#0c7778}.panel.dark h4{color:#ddf4f1}.panel ul{padding-left:23px;margin:0}.panel li{font-size:17px;line-height:1.9}.panel.dark li{color:#fff}.list{background:#fff;border:1px solid #e0e9ef}.list li{line-height:2.1}.note{margin-top:38px;background:#eaf7f5;color:#0c7778;text-align:center;padding:10px;border-radius:9px;font-size:12px}.slide:not(.cover):after{content:"운영 성과 보고 · 2026년 7월";position:absolute;left:68px;bottom:22px;font-size:10px;color:#7a8b9c}.slide:not(.cover):before{content:attr(data-no);position:absolute;right:68px;bottom:22px;font-size:10px;color:#7a8b9c}.cover{margin-bottom:28px}</style></head><body><div class="deck">'''
    for i,(cls,body,img) in enumerate(slides,1):
        html += f'<section class="slide {cls}" data-no="{i}">{body}{img}</section>'
    html += '</div></body></html>'
    path.write_text(html, encoding='utf-8')

if __name__ == '__main__':
    write_pptx(OUT / 'sponsor_report_20260701_20260731.pptx')
    write_html(OUT / 'sponsor_report_20260701_20260731_preview.html')
    print('created', OUT / 'sponsor_report_20260701_20260731.pptx')
    print('created', OUT / 'sponsor_report_20260701_20260731_preview.html')
