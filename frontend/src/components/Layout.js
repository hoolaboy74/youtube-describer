import React, { useRef } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Header from './Header';
import BottomNav from './BottomNav';
import { usePageFocus } from '../hooks';
import './Layout.css';

const Layout = () => {
  const location = useLocation();
  const titleRef = useRef(null);

  usePageFocus(titleRef);

  const getTitle = (pathname) => {
    if (pathname === '/') return '뷰레이터';
    if (pathname.startsWith('/board')) return '와글와글 게시판';
    if (pathname === '/more') return '더보기';
    return '유튜브 화면 해설';
  };

  const title = getTitle(location.pathname);

  // Pages that should not have the main layout (header/bottom-nav)
  const noLayoutPaths = [
    /^\/video\/.+/,
    /^\/board\/create$/,
    /^\/board\/\d+$/,
    /^\/admin$/,
  ];

  const showLayout = !noLayoutPaths.some(pathRegex => pathRegex.test(location.pathname));

  if (!showLayout) {
    return <Outlet />;
  }

  return (
    <div className="layout">
      <Header title={title} ref={titleRef} />
      <main className="main-content">
        <Outlet />
      </main>
      <BottomNav />
    </div>
  );};

export default Layout;
