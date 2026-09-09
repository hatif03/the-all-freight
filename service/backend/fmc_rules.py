from __future__ import annotations

from dataclasses import dataclass


FMC_2024_FINAL_RULE_URL = (
    "https://www.federalregister.gov/documents/2024/02/26/2024-02926/"
    "demurrage-and-detention-billing-requirements"
)
FMC_2024_EFFECTIVE_DATE_URL = (
    "https://www.federalregister.gov/documents/2024/05/14/2024-10515/"
    "demurrage-and-detention-billing-requirements"
)
FMC_2025_SET_ASIDE_URL = (
    "https://www.federalregister.gov/documents/2025/12/29/2025-23920/"
    "demurrage-and-detention-billing-requirements-properly-issued-invoices-provision-set-aside-by-court"
)


@dataclass(frozen=True)
class FmcRuleFact:
    topic: str
    fact: str
    source_url: str


FMC_DISPUTE_FACTS: tuple[FmcRuleFact, ...] = (
    FmcRuleFact(
        topic="Scope",
        fact=(
            "46 CFR part 541 governs demurrage and detention invoices issued by ocean common "
            "carriers, marine terminal operators, and NVOCCs."
        ),
        source_url=FMC_2024_FINAL_RULE_URL,
    ),
    FmcRuleFact(
        topic="Historical who-may-be-billed context",
        fact=(
            "As published in 2024, the rule addressed billing the contracting party or consignee; "
            "treat this as historical context because the separate properly-issued-invoices section "
            "was later removed after a court set-aside."
        ),
        source_url=FMC_2024_FINAL_RULE_URL,
    ),
    FmcRuleFact(
        topic="Invoice timing",
        fact=(
            "Billing parties generally must issue demurrage or detention invoices within 30 calendar "
            "days from the date on which the charge was last incurred; NVOCC pass-through invoices "
            "generally run from the invoice they received."
        ),
        source_url=FMC_2024_FINAL_RULE_URL,
    ),
    FmcRuleFact(
        topic="Mitigation/refund/waiver request window",
        fact=(
            "The billed party must be allowed at least 30 calendar days from invoice issuance to "
            "request mitigation, refund, or waiver."
        ),
        source_url=FMC_2024_FINAL_RULE_URL,
    ),
    FmcRuleFact(
        topic="Billing party response window",
        fact=(
            "A billing party receiving a mitigation, refund, or waiver request must attempt to "
            "resolve it within 30 calendar days unless both parties agree to a later date."
        ),
        source_url=FMC_2024_FINAL_RULE_URL,
    ),
    FmcRuleFact(
        topic="Invoice contents",
        fact=(
            "Required invoice content covers identifying information, timing information, rate "
            "information, dispute process/contact information, and certifications about rule "
            "consistency and billing-party performance."
        ),
        source_url=FMC_2024_EFFECTIVE_DATE_URL,
    ),
    FmcRuleFact(
        topic="Current caveat",
        fact=(
            "A later FMC rule removed the separate properly-issued-invoices provision after a D.C. "
            "Circuit set-aside; carrier arguments should cite the remaining invoice-content, timing, "
            "and dispute-process rules rather than claiming that removed provision."
        ),
        source_url=FMC_2025_SET_ASIDE_URL,
    ),
)


def fmc_dispute_facts_text() -> str:
    return "\n".join(
        f"- {fact.topic}: {fact.fact} Source: {fact.source_url}"
        for fact in FMC_DISPUTE_FACTS
    )


def fmc_source_urls() -> list[str]:
    return sorted({fact.source_url for fact in FMC_DISPUTE_FACTS})
