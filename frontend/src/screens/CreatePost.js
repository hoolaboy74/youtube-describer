import React, { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { usePageFocus } from '../hooks';
import { useAccessibility } from '../contexts/AccessibilityContext';
import Header from '../components/Header';
import './CreatePost.css';

function CreatePost() {
  const { announcePolite, announceAssertive } = useAccessibility();
  const titleRef = useRef(null);
  const contentRef = useRef(null);
  const nicknameRef = useRef(null);
  const passwordRef = useRef(null);
  const pageTitleRef = useRef(null);

  usePageFocus(pageTitleRef);

  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    const title = titleRef.current.value;
    const content = contentRef.current.value;
    const nickname = nicknameRef.current.value;
    const password = passwordRef.current.value;

    if (!title || !content || !nickname || !password) {
      setError('모든 필드를 입력해주세요.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const response = await axios.post('/api/board/posts', {
        title,
        content,
        nickname,
        password,
      });
      
      announcePolite('새 글이 성공적으로 작성되었습니다.');
      const newPostId = response.data.id;
      navigate(`/board/${newPostId}`);

    } catch (err) {
      const errorMsg = '글 작성에 실패했습니다. 다시 시도해주세요.';
      setError(errorMsg);
      announceAssertive(errorMsg);
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="create-post-container">
      <Header title="새 글 작성" ref={pageTitleRef} />
      <form onSubmit={handleSubmit} className="create-post-form">
        {error && <p className="error-message">{error}</p>}
        <div className="form-group">
          <label htmlFor="title">제목</label>
          <input
            type="text"
            id="title"
            ref={titleRef}
            defaultValue=""
            required
          />
        </div>
        <div className="form-group">
          <label htmlFor="content">내용</label>
          <textarea
            id="content"
            ref={contentRef}
            defaultValue=""
            required
            rows="10"
          ></textarea>
        </div>
        <div className="form-group">
          <label htmlFor="nickname">닉네임</label>
          <input
            type="text"
            id="nickname"
            ref={nicknameRef}
            defaultValue=""
            required
          />
        </div>
        <div className="form-group">
          <label htmlFor="password">비밀번호 (수정/삭제 시 필요)</label>
          <input
            type="password"
            id="password"
            ref={passwordRef}
            defaultValue=""
            required
          />
        </div>
        <div className="form-actions">
            <button type="submit" disabled={loading}>
                {loading ? '작성 중...' : '작성'}
            </button>
        </div>
      </form>
    </div>
  );
}

export default CreatePost;
