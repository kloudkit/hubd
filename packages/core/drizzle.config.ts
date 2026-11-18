import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  casing: 'snake_case',
  schema: './src/schema.ts',
  out: './migrations',
  schemaFilter: ['hubd'],
})
