import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import { useAccessibility } from '../contexts/AccessibilityContext';
import './MyPageScreen.css';

function MyPageScreen() {
    const { token, logout, API_BASE } = useAuth();
    const { announcePolite } = useAccessibility();
    const navigate = useNavigate();

    // 회원 정보 상태
    const [profile, setProfile] = useState({
        name: '',
        email: '',
        phone: '',
        birthdate: '',
        pin: '',
        isBlind: 0,
        createdAt: ''
    });
    const [infoMessage, setInfoMessage] = useState('');
    const [infoError, setInfoError] = useState('');

    // 비밀번호 변경 상태
    const [passwords, setPasswords] = useState({
        currentPassword: '',
        newPassword: '',
        confirmPassword: ''
    });
    const [pwMessage, setPwMessage] = useState('');
    const [pwError, setPwError] = useState('');

    // 데이터 목록 상태
    const [requestedVideos, setRequestedVideos] = useState([]);
    const [watchHistory, setWatchHistory] = useState([]);
    const [favorites, setFavorites] = useState([]);
    const [myPosts, setMyPosts] = useState([]);
    const [myComments, setMyComments] = useState([]);

    // 더보기 토글 상태
    const [showAllRequested, setShowAllRequested] = useState(false);
    const [showAllHistory, setShowAllHistory] = useState(false);
    const [showAllFavorites, setShowAllFavorites] = useState(false);
    const [showAllPosts, setShowAllPosts] = useState(false);
    const [showAllComments, setShowAllComments] = useState(false);

    const [loading, setLoading] = useState(true);
    const [theme, setTheme] = useState(() => localStorage.getItem('app-theme') || 'dark');

    const handleThemeChange = (newTheme) => {
        setTheme(newTheme);
        localStorage.setItem('app-theme', newTheme);
        document.documentElement.setAttribute('data-theme', newTheme);
        announcePolite(newTheme === 'dark' ? '다크 모드로 전환되었습니다.' : '라이트 모드로 전환되었습니다.');
    };

    // 로그인 검증
    useEffect(() => {
        if (!token) {
            navigate('/login');
        }
    }, [token, navigate]);

    // 초기 데이터 로드
    useEffect(() => {
        const fetchMyPageData = async () => {
            if (!token) return;
            setLoading(true);
            try {
                // 1. 회원 정보 로드
                const profileRes = await axios.get(`${API_BASE}/api/users/me`);
                if (profileRes.data.success) {
                    setProfile({
                        ...profileRes.data.user,
                        pin: profileRes.data.user.pin || ''
                    });
                }

                // 2. 요청 영상 목록
                const reqVideosRes = await axios.get(`${API_BASE}/api/users/me/videos/requested`);
                if (reqVideosRes.data.success) {
                    setRequestedVideos(reqVideosRes.data.videos);
                }

                // 3. 최근 시청 목록
                const historyRes = await axios.get(`${API_BASE}/api/users/me/videos/history`);
                if (historyRes.data.success) {
                    setWatchHistory(historyRes.data.videos);
                }

                // 4. 즐겨찾기 목록
                const favRes = await axios.get(`${API_BASE}/api/users/me/videos/favorites`);
                if (favRes.data.success) {
                    setFavorites(favRes.data.videos);
                }

                // 5. 활동 목록 (게시판/댓글)
                const activitiesRes = await axios.get(`${API_BASE}/api/users/me/activities`);
                if (activitiesRes.data.success) {
                    setMyPosts(activitiesRes.data.posts);
                    setMyComments(activitiesRes.data.comments);
                }
            } catch (err) {
                console.error('Failed to load my page data:', err);
                announcePolite('마이페이지 데이터를 불러오는 중에 오류가 발생했습니다.');
            } finally {
                setLoading(false);
            }
        };

        fetchMyPageData();
    }, [token, API_BASE, announcePolite]);

    // 회원 정보 수정 처리
    const handleUpdateProfile = async (e) => {
        e.preventDefault();
        setInfoMessage('');
        setInfoError('');

        if (!profile.name || !profile.phone || !profile.pin) {
            setInfoError('이름, 연락처, PIN 번호를 모두 입력해주세요.');
            announcePolite('이름, 연락처, PIN 번호를 모두 입력해주세요.');
            return;
        }
        if (profile.pin.length < 4 || profile.pin.length > 6) {
            setInfoError('PIN 번호는 4~6자리 숫자여야 합니다.');
            announcePolite('PIN 번호는 4~6자리 숫자여야 합니다.');
            return;
        }

        try {
            const res = await axios.put(`${API_BASE}/api/users/me`, {
                name: profile.name,
                phone: profile.phone,
                pin: profile.pin
            });
            if (res.data.success) {
                setInfoMessage('회원 정보가 성공적으로 수정되었습니다.');
                announcePolite('회원 정보가 성공적으로 수정되었습니다.');
            }
        } catch (err) {
            const errMsg = err.response?.data?.error || '정보 수정 중 오류가 발생했습니다.';
            setInfoError(errMsg);
            announcePolite(errMsg);
        }
    };

    // 비밀번호 변경 처리
    const handleUpdatePassword = async (e) => {
        e.preventDefault();
        setPwMessage('');
        setPwError('');

        if (!passwords.currentPassword || !passwords.newPassword || !passwords.confirmPassword) {
            setPwError('모든 비밀번호 필드를 입력해주세요.');
            announcePolite('모든 비밀번호 필드를 입력해주세요.');
            return;
        }

        if (passwords.newPassword !== passwords.confirmPassword) {
            setPwError('새 비밀번호와 비밀번호 확인이 일치하지 않습니다.');
            announcePolite('새 비밀번호와 비밀번호 확인이 일치하지 않습니다.');
            return;
        }

        try {
            const res = await axios.put(`${API_BASE}/api/users/me/password`, {
                currentPassword: passwords.currentPassword,
                newPassword: passwords.newPassword
            });
            if (res.data.success) {
                setPwMessage('비밀번호가 안전하게 변경되었습니다.');
                announcePolite('비밀번호가 안전하게 변경되었습니다.');
                setPasswords({ currentPassword: '', newPassword: '', confirmPassword: '' });
            }
        } catch (err) {
            const errMsg = err.response?.data?.error || '비밀번호 변경 중 오류가 발생했습니다.';
            setPwError(errMsg);
            announcePolite(errMsg);
        }
    };

    // 시각장애인 인증 등급 라벨화
    const getBlindStatusLabel = (status) => {
        switch (status) {
            case 1: return '시각장애인 인증 회원';
            case 2: return '인증 반려 (정보 불일치)';
            case 9: return '관리자 승인 대기 중';
            case 0:
            default:
                return '미인증 (일반 회원)';
        }
    };

    const formatDuration = (seconds) => {
        if (!seconds) return '00:00';
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    };

    if (loading) {
        return (
            <div className="mypage-loading" role="status">
                <p>마이페이지 데이터를 불러오는 중입니다...</p>
                <div className="spinner"></div>
            </div>
        );
    }

    // 목록 분할 도우미 (최대 5개 노출 후 토글)
    const getVisibleItems = (items, showAll) => {
        return showAll ? items : items.slice(0, 5);
    };

    return (
        <div className="mypage-container">
            <h1 className="mypage-title">마이페이지</h1>

            {/* 섹션 0: 화면 테마 설정 (저시력자/색반전 대응) */}
            <section className="mypage-section" aria-labelledby="section-theme">
                <h2 id="section-theme" style={{ fontSize: '1.25rem', marginBottom: '10px' }}>화면 테마 설정</h2>
                <p style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)', marginBottom: '15px', lineHeight: '1.5' }}>
                    * 스마트폰의 <strong>색 반전(Invert)</strong> 기능을 켜고 사용하시는 저시력 사용자 분들은 <strong>'☀️ 라이트 모드'</strong>를 선택하시면 화면이 반전되어 눈부심이 없는 다크 모드로 표현됩니다.
                </p>
                <div style={{ display: 'flex', gap: '15px' }} role="radiogroup" aria-labelledby="section-theme">
                    <button
                        type="button"
                        onClick={() => handleThemeChange('dark')}
                        className={`theme-btn ${theme === 'dark' ? 'active' : ''}`}
                        role="radio"
                        aria-checked={theme === 'dark'}
                        style={{
                            padding: '12px 24px',
                            background: theme === 'dark' ? 'var(--gradient-accent)' : 'var(--glass-bg)',
                            color: '#fff',
                            border: theme === 'dark' ? 'none' : 'var(--glass-border)',
                            borderRadius: '8px',
                            cursor: 'pointer',
                            fontWeight: 'bold',
                            flex: 1
                        }}
                    >
                        🌙 다크 모드 (기본)
                    </button>
                    <button
                        type="button"
                        onClick={() => handleThemeChange('light')}
                        className={`theme-btn ${theme === 'light' ? 'active' : ''}`}
                        role="radio"
                        aria-checked={theme === 'light'}
                        style={{
                            padding: '12px 24px',
                            background: theme === 'light' ? 'var(--gradient-accent)' : 'var(--glass-bg)',
                            color: '#fff',
                            border: theme === 'light' ? 'none' : 'var(--glass-border)',
                            borderRadius: '8px',
                            cursor: 'pointer',
                            fontWeight: 'bold',
                            flex: 1
                        }}
                    >
                        ☀️ 라이트 모드 (색 반전 사용자용)
                    </button>
                </div>
            </section>

            {/* 섹션 1: 가입 회원 정보 */}
            <section className="mypage-section" aria-labelledby="section-profile">
                <h2 id="section-profile">가입 정보 및 수정</h2>
                <form onSubmit={handleUpdateProfile} className="mypage-form">
                    <div className="form-group">
                        <label htmlFor="profile-email">이메일 계정 (수정 불가)</label>
                        <input
                            type="email"
                            id="profile-email"
                            value={profile.email}
                            readOnly
                            className="input-readonly"
                        />
                    </div>
                    <div className="form-group">
                        <label htmlFor="profile-name">이름</label>
                        <input
                            type="text"
                            id="profile-name"
                            value={profile.name}
                            onChange={(e) => setProfile({ ...profile, name: e.target.value })}
                            placeholder="실명을 입력하세요"
                        />
                    </div>
                    <div className="form-group">
                        <label htmlFor="profile-phone">연락처 (휴대폰 번호)</label>
                        <input
                            type="tel"
                            id="profile-phone"
                            value={profile.phone}
                            onChange={(e) => setProfile({ ...profile, phone: e.target.value })}
                            placeholder="010-0000-0000"
                        />
                    </div>
                    <div className="form-group">
                        <label htmlFor="profile-pin">비밀번호 찾기용 PIN 번호 (4~6자리 숫자)</label>
                        <input
                            type="password"
                            id="profile-pin"
                            value={profile.pin}
                            onChange={(e) => setProfile({ ...profile, pin: e.target.value.replace(/[^0-9]/g, '').slice(0, 6) })}
                            placeholder={profile.pin ? "" : "PIN 번호 입력"}
                            maxLength="6"
                        />
                    </div>
                    <div className="form-group">
                        <label htmlFor="profile-birth">생년월일 (수정 불가)</label>
                        <input
                            type="text"
                            id="profile-birth"
                            value={profile.birthdate}
                            readOnly
                            className="input-readonly"
                        />
                    </div>
                    <div className="form-group">
                        <span className="label-simulation">장애인 자격 인증 상태</span>
                        <div className="status-badge-container" style={{ display: 'flex', alignItems: 'center', gap: '15px', marginTop: '4px' }}>
                            <div className="status-badge" aria-live="polite" style={{ display: 'inline-block' }}>
                                {getBlindStatusLabel(profile.isBlind)}
                            </div>
                            {(profile.isBlind === 0 || profile.isBlind === 2) && (
                                <Link to="/verify" className="btn-verify-direct" style={{
                                    padding: '8px 16px',
                                    background: 'var(--gradient-accent)',
                                    color: '#fff',
                                    borderRadius: '6px',
                                    textDecoration: 'none',
                                    fontSize: '0.85rem',
                                    fontWeight: 'bold',
                                    boxShadow: 'var(--glass-shadow-light)',
                                    display: 'inline-block'
                                }}>
                                    시각장애인 인증하기
                                </Link>
                            )}
                        </div>
                    </div>

                    {infoMessage && <p className="success-message" role="status">{infoMessage}</p>}
                    {infoError && <p className="error-message" role="alert">{infoError}</p>}

                    <button type="submit" className="btn-submit">회원 정보 수정</button>
                </form>
            </section>

            {/* 섹션 2: 비밀번호 변경 */}
            <section className="mypage-section" aria-labelledby="section-password">
                <h2 id="section-password">비밀번호 변경</h2>
                <form onSubmit={handleUpdatePassword} className="mypage-form">
                    <div className="form-group">
                        <label htmlFor="pw-current">현재 비밀번호</label>
                        <input
                            type="password"
                            id="pw-current"
                            value={passwords.currentPassword}
                            onChange={(e) => setPasswords({ ...passwords, currentPassword: e.target.value })}
                            placeholder="현재 사용 중인 비밀번호"
                        />
                    </div>
                    <div className="form-group">
                        <label htmlFor="pw-new">새 비밀번호</label>
                        <input
                            type="password"
                            id="pw-new"
                            value={passwords.newPassword}
                            onChange={(e) => setPasswords({ ...passwords, newPassword: e.target.value })}
                            placeholder="새로운 비밀번호"
                        />
                    </div>
                    <div className="form-group">
                        <label htmlFor="pw-confirm">새 비밀번호 확인</label>
                        <input
                            type="password"
                            id="pw-confirm"
                            value={passwords.confirmPassword}
                            onChange={(e) => setPasswords({ ...passwords, confirmPassword: e.target.value })}
                            placeholder="새로운 비밀번호 한 번 더 입력"
                        />
                    </div>

                    {pwMessage && <p className="success-message" role="status">{pwMessage}</p>}
                    {pwError && <p className="error-message" role="alert">{pwError}</p>}

                    <button type="submit" className="btn-submit">비밀번호 업데이트</button>
                </form>
            </section>

            {/* 섹션 3: 내가 생성 요청한 영상 */}
            <section className="mypage-section" aria-labelledby="section-requested">
                <h2 id="section-requested">내가 해설 생성을 신청한 영상</h2>
                {requestedVideos.length === 0 ? (
                    <p className="empty-list-text">해설 생성을 신청한 영상이 없습니다.</p>
                ) : (
                    <>
                        <ul className="video-list">
                            {getVisibleItems(requestedVideos, showAllRequested).map((video) => (
                                <li key={video.videoId} className="video-item-card">
                                    <Link to={`/video/${video.videoId}`} className="video-link">
                                        <span className="video-title">{video.title}</span>
                                        <div className="video-meta">
                                            <span className="video-duration">재생시간: {formatDuration(video.duration)}</span>
                                            <span className={`status-tag status-${video.status}`}>
                                                {video.status === 'completed' && '완료'}
                                                {video.status === 'processing' && '생성 중'}
                                                {video.status === 'failed' && '실패'}
                                            </span>
                                        </div>
                                    </Link>
                                </li>
                            ))}
                        </ul>
                        {requestedVideos.length > 5 && (
                            <button
                                onClick={() => setShowAllRequested(!showAllRequested)}
                                className="btn-toggle-more"
                                aria-expanded={showAllRequested}
                            >
                                {showAllRequested ? '접기' : `더보기 (${requestedVideos.length - 5}개 더 있음)`}
                            </button>
                        )}
                    </>
                )}
            </section>

            {/* 섹션 4: 최근 시청한 영상 */}
            <section className="mypage-section" aria-labelledby="section-history">
                <h2 id="section-history">최근 시청한 영상</h2>
                {watchHistory.length === 0 ? (
                    <p className="empty-list-text">최근 시청한 영상이 없습니다.</p>
                ) : (
                    <>
                        <ul className="video-list">
                            {getVisibleItems(watchHistory, showAllHistory).map((video, idx) => (
                                <li key={`${video.videoId}-${idx}`} className="video-item-card">
                                    <Link to={`/video/${video.videoId}`} className="video-link">
                                        <span className="video-title">{video.title}</span>
                                        <div className="video-meta">
                                            <span className="video-duration">재생시간: {formatDuration(video.duration)}</span>
                                            <span className="watch-date">시청일: {new Date(video.watchedAt).toLocaleDateString()}</span>
                                        </div>
                                    </Link>
                                </li>
                            ))}
                        </ul>
                        {watchHistory.length > 5 && (
                            <button
                                onClick={() => setShowAllHistory(!showAllHistory)}
                                className="btn-toggle-more"
                                aria-expanded={showAllHistory}
                            >
                                {showAllHistory ? '접기' : `더보기 (${watchHistory.length - 5}개 더 있음)`}
                            </button>
                        )}
                    </>
                )}
            </section>

            {/* 섹션 5: 좋아요 한 영상 */}
            <section className="mypage-section" aria-labelledby="section-favorites">
                <h2 id="section-favorites">좋아요 한 영상</h2>
                {favorites.length === 0 ? (
                    <p className="empty-list-text">좋아요를 누른 영상이 없습니다.</p>
                ) : (
                    <>
                        <ul className="video-list">
                            {getVisibleItems(favorites, showAllFavorites).map((video) => (
                                <li key={video.videoId} className="video-item-card">
                                    <Link to={`/video/${video.videoId}`} className="video-link">
                                        <span className="video-title">{video.title}</span>
                                        <div className="video-meta">
                                            <span className="video-duration">재생시간: {formatDuration(video.duration)}</span>
                                            <span className="fav-date">등록일: {new Date(video.createdAt).toLocaleDateString()}</span>
                                        </div>
                                    </Link>
                                </li>
                            ))}
                        </ul>
                        {favorites.length > 5 && (
                            <button
                                onClick={() => setShowAllFavorites(!showAllFavorites)}
                                className="btn-toggle-more"
                                aria-expanded={showAllFavorites}
                            >
                                {showAllFavorites ? '접기' : `더보기 (${favorites.length - 5}개 더 있음)`}
                            </button>
                        )}
                    </>
                )}
            </section>

            {/* 섹션 6: 커뮤니티 활동 (내가 쓴 게시글) */}
            <section className="mypage-section" aria-labelledby="section-posts">
                <h2 id="section-posts">내가 쓴 자유게시판 게시글</h2>
                {myPosts.length === 0 ? (
                    <p className="empty-list-text">작성한 게시글이 없습니다.</p>
                ) : (
                    <>
                        <ul className="activity-list">
                            {getVisibleItems(myPosts, showAllPosts).map((post) => (
                                <li key={post.id} className="activity-item-card">
                                    <Link to={`/board/${post.id}`} className="activity-link">
                                        <span className="activity-title">{post.title}</span>
                                        <span className="activity-date">{new Date(post.createdAt).toLocaleDateString()}</span>
                                    </Link>
                                </li>
                            ))}
                        </ul>
                        {myPosts.length > 5 && (
                            <button
                                onClick={() => setShowAllPosts(!showAllPosts)}
                                className="btn-toggle-more"
                                aria-expanded={showAllPosts}
                            >
                                {showAllPosts ? '접기' : `더보기 (${myPosts.length - 5}개 더 있음)`}
                            </button>
                        )}
                    </>
                )}
            </section>

            {/* 섹션 7: 커뮤니티 활동 (내가 쓴 댓글) */}
            <section className="mypage-section" aria-labelledby="section-comments">
                <h2 id="section-comments">내가 작성한 댓글 내역</h2>
                {myComments.length === 0 ? (
                    <p className="empty-list-text">작성한 댓글이 없습니다.</p>
                ) : (
                    <>
                        <ul className="activity-list">
                            {getVisibleItems(myComments, showAllComments).map((comment) => (
                                <li key={comment.id} className="activity-item-card">
                                    <Link to={`/board/${comment.postId}`} className="activity-link">
                                        <div className="comment-bubble">
                                            <span className="comment-text">“{comment.content}”</span>
                                            <span className="comment-target">글제목: {comment.targetTitle}</span>
                                        </div>
                                        <span className="activity-date">{new Date(comment.createdAt).toLocaleDateString()}</span>
                                    </Link>
                                </li>
                            ))}
                        </ul>
                        {myComments.length > 5 && (
                            <button
                                onClick={() => setShowAllComments(!showAllComments)}
                                className="btn-toggle-more"
                                aria-expanded={showAllComments}
                            >
                                {showAllComments ? '접기' : `더보기 (${myComments.length - 5}개 더 있음)`}
                            </button>
                        )}
                    </>
                )}
            </section>

            {/* 로그아웃 버튼 (하단 보강) */}
            <div className="mypage-logout-area">
                <button onClick={logout} className="btn-logout-mypage">로그아웃</button>
            </div>
        </div>
    );
}

export default MyPageScreen;
