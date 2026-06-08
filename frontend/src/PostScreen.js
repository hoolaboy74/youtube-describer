import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { usePageFocus } from './hooks';
import { useAuth } from './contexts/AuthContext';
import './PostScreen.css';

function PostScreen({ announcePolite, announceAssertive }) {
  const { postId } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [post, setPost] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Post edit state
  const [isEditingPost, setIsEditingPost] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');

  // Comment edit state
  const [editingComment, setEditingComment] = useState(null); // { id, content }

  const commentContentRef = useRef(null);
  const commentNicknameRef = useRef(null);
  const pageTitleRef = useRef(null);
  const editCommentContentRef = useRef(null);

  usePageFocus(pageTitleRef);

  const [commentError, setCommentError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fetchPost = useCallback(async () => {
    try {
      setLoading(true);
      const response = await axios.get(`/api/board/posts/${postId}`);
      setPost(response.data);
      setEditTitle(response.data.title);
      setEditContent(response.data.content);
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

  const handlePostUpdate = async (e) => {
    e.preventDefault();
    if (!editTitle.trim() || !editContent.trim()) {
      alert('제목과 내용을 모두 입력해주세요.');
      return;
    }

    try {
      await axios.put(`/api/board/posts/${postId}`, {
        title: editTitle.trim(),
        content: editContent.trim(),
      });
      setIsEditingPost(false);
      fetchPost();
      announcePolite('게시글이 성공적으로 수정되었습니다.');
    } catch (err) {
      console.error('Failed to update post:', err);
      alert(err.response?.data?.error || '게시글 수정에 실패했습니다.');
    }
  };

  const handlePostDelete = async () => {
    if (!window.confirm('정말로 이 게시글을 삭제하시겠습니까?')) return;

    try {
      await axios.delete(`/api/board/posts/${postId}`);
      announcePolite('게시글이 삭제되었습니다.');
      navigate('/board');
    } catch (err) {
      console.error('Failed to delete post:', err);
      alert(err.response?.data?.error || '게시글 삭제에 실패했습니다.');
    }
  };

  const handleCommentSubmit = async (e) => {
    e.preventDefault();
    if (!user) {
      setCommentError('로그인이 필요합니다.');
      return;
    }
    
    const content = commentContentRef.current.value;
    const nickname = commentNicknameRef.current.value;

    if (!content.trim() || !nickname.trim()) {
      setCommentError('모든 필드를 입력해주세요.');
      return;
    }

    setIsSubmitting(true);
    setCommentError('');

    try {
      await axios.post(`/api/board/posts/${postId}/comments`, {
        content: content.trim(),
        nickname: nickname.trim(),
      });
      
      announcePolite('댓글이 성공적으로 작성되었습니다.');
      commentContentRef.current.value = '';
      if (commentNicknameRef.current) {
        commentNicknameRef.current.value = user.name || '';
      }
      fetchPost();
    } catch (err) {
      const errorMsg = '댓글 작성에 실패했습니다.';
      setCommentError(errorMsg);
      announceAssertive(errorMsg);
      console.error(err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCommentDelete = async (commentId) => {
    if (!window.confirm('정말로 이 댓글을 삭제하시겠습니까?')) return;

    try {
      await axios.delete(`/api/board/comments/${commentId}`);
      announcePolite('댓글이 삭제되었습니다.');
      fetchPost();
    } catch (err) {
      console.error('Failed to delete comment:', err);
      alert(err.response?.data?.error || '댓글 삭제에 실패했습니다.');
    }
  };

  const handleCommentUpdate = async (e) => {
    e.preventDefault();
    const newContent = editCommentContentRef.current.value;
    if (!newContent.trim()) {
      alert('내용을 입력해주세요.');
      return;
    }

    try {
      await axios.put(`/api/board/comments/${editingComment.id}`, {
        content: newContent.trim()
      });
      setEditingComment(null);
      fetchPost();
      announcePolite('댓글이 수정되었습니다.');
    } catch (err) {
      console.error('Failed to update comment:', err);
      alert(err.response?.data?.error || '댓글 수정에 실패했습니다.');
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
      {isEditingPost ? (
        <form onSubmit={handlePostUpdate} className="post-edit-form">
          <div className="form-group">
            <label htmlFor="edit-title">제목</label>
            <input
              type="text"
              id="edit-title"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="edit-content">내용</label>
            <textarea
              id="edit-content"
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              required
              rows="10"
            ></textarea>
          </div>
          <div className="form-actions">
            <button type="submit" className="btn">저장</button>
            <button type="button" onClick={() => setIsEditingPost(false)} className="btn btn-secondary">취소</button>
          </div>
        </form>
      ) : (
        <>
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
              {user && user.id === post.userId && (
                <>
                  <button onClick={() => setIsEditingPost(true)} className="btn">수정</button>
                  <button onClick={handlePostDelete} className="btn btn-danger">삭제</button>
                </>
              )}
          </div>
        </>
      )}

      <hr />

      <div className="comments-section">
        <h2>댓글 ({post.comments.length})</h2>
        <ul className="comment-list">
          {post.comments.map(comment => (
            <li key={comment.id} className="comment-item">
              {editingComment && editingComment.id === comment.id ? (
                <form onSubmit={handleCommentUpdate} className="comment-edit-form">
                  <textarea
                    ref={editCommentContentRef}
                    defaultValue={comment.content}
                    required
                  ></textarea>
                  <div className="comment-actions">
                    <button type="submit">저장</button>
                    <button type="button" onClick={() => setEditingComment(null)}>취소</button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="comment-header">
                    <strong>{comment.nickname}</strong>
                    <span>{formatDate(comment.createdAt)}</span>
                  </div>
                  <p>{comment.content}</p>
                  {user && user.id === comment.userId && (
                    <div className="comment-actions">
                      <button onClick={() => setEditingComment(comment)}>수정</button>
                      <button onClick={() => handleCommentDelete(comment.id)}>삭제</button>
                    </div>
                  )}
                </>
              )}
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
              ref={commentNicknameRef}
              defaultValue={user ? user.name || '' : ''}
              required
              disabled={!user}
              placeholder={user ? "닉네임" : "로그인이 필요합니다"}
            />
          </div>
          <div className="form-group">
            <label htmlFor="comment-content">내용</label>
            <textarea
              id="comment-content"
              ref={commentContentRef}
              defaultValue=""
              required
              rows="3"
              disabled={!user}
              placeholder={user ? "댓글을 입력하세요..." : "댓글을 작성하려면 로그인이 필요합니다."}
            ></textarea>
          </div>
          <button type="submit" disabled={isSubmitting || !user}>
            {isSubmitting ? '등록 중...' : '댓글 등록'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default PostScreen;
