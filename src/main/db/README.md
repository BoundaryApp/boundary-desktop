# Database Setup

This directory contains the database configuration and connection logic for the Boundary Desktop app.

## Architecture

The database uses SQLite with Drizzle ORM and is stored in the Electron app's user data directory:

- **Database Location**: `{userData}/db/boundary.db`
- **Migrations**: `{userData}/db/` (generated at runtime)
- **Task Files**: `{userData}/task-files/{taskId}/` (includes task.log)

## Dynamic Configuration

Since Electron's `app.getPath('userData')` is only available after the app is ready, we use a dynamic configuration approach:

1. **Runtime Config Generation**: When `initializeDatabase()` is called, it generates a temporary Drizzle config file with the correct user data paths
2. **Migration Execution**: Drizzle-kit commands are executed using the temporary config
3. **Cleanup**: The temporary config is removed after migrations complete

## Files

- `connection.ts` - Main database connection and initialization logic
- `drizzle.config.ts` - Development fallback config (not used in production)
- `schema/Task.ts` - Database schema definitions

## Usage

The database is automatically initialized when the Electron app starts:

```typescript
// In main/index.ts
app.whenReady().then(async () => {
  await initializeDatabase();
});
```

## Development

For development and CLI operations, the static `drizzle.config.ts` provides fallback paths when the app is not ready. 