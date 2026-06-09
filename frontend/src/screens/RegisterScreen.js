import React, { useState, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import axios from 'axios';
import './RegisterScreen.css';

function RegisterScreen() {
    const navigate = useNavigate();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [name, setName] = useState('');
    const [phone, setPhone] = useState('');
    const [birthdate, setBirthdate] = useState('');
    const [pin, setPin] = useState('');
    const [verificationMethod, setVerificationMethod] = useState('siloam_api'); // 'siloam_api' or 'card_ocr'
    
    // OCR 관련 상태
    const [cardImage, setCardImage] = useState(null);
    const [mimeType, setMimeType] = useState('');
    
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [successMessage, setSuccessMessage] = useState('');
    
    const fileInputRef = useRef(null);

    // 스크린리더를 위한 실시간 알림 영역 텍스트
    const [srAnnouncement, setSrAnnouncement] = useState('');

    const handleFileChange = (e) => {
        const file = e.target.files[0];
        if (file) {
            if (!file.type.startsWith('image/')) {
                const err = '이미지 파일만 업로드할 수 있습니다.';
                setError(err);
                setSrAnnouncement(err);
                return;
            }
            
            setMimeType(file.type);
            const reader = new FileReader();
            reader.onloadend = () => {
                setCardImage(reader.result);
                setSrAnnouncement('복지카드 이미지가 성공적으로 선택되었습니다.');
            };
            reader.readAsDataURL(file);
        }
    };

    const triggerFileSelect = () => {
        fileInputRef.current.click();
    };

    const handleRemoveImage = (e) => {
        e.stopPropagation();
        setCardImage(null);
        setMimeType('');
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
        setSrAnnouncement('선택한 복지카드 이미지가 제거되었습니다.');
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setSuccessMessage('');
        setSrAnnouncement('');

        // 기본 벨리데이션
        if (password !== confirmPassword) {
            const err = '비밀번호와 비밀번호 확인이 일치하지 않습니다.';
            setError(err);
            setSrAnnouncement(err);
            return;
        }

        if (verificationMethod === 'card_ocr' && !cardImage) {
            const err = '복지카드 사진을 업로드해 주세요.';
            setError(err);
            setSrAnnouncement(err);
            return;
        }

        setLoading(true);
        setSrAnnouncement('회원가입 및 시각장애인 인증을 시작합니다. 잠시만 기다려 주십시오.');

        try {
            const response = await axios.post('/api/auth/register', {
                email,
                password,
                name,
                phone,
                birthdate,
                pin,
                verificationMethod,
                cardImage: verificationMethod === 'card_ocr' ? cardImage : undefined,
                mimeType: verificationMethod === 'card_ocr' ? mimeType : undefined
            });

            if (response.data.success) {
                const msg = response.data.message || '회원가입이 완료되었습니다.';
                setSuccessMessage(msg);
                setSrAnnouncement(msg + ' 로그인 페이지로 이동합니다.');
                
                setTimeout(() => {
                    navigate('/login');
                }, 3000);
            }
        } catch (err) {
            const errMsg = err.response?.data?.error || '회원가입 처리 중 오류가 발생했습니다. 입력 정보를 확인해 주십시오.';
            setError(errMsg);
            setSrAnnouncement(errMsg);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="register-container">
            {/* 스크린리더 음성 안내용 aria-live 영역 */}
            <div className="sr-only" aria-live="assertive" role="alert">
                {srAnnouncement}
            </div>

            <div className="register-card">
                <h1 className="register-title" id="form-title">회원 가입</h1>
                <p className="register-subtitle">시각장애인 전용 화면 해설 작성을 위해 인증 후 가입을 완료해 주십시오.</p>
                
                <div className="status-messages-container">
                    {error && <div className="error-message" id="error-desc">{error}</div>}
                    {successMessage && <div className="success-message" style={{ color: '#86efac', marginBottom: '15px', fontSize: '0.95rem' }}>{successMessage}</div>}
                </div>

                <form className="register-form" onSubmit={handleSubmit} aria-labelledby="form-title">
                    <div className="form-group">
                        <label className="form-label" htmlFor="email">이메일 (아이디)</label>
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

                    <div className="form-group">
                        <label className="form-label" htmlFor="confirmPassword">비밀번호 확인</label>
                        <input
                            type="password"
                            id="confirmPassword"
                            className="form-input"
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            required
                            placeholder={confirmPassword ? "" : "비밀번호 재입력"}
                            aria-invalid={password !== confirmPassword ? "true" : "false"}
                        />
                    </div>

                    <div className="form-group">
                        <label className="form-label" htmlFor="name">이름 (실명)</label>
                        <input
                            type="text"
                            id="name"
                            className="form-input"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            required
                            placeholder={name ? "" : "성명 입력"}
                        />
                    </div>

                    <div className="form-group">
                        <label className="form-label" htmlFor="birthdate">생년월일 (8자리 숫자만)</label>
                        <input
                            type="text"
                            id="birthdate"
                            className="form-input"
                            value={birthdate}
                            onChange={(e) => setBirthdate(e.target.value.replace(/[^0-9]/g, ''))}
                            required
                            placeholder={birthdate ? "" : "예: 19900101"}
                        />
                    </div>

                    <div className="form-group">
                        <label className="form-label" htmlFor="phone">휴대폰 번호 (숫자만)</label>
                        <input
                            type="tel"
                            id="phone"
                            className="form-input"
                            value={phone}
                            onChange={(e) => setPhone(e.target.value.replace(/[^0-9]/g, ''))}
                            required
                            placeholder={phone ? "" : "예: 01012345678"}
                        />
                    </div>

                    <div className="form-group">
                        <label className="form-label" htmlFor="pin">비밀번호 찾기용 PIN 번호 (4~6자리 숫자)</label>
                        <input
                            type="password"
                            id="pin"
                            className="form-input"
                            value={pin}
                            onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
                            required
                            maxLength="6"
                            placeholder="PIN 번호 입력"
                        />
                        <span className="form-hint" style={{ fontSize: '0.8rem', color: '#9ca3af', marginTop: '4px', display: 'block' }}>
                            * 향후 비밀번호 분실 시 계정 보안 유지를 위한 본인 확인용 PIN 번호입니다. 안전하게 보관해 주십시오.
                        </span>
                    </div>

                    <div className="form-group">
                        <span className="form-label" id="method-label">시각장애인 인증 방식 선택</span>
                        <div className="method-selector" role="radiogroup" aria-labelledby="method-label">
                            <button
                                type="button"
                                className={`method-btn ${verificationMethod === 'siloam_api' ? 'active' : ''}`}
                                onClick={() => {
                                    setVerificationMethod('siloam_api');
                                    setSrAnnouncement('인증 수단이 실로암 복지관 회원 조회 방식으로 설정되었습니다.');
                                }}
                                role="radio"
                                aria-checked={verificationMethod === 'siloam_api'}
                            >
                                실로암 복지관 인증
                            </button>
                            <button
                                type="button"
                                className={`method-btn ${verificationMethod === 'card_ocr' ? 'active' : ''}`}
                                onClick={() => {
                                    setVerificationMethod('card_ocr');
                                    setSrAnnouncement('인증 수단이 복지카드 사진 분석 방식으로 설정되었습니다.');
                                }}
                                role="radio"
                                aria-checked={verificationMethod === 'card_ocr'}
                            >
                                복지카드 촬영 인증
                            </button>
                        </div>
                    </div>

                    {verificationMethod === 'siloam_api' && (
                        <div style={{ fontSize: '0.85rem', color: '#9ca3af', lineHeight: '1.4', background: 'rgba(255,255,255,0.02)', padding: '12px', borderRadius: '6px' }}>
                            실로암 복지관에 등록된 실명, 생년월일, 휴대폰 번호와 가입 양식의 정보가 정확하게 일치하면 즉시 인증이 완료됩니다.
                        </div>
                    )}

                    {verificationMethod === 'card_ocr' && (
                        <div className="form-group">
                            <label className="form-label">복지카드 업로드</label>
                            
                            <input
                                type="file"
                                ref={fileInputRef}
                                style={{ display: 'none' }}
                                accept="image/*"
                                onChange={handleFileChange}
                            />
                            
                            {!cardImage ? (
                                <div 
                                    className="ocr-upload-box" 
                                    onClick={triggerFileSelect}
                                    role="button"
                                    tabIndex={0}
                                    onKeyDown={(e) => e.key === 'Enter' && triggerFileSelect()}
                                    aria-label="복지카드 이미지 파일 선택"
                                >
                                    <div className="ocr-upload-icon">📸</div>
                                    <span style={{ fontSize: '0.95rem', fontWeight: 600 }}>복지카드 사진 첨부하기</span>
                                    <span style={{ fontSize: '0.8rem', color: '#9ca3af', marginTop: '4px' }}>카메라 촬영 또는 갤러리 업로드</span>
                                </div>
                            ) : (
                                <div className="ocr-preview-container">
                                    <img src={cardImage} alt="업로드된 복지카드 미리보기" className="ocr-preview-image" />
                                    <button type="button" className="ocr-remove-btn" onClick={handleRemoveImage}>제거</button>
                                </div>
                            )}

                            <div className="ocr-warning-box" role="alert">
                                🔒 업로드된 복지카드 사진은 저장되지 않으며, 시각장애인 자격 확인 완료 즉시 안전하게 폐기됩니다.
                            </div>
                        </div>
                    )}

                    <button 
                        type="submit" 
                        className="submit-btn" 
                        disabled={loading}
                    >
                        {loading ? '인증 및 가입 처리 중...' : '인증 후 회원 가입 완료'}
                    </button>
                </form>

                <div style={{ marginTop: '20px', textAlign: 'center', fontSize: '0.9rem', color: '#9ca3af' }}>
                    이미 계정이 있으신가요? <Link to="/login" style={{ color: '#a78bfa', textDecoration: 'none', fontWeight: 600 }}>로그인하기</Link>
                </div>
            </div>
        </div>
    );
}

export default RegisterScreen;
