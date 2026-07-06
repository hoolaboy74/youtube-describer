import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import axios from 'axios';
import YouTube from 'react-youtube';
import Comments from '../Comments';
import { usePageFocus } from '../hooks';
import Header from '../components/Header';
import { useAccessibility } from '../contexts/AccessibilityContext';
import { useAuth } from '../contexts/AuthContext';
import './PlayerScreenV2.css';

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
    const { user, token, API_BASE } = useAuth();
    const { videoId } = useParams();
    const navigate = useNavigate();
    const location = useLocation();
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
    const [isFavorite, setIsFavorite] = useState(false);
    const [likeCount, setLikeCount] = useState(0);

    // 좋아요 상태 조회 및 토글 핸들러
    useEffect(() => {
        const checkFavorite = async () => {
            if (user && videoId) {
                try {
                    const res = await axios.get(`${API_BASE}/api/users/me/videos/favorites/${videoId}`);
                    if (res.data.success) {
                        setIsFavorite(res.data.isFavorite);
                        setLikeCount(res.data.likeCount || 0);
                    }
                } catch (err) {
                    console.error('Failed to check favorite status:', err);
                }
            }
        };
        checkFavorite();
    }, [user, videoId, API_BASE]);

    const handleToggleFavorite = async () => {
        if (!user) {
            alert('로그인이 필요한 기능입니다.');
            return;
        }
        try {
            const res = await axios.post(`${API_BASE}/api/users/me/videos/favorites/toggle`, { videoId });
            if (res.data.success) {
                setIsFavorite(res.data.isFavorite);
                setLikeCount(res.data.likeCount || 0);
                announcePolite(res.data.isFavorite ? '좋아요가 반영되었습니다.' : '좋아요가 취소되었습니다.');
            }
        } catch (err) {
            console.error('Failed to toggle favorite:', err);
            announcePolite('좋아요 상태 변경에 실패했습니다.');
        }
    };
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

    // Time & Navigation State
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);

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
        if (!user) {
            setError('LOGIN_REQUIRED');
            announcePolite('신규 화면 해설을 생성하려면 로그인이 필요합니다.');
            return;
        }

        console.log('Starting new generation process...');
        setIsNewGeneration(true);
        setStatusMessage('새로운 화면 해설 대본 생성을 시작합니다...');
        announcePolite('기존 대본이 없거나 불완전하여, 새로 생성을 시작합니다.');
        
        const sseApiHost = process.env.NODE_ENV === 'production' ? '' : 'http://localhost:4000';
        const url = `${sseApiHost}/api/process?youtubeUrl=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&token=${token}`;
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
                    
                    let msg = '';
                    if (data.message === 'funds_depleted') {
                        msg = '서비스 운영을 위한 후원금이 모두 소진되어 현재 새로운 영상을 생성할 수 없습니다. 여러분의 따뜻한 후원이 필요합니다.';
                    } else if (data.message === 'unverified_user_duration_exceeded') {
                        msg = '시각장애인 인증을 완료하지 않은 회원은 5분 이하의 영상만 해설을 생성할 수 있습니다. 5분을 초과하는 영상의 화면 해설을 생성하려면 마이페이지에서 시각장애인 인증을 완료해 주십시오.';
                    } else if (data.message === 'duration_exceeded') {
                        const limit = data.limit || 30;
                        msg = `${limit}분이 넘는 영상은 비용 문제로 인해 처리할 수 없습니다. 양해 부탁드립니다.`;
                    } else if (data.message === 'service_paused') {
                        msg = '현재 관리자에 의해 신규 영상 생성이 일시 중지되었습니다. 잠시 후 다시 시도해주세요.';
                    } else if (data.message === 'live_stream_not_supported') {
                        msg = '라이브 스트리밍 영상은 현재 지원되지 않습니다. 영상이 종료된 후 다시 시도해주세요.';
                    } else if (data.message === 'embed_disabled') {
                        msg = '이 영상은 소유자의 요청으로 다른 웹사이트에서의 재생이 금지되어 있어 화면 해설을 제공할 수 없습니다. 유튜브에서 직접 시청해주세요.';
                    } else if (data.message === 'gemini_unavailable') {
                        msg = 'AI 생성기가 일시적인 과부하 또는 할당량 문제로 응답하지 않습니다. 잠시 후 다시 시도해 주세요.';
                    } else if (data.message === 'gemini_rejection') {
                        msg = 'AI가 부적절하거나 유해한 콘텐츠를 감지하여 생성을 중단했습니다.';
                    } else if (data.message === 'Invalid or missing YouTube URL' || data.message === 'Could not extract YouTube video ID from URL') {
                        msg = '유효하지 않거나 지원되지 않는 YouTube URL입니다. 올바른 주소를 입력해주세요.';
                    } else if (data.message === 'video_processing_failed' || data.message === 'An unexpected error occurred on the server.' || data.message === 'A critical database error occurred.') {
                        msg = '죄송합니다. 서비스 처리 중 예상치 못한 서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.';
                    } else if (data.message === 'auth_error') {
                        msg = '해당 영상은 로그인(인증)이 필요하거나 처리 시스템의 문제로 인해 화면 해설을 생성할 수 없습니다. 다른 영상을 시도해 주세요.';
                    } else {
                        msg = data.details || data.message || '알 수 없는 오류가 발생했습니다.';
                    }
                    setError(msg);
                    announceAssertive(msg);
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
            const isFrameExtractionStart = data.message.includes('프레임 및 자막 추출 중');
            const isDownloadStart = data.message.includes('영상 다운로드 중');
            const isDownloadEnd = data.message.includes('다운로드 완료');
            const isProgressMessage = /^\d+%$/.test(data.message); // matches "xx%"

            if (isAiMessage) {
                setHasAiProcessingStarted(true);
                if (!hasAnnouncedAiStart.current) {
                    announcePolite(data.message);
                    hasAnnouncedAiStart.current = true;
                }
            } else if (isFrameExtractionStart) {
                if (!hasAnnouncedFrameExtraction.current) {
                    announcePolite('영상 분석 및 프레임 추출을 시작합니다.');
                    hasAnnouncedFrameExtraction.current = true;
                }
            } else if (isDownloadStart) {
                announcePolite('영상을 다운로드 중입니다.');
            } else if (isDownloadEnd) {
                announcePolite('다운로드가 완료되었습니다. 파일을 저장하고 있습니다.');
            } else if (isProgressMessage) {
                announcePolite(data.message);
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
    }, [videoId, announcePolite, announceAssertive, user, token]);

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

        // Reset time
        setCurrentTime(0);
        setDuration(0);

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

            // 자막(text) 타입은 충돌 검사를 하지 않고 무조건 포함시킵니다.
            // 또한 이전 라인이 자막인 경우에도, 이번 라인이 자막이면 충돌 무시하고 포함 (자막 연쇄 허용)
            if (currentLine.verbosity === 'text') {
                finalScript.push(currentLine);
                continue;
            }

            // 이전 라인이 자막인데 현재 라인이 해설인 경우 -> 충돌나면 해설을 버림 (자막 우선)
            // 해설 vs 해설인 경우 -> 기존 로직대로 3.5초 체크

            const isCollision = currentLine.timestamp < lastAcceptedLine.timestamp + COLLISION_THRESHOLD_SECONDS;

            if (isCollision) {
                const currentPriority = getPriority(currentLine.verbosity);
                const lastPriority = getPriority(lastAcceptedLine.verbosity);

                if (currentPriority > lastPriority) {
                    // 현재(해설) 중요도가 더 높으면 교체 (사실 text 우선이라 여기 올 일은 거의 없음)
                    finalScript.pop();
                    finalScript.push(currentLine);
                }
                // 그렇지 않으면 현재 라인(해설) 스킵
            } else {
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
            player.setVolume(60); // Audio ducking for PC
        }
    }, [player]);

    const handleTtsEnd = useCallback(() => {
        if (!player) return;
        isTtsPlayingRef.current = false;
        
        const currentMode = playbackModeRef.current;

        // 1. 'pause' 모드인 경우 -> 무조건 다시 재생
        // 2. 'together' 모드인데 자막 대기를 위해 강제로 멈춰있던 경우 -> 다시 재생
        // (playerState !== 1 은 일시정지 등을 의미)
        if (player.getPlayerState() !== 1) {
             player.playVideo();
        }
        
        if (currentMode === 'together' && !isMobile()) {
            player.setVolume(100); // Restore volume for PC
        }
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
        // 기존 interval 로직에 시간 업데이트 추가
        if (!player) return;

        const intervalId = setInterval(() => {
            // Player가 유효하고 기능이 있는지 확인
            if (player && typeof player.getPlayerState === 'function') {
                // 1. 현재 시간 업데이트
                const time = player.getCurrentTime();
                setCurrentTime(time);

                // 2. 총 길이 업데이트 (한 번만 설정되어도 되지만, 안전하게 확인)
                if (duration === 0) {
                    const dur = player.getDuration();
                    if (dur) setDuration(dur);
                }

                // 3. 기존 로직: 재생 중일 때 대본 체크
                if (isPlaying && isDescriptionEnabledRef.current) {
                    const currentTimeFloor = Math.floor(time);
                    
                    // 아직 읽지 않은 다음 스크립트 찾기
                    const nextLineIndex = playableScript.findIndex((line, index) => 
                        index > lastSpokenIndexRef.current && currentTimeFloor >= line.timestamp
                    );

                    if (nextLineIndex !== -1) {
                        const nextLine = playableScript[nextLineIndex];

                        // [중요] 이미 TTS가 재생 중인 경우의 처리
                        if (isTtsPlayingRef.current) {
                            // 다음 읽을 것이 자막(text)이고 영상이 재생 중이라면
                            // -> "잠깐 멈춰, 앞의 설명 다 듣고 이거 읽고 가자"
                            if (nextLine.verbosity === 'text' && player.getPlayerState() === 1) {
                                player.pauseVideo();
                            }
                            // 오디오 끝날 때까지 대기
                        } else {
                            // 재생 가능한 상태이므로 재생 시작
                            lastSpokenIndexRef.current = nextLineIndex;
                            playDescription(nextLine);
                        }
                    }
                }
            }
        }, 250);

        return () => clearInterval(intervalId);
    }, [isPlaying, player, playableScript, playDescription, duration]);
    
    useEffect(() => {
        if (player && typeof player.getCurrentTime === 'function') {
            const currentTime = player.getCurrentTime();
            lastSpokenIndexRef.current = playableScript.findLastIndex(line => line.timestamp <= currentTime);
        }
    }, [verbosity, playableScript, player]);

    const handleSkip = (seconds) => {
        if (player && typeof player.getCurrentTime === 'function') {
            const currentTime = player.getCurrentTime();
            const newTime = currentTime + seconds;
            player.seekTo(newTime, true);
            setCurrentTime(newTime); // 즉시 UI 반영
            
            // 1. 현재 재생 중인 오디오가 있다면 즉시 중단 및 초기화
            if (audioPlayerRef.current) {
                audioPlayerRef.current.pause();
                audioPlayerRef.current.currentTime = 0;
            }
            
            // 2. TTS 상태 리셋
            isTtsPlayingRef.current = false;

            // 3. TTS 포인터 재설정
            const newIndex = playableScript.findLastIndex(line => line.timestamp <= newTime);
            lastSpokenIndexRef.current = newIndex;

            // 접근성 안내
            const msg = `${Math.abs(seconds)}초 ${seconds > 0 ? '앞으로' : '뒤로'} 이동`;
            announcePolite(msg);
        }
    };

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

        const isVideoPlaying = player.getPlayerState() === 1;
        const isAudioPlaying = audioPlayerRef.current && !audioPlayerRef.current.paused && !audioPlayerRef.current.ended;

        // 1. 영상이나 오디오 중 하나라도 재생 중이면 -> 둘 다 확실하게 일시정지
        if (isVideoPlaying || isAudioPlaying) {
            if (isVideoPlaying) player.pauseVideo();
            if (isAudioPlaying) audioPlayerRef.current.pause();
            return;
        }

        // 2. 둘 다 멈춰있는 경우 -> 재생 재개 (Resume)

        // 2-1. 모바일 브라우저 오디오 정책 대응 (최초 1회 Silent Audio 재생)
        if (!isInteractionDone) {
            setIsInteractionDone(true);
            const audioPlayer = audioPlayerRef.current;
            if (audioPlayer) {
                audioPlayer.src = SILENT_AUDIO;
                audioPlayer.volume = 0;
                audioPlayer.play().catch(e => {
                    console.warn("Silent audio play for unlocking context failed (this is often ok).", e);
                });
            }
        }
        
        // 2-2. 멈췄던 오디오 처리
        const audio = audioPlayerRef.current;
        const isPauseMode = playbackModeRef.current === 'pause';
        
        if (audio && audio.paused && !audio.ended && audio.src && audio.src !== SILENT_AUDIO) {
             
             // Case A: '멈춘 후 해설' 모드 -> 무조건 오디오만 재생
             if (isPauseMode) {
                 audio.play().catch(e => {
                     console.error("Resume audio failed", e);
                     player.playVideo(); 
                 });
                 return;
             }
             
             // Case B: '영상과 같이' 모드
             if (isMobile()) {
                 // 모바일: 멈췄던 오디오는 과감히 버립니다.
                 // 억지로 재생하려다 큐가 꼬이는 것을 방지하기 위해,
                 // 현재 오디오 재생 상태(Ref)를 강제로 끄고 영상만 틉니다.
                 isTtsPlayingRef.current = false; 
                 // (주의) audio.currentTime 등을 건드리면 또 로딩이 걸리므로, 그냥 놔두고 플래그만 내립니다.
             } else {
                 // PC: 정상 재생
                 audio.volume = 1;
                 audio.play().catch(e => console.error("Resume audio failed", e));
             }
        }

        // 3. 영상 재생
        player.playVideo();
    };

    const newVerbosityLabels = { 0: '없음', ...verbosityLabels };

    return (
        <div ref={mainContainerRef} className="player-screen-container">
            <Header title={videoInfo.title} ref={headingRef} />

            {isLoading ? (
                <p>영상 데이터를 불러오는 중입니다...</p>
            ) : error ? (
                error === 'LOGIN_REQUIRED' ? (
                    <div className="login-required-container" role="status" aria-live="polite">
                        <h2 className="login-required-title">화면 해설 생성 권한이 제한되었습니다</h2>
                        <p className="login-required-message">
                            신규 영상의 화면 해설 대본을 생성하시려면 <strong>시각장애인 인증 회원</strong>으로 로그인이 필요합니다.<br/>
                            이미 해설 대본이 존재하는 영상은 로그인 없이 즉시 시청하실 수 있습니다.
                        </p>
                        <div className="login-required-actions">
                            <button 
                                onClick={() => navigate('/login', { state: { from: location } })}
                                className="login-required-btn-primary"
                            >
                                로그인하기
                            </button>
                            <button 
                                onClick={() => navigate('/register')}
                                className="login-required-btn-secondary"
                            >
                                회원가입
                            </button>
                        </div>
                    </div>
                ) : (
                    <p className="error-message" role="alert">{error}</p>
                )
            ) : (isNewGeneration && !isPlayerReady) ? (
                <div className="status-container">
                    <p>새로운 화면 해설을 생성하고 있습니다. 잠시만 기다려주세요...</p>
                    <p className="status-message">{statusMessage}</p>
                    <div className="spinner"></div>
                </div>
            ) : isPlayerReady ? (
                <>
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
                             onReady={async (e) => {
                                 setPlayer(e.target);
                                 setDuration(e.target.getDuration());
                                 if (user) {
                                     try {
                                         await axios.post(`${API_BASE}/api/users/me/videos/history`, { videoId });
                                     } catch (err) {
                                         console.error('Failed to update watch history:', err);
                                     }
                                 }
                             }}
                            onStateChange={(e) => setIsPlaying(e.data === window.YT.PlayerState.PLAYING)}
                        />
                    </div>
                    
                    {/* Time & Navigation Controls - High Contrast & Simple for Accessibility */}
                    <div className="time-bar-container">
                        <div className="time-display">
                            {/* Screen Reader Only Text */}
                            <span style={{
                                position: 'absolute',
                                width: '1px',
                                height: '1px',
                                padding: 0,
                                margin: '-1px',
                                overflow: 'hidden',
                                clip: 'rect(0,0,0,0)',
                                whiteSpace: 'nowrap',
                                border: 0
                            }}>
                                {`전체 ${formatTime(duration)} 중 현재 ${formatTime(currentTime)}`}
                            </span>
                            
                            {/* Visual Only Text */}
                            <span aria-hidden="true">
                                {formatTime(currentTime)} / {formatTime(duration)}
                            </span>
                        </div>
                        <div className="jump-buttons">
                            <button 
                                onClick={() => handleSkip(-30)} 
                                className="skip-button"
                                aria-label="30초 뒤로 이동"
                            >
                                ⏪ 30초 전
                            </button>
                            <button 
                                onClick={() => handleSkip(30)} 
                                className="skip-button"
                                aria-label="30초 앞으로 이동"
                            >
                                30초 후 ⏩
                            </button>
                        </div>
                    </div>
                </>
            ) : (
                <p>알 수 없는 상태입니다. 페이지를 새로고침 해주세요.</p>
            )}

            <div className="controls-container">
                <div className="control-group">
                    <label htmlFor="verbosity-select" className="control-label">해설정도:</label>
                    <select
                        id="verbosity-select"
                        value={verbosity}
                        onChange={(e) => handleVerbosityChange(Number(e.target.value))}
                        className="control-select"
                    >
                        <option value={0}>없음</option>
                        <option value={1}>최소</option>
                        <option value={2}>기본</option>
                        <option value={3}>최대</option>
                    </select>

                    <div className="subtitle-check-container">
                        <input
                            type="checkbox"
                            id="subtitle-check"
                            checked={isReadingSubtitles}
                            onChange={handleSubtitleToggle}
                            className="subtitle-checkbox"
                        />
                        <label htmlFor="subtitle-check" className="subtitle-label">자막 읽기</label>
                    </div>
                </div>

                <div className="control-group">
                    <label htmlFor="mode-select" className="control-label">해설방식:</label>
                    <select
                        id="mode-select"
                        value={playbackMode}
                        onChange={(e) => setPlaybackMode(e.target.value)}
                        className="control-select"
                    >
                        <option value="pause">멈춘 후 해설</option>
                        <option value="together">영상과 같이</option>
                    </select>
                </div>

                <div className="control-group">
                    <label htmlFor="rate-select" className="control-label">해설속도:</label>
                    <select
                        id="rate-select"
                        value={playbackRate}
                        onChange={(e) => {
                            const rate = Number(e.target.value);
                            setPlaybackRate(rate);
                            const label = { 1.5: '초보', 2.0: '중수', 2.5: '고수', 3.0: '초고수', 3.5: '신' }[rate];
                            announcePolite(`해설 속도가 ${label} 모드로 변경되었습니다.`);
                        }}
                        className="control-select"
                    >
                        <option value={1.5}>초보 (1.5x)</option>
                        <option value={2.0}>중수 (2.0x)</option>
                        <option value={2.5}>고수 (2.5x)</option>
                        <option value={3.0}>초고수 (3.0x)</option>
                        <option value={3.5}>신 (3.5x)</option>
                    </select>
                </div>

                <div className="secondary-controls">
                    <button onClick={() => setIsScriptVisible(prev => !prev)} aria-expanded={isScriptVisible} className="toggle-script-button">
                        {isScriptVisible ? '대본 숨기기' : '대본 보기'}
                    </button>
                    <ShareButton />
                    {user && (
                        <button onClick={handleToggleFavorite} className={`favorite-button ${isFavorite ? 'active' : ''}`} aria-label={isFavorite ? `좋아요 완료, 현재 좋아요 총 ${likeCount}개` : `좋아요, 현재 좋아요 총 ${likeCount}개`}>
                            {isFavorite ? `❤️ 좋아요 ${likeCount}` : `🖤 좋아요 ${likeCount}`}
                        </button>
                    )}
                </div>
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
