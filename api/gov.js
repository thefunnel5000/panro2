// 판로비서2 — 수출바우처·판판대로 카탈로그 API 프록시
//
// 원본: https://govdata-api-theta.vercel.app  (수출바우처 서비스 8,951건 · 판판대로 공고)
// 브라우저에서 직접 부르면 CORS·캐시 제어를 우리가 못 하므로 서버에서 중계한다.
// 인증키가 필요 없는 공개 API이며, 중계 과정에서 값을 가공하지 않는다(원문 그대로 전달).
//
// GET /api/gov?path=services&q=...&size=20
// GET /api/gov?path=services/19423
// GET /api/gov?path=notice-match&target=중소기업&open_only=1

const ORIGIN = "https://govdata-api-theta.vercel.app";

// 허용 경로 — 목록형과 상세형(:id)을 나눠 화이트리스트로 막는다.
const FLAT = new Set([
  "services", "notices", "match", "infer", "vendors",
  "notice-match", "meta", "facets", "axes", "health"
]);
const NESTED = new Set(["services", "notices"]);

export default async function handler(req, res) {
  const raw = String(req.query.path || "").replace(/^\/+|\/+$/g, "");
  if (!raw) return res.status(400).json({ ok: false, error: "path required" });

  const seg = raw.split("/");
  const ok = seg.length === 1 ? FLAT.has(seg[0])
           : seg.length === 2 ? (NESTED.has(seg[0]) && /^[\w.-]{1,40}$/.test(seg[1]))
           : false;
  if (!ok) return res.status(400).json({ ok: false, error: "path not allowed" });

  // path 를 뺀 나머지 쿼리를 그대로 넘긴다
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) {
    if (k === "path" || v == null || v === "") continue;
    if (Array.isArray(v)) v.forEach(x => qs.append(k, String(x)));
    else qs.append(k, String(v));
  }

  const url = `${ORIGIN}/api/${seg.map(encodeURIComponent).join("/")}${qs.toString() ? "?" + qs : ""}`;

  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 9000);
  try {
    const r = await fetch(url, {
      signal: c.signal,
      headers: { Accept: "application/json", "User-Agent": "panro2/1.0" }
    });
    const text = await r.text();
    // 카탈로그는 하루 단위로 갱신되므로 엣지 캐시를 길게 잡는다.
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(r.status).send(text);
  } catch (e) {
    return res.status(200).json({ ok: false, error: "upstream unavailable", path: raw });
  } finally { clearTimeout(t); }
}
