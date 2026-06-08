import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import axios from 'axios';
import { usePageFocus } from '../hooks';
import { useAccessibility } from '../contexts/AccessibilityContext';
import { useAuth } from '../contexts/AuthContext';
import Header from '../components/Header';
import './PostScreen.css';

function PostScreen() {
  const { announcePolite, announceAssertive } = useAccessibility();
  const { postId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  
  const [post, setPost] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  
  const pageTitleRef = useRef(null);
  usePageFocus(pageTitleRef);

  // Post Edit Mode State
  const [isEditingPost, setIsEditingPost] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');

  // Comment Creation & Inline Edit State
  const [commentContent, setCommentContent] = useState('');
  const [commentError, setCommentError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [editingCommentId, setEditingCommentId] = useState(null);
  const [editCommentContent, setEditCommentContent] = useState('');

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

  const handleStartEditPost = () => {
    setEditTitle(post.title);
    setEditContent(post.content);
    setIsEditingPost(true);
  };

  const handleSavePost = async (e) => {
    e.preventDefault();
    if (!editTitle.trim() || !editContent.trim()) {
      alert('제목과 내용을 모두 입력해 주세요.');
      return;
    }
    try {
      await axios.put(`/api/board/posts/${postId}`, {
        title: editTitle.trim(),
        content: editContent.trim()
      });
      announcePolite('글이 성공적으로 수정되었습니다.');
      setIsEditingPost(false);
      fetchPost();
    } catch (err) {
      alert(err.response?.data?.error || '글 수정에 실패했습니다.');
    }
  };

  const handleDeletePost = async () => {
    if (!window.confirm('정말 이 게시글을 삭제하시겠습니까?')) return;
    try {
      await axios.delete(`/api/board/posts/${postId}`);
      announcePolite('게시글이 삭제되었습니다.');
      navigate('/board', { replace: true });
    } catch (err) {
      alert(err.response?.data?.error || '삭제 실패');
    }
  };

  const handleCommentSubmit = async (e) => {
    e.preventDefault();
    if (!commentContent.trim()) {
      setCommentError('댓글 내용을 입력해주세요.');
      return;
    }
    setIsSubmitting(true);
    setCommentError('');

    try {
      await axios.post(`/api/board/posts/${postId}/comments`, {
        content: commentContent.trim()
      });
      announcePolite('댓글이 성공적으로 작성되었습니다.');
      setCommentContent('');
      fetchPost();
    } catch (err) {
      const errorMsg = err.response?.data?.error || '댓글 작성에 실패했습니다.';
      setCommentError(errorMsg);
      announceAssertive(errorMsg);
      console.error(err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStartEditComment = (comment) => {
    setEditingCommentId(comment.id);
    setEditCommentContent(comment.content);
  };

  const handleSaveEditComment = async (commentId) => {
    if (!editCommentContent.trim()) {
      alert('댓글 내용을 입력해주세요.');
      return;
    }
    try {
      await axios.put(`/api/board/comments/${commentId}`, {
        content: editCommentContent.trim()
      });
      setEditingCommentId(null);
      fetchPost();
    } catch (err) {
      alert(err.response?.data?.error || '댓글 수정 실패');
    }
  };

  const handleDeleteComment = async (commentId) => {
    if (!window.confirm('댓글을 정말 삭제하시겠습니까?')) return;
    try {
      await axios.delete(`/api/board/comments/${commentId}`);
      fetchPost();
    } catch (err) {
      alert(err.response?.data?.error || '댓글 삭제 실패');
    }
  };

  const formatDate = (dateString) => {
    const options = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' };
    return new Date(dateString).toLocaleString('ko-KR', options);
  };

  if (loading) {
    return (
        <>
            <Header title="게시글 불러오는 중..." />
            <p>게시글을 불러오는 중...</p>
        </>
    );
  }

  if (error) {
    return (
        <>
            <Header title="오류" />
            <p className="error-message">{error}</p>
        </>
    );
  }

  if (!post) {
    return (
        <>
            <Header title="게시글 없음" />
            <p>게시글을 찾을 수 없습니다.</p>
        </>
    );
  }

  const isPostOwner = user && post.userId === user.id;

  return (
    <div className="post-container">
      <Header title={isEditingPost ? "게시글 수정" : post.title} ref={pageTitleRef} />
      
      {isEditingPost ? (
        <form onSubmit={handleSavePost} className="post-edit-form">
          <div className="form-group" style={{ display: 'flex', flexDirection: 'column', marginBottom: '15px' }}>
            <label htmlFor="edit-title" style={{ fontWeight: 'bold', marginBottom: '5px' }}>제목</label>
            <input
              type="text"
              id="edit-title"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              required
              style={{ background: 'var(--glass-bg-input)', border: 'var(--glass-border-input)', padding: '10px', borderRadius: '8px', color: 'var(--color-text-bright)' }}
            />
          </div>
          <div className="form-group" style={{ display: 'flex', flexDirection: 'column', marginBottom: '15px' }}>
            <label htmlFor="edit-content" style={{ fontWeight: 'bold', marginBottom: '5px' }}>내용</label>
            <textarea
              id="edit-content"
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              required
              rows="10"
              style={{ background: 'var(--glass-bg-input)', border: 'var(--glass-border-input)', padding: '10px', borderRadius: '8px', color: 'var(--color-text-bright)' }}
            ></textarea>
          </div>
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button type="submit" style={{ padding: '8px 16px', background: 'var(--gradient-accent)', border: 'none', borderRadius: '6px', color: '#fff', fontWeight: 'bold', cursor: 'pointer' }}>저장</button>
            <button type="button" onClick={() => setIsEditingPost(false)} style={{ padding: '8px 16px', background: 'var(--glass-bg)', border: 'var(--glass-border-light)', borderRadius: '6px', color: 'var(--color-text-main)', cursor: 'pointer' }}>취소</button>
          </div>
        </form>
      ) : (
        <>
          <div className="post-meta" role="group" aria-label={`작성자: ${post.nickname}, 작성일: ${formatDate(post.createdAt)}`} tabIndex="0">
              <span aria-hidden="true">작성자: {post.nickname}</span>
              <span aria-hidden="true">작성일: {formatDate(post.createdAt)}</span>
              {isPostOwner && (
                <div className="post-owner-actions" style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
                  <button onClick={handleStartEditPost} style={{ background: 'var(--glass-bg)', border: 'var(--glass-border-light)', padding: '2px 8px', borderRadius: '4px', color: 'var(--color-text-bright)', fontSize: '0.8rem', cursor: 'pointer' }}>수정</button>
                  <button onClick={handleDeletePost} style={{ background: 'rgba(239, 68, 68, 0.2)', border: '1px solid rgba(239, 68, 68, 0.4)', padding: '2px 8px', borderRadius: '4px', color: '#f87171', fontSize: '0.8rem', cursor: 'pointer' }}>삭제</button>
                </div>
              )}
          </div>

          <div className="post-content" dangerouslySetInnerHTML={{ __html: post.content.replace(/\n/g, '<br />') }}></div>
        </>
      )}

      <hr />

      <div className="comments-section">
        <h2 aria-label={`댓글 ${post.comments.length}개`}>
          <span aria-hidden="true">댓글 ({post.comments.length})</span>
        </h2>
        <ul className="comment-list">
          {post.comments.map(comment => {
            const isCommentOwner = user && comment.userId === user.id;
            const isEditingComment = editingCommentId === comment.id;

            return (
              <li key={comment.id} className="comment-item">
                {isEditingComment ? (
                  <div className="comment-edit-container" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <textarea
                      value={editCommentContent}
                      onChange={(e) => setEditCommentContent(e.target.value)}
                      rows="3"
                      style={{ background: 'var(--glass-bg-input)', border: 'var(--glass-border-input)', padding: '8px', borderRadius: '6px', color: 'var(--color-text-bright)', width: '100%' }}
                    />
                    <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                      <button onClick={() => handleSaveEditComment(comment.id)} style={{ padding: '4px 10px', background: 'var(--gradient-accent)', border: 'none', borderRadius: '4px', color: '#fff', fontSize: '0.8rem', cursor: 'pointer' }}>저장</button>
                      <button onClick={() => setEditingCommentId(null)} style={{ padding: '4px 10px', background: 'var(--glass-bg)', border: 'var(--glass-border-light)', borderRadius: '4px', color: 'var(--color-text-main)', fontSize: '0.8rem', cursor: 'pointer' }}>취소</button>
                    </div>
                  </div>
                ) : (
                  <div 
                    tabIndex="0"
                    role="group"
                    aria-label={`댓글. 작성자: ${comment.nickname}, 작성일: ${formatDate(comment.createdAt)}, 내용: ${comment.content}`}
                  >
                    <div className="comment-header" aria-hidden="true">
                      <div>
                        <strong>{comment.nickname}</strong>
                        <span style={{ marginLeft: '10px' }}>{formatDate(comment.createdAt)}</span>
                      </div>
                      {isCommentOwner && (
                        <div style={{ display: 'flex', gap: '6px' }}>
                          <button onClick={() => handleStartEditComment(comment)} style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', fontSize: '0.8rem', cursor: 'pointer', textDecoration: 'underline' }}>수정</button>
                          <button onClick={() => handleDeleteComment(comment.id)} style={{ background: 'none', border: 'none', color: '#f87171', fontSize: '0.8rem', cursor: 'pointer', textDecoration: 'underline' }}>삭제</button>
                        </div>
                      )}
                    </div>
                    <p aria-hidden="true" style={{ whiteSpace: 'pre-wrap' }}>{comment.content}</p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        {user ? (
          <form onSubmit={handleCommentSubmit} className="comment-form">
            <h3>댓글 작성</h3>
            {commentError && <p className="error-message" role="alert">{commentError}</p>}
            <div className="form-group">
              <label htmlFor="comment-author">작성자</label>
              <input
                type="text"
                id="comment-author"
                value={user.name}
                readOnly
                disabled
              />
            </div>
            <div className="form-group">
              <label htmlFor="comment-content">내용</label>
              <textarea
                id="comment-content"
                value={commentContent}
                onChange={(e) => setCommentContent(e.target.value)}
                required
                rows="3"
              ></textarea>
            </div>
            <button type="submit" disabled={isSubmitting}>
              {isSubmitting ? '등록 중...' : '댓글 등록'}
            </button>
          </form>
        ) : (
          <div className="comment-login-prompt" style={{ padding: '20px', background: 'var(--glass-bg)', border: 'var(--glass-border-light)', borderRadius: '12px', textAlign: 'center', marginTop: '20px' }}>
            <p style={{ margin: '0 0 10px 0', color: 'var(--color-text-muted)' }}>댓글을 작성하려면 로그인이 필요합니다.</p>
            <Link to="/login" className="btn btn-primary" style={{ display: 'inline-block', textDecoration: 'none' }}>로그인하러 가기</Link>
          </div>
        )}
      </div>
    </div>
  );
}

export default PostScreen;
