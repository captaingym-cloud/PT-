// SMS 인증 API + 정적 파일 서빙을 함께 처리하는 Worker.
// 기존 pt 프로젝트는 정적 파일만 서빙했는데(assets 전용), 여기에 /api/* 경로만
// 가로채서 서버 로직(알리고 SMS 발송)을 처리하고 나머지는 그대로 정적 파일로
// 넘겨서 index.html 등 기존 배포는 전혀 안 건드림.

const CODE_TTL_SECONDS = 5 * 60; // 인증번호 5분 유효
const RESEND_COOLDOWN_SECONDS = 60; // 같은 번호로 재발송은 60초 간격 제한 (SMS 스팸/비용 남용 방지)

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function normalizePhone(phone) {
  return (phone || '').replace(/[^0-9]/g, '');
}

function isValidKoreanPhone(phone) {
  // 010/011/016/017/018/019로 시작하는 10~11자리
  return /^01[016789]\d{7,8}$/.test(phone);
}

function randomSixDigitCode() {
  // crypto.getRandomValues로 균등 분포 6자리 생성 (Math.random보다 예측 어려움)
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(100000 + (arr[0] % 900000));
}

async function sendAligoSms(env, phone, code) {
  const body = new URLSearchParams({
    key: env.ALIGO_API_KEY,
    user_id: env.ALIGO_USER_ID,
    sender: env.ALIGO_SENDER,
    receiver: phone,
    msg: `[PT일지] 인증번호는 [${code}] 입니다. 5분 이내에 입력해주세요.`,
    msg_type: 'SMS',
  });
  const res = await fetch('https://apis.aligo.in/send/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json().catch(() => null);
  // 알리고는 성공해도 HTTP 200 + result_code로 성공/실패를 구분함
  const ok = res.ok && data && String(data.result_code) === '1';
  return { ok, raw: data };
}

async function handleSendSms(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: '요청 형식이 올바르지 않아요.' }, 400);
  }

  const phone = normalizePhone(payload.phone);
  if (!isValidKoreanPhone(phone)) {
    return jsonResponse({ ok: false, error: '올바른 휴대폰 번호를 입력해주세요.' }, 400);
  }

  const cooldownKey = `cooldown_${phone}`;
  const stillCoolingDown = await env.SMS_KV.get(cooldownKey);
  if (stillCoolingDown) {
    return jsonResponse({ ok: false, error: '잠시 후 다시 시도해주세요. (재발송은 1분 간격)' }, 429);
  }

  const code = randomSixDigitCode();
  const codeKey = `code_${phone}`;

  const smsResult = await sendAligoSms(env, phone, code);
  if (!smsResult.ok) {
    return jsonResponse({ ok: false, error: '문자 발송에 실패했어요. 잠시 후 다시 시도해주세요.' }, 502);
  }

  // 발송 성공한 뒤에만 코드를 저장 — 발송 실패했는데 코드만 저장되면 트레이너가
  // 문자를 못 받았는데도 "인증번호 확인" 화면으로 넘어가서 계속 헷갈리게 됨
  await env.SMS_KV.put(codeKey, JSON.stringify({ code, attempts: 0 }), { expirationTtl: CODE_TTL_SECONDS });
  await env.SMS_KV.put(cooldownKey, '1', { expirationTtl: RESEND_COOLDOWN_SECONDS });

  return jsonResponse({ ok: true });
}

async function handleVerifySms(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: '요청 형식이 올바르지 않아요.' }, 400);
  }

  const phone = normalizePhone(payload.phone);
  const inputCode = (payload.code || '').trim();
  if (!phone || !/^\d{6}$/.test(inputCode)) {
    return jsonResponse({ ok: false, error: '인증번호 6자리를 입력해주세요.' }, 400);
  }

  const codeKey = `code_${phone}`;
  const stored = await env.SMS_KV.get(codeKey);
  if (!stored) {
    return jsonResponse({ ok: false, error: '인증번호가 만료됐어요. 다시 요청해주세요.' }, 410);
  }

  const record = JSON.parse(stored);

  // 코드 자체는 6자리 숫자라 무차별 대입이 쉬운 편이라, 시도 횟수를 제한해서
  // 같은 인증번호에 대해 5번 넘게 틀리면 그 코드를 폐기하고 재발송을 요구함
  if (record.attempts >= 5) {
    await env.SMS_KV.delete(codeKey);
    return jsonResponse({ ok: false, error: '시도 횟수를 초과했어요. 인증번호를 다시 요청해주세요.' }, 429);
  }

  if (record.code !== inputCode) {
    record.attempts += 1;
    await env.SMS_KV.put(codeKey, JSON.stringify(record), { expirationTtl: CODE_TTL_SECONDS });
    return jsonResponse({ ok: false, error: '인증번호가 일치하지 않아요.' }, 401);
  }

  // 검증 성공하면 재사용 방지를 위해 즉시 폐기
  await env.SMS_KV.delete(codeKey);
  // 회원가입 단계에서 "이 번호가 방금 인증됐다"는 걸 짧게 확인할 수 있도록 별도 플래그를
  // 남겨둠 (가입 완료까지 몇 분 걸릴 수 있어서 인증 코드보다 조금 더 여유있게 유지)
  await env.SMS_KV.put(`verified_${phone}`, '1', { expirationTtl: 15 * 60 });

  return jsonResponse({ ok: true });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/send-sms' && request.method === 'POST') {
      return handleSendSms(request, env);
    }
    if (url.pathname === '/api/verify-sms' && request.method === 'POST') {
      return handleVerifySms(request, env);
    }

    // API 경로가 아니면 기존처럼 정적 파일(index.html 등)로 그대로 넘김
    return env.ASSETS.fetch(request);
  },
};
