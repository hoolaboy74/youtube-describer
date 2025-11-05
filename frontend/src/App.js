import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Routes, Route, useNavigate, useParams, useLocation, Link } from 'react-router-dom';
import axios from 'axios';
import YouTube from 'react-youtube';
import './App.css';
import Comments from './Comments'; // Import the Comments component

// Helper to check if a string is a valid YouTube URL
function getYouTubeId(url) {
    try {
        const urlObj = new URL(url);
        if (urlObj.hostname === 'youtu.be') return urlObj.pathname.substring(1);
        if (urlObj.hostname.includes('youtube.com')) return urlObj.searchParams.get('v');
    } catch (e) { /* Ignore parsing errors */ }
    return null;
}

// --- Main App Component ---
function App() {
    const [politeAnnouncement, setPoliteAnnouncement] = useState('');
    const [assertiveAnnouncement, setAssertiveAnnouncement] = useState('');
    const [isGuideVisible, setIsGuideVisible] = useState(false);
    const [isCopied, setIsCopied] = useState(false);
    const politeTimeoutRef = useRef(null);
    const assertiveTimeoutRef = useRef(null);
    const mainRef = useRef(null);
    const guideButtonRef = useRef(null);
    const closeGuideButtonRef = useRef(null);

    const announcePolite = useCallback((message) => {
        clearTimeout(politeTimeoutRef.current);
        setPoliteAnnouncement(message);
        politeTimeoutRef.current = setTimeout(() => setPoliteAnnouncement(''), 2000);
    }, []);

    const announceAssertive = useCallback((message) => {
        clearTimeout(assertiveTimeoutRef.current);
        setAssertiveAnnouncement(message);
        assertiveTimeoutRef.current = setTimeout(() => setAssertiveAnnouncement(''), 5000);
    }, []);

    useEffect(() => {
        if (isGuideVisible) {
            closeGuideButtonRef.current?.focus();
        } else {
            guideButtonRef.current?.focus();
        }
    }, [isGuideVisible]);

    const openGuide = () => setIsGuideVisible(true);
    const closeGuide = () => setIsGuideVisible(false);

    const handleCopyAccount = () => {
        const textToCopy = '우리은행 1005-980-321301';
        navigator.clipboard.writeText(textToCopy).then(() => {
            setIsCopied(true);
            announcePolite('계좌번호가 복사되었습니다.');
            setTimeout(() => setIsCopied(false), 2000);
        }).catch(err => {
            console.error('Failed to copy account number: ', err);
            announceAssertive('계좌번호 복사에 실패했습니다.');
        });
    };

    return (
        <div className="App">
            <div className="visually-hidden" aria-live="polite" aria-atomic="true">{politeAnnouncement}</div>
            <div className="visually-hidden" aria-live="assertive" aria-atomic="true">{assertiveAnnouncement}</div>

            <header className="App-header">
                <div className="header-top">
                    <Link to="/" style={{ textDecoration: 'none', color: 'inherit' }}>
                        <h1>유튜브 화면 해설 생성기</h1>
                    </Link>
                    <button onClick={openGuide} className="guide-button" ref={guideButtonRef} role="link">
                        서비스 이용 안내
                    </button>
                </div>
                <p>이 서비스는 유튜브 영상을 시각 장애인을 위한 화면 해설 영상으로 만드는 서비스 입니다.</p>
            </header>

            {isGuideVisible && (
                <div className="modal-overlay" onClick={closeGuide}>
                    <div className="modal-content" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="guide-title">
                        <h3 id="guide-title">서비스 이용 방법</h3>
                        <div style={{textAlign: 'left', marginBottom: '20px'}}>
                            <h4>1. 영상 찾기 및 생성</h4>
                            <p>홈 화면 입력창에 유튜브 주소(URL)나 검색어를 입력 후 '검색 또는 생성' 버튼을 누르세요. 검색 결과에서 원하는 영상을 선택하면 재생 화면으로 이동합니다.</p>
                            
                            <h4>2. 해설과 함께 재생</h4>
                            <p><strong>새로운 영상:</strong> 해설 생성이 자동으로 시작되며, 영상 길이에 따라 몇 분 정도 소요될 수 있습니다. 생성이 완료되면 바로 시청할 수 있습니다.</p>
                            <p><strong>기존 영상:</strong> 이미 해설이 만들어진 영상은 바로 재생됩니다.</p>

                            <h4 style={{marginTop: '20px'}}><strong>** 주의 사항 **</strong></h4>
                            <ul>
                                <li>화면 해설은 AI에 의해 자동 생성 되므로 해설의 품질이 전문 작가가 만드는 해설과는 차이가 있습니다.</li>
                                <li>영상의 내용에 폭력, 선정성, 비윤리적인 내용이 있다면 AI가 화면 해설 생성을 거부 하고 오류를 낼 수 있습니다.</li>
                                <li>이런 상황이 반복 되면 서비스 전체가 중지 될 수있고 복구에는 많은 시간이 필요 합니다.</li>
                            </ul>
                            
                            <hr style={{margin: '20px 0'}} />

                            <div className="sponsorship-info">
                                <p>이 서비스는 <strong>시각장애인 맘 센터</strong>의 후원으로 운영됩니다. 서비스의 안정적인 운영과 개선을 위해 여러분의 소중한 후원을 부탁드립니다.</p>
                                <p><strong>후원 계좌:</strong> 시각장애인MOM센터 우리은행 1005-980-321301</p>
                                <button onClick={handleCopyAccount} className="copy-button">
                                    {isCopied ? '복사됨!' : '계좌번호 복사'}
                                </button>
                            </div>
                        </div>
                        <button onClick={closeGuide} ref={closeGuideButtonRef}>닫기</button>
                    </div>
                </div>
            )}

            <main ref={mainRef} tabIndex="-1">
                <Routes>
                    <Route path="/" element={<HomeScreen announcePolite={announcePolite} announceAssertive={announceAssertive} />} />
                    <Route path="/video/:videoId" element={<PlayerScreen mainRef={mainRef} announcePolite={announcePolite} announceAssertive={announceAssertive} />} />
                </Routes>
            </main>
        </div>
    );
}


// --- HomeScreen Component ---
function HomeScreen({ announcePolite, announceAssertive }) {
    const [inputValue, setInputValue] = useState('');
    const [isSearching, setIsSearching] = useState(false);
    const [error, setError] = useState('');
    const [searchResults, setSearchResults] = useState({ db: [], youtube: [] });
    const [initialVideos, setInitialVideos] = useState([]);
    
    const [initialVideosLimit, setInitialVideosLimit] = useState(10);
    const [dbResultsLimit, setDbResultsLimit] = useState(10);
    const [youtubeResultsLimit, setYoutubeResultsLimit] = useState(20);
    const [focusedItemId, setFocusedItemId] = useState(null);
    
    const itemRefs = useRef(new Map());
    const navigate = useNavigate();

    useEffect(() => {
        axios.get(`/api/cached-videos`)
            .then(response => setInitialVideos(response.data || []))
            .catch(err => {
                const errorMsg = '이전 작업 목록을 불러오는 데 실패했습니다. 백엔드 서버가 실행 중인지 확인하세요.';
                console.error('캐시 목록을 불러오는 데 실패했습니다:', err);
                setError(errorMsg);
                announceAssertive(`오류: ${errorMsg}`);
            });
    }, [announceAssertive]);

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
        if (!inputValue) return;

        const videoId = getYouTubeId(inputValue);
        if (videoId) {
            announcePolite('새 영상 처리를 시작합니다.');
            navigate(`/video/${videoId}`);
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

    const renderList = () => {
        if (showSearchResults) {
            return (
                <>
                    {searchResults.db.length > 0 && (
                        <div className="search-results-section">
                            <h3>DB 검색 결과</h3>
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
                                            onClick={() => handleVideoSelect(video)}
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

    return (
        <>
            {error && <p className="error-message" role="alert">{error}</p>}
            <form onSubmit={handleSubmit} className="url-form">
                <input
                    type="text"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    placeholder="이곳에 유튜브 URL을 입력하거나, 제목으로 검색하세요"
                />
                <button type="submit" disabled={!inputValue}>{'검색 또는 생성'}</button>
            </form>

            <div className="cached-list-container">
                <h2>{showSearchResults ? '검색 결과' : '이전 작업 목록'}</h2>
                {isSearching ? <p>검색 중...</p> : renderList()}
            </div>
        </>
    );
}


// --- PlayerScreen Component ---
const verbosityLabels = { 1: '최소', 2: '기본', 3: '최대' };
function formatTime(seconds) {
    return new Date(seconds * 1000).toISOString().substr(11, 8);
}

const SILENT_AUDIO = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';

// --- ShareButton Component ---
function ShareButton({ announcePolite }) {
    const [isCopied, setIsCopied] = useState(false);
    const location = useLocation();

    const handleShare = () => {
        const shareUrl = window.location.origin + location.pathname;

        // Modern, secure context-only API
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(shareUrl).then(() => {
                setIsCopied(true);
                announcePolite('링크가 클립보드에 복사되었습니다.');
                setTimeout(() => setIsCopied(false), 2000);
            }).catch(err => {
                console.error('Failed to copy URL with navigator.clipboard: ', err);
                alert('URL 복사에 실패했습니다. 사이트가 HTTPS로 제공되는지 확인하세요.');
            });
        } else {
            // Fallback for HTTP or older browsers
            const textArea = document.createElement("textarea");
            textArea.value = shareUrl;
            
            // Make the textarea non-editable and hidden
            textArea.style.position = "fixed";
            textArea.style.top = "-9999px";
            textArea.style.left = "-9999px";
            
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            
            try {
                const successful = document.execCommand('copy');
                if (successful) {
                    setIsCopied(true);
                    announcePolite('링크가 클립보드에 복사되었습니다.');
                    setTimeout(() => setIsCopied(false), 2000);
                } else {
                    throw new Error('document.execCommand failed');
                }
            } catch (err) {
                console.error('Fallback: Failed to copy URL: ', err);
                alert('URL 복사에 실패했습니다. 수동으로 복사해주세요.');
            } finally {
                document.body.removeChild(textArea);
            }
        }
    };

    return (
        <button onClick={handleShare} className="share-button">
            {isCopied ? '복사됨!' : '공유'}
        </button>
    );
}

function PlayerScreen({ mainRef, announcePolite, announceAssertive }) {
    const { videoId } = useParams();
    const navigate = useNavigate();
    const [videoInfo, setVideoInfo] = useState({ videoId, title: '불러오는 중...' });
    const [script, setScript] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState('');
    const eventSourceRef = useRef(null);

    const [statusMessage, setStatusMessage] = useState('영상 정보를 확인 중입니다...');
    const [isPlayerReady, setIsPlayerReady] = useState(false);
    const [isNewGeneration, setIsNewGeneration] = useState(false);
    const [isGenerationComplete, setIsGenerationComplete] = useState(false);
    const [isInteractionDone, setIsInteractionDone] = useState(false);

    const [player, setPlayer] = useState(null);
    const [verbosity, setVerbosity] = useState(2); // Default to '기본'
    const [isPlaying, setIsPlaying] = useState(false);
    const audioCache = useRef(new Map());
    const isTtsPlayingRef = useRef(false);

    const audioPlayerRef = useRef(null);
    const onAudioEndedRef = useRef(null);

    // UI State
    const [isScriptVisible, setIsScriptVisible] = useState(false);

    // Combined description enabled/disabled logic
    const isDescriptionEnabled = verbosity > 0;
    const isDescriptionEnabledRef = useRef(isDescriptionEnabled);
    useEffect(() => { isDescriptionEnabledRef.current = isDescriptionEnabled; }, [isDescriptionEnabled]);

    useEffect(() => {
        const player = new Audio();
        audioPlayerRef.current = player;
        const onEnded = () => {
            if (onAudioEndedRef.current) onAudioEndedRef.current();
        };
        player.addEventListener('ended', onEnded);
        player.addEventListener('error', onEnded);
        return () => {
            player.removeEventListener('ended', onEnded);
            player.removeEventListener('error', onEnded);
        };
    }, []);

    const lastSpokenIndexRef = useRef(-1);
    const hasAnnouncedAiStart = useRef(false);

    const startNewGeneration = useCallback(() => {
        console.log('Starting new generation process...');
        setIsNewGeneration(true);
        setStatusMessage('새로운 화면 해설 대본 생성을 시작합니다...');
        announcePolite('기존 대본이 없거나 불완전하여, 새로 생성을 시작합니다.');
        
        const sseApiHost = process.env.NODE_ENV === 'production' ? '' : 'http://localhost:4000';
        const url = `${sseApiHost}/api/process?youtubeUrl=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
        const es = new EventSource(url);
        eventSourceRef.current = es;
        let isDuplicate = false;
        let isFirstChunk = true;

        es.onopen = () => console.log("SSE connection opened for streaming.");

        es.addEventListener('start', (event) => {
            const data = JSON.parse(event.data);
            setVideoInfo({ videoId: data.videoId, title: data.title });
        });

        es.addEventListener('status_update', (event) => {
            const data = JSON.parse(event.data);
            setStatusMessage(data.message);
            
            const isAiMessage = data.message.includes('AI로 대본 생성 중');
            if (isAiMessage) {
                if (!hasAnnouncedAiStart.current) {
                    announcePolite(data.message);
                    hasAnnouncedAiStart.current = true;
                }
            } else {
                announcePolite(data.message);
            }
        });

        es.addEventListener('script_chunk', (event) => {
            if (isFirstChunk) {
                setIsPlayerReady(true);
                announcePolite('재생 준비가 완료되었습니다. 이제 영상을 재생할 수 있습니다.');
                isFirstChunk = false;
            }
            const chunk = JSON.parse(event.data);
            setScript(prevScript => {
                const scriptMap = new Map(prevScript.map(line => [line.id, line]));
                chunk.forEach(line => scriptMap.set(line.id, line));
                return Array.from(scriptMap.values()).sort((a, b) => a.timestamp - b.timestamp);
            });
        });

        es.addEventListener('end', () => {
            console.log("SSE stream ended.");
            announcePolite('대본 생성이 완료되었습니다.');
            setIsGenerationComplete(true);
            es.close();
        });

        es.addEventListener('duplicate_request', () => {
            console.log('Duplicate request detected.');
            isDuplicate = true;
            es.close();
        });

        es.onerror = (err) => {
            if (isDuplicate) return;
            console.error('EventSource failed:', err);
            const errorMsg = '대본 생성 중 오류가 발생했습니다.';
            setError(errorMsg);
            announceAssertive(`오류: ${errorMsg}`);
            es.close();
        };
    }, [videoId, announcePolite, announceAssertive]);

    useEffect(() => {
        if (!videoId) {
            navigate('/');
            return;
        }

        setIsLoading(true);
        setIsNewGeneration(false);
        setIsPlayerReady(false);
        setIsGenerationComplete(false);
        setIsInteractionDone(false);
        setScript([]);
        setError('');
        setStatusMessage('영상 정보를 확인 중입니다...');
        announcePolite('영상 데이터를 불러오는 중입니다.');
        hasAnnouncedAiStart.current = false;

        axios.get(`/api/script/${videoId}`)
            .then(response => {
                const video = response.data;
                if (video) {
                    setVideoInfo({ videoId: video.videoId, title: video.title });
                    if (video.status === 'completed') {
                        setScript(video.script || []);
                        setIsPlayerReady(true);
                        setIsGenerationComplete(true);
                        announcePolite(video.script && video.script.length > 0 ? '캐시된 영상 데이터를 불러왔습니다.' : '영상 처리가 완료되었지만, 생성된 화면 해설이 없습니다.');
                    } else if (['failed', 'pending'].includes(video.status)) {
                        announcePolite('이전에 실패했거나 미완료된 영상입니다. 다시 생성을 시작합니다.');
                        startNewGeneration();
                    } else if (video.status === 'processing') {
                        setError('해당 영상은 현재 다른 요청에 의해 처리 중입니다. 잠시 후 다시 시도해 주세요.');
                        announceAssertive('해당 영상은 현재 처리 중입니다.');
                    } else {
                        startNewGeneration();
                    }
                } else {
                    startNewGeneration();
                }
            })
            .catch(err => {
                if (err.response && err.response.status === 404) {
                    startNewGeneration();
                } else {
                    console.error('Failed to fetch script:', err);
                    const errorMsg = '스크립트를 불러오는 중 오류가 발생했습니다.';
                    setError(errorMsg);
                    announceAssertive(`오류: ${errorMsg}`);
                }
            })
            .finally(() => setIsLoading(false));

        return () => {
            if (eventSourceRef.current) {
                eventSourceRef.current.close();
                eventSourceRef.current = null;
            }
        };
    }, [videoId, navigate, announcePolite, announceAssertive, startNewGeneration]);

    // Effect for periodic announcements during generation for screen reader users
    useEffect(() => {
        // The interval should only run when we are actively generating a *new* script,
        // it's not yet complete, there are no errors, and the player isn't ready to start.
        if (isNewGeneration && !isGenerationComplete && !error && !isPlayerReady) {
            const waitingMessages = [
                'AI가 열심히 대본을 작성하고 있습니다. 잠시만 기다려주세요.',
                '최고의 해설을 위해 영상의 모든 장면을 분석 중입니다.',
                '이야기의 흐름을 파악하고 있습니다. 거의 다 되어갑니다.',
            ];
            let messageIndex = 0;

            // Announce immediately once, then set interval
            announcePolite(waitingMessages[messageIndex]);
            messageIndex = (messageIndex + 1) % waitingMessages.length;

            const intervalId = setInterval(() => {
                announcePolite(waitingMessages[messageIndex]);
                messageIndex = (messageIndex + 1) % waitingMessages.length;
            }, 15000); // Announce every 15 seconds

            return () => clearInterval(intervalId); // Cleanup on completion or error
        }
    }, [isNewGeneration, isGenerationComplete, announcePolite, error, isPlayerReady]);

    const filteredScript = useMemo(() => {
        if (verbosity === 0) return []; // No script if description is off

        const linesByTimestamp = new Map();
        for (const line of script) {
            const lineVerbosity = parseInt(line.verbosity.replace('v', ''));
            if (lineVerbosity <= verbosity) {
                const existingLine = linesByTimestamp.get(line.timestamp);
                if (!existingLine || lineVerbosity > parseInt(existingLine.verbosity.replace('v', ''))) {
                    linesByTimestamp.set(line.timestamp, line);
                }
            }
        }
        return Array.from(linesByTimestamp.values()).sort((a, b) => a.timestamp - b.timestamp);
    }, [script, verbosity]);

    const playDescription = useCallback(async (scriptLine) => {
        if (!player || !scriptLine || !audioPlayerRef.current) return;

        isTtsPlayingRef.current = true;
        player.setVolume(30);
        player.pauseVideo();

        const audioPlayer = audioPlayerRef.current;

        onAudioEndedRef.current = () => {
            isTtsPlayingRef.current = false;
            if (player) {
                player.setVolume(100);
                if (player.getPlayerState() !== 1) player.playVideo();
            }
        };

        const playAudioFromUrl = (url) => {
            audioPlayer.src = url;
            audioPlayer.playbackRate = 1.3;
            audioPlayer.volume = 1;
            audioPlayer.play().catch(e => {
                console.error("Audio play failed:", e);
                if (onAudioEndedRef.current) onAudioEndedRef.current();
            });
        };

        if (audioCache.current.has(scriptLine.id)) {
            playAudioFromUrl(audioCache.current.get(scriptLine.id));
            return;
        }

        try {
            const response = await axios.post(`/api/tts`, { text: scriptLine.text }, { responseType: 'blob' });
            const audioUrl = URL.createObjectURL(response.data);
            audioCache.current.set(scriptLine.id, audioUrl);
            playAudioFromUrl(audioUrl);
        } catch (error) {
            console.error('Failed to fetch audio:', error);
            if (onAudioEndedRef.current) onAudioEndedRef.current();
        }
    }, [player]);

    useEffect(() => {
        if (!isPlaying || !player) return;

        const intervalId = setInterval(() => {
            if (isTtsPlayingRef.current || !isDescriptionEnabledRef.current || !player || typeof player.getPlayerState !== 'function' || player.getPlayerState() !== 1) {
                return;
            }
            const currentTime = Math.floor(player.getCurrentTime());
            const nextLineIndex = filteredScript.findIndex((line, index) => 
                index > lastSpokenIndexRef.current && currentTime >= line.timestamp
            );
            if (nextLineIndex !== -1) {
                lastSpokenIndexRef.current = nextLineIndex;
                playDescription(filteredScript[nextLineIndex]);
            }
        }, 250);

        return () => clearInterval(intervalId);
    }, [isPlaying, player, filteredScript, playDescription]);
    
    useEffect(() => {
        if (player && typeof player.getCurrentTime === 'function') {
            const currentTime = player.getCurrentTime();
            lastSpokenIndexRef.current = filteredScript.findLastIndex(line => line.timestamp <= currentTime);
        }
    }, [verbosity, filteredScript, player]);

    const handleVerbosityChange = (level) => {
        setVerbosity(level);
        const label = { 0: '해설 없음', ...verbosityLabels }[level];
        announcePolite(`상세 수준이 ${label}으로 변경되었습니다.`);
    };

    const handleTogglePlay = () => {
        if (!player) return;

        if (!isInteractionDone) {
            setIsInteractionDone(true);
            if (audioPlayerRef.current) {
                audioPlayerRef.current.src = SILENT_AUDIO;
                audioPlayerRef.current.volume = 0;
                audioPlayerRef.current.play().catch(e => console.warn("Audio context could not be unlocked.", e));
            }
        }

        const playerState = player.getPlayerState();
        if (playerState === 1) { // playing
            player.pauseVideo();
        } else { // paused, ended, etc.
            player.playVideo();
        }
    };

    const renderContent = () => {
        if (isLoading) return <p>영상 데이터를 불러오는 중입니다...</p>;
        if (error) return <p className="error-message" role="alert">{error}</p>;
        if (isNewGeneration && !isPlayerReady) {
            return (
                <div className="status-container">
                    <p>새로운 화면 해설을 생성하고 있습니다. 잠시만 기다려주세요...</p>
                    <p className="status-message">{statusMessage}</p>
                    <div className="spinner"></div>
                </div>
            );
        }
        if (isPlayerReady) {
            return (
                <div className="video-container">
                    <div className={`play-overlay ${isPlaying ? 'is-playing' : ''}`}>
                        <button className="big-play-button" onClick={handleTogglePlay} aria-label={isPlaying ? "일시정지" : "재생"}>
                            {isPlaying ? '❚❚' : '▶'}
                        </button>
                    </div>
                    <YouTube
                        videoId={videoId}
                        opts={{
                            width: '100%',
                            height: '100%',
                            playerVars: {
                                controls: 0, // Hide YouTube's native controls
                                rel: 0, // Do not show related videos
                                iv_load_policy: 3 // Do not show annotations
                            }
                        }}
                        onReady={(e) => setPlayer(e.target)}
                        onStateChange={(e) => setIsPlaying(e.data === window.YT.PlayerState.PLAYING)}
                    />
                </div>
            );
        }
        return <p>알 수 없는 상태입니다. 페이지를 새로고침 해주세요.</p>;
    };

    const newVerbosityLabels = { 0: '없음', ...verbosityLabels };

    return (
        <>
            <div className="video-header">
                <button onClick={() => navigate('/')} className="back-button">← 목록으로</button>
                <h2>{videoInfo.title}</h2>
                <ShareButton announcePolite={announcePolite} />
            </div>

            {renderContent()}

            <div className="controls-container">
                <div className="verbosity-control">
                    <span>상세 수준:</span>
                    {[0, 1, 2, 3].map(level => (
                        <button key={level} onClick={() => handleVerbosityChange(level)} aria-pressed={verbosity === level}>
                            {newVerbosityLabels[level]}
                        </button>
                    ))}
                </div>
                <button onClick={() => setIsScriptVisible(prev => !prev)} aria-expanded={isScriptVisible}>
                    {isScriptVisible ? '대본 숨기기' : '대본 보기'}
                </button>
            </div>

            {isScriptVisible && (
                <div className="script-container">
                    <h3>{`화면 해설 대본 (${newVerbosityLabels[verbosity]}: ${filteredScript.length}개)`}</h3>
                    <ul>
                        {filteredScript.map((line) => (
                            <li key={line.id}>
                                <strong>[{formatTime(line.timestamp)}]</strong>
                                <span className={`verbosity-tag verbosity-${line.verbosity.replace('v', '')}`}>{line.verbosity}</span>
                                {line.text}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            <Comments videoId={videoId} mainRef={mainRef} />
        </>
    );
}

export default App;
