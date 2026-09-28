import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { SessionProvider, useSession } from './context/SessionContext.jsx';
import { TicketsProvider } from './context/TicketsContext.jsx';
import { ToastProvider } from './context/ToastContext.jsx';
import TabBar from './components/TabBar.jsx';
import LoginScreen from './screens/auth/LoginScreen.jsx';
import SignupScreen from './screens/auth/SignupScreen.jsx';
import ForgotPasswordScreen from './screens/auth/ForgotPasswordScreen.jsx';
import HomeScreen from './screens/HomeScreen.jsx';
import RequestsScreen from './screens/RequestsScreen.jsx';
import TicketDetailScreen from './screens/TicketDetailScreen.jsx';
import NewRequestScreen from './screens/NewRequestScreen.jsx';
import LiveChatScreen from './screens/LiveChatScreen.jsx';
import ProfileScreen from './screens/ProfileScreen.jsx';

function Protected({ children }) {
  const { session } = useSession();
  if (!session) return <Navigate to="/login" replace />;
  return children;
}

function GuestOnly({ children }) {
  const { session } = useSession();
  if (session) return <Navigate to="/home" replace />;
  return children;
}

/** The tab-shell: bottom navigation + the four tab screens. */
function Shell() {
  return (
    <div className="mx-auto flex h-full max-w-md flex-col bg-slate-50">
      <div className="min-h-0 flex-1">
        <Routes>
          <Route path="home" element={<HomeScreen />} />
          <Route path="requests" element={<RequestsScreen />} />
          <Route path="chat" element={<LiveChatScreen />} />
          <Route path="profile" element={<ProfileScreen />} />
        </Routes>
      </div>
      <TabBar />
    </div>
  );
}

export default function App() {
  return (
    <SessionProvider>
      <TicketsProvider>
        <ToastProvider>
          <BrowserRouter>
            <Routes>
              {/* Auth */}
              <Route path="/login" element={<GuestOnly><LoginScreen /></GuestOnly>} />
              <Route path="/signup" element={<GuestOnly><SignupScreen /></GuestOnly>} />
              <Route path="/forgot-password" element={<GuestOnly><ForgotPasswordScreen /></GuestOnly>} />

              {/* Full-screen flows without the tab bar */}
              <Route path="/new" element={<Protected><NewRequestScreen /></Protected>} />
              <Route path="/requests/:id" element={<Protected><TicketDetailScreen /></Protected>} />

              {/* Tab shell */}
              <Route path="/" element={<Protected><Shell /></Protected>}>
                <Route index element={<Navigate to="/home" replace />} />
              </Route>

              <Route path="*" element={<Navigate to="/home" replace />} />
            </Routes>
          </BrowserRouter>
        </ToastProvider>
      </TicketsProvider>
    </SessionProvider>
  );
}
