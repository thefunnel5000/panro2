// 판로비서2 — 공공데이터 통합 조회 (Vercel Serverless Function)
// GET /api/onboard?bizno=1234567891
// 국세청(상태) + 공정위(통신판매 상세) + 국민연금(가입 사업장) + 금융위(기업개요·요약재무)
// 키는 서버측에서만 사용 — 브라우저에 노출되지 않음. 운영 시 Vercel 환경변수 DATA_GO_KR_KEY 권장.
const KEY = process.env.DATA_GO_KR_KEY ||
  "MZOTX%2F4lAoLBnPvsfQfJjM0WKA9QJEc4WRAhVia02TuSTz7smlRWDdHizOC1VqD9b%2FC6%2FzdWFNjrxLrtzixo8g%3D%3D"; // 이미 URL 인코딩된 키 — 재인코딩 금지

async function j(url, opt = {}, ms = 4500) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { ...opt, signal: c.signal });
    const text = await r.text();
    try { return JSON.parse(text); } catch { return { __raw: text.slice(0, 300) }; }
  } catch (e) { return null; }
  finally { clearTimeout(t); }
}
const items = d => {
  const it = d?.response?.body?.items?.item ?? d?.items ?? null;
  return it == null ? [] : Array.isArray(it) ? it : [it];
};

export default async function handler(req, res) {
  const bizno = String(req.query.bizno || "").replace(/\D/g, "");
  if (!/^\d{10}$/.test(bizno)) return res.status(400).json({ ok: false, error: "invalid bizno" });

  // ── 1. 국세청 사업자 상태 (POST)
  const ntsP = j(`https://api.odcloud.kr/api/nts-businessman/v1/status?serviceKey=${KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ b_no: [bizno] })
  });

  // ── 2. 공정위 통신판매 등록상세 (pageNo/numOfRows 필수)
  const ftcP = j(`https://apis.data.go.kr/1130000/MllBsDtl_3Service/getMllBsInfoDetail_3?serviceKey=${KEY}&brno=${bizno}&pageNo=1&numOfRows=10&resultType=json`);

  // ── 3. 국민연금 (camelCase 파라미터, 2단계: 기본 → 상세)
  const npsP = (async () => {
    let base = await j(`https://apis.data.go.kr/B552015/NpsBplcInfoInqireServiceV2/getBassInfoSearchV2?serviceKey=${KEY}&bzowrRgstNo=${bizno}&_type=json&numOfRows=100&pageNo=1`);
    let list = items(base);
    if (!list.length) { // 데이터셋이 앞 6자리만 공개하는 경우 대비
      base = await j(`https://apis.data.go.kr/B552015/NpsBplcInfoInqireServiceV2/getBassInfoSearchV2?serviceKey=${KEY}&bzowrRgstNo=${bizno.slice(0, 6)}&_type=json&numOfRows=100&pageNo=1`);
      list = items(base);
    }
    if (!list.length) return { status: "NONE" };
    list.sort((a, b) => String(b.dataCrtYm || "").localeCompare(String(a.dataCrtYm || "")));
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
  const nps = await npsP;

  res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate"); // 24h 캐시
  res.status(200).json({
    ok: true, bizno,
    registered: !!(ntsRow && ntsRow.b_stt_cd && ntsRow.b_stt_cd !== ""),
    nts: ntsRow ? { status: "LIVE", b_stt: ntsRow.b_stt || null, b_stt_cd: ntsRow.b_stt_cd || null, tax_type: ntsRow.tax_type || null, end_dt: ntsRow.end_dt || null } : { status: "FAIL" },
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
