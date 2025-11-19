import React, { forwardRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import './Header.css';

const Header = forwardRef(({ title }, ref) => {
  const location = useLocation();
  const navigate = useNavigate();

  const showBackButton = location.pathname !== '/';

  return (
    <header className="header">
      <div className="header-left">
        {showBackButton && (
          <button onClick={() => navigate(-1)} className="back-button-header">
            &larr;
          </button>
        )}
      </div>
      <h1 className="header-title" ref={ref}>
        <Link to="/" className="header-link">
            {title}
        </Link>
      </h1>
      <div className="header-right"></div>
    </header>
  );
});

export default Header;
