import assert from "node:assert/strict";
import test from "node:test";
import {
  maskSensitiveValue as demoMaskSensitiveValue,
  validateTextValue as demoValidateTextValue,
} from "../client/src/lib/demo-validators.js";
import { BUILTIN_TEMPLATES } from "../src/templates/presets.js";
import {
  isKnownValidator,
  listValidators,
  maskSensitiveValue,
  SENSITIVE_VALIDATORS,
  validateTextValue,
} from "../src/validators/index.js";

test("UK pack: uk_utr_mod11, uk_nino, uk_sort_code validation, normalisation, and masking", () => {
  // Valid synthetic UK UTRs (weights [6,7,8,9,10,5,4,3,2] on digits 1..9)
  assert.deepEqual(validateTextValue("uk_utr_mod11", "11234-56789"), {
    valid: true,
    normalised: "11234 56789",
  });
  assert.deepEqual(validateTextValue("uk_utr_mod11", "90000 00001"), {
    valid: true,
    normalised: "90000 00001",
  });
  // Invalid UTR checksum & format
  assert.equal(validateTextValue("uk_utr_mod11", "2123456789").valid, false);
  assert.equal(validateTextValue("uk_utr_mod11", "112345678").valid, false);
  assert.equal(validateTextValue("uk_utr_mod11", "112345678A").valid, false);

  // Valid UK NINO & normalisation
  assert.deepEqual(validateTextValue("uk_nino", "aa-123456-c"), {
    valid: true,
    normalised: "AA 12 34 56 C",
  });
  assert.equal(SENSITIVE_VALIDATORS.has("uk_nino"), true);
  assert.equal(maskSensitiveValue("uk_nino", "AA 12 34 56 C"), "****** 56C");
  assert.equal(maskSensitiveValue("uk_nino", "aa123456c"), "****** 56C");
  // Numeric masking unchanged
  assert.equal(maskSensitiveValue("au_tfn_mod11", "876 543 210"), "****** 210");

  // Invalid UK NINO prefixes and characters
  for (const badPrefix of ["BG", "GB", "NK", "KN", "TN", "NT", "ZZ"]) {
    assert.equal(validateTextValue("uk_nino", `${badPrefix}123456A`).valid, false, badPrefix);
  }
  assert.equal(validateTextValue("uk_nino", "DA123456A").valid, false);
  assert.equal(validateTextValue("uk_nino", "AO123456A").valid, false);
  assert.equal(validateTextValue("uk_nino", "AA123456E").valid, false);
  assert.equal(validateTextValue("uk_nino", "AA12345A").valid, false);

  // UK Sort Code
  assert.deepEqual(validateTextValue("uk_sort_code", "20 00 00"), {
    valid: true,
    normalised: "20-00-00",
  });
  assert.equal(validateTextValue("uk_sort_code", "00-00-00").valid, false);
  assert.equal(validateTextValue("uk_sort_code", "12345").valid, false);
});

test("US pack: us_ein, us_routing_aba, us_ssn validation, normalisation, and masking", () => {
  // IRS EIN
  assert.deepEqual(validateTextValue("us_ein", "12 3456789"), {
    valid: true,
    normalised: "12-3456789",
  });
  assert.deepEqual(validateTextValue("us_ein", "98-7654321"), {
    valid: true,
    normalised: "98-7654321",
  });
  assert.equal(validateTextValue("us_ein", "00-1234567").valid, false);
  assert.equal(validateTextValue("us_ein", "07-1234567").valid, false);
  assert.equal(validateTextValue("us_ein", "78-1234567").valid, false);
  assert.equal(validateTextValue("us_ein", "12-345678").valid, false);

  // US ABA Routing Number (synthetic valid numbers for each Federal Reserve range)
  for (const validAba of ["110000000", "210000007", "610000005", "800000006"]) {
    assert.deepEqual(validateTextValue("us_routing_aba", validAba), {
      valid: true,
      normalised: validAba,
    });
  }
  assert.deepEqual(validateTextValue("us_routing_aba", "110-000-000"), {
    valid: true,
    normalised: "110000000",
  });
  assert.equal(validateTextValue("us_routing_aba", "110000001").valid, false);
  assert.equal(validateTextValue("us_routing_aba", "130000004").valid, false);
  assert.equal(validateTextValue("us_routing_aba", "11000000").valid, false);

  // US SSN (SSA rules + masking)
  assert.deepEqual(validateTextValue("us_ssn", "123 45 6789"), {
    valid: true,
    normalised: "123-45-6789",
  });
  assert.equal(SENSITIVE_VALIDATORS.has("us_ssn"), true);
  assert.equal(maskSensitiveValue("us_ssn", "123-45-6789"), "****** 789");
  assert.equal(validateTextValue("us_ssn", "000-12-3456").valid, false);
  assert.equal(validateTextValue("us_ssn", "666-12-3456").valid, false);
  assert.equal(validateTextValue("us_ssn", "900-12-3456").valid, false);
  assert.equal(validateTextValue("us_ssn", "123-00-3456").valid, false);
  assert.equal(validateTextValue("us_ssn", "123-45-0000").valid, false);
  assert.equal(validateTextValue("us_ssn", "123-45-678").valid, false);
});

test("EU pack: eu_vat all 27 member states + BE/DE/FR deterministic checksums", () => {
  // Checksum-enforced member states
  assert.deepEqual(validateTextValue("eu_vat", "de 123.456.788"), {
    valid: true,
    normalised: "DE123456788",
  });
  assert.equal(validateTextValue("eu_vat", "DE123456789").valid, false);

  assert.deepEqual(validateTextValue("eu_vat", "be 0123-456-749"), {
    valid: true,
    normalised: "BE0123456749",
  });
  assert.equal(validateTextValue("eu_vat", "BE0123456748").valid, false);
  assert.equal(validateTextValue("eu_vat", "BE2123456749").valid, false);

  assert.deepEqual(validateTextValue("eu_vat", "fr 32 123456789"), {
    valid: true,
    normalised: "FR32123456789",
  });
  assert.deepEqual(validateTextValue("eu_vat", "FRAB123456789"), {
    valid: true,
    normalised: "FRAB123456789",
  });
  assert.equal(validateTextValue("eu_vat", "FR33123456789").valid, false);

  // Format-checked EU member states (remaining 24 of 27)
  const validFormatSamples = [
    "ATU12345678",
    "BG123456789",
    "CY12345678L",
    "CZ12345678",
    "DK12345678",
    "EE123456789",
    "EL123456789",
    "ESX1234567R",
    "FI12345678",
    "HR12345678901",
    "HU12345678",
    "IE1234567A",
    "IT12345678901",
    "LT123456789",
    "LU12345678",
    "LV12345678901",
    "MT12345678",
    "NL123456789B01",
    "PL1234567890",
    "PT123456789",
    "RO1234567890",
    "SE123456789012",
    "SI12345678",
    "SK1234567890",
  ];
  for (const sample of validFormatSamples) {
    assert.deepEqual(validateTextValue("eu_vat", sample), {
      valid: true,
      normalised: sample,
    });
  }

  assert.equal(validateTextValue("eu_vat", "GB123456789").valid, false);
  assert.equal(validateTextValue("eu_vat", "XX12345678").valid, false);
  assert.equal(validateTextValue("eu_vat", "AT12345678").valid, false);
  assert.equal(validateTextValue("eu_vat", "NL123456789A01").valid, false);

  // Leading-zero ABN and all-zero TFN must fail closed.
  assert.equal(validateTextValue("au_abn_mod89", "00 000 000 109").valid, false);
  assert.equal(validateTextValue("au_tfn_mod11", "000 000 000").valid, false);
});

test("Demo validators & presets stay in 1-to-1 parity with backend packs", () => {
  const keys = listValidators().map((v) => v.key);
  for (const key of ["uk_utr_mod11", "uk_nino", "uk_sort_code", "us_ein", "us_routing_aba", "us_ssn", "eu_vat"]) {
    assert.ok(isKnownValidator(key), `Missing server validator ${key}`);
  }

  const cases: Array<[string, string]> = [
    ["uk_utr_mod11", "1123456789"],
    ["uk_utr_mod11", "2123456789"],
    ["uk_nino", "aa 12 34 56 c"],
    ["uk_nino", "GB123456A"],
    ["uk_sort_code", "200000"],
    ["uk_sort_code", "000000"],
    ["us_ein", "123456789"],
    ["us_ein", "071234567"],
    ["us_routing_aba", "110000000"],
    ["us_routing_aba", "110000001"],
    ["us_ssn", "123456789"],
    ["us_ssn", "666123456"],
    ["eu_vat", "de123456788"],
    ["eu_vat", "DE123456789"],
    ["eu_vat", "BE0123456749"],
    ["eu_vat", "FR32123456789"],
  ];

  for (const [key, input] of cases) {
    assert.deepEqual(demoValidateTextValue(key, input), validateTextValue(key, input), `${key}:${input}`);
  }

  for (const key of keys) {
    assert.equal(
      demoMaskSensitiveValue(key, "AA 12 34 56 C"),
      maskSensitiveValue(key, "AA 12 34 56 C"),
      `mask parity for ${key}`
    );
    assert.equal(
      demoMaskSensitiveValue(key, "876 543 210"),
      maskSensitiveValue(key, "876 543 210"),
      `numeric mask parity for ${key}`
    );
  }

  assert.equal(BUILTIN_TEMPLATES.length, 6);
  const kyc = BUILTIN_TEMPLATES.find((t) => t.key === "kyc-legal-onboarding");
  const mortgage = BUILTIN_TEMPLATES.find((t) => t.key === "mortgage-loan-pack");
  assert.ok(kyc && mortgage);
  assert.equal(kyc.name, "Legal / KYC Client Onboarding");
  assert.equal(mortgage.name, "Mortgage & Loan Document Pack");
  for (const tpl of BUILTIN_TEMPLATES) {
    assert.ok(!tpl.description.includes("\u2014"));
    for (const item of tpl.items) {
      assert.ok(isKnownValidator(item.validator), `Unknown template validator ${item.validator}`);
      assert.ok(!item.label.includes("\u2014") && !item.helpText.includes("\u2014"));
    }
  }
});

test("AU Medicare /IRN slash normalisation and validator idempotency", () => {
  for (const input of ["2123 45670 1 / 1", "2123 45670 1/1", "21234567011"]) {
    const serverRes = validateTextValue("au_medicare_mod10", input);
    const demoRes = demoValidateTextValue("au_medicare_mod10", input);
    assert.deepEqual(serverRes, { valid: true, normalised: "2123 45670 1 / 1" });
    assert.deepEqual(demoRes, serverRes);
  }
  assert.equal(validateTextValue("au_medicare_mod10", "2123 45670 1 / 0").valid, false);

  const validSamples: Record<string, string> = {
    email: "Ops@Example.COM.AU",
    url: "https://example.com.au/intake",
    phone_e164: "+61 412 345 678",
    iban: "DE89 3704 0044 0532 0130 00",
    au_phone_e164: "0412 345 678",
    au_abn_mod89: "99 000 000 000",
    au_bsb: "083170",
    au_tfn_mod11: "876543210",
    au_medicare_mod10: "2123 45670 1 / 1",
    uk_utr_mod11: "11234-56789",
    uk_nino: "aa 12 34 56 c",
    uk_sort_code: "20 00 00",
    us_ein: "12 3456789",
    us_routing_aba: "110-000-000",
    us_ssn: "123 45 6789",
    eu_vat: "de123456788",
  };
  for (const [key, sample] of Object.entries(validSamples)) {
    const first = validateTextValue(key, sample);
    assert.equal(first.valid, true, `Expected ${key} sample to validate`);
    assert.ok(first.normalised);
    const second = validateTextValue(key, first.normalised);
    assert.deepEqual(second, first, `Expected idempotency for ${key}`);
    assert.deepEqual(demoValidateTextValue(key, sample), first, `Demo mismatch for ${key}`);
  }
});
