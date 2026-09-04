// Run against an isolated local PostgreSQL + PostgREST instance, never production.
// Applies no migrations. Required environment and setup are documented in
// docs/deployment-and-operations.md under "구버전 관련 릴스 HTTP 회귀 테스트".
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set for this local-only test`);
  return value;
}

function localURL(value, protocols) {
  const url = new URL(value);
  assert.ok(protocols.includes(url.protocol), "Unexpected test URL protocol");
  assert.ok(
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
    "This test only permits loopback URLs",
  );
  return url;
}

const database = localURL(required("POSTGRES_TEST_URL"), [
  "postgres:",
  "postgresql:",
]);
const api = localURL(required("POSTGREST_TEST_URL"), ["http:"]);
const databaseName = decodeURIComponent(database.pathname.slice(1));
assert.match(
  databaseName,
  /^yeogidam_compat_test(?:_[a-z0-9_]+)?$/,
  "Use a dedicated yeogidam_compat_test database; not an existing Supabase database",
);
assert.equal(
  api.pathname,
  "/",
  "POSTGREST_TEST_URL must be the direct PostgREST origin",
);
const secret = required("POSTGREST_TEST_JWT_SECRET");
assert.ok(
  secret.length >= 32,
  "Use a local test JWT secret of at least 32 characters",
);
const psql = process.env.PSQL_BINARY || "psql";
const pgEnv = {
  // PGHOSTADDR/PGSERVICE can override libpq's destination even when PGHOST is
  // loopback. Do not inherit any PG* connection settings from the caller.
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("PG")),
  ),
  PGHOST: database.hostname.replace(/^\[|\]$/g, ""),
  PGPORT: database.port || "5432",
  PGDATABASE: databaseName,
  PGUSER: decodeURIComponent(database.username),
  PGPASSWORD: decodeURIComponent(database.password),
  PGSSLMODE: "disable",
  PGOPTIONS: "",
};

function sql(query) {
  return execFileSync(psql, ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"], {
    input: query,
    encoding: "utf8",
    env: pgEnv,
    timeout: 30_000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const jsonSQL = (query) => JSON.parse(sql(query));
const users = [randomUUID(), randomUUID(), randomUUID()];
const places = [randomUUID(), randomUUID(), randomUUID()];
const run = randomUUID().replaceAll("-", "");
const sharedShortcode = `compat_${run}`;
const retryShortcode = `retry_${run}`;
const failedShortcode = `failed_${run}`;
const legacyId = randomUUID();
const metadata = {
  instagram_author_username: "compat.author",
  instagram_description: "기존 앱 관련 릴스 조회 검증",
  instagram_thumbnail_url: "https://example.com/compat.jpg",
};

function token(user) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const message = `${encode({ alg: "HS256", typ: "JWT" })}.${
    encode({
      role: "authenticated",
      sub: user,
      exp: Math.floor(Date.now() / 1000) + 600,
    })
  }`;
  return `${message}.${
    createHmac("sha256", secret).update(message).digest("base64url")
  }`;
}

async function get(path, user, query) {
  const url = new URL(path, api);
  url.search = new URLSearchParams(query).toString();
  const response = await fetch(url, {
    headers: user ? { Authorization: `Bearer ${token(user)}` } : {},
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

// Keep this contract identical to fe-release/1.0.1 Frontend/src/entities/info/api.ts.
const oldSelect = [
  "id",
  "instagram_url",
  "instagram_author_username",
  "instagram_description",
  "instagram_thumbnail_url",
  "created_at",
  "reel_places!inner(place_id)",
].join(",");
const oldQuery = (place) => ({
  select: oldSelect,
  processing_status: "eq.COMPLETED",
  "reel_places.place_id": `eq.${place}`,
  order: "created_at.desc",
});

function begin(user, shortcode, mode = "AUTO_SAVE") {
  return jsonSQL(`select public.begin_reel_request(
    ${literal(user)}, ${literal(randomUUID())}, ${literal(shortcode)},
    ${literal(`https://www.instagram.com/reel/${shortcode}/`)},
    'instagram_share', ${literal(mode)}, 9, now() - interval '15 minutes');`);
}

function persist(request, place) {
  sql(`select public.persist_reel_place_result(
    ${literal(request.worker_reel_id)}, ${literal(place)}, 0, null,
    ${literal(request.processing_token)});`);
}

function finalize(request) {
  sql(`update public.reels set
    instagram_author_username = ${literal(metadata.instagram_author_username)},
    instagram_description = ${literal(metadata.instagram_description)},
    instagram_thumbnail_url = ${literal(metadata.instagram_thumbnail_url)}
    where id = ${literal(request.worker_reel_id)};
    select public.finalize_reel_extraction(
      ${literal(request.extraction_id)}, ${literal(request.worker_reel_id)},
      ${literal(request.processing_token)}, true);`);
}

test("legacy related-reels HTTP contract on real PostgREST", async (t) => {
  try {
    sql(`begin;
      insert into auth.users (id, aud, role, email) values
      ${
      users.map((id, i) =>
        `(${literal(id)}, 'authenticated', 'authenticated',
        ${literal(`compat-${run}-${i}@test.invalid`)})`
      ).join(",")
    };
      insert into public.places (id, name) values
      ${
      places.map((id, i) => `(${literal(id)}, ${literal(`compat place ${i}`)})`)
        .join(",")
    };
      commit;`);

    const worker = begin(users[0], sharedShortcode);
    const waiting = begin(users[1], sharedShortcode);
    assert.equal(worker.should_process, true);
    assert.equal(waiting.should_process, false);
    persist(worker, places[0]);
    await t.test("in-flight requests are absent from completed related reels", async () => {
      assert.deepEqual(await get("reels", users[1], oldQuery(places[0])), []);
    });
    finalize(worker);

    await t.test("another user's in-flight extraction becomes visible without copied links", async () => {
      assert.equal(
        sql(`select count(*) from public.reel_places
        where reel_id = ${literal(waiting.reel_id)};`),
        "0",
      );
      const rows = await get("reels", users[1], oldQuery(places[0]));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, waiting.reel_id);
      assert.deepEqual(rows[0].reel_places, [{ place_id: places[0] }]);
      for (const [field, value] of Object.entries(metadata)) {
        assert.equal(rows[0][field], value);
      }
    });

    const cached = begin(users[1], sharedShortcode);
    assert.equal(cached.reused, true);
    await t.test("completed cache reuse and reshare return only the newest own request", async () => {
      const rows = await get("reels", users[1], oldQuery(places[0]));
      assert.deepEqual(rows.map((row) => row.id), [cached.reel_id]);
      assert.equal(
        sql(`select count(*) from public.reel_places
        where reel_id = ${literal(cached.reel_id)};`),
        "0",
      );
    });

    await t.test("new view and old embedded query expose the same request", async () => {
      const rows = await get("user_related_reels", users[1], {
        select: "id,place_id",
        place_id: `eq.${places[0]}`,
      });
      assert.deepEqual(rows, [{ id: cached.reel_id, place_id: places[0] }]);
      const saved = await get("saved_places", users[1], {
        select: "place_id",
        place_id: `eq.${places[0]}`,
      });
      assert.deepEqual(saved, [{ place_id: places[0] }]);
    });

    await t.test("ownership, foreign parent filters, and inner place filters are preserved", async () => {
      assert.deepEqual(await get("reels", users[2], oldQuery(places[0])), []);
      assert.deepEqual(
        await get("reels", users[1], {
          ...oldQuery(places[0]),
          id: `eq.${worker.reel_id}`,
        }),
        [],
      );
      assert.deepEqual(await get("reels", users[1], oldQuery(places[2])), []);
    });

    await t.test("anonymous requests cannot use the related-reels adapter", async () => {
      const url = new URL("reels", api);
      url.search = new URLSearchParams(oldQuery(places[0])).toString();
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      await response.arrayBuffer();
      assert.ok([401, 403].includes(response.status));
    });

    sql(`insert into public.reels
      (id, user_id, instagram_url, instagram_shortcode, processing_status)
      values (${literal(legacyId)}, ${literal(users[1])},
        'https://www.instagram.com/reel/legacy/', ${
      literal(`legacy_${run}`)
    }, 'COMPLETED');
      insert into public.reel_places (reel_id, place_id, position)
      values (${literal(legacyId)}, ${literal(places[2])}, 0);`);
    await t.test("pre-extraction legacy data continues to resolve", async () => {
      assert.deepEqual(
        (await get("reels", users[1], oldQuery(places[2])))
          .map((row) => row.id),
        [legacyId],
      );
    });

    const stale = begin(users[0], retryShortcode);
    persist(stale, places[1]);
    // set_updated_at replaces a manual timestamp; use an explicit future stale cutoff
    // to claim a new worker deterministically without disabling triggers or sleeping.
    const takeover = jsonSQL(`select public.begin_reel_request(
      ${literal(users[1])}, ${literal(randomUUID())}, ${
      literal(retryShortcode)
    },
      ${literal(`https://www.instagram.com/reel/${retryShortcode}/`)},
      'instagram_share', 'AUTO_SAVE', 9, now() + interval '1 second');`);
    assert.equal(takeover.should_process, true);
    persist(takeover, places[0]);
    finalize(takeover);
    await t.test("stale worker evidence remains stored but is absent from the old API", async () => {
      assert.equal(
        sql(`select count(*) from public.reel_places
        where reel_id = ${literal(stale.reel_id)} and place_id = ${
          literal(places[1])
        };`),
        "1",
      );
      assert.deepEqual(await get("reels", users[0], oldQuery(places[1])), []);
      const rows = await get("reels", users[0], oldQuery(places[0]));
      assert.ok(rows.some((row) => row.id === stale.reel_id));
    });

    await t.test("failed extraction followed by retry exposes only the completed final result", async () => {
      const failed = begin(users[2], failedShortcode);
      persist(failed, places[1]);
      sql(`select public.fail_reel_extraction(
        ${literal(failed.extraction_id)}, ${literal(failed.worker_reel_id)},
        ${literal(failed.processing_token)}, 'UNKNOWN');`);
      assert.deepEqual(await get("reels", users[2], oldQuery(places[1])), []);
      const retry = begin(users[2], failedShortcode);
      assert.notEqual(retry.extraction_id, failed.extraction_id);
      persist(retry, places[0]);
      finalize(retry);
      const rows = await get("reels", users[2], oldQuery(places[0]));
      assert.deepEqual(rows.map((row) => row.id), [retry.reel_id]);
      assert.deepEqual(await get("reels", users[2], oldQuery(places[1])), []);
    });

    await t.test("physical worker rows are not rewritten by the compatibility reads", async () => {
      assert.equal(
        sql(`select count(*) from public.reel_places
        where reel_id = ${literal(worker.reel_id)};`),
        "1",
      );
      assert.equal(
        sql(`select count(*) from public.reel_places
        where reel_id in (${literal(waiting.reel_id)}, ${
          literal(cached.reel_id)
        });`),
        "0",
      );
    });
  } finally {
    // Random fixture IDs and shortcodes from this run only; never wipe tables.
    sql(`begin;
      delete from auth.users where id in (${users.map(literal).join(",")});
      delete from public.reel_extractions where instagram_shortcode in
        (${literal(sharedShortcode)}, ${literal(retryShortcode)}, ${
      literal(failedShortcode)
    });
      delete from public.places where id in (${places.map(literal).join(",")});
      commit;`);
  }
});
