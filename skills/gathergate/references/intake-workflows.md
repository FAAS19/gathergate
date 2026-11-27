# GatherGate Regional Intake Workflows

GatherGate validates structured text fields deterministically in the client portal before files or values reach the operator console.

## Built-In Regional Validator Packs

- **Australia (`au`)**: ATO ABN (`au_abn_mod89`), ATO TFN (`au_tfn_mod11`, sensitive/masked), Services Australia Medicare + IRN (`au_medicare_mod10`, sensitive/masked), 6-digit BSB (`au_bsb`), and `+61` E.164 phone (`au_phone_e164`).
- **United Kingdom (`uk`)**: HMRC UTR (`uk_utr_mod11`), National Insurance Number (`uk_nino`, sensitive/masked), and 6-digit Sort Code (`uk_sort_code`).
- **United States (`us`)**: IRS EIN (`us_ein`), ABA Routing Number (`us_routing_aba`), and SSN (`us_ssn`, sensitive/masked).
- **European Union (`eu`)**: 27-country EU VAT format and deterministic checksums (`eu_vat`).
- **Generic**: `email`, `url`, `phone_e164`, and `iban` (ISO 13616 mod-97).

## Choosing `require_otp`

- Set `require_otp: true` on `create_request` whenever the chosen template contains sensitive validators (`au_tfn_mod11`, `au_medicare_mod10`, `uk_nino`, `us_ssn`) or photo identity documents.
- Packs containing sensitive validators automatically default to a shorter 14-day post-completion purge window (`SENSITIVE_DEFAULT_PURGE_DAYS`).

## Handling Partial Submissions

- When `get_request_status` shows `status: "in_review"`, all required items have been submitted or approved. Direct the operator to `review_url` to approve items or request a revision with a note.
- When `status: "open"` and items remain `pending` or `rejected`, confirm with the operator before triggering `send_reminder`.
