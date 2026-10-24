import { Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider, RequireAuth } from '@/auth/AuthProvider';
import { AppShell } from '@/components/layout/AppShell';
import { Conversations } from '@/pages/Conversations';
import { Dashboard } from '@/pages/Dashboard';
import { KnowledgeBase } from '@/pages/KnowledgeBase';
import { Login } from '@/pages/Login';
import { Logs } from '@/pages/Logs';
import { SettingsPage } from '@/pages/Settings';
import { RealtimeProvider } from '@/realtime/RealtimeProvider';

export function App() {
  return (
    <AuthProvider>
      <Toaster position="top-right" richColors closeButton />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          element={
            <RequireAuth>
              <RealtimeProvider>
                <AppShell />
              </RealtimeProvider>
            </RequireAuth>
          }
        >
          <Route index element={<Dashboard />} />
          <Route path="conversations" element={<Conversations />} />
          <Route path="conversations/:id" element={<Conversations />} />
          <Route path="knowledge-base" element={<KnowledgeBase />} />
          <Route path="logs" element={<Logs />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
