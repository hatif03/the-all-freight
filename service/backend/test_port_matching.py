"""Self-check for monitored-port resolution.

The only non-trivial logic in shipment↔incident attribution is deciding whether
a free-text port name means a monitored port. Getting it wrong in the permissive
direction fabricates a connection the data doesn't support, so the assertions
that matter most here are the negative ones.

    cd backend && uv run python test_port_matching.py
"""

from __future__ import annotations

from ports import resolve_port_code


def test_positive_matches() -> None:
    assert resolve_port_code("Los Angeles, USA")[0] == "la_lb"
    assert resolve_port_code("Long Beach")[0] == "la_lb"
    assert resolve_port_code("Los Angeles / Long Beach")[0] == "la_lb"
    assert resolve_port_code("Port of Newark, NJ")[0] == "ny_nj"
    assert resolve_port_code("New York / New Jersey")[0] == "ny_nj"
    assert resolve_port_code("Singapore")[0] == "singapore"
    # Case- and accent-insensitive via casefold.
    assert resolve_port_code("SINGAPORE")[0] == "singapore"


def test_negative_matches() -> None:
    """No match must stay no match — a near-miss is not a monitored port."""
    for text in [
        "Rotterdam, Netherlands",
        "Felixstowe, UK",
        "New Orleans, USA",  # contains "orleans", not "new york"; must not hit ny_nj
        "Newport News, USA",
        "Shanghai, China",
        "Los Alamos, USA",  # shares a prefix with "los angeles" only
        "",
        None,
    ]:
        assert resolve_port_code(text) is None, f"{text!r} should not resolve"


def test_candidate_precedence() -> None:
    """Earlier candidates win, and a miss falls through to the next one."""
    code, alias, text = resolve_port_code("Rotterdam", "Los Angeles, USA")
    assert (code, alias, text) == ("la_lb", "los angeles", "Los Angeles, USA")

    # A recommended entry port takes precedence over the destination.
    assert resolve_port_code("Singapore", "Los Angeles, USA")[0] == "singapore"

    assert resolve_port_code(None, None) is None


def test_returns_reason() -> None:
    """The matched alias and source text are returned so they can be persisted
    as the human-readable basis for the attribution."""
    result = resolve_port_code("Port of Long Beach, California")
    assert result is not None
    code, alias, text = result
    assert code == "la_lb"
    assert alias == "long beach"
    assert text == "Port of Long Beach, California"


if __name__ == "__main__":
    test_positive_matches()
    test_negative_matches()
    test_candidate_precedence()
    test_returns_reason()
    print("port matching: all checks passed")
