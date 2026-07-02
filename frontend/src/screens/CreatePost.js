import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { usePageFocus } from '../hooks';
import { useAccessibility } from '../contexts/AccessibilityContext';
import { useAuth } from '../contexts/AuthContext';
import Header from '../components/Header';
import './CreatePost.css';

function CreatePost() {
  const { announcePolite, announceAssertive } = useAccessibility();
  const pageTitleRef = useRef(null);
  usePageFocus(pageTitleRef);
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  
  const [formData, setFormData] = useState({
    title: '',
    content: '',
    nickname: '',
    adminPassword: ''
  });
  const [isNotice, setIsNotice] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) {
      alert('로그인이 필요한 서비스입니다.');
      navigate('/login', { replace: true });
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (user) {
      setFormData(prev => ({ ...prev, nickname: prev.nickname || user.name }));
    }
  }, [user]);

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    const { title, content, nickname, adminPassword } = formData;

    if (!title.trim() || !content.trim()) {
      setError('제목과 내용은 필수입니다.');
      return;
    }
    if (title.trim().length < 2) {
        setError('제목은 2자 이상이어야 합니다.');
        return;
    }
    if (content.trim().length < 5) {
        setError('내용은 5자 이상이어야 합니다.');
        return;
    }

    if (isNotice && !adminPassword.trim()) {
      setError('공지로 등록하려면 관리자 비밀번호를 입력해야 합니다.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const payload = {
        title: title.trim(),
        content: content.trim(),
        nickname: nickname.trim(),
        is_notice: isNotice,
        adminPassword: isNotice ? adminPassword.trim() : undefined,
      };
      
      const response = await axios.post('/api/board/posts', payload);
      
      announcePolite('새 글이 성공적으로 작성되었습니다.');
      const newPostId = response.data.id;
      navigate(`/board/${newPostId}`, { replace: true });

    } catch (err) {
      const errorMsg = err.response?.data?.error || '글 작성에 실패했습니다. 다시 시도해주세요.';
      setError(errorMsg);
      announceAssertive(errorMsg);
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  if (authLoading || !user) {
    return (
      <div className="create-post-container">
        <Header title="로딩 중..." />
        <p>사용자 권한을 확인하고 있습니다...</p>
      </div>
    );
  }

  return (
    <div className="create-post-container">
      <Header title="새 글 작성" ref={pageTitleRef} />
      <form onSubmit={handleSubmit} className="create-post-form">
        {error && <p className="error-message" role="alert">{error}</p>}
        <div className="form-group">
          <label htmlFor="title">제목</label>
          <input
            type="text"
            id="title"
            name="title"
            value={formData.title}
            onChange={handleInputChange}
            required
          />
        </div>
        <div className="form-group">
          <label htmlFor="content">내용</label>
          <textarea
            id="content"
            name="content"
            value={formData.content}
            onChange={handleInputChange}
            required
            rows="10"
          ></textarea>
        </div>
        <div className="form-group">
          <label htmlFor="nickname">작성자 (닉네임)</label>
          <input
            type="text"
            id="nickname"
            name="nickname"
            value={formData.nickname}
            onChange={handleInputChange}
            required
          />
        </div>

        <div className="form-group notice-checkbox">
            <input 
                type="checkbox"
                id="isNotice"
                checked={isNotice}
                onChange={(e) => setIsNotice(e.target.checked)}
            />
            <label htmlFor="isNotice">공지로 등록</label>
        </div>

        {isNotice && (
            <div className="form-group">
                <label htmlFor="adminPassword">관리자 비밀번호</label>
                <input
                    type="password"
                    id="adminPassword"
                    name="adminPassword"
                    value={formData.adminPassword}
                    onChange={handleInputChange}
                    required={isNotice}
                />
            </div>
        )}

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
