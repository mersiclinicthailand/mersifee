// ============================================================================
// แม่แบบอีเมล Mersi Clinic — ใช้ร่วมกันทั้งเมลจริงและเมลทดสอบ
//
// เขียนแบบ "อีเมลปลอดภัย": ตาราง + inline style ล้วน (Gmail / Outlook / iPhone Mail
// ไม่รองรับ flex, grid, <style> ภายนอก) · โลโก้ดึงจากเว็บของระบบ (/logo.png)
// ไม่ฝังเป็น base64 เพราะ Gmail ตัดรูป base64 ทิ้ง
// ============================================================================

export const BRAND = {
  sage: '#8B9677', sageDk: '#6E7A5B', sageLt: '#E8EBE2',
  cream: '#F7F5EF', champagne: '#C8B68E', ink: '#23261F', ink2: '#5B6154', ink3: '#8A8F80',
  line: '#E6E3DA', page: '#EEF0EA',
};

const TH_MONTH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
                  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const TH_MONTH_FULL = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
                       'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
export const ymThai = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return `${TH_MONTH[m - 1]} ${String(y + 543).slice(-2)}`;
};
export const ymThaiFull = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return `${TH_MONTH_FULL[m - 1]} ${y + 543}`;
};
export const money = (n: number) =>
  Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** กัน HTML injection จากชื่อ/ข้อความที่มาจากฐานข้อมูล */
export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const FONT = `'Sarabun','IBM Plex Sans Thai','Noto Sans Thai',Tahoma,Arial,sans-serif`;
const B = BRAND;

export type MailKind = 'sign_invite' | 'tax_detail' | 'wht_cert';

export interface MailData {
  kind: MailKind;
  name: string;            // ชื่อเต็มของแพทย์
  licNo: string;
  branchTh: string;
  ym: string;              // YYYY-MM
  gross: number; tax: number; net: number;
  appUrl: string;          // ใช้หาโลโก้ และทำลิงก์
  signLink?: string;       // sign_invite
  fileName?: string;       // wht_cert
  note?: string;           // ข้อความเพิ่มเติมจากผู้ส่ง
  test?: boolean;          // เมลทดสอบ — มีแถบบอกชัด ๆ
}

/* ---------------------------------- ชิ้นส่วน ---------------------------------- */

const p = (html: string, extra = '') =>
  `<p style="margin:0 0 14px;font-family:${FONT};font-size:15px;line-height:1.75;color:${B.ink2};${extra}">${html}</p>`;

/** ป้ายข้อมูลเล็ก ๆ ใต้หัวเรื่อง: สาขา · รอบเดือน · เลข ว. */
const chips = (items: string[]) => `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:14px auto 0;">
    <tr>${items.map((t) => `
      <td style="padding:0 3px;">
        <span style="display:inline-block;font-family:${FONT};font-size:12px;color:${B.sageDk};
          background:#FFFFFF;border:1px solid ${B.line};border-radius:999px;padding:4px 11px;white-space:nowrap;">${t}</span>
      </td>`).join('')}
    </tr>
  </table>`;

/** การ์ดยอดเงิน — จ่ายสุทธิตัวใหญ่ อ่านง่ายบนมือถือ */
export const amountCard = (gross: number, tax: number, net: number) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
    style="background:${B.cream};border:1px solid ${B.line};border-radius:14px;margin:6px 0 20px;">
    <tr><td style="padding:18px 20px 6px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="font-family:${FONT};font-size:14px;color:${B.ink2};padding:6px 0;">รวมเงินได้</td>
          <td align="right" style="font-family:${FONT};font-size:15px;color:${B.ink};padding:6px 0;">${money(gross)} ฿</td>
        </tr>
        <tr>
          <td style="font-family:${FONT};font-size:14px;color:${B.ink2};padding:6px 0 12px;border-bottom:1px dashed ${B.champagne};">
            หักภาษี ณ ที่จ่าย</td>
          <td align="right" style="font-family:${FONT};font-size:15px;color:#A04A3C;padding:6px 0 12px;border-bottom:1px dashed ${B.champagne};">
            −${money(tax)} ฿</td>
        </tr>
      </table>
    </td></tr>
    <tr><td style="padding:10px 20px 18px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="font-family:${FONT};font-size:14px;font-weight:700;color:${B.ink};">จ่ายสุทธิ</td>
          <td align="right" style="font-family:${FONT};font-size:26px;font-weight:700;color:${B.sageDk};letter-spacing:-.3px;">
            ${money(net)} <span style="font-size:15px;">฿</span></td>
        </tr>
      </table>
    </td></tr>
  </table>`;

/** ปุ่มแบบ "bulletproof" — กดได้ทุกแอปอีเมลรวม Outlook */
const button = (href: string, label: string) => `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:8px auto 14px;">
    <tr><td align="center" bgcolor="${B.sage}" style="border-radius:12px;background:${B.sage};">
      <a href="${esc(href)}" target="_blank"
        style="display:inline-block;padding:15px 38px;font-family:${FONT};font-size:16px;font-weight:700;
               color:#FFFFFF;text-decoration:none;border-radius:12px;">${label}</a>
    </td></tr>
  </table>`;

const attachmentRow = (fileName: string) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
    style="border:1px solid ${B.line};border-radius:12px;margin:0 0 18px;">
    <tr>
      <td width="52" align="center" style="padding:12px 0 12px 14px;">
        <span style="display:inline-block;background:#C9412F;color:#FFFFFF;font-family:Arial,sans-serif;font-size:11px;
          font-weight:700;border-radius:5px;padding:6px 7px;">PDF</span>
      </td>
      <td style="padding:12px 14px;font-family:${FONT};">
        <div style="font-size:14px;color:${B.ink};font-weight:600;word-break:break-all;">${esc(fileName)}</div>
        <div style="font-size:12px;color:${B.ink3};">แนบมากับอีเมลฉบับนี้ · เปิดได้จากไฟล์แนบด้านล่าง</div>
      </td>
    </tr>
  </table>`;

const noteBox = (note?: string) => (note ? `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;">
    <tr><td style="border-left:3px solid ${B.champagne};background:#FBFAF6;padding:12px 16px;
      font-family:${FONT};font-size:14px;line-height:1.7;color:${B.ink2};">${esc(note)}</td></tr>
  </table>` : '');

/* ---------------------------------- โครงเมล ---------------------------------- */

function layout(o: {
  appUrl: string; preheader: string; eyebrow: string; title: string;
  chipItems: string[]; body: string; test?: boolean;
}) {
  const logo = o.appUrl ? `${o.appUrl}/logo.png` : '';
  const testBar = o.test ? `
    <tr><td style="background:#FFF4D6;border-bottom:1px solid #EBD9A8;padding:10px 20px;text-align:center;
      font-family:${FONT};font-size:13px;color:#7A5A12;">
      🧪 <b>อีเมลทดสอบ</b> — ยอดเงินและชื่อในเมลนี้เป็นข้อมูลตัวอย่าง ไม่ได้ส่งถึงแพทย์จริง
    </td></tr>` : '';

  return `<!doctype html>
<html lang="th" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>${esc(o.title)}</title>
</head>
<body style="margin:0;padding:0;background:${B.page};-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(o.preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${B.page};">
    <tr><td align="center" style="padding:28px 12px 36px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
        style="max-width:560px;background:#FFFFFF;border-radius:18px;overflow:hidden;
               border:1px solid ${B.line};box-shadow:0 6px 24px rgba(35,38,31,.06);">
        ${testBar}
        <!-- หัวเมล -->
        <tr><td align="center" style="background:${B.cream};padding:30px 24px 24px;border-bottom:1px solid ${B.line};">
          ${logo
            ? `<img src="${esc(logo)}" width="84" height="84" alt="Mersi Clinic"
                 style="display:block;width:84px;height:84px;border:0;margin:0 auto 14px;border-radius:50%;">`
            : `<div style="font-family:Georgia,serif;font-size:30px;color:${B.sageDk};margin:0 0 10px;">Mersi</div>`}
          <div style="font-family:${FONT};font-size:12px;letter-spacing:2px;color:${B.champagne};text-transform:uppercase;">
            ${esc(o.eyebrow)}</div>
          <div style="font-family:${FONT};font-size:21px;font-weight:700;color:${B.ink};margin-top:4px;">${esc(o.title)}</div>
          ${chips(o.chipItems)}
        </td></tr>
        <!-- เนื้อหา -->
        <tr><td style="padding:28px 28px 8px;">${o.body}</td></tr>
        <!-- ท้ายเมล -->
        <tr><td style="padding:4px 28px 26px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="border-top:1px solid ${B.line};padding-top:16px;font-family:${FONT};font-size:13px;line-height:1.7;color:${B.ink2};">
              ขอแสดงความนับถือ<br>
              <b style="color:${B.ink};">Mersi Clinic</b> · ฝ่ายบุคคลและฝ่ายบัญชี
            </td></tr>
          </table>
        </td></tr>
      </table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
        <tr><td align="center" style="padding:16px 20px 0;font-family:${FONT};font-size:11.5px;line-height:1.7;color:${B.ink3};">
          อีเมลฉบับนี้ส่งจากระบบค่าตอบแทนแพทย์ของ Mersi Clinic โดยอัตโนมัติ กรุณาอย่าตอบกลับ<br>
          ข้อมูลในอีเมลเป็นความลับเฉพาะผู้รับ หากได้รับโดยไม่ทราบที่มา กรุณาแจ้งฝ่ายบุคคลและลบอีเมลนี้
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/* --------------------------------- เมลแต่ละแบบ --------------------------------- */

export function buildMail(d: MailData): { subject: string; html: string } {
  const month = ymThai(d.ym);
  const monthFull = ymThaiFull(d.ym);
  const chipItems = [`สาขา${esc(d.branchTh)}`, `รอบ ${esc(monthFull)}`, `ว.${esc(d.licNo)}`];
  const hello = p(`เรียน <b style="color:${B.ink};">${esc(d.name)}</b>`, 'margin-bottom:10px;');
  const pre = d.test ? '[ทดสอบ] ' : '';

  if (d.kind === 'sign_invite') {
    return {
      subject: `${pre}ขอความอนุเคราะห์เซ็นรับรองรายได้ ${month} · ${d.branchTh}`,
      html: layout({
        appUrl: d.appUrl, test: d.test, chipItems,
        preheader: `ยอดสุทธิ ${money(d.net)} บาท — กดเพื่อตรวจสอบและเซ็นรับรอง ใช้เวลาไม่ถึง 1 นาที`,
        eyebrow: 'Income Confirmation', title: 'เซ็นรับรองรายได้ประจำเดือน',
        body: `${hello}
          ${p(`ยอดค่าตอบแทนประจำเดือน <b>${esc(monthFull)}</b> สาขา<b>${esc(d.branchTh)}</b>
            ได้รับการอนุมัติเรียบร้อยแล้ว ขอความอนุเคราะห์อาจารย์ตรวจสอบยอดด้านล่าง แล้วกดปุ่มเพื่อเซ็นรับรองครับ`)}
          ${amountCard(d.gross, d.tax, d.net)}
          ${noteBox(d.note)}
          ${button(d.signLink || '#', 'ตรวจสอบและเซ็นรับรอง')}
          ${p(`เซ็นด้วยนิ้วบนมือถือได้เลย ไม่ต้องล็อกอิน · ลิงก์นี้ใช้ได้เฉพาะอาจารย์ท่านเดียว มีอายุ 14 วัน
            กรุณาอย่าส่งต่อให้ผู้อื่น`, `font-size:12.5px;color:${B.ink3};text-align:center;`)}`,
      }),
    };
  }

  if (d.kind === 'wht_cert') {
    const file = d.fileName || `50ทวิ_${d.licNo}_${month}.pdf`;
    return {
      subject: `${pre}หนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ) ${month} · ${d.branchTh}`,
      html: layout({
        appUrl: d.appUrl, test: d.test, chipItems,
        preheader: `50 ทวิ ประจำเดือน ${monthFull} · ภาษีหัก ณ ที่จ่าย ${money(d.tax)} บาท (ไฟล์แนบ)`,
        eyebrow: 'Withholding Tax Certificate', title: 'หนังสือรับรองการหักภาษี ณ ที่จ่าย',
        body: `${hello}
          ${p(`ฝ่ายบัญชีขอส่ง <b>หนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ)</b> สำหรับค่าตอบแทนประจำเดือน
            <b>${esc(monthFull)}</b> สาขา<b>${esc(d.branchTh)}</b> ตามไฟล์แนบครับ`)}
          ${attachmentRow(file)}
          ${amountCard(d.gross, d.tax, d.net)}
          ${noteBox(d.note)}
          ${p(`กรุณาเก็บไฟล์นี้ไว้ใช้ยื่นแบบภาษีเงินได้บุคคลธรรมดาประจำปี
            หากยอดไม่ตรงกับที่ได้รับ กรุณาติดต่อฝ่ายบัญชีครับ`, `font-size:13px;`)}`,
      }),
    };
  }

  return {
    subject: `${pre}รายละเอียดการหักภาษี ณ ที่จ่าย ${month} · ${d.branchTh}`,
    html: layout({
      appUrl: d.appUrl, test: d.test, chipItems,
      preheader: `สรุปภาษีหัก ณ ที่จ่ายเดือน ${monthFull}: ${money(d.tax)} บาท · สุทธิ ${money(d.net)} บาท`,
      eyebrow: 'Tax Summary', title: 'รายละเอียดการหักภาษี ณ ที่จ่าย',
      body: `${hello}
        ${p(`สรุปการหักภาษี ณ ที่จ่ายสำหรับค่าตอบแทนประจำเดือน <b>${esc(monthFull)}</b>
          สาขา<b>${esc(d.branchTh)}</b> ดังนี้ครับ`)}
        ${amountCard(d.gross, d.tax, d.net)}
        ${noteBox(d.note)}
        ${p(`หนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ) ฝ่ายบัญชีจะจัดส่งให้ตามรอบ
          หากมีข้อสงสัยกรุณาติดต่อฝ่ายบัญชีได้เลยครับ`, `font-size:13px;`)}`,
    }),
  };
}
