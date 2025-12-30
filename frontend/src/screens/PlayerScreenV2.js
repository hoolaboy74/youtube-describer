import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import axios from 'axios';
import YouTube from 'react-youtube';
import Comments from '../Comments';
import { usePageFocus } from '../hooks';
import Header from '../components/Header';
import { useAccessibility } from '../contexts/AccessibilityContext';

function isMobile() {
    return /Mobi|Android/i.test(navigator.userAgent);
}

const verbosityLabels = { 1: '최소', 2: '기본', 3: '최대' };
function formatTime(seconds) {
    return new Date(seconds * 1000).toISOString().substr(11, 8);
}

const SILENT_AUDIO = 'data:audio/wav;base64,U1JpZ0AAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';

function ShareButton() {
    const { announcePolite } = useAccessibility();
    const [isCopied, setIsCopied] = useState(false);
    const location = useLocation();

    const handleShare = () => {
        const shareUrl = window.location.origin + location.pathname;

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
            const textArea = document.createElement("textarea");
            textArea.value = shareUrl;
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

function PlayerScreenV2() {
    const { announcePolite, announceAssertive } = useAccessibility();
    const { videoId } = useParams();
    const navigate = useNavigate();
    const mainContainerRef = useRef(null); // Create a ref for the main container
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
    const [hasAiProcessingStarted, setHasAiProcessingStarted] = useState(false);

    const [player, setPlayer] = useState(null);
    const [verbosity, setVerbosity] = useState(() => {
        const savedVerbosity = localStorage.getItem('playerVerbosity');
        return savedVerbosity !== null ? JSON.parse(savedVerbosity) : 2;
    });

    const [isReadingSubtitles, setIsReadingSubtitles] = useState(() => {
        const saved = localStorage.getItem('playerReadingSubtitles');
        return saved !== null ? JSON.parse(saved) : true;
    });

    const [playbackRate, setPlaybackRate] = useState(() => {
        const saved = localStorage.getItem('playerPlaybackRate');
        return saved !== null ? JSON.parse(saved) : 1.5;
    });

    useEffect(() => {
        localStorage.setItem('playerVerbosity', JSON.stringify(verbosity));
    }, [verbosity]);

    useEffect(() => {
        localStorage.setItem('playerReadingSubtitles', JSON.stringify(isReadingSubtitles));
    }, [isReadingSubtitles]);

    const playbackRateRef = useRef(playbackRate);
    useEffect(() => {
        playbackRateRef.current = playbackRate;
        localStorage.setItem('playerPlaybackRate', JSON.stringify(playbackRate));
    }, [playbackRate]);

    const [playbackMode, setPlaybackMode] = useState(() => {
        const savedPlaybackMode = localStorage.getItem('playerPlaybackMode');
        return savedPlaybackMode !== null ? savedPlaybackMode : (isMobile() ? 'pause' : 'together');
    });

    useEffect(() => {
        localStorage.setItem('playerPlaybackMode', playbackMode);
    }, [playbackMode]);
    const playbackModeRef = useRef(playbackMode);
    useEffect(() => {
        playbackModeRef.current = playbackMode;
    }, [playbackMode]);
    const [isPlaying, setIsPlaying] = useState(false);
    const audioCache = useRef(new Map());
    const isTtsPlayingRef = useRef(false);

    const audioPlayerRef = useRef(null);
    const onAudioEndedRef = useRef(null);

    // UI State
    const [isScriptVisible, setIsScriptVisible] = useState(false);

    const isDescriptionEnabled = verbosity > 0 || isReadingSubtitles;
    const isDescriptionEnabledRef = useRef(isDescriptionEnabled);
    useEffect(() => { isDescriptionEnabledRef.current = isDescriptionEnabled; }, [isDescriptionEnabled]);

    const headingRef = useRef(null);
    usePageFocus(headingRef);

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
    const hasAnnouncedFrameExtraction = useRef(false);
    const messageIndexRef = useRef(0);

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
        let hasErrorFired = false;

        const handleError = (errorType, errorPayload) => {
            if (hasErrorFired) return;
            hasErrorFired = true;
            es.close();

            if (errorType === 'backend') {
                try {
                    const data = JSON.parse(errorPayload);
                    console.error('Backend Error Event:', data);
                    
                    if (data.message === 'funds_depleted') {
                        setError('서비스 운영을 위한 후원금이 모두 소진되어 현재 새로운 영상을 생성할 수 없습니다. 여러분의 따뜻한 후원이 필요합니다.');
                    } else if (data.message === 'duration_exceeded') {
                        const limit = data.limit || 30;
                        setError(`${limit}분이 넘는 영상은 비용 문제로 인해 처리할 수 없습니다. 양해 부탁드립니다.`);
                    } else if (data.message === 'service_paused') {
                        setError('현재 관리자에 의해 신규 영상 생성이 일시 중지되었습니다. 잠시 후 다시 시도해주세요.');
                    } else if (data.message === 'live_stream_not_supported') {
                        setError('라이브 스트리밍 영상은 현재 지원되지 않습니다. 영상이 종료된 후 다시 시도해주세요.');
                    } else if (data.message === 'gemini_unavailable') {
                        setError('AI 생성기가 일시적인 과부하 또는 할당량 문제로 응답하지 않습니다. 잠시 후 다시 시도해 주세요.');
                    } else if (data.message === 'gemini_rejection') {
                        setError('AI가 부적절하거나 유해한 콘텐츠를 감지하여 생성을 중단했습니다.');
                    } else if (data.message === 'Invalid or missing YouTube URL' || data.message === 'Could not extract YouTube video ID from URL') {
                        setError('유효하지 않거나 지원되지 않는 YouTube URL입니다. 올바른 주소를 입력해주세요.');
                    } else if (data.message === 'video_processing_failed' || data.message === 'An unexpected error occurred on the server.' || data.message === 'A critical database error occurred.') {
                        setError('죄송합니다. 서비스 처리 중 예상치 못한 서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.');
                    } else if (data.message === 'auth_error') { // New condition for authentication errors
                        setError('해당 영상은 로그인(인증)이 필요하거나 처리 시스템의 문제로 인해 화면 해설을 생성할 수 없습니다. 다른 영상을 시도해 주세요.');
                    } else {
                        setError(data.details || data.message || '알 수 없는 오류가 발생했습니다.');
                    }
                } catch (parseError) {
                    console.error('Failed to parse backend error event:', parseError, errorPayload);
                    setError('서버에서 알 수 없는 오류가 발생했습니다.');
                }
            } else if (errorType === 'network') {
                if (isDuplicate) return;
                console.error('EventSource failed:', errorPayload);
                setError(currentError => {
                    if (currentError) return currentError;
                    return '대본 생성 중 네트워크 오류가 발생했습니다. 인터넷 연결을 확인해주세요.';
                });
            }
        };

        es.onopen = () => console.log("SSE connection opened for streaming.");

        es.addEventListener('start', (event) => {
            const data = JSON.parse(event.data);
            setVideoInfo({ videoId: data.videoId, title: data.title });
        });

        es.addEventListener('status_update', (event) => {
            const data = JSON.parse(event.data);
            setStatusMessage(data.message);

            const isAiMessage = data.message.includes('AI로 전체 대본 생성 중');
            const isFrameExtractionMessage = data.message.includes('주요 장면 프레임 추출 중');

            if (isAiMessage) {
                setHasAiProcessingStarted(true);
                if (!hasAnnouncedAiStart.current) {
                    announcePolite(data.message);
                    hasAnnouncedAiStart.current = true;
                }
            } else if (isFrameExtractionMessage) {
                if (!hasAnnouncedFrameExtraction.current) {
                    announcePolite('주요 장면 프레임 추출 중입니다.');
                    hasAnnouncedFrameExtraction.current = true;
                } else {
                    const progressMatch = data.message.match(/\((\d+)%\)/);
                    if (progressMatch && progressMatch[1]) {
                        announcePolite(progressMatch[1] + '%');
                    }
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

        es.addEventListener('backend_error', (event) => {
            handleError('backend', event.data);
        });

        es.onerror = (err) => {
            if (isDuplicate) return;
            handleError('network', err);
        };
    }, [videoId, announcePolite]);

    useEffect(() => {
        if (!videoId) {
            navigate('/');
            return;
        }

        setIsLoading(true);
        setIsNewGeneration(false);
        setIsPlayerReady(false);
        setIsGenerationComplete(false);
        setHasAiProcessingStarted(false);
        setIsInteractionDone(false);
        setScript([]);
        setError('');
        setStatusMessage('영상 정보를 확인 중입니다...');
        announcePolite('영상 데이터를 불러오는 중입니다.');
        hasAnnouncedAiStart.current = false;
        hasAnnouncedFrameExtraction.current = false;
        messageIndexRef.current = 0;
        lastSpokenIndexRef.current = -1;

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

    useEffect(() => {
        if (hasAiProcessingStarted && !isGenerationComplete && !error && !isPlayerReady) {
            const waitingMessages = [
                'AI가 열심히 대본을 작성하고 있습니다. 잠시만 기다려주세요.',
                '최고의 해설을 위해 영상의 모든 장면을 분석 중입니다.',
                '이야기의 흐름을 파악하고 있습니다. 거의 다 되어갑니다.',
            ];

            announcePolite(waitingMessages[messageIndexRef.current]);
            messageIndexRef.current = (messageIndexRef.current + 1) % waitingMessages.length;

            const intervalId = setInterval(() => {
                announcePolite(waitingMessages[messageIndexRef.current]);
                messageIndexRef.current = (messageIndexRef.current + 1) % waitingMessages.length;
            }, 15000);

            return () => clearInterval(intervalId);
        }
    }, [hasAiProcessingStarted, isGenerationComplete, announcePolite, error, isPlayerReady]);

    const filteredScript = useMemo(() => {
        const vLinesMap = new Map();
        const textLines = [];

        for (const line of script) {
            if (line.verbosity === 'text') {
                if (isReadingSubtitles) {
                    textLines.push(line);
                }
            } else {
                if (verbosity === 0) continue;
                const lineVerbosity = parseInt(line.verbosity.replace('v', ''));
                if (lineVerbosity <= verbosity) {
                    const existingLine = vLinesMap.get(line.timestamp);
                    if (!existingLine || lineVerbosity > parseInt(existingLine.verbosity.replace('v', ''))) {
                        vLinesMap.set(line.timestamp, line);
                    }
                }
            }
        }
        return [...vLinesMap.values(), ...textLines].sort((a, b) => a.timestamp - b.timestamp);
    }, [script, verbosity, isReadingSubtitles]);

    const playableScript = useMemo(() => {
        if (filteredScript.length === 0) return [];

        const finalScript = [];
        const COLLISION_THRESHOLD_SECONDS = 3.5;

        const getPriority = (v) => v === 'text' ? 4 : parseInt(v.replace('v', ''));

        for (const currentLine of filteredScript) {
            if (finalScript.length === 0) {
                finalScript.push(currentLine);
                continue;
            }

            const lastAcceptedLine = finalScript[finalScript.length - 1];
            const isCollision = currentLine.timestamp < lastAcceptedLine.timestamp + COLLISION_THRESHOLD_SECONDS;

            if (isCollision) {
                const currentPriority = getPriority(currentLine.verbosity);
                const lastPriority = getPriority(lastAcceptedLine.verbosity);

                if (currentPriority > lastPriority) {
                    // Current line is more important, replace the last one
                    finalScript.pop();
                    finalScript.push(currentLine);
                }
                // Else, do nothing (skip the current line)
            } else {
                // No collision, add the current line
                finalScript.push(currentLine);
            }
        }
        return finalScript;
    }, [filteredScript]);

    const handleTtsStart = useCallback(() => {
        if (!player || typeof player.pauseVideo !== 'function') return;
        isTtsPlayingRef.current = true;
        
        const currentMode = playbackModeRef.current;
        
        if (currentMode === 'pause') {
            if (player.getPlayerState() === 1) player.pauseVideo();
        } else if (currentMode === 'together' && !isMobile()) {
            player.setVolume(30); // Audio ducking for PC
        }
        // For mobile 'together', we just let it play over.
    }, [player]);

    const handleTtsEnd = useCallback(() => {
        if (!player) return;
        isTtsPlayingRef.current = false;
        
        const currentMode = playbackModeRef.current;

        if (currentMode === 'pause') {
            if (player.getPlayerState() !== 1) player.playVideo();
        } else if (currentMode === 'together' && !isMobile()) {
            player.setVolume(100); // Restore volume for PC
        }
        // For mobile 'together', no volume change was made.
    }, [player]);

    const playDescription = useCallback(async (scriptLine) => {
        if (!player || !scriptLine || !audioPlayerRef.current) return;

        handleTtsStart();

        const audioPlayer = audioPlayerRef.current;

        onAudioEndedRef.current = () => {
            handleTtsEnd();
        };

        const playAudioFromUrl = (url) => {
            audioPlayer.src = url;
            audioPlayer.playbackRate = playbackRateRef.current;
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
    }, [player, handleTtsStart, handleTtsEnd]);

    useEffect(() => {
        if (!isPlaying || !player) return;

        const intervalId = setInterval(() => {
            if (isTtsPlayingRef.current || !isDescriptionEnabledRef.current || !player || typeof player.getPlayerState !== 'function' || player.getPlayerState() !== 1) {
                return;
            }
            const currentTime = Math.floor(player.getCurrentTime());
            const nextLineIndex = playableScript.findIndex((line, index) => 
                index > lastSpokenIndexRef.current && currentTime >= line.timestamp
            );
            if (nextLineIndex !== -1) {
                lastSpokenIndexRef.current = nextLineIndex;
                playDescription(playableScript[nextLineIndex]);
            }
        }, 250);

        return () => clearInterval(intervalId);
    }, [isPlaying, player, playableScript, playDescription]);
    
    useEffect(() => {
        if (player && typeof player.getCurrentTime === 'function') {
            const currentTime = player.getCurrentTime();
            lastSpokenIndexRef.current = playableScript.findLastIndex(line => line.timestamp <= currentTime);
        }
    }, [verbosity, playableScript, player]);

    const handleVerbosityChange = (level) => {
        setVerbosity(level);
        const label = { 0: '없음', ...verbosityLabels }[level];
        announcePolite(`해설정도가 ${label}으로 변경되었습니다.`);
    };

    const handleSubtitleToggle = () => {
        setIsReadingSubtitles(prev => {
            const newState = !prev;
            announcePolite(newState ? '자막 읽기가 켜졌습니다.' : '자막 읽기가 꺼졌습니다.');
            return newState;
        });
    };

    const handleTogglePlay = () => {
        if (!player) return;

        const playerState = player.getPlayerState();
        if (playerState === 1) { // 1 means playing
            player.pauseVideo();
            return;
        }

        // On the first play, unlock audio context and start the video simultaneously.
        // This is crucial for mobile browser compatibility.
        if (!isInteractionDone) {
            setIsInteractionDone(true);
            const audioPlayer = audioPlayerRef.current;
            if (audioPlayer) {
                // Play a silent audio track to unlock the audio context.
                // The user's single tap must be used to initiate both audio and video.
                audioPlayer.src = SILENT_AUDIO;
                audioPlayer.volume = 0;
                audioPlayer.play().catch(e => {
                    // This can fail on some strict browsers, but the attempt is what matters.
                    console.warn("Silent audio play for unlocking context failed (this is often ok).", e);
                });
            }
        }
        
        // For both first play and subsequent plays, start the video.
        player.playVideo();
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
                                controls: 0,
                                rel: 0,
                                iv_load_policy: 3,
                                playsinline: 1
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
        <div ref={mainContainerRef}>
            <Header title={videoInfo.title} ref={headingRef} />

            {renderContent()}

            <div className="controls-container">
                <div className="verbosity-control">
                    <span>해설정도:</span>
                    {[0, 1, 2, 3].map(level => (
                        <button key={level} onClick={() => handleVerbosityChange(level)} aria-pressed={verbosity === level}>
                            {newVerbosityLabels[level]}
                        </button>
                    ))}
                    <button 
                        className="subtitle-toggle" 
                        onClick={handleSubtitleToggle} 
                        aria-pressed={isReadingSubtitles}
                        style={{ marginLeft: '10px', borderLeft: '1px solid #ccc', paddingLeft: '10px' }}
                    >
                        자막 읽기
                    </button>
                </div>
                <div className="playback-mode-control">
                    <span>해설방식:</span>
                    <button onClick={() => setPlaybackMode('pause')} aria-pressed={playbackMode === 'pause'}>
                        멈춘 후 해설
                    </button>
                    <button onClick={() => setPlaybackMode('together')} aria-pressed={playbackMode === 'together'}>
                        영상과 같이
                    </button>
                </div>
                <div className="playback-rate-control" style={{ marginTop: '10px' }}>
                    <span>해설속도:</span>
                    {[1.5, 2.5, 3.5].map(rate => (
                        <button 
                            key={rate} 
                            onClick={() => {
                                setPlaybackRate(rate);
                                announcePolite(`해설 속도가 ${rate}배속으로 변경되었습니다.`);
                            }} 
                            aria-pressed={playbackRate === rate}
                        >
                            {rate.toFixed(1)}
                        </button>
                    ))}
                </div>
                <button onClick={() => setIsScriptVisible(prev => !prev)} aria-expanded={isScriptVisible} style={{ marginTop: '10px' }}>
                    {isScriptVisible ? '대본 숨기기' : '대본 보기'}
                </button>
                <ShareButton />
            </div>

            {isScriptVisible && (
                <div className="script-container">
                    <h3>{`화면 해설 대본 (${newVerbosityLabels[verbosity]}: ${playableScript.length}개)`}</h3>
                    <ul>
                        {playableScript.map((line) => (
                            <li key={line.id}>
                                <strong>[{formatTime(line.timestamp)}]</strong>
                                <span className={`verbosity-tag verbosity-${line.verbosity.replace('v', '')}`}>{line.verbosity}</span>
                                {line.text}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            <Comments videoId={videoId} mainRef={mainContainerRef} />
        </div>
    );
}

export default PlayerScreenV2;
