/* ============================================================================
 * Wht.tsx — ส่งเมลหนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ) หาแพทย์
 *
 * สำหรับฝ่ายบัญชี:
 *   1. ออก 50 ทวิ จากโปรแกรมบัญชีตามปกติ (PDF คนละไฟล์)
 *   2. ลากไฟล์ทั้งหมดมาวางทีเดียว — ระบบจับคู่ไฟล์กับแพทย์จาก "เลข ว." หรือชื่อในชื่อไฟล์
 *   3. ตรวจคู่ แก้ที่ผิด แล้วกดส่ง — แต่ละคนได้เมลพร้อมไฟล์ของตัวเองเท่านั้น
 *
 * ไฟล์แนบไม่ถูกเก็บในระบบ — ส่งผ่านไปที่ผู้ให้บริการอีเมลแล้วทิ้ง
 * ยอดในตัวเมลดึงจาก snapshot ที่ล็อกตอนอนุมัติ จึงตรงกับเอกสารที่อนุมัติเสมอ
 * ==========================================================================*/
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Scope } from '../App';
import { api, type MailRow, type MailTargets } from '../lib/api';
import { useAuth } from '../lib/auth';
import { docNick, splitName } from '../lib/names';
import {
  Alerts, BranchMonthPicker, Card, Money, Note, Skeleton, StatusPill, useAsync, YmLabel,
} from '../components/ui';

const thTime = (s: string | null) => (s ? s.replace('T', ' ').substring(0, 16) : '—');
const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);
const MAX_BYTES = 8 * 1024 * 1024;

/** อ่านไฟล์เป็น base64 (ไม่เอาส่วนหัว data:...;base64,) */
function toBase64(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => rej(new Error(`อ่านไฟล์ ${f.name} ไม่สำเร็จ`));
    r.readAsDataURL(f);
  });
}

/** เดาว่าไฟล์นี้เป็นของแพทย์คนไหน จากชื่อไฟล์ — เลข ว. ก่อน แล้วค่อยชื่อจริง/ชื่อเล่น */
function guessOwner(fileName: string, rows: MailRow[]): string {
  const base = fileName.replace(/\.[^.]+$/, '');
  const nums = base.match(/\d{4,6}/g) || [];
  for (const n of nums) {
    const hit = rows.find((r) => r.licNo === n);
    if (hit) return hit.licNo;
  }
  const flat = base.replace(/[\s_\-.()]+/g, '');
  const byName = rows.filter((r) => {
    const first = splitName(r.name).first;
    return first.length >= 2 && flat.includes(first);
  });
  if (byName.length === 1) return byName[0].licNo;
  const byNick = rows.filter((r) => r.nick && r.nick.length >= 2 && flat.includes(r.nick));
  if (byNick.length === 1) return byNick[0].licNo;
  return '';
}

interface Picked { file: File; owner: string }

export default function Wht({ scope }: { scope: Scope }) {
  const { boot } = useAuth();
  const [data, setData] = useState<MailTargets | null>(null);
  const [files, setFiles] = useState<Picked[]>([]);
  const [note, setNote] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<Record<string, { ok: boolean; error?: string }>>({});
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const dropRef = useRef<HTMLInputElement>(null);
  const { busy, err, msg, setErr, setMsg, run } = useAsync();

  const load = () => {
    setData(null); setResult({}); setSel(new Set());
    api.emailTargets(scope.branch, scope.ym).then(setData).catch((e) => setErr(e.message));
  };
  useEffect(() => { load(); setFiles([]); }, [scope.branch, scope.ym]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = data?.rows || [];
  const approved = ['APPROVED', 'PAID'].includes(data?.status || '');

  /** ไฟล์ของแพทย์แต่ละคน (คนละ 1 ไฟล์ — ถ้ามีหลายไฟล์ใช้ไฟล์ล่าสุด) */
  const fileOf = useMemo(() => {
    const m = new Map<string, File>();
    files.forEach((p) => { if (p.owner) m.set(p.owner, p.file); });
    return m;
  }, [files]);
  const orphan = files.filter((p) => !p.owner);
  const ready = rows.filter((r) => r.email && fileOf.has(r.licNo));

  function addFiles(list: FileList | File[] | null) {
    if (!list) return;
    const arr = [...list];
    const bad = arr.filter((f) => f.size > MAX_BYTES).map((f) => f.name);
    const okFiles = arr.filter((f) => f.size <= MAX_BYTES);
    setFiles((prev) => {
      const next = [...prev];
      okFiles.forEach((f) => {
        const i = next.findIndex((p) => p.file.name === f.name);
        const item = { file: f, owner: guessOwner(f.name, rows) };
        if (i >= 0) next[i] = item; else next.push(item);
      });
      return next;
    });
    setResult({});
    if (bad.length) setErr(`ไฟล์ใหญ่เกิน 8MB ไม่ได้แนบ: ${bad.join(', ')}`);
  }

  const setOwner = (name: string, owner: string) =>
    setFiles((prev) => prev.map((p) => (p.file.name === name ? { ...p, owner } : p)));
  const dropFileOf = (lic: string) =>
    setFiles((prev) => prev.filter((p) => p.owner !== lic));

  /** ส่งทีละคน — ไฟล์ PDF หลายไฟล์รวมกันอาจใหญ่เกินกว่าคำขอเดียวจะรับไหว */
  const sendCerts = () => run(async () => {
    const targets = ready.filter((r) => !sel.size || sel.has(r.licNo));
    if (!targets.length) { setErr('ยังไม่มีแพทย์ที่แนบไฟล์และมีอีเมล'); return; }
    let ok = 0;
    const res: Record<string, { ok: boolean; error?: string }> = {};
    setProgress({ done: 0, total: targets.length });
    for (let i = 0; i < targets.length; i++) {
      const r = targets[i];
      const f = fileOf.get(r.licNo)!;
      try {
        const content = await toBase64(f);
        const out = await api.sendMail('wht_cert', scope.branch, scope.ym, [r.licNo], {
          attachments: { [r.licNo]: { filename: f.name, content } }, note,
        });
        const one = out.results.find((x) => x.licNo === r.licNo) || { ok: false, error: 'ไม่มีผลตอบกลับ' };
        res[r.licNo] = one;
        if (one.ok) ok++;
      } catch (e) {
        res[r.licNo] = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      setResult({ ...res });
      setProgress({ done: i + 1, total: targets.length });
    }
    setProgress(null);
    setMsg(`ส่ง 50 ทวิ สำเร็จ ${ok} จาก ${targets.length} คน`);
    api.emailTargets(scope.branch, scope.ym).then(setData).catch(() => undefined);
  });

  /** สรุปยอดหักภาษีทางเมล (ไม่แนบไฟล์) — ใช้ตอนยังไม่ได้ออก 50 ทวิ */
  const sendSummary = () => run(async () => {
    const lics = [...sel].filter((l) => rows.find((r) => r.licNo === l)?.email);
    if (!lics.length) { setErr('เลือกแพทย์ที่มีอีเมลก่อน'); return; }
    const out = await api.sendMail('tax_detail', scope.branch, scope.ym, lics, { note });
    const res: Record<string, { ok: boolean; error?: string }> = {};
    out.results.forEach((x) => { res[x.licNo] = { ok: x.ok, error: x.error }; });
    setResult(res);
    setMsg(`ส่งสรุปยอดหักภาษีสำเร็จ ${out.sent} จาก ${out.total} คน${out.logError ? ` · ${out.logError}` : ''}`);
    api.emailTargets(scope.branch, scope.ym).then(setData).catch(() => undefined);
  });

  const toggle = (lic: string) => setSel((s) => {
    const n = new Set(s);
    if (n.has(lic)) n.delete(lic); else n.add(lic);
    return n;
  });

  const totals = rows.reduce((a, r) => ({ gross: a.gross + r.gross, tax: a.tax + r.tax }), { gross: 0, tax: 0 });

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>ส่งเมลหัก ณ ที่จ่าย</h1>
        {data && <StatusPill s={data.status} />}
        <div className="spacer" />
        <BranchMonthPicker
          branches={boot?.branches || []} branch={scope.branch} ym={scope.ym}
          onBranch={scope.setBranch} onYm={scope.setYm}
        />
      </div>

      <Alerts err={err} msg={msg} />

      {!data ? <div className="card"><Skeleton rows={5} /></div> : (
        <>
          {!approved && (
            <Note tone="warn">
              ส่งได้เฉพาะรอบที่ <b>อนุมัติแล้ว</b> — รอบนี้ยังอยู่สถานะ “{data.status}”
              ยอดภาษีที่ส่งไปจะดึงจากยอดที่ล็อกไว้ตอนอนุมัติ จึงตรงกับ 50 ทวิ เสมอ
            </Note>
          )}

          <Card title="① แนบไฟล์ 50 ทวิ"
            right={<span className="muted">PDF คนละไฟล์ · ไม่เกิน 8MB · ลากมาวางทีเดียวได้หลายไฟล์</span>}
          >
            <div
              className="drop"
              onClick={() => dropRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); }}
              onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
              style={{
                border: '2px dashed var(--line)', borderRadius: 12, padding: '22px 16px',
                textAlign: 'center', cursor: 'pointer', background: 'var(--bg)',
              }}
            >
              <b>ลากไฟล์ 50 ทวิ มาวางที่นี่</b> หรือคลิกเพื่อเลือกไฟล์
              <div className="muted" style={{ fontSize: '.82rem', marginTop: 4 }}>
                ตั้งชื่อไฟล์ให้มี <b>เลข ว.</b> ของแพทย์ เช่น <code>50ทวิ_56186_ส.ค.69.pdf</code>
                ระบบจะจับคู่ให้เอง (ถ้าไม่มี จะลองหาจากชื่อจริงหรือชื่อเล่นในชื่อไฟล์)
              </div>
              <input ref={dropRef} type="file" accept="application/pdf,.pdf,image/*" multiple hidden
                onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
              />
            </div>

            {orphan.length > 0 && (
              <>
                <Note tone="warn">
                  มี {orphan.length} ไฟล์ที่ระบบยังไม่รู้ว่าเป็นของใคร — เลือกเจ้าของให้ด้านล่าง
                </Note>
                <div className="tablewrap">
                  <table>
                    <thead><tr><th>ไฟล์</th><th className="n">ขนาด</th><th>เป็นของ</th><th></th></tr></thead>
                    <tbody>
                      {orphan.map((p) => (
                        <tr key={p.file.name}>
                          <td>{p.file.name}</td>
                          <td className="n">{kb(p.file.size)}</td>
                          <td>
                            <select value="" onChange={(e) => setOwner(p.file.name, e.target.value)}>
                              <option value="">— เลือกแพทย์ —</option>
                              {rows.map((r) => (
                                <option key={r.licNo} value={r.licNo}>
                                  ว.{r.licNo} · {docNick(r.nick) || r.name}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <button className="sm"
                              onClick={() => setFiles((f) => f.filter((x) => x.file.name !== p.file.name))}
                            >
                              เอาออก
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </Card>

          <Card
            title={<>② ตรวจคู่และส่ง · <YmLabel ym={scope.ym} /></>}
            right={
              <div className="row" style={{ gap: 6 }}>
                <button className="sm" disabled={busy}
                  onClick={() => setSel(new Set(rows.filter((r) => r.email).map((r) => r.licNo)))}
                >
                  เลือกทุกคนที่มีอีเมล
                </button>
                <button className="sm" disabled={busy} onClick={() => setSel(new Set())}>ล้างที่เลือก</button>
              </div>
            }
          >
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 34 }}></th>
                    <th>แพทย์</th><th>อีเมล</th>
                    <th className="n">รวมเงินได้</th><th className="n">ภาษีหัก ณ ที่จ่าย</th>
                    <th>ไฟล์ 50 ทวิ</th><th>ส่งเรื่องภาษีล่าสุด</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const f = fileOf.get(r.licNo);
                    const res = result[r.licNo];
                    return (
                      <tr key={r.licNo}>
                        <td>
                          <input type="checkbox" disabled={!r.email || busy}
                            checked={sel.has(r.licNo)} onChange={() => toggle(r.licNo)}
                          />
                        </td>
                        <td>
                          ว.{r.licNo} · <b>{docNick(r.nick) || r.name}</b>
                          <div className="muted" style={{ fontSize: '.78rem' }}>{r.name}</div>
                        </td>
                        <td>
                          {r.email
                            ? <span className="muted">{r.email}</span>
                            : <span className="pill bad">ไม่มีอีเมลในทะเบียน</span>}
                          {res && (res.ok
                            ? <><br /><span className="pill ok">ส่งแล้ว</span></>
                            : <><br /><span className="pill bad">ไม่สำเร็จ: {res.error}</span></>)}
                        </td>
                        <td className="n"><Money v={r.gross} /></td>
                        <td className="n"><Money v={r.tax} /></td>
                        <td>
                          {f ? (
                            <span className="pill ok" title={f.name}>
                              📎 {f.name.length > 26 ? `${f.name.slice(0, 24)}…` : f.name} · {kb(f.size)}
                              <button className="sm" style={{ marginLeft: 6, padding: '0 6px' }}
                                onClick={() => dropFileOf(r.licNo)} title="เอาไฟล์นี้ออก"
                              >
                                ✕
                              </button>
                            </span>
                          ) : (
                            <label className="pill none" style={{ cursor: 'pointer' }}>
                              + แนบไฟล์
                              <input type="file" accept="application/pdf,.pdf,image/*" hidden
                                onChange={(e) => {
                                  const one = e.target.files?.[0];
                                  if (one) {
                                    if (one.size > MAX_BYTES) setErr(`ไฟล์ ${one.name} ใหญ่เกิน 8MB`);
                                    else setFiles((p) => [...p.filter((x) => x.owner !== r.licNo),
                                      { file: one, owner: r.licNo }]);
                                  }
                                  e.target.value = '';
                                }}
                              />
                            </label>
                          )}
                        </td>
                        <td className="muted">{thTime(r.lastTaxMail)}</td>
                      </tr>
                    );
                  })}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="muted">
                        ยังไม่มียอดที่อนุมัติในรอบนี้ — ต้องอนุมัติที่แท็บ “อนุมัติ” ก่อน
                      </td>
                    </tr>
                  )}
                </tbody>
                {rows.length > 0 && (
                  <tfoot>
                    <tr>
                      <td></td><td colSpan={2}><b>รวม {rows.length} คน</b></td>
                      <td className="n"><b><Money v={totals.gross} /></b></td>
                      <td className="n"><b><Money v={totals.tax} /></b></td>
                      <td colSpan={2} className="muted">แนบไฟล์แล้ว {fileOf.size} คน</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>

            <label style={{ display: 'block', marginTop: 12 }}>
              <span className="muted" style={{ fontSize: '.85rem' }}>ข้อความเพิ่มเติมในเมล (ไม่บังคับ)</span>
              <textarea rows={2} value={note} maxLength={1000}
                onChange={(e) => setNote(e.target.value)}
                placeholder="เช่น ยอดนี้รวมค่าเวรและค่ามือของเดือนสิงหาคมแล้ว"
                style={{ width: '100%', marginTop: 4 }}
              />
            </label>

            {progress && (
              <Note tone="info">กำลังส่ง {progress.done} / {progress.total} คน… อย่าเพิ่งปิดหน้านี้</Note>
            )}

            <div className="row" style={{ marginTop: 12 }}>
              <button className="primary" disabled={busy || !approved || !ready.length}
                onClick={sendCerts}
              >
                ส่ง 50 ทวิ พร้อมไฟล์แนบ
                ({(sel.size ? ready.filter((r) => sel.has(r.licNo)) : ready).length} คน)
              </button>
              <button disabled={busy || !approved || !sel.size} onClick={sendSummary}>
                ส่งเฉพาะสรุปยอดหักภาษี ไม่แนบไฟล์ ({sel.size})
              </button>
            </div>
            <p className="muted" style={{ marginBottom: 0 }}>
              ปุ่มแรกส่งให้ทุกคนที่แนบไฟล์แล้ว (ถ้าติ๊กเลือกไว้ จะส่งเฉพาะคนที่ติ๊ก) — แต่ละคนได้เฉพาะไฟล์ของตัวเอง ·
              ไฟล์แนบไม่ถูกเก็บในระบบ · ทุกฉบับบันทึกประวัติไว้ตรวจย้อนได้
            </p>
          </Card>
        </>
      )}
    </>
  );
}
