import React, { useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import './LoginScreen.css';

function LoginScreen() {
    const { login } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();
    
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    // 스크린리더 공지용 상태
    const [srAnnouncement, setSrAnnouncement] = useState('');

    // 로그인 완료 후 이동할 원래 대상 페이지 확인 (없으면 메인)
    const from = location.state?.from?.pathname || "/";

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setSrAnnouncement('');
        setLoading(true);
        setSrAnnouncement('로그인을 요청 중입니다. 잠시만 기다려 주십시오.');

        const result = await login(email, password);
        
        if (result.success) {
            setSrAnnouncement('로그인에 성공했습니다. 이전 화면으로 리다이렉트합니다.');
            setTimeout(() => {
                navigate(from, { replace: true });
            }, 1000);
        } else {
            setError(result.error);
            setSrAnnouncement(result.error);
            setLoading(false);
        }
    };

    return (
        <div className="login-container">
            {/* 스크린리더 알림용 live 영역 */}
            <div className="sr-only" aria-live="assertive" role="alert">
                {srAnnouncement}
            </div>

            <div className="login-card">
                <h1 className="login-title" id="login-title">로그인</h1>
                <p className="login-subtitle">화면 해설 생성 서비스를 이용하기 위해 계정 정보를 입력하십시오.</p>
                
                <div className="status-messages-container">
                    {error && <div className="error-message" role="alert">{error}</div>}
                </div>

                <form className="login-form" onSubmit={handleSubmit} aria-labelledby="login-title">
                    <div className="form-group">
                        <label className="form-label" htmlFor="email">이메일 주소</label>
                        <input
                            type="email"
                            id="email"
                            className="form-input"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            required
                            placeholder={email ? "" : "example@email.com"}
                        />
                    </div>

                    <div className="form-group">
                        <label className="form-label" htmlFor="password">비밀번호</label>
                        <input
                            type="password"
                            id="password"
                            className="form-input"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                            placeholder={password ? "" : "비밀번호 입력"}
                        />
                    </div>

                    <button 
                        type="submit" 
                        className="submit-btn" 
                        disabled={loading}
                    >
                        {loading ? '로그인 처리 중...' : '로그인'}
                    </button>
                </form>

                <div style={{ marginTop: '20px', textAlign: 'center', fontSize: '0.9rem', color: '#9ca3af' }}>
                    아직 회원이 아니신가요? <Link to="/register" style={{ color: '#a78bfa', textDecoration: 'none', fontWeight: 600 }}>회원가입하기</Link>
                </div>
            </div>
        </div>
    );
}

export default LoginScreen;
