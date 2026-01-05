import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { clearAuthToken, fetchMe, getAuthToken } from '../api.ts';
import type { AuthUser } from '../api.ts';

type AuthStatus = 'loading' | 'guest' | 'auth';

type AuthContextValue = {
  user: AuthUser | null;
  status: AuthStatus;
  setUser: (user: AuthUser | null) => void;
  logout: () => void;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUserState] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');

  const setUser = (next: AuthUser | null) => {
    setUserState(next);
    setStatus(next ? 'auth' : 'guest');
  };

  const logout = () => {
    clearAuthToken();
    setUser(null);
  };

  const refresh = async () => {
    const token = getAuthToken();
    if (!token) {
      setUser(null);
      return;
    }

    try {
      const data = await fetchMe();
      setUser(data);
    } catch {
      clearAuthToken();
      setUser(null);
    }
  };

  useEffect(() => {
    refresh().catch(() => {});
  }, []);

  return (
    <AuthContext.Provider value={{ user, status, setUser, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
};
