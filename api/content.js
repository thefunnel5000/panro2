// 판로비서2 — 콘텐츠 스튜디오 초안 저장·조회
// GET  /api/content?bizno=1234567891        → 저장된 초안 목록
// POST /api/content  {bizno, kind, title, text}
//
// 저장 대상은 이용자가 만든 홍보 초안이며, 기업(사업자번호) 단위로 묶인다.
// 이용자 식별 정보(IP·세션)는 저장하지 않는다.
import { putContent, getContents, KV_ON } from "./_store.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    const bizno = String(req.query.bizno || "").replace(/\D/g, "");
    if (!/^\d{10}$/.test(bizno)) return res.status(400).json({ ok: false, error: "invalid bizno" });
    const list = await getContents(bizno);
    return res.status(200).json({ ok: true, persistent: KV_ON, count: list.length, contents: list });
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};
    const bizno = String(body.bizno || "").replace(/\D/g, "");
    if (!/^\d{10}$/.test(bizno)) return res.status(400).json({ ok: false, error: "invalid bizno" });
    if (!body.kind || !body.text) return res.status(400).json({ ok: false, error: "kind and text required" });
    const list = await putContent(bizno, { kind: String(body.kind).slice(0, 24), title: String(body.title || "").slice(0, 60), text: body.text });
    return res.status(200).json({ ok: true, persistent: KV_ON, count: list.length, contents: list });
  }

  return res.status(405).json({ ok: false, error: "method not allowed" });
}
