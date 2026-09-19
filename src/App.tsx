import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth, can } from './lib/auth';
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
const Registry  = lazy(() => import('./pages/Registry'));
const Settings  = lazy(() => import('./pages/Settings'));

export interface Scope {
  branch: string; ym: string;
  setBranch: (v: string) => void; setYm: (v: string) => void;
}

const TABS: { to: string; label: string; show?: (r: string) => boolean }[] = [
  { to: '/',          label: 'ภาพรวม' },
  { to: '/import',    label: 'นำเข้าข้อมูล', show: (r) => can.editData(r) },
  { to: '/shifts',    label: 'ใบเวรแพทย์' },
  { to: '/clock',     label: 'ลงเวลา' },
  { to: '/calc',      label: 'คำนวณ' },
  { to: '/reconcile', label: 'กระทบยอด' },
  { to: '/approve',   label: 'อนุมัติ' },
  { to: '/registry',  label: 'ทะเบียน' },
  { to: '/settings',  label: 'ตั้งค่า' },
];

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

  if (loading) return <Loading />;
  if (!boot) return <Login error={error} />;

  const role = boot.me.role;
  const tabs = TABS.filter((t) => !t.show || t.show(role));

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
            <Route path="/import"    element={<Import scope={scope} />} />
            <Route path="/shifts"    element={<Shifts scope={scope} />} />
            <Route path="/clock"     element={<Clock scope={scope} />} />
            <Route path="/calc"      element={<Calc scope={scope} />} />
            <Route path="/reconcile" element={<Reconcile scope={scope} />} />
            <Route path="/approve"   element={<Approve scope={scope} />} />
            <Route path="/registry"  element={<Registry />} />
            <Route path="/settings"  element={<Settings />} />
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
