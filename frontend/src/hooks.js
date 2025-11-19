import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

// Custom hook for managing focus on page/view change
export function usePageFocus(ref) {
    const location = useLocation();

    useEffect(() => {
        if (ref.current) {
            ref.current.setAttribute('tabindex', '-1');
            setTimeout(() => ref.current.focus(), 0);
        }
    }, [location.pathname, ref]);
}
