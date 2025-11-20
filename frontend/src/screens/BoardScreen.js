import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { usePageFocus } from '../hooks';
import { useAccessibility } from '../contexts/AccessibilityContext';
import './BoardScreen.css';

function BoardScreen() {
  const { announceAssertive } = useAccessibility();
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sortBy, setSortBy] = useState('newest');
  const titleRef = useRef(null);

  usePageFocus(titleRef);

  useEffect(() => {
    const fetchPosts = async () => {
      try {
        setLoading(true);
        const response = await axios.get(`/api/board/posts?sortBy=${sortBy}`);
        setPosts(response.data.posts || []);
      } catch (err) {
        const errorMsg = '게시글 목록을 불러오는 데 실패했습니다.';
        setError(errorMsg);
        announceAssertive(errorMsg);
        console.error(err);
      } finally {
        setLoading(false);
      }
    };

    fetchPosts();
  }, [sortBy, announceAssertive]);

  const formatDate = (dateString) => {
    const options = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' };
    return new Date(dateString).toLocaleString('ko-KR', options);
  };

  return (
    <div className="board-container">
      <div className="board-header">
        <h1 ref={titleRef}>와글와글 게시판</h1>
        <Link to="/board/create" className="btn btn-primary">새 글 작성</Link>
      </div>

      <div className="sort-options">
        <button onClick={() => setSortBy('newest')} className={sortBy === 'newest' ? 'active' : ''}>최신순</button>
        <button onClick={() => setSortBy('comments')} className={sortBy === 'comments' ? 'active' : ''}>댓글 많은 순</button>
      </div>

      {loading && <p>게시글을 불러오는 중...</p>}
      {error && <p className="error-message">{error}</p>}
      
      {!loading && !error && (
        <ul className="post-list">
          {posts.length > 0 ? (
            posts.map(post => (
              <li key={post.id} className={post.is_notice ? 'notice-post' : ''}>
                <Link 
                  to={`/board/${post.id}`} 
                  className="post-link"
                  aria-label={`${post.is_notice ? '공지사항,' : ''} 제목: ${post.title}, 작성자: ${post.nickname}, 댓글: ${post.commentCount}개`}
                >
                  <div className="post-title" aria-hidden="true">
                    {post.is_notice && <strong>[공지] </strong>}
                    {post.title}
                  </div>
                  <div className="post-meta" aria-hidden="true">
                    <span>{post.nickname}</span>
                    <span>{formatDate(post.createdAt)}</span>
                    <span>댓글: {post.commentCount}</span>
                  </div>
                </Link>
              </li>
            ))
          ) : (
            <p>아직 작성된 글이 없습니다.</p>
          )}
        </ul>
      )}
    </div>
  );
}

export default BoardScreen;
