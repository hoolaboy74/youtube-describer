import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import './HomeScreen.css';

import { useAccessibility } from '../contexts/AccessibilityContext';

// Helper to check if a string is a valid YouTube URL
function getYouTubeId(url) {
    if (!isValidYoutubeUrl(url)) {
        return null;
    }
    try {
        const urlObj = new URL(url);
        if (urlObj.hostname === 'youtu.be') return urlObj.pathname.substring(1);
        if (urlObj.hostname.includes('youtube.com')) return urlObj.searchParams.get('v');
    } catch (e) { /* Ignore parsing errors */ }
    return null;
}

function isValidYoutubeUrl(url) {
    const YOUTUBE_URL_REGEX = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/(watch\?v=|embed\/|v\/|)([\w-]+)$/;
    return YOUTUBE_URL_REGEX.test(url);
}

// --- HomeScreen Component ---
function HomeScreen() {
    const { announcePolite, announceAssertive } = useAccessibility();
    const [inputValue, setInputValue] = useState('');
    const [isSearching, setIsSearching] = useState(false);
    const [error, setError] = useState('');
    const [searchResults, setSearchResults] = useState({ db: [], youtube: [] });
    const [initialVideos, setInitialVideos] = useState([]);
    const [financialSummary, setFinancialSummary] = useState(null);
    const [notice, setNotice] = useState({ id: '', title: '', content: '' });
    const [isNoticeVisible, setIsNoticeVisible] = useState(false);
    const [dontShowNoticeToday, setDontShowNoticeToday] = useState(false);
    
    const [initialVideosLimit, setInitialVideosLimit] = useState(10);
    const [dbResultsLimit, setDbResultsLimit] = useState(10);
    const [youtubeResultsLimit, setYoutubeResultsLimit] = useState(20);
    const [focusedItemId, setFocusedItemId] = useState(null);
    
    const itemRefs = useRef(new Map());
    const navigate = useNavigate();
    const noticeCloseButtonRef = useRef(null);
    const noticeTitleRef = useRef(null);
    const lastFocusedNoticeElementRef = useRef(null);

    // Simple hash function for notice content
    const simpleHash = (str) => {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = (hash << 5) - hash + char;
            hash |= 0; // Convert to 32bit integer
        }
        return String(hash);
    };

    useEffect(() => {
        // Fetch initial video list
        axios.get(`/api/cached-videos`)
            .then(response => setInitialVideos(response.data || []))
            .catch(err => {
                const errorMsg = '이전 작업 목록을 불러오는 데 실패했습니다. 백엔드 서버가 실행 중인지 확인하세요.';
                console.error('캐시 목록을 불러오는 데 실패했습니다:', err);
                setError(errorMsg);
                announceAssertive(`오류: ${errorMsg}`);
            });

        // Fetch financial summary and notice
        axios.get('/api/financial-summary')
            .then(response => {
                setFinancialSummary(response.data);
                const { noticeTitle, noticeContent } = response.data;

                if (!noticeTitle || !noticeContent) {
                    return; // No notice, do nothing
                }

                const currentNoticeId = simpleHash(noticeContent);
                const dismissedNoticeRaw = localStorage.getItem('dismissed_notice');
                const dismissedNotice = dismissedNoticeRaw ? JSON.parse(dismissedNoticeRaw) : null;
                
                const now = new Date().getTime();
                const oneDay = 24 * 60 * 60 * 1000;

                let shouldShow = true;
                if (dismissedNotice) {
                    // If the notice is the same one that was dismissed, check the timestamp
                    if (dismissedNotice.id === currentNoticeId && (now - dismissedNotice.timestamp < oneDay)) {
                        shouldShow = false;
                    }
                }

                if (shouldShow) {
                    setNotice({ id: currentNoticeId, title: noticeTitle, content: noticeContent });
                    setIsNoticeVisible(true);
                }
            })
            .catch(err => console.error('Failed to fetch financial summary:', err));
    }, [announceAssertive]);

    useEffect(() => {
        if (isNoticeVisible) {
            lastFocusedNoticeElementRef.current = document.activeElement;
            noticeTitleRef.current?.focus();
        }
    }, [isNoticeVisible]);

    useEffect(() => {
        if (focusedItemId) {
            const element = itemRefs.current.get(focusedItemId);
            if (element) {
                // Defer focus call to avoid race conditions with browser's focus handling
                setTimeout(() => {
                    element.focus();
                }, 0);
            }
            setFocusedItemId(null);
        }
    }, [focusedItemId]);

    const handleSearch = (query) => {
        setDbResultsLimit(10); // Reset limit on new search
        setYoutubeResultsLimit(20); // Reset limit on new search
        setIsSearching(true);
        announcePolite('검색 중입니다.');
        axios.get(`/api/search?query=${query}`)
            .then(response => {
                const { dbResults = [], youtubeResults = [] } = response.data;
                setSearchResults({ db: dbResults, youtube: youtubeResults });
                const total = dbResults.length + youtubeResults.length;
                if (total > 0) {
                    announcePolite(`검색 완료. 총 ${total}개의 결과를 찾았습니다.`);
                } else {
                    announcePolite('검색 결과가 없습니다.');
                }
            })
            .catch(err => {
                console.error('Search failed:', err);
                const errorMsg = '검색 중 오류가 발생했습니다.';
                setError(errorMsg);
                announceAssertive(`오류: ${errorMsg}`);
            })
            .finally(() => {
                setIsSearching(false);
            });
    };

    const handleSubmit = (e) => {
        e.preventDefault();
        setError(''); // Clear previous errors
        if (!inputValue) return;

        const isUrlLike = inputValue.startsWith('http://') || inputValue.startsWith('https://');
        const videoId = getYouTubeId(inputValue);

        if (isUrlLike) {
            if (financialSummary?.processingPaused === 'true') {
                const pauseError = "현재 관리자에 의해 신규 영상 생성이 일시 중지되었습니다. 기존 영상 검색은 가능합니다.";
                setError(pauseError);
                announceAssertive(pauseError);
                return;
            }
            if (videoId) {
                announcePolite('새 영상 처리를 시작합니다.');
                navigate(`/video/${videoId}`);
            } else {
                setError('유효하지 않은 YouTube URL입니다. 올바른 주소를 입력해주세요.');
                announceAssertive('오류: 유효하지 않은 YouTube URL');
            }
        } else {
            handleSearch(inputValue);
        }
    };

    const handleVideoSelect = (video) => {
        navigate(`/video/${video.id}`);
    };

    const handleLoadMore = (type, e) => {
        if (e) e.preventDefault();
        let lastItem;

        if (type === 'initial') {
            const lastItemIndex = initialVideosLimit - 1;
            if (lastItemIndex >= 0 && initialVideos.length > lastItemIndex) {
                lastItem = initialVideos[lastItemIndex];
                setFocusedItemId(lastItem.videoId);
            }
            setInitialVideosLimit(prev => prev + 10);

        } else if (type === 'db') {
            const lastItemIndex = dbResultsLimit - 1;
            if (lastItemIndex >= 0 && searchResults.db.length > lastItemIndex) {
                lastItem = searchResults.db[lastItemIndex];
                setFocusedItemId(lastItem.id);
            }
            setDbResultsLimit(prev => prev + 10);

        } else if (type === 'youtube') {
            const lastItemIndex = youtubeResultsLimit - 1;
            if (lastItemIndex >= 0 && searchResults.youtube.length > lastItemIndex) {
                lastItem = searchResults.youtube[lastItemIndex];
                setFocusedItemId(lastItem.id);
            }
            setYoutubeResultsLimit(prev => prev + 20);
        }
    };

    const showSearchResults = searchResults.db.length > 0 || searchResults.youtube.length > 0;
    
    const isUrl = inputValue.startsWith('http');
    const isCreationDisabled = isUrl && financialSummary?.processingPaused === 'true';
    const isSubmitDisabled = !inputValue || isCreationDisabled;

    const placeholderText = financialSummary?.processingPaused === 'true' 
        ? "신규 영상 생성 중지됨. 기존 영상 검색만 가능합니다." 
        : "이곳에 유튜브 URL을 입력하거나, 제목으로 검색하세요";

    const renderList = () => {
        if (showSearchResults) {
            return (
                <>
                    {searchResults.db.length > 0 && (
                        <div className="search-results-section">
                            <h3>화면 해설 영상 검색 결과</h3>
                            <ol>
                                {searchResults.db.slice(0, dbResultsLimit).map(video => (
                                    <li key={video.id}>
                                        <button 
                                            ref={el => itemRefs.current.set(video.id, el)}
                                            onClick={() => handleVideoSelect(video)}>
                                            <img src={video.thumbnail} alt="" className="thumbnail"/> {video.title} {video.commentCount > 0 && `(댓글: ${video.commentCount})`}
                                        </button>
                                    </li>
                                ))}
                            </ol>
                            {searchResults.db.length > dbResultsLimit && (
                                <button onClick={(e) => handleLoadMore('db', e)} className="load-more-button">
                                    더보기
                                </button>
                            )}
                        </div>
                    )}
                    {searchResults.youtube.length > 0 && (
                        <div className="search-results-section">
                            <h3>YouTube 검색 결과</h3>
                            <ol>
                                {searchResults.youtube.slice(0, youtubeResultsLimit).map(video => (
                                    <li key={video.id}>
                                        <button 
                                            ref={el => itemRefs.current.set(video.id, el)}
                                            onClick={() => {
                                                if (financialSummary?.processingPaused === 'true') {
                                                    const pauseError = "현재 관리자에 의해 신규 영상 생성이 일시 중지되었습니다.";
                                                    setError(pauseError);
                                                    announceAssertive(pauseError);
                                                } else {
                                                    handleVideoSelect(video);
                                                }
                                            }}
                                            aria-label={`${video.title}, 채널 ${video.channel}, 조회수 ${video.views}회, 길이 ${video.durationFormatted}`}>
                                            <img src={video.thumbnail} alt={`${video.title} 썸네일`} className="thumbnail"/> 
                                            <div className="video-info" aria-hidden="true">
                                                <div className="video-title">{video.title}</div>
                                                <div className="video-meta">
                                                    {video.channel} • 조회수 ${video.views}회 • ${video.durationFormatted}
                                                </div>
                                            </div>
                                        </button>
                                    </li>
                                ))}
                            </ol>
                            {searchResults.youtube.length > youtubeResultsLimit && (
                                <button onClick={(e) => handleLoadMore('youtube', e)} className="load-more-button">
                                    더보기
                                </button>
                            )}
                        </div>
                    )}
                </>
            );
        }

        return (
            <>
                <ol>
                    {initialVideos.slice(0, initialVideosLimit).map(video => (
                        <li key={video.videoId}>
                            <button 
                                ref={el => itemRefs.current.set(video.videoId, el)}
                                onClick={() => handleVideoSelect({ id: video.videoId, source: 'db' })}>
                                {video.title} {video.commentCount > 0 && `(댓글: ${video.commentCount})`}
                            </button>
                        </li>
                    ))}
                </ol>
                {initialVideos.length > initialVideosLimit && (
                    <button onClick={(e) => handleLoadMore('initial', e)} className="load-more-button">
                        더보기
                    </button>
                )}
            </>
        );
    };

    const renderFinancialSummary = () => {
        if (!financialSummary) return null;

        const { totalDonations, totalApiCosts, totalProxyCost, exchangeRate } = financialSummary;
        const rate = parseFloat(exchangeRate) || 1400;
        const totalUsedCost = (totalApiCosts || 0) + (totalProxyCost || 0);
        const totalUsedCostKRW = totalUsedCost * rate;
        const balanceKRW = totalDonations - totalUsedCostKRW;

        const formatCurrency = (num) => Math.floor(num).toLocaleString('ko-KR');

        return (
            <div className="financial-summary-container" aria-labelledby="financial-summary-heading">
                <h2 id="financial-summary-heading" className="visually-hidden">실시간 운영 현황</h2>
                <div className="financial-text">
                    남은 운영비: <strong>{formatCurrency(balanceKRW)}원</strong>
                </div>
                <progress
                    max={totalDonations}
                    value={totalUsedCostKRW}
                    aria-label={`총 후원금 ${formatCurrency(totalDonations)}원 중 ${formatCurrency(totalUsedCostKRW)}원 사용됨`}
                />
            </div>
        );
    };

    const handleCloseNotice = () => {
        if (dontShowNoticeToday) {
            const now = new Date().getTime();
            localStorage.setItem('dismissed_notice', JSON.stringify({ id: notice.id, timestamp: now }));
        }
        setIsNoticeVisible(false);
        lastFocusedNoticeElementRef.current?.focus();
    };

    return (
        <div className="home-screen">
            {isNoticeVisible && (
                <div className="modal-overlay" onClick={handleCloseNotice}>
                    <div className="modal-content" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="notice-title">
                        <h3 id="notice-title" ref={noticeTitleRef} tabIndex="-1">{notice.title}</h3>
                        <div style={{ textAlign: 'left', whiteSpace: 'pre-wrap', marginBottom: '20px' }}>
                            <p>{notice.content}</p>
                        </div>
                        <div className="modal-footer">
                            <div className="checkbox-wrapper">
                                <input 
                                    type="checkbox" 
                                    aria-label="하루 동안 보지 않기"
                                    checked={dontShowNoticeToday} 
                                    onChange={(e) => setDontShowNoticeToday(e.target.checked)}
                                />
                                <span 
                                    className="checkbox-text"
                                    onClick={() => setDontShowNoticeToday(prev => !prev)}
                                    aria-hidden="true"
                                >
                                    하루 동안 보지 않기
                                </span>
                            </div>
                            <button onClick={handleCloseNotice} ref={noticeCloseButtonRef}>닫기</button>
                        </div>
                    </div>
                </div>
            )}

            {error && <p className="error-message" role="alert">{error}</p>}

            {renderFinancialSummary()}

            <form onSubmit={handleSubmit} className="url-form">
                <input
                    type="text"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    placeholder={placeholderText}
                />
                <button type="submit" disabled={isSubmitDisabled}>{'검색 또는 생성'}</button>
            </form>

            <div className="cached-list-container">
                <h2>{showSearchResults ? '검색 결과' : '사용자들의 최근 생성 영상'}</h2>
                {isSearching ? <p>검색 중...</p> : renderList()}
            </div>
        </div>
    );
}

export default HomeScreen;
