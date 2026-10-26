// UI label variants. Set DODAM_LABELS=v2 to rename a few labels so the guide
// maintenance pipeline can be tested against a "the UI copy changed" scenario.
// Every label that differs between variants lives in this one table.
const VARIANTS = {
  v1: {
    leaveNewButton: '휴가 신청', // button-link on /leave and the home quick action
    leaveNewTitle: '휴가 신청', // h1, <title> and breadcrumb of /leave/new
    leaveSubmit: '신청하기', // submit button of the leave form
    leaveCreated: '휴가 신청이 접수됐어요. 결재가 끝나면 알려드릴게요.',
    leaveCancel: '신청 취소', // danger button on /leave/:id
    leaveCancelConfirm: '신청 취소하기', // confirm button inside the modal
    leaveCancelTitle: '휴가 신청을 취소할까요?',
    leaveCancelled: '휴가 신청을 취소했어요.',
  },
  v2: {
    leaveNewButton: '휴가 요청',
    leaveNewTitle: '휴가 요청',
    leaveSubmit: '요청하기',
    leaveCreated: '휴가 요청이 접수됐어요. 결재가 끝나면 알려드릴게요.',
    leaveCancel: '요청 취소',
    leaveCancelConfirm: '요청 취소하기',
    leaveCancelTitle: '휴가 요청을 취소할까요?',
    leaveCancelled: '휴가 요청을 취소했어요.',
  },
};

export const LABEL_VARIANT = process.env.DODAM_LABELS === 'v2' ? 'v2' : 'v1';
export const L = VARIANTS[LABEL_VARIANT];
