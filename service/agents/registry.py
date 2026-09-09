"""Static role registry.

No external coordination-platform credentials, heartbeats, or peer discovery
to manage — the room bus (agents/room_bus) is self-hosted, so a role is just
a name every agent process already knows about.
"""

ROLES: dict[str, str] = {
    "sentinel": "Sentinel",
    "logistics": "Logistics",
    "carrier": "Carrier",
    "finance": "Finance",
    "procurement": "Procurement",
    "customer_impact": "Customer Impact",
    "dissent": "Dissent",
}


def all_recruitable() -> list[str]:
    """Roles that the Sentinel recruits into a room at runtime."""
    return ["logistics", "carrier", "finance", "procurement", "customer_impact"]
