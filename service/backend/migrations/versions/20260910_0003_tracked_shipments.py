"""Tracked shipments and their attribution to incidents.

Revision ID: 20260910_0003
Revises: 20260909_0002
Create Date: 2026-09-10 00:00:00
"""

from alembic import op
import sqlalchemy as sa

revision = "20260910_0003"
down_revision = "20260909_0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "tracked_shipments",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("product", sa.String(length=512), nullable=False),
        sa.Column("origin", sa.String(length=255), nullable=False),
        sa.Column("destination", sa.String(length=255), nullable=False),
        sa.Column("ship_date", sa.String(length=64), nullable=True),
        sa.Column("mode", sa.String(length=64), nullable=True),
        sa.Column("risk_score", sa.Integer(), nullable=False),
        sa.Column("entry_port", sa.String(length=255), nullable=True),
        sa.Column("port_code", sa.String(length=32), nullable=True),
        sa.Column("port_match_field", sa.String(length=32), nullable=True),
        sa.Column("port_match_basis", sa.Text(), nullable=True),
        sa.Column("analysis", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_tracked_shipments_port_code"), "tracked_shipments", ["port_code"], unique=False)

    op.create_table(
        "shipment_incident_links",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("shipment_id", sa.BigInteger(), nullable=False),
        sa.Column("incident_id", sa.BigInteger(), nullable=False),
        sa.Column("match_type", sa.String(length=32), nullable=False),
        sa.Column("inferred", sa.Boolean(), nullable=False),
        sa.Column("basis", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["shipment_id"], ["tracked_shipments.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["incident_id"], ["incidents.id"]),
        sa.PrimaryKeyConstraint("id"),
        # One attribution per (shipment, incident) — the matcher runs from both
        # directions (new incident, and newly-tracked shipment), so without this
        # a shipment tracked during an open incident would link twice.
        sa.UniqueConstraint("shipment_id", "incident_id", name="uq_shipment_incident"),
    )
    op.create_index(
        op.f("ix_shipment_incident_links_shipment_id"), "shipment_incident_links", ["shipment_id"], unique=False
    )
    op.create_index(
        op.f("ix_shipment_incident_links_incident_id"), "shipment_incident_links", ["incident_id"], unique=False
    )


def downgrade() -> None:
    op.drop_table("shipment_incident_links")
    op.drop_table("tracked_shipments")
