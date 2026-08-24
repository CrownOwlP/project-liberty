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
 * TRANSCRIBED FROM https://www.better-auth.com/docs/concepts/database (core
 * schema section, read 2026-08-21 against Better Auth 1.7.1). The authoritative
 * generator is `npx @better-auth/cli generate`, and this file must be
 * reconciled against its output before the first migration is applied -- see
 * `docs/DATA_MODEL.md`. It is written by hand here so the first migration can be
 * REVIEWED as a whole rather than arriving as generated output nobody read.
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
 * The `(issuer, accountId)` unique index is Better Auth's, not ours, and it is
 * the constraint that stops two provider identities collapsing into one local
 * account. Credential (password) accounts use the `local:credential` issuer.
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
    issuer: text("issuer").notNull(),
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
    unique("account_issuer_account_id_key").on(table.issuer, table.accountId),
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
