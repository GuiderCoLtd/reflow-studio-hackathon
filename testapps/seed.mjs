// Seed the local test apps with realistic Korean sample data through their
// REST APIs, so exploration and guides see a lived-in workspace.
const PASS = 'DemoPass!2026';

async function j(res) {
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.url} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function seedGitea() {
  const base = 'http://127.0.0.1:3300/api/v1';
  const auth = { Authorization: 'Basic ' + Buffer.from(`demo:${PASS}`).toString('base64'), 'Content-Type': 'application/json' };
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: auth, body: JSON.stringify(body) }).then(j);
  const repos = [
    { name: 'website', description: '회사 홈페이지 (Next.js)' },
    { name: 'mobile-app', description: '고객용 모바일 앱' },
  ];
  for (const r of repos) await post('/user/repos', { ...r, auto_init: true, readme: 'Default', default_branch: 'main' }).catch((e) => console.log('repo', e.message.slice(0, 80)));
  const labels = [
    { name: '버그', color: '#e11d48' },
    { name: '기능 요청', color: '#2563eb' },
    { name: '문서', color: '#16a34a' },
  ];
  const labelIds = [];
  for (const l of labels) {
    const res = await post('/repos/demo/website/labels', l).catch(() => null);
    if (res) labelIds.push(res.id);
  }
  const ms = await post('/repos/demo/website/milestones', { title: '11월 릴리스', description: '홈페이지 개편 1차' }).catch(() => null);
  const issues = [
    { title: '모바일에서 메뉴가 겹쳐 보임', body: '아이폰 사파리에서 상단 메뉴가 본문을 가립니다.', labels: [labelIds[0]] },
    { title: '문의하기 폼에 개인정보 동의 추가', body: '법무팀 요청 사항입니다.', labels: [labelIds[1]] },
    { title: '회사 소개 페이지 문구 수정', body: '대표 인사말을 최신 버전으로 교체해 주세요.', labels: [labelIds[2]] },
    { title: '검색 결과 정렬 오류', body: '최신순 정렬이 동작하지 않습니다.', labels: [labelIds[0]] },
  ];
  for (const i of issues) await post('/repos/demo/website/issues', { ...i, labels: i.labels.filter(Boolean), milestone: ms?.id }).catch((e) => console.log('issue', e.message.slice(0, 80)));
  await post('/orgs', { username: 'acme', full_name: 'Acme 주식회사', visibility: 'public' }).catch((e) => console.log('org', e.message.slice(0, 80)));
  console.log('gitea seeded');
}

async function seedVikunja() {
  const base = 'http://127.0.0.1:3456/api/v1';
  const { token } = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'demo', password: PASS }) }).then(j);
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const put = (p, body) => fetch(base + p, { method: 'PUT', headers: h, body: JSON.stringify(body) }).then(j);
  const existing = await fetch(base + '/projects', { headers: h }).then(j);
  const byTitle = Object.fromEntries(existing.map((p) => [p.title, p]));
  const projects = [
    { title: '웹사이트 리뉴얼', description: '<p>홈페이지 개편 프로젝트</p>', hex_color: '2563eb' },
    { title: '마케팅 캠페인 2026', description: '<p>4분기 캠페인 일정 관리</p>', hex_color: 'e11d48' },
    { title: '채용', description: '<p>상반기 채용 진행 현황</p>', hex_color: '16a34a' },
  ];
  const ids = {};
  for (const p of projects) ids[p.title] = byTitle[p.title]?.id ?? (await put('/projects', p)).id;
  const labels = [
    { title: '긴급', hex_color: 'e11d48' },
    { title: '디자인', hex_color: '7c3aed' },
    { title: '대기', hex_color: '64748b' },
  ];
  for (const l of labels) await put('/labels', l).catch((e) => console.log('label', e.message.slice(0, 80)));
  const tasks = {
    '웹사이트 리뉴얼': ['메인 화면 시안 검토', '회사 소개 문구 정리', '문의 폼 개선', '검색 기능 점검'],
    '마케팅 캠페인 2026': ['보도자료 초안 작성', 'SNS 광고 소재 준비', '인플루언서 섭외 리스트'],
    채용: ['프론트엔드 개발자 공고 게시', '1차 면접 일정 조율'],
  };
  for (const [proj, list] of Object.entries(tasks)) {
    for (const title of list) await put(`/projects/${ids[proj]}/tasks`, { title }).catch((e) => console.log('task', e.message.slice(0, 80)));
  }
  await put('/teams', { name: '마케팅팀', description: '마케팅 담당' }).catch((e) => console.log('team', e.message.slice(0, 80)));
  console.log('vikunja seeded', ids);
}

const which = process.argv[2] || 'all';
if (which === 'all' || which === 'gitea') await seedGitea();
if (which === 'all' || which === 'vikunja') await seedVikunja();
