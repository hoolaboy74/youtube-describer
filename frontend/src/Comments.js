import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';

function Comments({ videoId, mainRef }) {
    const [comments, setComments] = useState([]);
    const [editingComment, setEditingComment] = useState(null); // { id, content }
    const [error, setError] = useState('');

    // Refs for the new comment form
    const nicknameRef = useRef(null);
    const passwordRef = useRef(null);
    const contentRef = useRef(null);

    // Ref for the comment edit form
    const editContentRef = useRef(null);

    const fetchComments = useCallback(async () => {
        try {
            const response = await axios.get(`/api/comments/${videoId}`);
            setComments(response.data);
        } catch (err) {
            console.error("Failed to fetch comments:", err);
            setError("댓글을 불러오는 데 실패했습니다.");
        }
    }, [videoId]);

    useEffect(() => {
        if (videoId) {
            fetchComments();
        }
    }, [videoId, fetchComments]);

    const handleSubmit = async (e) => {
        e.preventDefault();
        const nickname = nicknameRef.current.value;
        const password = passwordRef.current.value;
        const content = contentRef.current.value;

        if (!nickname || !password || !content) {
            setError("닉네임, 비밀번호, 내용을 모두 입력해주세요.");
            return;
        }
        try {
            await axios.post('/api/comments', { videoId, nickname, password, content });
            nicknameRef.current.value = '';
            passwordRef.current.value = '';
            contentRef.current.value = '';
            setError('');
            fetchComments();
        } catch (err) {
            console.error("Failed to add comment:", err);
            setError("댓글 작성에 실패했습니다.");
        }
    };

    const handleDelete = async (commentId) => {
        const pw = prompt("댓글을 삭제하려면 비밀번호를 입력하세요.");
        if (!pw) return;

        try {
            await axios.delete(`/api/comments/${commentId}`, { data: { password: pw } });
            fetchComments();
            mainRef.current?.focus();
        } catch (err) {
            console.error("Failed to delete comment:", err);
            alert(err.response?.data?.error || "댓글 삭제에 실패했습니다.");
        }
    };

    const handleEdit = (comment) => {
        setEditingComment(comment);
    };

    const handleUpdate = async (e) => {
        e.preventDefault();
        const newContent = editContentRef.current.value;
        if (!newContent) {
            alert("내용을 입력해주세요.");
            return;
        }

        const pw = prompt("댓글을 수정하려면 비밀번호를 입력하세요.");
        if (!pw) return;

        try {
            await axios.put(`/api/comments/${editingComment.id}`, {
                password: pw,
                content: newContent
            });
            setEditingComment(null);
            fetchComments();
            mainRef.current?.focus();
        } catch (err) {
            console.error("Failed to update comment:", err);
            alert(err.response?.data?.error || "댓글 수정에 실패했습니다.");
        }
    };

    return (
        <div className="comments-container">
            <h3>댓글</h3>
            {error && <p className="error-message">{error}</p>}
            <form onSubmit={handleSubmit} className="comment-form">
                <div className="comment-meta">
                    <input
                        type="text"
                        placeholder="닉네임"
                        ref={nicknameRef}
                        defaultValue=""
                        required
                    />
                    <input
                        type="password"
                        placeholder="비밀번호"
                        ref={passwordRef}
                        defaultValue=""
                        required
                    />
                </div>
                <textarea
                    placeholder="댓글을 입력하세요..."
                    ref={contentRef}
                    defaultValue=""
                    required
                ></textarea>
                <button type="submit">등록</button>
            </form>

            <ul className="comment-list">
                {comments.map((comment) => (
                    <li key={comment.id} className="comment-item">
                        {editingComment && editingComment.id === comment.id ? (
                            <form onSubmit={handleUpdate} className="comment-edit-form">
                                <textarea
                                    ref={editContentRef}
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
                                    <span className="comment-date">
                                        {new Date(comment.createdAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}
                                    </span>
                                </div>
                                <p>{comment.content}</p>
                                <div className="comment-actions">
                                    <button onClick={() => handleEdit(comment)}>수정</button>
                                    <button onClick={() => handleDelete(comment.id)}>삭제</button>
                                </div>
                            </>
                        )}
                    </li>
                ))}
            </ul>
        </div>
    );
}

export default Comments;
