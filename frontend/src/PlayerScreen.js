import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import axios from 'axios';
import YouTube from 'react-youtube';
import Comments from './Comments';
import { usePageFocus } from './hooks';

const verbosityLabels = { 1: '최소', 2: '기본', 3: '최대' };
function formatTime(seconds) {
    return new Date(seconds * 1000).toISOString().substr(11, 8);
}

const SILENT_AUDIO = 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU2LjM2LjEwMAAAAAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAEAAABIADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV6urq6urq6urq6urq6urq6urq6urq6urq6v///';

function ShareButton({ announcePolite }) {
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
    const [hasAiProcessingStarted, setHasAiProcessingStarted] = useState(false);

    const [player, setPlayer] = useState(null);
    const [verbosity, setVerbosity] = useState(2); // Default to '기본'
    const [isPlaying, setIsPlaying] = useState(false);
    const audioCache = useRef(new Map());
    const isTtsPlayingRef = useRef(false);

    const audioPlayerRef = useRef(null);
    const onAudioEndedRef = useRef(null);

    // UI State
    const [isScriptVisible, setIsScriptVisible] = useState(false);

    const isDescriptionEnabled = verbosity > 0;
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
                        const fundsDepletedError = '서비스 운영을 위한 후원금이 모두 소진되어 현재 새로운 영상을 생성할 수 없습니다. 여러분의 따뜻한 후원이 필요합니다.';
                        setError(fundsDepletedError);
                        announcePolite(fundsDepletedError);
                    } else if (data.message === 'duration_exceeded') {
                        const limit = data.limit || 30;
                        const durationError = `${limit}분이 넘는 영상은 비용 문제로 인해 처리할 수 없습니다. 양해 부탁드립니다.`;
                        setError(durationError);
                        announcePolite(durationError);
                    } else if (data.message === 'service_paused') {
                        const servicePausedError = '현재 관리자에 의해 신규 영상 생성이 일시 중지되었습니다. 잠시 후 다시 시도해주세요.';
                        setError(servicePausedError);
                        announcePolite(servicePausedError);
                    } else if (data.message === 'live_stream_not_supported') {
                        const liveStreamError = '라이브 스트리밍 영상은 현재 지원되지 않습니다. 영상이 종료된 후 다시 시도해주세요.';
                        setError(liveStreamError);
                        announcePolite(liveStreamError);
                    } else {
                        const errorMessage = data.details || data.message || '알 수 없는 오류가 발생했습니다.';
                        setError(errorMessage);
                        announcePolite(`오류: ${errorMessage}`);
                    }
                } catch (parseError) {
                    console.error('Failed to parse backend error event:', parseError, errorPayload);
                    setError('서버에서 알 수 없는 오류가 발생했습니다.');
                    announcePolite('오류: 서버에서 알 수 없는 오류');
                }
            } else if (errorType === 'network') {
                if (isDuplicate) return;
                console.error('EventSource failed:', errorPayload);
                setError(currentError => {
                    if (currentError) return currentError;
                    const errorMsg = '대본 생성 중 네트워크 오류가 발생했습니다. 인터넷 연결을 확인해주세요.';
                    announcePolite(`오류: ${errorMsg}`);
                    return errorMsg;
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
        if (verbosity === 0) return [];

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
        
        // Only pause if the video has actually started playing.
        // This prevents the video from pausing at timestamp 0.
        if (player.getCurrentTime() > 0.5) {
            player.pauseVideo();
        }

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
            
            const currentTime = player.getCurrentTime();

            // This robust logic handles sequential playback and backward seeks.
            // Find what the current index *should* be based on the video's current time.
            const correctLineIndex = filteredScript.findLastIndex(line => currentTime >= line.timestamp);

            // If the user seeks backward, this resets the index to the correct position.
            if (correctLineIndex < lastSpokenIndexRef.current) {
                console.log('Seek-back detected. Resetting last spoken index.');
                lastSpokenIndexRef.current = correctLineIndex;
            }

            // Find the next script to play sequentially from the last known point.
            const nextScriptIndex = lastSpokenIndexRef.current + 1;
            if (nextScriptIndex < filteredScript.length) {
                const nextScript = filteredScript[nextScriptIndex];
                if (currentTime >= nextScript.timestamp) {
                    console.log(`Playing script at index ${nextScriptIndex} for time ${currentTime}`);
                    lastSpokenIndexRef.current = nextScriptIndex;
                    playDescription(nextScript);
                }
            }
        }, 250);

        return () => clearInterval(intervalId);
    }, [isPlaying, player, filteredScript, playDescription]);

    const handleVerbosityChange = (level) => {
        setVerbosity(level);
        const label = { 0: '없음', ...verbosityLabels }[level];
        announcePolite(`상세 수준이 ${label}으로 변경되었습니다.`);
        
        // Reset last spoken index when verbosity changes, as filteredScript is now different
        if (player && typeof player.getCurrentTime === 'function') {
            const currentTime = player.getCurrentTime();
            lastSpokenIndexRef.current = filteredScript.findLastIndex(line => currentTime >= line.timestamp);
        }
    };

    const playAndUnlockAudio = useCallback(() => {
        console.log("playAndUnlockAudio: 함수 시작.");
        const audioPlayer = audioPlayerRef.current;
        if (!player || !audioPlayer) {
            console.error("playAndUnlockAudio: player 또는 audioPlayer가 준비되지 않음.");
            if (player) player.playVideo();
            return;
        }

        const startVideoPlayback = () => {
            console.log("playAndUnlockAudio: startVideoPlayback 호출됨.");
            if (player) {
                // When starting the video, duck the volume if the 0-sec script was just played
                if (isTtsPlayingRef.current) {
                    player.setVolume(30);
                }
                player.playVideo();
            }
            audioPlayer.removeEventListener('ended', startVideoPlayback);
            audioPlayer.removeEventListener('error', startVideoPlayback);
        };

        audioPlayer.addEventListener('ended', startVideoPlayback);
        audioPlayer.addEventListener('error', startVideoPlayback);

        const scriptAtZero = filteredScript.find(line => line.timestamp === 0);

        if (scriptAtZero) {
            console.log("playAndUnlockAudio: 0초 스크립트 발견.", scriptAtZero);
            lastSpokenIndexRef.current = 0;
            isTtsPlayingRef.current = true; // Signal that a description is playing

            // This function is a simplified version of playAudioFromUrl for this specific case
            const playFromUrl = (url) => {
                console.log("playAndUnlockAudio: playFromUrl 호출됨, URL:", url);
                audioPlayer.src = url;
                audioPlayer.volume = 1.0;
                audioPlayer.playbackRate = 1.3;
                audioPlayer.play().catch(e => {
                    console.error("playAndUnlockAudio: 0초 스크립트 재생 실패, 비디오를 대신 시작합니다.", e);
                    startVideoPlayback();
                });
            };

            if (audioCache.current.has(scriptAtZero.id)) {
                console.log("playAndUnlockAudio: 스크립트가 캐시에 있습니다.");
                playFromUrl(audioCache.current.get(scriptAtZero.id));
            } else {
                console.log("playAndUnlockAudio: 스크립트가 캐시에 없습니다. TTS API를 호출합니다.");
                axios.post(`/api/tts`, { text: scriptAtZero.text }, { responseType: 'blob' })
                    .then(response => {
                        console.log("playAndUnlockAudio: TTS API 호출 성공.");
                        const audioUrl = URL.createObjectURL(response.data);
                        audioCache.current.set(scriptAtZero.id, audioUrl);
                        playFromUrl(audioUrl);
                    })
                    .catch(err => {
                        console.error("playAndUnlockAudio: 0초 스크립트 TTS 호출 실패, 비디오를 대신 시작합니다.", err);
                        startVideoPlayback();
                    });
            }
        } else {
            console.log("playAndUnlockAudio: 0초 스크립트 없음. 무음 오디오를 재생합니다.");
            isTtsPlayingRef.current = false;
            audioPlayer.src = SILENT_AUDIO;
            audioPlayer.volume = 0;
            audioPlayer.play().catch(e => {
                console.error("playAndUnlockAudio: 무음 오디오 재생 실패, 비디오를 대신 시작합니다.", e);
                startVideoPlayback();
            });
        }
    }, [player, filteredScript, audioCache, isTtsPlayingRef]);

    const handleTogglePlay = () => {
        if (!player) return;

        const playerState = player.getPlayerState();
        if (playerState === 1) { // 1 means playing
            player.pauseVideo();
            return;
        }

        if (!isInteractionDone) {
            setIsInteractionDone(true);
            playAndUnlockAudio(); // Call the new, dedicated function for the first play
        } else {
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
                                controls: 0,
                                rel: 0,
                                iv_load_policy: 3,
                                playsinline: 1
                            }
                        }}
                        onReady={(e) => setPlayer(e.target)}
                        onStateChange={(e) => {
                            const isNowPlaying = e.data === window.YT.PlayerState.PLAYING;
                            setIsPlaying(isNowPlaying);
                        }}
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
                <h2 ref={headingRef}>{videoInfo.title}</h2>
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

export default PlayerScreen;
