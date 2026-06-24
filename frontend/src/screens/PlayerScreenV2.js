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
    const [isQaModalOpen, setIsQaModalOpen] = useState(false);

    // Q&A States & Hooks
    const [question, setQuestion] = useState('');
    const [qaList, setQaList] = useState([]);
    const [isQaLoading, setIsQaLoading] = useState(false);
    const inputRef = useRef(null);
    const qaTriggerBtnRef = useRef(null);
    const [qaPoliteAnnouncement, setQaPoliteAnnouncement] = useState('');
    const qaTimeoutRef = useRef(null);
    const announceQaPolite = useCallback((message) => {
        clearTimeout(qaTimeoutRef.current);
        setQaPoliteAnnouncement('');
        setTimeout(() => {
            setQaPoliteAnnouncement(message);
            qaTimeoutRef.current = setTimeout(() => setQaPoliteAnnouncement(''), 3000);
        }, 100);
    }, []);
    const qaListEndRef = useRef(null);
    const modalRef = useRef(null);
    const closeBtnRef = useRef(null);

    const isDescriptionEnabled = verbosity > 0 || isReadingSubtitles;
    const isDescriptionEnabledRef = useRef(isDescriptionEnabled);
    useEffect(() => { isDescriptionEnabledRef.current = isDescriptionEnabled; }, [isDescriptionEnabled]);

    const headingRef = useRef(null);
    usePageFocus(headingRef);

    useEffect(() => {
        if (videoInfo && videoInfo.title && videoInfo.title !== '불러오는 중...') {
            document.title = videoInfo.title;
        } else {
            document.title = '유튜브 화면 해설';
        }
        return () => {
            document.title = '시각장애인맘센터';
        };
    }, [videoInfo]);



    const handleTogglePlay = useCallback(() => {
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
    }, [player, isInteractionDone]);

    // Handle Q&A Modal State Changes
    useEffect(() => {
        if (isQaModalOpen) {
            // Pause video on modal open
            if (player && player.getPlayerState() === 1) {
                player.pauseVideo();
                setIsPlaying(false);
            }
            // Stop any playing TTS and restore volume immediately
            if (isTtsPlayingRef.current) {
                isTtsPlayingRef.current = false;
                if (audioPlayerRef.current) {
                    audioPlayerRef.current.pause();
                }
            }
            if (player) {
                player.setVolume(100);
            }
            announceQaPolite('질문 하세요');
        }
    }, [isQaModalOpen, player, announceQaPolite]);

    // Close QA Modal, stop TTS, and resume video playback
    const handleCloseQaModal = useCallback(() => {
        setIsQaModalOpen(false);
        // iOS 동기적 모달 숨김 처리 강제
        if (modalRef.current) {
            modalRef.current.style.display = 'none';
        }

        // 1. Stop QA TTS if playing
        if (isTtsPlayingRef.current) {
            isTtsPlayingRef.current = false;
            if (audioPlayerRef.current) {
                audioPlayerRef.current.pause();
            }
        }

        // Restore video volume unconditionally to prevent audio ducking from sticking
        if (player) {
            player.setVolume(100);
        }

        // 2. Resume video playback
        if (player) {
            player.playVideo();
            setIsPlaying(true);
        }

        // 3. 원래 대화창 열기 버튼으로 포커스 복원
        if (qaTriggerBtnRef.current) {
            qaTriggerBtnRef.current.focus();
        }

        announcePolite('질의응답 닫힘');
    }, [player, announcePolite]);

    // Keyboard shortcut logic for Q&A and video playback
    useEffect(() => {
        const handleKeyDown = (e) => {
            const activeEl = document.activeElement;

            // 1. If Q&A Modal is Open
            if (isQaModalOpen) {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    handleCloseQaModal();
                    return;
                }

                if (e.key === 'Tab') {
                    if (!modalRef.current) return;
                    
                    const focusableEls = modalRef.current.querySelectorAll(
                        'a[href], area[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex="0"]'
                    );
                    if (focusableEls.length > 0) {
                        const firstEl = focusableEls[0];
                        const lastEl = focusableEls[focusableEls.length - 1];

                        if (e.shiftKey) { // Shift + Tab
                            if (document.activeElement === firstEl) {
                                lastEl.focus();
                                e.preventDefault();
                            }
                        } else { // Tab
                            if (document.activeElement === lastEl) {
                                firstEl.focus();
                                e.preventDefault();
                            }
                        }
                    }
                }
                
                // Allow space key inside input for text typing
                if (activeEl && ['INPUT', 'TEXTAREA'].includes(activeEl.tagName)) {
                    return;
                }
                
                // Space bar toggle playback within Modal when not typing
                if (e.key === ' ' || e.key === 'Spacebar') {
                    e.preventDefault();
                    handleTogglePlay();
                }
                return;
            }

            // 2. If Q&A Modal is Closed
            if (activeEl && ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeEl.tagName)) {
                return;
            }

            // Open QA Modal via 'q' or 'Q' key - Pause everything first
            if (e.key === 'q' || e.key === 'Q') {
                e.preventDefault();
                if (player) {
                    player.pauseVideo();
                }
                setIsPlaying(false);
                if (isTtsPlayingRef.current) {
                    isTtsPlayingRef.current = false;
                    if (audioPlayerRef.current) {
                        audioPlayerRef.current.pause();
                    }
                    if (player) {
                        player.setVolume(100);
                    }
                }
                // iOS 동기적 포커스 및 모달 표출 강제
                if (modalRef.current) {
                    modalRef.current.style.display = 'flex';
                }
                if (inputRef.current) {
                    inputRef.current.focus();
                }
                setIsQaModalOpen(true);
                return;
            }

            if (e.key === ' ' || e.key === 'Spacebar') {
                e.preventDefault(); // Prevent default browser scroll

                if (!player) return;

                const playerState = player.getPlayerState();
                const isVideoPlaying = playerState === 1; // 1: PLAYING
                const isAudioPlaying = audioPlayerRef.current && !audioPlayerRef.current.paused && !audioPlayerRef.current.ended;

                // 재생 중인 경우 -> 일시 정지 및 Q&A 모달 열기
                if (isVideoPlaying || isAudioPlaying) {
                    if (isVideoPlaying) player.pauseVideo();
                    if (isAudioPlaying) {
                        audioPlayerRef.current.pause();
                        isTtsPlayingRef.current = false;
                    }
                    setIsPlaying(false);
                    // iOS 동기적 포커스 및 모달 표출 강제
                    if (modalRef.current) {
                        modalRef.current.style.display = 'flex';
                    }
                    if (inputRef.current) {
                        inputRef.current.focus();
                    }
                    setIsQaModalOpen(true);
                } else {
                    // 정지 중인 경우 -> 재생 재개
                    if (isTtsPlayingRef.current) {
                        isTtsPlayingRef.current = false;
                        if (audioPlayerRef.current) {
                            audioPlayerRef.current.pause();
                        }
                        player.setVolume(100);
                    }

                    handleTogglePlay();
                    announcePolite('영상을 다시 재생합니다.');
                }
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [player, announcePolite, handleTogglePlay, isQaModalOpen, handleCloseQaModal]);

    // Seek to specific timestamp and resume play
    const handleSeekTo = (timestamp) => {
        if (player) {
            player.seekTo(timestamp, true);
            player.playVideo();
            setIsPlaying(true);
            announcePolite(`${formatTime(timestamp)} 시점으로 이동하여 영상을 재생합니다.`);
        }
    };

    // Auto-scroll chat window to bottom on new messages
    useEffect(() => {
        if (qaListEndRef.current) {
            qaListEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [qaList]);

    // Send question to backend Q&A API
    const handleAskQuestion = async () => {
        if (!question.trim() || !player) return;

        // 질문 전송 시 질문창 포커스 아웃하여 스페이스바 단축키 활성화
        if (inputRef.current) {
            inputRef.current.blur();
        }

        player.pauseVideo();
        setIsPlaying(false);

        const currentTimestamp = player.getCurrentTime();
        const userQuestion = question.trim();
        setQuestion('');

        const newQaId = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : (Math.random().toString(36).substring(2) + Date.now().toString(36));
        const newQaItem = {
            id: newQaId,
            timestamp: currentTimestamp,
            question: userQuestion,
            answer: '',
            isGenerating: true
        };

        setQaList(prev => [...prev, newQaItem]);
        setIsQaLoading(true);
        announceQaPolite('잠시만요');

        // 이전 완료된 Q&A 히스토리 구성
        const qaHistory = qaList
            .filter(qa => !qa.isGenerating && qa.answer)
            .map(qa => ({
                question: qa.question,
                answer: qa.answer
            }));

        try {
            const response = await axios.post('/api/video-qa', {
                videoId,
                timestamp: currentTimestamp,
                question: userQuestion,
                history: qaHistory
            });

            const answerText = response.data.answer;

            setQaList(prev => prev.map(qa => 
                qa.id === newQaId ? { ...qa, answer: answerText, isGenerating: false } : qa
            ));
            setIsQaLoading(false);

            // Play answer with TTS audio
            isTtsPlayingRef.current = true;
            player.setVolume(10);
            
            const audioPlayer = audioPlayerRef.current;
            if (audioPlayer) {
                audioPlayer.pause();
                
                onAudioEndedRef.current = () => {
                    isTtsPlayingRef.current = false;
                    if (player) {
                        player.setVolume(100);
                    }
                };

                const ttsResponse = await axios.post(`/api/tts`, { text: answerText }, { responseType: 'blob' });
                const audioUrl = URL.createObjectURL(ttsResponse.data);
                
                audioPlayer.src = audioUrl;
                audioPlayer.playbackRate = playbackRateRef.current || 1.3;
                audioPlayer.volume = 1.0;
                audioPlayer.play().catch(e => {
                    console.error("Q&A Audio play failed:", e);
                    isTtsPlayingRef.current = false;
                });
            }

            // Refocus input field after answer is processed
            setTimeout(() => {
                if (inputRef.current) {
                    inputRef.current.focus();
                }
            }, 100);

        } catch (error) {
            console.error('Q&A failed:', error);
            setQaList(prev => prev.map(qa => 
                qa.id === newQaId ? { ...qa, answer: '답변을 생성하는 데 실패했습니다. 다시 시도해 주세요.', isGenerating: false } : qa
            ));
            setIsQaLoading(false);
            announceQaPolite('장면 분석 및 답변 생성에 실패했습니다.');

            // Refocus input field on error as well
            setTimeout(() => {
                if (inputRef.current) {
                    inputRef.current.focus();
                }
            }, 100);
        }
    };

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
                    } else if (data.message === 'embed_disabled') {
                        setError('이 영상은 소유자의 요청으로 다른 웹사이트에서의 재생이 금지되어 있어 화면 해설을 제공할 수 없습니다. 유튜브에서 직접 시청해주세요.');
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
            player.setVolume(30); // Audio ducking for PC
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


    const newVerbosityLabels = { 0: '없음', ...verbosityLabels };

    return (
        <div ref={mainContainerRef} style={{ maxWidth: '800px', margin: '0 auto', padding: '0 20px 100px 20px' }}>
            <Header title={videoInfo.title} ref={headingRef} />

            {isLoading ? (
                <p>영상 데이터를 불러오는 중입니다...</p>
            ) : error ? (
                <p className="error-message" role="alert">{error}</p>
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
                            onReady={(e) => {
                                setPlayer(e.target);
                                setDuration(e.target.getDuration());
                            }}
                            onStateChange={(e) => setIsPlaying(e.data === window.YT.PlayerState.PLAYING)}
                        />
                    </div>
                    
                    {/* Q&A Trigger Button */}
                    <div style={{ margin: '20px 0', display: 'flex', justifyContent: 'center' }}>
                        <button
                            ref={qaTriggerBtnRef}
                            onClick={() => {
                                // iOS 동기적 모달 display 제어 및 포커싱 강제
                                if (modalRef.current) {
                                    modalRef.current.style.display = 'flex';
                                }
                                if (inputRef.current) {
                                    inputRef.current.focus();
                                }
                                setIsQaModalOpen(true);
                            }}
                            style={{
                                width: '100%',
                                padding: '14px 20px',
                                borderRadius: '12px',
                                backgroundColor: '#0070f3',
                                color: '#ffffff',
                                border: 'none',
                                fontWeight: '700',
                                cursor: 'pointer',
                                fontSize: '1.05rem',
                                boxShadow: '0 4px 12px rgba(0,112,243,0.2)',
                                transition: 'background-color 0.2s'
                            }}
                            aria-label="AI와 대화하기"
                        >
                            AI와 대화하기
                        </button>
                    </div>

                    {/* Q&A Modal */}
                    <div 
                        ref={modalRef}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="qa-modal-title"
                        style={{
                            position: 'fixed',
                            top: 0,
                            left: 0,
                            right: 0,
                            bottom: 0,
                            backgroundColor: 'rgba(0, 0, 0, 0.75)',
                            display: isQaModalOpen ? 'flex' : 'none',
                            justifyContent: 'center',
                            alignItems: 'center',
                            zIndex: 10000,
                            padding: '20px'
                        }}
                    >
                            {/* Local Live Region for Modal Accessibility */}
                            <div className="visually-hidden" aria-live="polite" aria-atomic="true" style={{
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
                                {qaPoliteAnnouncement}
                            </div>

                            <div style={{
                                width: '100%',
                                maxWidth: '600px',
                                height: '80%',
                                maxHeight: '650px',
                                backgroundColor: '#ffffff',
                                borderRadius: '16px',
                                boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
                                display: 'flex',
                                flexDirection: 'column',
                                overflow: 'hidden',
                                border: '1px solid #eaeaea'
                            }}>
                                {/* Modal Header */}
                                <div style={{
                                    padding: '20px 24px',
                                    borderBottom: '1px solid #eaeaea',
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    backgroundColor: '#f8f9fa',
                                    flexShrink: 0
                                }}>
                                    <div>
                                        <h2 id="qa-modal-title" style={{ margin: 0, fontSize: '1.2rem', fontWeight: '700', color: '#1a1a1a' }}>
                                            AI 동영상 질의응답 (Q&A)
                                        </h2>
                                        <span style={{ fontSize: '0.8rem', color: '#666' }}>
                                            현재 영상 시점: {formatTime(currentTime)}
                                        </span>
                                    </div>
                                    <button
                                        ref={closeBtnRef}
                                        onClick={handleCloseQaModal}
                                        style={{
                                            padding: '8px 16px',
                                            borderRadius: '8px',
                                            backgroundColor: '#f5f5f5',
                                            color: '#333',
                                            border: '1px solid #ccc',
                                            cursor: 'pointer',
                                            fontSize: '0.9rem',
                                            fontWeight: '600'
                                        }}
                                        aria-label="대화창 닫기 (ESC)"
                                    >
                                        닫기
                                    </button>
                                </div>

                                {/* Modal Body (Chat History) */}
                                <div style={{
                                    flex: 1,
                                    padding: '20px 24px',
                                    backgroundColor: '#f4f5f7',
                                    overflowY: 'auto',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: '16px'
                                }}>
                                    {qaList.length === 0 ? (
                                        <div style={{
                                            display: 'flex',
                                            flexDirection: 'column',
                                            justifyContent: 'center',
                                            alignItems: 'center',
                                            height: '100%',
                                            minHeight: '200px',
                                            color: '#888',
                                            fontSize: '0.95rem',
                                            textAlign: 'center',
                                            gap: '8px',
                                            padding: '0 20px'
                                        }}>
                                            <span style={{ fontSize: '1.5rem' }}>💡</span>
                                            <span style={{ fontWeight: '600' }}>아직 대화 내역이 없습니다.</span>
                                            <span style={{ fontSize: '0.85rem', color: '#aaa' }}>궁금한 내용을 아래 입력창에 작성해 보세요.</span>
                                        </div>
                                    ) : (
                                        qaList.map((qa) => (
                                            <div key={qa.id} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                                {/* User Question Bubble */}
                                                <div style={{
                                                    alignSelf: 'flex-end',
                                                    maxWidth: '85%',
                                                    display: 'flex',
                                                    flexDirection: 'column',
                                                    alignItems: 'flex-end',
                                                    gap: '4px'
                                                }}>
                                                    <span style={{ fontSize: '0.75rem', color: '#888' }}>
                                                        {/* Timestamp Click to Seek */}
                                                        <button
                                                            onClick={() => handleSeekTo(qa.timestamp)}
                                                            style={{
                                                                background: 'none',
                                                                border: 'none',
                                                                color: '#0070f3',
                                                                cursor: 'pointer',
                                                                padding: 0,
                                                                fontSize: '0.75rem',
                                                                fontWeight: '600',
                                                                textDecoration: 'underline'
                                                            }}
                                                            aria-label={`영상 ${formatTime(qa.timestamp)} 시점으로 이동`}
                                                        >
                                                            질문 시점: {formatTime(qa.timestamp)}
                                                        </button>
                                                    </span>
                                                    <div style={{
                                                        backgroundColor: '#0070f3',
                                                        color: '#ffffff',
                                                        padding: '10px 14px',
                                                        borderRadius: '16px 16px 2px 16px',
                                                        fontSize: '0.95rem',
                                                        lineHeight: '1.45',
                                                        wordBreak: 'break-word',
                                                        boxShadow: '0 2px 6px rgba(0,112,243,0.15)'
                                                    }}>
                                                        {qa.question}
                                                    </div>
                                                </div>

                                                {/* AI Answer Bubble */}
                                                <div style={{
                                                    alignSelf: 'flex-start',
                                                    maxWidth: '85%',
                                                    display: 'flex',
                                                    flexDirection: 'column',
                                                    alignItems: 'flex-start',
                                                    gap: '4px'
                                                }}>
                                                    <span style={{ fontSize: '0.75rem', color: '#888', fontWeight: '600' }}>AI 비서</span>
                                                    <div style={{
                                                        backgroundColor: '#ffffff',
                                                        color: '#222222',
                                                        padding: '12px 16px',
                                                        borderRadius: '16px 16px 16px 2px',
                                                        fontSize: '0.95rem',
                                                        lineHeight: '1.5',
                                                        wordBreak: 'break-word',
                                                        border: '1px solid #e2e8f0',
                                                        boxShadow: '0 2px 6px rgba(0,0,0,0.02)'
                                                    }}>
                                                        {qa.isGenerating ? (
                                                            <span style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#0070f3' }}>
                                                                <span style={{ fontStyle: 'italic' }}>구글 검색 및 장면 정밀 분석 중...</span>
                                                            </span>
                                                        ) : (
                                                            <span>{qa.answer}</span>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        ))
                                    )}
                                    <div ref={qaListEndRef} />
                                </div>

                                {/* Modal Footer (Input controls) */}
                                <div style={{
                                    padding: '20px 24px',
                                    borderTop: '1px solid #eaeaea',
                                    backgroundColor: '#ffffff',
                                    display: 'flex',
                                    gap: '10px',
                                    alignItems: 'center',
                                    flexShrink: 0
                                }}>


                                    <input
                                        ref={inputRef}
                                        type="text"
                                        value={question}
                                        onChange={(e) => setQuestion(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') handleAskQuestion();
                                        }}
                                        style={{
                                            flex: 1,
                                            padding: '12px 16px',
                                            borderRadius: '24px',
                                            border: '1.5px solid #eaeaea',
                                            fontSize: '0.95rem',
                                            outline: 'none',
                                            transition: 'border-color 0.2s',
                                            boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.02)'
                                        }}
                                        aria-label="AI에게 질문할 내용을 입력하세요."
                                    />

                                    <button
                                        onClick={handleAskQuestion}
                                        disabled={isQaLoading || !question.trim()}
                                        style={{
                                            padding: '0 24px',
                                            height: '46px',
                                            borderRadius: '24px',
                                            backgroundColor: '#0070f3',
                                            color: '#fff',
                                            border: 'none',
                                            fontSize: '0.95rem',
                                            fontWeight: '600',
                                            cursor: (isQaLoading || !question.trim()) ? 'not-allowed' : 'pointer',
                                            opacity: (isQaLoading || !question.trim()) ? 0.6 : 1,
                                            transition: 'background-color 0.2s',
                                            flexShrink: 0
                                        }}
                                    >
                                        전송
                                    </button>
                                </div>
                            </div>
                        </div>
                    
                    {/* Time & Navigation Controls - High Contrast & Simple for Accessibility */}
                    <div className="time-control-bar" style={{ 
                        display: 'flex', 
                        justifyContent: 'space-between', 
                        alignItems: 'center', 
                        padding: '15px 0',
                        borderBottom: '1px solid #eee',
                        marginBottom: '15px'
                    }}>
                        <div className="time-display" style={{ fontSize: '1.2rem', fontWeight: 'bold', color: '#333' }}>
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
                        <div className="jump-buttons" style={{ display: 'flex', gap: '15px' }}>
                            <button 
                                onClick={() => handleSkip(-30)} 
                                style={{ padding: '10px 15px', fontSize: '1.1rem', cursor: 'pointer' }}
                                aria-label="30초 뒤로 이동"
                            >
                                ⏪ 30초 전
                            </button>
                            <button 
                                onClick={() => handleSkip(30)} 
                                style={{ padding: '10px 15px', fontSize: '1.1rem', cursor: 'pointer' }}
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
                <div className="control-group" style={{ marginBottom: '15px' }}>
                    <label htmlFor="verbosity-select" style={{ marginRight: '10px', fontWeight: 'bold' }}>해설정도:</label>
                    <select
                        id="verbosity-select"
                        value={verbosity}
                        onChange={(e) => handleVerbosityChange(Number(e.target.value))}
                        style={{ padding: '5px', fontSize: '1rem' }}
                    >
                        <option value={0}>없음</option>
                        <option value={1}>최소</option>
                        <option value={2}>기본</option>
                        <option value={3}>최대</option>
                    </select>

                    <div style={{ display: 'inline-block', marginLeft: '15px' }}>
                        <input
                            type="checkbox"
                            id="subtitle-check"
                            checked={isReadingSubtitles}
                            onChange={handleSubtitleToggle}
                            style={{ width: '1.2rem', height: '1.2rem', verticalAlign: 'middle' }}
                        />
                        <label htmlFor="subtitle-check" style={{ marginLeft: '5px', verticalAlign: 'middle' }}>자막 읽기</label>
                    </div>
                </div>

                <div className="control-group" style={{ marginBottom: '15px' }}>
                    <label htmlFor="mode-select" style={{ marginRight: '10px', fontWeight: 'bold' }}>해설방식:</label>
                    <select
                        id="mode-select"
                        value={playbackMode}
                        onChange={(e) => setPlaybackMode(e.target.value)}
                        style={{ padding: '5px', fontSize: '1rem' }}
                    >
                        <option value="pause">멈춘 후 해설</option>
                        <option value="together">영상과 같이</option>
                    </select>
                </div>

                <div className="control-group" style={{ marginBottom: '15px' }}>
                    <label htmlFor="rate-select" style={{ marginRight: '10px', fontWeight: 'bold' }}>해설속도:</label>
                    <select
                        id="rate-select"
                        value={playbackRate}
                        onChange={(e) => {
                            const rate = Number(e.target.value);
                            setPlaybackRate(rate);
                            const label = { 1.5: '초보', 2.0: '중수', 2.5: '고수', 3.0: '초고수', 3.5: '신' }[rate];
                            announcePolite(`해설 속도가 ${label} 모드로 변경되었습니다.`);
                        }}
                        style={{ padding: '5px', fontSize: '1rem' }}
                    >
                        <option value={1.5}>초보 (1.5x)</option>
                        <option value={2.0}>중수 (2.0x)</option>
                        <option value={2.5}>고수 (2.5x)</option>
                        <option value={3.0}>초고수 (3.0x)</option>
                        <option value={3.5}>신 (3.5x)</option>
                    </select>
                </div>

                <div className="secondary-controls" style={{ display: 'flex', gap: '10px' }}>
                    <button onClick={() => setIsScriptVisible(prev => !prev)} aria-expanded={isScriptVisible} style={{ flex: 1, padding: '10px' }}>
                        {isScriptVisible ? '대본 숨기기' : '대본 보기'}
                    </button>
                    <ShareButton />
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
