import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import HomeScreen from './screens/HomeScreen';
import PlayerScreenV2 from './screens/PlayerScreenV2';
import BoardScreen from './screens/BoardScreen';
import PostScreen from './screens/PostScreen';
import CreatePost from './screens/CreatePost';
import MoreScreen from './screens/MoreScreen';
import VoiceSampleScreen from './screens/VoiceSampleScreen';
import RegisterScreen from './screens/RegisterScreen';
import LoginScreen from './screens/LoginScreen';
import Admin from './screens/Admin';
import MyPageScreen from './screens/MyPageScreen';
import { AccessibilityProvider } from './contexts/AccessibilityContext';
import { AuthProvider } from './contexts/AuthContext';
import './styles/main.css';

function App() {
  return (
    <AccessibilityProvider>
      <AuthProvider>
        <Router>
          <Routes>
            <Route path="/" element={<Layout />}>
              <Route index element={<HomeScreen />} />
              <Route path="board" element={<BoardScreen />} />
              <Route path="more" element={<MoreScreen />} />
              <Route path="voice_sample" element={<VoiceSampleScreen />} />
              <Route path="mypage" element={<MyPageScreen />} />
            </Route>
            <Route path="/video/:videoId" element={<PlayerScreenV2 />} />
            <Route path="/board/create" element={<CreatePost />} />
            <Route path="/board/:postId" element={<PostScreen />} />
            <Route path="/register" element={<RegisterScreen />} />
            <Route path="/login" element={<LoginScreen />} />
            <Route path="/admin" element={<Admin />} />
          </Routes>
        </Router>
      </AuthProvider>
    </AccessibilityProvider>
  );
}

export default App;
