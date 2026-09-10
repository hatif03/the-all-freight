from __future__ import annotations

import datetime as dt

from sqlalchemy import BigInteger, Boolean, Date, DateTime, Float, ForeignKey, Index, JSON, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


class Vessel(Base):
    __tablename__ = "vessels"

    mmsi: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    imo: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    dim_a: Mapped[int | None] = mapped_column(nullable=True)
    dim_b: Mapped[int | None] = mapped_column(nullable=True)
    dim_c: Mapped[int | None] = mapped_column(nullable=True)
    dim_d: Mapped[int | None] = mapped_column(nullable=True)
    last_lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    last_lon: Mapped[float | None] = mapped_column(Float, nullable=True)
    last_sog: Mapped[float | None] = mapped_column(Float, nullable=True)
    last_cog: Mapped[float | None] = mapped_column(Float, nullable=True)
    last_nav_status: Mapped[str | None] = mapped_column(String(100), nullable=True)
    destination: Mapped[str | None] = mapped_column(String(255), nullable=True)
    eta: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    source: Mapped[str] = mapped_column(String(32), default="live", nullable=False)
    captured_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
        onupdate=utcnow,
        nullable=False,
    )

    position_reports: Mapped[list[PositionReport]] = relationship(back_populates="vessel")
    disruption_events: Mapped[list[DisruptionEvent]] = relationship(back_populates="vessel")


class PositionReport(Base):
    __tablename__ = "position_reports"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    mmsi: Mapped[int] = mapped_column(BigInteger, ForeignKey("vessels.mmsi"), nullable=False, index=True)
    lat: Mapped[float] = mapped_column(Float, nullable=False)
    lon: Mapped[float] = mapped_column(Float, nullable=False)
    sog: Mapped[float | None] = mapped_column(Float, nullable=True)
    cog: Mapped[float | None] = mapped_column(Float, nullable=True)
    nav_status: Mapped[str | None] = mapped_column(String(100), nullable=True)
    ts: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    source: Mapped[str] = mapped_column(String(32), nullable=False)
    source_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    captured_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    vessel: Mapped[Vessel] = relationship(back_populates="position_reports")


class BolRecord(Base):
    __tablename__ = "bol_records"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    bol_ref: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    importer_name: Mapped[str] = mapped_column(String(512), nullable=False, index=True)
    consignee_name: Mapped[str | None] = mapped_column(String(512), nullable=True)
    shipper_name: Mapped[str | None] = mapped_column(String(512), nullable=True)
    cargo_desc: Mapped[str | None] = mapped_column(Text, nullable=True)
    vessel_name: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    voyage: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    carrier: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    container_number: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    arrival_port: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    foreign_port: Mapped[str | None] = mapped_column(String(255), nullable=True)
    arrival_date: Mapped[dt.date | None] = mapped_column(Date, nullable=True, index=True)
    lane_key: Mapped[str | None] = mapped_column(String(512), nullable=True, index=True)
    manifest_confidential: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    source: Mapped[str] = mapped_column(String(64), nullable=False)
    source_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    captured_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    raw_payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class BolLaneImporterIndex(Base):
    __tablename__ = "bol_lane_importer_index"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    importer_name: Mapped[str] = mapped_column(String(512), nullable=False, index=True)
    vessel_name: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    carrier: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    arrival_port: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    foreign_port: Mapped[str | None] = mapped_column(String(255), nullable=True)
    lane_key: Mapped[str | None] = mapped_column(String(512), nullable=True, index=True)
    shipment_count: Mapped[int] = mapped_column(default=0, nullable=False)
    first_arrival_date: Mapped[dt.date | None] = mapped_column(Date, nullable=True)
    last_arrival_date: Mapped[dt.date | None] = mapped_column(Date, nullable=True)
    sample_bol_ref: Mapped[str | None] = mapped_column(String(128), nullable=True)
    source: Mapped[str] = mapped_column(String(64), nullable=False)
    basis: Mapped[str] = mapped_column(Text, nullable=False)
    captured_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class DisruptionEvent(Base):
    __tablename__ = "disruption_events"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    mmsi: Mapped[int] = mapped_column(BigInteger, ForeignKey("vessels.mmsi"), nullable=False, index=True)
    port: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    type: Mapped[str] = mapped_column(String(100), nullable=False)
    severity: Mapped[str] = mapped_column(String(50), nullable=False)
    detected_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    source: Mapped[str] = mapped_column(String(32), nullable=False)
    source_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    basis: Mapped[str | None] = mapped_column(Text, nullable=True)
    captured_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    vessel: Mapped[Vessel] = relationship(back_populates="disruption_events")
    affected_parties: Mapped[list[AffectedParty]] = relationship(back_populates="event")
    incidents: Mapped[list[Incident]] = relationship(back_populates="event")


class AffectedParty(Base):
    __tablename__ = "affected_parties"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    event_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("disruption_events.id"), nullable=False, index=True)
    importer_name: Mapped[str] = mapped_column(String(512), nullable=False, index=True)
    cargo_desc: Mapped[str | None] = mapped_column(Text, nullable=True)
    bol_ref: Mapped[str | None] = mapped_column(String(128), nullable=True)
    inferred: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    basis: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str] = mapped_column(String(64), nullable=False)
    source_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    captured_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    event: Mapped[DisruptionEvent] = relationship(back_populates="affected_parties")


class TariffRate(Base):
    __tablename__ = "tariff_rates"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    carrier: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    port: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    equipment: Mapped[str] = mapped_column(String(100), nullable=False)
    per_day_rate: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False)
    free_days: Mapped[int] = mapped_column(nullable=False)
    tier: Mapped[str | None] = mapped_column(String(100), nullable=True)
    source_url: Mapped[str] = mapped_column(Text, nullable=False)
    captured_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class Incident(Base):
    __tablename__ = "incidents"

    # No separate external room id: this repo self-hosts the coordination room
    # (Postgres + Redis, see agents/room_bus), so the room *is* the incident —
    # `incident.id` doubles as the room id everywhere (Participant.room_id,
    # RecoveryOption.room_id, RoomMessage.room_id, ... all FK here).
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    event_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("disruption_events.id"), nullable=False, index=True)
    phase: Mapped[str] = mapped_column(String(100), default="detected", nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    event: Mapped[DisruptionEvent] = relationship(back_populates="incidents")
    participants: Mapped[list[Participant]] = relationship(back_populates="incident")
    options: Mapped[list[RecoveryOption]] = relationship(back_populates="incident")
    votes: Mapped[list[Vote]] = relationship(back_populates="incident")
    dissents: Mapped[list[Dissent]] = relationship(back_populates="incident")
    decisions: Mapped[list[Decision]] = relationship(back_populates="incident")
    dossiers: Mapped[list[Dossier]] = relationship(back_populates="incident")
    messages: Mapped[list[RoomMessage]] = relationship(back_populates="incident")
    shipment_links: Mapped[list[ShipmentIncidentLink]] = relationship(back_populates="incident")


class TrackedShipment(Base):
    """A planned shipment the user chose to keep watching.

    This is the object that joins the two halves of the product: it's created
    from a planning-flow analysis and it's what incidents get attributed to.
    The `AnalysisResult` that produced it is stored verbatim in `analysis` so
    the dashboard can be re-rendered after a refresh; the columns above it are
    the only fields anything lists or matches on, which is why `GET /shipments`
    can avoid selecting the blob at all.
    """

    __tablename__ = "tracked_shipments"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    product: Mapped[str] = mapped_column(String(512), nullable=False)
    origin: Mapped[str] = mapped_column(String(255), nullable=False)
    destination: Mapped[str] = mapped_column(String(255), nullable=False)
    ship_date: Mapped[str | None] = mapped_column(String(64), nullable=True)
    mode: Mapped[str | None] = mapped_column(String(64), nullable=True)
    risk_score: Mapped[int] = mapped_column(default=0, nullable=False)

    # The entry port as the analysis recommended it, verbatim, for display.
    entry_port: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Resolved monitored-port code (ports.PORTS_BY_CODE), or NULL when this lane
    # touches no AIS-monitored port. NULL can never match an incident, which is
    # the honest outcome for most lanes — only three ports are watched.
    port_code: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    port_match_field: Mapped[str | None] = mapped_column(String(32), nullable=True)
    port_match_basis: Mapped[str | None] = mapped_column(Text, nullable=True)

    analysis: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    incident_links: Mapped[list[ShipmentIncidentLink]] = relationship(
        back_populates="shipment",
        cascade="all, delete-orphan",
    )


class ShipmentIncidentLink(Base):
    """Why a tracked shipment is shown against an incident.

    A link table rather than a FK on the incident, because an incident is
    discovered independently of any shipment and matches 0..N of them, while a
    shipment accumulates incidents over its life. It also gives every
    attribution somewhere to record its own `basis` — mirroring the
    `AffectedParty` convention, and required by the no-fabricated-data rule: a
    shipment is never shown as touched by an incident without a defensible,
    stored reason.
    """

    __tablename__ = "shipment_incident_links"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    shipment_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("tracked_shipments.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    incident_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("incidents.id"), nullable=False, index=True)
    match_type: Mapped[str] = mapped_column(String(32), nullable=False)
    inferred: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    basis: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    shipment: Mapped[TrackedShipment] = relationship(back_populates="incident_links")
    incident: Mapped[Incident] = relationship(back_populates="shipment_links")


class AnakinMonitor(Base):
    """A scheduled page-change monitor registered with Anakin.

    Keyed by `url` rather than by shipment: monitors cost credits on every
    check, so N shipments routing through the same port share one monitor
    instead of each registering their own. `ShipmentMonitorLink` records who
    cares about it, and a monitor is only deregistered once nobody does.
    """

    __tablename__ = "anakin_monitors"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    anakin_monitor_id: Mapped[str] = mapped_column(String(128), nullable=False, unique=True)
    url: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    label: Mapped[str] = mapped_column(String(255), nullable=False)
    port_code: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    interval_minutes: Mapped[int] = mapped_column(nullable=False)
    # Anakin HMAC-signs webhook deliveries with this; without it a delivery
    # can't be distinguished from anyone POSTing at the public endpoint.
    webhook_secret: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    signals: Mapped[list[MonitorSignal]] = relationship(back_populates="monitor", cascade="all, delete-orphan")
    shipment_links: Mapped[list[ShipmentMonitorLink]] = relationship(
        back_populates="monitor", cascade="all, delete-orphan"
    )


class ShipmentMonitorLink(Base):
    __tablename__ = "shipment_monitor_links"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    shipment_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("tracked_shipments.id", ondelete="CASCADE"), nullable=False, index=True
    )
    monitor_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("anakin_monitors.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    monitor: Mapped[AnakinMonitor] = relationship(back_populates="shipment_links")


class MonitorSignal(Base):
    """A detected change on a monitored page.

    Deliberately NOT a DisruptionEvent: that table requires a real vessel MMSI,
    so recording a tariff-page edit as one would fabricate a vessel disruption.
    Web signals are their own class of evidence and are surfaced as such.

    Attached to the monitor rather than to a shipment, because one page change
    is one event — every shipment watching that URL sees the same signal.
    """

    __tablename__ = "monitor_signals"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    monitor_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("anakin_monitors.id", ondelete="CASCADE"), nullable=False, index=True
    )
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    changed: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    source_url: Mapped[str] = mapped_column(Text, nullable=False)
    detected_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False, index=True
    )
    raw: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    monitor: Mapped[AnakinMonitor] = relationship(back_populates="signals")


class Participant(Base):
    __tablename__ = "participants"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    room_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("incidents.id"), nullable=False, index=True)
    agent_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    role: Mapped[str] = mapped_column(String(100), nullable=False)
    framework: Mapped[str | None] = mapped_column(String(100), nullable=True)
    joined_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(50), default="pending", nullable=False)

    incident: Mapped[Incident] = relationship(back_populates="participants")


class RecoveryOption(Base):
    __tablename__ = "options"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    room_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("incidents.id"), nullable=False, index=True)
    proposer: Mapped[str] = mapped_column(String(255), nullable=False)
    type: Mapped[str] = mapped_column(String(100), nullable=False)
    feasibility: Mapped[str] = mapped_column(String(100), nullable=False)
    eta_delta_hours: Mapped[float | None] = mapped_column(Float, nullable=True)
    cost_delta: Mapped[float | None] = mapped_column(Numeric(14, 2), nullable=True)
    risk: Mapped[str | None] = mapped_column(Text, nullable=True)
    rationale: Mapped[str | None] = mapped_column(Text, nullable=True)
    source: Mapped[str | None] = mapped_column(String(64), nullable=True)
    basis: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    incident: Mapped[Incident] = relationship(back_populates="options")
    votes: Mapped[list[Vote]] = relationship(back_populates="option")
    dissents: Mapped[list[Dissent]] = relationship(back_populates="target_option")
    decisions: Mapped[list[Decision]] = relationship(back_populates="option")


class Vote(Base):
    __tablename__ = "votes"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    room_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("incidents.id"), nullable=False, index=True)
    agent_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    option_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("options.id"), nullable=False, index=True)
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    rationale: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    incident: Mapped[Incident] = relationship(back_populates="votes")
    option: Mapped[RecoveryOption] = relationship(back_populates="votes")


class Dissent(Base):
    __tablename__ = "dissent"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    room_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("incidents.id"), nullable=False, index=True)
    target_option_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("options.id"), nullable=True, index=True)
    objection: Mapped[str | None] = mapped_column(Text, nullable=True)
    material: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    basis: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    incident: Mapped[Incident] = relationship(back_populates="dissents")
    target_option: Mapped[RecoveryOption | None] = relationship(back_populates="dissents")


class Decision(Base):
    __tablename__ = "decisions"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    room_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("incidents.id"), nullable=False, index=True)
    option_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("options.id"), nullable=True, index=True)
    human_action: Mapped[str] = mapped_column(String(100), nullable=False)
    actor: Mapped[str] = mapped_column(String(255), nullable=False)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    decided_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    incident: Mapped[Incident] = relationship(back_populates="decisions")
    option: Mapped[RecoveryOption | None] = relationship(back_populates="decisions")


class Dossier(Base):
    __tablename__ = "dossiers"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    room_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("incidents.id"), nullable=False, index=True)
    pdf_uri: Mapped[str | None] = mapped_column(Text, nullable=True)
    json_uri: Mapped[str | None] = mapped_column(Text, nullable=True)
    generated_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    source: Mapped[str | None] = mapped_column(String(64), nullable=True)

    incident: Mapped[Incident] = relationship(back_populates="dossiers")


class RoomMessage(Base):
    """Durable log for the self-hosted room bus (agents/room_bus).

    Every room_bus.send() call inserts one row here, then publishes the same
    message on the Redis `room_messages` channel for real-time fanout to the
    agent processes and the dashboard. get_context() replays this table in
    creation order.
    """

    __tablename__ = "room_messages"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    room_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("incidents.id"), nullable=False, index=True)
    sender_role: Mapped[str] = mapped_column(String(100), nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    mentions: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False, index=True)

    incident: Mapped[Incident] = relationship(back_populates="messages")


Index("ix_position_reports_mmsi_ts", PositionReport.mmsi, PositionReport.ts)
Index("ix_bol_records_vessel_voyage", BolRecord.vessel_name, BolRecord.voyage)
Index("ix_bol_records_lane_importer", BolRecord.lane_key, BolRecord.importer_name)
Index("ix_bol_lane_importer_lookup", BolLaneImporterIndex.lane_key, BolLaneImporterIndex.importer_name)
