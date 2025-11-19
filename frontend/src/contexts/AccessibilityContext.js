import React, { createContext, useState, useRef, useCallback, useContext } from 'react';

const AccessibilityContext = createContext(null);

export const AccessibilityProvider = ({ children }) => {
  const [politeAnnouncement, setPoliteAnnouncement] = useState('');
  const [assertiveAnnouncement, setAssertiveAnnouncement] = useState('');
  const politeTimeoutRef = useRef(null);
  const assertiveTimeoutRef = useRef(null);

  const announcePolite = useCallback((message) => {
    clearTimeout(politeTimeoutRef.current);
    setPoliteAnnouncement('');
    setTimeout(() => {
        setPoliteAnnouncement(message);
        politeTimeoutRef.current = setTimeout(() => setPoliteAnnouncement(''), 2000);
    }, 100);
  }, []);

  const announceAssertive = useCallback((message) => {
    clearTimeout(assertiveTimeoutRef.current);
    setAssertiveAnnouncement('');
    setTimeout(() => {
        setAssertiveAnnouncement(message);
        assertiveTimeoutRef.current = setTimeout(() => setAssertiveAnnouncement(''), 5000);
    }, 100);
  }, []);

  const value = { announcePolite, announceAssertive };

  return (
    <AccessibilityContext.Provider value={value}>
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">{politeAnnouncement}</div>
      <div className="visually-hidden" aria-live="assertive" aria-atomic="true">{assertiveAnnouncement}</div>
      {children}
    </AccessibilityContext.Provider>
  );
};

export const useAccessibility = () => {
  const context = useContext(AccessibilityContext);
  if (!context) {
    throw new Error('useAccessibility must be used within an AccessibilityProvider');
  }
  return context;
};
