const express = require('express');
const { MongoClient, ServerApiVersion } = require('mongodb');
require('dotenv').config();
const app = express();
const cors = require('cors');
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const uri = process.env.MONGO_DB_URI;
const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
});

// কালেকশনটি বাইরে রাখুন যাতে সব রুটে ব্যবহার করা যায়
let promptsCollection;

async function run() {
  try {
    await client.connect();
    // ডাটাবেস এবং কালেকশন সেটআপ
    promptsCollection = client.db("Prompt_Verse").collection("prompts");
    console.log("Successfully connected to MongoDB!");
  } catch (error) {
    console.error(error);
  }
}
run();

// রুটগুলো এখন গ্লোবালি এক্সেস করতে পারবে
app.get('/api/prompts/featured', async (req, res) => {
  try {
    // চেক করুন ডাটাবেস কানেক্ট হয়েছে কি না
    if (!promptsCollection) return res.status(503).send({ message: "Database not connected" });
    
    const result = await promptsCollection
      .find({ status: "approved", visibility: "public" })
      .sort({ rating: -1, copyCount: -1 })
      .limit(6)
      .toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to load featured prompts" });
  }
});

app.get('/', (req, res) => {
  res.send('Server is running!');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

module.exports = app; // Vercel-এর জন্য এটি যোগ করা ভালো