import { useEffect, useMemo, useState } from 'react';
import type { Scope } from '../App';
import { api, type Workspace } from '../lib/api';
import { useAuth, can } from '../lib/auth';
import { calcCore, type CalcResult } from '../lib/calc';
import {
  Alerts, BranchMonthPicker, Card, Confirm, Money, Note, Skeleton, Stat, StatusPill,
  STATUS_TH, useAsync,
} from '../components/ui';

type Action = 'SUBMIT' | 'APPROVE' | 'REJECT' | 'PAID';

const STEPS: { key: string; label: string; who: string }[] = [
  { key: 'DRAFT',     label: '① จัดทำ',       who: 'พนักงานสาขา' },
  { key: 'SUBMITTED', label: '② ส่งตรวจ',      who: 'พนักงานสาขา' },
  { key: 'APPROVED',  label: '③ อนุมัติ',      who: 'ฝ่าย HR' },
  { key: 'PAID',      label: '④ บันทึกจ่าย',   who: 'ฝ่ายบัญชี' },
];
// REVIEWED ยังอยู่ใน enum ของฐานข้อมูลเผื่อรอบเก่าที่ค้างอยู่ในสถานะนั้น
// แต่หน้าจอนี้ไม่ใช้แล้ว — HR อนุมัติได้ตรงจาก SUBMITTED เลย
const ORDER = ['NONE', 'DRAFT', 'SUBMITTED', 'REVIEWED', 'APPROVED', 'PAID'];

export default function Approve({ scope }: { scope: Scope }) {
  const { boot } = useAuth();
  const [ws, setWs] = useState<Workspace | null>(null);
  const [ask, setAsk] = useState<Action | null>(null);
  const { busy, err, msg, setErr, setMsg, run } = useAsync();

  const load = () => {
    setWs(null);
    api.workspace(scope.branch, scope.ym).then(setWs).catch((e) => setErr(e.message));
  };
  useEffect(load, [scope.branch, scope.ym]); // eslint-disable-line react-hooks/exhaustive-deps

  const res: CalcResult | null = useMemo(
    () => (ws && boot ? calcCore(api.toCalcCtx(ws, boot.config)) : null),
    [ws, boot],
  );

  const p = ws?.period;
  const status = p?.status || 'NONE';
  const role = boot?.me.role;
  const me = boot?.me.username;
  const blockers = res?.blockers || 0;

  const cur = ORDER.indexOf(status);

  /** ปุ่มไหนกดได้ — ฝั่งหน้าจอเป็นแค่ความสะดวก กติกาจริงบังคับที่ฐานข้อมูล */
  const canDo: Record<Action, { ok: boolean; why?: string }> = {
    SUBMIT: {
      ok: ['DRAFT', 'REJECTED'].includes(status) && blockers === 0,
      why: blockers ? `ยังมีปัญหาระดับบล็อก ${blockers} รายการ` : 'รอบนี้ไม่ได้อยู่สถานะที่ส่งตรวจได้',
    },
    APPROVE: {
      ok: status === 'SUBMITTED' && can.approve(role) && p?.submitted_by !== me,
      why: !can.approve(role) ? 'เฉพาะฝ่าย HR'
        : p?.submitted_by === me ? 'ผู้อนุมัติต้องเป็นคนละบัญชีกับผู้จัดทำ'
          : 'ต้องอยู่สถานะส่งตรวจแล้ว',
    },
    REJECT: {
      ok: status === 'SUBMITTED' && can.approve(role),
      why: !can.approve(role) ? 'เฉพาะฝ่าย HR' : 'ตีกลับได้เฉพาะรอบที่ส่งตรวจแล้ว',
    },
    PAID: {
      ok: status === 'APPROVED' && can.review(role),
      why: status !== 'APPROVED' ? 'ต้องอนุมัติก่อน' : 'เฉพาะฝ่ายบัญชี',
    },
  };

  const LABEL: Record<Action, string> = {
    SUBMIT: 'ส่งตรวจ', APPROVE: 'อนุมัติ',
    REJECT: 'ตีกลับ', PAID: 'บันทึกจ่าย',
  };

  async function doAction(a: Action, note: string) {
    setAsk(null);
    await run(async () => {
      const snapshot = a === 'APPROVE' && res
        ? { totals: res.totals, lines: res.lines.map((L) => ({ licNo: L.licNo, net: L.net, gross: L.gross, tax: L.taxAmt })) }
        : null;
      const r = await api.workflow(scope.branch, scope.ym, a, note, snapshot);
      load();
      setMsg(`${LABEL[a]}เรียบร้อย — สถานะเป็น “${STATUS_TH[r.status] || r.status}”`);
    });
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>ขั้นตอนอนุมัติ</h1>
        {ws && <StatusPill s={status} />}
        <div className="spacer" />
        <BranchMonthPicker
          branches={boot?.branches || []} branch={scope.branch} ym={scope.ym}
          onBranch={scope.setBranch} onYm={scope.setYm}
        />
      </div>

      <Alerts err={err} msg={msg} />

      {!ws || !res ? <div className="card"><Skeleton rows={5} /></div> : (
        <>
          <Card title="ความคืบหน้าของรอบ">
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))' }}>
              {STEPS.map((s) => {
                const idx = ORDER.indexOf(s.key);
                const done = cur >= idx && cur > 0;
                return (
                  <div key={s.key} className="stat"
                    style={done ? { borderColor: 'var(--sage)', background: 'var(--sage-lt)' } : undefined}
                  >
                    <div className="k">{s.who}</div>
                    <div style={{ fontWeight: 600, fontSize: '.95rem' }}>
                      {done ? '✓ ' : ''}{s.label}
                    </div>
                    <div className="s">
                      {s.key === 'SUBMITTED' && p?.submitted_by}
                      {s.key === 'REVIEWED' && p?.reviewed_by}
                      {s.key === 'APPROVED' && p?.approved_by}
                      {s.key === 'PAID' && (p?.paid_ref || p?.paid_by)}
                    </div>
                  </div>
                );
              })}
            </div>

            {status === 'REJECTED' && (
              <Note tone="bad">
                รอบนี้ถูกตีกลับ — แก้ข้อมูลแล้วส่งตรวจใหม่ได้
                {ws.history[0]?.note && <><br /><b>เหตุผล:</b> {ws.history[0].note}</>}
              </Note>
            )}

            <div className="row" style={{ marginTop: 12 }}>
              {(['SUBMIT', 'APPROVE', 'REJECT', 'PAID'] as Action[]).map((a) => (
                <button
                  key={a}
                  className={a === 'REJECT' ? 'danger' : canDo[a].ok ? 'primary' : ''}
                  disabled={!canDo[a].ok || busy}
                  title={canDo[a].ok ? '' : canDo[a].why}
                  onClick={() => setAsk(a)}
                >
                  {LABEL[a]}
                </button>
              ))}
            </div>
            <p className="muted" style={{ marginBottom: 0 }}>
              ระบบบังคับว่าผู้จัดทำและผู้อนุมัติ (ฝ่าย HR) ต้องเป็นคนละบัญชี — ตรวจที่ฐานข้อมูลทุกครั้ง
              ไม่ใช่แค่ซ่อนปุ่ม · เมื่ออนุมัติแล้วยอดถูกล็อกเป็น snapshot แก้ไม่ได้อีก
            </p>
          </Card>

          <div className="grid g4" style={{ marginBottom: 14 }}>
            <Stat k="รวมเงินได้" v={<Money v={res.totals.gross} />} />
            <Stat k="ภาษีหัก ณ ที่จ่าย" v={<Money v={res.totals.tax} />} />
            <Stat k="จ่ายสุทธิ" v={<Money v={res.totals.net} />} />
            <Stat
              k="ปัญหาระดับบล็อก" v={blockers} tone={blockers ? 'bad' : 'ok'}
              s={blockers ? 'ส่งตรวจไม่ได้' : 'พร้อมส่งตรวจ'}
            />
          </div>

          {p?.snapshot != null && (
            <Note tone="ok">
              ยอดที่ล็อกไว้ตอนอนุมัติถูกบันทึกเป็น snapshot แล้ว — ใช้ตรวจย้อนกลับได้ว่าตอนอนุมัติยอดเป็นเท่าไร
            </Note>
          )}

          <Card title="ประวัติการดำเนินการ">
            {ws.history.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>ยังไม่มีการดำเนินการในรอบนี้</p>
            ) : (
              <div className="tablewrap">
                <table>
                  <thead>
                    <tr><th>เมื่อ</th><th>การกระทำ</th><th>ผู้ทำรายการ</th><th>หมายเหตุ</th></tr>
                  </thead>
                  <tbody>
                    {ws.history.map((h, i) => (
                      <tr key={i}>
                        <td className="muted">{(h.at || '').replace('T', ' ').substring(0, 16)}</td>
                        <td>{LABEL[h.action as Action] || h.action}</td>
                        <td>{h.actor}</td>
                        <td>{h.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

      <Confirm
        open={!!ask}
        title={ask ? `ยืนยัน${LABEL[ask]}` : ''}
        needReason={ask === 'REJECT' || ask === 'PAID'}
        confirmText={ask ? LABEL[ask] : ''}
        body={
          ask === 'APPROVE' ? 'เมื่ออนุมัติแล้ว ยอดจะถูกล็อกเป็น snapshot และไม่มีใครแก้ได้อีก รวมถึงผู้ดูแลระบบ'
            : ask === 'PAID' ? 'ระบบไม่สั่งโอนเงิน บันทึกเลขอ้างอิงการจ่ายอย่างเดียว — กรอกเลขอ้างอิงด้านล่าง'
              : ask === 'REJECT' ? 'สาขาจะกลับมาแก้ไขข้อมูลได้ — ต้องระบุเหตุผล'
                : ask === 'SUBMIT' ? 'หลังส่งตรวจ สาขาจะแก้ข้อมูลไม่ได้จนกว่าฝ่ายบัญชีจะตีกลับ'
                  : undefined
        }
        onOk={(reason) => ask && doAction(ask, reason)}
        onCancel={() => setAsk(null)}
      />
    </>
  );
}
