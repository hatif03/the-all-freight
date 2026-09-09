"""Audit dossier generator.

Turns a resolved incident into a one-page, regulator-grade **decision record**.
Built entirely from the database (the system of record alongside the
room bus's message log), so it needs no external coordination credentials and
is reliable to regenerate at any time.

Outputs both a styled self-contained **HTML** file (print-to-PDF in any browser)
and a machine-readable **JSON** file under `data/dossiers/`, and records a
`Dossier` row. Zero extra dependencies (no reportlab/weasyprint).

Every figure carries its provenance (Live AIS / Public BoL / Published tariff /
model-generated); nothing is fabricated (constraint C1).
"""

from __future__ import annotations

import datetime as dt
import html
import json
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from models import Dossier, DisruptionEvent, Incident, utcnow

DOSSIER_DIR = Path(__file__).resolve().parent.parent / "data" / "dossiers"
MAERSK_IMPORT_TARIFF_URL = "https://www.maersk.com/local-information/united-states/import"


def _esc(value: Any) -> str:
    return html.escape("" if value is None else str(value))


def _money(value: Any) -> str:
    if value is None:
        return "—"
    try:
        return f"${float(value):,.2f}"
    except (TypeError, ValueError):
        return str(value)


async def _load_incident(session: AsyncSession, incident_id: int) -> Incident | None:
    stmt = (
        select(Incident)
        .where(Incident.id == incident_id)
        .options(
            selectinload(Incident.event).selectinload(DisruptionEvent.vessel),
            selectinload(Incident.event).selectinload(DisruptionEvent.affected_parties),
            selectinload(Incident.options),
            selectinload(Incident.participants),
            selectinload(Incident.votes),
            selectinload(Incident.dissents),
            selectinload(Incident.decisions),
        )
    )
    res = await session.execute(stmt)
    return res.scalar_one_or_none()


def _build_record(incident: Incident, generated_at: dt.datetime) -> dict[str, Any]:
    """Assemble the structured (JSON) decision record from the incident graph."""
    event = incident.event
    vessel_name = event.vessel.name if (event and event.vessel) else None

    # Quorum tally: summed confidence per option (the agents' vote).
    score_by_option: dict[int, float] = {}
    for v in incident.votes:
        score_by_option[v.option_id] = score_by_option.get(v.option_id, 0.0) + (v.confidence or 0.0)
    leading_id = max(score_by_option, key=score_by_option.get) if score_by_option else None

    dissent = incident.dissents[-1] if incident.dissents else None
    decision = incident.decisions[-1] if incident.decisions else None

    return {
        "dossier": {
            "incident_id": incident.id,
            "room_id": incident.id,
            "phase": incident.phase,
            "generated_at": generated_at.isoformat(),
        },
        "event": {
            "vessel": vessel_name,
            "mmsi": event.mmsi if event else None,
            "port": event.port if event else None,
            "type": event.type if event else None,
            "severity": event.severity if event else None,
            "detected_at": event.detected_at.isoformat() if (event and event.detected_at) else None,
            "basis": event.basis if event else None,
            "source": event.source if event else None,
        },
        "affected_importers": [
            {
                "importer_name": p.importer_name,
                "cargo_desc": p.cargo_desc,
                "bol_ref": p.bol_ref,
                "inferred": p.inferred,
                "basis": p.basis,
                "source": p.source,
                "source_url": p.source_url,
            }
            for p in (event.affected_parties if event else [])
        ],
        "options": [
            {
                "id": o.id,
                "proposer": o.proposer,
                "type": o.type,
                "feasibility": o.feasibility,
                "eta_delta_hours": o.eta_delta_hours,
                "cost_delta": float(o.cost_delta) if o.cost_delta is not None else None,
                "risk": o.risk,
                "rationale": o.rationale,
                "quorum_vote_score": round(score_by_option.get(o.id, 0.0), 3),
                "is_recommended": o.id == leading_id,
            }
            for o in incident.options
        ],
        "quorum": {
            "leading_option_id": leading_id,
            "scores": {str(k): round(v, 3) for k, v in score_by_option.items()},
            "voters": sorted({v.agent_id for v in incident.votes}),
        },
        "dissent": (
            {
                "target_option_id": dissent.target_option_id,
                "objection": dissent.objection,
                "material": dissent.material,
                "basis": dissent.basis,
            }
            if dissent
            else None
        ),
        "human_decision": (
            {
                "action": decision.human_action,
                "actor": decision.actor,
                "reason": decision.reason,
                "option_id": decision.option_id,
                "decided_at": decision.decided_at.isoformat() if decision.decided_at else None,
            }
            if decision
            else None
        ),
        "participants": [
            {"role": p.role, "framework": p.framework, "status": p.status}
            for p in incident.participants
        ],
        "provenance_note": (
            "Vessel positions: live AIS (aisstream.io). Affected importers: public U.S. "
            "Customs bills of lading (19 CFR §103.31); pre-arrival associations flagged "
            "'inferred'. D&D costs: published Maersk U.S. import demurrage tariff. Agent "
            "rationales are model-generated and labelled as such. No data is fabricated (C1)."
        ),
    }


def _feasibility_color(value: Any) -> str:
    f = str(value or "").lower()
    if f == "high":
        return "#0f9d6e"
    if f == "medium":
        return "#b8862a"
    if f == "low":
        return "#cf4646"
    return "#4a5663"


def _render_html(rec: dict[str, Any]) -> str:
    d = rec["dossier"]
    e = rec["event"]
    dec = rec["human_decision"]
    dis = rec["dissent"]

    # ---- phase chip ----
    phase = str(d["phase"] or "")
    phase_color = "#0f9d6e" if phase == "approved" else "#cf4646" if phase == "rejected" else "#7a8896"

    # ---- severity card (red-tinted for high/critical) ----
    sev = str(e["severity"] or "").lower()
    if sev in ("high", "critical"):
        sev_card = (
            'style="border:1px solid #f4d3d3; background:#fdf3f3; border-radius:10px; padding:13px 15px;"'
        )
        sev_k_color, sev_v_color = "#c97a7a", "#cf4646"
    else:
        sev_card = 'style="border:1px solid #e4e8ee; border-radius:10px; padding:13px 15px;"'
        sev_k_color, sev_v_color = "#90a0ae", "#1a2430"

    # ---- affected importers (4-col grid; basis kept as a muted sub-line) ----
    importer_rows = ""
    for i, p in enumerate(rec["affected_importers"]):
        top = "" if i == 0 else "border-top:1px solid #eceff3;"
        if p["inferred"]:
            chip = (
                '<span class="mono" style="font-size:9px; color:#b8862a; background:#fbf3e0; '
                'border:1px solid #efdcb0; padding:3px 7px; border-radius:5px; font-weight:700;">INFERRED</span>'
            )
        else:
            chip = (
                '<span class="mono" style="font-size:9px; color:#0f9d6e; background:#e7f7ef; '
                'border:1px solid #c2e8d6; padding:3px 7px; border-radius:5px; font-weight:700;">FACT</span>'
            )
        basis_line = (
            f'<div style="color:#90a0ae; font-size:11px; margin-top:5px; line-height:1.4;">Basis: {_esc(p["basis"])}</div>'
            if p["basis"]
            else ""
        )
        importer_rows += (
            f'<div style="display:grid; grid-template-columns:1.1fr 2fr 0.8fr 1.1fr; gap:0; '
            f'padding:14px 16px; align-items:start; {top}">'
            f'<div style="font-size:13px; font-weight:600;">{_esc(p["importer_name"])}</div>'
            f'<div style="font-size:12px; color:#4a5663; line-height:1.5;">{_esc(p["cargo_desc"] or "General cargo")}{basis_line}</div>'
            f'<div>{chip}</div>'
            f'<div class="mono" style="font-size:12px; color:#4a5663;">{_esc(p["bol_ref"] or "—")}</div>'
            f"</div>"
        )
    if not importer_rows:
        importer_rows = (
            '<div style="padding:14px 16px; color:#90a0ae; font-size:13px;">'
            "No affected importers resolved for this voyage.</div>"
        )

    # ---- recovery options + quorum ----
    option_rows = ""
    for i, o in enumerate(rec["options"]):
        if o["is_recommended"]:
            row_bg = "background:#f0faf5; border-top:1px solid #d6efe2;"
            quorum_cell = (
                f'<span style="font-weight:700;">{o["quorum_vote_score"]:.2f}</span> '
                '<span style="color:#0f9d6e; font-weight:700;">★</span>'
            )
        else:
            row_bg = "" if i == 0 else "border-top:1px solid #eceff3;"
            quorum_cell = f'{o["quorum_vote_score"]:.2f}'
        cost_color = "#cf4646" if str(o["feasibility"] or "").lower() == "low" else "#1a2430"
        option_rows += (
            f'<div style="display:grid; grid-template-columns:0.9fr 0.9fr 0.9fr 0.7fr 0.9fr 1.1fr; '
            f'padding:13px 16px; align-items:center; {row_bg}">'
            f'<div style="font-size:13px;">{_esc(o["proposer"])}</div>'
            f'<div style="font-size:13px; font-weight:700;">{_esc(o["type"])}</div>'
            f'<div style="font-size:13px; color:{_feasibility_color(o["feasibility"])}; font-weight:600;">{_esc(o["feasibility"])}</div>'
            f'<div class="mono" style="text-align:right; font-size:13px;">{_esc(o["eta_delta_hours"])} h</div>'
            f'<div class="mono" style="text-align:right; font-size:13px; font-weight:600; color:{cost_color};">{_money(o["cost_delta"])}</div>'
            f'<div class="mono" style="text-align:right; font-size:13px;">{quorum_cell}</div>'
            f"</div>"
        )
    if not option_rows:
        option_rows = (
            '<div style="padding:13px 16px; color:#90a0ae; font-size:13px;">'
            "No recovery options recorded.</div>"
        )

    participant_chips = " ".join(
        f'<span class="mono" style="font-size:11px; color:#4a5663; background:#f5f7f9; '
        f'border:1px solid #e4e8ee; padding:5px 11px; border-radius:7px;">{_esc(p["role"])} · {_esc(p["framework"])}</span>'
        for p in rec["participants"]
    ) or '<span style="color:#90a0ae; font-size:12px;">No participants recorded.</span>'

    dissent_block = ""
    if dis:
        material_label = "MATERIAL" if dis["material"] else "NON-MATERIAL"
        basis_line = (
            f'<div style="font-size:12px; color:#a07878; margin-top:9px;">Basis: {_esc(dis["basis"])}</div>'
            if dis["basis"]
            else ""
        )
        dissent_block = (
            '<div style="background:#fdf3f3; border:1px solid #f4d3d3; border-radius:12px; padding:18px 20px; margin-top:20px;">'
            f'<div class="mono" style="font-size:9px; letter-spacing:.14em; color:#c97a7a; font-weight:700;">RECORDED ADVERSARIAL DISSENT · {material_label}</div>'
            f'<div style="font-size:14px; color:#2a3440; margin-top:10px; line-height:1.6;">{_esc(dis["objection"])}</div>'
            f"{basis_line}</div>"
        )

    if dec:
        is_approve = str(dec["action"]).lower().startswith("approv")
        badge_color = "#0f9d6e" if is_approve else "#cf4646"
        badge_bg = "#e7f7ef" if is_approve else "#fdf3f3"
        badge_border = "#c2e8d6" if is_approve else "#f4d3d3"
        decision_block = (
            '<div style="border:1px solid #e4e8ee; border-radius:12px; padding:18px 20px;">'
            '<div style="display:flex; align-items:center; gap:10px;">'
            '<span class="mono" style="font-size:9px; letter-spacing:.1em; color:#90a0ae;">HUMAN DECISION GATE</span>'
            f'<span class="mono" style="font-size:10px; color:{badge_color}; background:{badge_bg}; '
            f'border:1px solid {badge_border}; padding:3px 9px; border-radius:5px; font-weight:700; text-transform:uppercase;">{_esc(dec["action"])}</span>'
            "</div>"
            f'<div style="font-size:15px; margin-top:11px;"><span style="font-weight:700;">{_esc(dec["actor"])}:</span> &ldquo;{_esc(dec["reason"])}&rdquo;</div>'
            f'<div class="mono" style="font-size:11px; color:#90a0ae; margin-top:8px;">option #{_esc(dec["option_id"])} · {_esc(dec["decided_at"])}</div>'
            "</div>"
        )
    else:
        decision_block = (
            '<div style="border:1px solid #e4e8ee; border-radius:12px; padding:18px 20px; color:#90a0ae; font-size:13px;">'
            "No human decision recorded yet.</div>"
        )

    detected_line = (
        f'Detected {_esc(e["detected_at"])} · {_esc(e["basis"])} '
        f'<span class="mono" style="font-size:11px; color:#90a0ae;">source: {_esc(e["source"])}</span>'
    )

    sec = (
        'font-family:\'JetBrains Mono\',ui-monospace,Menlo,monospace; font-size:10px; '
        "letter-spacing:.16em; color:#2456c8; text-transform:uppercase; font-weight:600;"
    )

    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ops Room Decision Record — Incident #{d['incident_id']}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  * {{ box-sizing:border-box; }}
  body {{ margin:0; padding:40px 20px; background:#0b0f14; color:#1a2430;
         font-family:'Hanken Grotesk',-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
         -webkit-font-smoothing:antialiased; }}
  .mono {{ font-family:'JetBrains Mono',ui-monospace,Menlo,monospace; }}
  @media print {{ body {{ background:#fff; padding:0; }} .sheet {{ box-shadow:none !important; border:none !important; }} }}
</style></head>
<body>
<div class="sheet" style="max-width:880px; margin:0 auto; background:#fbfcfd; border:1px solid #e4e8ee; border-radius:18px; padding:44px 48px; box-shadow:0 40px 90px -50px rgba(0,0,0,.85);">

  <!-- header -->
  <div style="display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid #eceff3; padding-bottom:22px; gap:16px; flex-wrap:wrap;">
    <div style="display:flex; align-items:center; gap:13px;">
      <svg width="34" height="34" viewBox="0 0 32 32" fill="none">
        <rect x="2.5" y="2.5" width="27" height="27" rx="8.5" stroke="#0f9d6e" stroke-width="2"/>
        <line x1="16" y1="11" x2="11" y2="21" stroke="#9fb3c4" stroke-width="1.6"/>
        <line x1="16" y1="11" x2="21" y2="21" stroke="#9fb3c4" stroke-width="1.6"/>
        <line x1="11" y1="21" x2="21" y2="21" stroke="#9fb3c4" stroke-width="1.6"/>
        <circle cx="16" cy="11" r="3" fill="#0f9d6e"/>
        <circle cx="11" cy="21" r="2.4" fill="#fff" stroke="#9fb3c4" stroke-width="1.6"/>
        <circle cx="21" cy="21" r="2.4" fill="#fff" stroke="#9fb3c4" stroke-width="1.6"/>
      </svg>
      <div>
        <div style="font-size:18px; font-weight:800; letter-spacing:-.02em; line-height:1.2;">Disruption Decision Record</div>
        <div class="mono" style="font-size:11px; color:#7a8896; margin-top:5px;">Ops Room · audit dossier</div>
      </div>
    </div>
    <div class="mono" style="text-align:right; font-size:11px; color:#7a8896; line-height:1.7;">
      <div>incident <span style="color:#1a2430; font-weight:600;">#{d['incident_id']}</span></div>
      <div>phase <span style="color:{phase_color}; font-weight:600;">{_esc(phase)}</span></div>
      <div>{_esc(d['generated_at'])}</div>
    </div>
  </div>

  <!-- disruption -->
  <div style="{sec} margin:26px 0 14px;">Disruption</div>
  <div style="display:grid; grid-template-columns:repeat(4,1fr); gap:12px;">
    <div style="border:1px solid #e4e8ee; border-radius:10px; padding:13px 15px;"><div class="mono" style="font-size:9px; letter-spacing:.12em; color:#90a0ae;">VESSEL</div><div style="font-size:14px; font-weight:700; margin-top:5px;">{_esc(e['vessel'] or '—')}</div></div>
    <div style="border:1px solid #e4e8ee; border-radius:10px; padding:13px 15px;"><div class="mono" style="font-size:9px; letter-spacing:.12em; color:#90a0ae;">PORT</div><div style="font-size:14px; font-weight:700; margin-top:5px;">{_esc(e['port'] or '—')}</div></div>
    <div style="border:1px solid #e4e8ee; border-radius:10px; padding:13px 15px;"><div class="mono" style="font-size:9px; letter-spacing:.12em; color:#90a0ae;">TYPE</div><div style="font-size:14px; font-weight:700; margin-top:5px;">{_esc(e['type'] or '—')}</div></div>
    <div {sev_card}><div class="mono" style="font-size:9px; letter-spacing:.12em; color:{sev_k_color};">SEVERITY</div><div style="font-size:14px; font-weight:700; margin-top:5px; color:{sev_v_color};">{_esc(e['severity'] or '—')}</div></div>
  </div>
  <div style="color:#6b7886; font-size:13px; margin-top:14px; line-height:1.6;">{detected_line}</div>

  <!-- affected importers -->
  <div style="{sec} margin:28px 0 12px;">Affected importers · bill-of-lading provenance</div>
  <div style="border:1px solid #e4e8ee; border-radius:12px; overflow:hidden;">
    <div class="mono" style="display:grid; grid-template-columns:1.1fr 2fr 0.8fr 1.1fr; gap:0; background:#f5f7f9; padding:11px 16px; font-size:9px; letter-spacing:.1em; color:#90a0ae;">
      <div>IMPORTER</div><div>CARGO</div><div>PROVENANCE</div><div>BOL</div>
    </div>
    {importer_rows}
  </div>

  <!-- recovery options -->
  <div style="{sec} margin:28px 0 12px;">Recovery options &amp; quorum vote</div>
  <div style="border:1px solid #e4e8ee; border-radius:12px; overflow:hidden;">
    <div class="mono" style="display:grid; grid-template-columns:0.9fr 0.9fr 0.9fr 0.7fr 0.9fr 1.1fr; background:#f5f7f9; padding:11px 16px; font-size:9px; letter-spacing:.08em; color:#90a0ae;">
      <div>PROPOSER</div><div>STRATEGY</div><div>FEASIBILITY</div><div style="text-align:right;">ETA Δ</div><div style="text-align:right;">D&amp;D Δ</div><div style="text-align:right;">QUORUM</div>
    </div>
    {option_rows}
  </div>

  {dissent_block}

  <!-- decision -->
  <div style="{sec} margin:26px 0 12px;">Decision</div>
  {decision_block}

  <!-- agents -->
  <div style="{sec} margin:26px 0 12px;">Collaborating agents</div>
  <div style="display:flex; gap:8px; flex-wrap:wrap;">{participant_chips}</div>

  <div style="border-top:1px solid #eceff3; margin-top:26px; padding-top:16px; font-size:11px; color:#90a0ae; line-height:1.65;">{_esc(rec['provenance_note'])}</div>
</div></body></html>"""


async def build_dossier(session: AsyncSession, incident_id: int) -> dict[str, Any] | None:
    """Generate (and persist) the dossier for an incident.

    Returns {"html", "record", "html_path", "json_path"} or None if not found.
    """
    incident = await _load_incident(session, incident_id)
    if incident is None:
        return None

    generated_at = utcnow()
    record = _build_record(incident, generated_at)
    html_doc = _render_html(record)

    DOSSIER_DIR.mkdir(parents=True, exist_ok=True)
    html_path = DOSSIER_DIR / f"incident_{incident_id}.html"
    json_path = DOSSIER_DIR / f"incident_{incident_id}.json"
    html_path.write_text(html_doc, encoding="utf-8")
    json_path.write_text(json.dumps(record, indent=2), encoding="utf-8")

    session.add(
        Dossier(
            room_id=incident.id,
            pdf_uri=str(html_path),  # HTML doc (print-to-PDF); no heavy PDF dep
            json_uri=str(json_path),
            source="db_room_record",
        )
    )
    await session.commit()

    return {
        "html": html_doc,
        "record": record,
        "html_path": str(html_path),
        "json_path": str(json_path),
    }
