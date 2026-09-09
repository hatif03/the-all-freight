from __future__ import annotations

import re
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models import TariffRate


def normalize_text(value: str | None) -> str:
    return re.sub(r"\s+", " ", value or "").strip().lower()


def normalize_equipment(value: str | None) -> str:
    text = normalize_text(value)
    if "reefer" in text or "refrigerated" in text:
        return "reefer"
    if "dry" in text or "standard" in text or "container" in text:
        return "dry"
    return text


def parse_tier_start(tier: str | None, free_days: int) -> int:
    text = normalize_text(tier)
    if not text:
        return free_days + 1

    match = re.search(r"(\d+)", text)
    if match:
        return int(match.group(1))

    return free_days + 1


def parse_tier_end(tier: str | None) -> int | None:
    text = normalize_text(tier)
    if not text or "+" in text or "onward" in text or "thereafter" in text:
        return None

    numbers = [int(n) for n in re.findall(r"\d+", text)]
    if len(numbers) >= 2:
        return numbers[1]
    if len(numbers) == 1:
        return numbers[0]
    return None


def match_score(rate: TariffRate, carrier: str, port: str, equipment: str) -> int:
    carrier_key = normalize_text(carrier)
    port_key = normalize_text(port)
    equipment_key = normalize_equipment(equipment)

    score = 0
    rate_carrier = normalize_text(rate.carrier)
    rate_port = normalize_text(rate.port)
    rate_equipment = normalize_equipment(rate.equipment)

    if carrier_key and (carrier_key in rate_carrier or rate_carrier in carrier_key):
        score += 4
    if port_key and (port_key in rate_port or rate_port in port_key):
        score += 3
    if equipment_key and equipment_key == rate_equipment:
        score += 2
    return score


def build_unavailable_response(carrier: str, port: str, equipment: str, days: float) -> dict[str, Any]:
    return {
        "available": False,
        "amount": None,
        "per_day": None,
        "free_days": 0,
        "chargeable_days": max(0.0, float(days)),
        "tier_breakdown": [],
        "source_url": None,
        "basis": (
            "No cited tariff_rates row matched "
            f"carrier={carrier!r}, port={port!r}, equipment={equipment!r}; no cost was inferred."
        ),
    }


async def find_tariff_rates(
    session: AsyncSession,
    carrier: str,
    port: str,
    equipment: str,
) -> list[TariffRate]:
    equipment_key = normalize_equipment(equipment)
    stmt = select(TariffRate).where(
        TariffRate.carrier.ilike(f"%{carrier}%"),
        TariffRate.equipment.ilike(f"%{equipment_key}%"),
    )

    if port:
        stmt = stmt.where(TariffRate.port.ilike(f"%{port}%"))

    result = await session.execute(stmt)
    rates = list(result.scalars().all())

    # No cross-region fallback: if a port was requested but no tariff matches it,
    # return nothing so the caller reports the cost as UNAVAILABLE. Borrowing a
    # different port's tariff (e.g. applying the US/LA rate to a Singapore vessel)
    # would present a fabricated, mis-cited figure (violates C1).

    return sorted(
        rates,
        key=lambda rate: (
            -match_score(rate, carrier, port, equipment),
            parse_tier_start(rate.tier, rate.free_days),
            float(rate.per_day_rate),
        ),
    )


def calculate_tiered_amount(rates: list[TariffRate], days: float) -> dict[str, Any]:
    first = rates[0]
    free_days = first.free_days
    chargeable_days = max(0.0, float(days) - free_days)
    whole_chargeable_days = int(chargeable_days)

    amount = Decimal("0")
    per_day: float | None = None
    tier_breakdown: list[dict[str, Any]] = []

    ordered_rates = sorted(rates, key=lambda rate: parse_tier_start(rate.tier, free_days))
    for rate in ordered_rates:
        tier_start = parse_tier_start(rate.tier, free_days)
        tier_end = parse_tier_end(rate.tier)
        bill_start = max(tier_start, free_days + 1)
        bill_end = tier_end if tier_end is not None else free_days + whole_chargeable_days
        if bill_end < bill_start:
            continue

        billed_days = max(0, min(bill_end, free_days + whole_chargeable_days) - bill_start + 1)
        if billed_days == 0:
            continue

        rate_amount = Decimal(str(rate.per_day_rate))
        subtotal = rate_amount * billed_days
        amount += subtotal
        per_day = float(rate_amount)
        tier_breakdown.append(
            {
                "range": rate.tier or f"{bill_start}+",
                "days": billed_days,
                "rate": float(rate_amount),
                "subtotal": float(subtotal),
            }
        )

    if chargeable_days > whole_chargeable_days and ordered_rates:
        last_rate = ordered_rates[-1]
        fractional_days = chargeable_days - whole_chargeable_days
        rate_amount = Decimal(str(last_rate.per_day_rate))
        subtotal = rate_amount * Decimal(str(fractional_days))
        amount += subtotal
        per_day = float(rate_amount)
        tier_breakdown.append(
            {
                "range": last_rate.tier or f"{free_days + whole_chargeable_days + 1}+",
                "days": fractional_days,
                "rate": float(rate_amount),
                "subtotal": float(subtotal),
            }
        )

    return {
        "amount": float(amount),
        "per_day": per_day or float(ordered_rates[0].per_day_rate),
        "free_days": free_days,
        "chargeable_days": chargeable_days,
        "tier_breakdown": tier_breakdown,
        "source_url": first.source_url,
        "basis": (
            f"Calculated from {len(ordered_rates)} cited tariff_rates row(s) for "
            f"{first.carrier} / {first.port} / {first.equipment}."
        ),
    }


async def compute_dd_exposure(
    session: AsyncSession | None,
    carrier: str,
    port: str,
    equipment: str,
    days: float,
) -> dict[str, Any]:
    if session is None:
        return build_unavailable_response(carrier, port, equipment, days)

    rates = await find_tariff_rates(session, carrier, port, equipment)
    if not rates:
        return build_unavailable_response(carrier, port, equipment, days)

    response = calculate_tiered_amount(rates, days)
    response["available"] = True
    return response
