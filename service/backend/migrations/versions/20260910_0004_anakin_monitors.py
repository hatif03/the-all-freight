"""Anakin page-change monitors and the signals they produce.

Revision ID: 20260910_0004
Revises: 20260910_0003
Create Date: 2026-09-10 00:00:00
"""

from alembic import op
import sqlalchemy as sa

revision = "20260910_0004"
down_revision = "20260910_0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "anakin_monitors",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("anakin_monitor_id", sa.String(length=128), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("label", sa.String(length=255), nullable=False),
        sa.Column("port_code", sa.String(length=32), nullable=True),
        sa.Column("interval_minutes", sa.Integer(), nullable=False),
        sa.Column("webhook_secret", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        # One monitor per URL, globally: monitors are billed per check, so
        # shipments sharing a lane must share the monitor rather than each
        # registering their own.
        sa.UniqueConstraint("url", name="uq_anakin_monitors_url"),
        sa.UniqueConstraint("anakin_monitor_id", name="uq_anakin_monitors_remote_id"),
    )
    op.create_index(op.f("ix_anakin_monitors_port_code"), "anakin_monitors", ["port_code"], unique=False)

    op.create_table(
        "shipment_monitor_links",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("shipment_id", sa.BigInteger(), nullable=False),
        sa.Column("monitor_id", sa.BigInteger(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["shipment_id"], ["tracked_shipments.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["monitor_id"], ["anakin_monitors.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("shipment_id", "monitor_id", name="uq_shipment_monitor"),
    )
    op.create_index(
        op.f("ix_shipment_monitor_links_shipment_id"), "shipment_monitor_links", ["shipment_id"], unique=False
    )
    op.create_index(
        op.f("ix_shipment_monitor_links_monitor_id"), "shipment_monitor_links", ["monitor_id"], unique=False
    )

    op.create_table(
        "monitor_signals",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("monitor_id", sa.BigInteger(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("changed", sa.JSON(), nullable=True),
        sa.Column("source_url", sa.Text(), nullable=False),
        sa.Column("detected_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("raw", sa.JSON(), nullable=True),
        sa.ForeignKeyConstraint(["monitor_id"], ["anakin_monitors.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_monitor_signals_monitor_id"), "monitor_signals", ["monitor_id"], unique=False)
    op.create_index(op.f("ix_monitor_signals_detected_at"), "monitor_signals", ["detected_at"], unique=False)


def downgrade() -> None:
    op.drop_table("monitor_signals")
    op.drop_table("shipment_monitor_links")
    op.drop_table("anakin_monitors")
