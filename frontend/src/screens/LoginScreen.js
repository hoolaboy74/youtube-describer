import React, { useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import axios from 'axios';
import './LoginScreen.css';

function LoginScreen() {
    const { login } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();
    
    // 모드: 'login', 'findId', 'resetPassword'
    const [mode, setMode] = useState('login');
    
    // 로그인 상태
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    
    // 아이디 찾기 상태
    const [findName, setFindName] = useState('');
    const [findBirthdate, setFindBirthdate] = useState('');
    const [foundEmail, setFoundEmail] = useState('');
    
    // 비밀번호 재설정 상태
    const [resetName, setResetName] = useState('');
    const [resetBirthdate, setResetBirthdate] = useState('');
    const [resetPhone, setResetPhone] = useState('');
    const [resetPin, setResetPin] = useState('');
    const [isResetVerified, setIsResetVerified] = useState(false);
    const [newPassword, setNewPassword] = useState('');
    const [confirmNewPassword, setConfirmNewPassword] = useState('');
    
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [successMessage, setSuccessMessage] = useState('');

    // 스크린리더 공지용 상태
    const [srAnnouncement, setSrAnnouncement] = useState('');

    // 로그인 완료 후 이동할 원래 대상 페이지 확인 (없으면 메인)
    const from = location.state?.from?.pathname || "/";

    const handleLoginSubmit = async (e) => {
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

    const handleFindIdSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setSuccessMessage('');
        setFoundEmail('');
        setLoading(true);
        setSrAnnouncement('회원 아이디를 조회 중입니다.');

        try {
            const response = await axios.post('/api/auth/find-id', {
                name: findName,
                birthdate: findBirthdate
            });
            if (response.data.success) {
                setFoundEmail(response.data.email);
                setSrAnnouncement(`회원님의 아이디는 ${response.data.email} 입니다.`);
            }
        } catch (err) {
            const errMsg = err.response?.data?.error || '일치하는 회원 정보를 찾을 수 없습니다.';
            setError(errMsg);
            setSrAnnouncement(errMsg);
        } finally {
            setLoading(false);
        }
    };

    const handleVerifyResetSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setSuccessMessage('');
        setLoading(true);
        setSrAnnouncement('입력하신 인증 정보를 검증 중입니다.');

        try {
            const response = await axios.post('/api/auth/verify-reset-credentials', {
                name: resetName,
                birthdate: resetBirthdate,
                phone: resetPhone,
                pin: resetPin
            });
            if (response.data.success) {
                setIsResetVerified(true);
                setSuccessMessage(response.data.message);
                setSrAnnouncement('인증에 성공했습니다. 새 비밀번호를 입력해 주십시오.');
            }
        } catch (err) {
            const errMsg = err.response?.data?.error || '인증 정보가 올바르지 않습니다.';
            setError(errMsg);
            setSrAnnouncement(errMsg);
        } finally {
            setLoading(false);
        }
    };

    const handleResetPasswordSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setSuccessMessage('');
        setSrAnnouncement('');

        if (newPassword !== confirmNewPassword) {
            const err = '비밀번호와 비밀번호 확인이 일치하지 않습니다.';
            setError(err);
            setSrAnnouncement(err);
            return;
        }

        setLoading(true);
        setSrAnnouncement('비밀번호를 변경하고 있습니다.');

        try {
            const response = await axios.post('/api/auth/reset-password-with-pin', {
                name: resetName,
                birthdate: resetBirthdate,
                phone: resetPhone,
                pin: resetPin,
                newPassword
            });
            if (response.data.success) {
                setSuccessMessage('비밀번호가 성공적으로 재설정되었습니다. 변경된 비밀번호로 로그인해 주십시오.');
                setSrAnnouncement('비밀번호가 성공적으로 재설정되었습니다. 로그인 화면으로 돌아갑니다.');
                setTimeout(() => {
                    handleBackToLogin();
                }, 3000);
            }
        } catch (err) {
            const errMsg = err.response?.data?.error || '비밀번호 재설정 처리 중 오류가 발생했습니다.';
            setError(errMsg);
            setSrAnnouncement(errMsg);
        } finally {
            setLoading(false);
        }
    };

    const handleBackToLogin = () => {
        setMode('login');
        setError('');
        setSuccessMessage('');
        setFoundEmail('');
        setFindName('');
        setFindBirthdate('');
        setResetName('');
        setResetBirthdate('');
        setResetPhone('');
        setResetPin('');
        setIsResetVerified(false);
        setNewPassword('');
        setConfirmNewPassword('');
        setSrAnnouncement('로그인 화면으로 돌아왔습니다.');
    };

    const changeMode = (newMode, announcement) => {
        setMode(newMode);
        setError('');
        setSuccessMessage('');
        setSrAnnouncement(announcement);
    };

    return (
        <div className="login-container">
            {/* 스크린리더 알림용 live 영역 */}
            <div className="sr-only" aria-live="assertive" role="alert">
                {srAnnouncement}
            </div>

            <div className="login-card">
                {mode === 'login' && (
                    <>
                        <h1 className="login-title" id="login-title">로그인</h1>
                        <p className="login-subtitle">화면 해설 생성 서비스를 이용하기 위해 계정 정보를 입력하십시오.</p>
                        
                        <div className="status-messages-container">
                            {error && <div className="error-message" role="alert">{error}</div>}
                        </div>

                        <form className="login-form" onSubmit={handleLoginSubmit} aria-labelledby="login-title">
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

                        <div style={{ marginTop: '20px', display: 'flex', justifyContent: 'center', gap: '10px', fontSize: '0.85rem', color: '#9ca3af' }}>
                            <button type="button" onClick={() => changeMode('findId', '회원 ID 찾기 화면으로 이동했습니다.')} style={{ background: 'none', border: 'none', color: '#a78bfa', cursor: 'pointer', fontWeight: 600 }}>아이디 찾기</button>
                            <span>|</span>
                            <button type="button" onClick={() => changeMode('resetPassword', '비밀번호 찾기 화면으로 이동했습니다.')} style={{ background: 'none', border: 'none', color: '#a78bfa', cursor: 'pointer', fontWeight: 600 }}>비밀번호 찾기</button>
                        </div>

                        <div style={{ marginTop: '15px', textAlign: 'center', fontSize: '0.9rem', color: '#9ca3af' }}>
                            아직 회원이 아니신가요? <Link to="/register" style={{ color: '#a78bfa', textDecoration: 'none', fontWeight: 600 }}>회원가입하기</Link>
                        </div>
                    </>
                )}

                {mode === 'findId' && (
                    <>
                        <h1 className="login-title" id="find-id-title">아이디 찾기</h1>
                        <p className="login-subtitle">가입 시 입력하신 이름과 생년월일을 입력하여 아이디(이메일)를 찾으실 수 있습니다.</p>

                        <div className="status-messages-container">
                            {error && <div className="error-message" role="alert">{error}</div>}
                            {foundEmail && (
                                <div className="success-message" style={{ padding: '12px 16px', background: 'rgba(134, 239, 172, 0.15)', borderRadius: '8px', color: '#86efac', fontSize: '0.95rem', border: '1px solid rgba(134, 239, 172, 0.3)', marginBottom: '15px', textAlign: 'center' }}>
                                    회원님의 아이디는 <strong>{foundEmail}</strong> 입니다.
                                </div>
                            )}
                        </div>

                        {!foundEmail ? (
                            <form className="login-form" onSubmit={handleFindIdSubmit} aria-labelledby="find-id-title">
                                <div className="form-group">
                                    <label className="form-label" htmlFor="findName">이름 (실명)</label>
                                    <input
                                        type="text"
                                        id="findName"
                                        className="form-input"
                                        value={findName}
                                        onChange={(e) => setFindName(e.target.value)}
                                        required
                                        placeholder={findName ? "" : "성명 입력"}
                                    />
                                </div>

                                <div className="form-group">
                                    <label className="form-label" htmlFor="findBirthdate">생년월일 (8자리 숫자만)</label>
                                    <input
                                        type="text"
                                        id="findBirthdate"
                                        className="form-input"
                                        value={findBirthdate}
                                        onChange={(e) => setFindBirthdate(e.target.value.replace(/[^0-9]/g, ''))}
                                        required
                                        placeholder={findBirthdate ? "" : "예: 19900101"}
                                    />
                                </div>

                                <button 
                                    type="submit" 
                                    className="submit-btn" 
                                    disabled={loading}
                                >
                                    {loading ? '조회 중...' : '아이디 찾기'}
                                </button>
                            </form>
                        ) : null}

                        <button 
                            type="button" 
                            className="submit-btn" 
                            style={{ background: 'rgba(255, 255, 255, 0.08)', border: '1px solid rgba(255, 255, 255, 0.15)', marginTop: foundEmail ? '15px' : '10px' }}
                            onClick={handleBackToLogin}
                        >
                            로그인 화면으로 돌아가기
                        </button>
                    </>
                )}

                {mode === 'resetPassword' && (
                    <>
                        <h1 className="login-title" id="reset-password-title">비밀번호 찾기 (재설정)</h1>
                        <p className="login-subtitle">
                            {!isResetVerified 
                                ? "이름, 생년월일, 전화번호 및 가입 시 설정한 PIN 번호를 입력하여 본인 확인을 완료해 주십시오."
                                : "본인 확인이 완료되었습니다. 새로운 비밀번호를 설정해 주십시오."
                            }
                        </p>

                        <div className="status-messages-container">
                            {error && <div className="error-message" role="alert">{error}</div>}
                            {successMessage && <div className="success-message" style={{ padding: '12px 16px', background: 'rgba(134, 239, 172, 0.15)', borderRadius: '8px', color: '#86efac', fontSize: '0.95rem', border: '1px solid rgba(134, 239, 172, 0.3)', marginBottom: '15px' }}>{successMessage}</div>}
                        </div>

                        {!isResetVerified ? (
                            <form className="login-form" onSubmit={handleVerifyResetSubmit} aria-labelledby="reset-password-title">
                                <div className="form-group">
                                    <label className="form-label" htmlFor="resetName">이름 (실명)</label>
                                    <input
                                        type="text"
                                        id="resetName"
                                        className="form-input"
                                        value={resetName}
                                        onChange={(e) => setResetName(e.target.value)}
                                        required
                                        placeholder={resetName ? "" : "성명 입력"}
                                    />
                                </div>

                                <div className="form-group">
                                    <label className="form-label" htmlFor="resetBirthdate">생년월일 (8자리 숫자만)</label>
                                    <input
                                        type="text"
                                        id="resetBirthdate"
                                        className="form-input"
                                        value={resetBirthdate}
                                        onChange={(e) => setResetBirthdate(e.target.value.replace(/[^0-9]/g, ''))}
                                        required
                                        placeholder={resetBirthdate ? "" : "예: 19900101"}
                                    />
                                </div>

                                <div className="form-group">
                                    <label className="form-label" htmlFor="resetPhone">휴대폰 번호 (숫자만)</label>
                                    <input
                                        type="tel"
                                        id="resetPhone"
                                        className="form-input"
                                        value={resetPhone}
                                        onChange={(e) => setResetPhone(e.target.value.replace(/[^0-9]/g, ''))}
                                        required
                                        placeholder={resetPhone ? "" : "예: 01012345678"}
                                    />
                                </div>

                                <div className="form-group">
                                    <label className="form-label" htmlFor="resetPin">가입 시 설정한 PIN 번호</label>
                                    <input
                                        type="password"
                                        id="resetPin"
                                        className="form-input"
                                        value={resetPin}
                                        onChange={(e) => setResetPin(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
                                        required
                                        maxLength="6"
                                        placeholder={resetPin ? "" : "PIN 번호 입력"}
                                    />
                                </div>

                                <button 
                                    type="submit" 
                                    className="submit-btn" 
                                    disabled={loading}
                                >
                                    {loading ? '확인 중...' : '인증 정보 확인'}
                                </button>
                            </form>
                        ) : (
                            <form className="login-form" onSubmit={handleResetPasswordSubmit} aria-labelledby="reset-password-title">
                                <div className="form-group">
                                    <label className="form-label" htmlFor="newPassword">새 비밀번호</label>
                                    <input
                                        type="password"
                                        id="newPassword"
                                        className="form-input"
                                        value={newPassword}
                                        onChange={(e) => setNewPassword(e.target.value)}
                                        required
                                        placeholder={newPassword ? "" : "새 비밀번호 입력"}
                                    />
                                </div>

                                <div className="form-group">
                                    <label className="form-label" htmlFor="confirmNewPassword">새 비밀번호 확인</label>
                                    <input
                                        type="password"
                                        id="confirmNewPassword"
                                        className="form-input"
                                        value={confirmNewPassword}
                                        onChange={(e) => setConfirmNewPassword(e.target.value)}
                                        required
                                        placeholder={confirmNewPassword ? "" : "새 비밀번호 재입력"}
                                    />
                                </div>

                                <button 
                                    type="submit" 
                                    className="submit-btn" 
                                    disabled={loading}
                                >
                                    {loading ? '변경 중...' : '비밀번호 재설정 완료'}
                                </button>
                            </form>
                        )}

                        <button 
                            type="button" 
                            className="submit-btn" 
                            style={{ background: 'rgba(255, 255, 255, 0.08)', border: '1px solid rgba(255, 255, 255, 0.15)', marginTop: '10px' }}
                            onClick={handleBackToLogin}
                        >
                            로그인 화면으로 돌아가기
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}

export default LoginScreen;
