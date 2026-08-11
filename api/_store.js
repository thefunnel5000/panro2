// 판로비서2 — 기업 프로필 저장소 어댑터
//
// 저장 대상은 "공공데이터 API 조회 결과"뿐이다. 이용자 식별 정보(IP·세션·검색 이력)는 저장하지 않는다.
// 국세청 사업자 상태 / 공정거래위원회 통신판매사업자 / 국민연금 가입 사업장 / 금융위원회 공시 재무는
// 모두 공개 공공데이터이며, 여기서는 재조회 부담을 줄이기 위한 캐시 겸 축적 저장소로 사용한다.
//
// 백엔드 우선순위
//   1) Upstash / Vercel KV  — 환경변수 KV_REST_API_URL + KV_REST_API_TOKEN 이 있으면 사용 (영구)
//   2) 메모리               — 없으면 인스턴스 메모리 (재배포·콜드스타트 시 소멸)
// 운영 전환은 Vercel 프로젝트에 KV를 연결하고 위 두 환경변수만 넣으면 코드 수정 없이 이뤄진다.

const URL_ = process.env.KV_REST_API_URL || null;
const TOKEN = process.env.KV_REST_API_TOKEN || null;
export const KV_ON = !!(URL_ && TOKEN);

const MEM = (globalThis.__panroMem ||= { map: new Map(), idx: [] });

const TTL = 60 * 60 * 24 * 30; // 30일 보관
export const FRESH_MS = 1000 * 60 * 60 * 24; // 24시간 지나면 갱신 대상

async function kv(cmd) {
  try {
    const r = await fetch(`${URL_}/${cmd.map(encodeURIComponent).join("/")}`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.result ?? null;
  } catch { return null; }
}
async function kvSet(key, value) {
  try {
    const r = await fetch(`${URL_}/set/${encodeURIComponent(key)}?EX=${TTL}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(value)
    });
    return r.ok;
  } catch { return false; }
}

const KEY = b => `panro:co:${b}`;
const IDX = "panro:idx";

/** 저장된 기업 프로필 조회 */
export async function getProfile(bizno) {
  if (KV_ON) {
    const raw = await kv(["get", KEY(bizno)]);
    if (!raw) return null;
    try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
  }
  return MEM.map.get(bizno) || null;
}

/** 기업 프로필 저장·갱신. 조회 횟수를 누적해 어떤 기업이 자주 찾아지는지 남긴다. */
export async function putProfile(bizno, data) {
  const prev = await getProfile(bizno);
  const rec = {
    bizno,
    name: data.name || prev?.name || null,
    sector: data.sector || prev?.sector || null,
    region: data.region || prev?.region || null,
    emp: data.emp ?? prev?.emp ?? null,
    sales: data.sales ?? prev?.sales ?? null,
    status: data.status || prev?.status || null,
    payload: data.payload || prev?.payload || null,
    hits: (prev?.hits || 0) + 1,
    firstSeen: prev?.firstSeen || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  if (KV_ON) {
    await kvSet(KEY(bizno), rec);
    try {
      await fetch(`${URL_}/zadd/${IDX}/${Date.now()}/${encodeURIComponent(bizno)}`, {
        method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }
      });
    } catch { /* 색인 실패는 조회에 영향 없음 */ }
  } else {
    MEM.map.set(bizno, rec);
    MEM.idx = [bizno, ...MEM.idx.filter(x => x !== bizno)].slice(0, 200);
  }
  return rec;
}

/** 최근 조회된 기업 목록 */
export async function listProfiles(limit = 12) {
  if (KV_ON) {
    const ids = await kv(["zrange", IDX, String(-limit), "-1", "rev"]);
    const arr = Array.isArray(ids) ? ids : [];
    const out = [];
    for (const b of arr) {
      const p = await getProfile(b);
      if (p) out.push(slim(p));
    }
    return out;
  }
  return MEM.idx.slice(0, limit).map(b => MEM.map.get(b)).filter(Boolean).map(slim);
}

/** 목록에는 요약만 내보낸다 */
function slim(p) {
  return {
    bizno: p.bizno ? p.bizno.slice(0, 3) + "-**-***" + p.bizno.slice(8) : null,
    key: p.bizno,
    name: p.name, sector: p.sector, region: p.region, emp: p.emp,
    hits: p.hits, updatedAt: p.updatedAt
  };
}

/** 저장된 값이 오래되어 다시 조회해야 하는지 */
export function isStale(rec) {
  if (!rec?.updatedAt) return true;
  return Date.now() - new Date(rec.updatedAt).getTime() > FRESH_MS;
}
