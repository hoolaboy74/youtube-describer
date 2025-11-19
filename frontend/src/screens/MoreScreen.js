import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import GuideContent from '../components/GuideContent';
import './MoreScreen.css';

const MoreScreen = () => {
  const [showGuide, setShowGuide] = useState(false);

  if (showGuide) {
    return (
      <div className="more-screen">
        <button onClick={() => setShowGuide(false)} className="back-button">← 뒤로</button>
        <GuideContent />
      </div>
    );
  }

  return (
    <div className="more-screen">
      <ul className="more-menu">
        <li className="more-menu-item">
          <button onClick={() => setShowGuide(true)} className="more-menu-button">서비스 이용 안내</button>
        </li>
        <li className="more-menu-item">
          <Link to="/admin">관리자 페이지</Link>
        </li>
        {/* Add other links like donation, etc. here */}
      </ul>
    </div>
  );
};

export default MoreScreen;
