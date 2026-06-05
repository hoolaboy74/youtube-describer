import React, { createContext, useState, useEffect, useContext } from 'react';
import axios from 'axios';

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
    const [user, setUser] = useState(null);
    const [token, setToken] = useState(localStorage.getItem('token') || null);
    const [loading, setLoading] = useState(true);

    // API URL 설정 (개발/운영 유연화)
    const API_BASE = process.env.REACT_APP_API_URL || '';

    // 토큰이 변경될 때마다 axios의 기본 헤더 설정 및 로컬스토리지 동기화
    useEffect(() => {
        if (token) {
            localStorage.setItem('token', token);
            axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
        } else {
            localStorage.removeItem('token');
            delete axios.defaults.headers.common['Authorization'];
        }
    }, [token]);

    // 앱 실행 시 로그인 세션 유지 검사
    useEffect(() => {
        const checkLogin = async () => {
            if (!token) {
                setLoading(false);
                return;
            }

            try {
                const response = await axios.get(`${API_BASE}/api/auth/me`);
                if (response.data.success) {
                    setUser(response.data.user);
                } else {
                    setToken(null);
                    setUser(null);
                }
            } catch (error) {
                console.error('Session validation failed:', error);
                // 네트워크 오류가 아닌 401인 경우에만 토큰 리셋
                if (error.response && error.response.status === 401) {
                    setToken(null);
                    setUser(null);
                }
            } finally {
                setLoading(false);
            }
        };

        checkLogin();
    }, [token, API_BASE]);

    // 로그인
    const login = async (email, password) => {
        try {
            const response = await axios.post(`${API_BASE}/api/auth/login`, { email, password });
            if (response.data.success) {
                setToken(response.data.token);
                setUser(response.data.user);
                return { success: true };
            }
        } catch (error) {
            const errMsg = error.response?.data?.error || '로그인에 실패했습니다.';
            return { success: false, error: errMsg };
        }
    };

    // 로그아웃
    const logout = async () => {
        try {
            await axios.post(`${API_BASE}/api/auth/logout`);
        } catch (e) {
            console.warn('Logout request failed:', e);
        } finally {
            setToken(null);
            setUser(null);
        }
    };

    return (
        <AuthContext.Provider value={{ user, token, loading, login, logout, API_BASE }}>
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => {
    const context = useContext(AuthContext);
    if (!context) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
};
