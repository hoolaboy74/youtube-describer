import React from 'react';
import { NavLink } from 'react-router-dom';
import './BottomNav.css';

const BottomNav = () => {
  return (
    <nav className="bottom-nav">
      <NavLink to="/" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")} end>
        <span className="nav-icon">🏠</span>
        <span className="nav-text">홈</span>
      </NavLink>
      <NavLink to="/board" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}>
        <span className="nav-icon">📋</span>
        <span className="nav-text">게시판</span>
      </NavLink>
      <NavLink to="/more" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}>
        <span className="nav-icon">⚙️</span>
        <span className="nav-text">더보기</span>
      </NavLink>
    </nav>
  );
};

export default BottomNav;
