import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { visibleTabs } from './lib/tabs';
import { APP_VERSION } from './lib/supabase';
import { Loading, Skeleton } from './components/ui';
import Login from './pages/Login';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Import    = lazy(() => import('./pages/Import'));
const Shifts    = lazy(() => import('./pages/Shifts'));
const Clock     = lazy(() => import('./pages/Clock'));
const Calc      = lazy(() => import('./pages/Calc'));
const Reconcile = lazy(() => import('./pages/Reconcile'));
const Approve   = lazy(() => import('./pages/Approve'));
const EmailPage = lazy(() => import('./pages/Email'));
const Registry  = lazy(() => import('./pages/Registry'));
const Settings  = lazy(() => import('./pages/Settings'));
const Sign      = lazy(() => import('./pages/Sign'));

export interface Scope {
  branch: string; ym: string;
  setBranch: (v: string) => void; setYm: (v: string) => void;
}

export default function App() {
  const { boot, loading, error, signOut } = useAuth();
  const loc = useLocation();

  const [branch, setBranch] = useState(() => localStorage.getItem('fee.branch') || '');
  const [ym, setYm] = useState(() => {
    const saved = localStorage.getItem('fee.ym');
    if (saved) return saved;
    const d = new Date();
    d.setMonth(d.getMonth() - 1);            // ตั้งต้นที่เดือนก่อน (รอบที่กำลังปิด)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });

  useEffect(() => {
    if (boot && !boot.branches.some((b) => b.code === branch)) {
      setBranch(boot.branches[0]?.code || '');
    }
  }, [boot, branch]);

  useEffect(() => { if (branch) localStorage.setItem('fee.branch', branch); }, [branch]);
  useEffect(() => { localStorage.setItem('fee.ym', ym); }, [ym]);

  const scope: Scope = useMemo(() => ({ branch, ym, setBranch, setYm }), [branch, ym]);

  /** หน้าเซ็นของแพทย์เปิดจากลิงก์ในอีเมล ต้องเข้าได้ก่อนล็อกอิน
   *  จึงต้องตัดสินใจก่อนด่านตรวจสิทธิ์ทั้งหมด */
  if (loc.pathname.startsWith('/sign/')) {
    return (
      <Suspense fallback={<Loading />}>
        <Routes location={loc}>
          <Route path="/sign/:token" element={<Sign />} />
        </Routes>
      </Suspense>
    );
  }

  if (loading) return <Loading />;
  if (!boot) return <Login error={error} />;

  const tabs = visibleTabs(boot.me.role, boot.me.tabs);
  const allowed = new Set(tabs.map((t) => t.to));
  /** เข้า URL ตรง ๆ ของแท็บที่ไม่มีสิทธิ์ → เด้งกลับหน้าแรก
   *  (เป็นแค่การกันเข้าหน้าจอ สิทธิ์จริงบังคับที่ฐานข้อมูลอยู่แล้ว) */
  const guard = (to: string, el: React.ReactElement) =>
    (allowed.has(to) ? el : <Navigate to="/" replace />);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <img className="mark" src="/logo.png" alt="Mersi Clinic" />
          <span>
            Mersi Clinic
            <small>ระบบค่าตอบแทนแพทย์</small>
          </span>
        </div>
        <div className="spacer" />
        <span className="muted" style={{ textAlign: 'right' }}>
          {boot.me.name}<br />
          <span className="pill none">{boot.me.roleTh}</span>
        </span>
        <button className="sm" onClick={signOut}>ออกจากระบบ</button>
      </header>

      <nav className="tabs">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.to === '/'}
            className={({ isActive }) => (isActive ? 'on' : '')}
          >
            {t.label}
          </NavLink>
        ))}
      </nav>

      <main>
        <Suspense fallback={<div className="card"><Skeleton rows={4} /></div>}>
          <Routes location={loc}>
            <Route path="/"          element={<Dashboard scope={scope} />} />
            <Route path="/import"    element={guard('/import', <Import scope={scope} />)} />
            <Route path="/shifts"    element={guard('/shifts', <Shifts scope={scope} />)} />
            <Route path="/clock"     element={guard('/clock', <Clock scope={scope} />)} />
            <Route path="/calc"      element={guard('/calc', <Calc scope={scope} />)} />
            <Route path="/reconcile" element={guard('/reconcile', <Reconcile scope={scope} />)} />
            <Route path="/approve"   element={guard('/approve', <Approve scope={scope} />)} />
            <Route path="/email"     element={guard('/email', <EmailPage scope={scope} />)} />
            <Route path="/registry"  element={guard('/registry', <Registry />)} />
            <Route path="/settings"  element={guard('/settings', <Settings />)} />
            <Route path="*"          element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
        <p className="muted" style={{ textAlign: 'center', marginTop: 20 }}>
          Mersi Clinic · ระบบค่าตอบแทนแพทย์ {APP_VERSION}
        </p>
      </main>
    </div>
  );
}
