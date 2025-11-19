import React, { forwardRef } from 'react';
import { Link } from 'react-router-dom';
import './Header.css';

const Header = forwardRef(({ title }, ref) => {
  return (
    <header className="header">
      <h1 className="header-title" ref={ref}>
        <Link to="/" className="header-link">
            {title}
        </Link>
      </h1>
    </header>
  );
});

export default Header;
