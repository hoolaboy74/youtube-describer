import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Routes, Route, useNavigate, useParams, useLocation, Link } from 'react-router-dom';
import axios from 'axios';
import YouTube from 'react-youtube';
import './App.css';

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
    const politeTimeoutRef = useRef(null);
    const assertiveTimeoutRef = useRef(null);

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

    return (
        <div className="App">
            <div className="visually-hidden" aria-live="polite" aria-atomic="true">{politeAnnouncement}</div>
            <div className="visually-hidden" aria-live="assertive" aria-atomic="true">{assertiveAnnouncement}</div>

            <header className="App-header">
                <Link to="/" style={{ textDecoration: 'none', color: 'inherit' }}>
                    <h1>유튜브 화면 해설 생성기</h1>
                </Link>
                <p>유튜브 영상 링크를 입력하거나, 제목으로 검색하여 화면 해설을 생성하세요.</p>
            </header>
            <main>
                <Routes>
                    <Route path="/" element={<HomeScreen announcePolite={announcePolite} announceAssertive={announceAssertive} />} />
                    <Route path="/video/:videoId" element={<PlayerScreen announcePolite={announcePolite} announceAssertive={announceAssertive} />} />
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

    const handleSearch = (query) => {
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

    const showSearchResults = searchResults.db.length > 0 || searchResults.youtube.length > 0;

    const renderList = () => {
        if (showSearchResults) {
            return (
                <>
                    {searchResults.db.length > 0 && (
                        <div className="search-results-section">
                            <h3>DB 검색 결과</h3>
                            <ul>
                                {searchResults.db.map(video => (
                                    <li key={video.id}>
                                        <button onClick={() => handleVideoSelect(video)}>
                                            <img src={video.thumbnail} alt="" className="thumbnail"/> {video.title}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {searchResults.youtube.length > 0 && (
                        <div className="search-results-section">
                            <h3>YouTube 검색 결과</h3>
                            <ul>
                                {searchResults.youtube.map(video => (
                                    <li key={video.id}>
                                        <button 
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
                            </ul>
                        </div>
                    )}
                </>
            );
        }

        return (
            <ul>
                {initialVideos.map(video => (
                    <li key={video.videoId}>
                        <button onClick={() => handleVideoSelect({ id: video.videoId, source: 'db' })}>
                            {video.title}
                        </button>
                    </li>
                ))}
            </ul>
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
                    placeholder="유튜브 URL을 입력하거나, 제목으로 검색하세요"
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

function PlayerScreen({ announcePolite, announceAssertive }) {
    const { videoId } = useParams();
    const navigate = useNavigate();
    const [videoInfo, setVideoInfo] = useState({ videoId, title: '불러오는 중...' });
    const [script, setScript] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState('');
    const eventSourceRef = useRef(null);

    // New states for improved UX
    const [statusMessage, setStatusMessage] = useState('영상 정보를 확인 중입니다...');
    const [isPlayerReady, setIsPlayerReady] = useState(false);
    const [isNewGeneration, setIsNewGeneration] = useState(false);
    const [isInteractionDone, setIsInteractionDone] = useState(false); // Audio unlock state

    const [player, setPlayer] = useState(null);
    const [isTtsEnabled, setIsTtsEnabled] = useState(true);
    const [verbosity, setVerbosity] = useState(2);
    const [isPlaying, setIsPlaying] = useState(false);
    const audioCache = useRef(new Map());
    const isTtsPlayingRef = useRef(false);

    const audioPlayerRef = useRef(null);
    const onAudioEndedRef = useRef(null);

    useEffect(() => {
        const player = new Audio();

        audioPlayerRef.current = player;

        const onEnded = () => {
            if (onAudioEndedRef.current) {
                onAudioEndedRef.current();
            }
        };
        player.addEventListener('ended', onEnded);
        player.addEventListener('error', onEnded); // Also handle errors

        return () => {
            player.removeEventListener('ended', onEnded);
            player.removeEventListener('error', onEnded);
        };
    }, []);

    const ttsEnabledRef = useRef(isTtsEnabled);
    useEffect(() => { ttsEnabledRef.current = isTtsEnabled; }, [isTtsEnabled]);

    const lastSpokenIndexRef = useRef(-1);
    const hasAnnouncedAiStart = useRef(false); // Ref to track AI start announcement

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
                const scriptMap = new Map();
                prevScript.forEach(line => scriptMap.set(line.id, line));
                chunk.forEach(line => scriptMap.set(line.id, line));
                const newScript = Array.from(scriptMap.values());
                newScript.sort((a, b) => a.timestamp - b.timestamp);
                return newScript;
            });
        });

        es.addEventListener('end', () => {
            console.log("SSE stream ended.");
            announcePolite('대본 생성이 완료되었습니다.');
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

        // Reset states for new video
        setIsLoading(true);
        setIsNewGeneration(false);
        setIsPlayerReady(false);
        setIsInteractionDone(false); // Reset audio unlock state
        setScript([]);
        setError('');
        setStatusMessage('영상 정보를 확인 중입니다...');
        announcePolite('영상 데이터를 불러오는 중입니다.');
        hasAnnouncedAiStart.current = false; // Reset the flag for each new video

        axios.get(`/api/script/${videoId}`)
            .then(response => {
                const video = response.data;
                if (video) {
                    setVideoInfo({ videoId: video.videoId, title: video.title });

                    if (video.status === 'completed') {
                        setScript(video.script || []);
                        setIsPlayerReady(true);
                        if (video.script && video.script.length > 0) {
                            announcePolite('캐시된 영상 데이터를 불러왔습니다.');
                        } else {
                            announcePolite('영상 처리가 완료되었지만, 생성된 화면 해설이 없습니다.');
                        }
                    } else if (video.status === 'failed' || video.status === 'pending') {
                        announcePolite('이전에 실패했거나 미완료된 영상입니다. 다시 생성을 시작합니다.');
                        startNewGeneration();
                    } else if (video.status === 'processing') {
                        setError('해당 영상은 현재 다른 요청에 의해 처리 중입니다. 잠시 후 다시 시도해 주세요.');
                        announceAssertive('해당 영상은 현재 처리 중입니다.');
                    } else {
                        // Fallback for unknown status or older records without status
                        startNewGeneration();
                    }
                } else {
                    // This case should not be hit if server returns 404, but as a fallback...
                    startNewGeneration();
                }
            })
            .catch(err => {
                if (err.response && err.response.status === 404) {
                    // Video does not exist in DB at all, start new generation.
                    startNewGeneration();
                } else {
                    console.error('Failed to fetch script:', err);
                    const errorMsg = '스크립트를 불러오는 중 오류가 발생했습니다.';
                    setError(errorMsg);
                    announceAssertive(`오류: ${errorMsg}`);
                }
            })
            .finally(() => {
                setIsLoading(false);
            });

        return () => {
            if (eventSourceRef.current) {
                eventSourceRef.current.close();
                eventSourceRef.current = null;
            }
        };
    }, [videoId, navigate, announcePolite, announceAssertive, startNewGeneration]);

    const filteredScript = useMemo(() => {
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

        // Set the callback for when this specific audio ends
        onAudioEndedRef.current = () => {
            isTtsPlayingRef.current = false;
            if (player) {
                player.setVolume(100);
                if (player.getPlayerState() !== 1) {
                    player.playVideo();
                }
            }
        };

        const playAudioFromUrl = (url) => {
            audioPlayer.src = url;
            audioPlayer.playbackRate = 1.3; // Re-apply playback rate every time src changes
            audioPlayer.volume = 1; // Make sure it's audible
            audioPlayer.play().catch(e => {
                console.error("Audio play failed:", e);
                if (onAudioEndedRef.current) {
                    onAudioEndedRef.current(); // Manually trigger if play fails
                }
            });
        };

        if (audioCache.current.has(scriptLine.id)) {
            playAudioFromUrl(audioCache.current.get(scriptLine.id));
            return;
        }

        try {
            const response = await axios.post(
                `/api/tts`,
                { text: scriptLine.text },
                { responseType: 'blob' }
            );
            const audioUrl = URL.createObjectURL(response.data);
            audioCache.current.set(scriptLine.id, audioUrl);
            playAudioFromUrl(audioUrl);
        } catch (error) {
            console.error('Failed to fetch audio:', error);
            if (onAudioEndedRef.current) {
                onAudioEndedRef.current();
            }
        }
    }, [player]);

    // Main playback loop - Refactored to prevent stale closures
    useEffect(() => {
        if (!isPlaying || !player) return;

        const intervalId = setInterval(() => {
            if (isTtsPlayingRef.current || !ttsEnabledRef.current || !player || typeof player.getPlayerState !== 'function' || player.getPlayerState() !== 1) {
                return;
            }

            const currentTime = Math.floor(player.getCurrentTime());
            const nextLineIndex = filteredScript.findIndex((line, index) => 
                index > lastSpokenIndexRef.current && currentTime >= line.timestamp
            );

            if (nextLineIndex !== -1) {
                lastSpokenIndexRef.current = nextLineIndex;
                const scriptLine = filteredScript[nextLineIndex];
                playDescription(scriptLine);
            }
        }, 250);

        return () => clearInterval(intervalId);
    }, [isPlaying, player, filteredScript, playDescription]);
    
    // Effect to sync index on verbosity change or seek
    useEffect(() => {
        if (player && typeof player.getCurrentTime === 'function') {
            const currentTime = player.getCurrentTime();
            const lastIndex = filteredScript.findLastIndex(line => line.timestamp <= currentTime);
            lastSpokenIndexRef.current = lastIndex;
        }
    }, [verbosity, filteredScript, player]);

    const handleVerbosityChange = (level) => {
        setVerbosity(level);
        announcePolite(`상세 수준이 ${verbosityLabels[level]}로 변경되었습니다.`);
    };

    const handleInitialPlay = () => {
        setIsInteractionDone(true);
        if (player) {
            player.playVideo();
        }
        if (audioPlayerRef.current) {
            audioPlayerRef.current.src = SILENT_AUDIO;
            audioPlayerRef.current.volume = 0;
            audioPlayerRef.current.play().catch(e => {
                console.warn("Audio context could not be unlocked.", e);
            });
        }
    };

    const renderContent = () => {
        if (isLoading) {
            return <p>영상 데이터를 불러오는 중입니다...</p>;
        }
        if (error) {
            return <p className="error-message" role="alert">{error}</p>;
        }
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
                    {!isInteractionDone && (
                        <div className="play-overlay">
                            <button className="big-play-button" onClick={handleInitialPlay} aria-label="재생 및 음성 해설 시작">
                                ▶
                            </button>
                        </div>
                    )}
                    <YouTube
                        videoId={videoId}
                        opts={{ width: '100%', height: '100%' }}
                        onReady={(e) => setPlayer(e.target)}
                        onStateChange={(e) => setIsPlaying(e.data === window.YT.PlayerState.PLAYING)}
                    />
                </div>
            );
        }
        return <p>알 수 없는 상태입니다. 페이지를 새로고침 해주세요.</p>;
    };

    return (
        <>
            <div className="video-header">
                <button onClick={() => navigate('/')} className="back-button">← 목록으로</button>
                <h2>{videoInfo.title}</h2>
                <ShareButton announcePolite={announcePolite} />
            </div>

            {renderContent()}

            <div className="controls-container">
                <label className="tts-toggle">
                    <input 
                        type="checkbox" 
                        checked={isTtsEnabled} 
                        onChange={(e) => setIsTtsEnabled(e.target.checked)} 
                        aria-label="음성 해설 활성화"
                    />
                    <span aria-hidden="true">음성 해설 활성화</span>
                </label>
                <div className="verbosity-control">
                    <span>상세 수준:</span>
                    {[1, 2, 3].map(level => (
                        <button key={level} onClick={() => handleVerbosityChange(level)} aria-pressed={verbosity === level}>
                            {verbosityLabels[level]}
                        </button>
                    ))}
                </div>
            </div>

            <div className="script-container">
                <h3>{`화면 해설 대본 (${verbosityLabels[verbosity]}: ${filteredScript.length}개)`}</h3>
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
        </>
    );
}

export default App;
