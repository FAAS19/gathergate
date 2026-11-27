---
title: Deterministic Validator Packs
description: Built-in statutory checksum validators across Generic, AU, UK, US, and EU packs, plus how to contribute a new country pack.
---

GatherGate validates structured text fields deterministically on **every** client submission before saving. Bad checksums are rejected immediately in the client portal with actionable feedback, and unknown validator keys always **fail closed**.

## Built-In Packs

### Generic (`generic`)

| Key | Check & Normalisation | Masked |
| :--- | :--- | :---: |
| `none` | Any non-empty text | No |
| `email` | RFC-style email format, lowercased | No |
| `url` | Valid `http://` or `https://` URL | No |
| `phone_e164` | International E.164 (`+[1-9]`, 8 to 15 digits) | No |
| `iban` | ISO 13616 `mod-97` checksum, 4-char spaced groups | No |

### Australia (`au`)

| Key | Check & Normalisation | Masked |
| :--- | :--- | :---: |
| `au_abn_mod89` | 11-digit ATO ABN `mod-89` checksum (`XX XXX XXX XXX`) | No |
| `au_bsb` | 6-digit Australian BSB (`XXX-XXX`) | No |
| `au_phone_e164` | AU mobile/landline normalised to `+61` E.164 | No |
| `au_tfn_mod11` | 8 or 9-digit ATO TFN `mod-11` checksum | **Yes** |
| `au_medicare_mod10` | 10 or 11-digit Services Australia Medicare + IRN `mod-10` | **Yes** |

### United Kingdom (`uk`)

| Key | Check & Normalisation | Masked |
| :--- | :--- | :---: |
| `uk_utr_mod11` | 10-digit HMRC Unique Taxpayer Reference `mod-11` | No |
| `uk_sort_code` | 6-digit UK Bank Sort Code (`XX-XX-XX`, rejects `00-00-00`) | No |
| `uk_nino` | UK National Insurance format & prefix exclusions | **Yes** |

### United States (`us`)

| Key | Check & Normalisation | Masked |
| :--- | :--- | :---: |
| `us_ein` | 9-digit IRS EIN with valid campus prefix (`XX-XXXXXXX`) | No |
| `us_routing_aba` | 9-digit Federal Reserve ABA routing `mod-10` | No |
| `us_ssn` | 9-digit SSA area, group, and serial rules | **Yes** |

### European Union (`eu`)

| Key | Check & Normalisation | Masked |
| :--- | :--- | :---: |
| `eu_vat` | All 27 EU member-state patterns + BE (`mod-97`), DE (ISO 7064 `mod 11,10`), and FR (`mod-97`) checksums | No |

## Sensitive Field Behaviour

Any validator marked `sensitive: true`:

1. Triggers a **14-day default auto-purge** window (instead of 30 days) on requests using it.
2. Stays masked (`****** 789`) in operator lists, API detail responses, and lifecycle webhooks until an authenticated operator triggers an audited reveal.

## Contributing a Country Validator Pack

Validator packs live in `src/validators/packs/` and require zero external dependencies:

1. Create `src/validators/packs/<country>.ts` exporting a `ValidatorPack` (see `src/validators/packs/types.ts`).
2. Register the pack in `VALIDATOR_PACKS` inside `src/validators/index.ts`.
3. Add user-facing selector options in `client/src/lib/api.ts` (`VALIDATOR_OPTIONS`) and mirror the pure checksum in `client/src/lib/demo-validators.ts`.
4. Add unit tests for valid inputs, invalid checksums, normalisation, and masking in `tests/validator-packs.test.ts`.
5. Run the verification gate (`npm run typecheck && npm run build && npm test`) and open a PR against `main`.
