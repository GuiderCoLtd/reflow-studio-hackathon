// Recreate data/dodam.db from scratch with deterministic Korean sample data.
// "Today" in the data is 2026-11-05 (Thu). Run while the server is stopped,
// or restart it afterwards (testapps/ctl.sh restart dodam).
process.removeAllListeners('warning'); // silence the node:sqlite ExperimentalWarning

const fs = await import('node:fs');
const path = await import('node:path');
const { DB_PATH } = await import('./lib/config.mjs');
const { openDb, SCHEMA } = await import('./lib/db.mjs');
const { hashPassword } = await import('./lib/passwords.mjs');

const PASSWORD = 'DemoPass!2026';

// ---------------------------------------------------------------- data

const DEPARTMENTS = ['경영지원팀', '마케팅팀', '개발팀', '디자인팀', '영업팀'];

// [id, name, email, deptIndex(1-based), title, role, phone, employeeNo, joinedOn]
const USERS = [
  [1, '김하늘', 'demo@dodamwork.test', 2, '팀장', 'admin', '010-2481-5730', 'DD-2103', '2021-03-02'],
  [2, '박지훈', 'jihoon.park@dodamwork.test', 1, '이사', 'admin', '010-3307-1842', 'DD-1901', '2019-06-10'],
  [3, '이도윤', 'doyun.lee@dodamwork.test', 2, '선임', 'member', '010-5521-0937', 'DD-2302', '2023-02-13'],
  [4, '최서아', 'seoa.choi@dodamwork.test', 2, '매니저', 'member', '010-7714-2056', 'DD-2407', '2024-07-01'],
  [5, '정우진', 'woojin.jung@dodamwork.test', 4, '선임', 'member', '010-4038-6619', 'DD-2209', '2022-09-19'],
  [6, '한소율', 'soyul.han@dodamwork.test', 4, '팀장', 'member', '010-2290-4471', 'DD-2011', '2020-11-02'],
  [7, '서준호', 'junho.seo@dodamwork.test', 3, '팀장', 'member', '010-6672-1308', 'DD-1909', '2019-09-02'],
  [8, '문가은', 'gaeun.moon@dodamwork.test', 3, '책임', 'member', '010-9183-5524', 'DD-2004', '2020-04-06'],
  [9, '배수현', 'suhyun.bae@dodamwork.test', 3, '선임', 'member', '010-3349-8102', 'DD-2203', '2022-03-14'],
  [10, '조민혁', 'minhyuk.cho@dodamwork.test', 3, '매니저', 'member', '010-8820-4167', 'DD-2401', '2024-01-08'],
  [11, '권나연', 'nayeon.kwon@dodamwork.test', 5, '팀장', 'member', '010-4471-9035', 'DD-2008', '2020-08-03'],
  [12, '홍성민', 'sungmin.hong@dodamwork.test', 5, '책임', 'member', '010-5604-2218', 'DD-2110', '2021-10-11'],
  [13, '신다인', 'dain.shin@dodamwork.test', 5, '매니저', 'member', '010-2935-7740', 'DD-2503', '2025-03-04'],
  [14, '강예린', 'yerin.kang@dodamwork.test', 2, '매니저', 'member', '010-6158-3392', 'DD-2308', '2023-08-21'],
  [15, '유하준', 'hajun.yu@dodamwork.test', 4, '매니저', 'member', '010-7307-6651', 'DD-2501', '2025-01-06'],
  [16, '장은비', 'eunbi.jang@dodamwork.test', 1, '매니저', 'admin', '010-3826-1479', 'DD-2105', '2021-05-17'],
  [17, '임채원', 'chaewon.lim@dodamwork.test', 1, '매니저', 'member', '010-9462-0583', 'DD-2311', '2023-11-06'],
];
// Pending invitation (no password yet).
const INVITED = [[18, '윤서진', 'seojin.yoon@dodamwork.test', 3, 'member', '2026-11-03 15:10']];

const LEAVES = [
  // [id, userId, type, start, end, days, reason, status, approverId, createdAt, decidedAt, note]
  [1, 1, 'annual', '2026-06-12', '2026-06-12', 1, '이사 준비', 'rejected', 2, '2026-06-03 09:41', '2026-06-03 15:20', '상반기 결산 마감 주간이에요. 다음 주로 조정해 주실 수 있을까요?'],
  [2, 1, 'pm_half', '2026-07-03', '2026-07-03', 0.5, '병원 진료', 'approved', 2, '2026-07-01 10:12', '2026-07-01 13:05', null],
  [3, 1, 'annual', '2026-08-13', '2026-08-14', 2, '여름 휴가', 'approved', 2, '2026-07-29 11:30', '2026-07-29 16:44', null],
  [4, 1, 'annual', '2026-10-30', '2026-10-30', 1, '개인 일정', 'approved', 2, '2026-10-23 09:15', '2026-10-23 11:02', null],
  [5, 3, 'annual', '2026-11-19', '2026-11-20', 2, '가족 행사 참석', 'pending', 1, '2026-11-04 16:12', null, null],
  [6, 14, 'annual', '2026-11-05', '2026-11-05', 1, '개인 사유', 'approved', 1, '2026-10-28 10:20', '2026-10-28 14:05', null],
  [7, 8, 'annual', '2026-11-09', '2026-11-10', 2, '가족 여행', 'approved', 7, '2026-10-26 13:30', '2026-10-26 17:10', null],
];

const R = (name, qty, price) => ({ name, qty, price });
const EXPENSES = [
  // [id, userId, usedOn, category, amount, merchant, memo, status, approverId, createdAt, decidedAt, note, receiptItems, paidAt]
  [1, 1, '2026-11-02', 'supplies', 57500, '오피스 문구센터 성수점', '제품 촬영용 소품·폼보드', 'approved', 2, '2026-11-02 17:05', '2026-11-03 09:12', null, [R('폼보드 A2', 5, 4500), R('촬영 소품 세트', 1, 35000)], '2026-11-02 14:21'],
  [2, 1, '2026-11-02', 'entertainment', 32000, '카페 온담', '파트너사 미팅 음료 (4명)', 'approved', 2, '2026-11-02 17:12', '2026-11-03 09:13', null, [R('아메리카노', 2, 5000), R('카페라떼', 2, 5500), R('디저트', 2, 5500)], '2026-11-02 15:47'],
  [3, 1, '2026-11-03', 'transport', 24500, '택시 (성수 → 여의도)', '거래처 미팅 이동', 'approved', 2, '2026-11-03 18:20', '2026-11-04 09:05', null, [R('택시 요금', 1, 24500)], '2026-11-03 13:18'],
  [4, 1, '2026-11-04', 'etc', 48000, '책방 오늘', '마케팅 트렌드 도서 3권', 'approved', 2, '2026-11-04 12:10', '2026-11-04 17:40', null, [R('도서', 3, 16000)], '2026-11-04 11:52'],
  [5, 1, '2026-11-04', 'meal', 86000, '한상 차림 을지로점', '마케팅팀 주간 회의 점심 (5명)', 'pending', 2, '2026-11-04 13:40', null, null, [R('점심 정식', 5, 15000), R('음료', 5, 2200)], '2026-11-04 12:41'],
  [6, 4, '2026-10-29', 'meal', 64800, '카페 온담 성수점', '고객 인터뷰 참가자 6명 다과', 'pending', 1, '2026-11-04 10:05', null, null, [R('조각 케이크', 6, 6800), R('음료', 6, 4000)], '2026-10-29 15:03'],
  [7, 4, '2026-10-26', 'supplies', 73200, '오피스 문구센터 성수점', 'SNS 광고 소재 촬영 소품', 'approved', 1, '2026-10-26 15:40', '2026-10-27 09:40', null, [R('촬영 배경지', 4, 9800), R('LED 미니 조명', 1, 34000)], '2026-10-26 11:26'],
  [8, 14, '2026-10-15', 'transport', 18700, '택시 (성수 → 강남)', '외부 미팅 이동', 'rejected', 1, '2026-10-15 18:10', '2026-10-16 10:30', '영수증 사진이 흐려서 금액이 보이지 않아요. 다시 찍어서 올려 주세요.', [R('택시 요금', 1, 18700)], '2026-10-15 16:40'],
];

// Attendance for the demo user (late Oct + Nov 1–5). [date, in, out, status, note, corrected]
const ATTENDANCE = [
  ['2026-10-26', '08:54', '18:12', 'normal', '', 0],
  ['2026-10-27', '08:49', '19:05', 'normal', '', 0],
  ['2026-10-28', '08:58', '18:50', 'normal', '퇴근 시간 정정 반영', 1],
  ['2026-10-29', '08:52', '18:41', 'normal', '', 0],
  ['2026-10-30', null, null, 'vacation', '연차', 0],
  ['2026-11-02', '09:07', '18:30', 'late', '출근 지하철 지연', 0],
  ['2026-11-03', '08:51', '18:40', 'outside', '거래처 미팅 (여의도)', 0],
  ['2026-11-04', '08:55', '18:16', 'normal', '', 0],
  ['2026-11-05', '08:57', null, 'normal', '', 0],
];

const NOTICES = [
  [1, '2026년 연말정산 일정 안내', 16, 1, 48, '2026-11-02 09:00', `2026년 귀속 연말정산 일정을 안내드려요.

- 간소화 자료 조회: 2027년 1월 15일(금)부터
- 공제 신고서 제출: 2027년 1월 18일(월) – 1월 29일(금)
- 결과 확인 및 정정: 2027년 2월 중

올해부터 공제 신고서는 도담워크에서 바로 제출할 수 있어요. 부양가족이 바뀌었거나 주택자금 공제를 받는 분은 증빙 서류를 미리 준비해 주세요.

문의: 경영지원팀 장은비 매니저 (내선 104)`],
  [2, '11월 사내 보안 교육 안내', 2, 1, 37, '2026-11-03 10:30', `정보보호 의무 교육을 아래와 같이 진행해요. 전 구성원 필수 참석이에요.

- 일시: 11월 11일(수) 14:00 – 15:30
- 장소: 7층 대회의실 (온라인 동시 참여 가능)
- 내용: 피싱 메일 대응, 비밀번호 관리, 고객 정보 취급 기준

참석이 어려운 분은 11월 18일(수)까지 다시보기로 이수해 주세요. 미이수 시 사내 시스템 접근이 제한될 수 있어요.`],
  [3, '사무실 네트워크 점검 공지(11/8)', 7, 0, 21, '2026-11-04 09:30', `네트워크 장비 교체 작업으로 아래 시간 동안 인터넷과 사내 와이파이가 끊겨요.

- 일시: 11월 8일(일) 02:00 – 06:00
- 영향: 사내 와이파이, 유선 인터넷, 회의실 화상 장비

작업 시간에는 원격 접속(VPN)도 잠시 끊길 수 있어요. 주말 근무 예정인 분은 개발팀 서준호 팀장에게 미리 알려 주세요.`],
  [4, '복지포인트 사용 기한 안내', 16, 0, 52, '2026-10-30 14:00', `2026년 복지포인트는 12월 20일(일)까지 쓸 수 있어요. 남은 포인트는 이월되지 않으니 기한 안에 사용해 주세요.

- 사용처: 도서, 운동, 건강검진, 자기계발 강의
- 청구 방법: 경비 메뉴에서 분류를 '기타'로 선택하고 메모에 '복지포인트'라고 적어 주세요.
- 1인 연간 한도: 600,000원`],
  [5, '4분기 전사 타운홀 미팅 안내', 2, 0, 61, '2026-10-27 11:00', `4분기 타운홀 미팅을 아래와 같이 진행해요.

- 일시: 11월 27일(금) 16:00 – 17:30
- 장소: 7층 라운지
- 순서: 3분기 실적 공유, 2027년 사업 계획, 팀별 하이라이트, 자유 질의응답

미리 묻고 싶은 질문은 11월 24일(화)까지 경영지원팀에 보내 주세요. 행사가 끝나면 간단한 다과가 준비돼 있어요.`],
  [6, '사내 동호회 지원 제도 변경 안내', 16, 0, 44, '2026-10-20 16:20', `11월부터 사내 동호회 활동비 지원 기준이 바뀌어요.

- 지원 대상: 구성원 4명 이상이 참여하는 동호회
- 지원 금액: 1인당 월 30,000원 (기존 20,000원)
- 신청 방법: 매월 활동 사진과 영수증을 첨부해 경비로 청구

새 동호회를 만들고 싶은 분은 경영지원팀에 알려 주세요.`],
];

// Notices that carry a photograph (public/img/<name>-800.jpg / -1600.jpg).
const NOTICE_PHOTOS = { 2: 'training-room', 5: 'townhall' };

const EVENTS = [
  ['2026-11-08', null, '사무실 네트워크 점검', '02:00 – 06:00 · 인터넷 일시 중단'],
  ['2026-11-11', null, '11월 사내 보안 교육', '14:00 · 7층 대회의실'],
  ['2026-11-27', null, '4분기 전사 타운홀 미팅', '16:00 · 7층 라운지'],
];

const SETTINGS = {
  company: { name: '주식회사 도담', ceo: '윤재원', bizno: '123-45-67890', phone: '02-6952-1180', address: '서울특별시 성동구 성수이로 118, 7층', work_start: '09:00', work_end: '18:00' },
  leave: { basis: 'fiscal', half_day: '1', carry_over: '0' },
  'user:1': { approval_request: '1', approval_result: '1', notice: '1', attendance: '0', email: '1' },
  home: { featured_notice: '5' },
};

// ---------------------------------------------------------------- helpers

const won = (n) => n.toLocaleString('ko-KR');
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const dateW = (s) => `${s.replaceAll('-', '.')} (${WEEK[new Date(`${s}T00:00:00Z`).getUTCDay()]})`;
const periodText = (a, b) => (a === b ? dateW(a) : `${dateW(a)} – ${dateW(b)}`);
const short = (s) => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;
const xmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// A simple, legible receipt image (SVG) for each seeded expense.
function receiptSvg({ merchant, paidAt, items }) {
  const total = items.reduce((s, it) => s + it.qty * it.price, 0);
  const supply = Math.round(total / 1.1);
  const font = "font-family='Pretendard, sans-serif'";
  const rows = items
    .map((it, i) => {
      const y = 132 + i * 22;
      return `<text x='20' y='${y}' ${font} font-size='11' fill='#374151'>${xmlEsc(it.name)}</text><text x='150' y='${y}' ${font} font-size='11' fill='#6B7280' text-anchor='end'>${it.qty}</text><text x='220' y='${y}' ${font} font-size='11' fill='#111827' text-anchor='end'>${won(it.qty * it.price)}</text>`;
    })
    .join('');
  const y0 = 132 + items.length * 22 + 6;
  const zig = Array.from({ length: 12 }, (_, k) => 11 - k).map((i) => `L${i * 20 + 10} 340L${i * 20} 330`).join('');
  return `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='340' viewBox='0 0 240 340'>
<path d='M0 0H240V330${zig}Z' fill='#FFFFFF'/>
<text x='120' y='36' ${font} font-size='15' font-weight='700' fill='#111827' text-anchor='middle'>${xmlEsc(merchant)}</text>
<text x='120' y='56' ${font} font-size='10' fill='#9CA3AF' text-anchor='middle'>사업자 214-00-00000 · 서울 성동구</text>
<line x1='20' y1='72' x2='220' y2='72' stroke='#D1D5DB' stroke-dasharray='3 3'/>
<text x='20' y='92' ${font} font-size='10.5' fill='#6B7280'>${paidAt}</text>
<text x='220' y='92' ${font} font-size='10.5' fill='#6B7280' text-anchor='end'>영수증</text>
<text x='20' y='112' ${font} font-size='10' fill='#9CA3AF'>품명</text><text x='150' y='112' ${font} font-size='10' fill='#9CA3AF' text-anchor='end'>수량</text><text x='220' y='112' ${font} font-size='10' fill='#9CA3AF' text-anchor='end'>금액</text>
${rows}
<line x1='20' y1='${y0}' x2='220' y2='${y0}' stroke='#D1D5DB' stroke-dasharray='3 3'/>
<text x='20' y='${y0 + 20}' ${font} font-size='10.5' fill='#6B7280'>공급가액</text><text x='220' y='${y0 + 20}' ${font} font-size='10.5' fill='#6B7280' text-anchor='end'>${won(supply)}</text>
<text x='20' y='${y0 + 38}' ${font} font-size='10.5' fill='#6B7280'>부가세</text><text x='220' y='${y0 + 38}' ${font} font-size='10.5' fill='#6B7280' text-anchor='end'>${won(total - supply)}</text>
<text x='20' y='${y0 + 64}' ${font} font-size='13' font-weight='700' fill='#111827'>합계</text><text x='220' y='${y0 + 64}' ${font} font-size='15' font-weight='700' fill='#111827' text-anchor='end'>${won(total)}원</text>
<text x='120' y='${y0 + 92}' ${font} font-size='10' fill='#9CA3AF' text-anchor='middle'>법인카드 ****-2207 · 일시불 승인</text>
</svg>`;
}

// ---------------------------------------------------------------- build

const tmp = `${DB_PATH}.seeding`;
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
for (const f of [tmp, `${tmp}-journal`]) fs.rmSync(f, { force: true });

const db = openDb(tmp);
db.exec(SCHEMA);
db.exec('BEGIN');

const insDept = db.prepare('INSERT INTO departments (id, name, sort) VALUES (?, ?, ?)');
DEPARTMENTS.forEach((name, i) => insDept.run(i + 1, name, i + 1));

const insUser = db.prepare(
  `INSERT INTO users (id, name, email, password_hash, dept_id, title, role, invited, phone, employee_no, joined_on, leave_total, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 15, ?)`,
);
for (const [id, name, email, dept, title, role, phone, empNo, joined] of USERS) {
  insUser.run(id, name, email, hashPassword(PASSWORD, `dodam-${id}`), dept, title, role, phone, empNo, joined, `${joined} 09:00`);
}
for (const [id, name, email, dept, role, created] of INVITED) {
  db.prepare(`INSERT INTO users (id, name, email, password_hash, dept_id, title, role, invited, created_at) VALUES (?, ?, ?, NULL, ?, NULL, ?, 1, ?)`).run(id, name, email, dept, role, created);
}
const user = (id) => USERS.find((u) => u[0] === id);
const deptOf = (id) => DEPARTMENTS[user(id)[3] - 1];

const insLeave = db.prepare(
  `INSERT INTO leave_requests (id, user_id, type, start_date, end_date, days, reason, status, approver_id, created_at, decided_at, decision_note)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
LEAVES.forEach((l) => insLeave.run(...l));

const insExp = db.prepare(
  `INSERT INTO expenses (id, user_id, used_on, category, amount, merchant, memo, receipt_name, receipt_type, receipt, status, approver_id, created_at, decided_at, decision_note)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
for (const [id, uid, usedOn, cat, amount, merchant, memo, status, approver, created, decided, note, items, paidAt] of EXPENSES) {
  const sum = items.reduce((s, it) => s + it.qty * it.price, 0);
  if (sum !== amount) throw new Error(`receipt total mismatch for expense ${id}: ${sum} != ${amount}`);
  const svg = Buffer.from(receiptSvg({ merchant, paidAt, items }));
  insExp.run(id, uid, usedOn, cat, amount, merchant, memo, `영수증_${usedOn.slice(5).replace('-', '')}.svg`, 'image/svg+xml', svg, status, approver, created, decided, note);
}

// Approval documents. Each spec: kind, title, drafter, drafted, steps, body, ref.
const LEAVE_LABEL = { annual: '연차', am_half: '오전 반차', pm_half: '오후 반차', sick: '병가', family: '경조사' };
const LEAVE_TITLE = { annual: '연차 휴가 신청', am_half: '오전 반차 신청', pm_half: '오후 반차 신청', sick: '병가 신청', family: '경조사 휴가 신청' };
const CAT_LABEL = { meal: '식대', transport: '교통비', supplies: '소모품', entertainment: '접대비', etc: '기타' };
const fmtDays = (n) => `${n}일`;

const docs = [];
// Leave requests -> leave request documents
for (const [id, uid, type, start, end, days, reason, status, approver, created, decided, note] of LEAVES) {
  if (uid === 8) continue; // another team's leave, approved outside this demo user's view
  const extra = uid === 3 ? [['업무 대행', '최서아 매니저'], ['비상 연락처', '010-5521-0937']] : [];
  docs.push({
    kind: 'leave',
    title: `${LEAVE_TITLE[type]} (${start === end ? short(start) : `${short(start)}~${short(end)}`})`,
    drafter: uid,
    drafted: created,
    status,
    closed: decided,
    steps: [{ user: approver, role: '승인', status: status === 'pending' ? 'pending' : status, at: decided, comment: note }],
    body: { fields: [['휴가 종류', LEAVE_LABEL[type]], ['기간', periodText(start, end)], ['일수', fmtDays(days)], ['사유', reason], ...extra] },
    ref: ['leave', id],
  });
}
// Expenses -> expense claim documents
const EXP_TITLES = { 6: '고객 인터뷰 다과비 청구', 7: 'SNS 광고 소재 촬영 소품 구입', 8: '외부 미팅 택시비 청구' };
for (const [id, uid, usedOn, cat, amount, merchant, memo, status, approver, created, decided, note] of EXPENSES) {
  docs.push({
    kind: 'expense',
    title: EXP_TITLES[id] || `${CAT_LABEL[cat]} 청구 · ${merchant}`,
    drafter: uid,
    drafted: created,
    status,
    closed: decided,
    steps: [{ user: approver, role: '승인', status: status === 'pending' ? 'pending' : status, at: decided, comment: note }],
    body: {
      fields: [['사용일', dateW(usedOn)], ['분류', CAT_LABEL[cat]], ['사용처', merchant], ['금액', `${won(amount)}원`], ['메모', memo]],
      attachments: [{ name: `영수증_${usedOn.slice(5).replace('-', '')}.svg`, expenseId: id }],
    },
    ref: ['expense', id],
  });
}
// Purchase and trip documents.
docs.push({
  kind: 'purchase',
  title: '디자인팀 모니터 구매',
  drafter: 5,
  drafted: '2026-11-03 14:30',
  status: 'pending',
  steps: [
    { user: 6, role: '검토', status: 'approved', at: '2026-11-03 17:02', comment: '신규 입사자 자리 세팅 일정에 맞춰 진행해 주세요.' },
    { user: 1, role: '승인', status: 'pending' },
  ],
  body: {
    fields: [['구매 목적', '신규 입사자 작업 환경 구성 및 디자이너 듀얼 모니터 전환'], ['납품 희망일', dateW('2026-11-12')], ['구매처', '오피스몰 (사무기기 전문몰)'], ['결제 방법', '법인카드']],
    items: [
      { name: '27인치 QHD 모니터', spec: 'IPS · 75Hz · 높낮이 조절', qty: 2, price: 389000 },
      { name: '모니터 암', spec: '싱글 · 가스 스프링', qty: 2, price: 45000 },
      { name: 'HDMI 케이블', spec: '2m', qty: 2, price: 9000 },
    ],
  },
});
docs.push({
  kind: 'purchase',
  title: '4분기 SNS 광고 집행 품의',
  drafter: 1,
  drafted: '2026-11-02 11:20',
  status: 'pending',
  steps: [{ user: 2, role: '승인', status: 'pending' }],
  body: {
    fields: [['집행 목적', '연말 프로모션 신규 가입자 확보'], ['집행 기간', periodText('2026-11-16', '2026-12-20')], ['예산 과목', '광고선전비']],
    items: [
      { name: 'SNS 피드 광고', spec: '11/16~12/20 · 5주', qty: 1, price: 3000000 },
      { name: '검색 광고', spec: '키워드 30개', qty: 1, price: 1200000 },
      { name: '광고 소재 제작', spec: '이미지 8종 · 영상 2종', qty: 1, price: 600000 },
    ],
  },
});
docs.push({
  kind: 'trip',
  title: '부산 마케팅 박람회 참관 출장',
  drafter: 1,
  drafted: '2026-10-14 10:00',
  status: 'approved',
  closed: '2026-10-14 15:30',
  steps: [{ user: 2, role: '승인', status: 'approved', at: '2026-10-14 15:30', comment: '출장 보고서는 다음 주 금요일까지 공유 부탁해요.' }],
  body: { fields: [['출장지', '부산 해운대구 (전시 컨벤션센터)'], ['기간', periodText('2026-10-15', '2026-10-16')], ['목적', '2026 마케팅 박람회 참관 및 파트너사 미팅'], ['동행자', '이도윤 선임'], ['예상 경비', '420,000원 (교통 118,000 · 숙박 180,000 · 식대 72,000 · 기타 50,000)']] },
});
docs.push({
  kind: 'trip',
  title: '대구 고객사 미팅 출장',
  drafter: 3,
  drafted: '2026-10-19 11:00',
  status: 'approved',
  closed: '2026-10-20 09:15',
  steps: [{ user: 1, role: '승인', status: 'approved', at: '2026-10-20 09:15', comment: null }],
  body: { fields: [['출장지', '대구 수성구'], ['기간', dateW('2026-10-22')], ['목적', '고객사 브랜드 리뉴얼 제안 미팅'], ['예상 경비', '186,000원 (KTX 왕복 · 식대)']] },
});

// Insert in drafting order so ids and document numbers are chronological.
docs.sort((a, b) => a.drafted.localeCompare(b.drafted));
const seqByDept = { 마케팅팀: 96, 디자인팀: 46 };
const insDoc = db.prepare(
  `INSERT INTO approval_docs (doc_no, kind, title, drafter_id, status, body, ref_type, ref_id, drafted_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const insStep = db.prepare('INSERT INTO approval_steps (doc_id, seq, user_id, role, status, acted_at, comment) VALUES (?, ?, ?, ?, ?, ?, ?)');
const docIdByTitle = {};
for (const d of docs) {
  const dept = deptOf(d.drafter);
  seqByDept[dept] = (seqByDept[dept] || 0) + 1 + (d.drafter === 1 ? 1 : 0);
  const docNo = `${dept}-${d.drafted.slice(0, 4)}-${String(seqByDept[dept]).padStart(3, '0')}`;
  const r = insDoc.run(docNo, d.kind, d.title, d.drafter, d.status, JSON.stringify(d.body), d.ref?.[0] ?? null, d.ref?.[1] ?? null, d.drafted, d.status === 'pending' ? null : d.closed);
  const docId = Number(r.lastInsertRowid);
  docIdByTitle[d.title] = docId;
  insStep.run(docId, 0, d.drafter, '기안', 'drafted', d.drafted, null);
  d.steps.forEach((s, i) => insStep.run(docId, i + 1, s.user, s.role, s.status, s.status === 'pending' || s.status === 'waiting' ? null : s.at, s.comment ?? null));
}

const insAtt = db.prepare('INSERT INTO attendance (user_id, work_date, clock_in, clock_out, status, note, corrected) VALUES (1, ?, ?, ?, ?, ?, ?)');
ATTENDANCE.forEach((a) => insAtt.run(...a));
db.prepare(`INSERT INTO corrections (user_id, work_date, field, time, reason, status, created_at) VALUES (1, '2026-10-28', 'out', '18:50', '외부 미팅 후 사무실에 복귀해서 퇴근 기록을 늦게 남겼어요.', 'approved', '2026-10-29 09:20')`).run();

const insNotice = db.prepare('INSERT INTO notices (id, title, body, author_id, pinned, views, created_at, photo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
for (const [id, title, author, pinned, views, created, body] of NOTICES) insNotice.run(id, title, body, author, pinned, views, created, NOTICE_PHOTOS[id] ?? null);

const insEvent = db.prepare('INSERT INTO events (date, end_date, title, detail) VALUES (?, ?, ?, ?)');
EVENTS.forEach((e) => insEvent.run(...e));

const insNote = db.prepare('INSERT INTO notifications (user_id, kind, text, link, created_at, read) VALUES (1, ?, ?, ?, ?, ?)');
insNote.run('result', '박지훈님이 경비 청구(오피스 문구센터 성수점)를 승인했어요.', '/expenses/1', '2026-11-03 09:12', 1);
insNote.run('approval', '한소율님이 ‘디자인팀 모니터 구매’ 검토를 마쳤어요. 최종 결재가 필요해요.', `/approvals/${docIdByTitle['디자인팀 모니터 구매']}`, '2026-11-03 17:02', 0);
insNote.run('notice', '새 공지 ‘사무실 네트워크 점검 공지(11/8)’가 올라왔어요.', '/notices/3', '2026-11-04 09:30', 1);
insNote.run('approval', '최서아님이 경비 청구서를 올렸어요. 결재해 주세요.', `/approvals/${docIdByTitle['고객 인터뷰 다과비 청구']}`, '2026-11-04 10:05', 0);
insNote.run('approval', '이도윤님이 휴가 신청서를 올렸어요. 결재해 주세요.', `/approvals/${docIdByTitle['연차 휴가 신청 (11/19~11/20)']}`, '2026-11-04 16:12', 0);

const insSet = db.prepare('INSERT INTO settings (scope, key, value) VALUES (?, ?, ?)');
for (const [scope, values] of Object.entries(SETTINGS)) for (const [k, v] of Object.entries(values)) insSet.run(scope, k, v);

db.exec('COMMIT');
db.exec('VACUUM');
db.close();

// Atomic swap so a half-written database is never visible.
fs.rmSync(`${DB_PATH}-journal`, { force: true });
fs.renameSync(tmp, DB_PATH);
fs.rmSync(`${tmp}-journal`, { force: true });

console.log(`seeded ${DB_PATH}`);
console.log(`  login: demo@dodamwork.test / ${PASSWORD} (김하늘, 마케팅팀 팀장, 관리자)`);
console.log(`  ${USERS.length + INVITED.length} members, ${LEAVES.length} leave requests, ${EXPENSES.length} expenses, ${docs.length} approval documents, ${NOTICES.length} notices`);
console.log('  if the server is running, restart it: testapps/ctl.sh restart dodam');
