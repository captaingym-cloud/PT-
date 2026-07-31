// SMS 인증 API + 정적 파일 서빙 + 매일 자동 전체 백업(cron)을 함께 처리하는
// Worker. 기존 pt 프로젝트는 정적 파일만 서빙했는데(assets 전용), 여기에
// /api/* 경로만 가로채서 서버 로직을 처리하고 나머지는 그대로 정적 파일로
// 넘겨서 index.html 등 기존 배포는 전혀 안 건드림.

const CODE_TTL_SECONDS = 5 * 60; // 인증번호 5분 유효
const RESEND_COOLDOWN_SECONDS = 60; // 같은 번호로 재발송은 60초 간격 제한 (SMS 스팸/비용 남용 방지)

const FS_PROJECT = 'captaingym-1ccd2';
const FS_API_KEY = 'AIzaSyCXtPpKkFZuDnkZViRheHMq9mePKDUbUt8';
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FS_PROJECT}/databases/(default)/documents`;
const AUTH_BASE = 'https://identitytoolkit.googleapis.com/v1';
const BACKUP_RETENTION_DAYS = 30; // 이보다 오래된 백업은 자동 삭제 (용량 관리)

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
  console.log('sendAligoSms result:', JSON.stringify(data));
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

/* ═══════════════════════════════════════
   매일 자동 전체 백업
   (2026-07-08 데이터 유실 사고 이후 추가 — 배열 문서를 항목당 문서로 바꾼
   구조 개선과는 별개로, "어떤 원인으로든 통째 유실이 나도 되돌릴 수 있게"
   매일 밤 전체 데이터를 R2에 스냅샷 떠서 보관함)
═══════════════════════════════════════ */

function trainerEmail(trainerId) {
  const safe = encodeURIComponent(trainerId).replace(/%/g, '_');
  return `${safe}@captaingym.local`;
}

// 대표님 마스터 계정(__admin__)으로 로그인 — 이 계정만 모든 트레이너의
// ownerId 검사를 통과하도록 firestore.rules에 예외가 있어서, 백업이
// 전체 데이터에 접근하려면 이 계정이 필요함
async function backupAuth(adminPin) {
  const res = await adminAuthFull(adminPin);
  return res ? res.idToken : null;
}

async function adminAuthFull(adminPin) {
  const email = trainerEmail('__admin__');
  const password = 'pw_' + adminPin + '_captaingym';
  const res = await fetch(`${AUTH_BASE}/accounts:signInWithPassword?key=${FS_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return { idToken: data.idToken, uid: data.localId };
}

async function fsListAll(token, col) {
  const results = [];
  let pageToken = '';
  do {
    const url = `${FS_BASE}/${col}?pageSize=300${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`;
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) break;
    const data = await res.json();
    (data.documents || []).forEach((doc) => {
      if (doc.fields && doc.fields.v) {
        try {
          results.push(JSON.parse(doc.fields.v.stringValue));
        } catch (e) {}
      }
    });
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return results;
}

// Worker 1회 실행당 subrequest 한도(기본 50개)를 넘지 않도록, 백업을 두
// 단계(phase)로 나누고 각 단계 안에서도 배치로 쪼갬:
//   phase 'list'  — trainer_directory 순회하며 트레이너별 members_* 조회
//                    (트레이너 1명당 subrequest 1개)를 TRAINERS_PER_BATCH씩
//   phase 'fetch' — worklist(=회원 1명 단위)를 MEMBERS_PER_BATCH씩,
//                    회원 1명당 최대 4개 subrequest(journal/memo2/inbody/meal)
// 두 단계를 합치지 않고 완전히 분리해야 "trainer_directory 조회 +
// 트레이너별 members 조회"가 이미 다 써버린 subrequest 위에 회원 데이터
// 조회가 겹쳐서 한도를 넘는 문제(실제로 발생)를 피할 수 있음.
const TRAINERS_PER_BATCH = 15;
const MEMBERS_PER_BATCH = 10;
const BACKUP_PROGRESS_KEY = 'backups/_progress.json';

async function fsListAllForMember(token, tid, mid) {
  const [journal, memos, inbody, meal] = await Promise.all([
    fsListAll(token, `journal_${tid}_${mid}`),
    fsListAll(token, `memo2_${tid}_${mid}`),
    fsListAll(token, `inbody_${tid}_${mid}`),
    fsListAll(token, `meal_${tid}_${mid}`),
  ]);
  return { journal, memos, inbody, meal };
}

// 하루치 백업을 여러 번의 Worker 실행에 걸쳐 이어감. env.PT_BACKUPS에 진행
// 상태(현재 phase, 다음 인덱스, 지금까지 모은 데이터)를 저장해두고, 매
// 호출마다 정해진 배치 크기만큼만 처리한 뒤 남았으면 done:false를 반환함 —
// 호출한 쪽(continueBackupIfNeeded)이 이걸 보고 새 요청으로 다시 호출함.
async function runFullBackup(env) {
  const adminPin = env.DASH_ADMIN_PIN;
  if (!adminPin) {
    return { ok: false, error: 'DASH_ADMIN_PIN secret이 설정되지 않았어요' };
  }

  const dateKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // cron이 5분마다 도는 동안, 오늘치 백업이 이미 완료돼서 파일이 있으면
  // 곧바로 스킵함 — 이 체크가 없으면 완료 후에도 계속 처음부터 재시작하게 됨
  const existing = await env.PT_BACKUPS.head(`backups/${dateKey}.json`);
  if (existing) {
    return { ok: true, done: true, skipped: true, key: `backups/${dateKey}.json` };
  }

  const token = await backupAuth(adminPin);
  if (!token) {
    return { ok: false, error: '관리자 인증에 실패했어요' };
  }

  const progressObj = await env.PT_BACKUPS.get(BACKUP_PROGRESS_KEY);
  let progress = progressObj ? await progressObj.json().catch(() => null) : null;

  // 진행 상태가 없거나, 있어도 오늘 날짜가 아니면(=어제 백업이 처리 도중
  // 끊긴 채 남아있는 상태면) 오늘 것으로 새로 시작함 — phase 'list'부터
  if (!progress || progress.dateKey !== dateKey) {
    const trainers = await fsListAll(token, 'trainer_directory');
    progress = {
      dateKey,
      phase: 'list',
      trainers,
      trainerIndex: 0,
      trainerMeta: {},
      worklist: [],
      memberIndex: 0,
      byTrainer: {},
    };
  }

  if (progress.phase === 'list') {
    const { trainers } = progress;
    const endIndex = Math.min(progress.trainerIndex + TRAINERS_PER_BATCH, trainers.length);
    for (let i = progress.trainerIndex; i < endIndex; i++) {
      const trainer = trainers[i];
      const tid = trainer.trainerId;
      if (!tid) continue;
      progress.trainerMeta[tid] = { trainerId: tid, name: trainer.name, gym: trainer.gym };
      const members = await fsListAll(token, `members_${tid}`);
      for (const member of members) {
        if (!member.id) continue;
        progress.worklist.push({ tid, member });
      }
    }
    progress.trainerIndex = endIndex;

    if (progress.trainerIndex < trainers.length) {
      await env.PT_BACKUPS.put(BACKUP_PROGRESS_KEY, JSON.stringify(progress), {
        httpMetadata: { contentType: 'application/json' },
      });
      return { ok: true, done: false, phase: 'list', processed: progress.trainerIndex, total: trainers.length };
    }
    progress.phase = 'fetch';
  }

  // phase === 'fetch'
  const { worklist, trainerMeta, byTrainer } = progress;
  const endIndex = Math.min(progress.memberIndex + MEMBERS_PER_BATCH, worklist.length);
  for (let i = progress.memberIndex; i < endIndex; i++) {
    const { tid, member } = worklist[i];
    const data = await fsListAllForMember(token, tid, member.id);
    if (!byTrainer[tid]) byTrainer[tid] = [];
    byTrainer[tid].push({ member, ...data });
  }
  progress.memberIndex = endIndex;

  const done = progress.memberIndex >= worklist.length;

  if (!done) {
    await env.PT_BACKUPS.put(BACKUP_PROGRESS_KEY, JSON.stringify(progress), {
      httpMetadata: { contentType: 'application/json' },
    });
    return { ok: true, done: false, phase: 'fetch', processed: progress.memberIndex, total: worklist.length };
  }

  // 전부 끝났으면 트레이너별로 묶어서 최종 스냅샷을 날짜별 파일로 저장
  const snapshot = {
    generatedAt: new Date().toISOString(),
    trainers: Object.keys(trainerMeta).map((tid) => ({
      ...trainerMeta[tid],
      members: byTrainer[tid] || [],
    })),
  };
  const key = `backups/${dateKey}.json`;
  await env.PT_BACKUPS.put(key, JSON.stringify(snapshot), {
    httpMetadata: { contentType: 'application/json' },
  });
  await env.PT_BACKUPS.delete(BACKUP_PROGRESS_KEY);

  // 오래된 백업 정리 (용량 관리)
  const cutoff = Date.now() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const list = await env.PT_BACKUPS.list({ prefix: 'backups/' });
  for (const obj of list.objects) {
    if (obj.uploaded && new Date(obj.uploaded).getTime() < cutoff && obj.key !== BACKUP_PROGRESS_KEY) {
      await env.PT_BACKUPS.delete(obj.key);
    }
  }

  return { ok: true, done: true, key, trainerCount: Object.keys(trainerMeta).length };
}

/* ═══════════════════════════════════════
   메모 사진 고아 객체 자동 정리 (매일 백업 직후)
   — v2.9.0에서 업로드 시점마다 자동으로 정리하게 고쳤지만, 트레이너가
   한동안 그 메모에 새 사진을 안 올리면 고아가 계속 쌓여있을 수 있음.
   매일 밤 방금 끝낸 백업 스냅샷(각 회원의 memos, 즉 photos 배열까지 이미
   다 갖고 있음)을 그대로 재사용해서, R2(PT_MEMO_PHOTOS)에서 그 어떤
   memos[].photos[].id로도 참조되지 않는 객체를 찾아 지움. 백업과 동일한
   배치/이어가기 구조 — Worker 1회 실행당 subrequest 한도를 넘지 않게
   트레이너 TRAINERS_PER_BATCH명씩만 처리하고 진행 상태를 R2에 저장함
═══════════════════════════════════════ */
const ORPHAN_SWEEP_PROGRESS_KEY = 'backups/_orphan_sweep_progress.json';
const ORPHAN_SWEEP_LOG_PREFIX = 'orphan-sweep-logs/';

async function runOrphanSweep(env, dateKey, snapshot) {
  const existingLog = await env.PT_BACKUPS.head(`${ORPHAN_SWEEP_LOG_PREFIX}${dateKey}.json`);
  if (existingLog) {
    return { ok: true, done: true, skipped: true };
  }

  const progressObj = await env.PT_BACKUPS.get(ORPHAN_SWEEP_PROGRESS_KEY);
  let progress = progressObj ? await progressObj.json().catch(() => null) : null;

  if (!progress || progress.dateKey !== dateKey) {
    progress = { dateKey, trainerIndex: 0, deletedCount: 0, affected: [] };
  }

  const trainers = snapshot.trainers || [];
  const endIndex = Math.min(progress.trainerIndex + TRAINERS_PER_BATCH, trainers.length);
  for (let i = progress.trainerIndex; i < endIndex; i++) {
    const trainer = trainers[i];
    const tid = trainer.trainerId;
    if (!tid) continue;
    for (const memberEntry of trainer.members || []) {
      const member = memberEntry.member;
      if (!member || !member.id) continue;
      const memos = memberEntry.memos || [];
      const keepIds = new Set();
      memos.forEach((m) => (m.photos || []).forEach((p) => p.id && keepIds.add(p.id)));
      const memoIds = new Set(memos.map((m) => m.id).filter(Boolean));
      memoIds.add('note'); // 회원 특이사항은 memoId가 항상 'note'

      let memberDeleted = 0;
      for (const memoId of memoIds) {
        const prefix = memoPhotoKey(tid, member.id, memoId, '');
        const list = await env.PT_MEMO_PHOTOS.list({ prefix });
        const orphans = list.objects.filter((o) => !keepIds.has(o.key.slice(prefix.length)));
        if (orphans.length) {
          await Promise.all(orphans.map((o) => env.PT_MEMO_PHOTOS.delete(o.key)));
          memberDeleted += orphans.length;
        }
      }
      if (memberDeleted > 0) {
        progress.deletedCount += memberDeleted;
        progress.affected.push({
          trainerId: tid,
          trainerName: trainer.name || tid,
          memberId: member.id,
          memberName: member.name || member.id,
          deletedCount: memberDeleted,
        });
      }
    }
  }
  progress.trainerIndex = endIndex;

  const done = progress.trainerIndex >= trainers.length;
  if (!done) {
    await env.PT_BACKUPS.put(ORPHAN_SWEEP_PROGRESS_KEY, JSON.stringify(progress), {
      httpMetadata: { contentType: 'application/json' },
    });
    return { ok: true, done: false, processed: progress.trainerIndex, total: trainers.length };
  }

  const log = {
    dateKey,
    ranAt: new Date().toISOString(),
    deletedCount: progress.deletedCount,
    affectedMembers: progress.affected,
  };
  await env.PT_BACKUPS.put(`${ORPHAN_SWEEP_LOG_PREFIX}${dateKey}.json`, JSON.stringify(log), {
    httpMetadata: { contentType: 'application/json' },
  });
  await env.PT_BACKUPS.delete(ORPHAN_SWEEP_PROGRESS_KEY);

  // 오래된 로그 정리 (백업과 같은 보관 기간 정책 재사용)
  const cutoff = Date.now() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const logList = await env.PT_BACKUPS.list({ prefix: ORPHAN_SWEEP_LOG_PREFIX });
  for (const obj of logList.objects) {
    if (obj.uploaded && new Date(obj.uploaded).getTime() < cutoff) {
      await env.PT_BACKUPS.delete(obj.key);
    }
  }

  return { ok: true, done: true, deletedCount: progress.deletedCount, affectedMembers: progress.affected.length };
}

// 백업이 끝난 뒤 이어서 고아 사진 정리를 시도함 — 아직 백업 자체가 안
// 끝났으면(done:false) 스킵하고 다음 cron 틱에서 백업 이어가기가 먼저
// 진행되게 함. 백업 스냅샷 파일을 다시 읽어와서 그 안의 memos 데이터를 그대로 씀
async function continueOrphanSweepIfBackupDone(env, backupResult) {
  if (!backupResult.ok || !backupResult.done || !backupResult.key) return;
  const dateKey = backupResult.key.replace('backups/', '').replace('.json', '');
  const snapshotObj = await env.PT_BACKUPS.get(backupResult.key);
  if (!snapshotObj) return;
  const snapshot = await snapshotObj.json().catch(() => null);
  if (!snapshot) return;
  await runOrphanSweep(env, dateKey, snapshot);
}

/* ═══════════════════════════════════════
   대표(헬스장 관리자) 대시보드 인증
   (2026-07-10 헬스장/대표/트레이너 3단계 구조 도입 — 대표가 자기 헬스장
   트레이너들의 데이터를 봐야 하는데, firestore.rules상 그러려면 __admin__
   마스터 계정 권한이 필요함. 마스터 PIN을 브라우저에 그대로 노출하면 누구나
   개발자도구로 읽어갈 수 있어서, 이 엔드포인트가 "요청자가 진짜 승인된
   대표인지"를 서버에서 직접 확인한 뒤에만 __admin__ idToken을 발급함)
═══════════════════════════════════════ */
async function handleOwnerAuth(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: '요청 형식이 올바르지 않아요.' }, 400);
  }
  const trainerId = (payload.trainerId || '').trim();
  const trainerPin = (payload.trainerPin || '').trim();
  if (!trainerId || !trainerPin) {
    return jsonResponse({ ok: false, error: '요청이 올바르지 않아요.' }, 400);
  }

  // 1) 요청자 본인 인증 — 자기 트레이너 계정(이름+비밀번호)으로 로그인이
  // 되는지부터 확인함. 이게 없으면 trainerId만 알아도(=이름만 알아도) 아무나
  // 대표 행세를 할 수 있음
  const email = trainerEmail(trainerId);
  const password = 'pw_' + trainerPin + '_captaingym';
  const selfAuthRes = await fetch(`${AUTH_BASE}/accounts:signInWithPassword?key=${FS_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  if (!selfAuthRes.ok) {
    return jsonResponse({ ok: false, error: '로그인 정보가 올바르지 않아요.' }, 401);
  }
  const selfToken = (await selfAuthRes.json()).idToken;

  // 2) 이 트레이너가 실제로 자기 헬스장의 승인된 대표인지 확인. 본인 인증
  // 토큰으로 자기 trainer_directory 문서와 그 gymId의 gym_directory 문서를
  // 조회함(둘 다 로그인만 하면 읽기 허용된 컬렉션이라 본인 토큰으로 충분함)
  const trainerRes = await fetch(`${FS_BASE}/trainer_directory/${encodeURIComponent(trainerId)}`, {
    headers: { Authorization: 'Bearer ' + selfToken },
  });
  if (!trainerRes.ok) return jsonResponse({ ok: false, error: '트레이너 정보를 찾을 수 없어요.' }, 404);
  const trainerDoc = await trainerRes.json();
  const trainerData = trainerDoc.fields && trainerDoc.fields.v ? JSON.parse(trainerDoc.fields.v.stringValue) : null;
  const gymId = trainerData && trainerData.gymId;
  if (!gymId) return jsonResponse({ ok: false, error: '소속 헬스장 정보가 없어요.' }, 403);

  const gymRes = await fetch(`${FS_BASE}/gym_directory/${encodeURIComponent(gymId)}`, {
    headers: { Authorization: 'Bearer ' + selfToken },
  });
  if (!gymRes.ok) return jsonResponse({ ok: false, error: '헬스장 정보를 찾을 수 없어요.' }, 404);
  const gymDoc = await gymRes.json();
  const gymData = gymDoc.fields && gymDoc.fields.v ? JSON.parse(gymDoc.fields.v.stringValue) : null;
  if (!gymData || gymData.ownerTrainerId !== trainerId) {
    return jsonResponse({ ok: false, error: '이 헬스장의 대표가 아니에요.' }, 403);
  }

  // 3) 여기까지 왔으면 진짜 승인된 대표 — __admin__ 계정으로 대신 인증해서
  // idToken을 내려줌 (마스터 PIN 자체는 응답에 안 실림, env secret에서만 씀)
  const adminPin = env.DASH_ADMIN_PIN;
  if (!adminPin) return jsonResponse({ ok: false, error: '대시보드 설정이 아직 안 됐어요.' }, 500);
  const adminAuth = await adminAuthFull(adminPin);
  if (!adminAuth) return jsonResponse({ ok: false, error: '대시보드 인증에 실패했어요.' }, 500);

  return jsonResponse({ ok: true, idToken: adminAuth.idToken, uid: adminAuth.uid, gymId, gymName: gymData.name || '' });
}

/* ═══════════════════════════════════════
   회원 메모 사진 (R2: pt-memo-photos)
   — 메모 1건당 최대 3장. 트레이너가 로그인할 때 이미 발급받은 Firebase
   idToken을 그대로 재사용해서, 그 토큰이 실제로 유효한지만 Firebase Auth로
   확인함(토큰이 있다=로그인된 트레이너다). 키는 trainerId/memberId/memoId
   기준으로 구성해서, 조회할 때도 그 조합을 알아야만 접근 가능함
═══════════════════════════════════════ */
const MEMO_PHOTO_MAX_BYTES = 5 * 1024 * 1024; // 장당 5MB 제한
const MEMO_PHOTO_MAX_COUNT = 3; // 메모 1건당 최대 3장

async function verifyFirebaseToken(idToken) {
  if (!idToken) return null;
  const res = await fetch(`${AUTH_BASE}/accounts:lookup?key=${FS_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.users && data.users[0] ? data.users[0] : null;
}

function memoPhotoKey(trainerId, memberId, memoId, photoId) {
  // R2 오브젝트 키에 그대로 못 쓰는 문자(슬래시 등)가 섞이지 않도록 인코딩
  const safe = (s) => encodeURIComponent(s || '');
  return `memo-photos/${safe(trainerId)}/${safe(memberId)}/${safe(memoId)}/${safe(photoId)}`;
}

async function handleUploadMemoPhoto(request, env) {
  const idToken = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  const user = await verifyFirebaseToken(idToken);
  if (!user) return jsonResponse({ ok: false, error: '로그인이 필요해요.' }, 401);

  const url = new URL(request.url);
  const trainerId = url.searchParams.get('trainerId');
  const memberId = url.searchParams.get('memberId');
  const memoId = url.searchParams.get('memoId');
  if (!trainerId || !memberId || !memoId) {
    return jsonResponse({ ok: false, error: '요청이 올바르지 않아요.' }, 400);
  }

  // File 객체를 body에 그대로 스트리밍하는 방식은 카톡 인앱브라우저 같은
  // 일부 웹뷰에서 조용히 실패하는 경우가 있어서, 클라이언트가 FormData로
  // 감싸서 보냄 — 그래서 여기서도 request.formData()로 받음
  let photoFile;
  try {
    const form = await request.formData();
    photoFile = form.get('photo');
  } catch (e) {
    return jsonResponse({ ok: false, error: '사진 업로드 형식이 올바르지 않아요.' }, 400);
  }
  if (!photoFile || typeof photoFile.arrayBuffer !== 'function') {
    return jsonResponse({ ok: false, error: '사진 파일을 찾을 수 없어요.' }, 400);
  }

  const contentType = url.searchParams.get('contentType') || photoFile.type || 'image/jpeg';
  if (!contentType.startsWith('image/')) {
    return jsonResponse({ ok: false, error: '이미지 파일만 업로드할 수 있어요.' }, 400);
  }

  const body = await photoFile.arrayBuffer();
  if (body.byteLength > MEMO_PHOTO_MAX_BYTES) {
    return jsonResponse({ ok: false, error: '사진 용량이 너무 커요 (최대 5MB).' }, 400);
  }
  if (body.byteLength === 0) {
    return jsonResponse({ ok: false, error: '빈 파일이에요.' }, 400);
  }

  // 이미 몇 장 있는지 확인해서 3장 제한을 넘지 않게 함.
  // 클라이언트가 "지금 실제로 이 메모에 남아있어야 할 사진 id 목록"을
  // keepIds로 같이 보내줌 — 사진을 삭제할 때 DELETE 요청이 네트워크 문제
  // 등으로 실패하면 R2에는 그대로 남는데(고아 객체) Firestore의 photos
  // 배열에는 이미 없어서 트레이너 화면엔 안 보이는 상태가 됨. 이런 고아가
  // 쌓이면 실제 사진은 1장뿐인데도 "메모당 최대 3장" 제한에 걸려 새 사진을
  // 하나도 못 올리는 문제가 있었음. 업로드 시점마다 keepIds에 없는 R2
  // 객체는 이미 못 쓰는 고아로 보고 자동으로 정리한 뒤 개수를 셈
  const prefix = memoPhotoKey(trainerId, memberId, memoId, '');
  const existing = await env.PT_MEMO_PHOTOS.list({ prefix });
  // keepIds 파라미터 자체가 없는 요청(옛 버전 클라이언트 등)에서는 고아
  // 정리를 건너뜀 — 안 그러면 "아무것도 안 남겨야 한다"는 뜻으로 잘못
  // 해석해서 실제로 멀쩡히 쓰이고 있는 사진까지 전부 지워버릴 위험이 있음
  const hasKeepIdsParam = url.searchParams.has('keepIds');
  let survivorCount = existing.objects.length;
  if (hasKeepIdsParam) {
    const keepIds = new Set(url.searchParams.get('keepIds').split(',').map(s => s.trim()).filter(Boolean));
    const orphans = existing.objects.filter(o => !keepIds.has(o.key.slice(prefix.length)));
    if (orphans.length) {
      await Promise.all(orphans.map(o => env.PT_MEMO_PHOTOS.delete(o.key)));
    }
    survivorCount = existing.objects.length - orphans.length;
  }
  if (survivorCount >= MEMO_PHOTO_MAX_COUNT) {
    return jsonResponse({ ok: false, error: `사진은 메모 1건당 최대 ${MEMO_PHOTO_MAX_COUNT}장까지만 넣을 수 있어요.` }, 400);
  }

  const photoId = 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const key = memoPhotoKey(trainerId, memberId, memoId, photoId);
  await env.PT_MEMO_PHOTOS.put(key, body, { httpMetadata: { contentType } });

  return jsonResponse({ ok: true, photoId, url: `/api/memo-photo?key=${encodeURIComponent(key)}` });
}

async function handleGetMemoPhoto(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!key || !key.startsWith('memo-photos/')) return jsonResponse({ ok: false, error: '요청이 올바르지 않아요.' }, 400);

  const idToken = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') || url.searchParams.get('token');
  const user = await verifyFirebaseToken(idToken);
  if (!user) return jsonResponse({ ok: false, error: '로그인이 필요해요.' }, 401);

  const obj = await env.PT_MEMO_PHOTOS.get(key);
  if (!obj) return jsonResponse({ ok: false, error: '사진을 찾을 수 없어요.' }, 404);
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
      'Cache-Control': 'private, max-age=86400',
    },
  });
}

async function handleDeleteMemoPhoto(request, env) {
  const idToken = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  const user = await verifyFirebaseToken(idToken);
  if (!user) return jsonResponse({ ok: false, error: '로그인이 필요해요.' }, 401);

  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!key || !key.startsWith('memo-photos/')) return jsonResponse({ ok: false, error: '요청이 올바르지 않아요.' }, 400);

  await env.PT_MEMO_PHOTOS.delete(key);
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
    if (url.pathname === '/api/backup-now' && request.method === 'POST') {
      // 매일 자동으로 도는 것과 별개로, 필요할 때 수동으로 즉시 백업을 뜰 수
      // 있게 하는 관리자 전용 엔드포인트. 요청 본문에 관리자 PIN을 넣어야
      // 실행됨(아무나 못 부르게) — cron이 쓰는 것과 같은 PIN을 재사용
      let payload;
      try {
        payload = await request.json();
      } catch (e) {
        return jsonResponse({ ok: false, error: '요청 형식이 올바르지 않아요.' }, 400);
      }
      if (!payload.pin || payload.pin !== env.DASH_ADMIN_PIN) {
        return jsonResponse({ ok: false, error: '권한이 없어요.' }, 403);
      }
      // 배치 구조라 한 번 호출로 안 끝날 수 있음(done:false) — 그럴 땐
      // 응답의 done 값을 보고 /api/backup-continue를 반복 호출해야 함.
      // 자동 매일 백업은 5분 간격 cron이 알아서 이어서 처리함.
      const result = await runFullBackup(env);
      return jsonResponse(result, result.ok ? 200 : 500);
    }
    if (url.pathname === '/api/backup-continue' && request.method === 'POST') {
      // /api/backup-now가 done:false를 반환했을 때, 다음 배치를 이어서
      // 처리하기 위해 수동으로 반복 호출하는 엔드포인트. PIN은
      // 쿼리스트링으로 받음(스크립트에서 반복 호출하기 편하게)
      const pin = url.searchParams.get('pin');
      if (!pin || pin !== env.DASH_ADMIN_PIN) {
        return jsonResponse({ ok: false, error: '권한이 없어요.' }, 403);
      }
      const result = await runFullBackup(env);
      if (result.ok && result.done && result.key) {
        await continueOrphanSweepIfBackupDone(env, result);
      }
      return jsonResponse(result, result.ok ? 200 : 500);
    }
    if (url.pathname === '/api/orphan-sweep-continue' && request.method === 'POST') {
      // 고아 사진 정리는 항상 그날 백업이 끝난 뒤에만 진행되므로, 배치가
      // 한 번에 안 끝났을 때(done:false) 수동으로 이어서 돌리는 용도.
      // 매일 자동으로는 scheduled()가 백업 뒤에 이어서 알아서 처리함
      const pin = url.searchParams.get('pin');
      if (!pin || pin !== env.DASH_ADMIN_PIN) {
        return jsonResponse({ ok: false, error: '권한이 없어요.' }, 403);
      }
      const dateKey = new Date().toISOString().slice(0, 10);
      const backupKey = `backups/${dateKey}.json`;
      const snapshotObj = await env.PT_BACKUPS.get(backupKey);
      if (!snapshotObj) {
        return jsonResponse({ ok: false, error: '오늘치 백업이 아직 없어요. 먼저 백업을 완료해주세요.' }, 400);
      }
      const snapshot = await snapshotObj.json().catch(() => null);
      if (!snapshot) {
        return jsonResponse({ ok: false, error: '백업 스냅샷을 읽지 못했어요.' }, 500);
      }
      const result = await runOrphanSweep(env, dateKey, snapshot);
      return jsonResponse(result, result.ok ? 200 : 500);
    }
    if (url.pathname === '/api/owner-auth' && request.method === 'POST') {
      return handleOwnerAuth(request, env);
    }
    if (url.pathname === '/api/upload-memo-photo' && request.method === 'POST') {
      return handleUploadMemoPhoto(request, env);
    }
    if (url.pathname === '/api/memo-photo' && request.method === 'GET') {
      return handleGetMemoPhoto(request, env);
    }
    if (url.pathname === '/api/memo-photo' && request.method === 'DELETE') {
      return handleDeleteMemoPhoto(request, env);
    }

    // API 경로가 아니면 기존처럼 정적 파일(index.html 등)로 그대로 넘김
    return env.ASSETS.fetch(request);
  },

  // Cloudflare cron trigger가 5분마다 자동 호출함 (wrangler.jsonc의
  // triggers.crons 설정 참고). 한 번에 한 배치만 처리하고, 오늘치 백업이
  // 이미 끝나 있으면 runFullBackup이 곧바로 skip 처리해서 조용히 리턴함 —
  // 그래서 하루 종일 돌아도 실제로는 새벽에 몇 번만 의미 있게 실행됨.
  // 백업이 done:true를 반환한 틱에 이어서 고아 사진 정리도 시도함(그 전
  // 틱들은 아직 백업 중이라 스냅샷이 없으므로 자동으로 스킵됨) — 정리도
  // 배치 구조라 한 번에 안 끝나면 다음 틱들에서 이어서 마저 처리됨
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runFullBackup(env).then((backupResult) => continueOrphanSweepIfBackupDone(env, backupResult))
    );
  },
};
