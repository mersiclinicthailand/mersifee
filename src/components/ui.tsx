import React, { useEffect, useRef, useState } from 'react';
import { fmtMoney, ymThai, TH_MONTHS_FULL } from '../lib/core';

/* ---------------------------- ชิ้นส่วนพื้นฐาน ---------------------------- */

export const Money = ({ v, dash }: { v: number | null | undefined; dash?: boolean }) => (
  <span className="tnum">{v === null || v === undefined || (dash && !v) ? '—' : fmtMoney(v)}</span>
);

export function Card(
  { title, right, children, className = '' }:
  { title?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; className?: string },
) {
  return (
    <section className={`card ${className}`}>
      {(title || right) && (
        <div className="card-head">
          {title && <h3>{title}</h3>}
          <div className="spacer" />
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export const Stat = (
  { k, v, s, tone }: { k: string; v: React.ReactNode; s?: React.ReactNode; tone?: string },
) => (
  <div className="stat">
    <div className="k">{k}</div>
    <div className="v" style={tone ? { color: `var(--${tone})` } : undefined}>{v}</div>
    {s && <div className="s">{s}</div>}
  </div>
);

export const Note = (
  { tone = 'info', children }: { tone?: 'info' | 'ok' | 'warn' | 'bad'; children: React.ReactNode },
) => <div className={`note ${tone}`}>{children}</div>;

export const Loading = () => <div className="progress" />;

export const Skeleton = ({ rows = 3 }: { rows?: number }) => (
  <div style={{ display: 'grid', gap: 8 }}>
    {Array.from({ length: rows }).map((_, i) => (
      <div key={i} className="skel" style={{ width: `${95 - i * 12}%` }} />
    ))}
  </div>
);

/* ------------------------------ สถานะรอบ ------------------------------ */

export const STATUS_TH: Record<string, string> = {
  NONE: 'ยังไม่ส่งข้อมูล', DRAFT: 'กำลังจัดทำ', SUBMITTED: 'ส่งตรวจแล้ว',
  REJECTED: 'ถูกตีกลับ', REVIEWED: 'บัญชีตรวจแล้ว', APPROVED: 'อนุมัติแล้ว', PAID: 'บันทึกจ่ายแล้ว',
};
const STATUS_CLS: Record<string, string> = {
  NONE: 'none', DRAFT: 'draft', SUBMITTED: 'sub', REJECTED: 'rej',
  REVIEWED: 'rev', APPROVED: 'appr', PAID: 'paid',
};

export const StatusPill = ({ s }: { s: string }) => (
  <span className={`pill ${STATUS_CLS[s] || 'none'}`}>{STATUS_TH[s] || s}</span>
);

/* --------------------------- ตัวเลือกสาขา/เดือน --------------------------- */

export function BranchMonthPicker(
  { branches, branch, ym, onBranch, onYm, hideBranch }:
  {
    branches: { code: string; nameTh: string }[]; branch: string; ym: string;
    onBranch: (v: string) => void; onYm: (v: string) => void; hideBranch?: boolean;
  },
) {
  const [y, m] = ym.split('-');
  const years = [2025, 2026, 2027, 2028];
  return (
    <div className="row">
      {!hideBranch && (
        <div className="inline-field">
          <label>สาขา</label>
          <select value={branch} onChange={(e) => onBranch(e.target.value)}>
            {branches.map((b) => (
              <option key={b.code} value={b.code}>{b.code} · {b.nameTh}</option>
            ))}
          </select>
        </div>
      )}
      <div className="inline-field">
        <label>เดือน</label>
        <select value={m} onChange={(e) => onYm(`${y}-${e.target.value}`)}>
          {TH_MONTHS_FULL.map((n, i) => (
            <option key={n} value={String(i + 1).padStart(2, '0')}>{n}</option>
          ))}
        </select>
        <select value={y} onChange={(e) => onYm(`${e.target.value}-${m}`)}>
          {years.map((yy) => <option key={yy} value={yy}>{yy + 543}</option>)}
        </select>
      </div>
    </div>
  );
}

export const YmLabel = ({ ym }: { ym: string }) => <>{ymThai(ym)}</>;

/* ------------------------------ กล่องยืนยัน ------------------------------ */

export function Confirm(
  { open, title, body, confirmText = 'ยืนยัน', needReason, onOk, onCancel }:
  {
    open: boolean; title: string; body?: React.ReactNode; confirmText?: string;
    needReason?: boolean; onOk: (reason: string) => void; onCancel: () => void;
  },
) {
  const [reason, setReason] = useState('');
  useEffect(() => { if (open) setReason(''); }, [open]);
  if (!open) return null;
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(35,38,31,.45)', zIndex: 60,
      display: 'grid', placeItems: 'center', padding: 16,
    }}
    >
      <div className="card" style={{ maxWidth: 440, width: '100%', margin: 0 }}>
        <h3>{title}</h3>
        {body && <div className="muted" style={{ marginBottom: 10 }}>{body}</div>}
        {needReason && (
          <div className="field">
            <label>เหตุผล (บังคับ)</label>
            <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        )}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
          <button onClick={onCancel}>ยกเลิก</button>
          <button
            className="primary"
            disabled={needReason && !reason.trim()}
            onClick={() => onOk(reason.trim())}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------- แผ่นเซ็นลายเซ็น ---------------------------- */

export function SignaturePad(
  { onChange }: { onChange: (dataUrl: string | null) => void },
) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);

  useEffect(() => {
    const cv = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    const r = cv.getBoundingClientRect();
    cv.width = r.width * dpr;
    cv.height = r.height * dpr;
    const ctx = cv.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#23261F';
  }, []);

  const pos = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  return (
    <div>
      <canvas
        ref={ref}
        className="sigpad"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drawing.current = true;
          const ctx = ref.current!.getContext('2d')!;
          const p = pos(e);
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const ctx = ref.current!.getContext('2d')!;
          const p = pos(e);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
          dirty.current = true;
        }}
        onPointerUp={() => {
          drawing.current = false;
          if (dirty.current) onChange(ref.current!.toDataURL('image/png'));
        }}
      />
      <div className="row" style={{ marginTop: 6 }}>
        <span className="muted">เซ็นด้วยนิ้วหรือปากกาสไตลัสในกรอบด้านบน</span>
        <div className="spacer" />
        <button
          className="sm"
          onClick={() => {
            const cv = ref.current!;
            cv.getContext('2d')!.clearRect(0, 0, cv.width, cv.height);
            dirty.current = false;
            onChange(null);
          }}
        >
          ล้าง
        </button>
      </div>
    </div>
  );
}

/* ------------------------------ ข้อความผิดพลาด ------------------------------ */

export function useAsync() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      await fn();
      if (okMsg) setMsg(okMsg);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, err, msg, setErr, setMsg, run };
}

export const Alerts = ({ err, msg }: { err?: string | null; msg?: string | null }) => (
  <>
    {err && <Note tone="bad">{err}</Note>}
    {msg && <Note tone="ok">{msg}</Note>}
  </>
);
