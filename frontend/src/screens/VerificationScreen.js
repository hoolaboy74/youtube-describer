import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import { useAccessibility } from '../contexts/AccessibilityContext';
import './VerificationScreen.css';

function VerificationScreen() {
    const navigate = useNavigate();
    const { token, API_BASE } = useAuth();
    const { announcePolite, announceAssertive } = useAccessibility();

    // 회원 프로필 정보
    const [profile, setProfile] = useState({
        name: '',
        phone: '',
        birthdate: '',
        isBlind: 0
    });

    const [verificationMethod, setVerificationMethod] = useState('siloam_api'); // 'siloam_api' or 'card_ocr'
    const [cardImage, setCardImage] = useState(null);
    const [mimeType, setMimeType] = useState('');
    const [loading, setLoading] = useState(false);
    const [pageLoading, setPageLoading] = useState(true);
    const [error, setError] = useState('');
    const [successMessage, setSuccessMessage] = useState('');
    const [srAnnouncement, setSrAnnouncement] = useState('');

    const fileInputRef = useRef(null);

    // 로그인 확인 및 프로필 로드
    useEffect(() => {
        if (!token) {
            navigate('/login');
            return;
        }

        const loadProfile = async () => {
            try {
                const res = await axios.get(`${API_BASE}/api/users/me`);
                if (res.data.success) {
                    const user = res.data.user;
                    if (user.isBlind === 1) {
                        announceAssertive('이미 시각장애인 인증이 완료된 회원입니다. 마이페이지로 이동합니다.');
                        navigate('/mypage');
                        return;
                    }
                    setProfile(user);
                    setSrAnnouncement('시각장애인 인증 페이지가 열렸습니다. 가입하신 회원 정보로 인증을 진행할 수 있습니다.');
                }
            } catch (err) {
                console.error('Failed to load profile for verification:', err);
                setError('사용자 정보를 불러오는데 실패했습니다.');
                announceAssertive('사용자 정보를 불러오는데 실패했습니다. 마이페이지로 돌아갑니다.');
                setTimeout(() => navigate('/mypage'), 2000);
            } finally {
                setPageLoading(false);
            }
        };

        loadProfile();
    }, [token, navigate, API_BASE, announceAssertive]);

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

        if (verificationMethod === 'card_ocr' && !cardImage) {
            const err = '복지카드 사진을 업로드해 주세요.';
            setError(err);
            setSrAnnouncement(err);
            return;
        }

        setLoading(true);
        setSrAnnouncement('시각장애인 자격 자가 인증을 요청 중입니다. 잠시만 기다려 주십시오.');

        try {
            const response = await axios.post(`${API_BASE}/api/users/me/verify-blind`, {
                verificationMethod,
                cardImage: verificationMethod === 'card_ocr' ? cardImage : undefined,
                mimeType: verificationMethod === 'card_ocr' ? mimeType : undefined
            });

            if (response.data.success) {
                const msg = response.data.message || '인증 처리가 완료되었습니다.';
                setSuccessMessage(msg);
                setSrAnnouncement(msg + ' 마이페이지로 이동합니다.');
                announcePolite(msg);
                
                setTimeout(() => {
                    navigate('/mypage');
                }, 3000);
            }
        } catch (err) {
            const errMsg = err.response?.data?.error || '인증 처리 중 오류가 발생했습니다. 회원 정보와 일치 여부를 확인해 주십시오.';
            setError(errMsg);
            setSrAnnouncement(errMsg);
            announceAssertive(errMsg);
        } finally {
            setLoading(false);
        }
    };

    if (pageLoading) {
        return (
            <div className="verify-loading" role="status">
                <p>인증 페이지 데이터를 불러오는 중입니다...</p>
                <div className="spinner"></div>
            </div>
        );
    }

    return (
        <div className="verify-container">
            {/* 스크린리더 음성 안내용 aria-live 영역 */}
            <div className="sr-only" aria-live="assertive" role="alert">
                {srAnnouncement}
            </div>

            <div className="verify-card">
                <h1 className="verify-title" id="verify-form-title">시각장애인 회원 자격 인증</h1>
                <p className="verify-subtitle">뷰래이터 서비스 내 5분 초과 영상의 화면 해설 대본 요청을 위해 장애인 자격을 인증해 주십시오.</p>
                
                <div className="verify-user-info-box">
                    <h2 className="info-title">내 가입 정보</h2>
                    <ul className="info-list">
                        <li><strong>이름:</strong> {profile.name}</li>
                        <li><strong>생년월일:</strong> {profile.birthdate}</li>
                        <li><strong>연락처:</strong> {profile.phone}</li>
                    </ul>
                    <p className="info-hint">* 위 개인 인적사항 정보와 매칭하여 검증이 수행됩니다. 정보 수정이 필요하시면 먼저 마이페이지에서 수정해 주십시오.</p>
                </div>

                <div className="status-messages-container">
                    {error && <div className="error-message" id="error-desc">{error}</div>}
                    {successMessage && <div className="success-message" style={{ color: '#86efac', marginBottom: '15px', fontSize: '0.95rem' }}>{successMessage}</div>}
                </div>

                <form className="verify-form" onSubmit={handleSubmit} aria-labelledby="verify-form-title">
                    <div className="form-group">
                        <span className="form-label" id="verify-method-label">시각장애인 인증 방식 선택</span>
                        <div className="method-selector" role="radiogroup" aria-labelledby="verify-method-label">
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
                            실로암 복지관에 등록된 회원 인적사항(이름, 생년월일, 휴대폰 번호)과 내 가입 정보가 정확하게 일치하면 즉시 인증이 완료됩니다.
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

                    <div style={{ display: 'flex', gap: '15px', marginTop: '20px' }}>
                        <button 
                            type="button" 
                            className="cancel-btn" 
                            onClick={() => navigate('/mypage')}
                            style={{
                                flex: 1,
                                padding: '14px',
                                background: 'rgba(255, 255, 255, 0.05)',
                                border: 'var(--glass-border)',
                                borderRadius: '8px',
                                color: 'var(--color-text-main)',
                                fontSize: '1rem',
                                fontWeight: 700,
                                cursor: 'pointer',
                                transition: 'all 0.3s ease'
                            }}
                        >
                            취소
                        </button>
                        <button 
                            type="submit" 
                            className="submit-btn" 
                            disabled={loading}
                            style={{
                                flex: 2,
                                margin: 0 // 기본 margin 제거
                            }}
                        >
                            {loading ? '인증 처리 중...' : '인증 완료'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}

export default VerificationScreen;
