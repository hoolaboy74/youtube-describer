import React, { useState, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import GuideContent from '../components/GuideContent';
import './MoreScreen.css';

const MoreScreen = () => {
  const [showGuide, setShowGuide] = useState(false);
  const guideTitleRef = useRef(null);
  const triggerButtonRef = useRef(null);

  useEffect(() => {
    if (showGuide) {
      if (guideTitleRef.current) {
        guideTitleRef.current.setAttribute('tabindex', '-1');
        guideTitleRef.current.focus();
      }
    } else {
      if (triggerButtonRef.current) {
        triggerButtonRef.current.focus();
        // Reset after use
        triggerButtonRef.current = null;
      }
    }
  }, [showGuide]);

  const handleShowGuide = (e) => {
    // Store the element that triggered the guide
    triggerButtonRef.current = e.currentTarget;
    setShowGuide(true);
  };

  const handleHideGuide = () => {
    setShowGuide(false);
  };

  if (showGuide) {
    return (
      <div className="more-screen">
        <button onClick={handleHideGuide} className="back-button">← 뒤로</button>
        <GuideContent ref={guideTitleRef} />
      </div>
    );
  }

  return (
    <div className="more-screen">
      <ul className="more-menu">
        <li className="more-menu-item">
          <button onClick={handleShowGuide} className="more-menu-button">서비스 이용 안내</button>
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
