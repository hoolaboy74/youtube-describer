import React, { useState, useRef } from 'react';
import { usePageFocus } from '../hooks';
import './VoiceSampleScreen.css';

const voiceList = [
    { id: 'ko-KR-Wavenet-A', name: 'Wavenet A (여성)', desc: '현재 사용 중인 기본 목소리', gender: 'female' },
    { id: 'ko-KR-Wavenet-B', name: 'Wavenet B (여성)', desc: '차분하고 부드러운 톤', gender: 'female' },
    { id: 'ko-KR-Wavenet-C', name: 'Wavenet C (남성)', desc: '굵고 신뢰감 있는 톤', gender: 'male' },
    { id: 'ko-KR-Wavenet-D', name: 'Wavenet D (남성)', desc: '부드러운 남성 목소리', gender: 'male' },
    { id: 'ko-KR-Neural2-A', name: 'Neural2 A (여성)', desc: '가장 자연스러운 최신 기술', gender: 'female' },
    { id: 'ko-KR-Neural2-B', name: 'Neural2 B (여성)', desc: '뉴스 아나운서 스타일', gender: 'female' },
    { id: 'ko-KR-Neural2-C', name: 'Neural2 C (남성)', desc: '차분한 최신 기술 남성음', gender: 'male' },
];

function VoiceSampleScreen() {
    const headerRef = useRef(null);
    usePageFocus(headerRef);
    const [playingId, setPlayingId] = useState(null);
    const audioRef = useRef(new Audio());

    const handlePlay = (voiceId) => {
        // 기존 재생 중인 것이 있다면 중지
        audioRef.current.pause();

        // 같은 걸 다시 누르면 멈춤 (토글)
        if (playingId === voiceId) {
            setPlayingId(null);
            return;
        }

        // 새 파일 재생
        audioRef.current.src = `/voice_samples/${voiceId}.mp3`;
        audioRef.current.play()
            .then(() => {
                setPlayingId(voiceId);
            })
            .catch(err => {
                console.error("Audio play failed", err);
                alert("재생할 수 없습니다.");
            });

        // 재생 끝나면 상태 초기화
        audioRef.current.onended = () => {
            setPlayingId(null);
        };
    };

    return (
        <div className="voice-sample-container">
            <h1 ref={headerRef}>목소리 샘플 들어보기</h1>
            <p className="description">
                뷰레이터에서 제공 가능한 다양한 AI 성우들의 목소리입니다.<br/>
                재생 버튼을 눌러 미리 들어보세요.
            </p>

            <ul className="voice-list">
                {voiceList.map((voice) => (
                    <li key={voice.id} className={`voice-item ${playingId === voice.id ? 'playing' : ''}`}>
                        <div className="voice-info">
                            <h2>{voice.name}</h2>
                            <p>{voice.desc}</p>
                        </div>
                        <button 
                            className="play-button"
                            onClick={() => handlePlay(voice.id)}
                            aria-label={`${voice.name} 미리듣기 ${playingId === voice.id ? '중지' : '재생'}`}
                        >
                            {playingId === voice.id ? '■ 중지' : '▶ 재생'}
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    );
}

export default VoiceSampleScreen;
