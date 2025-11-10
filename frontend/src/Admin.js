import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import './Admin.css';

const API_BASE_URL = process.env.NODE_ENV === 'development' ? 'http://localhost:4000/api' : '/api';

// Create the axios instance outside the component to ensure it's a singleton
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
    
    const [newDonation, setNewDonation] = useState(getInitialDonationState());

    const handleAuth = () => {
        if (password === 'momcenter!@#') {
            localStorage.setItem('admin_token', password);
            api.defaults.headers.common['Authorization'] = `Bearer ${password}`;
            setIsAuthenticated(true);
        } else {
            alert('Incorrect password');
        }
    };

    const fetchData = useCallback(async () => {
        if (!isAuthenticated) return;
        try {
            const [summaryRes, donationsRes, costsRes] = await Promise.all([
                api.get('/admin/summary'),
                api.get('/admin/donations'),
                api.get('/admin/costs'),
            ]);
            setSummary(summaryRes.data);
            setDonations(donationsRes.data);
            setCosts(costsRes.data);
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
            fetchData();
        }
    }, [isAuthenticated, fetchData]);

    const handleNewDonationChange = (e) => {
        const { name, value } = e.target;
        setNewDonation(prev => ({ ...prev, [name]: value }));
    };

    const handleAddDonation = async (e) => {
        e.preventDefault();
        const { donator_name, amount, year, month, day, message } = newDonation;
        
        if (!donator_name.trim()) {
            alert('후원자명을 입력해주세요.');
            return;
        }
        if (!amount.trim()) {
            alert('금액을 입력해주세요.');
            return;
        }
        if (!year || !month || !day) {
            alert('날짜를 모두 입력해주세요.');
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
            fetchData();
        } catch (error) {
            console.error('Failed to add donation', error);
            alert('후원 내역 추가에 실패했습니다.');
        }
    };
    
    const handleDeleteDonation = async (id) => {
        if (window.confirm('정말로 이 후원 내역을 삭제하시겠습니까?')) {
            try {
                await api.delete(`/admin/donations/${id}`);
                fetchData();
            } catch (error) {
                console.error('Failed to delete donation', error);
                alert('후원 내역 삭제에 실패했습니다.');
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

            <section className="admin-summary">
                <h2>요약</h2>
                <div className="summary-cards">
                    <div className="card">
                        <h3>총 후원금</h3>
                        <p>{summary.totalDonations.toLocaleString()} 원</p>
                    </div>
                    <div className="card">
                        <h3>총 API 비용</h3>
                        <p>{summary.totalApiCosts.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}</p>
                    </div>
                    <div className="card">
                        <h3>현재 잔액</h3>
                        <p>{/* 단순 계산이 어려우므로 참고용으로만 표시 */}</p>
                        <p>후원금 - API 비용 (환율 미적용)</p>
                        <p><strong>{(summary.totalDonations - (summary.totalApiCosts * 1350)).toLocaleString()} 원 (참고)</strong></p>
                    </div>
                </div>
            </section>

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
        </div>
    );
};

export default Admin;