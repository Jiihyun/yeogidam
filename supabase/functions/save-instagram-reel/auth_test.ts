import { hasServiceRoleCredential } from "./auth.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const SECRET = "sb_secret_test_server_only";

Deno.test("internal batches authenticate with an exact secret apikey and no bearer", () => {
  assert(
    hasServiceRoleCredential(new Headers({ apikey: SECRET }), SECRET),
    "secret apikey must authorize internal batches without a user session",
  );
});

Deno.test("legacy service-role bearer credentials remain supported", () => {
  const serviceRoleJwt = "test-legacy-service-role-jwt";
  assert(
    hasServiceRoleCredential(
      new Headers({ Authorization: `Bearer ${serviceRoleJwt}` }),
      serviceRoleJwt,
    ),
    "legacy server callers must remain authorized",
  );
});

Deno.test("user and publishable credentials cannot authorize an internal batch", () => {
  assert(
    !hasServiceRoleCredential(
      new Headers({
        apikey: "sb_publishable_test_client",
        Authorization: "Bearer test-user-jwt",
      }),
      SECRET,
    ),
    "user requests must continue through user authentication",
  );
});

Deno.test("a secret-looking key is rejected unless its entire value matches", () => {
  for (
    const headers of [
      new Headers({ apikey: "sb_secret_wrong" }),
      new Headers({ Authorization: "Bearer sb_secret_wrong" }),
      new Headers({ apikey: `${SECRET}-suffix` }),
    ]
  ) {
    assert(
      !hasServiceRoleCredential(headers, SECRET),
      "wrong secret must be rejected",
    );
  }
});

Deno.test("missing credentials or server configuration fail closed", () => {
  assert(
    !hasServiceRoleCredential(new Headers(), SECRET),
    "missing credentials must fail",
  );
  for (const serviceRoleKey of [undefined, ""]) {
    assert(
      !hasServiceRoleCredential(new Headers(), serviceRoleKey),
      "missing server secret must never authorize an empty request",
    );
  }
});
