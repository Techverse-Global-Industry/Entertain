import {sqliteSchema} from '../server/core.mjs';
import {postgresSchema} from '../server/postgres-sql.mjs';
// Schema only: never exports customer data, credentials or uploaded files.
process.stdout.write(postgresSchema(sqliteSchema));
