// Action safety gate. The agent works on real sites, so every click is
// classified before it runs. Exploration may only look; performing a workflow
// may cause the effects the workflow was approved for; irreversible effects on
// live data become "ghost" steps that are filmed but never executed.

const PATTERNS = {
  logout: /(log ?out|sign ?out|로그아웃|로그 아웃)/i,
  delete: /(delete|remove|destroy|erase|purge|discard|archive|deactivate|unsubscribe|leave (team|org)|삭제|제거|지우기|탈퇴|해지|비활성화|보관 처리|폐기)/i,
  pay: /(pay|purchase|buy|checkout|place order|subscribe|upgrade|billing|결제|구매|주문|송금|이체|충전|구독|업그레이드)/i,
  send: /(send|invite|publish|post|notify|email|message|전송|발송|보내기|초대|게시|발행|알림 보내기)/i,
  share: /(share|공유)/i,
  submit: /(submit|apply|confirm|finish|complete|register|request|제출|신청|확정|완료|접수|등록하기|요청)/i,
  save: /(save|create|add|new|update|apply changes|ok|done|저장|생성|만들기|추가|등록|수정|적용|확인)/i,
};

const NEUTRAL = /(cancel|close|back|dismiss|취소|닫기|뒤로|이전)/i;

export function classifyAction({ tool, role, name, text, container }, { strict = false } = {}) {
  const label = [name, text].filter(Boolean).join(' ').slice(0, 200);
  if (tool !== 'click' && tool !== 'press_key') return { category: 'input', label };
  // Focusing a field commits nothing, whatever its label says.
  if (['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider'].includes(role)) return { category: 'input', label };
  if (!label) return { category: 'unknown', label };
  if (NEUTRAL.test(label) && label.length <= 20) return { category: 'neutral', label };
  // Links, tabs and menu entries navigate or filter; only hard-destructive
  // words count there. "검토 요청됨" (review requested) is a filter tab, not a submit.
  const navRole = !strict && ['link', 'tab', 'menuitem', 'treeitem', 'option', 'radio', 'checkbox', 'switch'].includes(role);
  for (const cat of navRole ? ['logout', 'delete', 'pay'] : ['logout', 'delete', 'pay', 'send', 'share', 'submit', 'save']) {
    if (PATTERNS[cat].test(label)) return { category: cat, label };
  }
  if (role === 'link' || role === 'tab' || role === 'menuitem' || role === 'treeitem' || role === 'option') return { category: 'navigate', label };
  return { category: 'other', label };
}

// mode: 'explore' | 'perform'. siteMode: 'sandbox' (test app / test account)
// or 'live' (customer data). allowed: effects the workflow was approved for.
export function decide({ mode, siteMode = 'sandbox', allowed = [], action }) {
  // Exploration must never change data, so every role gets the full word check.
  const c = classifyAction(action, { strict: mode === 'explore' });
  if (c.category === 'logout') return { decision: 'block', reason: 'Logging out would end the session.', ...c };
  if (mode === 'explore') {
    if (['delete', 'pay', 'send', 'share', 'submit', 'save'].includes(c.category)) return { decision: 'block', reason: `Exploration never triggers "${c.category}" actions.`, ...c };
    return { decision: 'allow', ...c };
  }
  if (['delete', 'pay', 'send', 'share', 'submit'].includes(c.category)) {
    if (!allowed.includes(c.category)) return { decision: 'block', reason: `This workflow is not approved for "${c.category}" actions.`, ...c };
    if (siteMode === 'live') return { decision: 'ghost', reason: `Irreversible "${c.category}" on live data is filmed but not executed.`, ...c };
  }
  return { decision: 'allow', ...c };
}
