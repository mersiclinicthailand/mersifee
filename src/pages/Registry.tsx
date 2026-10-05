import { useEffect, useMemo, useRef, useState } from 'react';
import { api, dropCache, type PoolRow, type PoolSearch, type RegTodo, type DoctorImportResult } from '../lib/api';
import { parseDoctorFile, type DoctorParsed } from '../lib/parse';
import { toThaiDate } from '../lib/core';
import { useAuth, can } from '../lib/auth';
import { Alerts, Card, Money, Note, Skeleton, useAsync } from '../components/ui';
import { docNick, rawNick } from '../lib/names';

interface Doctor {
  lic_no: string; full_name: string; nick_name: string; bank: string; bank_acc: string;
  id_card: string; address: string; contact: string; email: string;
  payee_type: string; payee_name: string;
  status: string; note: string;
}
interface Rate {
  id?: string; lic_no: string; branch: string; hourly_rate: number;
  tax_base: string; tax_rate: number; hand_method: string;
  eff_from: string | null; eff_to: string | null; note: string;
}

const BLANK_DOC: Doctor = {
  lic_no: '', full_name: '', nick_name: '', bank: '', bank_acc: '', id_card: '',
  address: '', contact: '', email: '',
  payee_type: 'PERSON', payee_name: '', status: 'ACTIVE', note: '',
};
const BLANK_RATE: Rate = {
  lic_no: '', branch: '', hourly_rate: 0, tax_base: 'TOTAL', tax_rate: 3,
  hand_method: 'SOURCE', eff_from: null, eff_to: null, note: '',
};

/** ช่องที่ต้องกรอก → ชื่อภาษาไทย */
const FIELD_TH: Record<string, string> = {
  full_name: 'ชื่อ-สกุล', bank: 'ธนาคาร', bank_acc: 'เลขบัญชี', id_card: 'เลขบัตรประชาชน',
  address: 'ที่อยู่', email: 'อีเมล', payee_name: 'ชื่อผู้รับเงิน (นิติบุคคล)', inactive: 'สถานะพ้นสภาพแต่ยังมีงาน',
};
const KIND_TH: Record<string, { t: string; c: string }> = {
  UNREGISTERED: { t: 'ยังไม่ขึ้นทะเบียน', c: 'block' },
  POOL: { t: 'อยู่ในคลัง ยังไม่ขึ้นทะเบียน', c: 'block' },
  UNKNOWN: { t: 'ชื่อในตารางแพทย์ ยังไม่รู้ว่าใคร', c: 'block' },
  INCOMPLETE: { t: 'ข้อมูลไม่ครบ', c: 'warn' },
};
type TodoFilter = 'ALL' | 'REG' | 'INFO' | 'RATE';
type ImpMode = 'FILL' | 'OVERWRITE' | 'NONE';
const digits = (v: string) => (v || '').replace(/\D/g, '');
/** การเปลี่ยนที่น่าจะผิด → เอาติ๊กออกให้ก่อน (HR ติ๊กกลับเองได้)
 *  เลขเหมือนเดิมแค่หายเลข 0 / ชื่อบริษัททับชื่อแพทย์ / ค่าใหม่สั้นกว่าและเป็นส่วนหนึ่งของค่าเดิม */
function riskyChange(c: { field: string; old: string; new: string }): string {
  if (!c.old) return '';
  if (['bank_acc', 'id_card', 'contact'].includes(c.field)
      && digits(c.old).replace(/^0+/, '') === digits(c.new).replace(/^0+/, '')) {
    return digits(c.new).length < digits(c.old).length ? 'เลข 0 นำหน้าหาย' : 'ต่างแค่รูปแบบ';
  }
  if (c.field === 'full_name' && /^บริษัท|จำกัด/.test(c.new)) return 'เป็นชื่อบริษัท ไม่ใช่ชื่อแพทย์';
  if (c.new.length < c.old.length && c.old.replace(/\s+/g, '').includes(c.new.replace(/\s+/g, ''))) return 'ข้อมูลใหม่สั้นกว่าเดิม';
  return '';
}
/** เดือน ym → ชื่อเดือนย่อ เช่น 2026-08 → ส.ค. 69 */
const ymShort = (ym: string) => toThaiDate(ym + '-01').replace(/^1\s+/, '').replace(/\s+25(\d\d)$/, ' $1');

const TAX_BASE_TH: Record<string, string> = {
  TOTAL: 'รวมเงินได้', SHIFT: 'เฉพาะค่าเวร', NONE: 'ไม่หักภาษี',
};

export default function Registry() {
  const { boot } = useAuth();
  const [tab, setTab] = useState<'doc' | 'rate'>('doc');
  const [docs, setDocs] = useState<Doctor[] | null>(null);
  const [rates, setRates] = useState<Rate[] | null>(null);
  const [editDoc, setEditDoc] = useState<Doctor | null>(null);
  const [editRate, setEditRate] = useState<Rate | null>(null);
  const { busy, err, msg, setErr, setMsg, run } = useAsync();

  /* คลังรายชื่อแพทย์ — 674 รายชื่อที่ย้ายมาจากระบบเดิมแต่ยังไม่เคยขึ้นทะเบียน */
  const [poolOpen, setPoolOpen] = useState(false);
  const [poolQ, setPoolQ] = useState('');
  const [pool, setPool] = useState<PoolSearch | null>(null);
  const [poolPick, setPoolPick] = useState<Set<string>>(new Set());

  /* ---------- สิ่งที่ต้องทำในทะเบียน (แจ้งเตือน) ---------- */
  const [todo, setTodo] = useState<RegTodo[] | null>(null);
  const [tf, setTf] = useState<TodoFilter>('ALL');
  const [need, setNeed] = useState<Set<string>>(new Set());   // ช่องที่ต้องกรอกของฟอร์มที่เปิดอยู่
  const formRef = useRef<HTMLDivElement>(null);
  const loadTodo = () => {
    dropCache('todo');
    api.registryTodo().then(setTodo).catch(() => setTodo([]));
  };
  useEffect(loadTodo, []);
  const todoView = useMemo(() => (todo || []).filter((t) => {
    if (tf === 'REG') return t.kind !== 'INCOMPLETE';
    if (tf === 'INFO') return t.kind === 'INCOMPLETE' && t.missing.length > 0;
    if (tf === 'RATE') return t.rateGaps.length > 0;
    return true;
  }), [todo, tf]);
  const cnt = useMemo(() => ({
    REG: (todo || []).filter((t) => t.kind !== 'INCOMPLETE').length,
    INFO: (todo || []).filter((t) => t.kind === 'INCOMPLETE' && t.missing.length > 0).length,
    RATE: (todo || []).filter((t) => t.rateGaps.length > 0).length,
  }), [todo]);
  const scrollToForm = () => setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);

  /* ---------- นำเข้าทะเบียนแพทย์จาก Excel ---------- */
  const [impOpen, setImpOpen] = useState(false);
  const [impFile, setImpFile] = useState<DoctorParsed | null>(null);
  const [impMode, setImpMode] = useState<ImpMode>('FILL');
  const [impPrev, setImpPrev] = useState<DoctorImportResult | null>(null);
  const [impSkip, setImpSkip] = useState<Set<string>>(new Set());
  const [impShow, setImpShow] = useState<'' | 'skip' | 'warn' | 'dup'>('');

  const impPreview = (parsed: DoctorParsed, mode: ImpMode) => run(async () => {
    setImpPrev(null);
    const r = await api.doctorImport(parsed.rows, mode, true, parsed.fileName);
    setImpPrev(r);
    setImpSkip(new Set(r.docChanges.filter((c) => riskyChange(c)).map((c) => `${c.licNo}|${c.field}`)));
  });
  const impPick = (f: File | null) => f && run(async () => {
    setImpFile(null); setImpPrev(null); setImpShow('');
    const p = await parseDoctorFile(f);
    setImpFile(p);
    await impPreview(p, impMode);
  });
  const impApply = () => impFile && run(async () => {
    const r = await api.doctorImport(impFile.rows, impMode, false, impFile.fileName, [...impSkip]);
    setImpFile(null); setImpPrev(null); setImpOpen(false);
    load();
    setMsg(`นำเข้าทะเบียนแพทย์แล้ว · ${r.rows} คนในไฟล์ · แพทย์ใหม่เข้าคลัง ${r.poolNew} · อัปเดตคลัง ${r.poolChanged}`
      + ` · แก้ทะเบียน ${r.docUpdated} คน (${r.docChanges.length} ช่อง)`
      + ' — แพทย์ที่มีงานแต่ยังไม่ขึ้นทะเบียนจะขึ้นในรายการ 🔔 ด้านบน');
  });

  const role = boot?.me.role;
  const mayDoc = can.registry(role);
  const mayRate = can.rates(role);

  const load = () => {
    loadTodo();
    api.listDoctors().then((d) => setDocs(d as Doctor[])).catch((e) => setErr(e.message));
    api.listRates().then((r) => setRates(r as Rate[])).catch((e) => setErr(e.message));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ค้นคลังแบบหน่วงคำพิมพ์ — กันยิงทุกตัวอักษร */
  useEffect(() => {
    if (!poolOpen) return;
    setPool(null);
    const t = setTimeout(() => {
      api.poolSearch(poolQ, 100).then(setPool).catch((e) => setErr(e.message));
    }, poolQ ? 300 : 0);
    return () => clearTimeout(t);
  }, [poolOpen, poolQ]); // eslint-disable-line react-hooks/exhaustive-deps

  const togglePick = (lic: string) => setPoolPick((s) => {
    const n = new Set(s);
    if (n.has(lic)) n.delete(lic); else n.add(lic);
    return n;
  });

  const promote = () => run(async () => {
    const licNos = [...poolPick];
    if (!licNos.length) throw new Error('ยังไม่ได้เลือกแพทย์');
    const r = await api.poolPromote(licNos);
    setPoolPick(new Set());
    load();
    setPool(null);
    api.poolSearch(poolQ, 100).then(setPool).catch(() => { /* โหลดใหม่ไม่ได้ก็ไม่เป็นไร */ });
    setMsg(
      `ขึ้นทะเบียนแล้ว ${r.added} คน`
      + (r.skipped ? ` · ข้ามที่มีในทะเบียนอยู่แล้ว ${r.skipped} คน` : '')
      + ' — อย่าลืมตั้งอัตราค่าตอบแทนที่แท็บ “อัตราและสัญญา”',
    );
  });

  const saveDoc = () => editDoc && run(async () => {
    if (!editDoc.lic_no.trim() || !editDoc.full_name.trim()) {
      throw new Error('ต้องระบุรหัส ว. และชื่อ-สกุล');
    }
    await api.saveDoctor({ ...editDoc, lic_no: editDoc.lic_no.trim(), nick_name: rawNick(editDoc.nick_name) });
    setEditDoc(null); setNeed(new Set()); load(); loadTodo();
    setMsg('บันทึกทะเบียนแพทย์แล้ว');
  });

  const saveRate = () => editRate && run(async () => {
    if (!editRate.hourly_rate) throw new Error('ต้องระบุอัตราต่อชั่วโมง');
    if (!editRate.eff_from) throw new Error('ต้องระบุวันที่เริ่มมีผล — อัตราที่ไม่มีวันมีผลทำให้ตรวจย้อนกลับไม่ได้');
    await api.saveRate({
      ...editRate,
      lic_no: editRate.lic_no.trim() || '*',
      approved_by: boot?.me.username || '',
    });
    setEditRate(null); load();
    setMsg('บันทึกอัตราแล้ว — อัตราที่เปลี่ยนไม่กระทบรอบที่อนุมัติไปแล้ว');
  });

  /* ปุ่มลัดจากรายการแจ้งเตือน */
  const fixInfo = (t: RegTodo) => {
    const d = docs?.find((x) => x.lic_no === t.licNo);
    setTab('doc');
    setNeed(new Set(t.missing));
    setEditDoc(d ? { ...d, status: t.missing.includes('inactive') ? 'ACTIVE' : d.status }
      : { ...BLANK_DOC, lic_no: t.licNo, nick_name: t.nick.replace(/^หมอ\s*/, ''), full_name: t.name });
    scrollToForm();
  };
  /** ชื่อในตารางแพทย์ที่ยังไม่รู้ว่าใคร → ผูกกับหมอที่มีในทะเบียนแล้ว */
  const [assign, setAssign] = useState<Record<string, string>>({});
  const assignLabel = (t: RegTodo, lic: string) => run(async () => {
    const r = await api.rosterAssignLabel(t.nick, lic);
    const d = (docs || []).find((x) => x.lic_no === lic);
    loadTodo();
    setMsg(`จับคู่ "${t.nick}" = ${docNick(d?.nick_name) || d?.full_name || ''} (ว.${lic}) แล้ว · เติมเลข ว. ให้ ${r.updated} เวรในตารางแพทย์`
      + (r.aliases ? ' · จำชื่อนี้ไว้แล้ว ไฟล์ตารางเวรครั้งหน้าจับคู่เอง' : ''));
  });
  const fixPool = (t: RegTodo) => run(async () => {
    const r = await api.poolPromote([t.licNo]);
    load();
    setMsg(r.added
      ? `ขึ้นทะเบียน ${t.nick || t.name} (ว.${t.licNo}) จากคลังแล้ว — ตรวจข้อมูลที่ยังขาดในรายการด้านบน`
      : `ว.${t.licNo} มีในทะเบียนอยู่แล้ว`);
  });
  const fixRate = (t: RegTodo) => {
    const gaps = t.rateGaps.slice().sort((a, b) => (a.ym < b.ym ? -1 : 1));
    const brs = Array.from(new Set(gaps.map((g) => g.branch)));
    setTab('rate');
    setEditRate({
      ...BLANK_RATE, lic_no: t.licNo,
      branch: brs.length === 1 ? brs[0] : '',
      eff_from: gaps[0] ? gaps[0].ym + '-01' : null,
      note: brs.length > 1 ? `ทำงานหลายสาขา: ${brs.join(', ')}` : '',
    });
    scrollToForm();
  };

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>ทะเบียน</h1>
        <div className="spacer" />
        <button className={tab === 'doc' ? 'primary' : ''} onClick={() => setTab('doc')}>แพทย์</button>
        <button className={tab === 'rate' ? 'primary' : ''} onClick={() => setTab('rate')}>อัตราและสัญญา</button>
      </div>

      <Alerts err={err} msg={msg} />

      {/* ---------- แจ้งเตือน: ต้องขึ้นทะเบียน / กรอกข้อมูล / ตั้งอัตรา ---------- */}
      {todo && todo.length > 0 && (
        <Card
          title={<>🔔 ต้องดำเนินการในทะเบียน ({todo.length} คน)</>}
          right={<span className="muted">ดูจากตารางแพทย์ · ใบเวร · ค่ามือ 3 เดือนล่าสุด</span>}
        >
          <div className="chips">
            {([
              ['ALL', `ทั้งหมด ${todo.length}`], ['REG', `ต้องขึ้นทะเบียน ${cnt.REG}`],
              ['INFO', `ข้อมูลไม่ครบ ${cnt.INFO}`], ['RATE', `ยังไม่มีอัตรา ${cnt.RATE}`],
            ] as [TodoFilter, string][]).map(([k, label]) => (
              <button key={k} className={`sm ${tf === k ? 'on' : ''}`} onClick={() => setTf(k)}>{label}</button>
            ))}
          </div>
          <div className="tablewrap" style={{ maxHeight: 420, overflow: 'auto' }}>
            <table>
              <thead>
                <tr><th>แพทย์</th><th>สถานะ</th><th>สาขาที่มีงาน</th><th>ต้องเติม</th><th></th></tr>
              </thead>
              <tbody>
                {todoView.map((t) => {
                  const k = KIND_TH[t.kind];
                  const gapsByBr: Record<string, string[]> = {};
                  t.rateGaps.forEach((g) => { (gapsByBr[g.branch] = gapsByBr[g.branch] || []).push(g.ym); });
                  return (
                    <tr key={t.key}>
                      <td>
                        <b>{docNick(t.nick) || t.nick || '—'}</b>
                        {t.licNo && <span className="muted"> · ว.{t.licNo}</span>}
                        {t.name && <div className="muted" style={{ fontSize: '.8rem' }}>{t.name}</div>}
                      </td>
                      <td>
                        <span className={`pill ${k.c}`}>{k.t}</span>
                        {t.days ? <div className="muted" style={{ fontSize: '.78rem' }}>{t.days} เวรในตาราง</div> : null}
                      </td>
                      <td className="muted">{t.branches.join(', ')}<br />ล่าสุด {ymShort(t.lastYm)}</td>
                      <td>
                        {t.kind === 'UNREGISTERED' && (
                          <span className="pill block">
                            {t.inPool ? 'มีในคลังรายชื่อ — กดขึ้นทะเบียนได้เลย' : 'ไม่มีในคลัง — ต้องเพิ่มแพทย์ใหม่'}
                          </span>
                        )}
                        {t.kind === 'POOL' && <span className="pill block">กดขึ้นทะเบียนจากคลัง แล้วจับคู่ตารางแพทย์ใหม่</span>}
                        {t.kind === 'UNKNOWN' && (
                          <span className="pill block">ไม่รู้เลข ว. — เพิ่มแพทย์ หรือแก้ชื่อในแท็บตารางแพทย์</span>
                        )}
                        {t.missing.map((m) => <span key={m} className="pill warn" style={{ marginRight: 4 }}>{FIELD_TH[m] || m}</span>)}
                        {Object.keys(gapsByBr).length > 0 && (
                          <div style={{ marginTop: 3, fontSize: '.8rem' }}>
                            <span className="pill none">ไม่มีอัตรา</span>{' '}
                            {Object.entries(gapsByBr).map(([b, ys]) => `${b} (${ys.sort().map(ymShort).join(', ')})`).join(' · ')}
                          </div>
                        )}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {mayDoc && (t.kind === 'POOL' || (t.kind === 'UNREGISTERED' && t.inPool)) && (
                          <button className="sm primary" disabled={busy} onClick={() => fixPool(t)}>ขึ้นทะเบียน</button>
                        )}
                        {mayDoc && t.kind === 'UNKNOWN' && (
                          <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                            <select value={assign[t.key] || ''} style={{ maxWidth: 190 }}
                              onChange={(e) => setAssign((a) => ({ ...a, [t.key]: e.target.value }))}
                            >
                              <option value="">— เป็นหมอที่มีอยู่แล้ว —</option>
                              {(docs || []).slice().sort((a, b) => (a.nick_name || '').localeCompare(b.nick_name || '', 'th'))
                                .map((d) => (
                                  <option key={d.lic_no} value={d.lic_no}>
                                    {docNick(d.nick_name) || d.full_name} · ว.{d.lic_no}
                                  </option>
                                ))}
                            </select>
                            <button className="sm primary" disabled={busy || !assign[t.key]}
                              onClick={() => assignLabel(t, assign[t.key])}
                            >จับคู่</button>
                          </div>
                        )}
                        {mayDoc && ((t.kind === 'UNREGISTERED' && !t.inPool) || t.kind === 'UNKNOWN') && (
                          <button className="sm" onClick={() => fixInfo(t)}>
                            {t.kind === 'UNKNOWN' ? 'หรือ เพิ่มเป็นหมอใหม่' : 'เพิ่มแพทย์'}
                          </button>
                        )}
                        {mayDoc && t.kind === 'INCOMPLETE' && t.missing.length > 0 && (
                          <button className="sm primary" onClick={() => fixInfo(t)}>กรอกข้อมูล</button>
                        )}{' '}
                        {mayRate && t.licNo && t.rateGaps.length > 0 && t.kind === 'INCOMPLETE' && (
                          <button className="sm" onClick={() => fixRate(t)}>ตั้งอัตรา</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {todoView.length === 0 && (
                  <tr><td colSpan={5} className="muted">ไม่มีรายการในหมวดนี้ 🎉</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {!mayDoc && (
            <p className="muted" style={{ marginBottom: 0 }}>
              บทบาทของคุณดูได้อย่างเดียว — ส่งรายการนี้ให้ฝ่ายบุคคลกรอกข้อมูล
            </p>
          )}
        </Card>
      )}

      {tab === 'doc' && (
        <Card
          title={`ทะเบียนแพทย์ (${docs?.length ?? '—'} คน)`}
          right={mayDoc && (
            <div className="row" style={{ gap: 6 }}>
              <button className={poolOpen ? 'primary' : ''}
                onClick={() => { setPoolOpen(!poolOpen); setPoolPick(new Set()); }}
              >
                {poolOpen ? 'ปิดคลังรายชื่อ' : 'ดึงจากคลังรายชื่อ'}
              </button>
              <button className={impOpen ? 'primary' : ''}
                onClick={() => { setImpOpen(!impOpen); setImpFile(null); setImpPrev(null); }}
              >
                {impOpen ? 'ปิดนำเข้า' : '⬆ นำเข้าจาก Excel'}
              </button>
              <button className="primary" onClick={() => setEditDoc({ ...BLANK_DOC })}>+ เพิ่มแพทย์</button>
            </div>
          )}
        >
          {!mayDoc && <Note tone="info">บทบาทของคุณดูได้อย่างเดียว — แก้ไขได้เฉพาะฝ่ายบุคคลและผู้ดูแลระบบ</Note>}
          {!docs ? <Skeleton rows={5} /> : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>รหัส ว.</th><th>ชื่อ-สกุล</th><th>ชื่อเล่น</th><th>ธนาคาร</th>
                    <th>เลขบัญชี</th><th>ผู้รับเงิน</th><th>ติดต่อ</th><th>อีเมล</th>
                    <th>สถานะ</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {docs.map((d) => (
                    <tr key={d.lic_no}>
                      <td>{d.lic_no}</td>
                      <td>{d.full_name}</td>
                      <td>{docNick(d.nick_name)}</td>
                      <td>{d.bank}</td>
                      <td className="tnum">{d.bank_acc}</td>
                      <td>
                        {d.payee_type === 'COMPANY'
                          ? <span className="pill warn">นิติบุคคล · {d.payee_name}</span>
                          : 'บุคคลธรรมดา'}
                      </td>
                      <td className="muted">{d.contact}</td>
                      <td>
                        {d.email
                          ? <span className="muted">{d.email}</span>
                          : <span className="pill warn">ยังไม่มีอีเมล</span>}
                      </td>
                      <td>
                        <span className={`pill ${d.status === 'ACTIVE' ? 'ok' : 'none'}`}>
                          {d.status === 'ACTIVE' ? 'ปฏิบัติงาน' : 'พ้นสภาพ'}
                        </span>
                      </td>
                      <td>
                        {mayDoc && <button className="sm" onClick={() => setEditDoc({ ...d })}>แก้ไข</button>}
                      </td>
                    </tr>
                  ))}
                  {docs.length === 0 && (
                    <tr><td colSpan={10} className="muted">ยังไม่มีแพทย์ในทะเบียน</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* ---------- นำเข้าทะเบียนแพทย์จาก Excel ---------- */}
      {tab === 'doc' && impOpen && mayDoc && (
        <Card title="นำเข้าทะเบียนแพทย์จาก Excel (ไฟล์ Data หมอ Update)">
          <Note tone="info">
            ใช้ไฟล์รูปแบบเดิมของ HR (ชีต “หมอทุกสาขา”: การันตีหมอ · วันเกิด · เลขว. · เลขบัตรประชาชน ·
            ชื่อ-นามสกุล · ชื่อเล่น · เบอร์ติดต่อ · ที่อยู่ · ธนาคาร · เลขบัญชี · สาขา · Mail · หมายเหตุ) —
            อ่านในเบราว์เซอร์ นำเข้าซ้ำได้ทุกครั้งที่อัปเดต ·
            แพทย์ทุกคนในไฟล์เข้า<b>คลังรายชื่อ</b> ·
            แพทย์ที่<b>ขึ้นทะเบียนแล้ว</b>จะแก้ตามโหมดที่เลือก · ระบบไม่ลบใครออก และไม่เอาค่าว่างทับข้อมูลเดิม
          </Note>
          <div className="row" style={{ gap: 16, flexWrap: 'wrap', marginBottom: 10 }}>
            <input type="file" accept=".xlsx,.xls" disabled={busy}
              onChange={(e) => impPick(e.target.files?.[0] || null)} />
            {([
              ['FILL', 'เติมเฉพาะช่องที่ยังว่าง (แนะนำ)'],
              ['OVERWRITE', 'ทับด้วยข้อมูลในไฟล์'],
              ['NONE', 'อัปเดตแค่คลัง ไม่แตะทะเบียน'],
            ] as [ImpMode, string][]).map(([m, t]) => (
              <label key={m} className="inline-field">
                <input type="radio" name="impmode" checked={impMode === m} disabled={busy}
                  onChange={() => { setImpMode(m); if (impFile) impPreview(impFile, m); }} />
                <span>{t}</span>
              </label>
            ))}
          </div>

          {impFile && (
            <>
              <div className="grid g4" style={{ marginBottom: 10 }}>
                <div className="stat"><div className="k">แถวในไฟล์</div><div className="v">{impFile.total}</div>
                  <div className="s">ชีต {impFile.sheet}</div></div>
                <div className="stat"><div className="k">แพทย์ที่นำเข้าได้</div><div className="v">{impFile.rows.length}</div>
                  <div className="s">มีเลข ว. ถูกต้อง</div></div>
                <div className="stat"><div className="k">แพทย์ใหม่ (เข้าคลัง)</div><div className="v">{impPrev ? impPrev.poolNew : '…'}</div>
                  <div className="s">อัปเดตข้อมูลในคลัง {impPrev ? impPrev.poolChanged : '…'} คน</div></div>
                <div className="stat"><div className="k">ขึ้นทะเบียนแล้ว</div><div className="v">{impPrev ? impPrev.registered : '…'}</div>
                  <div className="s">จะแก้ {impPrev ? impPrev.docChanges.length - impSkip.size : '…'} ช่อง</div></div>
              </div>

              <div className="chips">
                <button className={`sm ${impShow === 'skip' ? 'on' : ''}`} onClick={() => setImpShow(impShow === 'skip' ? '' : 'skip')}>
                  ข้าม {impFile.skipped.length} แถว
                </button>
                <button className={`sm ${impShow === 'dup' ? 'on' : ''}`} onClick={() => setImpShow(impShow === 'dup' ? '' : 'dup')}>
                  เลข ว. ซ้ำ {impFile.dups.length}
                </button>
                <button className={`sm ${impShow === 'warn' ? 'on' : ''}`} onClick={() => setImpShow(impShow === 'warn' ? '' : 'warn')}>
                  ข้อควรตรวจ {impFile.warnings.length}
                </button>
              </div>
              {impShow === 'skip' && (
                <div className="tablewrap" style={{ maxHeight: 260, overflow: 'auto', marginBottom: 10 }}>
                  <table><thead><tr><th className="n">แถว</th><th>เลข ว.</th><th>ชื่อ</th><th>เหตุผล</th></tr></thead>
                    <tbody>{impFile.skipped.map((x) => (
                      <tr key={x.row}><td className="n">{x.row}</td><td>{x.lic || '—'}</td><td>{x.name}</td><td className="muted">{x.reason}</td></tr>
                    ))}</tbody></table>
                </div>
              )}
              {impShow === 'dup' && (
                <Note tone="warn">
                  เลข ว. เดียวกันมีหลายแถว — ระบบใช้แถวที่ข้อมูลครบกว่า:{' '}
                  {impFile.dups.map((d) => `ว.${d.lic} (แถว ${d.rows.join(', ')})`).join(' · ')}
                </Note>
              )}
              {impShow === 'warn' && (
                <div className="tablewrap" style={{ maxHeight: 260, overflow: 'auto', marginBottom: 10 }}>
                  <table><thead><tr><th className="n">แถว</th><th>เลข ว.</th><th>ข้อควรตรวจ</th></tr></thead>
                    <tbody>{impFile.warnings.map((x, i) => (
                      <tr key={i}><td className="n">{x.row}</td><td>{x.lic}</td><td>{x.text}</td></tr>
                    ))}</tbody></table>
                </div>
              )}

              {impPrev && impPrev.docChanges.length > 0 && (
                <>
                  <h3 style={{ margin: '12px 0 6px' }}>ข้อมูลที่จะเปลี่ยนในทะเบียน ({impPrev.docChanges.length} ช่อง)</h3>
                  <p className="muted" style={{ marginTop: 0 }}>
                    เอาติ๊กออก = ไม่แก้ช่องนั้น · ระบบเอาติ๊กออกให้ก่อนในช่องที่น่าจะผิด (เช่น เลข 0 นำหน้าหาย, ชื่อบริษัททับชื่อแพทย์)
                  </p>
                  <div className="tablewrap" style={{ maxHeight: 360, overflow: 'auto' }}>
                    <table>
                      <thead><tr><th></th><th>แพทย์</th><th>ช่อง</th><th>เดิม</th><th>ใหม่จากไฟล์</th></tr></thead>
                      <tbody>
                        {impPrev.docChanges.map((c) => {
                          const k = `${c.licNo}|${c.field}`;
                          const risk = riskyChange(c);
                          return (
                            <tr key={k} style={impSkip.has(k) ? { opacity: .55 } : undefined}>
                              <td>
                                <input type="checkbox" checked={!impSkip.has(k)} disabled={busy}
                                  onChange={() => setImpSkip((s) => {
                                    const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n;
                                  })} />
                              </td>
                              <td>{docNick(c.who) || c.who} <span className="muted">ว.{c.licNo}</span></td>
                              <td>{FIELD_TH[c.field] || (c.field === 'nick_name' ? 'ชื่อเล่น' : c.field === 'contact' ? 'เบอร์ติดต่อ' : c.field)}</td>
                              <td className="muted">{c.old || <i>ว่าง</i>}</td>
                              <td>{c.new}{risk && <> <span className="pill warn">{risk}</span></>}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              {impPrev && impPrev.docChanges.length === 0 && impMode !== 'NONE' && (
                <Note tone="ok">ข้อมูลแพทย์ที่ขึ้นทะเบียนแล้วตรงกับไฟล์ / ไม่มีช่องว่างให้เติม</Note>
              )}
              {impPrev && impPrev.notInFile.length > 0 && (
                <p className="muted">
                  แพทย์ในทะเบียนที่ไม่มีในไฟล์นี้ {impPrev.notInFile.length} คน (เพิ่มในระบบเอง) — ไม่ถูกลบ:{' '}
                  {impPrev.notInFile.slice(0, 12).map((x) => `${docNick(x.who) || x.who} ว.${x.licNo}`).join(', ')}
                  {impPrev.notInFile.length > 12 ? ' …' : ''}
                </p>
              )}

              <div className="row" style={{ marginTop: 10 }}>
                <button className="primary" disabled={busy || !impPrev} onClick={impApply}>
                  ยืนยันนำเข้า {impFile.rows.length} คน
                </button>
                <button disabled={busy} onClick={() => { setImpFile(null); setImpPrev(null); }}>ยกเลิก</button>
              </div>
            </>
          )}
        </Card>
      )}

      {/* ---------- คลังรายชื่อแพทย์ ---------- */}
      {tab === 'doc' && poolOpen && mayDoc && (
        <Card
          title={`คลังรายชื่อแพทย์ — ยังไม่ได้ขึ้นทะเบียน ${pool?.pool ?? '—'} คน`}
          right={
            <button className="primary" disabled={busy || !poolPick.size} onClick={promote}>
              ขึ้นทะเบียนที่เลือก ({poolPick.size})
            </button>
          }
        >
          <Note tone="info">
            รายชื่อชุดนี้ย้ายมาพร้อมระบบเดิมแต่ไม่เคยถูกขึ้นทะเบียน จึงไม่ปรากฏในทะเบียนแพทย์ ·
            ช่อง<b>ที่มา</b>คือสถานที่ทำงานเดิมที่ติดมากับข้อมูล ไม่ใช่สาขา Mersi ·
            ขึ้นทะเบียนแล้ว<b>ยังคำนวณไม่ได้จนกว่าจะตั้งอัตราค่าตอบแทน</b>ให้แพทย์คนนั้น
          </Note>

          <div className="field" style={{ maxWidth: 420 }}>
            <label>ค้นหา — รหัส ว. / ชื่อ-สกุล / ชื่อเล่น / ที่มา</label>
            <input value={poolQ} placeholder="เช่น สมชาย หรือ 96849 หรือ ขอนแก่น"
              onChange={(e) => setPoolQ(e.target.value)}
            />
          </div>

          {!pool ? <Skeleton rows={4} /> : (
            <>
              <div className="row" style={{ marginBottom: 8 }}>
                <span className="muted">
                  พบ {pool.found} คน
                  {pool.found > pool.rows.length && ` · แสดง ${pool.rows.length} คนแรก พิมพ์ค้นหาเพิ่มเพื่อให้แคบลง`}
                </span>
                <div className="spacer" />
                <button className="sm" disabled={busy || !pool.rows.length}
                  onClick={() => setPoolPick(new Set(pool.rows.map((r) => r.licNo)))}
                >
                  เลือกทั้งหมดที่แสดง
                </button>
                <button className="sm" disabled={busy || !poolPick.size}
                  onClick={() => setPoolPick(new Set())}
                >
                  ล้างที่เลือก
                </button>
              </div>

              <div className="tablewrap">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 34 }}></th>
                      <th>รหัส ว.</th><th>ชื่อ-สกุล</th><th>ชื่อเล่น</th>
                      <th>ธนาคาร</th><th>เลขบัญชี</th><th>อีเมล</th><th>ที่มา</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pool.rows.map((r: PoolRow) => (
                      <tr key={r.licNo}>
                        <td>
                          <input type="checkbox" disabled={busy}
                            checked={poolPick.has(r.licNo)}
                            onChange={() => togglePick(r.licNo)}
                          />
                        </td>
                        <td>{r.licNo}</td>
                        <td>{r.name}</td>
                        <td>{docNick(r.nick)}</td>
                        <td>{r.bank}</td>
                        <td className="tnum">{r.bankAcc}</td>
                        <td>
                          {r.email
                            ? <span className="muted">{r.email}</span>
                            : <span className="pill warn">ไม่มีอีเมล</span>}
                        </td>
                        <td className="muted">{r.source}</td>
                      </tr>
                    ))}
                    {pool.rows.length === 0 && (
                      <tr>
                        <td colSpan={8} className="muted">
                          {poolQ ? 'ไม่พบรายชื่อที่ตรงกับคำค้น' : 'ขึ้นทะเบียนครบทุกคนในคลังแล้ว'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      )}

      {tab === 'rate' && (
        <Card
          title={`อัตราและสัญญา (${rates?.length ?? '—'} รายการ)`}
          right={mayRate && <button className="primary" onClick={() => setEditRate({ ...BLANK_RATE })}>+ เพิ่มอัตรา</button>}
        >
          <Note tone="info">
            ลำดับการเลือกอัตรา: <b>แพทย์+สาขา → แพทย์ → สาขา → อัตรากลาง</b> ·
            ไม่พบอัตราที่ตรงสาขา/วันที่ ระบบจะ<b>ใช้อัตราสำรองคำนวณไปก่อนและขึ้นคำเตือน</b> (ไม่ใช้ 0 แทน) ·
            เว้นรหัส ว. ว่าง = อัตรากลาง · เว้นสาขาว่าง = ทุกสาขา
          </Note>
          {!rates ? <Skeleton rows={5} /> : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>รหัส ว.</th><th>สาขา</th><th className="n">อัตรา/ชม.</th>
                    <th>ฐานภาษี</th><th className="n">อัตราภาษี</th>
                    <th>มีผลตั้งแต่</th><th>ถึง</th><th>หมายเหตุ</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {rates.map((r) => (
                    <tr key={r.id}>
                      <td>{r.lic_no === '*' ? <span className="pill none">อัตรากลาง</span> : r.lic_no}</td>
                      <td>{r.branch || <span className="muted">ทุกสาขา</span>}</td>
                      <td className="n"><Money v={r.hourly_rate} /></td>
                      <td>{TAX_BASE_TH[r.tax_base] || r.tax_base}</td>
                      <td className="n">{r.tax_base === 'NONE' ? '—' : `${r.tax_rate}%`}</td>
                      <td>{r.eff_from || <span className="pill block">ไม่ระบุ</span>}</td>
                      <td>{r.eff_to || <span className="muted">ไม่สิ้นสุด</span>}</td>
                      <td className="muted">{r.note}</td>
                      <td>
                        {mayRate && (
                          <div className="row">
                            <button className="sm" onClick={() => setEditRate({ ...r })}>แก้ไข</button>
                            <button className="sm" onClick={() => run(async () => {
                              await api.deleteRate(r.id!); load(); setMsg('ลบอัตราแล้ว');
                            })}
                            >
                              ลบ
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                  {rates.length === 0 && (
                    <tr><td colSpan={9} className="muted">ยังไม่มีอัตรา — การคำนวณจะแจ้งปัญหา NO_RATE ทุกบรรทัด</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* ---------- ฟอร์มแก้ไขแพทย์ ---------- */}
      <div ref={formRef} />
      {editDoc && (
        <Card title={editDoc.lic_no && docs?.some((d) => d.lic_no === editDoc.lic_no) ? `แก้ไข ${editDoc.lic_no}` : 'เพิ่มแพทย์ใหม่'}>
          {need.size > 0 && (
            <Note tone="warn">
              ช่องที่ยังว่าง: {[...need].map((m) => FIELD_TH[m] || m).join(' · ')} — กรอกแล้วกดบันทึก
            </Note>
          )}
          <div className="grid g3">
            {([
              ['lic_no', 'รหัส ว.'], ['full_name', 'ชื่อ-สกุล'], ['nick_name', 'ชื่อเล่น'],
              ['bank', 'ธนาคาร'], ['bank_acc', 'เลขบัญชี'], ['id_card', 'เลขบัตรประชาชน'],
              ['contact', 'เบอร์ติดต่อ'], ['email', 'อีเมล (ใช้ส่งหนังสือรับรองรายได้)'],
      ['payee_name', 'ชื่อผู้รับเงิน (ถ้าเป็นนิติบุคคล)'],
            ] as [keyof Doctor, string][]).map(([k, label]) => (
              <div className={`field ${need.has(k) && !String(editDoc[k] ?? '').trim() ? 'need' : ''}`} key={k}>
                <label>{label}</label>
                <input
                  value={String(editDoc[k] ?? '')}
                  disabled={k === 'lic_no' && !!docs?.some((d) => d.lic_no === editDoc.lic_no)}
                  onChange={(e) => setEditDoc({ ...editDoc, [k]: e.target.value })}
                />
              </div>
            ))}
            <div className="field">
              <label>ประเภทผู้รับเงิน</label>
              <select value={editDoc.payee_type}
                onChange={(e) => setEditDoc({ ...editDoc, payee_type: e.target.value })}
              >
                <option value="PERSON">บุคคลธรรมดา</option>
                <option value="COMPANY">นิติบุคคล</option>
              </select>
            </div>
            <div className="field">
              <label>สถานะ</label>
              <select value={editDoc.status}
                onChange={(e) => setEditDoc({ ...editDoc, status: e.target.value })}
              >
                <option value="ACTIVE">ปฏิบัติงาน</option>
                <option value="INACTIVE">พ้นสภาพ</option>
              </select>
            </div>
          </div>
          <div className={`field ${need.has('address') && !editDoc.address?.trim() ? 'need' : ''}`}>
            <label>ที่อยู่</label>
            <textarea rows={2} value={editDoc.address}
              onChange={(e) => setEditDoc({ ...editDoc, address: e.target.value })}
            />
          </div>
          <div className="row">
            <button className="primary" onClick={saveDoc} disabled={busy}>บันทึก</button>
            <button onClick={() => { setEditDoc(null); setNeed(new Set()); }}>ยกเลิก</button>
          </div>
        </Card>
      )}

      {/* ---------- ฟอร์มแก้ไขอัตรา ---------- */}
      {editRate && (
        <Card title={editRate.id ? 'แก้ไขอัตรา' : 'เพิ่มอัตราใหม่'}>
          <div className="grid g3">
            <div className="field">
              <label>รหัส ว. (เว้นว่าง = อัตรากลาง)</label>
              <input value={editRate.lic_no === '*' ? '' : editRate.lic_no}
                onChange={(e) => setEditRate({ ...editRate, lic_no: e.target.value })}
              />
            </div>
            <div className="field">
              <label>สาขา (เว้นว่าง = ทุกสาขา)</label>
              <select value={editRate.branch}
                onChange={(e) => setEditRate({ ...editRate, branch: e.target.value })}
              >
                <option value="">ทุกสาขา</option>
                {(boot?.branches || []).map((b) => (
                  <option key={b.code} value={b.code}>{b.code} · {b.nameTh}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>อัตราต่อชั่วโมง (บาท)</label>
              <input type="number" value={editRate.hourly_rate}
                onChange={(e) => setEditRate({ ...editRate, hourly_rate: Number(e.target.value) })}
              />
            </div>
            <div className="field">
              <label>ฐานคำนวณภาษี</label>
              <select value={editRate.tax_base}
                onChange={(e) => setEditRate({ ...editRate, tax_base: e.target.value })}
              >
                <option value="TOTAL">รวมเงินได้ (ค่าเวร + ค่ามือ)</option>
                <option value="SHIFT">เฉพาะค่าเวร</option>
                <option value="NONE">ไม่หักภาษี ณ ที่จ่าย</option>
              </select>
            </div>
            <div className="field">
              <label>อัตราภาษี (%)</label>
              <input type="number" step="0.01" value={editRate.tax_rate}
                onChange={(e) => setEditRate({ ...editRate, tax_rate: Number(e.target.value) })}
              />
            </div>
            <div className="field">
              <label>มีผลตั้งแต่</label>
              <input type="date" value={editRate.eff_from || ''}
                onChange={(e) => setEditRate({ ...editRate, eff_from: e.target.value || null })}
              />
            </div>
            <div className="field">
              <label>ถึงวันที่ (เว้นว่าง = ไม่สิ้นสุด)</label>
              <input type="date" value={editRate.eff_to || ''}
                onChange={(e) => setEditRate({ ...editRate, eff_to: e.target.value || null })}
              />
            </div>
            <div className="field" style={{ gridColumn: 'span 2' }}>
              <label>หมายเหตุ / เอกสารอ้างอิง</label>
              <input value={editRate.note}
                onChange={(e) => setEditRate({ ...editRate, note: e.target.value })}
              />
            </div>
          </div>
          <div className="row">
            <button className="primary" onClick={saveRate} disabled={busy}>บันทึก</button>
            <button onClick={() => setEditRate(null)}>ยกเลิก</button>
          </div>
        </Card>
      )}
    </>
  );
}
