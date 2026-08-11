// 판로비서2 — 저장된 기업 프로필 조회
// GET /api/profile              → 최근 조회된 기업 목록(요약)
// GET /api/profile?bizno=...    → 특정 기업의 저장된 프로필
//
// 저장되는 값은 공공데이터 API 조회 결과뿐이며, 이용자 식별 정보는 저장하지 않는다.
import { getProfile, listProfiles, isStale, KV_ON } from "./_store.js";

export default async function handler(req, res) {
  const bizno = String(req.query.bizno || "").replace(/\D/g, "");
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate");

  if (bizno) {
    if (!/^\d{10}$/.test(bizno)) return res.status(400).json({ ok: false, error: "invalid bizno" });
    const rec = await getProfile(bizno);
    if (!rec) return res.status(200).json({ ok: true, found: false, persistent: KV_ON });
    return res.status(200).json({ ok: true, found: true, persistent: KV_ON, stale: isStale(rec), profile: rec });
  }

  const limit = Math.min(30, Math.max(1, parseInt(req.query.limit, 10) || 12));
  const list = await listProfiles(limit);
  return res.status(200).json({ ok: true, persistent: KV_ON, count: list.length, companies: list });
}
