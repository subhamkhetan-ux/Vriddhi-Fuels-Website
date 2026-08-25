"""Gmail -> Master Paid payment agent.

Cloud half (this package) reads bank credit-alert emails, parses them, matches
the payer to a canonical customer, and appends confirmed entries to a queue
committed in the repo. The local half (``materialize.py`` at the repo root)
turns that queue into an ``.xlsx`` in Master Paid's exact shape.

The parser grammar, name matcher, date-serial conversion, and idempotency model
are ported from the proven WhatsApp-driven ``vriddhi_pay.py`` system (whose logic
also lives in this repo's ``pay/`` PWA). This is a re-target, not a rewrite.
"""
