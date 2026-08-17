import dotenv from 'dotenv';
import { resolveMongoUri } from '../resolve-mongo-uri.js';
import { MongoClient, ObjectId } from 'mongodb';

dotenv.config({ path: '../.env' });

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: node query-user.mjs <email>');
    process.exit(2);
  }

  const mongoUri = process.env.MONGO_DB_URI;
  if (!mongoUri) {
    console.error('MONGO_DB_URI not set in environment for this process.');
    process.exit(3);
  }

  try {
    const resolved = await resolveMongoUri(mongoUri);
    const client = new MongoClient(resolved);
    await client.connect();
    const db = client.db(process.env.DB_NAME || 'Prompt_Verse');
    const users = db.collection('user');
    const user = await users.findOne({ email });
    console.log(JSON.stringify(user, null, 2));
    await client.close();
  } catch (err) {
    console.error('Error:', err.message || err);
    process.exit(1);
  }
}

main();