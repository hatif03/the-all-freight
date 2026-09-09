"""Initial ops-room schema.

Revision ID: 20260615_0001
Revises:
Create Date: 2026-06-15 00:00:00
"""

from alembic import op
import sqlalchemy as sa

revision = "20260615_0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "vessels",
        sa.Column("mmsi", sa.BigInteger(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=True),
        sa.Column("type", sa.String(length=100), nullable=True),
        sa.Column("imo", sa.String(length=32), nullable=True),
        sa.Column("dim_a", sa.Integer(), nullable=True),
        sa.Column("dim_b", sa.Integer(), nullable=True),
        sa.Column("dim_c", sa.Integer(), nullable=True),
        sa.Column("dim_d", sa.Integer(), nullable=True),
        sa.Column("last_lat", sa.Float(), nullable=True),
        sa.Column("last_lon", sa.Float(), nullable=True),
        sa.Column("last_sog", sa.Float(), nullable=True),
        sa.Column("last_cog", sa.Float(), nullable=True),
        sa.Column("last_nav_status", sa.String(length=100), nullable=True),
        sa.Column("destination", sa.String(length=255), nullable=True),
        sa.Column("eta", sa.DateTime(timezone=True), nullable=True),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("mmsi"),
    )
    op.create_index(op.f("ix_vessels_imo"), "vessels", ["imo"], unique=False)

    op.create_table(
        "bol_records",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("bol_ref", sa.String(length=128), nullable=True),
        sa.Column("importer_name", sa.String(length=512), nullable=False),
        sa.Column("consignee_name", sa.String(length=512), nullable=True),
        sa.Column("shipper_name", sa.String(length=512), nullable=True),
        sa.Column("cargo_desc", sa.Text(), nullable=True),
        sa.Column("vessel_name", sa.String(length=255), nullable=True),
        sa.Column("voyage", sa.String(length=128), nullable=True),
        sa.Column("carrier", sa.String(length=255), nullable=True),
        sa.Column("container_number", sa.String(length=64), nullable=True),
        sa.Column("arrival_port", sa.String(length=255), nullable=True),
        sa.Column("foreign_port", sa.String(length=255), nullable=True),
        sa.Column("arrival_date", sa.Date(), nullable=True),
        sa.Column("lane_key", sa.String(length=512), nullable=True),
        sa.Column("manifest_confidential", sa.Boolean(), nullable=False),
        sa.Column("source", sa.String(length=64), nullable=False),
        sa.Column("source_url", sa.Text(), nullable=True),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("raw_payload", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_bol_records_arrival_date"), "bol_records", ["arrival_date"], unique=False)
    op.create_index(op.f("ix_bol_records_arrival_port"), "bol_records", ["arrival_port"], unique=False)
    op.create_index(op.f("ix_bol_records_bol_ref"), "bol_records", ["bol_ref"], unique=False)
    op.create_index(op.f("ix_bol_records_carrier"), "bol_records", ["carrier"], unique=False)
    op.create_index(op.f("ix_bol_records_container_number"), "bol_records", ["container_number"], unique=False)
    op.create_index(op.f("ix_bol_records_importer_name"), "bol_records", ["importer_name"], unique=False)
    op.create_index(op.f("ix_bol_records_lane_importer"), "bol_records", ["lane_key", "importer_name"], unique=False)
    op.create_index(op.f("ix_bol_records_lane_key"), "bol_records", ["lane_key"], unique=False)
    op.create_index(op.f("ix_bol_records_vessel_name"), "bol_records", ["vessel_name"], unique=False)
    op.create_index(op.f("ix_bol_records_vessel_voyage"), "bol_records", ["vessel_name", "voyage"], unique=False)
    op.create_index(op.f("ix_bol_records_voyage"), "bol_records", ["voyage"], unique=False)

    op.create_table(
        "bol_lane_importer_index",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("importer_name", sa.String(length=512), nullable=False),
        sa.Column("vessel_name", sa.String(length=255), nullable=True),
        sa.Column("carrier", sa.String(length=255), nullable=True),
        sa.Column("arrival_port", sa.String(length=255), nullable=True),
        sa.Column("foreign_port", sa.String(length=255), nullable=True),
        sa.Column("lane_key", sa.String(length=512), nullable=True),
        sa.Column("shipment_count", sa.Integer(), nullable=False),
        sa.Column("first_arrival_date", sa.Date(), nullable=True),
        sa.Column("last_arrival_date", sa.Date(), nullable=True),
        sa.Column("sample_bol_ref", sa.String(length=128), nullable=True),
        sa.Column("source", sa.String(length=64), nullable=False),
        sa.Column("basis", sa.Text(), nullable=False),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_bol_lane_importer_index_arrival_port"), "bol_lane_importer_index", ["arrival_port"], unique=False)
    op.create_index(op.f("ix_bol_lane_importer_index_carrier"), "bol_lane_importer_index", ["carrier"], unique=False)
    op.create_index(op.f("ix_bol_lane_importer_index_importer_name"), "bol_lane_importer_index", ["importer_name"], unique=False)
    op.create_index(op.f("ix_bol_lane_importer_index_lane_key"), "bol_lane_importer_index", ["lane_key"], unique=False)
    op.create_index(op.f("ix_bol_lane_importer_index_vessel_name"), "bol_lane_importer_index", ["vessel_name"], unique=False)
    op.create_index(op.f("ix_bol_lane_importer_lookup"), "bol_lane_importer_index", ["lane_key", "importer_name"], unique=False)

    op.create_table(
        "position_reports",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("mmsi", sa.BigInteger(), nullable=False),
        sa.Column("lat", sa.Float(), nullable=False),
        sa.Column("lon", sa.Float(), nullable=False),
        sa.Column("sog", sa.Float(), nullable=True),
        sa.Column("cog", sa.Float(), nullable=True),
        sa.Column("nav_status", sa.String(length=100), nullable=True),
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("source_url", sa.Text(), nullable=True),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["mmsi"], ["vessels.mmsi"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_position_reports_mmsi"), "position_reports", ["mmsi"], unique=False)
    op.create_index(op.f("ix_position_reports_mmsi_ts"), "position_reports", ["mmsi", "ts"], unique=False)
    op.create_index(op.f("ix_position_reports_ts"), "position_reports", ["ts"], unique=False)

    op.create_table(
        "disruption_events",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("mmsi", sa.BigInteger(), nullable=False),
        sa.Column("port", sa.String(length=255), nullable=True),
        sa.Column("type", sa.String(length=100), nullable=False),
        sa.Column("severity", sa.String(length=50), nullable=False),
        sa.Column("detected_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("source_url", sa.Text(), nullable=True),
        sa.Column("basis", sa.Text(), nullable=True),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["mmsi"], ["vessels.mmsi"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_disruption_events_mmsi"), "disruption_events", ["mmsi"], unique=False)
    op.create_index(op.f("ix_disruption_events_port"), "disruption_events", ["port"], unique=False)

    op.create_table(
        "tariff_rates",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("carrier", sa.String(length=255), nullable=False),
        sa.Column("port", sa.String(length=255), nullable=False),
        sa.Column("equipment", sa.String(length=100), nullable=False),
        sa.Column("per_day_rate", sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column("free_days", sa.Integer(), nullable=False),
        sa.Column("tier", sa.String(length=100), nullable=True),
        sa.Column("source_url", sa.Text(), nullable=False),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_tariff_rates_carrier"), "tariff_rates", ["carrier"], unique=False)
    op.create_index(op.f("ix_tariff_rates_port"), "tariff_rates", ["port"], unique=False)

    op.create_table(
        "affected_parties",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("event_id", sa.BigInteger(), nullable=False),
        sa.Column("importer_name", sa.String(length=512), nullable=False),
        sa.Column("cargo_desc", sa.Text(), nullable=True),
        sa.Column("bol_ref", sa.String(length=128), nullable=True),
        sa.Column("inferred", sa.Boolean(), nullable=False),
        sa.Column("basis", sa.Text(), nullable=False),
        sa.Column("source", sa.String(length=64), nullable=False),
        sa.Column("source_url", sa.Text(), nullable=True),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["event_id"], ["disruption_events.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_affected_parties_event_id"), "affected_parties", ["event_id"], unique=False)
    op.create_index(op.f("ix_affected_parties_importer_name"), "affected_parties", ["importer_name"], unique=False)

    op.create_table(
        "incidents",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("event_id", sa.BigInteger(), nullable=False),
        sa.Column("phase", sa.String(length=100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["event_id"], ["disruption_events.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_incidents_event_id"), "incidents", ["event_id"], unique=False)

    op.create_table(
        "participants",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("room_id", sa.BigInteger(), nullable=False),
        sa.Column("agent_id", sa.String(length=255), nullable=False),
        sa.Column("role", sa.String(length=100), nullable=False),
        sa.Column("framework", sa.String(length=100), nullable=True),
        sa.Column("joined_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.String(length=50), nullable=False),
        sa.ForeignKeyConstraint(["room_id"], ["incidents.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_participants_agent_id"), "participants", ["agent_id"], unique=False)
    op.create_index(op.f("ix_participants_room_id"), "participants", ["room_id"], unique=False)

    op.create_table(
        "options",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("room_id", sa.BigInteger(), nullable=False),
        sa.Column("proposer", sa.String(length=255), nullable=False),
        sa.Column("type", sa.String(length=100), nullable=False),
        sa.Column("feasibility", sa.String(length=100), nullable=False),
        sa.Column("eta_delta_hours", sa.Float(), nullable=True),
        sa.Column("cost_delta", sa.Numeric(precision=14, scale=2), nullable=True),
        sa.Column("risk", sa.Text(), nullable=True),
        sa.Column("rationale", sa.Text(), nullable=True),
        sa.Column("source", sa.String(length=64), nullable=True),
        sa.Column("basis", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["room_id"], ["incidents.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_options_room_id"), "options", ["room_id"], unique=False)

    op.create_table(
        "votes",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("room_id", sa.BigInteger(), nullable=False),
        sa.Column("agent_id", sa.String(length=255), nullable=False),
        sa.Column("option_id", sa.BigInteger(), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False),
        sa.Column("rationale", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["option_id"], ["options.id"]),
        sa.ForeignKeyConstraint(["room_id"], ["incidents.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_votes_agent_id"), "votes", ["agent_id"], unique=False)
    op.create_index(op.f("ix_votes_option_id"), "votes", ["option_id"], unique=False)
    op.create_index(op.f("ix_votes_room_id"), "votes", ["room_id"], unique=False)

    op.create_table(
        "dissent",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("room_id", sa.BigInteger(), nullable=False),
        sa.Column("target_option_id", sa.BigInteger(), nullable=True),
        sa.Column("objection", sa.Text(), nullable=True),
        sa.Column("material", sa.Boolean(), nullable=False),
        sa.Column("basis", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["room_id"], ["incidents.id"]),
        sa.ForeignKeyConstraint(["target_option_id"], ["options.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_dissent_room_id"), "dissent", ["room_id"], unique=False)
    op.create_index(op.f("ix_dissent_target_option_id"), "dissent", ["target_option_id"], unique=False)

    op.create_table(
        "decisions",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("room_id", sa.BigInteger(), nullable=False),
        sa.Column("option_id", sa.BigInteger(), nullable=True),
        sa.Column("human_action", sa.String(length=100), nullable=False),
        sa.Column("actor", sa.String(length=255), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["option_id"], ["options.id"]),
        sa.ForeignKeyConstraint(["room_id"], ["incidents.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_decisions_option_id"), "decisions", ["option_id"], unique=False)
    op.create_index(op.f("ix_decisions_room_id"), "decisions", ["room_id"], unique=False)

    op.create_table(
        "dossiers",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("room_id", sa.BigInteger(), nullable=False),
        sa.Column("pdf_uri", sa.Text(), nullable=True),
        sa.Column("json_uri", sa.Text(), nullable=True),
        sa.Column("generated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("source", sa.String(length=64), nullable=True),
        sa.ForeignKeyConstraint(["room_id"], ["incidents.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_dossiers_room_id"), "dossiers", ["room_id"], unique=False)


def downgrade() -> None:
    op.drop_table("dossiers")
    op.drop_table("decisions")
    op.drop_table("dissent")
    op.drop_table("votes")
    op.drop_table("options")
    op.drop_table("participants")
    op.drop_table("incidents")
    op.drop_table("affected_parties")
    op.drop_table("tariff_rates")
    op.drop_table("disruption_events")
    op.drop_table("position_reports")
    op.drop_table("bol_lane_importer_index")
    op.drop_table("bol_records")
    op.drop_table("vessels")
