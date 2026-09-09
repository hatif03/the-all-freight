"""Room bus message log.

Revision ID: 20260909_0002
Revises: 20260615_0001
Create Date: 2026-09-09 00:00:00
"""

from alembic import op
import sqlalchemy as sa

revision = "20260909_0002"
down_revision = "20260615_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "room_messages",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("room_id", sa.BigInteger(), nullable=False),
        sa.Column("sender_role", sa.String(length=100), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("mentions", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["room_id"], ["incidents.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_room_messages_room_id"), "room_messages", ["room_id"], unique=False)
    op.create_index(op.f("ix_room_messages_created_at"), "room_messages", ["created_at"], unique=False)


def downgrade() -> None:
    op.drop_table("room_messages")
