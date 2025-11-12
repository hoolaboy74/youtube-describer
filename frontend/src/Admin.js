import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import './Admin.css';

const API_BASE_URL = process.env.NODE_ENV === 'development' ? 'http://localhost:4000/api' : '/api';

const api = axios.create({
    baseURL: API_BASE_URL,
});

const getInitialDonationState = () => {
    const today = new Date();
    return {
        donator_name: '',
        amount: '',
        year: today.getFullYear(),
        month: String(today.getMonth() + 1).padStart(2, '0'),
        day: String(today.getDate()).padStart(2, '0'),
        message: ''
    };
};

const Admin = () => {
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [password, setPassword] = useState('');

    const [summary, setSummary] = useState({ totalDonations: 0, totalApiCosts: 0, balance: 0 });
    const [donations, setDonations] = useState([]);
    const [costs, setCosts] = useState([]);
    const [videos, setVideos] = useState([]);
    const [activeTab, setActiveTab] = useState('dashboard');
    const [stats, setStats] = useState({
        totalVideos: 0,
        totalComments: 0,
        videosToday: 0,
        videosThisWeek: 0,
        videosThisMonth: 0,
        processingVideos: [],
        failedVideos: [],
        costToday: 0,
        costThisWeek: 0,
        costThisMonth: 0,
    });
    
    const [newDonation, setNewDonation] = useState(getInitialDonationState());

    const [videoFilters, setVideoFilters] = useState({ search: '', status: '' });
    const [videoPagination, setVideoPagination] = useState({ page: 1, limit: 20, totalVideos: 0 });
    const [searchTerm, setSearchTerm] = useState('');

    const [comments, setComments] = useState([]);
    const [commentPagination, setCommentPagination] = useState({ page: 1, limit: 20, totalComments: 0 });
    const [commentSearchTerm, setCommentSearchTerm] = useState('');
    const [debouncedCommentSearch, setDebouncedCommentSearch] = useState('');

    const [donationPagination, setDonationPagination] = useState({ page: 1, limit: 10, totalDonations: 0 });
    const [donationSearchTerm, setDonationSearchTerm] = useState('');
    const [debouncedDonationSearch, setDebouncedDonationSearch] = useState('');

    const [costPagination, setCostPagination] = useState({ page: 1, limit: 10, totalCosts: 0 });
    const [costSearchTerm, setCostSearchTerm] = useState('');
    const [debouncedCostSearch, setDebouncedCostSearch] = useState('');
    const [costSortOptions, setCostSortOptions] = useState({ sortBy: 'cost', sortOrder: 'DESC' });

    const [settings, setSettings] = useState({
        videoDurationLimit: '30',
        processingPaused: 'false',
        exchangeRate: '1400',
        notice_title: '',
        notice_content: '',
    });

    const fetchSettings = useCallback(async () => {
        if (!isAuthenticated) return;
        try {
            const res = await api.get('/admin/settings');
            // Ensure all setting fields exist to prevent uncontrolled component warnings
            setSettings(prev => ({
                ...prev,
                ...res.data,
                notice_title: res.data.notice_title || '',
                notice_content: res.data.notice_content || '',
            }));
        } catch (error) {
            console.error('Failed to fetch settings', error);
        }
    }, [isAuthenticated]);

    const handleSaveSettings = async () => {
        if (!isAuthenticated) return;
        if (window.confirm('설정을 저장하시겠습니까?')) {
            try {
                await api.put('/admin/settings', settings);
                alert('설정이 성공적으로 저장되었습니다.');
                // Re-fetch summary data in case exchange rate changed
                fetchAllData();
            } catch (error) {
                console.error('Failed to save settings', error);
                alert('설정 저장에 실패했습니다.');
            }
        }
    };

    const handleSettingChange = (e) => {
        const { name, value, type, checked } = e.target;
        const val = type === 'checkbox' ? String(checked) : value;
        setSettings(prev => ({ ...prev, [name]: val }));
    };

    useEffect(() => {
        const handler = setTimeout(() => {
            setVideoFilters(prev => ({ ...prev, search: searchTerm }));
        }, 500);
        return () => clearTimeout(handler);
    }, [searchTerm]);

    const handleAuth = () => {
        if (password === 'momcenter!@#') {
            localStorage.setItem('admin_token', password);
            api.defaults.headers.common['Authorization'] = `Bearer ${password}`;
            setIsAuthenticated(true);
        } else {
            alert('Incorrect password');
        }
    };

    const fetchVideos = useCallback(async () => {
        if (!isAuthenticated) return;
        try {
            const params = {
                page: videoPagination.page,
                limit: videoPagination.limit,
                search: videoFilters.search,
                status: videoFilters.status,
            };
            const res = await api.get('/admin/videos', { params });
            setVideos(res.data.videos || []);
            setVideoPagination(prev => ({ ...prev, totalVideos: res.data.totalVideos || 0 }));
        } catch (error) {
            console.error('Failed to fetch videos', error);
            setVideos([]);
        }
    }, [isAuthenticated, videoFilters, videoPagination.page, videoPagination.limit]);

    const fetchComments = useCallback(async () => {
        if (!isAuthenticated) return;
        try {
            const params = {
                page: commentPagination.page,
                limit: commentPagination.limit,
                search: debouncedCommentSearch,
            };
            const res = await api.get('/admin/comments', { params });
            setComments(res.data.comments || []);
            setCommentPagination(prev => ({ ...prev, totalComments: res.data.totalComments || 0 }));
        } catch (error) {
            console.error('Failed to fetch comments', error);
            setComments([]);
        }
    }, [isAuthenticated, commentPagination.page, commentPagination.limit, debouncedCommentSearch]);

    const fetchDonations = useCallback(async () => {
        if (!isAuthenticated) return;
        try {
            const params = {
                page: donationPagination.page,
                limit: donationPagination.limit,
                search: debouncedDonationSearch,
            };
            const res = await api.get('/admin/donations', { params });
            setDonations(res.data.donations || []);
            setDonationPagination(prev => ({ ...prev, totalDonations: res.data.totalDonations || 0 }));
        } catch (error) {
            console.error('Failed to fetch donations', error);
            setDonations([]);
        }
    }, [isAuthenticated, donationPagination.page, donationPagination.limit, debouncedDonationSearch]);

    const fetchCosts = useCallback(async () => {
        if (!isAuthenticated) return;
        try {
            const params = {
                page: costPagination.page,
                limit: costPagination.limit,
                search: debouncedCostSearch,
                sortBy: costSortOptions.sortBy,
                sortOrder: costSortOptions.sortOrder,
            };
            const res = await api.get('/admin/costs', { params });
            setCosts(res.data.costs || []);
            setCostPagination(prev => ({ ...prev, totalCosts: res.data.totalCosts || 0 }));
        } catch (error) {
            console.error('Failed to fetch costs', error);
            setCosts([]);
        }
    }, [isAuthenticated, costPagination.page, costPagination.limit, debouncedCostSearch, costSortOptions]);

    const fetchAllData = useCallback(async () => {
        if (!isAuthenticated) return;
        try {
            const [summaryRes, statsRes] = await Promise.all([
                api.get('/admin/summary'),
                api.get('/admin/dashboard-stats'),
            ]);
            setSummary(summaryRes.data);
            setStats(statsRes.data);
        } catch (error) {
            console.error('Failed to fetch admin data', error);
            if (error.response && error.response.status === 401) {
                setIsAuthenticated(false);
                localStorage.removeItem('admin_token');
            }
        }
    }, [isAuthenticated]);

    useEffect(() => {
        const token = localStorage.getItem('admin_token');
        if (token) {
            setPassword(token);
            api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
            setIsAuthenticated(true);
        }
    }, []);

    useEffect(() => {
        if (isAuthenticated) {
            fetchAllData();
            fetchSettings();
        }
    }, [isAuthenticated, fetchAllData, fetchSettings]);

    useEffect(() => {
        if (isAuthenticated && activeTab === 'content') {
            fetchVideos();
            fetchComments();
        }
    }, [isAuthenticated, activeTab, videoPagination.page, videoFilters, debouncedCommentSearch, commentPagination.page, fetchVideos, fetchComments]);

    useEffect(() => {
        if (isAuthenticated && activeTab === 'cost') {
            fetchDonations();
            fetchCosts();
        }
    }, [isAuthenticated, activeTab, donationPagination.page, debouncedDonationSearch, costPagination.page, debouncedCostSearch, costSortOptions, fetchDonations, fetchCosts]);

    useEffect(() => {
        if (isAuthenticated && activeTab === 'settings') {
            fetchSettings();
        }
    }, [isAuthenticated, activeTab, fetchSettings]);

    useEffect(() => {
        const handler = setTimeout(() => setDebouncedCommentSearch(commentSearchTerm), 500);
        return () => clearTimeout(handler);
    }, [commentSearchTerm]);

    useEffect(() => {
        const handler = setTimeout(() => setDebouncedDonationSearch(donationSearchTerm), 500);
        return () => clearTimeout(handler);
    }, [donationSearchTerm]);

    useEffect(() => {
        const handler = setTimeout(() => setDebouncedCostSearch(costSearchTerm), 500);
        return () => clearTimeout(handler);
    }, [costSearchTerm]);

    const handleFilterChange = (e) => {
        const { name, value } = e.target;
        setVideoPagination(prev => ({ ...prev, page: 1 }));
        if (name === 'search') {
            setSearchTerm(value);
        } else {
            setVideoFilters(prev => ({ ...prev, [name]: value }));
        }
    };

    const totalPages = Math.ceil(videoPagination.totalVideos / videoPagination.limit);
    const handlePageChange = (newPage) => newPage > 0 && newPage <= totalPages && setVideoPagination(prev => ({ ...prev, page: newPage }));

    const totalCommentPages = Math.ceil(commentPagination.totalComments / commentPagination.limit);
    const handleCommentPageChange = (newPage) => newPage > 0 && newPage <= totalCommentPages && setCommentPagination(prev => ({ ...prev, page: newPage }));

    const totalDonationPages = Math.ceil(donationPagination.totalDonations / donationPagination.limit);
    const handleDonationPageChange = (newPage) => newPage > 0 && newPage <= totalDonationPages && setDonationPagination(prev => ({ ...prev, page: newPage }));

    const totalCostPages = Math.ceil(costPagination.totalCosts / costPagination.limit);
    const handleCostPageChange = (newPage) => newPage > 0 && newPage <= totalCostPages && setCostPagination(prev => ({ ...prev, page: newPage }));

    const handleNewDonationChange = (e) => {
        const { name, value } = e.target;
        setNewDonation(prev => ({ ...prev, [name]: value }));
    };

    const handleAddDonation = async (e) => {
        e.preventDefault();
        const { donator_name, amount, year, month, day, message } = newDonation;
        if (!donator_name.trim() || !amount.trim() || !year || !month || !day) {
            alert('후원자명, 금액, 날짜를 모두 입력해주세요.');
            return;
        }
        const donation_date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (isNaN(new Date(donation_date).getTime())) {
            alert('유효하지 않은 날짜 형식입니다.');
            return;
        }
        try {
            await api.post('/admin/donations', { donator_name, amount, donation_date, message });
            setNewDonation(getInitialDonationState());
            fetchDonations();
            fetchAllData();
        } catch (error) {
            console.error('Failed to add donation', error);
            alert('후원 내역 추가에 실패했습니다.');
        }
    };
    
    const handleDeleteDonation = async (id) => {
        if (window.confirm('정말로 이 후원 내역을 삭제하시겠습니까?')) {
            try {
                await api.delete(`/admin/donations/${id}`);
                fetchDonations();
                fetchAllData();
            } catch (error) {
                console.error('Failed to delete donation', error);
                alert('후원 내역 삭제에 실패했습니다.');
            }
        }
    };

    const handleDeleteVideo = async (videoId, videoTitle) => {
        if (window.confirm(`'${videoTitle}' 영상을 정말로 삭제하시겠습니까?\n관련된 모든 대본과 댓글이 함께 삭제됩니다.`)) {
            try {
                await api.delete(`/admin/videos/${videoId}`);
                alert('영상이 성공적으로 삭제되었습니다.');
                fetchVideos();
            } catch (error) {
                console.error('Failed to delete video', error);
                alert('영상 삭제에 실패했습니다.');
            }
        }
    };

    const handleDeleteComment = async (commentId, content) => {
        const truncatedContent = content.length > 50 ? `${content.substring(0, 50)}...` : content;
        if (window.confirm(`다음 댓글을 정말로 삭제하시겠습니까?\n\n"${truncatedContent}"`)) {
            try {
                await api.delete(`/admin/comments/${commentId}`);
                alert('댓글이 성공적으로 삭제되었습니다.');
                fetchComments();
            } catch (error) {
                console.error('Failed to delete comment', error);
                alert('댓글 삭제에 실패했습니다.');
            }
        }
    };

    if (!isAuthenticated) {
        return (
            <div className="admin-auth-container">
                <h1>Admin Access</h1>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter password" onKeyPress={(e) => e.key === 'Enter' && handleAuth()} />
                <button onClick={handleAuth}>Login</button>
            </div>
        );
    }

    const USD_TO_KRW_RATE = parseFloat(settings.exchangeRate) || 1400;

    return (
        <div className="admin-container">
            <h1>관리자 페이지</h1>

            <div className="admin-tabs" role="tablist" aria-label="관리자 페이지 탭">
                <button role="tab" aria-selected={activeTab === 'dashboard'} className={`tab-btn ${activeTab === 'dashboard' ? 'active' : ''}`} onClick={() => setActiveTab('dashboard')}>대시보드</button>
                <button role="tab" aria-selected={activeTab === 'content'} className={`tab-btn ${activeTab === 'content' ? 'active' : ''}`} onClick={() => setActiveTab('content')}>콘텐츠 관리</button>
                <button role="tab" aria-selected={activeTab === 'cost'} className={`tab-btn ${activeTab === 'cost' ? 'active' : ''}`} onClick={() => setActiveTab('cost')}>비용 관리</button>
                <button role="tab" aria-selected={activeTab === 'settings'} className={`tab-btn ${activeTab === 'settings' ? 'active' : ''}`} onClick={() => setActiveTab('settings')}>서비스 설정</button>
            </div>

            <div role="tabpanel" hidden={activeTab !== 'dashboard'}>
                <section className="admin-summary">
                    <h2>재정 요약</h2>
                    <div className="summary-cards">
                        <div className="card"><h3>총 후원금</h3><p>{summary.totalDonations.toLocaleString()} 원</p></div>
                        <div className="card"><h3>총 API 비용</h3><p>{summary.totalApiCosts.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}</p></div>
                        <div className="card"><h3>현재 잔액 (참고)</h3><p><strong>{Math.floor(summary.totalDonations - (summary.totalApiCosts * USD_TO_KRW_RATE)).toLocaleString()} 원</strong></p></div>
                    </div>
                </section>
                <section className="admin-summary">
                    <h2>API 비용 요약</h2>
                    <div className="summary-cards">
                        <div className="card"><h3>오늘 API 비용</h3><p>{Math.floor(stats.costToday * USD_TO_KRW_RATE).toLocaleString()} 원</p></div>
                        <div className="card"><h3>최근 7일 API 비용</h3><p>{Math.floor(stats.costThisWeek * USD_TO_KRW_RATE).toLocaleString()} 원</p></div>
                        <div className="card"><h3>최근 30일 API 비용</h3><p>{Math.floor(stats.costThisMonth * USD_TO_KRW_RATE).toLocaleString()} 원</p></div>
                    </div>
                </section>
                <section className="admin-summary">
                    <h2>핵심 통계</h2>
                    <div className="summary-cards">
                        <div className="card"><h3>총 영상/댓글</h3><p>{stats.totalVideos} / {stats.totalComments}</p></div>
                        <div className="card"><h3>오늘 처리된 영상</h3><p>{stats.videosToday}</p></div>
                        <div className="card"><h3>최근 7일간 처리된 영상</h3><p>{stats.videosThisWeek}</p></div>
                        <div className="card"><h3>최근 30일간 처리된 영상</h3><p>{stats.videosThisMonth}</p></div>
                    </div>
                </section>
                <section className="admin-summary">
                    <h2>시스템 상태</h2>
                    <div className="summary-cards">
                        <div className="card"><h3>처리 중인 영상</h3><p>{stats.processingVideos.length}</p></div>
                        <div className="card"><h3>최근 24시간 내 실패한 영상</h3><p>{stats.failedVideos.length}</p></div>
                    </div>
                    {stats.processingVideos && stats.processingVideos.length > 0 && (
                        <div className="table-container dashboard-table">
                            <h4>처리 중인 영상 목록</h4>
                            <table>
                                <thead>
                                    <tr>
                                        <th>시작 시간</th>
                                        <th>제목</th>
                                        <th>Video ID</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {stats.processingVideos.map(v => (
                                        <tr key={v.videoId}>
                                            <td>{new Date(v.createdAt).toLocaleString()}</td>
                                            <td>{v.title}</td>
                                            <td>{v.videoId}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                    {stats.failedVideos && stats.failedVideos.length > 0 && (
                        <div className="table-container dashboard-table">
                            <h4>실패한 영상 목록</h4>
                            <table>
                                <thead>
                                    <tr>
                                        <th>실패 시간</th>
                                        <th>제목</th>
                                        <th>Video ID</th>
                                        <th>실패 원인</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {stats.failedVideos.map(v => (
                                        <tr key={v.videoId}>
                                            <td>{new Date(v.createdAt).toLocaleString()}</td>
                                            <td>{v.title}</td>
                                            <td>{v.videoId}</td>
                                            <td className="fail-reason-cell" title={v.fail_reason || ''}>{v.fail_reason}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </section>
            </div>

            <div role="tabpanel" hidden={activeTab !== 'content'}>
                <section>
                    <h2>영상 관리</h2>
                    <div className="filters-container">
                        <input type="search" name="search" placeholder="제목으로 검색..." value={searchTerm} onChange={handleFilterChange} />
                        <select name="status" value={videoFilters.status} onChange={handleFilterChange}>
                            <option value="">모든 상태</option>
                            <option value="completed">Completed</option>
                            <option value="processing">Processing</option>
                            <option value="failed">Failed</option>
                            <option value="pending">Pending</option>
                        </select>
                    </div>
                    <div className="table-container">
                        <table>
                            <thead><tr><th>생성일</th><th>제목</th><th>Video ID</th><th>상태</th><th>실패 원인</th><th>댓글 수</th><th>작업</th></tr></thead>
                            <tbody>
                                {(videos || []).map(v => (
                                    <tr key={v.videoId}>
                                        <td>{new Date(v.createdAt).toLocaleString()}</td>
                                        <td>{v.title}</td>
                                        <td>{v.videoId}</td>
                                        <td>{v.status}</td>
                                        <td className="fail-reason-cell" title={v.fail_reason || ''}>
                                            {v.status === 'failed' ? v.fail_reason : ''}
                                        </td>
                                        <td>{v.commentCount}</td>
                                        <td><button className="delete-btn" onClick={() => handleDeleteVideo(v.videoId, v.title)}>삭제</button></td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div className="pagination-container">
                        <button onClick={() => handlePageChange(videoPagination.page - 1)} disabled={videoPagination.page <= 1}>이전</button>
                        <span>{videoPagination.page} / {totalPages}</span>
                        <button onClick={() => handlePageChange(videoPagination.page + 1)} disabled={videoPagination.page >= totalPages}>다음</button>
                    </div>
                </section>
                <section>
                    <h2>댓글 관리</h2>
                    <div className="filters-container">
                        <input type="search" name="comment-search" placeholder="닉네임 또는 내용으로 검색..." value={commentSearchTerm} onChange={(e) => setCommentSearchTerm(e.target.value)} />
                    </div>
                    <div className="table-container">
                        <table>
                            <thead><tr><th>작성일</th><th>영상 제목</th><th>닉네임</th><th>내용</th><th>작업</th></tr></thead>
                            <tbody>
                                {(comments || []).map(c => (
                                    <tr key={c.id}><td>{new Date(c.createdAt).toLocaleString()}</td><td>{c.videoTitle || 'N/A'}</td><td>{c.nickname}</td><td className="comment-content-cell" title={c.content}>{c.content}</td><td><button className="delete-btn" onClick={() => handleDeleteComment(c.id, c.content)}>삭제</button></td></tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div className="pagination-container">
                        <button onClick={() => handleCommentPageChange(commentPagination.page - 1)} disabled={commentPagination.page <= 1}>이전</button>
                        <span>{commentPagination.page} / {totalCommentPages}</span>
                        <button onClick={() => handleCommentPageChange(commentPagination.page + 1)} disabled={commentPagination.page >= totalCommentPages}>다음</button>
                    </div>
                </section>
            </div>

            <div role="tabpanel" hidden={activeTab !== 'cost'}>
                <section>
                    <h2>후원금 관리</h2>
                    <form onSubmit={handleAddDonation} className="donation-form">
                        <input type="text" name="donator_name" value={newDonation.donator_name} onChange={handleNewDonationChange} placeholder="후원자명" />
                        <input type="number" name="amount" value={newDonation.amount} onChange={handleNewDonationChange} placeholder="금액(원)" />
                        <div className="date-inputs">
                            <label>년</label><input type="number" name="year" value={newDonation.year} onChange={handleNewDonationChange} placeholder="YYYY" />
                            <label>월</label><input type="number" name="month" value={newDonation.month} onChange={handleNewDonationChange} placeholder="MM" />
                            <label>일</label><input type="number" name="day" value={newDonation.day} onChange={handleNewDonationChange} placeholder="DD" />
                        </div>
                        <input type="text" name="message" value={newDonation.message} onChange={handleNewDonationChange} placeholder="메시지 (선택)" />
                        <button type="submit">후원 내역 추가</button>
                    </form>
                    <div className="filters-container">
                        <input type="search" name="donation-search" placeholder="후원자명 또는 메시지로 검색..." value={donationSearchTerm} onChange={(e) => setDonationSearchTerm(e.target.value)} />
                    </div>
                    <div className="table-container">
                        <table>
                            <thead><tr><th>날짜</th><th>후원자명</th><th>금액</th><th>메시지</th><th>작업</th></tr></thead>
                            <tbody>
                                {donations.map(d => (
                                    <tr key={d.id}><td>{new Date(d.donation_date).toLocaleDateString()}</td><td>{d.donator_name}</td><td>{d.amount.toLocaleString()} 원</td><td className="comment-content-cell" title={d.message}>{d.message}</td><td><button className="delete-btn" onClick={() => handleDeleteDonation(d.id)}>삭제</button></td></tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div className="pagination-container">
                        <button onClick={() => handleDonationPageChange(donationPagination.page - 1)} disabled={donationPagination.page <= 1}>이전</button>
                        <span>{donationPagination.page} / {totalDonationPages}</span>
                        <button onClick={() => handleDonationPageChange(donationPagination.page + 1)} disabled={donationPagination.page >= totalDonationPages}>다음</button>
                    </div>
                </section>
                <section>
                    <h2>API 비용 내역</h2>
                    <div className="filters-container">
                        <input type="search" name="cost-search" placeholder="영상 제목으로 검색..." value={costSearchTerm} onChange={(e) => setCostSearchTerm(e.target.value)} />
                        <select value={`${costSortOptions.sortBy},${costSortOptions.sortOrder}`} onChange={(e) => { const [sortBy, sortOrder] = e.target.value.split(','); setCostSortOptions({ sortBy, sortOrder }); }}>
                            <option value="cost,DESC">비용 높은 순</option>
                            <option value="createdAt,DESC">최신 순</option>
                        </select>
                    </div>
                    <div className="table-container">
                        <table>
                            <thead><tr><th>날짜</th><th>영상 제목</th><th>모델</th><th>총 토큰</th><th>비용 (USD)</th></tr></thead>
                            <tbody>
                                {costs.map(c => (
                                    <tr key={c.id}><td>{new Date(c.createdAt).toLocaleString()}</td><td>{c.videoTitle || c.videoId}</td><td>{c.model_used}</td><td>{(c.image_tokens + c.text_tokens).toLocaleString()}</td><td>{c.cost.toFixed(6)}</td></tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div className="pagination-container">
                        <button onClick={() => handleCostPageChange(costPagination.page - 1)} disabled={costPagination.page <= 1}>이전</button>
                        <span>{costPagination.page} / {totalCostPages}</span>
                        <button onClick={() => handleCostPageChange(costPagination.page + 1)} disabled={costPagination.page >= totalCostPages}>다음</button>
                    </div>
                </section>
            </div>

            <div role="tabpanel" hidden={activeTab !== 'settings'}>
                <section className="settings-container">
                    <h2>서비스 설정</h2>
                    <div className="setting-item">
                        <label htmlFor="videoDurationLimit">영상 길이 제한</label>
                        <select id="videoDurationLimit" name="videoDurationLimit" value={settings.videoDurationLimit} onChange={handleSettingChange}>
                            <option value="10">10분</option>
                            <option value="30">30분</option>
                            <option value="60">1시간</option>
                            <option value="0">제한 없음</option>
                        </select>
                        <p>지정된 길이 이상의 영상은 처리되지 않습니다. (0분 = 무제한)</p>
                    </div>
                    <div className="setting-item">
                        <label htmlFor="processingPaused">신규 화면 해설 생성 중지</label>
                        <label className="switch">
                            <input id="processingPaused" name="processingPaused" type="checkbox" checked={settings.processingPaused === 'true'} onChange={handleSettingChange} />
                            <span className="slider round"></span>
                        </label>
                        <p>이 옵션을 켜면, 사용자가 새로운 영상 해설 생성을 요청할 수 없습니다.</p>
                    </div>
                    <div className="setting-item">
                        <label htmlFor="exchangeRate">환율 설정 (USD to KRW)</label>
                        <input id="exchangeRate" name="exchangeRate" type="number" value={settings.exchangeRate} onChange={handleSettingChange} />
                        <p>대시보드의 원화(KRW) 비용 표시에 사용될 환율입니다.</p>
                    </div>

                    <hr />

                    <h2>공지사항 관리</h2>
                    <div className="setting-item">
                        <label htmlFor="notice_title">공지사항 제목</label>
                        <input id="notice_title" name="notice_title" type="text" value={settings.notice_title || ''} onChange={handleSettingChange} placeholder="공지사항 제목을 입력하세요." />
                        <p>메인 페이지에 표시될 공지사항의 제목입니다. 비워두면 공지가 표시되지 않습니다.</p>
                    </div>
                    <div className="setting-item">
                        <label htmlFor="notice_content">공지사항 내용</label>
                        <textarea id="notice_content" name="notice_content" value={settings.notice_content || ''} onChange={handleSettingChange} rows="5" placeholder="공지사항 내용을 입력하세요."></textarea>
                        <p>공지사항의 전체 내용입니다.</p>
                    </div>

                    <button className="save-btn" onClick={handleSaveSettings}>설정 저장</button>
                </section>
            </div>
        </div>
    );
};

export default Admin;
