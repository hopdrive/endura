/**
 * L3 — schema statements must start with their SQL keyword.
 *
 * The drivers route DDL by startsWith('CREATE'), but every statement
 * getSchemaStatements() produced began with a `-- comment` line, so the
 * routing never matched and DDL only worked by accident through the
 * parameterized path. Comment lines are stripped so the routing does
 * what it says.
 */

import { describe, it, expect } from 'vitest';
import { getSchemaStatements, MIGRATIONS } from '../../../../src/storage/sqlite/internal/schema';

describe('schema statement shape (L3)', () => {
  it('every schema statement begins with its SQL keyword, not a comment', () => {
    const statements = getSchemaStatements();
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement, statement.slice(0, 60)).toMatch(/^(CREATE|PRAGMA|INSERT|ALTER|DROP)/i);
    }
  });

  it('migration statements begin with their SQL keyword too', () => {
    for (const migration of MIGRATIONS) {
      for (const statement of migration.statements) {
        expect(statement.trim(), statement.slice(0, 60)).toMatch(/^(CREATE|PRAGMA|INSERT|ALTER|DROP|UPDATE|DELETE)/i);
      }
    }
  });
});
