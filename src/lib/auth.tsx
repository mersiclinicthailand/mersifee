import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { supabase } from './supabase';
import { api, dropCache, type Boot } from './api';

type Ctx = {
  boot: Boot | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthCtx = createContext<Ctx>({
  boot: null, loading: true, error: null,
  refresh: async () => {}, signOut: async () => {},
});

export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [boot, setBoot] = useState<Boot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    if (!data.session) { setBoot(null); setLoading(false); return; }
    try {
      setBoot(await api.bootstrap());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBoot(null);
      await supabase.auth.signOut();
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const { data: sub } = supabase.auth.onAuthStateChange((evt) => {
      if (evt === 'SIGNED_OUT') { dropCache(); setBoot(null); setLoading(false); }
      if (evt === 'SIGNED_IN' || evt === 'TOKEN_REFRESHED') load();
    });
    return () => sub.subscription.unsubscribe();
  }, [load]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    dropCache();
    setBoot(null);
  }, []);

  return (
    <AuthCtx.Provider value={{ boot, loading, error, refresh: load, signOut }}>
      {children}
    </AuthCtx.Provider>
  );
}

/** สิทธิ์ฝั่งหน้าจอ — ใช้ซ่อนเมนูเพื่อความสะดวกเท่านั้น
 *  การควบคุมสิทธิ์จริงอยู่ที่ RLS และ RPC ในฐานข้อมูล */
export const can = {
  registry:  (r?: string) => ['admin', 'it', 'hr'].includes(r || ''),
  rates:     (r?: string) => ['admin', 'acct', 'hr'].includes(r || ''),
  review:    (r?: string) => ['admin', 'acct'].includes(r || ''),
  approve:   (r?: string) => ['admin', 'hr'].includes(r || ''),
  users:     (r?: string) => ['admin', 'it'].includes(r || ''),
  config:    (r?: string) => ['admin', 'it', 'acct'].includes(r || ''),
  editData:  (r?: string) => ['admin', 'hr', 'acct', 'branch', 'it'].includes(r || ''),
  seeAudit:  (r?: string) => ['admin', 'it', 'audit', 'acct'].includes(r || ''),
};
