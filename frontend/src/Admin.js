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
        failedVideos: []
    });
    
    const [newDonation, setNewDonation] = useState(getInitialDonationState());

    const [videoFilters, setVideoFilters] = useState({ search: '', status: '' });
    const [videoPagination, setVideoPagination] = useState({ page: 1, limit: 20, totalVideos: 0 });
    const [searchTerm, setSearchTerm] = useState('');

    useEffect(() => {
        const handler = setTimeout(() => {
            setVideoFilters(prev => ({ ...prev, search: searchTerm }));
        }, 500);
        return () => {
            clearTimeout(handler);
        };
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

    const fetchAllData = useCallback(async () => {
        if (!isAuthenticated) return;
        try {
            const [summaryRes, donationsRes, costsRes, statsRes] = await Promise.all([
                api.get('/admin/summary'),
                api.get('/admin/donations'),
                api.get('/admin/costs'),
                api.get('/admin/dashboard-stats'),
            ]);
            setSummary(summaryRes.data);
            setDonations(donationsRes.data);
            setCosts(costsRes.data);
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
        }
    }, [isAuthenticated, fetchAllData]);

    useEffect(() => {
        if (isAuthenticated) {
            fetchVideos();
        }
    }, [isAuthenticated, videoFilters, videoPagination.page, fetchVideos]);

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

    const handlePageChange = (newPage) => {
        if (newPage > 0 && newPage <= totalPages) {
            setVideoPagination(prev => ({ ...prev, page: newPage }));
        }
    };

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

    if (!isAuthenticated) {
        return (
            <div className="admin-auth-container">
                <h1>Admin Access</h1>
                <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter password"
                    onKeyPress={(e) => e.key === 'Enter' && handleAuth()}
                />
                <button onClick={handleAuth}>Login</button>
            </div>
        );
    }

    return (
        <div className="admin-container">
            <h1>관리자 페이지</h1>

            <div className="admin-tabs" role="tablist" aria-label="관리자 페이지 탭">
                <button id="tab-dashboard" role="tab" aria-controls="panel-dashboard" aria-selected={activeTab === 'dashboard'} className={`tab-btn ${activeTab === 'dashboard' ? 'active' : ''}`} onClick={() => setActiveTab('dashboard')}>
                    대시보드
                </button>
                <button id="tab-content" role="tab" aria-controls="panel-content" aria-selected={activeTab === 'content'} className={`tab-btn ${activeTab === 'content' ? 'active' : ''}`} onClick={() => setActiveTab('content')}>
                    콘텐츠 관리
                </button>
                <button id="tab-cost" role="tab" aria-controls="panel-cost" aria-selected={activeTab === 'cost'} className={`tab-btn ${activeTab === 'cost' ? 'active' : ''}`} onClick={() => setActiveTab('cost')}>
                    비용 관리
                </button>
            </div>

            <div id="panel-dashboard" role="tabpanel" aria-labelledby="tab-dashboard" hidden={activeTab !== 'dashboard'}>
                <section className="admin-summary">
                    <h2>재정 요약</h2>
                    <div className="summary-cards">
                        <div className="card"><h3>총 후원금</h3><p>{summary.totalDonations.toLocaleString()} 원</p></div>
                        <div className="card"><h3>총 API 비용</h3><p>{summary.totalApiCosts.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}</p></div>
                        <div className="card"><h3>현재 잔액 (참고)</h3><p><strong>{(summary.totalDonations - (summary.totalApiCosts * 1350)).toLocaleString()} 원</strong></p></div>
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
                    <div className="system-status-container">
                        <div className="status-list"><h3>처리 중인 영상 ({stats.processingVideos.length})</h3><ul>{(stats.processingVideos || []).map(v => <li key={v.videoId}>{v.title}</li>)}</ul></div>
                        <div className="status-list"><h3>최근 24시간 내 실패한 영상 ({stats.failedVideos.length})</h3><ul>{(stats.failedVideos || []).map(v => <li key={v.videoId}>{v.title}</li>)}</ul></div>
                    </div>
                </section>
            </div>

            <div id="panel-content" role="tabpanel" aria-labelledby="tab-content" hidden={activeTab !== 'content'}>
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
                            <thead>
                                <tr>
                                    <th>생성일</th>
                                    <th>제목</th>
                                    <th>Video ID</th>
                                    <th>상태</th>
                                    <th>댓글 수</th>
                                    <th>작업</th>
                                </tr>
                            </thead>
                            <tbody>
                                {(videos || []).map(v => (
                                    <tr key={v.videoId}>
                                        <td>{new Date(v.createdAt).toLocaleString()}</td>
                                        <td>{v.title}</td>
                                        <td>{v.videoId}</td>
                                        <td>{v.status}</td>
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
            </div>

            <div id="panel-cost" role="tabpanel" aria-labelledby="tab-cost" hidden={activeTab !== 'cost'}>
                <>
                    <section>
                        <h2>후원금 관리</h2>
                        <form onSubmit={handleAddDonation} className="donation-form">
                            <input type="text" name="donator_name" value={newDonation.donator_name} onChange={handleNewDonationChange} placeholder="후원자명" />
                            <input type="number" name="amount" value={newDonation.amount} onChange={handleNewDonationChange} placeholder="금액(원)" />
                            <div className="date-inputs">
                                <label htmlFor="year">년</label>
                                <input id="year" type="number" name="year" value={newDonation.year} onChange={handleNewDonationChange} placeholder="YYYY" />
                                <label htmlFor="month">월</label>
                                <input id="month" type="number" name="month" value={newDonation.month} onChange={handleNewDonationChange} placeholder="MM" />
                                <label htmlFor="day">일</label>
                                <input id="day" type="number" name="day" value={newDonation.day} onChange={handleNewDonationChange} placeholder="DD" />
                            </div>
                            <input type="text" name="message" value={newDonation.message} onChange={handleNewDonationChange} placeholder="메시지 (선택)" />
                            <button type="submit">후원 내역 추가</button>
                        </form>
                        <div className="table-container">
                            <table>
                                <thead>
                                    <tr>
                                        <th>날짜</th>
                                        <th>후원자명</th>
                                        <th>금액</th>
                                        <th>메시지</th>
                                        <th>작업</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {donations.map(d => (
                                        <tr key={d.id}>
                                            <td>{new Date(d.donation_date).toLocaleDateString()}</td>
                                            <td>{d.donator_name}</td>
                                            <td>{d.amount.toLocaleString()} 원</td>
                                            <td>{d.message}</td>
                                            <td><button className="delete-btn" onClick={() => handleDeleteDonation(d.id)}>삭제</button></td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>

                    <section>
                        <h2>API 비용 내역</h2>
                        <div className="table-container">
                            <table>
                                <thead>
                                    <tr>
                                        <th>날짜</th>
                                        <th>영상 제목</th>
                                        <th>모델</th>
                                        <th>총 토큰</th>
                                        <th>비용 (USD)</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {costs.map(c => (
                                        <tr key={c.id}>
                                            <td>{new Date(c.createdAt).toLocaleString()}</td>
                                            <td>{c.videoTitle || c.videoId}</td>
                                            <td>{c.model_used}</td>
                                            <td>{(c.image_tokens + c.text_tokens).toLocaleString()}</td>
                                            <td>{c.cost.toFixed(6)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>
                </>
            </div>
        </div>
    );
};

export default Admin;
