// 판로비서2 — 공공데이터 통합 조회 (Vercel Serverless Function)
// GET /api/onboard?bizno=1234567891   — 사업자번호 통합 조회
// GET /api/onboard?q=상호            — 회사명으로 국민연금 사업장 검색(사업자번호를 모를 때)
// GET /api/onboard?q=상호&seq=12345  — 선택한 사업장의 업종·가입자수 상세
// 국세청(상태) + 공정위(통신판매 상세) + 국민연금(가입 사업장) + 금융위(기업개요·요약재무)
// 키는 서버측에서만 사용 — 브라우저에 노출되지 않음. 운영 시 Vercel 환경변수 DATA_GO_KR_KEY 권장.
import { getProfile, putProfile, isStale, KV_ON } from "./_store.js";

// 인증키는 이미 URL 인코딩된 문자열이다 — 재인코딩 금지.
// 공공데이터포털은 활용신청 건별로 일일 트래픽 한도를 따로 두므로, 키를 여러 개 등록하면
// 하나가 한도(코드 -5)에 걸려도 다음 키로 넘어가 조회가 이어진다.
const KEYS = [
  process.env.DATA_GO_KR_KEY,
  process.env.DATA_GO_KR_KEY2,
  process.env.DATA_GO_KR_KEY3,
  "MZOTX%2F4lAoLBnPvsfQfJjM0WKA9QJEc4WRAhVia02TuSTz7smlRWDdHizOC1VqD9b%2FC6%2FzdWFNjrxLrtzixo8g%3D%3D"
].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
const KEY = KEYS[0];

async function j(url, opt = {}, ms = 4500) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { ...opt, signal: c.signal });
    const text = await r.text();
    try { return JSON.parse(text); } catch { return { __xml: text }; }
  } catch (e) { return null; }
  finally { clearTimeout(t); }
}
const items = d => {
  if (d?.__xml) { // data.go.kr XML 응답 폴백 파서
    const out = [];
    for (const m of d.__xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const o = {};
      for (const f of m[1].matchAll(/<(\w+)>([\s\S]*?)<\/\1>/g)) o[f[1]] = f[2];
      out.push(o);
    }
    return out;
  }
  const it = d?.response?.body?.items?.item ?? d?.items ?? null;
  return it == null ? [] : Array.isArray(it) ? it : [it];
};

// ── 회사명 검색 (사업자번호를 모르는 이용자용)
// 국민연금 가입 사업장 목록을 사업장명으로 조회한다. 파라미터명이 스펙에 따라 다를 수 있어
// 여러 후보를 순차 시도하고, 전부 실패하면 빈 배열을 돌려준다(프론트는 이 경우 조용히 숨김).
async function searchWorkplaces(q) {
  const enc = encodeURIComponent(q);
  const bases = [
    `wkplNm=${enc}`,
    `wkpl_nm=${enc}`,
    `wkpl_nm_encoded=${enc}`
  ];
  for (const qs of bases) {
    const r = await j(`https://apis.data.go.kr/B552015/NpsBplcInfoInqireServiceV2/getBassInfoSearchV2?serviceKey=${KEY}&${qs}&_type=json&numOfRows=20&pageNo=1`, {}, 6000);
    const list = items(r);
    if (list.length) {
      const hit = list.filter(x => String(x.wkplNm || "").includes(q));
      const use = (hit.length ? hit : list).slice(0, 8);
      return use.map(x => ({
        seq: x.seq ?? null,
        name: x.wkplNm || null,
        addr: x.wkplRoadNmDtlAddr || null,
        cnt: x.jnngpCnt ?? null,
        ym: x.dataCrtYm || null
      }));
    }
  }
  return [];
}

export default async function handler(req, res) {
  // 회사명 검색 모드
  const q = String(req.query.q || "").trim();
  if (q) {
    if (q.length < 2) return res.status(400).json({ ok: false, error: "query too short" });
    let list = [];
    try { list = await searchWorkplaces(q); } catch (e) { list = []; }
    // 선택한 사업장의 업종·가입자수 상세 (seq 지정 시)
    let detail = null;
    const seq = String(req.query.seq || "").replace(/\D/g, "");
    if (seq) {
      const det = await j(`https://apis.data.go.kr/B552015/NpsBplcInfoInqireServiceV2/getDetailInfoSearchV2?serviceKey=${KEY}&seq=${seq}&_type=json`, {}, 6000);
      const d0 = items(det)[0] || {};
      if (d0 && Object.keys(d0).length) {
        detail = { cnt: d0.jnngpCnt ?? null, sector: d0.vldtVlKrnNm || null, adptDt: d0.adptDt || null, addr: d0.wkplRoadNmDtlAddr || null };
      }
    }
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate");
    return res.status(200).json({ ok: true, mode: "name", q, companies: list, detail, persistent: KV_ON, fetchedAt: new Date().toISOString() });
  }

  const bizno = String(req.query.bizno || "").replace(/\D/g, "");
  if (!/^\d{10}$/.test(bizno)) return res.status(400).json({ ok: false, error: "invalid bizno" });

  // ── 1. 국세청 사업자 상태 (POST) — 인코딩 키 → 실패 시 디코딩 키 재시도
  const ntsOpt = {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", Accept: "application/json", "User-Agent": "panro2/1.0" },
    body: JSON.stringify({ b_no: [bizno] })
  };
  // 실측상 Authorization: Infuser 헤더 방식이 가장 안정적이므로 이것을 1순위로 둔다.
  // 함수 전체 제한이 10초라 재시도 타임아웃 합이 그 안에 들어와야 한다 (3.2s × 3 ≈ 9.6s).
  // 국세청 odcloud: Authorization: Infuser 헤더 방식이 실측상 가장 안정적이다.
  // 응답이 느려 넉넉한 타임아웃이 필요하고(3.2초에서는 타임아웃), 키가 일일 한도에 걸리면
  // 문서에 없는 code -5를 돌려주므로 그때는 다음 키로 재시도한다.
  const ntsTry = async (key, ms) => {
    const hdrOpt = { ...ntsOpt, headers: { ...ntsOpt.headers, Authorization: `Infuser ${decodeURIComponent(key)}` } };
    const r = await j(`https://api.odcloud.kr/api/nts-businessman/v1/status?returnType=JSON`, hdrOpt, ms);
    return r?.data ? r : null;
  };
  const ntsP = (async () => {
    const budget = 11000;                       // 함수 제한 15초 안에서 국세청에 쓸 총 예산
    const per = Math.floor(budget / Math.min(KEYS.length, 3));
    const notes = [];
    for (let i = 0; i < Math.min(KEYS.length, 3); i++) {
      const r = await ntsTry(KEYS[i], per);
      if (r) { globalThis.__ntsKey = i; return r; }
      notes.push(`key${i}: no data`);
    }
    // 헤더 방식이 전부 실패하면 쿼리 방식으로 마지막 한 번
    globalThis.__nts1 = notes.join(' / ');
    const q = await j(`https://api.odcloud.kr/api/nts-businessman/v1/status?serviceKey=${KEY}&returnType=JSON`, ntsOpt, 2500);
    globalThis.__nts2 = q?.data ? 'query ok' : (q?.__xml || JSON.stringify(q || {})).slice(0, 160);
    return q;
  })();

  // ── 2. 공정위 통신판매 등록상세 (pageNo/numOfRows 필수)
  const ftcP = j(`https://apis.data.go.kr/1130000/MllBsDtl_3Service/getMllBsInfoDetail_3?serviceKey=${KEY}&brno=${bizno}&pageNo=1&numOfRows=10&resultType=json`);

  // ── 3. 국민연금 (camelCase 파라미터, 2단계: 기본 → 상세)
  const npsP = (async () => {
    let base = await j(`https://apis.data.go.kr/B552015/NpsBplcInfoInqireServiceV2/getBassInfoSearchV2?serviceKey=${KEY}&bzowrRgstNo=${bizno.slice(0, 6)}&_type=json&numOfRows=100&pageNo=1`);
    let list = items(base);
    if (!list.length) {
      base = await j(`https://apis.data.go.kr/B552015/NpsBplcInfoInqireServiceV2/getBassInfoSearchV2?serviceKey=${KEY}&bzowrRgstNo=${bizno}&_type=json&numOfRows=100&pageNo=1`);
      list = items(base);
    }
    if (req.query.debug) globalThis.__npsRaw = (base?.__xml || JSON.stringify(base||{})).slice(0,400);
    if (!list.length) return { status: "NONE", __list: [] };
    list.sort((a, b) => String(b.dataCrtYm || "").localeCompare(String(a.dataCrtYm || "")));
    globalThis.__npsList = list;
    const top = list[0];
    const det = top.seq != null
      ? await j(`https://apis.data.go.kr/B552015/NpsBplcInfoInqireServiceV2/getDetailInfoSearchV2?serviceKey=${KEY}&seq=${top.seq}&_type=json`)
      : null;
    const d0 = items(det)[0] || {};
    return {
      status: "LIVE",
      name: top.wkplNm || null,
      cnt: d0.jnngpCnt ?? top.jnngpCnt ?? null,
      sector: d0.vldtVlKrnNm || null,
      adptDt: d0.adptDt || null,
      addr: top.wkplRoadNmDtlAddr || top.wkplJnngStcd || null,
      ym: top.dataCrtYm || null
    };
  })();

  const [nts, ftc] = await Promise.all([ntsP, ftcP]);
  const ntsRow = nts?.data?.[0] || null;
  const ftcRow = items(ftc)[0] || null;

  // ── 4. 금융위 (공정위 crno 의존 체인)
  let fsc = { status: "NONE" };
  const crno = ftcRow?.crno || null;
  if (crno) {
    const [outline, fin25, fin24] = await Promise.all([
      j(`https://apis.data.go.kr/1160100/service/GetCorpBasicInfoService_V2/getCorpOutline_V2?serviceKey=${KEY}&crno=${crno}&resultType=json&numOfRows=10&pageNo=1`),
      j(`https://apis.data.go.kr/1160100/service/GetFinaStatInfoService_V2/getSummFinaStat_V2?serviceKey=${KEY}&crno=${crno}&bizYear=2025&resultType=json&numOfRows=10&pageNo=1`),
      j(`https://apis.data.go.kr/1160100/service/GetFinaStatInfoService_V2/getSummFinaStat_V2?serviceKey=${KEY}&crno=${crno}&bizYear=2024&resultType=json&numOfRows=10&pageNo=1`)
    ]);
    const o = items(outline)[0] || null;
    const f = items(fin25)[0] || items(fin24)[0] || null;
    fsc = {
      status: o || f ? "LIVE" : "NONE",
      corpNm: o?.corpNm || null, ceo: o?.enpRprFnm || null, enpEstbDt: o?.enpEstbDt || null,
      disclosed: !!f,
      bizYear: f?.bizYear || null,
      sales: f?.enpSaleAmt ?? null, opInc: f?.enpBzopPft ?? null, asset: f?.enpTastAmt ?? null
    };
  }
  let nps = await npsP;

  // ftc 상호와 대조해 6자리 프리픽스 동명이인 사업장 교정
  const hint = (ftcRow?.bzmnNm || "").replace(/[^가-힣A-Za-z]/g, "").slice(0, 4);
  if (hint && Array.isArray(globalThis.__npsList)) {
    const better = globalThis.__npsList.find(x => String(x.wkplNm || "").replace(/[^가-힣A-Za-z]/g, "").includes(hint));
    if (better && nps?.name !== better.wkplNm) {
      const det2 = better.seq != null ? await j(`https://apis.data.go.kr/B552015/NpsBplcInfoInqireServiceV2/getDetailInfoSearchV2?serviceKey=${KEY}&seq=${better.seq}&_type=json`) : null;
      const d2 = items(det2)[0] || {};
      nps = { status: "LIVE", name: better.wkplNm || null, cnt: d2.jnngpCnt ?? better.jnngpCnt ?? null,
              sector: d2.vldtVlKrnNm || null, adptDt: d2.adptDt || null, addr: better.wkplRoadNmDtlAddr || null, ym: better.dataCrtYm || null };
    }
  }
  res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate"); // 24h 캐시
  const dbg = req.query.debug ? { keys: KEYS.length, usedKey: globalThis.__ntsKey ?? null, npsRaw: globalThis.__npsRaw || null, nts1: globalThis.__nts1 || null, nts2: globalThis.__nts2 || null } : undefined;

  // ── 5. 조회 결과 축적 (공개 공공데이터만 보관, 이용자 식별 정보는 저장하지 않음)
  const name = ftcRow?.bzmnNm || nps?.name || fsc?.corpNm || null;
  const RG = [["서울","서울시"],["부산","부산시"],["대구","대구시"],["인천","인천시"],["광주","광주시"],["대전","대전시"],
    ["울산","울산시"],["세종","세종시"],["경기","경기도"],["강원","강원특별자치도"],["충북","충청북도"],["충남","충청남도"],
    ["전북","전북특별자치도"],["전남","전라남도"],["경북","경상북도"],["경남","경상남도"],["제주","제주특별자치도"]];
  const addrTxt = ftcRow?.lctnAddr || ftcRow?.rdnmAddr || nps?.addr || "";
  let stored = null;
  if (name) {
    try {
      stored = await putProfile(bizno, {
        name,
        sector: nps?.sector || ftcRow?.ntslPrdlstCn || null,
        region: (RG.find(([k]) => addrTxt.includes(k)) || [])[1] || null,
        emp: nps?.cnt ?? null,
        sales: fsc?.sales ?? null,
        status: ntsRow?.b_stt || null,
        payload: { addr: addrTxt || null, taxType: ntsRow?.tax_type || null, crno: crno || null,
                   bizYear: fsc?.bizYear || null, opInc: fsc?.opInc ?? null, dclrDate: ftcRow?.dclrDate || null }
      });
    } catch (e) { stored = null; }
  }

  // 국세청이 한도·장애로 실패했고 예전에 성공한 기록이 있으면 그 값을 '저장된 값'으로 표시한다.
  // (새로 조회한 값처럼 보이지 않도록 cached 표시를 함께 내려보낸다)
  let ntsOut = ntsRow
    ? { status: "LIVE", b_stt: ntsRow.b_stt || null, b_stt_cd: ntsRow.b_stt_cd || null, tax_type: ntsRow.tax_type || null, end_dt: ntsRow.end_dt || null }
    : { status: "FAIL" };
  if (!ntsRow) {
    const prevRec = await getProfile(bizno);
    if (prevRec?.status) {
      ntsOut = { status: "CACHED", b_stt: prevRec.status, b_stt_cd: null,
                 tax_type: prevRec.payload?.taxType || null, cachedAt: prevRec.updatedAt || null };
    }
  }

  res.status(200).json({
    ok: true, bizno, dbg,
    store: { persistent: KV_ON, hits: stored?.hits || 1, firstSeen: stored?.firstSeen || null, updatedAt: stored?.updatedAt || null },
    registered: !!(ntsRow && ntsRow.b_stt_cd && ntsRow.b_stt_cd !== ""),
    nts: ntsOut,
    ftc: ftcRow ? {
      status: "LIVE", name: ftcRow.bzmnNm || null, crno: ftcRow.crno || null,
      addr: ftcRow.lctnAddr || ftcRow.rdnmAddr || null, mailNo: ftcRow.prmmiMnno || null,
      items: ftcRow.ntslPrdlstCn || null, dclrDate: ftcRow.dclrDate || null,
      oper: ftcRow.operSttusCdNm || null, domain: ftcRow.domnCn || null, method: ftcRow.ntslMthdNm || null
    } : { status: "NONE" },
    nps, fsc,
    fetchedAt: new Date().toISOString()
  });
}
