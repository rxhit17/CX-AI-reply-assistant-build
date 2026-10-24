import type { Session } from '@supabase/supabase-js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import type { Me } from '@/lib/types';

interface AuthState {
  session: Session | null;
  me: Me | null;
  /** Set when /api/me failed (server unreachable or wrong server), as opposed to the account having no profile. */
  meError: string | null;
  retryMe: () => void;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [booting, setBooting] = useState(true);
  const queryClient = useQueryClient();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setBooting(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (!next) queryClient.clear(); // never keep one user's data in cache for the next
    });
    return () => data.subscription.unsubscribe();
  }, [queryClient]);

  const meQuery = useQuery({
    queryKey: ['me', session?.user.id],
    enabled: Boolean(session),
    queryFn: async () => (await api.get<{ user: Me }>('/api/me')).user,
    staleTime: 5 * 60_000,
  });

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return error ? error.message : null;
  }, []);
  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      session,
      me: meQuery.data ?? null,
      meError: meQuery.isError ? meQuery.error.message : null,
      retryMe: () => void meQuery.refetch(),
      loading: booting || (Boolean(session) && meQuery.isPending),
      signIn,
      signOut,
    }),
    [session, meQuery, booting, signIn, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/** Route guard. UX only: every API call is independently authorised on the server. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, me, meError, retryMe, signOut, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div
        className="flex h-full items-center justify-center text-sm text-muted-foreground"
        role="status"
      >
        Loading…
      </div>
    );
  }
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (meError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm" role="alert">
        <p className="max-w-md">
          You are signed in, but the application server could not be reached or did not respond correctly ({meError}). Check that the API is running and that VITE_API_URL points to it.
        </p>
        <div className="flex gap-2">
          <button className="rounded-md border px-3 py-1.5 font-medium" onClick={retryMe}>Try again</button>
          <button className="rounded-md border px-3 py-1.5" onClick={() => void signOut()}>Sign out</button>
        </div>
      </div>
    );
  }
  if (!me) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm" role="alert">
        Your account has no profile on this system. Ask an administrator for access.
      </div>
    );
  }
  return <>{children}</>;
}
