import { boolean, index, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

/* -------------------------------------------------------------------------
 * Better Auth's core schema, owned by THIS package
 *
 * These four tables belong to the identity library, but the migration that
 * creates them belongs here, because PL-0402 requires profile scoping to be
 * present in the FIRST migration rather than retrofitted. Two packages each
 * owning half of a migration cannot produce one first migration; one package
 * owning the whole database can.
 *
 * `user`, `session` and `verification` are TRANSCRIBED FROM
 * https://www.better-auth.com/docs/concepts/database (core schema section, read
 * 2026-08-21 against Better Auth 1.7.1). `account` was RE-DERIVED on 2026-09-15
 * (PL-0405) from the installed package itself -- `buildAuthTables` in
 * `@better-auth/core`, evaluated through `getAuthTablesWithResolvedIndexes({})`,
 * which is the function the library consults to decide what it writes. The docs
 * page is a second-hand account of that function, and the indirection is what
 * let this table drift a whole schema generation behind; see the `account`
 * comment below. The authoritative generator is still
 * `npx @better-auth/cli generate` and it must still be run before the first
 * migration is applied -- see `docs/DATA_MODEL.md`. It is written by hand here
 * so the first migration can be REVIEWED as a whole rather than arriving as
 * generated output nobody read.
 *
 * THIS FILE AND `migrations/0000_profile_scoped_identity.sql` MUST AGREE. They
 * are two statements of one schema and nothing mechanical compares them, so a
 * change to either is a change to both.
 *
 * `@liberty/auth` does not import this file. It receives these tables as an
 * argument, which is what keeps the dependency arrow pointing one way:
 * persistence -> auth, never back.
 * ---------------------------------------------------------------------- */

/**
 * The ACCOUNT. Note what is absent: no display name intended for a viewer, no
 * avatar, no preferences, no watch history. Those are profile concepts and they
 * live one table over. `name` here is Better Auth's own required field and is
 * the account holder's name, not the name shown on a profile tile.
 */
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull()
});

/**
 * The database-backed session. The row IS the session: deleting it revokes
 * access at the next request, which is the property the research chose database
 * sessions for and which a stateless encrypted cookie cannot offer.
 *
 * `ipAddress` and `userAgent` are Better Auth's optional columns. They are
 * retained because "sign out my other devices" is unusable without something
 * to name the device by, and they are deliberately NOT copied anywhere else --
 * they expire with the session, which is the shortest retention that still
 * serves the purpose.
 */
export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull()
  },
  (table) => [index("session_user_id_idx").on(table.userId)]
);

/**
 * One authentication method linked to a user.
 *
 * NO `issuer` COLUMN, AND THE UNIQUE KEY IS `(providerId, accountId)` (PL-0405).
 * This table used to carry `issuer: text("issuer").notNull()` and
 * `unique("account_issuer_account_id_key")`, transcribed from the 1.7.0-1.7.2
 * account schema. Better Auth ABANDONED that schema in 1.7.3 (PR #11153):
 * "Restore sign-in compatibility with 1.6 databases by identifying accounts
 * with `(providerId, accountId)` and removing the `issuer` requirement
 * introduced in 1.7.0. ... For SQL databases, also make `issuer` nullable or
 * remove the column so sign-ups and account linking can succeed." Removed
 * rather than made nullable, because the first migration has never been applied
 * and there is no data to preserve.
 *
 * LEAVING IT WOULD HAVE BROKEN AUTHENTICATION OUTRIGHT, not merely been stale.
 * The same release (PR #11178) added default-on schema validation: `diffSchema`
 * in `@better-auth/core` reports any NOT NULL, defaultless column the library
 * never writes as `unexpected-required-column`, and `formatSchemaFinding`
 * special-cases the name `issuer` with a link to the 1.7 upgrade guide. Its
 * words: every insert into `account` fails.
 *
 * THE `(providerId, accountId)` UNIQUE INDEX IS OURS, NOT THE LIBRARY'S, and
 * saying so is the point of this paragraph -- the previous one claimed the
 * opposite about the index it was describing.
 * `getAuthTablesWithResolvedIndexes({})` on 1.7.5 declares no unique index on
 * `account` at all. The library enforces account identity in code, in
 * `findAccountByKey`, which selects on that pair with `limit: 2` and throws
 * "Multiple accounts match the same accountId for provider ..." on two matches.
 * A duplicate pair is therefore an unrecoverable state for the library, and the
 * database is the only place that can make it unrepresentable. Safe by
 * construction: credential accounts key on `("credential", user id)` and social
 * accounts on `(provider, subject)`.
 *
 * `password` holds a hash produced by the library. It never leaves this table
 * and must never appear in a reason trail, a log line or an error message.
 */
export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
      mode: "date"
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
      mode: "date"
    }),
    scope: text("scope"),
    idToken: text("id_token"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull()
  },
  (table) => [
    unique("account_provider_id_account_id_key").on(table.providerId, table.accountId),
    index("account_user_id_idx").on(table.userId)
  ]
);

/**
 * Short-lived verification and reset tokens.
 *
 * `value` is a token that grants account access if it leaks, so rows here are
 * expected to be deleted on use and swept on expiry rather than accumulating.
 * The retention job is an operational task, not a schema one, but the reason it
 * exists is recorded here because a table nobody prunes is how a year of live
 * password-reset links ends up in a backup.
 */
export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull()
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)]
);

/**
 * The tables Better Auth's Drizzle adapter is handed, under the names it
 * expects.
 *
 * A named export rather than a `import * as schema` at the call site, because
 * the adapter matches by KEY and a stray export in this module -- a helper, a
 * type, a constant -- would be offered to it as if it were a model.
 */
export const betterAuthSchema = { user, session, account, verification } as const;
