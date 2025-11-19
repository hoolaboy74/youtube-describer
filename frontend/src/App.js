import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import HomeScreen from './screens/HomeScreen';
import PlayerScreen from './screens/PlayerScreen';
import BoardScreen from './screens/BoardScreen';
import PostScreen from './screens/PostScreen';
import CreatePost from './screens/CreatePost';
import MoreScreen from './screens/MoreScreen';
import Admin from './screens/Admin';
import { AccessibilityProvider } from './contexts/AccessibilityContext';
import './styles/main.css';

function App() {
  return (
    <AccessibilityProvider>
      <Router>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<HomeScreen />} />
            <Route path="board" element={<BoardScreen />} />
            <Route path="more" element={<MoreScreen />} />
          </Route>
          <Route path="/video/:videoId" element={<PlayerScreen />} />
          <Route path="/board/create" element={<CreatePost />} />
          <Route path="/board/:postId" element={<PostScreen />} />
          <Route path="/admin" element={<Admin />} />
        </Routes>
      </Router>
    </AccessibilityProvider>
  );
}

export default App;
