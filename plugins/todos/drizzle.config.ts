import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  casing: 'snake_case',
  schema: './server/schema.ts',
  out: './migrations',
  schemaFilter: ['todos'],
})
