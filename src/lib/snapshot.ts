/* ============================================================================
 * snapshot.ts — ยอดที่ "ล็อก" ไว้ตอนอนุมัติ
 *
 * เก็บละเอียดพอให้แพทย์ตรวจย้อนได้ทุกบาท: ใบเวรรายวัน + รายการค่ามือทุกแถว
 * อีเมลที่ส่งหาแพทย์อ่านจาก snapshot นี้เท่านั้น จึงตรงกับยอดที่อนุมัติเสมอ
 * ไม่ว่าหลังจากนั้นจะมีใครแก้ข้อมูลในระบบ
 *
 * ไม่เก็บ HN / ชื่อคนไข้ — เลขที่เอกสารพอให้ตามบิลใน MCS ได้แล้ว (PDPA)
 * ==========================================================================*/
import type { CalcResult } from './calc';
import { cellStr, num, toIsoDate } from './core';

export interface SnapDay {
  d: string; in: string; out: string; brk: number; hrs: number; mins: number;
  rate: number; shift: number; hand: number; handRows: number; deduct: number;
  special: number | null; kind: string; note: string; grace: string;
}
export interface SnapProc { d: string; doc: string; c: string; q: number; f: number }
export interface SnapLine {
  licNo: string; name: string; nick: string;
  payeeType: string; payeeName: string; bank: string; bankAcc: string;
  rate: number; taxBase: string; taxRate: number; taxBaseAmt: number;
  sumHrs: number; sumMins: number;
  shiftTotal: number; coverShift: number; handTotal: number;
  adjAdd: number; adjDeduct: number; adjList: { kind: string; amount: number; reason: string }[];
  gross: number; tax: number; deduct: number; net: number;
  procCount: number;
  days: SnapDay[];
  procs: SnapProc[];
  orphan: { d: string; amount: number; rows: number }[];
}

export function buildSnapshot(res: CalcResult, procRows: Record<string, unknown>[]) {
  const byLic = new Map<string, SnapProc[]>();
  procRows.forEach((r) => {
    const lic = cellStr(r.lic_no);
    if (!lic) return;
    const list = byLic.get(lic) || [];
    list.push({
      d: toIsoDate(r.bill_date), doc: cellStr(r.doc_no), c: cellStr(r.course),
      q: num(r.qty), f: num(r.fee),
    });
    byLic.set(lic, list);
  });

  const lines: SnapLine[] = res.lines.map((L) => ({
    licNo: L.licNo, name: L.fullName, nick: L.nickName,
    payeeType: L.payeeType, payeeName: L.payeeName, bank: L.bank, bankAcc: L.bankAcc,
    rate: L.rate, taxBase: L.taxBase, taxRate: L.taxRate, taxBaseAmt: L.taxBaseAmt,
    sumHrs: L.sumHrs, sumMins: L.sumMins,
    shiftTotal: L.shiftTotal, coverShift: L.coverShift, handTotal: L.handTotal,
    adjAdd: L.adjAdd, adjDeduct: L.adjDeduct, adjList: L.adjList,
    gross: L.gross, tax: L.taxAmt, deduct: L.deductTotal, net: L.net,
    procCount: L.procCount,
    days: L.rows.filter((r) => !r.error).map((r) => ({
      d: r.date, in: r.timeIn || '', out: r.timeOut || '', brk: num(r.breakMin),
      hrs: num(r.hrs), mins: num(r.mins), rate: num(r.rate),
      shift: num(r.shiftPay), hand: num(r.handFee), handRows: num(r.handRows),
      deduct: num(r.deduct), special: r.special ?? null,
      kind: r.kind || 'SHIFT', note: r.note || '', grace: r.graceNote || '',
    })),
    procs: (byLic.get(L.licNo) || []).sort((a, b) => (a.d === b.d ? a.doc.localeCompare(b.doc) : a.d < b.d ? -1 : 1)),
    orphan: L.orphan.map((o) => ({ d: o.date, amount: o.amount, rows: o.rows })),
  }));

  return { v: 2, totals: res.totals, coverMode: res.coverMode, lines };
}
