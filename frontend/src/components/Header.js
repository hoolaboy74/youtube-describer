import React, { forwardRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import './Header.css';

const Header = forwardRef(({ title }, ref) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const showBackButton = location.pathname !== '/';

  return (
    <header className="header" role="none">
      <div className="header-left">
        {showBackButton && (
          <button onClick={() => navigate(-1)} className="back-button-header" aria-label="뒤로 가기">
            &larr;
          </button>
        )}
      </div>
      <h1 className="header-title" ref={ref}>
        <Link to="/" className="header-link">
            {title}
        </Link>
      </h1>
      <div className="header-right">
        {user ? (
          <div className="user-info-header">
            <Link to="/mypage" className="user-name-link" aria-label={`로그인된 사용자: ${user.name}. 마이페이지로 이동`}>
              <span className="user-name">{user.name}님</span>
            </Link>
            <button onClick={logout} className="logout-button-header" aria-label="로그아웃">
              로그아웃
            </button>
          </div>
        ) : (
          <>
            <Link to="/login" className="login-link-header" aria-label="로그인">
              로그인
            </Link>
            <Link to="/register" className="register-link-header" aria-label="회원가입">
              회원가입
            </Link>
          </>
        )}
      </div>
    </header>
  );
});

export default Header;
