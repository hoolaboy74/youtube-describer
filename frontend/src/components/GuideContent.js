import React, { useState } from 'react';
import { useAccessibility } from '../contexts/AccessibilityContext';
import './GuideContent.css';

const GuideContent = () => {
  const { announcePolite } = useAccessibility();
  const [isCopied, setIsCopied] = useState(false);

  const handleCopyAccount = () => {
    const textToCopy = '우리은행 1005-980-321301';
    navigator.clipboard.writeText(textToCopy).then(() => {
      setIsCopied(true);
      announcePolite('계좌번호가 복사되었습니다.');
      setTimeout(() => setIsCopied(false), 2000);
    }).catch(err => {
      console.error('Failed to copy account number: ', err);
      announcePolite('계좌번호 복사에 실패했습니다.');
    });
  };

  return (
    <div className="guide-content">
        <h3>서비스 이용 방법</h3>
        <div style={{ textAlign: 'left', marginBottom: '20px' }}>
          <h4>1. 영상 찾기 및 생성</h4>
          <p>홈 화면 입력창에 유튜브 주소(URL)나 검색어를 입력 후 '검색 또는 생성' 버튼을 누르세요. 검색 결과에서 원하는 영상을 선택하면 재생 화면으로 이동합니다.</p>
          
          <h4>2. 해설과 함께 재생</h4>
          <p><strong>새로운 영상:</strong> 해설 생성이 자동으로 시작되며, 영상 길이에 따라 몇 분 정도 소요될 수 있습니다. 생성이 완료되면 바로 시청할 수 있습니다.</p>
          <p><strong>기존 영상:</strong> 이미 해설이 만들어진 영상은 바로 재생됩니다.</p>

          <h4 style={{ marginTop: '20px' }}><strong>** 주의 사항 **</strong></h4>
          <ul>
            <li>화면 해설은 AI에 의해 자동 생성 되므로 해설의 품질이 전문 작가가 만드는 해설과는 차이가 있습니다.</li>
            <li>영상의 내용에 폭력, 선정성, 비윤리적인 내용이 있다면 AI가 화면 해설 생성을 거부 하고 오류를 낼 수 있습니다.</li>
            <li>이런 상황이 반복 되면 서비스 전체가 중지 될 수있고 복구에는 많은 시간이 필요 합니다.</li>
          </ul>
          
          <hr style={{ margin: '20px 0' }} />

          <div className="sponsorship-info">
            <p>이 서비스는 <strong>시각장애인 맘 센터</strong>의 후원으로 운영됩니다. 서비스의 안정적인 운영과 개선을 위해 여러분의 소중한 후원을 부탁드립니다.</p>
            <p><strong>후원 계좌:</strong> 시각장애인MOM센터 우리은행 1005-980-321301</p>
            <button onClick={handleCopyAccount} className="copy-button">
              {isCopied ? '복사됨!' : '계좌번호 복사'}
            </button>
            <p style={{ marginTop: '15px' }}><strong>문의 사항:</strong> momcenter1@gmail.com</p>
          </div>
        </div>
    </div>
  );
};

export default GuideContent;
