import copy
import hashlib
import importlib.util
import json
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from zipfile import ZipFile

spec = importlib.util.spec_from_file_location('builder', Path(__file__).with_name('build_monthly_report.py'))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def sample():
    routes = [('description.request',36,241),('description.script',43,622),('tts.description',40,12454)]
    top = {'name':'Private Person','email':'secret@example.test','id':'private-uuid','ip':'1.2.3.4',
           'coreActiveDays':28,'registeredVideos':87,'completedVideos':84,
           'registeredVideoList':[{'title':t,'videoId':v,'status':'completed'} for t,v in [
               ('마티스 미술 강의','AAAAAAAAAAA'),('영화 오디세이 인터뷰','BBBBBBBBBBB'),('스마트 글래스 소개','CCCCCCCCCCC')]]}
    activity = {'definitions':{'coreRoutes':[r[0] for r in routes]},
        'summary':{'coreActiveMembers':43,'apiActiveMembers':46,'averageCoreDau':4.45,'averageApiDau':5.16,'maxCoreDau':8,'averageDauCompleteWindow':True},
        'daily':[{'date':f'2026-08-{i:02d}','coreUsers':4,'apiUsers':5,'privatePayload':'secret@example.test'} for i in range(1,32)],
        'monthly':[{'month':'2026-08','coreMau':43,'apiMau':46,'completeCalendarMonth':True}],
        'repeat':{'coreRepeatUsers':20,'coreRepeatRate':20/43*100,'activeDayDistribution':[{'bucket':b,'coreUsers':n} for b,n in [('1일',23),('2~3일',12),('4~7일',6),('8~14일',0),('15일 이상',2)]]},
        'weeklyRetention':[{'weekStart':'2026-08-03','nextWeekStart':'2026-08-10','completeWindows':True,'coreReturned':10,'coreCohort':16,'coreReturnRate':62.5},
                           {'weekStart':'2026-08-31','nextWeekStart':'2026-09-07','completeWindows':False,'coreReturned':0,'coreCohort':4,'coreReturnRate':None}],
        'monthlyRetention':[{'completeWindows':False}],
        'functions':[{'route':r,'apiUsers':u,'memberRequests':n,'apiRequests':n} for r,u,n in routes],
        'onboarding':{'newMembers':19,'coreUsedMembers':17,'coreRepeatMembers':6,'firstCoreDelayMedianSeconds':105,'firstCoreDelaySamples':17,'eligible7DayMembers':11,'returnedWithin7DayMembers':4,'returnWithin7DayRate':4/11*100,'coreActivationRate':17/19*100},
        'topActiveMembers':[top]}
    return {'schemaVersion':2,'collector':{'version':2,'sha256':'fixture'},'collectedAt':'2026-09-30T00:00:00Z',
            'range':{'startDate':'2026-08-01','endDate':'2026-08-31'},'warnings':[],
            'data':{'activity':activity,'videos':{'registered':224,'completed':201,'failed':23,'successRate':201/224*100,'failureCategories':{'model':8,'download':4,'other_or_unknown':11}},
                    'members':{'new':19},'costs':{'total':129.080974,'descriptionCost':129.080974,'qaCost':0},'api':{'requests':48567},
                    'qaReceipts':{'periodEvidence':'NO_RETAINED_DATA_BEFORE_FIRST_RECEIPT'}}}


class ReportTests(unittest.TestCase):
    def test_safe_projection_and_metrics(self):
        with tempfile.TemporaryDirectory() as root:
            report=sample(); before=copy.deepcopy(report)
            model=builder.content.make_content(report,Path(root))
            self.assertEqual(report,before)
            self.assertEqual(len(model['slides']),8)
            self.assertIn('43명',model['slides'][0]['title'])
            self.assertIn('46.5%',model['slides'][2]['lead'])
            self.assertEqual([r['users'] for r in model['slides'][3]['chart']['rows']],[36,43,40])
            self.assertIn('11명 중 4명',model['slides'][4]['sidebar']['cards'][0]['detail'])
            text=json.dumps(model,ensure_ascii=False)
            for private in ['Private Person','secret@example.test','private-uuid','1.2.3.4','privatePayload']:
                self.assertNotIn(private,text)

    def test_missing_activity_dates_and_partial_month_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            p=Path(root)/'stats.json';r=sample();r['data']['activity']=None;p.write_text(json.dumps(r))
            with self.assertRaises(ValueError):builder.load_report(p,'2026-08-01','2026-08-31')
            r=sample();r['data']['activity']['daily'].pop();p.write_text(json.dumps(r))
            with self.assertRaises(ValueError):builder.load_report(p,'2026-08-01','2026-08-31')
            with self.assertRaises(ValueError):builder.load_report(p,'2026-08-02','2026-08-31')

    def test_comparable_history_and_missing_periods(self):
        with tempfile.TemporaryDirectory() as root:
            directory=Path(root);r=sample()
            rows,sources=builder.content.monthly_history(r,directory)
            self.assertEqual(rows,[['6월','—','—'],['7월','—','—'],['8월','43','46']]);self.assertEqual(sources,[])
            old=sample();old['range']={'startDate':'2026-07-01','endDate':'2026-07-31'};old['data']['activity']['monthly']=[{'month':'2026-07','coreMau':25,'apiMau':30,'completeCalendarMonth':True}]
            p=directory/'system_stats_report_20260701_20260731.json';p.write_text(json.dumps(old))
            rows,sources=builder.content.monthly_history(r,directory);self.assertEqual(rows[1],['7월','25','30']);self.assertEqual(sources,[p])
            old['data']['activity']['definitions']['coreRoutes']=['changed'];p.write_text(json.dumps(old))
            self.assertEqual(builder.content.monthly_history(r,directory)[0][1],['7월','—','—'])

    def test_package_charts_accessibility_and_privacy(self):
        with tempfile.TemporaryDirectory() as root:
            directory=Path(root);(directory/'frame-0070.jpg').write_bytes(b'fixture-jpeg')
            raw=directory/'system_stats_report_20260801_20260831.json';raw.write_text(json.dumps(sample()))
            preview,pptx=builder.build('2026-08-01','2026-08-31',directory);text=preview.read_text()
            self.assertEqual(text.count('<section '),8);self.assertEqual(text.count('<svg '),3)
            self.assertIn('일별 활성 회원 상세표',text);self.assertIn('alt="뷰래이터',text)
            self.assertIn('핵심 기능 MAU',text);self.assertIn('$129.08',text);self.assertIn('익명 이용 사례',text)
            with ZipFile(pptx) as z:
                self.assertIsNone(z.testzip());self.assertEqual(z.read('ppt/media/rId2.jpg'),b'fixture-jpeg')
                xml=''.join(z.read(n).decode() for n in z.namelist() if n.endswith('.xml'))
                rels=ET.fromstring(z.read('ppt/_rels/presentation.xml.rels')); targets={r.attrib['Id']:r.attrib['Target'] for r in rels}
                pres=ET.fromstring(z.read('ppt/presentation.xml'))
                for i,sid in enumerate(pres.findall('.//{http://schemas.openxmlformats.org/presentationml/2006/main}sldId'),1):
                    self.assertEqual(int(sid.attrib['id']),255+i)
                    self.assertEqual(targets[sid.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']],f'slides/slide{i}.xml')
                self.assertIn('<p:txBody>',xml);self.assertNotIn('<a:txBody>',xml)
                for private in ['Private Person','secret@example.test','private-uuid','1.2.3.4']:self.assertNotIn(private,xml+text)
                self.assertNotIn('2026년 7월 운영 성과',xml)
            m=json.loads((directory/'sponsor_report_20260801_20260831_manifest.json').read_text())
            self.assertEqual(m['formatVersion'],3);self.assertEqual(m['sourceSha256'],hashlib.sha256(raw.read_bytes()).hexdigest())


if __name__ == '__main__':unittest.main()
