import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import axios from 'axios';
import { usePageFocus } from '../hooks';
import { useAccessibility } from '../contexts/AccessibilityContext';
import './PostScreen.css';

function PostScreen() {
  const { announcePolite, announceAssertive } = useAccessibility();
  const { postId } = useParams();
  const [post, setPost] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const contentRef = useRef(null);
  const nicknameRef = useRef(null);
  const passwordRef = useRef(null);
  const pageTitleRef = useRef(null);

  usePageFocus(pageTitleRef);

  const [commentError, setCommentError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fetchPost = useCallback(async () => {
    try {
      setLoading(true);
      const response = await axios.get(`/api/board/posts/${postId}`);
      setPost(response.data);
    } catch (err) {
      const errorMsg = '게시글을 불러오는 데 실패했습니다.';
      setError(errorMsg);
      announceAssertive(errorMsg);
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [postId, announceAssertive]);

  useEffect(() => {
    fetchPost();
  }, [fetchPost]);

  const handleCommentSubmit = async (e) => {
    e.preventDefault();
    
    const content = contentRef.current.value;
    const nickname = nicknameRef.current.value;
    const password = passwordRef.current.value;

    if (!content || !nickname || !password) {
      setCommentError('모든 필드를 입력해주세요.');
      return;
    }

    setIsSubmitting(true);
    setCommentError('');

    try {
      await axios.post(`/api/board/posts/${postId}/comments`, {
        content,
        nickname,
        password,
      });
      
      announcePolite('댓글이 성공적으로 작성되었습니다.');
      contentRef.current.value = '';
      nicknameRef.current.value = '';
      passwordRef.current.value = '';
      fetchPost(); // Re-fetch the post to show the new comment
    } catch (err) {
      const errorMsg = '댓글 작성에 실패했습니다.';
      setCommentError(errorMsg);
      announceAssertive(errorMsg);
      console.error(err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const formatDate = (dateString) => {
    const options = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' };
    return new Date(dateString).toLocaleString('ko-KR', options);
  };

  if (loading) {
    return <p>게시글을 불러오는 중...</p>;
  }

  if (error) {
    return <p className="error-message">{error}</p>;
  }

  if (!post) {
    return <p>게시글을 찾을 수 없습니다.</p>;
  }

  return (
    <div className="post-container">
      <div className="post-header">
        <h1 ref={pageTitleRef}>{post.title}</h1>
        <div className="post-meta">
          <span>작성자: {post.nickname}</span>
          <span>작성일: {formatDate(post.createdAt)}</span>
        </div>
      </div>

      <div className="post-content" dangerouslySetInnerHTML={{ __html: post.content.replace(/\n/g, '<br />') }}></div>
      
      <div className="post-actions">
          <Link to="/board" className="btn">목록으로</Link>
      </div>

      <hr />

      <div className="comments-section">
        <h2>댓글 ({post.comments.length})</h2>
        <ul className="comment-list">
          {post.comments.map(comment => (
            <li key={comment.id} className="comment-item">
              <div className="comment-header">
                <strong>{comment.nickname}</strong>
                <span>{formatDate(comment.createdAt)}</span>
              </div>
              <p>{comment.content}</p>
            </li>
          ))}
        </ul>

        <form onSubmit={handleCommentSubmit} className="comment-form">
          <h3>댓글 작성</h3>
          {commentError && <p className="error-message">{commentError}</p>}
          <div className="form-group">
            <label htmlFor="comment-nickname">닉네임</label>
            <input
              type="text"
              id="comment-nickname"
              ref={nicknameRef}
              defaultValue=""
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="comment-password">비밀번호</label>
            <input
              type="password"
              id="comment-password"
              ref={passwordRef}
              defaultValue=""
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="comment-content">내용</label>
            <textarea
              id="comment-content"
              ref={contentRef}
              defaultValue=""
              required
              rows="3"
            ></textarea>
          </div>
          <button type="submit" disabled={isSubmitting}>
            {isSubmitting ? '등록 중...' : '댓글 등록'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default PostScreen;
